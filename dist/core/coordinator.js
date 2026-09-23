/**
 * 例会协调器。
 *
 * ## 精髓：开会 = 互相唤起
 *
 * 这个系统里最重要的一件事不是"生成一份摘要"，而是
 * **一个 Agent 能让另一个正在待命的 Agent 动起来**。
 *
 * 机制上它由三件事共同构成：
 *
 * 1. **任何人都能召集**。{@link MeetingCoordinator.callMeeting} 对每个成员开放，
 *    不只有协调器能开会。一个 Agent 卡住了、做完里程碑了、发现方向偏了，
 *    都可以立刻把相关同伴唤起来。
 * 2. **投递即唤起**。会议摘要用 `mode: 'wake'` 投递：目标是空闲的就起一个新回合，
 *    是运行中的就在最近步骤边界送达。所以"广播"不是留言板，是点名让人动。
 * 3. **响应式再召集**。成员收到摘要后可以带 `inResponseTo` 再开一场会，
 *    形成 A 唤起 B、B 唤起 C 的可审计链条（{@link MeetingCoordinator.wakeGraph}）。
 *
 * ## 职责边界（刻意收窄）
 *
 * 协调器**只**做召集、汇总、广播。它不做任务路由、不做领域判断、不读别人的上下文。
 * 竞品调研里 Caucus 明确写"不做任务规划与路由"，MAST 把"Agent 间失配"
 * 列为三大失败模式之一——协调器一旦开始做路由，就会变成第 N 个需要被协调的 Agent。
 *
 * ## 上下文污染的落点
 *
 * 每个成员贡献的是**自己产出的限长摘要**（≤ maxBriefingChars），
 * 汇总成一条 ≤ maxAgendaChars 的 digest 广播回去。
 * A 的私有上下文永不进入 B 的上下文，B 的上下文增长量是
 * O(参会人数 × 摘要长度)，而不是 O(A 的全部工作)。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateTriggers } from './triggers.js';
import { DEFAULT_TRIGGER_POLICY } from './triggers.js';
import { RuntimeUnavailable } from '../ports/agent-runtime.js';
export const DEFAULT_COORDINATOR_POLICY = {
    ...DEFAULT_TRIGGER_POLICY,
    minCallIntervalMs: 60_000,
};
export class MeetingCoordinator {
    board;
    runtime;
    policy;
    now;
    specs = new Map();
    handles = new Map();
    lastCallAt = new Map();
    lastMeetingAt;
    lastMeetingRound;
    roundCounter = 0;
    meetings = [];
    constructor(options) {
        this.board = options.board;
        this.runtime = options.runtime;
        this.policy = options.policy ?? DEFAULT_COORDINATOR_POLICY;
        this.now = options.now ?? (() => Date.now());
        for (const spec of options.slots) {
            if (this.specs.has(spec.id)) {
                throw new RuntimeUnavailable(`槽位 ${spec.id} 重复注册；slot id 必须唯一。`);
            }
            this.specs.set(spec.id, spec);
        }
    }
    get slotIds() {
        return [...this.specs.keys()].sort(compareCodeUnit);
    }
    get slotSpecs() {
        return this.slotIds.map((id) => {
            const spec = this.specs.get(id);
            if (spec === undefined)
                throw new RuntimeUnavailable(`槽位 ${id} 规格丢失。`);
            return spec;
        });
    }
    get capabilities() {
        return this.runtime.capabilities();
    }
    get meetingHistory() {
        return this.meetings;
    }
    /** 当前轮次：取显式推进值与简报自述轮次的最大值。 */
    get currentRound() {
        const observed = this.board.snapshot().briefings.reduce((max, briefing) => Math.max(max, briefing.round), 0);
        return Math.max(observed, this.roundCounter);
    }
    /** 显式推进轮次。Agent 每完成一轮工作时调用。 */
    advanceRound(by = 1) {
        this.roundCounter += by;
        return this.roundCounter;
    }
    /**
     * 启动全部领域隔离子 Agent。
     *
     * 若运行时明确报出"不能 spawn"，**立即失败**而不是静默降级成
     * "只有协调器在空转"——后者会让人以为系统在跑，实际一个成员都没起来。
     */
    async start(options) {
        const capabilities = this.runtime.capabilities();
        if (!capabilities.canSpawn) {
            throw new RuntimeUnavailable(`运行时 ${capabilities.port} 不具备 spawn 能力，无法启动领域隔离子 Agent。` +
                `诊断：${capabilities.notes.join(' / ') || '上游未提供说明'}`);
        }
        const started = [];
        for (const spec of this.slotSpecs) {
            started.push(await this.runtime.spawn(spec, options));
        }
        for (const handle of started) {
            this.handles.set(handle.slot, handle);
        }
        return started;
    }
    /** 认领一个**由外部启动**的成员句柄。
     *
     * 存在的理由：在 dsh-std facet 模型下，"启动成员"是成员自身 facet 的职责
     * （一个领域方向 = 一个 facet），协调器只负责召集/汇总/广播。
     * 因此协调器必须能认领别人起好的句柄，而不是假定自己是唯一的启动者。 */
    adopt(handle) {
        if (!this.specs.has(handle.slot)) {
            this.specs.set(handle.slot, {
                id: handle.slot,
                domain: handle.slot,
                title: handle.slot,
                systemPrompt: '(由外部 facet 启动，规格未在协调器侧登记)',
            });
        }
        this.handles.set(handle.slot, handle);
    }
    /** 忘记一个已经退出的成员。
     *
     * 由成员 facet 卸载时回调。没有它，协调器会留着指向已关闭句柄的悬空引用，
     * "卸载即回收"就只回收了 Agent 而没回收协调器里的名册。 */
    forget(slot) {
        this.handles.delete(slot);
        this.specs.delete(slot);
    }
    /** 提交一份简报。委托给看板做预算与持久化校验。 */
    publish(draft) {
        const briefing = this.board.publish(draft);
        this.roundCounter = Math.max(this.roundCounter, briefing.round);
        return briefing;
    }
    /** 当前看板上的最新简报。 */
    latestBriefings() {
        return this.board.snapshot().briefings;
    }
    async tick() {
        const snapshot = this.board.snapshot();
        const evaluation = evaluateTriggers({
            snapshot,
            history: this.board.history(),
            slots: this.slotIds,
            currentRound: this.currentRound,
            now: this.now(),
            lastMeetingAt: this.lastMeetingAt,
            lastMeetingRound: this.lastMeetingRound,
        }, this.policy);
        const decision = evaluation.decisions[0];
        if (decision === undefined) {
            const suppressed = evaluation.suppressed[0];
            return {
                evaluation,
                suppressedReason: suppressed === undefined
                    ? undefined
                    : `触发「${suppressed.kind}」成立但被最小会议间隔压制：${suppressed.reason}`,
            };
        }
        return { evaluation, meeting: await this.convene(decision, evaluation.stallSignals) };
    }
    /**
     * **任何成员**都可以调用：召集一场会。
     *
     * 这是"互相唤起"的入口。被拒绝时会明确告诉发起者原因，
     * 而不是静默丢弃——一个被节流掉的求助如果无人知晓，Agent 会一直等下去。
     */
    async callMeeting(call) {
        if (!this.specs.has(call.calledBy)) {
            return { accepted: false, reason: `未注册的槽位 ${call.calledBy} 试图召集会议。` };
        }
        if (call.reason.trim().length === 0) {
            return { accepted: false, reason: '召集必须给出 reason；没有议题的会只会制造噪声。' };
        }
        const now = this.now();
        const previous = this.lastCallAt.get(call.calledBy);
        if (previous !== undefined && now - previous < this.policy.minCallIntervalMs) {
            const waitMs = this.policy.minCallIntervalMs - (now - previous);
            return {
                accepted: false,
                reason: `召集过于频繁：距 ${call.calledBy} 上次召集仅 ${Math.round((now - previous) / 1000)} 秒，` +
                    `请在 ${Math.ceil(waitMs / 1000)} 秒后再试（节流上限 ${Math.round(this.policy.minCallIntervalMs / 1000)} 秒）。`,
            };
        }
        this.lastCallAt.set(call.calledBy, now);
        const decision = {
            kind: 'peer-call',
            scope: call.scope,
            reason: `由 ${call.calledBy} 召集：${call.reason}`,
            priority: 0,
        };
        const meeting = await this.convene(decision, [], {
            calledBy: call.calledBy,
            invitees: call.invitees,
            inResponseTo: call.inResponseTo,
        });
        return { accepted: true, meeting };
    }
    /** 按触发决策召集（内部与 tick 使用）。 */
    async convene(decision, stallSignals = [], origin) {
        const participants = this.selectParticipants(decision, stallSignals, origin?.invitees);
        const agenda = this.board.summarize({
            scope: decision.scope,
            trigger: decision.kind,
            reason: decision.reason,
            participants,
        });
        const deliveredTo = [];
        const woke = [];
        const failures = [];
        // 摘要必须**唤起**接收者，而不是留给它下次自己发现。
        // 这是"互相唤起"的最后一段：会议不是公告栏，是点名让人动。
        const mode = 'wake';
        for (const slot of participants) {
            const handle = this.handles.get(slot);
            if (handle === undefined) {
                failures.push({ slot, error: '没有该槽位的运行句柄（未 start 或已关闭）。' });
                continue;
            }
            try {
                await this.runtime.deliver(handle, {
                    kind: decision.kind === 'peer-call' || decision.kind === 'on-demand' ? 'meeting-invite' : 'meeting-digest',
                    mode,
                    text: agenda.digest,
                    agendaId: agenda.id,
                });
                deliveredTo.push(slot);
                woke.push(slot);
            }
            catch (error) {
                failures.push({ slot, error: error instanceof Error ? error.message : String(error) });
            }
        }
        const record = {
            agenda,
            calledBy: origin?.calledBy ?? null,
            inResponseTo: origin?.inResponseTo ?? null,
            deliveredTo,
            woke,
            failures,
        };
        this.meetings.push(record);
        this.persistMeeting(record);
        this.lastMeetingAt = agenda.at;
        this.lastMeetingRound = this.currentRound;
        return record;
    }
    /**
     * 选择参会者。
     *
     * - 显式 `invitees` 优先（召集者说了算，但仍会被 slot 注册表裁剪）；
     * - `global`（大会）：全体成员；
     * - `local`（小会）：**只叫上出问题的和它们点名要的人**。
     *   这是刻意的：把停滞成员的问题广播给健康成员，只会污染后者的上下文。
     */
    selectParticipants(decision, stallSignals, invitees) {
        if (invitees !== undefined && invitees.length > 0) {
            const explicit = [...new Set(invitees)].filter((slot) => this.specs.has(slot)).sort(compareCodeUnit);
            if (explicit.length > 0)
                return explicit;
        }
        if (decision.scope === 'global')
            return this.slotIds;
        const chosen = new Set();
        for (const signal of stallSignals) {
            for (const slot of signal.slots)
                chosen.add(slot);
        }
        // 有障碍或明确求助的成员，即使在同一个 local 会议里也要进来。
        for (const briefing of this.board.snapshot().briefings) {
            if (briefing.blocker !== null || briefing.needs.length > 0 || briefing.requestedFrom.length > 0) {
                chosen.add(briefing.slot);
                for (const target of briefing.requestedFrom)
                    chosen.add(target);
            }
        }
        // 按需召集且没有任何信号时，退化为全体——否则会开出一个没有议程的会。
        if (chosen.size === 0)
            return this.slotIds;
        return [...chosen].filter((slot) => this.specs.has(slot)).sort(compareCodeUnit);
    }
    /**
     * 互相唤起的链条：`会议 id → 它引发的下一场会议 id`。
     *
     * 有它才能回答"这次连环会议到底是谁先挑起来的"。
     */
    wakeGraph() {
        const edges = [];
        for (const meeting of this.meetings) {
            if (meeting.inResponseTo !== null) {
                edges.push({ from: meeting.inResponseTo, to: meeting.agenda.id, by: meeting.calledBy });
            }
        }
        return edges;
    }
    /** 会议记录落盘：可审计"哪次会是谁开的、叫了谁、谁没到"。 */
    persistMeeting(record) {
        const dir = join(this.board.filePath, '..');
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({
            v: 1,
            id: record.agenda.id,
            scope: record.agenda.scope,
            trigger: record.agenda.trigger,
            reason: record.agenda.reason,
            calledBy: record.calledBy,
            inResponseTo: record.inResponseTo,
            at: record.agenda.at,
            boardRevision: record.agenda.boardRevision,
            participants: record.agenda.participants,
            deliveredTo: record.deliveredTo,
            woke: record.woke,
            failures: record.failures,
            digestChars: record.agenda.digestChars,
            truncated: record.agenda.truncated,
        });
        appendFileSync(join(dir, 'meetings.jsonl'), `${line}\n`, { encoding: 'utf8', flag: 'a' });
    }
    /** 关闭全部成员。逆序、幂等：与 dsh-std lifecycle 的清理语义保持一致。 */
    async shutdown() {
        const handles = [...this.handles.values()].reverse();
        this.handles.clear();
        const errors = [];
        for (const handle of handles) {
            try {
                await this.runtime.close(handle);
            }
            catch (error) {
                errors.push(`${handle.slot}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // 名册与被关闭的实例必须一起清空，否则 slotIds 会报告已经不存在的成员。
        this.specs.clear();
        if (errors.length > 0) {
            throw new RuntimeUnavailable(`关闭槽位时出现错误（其余已完成清理）：${errors.join('; ')}`);
        }
    }
}
function compareCodeUnit(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
//# sourceMappingURL=coordinator.js.map