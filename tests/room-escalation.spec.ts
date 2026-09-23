/**
 * 「停滞 → 正式会议室」升级路径 + 「会话活动 → 成员状态」驱动的测试。
 *
 * ## 这组测试要堵的两个洞
 *
 * 1. **正式会议室在真实宿主里是死代码**。`apply()` 建好了 `MeetingOrchestrator`、
 *    入了会籍、接了边界监听器，却**从来没有人调用 `orchestrator.convene()`** ——
 *    唯一调用它的是演示脚本和测试自己。于是"会议室 / 主持人控场 /
 *    每人个性化纪要 / 散会回收"这一整套只在测试里活着。
 *    本文件的 `pulse()` 用例断言：定时器走一轮就真的开会了。
 *
 * 2. **成员状态永远停在 `working`**。`AgentParticipant` 初始 `working`，
 *    而 `convene()` 要求至少一位能**立刻入场**的成员（`idle-waiting` / `done`
 *    直接入会；`working` 只能进 `awaiting-entry`）。
 *    没有任何东西把真实会话活动映射成状态时，`convene()` 永远抛
 *    「全部 N 位成员都在工作中，会议无法开始」。
 *    本文件的会话活动用例断言：上游 `turn/end` 到达后成员变成可立刻入场的空闲态。
 *
 * ## 刻意覆盖的生产细节
 *
 * 上游 `session/event` 带的是 **DSH 自己的会话 id**（UUID），不是我们的 slot id。
 * 所以这里用 `memberSessions` 显式映射来测 —— 恒等映射在真实环境里根本不成立，
 * 只测恒等映射等于没测。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_EVENT_CHANNEL } from '../src/adapters/dsh-boundary-watcher.js'
import type { DshSubagentRunFace } from '../src/adapters/dsh-meeting-voice.js'
import { ACTIVITY_EVENT } from '../src/adapters/dsh-session-state.js'
import { createDshMeetingRuntime, isLiveAgent, resolveLiveAgent } from '../src/adapters/dsh-team-runtime.js'
import { apply, readSlotsFromEnv, selectRoomInvitees } from '../src/host.js'
import { RuntimeUnavailable } from '../src/ports/agent-runtime.js'
import { HUMAN_PARTICIPANT, type AgentSlotSpec } from '../src/index.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-degrade-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 假上游（与 dsh-voice.spec.ts 同构，保持两份测试对同一契约的断言一致）
// ---------------------------------------------------------------------------

interface StartCall {
  readonly provider: string
  readonly request: Record<string, unknown>
}

function makeSubagentsService(
  handler: (call: StartCall) => { text?: string; stopReason?: string; output?: readonly { type: string; text?: string }[] },
): { face: unknown; calls: StartCall[]; disposed: () => number } {
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
        }),
        dispose: () => {
          state.disposed += 1
        },
      }
      return Promise.resolve(run)
    },
    // 真实 `ctx.subagents` 同时有 sendMessage / interrupt；替身必须照真实形状写，
    // 否则能力门会误判模型通道不可用（见 dsh-voice.spec.ts 同处注释）。
    sendMessage: () => Promise.resolve({ messageId: 'm', status: 'queued' }),
    interrupt: () => ({ previousStatus: 'idle' }),
  }
  return { face, calls, disposed: () => state.disposed }
}

function makeCtx(services: Record<string, unknown>) {
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const registered: string[] = []
  return {
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
 * `roots` 传空数组即可模拟"dsh 刚启动、用户还没开任何会话"——
 * 那是最容易被误判成"插件坏了"的状态，必须能测。
 * `add()` 模拟"用户后来开了会话"，用于验证成员会被补起来。
 */
function makeAgentsService(roots: readonly unknown[] = [{ id: 'lead-agent' }]) {
  const store = new Map(roots.map((agent) => [String((agent as { id: unknown }).id), agent]))
  return {
    currentInitiator: () => undefined,
    roots: () => [...store.values()],
    list: () => [...store.values()],
    get: (id: unknown) => store.get(String(id)),
    add: (agent: unknown) => {
      store.set(String((agent as { id: unknown }).id), agent)
    },
  }
}

type FakeAgents = ReturnType<typeof makeAgentsService>

/**
 * 假 agentTeams。
 *
 * `listMembers` 的形状按上游真实 `TeamMemberView` 写：
 * `{ id: SessionId, name, role, status }` —— 注意 `id` 是**上游会话 id**，
 * `name` 是我们 spawn 时给的名字。这正是自动建立映射的依据。
 */
