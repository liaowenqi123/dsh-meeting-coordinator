/**
 * 「借上下文」接线：成员发言必须带上**它自己真实会话的最近上下文**。
 *
 * ## 这组测试要堵的洞
 *
 * `readSessionContext()`（`adapters/dsh-session-catalog.ts`）早就写好了，
 * 但接线前 **src 里零调用点**——成员发言走的是一次性外部调用（B 路线），
 * prompt 里只有议题与群聊记录，"它现在大概在做什么"完全没带进去。
 * 用户看到的症状就是"上下文没继承"：会上人人都在就事论事，
 * 却没人知道同伴手里的活进展到哪。
 *
 * ## 接线形状（依赖注入，core 不 import adapters）
 *
 * ```
 *   host.apply() ──contextOf──▶ MeetingOrchestrator.projectionFor()
 *                                    │
 *                                    ├─▶ 入场引导（entry turn，落盘可审计）
 *                                    └─▶ 每次发言的 prompt（现读，不是快照）
 * ```
 *
 * 两层测试：
 * 1. **编排器层**：`contextOf` 钩子的契约（现读、容错、进退场两侧都带）；
 * 2. **宿主层**：`apply()` 真的把它接到了 `readSessionContext()`
 *    （假 `ctx.sessions` 的 `deriveMessages()` 文本必须出现在模型收到的
 *    prompt 里，且**只出现在它自己的 prompt 里**——隔离是硬约束）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoundRobinModerator } from '../src/adapters/moderators.js'
import { ScriptedMeetingVoice } from '../src/adapters/scripted-voice.js'
import { readSessionContext } from '../src/adapters/dsh-session-catalog.js'
import { HUMAN_PARTICIPANT } from '../src/core/participant.js'
import { MeetingOrchestrator } from '../src/core/room-orchestrator.js'
import { RoomRegistry } from '../src/core/room-registry.js'
import { DEFAULT_ROOM_POLICY } from '../src/core/meeting-room.js'
import { apply } from '../src/host.js'

let root: string
const now = (): number => 1790000000000

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-context-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ===========================================================================
// 第三层：readSessionContext 本体——借的是"它在做什么"，不是宿主样板
// ===========================================================================

describe('readSessionContext：system 样板不挤占预算（端到端实测踩过）', () => {
  /** 假 ctx.sessions：`deriveMessages()` 按真实形状把 system 放在第一条。 */
  function makeCtx(messages: readonly unknown[]): unknown {
    return {
      get: (name: string) =>
        name === 'sessions'
          ? {
              get: (id: unknown) =>
                id === 'sess-x'
                  ? {
                      deriveMessages: () => messages,
                    }
                  : undefined,
            }
          : undefined,
    }
  }

  it('几千字的 system 提示词不会把真实对话挤出投影', () => {
    const text = readSessionContext({
      ctx: makeCtx([
        { role: 'system', content: `You are an AI agent powered by DeepSeek Harness.${' 样板'.repeat(2000)}` },
        { role: 'user', content: 'E2E 探针：我在核对 60 日窗口的重训频率，卡在滑点口径' },
        { role: 'assistant', content: 'ABC 1' },
      ]) as never,
      sessionId: 'sess-x',
      maxChars: 800,
    })
    expect(text).toBeDefined()
    // 真实对话在（这才是"它正在做什么"）
    expect(text).toContain('E2E 探针')
    expect(text).toContain('ABC 1')
    // 样板不在（它每个会话都一样，零信息量）
    expect(text).not.toContain('You are an AI agent')
  })

  it('只有 system 消息（还没说过话的空会话）→ undefined，不投影一段废话', () => {
    const text = readSessionContext({
      ctx: makeCtx([{ role: 'system', content: 'You are an AI agent…' }]) as never,
      sessionId: 'sess-x',
      maxChars: 800,
    })
    expect(text).toBeUndefined()
  })

  it('会话不在进程里（get 返回 undefined）→ undefined，不伪造', () => {
    const text = readSessionContext({ ctx: makeCtx([]) as never, sessionId: 'sess-不在', maxChars: 800 })
    expect(text).toBeUndefined()
  })

  it('deriveMessages 抛错 → undefined（借不到是正常分支，不能炸掉一场会）', () => {
    const ctx = {
      get: (name: string) =>
        name === 'sessions'
          ? {
              get: () => ({
                deriveMessages: () => {
                  throw new Error('会话已销毁')
                },
              }),
            }
          : undefined,
    }
    const text = readSessionContext({ ctx: ctx as never, sessionId: 'sess-x', maxChars: 800 })
    expect(text).toBeUndefined()
  })

  it('超预算时截断并标注（预算口径与 memoryProjectionChars 一致）', () => {
    const text = readSessionContext({
      ctx: makeCtx([
        { role: 'user', content: '甲'.repeat(500) },
        { role: 'assistant', content: '乙'.repeat(500) },
      ]) as never,
      sessionId: 'sess-x',
      maxChars: 100,
    })
    expect(text).toBeDefined()
    // 截断到预算附近（后缀"…（已截断）"会略超几个字，这是既定行为）
    expect(text!.length).toBeLessThan(120)
    expect(text!.length).toBeLessThan(1000)
    expect(text).toContain('更早的上下文已省略')
  })
})

