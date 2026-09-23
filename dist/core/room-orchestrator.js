/**
 * 会议编排器：把「会议室会籍 → 召集 → 入场（含等待）→ 主持人控场 → 个性化压缩 → 散会」串起来。
 *
 * ## 完整流程
 *
 * ```
 *   会话加入会议室（会籍：获得"唤起/参会"的权利与义务）
 *        │
 *   任意成员或人类召集
 *        │
 *   ① 召集：working → awaiting-entry（不打断，等边界）
 *            idle-waiting / done → in-meeting（直接入场）
 *        │
 *   ② 开场：为已到场者注入入场引导（含各自记忆投影）
 *        │
 *   ③ 第 1 轮：全员依次发言（保证人人有输出）
 *        │
 *   ④ 之后：**主持人**逐个点名下一位 / 宣布散会
 *            （主持人无上下文，不会被任何人的私有记忆带偏）
 *        │
 *   ⑤ 迟到的成员在边界入场，补注入场引导
 *        │
 *   ⑥ 散会 + 会后压缩：每人各自一份"与自己相关"的纪要
 *        │
 *   ⑦ 散会：所有被召集者（含还没入场的）→ working
 * ```
 *
 * ## 三个刻意的设计决定
 *
 * 1. **不是所有会话都能被召集**。只有通过 `RoomRegistry` 加入了会议室的会话才有资格；
 *    没加入的会话不在候选名单里，也不可能被"误叫"。
 * 2. **正在工作的会话不被打断**。它先进入 `awaiting-entry`，
 *    等宿主在"本次输出结束 / 本次工具调用返回"的边界调 `onWorkUnitComplete()` 才入场。
 * 3. **发言内容不做结构化**。不强制"进度/障碍/需要"三段式；
 *    只有**长度上限**（防上下文爆炸）和**主持人的控制通道**是硬约束。
 */
