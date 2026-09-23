# @dsh-std/adapter-dsh 代码考古报告

> 只读调研，基于 `D:\tmp\dsh-std-ref`（版本 `0.1.1-rc.3`，`package.json:3`）。
> 两处与任务描述不符，先更正：`src/index.ts` 实为 **1968 行**（非 1859）；peerDependencies 已是**双区间**，不是单一 `0.1.2` 区间（见第 7 节）。

## 1. 运行形态与入口导出

**它是 cordis 插件，同时是一个库**——两者不矛盾：`index.ts` 既 `export async function apply(ctx, config)`（`index.ts:1953`、`export default apply` `index.ts:1968`），又把核心类导出供宿主直接 `new`。

它本身是一个 **DSH profile bundle**，靠 `cordis.patch.yml` 被激活（`cordis.patch.yml:1-5` 插入 `id: dsh-std-adapter`），并在 `package.json:101-115` 声明 `dsh.bundle.patch` 与 `dsh.client.inject`（5 个 DSH 客户端包，`platform: web`）。`apply` 会顺带扫描 profile 依赖并自动 mount 标准组件（`index.ts:1955-1962`）。

主要导出（`index.ts`）：

- `name`(`:178`)、`DSH_STD_NAMESPACE`(`:179`)、`DSH_ACTIVATION_*`(`:180-182`)
- 12 个协议常量 `DSH_COMMAND_API_VERSION`…`DSH_SKILL_KIND`（`:184-195`）
- 类型：`AdapterConfig`(`:205`)、`DshRuntimeDescriptor`(`:214`)、`DshFacetSnapshot`(`:245`)、`DshRuntimeSnapshot`(`:251`)、`DshCommandSurfaceProvider`(`:810`) 等
- 类：`DshStandardAdapter extends TypertRemoteService`(`:946`)、`DshStandardModelAdapter`(`:752`)
- 工厂：`createDshProtocolCatalog()`(`:1731`)、`createDshManifestCatalog()`(`:1746`)

子入口：`./client`(`src/client.ts`，浏览器半)、`./typert`(`TYPERT` `typert.ts:98`)、`./profile-loader`(`profile-loader.ts:14`)。

## 2. 消费的 DSH 内部 API（破坏性变更暴露面）

静态 import 集中在 4 个文件，这是真正会被上游打断的清单：

| 文件:行 | 模块 | 符号 |
|---|---|---|
| `index.ts:6` | `@deepseek-ai/cordis` | `Context` |
| `index.ts:7` | `dsh-session` | `KNOWN_SESSION_EVENT_TYPES` |
| `index.ts:8-9` | `dsh-llm` | `createUserMessage`、`LlmAdapter`（基类）+ 6 个类型 |
| `index.ts:9` | `dsh-attachment` | `AttachmentStore`（type） |
| `index.ts:11` | `dsh-skill` | `SkillRegistry`（type） |
| `index.ts:12-17` | `dsh-tools` | `ToolDefinition`、`ToolRunContext`、`ToolRuntime`（type） |
| `index.ts:18` | `dsh-agent` | **空 type import**，纯粹为类型合并 |
| `index.ts:19` | `dsh-typert-protocol` | `Remote`、`TypertRemoteService`（`extends`） |
| `index.ts:20` | `schemastery` | `z` |
| `client.ts:3,5-7` | cordis / `dsh-client-ui-settings/client` / `dsh-client-ui-tool/client` / `dsh-typert-protocol` | `Context`、`Service`、类型 |
| `binary-fs.ts:7-8` | cordis / `dsh-tools` | 仅 type |
| `skill-provider.ts:3-10` | `dsh-skill` | `SkillProvider` 等 type |
| `profile-loader.ts:3-4` | cordis / schemastery | `Context`、`z` |

**关键反证**：`dsh-commands`、`dsh-api-gateway`、`dsh-api-session-controller`、`dsh-client-modules`、`dsh-scope` **在 src 里完全没有 import**（peerDeps 里列它们只因 `dsh.client.inject` 与运行时服务查找）。服务通过 `ctx.get('agents'|'llm'|'sessionController'|'tools'|'skills'|'attachments'|'fs')` **字符串 + 强制断言**取得（`index.ts:369,381-382,985,1001,1588,1724`），`static inject = ['agents','llm','sessionController']`（`index.ts:947`）。

这是它隔离上游变更的真手法：**结构化类型 + `ctx.get` 鸭子类型 + `as unknown as`**，而非依赖 DSH 的导出类型。`session-adapter.ts` 整个文件 **零 `@deepseek-ai/*` import**，只用自造的 `DshSessionControllerFace`（`session-adapter.ts:76`，注释明写"Structural face shared by supported DSH 0.1.2 and 0.1.5 Session Controllers"），并兼容新旧字段（`seedLength` vs `inheritedEventCount`，`session-adapter.ts:39-40,358`）。

