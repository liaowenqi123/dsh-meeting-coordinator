/**
 * 运行时端口：协调器与"上游 Agent 运行时"之间**唯一**的接触面。
 *
 * ## 为什么要有这一层（这是对"降低未来维护成本"的直接回答）
 *
 * dsh-std 的 README 把 adapter 定义为"single-point shock absorber"：
 * 上游 DSH 可以激进重构，破坏性变更必须被收敛在一个适配层里。
 * 但 `@dsh-std/adapter-dsh` 是**宿主**适配层——它自己的 README 明确写着
 * 「Standard plugins neither declare dsh.bundle nor import this adapter」，
 * 即业务插件**不应** import 它。所以业务插件要自建自己的适配层。
 *
 * 本文件即该适配层的**上半部分**：领域侧只认识这些端口，
 * 不认识 `ctx.agentTeams`、`ctx.subagents`、Cordis `Context` 或任何 `@deepseek-ai/*` 符号。
 *
 * 下半部分在 `src/adapters/`，是整个仓库里**唯一**允许接触上游形状的地方。
 */
/** 运行时不可用时的统一错误。 */
export class RuntimeUnavailable extends Error {
    code = 'meeting/runtime-unavailable';
    constructor(message) {
        super(message);
        this.name = 'RuntimeUnavailable';
    }
}
//# sourceMappingURL=agent-runtime.js.map