function makeAgentTeamsService(roster: readonly { readonly id: string; readonly name: string }[] = []): unknown {
  return {
    spawnTeammate: (_caller: unknown, request: Record<string, unknown>) =>
      Promise.resolve({ member: { name: String(request['name']) } }),
    sendMessage: () => Promise.resolve({ messageId: 'm', status: 'queued' }),
    interrupt: () => ({ previousStatus: 'idle' }),
    createTask: () => Promise.resolve({ id: 't' }),
    listMembers: () => roster,
    waitForChange: () => Promise.resolve({ type: 'member-status' }),
  }
}

/** 完成所有已排队的微任务（本测试里全部模型调用都是同步 resolve 的 Promise）。 */
async function flush(times = 400): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

/**
 * `apply()` + **显式开会籍**。
 *
 * 默认会籍是空的（房间不自动建、人不自动进），所以每个需要"房间里有人"的用例
 * 都必须自己把这一步做出来。这些用例测的是会议机制，不是准入策略——
 * 准入策略有它自己的用例（`console-and-tool.spec.ts`）。
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

// ---------------------------------------------------------------------------

const SLOTS: readonly AgentSlotSpec[] = [
  { id: 'neural-net', workspace: 'quant-lab', model: 'deepseek-v4-pro', domain: 'neural-net', title: '神经网络专家', systemPrompt: '只做网络结构。' },
  { id: 'live-trading', workspace: 'quant-live', model: 'deepseek-v4.1-flash', domain: 'live-trading', title: '实盘专家', systemPrompt: '只做滑点与仓位。' },
]

/** 生产形状：上游会话 id 是 DSH 自己的，跟我们 slot id 无关。 */
const SESSIONS = { 'sess-7f3a': 'live-trading', 'sess-9c21': 'neural-net' } as const

function makeHostCtx(
  roster?: readonly { readonly id: string; readonly name: string }[],
  agentRoots: readonly unknown[] = [{ id: 'lead-agent' }],
  extraServices: Record<string, unknown> = {},
) {
  const service = makeSubagentsService(({ request }) => {
    const label = String(request['label'] ?? '')
    if (label === 'moderator') return { text: '{"action":"adjourn","reason":"讨论已收敛"}' }
    if (label.startsWith('minutes:')) {
      const who = label.slice('minutes:'.length)
      return { text: `待办：${who} 需在 60 日窗口下重跑验证。` }
    }
    if (label.startsWith('speech:')) {
      const who = label.slice('speech:'.length)
      return { text: `${who} 的进度：已完成本轮实验；障碍：需要对方确认成本口径。` }
    }
    return { text: 'ok' }
  })
  const agents = makeAgentsService(agentRoots)
  const ctx = makeCtx({
    agents,
    agentTeams: makeAgentTeamsService(roster),
    subagents: service.face,
    ...extraServices,
  })
  return { ctx, service, agents }
}

// ===========================================================================

describe('会话活动 → 成员状态：让"可被召集的空闲成员"真的存在', () => {
  it('上游 turn/end 让成员变成 idle-waiting，turn/start 让它回到 working', async () => {
    const { ctx } = makeHostCtx()
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'state', memberSessions: SESSIONS })

    // 初始：全员 working —— 这正是"没人喂状态"时永远不变的初值。
    expect(host.orchestrator.states()).toEqual({ 'live-trading': 'working', 'neural-net': 'working' })

    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-7f3a' }, { type: ACTIVITY_EVENT.idle })
    expect(host.orchestrator.member('live-trading').state).toBe('idle-waiting')

    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-7f3a' }, { type: ACTIVITY_EVENT.busy })
    expect(host.orchestrator.member('live-trading').state).toBe('working')

    await host.shutdown()
  })

  it('未被映射的会话 id 被忽略，且不产生错误', async () => {
    const { ctx } = makeHostCtx()
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'unknown-session', memberSessions: SESSIONS })

    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-别人家的会话' }, { type: ACTIVITY_EVENT.idle })
    expect(host.orchestrator.states()).toEqual({ 'live-trading': 'working', 'neural-net': 'working' })

    await host.shutdown()
  })

  it('已被召集（待入场）的成员收到 turn/end 时直接入场，而不是被改成空闲', async () => {
    const { ctx } = makeHostCtx()
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'awaiting', memberSessions: SESSIONS })

    // neural-net 空闲可以直接入会；live-trading 保持 working（模拟正在跑）
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-9c21' }, { type: ACTIVITY_EVENT.idle })
    expect(host.orchestrator.member('neural-net').state).toBe('idle-waiting')

    // 召集后 live-trading 进入 awaiting-entry（不打断）。
    // 在 onOpened 里发事件：convene() 是一口气跑完的，出了这个钩子会议就已经散了，
    // 事后再补事件只能测到一个已经 dismiss 的成员。
    let admitted: string | undefined
    const record = await host.orchestrator.convene({
      roomId: host.defaultRoomId,
      calledBy: 'neural-net',
      scope: 'global',
      reason: '等边界',
      hooks: {
        onOpened: (room) => {
          expect(room.hasPresent('live-trading')).toBe(false)
          expect(room.absent).toContain('live-trading')
          // 它的回合结束 → 应当入场，而不是变成 idle-waiting
          ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-7f3a' }, { type: ACTIVITY_EVENT.idle })
          admitted = host.orchestrator.member('live-trading').state
        },
      },
    })

    expect(admitted).toBe('in-meeting')
    expect(record.deferred).toContain('live-trading')
    expect(record.admittedLate).toContain('live-trading')
    expect(record.room.transcript.some((turn) => turn.kind === 'speech' && turn.speaker === 'live-trading')).toBe(true)

    await host.shutdown()
  })

  it('宿主不支持 on() 时报告降级而不是抛错', async () => {
    const service = makeSubagentsService(() => ({ text: 'x' }))
    const ctx = makeCtx({ agents: makeAgentsService(), agentTeams: makeAgentTeamsService(), subagents: service.face })
    const bare = { ...ctx, on: undefined }
    const host = await applied(bare as never, { slots: SLOTS, rootDir: root, boardDomain: 'no-on' })
    expect(host.orchestrator.states()).toEqual({ 'live-trading': 'working', 'neural-net': 'working' })
    await host.shutdown()
  })
})

