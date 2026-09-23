/**
 * 会话活动跟踪：`sessionId → 忙 / 闲`。
 *
 * ## 为什么需要它（这是"只允许非活动会话入会"的判据来源）
 *
 * 入会要往那个会话的工具集里装东西，而往一个**正在跑**的 Agent 里塞工具
 * 可能扰动它当前的任务。所以入会那一刻必须能回答"它现在忙不忙"。
 *
 * ## 为什么默认是"闲"而不是"未知即忙"
 *
 * 一个还没开始任何回合的会话，**客观上就是空闲的**——这不是猜测：
 * 本插件在 dsh 启动时加载，早于任何会话活动，所以每个会话的
 * `turn/start` / `turn/end` 都会被我们看见。于是：
 *
 * - 初值 `闲`（还没跑过）；
 * - 收到 `turn/start` → `忙`；
 * - 收到 `turn/end` → `闲`。
 *
 * 反过来"未知即忙"会让全新会话永远加不进来，而它恰恰是最该能加的。
 */
export declare class SessionActivityTracker {
    private readonly busy;
    /** 收到"开始一个回合"。 */
    markBusy(sessionId: string): void;
    /** 收到"回合结束"。 */
    markIdle(sessionId: string): void;
    /** 会话被销毁时清掉，避免集合无限增长。 */
    forget(sessionId: string): void;
    isBusy(sessionId: string): boolean;
    /** 诊断用。 */
    busySessions(): readonly string[];
}
//# sourceMappingURL=activity-tracker.d.ts.map