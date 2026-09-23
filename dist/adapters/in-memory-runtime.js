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
import { RuntimeUnavailable } from '../ports/agent-runtime.js';
/**
 * 一个可被检视的内存运行时。
 *
 * 生产路径**不使用**它；它存在的意义是让"隔离"与"唤起"成为可执行的断言，
 * 而不是架构宣言。
 */
export class InMemoryAgentRuntime {
    port = 'in-memory';
    agents = new Map();
    options;
    /** 记录每一次投递，用于断言"到底传了什么过去、用什么语义传的"。 */
    deliveries = [];
    constructor(options = {}) {
        this.options = options;
    }
    capabilities() {
        return {
            port: this.port,
            canSpawn: this.options.disableSpawn !== true,
            canDeliver: true,
            canWake: true,
            canInterrupt: true,
            canWaitForActivity: this.options.disableWaitForActivity !== true,
            hasNativeTaskBoard: this.options.hasNativeTaskBoard === true,
            notes: [
                '内存运行时：仅用于测试与演示，不具备持久化与跨进程能力。',
                this.options.disableSpawn === true ? '已按配置模拟"上游不支持 spawn"。' : '',
            ].filter((note) => note.length > 0),
        };
    }
    async spawn(spec, options) {
        if (this.options.disableSpawn === true) {
            throw new RuntimeUnavailable('内存运行时被配置为不可 spawn。');
        }
        if (options?.signal?.aborted === true) {
            throw new RuntimeUnavailable(`槽位 ${spec.id} 的启动已被取消。`);
        }
        if (this.agents.has(spec.id)) {
            throw new RuntimeUnavailable(`槽位 ${spec.id} 已存在；slot id 必须唯一。`);
        }
        const agent = {
            id: `mem-${spec.id}`,
            spec,
            // 私有上下文：只有自己的 systemPrompt，不含任何其他槽位的内容。
            context: [`[system] ${spec.systemPrompt}`],
            state: 'idle',
            closed: false,
            interrupted: 0,
            wakeCount: 0,
            steerWhileIdle: 0,
            waiters: [],
        };
        this.agents.set(spec.id, agent);
        return { id: agent.id, slot: spec.id, runtimeRef: agent.id };
    }
    /**
     * 投递。`mode` 决定是否唤起。
     *
     * 对 `wake`：空闲成员被叫起来（`idle → running`），并唤醒所有等待者。
     * 对 `steer`：只在目标正在运行时融入当前回合；目标空闲时消息被排队但不唤起，
     * 这一差异被计数（`steerWhileIdle`）以便测试与诊断，而不是被静默吞掉。
     */
    async deliver(handle, delivery) {
        const agent = this.mustGet(handle);
        if (agent.state === 'inactive') {
            throw new RuntimeUnavailable(`槽位 ${handle.slot} 处于 inactive，无法投递。`);
        }
        agent.context.push(`[${delivery.kind}/${delivery.mode}] ${delivery.text}`);
        this.deliveries.push({ slot: handle.slot, delivery });
        if (delivery.mode === 'wake') {
            if (agent.state === 'idle') {
                agent.state = 'running';
                agent.wakeCount += 1;
            }
            this.notifyWaiters(agent);
            return;
        }
        if (agent.state === 'idle') {
            agent.steerWhileIdle += 1;
        }
    }
    async interrupt(handle) {
        const agent = this.mustGet(handle);
        agent.interrupted += 1;
        agent.state = 'idle';
        agent.context.push('[interrupt] 当前回合被协调器中断以参加例会。');
        this.notifyWaiters(agent);
    }
    async waitForActivity(handle, timeoutMs, signal) {
        if (this.options.disableWaitForActivity === true) {
            throw new RuntimeUnavailable('内存运行时被配置为不支持 waitForActivity。');
        }
        const agent = this.mustGet(handle);
        if (signal?.aborted === true) {
            return { kind: 'timeout', detail: `槽位 ${handle.slot} 的等待已被取消。` };
        }
        return await new Promise((resolve) => {
            let settled = false;
            const settle = (observation) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                const index = agent.waiters.indexOf(onActivity);
                if (index >= 0)
                    agent.waiters.splice(index, 1);
                resolve(observation);
            };
            const onActivity = () => settle({ kind: 'changed', detail: `槽位 ${handle.slot} 产生了新活动。` });
            const timer = setTimeout(() => settle({ kind: 'timeout', detail: `等待 ${handle.slot} 超时。` }), timeoutMs);
            agent.waiters.push(onActivity);
        });
    }
    async close(handle) {
        const agent = this.mustGet(handle);
        agent.closed = true;
        agent.state = 'inactive';
        // 关闭即回收：上下文不再可读，对应 dsh-std 的 zero-leak 语义。
        this.agents.delete(handle.slot);
    }
    /**
     * 内存替身的映射是恒等：会话 id 就是 slot id。
     *
     * 这与真实 DSH 不同（那边会话 id 是上游自己的 UUID），
     * 所以**不要**拿内存替身"能跑通"当成真实宿主也能跑通的证据——
     * 真实映射必须靠 `DshMeetingRuntime.memberSessions()` 按 teammate name 对齐，
     * 或由 `config.memberSessions` 显式给出。
     */
    async memberSessions() {
        return [...this.agents.keys()].map((slot) => ({ slot, sessionId: slot }));
    }
    // --- 仅测试/演示可见的检视与驱动接口 -----------------------------------
    /** 读取某槽位的私有上下文副本。槽位不存在时抛错（而非返回空数组，避免误判）。 */
    inspectContext(slot) {
        return [...this.mustGetBySlot(slot).context];
    }
    /** 某槽位的私有上下文是否包含给定子串。 */
    contextContains(slot, needle) {
        return this.inspectContext(slot).some((line) => line.includes(needle));
    }
    /** 某槽位被唤起的次数。 */
    wakeCount(slot) {
        return this.mustGetBySlot(slot).wakeCount;
    }
    /** 用 steer 语义发给空闲成员、因而没能唤起它的条数。 */
    steerWhileIdle(slot) {
        return this.mustGetBySlot(slot).steerWhileIdle;
    }
    state(slot) {
        return this.mustGetBySlot(slot).state;
    }
    /** 测试/演示用：模拟成员"干完活了，回到空闲等下一次唤起"。 */
    markIdle(slot) {
        this.mustGetBySlot(slot).state = 'idle';
    }
    /** 测试/演示用：模拟成员正在自己的回合里工作。 */
    markRunning(slot) {
        this.mustGetBySlot(slot).state = 'running';
    }
    /**
     * 测试/演示用：模拟成员在自己的**私有上下文**里干活。
     *
     * 这些内容永远不会通过 `deliver()` 流转到别的槽位——这正是要断言的不变量。
     */
    recordPrivate(slot, text) {
        this.mustGetBySlot(slot).context.push(`[private] ${text}`);
    }
    /** 仍然存活的槽位。用于验证 `shutdown()` 的回收语义。 */
    liveSlots() {
        return [...this.agents.keys()].sort();
    }
    notifyWaiters(agent) {
        const waiters = [...agent.waiters];
        for (const waiter of waiters)
            waiter();
    }
    mustGet(handle) {
        const agent = this.agents.get(handle.slot);
        if (agent === undefined || agent.id !== handle.id) {
            throw new RuntimeUnavailable(`句柄 ${handle.id} 已失效（槽位 ${handle.slot} 已关闭或被替换）。`);
        }
        return agent;
    }
    mustGetBySlot(slot) {
        const agent = this.agents.get(slot);
        if (agent === undefined) {
            throw new RuntimeUnavailable(`槽位 ${slot} 不存在或已关闭；无法检视其状态。`);
        }
        return agent;
    }
}
//# sourceMappingURL=in-memory-runtime.js.map