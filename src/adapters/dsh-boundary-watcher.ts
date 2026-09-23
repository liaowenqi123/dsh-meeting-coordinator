/**
 * 「等工作单元结束再入场」的上游接线。
 *
 * ## 需求
 *
 * > 一个 agent 正在 working（不论是正在输出还是在调用工具 ing），
 * > 都将在**调用结束后**进入会议室（有一个等待的过程）。
 *
 * ## 上游钩子（已按 `@deepseek-ai/dsh@0.1.6-alpha.2` 核对）
 *
 * DSH 的会话事件词汇表里有两个正好可用的边界：
 *
 * | 事件 | 含义 | 何时用 |
 * |---|---|---|
 * | `step/end` | 一个步骤结束（含该步里的工具调用） | **默认**。最贴近"调用结束后" |
 * | `turn/end` | 整个回合结束 | 希望成员把手头这轮彻底做完再进场时 |
 *
 * 订阅方式是 `ctx.on('session/event', (session, event) => …)`，
 * 从 `event.type` 判断边界、从 `session.id` 取会话身份。
 *
 * ## 三个刻意的设计
 *
 * 1. **边界类型与身份映射都可配**。上游事件名是内部词汇表的一部分，
 *    未来可能变；把它硬编码在一个地方、并允许配置，比散落各处强。
 * 2. **只报告，不做决定**。"这个成员是否真的需要入场"由编排器判断
 *    （`onWorkUnitComplete` 对非 `awaiting-entry` 的成员是 no-op），
 *    这样 watcher 不需要知道会议状态。
 * 3. **监听器永不抛错**。事件回调里抛异常会污染宿主的事件分发，
 *    所以这里捕掉异常并记进 `errors`，供诊断读取。
 */

/** Cordis `Context` 的极窄视图：只用到 `on`。 */
export interface DshEventContextFace {
  on?(event: string, listener: (...args: unknown[]) => void): unknown
}

/** 采用的边界。 */
export type BoundaryKind = 'step-end' | 'turn-end'

/** 边界 → 上游会话事件名。 */
export const BOUNDARY_EVENT: Readonly<Record<BoundaryKind, string>> = {
  'step-end': 'step/end',
  'turn-end': 'turn/end',
}

/** 上游用于承载会话事件的 Cordis 事件名。 */
export const SESSION_EVENT_CHANNEL = 'session/event'

export interface BoundaryObservation {
  readonly sessionId: string
  readonly memberId: string | undefined
  readonly kind: BoundaryKind
  readonly at: number
}

export interface DshBoundaryWatcherOptions {
  readonly ctx: DshEventContextFace
  /** 边界类型。默认 `step-end`（对应需求里的"调用结束后"）。 */
  readonly boundary?: BoundaryKind | undefined
  /**
   * 把上游 sessionId 映射成本项目的成员 id。
   * 默认恒等映射（成员 id 就是会话 id）。返回 undefined 表示这不是受管成员。
   */
  readonly resolveMemberId?: ((sessionId: string) => string | undefined) | undefined
  /** 观察到边界时调用。异常会被捕获，不会打断宿主事件分发。 */
  readonly onBoundary: (input: { readonly sessionId: string; readonly memberId: string; readonly kind: BoundaryKind }) => void
  readonly now?: (() => number) | undefined
}

export interface DshBoundaryWatcherHandle {
  /** 解绑。幂等。 */
  detach(): void
  /** 观察到的事件流（用于断言与诊断）。 */
  readonly observations: readonly BoundaryObservation[]
  /** 监听器里被捕获的异常（正常应为空）。 */
  readonly errors: readonly string[]
  /** 当前是否已成功订阅。`false` 说明宿主 ctx 不支持 `on`。 */
  readonly attached: boolean
}

export function attachDshBoundaryWatcher(options: DshBoundaryWatcherOptions): DshBoundaryWatcherHandle {
  const kind: BoundaryKind = options.boundary ?? 'step-end'
  const expectedType = BOUNDARY_EVENT[kind]
  const resolveMemberId = options.resolveMemberId ?? ((sessionId: string) => sessionId)
  const now = options.now ?? (() => Date.now())
  const observations: BoundaryObservation[] = []
  const errors: string[] = []
  let detachFn: (() => void) | undefined
  let attached = false

  if (typeof options.ctx.on !== 'function') {
    errors.push(
      `宿主 ctx 不支持 on()：无法订阅 ${SESSION_EVENT_CHANNEL}，` +
        '"等工作单元结束再入场"将退化为由宿主动手调用 onWorkUnitComplete()。',
    )
  } else {
    const listener = (...args: unknown[]): void => {
      try {
        const event = args[1]
        if (typeof event !== 'object' || event === null) return
        const type = (event as { type?: unknown }).type
        if (type !== expectedType) return

        const sessionId = readSessionId(args[0]) ?? readSessionId(event)
        if (sessionId === undefined) {
          errors.push(`收到了 ${expectedType} 事件，但无法从载荷里读出 sessionId。`)
          return
        }
        const memberId = resolveMemberId(sessionId)
        observations.push({ sessionId, memberId, kind, at: now() })
        if (memberId === undefined) return
        options.onBoundary({ sessionId, memberId, kind })
      } catch (error) {
        // 事件监听器抛错会污染宿主的事件分发；这里只记录。
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
    get observations(): readonly BoundaryObservation[] {
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

/** 从会话对象或事件载荷里读出会话 id。上游可能把它叫 `id` 或 `sessionId`。 */
export function readSessionId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['id', 'sessionId', 'session']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
    // branded id 通常是 string；但有些实现用 { toString() } 包装。
    if (typeof candidate === 'object' && candidate !== null && typeof (candidate as { toString?: unknown }).toString === 'function') {
      const text = String(candidate)
      if (text.length > 0 && text !== '[object Object]') return text
    }
  }
  return undefined
}
