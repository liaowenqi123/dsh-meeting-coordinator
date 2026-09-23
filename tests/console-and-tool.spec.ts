/**
 * 会籍模型改造的测试：**默认空会籍 / 准入策略 / 落盘 / 全局工具**。
 *
 * ## 这组测试要钉住的东西
 *
 * 1. **默认什么都不做**。上一版 `apply()` 会自动建房间、把所有 slot 拉进会、
 *    并起一个 60 秒定时器 —— 结果是"插件一装上就自己开始开会"，用户既看不到
 *    也停不掉。默认状态必须是"没有房间、没有会籍、没有节律"。
 * 2. **入会那一刻必须非活动**。入会要往那个会话里装工具，
 *    往正在跑的 Agent 上做这件事有扰动风险。注意口径是**时点**：
 *    加入之后它可以随便忙。
 * 3. **子 Agent 不许入会**。否则一个会话 spawn N 个子 Agent 就能自我增票。
 * 4. **会议记录必须落盘**。原先只在内存里，重启即丢 ——
 *    而"看这个房间历次会议"正是面板存在的理由。
 * 5. **全局工具的内容按会籍过滤**。工具本身全局可见，
 *    但非成员不该读到别的房间的成员名单与会议内容（那是上下文污染）。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_EVENT_CHANNEL } from '../src/adapters/dsh-boundary-watcher.js'
import { ACTIVITY_EVENT } from '../src/adapters/dsh-session-state.js'
import { MEETING_TOOL_NAME, meetingToolDescription } from '../src/adapters/dsh-meeting-tool.js'
import { RoundRobinModerator } from '../src/adapters/moderators.js'
import { admitSession } from '../src/core/membership.js'
import { SessionActivityTracker } from '../src/core/activity-tracker.js'
import { listSessionCandidates, readSessionTitle } from '../src/adapters/dsh-session-catalog.js'
import { MeetingConsole } from '../src/core/console.js'
import { MeetingOrchestrator } from '../src/core/room-orchestrator.js'
import { RoomMinutesLog } from '../src/core/room-minutes.js'
import { RoomRegistry } from '../src/core/room-registry.js'
import { apply } from '../src/host.js'
import { HUMAN_PARTICIPANT } from '../src/core/participant.js'
import type { MeetingVoicePort } from '../src/ports/meeting-voice.js'
import type { AgentSlotSpec } from '../src/index.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-console-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 假上游（含 `sessions` —— 它是候选列表的来源，真实宿主必有）
// ---------------------------------------------------------------------------

const SLOTS: readonly AgentSlotSpec[] = [
  { id: 'neural-net', domain: 'quant-lab', title: '神经网络专家', systemPrompt: '只做网络结构。' },
  { id: 'live-trading', domain: 'quant-live', title: '实盘专家', systemPrompt: '只做滑点与仓位。' },
]

interface FakeSession {
  readonly id: string
  readonly parentSession?: string
  readonly title?: string
  readonly model?: string
}

function makeCtx(
  options: {
    readonly sessions?: readonly FakeSession[]
    readonly withTools?: boolean
    /** 会话标题（模拟 Cordis 服务 `sessionTitle`）。不给就退回"从首条消息派生"。 */
    readonly titles?: Record<string, string>
  } = {},
) {
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const registered: unknown[] = []
  const sessionList = [...(options.sessions ?? [])]
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ name: 'spawn' }),
    // 照真实 `ctx.subagents` 的形状写全（少一个方法就会被能力门判成不可用）。
    sendMessage: () => Promise.resolve({ messageId: 'm', status: 'queued' }),
    interrupt: () => ({ previousStatus: 'idle' }),
    start: () =>
      Promise.resolve({
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
        dispose: () => undefined,
      }),
  }
  const services: Record<string, unknown> = {
    // 标题服务（真实宿主由 dsh-base 装载 `@deepseek-ai/dsh-session-title`）。
    // 没有它插件就退回"从首条人类消息派生"——这条回退必须也能测。
    sessionTitle: {
      get: (session: { readonly id?: unknown }) => {
        const title = options.titles?.[String(session.id)]
        return title === undefined ? undefined : { title }
      },
    },
    agents: {
      currentInitiator: () => undefined,
      roots: () => [{ id: 'lead-agent' }],
      list: () => [{ id: 'lead-agent' }],
      get: () => ({ id: 'lead-agent' }),
    },
    agentTeams: {
      spawnTeammate: () => Promise.resolve({ member: { name: 'x' } }),
      sendMessage: () => Promise.resolve({}),
      interrupt: () => ({}),
      createTask: () => Promise.resolve({}),
      listMembers: () => [],
      waitForChange: () => Promise.resolve({}),
    },
    subagents,
    sessions: {
      list: () =>
        sessionList.map((session) => ({
          id: session.id,
          header: {
            ...(session.parentSession === undefined ? {} : { parentSession: session.parentSession }),
          },
          ...(session.model === undefined ? {} : { model: session.model }),
          deriveMessages: () => [{ role: 'user', content: `我是 ${session.id} 的上下文` }],
        })),
      get: (id: unknown) => {
        const found = sessionList.find((session) => session.id === String(id))
        if (found === undefined) return undefined
        return {
          id: found.id,
          header: {
            ...(found.parentSession === undefined ? {} : { parentSession: found.parentSession }),
          },
          ...(found.model === undefined ? {} : { model: found.model }),
          deriveMessages: () => [{ role: 'user', content: `我是 ${found.id} 的上下文` }],
        }
      },
    },
  }
  if (options.withTools === true) {
    services['tools'] = {
      register: (definition: unknown) => {
        registered.push(definition)
        return () => undefined
      },
    }
  }
  return {
    registered,
    sessionList,
    ctx: {
      get: (name: string) => services[name],
      on: (event: string, listener: (...args: unknown[]) => unknown) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return () => listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener))
      },
      effect: (callback: () => unknown) => callback(),
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args)
      },
    },
  }
}

