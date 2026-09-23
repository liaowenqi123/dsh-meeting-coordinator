/**
 * 会议室：一个**多轮群聊会话**。
 *
 * ## 与上一版的区别
 *
 * 上一版把会议做成了"第 1 轮结构化发言（进度/障碍/需要三段式）+ 后续讨论"。
 * 需求明确否掉了这个方向：
 *
 * > 我觉得没必要做结构化的东西，AI 会自动讨论出合理结果的（这个主要还是针对 AI agent 的集会）
 *
 * 所以本版：
 *
 * - **发言内容不设模板**。入场 prompt 只做定位（你是谁、议题是什么、在场有谁），
 *   然后请对方自然表达，不强制分段、不强制字段；
 * - **阶段不分 brief/discuss**，统一是 `speech`；
 * - **发言顺序交给主持人**（`moderator.ts`），会议室本身只负责记录与预算。
 *
 * 唯一保留的"硬约束"是**长度上限**——它不是发言格式，而是防上下文爆炸的工程底线
 * （N 人 × R 轮不做限制就会线性膨胀）。上限宽松且可配。
 *
 * ## 上下文预算
 *
 * 群聊最大的风险是上下文爆炸。`transcriptProjection()` 只保留最近窗口，
 * 并显式标注省略了多少条；总长恒在预算内，不随轮数线性增长。
 */
import type { AgentSlotId, MeetingScope } from './types.js';
/** 一条会议记录。 */
export type MeetingTurnKind = 
/** 入场：系统注入的引导（不是 Agent 说的话）。 */
'entry'
/** Agent 的一次发言。内容不做结构化。 */
 | 'speech'
/** 主持人控场发言（点名理由、宣布散会）。 */
 | 'moderator'
/** 人类发言。 */
 | 'human';
