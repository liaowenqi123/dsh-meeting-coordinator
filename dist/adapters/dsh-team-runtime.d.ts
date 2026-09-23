/**
 * DSH 运行时适配层。
 *
 * ## 这个文件是整个仓库里**唯一**接触上游 DSH 形状的地方
 *
 * 它刻意做到了三件事，直接对应"隔离上游破坏性变更、降低维护成本"这一目标：
 *
 * 1. **零 `@deepseek-ai/*` import**。全仓库不存在对上游包的类型依赖，
 *    上游重构导出、改包名、改类型都不会让本插件编译失败。
 *    做法抄自 `@dsh-std/adapter-dsh` 自己：它把会话适配器的上游形状
 *    声明为本地结构接口（`DshSessionControllerFace`），并用新旧字段双读兼容。
 * 2. **所有上游成员都是 optional**。上游删掉 `interrupt`，这里只是能力探测返回
 *    `canInterrupt: false`，而不是编译期爆炸或运行期 `undefined is not a function`。
 * 3. **能力是探测出来的，不是假设出来的**。拿不到 `agentTeams` 就明确报告降级，
 *    绝不假装能开会 —— dsh-std core 反复强调的
 *    "安装了某个包不能代替运行中的 support 声明"，这里把同一原则用在适配层。
 *
 * ## 已核实的上游形状（基线：`@deepseek-ai/dsh@0.1.6-alpha.2`）
 *
 * 来源：`node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/index.d.ts`
 * 与 `.../types.d.ts`（该包随 dsh 自身嵌套安装）：
 *
 * - `spawnTeammate(caller, { name, description, prompt: ContentBlock[], context: 'fresh'|'fork',
 *    provider, signal }) => Promise<{ member }>`
 * - `sendMessage(caller, { target, content: ContentBlock[], signal }) => Promise<{ messageId, status }>`
 * - `interrupt(caller, targetName) => { previousStatus }`
 * - `createTask(caller, { subject, description, blockedBy?, writeScopes? })`（原生共享任务板）
 *
 * `ContentBlock` 的文本形态为 `{ type: 'text', text: string }`。
 *
 * ## 两条上游路径的取舍（诚实记录）
 *
 * | | `ctx.agentTeams` | `ctx.subagents` |
 * |---|---|---|
 * | 持久 peer 信箱 | ✅ 原生 | ❌ |
 * | 共享任务板 / 写域隔离 | ✅ `createTask(writeScopes)` | ❌ |
 * | 指定 `model` / `reasoningEffort` | ❌ 无 `agentOptions` | ✅ `agentOptions` |
 *
 * 例会场景需要的是"持久信箱 + 名册 + 任务 DAG"，所以默认走 `agentTeams`；
 * 领域隔离靠**不同的 systemPrompt**达成，而不是靠不同模型。
 * 需要按槽位选模型时显式传 `preferred: 'subagents'`，代价是失去原生信箱。
 */
