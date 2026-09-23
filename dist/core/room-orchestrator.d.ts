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
import { AgentParticipant, type AgentParticipantSpec } from './participant.js';
import { MeetingRoom, type MeetingRoomPolicy, type MeetingTurn, type MeetingTurnKind } from './meeting-room.js';
import type { RoomMinutesSink } from './room-minutes.js';
import type { MeetingVoicePort } from '../ports/meeting-voice.js';
import type { ModeratorDecision, ModeratorPort } from './moderator.js';
import type { RoomRegistry } from './room-registry.js';
export interface RoomMeetingCall {
    /** 要开会的会议室 id。 */
    readonly roomId: string;
    /** 召集者：成员 id 或 `human`。人类不需要会籍即可召集。 */
    readonly calledBy: string;
    readonly reason: string;
    /**
     * 召集范围。
     * - `global`：会议室全体成员；
     * - `local`：只叫 `invitees` 点名的人（必须显式给出）。
     */
    readonly scope: 'global' | 'local';
    readonly invitees?: readonly string[] | undefined;
    /** 人是否在场（在场则有权发言）。 */
    readonly humanPresent?: boolean | undefined;
    /** 人类插话：`afterRound` 表示"在这一轮结束后插话"。 */
    readonly humanInput?: readonly {
        readonly afterRound: number;
        readonly text: string;
    }[] | undefined;
    /** 会议进行中的观察与驱动钩子。 */
    readonly hooks?: RoomMeetingHooks | undefined;
}
export interface RoomMeetingHooks {
    /** 会议室建好、第 1 轮开始**之前**调用。用来驱动"工作单元结束"让迟到者入场。 */
    readonly onOpened?: (room: MeetingRoom) => void | Promise<void>;
    /** 每轮发言结束后调用。 */
    readonly onRoundEnd?: (round: number, room: MeetingRoom) => void | Promise<void>;
    /** 主持人每次做决定后调用（可观测"主持人看到了什么、决定了什么"）。 */
    readonly onDecision?: (decision: ModeratorDecision, room: MeetingRoom) => void | Promise<void>;
}
export interface RoomMeetingRecord {
    readonly room: MeetingRoom;
    readonly calledBy: string;
    /** 被召集的成员（含后来才入场的）。 */
    readonly summoned: readonly string[];
    /** 召集时仍在工作、需要等边界的成员。 */
    readonly deferred: readonly string[];
    /** 会议进行中真正入场的迟到成员。 */
    readonly admittedLate: readonly string[];
    /** 始终没入场、按缺席处理的成员。 */
    readonly absent: readonly string[];
    /** 散会后回到 working 的成员。 */
    readonly dismissed: readonly string[];
    /** 每人各自的纪要。**内容应当不同。** */
    readonly notes: readonly {
        readonly participant: string;
        readonly text: string;
        readonly chars: number;
    }[];
    readonly rounds: number;
    /** 散会原因（主持人给的理由，或上限兜底）。 */
    readonly adjournedReason: string;
}
/**
 * 一场**进行中**会议的实时快照（面板"会议进行中"视图的数据形态）。
 *
 * 为什么需要它：会议是几十秒的多轮过程。只有散会后的
 * {@link RoomMeetingRecord} 的话，用户全程只能对着一块静止的界面猜
 * "开到哪了、谁在说话"——那正是"看不到会议过程"的缺口。
 * 这里每次调用重算（不是缓存），调用方拿到多新取决于它多久问一次。
 */
