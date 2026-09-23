/**
 * DSH 模型调用适配：把"某个会话说一句话"接到上游的真实模型上。
 *
 * ## 上游机制（已按 `@deepseek-ai/dsh@0.1.6-alpha.2` 的 `.d.ts` 核对）
 *
 * ```
 * const run = await ctx.subagents.start('spawn', {
 *   label, prompt: ContentBlock[], parent: Agent, signal,
 *   agentOptions: { model },          // ← 支持按会话指定模型
 * })
 * const result = await run.result     // SubagentResult
 * result.output                       // ContentBlock[]，最后一个非空 assistant 消息
 * await run.dispose()
 * ```
 *
 * 要点：
 * - `spawn` 提供**一次性（one-shot）**子运行，**上下文干净**，并且**能读回最终输出**；
 * - `agentOptions.model` 支持按调用指定模型 → 这就兑现了需求里的
 *   "**每个参会就使用那个会话的对应模型**"；
 * - `run.result` 在子级失败时**不 reject**，而是以 `stopReason: 'error'` 解析，
 *   所以必须检查 `stopReason`（忽略它会把一次失败当成"沉默的成员"）。
 *
 * 对比另一条路：`ctx.agentTeams.sendMessage` 是**持久信箱**，只返回
 * `{ messageId, status }`，**不回传发言内容**——因此它适合做"唤起/通知"，
 * 不适合做"让某个会话发言并读回结果"。例会需要后者，所以这里走 `subagents`。
 *
 * ## 为什么每轮用一次性调用，而不是累积同一个子会话
 *
 * 三层理由：
 *
 * 1. **可行性**：只有 one-shot 路径能直接读回输出；
 * 2. **上下文预算**：每轮干净调用 + 显式注入"该会话的记忆投影 + 群聊记录"，
 *    使单轮上下文恒有界。若让子会话累积，N 人 × R 轮的群聊会把上下文撑爆
 *    （调研里 Selector/Swarm 的"broadcast 给所有成员"就是这个坑）；
 * 3. **归属清晰**：会话的**身份与记忆**由 `AgentParticipant` 持有（在我们这里），
 *    上游子运行只是"这次发言的执行者"。记忆不会因为上游会话生命周期而漂移。
 *
 * 代价说清楚：成员在会上的多轮发言之间**没有上游侧的上下文连续性**，
 * 连续性靠协调器把 transcript 注入每一轮 prompt 来维持。
 * 若将来需要真正的持久子会话，用 `startContinuable` + 会话事件观察替代本实现。
 */
import type { DshContextFace } from './dsh-team-runtime.js';
import type { MeetingVoicePort } from '../ports/meeting-voice.js';
import type { ModeratorPort } from '../core/moderator.js';
/** DSH `ContentBlock` 的文本形态。 */
export interface DshContentBlockFace {
    readonly type: string;
    readonly text?: string | undefined;
}
/** `SubagentResult` 我们实际用到的字段。 */
export interface DshSubagentResultFace {
    readonly output?: readonly DshContentBlockFace[] | undefined;
    readonly diagnostic?: string | undefined;
    readonly stopReason?: string | undefined;
}
/** `SubagentRun` 我们实际用到的字段。 */
export interface DshSubagentRunFace {
    readonly id?: unknown;
    readonly result?: Promise<DshSubagentResultFace> | undefined;
    dispose?(): Promise<void> | void;
}
/** `ctx.subagents`（`SubagentRuntime`）我们实际用到的成员。全部 optional。 */
/** `ToolRestriction`（上游 `@deepseek-ai/dsh-tools`）我们实际用到的字段。 */
export interface DshToolRestrictionFace {
    /** 留下的工具名；**其余全部移除**。空数组 = 全部禁用。 */
    readonly allow?: readonly string[] | undefined;
    readonly deny?: readonly string[] | undefined;
}
export interface DshSubagentServiceFace {
    start?(name: string, request: {
        readonly label?: string | undefined;
        readonly prompt: readonly DshContentBlockFace[];
        readonly parent: unknown;
        readonly signal: AbortSignal;
        /** 角色/人格（`SubagentStartRequest.persona`）。 */
        readonly persona?: string | undefined;
        /**
         * **工具白名单**（`SubagentStartRequest.toolFilter`）。
         *
         * 上游语义：「the named tools **vanish from the child's prompt** AND refuse to execute」。
         * 这就是"开会的子 Agent 不该是 Agent"的落点：它只是**带着上下文来讨论的一个人**，
         * 不该有工具去重新探索项目。空 `allow` = 一个工具都不给。
         */
        readonly toolFilter?: DshToolRestrictionFace | undefined;
        readonly agentOptions?: {
            readonly model?: string | undefined;
        } | undefined;
    }): Promise<DshSubagentRunFace>;
    getProvider?(name: string): unknown;
    list?(): readonly string[];
}
export interface DshOneShotOptions {
    readonly ctx: DshContextFace;
    /**
     * 解析"当前活的 Agent"作为 `parent`。
     *
     * 必须是惰性的：插件装载时还没有绑定到具体会话。上游要求 `parent` 是
     * exact live Agent，用来派生 workspace、lineage 与 delegation depth。
     */
    readonly resolveCaller: () => unknown | Promise<unknown>;
    /** 子运行 provider 名。默认 `spawn`（全新上下文）。 */
    readonly provider?: string | undefined;
    /** 单次调用的超时（毫秒）。默认 120 秒（模型调用比 RPC 慢得多）。 */
    readonly callTimeoutMs?: number | undefined;
}
/**
 * 一次性模型调用：给一段 prompt，拿回一段文本。
 *
 * 说话、纪要、主持人控场都建立在它之上——只有一个"怎么调模型"的实现，
 * 避免三处各写一遍错误处理。
 */