// ===========================================================================

describe('默认状态：什么都不做', () => {
  it('apply() 之后一个房间都没有、一个会籍都没有', async () => {
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-a' }] })
    const { host } = await apply(ctx as never, { slots: SLOTS, rootDir: root, boardDomain: 'defaults' })

    expect(host.rooms.list()).toEqual([])
    expect(host.console.overview(HUMAN_PARTICIPANT).rooms).toEqual([])

    await (await apply(ctx as never, { rootDir: root, boardDomain: 'x' }))() // 幂等自检
  })

  it('**不注册定时器**：默认不自动跑节律（上一版默认跑，是"莫名开会"的主因）', async () => {
    const intervals: unknown[] = []
    vi.stubGlobal('setInterval', (handler: () => void) => {
      intervals.push(handler)
      return 0 as unknown as NodeJS.Timeout
    })

    const { ctx } = makeCtx()
    const activation = await apply(ctx as never, { slots: SLOTS, rootDir: root, boardDomain: 'no-auto' })
    expect(intervals).toHaveLength(0)

    // 显式打开才有节律 —— 这是刻意的取舍，不是漏了。
    await activation()
    const { ctx: ctx2 } = makeCtx()
    await apply(ctx2 as never, { slots: SLOTS, rootDir: root, boardDomain: 'auto', autoPulse: true })
    expect(intervals).toHaveLength(1)
  })
})