## 3. 向上提供的抽象

**对业务插件（组件作者）：adapter-dsh 不提供任何东西，而且不该 import 它**。README 明确："Standard plugins neither declare `dsh.bundle` nor import this adapter"(`README.md:9`)。业务插件面向的是 `@dsh-std/lifecycle` 的 `ActivationContext`（`packages/lifecycle/src/index.ts:78-90`），adapter 只是把这些 publication 投影进 DSH：

```ts
// 真实用法：adapter.spec.ts:219-241（宿主侧 mount 一个 facet）
await adapter.mount({
  manifest,                       // defineComponentManifest(...) 产物
  facet: 'runtime',
  activate(activation) {          // activation: ActivationContext
    activation.extensions.publish(
      { apiVersion: DSH_COMMAND_API_VERSION, kind: 'Command' },
      'account',
      { execute: () => ({ kind: 'success', text: 'copy the URL' }) },
    )
    activation.extensions.publish(
      { apiVersion: DSH_MODEL_API_VERSION, kind: DSH_MODEL_PROVIDER_KIND },
      'example-provider', {},
    )
  },
  snapshot: () => ({ extensions: [{ /* DshExtensionStatus */ }] }),
})
```

`ActivationContext` 给业务插件的只有三样：`identity`、`protocols.implement/client/agreement`、`extensions.publish`（`lifecycle/index.ts:82-89`）。宿主侧另有 `adapter.describe()`(`index.ts:1257`)、`snapshot()`(`:1261`)、`mountProfileComponents()`(`:1209`)、`catalog()/execute()/command()`(`:1353,1387,1525`)、`registerCommandSurfaceProvider()`(`:1143`)、`registerUiContributionProvider()`(`:1157`)。**没有** "typed client factory" 暴露给业务方——scoped client 只在 activation 回调内部可用（`index.ts:1054-1059`）。

## 4. Session 适配方式 —— 与本项目核心需求直接冲突

映射：DSH Session → `SessionCatalog`(list/get/create/rename) + `SessionHistory`(read/follow)（`session-adapter.ts:119-139`）。

**结论：不能用来创建/驱动独立子 Agent 会话。** 四条硬证据：

1. **子会话被显式排除**：`list` 过滤 `item.origin !== 'subagent'`（`session-adapter.ts:179`）；`get` 遇 `meta.origin === 'subagent'` 返回 `undefined`（`:208`）；`read` 直接 `throw new Error('DSH subagent history requires a parent-qualified product address')`（`:292-294`）。测试固化此行为（`session-adapter.spec.ts:134,145-148`）。
2. **create 装不下子会话**：`CreateSessionInput` 只有 `title` 和 `requestId`（`packages/session/src/catalog.ts:61-64`），没有 parent/origin/prompt 字段；实现只调 `controller.create({ sessionId })` + `rename`（`session-adapter.ts:243,251`），sessionId 由 sha256 确定性推导为 `session-std-<hash32>`（`:450-453`）。
3. **没有"跑一轮"的能力**：SessionCatalog 操作集是 `list|get|create|rename|delete|watch`（`catalog.ts:26`），SessionHistory 是 `read|follow|fork`（`history.ts:24`）——**无 prompt/send/turn**。且适配器只声明 `['read','follow']`，主动放弃 fork（`session-adapter.ts:133`；`README.md:26` 说明不主张 DSH 未暴露语义的操作）。
4. **唯一能"驱动"会话的路径绕开了标准协议**：`adapter.command(sessionId, line)`（`index.ts:1525`）经 `this.agent(sessionId)`（`:1722-1727`，走 `ctx.get('agents').get(id)`，取不到就抛 `session ... is not attached`）拿到 agent，再 `session.append('command/run', ...)`（`:1397-1409`）。它要求**会话已由 DSH 自己 attach 到活 agent**，且这是浏览器 Typert Remote 桥（`typert.ts:39-67`），不是标准会话协议。

要"创建并驱动子 Agent"，必须直接消费 DSH 的 `agents` / `sessionController`（或 DSH 内置 subagent 工具）——那正是 adapter-dsh 想帮你隔离的东西。

## 5. 成熟度

**接近完成态，不是骨架。** 在 `src/` 全量 grep `TODO|FIXME|not implemented|as any|: any` **零命中**。`any` 只在 `unknown` + 显式窄化处出现（如 `as unknown as DshSessionControllerFace` `index.ts:985`），且 `index.ts:1913-1943` 有一整套 `exact()/nonEmpty()/assert*` 运行时校验。