export interface ActiveMeetingView {
    /** 会议室 id（会籍实体；会议实例 id 是 `room-N-<roomId>`，两者别混）。 */
    readonly roomId: string;
    /** 会议实例 id。 */
    readonly meetingId: string;
    readonly scope: 'local' | 'global';
    readonly calledBy: string;
    readonly reason: string;
    /** 当前轮次（从 1 开始）。 */
    readonly round: number;
    readonly maxRounds: number;
    /** 已到场、可发言的成员（含可能的人类）。 */
    readonly present: readonly string[];
    /** 被召集但还没到场的成员。 */
    readonly absent: readonly string[];
    /** 到目前为止的全部记录（入场引导 / 发言 / 主持人 / 人类插话）。 */
    readonly transcript: readonly {
        readonly seq: number;
        readonly round: number;
        readonly speaker: string;
        readonly kind: MeetingTurnKind;
        readonly text: string;
        readonly at: number;
    }[];
}
export interface RoomOrchestratorOptions {
    readonly registry: RoomRegistry;
    readonly voice: MeetingVoicePort;
    readonly moderator: ModeratorPort;
    readonly roomPolicy?: MeetingRoomPolicy | undefined;
    readonly minutesMaxChars?: number | undefined;
    readonly now?: (() => number) | undefined;
    /**
     * 借一个会话**当前**的私有上下文（限长投影）。
     *
     * ## 为什么需要它（B 路线的"借上下文"）
     *
     * 新模型下成员是**用户自己的真实会话**，它的工作记忆不在我们手里——
     * 在 DSH 那个会话里。成员发言走的又是一次性外部调用（见
     * `dsh-meeting-voice.ts`），上游侧没有上下文连续性。所以每轮发言前要
     * 问一次上游："它现在大概在做什么"，把末尾若干条消息的限长投影拼进
     * 入场引导与发言 prompt。**不借这一下，发言人就只有议题没有背景**——
     * 那正是"上下文没继承"的真实症状。
     *
     * 拿不到时（会话没加载、上游抛错）返回 undefined，调用方退回
     * "没有私有上下文"的正常路径，**绝不伪造一段**。
     *
     * @param sessionId - 成员 id（新模型下它就是上游会话 id）。
     * @param maxChars - 字符预算，由会议策略给出（`memoryProjectionChars`）。
     */
    readonly contextOf?: ((sessionId: string, maxChars: number) => string | undefined) | undefined;
    /**
     * 会议记录的落点。
     *
     * 由编排器在散会后自动写入，**不靠调用方记得**：原先记录只推进内存数组，
     * 进程重启即丢，"看这个房间历次会议"就成了空列表。
     */
    readonly minutes?: RoomMinutesSink | undefined;
    /**
     * 解析一个成员的**上游 Agent 对象**（`ctx.agents.get(sessionId)`）。
     *
     * 给了它，发言就会走 `fork` provider —— 那个人的完整上下文被 seed 成
     * 这个子 Agent 自己的上下文。这才是"掏过来当作我的上下文注入"。
     * 不给就退回 prompt 注入（兜底）。
     */
    readonly agentOf?: ((sessionId: string) => unknown) | undefined;
    /**
     * **停会判定**。
     *
     * 每一步（每次发言后）都会问一次它。返回 `true` 就立刻散会，
     * 散会原因记成"被要求停止"。
     *
     * 存在它的理由（用户实测反馈）：
     * > 我还暂停不了他，我也没有暂停按钮或者停会按钮。
     * > 如果我强行断掉 DSH，整个会议还会直接消失。
     *
     * 停会判定必须是**可外部触发**的（标志文件 / 远端按钮），
     * 不能只靠模型自己决定结束——那样停不了一个跑偏的会。
     */
    readonly stopRequested?: (() => boolean) | undefined;
    /**
     * **会后回到工作区继续工作**。
     *
     * 用户原话：
     * > 开完会之后，他们并不能带着会议内容回到工作区开始工作。
     * > 我希望可以带着那个内容回到工作区工作……就类似于把工作内容发给那个会话，
     * > 当做类似用户的输入一样，让它继续工作或者说重新开始工作。
     *
     * 所以散会不是终点：每人各自的纪要会被**当作一条用户输入**发回它自己的会话，
     * 它接着就带着会议结论回去干活了。这一步不给就等于开了个白会。
     */
    readonly resumeWork?: ((sessionId: string, text: string) => void | Promise<void>) | undefined;
}
export declare class MeetingOrchestratorError extends Error {
    readonly code = "meeting/orchestrator";
    constructor(message: string);
}
export declare class MeetingOrchestrator {
    private readonly members;
    private readonly registry;
    private readonly voice;
    private readonly moderator;
    private readonly policy;
    private readonly minutesMaxChars;
    private readonly contextOf;
    private readonly minutes;
    private readonly agentOf;
    private readonly stopRequested;
    private readonly resumeWork;
    private readonly now;
    private counter;
    private active;
    /** 进行中会议所在的**会议室** id（会籍实体）。散会时清空。 */
    private activeRoomId;
    private activeTitles;
    private readonly history;
    constructor(options: RoomOrchestratorOptions);
    /** 登记一个会话（建 AgentParticipant）。登记本身不等于加入会议室。 */
    enroll(spec: AgentParticipantSpec): AgentParticipant;
    /** 把已登记的会话加入会议室（会籍：获得唤起与参会的权利/义务）。 */
    joinRoom(sessionId: string, roomId: string): void;
    member(id: string): AgentParticipant;
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
    private projectionFor;
    /**
     * 把一个会话从名册里摘掉（退出会议室）。
     *
     * 会中 / 待入场时**拒绝**（返回 `'busy'`）：那会把一场正在进行的会议的名册挖空，
     * 剩下的人还在发言、会后却找不到该投递给谁。
     *
     * 三种结果而不是布尔值，是为了让调用方能区分"本来就不在名册上"（无害）
     * 与"正在会中不能摘"（要报给用户）。
     */
    forget(sessionId: string): 'ok' | 'busy' | 'absent';
    get participantIds(): readonly string[];
    get meetings(): readonly RoomMeetingRecord[];
    get policySnapshot(): MeetingRoomPolicy;
    states(): Readonly<Record<string, string>>;
    activeRoom(): MeetingRoom | undefined;
    /**
     * 当前进行中会议的实时快照；没有进行中的会议时 `undefined`。
     *
     * 面板的"会议进行中"视图唯一数据来源。**每次调用重算**——
     * 缓存一份会让面板看到过期的轮次与发言，那比没有这个视图更糟
     * （用户会以为卡了）。
     */
    activeMeeting(): ActiveMeetingView | undefined;
    /**
     * 某个会话的**当前工作单元结束**。
     *
     * 宿主应在"本次输出结束"或"本次工具调用返回"的边界调用它。
     * 若该会话正在等会议入场，这里会把它放进会议室并补注入场引导。
     *
     * 返回是否真的入场了。
     */
    onWorkUnitComplete(sessionId: string): boolean;
    private admittedLate;
    /**
     * 本次会议的失败明细（发言失败 / 纪要生成失败）。每次 `convene()` 开头清空。
     *
     * 存在的理由：失败必须**看得见**。收集起来之后，散会理由里才会写清楚
     * "有谁没说上话、为什么"，而不是一场会开完什么异常都看不出来。
     */
    private meetingFailures;
    /** 人在会中实时插话。不占轮次、不占发言名额。 */
    injectHumanTurn(text: string): MeetingTurn;
    convene(call: RoomMeetingCall): Promise<RoomMeetingRecord>;
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
    private speakSafely;
    /**
     * 讨论主循环。
     *
     * 第 1 轮由会议室给出顺序（保证人人有输出）；
     * 之后**每一步**都问主持人：点名下一位，还是宣布散会。
     */
    private runDiscussion;
    /**
     * 若本轮在场成员都已发言，则推进到下一轮。
     *
     * 只在"所有**当前在场**的人"都说过话时才推进——迟到入场的人如果还没说，
     * 就留在本轮，由主持人点名补上。
     */
    private advanceIfRoundComplete;
    /** 让一位在场成员发言。发言内容不做结构化，只用该会话自己的模型。 */
    private speak;
    private callerModel;
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
export declare function buildSpeechPrompt(input: {
    readonly title: string;
    readonly domain: string;
    readonly reason: string;
    readonly round: number;
    readonly transcript: string;
    readonly guidanceChars: number;
    /** true = 第一轮汇报；false = 第二轮起的讨论。 */
    readonly isReport: boolean;
    readonly memoryProjection: string;
}): string;
//# sourceMappingURL=room-orchestrator.d.ts.map