// ===========================================================================
// 第一层：编排器的 contextOf 契约
// ===========================================================================

const SPECS = [
  { id: 'sess-alpha', domain: 'quant-lab', title: 'Alpha', systemPrompt: '', workspace: 'lab' },
  { id: 'sess-beta', domain: 'quant-live', title: 'Beta', systemPrompt: '', workspace: 'live' },
] as const

interface BorrowCall {
  readonly sessionId: string
  readonly maxChars: number
}

/**
 * 建一个登记齐全、全员入会且空闲的编排器。
 *
 * `borrowed` 给了才接 `contextOf`——不给就是"旧行为"（没有私有上下文），
 * 用来对照证明投影段真的来自这条新线。
 */
function setupOrchestrator(options?: {
  readonly borrowed?: (sessionId: string, maxChars: number) => string | undefined
}): {
  readonly orchestrator: MeetingOrchestrator
  readonly voice: ScriptedMeetingVoice
  readonly borrowCalls: BorrowCall[]
} {
  const registry = new RoomRegistry({ rootDir: root, now })
  const voice = new ScriptedMeetingVoice({
    scripts: {
      'sess-alpha': { speeches: ['Alpha：口径已定。', 'Alpha：补充边界条件。'] },
      'sess-beta': { speeches: ['Beta：数据已对齐。', 'Beta：补充抽样口径。'] },
    },
    minutesMaxChars: 300,
  })
  // minRounds=3：保证首轮之后还有第二轮，才能断言"每轮现读"。
  const moderator = new RoundRobinModerator({ minSpeechesPerMember: 1, minRounds: 3 })
  const borrowCalls: BorrowCall[] = []
  const orchestrator = new MeetingOrchestrator({
    registry,
    voice,
    moderator,
    now,
    ...(options?.borrowed === undefined
      ? {}
      : {
          contextOf: (sessionId: string, maxChars: number) => {
            borrowCalls.push({ sessionId, maxChars })
            return options.borrowed?.(sessionId, maxChars)
          },
        }),
  })
  for (const spec of SPECS) orchestrator.enroll(spec)
  registry.createRoom({ id: 'ctx-room', name: '借上下文' })
  for (const spec of SPECS) orchestrator.joinRoom(spec.id, 'ctx-room')
  for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()
  return { orchestrator, voice, borrowCalls }
}

const REASON = '对齐 60 日窗口的重训频率'

