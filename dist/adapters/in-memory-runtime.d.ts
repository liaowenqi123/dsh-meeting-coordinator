/**
 * 内存运行时：测试替身 + MVP 第一步的端到端演示载体。
 *
 * 它的核心作用不是"假装有 DSH"，而是让两件最抽象的事**可被断言**：
 *
 * 1. **上下文隔离**：每个槽位持有自己的私有 `context` 数组，
 *    `deliver()` 是唯一能跨槽位写入的入口。测试可以断言
 *    「A 的私有笔记不在 B 的上下文里，B 只拿到 A 那份 ≤200 字的摘要」。
 * 2. **互相唤起**：每个槽位有 `idle` / `running` 状态。
 *    `mode: 'wake'` 能把 idle 的同伴叫起来并改变它的状态；
 *    `mode: 'steer'` 只往当前回合里插话，对 idle 同伴不产生唤醒。
 *    这正是 DSH durable mailbox 的真实语义，因此这里的行为不是编造的。
 */
import type { AgentSlotId, AgentSlotSpec } from '../core/types.js';
import type { ActivityObservation, AgentHandle, AgentRuntimePort, Delivery, RuntimeCapabilities } from '../ports/agent-runtime.js';
type AgentRunState = 'idle' | 'running' | 'inactive';
export interface InMemoryRuntimeOptions {
    /** 是否模拟"上游不具备 spawn 能力"，用于测试降级路径。 */
    readonly disableSpawn?: boolean | undefined;
    /** 是否模拟"上游没有共享任务板"，用于测试能力探测。 */
    readonly hasNativeTaskBoard?: boolean | undefined;
    /** 是否模拟"上游不支持等待活动"，用于测试收简报的降级路径。 */
    readonly disableWaitForActivity?: boolean | undefined;
}
/**
 * 一个可被检视的内存运行时。
 *
 * 生产路径**不使用**它；它存在的意义是让"隔离"与"唤起"成为可执行的断言，
 * 而不是架构宣言。
 */
export declare class InMemoryAgentRuntime implements AgentRuntimePort {
    readonly port = "in-memory";
    private readonly agents;
    private readonly options;
    /** 记录每一次投递，用于断言"到底传了什么过去、用什么语义传的"。 */
    readonly deliveries: {
        readonly slot: AgentSlotId;
        readonly delivery: Delivery;
    }[];
    constructor(options?: InMemoryRuntimeOptions);
    capabilities(): RuntimeCapabilities;
    spawn(spec: AgentSlotSpec, options?: {
        readonly signal?: AbortSignal | undefined;
    }): Promise<AgentHandle>;
    /**
     * 投递。`mode` 决定是否唤起。
     *
     * 对 `wake`：空闲成员被叫起来（`idle → running`），并唤醒所有等待者。
     * 对 `steer`：只在目标正在运行时融入当前回合；目标空闲时消息被排队但不唤起，
     * 这一差异被计数（`steerWhileIdle`）以便测试与诊断，而不是被静默吞掉。
     */
    deliver(handle: AgentHandle, delivery: Delivery): Promise<void>;
    interrupt(handle: AgentHandle): Promise<void>;
    waitForActivity(handle: AgentHandle, timeoutMs: number, signal?: AbortSignal | undefined): Promise<ActivityObservation>;
    close(handle: AgentHandle): Promise<void>;
    /**
     * 内存替身的映射是恒等：会话 id 就是 slot id。
     *
     * 这与真实 DSH 不同（那边会话 id 是上游自己的 UUID），
     * 所以**不要**拿内存替身"能跑通"当成真实宿主也能跑通的证据——
     * 真实映射必须靠 `DshMeetingRuntime.memberSessions()` 按 teammate name 对齐，
     * 或由 `config.memberSessions` 显式给出。
     */
    memberSessions(): Promise<readonly {
        readonly slot: AgentSlotId;
        readonly sessionId: string;
    }[]>;
    /** 读取某槽位的私有上下文副本。槽位不存在时抛错（而非返回空数组，避免误判）。 */
    inspectContext(slot: AgentSlotId): readonly string[];
    /** 某槽位的私有上下文是否包含给定子串。 */
    contextContains(slot: AgentSlotId, needle: string): boolean;
    /** 某槽位被唤起的次数。 */
    wakeCount(slot: AgentSlotId): number;
    /** 用 steer 语义发给空闲成员、因而没能唤起它的条数。 */
    steerWhileIdle(slot: AgentSlotId): number;
    state(slot: AgentSlotId): AgentRunState;
    /** 测试/演示用：模拟成员"干完活了，回到空闲等下一次唤起"。 */
    markIdle(slot: AgentSlotId): void;
    /** 测试/演示用：模拟成员正在自己的回合里工作。 */
    markRunning(slot: AgentSlotId): void;
    /**
     * 测试/演示用：模拟成员在自己的**私有上下文**里干活。
     *
     * 这些内容永远不会通过 `deliver()` 流转到别的槽位——这正是要断言的不变量。
     */
    recordPrivate(slot: AgentSlotId, text: string): void;
    /** 仍然存活的槽位。用于验证 `shutdown()` 的回收语义。 */
    liveSlots(): readonly AgentSlotId[];
    private notifyWaiters;
    private mustGet;
    private mustGetBySlot;
}
export {};
//# sourceMappingURL=in-memory-runtime.d.ts.map