/**
 * 触发规则：决定"什么时候开会"。
 *
 * 三类触发，与需求一一对应：
 * - `timer`     —— 每 N 毫秒（默认 4 小时）；
 * - `round`     —— 每 N 轮（Agent 持续循环工作时的周期性简报交换）；
 * - `stall`     —— 由 {@link detectStall} 计算的停滞信号驱动（打破死循环的核心）；
 * - `on-demand` —— 任何成员按需召集，绕过节流（但仍有最小间隔，防止广播风暴）。
 *
 * 节流来自竞品调研的教训：Caucus 需要令牌桶限流，Anthropic 的 MAS 经验是
 * 多 Agent 约 15× token 成本，因此**默认绝不能每轮都开会**。
 */
import { type StallSignal } from './stall-detector.js';
import type { BoardSnapshot, Briefing, AgentSlotId, MeetingScope, MeetingTriggerKind } from './types.js';
export interface TriggerPolicy {
    /** 定时触发间隔（毫秒）。默认 4 小时；设为 0 关闭。 */
    readonly everyMs: number;
    /** 轮次触发间隔。设为 0 关闭。 */
    readonly everyRounds: number;
    /** 停滞信号触发开关。 */
    readonly onStall: boolean;
    /** 两次会议之间的最小间隔，对**所有**触发生效。防止广播风暴。 */
    readonly minIntervalMs: number;
    /** 定时/轮次触发的会议规模。停滞触发固定用 local（先局部解决，避免全局噪声）。 */
    readonly periodicScope: MeetingScope;
}
export declare const DEFAULT_TRIGGER_POLICY: TriggerPolicy;
export interface TriggerState {
    /** 已有简报的当前看板快照。 */
    readonly snapshot: BoardSnapshot;
    readonly history: readonly Briefing[];
    readonly slots: readonly AgentSlotId[];
    /** 协调器视角的当前轮次。 */
    readonly currentRound: number;
    readonly now: number;
    /** 上次会议时间；从未开过则为 undefined。 */
    readonly lastMeetingAt: number | undefined;
    /** 上次会议时的轮次。 */
    readonly lastMeetingRound: number | undefined;
}
export interface TriggerDecision {
    readonly kind: MeetingTriggerKind;
    readonly scope: MeetingScope;
    readonly reason: string;
    /** 数字越小越优先。手动 > 停滞 > 轮次 > 定时。 */
    readonly priority: number;
}
export interface TriggerEvaluation {
    readonly decisions: readonly TriggerDecision[];
    /** 被节流压制的触发，用于可观测性：让用户知道"本来该开会但被限流了"。 */
    readonly suppressed: readonly TriggerDecision[];
    readonly stallSignals: readonly StallSignal[];
}
/**
 * 评估全部触发规则。
 *
 * 返回**全部**成立的触发而不是第一条：调用方（或 UI）可以据此解释"为什么现在要开会"。
 * 但 `decisions` 已按优先级排序，`decisions[0]` 即应当执行的那一个。
 */
export declare function evaluateTriggers(state: TriggerState, policy?: TriggerPolicy): TriggerEvaluation;
/**
 * 构造一次"按需"触发。任何成员都可召集。
 *
 * `local` 的成员集合由调用方给出；这里不推断成员关系——推断需要知道领域拓扑，
 * 而协调器只负责召集/汇总/广播，不做任务路由。
 */
export declare function demandTrigger(input: {
    readonly scope: MeetingScope;
    readonly reason: string;
    readonly requestedBy: AgentSlotId;
}): TriggerDecision;
//# sourceMappingURL=triggers.d.ts.map