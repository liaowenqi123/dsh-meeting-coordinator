/**
 * DSH 模型调用通道 + 等边界入场接线的测试。
 *
 * 这两个适配器是"让会议室真正跑起来"的最后一块，因此断言要特别严：
 *
 * 1. **绝不能把失败当沉默**。上游 `SubagentRun.result` 在子级失败时**不 reject**，
 *    而是带 `stopReason: 'error'` 解析。如果忽略它，一场因为模型全挂而沉默的会议
 *    看上去会像"大家都没意见"——这是最危险的静默失败，必须抛错。
 * 2. **模型必须透传**。需求要求"每个参会就使用那个会话的对应模型"，
 *    所以要断言 `agentOptions.model` 真的带上了。
 * 3. **run 必须被 dispose**，否则子运行的工作与资源不会被取消和释放。
 * 4. **边界监听器永不抛错**，否则会污染宿主的事件分发。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachDshBoundaryWatcher,
  BOUNDARY_EVENT,
  SESSION_EVENT_CHANNEL,
  readSessionId,
} from '../src/adapters/dsh-boundary-watcher.js'
import {
  createDshMeetingVoice,
  createDshModerator,
  createDshOneShotRunner,
  extractOutput,
  type DshSubagentRunFace,
} from '../src/adapters/dsh-meeting-voice.js'
import { RoundRobinModerator } from '../src/adapters/moderators.js'
import { ScriptedMeetingVoice } from '../src/adapters/scripted-voice.js'
import { apply } from '../src/host.js'
import { VoiceUnavailable } from '../src/index.js'
import type { AgentSlotSpec } from '../src/index.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-voice-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 假上游
// ---------------------------------------------------------------------------

interface StartCall {
  readonly provider: string
  readonly request: Record<string, unknown>
}

function makeSubagentsService(
  handler: (call: StartCall) => { text?: string; stopReason?: string; diagnostic?: string; output?: readonly { type: string; text?: string }[] },
): { face: unknown; calls: StartCall[]; disposed: number } {
  const calls: StartCall[] = []
  const state = { disposed: 0 }
  const face = {
    list: () => ['spawn'],
    getProvider: () => ({ name: 'spawn' }),
    start: (provider: string, request: Record<string, unknown>): Promise<DshSubagentRunFace> => {
      calls.push({ provider, request })
      const outcome = handler({ provider, request })
      const run: DshSubagentRunFace = {
        id: `child-${calls.length}`,
        result: Promise.resolve({
          output: outcome.output ?? [{ type: 'text', text: outcome.text ?? '' }],
          stopReason: outcome.stopReason ?? 'completed',
          diagnostic: outcome.diagnostic,
        }),
        dispose: () => {
          state.disposed += 1
        },
      }
      return Promise.resolve(run)
    },
    // 真实的 `ctx.subagents`（`dsh-subagent` 的 SubagentRuntime）**还有**这两个方法。
    // 新版后端显式选 subagents，能力门因此要求它们在场：
    // 替身少了它们，`apply()` 会误判"模型通道不可用"。
    // 这和上次"假 `agents` 服务形状写错"是同一类问题——替身必须照真实形状写。
    sendMessage: () => Promise.resolve({ messageId: 'm', status: 'queued' }),
    interrupt: () => ({ previousStatus: 'idle' }),
  }
  return {
    face,
    calls,
    get disposed() {
      return state.disposed
    },
  }
}

/** 一个极窄的假 Cordis context：get / on / effect。 */
function makeCtx(services: Record<string, unknown>) {
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const registered: string[] = []
  return {
    listeners,
    registered,
    get(name: string): unknown {
      if (!(name in services)) throw new Error(`${name} is not mounted`)
      return services[name]
    },
    on(event: string, listener: (...args: unknown[]) => unknown): unknown {
      registered.push(event)
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener))
      }
    },
    effect(callback: () => unknown): unknown {
      return callback()
    },
    emit(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

/**
 * 假 `ctx.agents`（真实形状是 `AgentRegistry extends Service`）。
 *
 * ⚠️ 必须长得像真的，不能写成 `{ get: () => ({...}) }` 就完事：
 * 上游要求 **exact live Agent**（`ctx.agents.get(agent.id) === agent`），
 * 而 Agent 的来源是 `roots()` / `list()` / `currentInitiator()`。
 * 把**服务对象本身**当成 Agent 传下去会得到
 * `agent "undefined" is not a member of an active Agent Team`
 * —— 这是真机 boot 踩过的坑，测试形状必须能覆盖它。
 *
 * `roots` 传空数组即可模拟"dsh 刚启动、用户还没开会话"。
 */
function makeAgentsService(roots: readonly unknown[] = [{ id: 'lead-agent' }]) {
  const store = new Map(roots.map((agent) => [String((agent as { id: unknown }).id), agent]))
  return {
    /** 非 Agent 驱动的路径（插件加载、定时器）下确为 undefined。 */
    currentInitiator: () => undefined,
    roots: () => [...store.values()],
    list: () => [...store.values()],
    get: (id: unknown) => store.get(String(id)),
  }
}

function makeAgentTeamsService(): unknown {
  return {
    spawnTeammate: (_caller: unknown, request: Record<string, unknown>) =>
      Promise.resolve({ member: { name: String(request['name']) } }),
    sendMessage: () => Promise.resolve({ messageId: 'm', status: 'queued' }),
    interrupt: () => ({ previousStatus: 'idle' }),
    createTask: () => Promise.resolve({ id: 't' }),
    waitForChange: () => Promise.resolve({ type: 'member-status' }),
  }
}

/**
 * `apply()` + **显式开会籍**。
 *
 * 默认会籍是空的（房间不自动建、人不自动进），需要"房间里有人"的用例
 * 必须自己把这一步做出来。
 */
async function applied(ctx: Parameters<typeof apply>[0], config: Parameters<typeof apply>[1]) {
  const host = (await apply(ctx, config)).host
  const roomId = host.defaultRoomId
  if (host.rooms.room(roomId) === undefined) host.console.createRoom({ id: roomId, name: roomId })
  for (const sessionId of host.orchestrator.participantIds) {
    if (host.rooms.isMember(sessionId)) continue
    host.rooms.join({ sessionId, roomId, workspace: 'default' })
    host.orchestrator.joinRoom(sessionId, roomId)
  }
  return host
}

// ===========================================================================

describe('extractOutput：绝不能把失败当沉默', () => {
  it('拼接文本块', () => {
    expect(extractOutput({ output: [{ type: 'text', text: '你' }, { type: 'text', text: '好' }], stopReason: 'completed' })).toBe('你好')
  })

  it('stopReason 非 completed 时抛错（而不是当成"这位成员没话说"）', () => {
    expect(() =>
      extractOutput({ output: [{ type: 'text', text: '部分输出' }], stopReason: 'error', diagnostic: 'upstream 503' }),
    ).toThrow(/未正常完成/)
    try {
      extractOutput({ output: [], stopReason: 'max-tokens' })
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceUnavailable)
      expect((error as VoiceUnavailable).message).toContain('max-tokens')
    }
  })

  it('空输出抛错（沉默 ≠ 同意）', () => {
    expect(() => extractOutput({ output: [], stopReason: 'completed' })).toThrow(/空文本/)
    expect(() => extractOutput({ output: [{ type: 'text', text: '   ' }], stopReason: 'completed' })).toThrow(/空文本/)
  })

  it('只有非文本块时抛错（不要图片/工具结果当发言）', () => {
    expect(() => extractOutput({ output: [{ type: 'tool-result' }], stopReason: 'completed' })).toThrow(/空文本/)
  })
})