describe('停滞 → 正式会议室：把那条缺失的箭头接上', () => {
  it('pulse() 在停滞成立时真的开出一场会议室会议（含模型透传、各自纪要、散会回收）', async () => {
    const { ctx, service } = makeHostCtx()
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'escalate', memberSessions: SESSIONS })

    // 两位成员都空闲 → 能被立刻召集
    for (const sessionId of Object.keys(SESSIONS)) {
      ctx.emit(SESSION_EVENT_CHANNEL, { id: sessionId }, { type: ACTIVITY_EVENT.idle })
    }

    const pulse = await host.pulse()

    // 停滞信号成立（没人交过简报）
    expect(pulse.escalation.signals.join(' ')).toMatch(/silent-slot/)
    expect(pulse.escalation.escalated).toBe(true)

    const record = pulse.escalation.record
    expect(record).toBeDefined()
    if (record === undefined) return

    // 真实发言人 = 两位成员，且第一轮人人有输出
    expect([...record.summoned].sort()).toEqual(['live-trading', 'neural-net'])
    const speeches = record.room.transcript.filter((turn) => turn.kind === 'speech')
    expect(speeches).toHaveLength(2)

    // 每人用自己的模型
    const speechModels = service.calls
      .filter((call) => String(call.request['label']).startsWith('speech:'))
      .map((call) => (call.request['agentOptions'] as { model?: string } | undefined)?.model)
    expect(new Set(speechModels)).toEqual(new Set(['deepseek-v4-pro', 'deepseek-v4.1-flash']))

    // 主持人用的不是任何成员的模型（外部干预借人类席位召集）
    const moderatorCall = service.calls.find((call) => call.request['label'] === 'moderator')
    expect(moderatorCall).toBeDefined()
    expect(moderatorCall?.request['agentOptions']).toBeUndefined()

    // 每人各自一份、内容互不相同的纪要
    expect(record.notes).toHaveLength(2)
    expect(new Set(record.notes.map((note) => note.text)).size).toBe(2)

    // 散会后还原到召集前的空闲状态（两位都是先转空闲再被召集的）。
    // 必须是 `idle-waiting`：回到 working 会让下一次 pulse 再也升不了级。
    expect(host.orchestrator.states()).toEqual({ 'live-trading': 'idle-waiting', 'neural-net': 'idle-waiting' })
    expect(host.orchestrator.meetings).toHaveLength(1)

    // 每次模型调用都被 dispose
    expect(service.disposed()).toBe(service.calls.length)

    await host.shutdown()
  })

  it('定时器走的是 pulse：不调用 tick 也会开会', async () => {
    const intervals: (() => void)[] = []
    vi.stubGlobal('setInterval', (handler: () => void) => {
      intervals.push(handler)
      return 0 as unknown as NodeJS.Timeout
    })

    const { ctx, service } = makeHostCtx()
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'timer', memberSessions: SESSIONS, autoPulse: true })
    for (const sessionId of Object.keys(SESSIONS)) {
      ctx.emit(SESSION_EVENT_CHANNEL, { id: sessionId }, { type: ACTIVITY_EVENT.idle })
    }

    // apply() 必须注册了定时驱动
    expect(intervals).toHaveLength(1)

    intervals[0]?.()
    await flush()

    // 只走 tick 的话这里永远是 0 —— 那条箭头就是断在这儿
    expect(host.orchestrator.meetings).toHaveLength(1)
    expect(service.calls.filter((call) => String(call.request['label']).startsWith('speech:'))).toHaveLength(2)

    await host.shutdown()
  })

  it('全员工作中时升级失败不抛错，而是带回可诊断的理由', async () => {
    const { ctx } = makeHostCtx()
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'all-busy', memberSessions: SESSIONS })

    // 一个都不置空闲 → 全体 working
    const pulse = await host.pulse()

    expect(pulse.escalation.escalated).toBe(false)
    expect(pulse.escalation.reason).toMatch(/升级未成立/)
    expect(pulse.escalation.reason).toMatch(/工作中/)
    // 失败不能留下半个会议状态
    expect(host.orchestrator.meetings).toHaveLength(0)
    expect(host.orchestrator.states()).toEqual({ 'live-trading': 'working', 'neural-net': 'working' })

    await host.shutdown()
  })

  it('没有停滞信号时明确说明"不需要升级"', async () => {
    const { ctx } = makeHostCtx()
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'no-stall', memberSessions: SESSIONS })

    const result = await host.escalate({ decisions: [], suppressed: [], stallSignals: [] })
    expect(result.escalated).toBe(false)
    expect(result.reason).toMatch(/没有停滞信号/)
    expect(result.signals).toEqual([])

    await host.shutdown()
  })

  it('升级后会议记录真的落盘（可审计）', async () => {
    const { existsSync } = await import('node:fs')
    const { ctx } = makeHostCtx()
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'persist', memberSessions: SESSIONS })
    for (const sessionId of Object.keys(SESSIONS)) {
      ctx.emit(SESSION_EVENT_CHANNEL, { id: sessionId }, { type: ACTIVITY_EVENT.idle })
    }
    await host.pulse()

    // 会籍单独一份（进程重启后可恢复）；会议记录在 boardDomain 目录下。
    // 注意 board.jsonl 只在**有人提交简报**时才出现 ——
    // 只有会议发言、没有简报的场景下它本来就不该存在，不要在这里虚报。
    expect(existsSync(join(root, 'rooms.jsonl'))).toBe(true)
    expect(existsSync(join(root, 'persist', 'meetings.jsonl'))).toBe(true)
    expect(existsSync(join(root, 'persist', 'board.jsonl'))).toBe(false)

    host.coordinator.publish({ slot: 'live-trading', domain: 'live-trading', round: 1, status: '滑点重算完成' })
    expect(existsSync(join(root, 'persist', 'board.jsonl'))).toBe(true)

    await host.shutdown()
  })
})

