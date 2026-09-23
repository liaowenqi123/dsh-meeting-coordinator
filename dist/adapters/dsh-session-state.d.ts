/**
 * 「会话活动 → 成员状态」的上游接线。
 *
 * ## 为什么需要它（不接这一层的后果）
 *
 * `AgentParticipant` 的初始状态是 `working`，而 `MeetingOrchestrator.convene`
 * 要求**至少一位**被召集成员能在召集瞬间直接入场
 * （`idle-waiting` / `done` 直接 `in-meeting`；`working` 只能进 `awaiting-entry`）。
 *
 * 如果没有任何东西把真实会话的活动映射成状态，那么：
 *
 * - 全体成员永远停在 `working` → `convene()` 永远抛
 *   「全部 N 位成员都在工作中，会议无法开始」→ **会议室永远开不起来**；
 * - 边界监听器的 `onWorkUnitComplete()` 也永远是 no-op
 *   （它只对 `awaiting-entry` 生效，而没人会被置成那个状态）。
 *
 * 也就是说：**状态机不喂，整条正式路径就是死代码。**
 *
 * ## 与 `dsh-boundary-watcher.ts` 的分工（刻意分成两条独立订阅）
 *
 * | 关注点 | 归谁 |
 * |---|---|
 * | "这个会话忙起来了 / 空闲了"（驱动 `resume` / `beginIdleWaiting`） | **本文件** |
 * | "这个会话的工作单元走到边界了"（驱动 `onWorkUnitComplete` 入场） | `dsh-boundary-watcher.ts` |
 *
 * 不把两者合并的理由：入场时机是**可配置的策略**（`entryBoundary: step-end / turn-end`），
 * 而活动状态是**客观事实**。混在一个订阅里，改入场策略就会连带改状态语义，
 * 那正是"兼容层"式 bug 的温床。
 *
 * ## 上游事件词汇表（内部词汇，未来可能变，所以可配）
 *
 * | 事件 | 含义 | 映射到 |
 * |---|---|---|
 * | `turn/start` | 该会话开始一个回合 | `busy` → `working` |
 * | `turn/end` | 该回合结束（输出完毕、等用户回复） | `idle` → `idle-waiting` |
 *
 * 只报告、不做领域决定：把"忙/闲"翻译成参与者状态是宿主的职责，
 * 本文件不认识 `AgentParticipant`。
 *
 * ## 监听器永不抛错
 *
 * Cordis 的事件回调里抛异常会污染宿主的事件分发。这里一律捕掉并记进 `errors`，
 * 与边界监听器保持同一约定。
 */
import { type DshEventContextFace } from './dsh-boundary-watcher.js';
/** 会话活动的两种客观状态。 */
export type SessionActivityKind = 'busy' | 'idle';
/** 活动类别 → 上游会话事件名。可配，因为上游事件名属于内部词汇表。 */
export declare const ACTIVITY_EVENT: Readonly<Record<SessionActivityKind, string>>;
export interface SessionActivityObservation {
    readonly sessionId: string;
    readonly memberId: string | undefined;
    readonly kind: SessionActivityKind;
    readonly at: number;
}
export interface DshSessionStateOptions {
    readonly ctx: DshEventContextFace;
    /**
     * 把上游 sessionId 映射成本项目的成员 id。
     * 默认恒等映射（成员 id 就是会话 id）。返回 undefined 表示这不是受管成员。
     */
    readonly resolveMemberId?: ((sessionId: string) => string | undefined) | undefined;
    /** 自定义事件名覆盖，用于上游词汇表变动时不必改代码。 */
    readonly events?: Partial<Record<SessionActivityKind, string>> | undefined;
    /** 观察到活动时调用。异常会被捕获，不会打断宿主事件分发。 */
    readonly onActivity: (input: {
        readonly sessionId: string;
        /** 未映射到成员时为 undefined。**依然会回调**：候选列表要的是全部会话的忙/闲。 */
        readonly memberId: string | undefined;
        readonly kind: SessionActivityKind;
    }) => void;
    readonly now?: (() => number) | undefined;
}
export interface DshSessionStateHandle {
    /** 解绑。幂等。 */
    detach(): void;
    /** 观察到的事件流（用于断言与诊断）。 */
    readonly observations: readonly SessionActivityObservation[];
    /** 监听器里被捕获的异常（正常应为空）。 */
    readonly errors: readonly string[];
    /** 当前是否已成功订阅。`false` 说明宿主 ctx 不支持 `on`。 */
    readonly attached: boolean;
}
export declare function attachDshSessionState(options: DshSessionStateOptions): DshSessionStateHandle;
//# sourceMappingURL=dsh-session-state.d.ts.map