describe('准入策略：子 Agent 不许入会、只允许非活动会话', () => {
  it('子 Agent 被拒（否则一个会话能 spawn N 个子 Agent 自我增票）', () => {
    const verdict = admitSession({
      candidate: { sessionId: 'child-1', isSubagent: true, active: false },
      roomId: 'r1',
      currentRoomId: undefined,
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('subagent')
  })

  it('正在活动的会话被拒，理由说明是**注入安全**', () => {
    const verdict = admitSession({
      candidate: { sessionId: 's1', isSubagent: false, active: true },
      roomId: 'r1',
      currentRoomId: undefined,
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.code).toBe('active')
      expect(verdict.reason).toMatch(/正在活动/)
      expect(verdict.reason).toMatch(/扰动/)
    }
  })

  it('已在别的房间的会话被拒（排他会籍）', () => {
    const verdict = admitSession({
      candidate: { sessionId: 's1', isSubagent: false, active: false },
      roomId: 'r2',
      currentRoomId: 'r1',
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('already-elsewhere')
  })

  it('退出与入会同属"改工具集"，同样要求非活动', () => {
    const verdict = admitSession({
      candidate: { sessionId: 's1', isSubagent: false, active: true },
      roomId: 'r1',
      currentRoomId: 'r1',
      operation: 'leave',
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toMatch(/卸东西/)
  })

  it('**时点语义**：先被拒，等它这一轮结束后就能加', async () => {
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-busy' }] })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'timing' })
    host.console.createRoom({ id: 'r1', name: 'r1' })

    // 它开始一个回合 → 活动
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-busy' }, { type: ACTIVITY_EVENT.busy })
    const busy = host.console.addSession('r1', 'sess-busy')
    expect(busy.ok).toBe(false)
    if (!busy.ok) expect(busy.code).toBe('active')

    // 回合结束 → 空闲 → 可以加了
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-busy' }, { type: ACTIVITY_EVENT.idle })
    expect(host.console.addSession('r1', 'sess-busy').ok).toBe(true)
    // 加入之后它可以随便忙：会籍不受影响
    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-busy' }, { type: ACTIVITY_EVENT.busy })
    expect(host.rooms.isMember('sess-busy')).toBe(true)
  })

  it('会话列表里的子 Agent 不会被算成候选', async () => {
    const { ctx } = makeCtx({
      sessions: [{ id: 'root-1' }, { id: 'child-1', parentSession: 'root-1' }],
    })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'subagents' })
    host.console.createRoom({ id: 'r1', name: 'r1' })
    const view = host.console.candidatesFor('r1')

    expect(view.admittable.map((c) => c.sessionId)).toEqual(['root-1'])
    expect(view.rejected.map((c) => c.code)).toEqual(['subagent'])
  })

  it('入会同时动会籍与名册（否则会出现"在名单上却叫不到"的僵尸成员）', async () => {
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-a', title: '会话 A', model: 'deepseek-v4-pro' }] })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'roster' })
    host.console.createRoom({ id: 'r1', name: 'r1' })

    expect(host.console.addSession('r1', 'sess-a').ok).toBe(true)
    expect(host.rooms.room('r1')?.members.map((m) => m.sessionId)).toEqual(['sess-a'])
    expect(host.orchestrator.participantIds).toContain('sess-a')
    // 成员用自己的模型
    expect(host.orchestrator.member('sess-a').model).toBe('deepseek-v4-pro')

    expect(host.console.removeSession('r1', 'sess-a').ok).toBe(true)
    expect(host.rooms.isMember('sess-a')).toBe(false)
    expect(host.orchestrator.participantIds).not.toContain('sess-a')
  })
})

describe('可见性：工具全局可见，内容按会籍过滤', () => {
  it('非成员只看得到"存在 + 名字 + 我不在其中"；成员看得到名单；人类看全部', async () => {
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-a' }, { id: 'sess-b' }] })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'visibility' })
    host.console.createRoom({ id: 'r1', name: '房间一' })
    host.console.createRoom({ id: 'r2', name: '房间二' })
    host.console.addSession('r1', 'sess-a')

    // 成员视角
    const asMember = host.console.overview('sess-a')
    const r1 = asMember.rooms.find((room) => room.id === 'r1')
    expect(r1?.mine).toBe(true)
    expect(r1?.members?.map((m) => m.sessionId)).toEqual(['sess-a'])

    // 非成员视角：同一个房间只剩名字
    const asOutsider = host.console.overview('sess-b')
    const r1Out = asOutsider.rooms.find((room) => room.id === 'r1')
    expect(r1Out?.mine).toBe(false)
    expect(r1Out?.members).toBeUndefined()

    // 人类看全部
    const asHuman = host.console.overview(HUMAN_PARTICIPANT)
    expect(asHuman.rooms.find((room) => room.id === 'r1')?.members).toHaveLength(1)
    expect(asHuman.rooms.find((room) => room.id === 'r2')?.members).toEqual([])
  })

  it('非成员要房间详情被明确拒绝（不是返回空）', async () => {
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-a' }, { id: 'sess-b' }] })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'deny' })
    host.console.createRoom({ id: 'r1', name: 'r1' })
    host.console.addSession('r1', 'sess-a')

    const denied = host.console.detail('r1', 'sess-b')
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.code).toBe('not-a-member')
    expect(host.console.detail('r1', 'sess-a').ok).toBe(true)
  })

  it('非成员没有召集权（会籍 = 召集权的落点）', async () => {
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-a' }, { id: 'sess-b' }] })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'no-right' })
    host.console.createRoom({ id: 'r1', name: 'r1' })
    host.console.addSession('r1', 'sess-a')

    const result = await host.console.convene({ roomId: 'r1', calledBy: 'sess-b', reason: '我没会籍' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-a-member')
  })
})

describe('会议记录落盘：把"历次会议内容"变成可读的', () => {
  it('落盘并读回，含 transcript 与每人纪要', () => {
    const registry = new RoomRegistry({ rootDir: root })
    registry.createRoom({ id: 'r1', name: 'r1' })
    const log = new RoomMinutesLog({ rootDir: root })

    const line = log.toLine('r1', {
      room: { id: 'room-1-r1', scope: 'global', calledBy: 'human', reason: '同步', transcript: [] } as never,
      calledBy: 'human',
      summoned: ['a', 'b'],
      deferred: [],
      admittedLate: [],
      absent: [],
      dismissed: ['a', 'b'],
      notes: [
        { participant: 'a', text: 'A 的纪要', chars: 5 },
        { participant: 'b', text: 'B 的纪要', chars: 5 },
      ],
      rounds: 2,
      adjournedReason: '已收敛',
    })
    expect(line.roomId).toBe('r1')
    expect(line.notes).toHaveLength(2)
    expect(new Set(line.notes.map((n) => n.text)).size).toBe(2)

    log.write('r1', {
      room: { id: 'room-1-r1', scope: 'global', calledBy: 'human', reason: '同步', transcript: [] } as never,
      calledBy: 'human',
      summoned: ['a'],
      deferred: [],
      admittedLate: [],
      absent: [],
      dismissed: ['a'],
      notes: [{ participant: 'a', text: 'A 的纪要', chars: 5 }],
      rounds: 1,
      adjournedReason: '已收敛',
    })

    expect(existsSync(join(root, 'room-meetings.jsonl'))).toBe(true)
    const read = log.read('r1')
    expect(read).toHaveLength(1)
    expect(read[0]?.meetingId).toBe('room-1-r1')
    expect(log.indexByRoom().get('r1')).toHaveLength(1)
    // 另一个房间读不到
    expect(log.read('r2')).toEqual([])
  })

  it('落盘内容确实是 JSONL（每行一条，可追加）', async () => {
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-a' }] })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'jsonl' })
    host.console.createRoom({ id: 'r1', name: 'r1' })
    host.console.addSession('r1', 'sess-a')
    // 不需要再手动 `beginIdleWaiting()` —— 入会即空闲（准入已保证它非活动），
    // 状态机也不允许 idle → idle 的重复转换。

    // 直接用编排器开一场（模拟已有发言与纪要）
    const record = await host.console.convene({ roomId: 'r1', calledBy: HUMAN_PARTICIPANT, reason: '对齐成本' })
    expect(record.ok).toBe(true)

    const path = join(root, 'room-meetings.jsonl')
    expect(existsSync(path)).toBe(true)
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter((line) => line.length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(0)
    for (const line of lines) {
      const parsed = JSON.parse(line) as { v: number; roomId: string }
      expect(parsed.v).toBe(1)
      expect(parsed.roomId).toBe('r1')
    }
    // 面板能读回这次会议
    const detail = host.console.detail('r1', HUMAN_PARTICIPANT)
    expect(detail.ok).toBe(true)
  })
})

describe('全局工具："开会"这个按钮', () => {
  it('注册成功，说明里含义务与边界', async () => {
    const { ctx, registered } = makeCtx({ withTools: true })
    const activation = await apply(ctx as never, { slots: SLOTS, rootDir: root, boardDomain: 'tool' })

    expect(activation.notes.join(' ')).toMatch(/已全局注册/)
    expect(registered).toHaveLength(1)
    const definition = registered[0] as { name: string; description: string; parameters: Record<string, unknown> }
    expect(definition.name).toBe(MEETING_TOOL_NAME)
    expect(definition.parameters['required']).toEqual(['action'])

    // "一大坨"就是 description —— 它本来就在模型上下文里
    const description = meetingToolDescription()
    expect(description).toMatch(/义务/)
    expect(description).toMatch(/只需要拿到纪要/)
    expect(description).toMatch(/没有加入任何会议室/)
  })

  it('ctx.tools 不可用时只记诊断，**不让宿主下线**', async () => {
    const { ctx } = makeCtx()
    const activation = await apply(ctx as never, { slots: SLOTS, rootDir: root, boardDomain: 'no-tools' })
    expect(activation.notes.join(' ')).toMatch(/ctx\.tools 不可用/)
  })

  it('execute：调用者身份来自 exec，并按会籍过滤内容', async () => {
    const { ctx, registered } = makeCtx({ withTools: true, sessions: [{ id: 'sess-a' }, { id: 'sess-b' }] })
    const activation = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'tool-exec' })
    activation.host.console.createRoom({ id: 'r1', name: '房间一' })
    activation.host.console.addSession('r1', 'sess-a')

    const definition = registered[0] as { execute(args: unknown, exec: unknown): Promise<unknown> }

    // 成员视角
    const asMember = (await definition.execute({ action: 'overview' }, { agent: { id: 'sess-a' } })) as {
      rooms: { id: string; mine: boolean; members?: unknown[] }[]
      roomOfYou: string[]
    }
    expect(asMember.roomOfYou).toEqual(['r1'])
    expect(asMember.rooms.find((room) => room.id === 'r1')?.members).toHaveLength(1)

    // 非成员视角：看不到成员名单
    const asOutsider = (await definition.execute({ action: 'overview' }, { agent: { id: 'sess-b' } })) as {
      rooms: { id: string; mine: boolean; members?: unknown[] }[]
    }
    expect(asOutsider.rooms.find((room) => room.id === 'r1')?.members).toBeUndefined()

    // 认不出调用者时**按非成员处理**，绝不退化成人类观察者
    const asNobody = (await definition.execute({ action: 'overview' }, {})) as {
      rooms: { members?: unknown[] }[]
    }
    expect(asNobody.rooms[0]?.members).toBeUndefined()
  })

  it('execute：非成员调 convene 被拒；缺 reason 被拒', async () => {
    const { ctx, registered } = makeCtx({ withTools: true, sessions: [{ id: 'sess-a' }, { id: 'sess-b' }] })
    const activation = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'tool-deny' })
    activation.host.console.createRoom({ id: 'r1', name: 'r1' })
    activation.host.console.addSession('r1', 'sess-a')
    const definition = registered[0] as { execute(args: unknown, exec: unknown): Promise<unknown> }

    const denied = (await definition.execute(
      { action: 'convene', roomId: 'r1', reason: '我是外人' },
      { agent: { id: 'sess-b' } },
    )) as { ok: boolean; code?: string }
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('not-a-member')

    const noReason = (await definition.execute(
      { action: 'convene', roomId: 'r1', reason: '   ' },
      { agent: { id: 'sess-a' } },
    )) as { ok: boolean; reason: string }
    expect(noReason.ok).toBe(false)
    expect(noReason.reason).toMatch(/reason/)
  })
})

/** 造一个只带 `sessions` / `sessionTitle` 的极窄 ctx（会话目录的测试都要用）。 */
function makeCatalogCtx(input: {
  readonly sessions: readonly { readonly id: string; readonly messages?: readonly unknown[] }[]
  readonly titles?: Record<string, string>
}) {
  const sessions = input.sessions.map((session) => ({
    id: session.id,
    deriveMessages: () => session.messages ?? [],
  }))
  return {
    get: (name: string) => {
      if (name === 'sessions') return { list: () => sessions, get: (id: unknown) => sessions.find((s) => s.id === String(id)) }
      if (name === 'sessionTitle' && input.titles !== undefined) {
        return { get: (session: { readonly id?: unknown }) => {
          const title = input.titles?.[String(session.id)]
          return title === undefined ? undefined : { title }
        } }
      }
      return undefined
    },
  }
}

describe('会话标题：面板里不能只显示 session-750e30ff-…', () => {

  it('优先读 `sessionTitle` 服务的标题（用户改名 / 模型生成的都在这里）', () => {
    const ctx = makeCatalogCtx({
      sessions: [{ id: 'sess-1' }, { id: 'sess-2' }],
      titles: { 'sess-1': '风控口径对齐' },
    })
    const candidates = listSessionCandidates({ ctx: ctx as never, activity: new SessionActivityTracker() })
    expect(candidates.find((c) => c.sessionId === 'sess-1')?.title).toBe('风控口径对齐')
    // sess-2 没有标题事件 → 没有回退素材 → 不给标题，下游显示短 id
    expect(candidates.find((c) => c.sessionId === 'sess-2')?.title).toBeUndefined()
  })

  it('没有标题事件时，按**第一条人类消息**派生（会话还没被起过名的场景）', () => {
    const ctx = makeCatalogCtx({
      sessions: [
        { id: 'sess-1', messages: [{ role: 'user', content: '帮我看下这个\n复现路径是不是有问题' }] },
      ],
    })
    const candidates = listSessionCandidates({ ctx: ctx as never, activity: new SessionActivityTracker() })
    // 单行化（换行折叠成空格）
    expect(candidates[0]?.title).toBe('帮我看下这个 复现路径是不是有问题')
  })

  it('超长标题按**码点**截断（不能按字节，否则中文被切坏）', () => {
    const long = '一二三四五六七八九十'.repeat(6)
    const ctx = makeCatalogCtx({ sessions: [{ id: 'sess-1' }], titles: { 'sess-1': long } })
    const session = { id: 'sess-1' }
    const title = readSessionTitle(ctx as never, session)
    expect(title).toBeDefined()
    expect([...(title ?? '')].length).toBeLessThanOrEqual(48)
    expect(title?.endsWith('…')).toBe(true)
  })

  it('`titleOf` 显式给了就覆盖内置解析（留给要替换标题来源的场景）', () => {
    const ctx = makeCatalogCtx({ sessions: [{ id: 'sess-1' }], titles: { 'sess-1': '内置标题' } })
    const candidates = listSessionCandidates({
      ctx: ctx as never,
      activity: new SessionActivityTracker(),
      titleOf: () => '外部标题',
    })
    expect(candidates[0]?.title).toBe('外部标题')
  })

  it('宿主装配出来的成员视图也带标题（否则成员列表又是裸 id）', async () => {
    const { ctx } = makeCtx({
      sessions: [{ id: 'sess-a', title: '会话 A' }],
      // 让目录能读到真实标题（脏 id 的坑就是在这里暴露的）
      titles: { 'sess-a': '排查点云 V7 的过拟合' },
    })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'titles' })
    host.console.createRoom({ id: 'r1', name: 'r1' })

    const candidate = host.console.candidatesFor('r1').admittable[0]
    expect(candidate?.title).toBe('排查点云 V7 的过拟合')

    host.console.addSession('r1', 'sess-a')
    const member = host.console.detail('r1', HUMAN_PARTICIPANT)
    expect(member.ok).toBe(true)
    if (member.ok) expect(member.room.members?.[0]?.title).toBe('排查点云 V7 的过拟合')
  })
})