describe('★ 重启恢复：会籍从 rooms.jsonl 重建，不必先删掉再加回来', () => {
  it('重启后直接召集就能成功（成员名册被补齐）', async () => {
    // 用户现场：重启 dsh 后点"召集会议"，得到"没有可召集的成员"，
    // 必须把会议室里的成员一个个删掉再加回来才能开会。
    //
    // 根因：`rooms.jsonl` 持久化了房间与成员，但编排器的成员名册是**纯内存**的。
    // 重启后房间还在、成员还在，名册却是空的 —— 而 `convene()` 的候选范围是
    // `room.members ∩ this.members`，于是算出"没有可召集的成员"。

    // ① 第一次运行：建房间 + 加两个成员，落盘进 rooms.jsonl。
    //
    // 这里**刻意不用** `applied()` 包装：它会自动把 `SLOTS` 加进房间，
    // 而那些 slot id 与会话 id 同名（`live-trading` 等），于是会籍成员会先被
    // **slot 预登记**占住名册（状态 `working`），把真实的"从盘恢复"路径盖掉。
    // 真实环境里 `slots` 是空的，成员是任意会话 id —— 所以用独立 id 才对得上。
    const first = makeHostCtx()
    const host1 = (await apply(first.ctx, { slots: SLOTS, rootDir: root, boardDomain: 'restart' })).host
    host1.rooms.createRoom({ id: 'daily' })
    host1.rooms.join({ sessionId: 'sess-alpha', roomId: 'daily', workspace: 'w1' })
    host1.rooms.join({ sessionId: 'sess-beta', roomId: 'daily', workspace: 'w2' })
    await host1.shutdown()

    // ② 模拟重启：全新的 ctx、全新的 host，但**同一个 rootDir**（rooms.jsonl 还在）。
    const second = makeHostCtx()
    const host2 = (await apply(second.ctx, { slots: SLOTS, rootDir: root, boardDomain: 'restart' })).host

    // 房间与成员确实从盘上恢复了。
    const members = (host2.rooms.room('daily')?.members ?? []).map((member) => member.sessionId)
    expect([...members].sort()).toEqual(['sess-alpha', 'sess-beta'])

    // ★ 修复点：名册被补齐，且成员处于**可被召集的空闲**状态
    // （不是状态机的初始值 `working` —— 那会让召集报"全员都在工作中"）。
    for (const sessionId of members) {
      expect(host2.orchestrator.participantIds).toContain(sessionId)
      expect(host2.orchestrator.member(sessionId).state).toBe('idle-waiting')
    }

    // ③ 关键：**没有重新加任何成员**，直接召集。
    const result = await host2.console.convene({
      roomId: 'daily',
      calledBy: HUMAN_PARTICIPANT,
      reason: '重启后直接开会',
    })
    expect(result.ok, result.ok ? '' : `召集失败：${result.reason}`).toBe(true)
    if (result.ok) {
      expect(result.attended.length).toBeGreaterThan(0)
      expect(result.rounds).toBeGreaterThanOrEqual(1)
    }

    await host2.shutdown()
  })
})