工程细节到位：生命周期回滚（`index.ts:1303-1350`）、mount 失败逆序 dispose（`:1251-1254`）、分页快照指纹缓存（`session-adapter.ts:177-203`）、create 幂等收据（`:217-261`）、mutation 串行化（`:279-283`）、技能路径穿越防护（`skill-provider.ts:134-139`）。

测试规模：`adapter.spec.ts` 1116 行 / `session-adapter.spec.ts` 415 行 / `client.spec.ts`。CHANGELOG 5 个版本，最新 `0.1.1-rc.3` 记录 5 条（`CHANGELOG.md:3-9`），含明确的**行为修复**（create 重试不再覆盖后续改名）与**上游适配**（对齐 DSH `0.1.5-rc.2`：generic-file-aware model dispatch、branded command event positions、awaitable browser facet cleanup，同时保留旧 `0.1.2` peer 线）。

**已知缺口（作者自认）**：create 收据只存在内存中，适配器重建后无法跨重启重放原始结果（`README.md:28`）；不提供 delete/watch/fork（`README.md:26`）。

## 6. 对本项目的取舍

**只依赖 `@dsh-std/core` + `@dsh-std/manifest` + 自有协议，会失去：**
- 协议/清单定义注册表（`createDshManifestCatalog` `index.ts:1746-1758` 注册 8 个 extension + UI 定义）；
- 真正的 DSH 投影：`ctx.llm.registerAdapter()`（`index.ts:1565`）、`tools.register()`（`:1602`）、Skill provider（`skill-provider.ts:119-132`）、命令运行时、浏览器桥；
- 会话映射与 connection 端点（`index.ts:1018-1019`）、activation 驱动与组合校验。

**但**：如果你写的是**标准组件**，这些本来就不该由你承担——组件只发布 publication，投影是宿主职责（`README.md:9,22,26`）。所以对"开会插件"本身，**core + manifest + lifecycle + session + 自有协议是正确且被设计的路径**。

**只用 adapter-dsh 够不够？不够**——它不含任何上游 DSH 多 Agent 编排能力（第 4 节），也无法替你创建子会话来开会。它是**宿主适配层**，不是"多 Agent 能力包"。你的插件需要一个 adapter-dsh 之外的东西：直接对接 DSH `agents`/subagent，或给 dsh-std 补一个 `SessionTurn`/`AgentSpawn` 类协议（当前不存在，`catalog.ts:26` + `history.ts:24` 已穷举操作集）。

## 7. peerDependencies 区间与稳定性策略

**更正**：实际是 `">=0.1.2-alpha.2 <0.1.3 || >=0.1.5-rc.2 <0.1.6"`，13 个 DSH 包同款双区间（`package.json:38-49`），不是单一区间。

**该区间对"隔离上游变更"基本无效，隔离靠的是结构，不是版本号：**
1. 区间是**手工维护的 OR 列表**，每支持一个新的 DSH 版本就要加一条 OR——`CHANGELOG.md:7` 正是"适配 0.1.5-rc.2 同时保留旧 0.1.2 peer 线"。这是**追认兼容**，不是预防。
2. 区间**直接跳过** `0.1.3`、`0.1.4` 全线，也不接受 `0.1.6+`；用户装 DSH `0.1.6` 会直接 peer 冲突。它表达的是"我测过这两个"，不是"我能扛变更"。
3. 真正的韧性来自**结构化鸭子类型**：`DshSessionControllerFace`（`session-adapter.ts:76`）、`DshAgentLike`（`index.ts:275`）、一切 `ctx.get(...) as unknown as X`。上游改导出类型不影响编译，只有**运行时形状**变了才炸。
4. 由于第 3 点，区间**给不出安全保证**：peer 通过 ≠ 运行时不炸，因为编译期根本没检查那些形状。
5. 实际验证基线是 devDeps 的 `0.1.5-rc.2`（`package.json:83-96`），不是 peer 区间下界。

**稳定性策略**（可归纳为 4 条，对我们的借鉴价值最高）：
- 上游类型**只做 type import**，值层面尽量不引入（`dsh-agent` 只 `import type {}`，`index.ts:18`）；
- 一切产品服务走 `ctx.get('<string>')` + 结构接口，并容忍新旧字段双读（`index.ts:985`，`session-adapter.ts:39-40`）；
- **可选依赖全部 `peerDependenciesMeta.optional`**（`package.json:53-60`），缺失时优雅降级（`skills` 缺失就不装 provider，`index.ts:1001-1004`）；
- 不主张上游没有等价语义的操作（不实现 delete/watch/fork，`README.md:26`）。

**对我们的行动建议**：adapter-dsh 可作为"如何隔离 DSH"的**模板**照抄（结构接口 + ctx.get + optional peer），但不能作为多 Agent 编排的实现基础。开会插件若要驱动子 Agent，需自建协议并直接对接 DSH `agents`，同时接受这层耦合——目前 dsh-std 尚无该协议。
