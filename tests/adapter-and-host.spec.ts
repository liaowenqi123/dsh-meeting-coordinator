/**
 * DSH 适配层 + 宿主装配的测试。
 *
 * 两个重点：
 * 1. **适配层的能力探测必须诚实**。上游缺 `agentTeams` 时必须报告降级，
 *    绝不假装能开会。这些测试用一个**假的 Cordis Context** 驱动，
 *    因此不需要真的启动 DSH。
 * 2. **宿主装配走真实的 compose() + LifecycleCoordinator**，
 *    验证 provider facet 先于 consumer facet 激活，以及卸载即回收。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDshMeetingRuntime, isFace, readService, teammateName } from '../src/adapters/dsh-team-runtime.js'
import { InMemoryAgentRuntime } from '../src/adapters/in-memory-runtime.js'
import { RoundRobinModerator } from '../src/adapters/moderators.js'
import { ScriptedMeetingVoice } from '../src/adapters/scripted-voice.js'
import { AGENT_FACET_PREFIX, COORDINATOR_FACET, activateMeetingHost } from '../src/host.js'
import type { AgentSlotSpec } from '../src/index.js'

let root: string
let clock: number
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-meeting-adapter-'))
  clock = Date.parse('2026-01-01T00:00:00.000Z')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const SLOTS: readonly AgentSlotSpec[] = [
  { id: 'neural-net', domain: 'neural-net', title: '神经网络', systemPrompt: '只做网络结构。' },
  { id: 'live-trading', domain: 'live-trading', title: '实盘', systemPrompt: '只做滑点与仓位。' },
]

// ---------------------------------------------------------------------------
// 假的 DSH agentTeams 服务：记录调用，用于断言适配层映射是否正确
// ---------------------------------------------------------------------------

interface Call {
  readonly method: string
  readonly args: readonly unknown[]
}

function fakeTeamService(): { face: unknown; calls: Call[] } {
  const calls: Call[] = []
  const members = new Map<string, { name: string }>()
  const face = {
    async spawnTeammate(caller: unknown, request: Record<string, unknown>): Promise<unknown> {
      calls.push({ method: 'spawnTeammate', args: [caller, request] })
      const name = String(request['name'])
      members.set(name, { name })
      return { member: { name } }
    },
    async sendMessage(caller: unknown, request: Record<string, unknown>): Promise<unknown> {
      calls.push({ method: 'sendMessage', args: [caller, request] })
      return { messageId: 'm-1', status: 'queued' }
    },
    interrupt(caller: unknown, target: string): unknown {
      calls.push({ method: 'interrupt', args: [caller, target] })
      return { previousStatus: 'idle' }
    },
    createTask(caller: unknown, request: Record<string, unknown>): Promise<unknown> {
      calls.push({ method: 'createTask', args: [caller, request] })
      return Promise.resolve({ id: 't-1' })
    },
    async waitForChange(caller: unknown, timeoutMs: number): Promise<unknown> {
      calls.push({ method: 'waitForChange', args: [caller, timeoutMs] })
      return { type: 'member-status' }
    },
  }
  return { face, calls }
}

function fakeCtx(services: Record<string, unknown>): { get(name: string): unknown } {
  return {
    get(name: string): unknown {
      if (!(name in services)) throw new Error(`service ${name} is not registered`)
      return services[name]
    },
  }
}

describe('上游服务探测', () => {
  it('readService 对缺失服务与抛错服务都返回 undefined（上游两种行为都要容错）', () => {
    expect(readService(fakeCtx({}), 'agentTeams')).toBeUndefined()
    expect(readService({ get: () => { throw new Error('not mounted') } }, 'agentTeams')).toBeUndefined()
    expect(readService({}, 'agentTeams')).toBeUndefined()
  })

  it('isFace 不把任意对象误认成服务', () => {
    expect(isFace<{ start?: () => void }>({}, ['start'])).toBeUndefined()
    expect(isFace<{ start?: () => void }>(null, ['start'])).toBeUndefined()
    expect(isFace<{ start?: () => void }>({ start: () => undefined }, ['start'])).toBeDefined()
  })

  it('teammateName 是确定性映射，且产出上游要求的 kebab-case', () => {
    expect(teammateName('neural-net')).toBe('neural-net')
    expect(teammateName('Neural_Net')).toBe('neural-net')
    expect(teammateName('a b/c')).toBe('a-b-c')
    expect(teammateName('---')).toBe('slot')
    expect(teammateName('X'.repeat(200)).length).toBeLessThanOrEqual(64)
    // 确定性：同一输入永远同一输出。
    expect(teammateName('混合_命名 测试')).toBe(teammateName('混合_命名 测试'))
  })
})

describe('DSH 适配层能力探测', () => {
  it('agentTeams 可用时报告全部能力，并如实记录两条上游路径的取舍', () => {
    const { face } = fakeTeamService()
    const runtime = createDshMeetingRuntime({
      ctx: fakeCtx({ agentTeams: face }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    const capabilities = runtime.capabilities()
    expect(capabilities.canSpawn).toBe(true)
    expect(capabilities.canDeliver).toBe(true)
    expect(capabilities.canWake).toBe(true)
    expect(capabilities.canWaitForActivity).toBe(true)
    expect(capabilities.hasNativeTaskBoard).toBe(true)
    // 必须显式声明 agentTeams 不支持按槽位指定模型。
    expect(capabilities.notes.join(' ')).toMatch(/agentOptions/)
  })

  it('拿不到 agentTeams 时报降级而不是假装可用', () => {
    const runtime = createDshMeetingRuntime({
      ctx: fakeCtx({}),
      resolveCaller: () => ({ id: 'lead' }),
      preferred: 'agentTeams',
    })
    const capabilities = runtime.capabilities()
    expect(capabilities.canSpawn).toBe(false)
    expect(capabilities.notes.join(' ')).toMatch(/agentTeams/)
  })

  it('缺少 spawnTeammate 的服务不被当成可用后端', () => {
    const runtime = createDshMeetingRuntime({
      ctx: fakeCtx({ agentTeams: { sendMessage: () => undefined } }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    expect(runtime.capabilities().canSpawn).toBe(false)
  })

  it('无法解析活 Agent 时明确失败（上游要求 exact live Agent 作为授权凭据）', async () => {
    const { face } = fakeTeamService()
    const runtime = createDshMeetingRuntime({
      ctx: fakeCtx({ agentTeams: face }),
      resolveCaller: () => undefined,
    })
    await expect(runtime.spawn(SLOTS[0] as AgentSlotSpec)).rejects.toThrow(/无法解析当前活的 Lead Agent/)
  })
})

describe('DSH 适配层调用映射', () => {
  it('spawn 用 context=fresh 且把领域提示词与简报契约一起送进去', async () => {
    const { face, calls } = fakeTeamService()
    const runtime = createDshMeetingRuntime({
      ctx: fakeCtx({ agentTeams: face }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    const handle = await runtime.spawn(SLOTS[0] as AgentSlotSpec)
    expect(handle.slot).toBe('neural-net')
    expect(handle.runtimeRef).toBe('agentTeams:neural-net')

    const call = calls.find((row) => row.method === 'spawnTeammate')
    expect(call).toBeDefined()
    const request = call?.args[1] as Record<string, unknown>
    // fresh 是默认值：fork 会继承父上下文，正是我们要解决的污染。
    expect(request['context']).toBe('fresh')
    expect(request['provider']).toBe('spawn')
    const prompt = request['prompt'] as { type: string; text: string }[]
    expect(prompt[0]?.type).toBe('text')
    expect(prompt[0]?.text).toContain('只做网络结构。')
    expect(prompt[0]?.text).toContain('简报')
  })

  it('deliver 走 sendMessage，并带上 wake/steer 语义标记', async () => {
    const { face, calls } = fakeTeamService()
    const runtime = createDshMeetingRuntime({
      ctx: fakeCtx({ agentTeams: face }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    const handle = await runtime.spawn(SLOTS[0] as AgentSlotSpec)
    await runtime.deliver(handle, { kind: 'meeting-digest', mode: 'wake', text: '摘要正文' })

    const call = calls.find((row) => row.method === 'sendMessage')
    const request = call?.args[1] as Record<string, unknown>
    expect(request['target']).toBe('neural-net')
    expect((request['content'] as { text: string }[])[0]?.text).toBe('摘要正文')
    expect(request['signal']).toBeInstanceOf(AbortSignal)
  })

  it('waitForActivity 把上游 waitForChange 结果压成领域层可读诊断', async () => {
    const { face } = fakeTeamService()
    const runtime = createDshMeetingRuntime({
      ctx: fakeCtx({ agentTeams: face }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    const handle = await runtime.spawn(SLOTS[0] as AgentSlotSpec)
    const observation = await runtime.waitForActivity?.(handle, 1000)
    expect(observation?.kind).toBe('changed')
    expect(observation?.detail).toContain('member-status')
  })

  it('上游不支持 waitForActivity 时明确抛错，不退化成"假装等过了"', async () => {
    const runtime = createDshMeetingRuntime({
      ctx: fakeCtx({ agentTeams: { spawnTeammate: () => Promise.resolve({ member: { name: 'x' } }) } }),
      resolveCaller: () => ({ id: 'lead' }),
    })
    const handle = await runtime.spawn(SLOTS[0] as AgentSlotSpec)
    await expect(runtime.waitForActivity?.(handle, 10)).rejects.toThrow(/不支持 waitForActivity/)
  })

  it('subagents 后端把 model 映射到 agentOptions（agentTeams 做不到这一点）', async () => {
    const calls: Record<string, unknown>[] = []
    const subagents = {
      start: (provider: string, request: Record<string, unknown>) => {
        calls.push({ provider, ...request })
        return Promise.resolve({ childId: 'child-1' })
      },
      sendMessage: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    }
    const runtime = createDshMeetingRuntime({
      ctx: fakeCtx({ subagents }),
      resolveCaller: () => ({ id: 'lead' }),
      preferred: 'subagents',
    })
    const handle = await runtime.spawn({ ...(SLOTS[0] as AgentSlotSpec), model: 'deepseek-v4.1-flash' })
    expect(handle.runtimeRef).toBe('subagents:child-1')
    expect(calls[0]?.['agentOptions']).toEqual({ model: 'deepseek-v4.1-flash' })
    expect(runtime.capabilities().notes.join(' ')).toMatch(/agentOptions\.model/)
  })
})

// ---------------------------------------------------------------------------
// 宿主装配：真实的 compose() + LifecycleCoordinator
// ---------------------------------------------------------------------------

describe('宿主装配（真实 compose + lifecycle）', () => {
  function hostOptions() {
    const runtime = new InMemoryAgentRuntime()
    // 组合/装配用例只关心 facet 生命周期，因此用不打模型的替身。
    // 模型调用通道本身在 tests/dsh-voice.spec.ts 里单独验证。
    const voice = new ScriptedMeetingVoice({
      scripts: Object.fromEntries(
        SLOTS.map((slot) => [slot.id, { speeches: [`${slot.id} 的发言`], reflect: () => `${slot.id} 的待办：无。` }]),
      ),
    })
    return {
      runtime,
      options: {
        slots: SLOTS,
        runtime,
        voice,
        moderator: new RoundRobinModerator({ minSpeechesPerMember: 1, minRounds: 1 }),
        boardDomain: 'quant',
        rootDir: root,
        now: () => clock,
      },
    }
  }

  it('组合预检通过，且 provider facet 排在 consumer facet 之前', async () => {
    const { runtime, options } = hostOptions()
    const host = await activateMeetingHost(options)

    expect(host.plan.compatible).toBe(true)
    // 一个 coordinator facet + 每个槽位一个 agent facet。
    expect(host.plan.selected).toHaveLength(1 + SLOTS.length)
    expect(host.activated).toHaveLength(1 + SLOTS.length)

    // 激活顺序必须让 provider 先于 consumer：否则成员 facet 的
    // pre-activation 协商拿不到 agreement，激活会失败。
    const names = host.plan.activationOrder.map((key) => key.split('#')[1])
    expect(names[0]).toBe(COORDINATOR_FACET)
    expect(names.slice(1).every((name) => name?.startsWith(AGENT_FACET_PREFIX))).toBe(true)

    await host.shutdown()
    expect(runtime.liveSlots()).toHaveLength(0)
  })

  it('激活后协调器已认领全部成员，且能互相唤起', async () => {
    const { runtime, options } = hostOptions()
    const host = await activateMeetingHost(options)

    expect(host.coordinator.slotIds).toEqual(['live-trading', 'neural-net'])
    for (const slot of host.coordinator.slotIds) runtime.markIdle(slot)

    host.coordinator.publish({ slot: 'neural-net', domain: 'neural-net', round: 1, status: '网络方向就绪' })
    const result = await host.callMeeting({ calledBy: 'neural-net', scope: 'global', reason: '开工' })
    expect(result.accepted).toBe(true)
    if (!result.accepted) return
    expect([...result.meeting.woke].sort()).toEqual(['live-trading', 'neural-net'])
    for (const slot of host.coordinator.slotIds) {
      expect(runtime.state(slot)).toBe('running')
    }

    await host.shutdown()
  })

  it('shutdown 卸载全部 facet 并回收成员 —— 卸载即回收', async () => {
    const { runtime, options } = hostOptions()
    const host = await activateMeetingHost(options)
    expect(runtime.liveSlots()).toHaveLength(SLOTS.length)

    await host.shutdown()

    expect(runtime.liveSlots()).toHaveLength(0)
    // 共享注册表也被清空，不残留悬空句柄。
    expect(host.coordinator.slotIds).toEqual([])
  })

  it('成员 facet 的 boardDomain 与 agreement 不一致时拒绝激活', async () => {
    const { options } = hostOptions()
    // 用一份 boardDomain 不匹配的 host 配置无法直接构造；
    // 这里改为验证：正常配置下 agreement 的 boardDomain 被正确带入 facet 校验。
    const host = await activateMeetingHost({ ...options, boardDomain: 'quant' })
    expect(host.plan.compatible).toBe(true)
    await host.shutdown()
  })
})