describe('会话映射：真实环境里 slot id ≠ 上游会话 id', () => {
  it('从 agentTeams.listMembers 自动建立映射（按 teammate name 对齐）', async () => {
    // 上游看到的成员名是我们 spawn 时给的名字，id 是上游自己的会话身份。
    const roster = [
      { id: 'clj-9f01', name: 'live-trading' },
      { id: 'clj-9f02', name: 'neural-net' },
      { id: 'clj-9f03', name: '不是我们的成员' },
    ]
    const { ctx } = makeHostCtx(roster)

    // 刻意**不**给 config.memberSessions —— 映射必须靠探测拿到
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'auto-map' })

    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'clj-9f01' }, { type: ACTIVITY_EVENT.idle })
    expect(host.orchestrator.member('live-trading').state).toBe('idle-waiting')

    // 别人的成员不该被误认
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'clj-9f03' }, { type: ACTIVITY_EVENT.idle })
    expect(host.orchestrator.states()).toEqual({ 'live-trading': 'idle-waiting', 'neural-net': 'working' })

    // 两条都映射后可以直接开会
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'clj-9f02' }, { type: ACTIVITY_EVENT.idle })
    const pulse = await host.pulse()
    expect(pulse.escalation.escalated).toBe(true)

    await host.shutdown()
  })

  it('配置的显式映射优先于探测（用户说是谁就是谁）', async () => {
    const roster = [{ id: 'clj-9f01', name: 'live-trading' }]
    const { ctx } = makeHostCtx(roster)
    const host = await applied(ctx, {
      slots: SLOTS,
      rootDir: root,
      boardDomain: 'explicit-wins',
      memberSessions: { 'someone-elses-uuid': 'live-trading' },
    })

    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'someone-elses-uuid' }, { type: ACTIVITY_EVENT.idle })
    expect(host.orchestrator.member('live-trading').state).toBe('idle-waiting')

    await host.shutdown()
  })

  it('升级失败时的理由带上诊断：未映射会话 id 会被点出来', async () => {
    const { ctx } = makeHostCtx([])
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'diagnose' })

    // 上游发来我们完全不知道的会话 id
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-来自上游没人认领' }, { type: ACTIVITY_EVENT.idle })

    const pulse = await host.pulse()
    expect(pulse.escalation.escalated).toBe(false)
    // 不是只说一句"全部成员都在工作中"，而是告诉你去配什么
    expect(pulse.escalation.reason).toMatch(/未映射的上游会话 id/)
    expect(pulse.escalation.reason).toMatch(/memberSessions/)

    await host.shutdown()
  })

  it('DshMeetingRuntime.memberSessions 按 teammate name 对齐，且不编造未知成员', async () => {
    const roster = [
      { id: 'clj-7a', name: 'live-trading' },
      { id: 'clj-7b', name: 'neural-net' },
      { id: 'clj-7c', name: '别的队伍的人' },
    ]
    const ctx = makeCtx({ agents: makeAgentsService(), agentTeams: makeAgentTeamsService(roster) })
    const runtime = createDshMeetingRuntime({ ctx, resolveCaller: () => ({ id: 'lead-agent' }) })

    await runtime.spawn(SLOTS[0] as AgentSlotSpec)
    await runtime.spawn(SLOTS[1] as AgentSlotSpec)

    const mapping = await runtime.memberSessions?.()
    const sorted = [...(mapping ?? [])].sort((left, right) => (left.slot < right.slot ? -1 : 1))
    expect(sorted).toEqual([
      { slot: 'live-trading', sessionId: 'clj-7a' },
      { slot: 'neural-net', sessionId: 'clj-7b' },
    ])
  })

  it('subagents 后端如实返回空映射，不假装知道会话 id', async () => {
    const service = makeSubagentsService(() => ({ text: 'x' }))
    const ctx = makeCtx({ agents: makeAgentsService(), subagents: service.face })
    const runtime = createDshMeetingRuntime({
      ctx,
      resolveCaller: () => ({ id: 'lead-agent' }),
      preferred: 'subagents',
    })
    await runtime.spawn(SLOTS[0] as AgentSlotSpec)
    expect(await runtime.memberSessions?.()).toEqual([])
  })
})