export interface DshOneShotRunner {
    readonly port: string;
    capabilities(): {
        readonly available: boolean;
        readonly notes: readonly string[];
    };
    run(input: {
        readonly label: string;
        readonly prompt: string;
        readonly model?: string | undefined;
        /** 角色/人格，送到上游 `persona`。 */
        readonly persona?: string | undefined;
        /**
         * **以谁的身份发言**（那个人的 exact live Agent）。
         *
         * 给了它就走 `fork` provider：上游会把那个人**已完成的对话轮次一次性
         * seed 进子会话**（`dsh-subagent-fork-in-process` 的原生语义），
         * 于是这个子 Agent **就是**那个人，而不是"读过它资料的陌生人"。
         *
         * 不给就退回 `spawn`（干净上下文），由 prompt 里的上下文注入兜底。
         */
        readonly forkFrom?: unknown;
        /**
         * 工具白名单。**默认全禁**（`{ allow: [] }`）。
         *
         * 开会的子 Agent 不是 Agent——它只是**带着上下文来讨论的一个人**。
         * 给它工具它就会回去重新探索项目、边开会边干活，狂暴烧 token。
         * 用提示词劝是没用的，必须**直接不给它工具**。
         */
        readonly toolFilter?: DshToolRestrictionFace | undefined;
        readonly signal?: AbortSignal | undefined;
    }): Promise<string>;
}
export declare function createDshOneShotRunner(options: DshOneShotOptions): DshOneShotRunner;
/**
 * 从 `SubagentResult` 里取文本。
 *
 * 三个必须处理的真实情况：
 * 1. `stopReason !== 'completed'` → 抛错。**不能**把失败当成"这位成员没话说"，
 *    否则一场因为模型全挂而沉默的会议，看上去像"大家都没意见"。**这是最危险的静默失败。**
 * 2. `output` 为 undefined/空 → 抛错（同上，沉默不等于同意）。
 * 3. 只有非 text block → 抛错（我们不要图片/工具结果当发言）。
 */
export declare function extractOutput(result: DshSubagentResultFace): string;
/**
 * DSH 支持的 `MeetingVoicePort`：成员发言与会后纪要。
 *
 * 每次调用都是一次干净的 one-shot 运行，prompt 由协调器构造
 * （含该成员自己的记忆投影与群聊记录），并使用**该会话自己的模型**。
 */
export declare function createDshMeetingVoice(runner: DshOneShotRunner): MeetingVoicePort;
/**
 * DSH 支持的 `ModeratorPort`：**没有上下文**的控场者。
 *
 * 它发出的 prompt 只由 `buildModeratorPrompt()` 产出（群聊记录 + 名单 + 谁没说话），
 * `model` 是**召集者会话的模型**。与会者之间没有私有记忆进入这个调用。
 */
export declare function createDshModerator(runner: DshOneShotRunner): ModeratorPort;
//# sourceMappingURL=dsh-meeting-voice.d.ts.map