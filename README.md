# dsh-meeting-coordinator

> 给一群长跑的 Agent 装上「**会议室**」与「**互相唤起**」。
> 基于 [dsh-std](https://github.com/Yan-Zero/dsh-std) 元协议开发，为 DeepSeek Harness 提供多 Agent 协作。

[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-blue)](#安装)
[![CI](https://github.com/liaowenqi123/dsh-meeting-coordinator/actions/workflows/ci.yml/badge.svg)](https://github.com/liaowenqi123/dsh-meeting-coordinator/actions/workflows/ci.yml)
[![dsh-std](https://img.shields.io/badge/dsh--std-Community%20v0.15-green)](https://github.com/Yan-Zero/dsh-std)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](#快速开始)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)

**⚠️ 早期阶段 / Early stage.** 核心机制已经跑通并有 215 个测试覆盖，但**还没在真实生产场景里长期跑过**。
遇到问题请开 [Issue](https://github.com/liaowenqi123/dsh-meeting-coordinator/issues) —— **非常欢迎反馈、提 bug、发 PR**，见[欢迎贡献](#欢迎贡献反馈与已知不足)。

---

## 一、精髓：开会，和互相唤起

单个 Agent 长时间工作时会得三种病：**上下文污染**、**死循环**（在自己的上下文里反复确认同一个错误结论）、
**遗忘全局目标**。多 Agent 并行的方案很多，但真正难的是"**持续循环跑下去**"。

本插件的答案不是更好的提示词，而是**给 Agent 们一个组织**。

### 1.1 一个新的概念：会议室（群）

关键区分——**不是会话属于会议，而是会话加入会议室**：

```
   会话 A ──┐                      ┌── 会话 B
            │   加入（主动）        │
            ├──▶  ┌──────────┐  ◀──┤
            │     │  会议室   │     │
   会话 C ──┘     └──────────┘     └── 会话 D（没加入）
                                                    │
                                          叫不动，也不会被误叫
```

- 会议室是**持久实体**，不是每次开会临时建的；
- **加入会议室 = 自动获得「唤起会议」的权利 + 「参会」的义务**。
  没加入的会话，既不能召集，也不会被召集；
- 成员可**跨工作区**（成员列表里带 workspace，但不因此分裂成多个群）；
- **一个会话只能属于一个会议室**。

> 这一条解决的是"**不是每一个会话都是可被召集或唤起的**"：
> 会籍就是权限边界。你的私人助手会话不会因为某个 Agent 想开会就被拉进群聊。

### 1.2 「开会」是什么

不是"协调器把摘要广播出去"。是：

> 每个会话**带着自己的记忆，临时进入会议室**；
> 入场时**预注入一段 prompt**（说明议题、在场有谁、你可以说什么）；
> 会议室是一个**多轮群聊**，由**主持人**控场，像真的开会一样互相回应；
> 会后每个会话**各自**对会议做压缩，只留下**与自己相关**的内容；
> 回去之后，记忆变成「**原私有上下文 + 自己相关的会议纪要**」。

关键在于**每人拿到的纪要是不同的**。如果是"一份全局会议纪要发给所有人"，
那只是把广播换了个说法，别人的全部发言会原封不动挤进我的上下文——那正是污染。

```
  会话 A（记忆A）      会话 B（记忆B）      会话 C（记忆C）
        │                  │                  │
        └──────────┬───────┴───────┬──────────┘
                   ▼               ▼
        ┌────────────────────────────────────────────┐
        │  会议室（多轮群聊，共享 transcript）         │
        │                                            │
        │  入场：定位 prompt + 各自记忆的限长投影      │
        │  发言：主持人控场（主持人没有上下文）         │
        │  人类可随时插话（不占轮次）                  │
        └────────────────────────────────────────────┘
                   │               │
                   ▼               ▼
            A 的个性化纪要    B 的个性化纪要   C 的个性化纪要
              （内容各不相同）
                   │               │
                   ▼               ▼
            记忆A + 纪要A     记忆B + 纪要B   记忆C + 纪要C
```

### 1.3 「互相唤起」是什么

> 一个 agent 选择开会后，可以召集**所有**在工作或者不在工作的 agent
> （不在工作状态指的是输出完毕等待用户回复，或已完成任务），
> 开完会后，**所有 agent 都会回到工作状态**。

所以"唤起"是**状态层面**的动作，而且**正在工作的会话不会被会议打断**：

```
                      summon()
  working ─────▶ awaiting-entry ──(当前工作单元结束)──▶ in-meeting
  idle-waiting ────────────────────────────────────▶ in-meeting
  done ───────────────────────────────────────────▶ in-meeting

                      dismiss()  ──▶ 召集前的状态（还原，不是一刀切）
```

- `working`（正在输出 / 正在调用工具）→ 先进 **`awaiting-entry`**。
  **不打断**，等宿主在"本次输出结束 / 本次工具调用返回"的边界调 `onWorkUnitComplete()` 才入场。
  这就是需求里说的"**有一个等待的过程**"；
- `idle-waiting`（等用户回复）和 `done`（任务已完成）没有工作单元要等，**直接入场**；
- 散会时把每个人**还原到被召集之前的状态**：在跑的还在跑、等用户回复的继续等、
  已完成的仍然完成，包括中途才入场的和始终没入场的（缺席）。
  这解决了"会议开完了，那个已完成的 Agent 该干嘛"的问题。
  ⚠️ 这里曾经写死成"全部推回 `working`"，是一个会让会议室**一次性报废**的 bug：
  从 `idle-waiting` 被叫来的成员散会后被谎报成"正在干活"，下一次召集就永远等一个
  不会到来的工作单元边界——"再点一次召集，就告诉我全员在工作中"。
  详见 5.12。

### 1.4 主持人：有控场权，但**没有上下文**

> 设置一个主持人吧，模型使用唤起会话的模型，但是这个主持人**直接没有上下文**，
> 不会被任何人的上下文带偏。

这条把两件事彻底解耦了：

- **控场**（下一个谁说话、什么时候散会）由主持人负责；
- **发言**由各自会话产出，各自带着**自己的**记忆。

主持人只拿到**群聊记录 + 成员名单 + 谁还没说话**，拿不到任何人的私有记忆投影。
因此它**不可能**因为"某人的上下文更长/更详细"而偏好某人——
这就是"不会被带偏"的机制保证，而不是一句提示词约定。

```
主持人看到的:  议题 / 群聊记录 / 名单 / 谁没说话 / 累计发言次数
主持人看不到:  任何人的工作记忆、代码、日志、历史会话
```

它用的是**召集者会话的模型**：谁开的会，就像谁在主持，风格一致，
且不需要为协调器单独引入一个模型依赖。

### 1.5 不做结构化

> 我觉得没必要做结构化的东西，AI 会自动讨论出合理结果的（这个主要还是针对 AI agent 的集会）

所以：

- 入场 prompt 只做**定位**（你是谁、议题是什么、在场有谁、可以说什么），
  **不强制**"进度/障碍/需要"三段式，也不强制任何字段；
- 发言内容完全自由；
- 唯一保留的硬约束是**单次发言字数上限**——它不是发言格式，
  而是防上下文爆炸的工程底线（N 人 × R 轮不设限就会线性膨胀）。关键是**软目标与硬上限分开**：提示词只说"大致 800 字"（甚至明确写"不要去数字数、不要用工具核对字数"），硬上限放宽到 1600 字——紧贴实际长度的硬上限会逼模型去数字符甚至调工具核对，那是真实的算力黑洞。

主持人输出的**控制决定**是 JSON（`{"action":"invite","next":"..."}` 或 `{"action":"adjourn"}`）。
那不是给 AI 的模板，而是协调器与主持人之间的**控制通道**；
而且解析失败时**绝不会卡住会议**——会回退到安全轮转。

### 1.6 跑一遍看效果

```bash
pnpm run demo:room
```

真实输出（节选）：

```
[1] 会议室是持久实体；会话主动加入才有"唤起/参会"的权利与义务
  ✓ 会议室「量化同步会」成员 3 人：
  · live-trading  工作区=quant-live  模型=deepseek-v4.1-flash
  · neural-net    工作区=quant-lab   模型=deepseek-v4-pro
  · trad-algo     工作区=quant-lab   模型=deepseek-v4-pro
  ✓ 成员来自 2 个不同工作区

[2] 不是所有会话都能被唤起：没加入的会话叫不动
  · data-infra 已登记为会话，但**没有加入**这个会议室
  ✓ 越权召集被拒绝：会话 data-infra 不是会议室 quant-sync 的成员，没有召集权。

[4] 人召集会议：working 的先进"待入场"，空闲的直接入场
  · 会议已开始，入场情况：在场=human/neural-net/trad-algo  未到场=live-trading
  · live-trading 还在忙着，没有被打断 —— 它被记为"待入场"
  · → 现在 live-trading 的当前工作单元结束了（onWorkUnitComplete）
  · 会场更新：在场=human/live-trading/neural-net/trad-algo  未到场=(无)

[5] 入场引导：预注入 prompt + 自己的记忆投影，别人看不到
    【会议室入场】你是「实盘/泛化专家」（领域 live-trading）。
    本次会议议题：对齐成本约束与市场结构变化
    召集者：human；规模：大会（全体成员）。
    在场：neural-net、trad-algo、human（人类，有发言权）
    你被叫来开这个会。请自然地把别人不知道、但和你这个方向有关的情况说出来，比如：
    - 你现在做到哪了；- 你遇到了什么问题、卡在哪里；- 你需要谁的什么帮助…
    规则：
    - 这是一个多轮会议，由主持人控场决定发言顺序；你会在轮到你时被叫到。
    - 单次发言不超过 800 字（这不是格式要求，只是为了让所有人都有说话机会）。
    - 没有固定格式，怎么表达清楚就怎么来。
    你的私有记忆投影（只包含与你相关的部分；别人看不到这些）：
    你最近的工作记录：
    - 逐笔滑点重算完成，taker 成本占 41% 夏普
    - 私有日志 9.8MB，未对外共享
  ✓ 引导里有定位信息与开放式提示，但**没有**强制的三段式模板

[6] 主持人控场：用召集者的模型，但自己没有任何上下文
    【会议主持】你是本次会议的主持人。
    你的信息范围（重要）：
    - 你**没有任何与会者的私有上下文**：看不到他们的工作记忆、代码、日志、历史会话。
    - 你只能看到下面的群聊记录、成员名单，以及谁还没说话。
  ✓ 主持人只拿到群聊记录 + 名单 + 谁还没说话；拿不到任何人的私有记忆

[8] 每个参会者用的是自己的模型
  · 模型 deepseek-v4.1-flash ← live-trading
  · 模型 deepseek-v4-pro ← neural-net、trad-algo

[9] 会后压缩：每人各自提炼"与自己相关"的内容
  ── live-trading（65 字）
     待办：在 60 日 IC 窗口下重跑滑点估计并验证稳定性（我的责任）。会上确认换手压到
     5 倍以下后滑点约 20%，止损问题缓解。
  ── neural-net（73 字）
     待办：与 live-trading 对齐上线后的重训频率。会上确认换手降到 4.8 倍可行；
     若 60 日窗口上线，我的重训周期同步改为 60 日。
  ── trad-algo（59 字）
     待办：在 60 日窗口下重做统计显著性检验。我的判断被采纳：这是市场结构问题
     而非换手率问题；模型侧已承诺同步重训周期。

[11] 散会：所有成员回到工作状态
  · 散会后：data-infra=working，live-trading=working，neural-net=working，trad-algo=working
```

---

## 二、这个系统坚持的五个不变量

每一条都有对应的失败断言在测试里，不是口号。

### 不变量 1：会籍是权限边界

只有加入了会议室的会话才能召集、才会被召集。测试断言：

```ts
// 没加入的会话越权召集 → 被拒
await expect(orchestrator.convene({ calledBy: 'data-infra', ... })).rejects.toThrow(/没有召集权/)
// 排他会籍
expect(() => orchestrator.joinRoom('neural-net', 'other-room')).toThrow(RoomRegistryError)
```

会籍落盘（追加式 JSONL），进程重启后可恢复——内存态的群成员关系会在重启后静默消失，
让"唤起"变成无声失败。

### 不变量 2：私有上下文永不跨会话流动

进会议室时注入的是**记忆的限长投影**（`memoryProjection(maxChars)`），不是完整上下文：

```ts
expect(liveEntry.text).toContain('逐笔滑点重算完成')   // 自己的记忆
expect(liveEntry.text).not.toContain('残差宽度消融')   // 别人的私有记忆
```

> 为什么不共享上下文？因为共享上下文就是"上下文污染"本身。
> Cognition 主张"别做多 Agent、上下文必须共享"——那是针对**短周期、强耦合**任务。
> 本项目面向**长周期、弱耦合、方向可切分**的场景，隔离才是解药。

### 不变量 3：长度是硬预算，超限**拒绝**而不是截断

```ts
expect(() => room.appendSpeech('a', '一'.repeat(801))).toThrow(/超长/)
```

静默截断比超长更糟：Agent 会以为自己的诉求已经传达了。

> 依据：调研发现"200 字"这个具体数字没有研究支持，是工程取舍。
> 但"硬上限 + 分字段预算"有先例（LangChain 的 `max_token_limit` 滚动摘要、
> Caucus 把工具描述硬裁到 ≤260 字符）。所以本实现的是**机制**，上限是可配默认值。

### 不变量 4：停滞由**外部**计算，不依赖 Agent 自述

`detectStall()` 四类信号：`silent-slot`、`stale-briefing`、`repeated-fingerprint`（内容指纹连续重复=空转）、
`no-progress`。

> 竞品 Caucus 的 `ask_operator` 完全依赖 Agent 自判"我卡住了"。
> 但陷入死循环的 Agent 最不可能正确自判——否则它早跳出来了。
> 判据必须来自外部可观测行为。

而且节流故意留了后门：停滞触发（priority 1）**穿透**最小会议间隔——
"刚开完会就卡死"恰恰是最需要介入的时刻。

### 不变量 5：会后纪要必须**每人不同**且**真的更短**

```ts
expect(new Set(notes.map(n => n.text)).size).toBe(3)   // 每人不同
// validateMinutes：纪要必须短于会议记录本身，否则拒绝
```

`validateMinutes` 会拒绝"越压越长"的纪要（那说明模型在抄会议而不是在压缩）、空纪要、超长纪要。

---

## 三、安装

### 从源码构建

```bash
git clone https://github.com/liaowenqi123/dsh-meeting-coordinator.git
cd dsh-meeting-coordinator
pnpm install        # 只装依赖。dist/ 已随仓库提交，装完即可被 DSH 加载
pnpm run build      # 只有在改了 src/ 之后才需要
```

> **为什么 `dist/` 要提交进仓库？** 这是实测踩出来的，不是偷懒。
>
> 如果靠 `prepare` 脚本在安装时构建，那么从 GitHub 安装会**直接失败**：
>
> ```
> ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
> The git-hosted package "dsh-meeting-coordinator@0.1.0" needs to execute build
> scripts but is not in the "allowBuilds" allowlist.
> ```
>
> pnpm ≥10 默认**不允许依赖执行构建脚本**，而插件市场安装未上 npm 的包走的正是
> github spec。把构建产物一并提交，整条安装路径就完全不需要构建脚本了。
> 代价只有一个：**改了 `src/` 必须 `pnpm run build` 并把 `dist/` 一起提交**（见[贡献章节](#欢迎贡献反馈与已知不足)）。

### 装进 DeepSeek Harness

把本包装进 DSH 的 profile（真实装载契约在 `@deepseek-ai/dsh@0.1.6` 上核实过）：

```bash
# 以 web profile 为例
cd ~/.dsh/profiles/web
pnpm add <本包路径>                                     # 本地路径
pnpm add github:liaowenqi123/dsh-meeting-coordinator    # 或直接从 GitHub 装（无需构建）
```

DSH **不读 `dsh-plugin.json`**（那是标准/市场/准入层的清单，用于「安装前可知兼容性」）。
运行时真正读的是 `package.json` 的 `dsh.bundle.patch` → [`cordis.patch.yml`](cordis.patch.yml)。
两者本包都提供：能被真实装载，也能被静态评估。

重启 DSH（或重载 profile）后，会看到一个**会议室面板**，可以建会议室、加会话、召集会议。

### 在插件市场里找它

本仓库带 GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin)，这是社区插件市场
（如 [dsh-plugin-marketplace](https://github.com/AwesomeHou/dsh-plugin-marketplace)、
[DSH-Store](https://github.com/AI-Scarlett/DSH-Store)）自动同步的索引源——
装了市场插件就能直接搜到并一键安装。

### 验证安装

```bash
pnpm run verify     # 类型 + 清单静态校验 + 215 测试 + 构建 + 端到端演示
```

## 四、快速开始

环境：Node.js `^22.19 || >=24`（实测 v24.14.0）+ pnpm。

```bash
pnpm install
pnpm run verify     # 一条命令跑完全部验证
```

| 步骤 | 命令 | 验证什么 |
|---|---|---|
| 1 | `pnpm run typecheck` | 严格 TS（含 `exactOptionalPropertyTypes`） |
| 2 | `pnpm run check:manifest` | **不执行任何插件代码**，静态判定清单兼容性 |
| 3 | `pnpm run test` | **215 个测试**：协议 / 会籍 / 状态机 / 会议室 / 主持人 / **DSH 模型调用** / **边界监听** / **会话状态驱动** / **停滞升级** / 压缩 / 适配层 / 宿主装配 / **借上下文接线** / **实时会议视图** |
| 4 | `pnpm run build` | 产出 `dist/`（真实装载入口） |
| 5 | `pnpm run probe:composition` | 真实 `compose()` + `LifecycleCoordinator` 激活顺序 |
| 6 | `pnpm run demo:room` | **会议室机制端到端演示**（11 步，全断言） |
| 7 | `pnpm run demo` | 轻量路径演示：简报交换 + 停滞检测 + 唤醒 |
| 8 | `pnpm run test:e2e` | **真实 `dsh web` + Python mock LLM** 的端到端（见 5.14；需要本机 Chrome 与 3081 空闲） |

> `demo:room` 用 `ScriptedMeetingVoice`（脚本替身）驱动，因为演示环境里没有活的 DSH 会话；
> **模型调用通道本身由 `tests/dsh-voice.spec.ts` 用假上游逐条断言**（调用映射、模型透传、
> 失败处理、资源释放），其中还有一条 `apply()` 的端到端用例走完整真实代码路径
> （会籍 → 激活 → 召集 → 等边界入场 → 每人用自己的模型发言 → 各自纪要 → 散会）。

---

## 五、模型调用与等待入场：怎么接到上游

### 4.1 让会话说一句话

上游 DSH 有两条多 Agent 通道，**用途不同**，本项目两条都用、各司其职：

| 通道 | 能力 | 本项目用途 |
|---|---|---|
| `ctx.agentTeams`（`TeamService`） | 持久 peer 信箱；`sendMessage` 只回 `{messageId, status}`，**不回传发言内容** | **唤起 / 通知**成员（`dsh-team-runtime.ts`） |
| `ctx.subagents`（`SubagentRuntime`） | `start()` 返回 `SubagentRun`，`run.result` **能读回最终 assistant 输出** | **让会话说一句话**（`dsh-meeting-voice.ts`） |

所以"发言"走 `subagents`：

```ts
const run = await ctx.subagents.start('spawn', {
  label, prompt: [{ type: 'text', text }], parent, signal,
  agentOptions: { model },        // ← 按会话指定模型，兑现"每个参会用自己的模型"
})
const result = await run.result   // SubagentResult
result.output                     // ContentBlock[]，最后一个非空 assistant 消息
await run.dispose()
```

**优先 `fork` 那个人过来**：

```ts
const run = await ctx.subagents.start('fork', { parent: 那个人, prompt, persona, agentOptions: { model } })
```

**fork 的原生语义正是这件事**（`@deepseek-ai/dsh-subagent-fork-in-process`）：

> seeds each child with the parent’s completed conversation turns: the child sees every finished turn
> The seed is a one-time snapshot taken at fork time

也就是：**把那个人已完成的上下文一次性 seed 进这个子会话**，于是进会场的那个人**带着自己的完整上下文**——它就是它本人，不是「读过它资料的陌生人」。这就是「**掏过来，当作我的上下文注入**」。

拿不到 `fork`（或该会话不是活的）时退回 `spawn`，由 prompt 里的完整上下文注入兜底。
理由有三：只有这条路能读回输出；单轮上下文恒有界（避免 N 人 × R 轮把上下文撑爆）；
会话的身份与记忆由 `AgentParticipant` 持有，不会因上游会话生命周期漂移。

### 4.2 三个必须处理的失败模式

```ts
// ① result 在子级失败时不 reject，而是带 stopReason 解析 —— 忽略它最危险
if (stopReason !== 'completed') throw new VoiceUnavailable(...)
// ② 空输出 ≠ 成员没意见
if (text.length === 0) throw new VoiceUnavailable(...)
// ③ 超时只发 abort 信号不够：上游若忽略信号，await 会永远挂住 → 必须显式竞速
const result = await raceWithAbort(run.result, signal, label)
```

第 ① 条尤其关键：**一场因为模型全挂而沉默的会议，看起来会像"大家都没意见"。**
把失败当成沉默，比报错危险得多。这一条是被测试逼出来的真实 bug 修复
（超时测试最初直接超时挂住，暴露了只发信号不竞速的问题）。

### 4.3 等工作单元结束再入场

需求："一个 agent 正在 working（不论是正在输出还是在调用工具 ing），
都将在**调用结束后**进入会议室（有一个等待的过程）。"

上游会话事件词汇表里正好有两个可用的边界：

| 事件 | 含义 | 何时用 |
|---|---|---|
| `step/end` | 一个步骤结束（含该步里的工具调用） | **默认**，最贴近"调用结束后" |
| `turn/end` | 整个回合结束 | 希望成员把手头这轮彻底做完再进场 |

接线（`dsh-boundary-watcher.ts`）：

```ts
ctx.on('session/event', (session, event) => {
  if (event.type !== 'step/end') return          // 只看配置的边界
  const memberId = resolveMemberId(session.id)   // 可配的会话→成员映射
  if (memberId) orchestrator.onWorkUnitComplete(memberId)  // 到边界才真正入场
})
```

两个刻意的设计：**边界类型与身份映射都可配**（上游事件名是内部词汇表的一部分，
未来可能变）；**监听器永不抛错**（事件回调抛异常会污染宿主的事件分发，这里捕掉并记进诊断）。

---

## 六、两条路径：什么时候开会，什么时候只同步

```
        ┌─────────────────────────────────────────────────────────┐
        │  轻量路径：简报交换（MeetingCoordinator + BriefingBoard） │
        │  · 每 N 轮 / 4 小时：限长摘要落板 + 汇总广播（无模型调用）│
        │  · 持续计算停滞信号（指纹重复 / 轮次落后 / 无进展）      │
        └───────────────────────────┬─────────────────────────────┘
                                    │ 检测到停滞 / 按需召集
                                    ▼
        ┌─────────────────────────────────────────────────────────┐
        │  正式路径：会议室（MeetingOrchestrator + MeetingRoom）   │
        │  · 召集全体成员（含 idle / done）                        │
        │  · 入场 prompt → 主持人控场多轮讨论 → 每人个性化压缩     │
        │  · 散会后全部回到 working                                │
        └─────────────────────────────────────────────────────────┘
```

为什么两条都要：

- **高频低成本**。每次开会都要 N×R 次模型调用。日常节奏对齐用简报板就够，
  它只是追加写 JSONL + 一次汇总，**零模型调用**；
- **贵的事情只在需要时做**。停滞信号是**触发会议室**的判据，而不是让 Agent 自己喊"我要开会"；
- 这也符合调研结论：**便宜轮询 + 只在必要时开昂贵会议**。
  Anthropic 实测多 Agent 系统约 **15×** chat token，这个成本必须被理由支撑。

### 5.1 那条箭头是怎么落的：`pulse()`

上面那张图里 `轻量路径 ──检测到停滞/按需召集──▶ 正式路径` 这条箭头，
**落在 `host.ts` 的 `pulse()` 上**（不是 `tick()`）：

```ts
pulse(): Promise<MeetingPulseResult> {
  const light = await local.tick()                    // 轻量路径：简报落板 + 汇总广播
  return { light, escalation: await escalate(light.evaluation) }
}
```

三个刻意的决定：

1. **触发评估只跑一次，升级复用它**。`evaluateTriggers` 依赖协调器的
   `lastMeetingAt` / `lastMeetingRound`，跑两遍会把节流状态推乱——
   于是"该不该开会"和"该不该升级"必须看同一份评估。
2. **升级失败不抛错，只带回理由**。全员在工作中、已有一场会在进行，
   都是运行期的正常分支。把它当异常，定时器会把整棵插件树炸掉。
3. **召集者用人类席位（`human`），不是某个成员**。这是外部干预：
   停滞由外部计算，不依赖 Agent 自述。借用某个成员的身份会同时污染两件事——
   主持人会拿到那个成员的模型，审计里也会记成"是它召集的"。

### 5.2 成员状态必须被喂，否则会议室永远开不起来

`AgentParticipant` 的初始状态是 `working`，而 `convene()` 要求**至少一位**
被召集成员能立刻入场（`idle-waiting` / `done` 直接入会；`working` 只能进
`awaiting-entry`）。

所以"接上 `convene()`"还不够——**状态机不喂，整条正式路径就是死代码**：
全场永远 `working`，`convene()` 永远抛「全部成员都在工作中，会议无法开始」。

两个来源共同驱动状态，**刻意分成两条独立订阅**：

| 关注点 | 谁负责 | 依据 |
|---|---|---|
| "这个会话忙起来了 / 空闲了" | `dsh-session-state.ts` | 会话事件 `turn/start` / `turn/end` |
| "这个会话的工作单元走到边界了" | `dsh-boundary-watcher.ts` | 可配的 `step/end` / `turn/end` |

不合并的理由：入场时机是**可配置的策略**，而活动状态是**客观事实**。
混在一个订阅里，改入场策略就会连带改状态语义。

### 5.3 会话 id 不是成员 id（最容易误判成"插件没生效"的坑）

上游 `session/event` 带的是 **DSH 自己的会话 id（UUID）**，跟我们配置里的
`slot id` 毫无关系。映射不上时：日志不报错、插件也确实装好了，
但**没人被登记为空闲、没人入场、会议室永远开不起来**。

三级来源，优先级从高到低：

1. `config.memberSessions` 显式映射（用户说了算）；
2. **自动探测** `agentTeams.listMembers()`：上游的 `TeamMemberView` 同时带
   `id: SessionId` 与 `name`，而成员是我们用 `teammateName(slot)` 起的名字，
   按名字对齐就拿到权威会话 id；
3. 恒等映射（会话 id 恰好就是 slot id 的场景，主要是测试）。

升级失败时，理由里会**直接点名未映射的会话 id** 并告诉你去配什么——
不让这类配置错误表现成"插件没生效"。

### 5.4 上游要的是"活的 Agent"，不是 Agent 服务（真机踩过的坑）

`agentTeams` / `subagents` 的第一个参数是授权凭据，上游的判据非常具体：

```ts
tryMembership(agent) {
  if (this.ctx.agents.get(agent.id) !== agent) return undefined   // ← 必须同一个对象引用
  …
  throw new TeamError(`agent "${agent.id}" is not a member of an active Agent Team`)
}
```

所以**绝不能把 `ctx.get('agents')` 这个服务对象直接传下去**。
实测的错误信息是 `agent "undefined" is not a member of an active Agent Team`——
上游读 `agent.id`，而服务对象没有 `id`。而且那个错会以
`plugin tree failed to load` 的形式**把整个 dsh 带下线**。

`resolveLiveAgent()` 按三级取值，顺序有理由：

| 顺序 | 来源 | 何时命中 |
|---|---|---|
| 1 | `agents.currentInitiator()` | Agent 驱动的调用链（最准：就是"谁发起的"） |
| 2 | `agents.roots()[0]` | **插件加载与定时器路径**——`currentInitiator()` 是 AsyncLocalStorage 语义，这些路径下必然 undefined |
| 3 | `agents.list()[0]` | 兜底：任何活着的 Agent 都能当凭据 |

### 5.5 启动成员需要活的 Agent，而插件是在启动时加载的

这是上面那条的必然推论，也是**必须先解决才能装上**的问题：

> `dsh web` 刚启动时，用户可能还没打开任何会话——**一个 Agent 都没有**。

此时如果成员 facet 在激活期抛错，后果不是"这个成员没起来"，
而是 `plugin tree failed to load` → **整个 dsh 起不来**。

所以成员启动**失败即降级、不抛错**，并分成两类：

| 失败类型 | 处理 | 理由 |
|---|---|---|
| 协商类（拿不到 agreement、boardDomain 不一致） | **抛** | 契约错误，不是时机问题 |
| 启动类（没有活 Agent、上游拒绝） | **降级 + 重试** | 只是时机未到，`pulse()` 每轮重试（用户开会话后就该成功） |

降级的影响面是有限的：成员句柄只服务于**轻量路径**的消息投递；
`host.pendingMembers` 会如实列出没起来的成员，升级失败的理由里也会点名它们。

> ⚠️ 但**发言**仍然需要活的 Agent（`subagents.start` 的 `parent` 走同一个 `resolveCaller`）。
> 所以没有活 Agent 时会议是真的开不起来——插件不会假装"大家都沉默"，而是明确报错。

### 5.6 Cordis 只接受"函数或空"作为 `apply` 的返回值

这一条是真机 boot 第二次崩出来的：`TypeError: Invalid effect`。

Cordis 判定插件 effect 的代码是（`Fiber._execute` → `safeCollect`）：

```js
const effect = runner.execute.call(this)
if (typeof effect === 'function') return runner.collect(effect)   // 函数 = disposer，合法
else if (isNullable(effect)) {}                                   // 什么都不返回，合法
else if (!isObject(effect)) throw new TypeError('Invalid effect')
else if ('then' in effect) return effect.then(safeCollect)        // ← async apply 的 resolve 值走这里
```

`safeCollect` 只接受**函数**或 null/undefined。所以 **async `apply` 的 resolve 值只能是
`undefined` 或一个 disposer 函数**——直接 resolve 一个句柄对象就会让整个 dsh 起不来。

真实上游插件（`dsh-session-header` 等）都是**同步 `apply`、返回 void**，清理走
`ctx.effect(() => { …; return () => cleanup })`（callback 立即执行，它的**返回值**才是 disposer）。

本插件的 `apply` 因此返回一个 **disposer 函数**，句柄挂在它的 `.host` 属性上：

```ts
const { host } = await apply(ctx, { slots, rootDir, boardDomain })   // 程序化 / 测试
// 真机装载时 Cordis 把这个函数当 disposer 收集，卸载时调用它
```

拆卸过程是**幂等**的，因为它会被三个入口触发：返回的 disposer、`ctx.effect` 的清理、
`ctx.on('dispose')`——Cordis 卸载时可能三路都到。

### 5.7 默认什么都不做，以及 Cordis 服务访问的两个陷阱

**默认空会籍**：`apply()` 不建房间、不拉人入会、不启定时器。房间由人在面板上建，
成员由人把**非活动**会话加进去。上一版不是这样——它会自动建房间、把配置里的 slots
全拉进会、再起一个 60 秒定时器（`onStall: true` 让第一轮就判停滞），结果是
"插件一装上就自己开始每分钟开会"，而用户既看不到也停不掉。

| 约束 | 理由 |
|---|---|
| 默认无房间、无会籍 | 会籍是权限边界，默认满员等于边界从第一天就失效 |
| 入会**那一刻**必须非活动 | 入会要往该会话装工具；往正在跑的 Agent 上做会扰动它当前的任务。口径是**时点**：加入之后它可以随便忙 |
| 退出同样要求非活动 | 退出是卸工具，与入会同属"改该会话工具集"。于是只有这两个时点会碰它——**会议本身不碰它** |
| 子 Agent 不许入会 | 否则一个会话 spawn N 个子 Agent 就能自我增票。判据 `header.parentSession` / `origin === 'subagent'` |
| 自动节律默认关 | 要无人值守才 `autoPulse: true` |

**⚠️ 两个陷阱（连崩三次才搞清，必须记住）**：

1. **未在 `inject` 里声明的服务，属性访问会直接抛**：
   `cannot get property "tools" without inject`——不是返回 `undefined`。
2. **把它加进 `inject` 又会让整个 boot 挂死**：`inject` 会**等**该服务出现，
   而这个 profile 里它不在本入口之前就绪 → 入口一直等，`boot()` 不返回。
   症状是**进程活着、零输出、端口不监听**——最难查的一种。
3. **唯一安全的读法是 `ctx.get(name)`**（`readService` 内部还有 try/catch）。
   所以 `inject` 只列 **apply() 期间真正必需** 的服务，其余一律惰性 `get`。
   已验证可用的最小集：`inject: [agents, subagents, agentTeams]`。

**全局工具就是那个"按钮"**：`ctx.tools.register()` 在 `apply()` 里调用即为**全局注册**；
而 `ToolSchema.description` **本来就在该会话的模型上下文里**——
所以需求里"像系统提示词一样注入一大坨（新 toolcall + 权限 + 义务）"落地下来就是
写 `description`。按钮是它，说明书也是它。

### 5.8 轮次结论必须有去处

`pulse()` 跑在定时器里，而本插件没有 UI、也（暂时）没有命令。所以"升级失败的原因"
如果丢掉，用户看到的就只是**什么都没发生**——这是最难排查的一种表现。

两个通道，**只在结论变化时报告**（轮次本身是每分钟一次的心跳，原样刷日志等于没日志）：

| 通道 | 内容 | 可靠性 |
|---|---|---|
| `ctx.logger.info/warn` | `[dsh-meeting] 已升级/未升级到会议室：…` | 尽力而为。Cordis 内建 logger 的默认导出器只进内存缓冲（上限 1000 条），实测没出现在 `dsh web` 的 stdout |
| `<rootDir>/pulse.jsonl` | 结构化记录（escalated / reason / signals / trigger / meeting id） | **实测可用**，直接 `cat` 就能看 |

> 一个自己踩的坑：诊断文本里如果有**累加**的数组（比如每轮都 push 一条相同错误），
> 文本每次都会变，"结论变化才报告"的去重就完全失效——等于每轮刷一遍。
> 所以诊断里的错误集合用 `Set`。

### 5.9 会议室面板（浏览器半边）与四个把界面吃掉的真机坑

面板就是需求里那个"独立面板"：侧栏底部的 **🗂 会议室** 按钮打开一个全屏覆盖层，
左边是所有会议室，右边是选中房间的**成员 / 候选会话（能加的与加不了的，都带理由）/ 历次会议正文**，
并可直接建房间、加会话、移出、召集会议。

**实时会议视图（"看得见会议过程"）。** 会议是几十秒的多轮过程，只有散会后的记录的话，
用户全程只能对着一块静止的界面猜。面板打开期间每 2 秒轮询一次 `meeting/liveMeeting`
（第 8 个端点）：有会正在开时，房间详情顶部出现"● 会议进行中"区块——
议题、第 X/Y 轮、召集者、在场/未到场名单，以及**持续增长的实时记录**
（入场引导 / 发言 / 主持人控场，自动滚动到最新一条）；散会后区块消失，
历次会议里随即能看到这场会的完整记录。为什么必须轮询而不是"点召集后刷新"：
会议可能由任何人发起——面板按钮、Agent 调全局工具、停滞自动升级，
后两种压根不经面板的手。数据面是 `MeetingConsole.liveMeeting()`，
每次调用向编排器重算一份快照（`activeMeeting()`），**不缓存**——
缓存会让面板看到过期的轮次，那比没有这个视图更糟。

**实现要点：客户端半边不需要打包器。**
契约只有一条——文件自己调 `window.__ModuleLoader__.load({ id, factory })`，
工厂里 `require('react')` 由宿主注入，返回一个 Cordis 插件 `{ name, inject, apply }`。
上游那些几百 KB 的 `client.js` 是 TSX 多文件产物；我们只有 `client.js` 一个文件、
只用 `React.createElement`，所以**手写**比接一套构建更简单。

**数据怎么来。** 浏览器读不到文件。数据经 Typert Gateway 的**通用 RPC 通道**取：

```js
ctx.get('connection').rpc.call('/api', 'meeting/overview', { args: { request: { viewerId: 'human' } } })
```

宿主侧由 `src/adapters/dsh-meeting-remote.ts` 提供那 8 个端点。

**唯一一次"按契约复刻上游"的地方。** 上游的写法是
`class X extends TypertRemoteService` + `@Remote`，但那要 import
`@deepseek-ai/dsh-typert-protocol`——本包是 `link:` 安装的，会引入第二份 cordis。
我们从上游源码读出等价契约，**不 import**：

1. `ctx.provide(key, value)` 会让 `ctx.reflect.props[key]` 变成 `{ type: 'service' }`（gateway 按此发现）；
2. 服务实例上要有 `typertRemote`，且 `binding.service === 实例自身`（上游是 `!==` 就抛）；
3. 原型上要有一个**普通字符串键**的描述符
   `'@deepseek-ai/dsh-typert-protocol/remote-methods'` → `{ version: 1, methods: [{ method, invocation: { kind: 'direct' } }] }`。

第 3 条是关键：**它不是 `Symbol`**，所以不 import 也能写出等价描述符。
代价是上游改了这个键我们会**静默失效**（端点 404，不报错），
因此 `tests/meeting-remote.spec.ts` 把这 3 条连同"每个方法恰好一个名为 `request` 的形参"
一起钉成断言——形参名即 wire 字段名，上游 `assertExactArguments` 要求实参键与形参名完全一致。

真机上撞到的三个坑，代价都是"界面完全没有"：

| # | 现象 | 根因 |
|---|---|---|
| 1 | 插件装了，UI 上什么都没有 | `inject` 里写了 `agentTeams`，而 agent-team 那两层已从 profile 删除 → Cordis 的 `inject` **一直等**这个服务 → 入口永远 `pending`，`apply()` 根本没跑。**`inject` 写错名字的代价是静默不激活，不是报错。** |
| 2 | 按钮在，点开没反应 | `makeClient(ctx)` 建在组件函数体里 → `useCallback/useEffect` 的依赖每次渲染都是新引用 → 效果反复触发 → 无限渲染循环。改为在 `apply()` 期构造一次。 |
| 3 | 整个 dsh 起不来 | 加载期探测 `ctx.subagents` 的 provider 就 `throw`。那是**拿加载期的探测去判定调用期的事实**（加载那一刻上游 provider 还没注册完）。改为降级 + 记诊断，判据落到真正开会的时刻。 |
| 4 | 列表里全是 `session-750e30ff-…`，认不出是哪个会话 | 宿主里写着 `titleOf: (sessionId) => sessionId` —— **把 id 当成了标题**。它还是个"看起来无害的兜底"，实际把后面所有标题解析全短路了。已删；标题改由内置解析读 `sessionTitle` 服务（`session/title` 事件的 latest-wins 折叠），没有标题事件时退回**按首条人类消息派生**。 |

### 5.10 会话标题：面板里必须显示名字而不是 id

标题的真来源是 Cordis 服务 **`sessionTitle`**（`@deepseek-ai/dsh-session-title`，由 `dsh-base` 装载）：
`ctx.get('sessionTitle').get(session)` → `{ title, source, eventSeq }`。

两级读法（都在 `dsh-session-catalog.ts` 的 `readSessionTitle()` 里，**不 import 上游包**）：

| 级 | 条件 | 结果 |
|---|---|---|
| 1 | 有 `session/title` 事件（用户改名 / 模型生成 / 内置回退） | 用它的 `title` |
| 2 | 没有（新建会话还没起过名） | 用**第一条人类消息**派生单行短标题 |

派生按**码点**截断（不能按字节，中文会被切坏），上限 48 字符。
上游自己也有个 `fallbackSessionTitle(input, maxWords, maxBytes)` 做同一件事，
但按本仓库的规矩不 import 上游包；这里只求等价语义，不求逐字对齐——**它只影响观感，不参与任何判据**。

面板里显示为**两行**：标题在前（人来认），短 id 在后（机器来认），完整 id 挂在 `title` 属性上悬停可见。
标题缺席时（会话已关闭）只显示短 id，不编造。

> 一个值得记住的教训：**"兜底成 id" 这种看似无害的默认值，会让整个功能静默失效**。
> `titleOf: (sessionId) => sessionId` 既没报错、也没让面板变空——它只是让所有会话
> 长得都像 id，而人会以为"这个插件就是不做标题"。

### 5.11 两个把会议卡死的坑（真机测试暴露）

**症状**：4 个成员明明都跑完了，会议室坚持说「全部 4 位成员都在工作中，会议无法开始」；
而且那 4 个会话只有**被点开过**才出现在候选列表里。

| # | 根因 | 修法 |
|---|---|---|
| 1 | 「会话 id → 成员 id」的判据是**静态配置**（`config.slots` 的槽位 id + `memberSessions` 映射），而新版模型的成员是**用户在面板上加的真实会话**，两边都不在。于是 `turn/end` 到达时归属不到成员 → 状态机从未被驱动 → 全员停在初始值 `working`（初始值本身也是旧模型留下的：那时成员是插件 spawn 的、一起步就在干活）。 | 判据改成问**编排器的实时名册**（`rosterOf()` 给取函数，不是快照）。 |
| 2 | 入会时没补「空转」。即使映射修好，成员也要等**下一次** `turn/end` 才会转空闲——而"下一次"可能要等用户去那个会话再说一句话。 | 入会那一刻直接 `beginIdleWaiting()`。依据是**已成立的不变量**：准入要求入会时该会话非活动（见 `core/membership.ts`），所以它此刻必然空闲。 |
| 3 | 候选列表只读 `ctx.sessions.list()`，而它只给**已加载**的会话——没点开过的根本不在里面。 | 并入 `sessionController.list()`（侧栏那份持久化全量列表）。该接口是**异步**的，而候选接口是同步的，所以用**旁路缓存 + stale-while-revalidate**（1.5s TTL，启动时预热）。 |

第 3 条带出一个必须**看得见**的代价：不在进程里的会话，**借不到它的上下文**
（`store.get()` 读不到）。所以候选行上有一个 `未加载` 标记（悬停解释），
而不是假装一切正常。

> 两条更一般的教训：
> 1. **判据要用"活的事实"，不能用"配置的快照"。** 名册会变、状态会变，
>    凡是会变的东西都得给"取函数"，给快照就等着它在某个时刻过期——
>    而这类过期不会报错，只会让功能静默失效。
> 2. **状态机的初始值要跟着模型走。** `working` 是"成员是我 spawn 的、一起步就在干活"
>    那个模型的产物；成员换成用户的会话之后，默认值应当是"空闲"。



### 5.12 散会不能"无条件回 working"：一个会让会议室一次性报废的坑

**症状**（真机测试暴露）：第一次点「召集会议」时模型调用失败（`Connection error`），
再点一次，就永远得到「全部 4 位成员都在工作中，会议无法开始」——
**这个会议室从此再也召集不起来**。

**根因**：`AgentParticipant.dismiss()` 里写死了一行 `this._state = 'working'`。

这是旧模型的残留。那时成员是插件自己 spawn 的领域 Agent，一起步就在干活，
所以"散会后回去干活"是成立的。但新模型的成员是**用户的会话**，它是从
`idle-waiting` 被召集的——散会后把它标成 `working`，等于对它撒谎。
而 `summon()` 对 `working` 的反应是派去 `awaiting-entry`，去等一个工作单元边界：

```
空闲成员 → 召集 → in-meeting → 散会 → working   （✗ 谎报"正在干活"）
        → 再召集 → awaiting-entry → 等一个**永远不会到来**的边界
        → present.length === 0 → "全员都在工作中"
```

任何一次会议（**成功或失败**）之后都会落到这个状态。失败时尤其致命，
因为用户会立刻重试——这正是它一暴露就被撞上的原因。

**修法**：`summon()` 记下召集前的状态，`dismiss()` / `cancelSummon()` **还原**它。

| 召集前 | 散会后 |
|---|---|
| `idle-waiting` | `idle-waiting`（**立刻可以再召集**） |
| `working`（忙，正在等边界入场） | `working`（它本来就还在忙） |
| `done` | `done` |

顺带把 `convene()` 的 `try` 范围扩大到**房间的创建与开启**。那一段原本在 `try` 之外，
一旦抛错，被召集的成员就永远停在 `in-meeting` / `awaiting-entry`——同样是一次性报废。
清理的代价极低，锁死的代价极高，所以宁可把范围划大。

回归测试两条，都做过**反向验证**（把 `dismiss()` 改回旧行为，确认它们真的失败）：
`★ 同一会议室能连开两场`、`★ 发言阶段模型失败：成员被还原，会议室仍能再次召集`。

> 教训：**"兜底成一个具体的状态值"和"兜底成一个 ID"是同一类错误**（见 5.10）。
> 状态机的每一次转移都该问一句"我从哪来"，而不是硬编码一个"应该去哪"。
> 这两者在正常路径上表现得完全一样，只在异常路径上分叉——
> 而异常路径恰恰是用户最先遇到的那条。

### 5.13 借上下文：成员发言必须带上"它自己会话里正在发生什么"

B 路线（发言走一次性外部调用）有一个天生的缺口：上游子运行**没有上下文连续性**，
prompt 里只有议题与群聊记录的话，发言人就是个"就事论事的陌生人"——
用户看到的症状是"上下文没继承：会上人人都在说，却没人知道同伴手里进展到哪"。

修法是一条**依赖注入**（core 不许 import adapters，方向只能是 core ← adapters）：

```
host.apply() ──contextOf──▶ MeetingOrchestrator.projectionFor()
                                 │
                                 ├─▶ 入场引导（entry turn，落盘可审计）
                                 └─▶ 每次发言的 prompt（现读，不是快照）
```

`readSessionContext()`（`adapters/dsh-session-catalog.ts`）负责"借"：
`ctx.sessions.get(sessionId).deriveMessages()` 取末尾若干条，限长投影。
三个关键决定，每一个都是实测踩出来的：

| 决定 | 理由 |
|---|---|
| **每次发言现读，不是入会时快照** | 会话入会后还在继续工作，快照会立刻过期；"它现在卡在哪"恰恰是会上最该被带出去的信息 |
| **先过滤 system 消息再截尾部** | 端到端实测：`deriveMessages()` 把几千字的宿主系统提示词放在第一条，不过滤的话限长预算全被样板占满、真实对话被截断挤出投影——**借了上下文却等于借了一段废话，比不借更隐蔽** |
| **借不到就老实没有**（undefined → 投影段整段省略） | 会话没加载（候选项里的"未加载"徽标就是这个状态）、上游抛错，都是正常分支；伪造一段上下文比没有更糟 |

投影拼进两处：**入场引导**（它是"会上到底给了这位成员什么私有信息"的审计证据，
出了上下文污染争议时要靠它自证）和**每次发言的 prompt**（`buildSpeechPrompt` 的
"你的私有记忆投影"段；投影为空时整段省略——留个空标题只会让模型去臆测）。

### 5.14 主持人调用失败也不能毁掉一场会 + mock 端到端测试

**主持人失败不毁全场。** `speakSafely` 早就守住了"单个成员发言失败不毁会"，
但主持人的模型调用失败（鉴权 / 超时 / 抖动）曾让异常一路冒出去——
第 1 轮所有人都已经发言了，会议却在主持人环节整个报废，record 不落盘、纪要全丢。
现在它和发言同一条原则：记进 transcript 与失败明细，按 `safeFallback` 安全轮转继续。
主持人拿不到模型时，会议降级成确定性轮转，而不是消失。

**mock 端到端测试**（`pnpm run test:e2e`）。单测里的 ctx 终究是假的；
"正式会议室在活宿主里开成过一次"这件事，由一条**真实 `dsh web` + Python mock LLM** 的
链路验证（`tests/e2e/`）：

- `mock_llm.py`：本地复刻 `@deepseek-ai/dsh-llm-deepseek` 的 **Messages 协议**
  （`POST /messages` + Anthropic SSE 事件序 + `x-api-key` 头）。回复策略：
  主持人 prompt（含 `【会议主持】`）→ 输出 JSON 控制决定（本轮所有人都发言过就散会），
  其余一律 `ABC N`。每个请求连 prompt 一起落盘——**模型收到的 prompt 是唯一权威证据**。
- `run-e2e.mjs`：起 mock → 起 `dsh web`（`DEEPSEEK_BASE_URL` 指到 mock，端口 3081，
  用户的 3080 实例永不碰）→ 无头 Chrome 走 **CDP over pipe**（沙箱禁 TCP 调试端口）
  → 建会话、**把模型切成 deepseek-flash**（宿主默认模型是用户 settings 里的
  mimo-v2.6-pro，走真实计费端点；不切的话 mock 接不到调用）→ 发一条带时间戳的标记消息
  → 面板建房、加两个会话 → 点「召集会议」→ 每 500ms 采集实时视图 → 断言。

四条断言对应"整体能通 + 全程可见 + 保持上下文"：

| 断言 | 判据 |
|---|---|
| 整体能通 | `room-meetings.jsonl` 有一场完整的会：entry/speech/moderator 齐全、发言全是 `ABC N`、每成员一份个性化纪要 |
| 模型通道 | 会话里真的收到 mock 的 `ABC N` 回复（证明调用走了 mock，没碰真实 API） |
| 全程可见 | 会议进行中实时视图被采到 20 帧，记录条数持续增长（4 → 11 条），散会后区块消失 |
| **保持上下文** | mock 日志里，**带完整时间戳标记的那条用户消息出现在成员发言的 prompt 里**（投影段中） |

实测结论（2026-09-23，18/18 步通过）：一场 6 轮、10 次发言、2 份纪要的会完整跑通，
5 条发言 prompt 带着借来的真实上下文；另一个**未加载**的成员没有投影——
"借不到就老实没有"的对照组行为与设计一致。证据存档在 `logs/_e2e-mock-last/`。

> 两个值得记住的环境事实：① `cordis.patch.yml` 里的 `rootDir` **优先于** `DSH_MEETING_ROOT`
> 环境变量（config 优先），所以 e2e 的数据根就是项目的 `.dsh-meeting/`，与开发实例一致；
> ② **切走当前会话会把它逐出 `ctx.sessions`**（候选项出现"未加载"），
> 而借上下文要求成员在进程里活着——所以 e2e 让带标记的会话始终保持活跃，
> 第二个成员用任意旧会话（未加载 → 无模型 → 继承 lead 的 deepseek-flash → 照样走 mock）。

---

## 七、架构调研结论（简版）

完整论证见 [docs/架构调研结论.md](docs/架构调研结论.md)。

### 7.1 挂在哪一层？需要新协议吗？

**挂在 `@dsh-std/core` 元协议之上，定义一份新的私有领域协议 `meeting.dsh/v1alpha1` / `BriefingBoard`。**

需要新协议，三个硬证据：

1. **`@dsh-std/agent` 根本没有 npm 包。** 实测 `npm view @dsh-std/agent` → `E404`。
   同批未发布的还有 `content` / `events` / `permission`。复用 Agent 协议在依赖层面不可能。
2. **`@dsh-std/session` 操作集穷举且封闭。**
   `SessionCatalog = list|get|create|rename|delete|watch`，`SessionHistory = read|follow|fork`。
   **没有 append、没有 turn、没有 prompt**，无法表达"会话在会议室里说一句话"。
   提案里甚至明确写了 `No arbitrary append`。
3. **dsh-std 自己鼓励这条路**（仓库 `AGENTS.md`）：
   > Private protocols use their own namespaced `apiVersion` and participate through
   > the same core declaration and negotiation mechanism as public protocols.

### 7.2 最小依赖包面

**运行时 5 个包**（已实测可解析为单一 `@dsh-std/core` 副本）：

```
@dsh-std/core         0.1.1-rc.2   元协议本体（ProtocolCatalog / ProtocolDefinition 是真实实现）
@dsh-std/manifest     0.1.1-rc.2   parseManifest / projectManifest / ManifestDefinitionCatalog.validate
@dsh-std/composition  0.1.1-rc.1   compose() + ProtocolCompositionRule（**必须是这个版本**）
@dsh-std/lifecycle    0.1.1-rc.2   LifecycleCoordinator / ActivationDriverRegistry
@dsh-std/sdk          0.1.1-rc.2   defineFacet
```

> ⚠️ **踩过的坑**：`@dsh-std/composition@0.1.0-rc1` 把 `@dsh-std/core` 钉死在 `0.1.0-rc1`，
> 会装出**两份 core**，导致 `ProtocolCatalog` 类型不兼容
> （`Types have separate declarations of a private property 'definitions'`）。必须用 `0.1.1-rc.1`。

**刻意不依赖**：

- `@dsh-std/adapter-dsh` —— 业务插件不该 import 它（它 README 自己写明
  `Standard plugins neither … nor import this adapter`）。它是**宿主**适配层，我们只抄它的写法。
- `@dsh-std/storage` —— 它是**组件私有** KV，而会议室/简报板是**跨会话共享**通道，语义不符。

### 7.3 适配层：怎么隔离上游 DSH 的破坏性变更

`src/adapters/dsh-team-runtime.ts` 是全仓库**唯一**接触上游形状的文件：

1. **零 `@deepseek-ai/*` import**——上游改导出、改包名、改类型都不会让本插件编译失败；
2. **所有上游成员声明为 optional**——上游删掉 `interrupt`，这里只是能力探测返回
   `canInterrupt: false`，不是编译爆炸或 `undefined is not a function`；
3. **能力是探测出来的**——拿不到 `agentTeams` 就明确报降级，绝不假装能开会。

上游真实形状（已按 `@deepseek-ai/dsh@0.1.6-alpha.2` 的 `.d.ts` 逐条核对）：

```ts
spawnTeammate(caller, { name, description, prompt, context: 'fresh'|'fork', provider, signal })
sendMessage(caller, { target, content, signal })    // 持久信箱：空闲成员会被起一个新回合
interrupt(caller, targetName)
waitForChange(caller, timeoutMs, signal)
```

**诚实评估**：peerDependencies 区间隔离不了上游变更。真正起作用的是
**结构化鸭子类型 + 可选成员 + 能力探测**。但本插件**不能**声称对 DSH 零依赖：
必须调 `ctx.agentTeams` 才能创建 Agent。目标是"把耦合收敛到 1 个文件、失败时优雅降级"。

---

## 八、代码地图

```
src/
├── core/                            ← 零 dsh-std、零 DSH 依赖，纯 node 毫秒级测试
│   ├── types.ts                     领域模型 + ModeratorDecision
│   ├── briefing-text.ts             长度硬预算 + 内容指纹
│   ├── briefing-board.ts            追加式 JSONL 简报板（轻量路径）
│   ├── stall-detector.ts            四类停滞信号（外部计算）
│   ├── triggers.ts                  定时/轮次/停滞/按需 触发 + 节流
│   ├── coordinator.ts               轻量路径协调器 + 唤起链
│   ├── room-registry.ts           ★ 会议室实体 + 排他会籍（跨工作区，持久化）
│   ├── participant.ts             ★ 会话状态机：working/awaiting-entry/in-meeting/...
│   ├── meeting-room.ts            ★ 多轮群聊：入场注入 + 长度预算 + 滚动上下文
│   ├── moderator.ts               ★ 主持人：**没有上下文**的控场通道
│   ├── minutes.ts                 ★ 会后个性化压缩（相关性判据 + 压缩校验）
│   ├── room-orchestrator.ts       ★ 召集→等待入场→主持人控场→压缩→散会 全流程
│   ├── membership.ts              ★ 准入策略：子 Agent 不许入会、入会/退出时点必须非活动
│   ├── console.ts                 ★ 面板与全局工具**共用的唯一数据面**（含可见性分级）
│   ├── room-minutes.ts            ★ 正式会议室会议记录落盘（transcript + 每人纪要）
│   └── activity-tracker.ts          所有会话的忙/闲跟踪（候选列表与准入都靠它）
├── protocol/
│   ├── meeting-protocol.ts          私有协议 definition（validate + negotiate）
│   └── meeting-composition-rule.ts  让 compose() 排出 provider→consumer 顺序
├── ports/
│   ├── agent-runtime.ts             协调器 ↔ 上游运行时 的边界（wake/steer）
│   └── meeting-voice.ts             会议室里的"声音"（发言 / 纪要，带该会话的 model）
├── adapters/
│   ├── dsh-team-runtime.ts        ★ 唤起/通知：结构化鸭子类型，零上游 import
│   ├── dsh-meeting-voice.ts       ★ 让会话说一句话：one-shot 子调用 + 读回输出 + 失败处理
│   ├── dsh-boundary-watcher.ts    ★ 等边界入场：订阅 session/event 的 step/end
│   ├── dsh-session-state.ts       ★ 会话活动 → 成员状态：turn/start / turn/end
│   ├── dsh-session-catalog.ts     ★ 候选会话目录：读 ctx.sessions、判定子 Agent、读模型、**读标题**
│   ├── dsh-meeting-tool.ts        ★ 全局工具 dsh_meeting（"开会"这个按钮，给 Agent）
│   ├── dsh-meeting-remote.ts      ★ 面板端点（Typert SRC 通道，按契约复刻而非 import）
│   ├── moderators.ts                确定性主持人 + 脚本化主持人
│   ├── scripted-voice.ts            确定性声音替身（测试 + 演示）
│   └── in-memory-runtime.ts         内存运行时替身
├── facet.ts                         coordinator facet（provider）+ agent facet（consumer）
├── host.ts                          真实 compose() + LifecycleCoordinator 装配 + apply() + pulse()
└── bin/
    ├── demo-meeting-room.ts         会议室端到端演示（11 步）
    ├── demo-briefing-exchange.ts    轻量路径演示（7 步）
    ├── check-manifest.ts            安装前静态校验
    ├── probe-composition.ts         打印真实组合计划
    └── submit-briefing.ts           成员侧简报提交 CLI（旧模型遗留，通道仍由测试看守）

client.js                          ★ 浏览器半边：侧栏「会议室」入口 + 全屏面板
                                     （含**实时会议视图**：2 秒轮询 liveMeeting，手写，无需打包器）

tests/
├── meeting-context.spec.ts        ★ 借上下文接线三层测试（readSessionContext / 编排器 / 宿主）
├── console-and-tool.spec.ts        会籍模型 + 实时会议视图（会中快照 / 可见性 / 散会回落）
└── e2e/                          ★ 真实 dsh web + Python mock LLM 的端到端（见 5.14）
    ├── mock_llm.py                 Messages 协议 mock（回 ABC N / 主持人 JSON）
    └── run-e2e.mjs                 CDP over pipe 驱动面板开一场真会并断言

★ 标记的是理解本项目最该先读的文件。

---

## 九、`dsh-plugin.json` 清单草案

见 [dsh-plugin.json](dsh-plugin.json)（Community Draft v0.15）。`pnpm run check:manifest` 的真实输出：

```
compatible : YES
issues     : (无)
```

**"零 issue" 是刻意修出来的，不是本来就这样。** 发布前这份清单会报 3 条 warning：

```
[warning] unknown-protocol  — messages.dsh/v1alpha1 MessageObserver is unknown
[warning] unknown-extension — extension definition is not installed  (×2)
```

它们本身是机制在正常工作（在说"你还没装 `messages` 协议与 Command 扩展的 definition"），
但根因是**清单声明了实现里根本不存在的东西**：一个 `MessageObserver` 契约、两个
`meeting.coordinator.*` 命令。清单是准入契约——市场会照着它给用户显示"这个插件提供 2 个命令"，
而点下去什么都不会发生。所以那三项被删掉了，只保留真正在跑的东西：

- `requires.contracts` 只留私有协议 `meeting.dsh/v1alpha1 / BriefingBoard`（真的在协商）；
- `permissions` 只留一条 `messages.observe`，理由改成实际行为（开会时读参会会话的上下文）；
- `contributes.commands` 是空的。

### ⚠️ 一个必须知道的事实

实测（`@deepseek-ai/dsh@0.1.6-alpha.2`）：**内核不读 `dsh-plugin.json`**。
在 DSH checkout 里 grep 零命中。内核真正读的是 `package.json` 的
`dsh.bundle.patch` → `cordis.patch.yml`。社区插件 `dsh-pdf-edit@0.4.5` 与
`dsh-noletme@0.3.3` 的实证是：两者**都 ship 了 v0.15 清单，但都仍靠 `package.json.dsh` 真正挂载**。

所以本插件**两者都提供**：`dsh-plugin.json` 服务标准/市场/准入层，
[cordis.patch.yml](cordis.patch.yml) 服务运行时。

### 清单声明的入口，两条路都能走到

`facets.host.entry` 写的是 `dist/host.js`。实测两种寻址方式：

| 寻址方式 | 结果 |
|---|---|
| 绝对路径 / `file://` URL 直接加载 | ✅ 加载成功（宿主与市场走这条） |
| `require.resolve('dsh-meeting-coordinator/dist/host.js')`（按包名 + 子路径） | ⚠️ 原本被 `exports` 挡住（`ERR_PACKAGE_PATH_NOT_EXPORTED`），已在 `exports` 里补上 `./host` 与 `./dist/host.js` 两个子路径 |

补这一条是因为**清单声明了什么，别人就有权按什么去寻址**——声明了 `dist/host.js`
却在 `exports` 里不给这个子路径，等于给下游埋了一个"按文档走却报错"的坑。

---

## 十、分步验证

### 第一步：会籍与状态机

```bash
pnpm run test -- tests/meeting-room.spec.ts
```

| 要证明的 | 判据 |
|---|---|
| 会籍是权限边界 | 未加入的会话越权召集被拒；排他会籍抛错 |
| 会籍可恢复 | 新 `RoomRegistry` 实例重放日志后成员关系不丢 |
| 跨工作区 | 同一会议室成员来自不同 workspace |
| working 不被打断 | `working` → `awaiting-entry`；`onWorkUnitComplete()` → `in-meeting` |
| 空闲直接入场 | `idle-waiting` / `done` → 立即 `in-meeting` |
| 全员忙碌时不留僵尸 | 召集失败后所有人仍是 `working` |

### 第二步：会议室与主持人

| 要证明的 | 判据 |
|---|---|
| 入场注入 | entry turn 含定位 prompt + **自己的**记忆投影，不含别人的 |
| 不做结构化模板 | 引导里**没有**"请严格按…"三段式；提示词用轻松语气（"字数无所谓"），硬上限放宽到 1600 字 |
| 迟到者补入场 | 会议中途 `onWorkUnitComplete()` 入场并拿到自己的引导 |
| 主持人无上下文 | prompt 含"没有任何与会者的私有上下文" |
| 主持人用召集者的模型 | `ScriptedModerator` 收到的 `model` 全是召集者的 |
| 主持人坏掉不卡会 | 输出跑偏 → 安全回退；点名不在场的人 → 跳过 |
| 上限兜底 | 主持人一直想继续时，`maxRounds` 强制散会 |

### 第三步：压缩与散会

| 要证明的 | 判据 |
|---|---|
| 每人一份且不同 | `new Set(notes.map(n=>n.text)).size === 3` |
| 真的是压缩 | `validateMinutes` 拒绝"越压越长" |
| 记忆结构 | 私有上下文不变 + 新增 1 条自己的纪要 |
| 每人用自己的模型 | `voice.calls` 里 speak 的 model 与各会话配置一致 |
| 散会全回工作 | 三种来源状态 + 缺席者散会后都是 `working` |
| 出错也回收 | 阶段失败时 `finally` 保证不留半开会状态 |

### 第四步：模型调用通道与等边界入场（接上游）

```bash
pnpm run test -- tests/dsh-voice.spec.ts
```

| 要证明的 | 判据 |
|---|---|
| 调用映射正确 | `start('spawn', { label, prompt:[{type:'text'}], parent, signal, agentOptions })` |
| **模型按会话透传** | `agentOptions.model` 等于该成员的 model；不给就不带该字段 |
| **失败不是沉默** | `stopReason: 'error'` → 抛错；空输出 → 抛错；非文本块 → 抛错 |
| 超时不挂死 | 上游忽略 abort 时仍按超时抛错（`raceWithAbort`） |
| 资源释放 | 成功与失败路径都调用 `run.dispose()` |
| 主持人无上下文 | 实际发出的 prompt 含"没有任何与会者的私有上下文"，且不含任何 slot 的 systemPrompt |
| 等边界入场 | `session/event` + `step/end` → `onWorkUnitComplete` → 成员进入会场 |
| 边界可配 | `turn-end` 配置生效；非边界事件被忽略；未知会话不触发 |
| 监听器安全 | 回调抛错被捕获，不污染宿主事件分发 |
| **端到端** | `apply()` → 激活 → 开会 → 每人用自己模型发言 → 各自纪要 → 散会回 working |

### 第五步：停滞 → 会议室 的升级路径与会话状态驱动（接上游的最后一公里）

```bash
pnpm run test -- tests/room-escalation.spec.ts
```

| 要证明的 | 判据 |
|---|---|
| **那条箭头真的接了** | `pulse()` 在停滞成立时产出 `RoomMeetingRecord`；录到 2 条发言、2 份互不相同的纪要 |
| **定时器走的是 pulse** | 打桩 `setInterval` 后手动触发一次回调，会议室会议数从 0 变 1（只走 `tick()` 时永远是 0） |
| 升级失败不抛错 | 全员 `working` 时返回 `escalated:false` 且理由含"工作中"；不留半个会议状态 |
| 没有停滞就明说不升级 | `escalate({stallSignals:[]})` → `escalated:false`，理由含"没有停滞信号" |
| **成员状态由会话活动驱动** | `turn/end` → `idle-waiting`；`turn/start` → `working` |
| 待入场者收到 turn/end 直接入场 | 状态变 `in-meeting` 而不是 `idle-waiting`，且进 `admittedLate` |
| 未知会话被忽略 | 不报错、不改任何成员状态 |
| **会话映射自动探测** | `agentTeams.listMembers()` 的 `{id,name}` 按 teammate name 对齐；别人的成员不被误认 |
| 显式映射优先 | `config.memberSessions` 覆盖探测结果 |
| **配置错误能自解释** | 升级失败的理由点名未映射的会话 id，并提示去配 `memberSessions` |
| 不编造映射 | subagents 后端如实返回空数组 |
| 环境变量真被读了 | `readSlotsFromEnv` 解析 JSON 数组；非法 JSON / 非数组 / 缺字段一律明确报错 |

### 第六步：boot 安全（一个活 Agent 都没有时也不能把 dsh 带下线）

| 要证明的 | 判据 |
|---|---|
| **没有活 Agent 时 `apply()` 仍成功** | 不抛错；`pendingMembers` 列出未启动的成员；槽位规格仍登记（停滞检测照常） |
| 升级失败带回理由而非抛错 | 理由含"升级未成立"且**点名"尚未启动"的成员** |
| **用户开会话后成员能补起来** | `agents.add(...)` → `retryMembers()` 返回全部槽位；`pendingMembers` 立刻变空（getter，不是快照） |
| 补起后功能完整 | 会话事件驱动状态 + `pulse()` 升级成立 |
| 没有活 Agent 时会议确实开不起来 | `convene()` rejects（发言要 exact live Agent 当 parent），但 `finally` 收干净、不留半开会状态、不卡后续轮次 |
| **只要活的 Agent，不要服务对象** | 优先级 `currentInitiator > roots > list`；无 `id` 的一律跳过；`ctx.get('agents')` 不可用时返回 undefined 而非抛错 |

### 第七步：Cordis 契约与轮次可观测性

| 要证明的 | 判据 |
|---|---|
| **`apply` 的返回值能过 `safeCollect`** | 复刻 cordis `Fiber._execute` 的判定：resolve 的是函数（disposer），不是句柄对象 |
| disposer 幂等 | 连续调两次不抛错（Cordis 卸载时它和 `ctx.on('dispose')` 可能一起触发） |
| disposer 真的解绑了 | 卸载后再发会话事件，成员状态不再变化 |
| 升级失败会 warn 一次 | 宿主 logger（属性形式或 `ctx.get('logger')`）收到 `未升级到会议室：…`，含"尚未启动"诊断 |
| 升级成功会 info | 同上，成功时走 info |
| **结论不变不重复刷** | 连跑两轮，logger 与 `pulse.jsonl` 都只有一条 |
| 落盘可查 | `pulse.jsonl` 含 escalated / reason / signals / trigger / meeting id |

### 真实宿主装配（不是 mock）

```bash
pnpm run probe:composition
```

```
compatible: true
activationOrder:
   io.github.dsh-meeting.coordinator@0.1.0#coordinator          ← provider 先
   io.github.dsh-meeting.coordinator.live-trading@0.1.0#agent-live-trading
   io.github.dsh-meeting.coordinator.neural-net@0.1.0#agent-neural-net
```

走的是 dsh-std **真实的** `compose()` 与 `LifecycleCoordinator.activate(plan)`。里面有个坑：

> `compose()` 的 `activationOrder` **只由 `ProtocolCompositionRule.preflight` 产出的
> `bindings` 推导**。只声明 `requires`/`supports` 而不注册规则，排序退化成 participantId
> 字母序，成员 facet 会排在协调器前面，激活期 pre-negotiation 直接失败：
> `requirements are unavailable: 没有任何 support 提供 BriefingBoard`。

---

## 十一、诚实边界

**已在真实环境验证**：

- ✅ **215 个测试全绿**；`pnpm run verify` 端到端可复现（exit 0）
- ✅ **正式会议室在真实 `dsh web` 里开成过**（mock 端到端，2026-09-23，18/18 步）：
  真实宿主装载 → 面板建房加人 → 「召集会议」→ 6 轮 / 10 次发言 / 2 份个性化纪要完整落盘
  （`room-meetings.jsonl`），模型调用全部走本地 mock（`ABC N`），
  **发言 prompt 里带着该会话的真实上下文**（借上下文探针命中）。
  实时会议视图在会中被连续采到（记录条数 4 → 11 持续增长）。证据：`logs/_e2e-mock-last/`。
- ✅ 会籍、状态机（含等待入场）、主持人控场、个性化压缩、散会回收全部已断言
- ✅ **模型调用通道已接线**：`ctx.subagents.start` → 读回 `run.result` → 提取文本，
  含失败处理（`stopReason` / 空输出 / **abort 竞速**）与资源释放（`run.dispose`）
- ✅ **等边界入场已接线**：`ctx.on('session/event')` → `step/end` / `turn/end` → `onWorkUnitComplete`
- ✅ 有一条 `apply()` 的端到端用例走完整真实代码路径（见下）
- ✅ 走真实 `compose()` + `LifecycleCoordinator` 完成 facet 激活与卸载回收
- ✅ 所有 DSH 调用映射已按 `0.1.6-alpha.2` 的真实 `.d.ts` 签名核对
- ✅ 依赖解析：5 个包可解析为单一 `@dsh-std/core` 副本
- ✅ **能装进真实 profile**：`dsh plugin --profile web add <本包>`（pnpm 用 `link:` 软链，
  所以 `@dsh-std/*` 从本项目的 `node_modules/.pnpm/` 解析，**不需要单独安装 dsh-std**，
  也不会有"两份 core"问题）。`package.json` 的 `dsh.bundle.patch` 让 CLI 认它为 bundle 层；
  重装后**不再出现** `declares no dsh.bundle` 那条 warning。
- ✅ **会议室面板已在真实 `dsh web` 页面里跑通**（无头 Chrome，CDP over pipe）：
  侧栏底部出现 **🗂 会议室** 入口 → 点开是全屏面板 → 在面板上新建房间 →
  宿主落盘 `{"kind":"room-created","id":"daily"}`。
  候选列表里能列出**真实会话**（`session-750e30ff-…`）并给出"加入会话"按钮。
  截图见 `logs/_panel-open.png` / `logs/_panel-created.png`。
- ✅ **装载契约已用 `dsh --profile web --dump-config` 验证**（不启动 GUI，走真实
  bundle 层解析 + patch 组合）：本插件作为最后一层出现在组合结果里，
  `inject` 与 `config` 原样生效，profile 自己的 patch 层不互相污染。
- ✅ **停滞 → 会议室那条箭头已接线**：`pulse()` 把触发评估的停滞信号升级成
  `orchestrator.convene()`（6 个断言覆盖，含"定时器走的是 pulse 而不是 tick"）。
- ✅ **成员状态由真实会话活动驱动**：`turn/start` / `turn/end` → `working` / `idle-waiting`，
  没有它 `convene()` 永远抛"全部成员都在工作中"。
- ✅ **会话映射可自动探测**：`agentTeams.listMembers()` 按 teammate name 对齐拿会话 id
  （按真实 `TeamMemberView` 的 `id: SessionId` + `name` 核对）。
- ✅ **boot 安全**：一个活的 Agent 都没有时（`dsh web` 刚启动、用户还没开会话）
  插件仍然加载成功并降级，**不会把 dsh 带下线**；成员由 `pulse()` 每轮重试补起。
  这条是被真机 boot 逼出来的——第一版把 `ctx.get('agents')` 服务对象直接当 caller 传下去，
  得到 `agent "undefined" is not a member of an active Agent Team`，
  以 `plugin tree failed to load` 的形式让整个 dsh 起不来。
- ✅ **`apply` 返回值符合 Cordis 契约**：返回 disposer 函数（句柄挂 `.host`），
  而不是直接 resolve 句柄对象。第二版就是这么崩的：`TypeError: Invalid effect`。
- ✅ **已经在活的 DSH 宿主里跑起来过**（`dsh web`，插件以 bundle 层装载）：

  | 观察到 | 证据 |
  |---|---|
  | 插件加载成功，无 `plugin tree failed to load` | `dsh web: http://127.0.0.1:…` |
  | 会议室实体建立、两名成员入会（带 workspace + model） | `.dsh-meeting/rooms.jsonl` |
  | 停滞触发 → 轻量路径每轮开会 | `.dsh-meeting/<boardDomain>/meetings.jsonl` |
  | 有活 Agent 时成员真的 spawn 成功，摘要投递到人 | 会议记录里 `deliveredTo` 两名成员且 `failures` 为空 |
  | 无活 Agent 时优雅降级，理由自解释 | `.dsh-meeting/pulse.jsonl` 里点名"尚未启动"的成员 |

**尚未验证（必须说清楚）**：

- ⚠️ **端到端里的模型是 mock，不是真实模型**。"链路通 + 上下文带上了"已证实；
  "真实模型开出来的一场会**质量**如何"没有验证过（那要花真实额度）。
- ⚠️ **面板只在浅色主题下看过**。配色是运行时量页面背景亮度算出来的（明暗两套），
  但深色主题的实际观感没验证过。
- ⚠️ **面板的"按会籍过滤"视图没有在浏览器里走过**——面板固定以 `human` 观察者调用
  （看全部），收窄口径目前只由单测覆盖。
- ⚠️ **`/meeting` 与 `/meeting-status` 命令仍未实现**（`dsh-plugin.json` 声明了）。
  人类入口目前是面板；Agent 入口是全局工具 `dsh_meeting`。
- ⚠️ **旧模型的"插件自己 spawn 成员"那条路还在代码里**（`facet.ts` 的 agent facet +
  `host.ts` 的 `retryMembers`）。真实配置里 `slots` 为空，所以它不会被走到；
  但它是遗留路径，下一轮应当整段删除——新版模型不需要 spawn 任何成员。
- ⚠️ **`ctx.logger` 的去向未确认**。Cordis 内建 logger 的默认导出器只进内存缓冲，
  实测 `ctx.logger.warn` 没出现在 `dsh web` 的 stdout（可能走 GUI 日志面板）。
  所以把 `pulse.jsonl` 当**权威通道**，logger 当尽力而为。
- ⚠️ **上游事件名是内部词汇表**。`turn/start` / `turn/end` / `step/end` 取自
  `0.1.6-alpha.2`，可在 `dsh-session-state.ts` 的 `events` 与
  `config.entryBoundary` 覆盖；但若上游换了名字而没人改配置，表现会是
  "没人转空闲"——此时升级失败的理由里会点名未映射的会话 id，便于定位。
- ⚠️ `demo:room` 用的是脚本替身，**不是真实模型**。模型通道的正确性由单测 +
  端到端（mock）保证，但"真实模型开出来的一场会质量如何"没有验证过。
- ⚠️ **成员发言之间没有上游侧的上下文连续性**。每次发言是一次干净的 one-shot 调用，
  连续性靠协调器把 transcript + **借来的私有上下文**注入每轮 prompt。这是刻意的取舍
  （见第四节说明），但如果将来需要真正的持久子会话，要用 `startContinuable` + 会话事件观察替换。
- ⚠️ **`agentTeams` 没有 close/kill 成员的方法**（只有 `interrupt`）。
  适配层的 `close()` 只能解除本地映射并如实记录这个缺口。
- ⚠️ **`agentTeams` 不暴露 `agentOptions`**，所以走 agentTeams 后端时模型不可指定；
  但**会议室路径不依赖它**——发言走 `ctx.subagents`，那里的 `agentOptions.model` 可用。
- ⚠️ **跨进程会议室未实现**。同进程共享句柄；跨进程应改用 `@dsh-std/connection` 的 attachment。
- ⚠️ **未做 permission enforcement**（dsh-std 目前没有代码执行权限，
  `authorizePermission` 全仓无调用者），插件内自行兜底。
- ⚠️ **`ScriptedMeetingVoice` 的默认纪要替身**（正则挑行）只用于验证"每人一份且互不相同"，
  **它产出的文本不代表真实质量**。真实质量取决于模型。
- ⚠️ **`/meeting`、`/meeting-status` 命令还没做**（src 里零命中）。清单原本声明了这两个命令和
  一条对应的 `commands` 权限——**发布前已删掉**：清单是给市场和宿主看的准入契约，
  声明一个点了没反应的命令，等于给用户埋一个必现的 bug。现在
  `contributes.commands` 是空的，权限只保留真正在做的那条（读参会会话的上下文）。
  人类想手动开会，走返回句柄的 `orchestrator.convene()` 或面板上的「召集会议」按钮。
- ⚠️ **`dist/` 是提交进仓库的构建产物**（原因见[第三节](#三安装)：pnpm ≥10 不允许
  git 依赖跑构建脚本）。所以改了 `src/` 必须 `pnpm run build` 并**把 `dist/` 一起提交**，
  否则仓库里的产物会与源码漂移。
- ✅ **`cordis.patch.yml` 里已不再写死 `rootDir`**（发布前已移除本机绝对路径）。
  现在走 `DSH_MEETING_ROOT` 或默认值 `join(process.cwd(), '.dsh-meeting')`。
  要用固定位置请自己打开那一行。注意 config 优先于环境变量（见 5.14）。
- ⚠️ **端到端测试会在用户的 dsh 里留下痕迹**：若干 `ABC *` 标题的测试会话、
  若干 `e2e-*` 房间与会议记录。这是与开发实例共享数据根的代价，清理要谨慎
  （没有 deleteRoom API），目前选择接受。

**下一步优先级**：

1. 用**真实模型**（而非 mock）跑一次端到端，验证会议质量与限流下的稳定性；
2. 实现 `/meeting`、`/meeting-status` 命令，给人类一个手动入口（现在只有定时器能召集）；
3. 会后两段式压缩（先全局纪要，再按人定向查询）—— 调研建议的更稳做法；
4. 会议白板（结构化 decisions/blockers/asks）替代全量 transcript 注入，进一步压上下文。

---

## 十二、与参考方案的差异

调研了 4 个方案（证据与链接见 [docs/竞品调研.md](docs/竞品调研.md)）；
发言调度另见 [docs/发言顺序调研.md](docs/发言顺序调研.md)。

| 能力 | solution-council | Agent Chamber | Caucus | ClawTeam | **本项目** |
|---|---|---|---|---|---|
| **会议室（群）作为持久实体** | ❌ | 部分 | 部分 | ❌ | ✅ |
| **会籍 = 召集权 + 参会义务** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **跨工作区成员** | ❌ | ❌ | ❌ | 部分 | ✅ |
| **working 会话不被打断，等边界入场** | ❌ | ❌ | ❌ | ❌ | ✅ |
| 多轮群聊 | ❌ | ❌ | 部分 | ❌ | ✅ |
| **带私有记忆入场** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **主持人无上下文（不会被带偏）** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **会后每人独立压缩** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **每人用自己的模型** | ❌ | ❌ | ❌ | ❌ | ✅ |
| 外部停滞检测 | ❌ | ❌ | ❌ 靠自判 | ❌ | ✅ |
| 限长硬预算 | ❌ | ❌ | ❌ | ❌ | ✅ |
| **散会全部回到工作状态** | ❌ | ❌ | ❌ | ❌ | ✅ |
| 人可开会 / 可在会中发言 | ❌ | ❌ | 部分（人类当主席） | ❌ | ✅ |
| 协议层可移植 | ❌ | ❌ | ❌ | ❌ | ✅ dsh-std 协议 |
| 安装前可知兼容性 | ❌ | ❌ | ❌ | ❌ | ✅ `dsh-plugin.json` |

---

## 欢迎贡献、反馈与已知不足

### 现在是什么状态

**已跑通并有测试覆盖**：

- 会议室（群）+ 排他会籍 + 跨工作区成员；
- `fork` 那个人过来开会（带完整上下文）+ `toolFilter: { allow: [] }`（**开会只管讨论，不给工具**）；
- 主持人控场多轮讨论（无上下文，不会被谁的私有记忆带偏）；
- 第一轮汇报 / 第二轮起讨论的两套字数策略（**硬上限不说给模型**）；
- 会后每人独立压缩纪要 → **当作用户输入回到工作区继续干活**；
- 会议**每条发言立刻落盘**，崩溃可恢复（`reconcileLive`）；
- `stop.flag` 外部急停通道；
- 215 个测试 + 端到端演示 + 清单静态校验。

**已知不足（欢迎补）**：

1. 还没在真实生产场景长期跑过 —— 稳定性、边界情况都待验证；
2. 跨进程会议室未实现（同进程共享句柄；跨进程应改用 `@dsh-std/connection` 的 attachment）；
3. permission 只在清单里声明，未真正 enforce（dsh-std 目前没有执行权限的代码）；
4. 会后压缩是「单段式」，调研建议的「两段式」（先全局纪要，再按人定向）更稳；
5. 主持人的控场 prompt 还比较朴素，收敛速度有优化空间；
6. 面板（web UI）功能有限：建室 / 加人 / 开会 / 看记录，没有编辑会籍、导出纪要等。

### 怎么反馈

- **报 bug** → [开 Issue](https://github.com/liaowenqi123/dsh-meeting-coordinator/issues)。最好附上 `.dsh-meeting/room-meetings.jsonl` 里那一场的记录（它已经**每条发言落盘**了）。
- **提想法** → 同样开 Issue，或直接发 PR。**这个项目现在最缺的就是真实场景的反馈** —— 它在我的机器上跑通了，但边界情况一定还有没覆盖到的。
- **发 PR** → 跑一下 `pnpm run verify`（一条命令验完），保持绿即可。

### 开发

```bash
pnpm run typecheck        # 严格 TS（含 exactOptionalPropertyTypes）
pnpm run test             # 215 个测试
pnpm run check:manifest   # 不执行插件代码，静态判定清单兼容性
pnpm run demo:room        # 会议室机制端到端演示（11 步全断言）
pnpm run verify           # 上面全部
```

> ⚠️ **改了 `src/` 记得 `pnpm run build` 并把 `dist/` 一起提交。**
> `dist/` 是入库的（原因见[第三节](#三安装)），忘了重建会让仓库里的产物和源码漂移。
> `pnpm run verify` 最后一步就会跑 `build`，所以正常走它不会漏。

代码地图见[第八节](#八代码地图)。最该先读的 9 个文件在图里用 ★ 标了。

---

## License

[MIT](LICENSE) © 2026 liaowenqi123

本项目**非常欢迎**反馈、提 bug、发 PR —— 见[欢迎贡献、反馈与已知不足](#欢迎贡献反馈与已知不足)。
它现在还不完善，你遇到问题大概率不是我故意留的坑，就是我还没想到的坑。