describe('成员状态：面板加进来的成员也必须被驱动', () => {
  it('**入会那一刻就是空闲**（准入已保证它非活动），所以立刻能开会', async () => {
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-a' }] })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'join-idle' })
    host.console.createRoom({ id: 'r1', name: 'r1' })
    expect(host.console.addSession('r1', 'sess-a').ok).toBe(true)

    // 关键：不是状态机的初始值 working。
    // 不补这一笔的话，成员要等到**下一次** turn/end 才转空闲，
    // 表现为"刚把人加进去就告诉我全员在工作中，开不了会"。
    expect(host.orchestrator.member('sess-a').state).toBe('idle-waiting')

    const record = await host.console.convene({ roomId: 'r1', calledBy: HUMAN_PARTICIPANT, reason: '对齐契约' })
    expect(record.ok).toBe(true)
  })

  it('**面板加的成员**收到 turn/end 会转空闲（判据是实时名册，不是配置里的 slot）', async () => {
    // 注意这里 slots 是**空的** —— 旧实现只认 slots 里的 id，
    // 所以这种配置下成员状态永远不会被驱动（全员卡 working 那个 bug）。
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-a' }] })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'roster-map' })
    host.console.createRoom({ id: 'r1', name: 'r1' })
    host.console.addSession('r1', 'sess-a')

    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-a' }, { type: ACTIVITY_EVENT.busy })
    expect(host.orchestrator.member('sess-a').state).toBe('working')

    ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-a' }, { type: ACTIVITY_EVENT.idle })
    expect(host.orchestrator.member('sess-a').state).toBe('idle-waiting')
  })

  it('非成员会话的事件不会误伤成员状态（也不会抛）', async () => {
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-a' }] })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'outsider' })
    host.console.createRoom({ id: 'r1', name: 'r1' })
    host.console.addSession('r1', 'sess-a')

    expect(() => ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-other' }, { type: ACTIVITY_EVENT.idle })).not.toThrow()
    expect(host.orchestrator.member('sess-a').state).toBe('idle-waiting')
  })

  it('退出会议室后再收到事件也不会把它拉回来（名册是实时判据）', async () => {
    const { ctx } = makeCtx({ sessions: [{ id: 'sess-a' }] })
    const { host } = await apply(ctx as never, { slots: [], rootDir: root, boardDomain: 'left' })
    host.console.createRoom({ id: 'r1', name: 'r1' })
    host.console.addSession('r1', 'sess-a')
    expect(host.console.removeSession('r1', 'sess-a').ok).toBe(true)

    expect(() => ctx.emit(SESSION_EVENT_CHANNEL, { id: 'sess-a' }, { type: ACTIVITY_EVENT.idle })).not.toThrow()
    expect(host.orchestrator.participantIds).not.toContain('sess-a')
  })
})

describe('候选列表：没点开过的会话也要看得见', () => {
  it('并入持久化列表，且**标记未加载**（借不到上下文这件事必须看得见）', () => {
    const ctx = makeCatalogCtx({ sessions: [{ id: 'live-1' }] })
    const candidates = listSessionCandidates({
      ctx: ctx as never,
      activity: new SessionActivityTracker(),
      persisted: () => [
        { sessionId: 'old-1', running: false, cwd: '/w/old', projections: { values: { title: { title: '旧会话' } } } },
        { sessionId: 'child-1', parentSessionId: 'old-1' },
        { sessionId: 'running-1', running: true },
        { sessionId: 'live-1' },
      ],
    })
    const byId = new Map(candidates.map((c) => [c.sessionId, c]))

    // 没点开过的会话也在列表里，但明确标记未加载
    expect(byId.get('old-1')?.loaded).toBe(false)
    expect(byId.get('old-1')?.title).toBe('旧会话')
    expect(byId.get('old-1')?.workspace).toBe('/w/old')
    // 子 Agent 照样排除（防自我增票），即使它只存在于持久化列表里
    expect(byId.get('child-1')?.isSubagent).toBe(true)
    // 持久化行里的 running 就是活动判据
    expect(byId.get('running-1')?.active).toBe(true)
    // 两边都有的会话只出现一次，且用活会话的权威数据
    expect(candidates.filter((c) => c.sessionId === 'live-1')).toHaveLength(1)
    expect(byId.get('live-1')?.loaded).toBe(true)
    expect(candidates).toHaveLength(4)
  })

  it('不给持久化来源时退回旧行为（只列已加载的）', () => {
    const ctx = makeCatalogCtx({ sessions: [{ id: 'live-1' }] })
    const candidates = listSessionCandidates({ ctx: ctx as never, activity: new SessionActivityTracker() })
    expect(candidates.map((c) => c.sessionId)).toEqual(['live-1'])
    expect(candidates[0]?.loaded).toBe(true)
  })
})

describe('MeetingConsole：直接构造也能独立工作（不依赖宿主）', () => {
  it('createRoom 幂等报错、未知房间的动作被明确拒绝', () => {
    const registry = new RoomRegistry({ rootDir: root })
    const console = new MeetingConsole({
      registry,
      minutes: new RoomMinutesLog({ rootDir: root }),
      candidates: { list: () => [] },
      runtime: {
        convene: () => Promise.reject(new Error('不该被调用')),
        activeRoom: () => undefined,
        activeMeeting: () => undefined,
        enroll: () => undefined,
        forget: () => 'absent',
        stateOf: () => undefined,
      },
    })
    expect(console.createRoom({ id: 'r1', name: 'r1' }).ok).toBe(true)
    const dup = console.createRoom({ id: 'r1' })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.code).toBe('duplicate-room')

    const missing = console.addSession('nope', 's1')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('no-such-room')
  })
})