describe('编排器：发言 prompt 带上借来的会话上下文', () => {
  it('投影段出现在模型收到的发言 prompt 里，且带预算上限', async () => {
    const { orchestrator, voice, borrowCalls } = setupOrchestrator({
      borrowed: (sessionId) => `[user] ${sessionId} 正在核对 60 日窗口的重训频率，卡在滑点口径`,
    })

    const record = await orchestrator.convene({
      roomId: 'ctx-room',
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: REASON,
    })
    expect(record.notes).toHaveLength(2)

    const speech = voice.calls.find((call) => call.purpose === 'speak' && call.participant === 'sess-alpha')
    expect(speech).toBeDefined()
    expect(speech!.prompt).toContain('你的私有记忆投影')
    expect(speech!.prompt).toContain('sess-alpha 正在核对 60 日窗口的重训频率')
    // 定位与群聊记录仍然在（投影是新增段，不是替换）
    expect(speech!.prompt).toContain('【轮到你发言】')
    expect(speech!.prompt).toContain('会议室记录：')
    // 借上下文有显式预算，且与会议策略同一个口径
    expect(borrowCalls.length).toBeGreaterThan(0)
    expect(borrowCalls[0]?.maxChars).toBe(DEFAULT_ROOM_POLICY.memoryProjectionChars)
  })

  it('每轮发言**现读**一次：不拿入会时的快照', async () => {
    let reads = 0
    const { orchestrator, voice, borrowCalls } = setupOrchestrator({
      borrowed: () => {
        reads += 1
        return `第 ${reads} 次现读：当前卡在抽样口径上`
      },
    })

    await orchestrator.convene({
      roomId: 'ctx-room',
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: REASON,
    })

    const readNumberOf = (prompt: string): number => {
      const hit = /第 (\d+) 次现读/.exec(prompt)
      expect(hit, `prompt 里应带现读编号：${prompt.slice(0, 120)}`).not.toBeNull()
      return Number(hit?.[1])
    }

    const alphaSpeeches = voice.calls.filter((call) => call.purpose === 'speak' && call.participant === 'sess-alpha')
    // minRounds=3 保证 Alpha 至少发言两次
    expect(alphaSpeeches.length).toBeGreaterThanOrEqual(2)
    // 每一次发言的读取编号都不同且递增：证明是现读，不是入会时的快照
    // （开场投影也会各读一次，所以编号不从 1 开始——那没关系，递增才是判据）
    const numbers = alphaSpeeches.map((call) => readNumberOf(call.prompt))
    for (let index = 1; index < numbers.length; index += 1) {
      expect(numbers[index]).toBeGreaterThan(numbers[index - 1] as number)
    }
    // 现读次数覆盖每一次发言（开场投影 + 每轮发言都会读）
    expect(borrowCalls.length).toBeGreaterThanOrEqual(alphaSpeeches.length)
  })

  it('入场引导也带借来的上下文（它是"会上到底给了这位成员什么"的审计证据）', async () => {
    const { orchestrator } = setupOrchestrator({
      borrowed: () => '借来的上下文：正在重跑滑点估计，taker 成本吃掉 41% 夏普',
    })

    const record = await orchestrator.convene({
      roomId: 'ctx-room',
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: REASON,
    })

    const entry = record.room.transcript.find((turn) => turn.kind === 'entry' && turn.speaker === 'sess-beta')
    expect(entry).toBeDefined()
    expect(entry!.text).toContain('正在重跑滑点估计')
  })

  it('contextOf 抛错：会议照常开完，退回"没有私有上下文"', async () => {
    const { orchestrator, voice } = setupOrchestrator({
      borrowed: () => {
        throw new Error('上游会话已销毁，deriveMessages 读不出来')
      },
    })

    const record = await orchestrator.convene({
      roomId: 'ctx-room',
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: REASON,
    })
    // 会开成了：借上下文是增强，不是前提
    expect(record.notes).toHaveLength(2)

    const speech = voice.calls.find((call) => call.purpose === 'speak' && call.participant === 'sess-alpha')
    expect(speech!.prompt).not.toContain('开会前借来的')
    // 定位与群聊记录仍然在
    expect(speech!.prompt).toContain('【轮到你发言】')
  })

  it('没有 contextOf（旧行为）：prompt 里没有投影段，也不留空标题', async () => {
    const { orchestrator, voice } = setupOrchestrator()

    await orchestrator.convene({
      roomId: 'ctx-room',
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: REASON,
    })

    const speech = voice.calls.find((call) => call.purpose === 'speak' && call.participant === 'sess-alpha')
    expect(speech!.prompt).not.toContain('私有记忆投影')
    expect(speech!.prompt).toContain('会议室记录：')
  })
})