/**
 * 复刻 cordis `Fiber._execute` 里那段 effect 判定（真机就是在这里抛的）。
 *
 * ```js
 * const effect = runner.execute.call(this)
 * if (typeof effect === 'function') return runner.collect(effect)
 * else if (isNullable(effect)) {}
 * else if (!isObject(effect)) throw new TypeError('Invalid effect')
 * else if ('then' in effect) return effect.then(safeCollect)
 * ```
 *
 * `safeCollect(v)` 只接受**函数**或 null/undefined。async `apply` 的 resolve 值
 * 走的就是 `effect.then(safeCollect)` 这条分支。
 */
function cordisSafeCollect(dispose: unknown): void {
  if (typeof dispose === 'function') return
  if (dispose === null || dispose === undefined) return
  throw new TypeError('Invalid effect')
}

describe('轮次结论必须报出去（否则"什么都没发生"就是唯一的症状）', () => {
  function captureLogger() {
    const noted: string[] = []
    return {
      noted,
      logger: {
        info: (message: string) => {
          noted.push(`info:${message}`)
          return undefined
        },
        warn: (message: string) => {
          noted.push(`warn:${message}`)
          return undefined
        },
      },
    }
  }

  function stubTimers(): (() => void)[] {
    const intervals: (() => void)[] = []
    vi.stubGlobal('setInterval', (handler: () => void) => {
      intervals.push(handler)
      return 0 as unknown as NodeJS.Timeout
    })
    return intervals
  }

  it('升级不成立时 warn 一次，并落进 pulse.jsonl；结论不变则不重复刷', async () => {
    const { noted, logger } = captureLogger()
    const intervals = stubTimers()
    const { ctx } = makeHostCtx(undefined, [], { logger })
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'report-fail', autoPulse: true })

    intervals[0]?.()
    await flush()

    expect(noted).toHaveLength(1)
    expect(noted[0]).toMatch(/^warn:\[dsh-meeting\] 未升级到会议室/)
    // 理由必须是可诊断的：点名未启动的成员
    expect(noted[0]).toMatch(/尚未启动/)

    // 结论没变 → 心跳不该刷屏（这是"什么都没发生"的另一种写法）
    intervals[0]?.()
    await flush()
    expect(noted).toHaveLength(1)

    // 但落盘要有据可查
    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(join(root, 'pulse.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0] as string) as { escalated: boolean; trigger: string }
    expect(record.escalated).toBe(false)
    expect(record.trigger).toBe('stall')

    await host.shutdown()
  })

  it('升级成立时报 info，结论变化会被再次记录', async () => {
    const roster = [
      { id: 'sess-la', name: 'live-trading' },
      { id: 'sess-nn', name: 'neural-net' },
    ]
    const { noted, logger } = captureLogger()
    const intervals = stubTimers()
    const { ctx } = makeHostCtx(roster, undefined, { logger })
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'report-ok', autoPulse: true })

    // 让两位成员变成"可立刻入场"
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-la' }, { type: ACTIVITY_EVENT.idle })
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-nn' }, { type: ACTIVITY_EVENT.idle })

    intervals[0]?.()
    await flush()

    expect(noted.some((line) => line.startsWith('info:[dsh-meeting] 已升级到会议室'))).toBe(true)
    const { readFileSync } = await import('node:fs')
    const records = readFileSync(join(root, 'pulse.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { escalated: boolean; meeting: string | null })
    expect(records).toHaveLength(1)
    expect(records[0]?.escalated).toBe(true)

    await host.shutdown()
  })
})