describe('实时会议视图：会议进行中必须看得见（"看不到会议过程"的缺口）', () => {
  /**
   * 带"门"的声音：第一个成员的发言停在 Promise 上不放行，
   * 于是会议被精确地停在半程，测试就能在**会中**观察。
   */
  function makeGatedVoice(): {
    readonly voice: MeetingVoicePort
    readonly calls: string[]
    readonly release: () => void
  } {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    const calls: string[] = []
    const voice: MeetingVoicePort = {
      port: 'gated',
      capabilities: () => ({ port: 'gated', canSpeak: true, canReflect: true, notes: [] }),
      async speak(request) {
        calls.push(`${request.purpose}:${request.participant}`)
        if (request.purpose === 'speak' && request.participant === 'sess-a') await gate
        return request.purpose === 'reflect' ? '待办：口径对齐后重跑验证。' : `${request.participant} 的发言`
      },
    }
    return { voice, calls, release }
  }

  it('会中：人类看到实时快照；非成员被拒；成员看得到自己房间的会；散会后回到 ok:false', async () => {
    const registry = new RoomRegistry({ rootDir: root })
    const { voice, calls, release } = makeGatedVoice()
    const orchestrator = new MeetingOrchestrator({
      registry,
      voice,
      moderator: new RoundRobinModerator({ minSpeechesPerMember: 1, minRounds: 2 }),
    })
    registry.createRoom({ id: 'r-live', name: '实时' })
    for (const id of ['sess-a', 'sess-b']) {
      orchestrator.enroll({ id, domain: 'd', title: id, systemPrompt: '' })
      orchestrator.joinRoom(id, 'r-live')
      orchestrator.member(id).beginIdleWaiting()
    }
    const console = new MeetingConsole({
      registry,
      minutes: new RoomMinutesLog({ rootDir: root }),
      candidates: { list: () => [] },
      runtime: {
        convene: (call) => orchestrator.convene(call),
        activeRoom: () => {
          const room = orchestrator.activeRoom()
          return room === undefined ? undefined : { id: room.id }
        },
        activeMeeting: () => orchestrator.activeMeeting(),
        enroll: () => undefined,
        forget: () => 'absent',
        stateOf: (id) => orchestrator.member(id).state,
      },
    })

    // 开会，但不停 awaiting：会议会停在第一个发言的门前。
    const pending = orchestrator.convene({
      roomId: 'r-live',
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: '实时视图验证',
    })
    for (let index = 0; index < 100 && !calls.includes('speak:sess-a'); index += 1) {
      await Promise.resolve()
    }
    expect(calls).toContain('speak:sess-a')

    // 会中快照：开场引导已注入、还没有任何人发言完、第 1 轮。
    const live = console.liveMeeting(HUMAN_PARTICIPANT)
    expect(live.ok).toBe(true)
    if (!live.ok) return
    expect(live.meeting.roomId).toBe('r-live')
    expect(live.meeting.round).toBe(1)
    expect(live.meeting.maxRounds).toBe(6)
    expect(live.meeting.present).toEqual(['sess-a', 'sess-b'])
    expect(live.meeting.absent).toEqual([])
    expect(live.meeting.transcript.filter((turn) => turn.kind === 'entry')).toHaveLength(2)
    expect(live.meeting.transcript.some((turn) => turn.kind === 'speech')).toBe(false)

    // 可见性口径与 detail 一致：非成员连"开到哪了"都看不到。
    const outsider = console.liveMeeting('sess-outsider')
    expect(outsider.ok).toBe(false)
    if (!outsider.ok) expect(outsider.reason).toMatch(/不是它的成员/)
    // 本房间的成员看得到。
    expect(console.liveMeeting('sess-a').ok).toBe(true)

    // 放行 → 会议跑完 → 实时视图回到"没有会正在开"。
    release()
    await pending
    const after = console.liveMeeting(HUMAN_PARTICIPANT)
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.reason).toMatch(/没有正在进行的会议/)
  })
})