describe('createDshOneShotRunner：调用映射与资源释放', () => {
  it('把 prompt / parent / model 正确映射到上游，并且总是 dispose', async () => {
    const service = makeSubagentsService(() => ({ text: '模型输出' }))
    const runner = createDshOneShotRunner({
      ctx: makeCtx({ subagents: service.face, agents: makeAgentsService() }),
      resolveCaller: () => ({ id: 'lead-agent' }),
    })

    const text = await runner.run({ label: 'speech:a', prompt: '请发言', model: 'deepseek-v4-pro' })
    expect(text).toBe('模型输出')

    expect(service.calls).toHaveLength(1)
    const call = service.calls[0]
    expect(call?.provider).toBe('spawn')
    expect(call?.request['parent']).toEqual({ id: 'lead-agent' })
    expect(call?.request['label']).toBe('speech:a')
    expect(call?.request['prompt']).toEqual([{ type: 'text', text: '请发言' }])
    // 关键：按会话指定模型
    expect(call?.request['agentOptions']).toEqual({ model: 'deepseek-v4-pro' })
    expect(call?.request['signal']).toBeInstanceOf(AbortSignal)
    // 资源释放
    expect(service.disposed).toBe(1)
  })

  it('不给 model 时不带 agentOptions（让宿主用默认模型）', async () => {
    const service = makeSubagentsService(() => ({ text: 'x' }))
    const runner = createDshOneShotRunner({
      ctx: makeCtx({ subagents: service.face, agents: makeAgentsService() }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    await runner.run({ label: 'moderator', prompt: 'p' })
    expect(service.calls[0]?.request['agentOptions']).toBeUndefined()
  })

  it('上游失败时 dispose 仍然被调用（不然会泄漏子运行）', async () => {
    const service = makeSubagentsService(() => ({ text: '', stopReason: 'error' }))
    const runner = createDshOneShotRunner({
      ctx: makeCtx({ subagents: service.face, agents: makeAgentsService() }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    await expect(runner.run({ label: 'speech:a', prompt: 'p' })).rejects.toThrow(/未正常完成/)
    expect(service.disposed).toBe(1)
  })

  it('ctx.subagents 不可用时明确报告降级', () => {
    const runner = createDshOneShotRunner({ ctx: makeCtx({}), resolveCaller: () => ({ id: 'lead' }) })
    const probe = runner.capabilities()
    expect(probe.available).toBe(false)
    expect(probe.notes.join(' ')).toMatch(/subagents/)
  })

  it('provider 未注册时给出提示但不算致命', () => {
    const runner = createDshOneShotRunner({
      ctx: makeCtx({ subagents: { start: () => Promise.resolve({ result: Promise.resolve({ output: [] }) }), list: () => ['fork'] } }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    const probe = runner.capabilities()
    expect(probe.available).toBe(false)
    expect(probe.notes.join(' ')).toMatch(/fork/)
  })

  it('无法解析 parent 时明确失败（上游要求 exact live Agent）', async () => {
    const service = makeSubagentsService(() => ({ text: 'x' }))
    const runner = createDshOneShotRunner({
      ctx: makeCtx({ subagents: service.face }),
      resolveCaller: () => undefined,
    })
    await expect(runner.run({ label: 'x', prompt: 'p' })).rejects.toThrow(/无法解析当前活的 Agent/)
  })

  it('调用超时抛错，不静默返回空', async () => {
    const hanging = {
      list: () => ['spawn'],
      start: () =>
        Promise.resolve({
          result: new Promise<never>(() => {
            /* 永不 settle */
          }),
          dispose: () => undefined,
        }),
    }
    const runner = createDshOneShotRunner({
      ctx: makeCtx({ subagents: hanging, agents: makeAgentsService() }),
      resolveCaller: () => ({ id: 'lead' }),
      callTimeoutMs: 20,
    })
    await expect(runner.run({ label: 'hang', prompt: 'p' })).rejects.toThrow(/超时|失败/)
  })
})

describe('DSH 支撑的 voice / moderator', () => {
  it('voice.speak 把该会话的 model 透传下去', async () => {
    const service = makeSubagentsService(() => ({ text: '发言内容' }))
    const runner = createDshOneShotRunner({
      ctx: makeCtx({ subagents: service.face, agents: makeAgentsService() }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    const voice = createDshMeetingVoice(runner)
    const text = await voice.speak({
      participant: 'live-trading',
      purpose: 'speak',
      prompt: '请发言',
      maxChars: 800,
      model: 'deepseek-v4.1-flash',
    })
    expect(text).toBe('发言内容')
    expect(service.calls[0]?.request['label']).toBe('speech:live-trading')
    expect(service.calls[0]?.request['agentOptions']).toEqual({ model: 'deepseek-v4.1-flash' })
  })

  it('moderator 的 prompt 声明"没有与会者的私有上下文"，并用召集者的模型', async () => {
    const service = makeSubagentsService(() => ({ text: '{"action":"adjourn","reason":"已收敛"}' }))
    const runner = createDshOneShotRunner({
      ctx: makeCtx({ subagents: service.face, agents: makeAgentsService() }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    const moderator = createDshModerator(runner)
    const decision = await moderator.decide({
      roomName: 'r1',
      reason: '同步',
      members: ['a', 'b'],
      present: ['a', 'b'],
      absent: [],
      round: 2,
      maxRounds: 6,
      transcript: '[R1] a: 我的私有进度',
      spokeThisRound: ['a'],
      spokeCounts: { a: 1, b: 0 },
      model: 'deepseek-v4-pro',
    })
    expect(decision).toEqual({ action: 'adjourn', reason: '已收敛' })

    const prompt = service.calls[0]?.request['prompt'] as { text: string }[]
    expect(prompt[0]?.text).toContain('没有任何与会者的私有上下文')
    expect(prompt[0]?.text).toContain('只输出一个 JSON')
    expect(service.calls[0]?.request['agentOptions']).toEqual({ model: 'deepseek-v4-pro' })
    expect(service.calls[0]?.request['label']).toBe('moderator')
  })

  it('moderator 输出跑偏时回退到安全轮转，而不是卡住会议', async () => {
    const service = makeSubagentsService(() => ({ text: '我觉得大家说得都很好' }))
    const runner = createDshOneShotRunner({
      ctx: makeCtx({ subagents: service.face, agents: makeAgentsService() }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    const moderator = createDshModerator(runner)
    const decision = await moderator.decide({
      roomName: 'r1',
      reason: '同步',
      members: ['a', 'b'],
      present: ['a', 'b'],
      absent: [],
      round: 1,
      maxRounds: 6,
      transcript: '',
      spokeThisRound: ['a'],
      spokeCounts: { a: 1, b: 0 },
    })
    expect(decision).toEqual({ action: 'invite', next: 'b', note: '主持人输出无法解析，按轮转回退。' })
  })
})

describe('等边界入场：接上游 session/event', () => {
  it('订阅 session/event，只在配置的边界上触发，并把 sessionId 映射成成员', () => {
    const ctx = makeCtx({})
    const seen: { sessionId: string; memberId: string; kind: string }[] = []
    const watcher = attachDshBoundaryWatcher({
      ctx,
      boundary: 'step-end',
      onBoundary: (input) => seen.push(input),
    })

    expect(watcher.attached).toBe(true)
    expect(ctx.registered).toContain(SESSION_EVENT_CHANNEL)

    // 非边界事件：忽略
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 's1' }, { type: 'tool/call' })
    expect(seen).toHaveLength(0)

    // 目标边界：触发
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 's1' }, { type: BOUNDARY_EVENT['step-end'] })
    expect(seen).toEqual([{ sessionId: 's1', memberId: 's1', kind: 'step-end' }])

    // turn-end 边界不受 step-end 配置影响
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 's1' }, { type: BOUNDARY_EVENT['turn-end'] })
    expect(seen).toHaveLength(1)

    expect(watcher.observations).toHaveLength(1)
    expect(watcher.errors).toEqual([])
  })

  it('turn-end 配置生效，且支持自定义成员映射', () => {
    const ctx = makeCtx({})
    const seen: string[] = []
    attachDshBoundaryWatcher({
      ctx,
      boundary: 'turn-end',
      resolveMemberId: (sessionId) => (sessionId === 'sess-42' ? 'neural-net' : undefined),
      onBoundary: (input) => seen.push(input.memberId),
    })
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-42' }, { type: 'turn/end' })
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-unknown' }, { type: 'turn/end' })
    expect(seen).toEqual(['neural-net'])
  })

  it('监听器里的异常被捕获，不会污染宿主事件分发', () => {
    const ctx = makeCtx({})
    const watcher = attachDshBoundaryWatcher({
      ctx,
      onBoundary: () => {
        throw new Error('成员映射炸了')
      },
    })
    expect(() => ctx.emit(SESSION_EVENT_CHANNEL, { id: 's1' }, { type: 'step/end' })).not.toThrow()
    expect(watcher.errors).toEqual(['成员映射炸了'])
  })

  it('ctx 不支持 on 时报告降级而不是抛错', () => {
    const watcher = attachDshBoundaryWatcher({ ctx: {}, onBoundary: () => undefined })
    expect(watcher.attached).toBe(false)
    expect(watcher.errors.join(' ')).toMatch(/退化为由宿主动手调用/)
  })

  it('detach 幂等，且解绑后不再触发', () => {
    const ctx = makeCtx({})
    let count = 0
    const watcher = attachDshBoundaryWatcher({ ctx, onBoundary: () => (count += 1) })
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 's' }, { type: 'step/end' })
    watcher.detach()
    watcher.detach()
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 's' }, { type: 'step/end' })
    expect(count).toBe(1)
  })

  it('readSessionId 兼容 id / sessionId 两种字段名', () => {
    expect(readSessionId('raw')).toBe('raw')
    expect(readSessionId({ id: 'a' })).toBe('a')
    expect(readSessionId({ sessionId: 'b' })).toBe('b')
    expect(readSessionId({})).toBeUndefined()
    expect(readSessionId(null)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 端到端：真实 apply() 装配（假 ctx，但走全部真实代码路径）
// ---------------------------------------------------------------------------

describe('端到端：apply() 用 DSH 通道跑完一场真实会议', () => {
  const SLOTS: readonly AgentSlotSpec[] = [
    { id: 'neural-net', workspace: 'quant-lab', model: 'deepseek-v4-pro', domain: 'neural-net', title: '神经网络专家', systemPrompt: '只做网络结构。' },
    { id: 'live-trading', workspace: 'quant-live', model: 'deepseek-v4.1-flash', domain: 'live-trading', title: '实盘专家', systemPrompt: '只做滑点与仓位。' },
  ]

  function makeHostCtx() {
    // 模型输出按 label 分派：成员发言 / 纪要 / 主持人
    const service = makeSubagentsService(({ request }) => {
      const label = String(request['label'] ?? '')
      if (label === 'moderator') return { text: '{"action":"adjourn","reason":"讨论已收敛"}' }
      if (label.startsWith('minutes:')) {
        const who = label.slice('minutes:'.length)
        return { text: `待办：${who} 需在 60 日窗口下重跑验证（45 字以内）。` }
      }
      if (label.startsWith('speech:')) {
        const who = label.slice('speech:'.length)
        return { text: `${who} 的进度：已完成本轮实验；障碍：需要对方确认成本口径；需要：一次对齐。` }
      }
      return { text: 'ok' }
    })
    const ctx = makeCtx({
      agents: makeAgentsService(),
      agentTeams: makeAgentTeamsService(),
      subagents: service.face,
    })
    return { ctx, service }
  }

  it('apply → 激活 → 开会 → 每人用自己模型 → 各自纪要 → 散会后各自还原', async () => {
    const { ctx, service } = makeHostCtx()
    const host = await applied(ctx, {
      slots: SLOTS,
      rootDir: root,
      boardDomain: 'quant-sync',
    })

    // 会籍已建立：两个 slot 都在同一个会议室里
    expect(host.defaultRoomId).toBe('quant-sync')
    expect(host.rooms.room(host.defaultRoomId)?.members.map((m) => m.sessionId)).toEqual(['live-trading', 'neural-net'])

    // 让两位成员处于可立即入场状态
    host.orchestrator.member('neural-net').beginIdleWaiting()
    host.orchestrator.member('live-trading').beginIdleWaiting()

    const record = await host.orchestrator.convene({
      roomId: host.defaultRoomId,
      calledBy: 'neural-net',
      scope: 'global',
      reason: '成本口径对齐',
    })

    // 真实发言人 = 两位成员
    expect([...record.summoned].sort()).toEqual(['live-trading', 'neural-net'])
    const speeches = record.room.transcript.filter((t) => t.kind === 'speech')
    expect(speeches.length).toBe(2)

    // 每个成员用自己会话的模型
    const speechModels = service.calls
      .filter((call) => String(call.request['label']).startsWith('speech:'))
      .map((call) => (call.request['agentOptions'] as { model?: string } | undefined)?.model)
    expect(new Set(speechModels)).toEqual(new Set(['deepseek-v4-pro', 'deepseek-v4.1-flash']))

    // 主持人用召集者（neural-net）的模型，且 prompt 里没有别人的私有记忆
    const moderatorCall = service.calls.find((call) => call.request['label'] === 'moderator')
    expect((moderatorCall?.request['agentOptions'] as { model?: string } | undefined)?.model).toBe('deepseek-v4-pro')
    const moderatorPrompt = (moderatorCall?.request['prompt'] as { text: string }[])[0]?.text ?? ''
    expect(moderatorPrompt).toContain('没有任何与会者的私有上下文')
    expect(moderatorPrompt).not.toContain('只做网络结构。')

    // 每人各自一份纪要，内容不同
    expect(record.notes).toHaveLength(2)
    expect(new Set(record.notes.map((n) => n.text)).size).toBe(2)
    expect(record.adjournedReason).toBe('讨论已收敛')

    // 散会：还原到召集前的空闲状态（两位成员入场前都是 `idle-waiting`）。
    // 必须还原成**空闲**而不是 working——working 会让下一次召集被拒。
    expect(host.orchestrator.states()).toEqual({ 'live-trading': 'idle-waiting', 'neural-net': 'idle-waiting' })

    // 资源释放：每次模型调用都 dispose
    expect(service.disposed).toBe(service.calls.length)

    await host.shutdown()
    // 关闭后不得留下任何"会中/待入场"的残留状态（否则就是僵尸）。
    expect(host.orchestrator.states()).toEqual({ 'live-trading': 'idle-waiting', 'neural-net': 'idle-waiting' })
  })

  it('working 的成员被召集后不进会场；上游 step/end 到达时才入场', async () => {
    const { ctx } = makeHostCtx()
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'boundary-test' })

    host.orchestrator.member('neural-net').beginIdleWaiting()
    // live-trading 保持 working（模拟正在调用工具）

    let admitted = false
    const record = await host.orchestrator.convene({
      roomId: host.defaultRoomId,
      calledBy: 'neural-net',
      scope: 'global',
      reason: '等边界',
      hooks: {
        onOpened: (room) => {
          expect(room.hasPresent('live-trading')).toBe(false)
          expect(room.absent).toContain('live-trading')
          // 上游发出 step/end → watcher → onWorkUnitComplete → 入场
          ctx.emit(SESSION_EVENT_CHANNEL, { id: 'live-trading' }, { type: 'step/end' })
          admitted = host.orchestrator.activeRoom()?.hasPresent('live-trading') ?? false
        },
      },
    })

    expect(record.deferred).toContain('live-trading')
    expect(admitted).toBe(true)
    expect(record.admittedLate).toContain('live-trading')
    expect(record.room.transcript.some((t) => t.kind === 'speech' && t.speaker === 'live-trading')).toBe(true)

    await host.shutdown()
  })

  it('模型通道不可用时**仍然加载**（不把 dsh 带下线），但把原因记进诊断', async () => {
    // 上一版这里断言 `apply()` 抛错。代价在真实 boot 上暴露了：
    //
    //   dsh: plugin tree failed to load: ... DSH 模型调用通道不可用
    //   诊断：ctx.subagents 未注册 provider "spawn"（当前：(无)）
    //
    // 根因是**拿加载期的探测去判定调用期的事实**——插件加载的那一刻上游
    // provider 还没注册完。而新模型下 boot 期根本不需要模型通道
    // （默认没有房间、没有成员、没有节律），所以判据应该落到真正开会的时刻：
    // `convene()` 如实报错，**不假装开成了会**；加载期只记录缺陷。
    const ctx = makeCtx({ agents: makeAgentsService(), agentTeams: makeAgentTeamsService() })
    const activation = await apply(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'no-voice' })

    expect(activation.notes.join(' ')).toMatch(/模型调用通道不可用/)
    await activation()
  })
})

// 保证未使用的导入被显式消费（保持 lint/类型整洁）
void RoundRobinModerator
void ScriptedMeetingVoice
void vi