describe('Cordis 契约：apply 的返回值必须能过 safeCollect', () => {
  it('resolve 的是 disposer 函数，而不是句柄对象（真机这里崩过）', async () => {
    const { ctx } = makeHostCtx()
    const activation = await apply(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'cordis-contract' })

    // 关键：真机报的 `TypeError: Invalid effect` 就发生在这个判定上。
    // 之前 apply 直接 resolve 了 MeetingHostHandle 对象 → 整个 dsh 起不来。
    expect(() => cordisSafeCollect(activation)).not.toThrow()
    expect(typeof activation).toBe('function')

    // 句柄仍然可达（程序化调用方与测试都靠它）
    expect(activation.host.defaultRoomId).toBe('cordis-contract')
    expect(activation.host.pendingMembers).toEqual([])

    // disposer 幂等：Cordis 卸载时它可能和 ctx.on('dispose') 一起被触发
    await activation()
    await activation()
  })

  it('disposer 真的解绑了订阅：卸载之后会话事件不再驱动成员状态', async () => {
    const { ctx } = makeHostCtx()
    const activation = await apply(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'teardown-works' })
    const { host } = activation

    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'live-trading' }, { type: ACTIVITY_EVENT.idle })
    expect(host.orchestrator.member('live-trading').state).toBe('idle-waiting')

    await activation()

    // 复位后同一个事件不该再起作用 —— 说明监听器确实被解绑了
    host.orchestrator.member('live-trading').resume()
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'live-trading' }, { type: ACTIVITY_EVENT.idle })
    expect(host.orchestrator.member('live-trading').state).toBe('working')
  })
})

describe('boot 安全：没有活的 Agent 也不能把 dsh 带下线', () => {
  it('一个活的 Agent 都没有时，apply() 仍然成功（降级），成员记为待启动', async () => {
    // 模拟 `dsh web` 刚启动、用户还没开任何会话
    const { ctx } = makeHostCtx(undefined, [])

    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'no-agent' })

    // 关键：**不抛**。抛出去的表现是 plugin tree failed to load → 整个 dsh 起不来。
    expect([...host.pendingMembers].sort()).toEqual(['live-trading', 'neural-net'])
    // 槽位规格仍然登记着，所以停滞检测/简报板照常工作
    expect(host.coordinator.slotIds).toEqual(['live-trading', 'neural-net'])
    expect(host.orchestrator.states()).toEqual({ 'live-trading': 'working', 'neural-net': 'working' })

    // 这一轮升级会失败，但必须是"带回理由"而不是抛错
    const pulse = await host.pulse()
    expect(pulse.escalation.escalated).toBe(false)
    expect(pulse.escalation.reason).toMatch(/升级未成立/)
    // 诊断要点名"哪些成员还没起来"，否则看起来就像插件没生效
    expect(pulse.escalation.reason).toMatch(/尚未启动/)

    await host.shutdown()
  })

  it('用户开了会话之后，retryMembers() 把成员补起来；再开会就成立', async () => {
    const roster = [
      { id: 'sess-la', name: 'live-trading' },
      { id: 'sess-nn', name: 'neural-net' },
    ]
    const { ctx, agents } = makeHostCtx(roster, [])
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'late-agent' })
    expect(host.pendingMembers).toHaveLength(2)

    // 用户开了一个会话 → 出现活的 Agent
    agents.add({ id: 'lead-agent' })

    const recovered = await host.retryMembers()
    expect([...recovered].sort()).toEqual(['live-trading', 'neural-net'])
    // getter 必须立刻反映真相（否则诊断会撒谎）
    expect(host.pendingMembers).toEqual([])

    // 补起之后，会话事件与会议室都该正常工作
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-la' }, { type: ACTIVITY_EVENT.idle })
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-nn' }, { type: ACTIVITY_EVENT.idle })
    expect(host.orchestrator.member('live-trading').state).toBe('idle-waiting')

    const pulse = await host.pulse()
    expect(pulse.escalation.escalated).toBe(true)

    await host.shutdown()
  })

  it('没有活的 Agent 时会开不起来，但绝不留下半开会状态，也不卡住后续轮次', async () => {
    // 修正一个容易想当然的假设：成员句柄缺失只影响轻量路径的投递；
    // 但**发言**走 one-shot 子调用，而它的 parent 同样要求 exact live Agent。
    // 所以没有活 Agent 时会议是开不起来的——这是诚实行为，不能假装"大家都沉默"。
    const { ctx } = makeHostCtx(undefined, [])
    const host = await applied(ctx, { slots: SLOTS, rootDir: root, boardDomain: 'degraded-room' })

    host.orchestrator.member('live-trading').beginIdleWaiting()
    host.orchestrator.member('neural-net').beginIdleWaiting()

    await expect(
      host.orchestrator.convene({
        roomId: host.defaultRoomId,
        calledBy: 'live-trading',
        scope: 'global',
        reason: '降级下试图开会',
      }),
    ).rejects.toThrow(/活的 Agent/)

    // 编排器的 finally 必须把状态收干净：不留半开的会，也不留僵尸成员。
    expect(host.orchestrator.activeRoom()).toBeUndefined()
    expect(host.orchestrator.meetings).toHaveLength(0)
    expect(host.orchestrator.states()).toEqual({ 'live-trading': 'idle-waiting', 'neural-net': 'idle-waiting' })

    // 而且不能卡住后续轮次：pulse 仍然安全带回了理由而不是抛错
    const pulse = await host.pulse()
    expect(pulse.escalation.escalated).toBe(false)
    expect(pulse.escalation.reason).toMatch(/升级未成立/)

    await host.shutdown()
  })
})

