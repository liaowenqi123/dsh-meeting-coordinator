/**
 * 「会话活动 → 成员状态」的上游接线。
 *
 * ## 为什么需要它（不接这一层的后果）
 *
 * `AgentParticipant` 的初始状态是 `working`，而 `MeetingOrchestrator.convene`
 * 要求**至少一位**被召集成员能在召集瞬间直接入场
 * （`idle-waiting` / `done` 直接 `in-meeting`；`working` 只能进 `awaiting-entry`）。
 *
 * 如果没有任何东西把真实会话的活动映射成状态，那么：
 *
 * - 全体成员永远停在 `working` → `convene()` 永远抛
 *   「全部 N 位成员都在工作中，会议无法开始」→ **会议室永远开不起来**；
 * - 边界监听器的 `onWorkUnitComplete()` 也永远是 no-op
 *   （它只对 `awaiting-entry` 生效，而没人会被置成那个状态）。
 *
 * 也就是说：**状态机不喂，整条正式路径就是死代码。**
 *
 * ## 与 `dsh-boundary-watcher.ts` 的分工（刻意分成两条独立订阅）
 *
 * | 关注点 | 归谁 |
 * |---|---|
 * | "这个会话忙起来了 / 空闲了"（驱动 `resume` / `beginIdleWaiting`） | **本文件** |
 * | "这个会话的工作单元走到边界了"（驱动 `onWorkUnitComplete` 入场） | `dsh-boundary-watcher.ts` |
 *
 * 不把两者合并的理由：入场时机是**可配置的策略**（`entryBoundary: step-end / turn-end`），
 * 而活动状态是**客观事实**。混在一个订阅里，改入场策略就会连带改状态语义，
 * 那正是"兼容层"式 bug 的温床。
 *
 * ## 上游事件词汇表（内部词汇，未来可能变，所以可配）
 *
 * | 事件 | 含义 | 映射到 |
 * |---|---|---|
 * | `turn/start` | 该会话开始一个回合 | `busy` → `working` |
 * | `turn/end` | 该回合结束（输出完毕、等用户回复） | `idle` → `idle-waiting` |
 *
 * 只报告、不做领域决定：把"忙/闲"翻译成参与者状态是宿主的职责，
 * 本文件不认识 `AgentParticipant`。
 *
 * ## 监听器永不抛错
 *
 * Cordis 的事件回调里抛异常会污染宿主的事件分发。这里一律捕掉并记进 `errors`，
 * 与边界监听器保持同一约定。
 */

import { readSessionId, SESSION_EVENT_CHANNEL, type DshEventContextFace } from './dsh-boundary-watcher.js'

/** 会话活动的两种客观状态。 */
export type SessionActivityKind = 'busy' | 'idle'

/** 活动类别 → 上游会话事件名。可配，因为上游事件名属于内部词汇表。 */
export const ACTIVITY_EVENT: Readonly<Record<SessionActivityKind, string>> = {
  busy: 'turn/start',
  idle: 'turn/end',
}

export interface SessionActivityObservation {
  readonly sessionId: string
  readonly memberId: string | undefined
  readonly kind: SessionActivityKind
  readonly at: number
}

export interface DshSessionStateOptions {
  readonly ctx: DshEventContextFace
  /**
   * 把上游 sessionId 映射成本项目的成员 id。
   * 默认恒等映射（成员 id 就是会话 id）。返回 undefined 表示这不是受管成员。
   */
  readonly resolveMemberId?: ((sessionId: string) => string | undefined) | undefined
  /** 自定义事件名覆盖，用于上游词汇表变动时不必改代码。 */
  readonly events?: Partial<Record<SessionActivityKind, string>> | undefined
  /** 观察到活动时调用。异常会被捕获，不会打断宿主事件分发。 */
  readonly onActivity: (input: {
    readonly sessionId: string
    /** 未映射到成员时为 undefined。**依然会回调**：候选列表要的是全部会话的忙/闲。 */
    readonly memberId: string | undefined
    readonly kind: SessionActivityKind
  }) => void
  readonly now?: (() => number) | undefined
}

export interface DshSessionStateHandle {
  /** 解绑。幂等。 */
  detach(): void
  /** 观察到的事件流（用于断言与诊断）。 */
  readonly observations: readonly SessionActivityObservation[]
  /** 监听器里被捕获的异常（正常应为空）。 */
  readonly errors: readonly string[]
  /** 当前是否已成功订阅。`false` 说明宿主 ctx 不支持 `on`。 */
  readonly attached: boolean
}

export function attachDshSessionState(options: DshSessionStateOptions): DshSessionStateHandle {
  const resolveMemberId = options.resolveMemberId ?? ((sessionId: string) => sessionId)
  const now = options.now ?? (() => Date.now())
  const byEvent = new Map<string, SessionActivityKind>()
  for (const kind of ['busy', 'idle'] as const) {
    byEvent.set(options.events?.[kind] ?? ACTIVITY_EVENT[kind], kind)
  }

  const observations: SessionActivityObservation[] = []
  const errors: string[] = []
  let detachFn: (() => void) | undefined
  let attached = false

  if (typeof options.ctx.on !== 'function') {
    errors.push(
      `宿主 ctx 不支持 on()：无法订阅 ${SESSION_EVENT_CHANNEL}，` +
        '成员状态无法由真实会话活动驱动，"可被召集的空闲成员"将不存在。',
    )
  } else {
    const listener = (...args: unknown[]): void => {
      try {
        const event = args[1]
        if (typeof event !== 'object' || event === null) return
        const type = (event as { type?: unknown }).type
        if (typeof type !== 'string') return
        const kind = byEvent.get(type)
        if (kind === undefined) return

        const sessionId = readSessionId(args[0]) ?? readSessionId(event)
        if (sessionId === undefined) {
          errors.push(`收到了 ${type} 事件，但无法从载荷里读出 sessionId。`)
          return
        }
        const memberId = resolveMemberId(sessionId)
        observations.push({ sessionId, memberId, kind, at: now() })
        // 未映射到成员**也要回调**：忙/闲是"该会话"的属性，候选列表要用它，
        // 而候选列表包含大量非成员会话。归属不到成员只影响状态机那部分。
        options.onActivity({ sessionId, memberId, kind })
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }

    const returned = options.ctx.on(SESSION_EVENT_CHANNEL, listener)
    attached = true
    // Cordis 的 `on` 返回 `this`（可链式），只在返回函数时把它当解绑器。
    if (typeof returned === 'function') detachFn = returned as () => void
  }

  return {
    detach(): void {
      detachFn?.()
      detachFn = undefined
      attached = false
    },
    get observations(): readonly SessionActivityObservation[] {
      return [...observations]
    },
    get errors(): readonly string[] {
      return [...errors]
    },
    get attached(): boolean {
      return attached
    },
  }
}