import { AgentParticipant, HUMAN_PARTICIPANT } from './participant.js';
import { DEFAULT_ROOM_POLICY, MeetingRoom, } from './meeting-room.js';
import { DEFAULT_MINUTES_GUIDANCE_CHARS, DEFAULT_MINUTES_MAX_CHARS, buildReflectionPrompt, validateMinutes } from './minutes.js';
import { safeFallback } from './moderator.js';
import { countChars } from './briefing-text.js';
export class MeetingOrchestratorError extends Error {
    code = 'meeting/orchestrator';
    constructor(message) {
        super(message);
        this.name = 'MeetingOrchestratorError';
    }
}
export class MeetingOrchestrator {
    members = new Map();
    registry;
    voice;
    moderator;
    policy;
    minutesMaxChars;
    contextOf;
    minutes;
    agentOf;
    stopRequested;
    resumeWork;
    now;
    counter = 0;
    active;
    /** 进行中会议所在的**会议室** id（会籍实体）。散会时清空。 */
    activeRoomId;
    activeTitles = {};
    history = [];
    constructor(options) {
        this.registry = options.registry;
        this.voice = options.voice;
        this.moderator = options.moderator;
        this.policy = options.roomPolicy ?? DEFAULT_ROOM_POLICY;
        this.minutesMaxChars = options.minutesMaxChars ?? DEFAULT_MINUTES_MAX_CHARS;
        this.contextOf = options.contextOf;
        this.minutes = options.minutes;
        this.agentOf = options.agentOf;
        this.stopRequested = options.stopRequested;
        this.resumeWork = options.resumeWork;
        this.now = options.now ?? (() => Date.now());
    }
    // --- 入驻 ---------------------------------------------------------------
    /** 登记一个会话（建 AgentParticipant）。登记本身不等于加入会议室。 */
    enroll(spec) {
        if (this.members.has(spec.id)) {
            throw new MeetingOrchestratorError(`会话 ${spec.id} 重复登记。`);
        }
        const participant = new AgentParticipant(spec);
        this.members.set(spec.id, participant);
        return participant;
    }
    /** 把已登记的会话加入会议室（会籍：获得唤起与参会的权利/义务）。 */
    joinRoom(sessionId, roomId) {
        const member = this.member(sessionId);
        this.registry.join({
            sessionId,
            roomId,
            workspace: member.workspace,
            model: member.model,
        });
    }
    member(id) {
        const found = this.members.get(id);
        if (found === undefined)
            throw new MeetingOrchestratorError(`未登记的会话 ${id}。`);
        return found;
    }
    /**
     * 一位成员的**完整记忆投影**：自己的记忆 + 借来的当前工作上下文。
     *
     * 自己的记忆 = 会议纪要（`AgentParticipant.notes`，每场会每人不同）；
     * 借来的上下文 = 它真实会话里正在发生什么（`contextOf`，每次现读）。
     *
     * 为什么每次现读而不是入会时快照一份：会话入会后还在继续工作，
     * 快照会立刻过期，而"它现在卡在哪"恰恰是会上最该被带出去的信息。
     *
     * 借不到时只用自己的记忆——那是正常路径，不是错误。
     */
    projectionFor(id) {
        const own = this.member(id).memoryProjection(this.policy.memoryProjectionChars);
        let borrowed;
        try {
            borrowed = this.contextOf?.(id, this.policy.memoryProjectionChars);
        }
        catch {
            // 上游读上下文失败不该让一场会开不成：退回"没有私有上下文"。
            borrowed = undefined;
        }
        if (borrowed === undefined || borrowed.trim().length === 0)
            return own;
        const block = `你当前工作会话的最近上下文（开会前借来的，只含末尾若干条；别人看不到这些）：\n${borrowed}`;
        return own.trim().length === 0 ? block : `${own}\n\n${block}`;
    }
    /**
     * 把一个会话从名册里摘掉（退出会议室）。
     *
     * 会中 / 待入场时**拒绝**（返回 `'busy'`）：那会把一场正在进行的会议的名册挖空，
     * 剩下的人还在发言、会后却找不到该投递给谁。
     *
     * 三种结果而不是布尔值，是为了让调用方能区分"本来就不在名册上"（无害）
     * 与"正在会中不能摘"（要报给用户）。
     */
    forget(sessionId) {
        const member = this.members.get(sessionId);
        if (member === undefined)
            return 'absent';
        if (member.isInMeeting() || member.isAwaitingEntry())
            return 'busy';
        this.members.delete(sessionId);
        return 'ok';
    }
    get participantIds() {
        return [...this.members.keys()].sort(compareCodeUnit);
    }
    get meetings() {
        return this.history;
    }
    get policySnapshot() {
        return this.policy;
    }
    states() {
        const out = {};
        for (const id of this.participantIds)
            out[id] = this.member(id).state;
        return out;
    }
    activeRoom() {
        return this.active;
    }
    /**
     * 当前进行中会议的实时快照；没有进行中的会议时 `undefined`。
     *
     * 面板的"会议进行中"视图唯一数据来源。**每次调用重算**——
     * 缓存一份会让面板看到过期的轮次与发言，那比没有这个视图更糟
     * （用户会以为卡了）。
     */
    activeMeeting() {
        const room = this.active;
        if (room === undefined)
            return undefined;
        return {
            roomId: this.activeRoomId ?? room.id,
            meetingId: room.id,
            scope: room.scope,
            calledBy: room.calledBy,
            reason: room.reason,
            round: room.round,
            maxRounds: room.policy.maxRounds,
            present: room.present,
            absent: room.absent,
            transcript: room.transcript.map((turn) => ({
                seq: turn.seq,
                round: turn.round,
                speaker: turn.speaker,
                kind: turn.kind,
                text: turn.text,
                at: turn.at,
            })),
        };
    }
    // --- 入场边界 -----------------------------------------------------------
    /**
     * 某个会话的**当前工作单元结束**。
     *
     * 宿主应在"本次输出结束"或"本次工具调用返回"的边界调用它。
     * 若该会话正在等会议入场，这里会把它放进会议室并补注入场引导。
     *
     * 返回是否真的入场了。
     */
    onWorkUnitComplete(sessionId) {
        const member = this.member(sessionId);
        member.onWorkUnitComplete();
        if (!member.isInMeeting())
            return false;
        const room = this.active;
        if (room === undefined)
            return false;
        if (room.hasPresent(sessionId) || room.isClosed)
            return false;
        const turn = room.admit(sessionId, {
            memoryProjection: (id) => this.projectionFor(id),
            titles: this.activeTitles,
        });
        if (turn !== undefined)
            this.admittedLate.push(sessionId);
        return turn !== undefined;
    }
    admittedLate = [];
    /**
     * 本次会议的失败明细（发言失败 / 纪要生成失败）。每次 `convene()` 开头清空。
     *
     * 存在的理由：失败必须**看得见**。收集起来之后，散会理由里才会写清楚
     * "有谁没说上话、为什么"，而不是一场会开完什么异常都看不出来。
     */
    meetingFailures = [];
    /** 人在会中实时插话。不占轮次、不占发言名额。 */
    injectHumanTurn(text) {
        const room = this.active;
        if (room === undefined)
            throw new MeetingOrchestratorError('当前没有正在进行的会议，人类无法插话。');
        return room.appendHumanTurn(text);
    }
    // --- 主流程 -------------------------------------------------------------
    async convene(call) {
        if (this.active !== undefined) {
            throw new MeetingOrchestratorError('已有一场会议在进行中；一次只主持一场。');
        }
        const roomEntity = this.registry.room(call.roomId);
        if (roomEntity === undefined) {
            throw new MeetingOrchestratorError(`会议室 ${call.roomId} 不存在。`);
        }
        if (call.calledBy !== HUMAN_PARTICIPANT && !this.registry.isMember(call.calledBy)) {
            throw new MeetingOrchestratorError(`会话 ${call.calledBy} 不是会议室 ${call.roomId} 的成员，没有召集权。` +
                '只有加入了会议室的会话才能唤起会议。');
        }
        // 候选范围：会议室成员 ∩ 已登记会话。
        const memberIds = roomEntity.members.map((member) => member.sessionId).filter((id) => this.members.has(id));
        const invited = call.scope === 'global'
            ? memberIds
            : (call.invitees ?? []).filter((id) => memberIds.includes(id));
        if (invited.length === 0) {
            throw new MeetingOrchestratorError(call.scope === 'local'
                ? `小会必须用 invitees 点名至少一位会议室成员；当前可点名：${memberIds.join('、') || '(无)'}`
                : `会议室 ${call.roomId} 没有可召集的成员。`);
        }
        // ① 召集：working → 等边界；其余 → 立即入场。
        const summoned = [];
        const deferred = [];
        for (const id of invited) {
            const member = this.member(id);
            if (!member.canBeSummoned())
                continue; // 已在会中或已在等入场
            member.summon();
            summoned.push(id);
            if (member.isAwaitingEntry())
                deferred.push(id);
        }
        if (summoned.length === 0) {
            throw new MeetingOrchestratorError('所有被邀请的会话都已在会议中或已在等待入场。');
        }
        const present = summoned.filter((id) => this.member(id).isInMeeting());
        if (present.length === 0) {
            // 没有一个人能立刻到场。撤销召集，明确告诉调用方发生了什么。
            for (const id of summoned)
                this.member(id).cancelSummon();
            throw new MeetingOrchestratorError(`全部 ${deferred.length} 位成员都在工作中（${deferred.join('、')}），会议无法开始。` +
                '它们会在各自当前工作单元结束后才能入场；请在那之后重新召集。');
        }
        this.counter += 1;
        const humanPresent = call.humanPresent === true;
        this.admittedLate = [];
        this.meetingFailures = [];
        const notes = [];
        let adjournedReason = '';
        let room;
        try {
            // ⚠️ 房间的**创建与开启也必须在 try 里**。
            //
            // 它们极少抛错，但一旦抛错而没被接住，被召集的成员就永远停在
            // `in-meeting` / `awaiting-entry`——下一次召集直接报"全员已在会中"。
            // 清理的代价极低、锁死的代价极高，所以宁可把范围划大。
            const meetingId = `room-${this.counter}-${call.roomId}`;
            room = new MeetingRoom({
                id: meetingId,
                scope: call.scope,
                calledBy: call.calledBy,
                reason: call.reason,
                present: humanPresent ? [...present, HUMAN_PARTICIPANT] : present,
                absent: deferred,
                policy: this.policy,
                now: this.now,
                // **每条 turn 立刻落盘**（同步）：开一半就得落盘，不能等散会。
                // 散会后才写一次的话，进程被强杀就等于这场会从没开过。
                onTurn: (turn) => {
                    this.minutes?.appendTurn(call.roomId, meetingId, {
                        seq: turn.seq,
                        round: turn.round,
                        speaker: turn.speaker,
                        kind: turn.kind,
                        text: turn.text,
                        at: turn.at,
                    });
                },
            });
            // 开会立刻落 header：即使第一条发言就崩，也至少知道"这场会开过、谁被召集了"。
            this.minutes?.beginMeeting(call.roomId, {
                meetingId,
                at: this.now(),
                calledBy: call.calledBy,
                scope: call.scope,
                reason: call.reason,
                summoned,
                deferred,
            });
            this.activeTitles = {};
            for (const id of summoned) {
                const member = this.member(id);
                this.activeTitles[id] = { title: member.title, domain: member.domain };
            }
            room.open({
                memoryProjection: (id) => this.projectionFor(id),
                titles: this.activeTitles,
            });
            this.active = room;
            // 记住这是**哪个会议室**的会（会议实例 id 里嵌着它，但不该靠解析）。
            this.activeRoomId = call.roomId;
            await call.hooks?.onOpened?.(room);
            adjournedReason = await this.runDiscussion(room, call);
            // 一个人都没说上话的会是假的：明确报错，不假装开成了。
            //
            // 但**部分失败不算失败** —— 只要有人真的发了言，这场会就有内容。
            // 这里曾经的做法是让第一个人的异常一路冒出去，于是后面所有人都
            // 失去了发言机会（用户现场："只有第一个人发言，然后整场断掉"）。
            if (!room.transcript.some((turn) => turn.kind === 'speech')) {
                throw new MeetingOrchestratorError(`没有任何成员发言成功，这场会等于没开。失败明细：` +
                    `${this.meetingFailures.join('；') || '（上游未给出原因）'}`);
            }
            // ⑥ 会后压缩：每人各自一份。
            const transcript = room.transcriptProjection();
            const transcriptChars = countChars(transcript);
            for (const id of room.present.filter((member) => member !== HUMAN_PARTICIPANT)) {
                const member = this.member(id);
                try {
                    const prompt = buildReflectionPrompt({
                        participant: id,
                        title: member.title,
                        domain: member.domain,
                        meetingId: room.id,
                        reason: room.reason,
                        guidanceChars: DEFAULT_MINUTES_GUIDANCE_CHARS,
                        maxChars: this.minutesMaxChars,
                        transcript,
                        ownTurns: room.turnsBy(id),
                    });
                    const text = await this.voice.speak({
                        participant: id,
                        purpose: 'reflect',
                        prompt,
                        maxChars: this.minutesMaxChars,
                        model: member.model,
                        persona: member.systemPrompt,
                    });
                    const verdict = validateMinutes({
                        candidate: { participant: id, text },
                        transcriptChars,
                        maxChars: this.minutesMaxChars,
                    });
                    if (!verdict.ok)
                        throw new MeetingOrchestratorError(`会后压缩被拒绝：${verdict.reason}`);
                    const normalized = text.replace(/\s+/g, ' ').trim();
                    member.absorbNote({
                        meetingId: room.id,
                        text: normalized,
                        chars: verdict.chars,
                        scope: call.scope,
                        at: this.now(),
                    });
                    notes.push({ participant: id, text: normalized, chars: verdict.chars });
                    // **带回工作区**：把纪要当作一条用户输入发回它自己的会话，
                    // 让它带着会议结论继续干活。不发就是开了个白会。
                    try {
                        await this.resumeWork?.(id, resumePrompt(member.title, room.reason, normalized));
                    }
                    catch {
                        // 回灌失败不该让整场会的成果作废：纪要已经落库了。
                    }
                }
                catch (error) {
                    // 与发言同一原则：单个成员的纪要失败不该毁掉整场会，
                    // 但必须记进 transcript —— "谁没有纪要、为什么"要看得见。
                    const reason = error instanceof Error ? error.message : String(error);
                    room.appendModeratorTurn(`${id} 的会议纪要生成失败：${reason}`);
                    this.meetingFailures.push(`${id} 纪要失败（${reason}）`);
                }
            }
            if (notes.length === 0) {
                throw new MeetingOrchestratorError(`没有任何成员的会议纪要生成成功，这场会没有产出。明细：` +
                    `${this.meetingFailures.join('；') || '（上游未给出原因）'}`);
            }
            // 失败必须出现在散会理由里，而不是只在 transcript 里躺着。
            if (this.meetingFailures.length > 0) {
                adjournedReason = `${adjournedReason}（本场失败项：${this.meetingFailures.join('；')}）`;
            }
        }
        finally {
            if (room !== undefined)
                room.close();
            this.active = undefined;
            this.activeRoomId = undefined;
            this.activeTitles = {};
            // ⑦ 散会：所有被召集者（含始终没入场的）还原到**召集前**的状态。
            //
            // 不管是正常散会还是中途抛错（比如某个成员的模型调用失败），
            // 这一步都必须把状态还回去。少了它，会议结束后成员会卡在
            // `in-meeting` / `awaiting-entry`，那个会议室就再也召集不起来了。
            for (const id of summoned) {
                const member = this.member(id);
                if (member.isInMeeting() || member.isAwaitingEntry())
                    member.dismiss();
            }
        }
        if (room === undefined) {
            // 不可达：不抛错就一定建好了房间。显式写出来既收窄类型，
            // 也让"这里绝不该发生"成为一条明确判断而不是一个 `!`。
            throw new MeetingOrchestratorError('会议房间未能创建。');
        }
        const spokenRounds = room.transcript
            .filter((turn) => turn.kind === 'speech')
            .map((turn) => turn.round);
        const record = {
            room,
            calledBy: call.calledBy,
            summoned,
            deferred,
            admittedLate: [...this.admittedLate],
            absent: room.absent,
            dismissed: summoned,
            notes,
            rounds: spokenRounds.length === 0 ? 1 : Math.max(...spokenRounds),
            adjournedReason,
        };
        this.history.push(record);
        // 落盘：不靠调用方记得。落盘失败不能毁掉一场已经开完的会，
        // 所以吞掉异常——但用 try 包住是刻意的，避免把 I/O 故障升级成会议失败。
        try {
            this.minutes?.write(call.roomId, record);
        }
        catch {
            // 记录写不进去时会议本身仍然是成功的；面板少一条记录优于让整场会报错。
        }
        return record;
    }
    /**
     * 让一位成员发言。**失败不毁掉整场会**。
     *
     * 真实环境里单个成员的发言失败是正常分支：模型调用抖动、网络超时，
     * 或者产出超长（长度是硬预算，超限**拒绝**而不是截断）。
     *
     * 设计的本意是"拒绝**这一次发言**"，不是"拒绝**这一场会议**"。
     * 曾经的做法是让异常一路抛出去，于是第一个人出错后面所有人都没机会说话——
     * 用户看到的就是"只有第一个人发言，然后整场断掉"。
     *
     * @returns 是否发言成功。
     */
    async speakSafely(room, sessionId) {
        try {
            await this.speak(room, sessionId);
            return true;
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // ① 记进 transcript：失败必须看得见，不能被悄悄吞掉。
            room.appendModeratorTurn(`${sessionId} 本轮发言失败：${reason}`);
            // ② 标记本轮不可用：否则主持人会一直点他，而每次点都失败。
            room.markUnavailable(sessionId);
            this.meetingFailures.push(`${sessionId} 发言失败（${reason}）`);
            return false;
        }
    }
    /**
     * 讨论主循环。
     *
     * 第 1 轮由会议室给出顺序（保证人人有输出）；
     * 之后**每一步**都问主持人：点名下一位，还是宣布散会。
     */
    async runDiscussion(room, call) {
        const humanAfter = (round) => {
            for (const utterance of call.humanInput ?? []) {
                if (utterance.afterRound === round)
                    room.appendHumanTurn(utterance.text);
            }
        };
        humanAfter(0);
        for (const id of room.firstRoundOrder()) {
            // 外部停会：首轮逐个发言前也检查一次，别等全说完了才停。
            if (this.stopRequested?.() === true) {
                room.appendModeratorTurn('散会：被要求停止（外部停会）。');
                return '被要求停止（外部停会）。';
            }
            await this.speakSafely(room, id);
        }
        // 首轮结束后也要做一次"整轮完成"判定。漏掉这一步会让主持人在**同一轮**里
        // 又补点一个人（因为它看到本轮所有人都已发言、于是轮转），
        // 白白多出一轮发言。
        await this.advanceIfRoundComplete(room, call);
        let adjourned = '';
        // 每一步都问主持人。上限兜底放在下面，避免主持人坏掉时无限循环。
        for (let step = 0; step < 200; step += 1) {
            // **外部停会**：每步都问一次。不能只靠模型自己决定结束，
            // 否则一个跑偏的会根本停不下来（实测暴露的缺口）。
            if (this.stopRequested?.() === true) {
                adjourned = '被要求停止（外部停会）。';
                room.appendModeratorTurn(`散会：${adjourned}`);
                break;
            }
            if (room.atRoundLimit()) {
                adjourned = `已达轮次上限 ${room.policy.maxRounds} 轮，由协调器强制散会。`;
                room.appendModeratorTurn(adjourned);
                break;
            }
            // 主持人**调用失败**（模型抖动 / 鉴权失败 / 超时）不能毁掉一场已经开开的会：
            // 那会让第 1 轮已经说过的话、已经产生的内容全部不作数（record 不落盘）。
            // 与"发言失败不毁全场"同一条原则：记进 transcript 与失败明细，
            // 按安全轮转继续——主持人拿不到模型时，会议降级成确定性轮转而不是消失。
            let decision;
            try {
                decision = await this.moderator.decide({
                    roomName: room.id,
                    reason: room.reason,
                    members: this.registry.room(call.roomId)?.members.map((m) => m.sessionId) ?? [],
                    present: room.present.filter((id) => id !== HUMAN_PARTICIPANT),
                    absent: room.absent,
                    round: room.round,
                    maxRounds: room.policy.maxRounds,
                    transcript: room.transcriptProjection(),
                    // 传"已处理过"名单：本轮失败过的人不该被再点一次。
                    spokeThisRound: room.settledThisRound(),
                    spokeCounts: room.spokeCounts(),
                    model: this.callerModel(call.calledBy),
                });
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                room.appendModeratorTurn(`主持人本次决定失败（${reason}）；按安全轮转继续。`);
                this.meetingFailures.push(`主持人失败（${reason}）`);
                decision = safeFallback({
                    present: room.present.filter((id) => id !== HUMAN_PARTICIPANT),
                    spokeThisRound: room.settledThisRound(),
                });
            }
            await call.hooks?.onDecision?.(decision, room);
            if (decision.action === 'adjourn') {
                adjourned = decision.reason;
                room.appendModeratorTurn(`散会：${decision.reason}`);
                break;
            }
            if (!room.hasPresent(decision.next)) {
                // 主持人点名了不在场的人 → 记录并跳过，不让会议卡住。
                room.appendModeratorTurn(`主持人点名了 ${decision.next}，但它还没到场；本轮跳过。`);
                continue;
            }
            await this.speakSafely(room, decision.next);
            await this.advanceIfRoundComplete(room, call);
        }
        if (adjourned === '') {
            adjourned = '达到讨论步数上限，由协调器强制散会。';
            room.appendModeratorTurn(adjourned);
        }
        return adjourned;
    }
    /**
     * 若本轮在场成员都已发言，则推进到下一轮。
     *
     * 只在"所有**当前在场**的人"都说过话时才推进——迟到入场的人如果还没说，
     * 就留在本轮，由主持人点名补上。
     */
    async advanceIfRoundComplete(room, call) {
        const presentAgents = room.present.filter((id) => id !== HUMAN_PARTICIPANT);
        if (presentAgents.length === 0)
            return false;
        // 用"已处理过"而不是"发言过"：本轮发言失败的人也算处理过了，
        // 否则一场网络抖动会让本轮永远推进不下去。
        const settled = new Set(room.settledThisRound());
        if (!presentAgents.every((id) => settled.has(id)))
            return false;
        const finishedRound = room.round;
        await call.hooks?.onRoundEnd?.(finishedRound, room);
        for (const utterance of call.humanInput ?? []) {
            if (utterance.afterRound === finishedRound)
                room.appendHumanTurn(utterance.text);
        }
        room.nextRound();
        return true;
    }
    /** 让一位在场成员发言。发言内容不做结构化，只用该会话自己的模型。 */
    async speak(room, sessionId) {
        const member = this.member(sessionId);
        const prompt = buildSpeechPrompt({
            title: member.title,
            domain: member.domain,
            reason: room.reason,
            round: room.round,
            transcript: room.transcriptProjection(),
            // 软目标说给模型听、硬上限留给代码判 —— 两者分开是刻意的：
            // 紧贴实际长度的硬上限会让模型去数字符甚至调工具核对字数。
            // 第一轮是"汇报"（字数要求宽松），第二轮起是"讨论"（要求简短）。
            guidanceChars: room.round <= 1 ? room.policy.reportGuidanceChars : room.policy.discussGuidanceChars,
            isReport: room.round <= 1,
            // 每次发言现读一次：它这一轮大概在做什么，只有它自己知道。
            memoryProjection: this.projectionFor(sessionId),
        });
        const text = await this.voice.speak({
            participant: sessionId,
            purpose: 'speak',
            prompt,
            maxChars: room.round <= 1 ? room.policy.reportMaxChars : room.policy.discussMaxChars,
            model: member.model,
            // 关键：一次性子 Agent 必须**带着这个成员的角色**去发言，
            // 而不是一个"披着名字外衣的陌生人"。`persona` 会送到上游的
            // `SubagentStartRequest.persona`（角色/人格），配合 prompt 里的记忆投影
            // 一起构成"这就是 A 在说话"。
            persona: member.systemPrompt,
            // **fork 那个人过来**：上游把它的完整已完成上下文 seed 进这个子会话，
            // 于是"进会场的那个人"就是它本人，而不是读过它资料的陌生人。
            forkFrom: this.agentOf?.(sessionId),
        });
        room.appendSpeech(sessionId, text);
    }
    callerModel(caller) {
        if (caller === HUMAN_PARTICIPANT)
            return undefined;
        return this.members.get(caller)?.model;
    }
}
/**
 * 发言 prompt。
 *
 * 刻意**不**规定格式和字段——需求明确要求不要结构化，
 * 让 AI 自然讨论出结果。这里只做定位（你是谁、议题、轮到你了）、
 * 带出它自己的记忆投影，以及与预算提示。
 *
 * `memoryProjection` 是 B 路线的关键一环：发言是一次性外部调用，
 * 上游侧没有上下文连续性，"它自己是谁、正在做什么"全靠这一段带进去。
 */