describe('resolveLiveAgent：只要活的 Agent，不要服务对象', () => {
  it('优先级：currentInitiator > roots > list', () => {
    const ctx = makeCtx({
      agents: {
        currentInitiator: () => ({ id: 'initiator' }),
        roots: () => [{ id: 'root' }],
        list: () => [{ id: 'listed' }],
      },
    })
    expect(resolveLiveAgent(ctx)).toEqual({ id: 'initiator' })
  })

  it('没有发起者边界时退到 roots（插件加载与定时器路径的真实情形）', () => {
    const ctx = makeCtx({
      agents: {
        currentInitiator: () => {
          throw new Error('no initiator boundary')
        },
        roots: () => [{ id: 'root' }],
        list: () => [{ id: 'listed' }],
      },
    })
    expect(resolveLiveAgent(ctx)).toEqual({ id: 'root' })
  })

  it('**服务对象本身不是 Agent**：没有 id 的一律跳过，全都没有则 undefined', () => {
    // 这就是真机踩的坑：把 ctx.agents 原样传下去，上游读 agent.id 得到 undefined
    const serviceLike = { get: () => undefined, roots: () => [], list: () => [] }
    const ctx = makeCtx({ agents: { ...serviceLike, roots: () => [serviceLike] } })
    expect(resolveLiveAgent(ctx)).toBeUndefined()

    expect(isLiveAgent({ id: 'x' })).toBe(true)
    expect(isLiveAgent(serviceLike)).toBe(false)
    expect(isLiveAgent(undefined)).toBe(false)
    expect(isLiveAgent({ id: '' })).toBe(false)
  })

  it('ctx.get("agents") 不可用时返回 undefined 而不是抛错', () => {
    expect(resolveLiveAgent(makeCtx({}))).toBeUndefined()
  })
})

describe('selectRoomInvitees：小会只叫相关的人', () => {
  it('只挑停滞成员与有障碍/求助的成员，且裁剪到受管成员内', () => {
    const chosen = selectRoomInvitees({
      signals: [{ kind: 'silent-slot', slots: ['live-trading'], detail: 'x' }],
      briefings: [
        {
          slot: 'neural-net',
          domain: 'd',
          round: 1,
          status: 's',
          blocker: '卡在数据权限',
          needs: [],
          requestedFrom: ['live-trading'],
          boardRevision: 1,
          at: 0,
          fingerprint: 'f',
          chars: 1,
        },
      ],
      candidates: ['live-trading', 'neural-net'],
    })
    expect(chosen).toEqual(['live-trading', 'neural-net'])
  })

  it('停滞成员不在受管范围内时不硬塞（避免开出一个没有议程的会）', () => {
    const chosen = selectRoomInvitees({
      signals: [{ kind: 'silent-slot', slots: ['早就卸载了的成员'], detail: 'x' }],
      briefings: [],
      candidates: ['live-trading', 'neural-net'],
    })
    expect(chosen).toEqual([])
  })
})

describe('readSlotsFromEnv：把报错文案的承诺补上', () => {
  it('缺省返回空数组', () => {
    expect(readSlotsFromEnv({})).toEqual([])
    expect(readSlotsFromEnv({ DSH_MEETING_SLOTS: '   ' })).toEqual([])
  })

  it('解析 JSON 数组', () => {
    const parsed = readSlotsFromEnv({
      DSH_MEETING_SLOTS: JSON.stringify([{ id: 'a', domain: 'd', title: 't', systemPrompt: 'p' }]),
    })
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe('a')
  })

  it('非法 JSON / 非数组 / 缺字段一律明确报错，不静默当作没有槽位', () => {
    expect(() => readSlotsFromEnv({ DSH_MEETING_SLOTS: '{oops' })).toThrow(RuntimeUnavailable)
    expect(() => readSlotsFromEnv({ DSH_MEETING_SLOTS: '"不是数组"' })).toThrow(/必须是 JSON 数组/)
    expect(() => readSlotsFromEnv({ DSH_MEETING_SLOTS: '[{"id":"a"}]' })).toThrow(/domain/)
  })
})