import type { AgentSlotId } from '../core/types.js';
import type { AgentRuntimePort } from '../ports/agent-runtime.js';
/** DSH `ContentBlock` 的文本形态。 */
export interface DshContentBlockFace {
    readonly type: string;
    readonly text?: string | undefined;
}
/** `ctx.agentTeams`（`TeamService`）我们实际用到的成员。 */
export interface DshTeamServiceFace {
    spawnTeammate?(caller: unknown, request: {
        readonly name: string;
        readonly description: string;
        readonly prompt: readonly DshContentBlockFace[];
        readonly context: 'fresh' | 'fork';
        readonly provider: string;
        readonly signal: AbortSignal;
    }): Promise<unknown>;
    sendMessage?(caller: unknown, request: {
        readonly target: string;
        readonly content: readonly DshContentBlockFace[];
        readonly signal: AbortSignal;
    }): Promise<unknown>;
    interrupt?(caller: unknown, targetName: string): unknown;
    listMembers?(caller: unknown): readonly unknown[];
    /** 等待下一次 Team 域活动。用于会议后收简报。 */
    waitForChange?(caller: unknown, timeoutMs: number, signal: AbortSignal): Promise<unknown>;
    createTask?(caller: unknown, request: {
        readonly subject: string;
        readonly description: string;
        readonly blockedBy?: readonly string[] | undefined;
        readonly writeScopes?: readonly string[] | undefined;
    }): Promise<unknown>;
}
/** `ctx.subagents`（`SubagentRuntime`）我们实际用到的成员。 */
export interface DshSubagentRuntimeFace {
    start?(provider: string, request: {
        readonly label?: string | undefined;
        readonly prompt: readonly DshContentBlockFace[];
        readonly parent: unknown;
        readonly signal: AbortSignal;
        readonly agentOptions?: {
            readonly model?: string | undefined;
            readonly reasoningEffort?: string | undefined;
        } | undefined;
    }): Promise<unknown>;
    sendMessage?(sender: unknown, targetId: unknown, content: readonly DshContentBlockFace[], options?: unknown): Promise<unknown>;
    interrupt?(id: unknown, reason?: string): Promise<unknown> | unknown;
    stop?(id: unknown, reason?: string): Promise<unknown> | unknown;
}
/** Cordis `Context` 的极窄视图：只用到 `get`。 */
export interface DshContextFace {
    get?(name: string): unknown;
}
export type DshBackend = 'agentTeams' | 'subagents';
export interface DshMeetingRuntimeOptions {
    /** Cordis `Context`；只读它的 `get()`。 */
    readonly ctx: DshContextFace;
    /**
     * 解析"当前活的 Lead Agent"。
     *
     * 必须是**惰性**的：`agentTeams` 的每个方法都要求一个 exact live Agent 作为授权凭据，
     * 而插件在 `apply()` 时通常还没有绑定到具体会话。
     * 惰性解析避免了在装载期固化一个会过期的 agent 引用 —— 这也是上游
     * `tryMembership` 存在的理由（"stale identities" 会返回 undefined）。
     */
    readonly resolveCaller: () => unknown | Promise<unknown>;
    /** 后端选择。默认 `agentTeams`（有原生持久信箱与任务板）。 */
    readonly preferred?: DshBackend | undefined;
    /** 子 Agent 上下文模式。**默认 `fresh`**，见下方说明。 */
    readonly contextMode?: 'fresh' | 'fork' | undefined;
    /** 上游 provider 名。`spawn` 为全新上下文，`fork` 继承父上下文。 */
    readonly provider?: string | undefined;
    /** 单次上游调用的超时（毫秒）。默认 30 秒。 */
    readonly callTimeoutMs?: number | undefined;
}
export declare function createDshMeetingRuntime(options: DshMeetingRuntimeOptions): AgentRuntimePort;
/** 从 Cordis `Context` 取服务；`get` 本身也可能缺失。 */
export declare function readService(ctx: DshContextFace, name: string): unknown;
/** 值是否至少具备给定成员之一 —— 避免把任意对象误认成服务。 */
export declare function isFace<T>(value: unknown, members: readonly string[]): T | undefined;
/**
 * `ctx.agents`（`AgentRegistry`）我们实际用到的成员。
 *
 * 按 `@deepseek-ai/dsh@0.1.6-alpha.2` 的 `.d.ts` 核对：
 * `AgentRegistry extends Service`，提供 `currentInitiator()` / `requireInitiator()` /
 * `roots()` / `list()` / `get(id)`。
 */
export interface DshAgentRegistryFace {
    /** 读"继承了当前异步驱动链的发起者 Agent"。**非 Agent 驱动的路径下为 undefined。** */
    currentInitiator?(): unknown;
    /** 同上，但没有发起者边界时**抛错**。 */
    requireInitiator?(): unknown;
    /** 无 owner 的根 Agent（Lead）。 */
    roots?(): readonly unknown[];
    list?(): readonly unknown[];
    get?(id: unknown): unknown;
}
/** 一个对象是否长得像"活的 Agent"：上游 `tryMembership` 第一件事就是读 `agent.id`。 */
export declare function isLiveAgent(value: unknown): boolean;
/**
 * 解析一个**确实活着的 Agent** 作为上游授权凭据。
 *
 * ## 为什么必须这样解，而不能直接返回 `ctx.get('agents')`
 *
 * 实测踩过：`apply(ctx)` 里把 `ctx.get('agents')` 原样交给 `spawnTeammate`，
 * 上游报 `agent "undefined" is not a member of an active Agent Team` ——
 * 因为它读 `agent.id`，而服务对象没有 `id`。上游的 `tryMembership` 第一条判据是
 * `ctx.agents.get(agent.id) === agent`（**exact live Agent**，同一个对象引用），
 * 所以只能从 registry 里取，不能自己造。
 *
 * ## 三级取值，顺序有理由
 *
 * 1. `currentInitiator()` —— 在 Agent 驱动的调用链里最准确（就是"是谁发起的"）；
 *    但它是 AsyncLocalStorage 语义，**插件加载与定时器路径下必然为 undefined**。
 * 2. `roots()[0]` —— 无 owner 的根 Agent（Lead）。非 Agent 驱动路径只有它可用。
 * 3. `list()[0]` —— 兜底：任何活着的 Agent 都能当授权凭据。
 *
 * 都拿不到时返回 `undefined`（由调用方决定是报错还是稍后重试）——
 * 这**不是**异常情况：`dsh web` 刚启动、用户还没开任何会话时就是如此。
 */
export declare function resolveLiveAgent(ctx: DshContextFace): unknown;
/**
 * 槽位 id -> 上游 teammate 名。
 *
 * 上游要求 lower-kebab-case，且名字是持久身份（收件箱按名字寻址），
 * 因此这里必须是**确定性**映射：同一个 slot id 永远得到同一个名字。
 */
export declare function teammateName(slot: AgentSlotId): string;
//# sourceMappingURL=dsh-team-runtime.d.ts.map