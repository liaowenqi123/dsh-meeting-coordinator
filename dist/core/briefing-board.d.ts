/**
 * 简报板：领域隔离子 Agent 之间**唯一**的共享通道。
 *
 * ## 设计依据（来自竞品调研的失败教训）
 *
 * - **必须外置持久化**。Caucus 是内存态，重启清空需重 join；
 *   dsh-ai-solution-council 进程重启后 queued/running 一律标 failed。
 *   本实现用追加式 JSONL 作唯一事实来源，进程重启后 `revision` 与简报历史不丢。
 * - **追加式而非覆盖式**。覆盖写会在并发下丢数据，且无法审计"谁在第几轮说了什么"。
 * - **长度硬上限**。简报通道是全体成员每轮都要付的固定上下文成本，
 *   超限显式报错（见 `BriefingBudgetExceeded`），不静默截断。
 *
 * ## 并发契约（明确受限，不假装是数据库）
 *
 * 多个 Agent 进程可同时 append：单次 `appendFileSync` 在 O_APPEND 语义下对小记录
 * 是原子的。但**本实现不提供跨进程事务**。因此：
 * - 单条记录必须短（受 `maxBriefingChars` 约束，天然满足）；
 * - `revision` 由重放得出，不依赖计数器文件，避免读改写竞态；
 * - 读到尾部残行（进程在写入中途被杀）时丢弃该行而不是抛错。
 */
import type { AgentSlotId, BoardSnapshot, Briefing, BriefingDraft, MeetingAgenda, MeetingScope, MeetingTriggerKind } from './types.js';
export interface BriefingBoardOptions {
    /** 板的持久化根目录。每个 boardDomain 一个子目录。 */
    readonly rootDir: string;
    readonly boardDomain: string;
    /** 简报字符硬上限（code point）。 */
    readonly maxBriefingChars: number;
    /** 广播摘要总预算。 */
    readonly maxAgendaChars: number;
    /** 注入时钟，便于测试与复现。 */
    readonly now?: (() => number) | undefined;
}
export declare class BoardCorrupted extends Error {
    readonly code = "meeting/board-corrupted";
    constructor(message: string);
}
/**
 * 文件支撑的简报板。
 *
 * 每次 `publish` 追加一行；每次读取重放。
 * `revision` == 有效记录条数，因此**可从磁盘内容独立复算**，不需要额外的计数器文件。
 */
export declare class BriefingBoard {
    readonly boardDomain: string;
    private readonly rootDir;
    private readonly maxBriefingChars;
    private readonly maxAgendaChars;
    private readonly now;
    constructor(options: BriefingBoardOptions);
    /** 该板的 JSONL 文件绝对路径。 */
    get filePath(): string;
    private ensureDir;
    /**
     * 提交一份简报。
     *
     * 校验顺序刻意固定：先结构、再预算，最后落盘。任何一步失败都不产生副作用。
     */
    publish(draft: BriefingDraft): Briefing;
    /** 重放全部有效记录。尾部残行被忽略（进程中途被杀）。 */
    private records;
    private toBriefing;
    /** 当前看板快照：每个槽位的最新简报，按 slot code-unit 排序。 */
    snapshot(): BoardSnapshot;
    /** 某个槽位的最新简报。 */
    latest(slot: AgentSlotId): Briefing | undefined;
    /** 全部槽位的简报时间线（按写入顺序）。 */
    history(): readonly Briefing[];
    /**
     * 汇总议程。只取 scope 内成员的最新简报 —— 这是"隔离 + 跨上下文通信"的落点：
     * 每个成员贡献的是**自己产出的限长摘要**，而不是它的上下文。
     */
    summarize(input: {
        readonly scope: MeetingScope;
        readonly trigger: MeetingTriggerKind;
        readonly reason: string;
        readonly participants: readonly AgentSlotId[];
    }): MeetingAgenda;
}
//# sourceMappingURL=briefing-board.d.ts.map