export function buildSpeechPrompt(input) {
    const lines = [
        `【轮到你发言】你是「${input.title}」（领域 ${input.domain}）。议题：${input.reason}。当前第 ${input.round} 轮。`,
        '**发言的第一句话请先报你是谁、在哪个工作区、负责什么方向**（一两句即可），这样别人才知道该向谁求助。',
        '',
        input.isReport
            ? '用最简单的语言汇报你所面临的处境：你的进展、你遇到的卡点、你需要谁的什么帮助。'
            : '用最最简洁的语言表达你的观点建议。只补充新的信息，不要重复别人说过的话。',
        input.isReport
            ? '如果你这边确实没有新的、与议题相关的内容，直接说一句就行。'
            : '如果没有新的、与议题相关的内容，直接说一句就行。',
        `- 字数要求 ${input.guidanceChars} 字以下。`,
    ];
    // 投影为空（没有自己的纪要、也没借到上下文）时整段省掉：
    // 留一个空标题只会让模型以为"该有内容但没给"，反而去臆测。
    if (input.memoryProjection.trim().length > 0) {
        lines.push('', '你的私有记忆投影（只包含与你相关的部分；别人看不到这些）：', input.memoryProjection);
    }
    lines.push('', '会议室记录：', input.transcript);
    return lines.join('\n');
}
function compareCodeUnit(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
/**
 * 把会议纪要包装成一条**用户输入**，让会话接着干活。
 *
 * 刻意写成"你刚开完会，这是与你相关的结论，请继续工作"而不是
 * "总结一下这场会"——目标是让它**回到工作区干活**，不是再复述一遍。
 */
function resumePrompt(title, reason, note) {
    return [
        `【会议结束】你刚参加完会议「${reason}」，现在回到你的工作区继续干活。`,
        '',
        '以下是这场会里**与你相关**的结论与待办：',
        note,
        '',
        `你是「${title}」。请据此继续推进你手头的工作；如果会上明确了新的方向或阻塞，` +
            '优先处理它们。不需要再向会议复述，直接开始干活。',
    ].join('\n');
}
//# sourceMappingURL=room-orchestrator.js.map