// ===========================================================================
// 第二层：宿主接线 —— apply() 把 contextOf 接到 readSessionContext()
// ===========================================================================

interface StartCall {
  readonly provider: string
  readonly request: Record<string, unknown>
}

/** 假 `ctx.subagents`：记下每次模型调用的 label 与 prompt（真实形状的同构替身）。 */
function makeSubagentsService(
  handler: (call: StartCall) => { text?: string; stopReason?: string },
): { face: unknown; calls: StartCall[] } {
  const calls: StartCall[] = []
  const face = {
    list: () => ['spawn'],
    getProvider: () => ({ name: 'spawn' }),
    start: (provider: string, request: Record<string, unknown>) => {
      calls.push({ provider, request })
      const outcome = handler({ provider, request })
      return Promise.resolve({
        id: `child-${calls.length}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: outcome.text ?? '' }],
          stopReason: outcome.stopReason ?? 'completed',
        }),
        dispose: () => undefined,
      })
    },
    sendMessage: () => Promise.resolve({ messageId: 'm', status: 'queued' }),
    interrupt: () => ({ previousStatus: 'idle' }),
  }
  return { face, calls }
}

function makeCtx(services: Record<string, unknown>): {
  readonly ctx: Parameters<typeof apply>[0]
  emit(event: string, ...args: unknown[]): void
} {
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>()
  return {
    ctx: {
      get(name: string): unknown {
        if (!(name in services)) throw new Error(`${name} is not mounted`)
        return services[name]
      },
      on(event: string, listener: (...args: unknown[]) => unknown): unknown {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return () => {
          listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener))
        }
      },
      effect(callback: () => unknown): unknown {
        return callback()
      },
    } as unknown as Parameters<typeof apply>[0],
    emit(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

function makeAgentsService(roots: readonly unknown[] = [{ id: 'lead-agent' }]): unknown {
  const store = new Map(roots.map((agent) => [String((agent as { id: unknown }).id), agent]))
  return {
    currentInitiator: () => undefined,
    roots: () => [...store.values()],
    list: () => [...store.values()],
    get: (id: unknown) => store.get(String(id)),
  }
}

/**
 * 假 `ctx.sessions`。
 *
 * `listed` 进 `list()`（候选可见、可入会）；`loaded` 进 `get()`
 * （已加载、借得到上下文）。两者刻意可以不同——真实宿主里
 * "侧栏有它" 与 "它在进程里活着" 本来就是两件事。
 */
function makeSessionsService(listed: readonly string[], loaded: readonly string[]): unknown {
  const messagesOf = (sessionId: string): readonly unknown[] => [
    { role: 'user', content: `会话 ${sessionId}：正在核对 60 日窗口的重训频率，需要确认滑点口径` },
    { role: 'assistant', content: 'ABC 1' },
  ]
  return {
    list: () =>
      listed.map((sessionId) => ({
        id: sessionId,
        header: {},
        model: 'deepseek-v4.1-flash',
        deriveMessages: () => messagesOf(sessionId),
      })),
    get: (id: unknown) => {
      const sessionId = String(id)
      if (!loaded.includes(sessionId)) return undefined
      return {
        id: sessionId,
        header: {},
        model: 'deepseek-v4.1-flash',
        deriveMessages: () => messagesOf(sessionId),
      }
    },
  }
}

function promptTextOf(call: StartCall): string {
  const blocks = call.request['prompt']
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('')
}

function labelOf(call: StartCall): string {
  return String(call.request['label'] ?? '')
}

/** 标准假上游：主持人一轮后散会，发言/纪要都有确定文本。 */
function makeHost(services: Record<string, unknown>): {
  ctx: Parameters<typeof apply>[0]
  emit: (event: string, ...args: unknown[]) => void
  calls: StartCall[]
} {
  const service = makeSubagentsService(({ request }) => {
    const label = String(request['label'] ?? '')
    if (label === 'moderator') return { text: '{"action":"adjourn","reason":"讨论已收敛"}' }
    if (label.startsWith('minutes:')) return { text: '待办：口径对齐后重跑验证。' }
    if (label.startsWith('speech:')) return { text: '进度：口径已明确；障碍：无。' }
    return { text: 'ok' }
  })
  const { ctx, emit } = makeCtx({
    agents: makeAgentsService(),
    subagents: service.face,
    ...services,
  })
  return { ctx, emit, calls: service.calls }
}

describe('宿主接线：apply() 之后，模型收到的发言 prompt 带着会话自己的上下文', () => {
  it('已加载会话：借来的上下文进入它自己的发言 prompt，且不串到别人身上', async () => {
    const { ctx, calls } = makeHost({ sessions: makeSessionsService(['sess-7f3a', 'sess-9c21'], ['sess-7f3a', 'sess-9c21']) })
    const host = (await apply(ctx, { rootDir: root, boardDomain: 'borrow' })).host
    const roomId = host.defaultRoomId
    host.console.createRoom({ id: roomId, name: roomId })

    expect(host.console.addSession(roomId, 'sess-7f3a').ok).toBe(true)
    expect(host.console.addSession(roomId, 'sess-9c21').ok).toBe(true)

    const result = await host.console.convene({
      roomId,
      calledBy: HUMAN_PARTICIPANT,
      reason: '对齐 60 日窗口的重训频率',
    })
    expect(result.ok).toBe(true)

    const speeches = calls.filter((call) => labelOf(call).startsWith('speech:'))
    expect(speeches.length).toBe(2)

    const alpha = speeches.find((call) => labelOf(call) === 'speech:sess-7f3a')
    const beta = speeches.find((call) => labelOf(call) === 'speech:sess-9c21')
    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()

    // 各自的上下文确实进了各自的 prompt
    expect(promptTextOf(alpha!)).toContain('私有记忆投影')
    expect(promptTextOf(alpha!)).toContain('会话 sess-7f3a：正在核对 60 日窗口的重训频率')
    expect(promptTextOf(beta!)).toContain('会话 sess-9c21：正在核对 60 日窗口的重训频率')
    // 隔离是硬约束：A 的 prompt 里不能出现 B 的私有上下文
    expect(promptTextOf(alpha!)).not.toContain('会话 sess-9c21')
    expect(promptTextOf(beta!)).not.toContain('会话 sess-7f3a')

    await host.shutdown()
  })

  it('会话没加载（list 有、get 没有）：借不到上下文，但会照常开成', async () => {
    const { ctx, calls } = makeHost({ sessions: makeSessionsService(['sess-cold'], []) })
    const host = (await apply(ctx, { rootDir: root, boardDomain: 'borrow-cold' })).host
    const roomId = host.defaultRoomId
    host.console.createRoom({ id: roomId, name: roomId })

    // 未加载也能入会（准入只看非活动，不看加载）
    expect(host.console.addSession(roomId, 'sess-cold').ok).toBe(true)

    const result = await host.console.convene({
      roomId,
      calledBy: HUMAN_PARTICIPANT,
      reason: '对齐 60 日窗口的重训频率',
    })
    expect(result.ok).toBe(true)

    const speech = calls.find((call) => labelOf(call) === 'speech:sess-cold')
    expect(speech).toBeDefined()
    // 借不到就老实说"没有"，不伪造一段上下文
    expect(promptTextOf(speech!)).not.toContain('私有记忆投影')
    expect(promptTextOf(speech!)).toContain('会议室记录：')

    await host.shutdown()
  })
})
