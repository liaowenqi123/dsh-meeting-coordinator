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
import type { BriefingBoard } from './briefing-board.js';
import { type TriggerDecision, type TriggerEvaluation, type TriggerPolicy } from './triggers.js';
import type { StallSignal } from './stall-detector.js';
import type { AgentSlotId, AgentSlotSpec, Briefing, BriefingDraft, MeetingAgenda, MeetingCall, MeetingScope } from './types.js';
import type { AgentHandle, AgentRuntimePort, RuntimeCapabilities } from '../ports/agent-runtime.js';
/** 一次会议的完整记录。可供审计"谁召集的、叫了谁、谁真被唤起了、谁没到"。 */
export interface MeetingRecord {
    readonly agenda: MeetingAgenda;
    /** 发起者。定时/轮次触发的会议记为协调器自身席位（`null`）。 */
    readonly calledBy: AgentSlotId | null;
    readonly inResponseTo: string | null;
    /** 摘要**成功投递**到的成员。 */
    readonly deliveredTo: readonly AgentSlotId[];
    /** 投递时目标处于空闲、因此被**真正唤起**（新起回合）的成员。 */
    readonly woke: readonly AgentSlotId[];
    readonly failures: readonly {
        readonly slot: AgentSlotId;
        readonly error: string;
    }[];
}
export interface CoordinatorOptions {
    readonly board: BriefingBoard;
    readonly runtime: AgentRuntimePort;
    readonly slots: readonly AgentSlotSpec[];
    readonly policy?: TriggerPolicyPolicy | undefined;
    readonly now?: (() => number) | undefined;
}
/** 触发策略 + 召集节流策略。 */
export interface TriggerPolicyPolicy extends TriggerPolicy {
    /**
     * 同一个成员两次召集之间的最小间隔（毫秒）。
     *
     * 必要性来自竞品调研：Caucus 需要每发送者令牌桶限流；
     * Anthropic 的 MAS 经验是多 Agent 约 15× token 成本。
     * 没有这个限制，一个焦虑的 Agent 能把整队人towards 广播风暴。
     */
    readonly minCallIntervalMs: number;
}
export declare const DEFAULT_COORDINATOR_POLICY: TriggerPolicyPolicy;
export interface TickResult {
    readonly evaluation: TriggerEvaluation;
    readonly meeting?: MeetingRecord | undefined;
    /** 触发成立但被节流压制时的说明，供 UI 解释"为什么还没开会"。 */
    readonly suppressedReason?: string | undefined;
}
/** 一次召集的结果：被接受则是会议记录，被拒绝则带回拒绝理由给发起者。 */
export type CallMeetingResult = {
    readonly accepted: true;
    readonly meeting: MeetingRecord;
} | {
    readonly accepted: false;
    readonly reason: string;
};
export declare class MeetingCoordinator {
    private readonly board;
    private readonly runtime;
    private readonly policy;
    private readonly now;
    private readonly specs;
    private readonly handles;
    private readonly lastCallAt;
    private lastMeetingAt;
    private lastMeetingRound;
    private roundCounter;
    private readonly meetings;
    constructor(options: CoordinatorOptions);
    get slotIds(): readonly AgentSlotId[];
    get slotSpecs(): readonly AgentSlotSpec[];
    get capabilities(): RuntimeCapabilities;
    get meetingHistory(): readonly MeetingRecord[];
    /** 当前轮次：取显式推进值与简报自述轮次的最大值。 */
    get currentRound(): number;
    /** 显式推进轮次。Agent 每完成一轮工作时调用。 */
    advanceRound(by?: number): number;
    /**
     * 启动全部领域隔离子 Agent。
     *
     * 若运行时明确报出"不能 spawn"，**立即失败**而不是静默降级成
     * "只有协调器在空转"——后者会让人以为系统在跑，实际一个成员都没起来。
     */
    start(options?: {
        readonly signal?: AbortSignal | undefined;
    }): Promise<readonly AgentHandle[]>;
    /** 认领一个**由外部启动**的成员句柄。
     *
     * 存在的理由：在 dsh-std facet 模型下，"启动成员"是成员自身 facet 的职责
     * （一个领域方向 = 一个 facet），协调器只负责召集/汇总/广播。
     * 因此协调器必须能认领别人起好的句柄，而不是假定自己是唯一的启动者。 */
    adopt(handle: AgentHandle): void;
    /** 忘记一个已经退出的成员。
     *
     * 由成员 facet 卸载时回调。没有它，协调器会留着指向已关闭句柄的悬空引用，
     * "卸载即回收"就只回收了 Agent 而没回收协调器里的名册。 */
    forget(slot: AgentSlotId): void;
    /** 提交一份简报。委托给看板做预算与持久化校验。 */
    publish(draft: BriefingDraft): Briefing;
    /** 当前看板上的最新简报。 */
    latestBriefings(): readonly Briefing[];
    tick(): Promise<TickResult>;
    /**
     * **任何成员**都可以调用：召集一场会。
     *
     * 这是"互相唤起"的入口。被拒绝时会明确告诉发起者原因，
     * 而不是静默丢弃——一个被节流掉的求助如果无人知晓，Agent 会一直等下去。
     */
    callMeeting(call: MeetingCall): Promise<CallMeetingResult>;
    /** 按触发决策召集（内部与 tick 使用）。 */
    convene(decision: TriggerDecision, stallSignals?: readonly StallSignal[], origin?: {
        readonly calledBy?: AgentSlotId | undefined;
        readonly invitees?: readonly AgentSlotId[] | undefined;
        readonly inResponseTo?: string | undefined;
    }): Promise<MeetingRecord>;
    /**
     * 选择参会者。
     *
     * - 显式 `invitees` 优先（召集者说了算，但仍会被 slot 注册表裁剪）；
     * - `global`（大会）：全体成员；
     * - `local`（小会）：**只叫上出问题的和它们点名要的人**。
     *   这是刻意的：把停滞成员的问题广播给健康成员，只会污染后者的上下文。
     */
    private selectParticipants;
    /**
     * 互相唤起的链条：`会议 id → 它引发的下一场会议 id`。
     *
     * 有它才能回答"这次连环会议到底是谁先挑起来的"。
     */
    wakeGraph(): readonly {
        readonly from: string;
        readonly to: string;
        readonly by: AgentSlotId | null;
    }[];
    /** 会议记录落盘：可审计"哪次会是谁开的、叫了谁、谁没到"。 */
    private persistMeeting;
    /** 关闭全部成员。逆序、幂等：与 dsh-std lifecycle 的清理语义保持一致。 */
    shutdown(): Promise<void>;
}
export type { MeetingScope, MeetingAgenda };
//# sourceMappingURL=coordinator.d.ts.map