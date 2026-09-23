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

import type { AgentSlotId, AgentSlotSpec, MeetingAgenda } from '../core/types.js'

/** 一个已启动的 Agent 实例在本地的句柄。 */
export interface AgentHandle {
  readonly id: string
  readonly slot: AgentSlotId
  /** 上游运行时实例标识；仅在诊断与审计中使用，不作为授权凭据。 */
  readonly runtimeRef: string
}

/** 投递给成员的消息类别。 */
export type DeliveryKind = 'spawn-prompt' | 'meeting-digest' | 'meeting-invite' | 'stall-notice'

/**
 * 投递语义。这是「互相唤起」的机制核心。
 *
 * - `wake`：把**空闲（idle / inactive）**的同伴叫起来，让它开一个新回合。
 *   DSH 的 durable mailbox 语义正是如此：发给 running 的目标在最近的步骤边界送达，
 *   发给 idle 的目标直接起一个回合，发给 inactive 的同伴冷启动。
 * - `steer`：目标正在跑，把这条消息插进它**当前**回合的下一步边界，不新起回合。
 *
 * 协调器必须显式选择语义：用错会得到很不一样的系统行为——
 * 该唤醒时用 steer 会石沉大海（空闲的 Agent 没有 active turn 可插），
 * 该 steer 时用 wake 会把一个正在专注工作的 Agent 打断成两个并行回合。
 */
export type DeliveryMode = 'wake' | 'steer'

export interface Delivery {
  readonly kind: DeliveryKind
  /** 消息意图。`wake` = 唤起（可能起新回合），`steer` = 融入当前回合。 */
  readonly mode: DeliveryMode
  readonly text: string
  readonly agendaId?: string | undefined
}

/** 一次活动观察的结果：协调器据此知道"我等到了什么"。 */
export interface ActivityObservation {
  readonly kind: 'changed' | 'timeout'
  readonly detail: string
}

/**
 * 上游能力探测结果。
 *
 * 关键：**能力是探测出来的，不是假设出来的**。
 * dsh-std 反复强调 "安装了某个包…不能代替运行中的 support 声明"；
 * 这里把同一原则用在适配层：拿不到 `agentTeams` 时不能假装能开会。
 */
export interface RuntimeCapabilities {
  /** 端口自身标识，例如 `dsh/agentTeams`。 */
  readonly port: string
  readonly canSpawn: boolean
  readonly canDeliver: boolean
  /** 是否区分 wake / steer 两种投递语义（持久信箱型上游为 true）。 */
  readonly canWake: boolean
  readonly canInterrupt: boolean
  /** 是否支持"等待同伴产生活动"，用于会议结束后收简报。 */
  readonly canWaitForActivity: boolean
  /** 上游是否有原生共享任务板（如 agentTeams.createTask 的 writeScopes/blockedBy）。 */
  readonly hasNativeTaskBoard: boolean
  /** 人类可读的降级说明，直接进诊断报告。 */
  readonly notes: readonly string[]
}

/**
 * 协调器依赖的运行时抽象。
 *
 * 刻意保持窄：只有"起一个领域隔离的 Agent"、"把它唤起/驱动"、"停掉它"、"等它动"。
 * 不做任务路由、不做工具调用、不暴露上游对象——那些都不属于例会的职责。
 */
export interface AgentRuntimePort {
  readonly port: string

  /** 探测当前环境实际具备的能力。必须无副作用且可在任何时刻调用。 */
  capabilities(): RuntimeCapabilities

  /** 启动一个领域隔离子 Agent。 */
  spawn(spec: AgentSlotSpec, options?: { readonly signal?: AbortSignal | undefined }): Promise<AgentHandle>

  /**
   * 向成员投递消息。`delivery.mode` 决定这是"唤起"还是"融入当前回合"。
   *
   * 实现契约：`wake` 必须能把空闲成员叫起来；做不到时必须抛
   * {@link RuntimeUnavailable}，**不允许**静默降级成"消息已排队但永远没人看"。
   */
  deliver(handle: AgentHandle, delivery: Delivery): Promise<void>

  /** 中断成员当前回合。用于"开会时把跑飞的 Agent 拉回来"。 */
  interrupt(handle: AgentHandle): Promise<void>

  /**
   * 等待同伴产生下一次活动。可选能力。
   *
   * 有它，例会才能是"交换"而不是"广播"：协调器唤醒 N 个成员后，
   * 可以等它们把新简报交上来，再决定是否开第二轮。
   */
  waitForActivity?(handle: AgentHandle, timeoutMs: number, signal?: AbortSignal | undefined): Promise<ActivityObservation>

  /**
   * 探测"槽位 → 上游会话 id"的映射。可选能力。
   *
   * 为什么需要它：上游的会话事件（`session/event`）带的是上游自己的会话身份。
   * 没有这层映射，事件归属不到成员——"等边界入场"和"成员是否空闲"两件事
   * 都会静默失效，看起来就像插件没装成功。
   *
   * 拿不到映射时应返回空数组，**不要**编造恒等映射：
   * 一个错的映射比没有映射更难排查。
   */
  memberSessions?(): Promise<readonly { readonly slot: AgentSlotId; readonly sessionId: string }[]>

  /** 终止成员并回收其资源。 */
  close(handle: AgentHandle): Promise<void>
}

/** 广播端口的输入：一次会议要通知的成员与要送达的议程。 */
export interface BroadcastInput {
  readonly handles: readonly AgentHandle[]
  readonly agenda: MeetingAgenda
}

/** 运行时不可用时的统一错误。 */
export class RuntimeUnavailable extends Error {
  readonly code = 'meeting/runtime-unavailable'

  constructor(message: string) {
    super(message)
    this.name = 'RuntimeUnavailable'
  }
}
