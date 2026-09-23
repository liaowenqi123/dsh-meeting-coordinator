/**
 * 组合期 preflight 规则：让 `compose()` 知道本协议的 provider/consumer 关系。
 *
 * ## 为什么必须有这个文件
 *
 * 这不是可选的优化，而是**装配能否成功的前提**。实测（`pnpm run probe:composition`）：
 * 只注册 `ProtocolDefinition` 而不注册 `ProtocolCompositionRule` 时，
 * `compose()` 产出的 `activationOrder` 是**按 participantId 的字母序**，
 * 例如 `agent-live-trading` 排在 `coordinator` 之前。
 *
 * 于是 `LifecycleCoordinator` 会先激活成员 facet。而成员 facet 在激活前要做
 * pre-activation 协商（`activateOne` 里的 `this.protocols.negotiate(...)`），
 * 此时协调器的 support 还没发布，协商直接失败：
 *
 * ```
 * facet ...#agent-live-trading requirements are unavailable: 没有任何 support 提供 BriefingBoard。
 * ```
 *
 * 上游 `facetActivationOrder` 的顺序完全由 `bindings` 推导
 * （`node_modules/@dsh-std/composition/lib/index.js`），而 `bindings` 只由
 * 相应协议的 `ProtocolCompositionRule.preflight` 产出。所以**声明了 requires/supports
 * 还不够，必须同时给出把两者连起来的规则**。
 *
 * ## 规则做什么
 *
 * 1. 为每个 requirement 指出它可能绑定的 support，从而建立 provider → consumer 顺序边；
 * 2. 在"消费方没指定 boardDomain、而候选 coordinator 分属不同板"时报歧义，
 *    因为这种歧义在组合期就能发现，不该拖到激活期才炸。
 *
 * 注意：真正的 coordinator 仲裁仍由 `negotiate` + 显式 policy 完成
 * （注册顺序不能作为仲裁规则）。本规则只负责"连边"和"尽早报警"。
 */
import type { ProtocolCompositionRule } from '@dsh-std/composition';
export declare const briefingBoardCompositionRule: ProtocolCompositionRule;
//# sourceMappingURL=meeting-composition-rule.d.ts.map