export interface MeetingTurn {
    readonly seq: number;
    readonly round: number;
    /** 发言者：成员 id、`human`、或 `moderator`。 */
    readonly speaker: string;
    readonly kind: MeetingTurnKind;
    readonly text: string;
    readonly chars: number;
    readonly at: number;
}
export interface MeetingRoomPolicy {
    /**
     * **第一轮（汇报）**提示词里说的字数（"1600 字以下"）。
     *
     * ⚠️ 与 {@link reportMaxChars}（硬上限）必须分开，且**只把软目标告诉模型**。
     * 一旦把硬上限说出去，模型就会把精力花在"我到底输出了多少字"上，
     * 反复确认、甚至调工具数——那才是真正的算力黑洞。
     * 所以报错时也**只重复软目标**，绝不提硬上限。
     */
    readonly reportGuidanceChars: number;
    /** 第一轮的**硬上限**。**绝不能写进提示词**，它只是防空洞。 */
    readonly reportMaxChars: number;
    /** **第二轮起（讨论）**提示词里说的字数（"100-200 字"）。 */
    readonly discussGuidanceChars: number;
    /** 讨论轮的**硬上限**。超过就报错，但**报错里不说这个数字**。 */
    readonly discussMaxChars: number;
    /** 轮次硬顶（防无限循环的兜底；主要判据仍由主持人给出）。 */
    readonly maxRounds: number;
    /** 注入模型的 transcript 预算。 */
    readonly transcriptBudgetChars: number;
    /**
     * 记忆投影的字符上限。
     *
     * 必须给足量：一次性子 Agent 要"带着 A 的上下文"去发言，
     * 只借一小段尾巴是"披着角色外衣的陌生人"。详见 `dsh-session-catalog.readSessionContext`。
     */
    readonly memoryProjectionChars: number;
    /** 等一个正在工作的成员入场的最长时间（毫秒）。超时按缺席处理。 */
    readonly entryWaitMs: number;
}
export declare const DEFAULT_ROOM_POLICY: MeetingRoomPolicy;
/** 入场引导 prompt。刻意**不**规定发言格式。 */
export interface EntryPromptTemplate {
    build(input: {
        readonly participant: AgentSlotId;
        readonly domain: string;
        readonly title: string;
        readonly reason: string;
        readonly scope: MeetingScope;
        readonly calledBy: string;
        readonly present: readonly string[];
        readonly absent: readonly string[];
        readonly memoryProjection: string;
        readonly humanPresent: boolean;
        /** 第一轮软目标：说给模型听的建议长度（硬上限不说）。 */
        readonly reportGuidanceChars: number;
    }): string;
}
export declare const DEFAULT_ENTRY_PROMPT: EntryPromptTemplate;
export interface MeetingRoomOptions {
    readonly id: string;
    readonly scope: MeetingScope;
    /** 召集者：成员 id 或 `human`。 */
    readonly calledBy: string;
    readonly reason: string;
    /** **已到场**、可以发言的成员。 */
    readonly present: readonly string[];
    /** 被召集但还没到场的成员（还在忙）。他们到了会由 `admit()` 加进来。 */
    readonly absent?: readonly string[] | undefined;
    readonly policy?: MeetingRoomPolicy | undefined;
    readonly entryPrompt?: EntryPromptTemplate | undefined;
    readonly now?: (() => number) | undefined;
    /**
     * **每条 turn 落盘的钩子**。
     *
     * 在 `push()` 成功后立刻**同步**调用。存在它的唯一理由是"开一半就得落盘"：
     * 散会后才写一次记录的话，进程被强杀就等于这场会从没开过
     * （实测暴露的真实缺口）。同步调用是为了保证它真的已经写进文件。
     */
    readonly onTurn?: ((turn: MeetingTurn) => void) | undefined;
}
export declare class MeetingRoomError extends Error {
    readonly code = "meeting/room";
    constructor(message: string);
}
export declare class MeetingRoom {
    readonly id: string;
    readonly scope: MeetingScope;
    readonly calledBy: string;
    readonly reason: string;
    readonly policy: MeetingRoomPolicy;
    private readonly entryPrompt;
    private readonly now;
    private readonly onTurn;
    private readonly turns;
    private readonly presentSet;
    private readonly absentSet;
    private sequence;
    private currentRound;
    private closed;
    /** 本轮"发言失败 / 被拒绝"的成员。推进轮次时清空。 */
    private readonly unavailableSet;
    constructor(options: MeetingRoomOptions);
    get humanPresent(): boolean;
    /** 已到场可发言的成员（含可能的人类）。 */
    get present(): readonly string[];
    /** 被召集但还没到场的成员。 */
    get absent(): readonly string[];
    /** 纯 Agent 成员（排除人类），已到场。 */
    get agentPresent(): readonly AgentSlotId[];
    get round(): number;
    get isClosed(): boolean;
    get transcript(): readonly MeetingTurn[];
    /**
     * 开场：为**已到场**的每位成员注入入场引导。
     *
     * 迟到的成员会在 `admit()` 时单独拿到自己的入场引导——先开会、后到场，
     * 不让一个慢会话把整场会拖住（需求里"有一个等待的过程"，等的边界由调用方控制）。
     */
    open(input: {
        readonly memoryProjection: (participant: AgentSlotId) => string;
        readonly titles: Readonly<Record<string, {
            title: string;
            domain: string;
        }>>;
    }): readonly MeetingTurn[];
    /** 一位迟到的成员入场。会为它补注入场引导。 */
    admit(participant: AgentSlotId, input: {
        readonly memoryProjection: (participant: AgentSlotId) => string;
        readonly titles: Readonly<Record<string, {
            title: string;
            domain: string;
        }>>;
    }): MeetingTurn | undefined;
    private makeEntryTurn;
    /**
     * 第 1 轮的发言顺序：全体已到场成员，按确定性顺序。
     *
     * 第 2 轮起不再由会议室决定——交给主持人（见 `moderator.ts`）。
     */
    firstRoundOrder(): readonly AgentSlotId[];
    /** 进入下一轮。 */
    nextRound(): number;
    /** 是否已达轮次硬顶。 */
    atRoundLimit(): boolean;
    /** 某成员是否已到场。 */
    hasPresent(member: string): boolean;
    /**
     * 本次发言的硬上限（按轮次分）。
     *
     * 第一轮是**汇报**（上限宽松），第二轮起是**讨论**（上限收紧）。
     * 这两个数字**都不进提示词**——只把软目标告诉模型，报错时也只重复软目标。
     */
    private speechCap;
    /** 记录一次 Agent 发言。超长**硬拒绝**，不静默截断。 */
    appendSpeech(speaker: string, text: string): MeetingTurn;
    /**
     * 人类插话。
     *
     * 人的发言**不占轮次也不占发言名额**：会议是一群 Agent 的循环，
     * 人不该被主持人的调度排队。
     */
    appendHumanTurn(text: string): MeetingTurn;
    /** 主持人控场发言（点名理由、宣布散会）。不占发言名额。 */
    appendModeratorTurn(text: string): MeetingTurn;
    close(): readonly MeetingTurn[];
    /** 本轮已发言的成员。 */
    spokeThisRound(): readonly AgentSlotId[];
    /**
     * 标记一位成员本轮不可用（发言失败，或产出被拒绝）。
     *
     * 他**不算发言**，但本轮不该再被主持人点名——否则每次点都失败，
     * 会议会一直卡在同一轮里原地打转，直到步数上限。
     */
    markUnavailable(sessionId: string): void;
    /** 本轮失败/被拒的成员。 */
    unavailableThisRound(): readonly AgentSlotId[];
    /**
     * 本轮**已经处理过**的成员 = 发言过 ∪ 失败过。
     *
     * 轮次推进和主持人点名都该看这个（而不是 `spokeThisRound()`）：
     * 失败过的人不必再点，否则一次网络抖动就能让会议原地打转。
     */
    settledThisRound(): readonly AgentSlotId[];
    /** 全会累计发言次数。 */
    spokeCounts(): Readonly<Record<string, number>>;
    /** 某位成员自己的全部发言，用于生成个性化纪要。 */
    turnsBy(speaker: string): readonly MeetingTurn[];
    /**
     * 生成给模型看的群聊上下文（滚动窗口，恒在预算内）。
     *
     * 从最近往前收，直到预算耗尽；被丢掉的部分显式标注。
     */
    transcriptProjection(): string;
    private push;
}
//# sourceMappingURL=meeting-room.d.ts.map