/**
 * 面板端点（Typert Remote）的契约测试。
 *
 * ## 为什么这组测试必须存在
 *
 * `src/adapters/dsh-meeting-remote.ts` 是**按契约复刻**上游，而不是 import 上游包
 * （import 会引入第二份 cordis，那是本仓库一直在避免的问题）。复刻的代价是：
 * **上游改了契约，我们这边是静默失效**——端点直接 404，面板一片空白，
 * 没有任何异常提示。
 *
 * 所以这里把上游那三条硬要求逐条钉成断言：
 *
 * 1. `ctx.provide(key, value)` 必须把 key 变成 `{ type: 'service' }`（gateway 按此发现）；
 * 2. 服务实例上的 `typertRemote.service` 必须**严格等于实例自身**
 *    （上游 `readBinding` 是 `!==` 就抛 `gateway/binding-invalid`）；
 * 3. 原型上那个**普通字符串键**的描述符必须存在、且 version 为 1、invocation 为 direct。
 *
 * 另外把"形参名即 wire 字段名"这条也钉住：上游 `assertExactArguments` 要求
 * 实参键与形参名完全一致，所以每个方法都必须**恰好一个名为 `request` 的形参**，
 * 且不能有 `signal`（上游会把它当取消通道，改变调用语义）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MEETING_REMOTE_NAMESPACE,
  MEETING_REMOTE_SERVICE,
  registerMeetingRemote,
} from '../src/adapters/dsh-meeting-remote.js'
import { MeetingConsole } from '../src/core/console.js'
import { RoomMinutesLog } from '../src/core/room-minutes.js'
import { RoomRegistry } from '../src/core/room-registry.js'
import { HUMAN_PARTICIPANT } from '../src/core/participant.js'
import type { ActiveMeetingView } from '../src/core/room-orchestrator.js'

/** 上游 `dsh-typert-protocol` 里那个描述符键的**字面量**。改上游 = 改这里。 */
const UPSTREAM_DESCRIPTOR_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

const EXPECTED_METHODS = [
  'overview',
  'detail',
  'liveMeeting',
  'candidates',
  'createRoom',
  'addSession',
  'removeSession',
  'convene',
] as const

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-remote-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface FakeProvide {
  readonly ctx: unknown
  readonly provides: { readonly name: string; readonly value: unknown }[]
  readonly disposeCalls: { count: number }
}

function makeCtx(options: { readonly provide?: 'ok' | 'missing' | 'throws' } = {}): FakeProvide {
  const mode = options.provide ?? 'ok'
  const provides: { name: string; value: unknown }[] = []
  const disposeCalls = { count: 0 }
  const ctx: Record<string, unknown> = {
    get: () => undefined,
  }
  if (mode === 'ok') {
    ctx['provide'] = (name: string, value: unknown) => {
      provides.push({ name, value })
      return () => {
        disposeCalls.count += 1
      }
    }
  }
  if (mode === 'throws') {
    ctx['provide'] = (name: string, value: unknown) => {
      provides.push({ name, value })
      throw new Error('service "meetingConsole" has been registered at <someone-else>')
    }
  }
  return { ctx, provides, disposeCalls }
}

/** 一个能独立工作的真实数据面（不依赖宿主）。 */
function makeConsole(
  sessionIds: readonly string[],
  options?: { readonly activeMeeting?: ActiveMeetingView | undefined },
): MeetingConsole {
  const registry = new RoomRegistry({ rootDir: root })
  return new MeetingConsole({
    registry,
    minutes: new RoomMinutesLog({ rootDir: root }),
    candidates: {
      list: () => sessionIds.map((sessionId) => ({ sessionId, isSubagent: false, active: false, title: sessionId })),
    },
    runtime: {
      convene: () => Promise.reject(new Error('本测试不真的开会')),
      activeRoom: () => (options?.activeMeeting === undefined ? undefined : { id: options.activeMeeting.roomId }),
      activeMeeting: () => options?.activeMeeting,
      enroll: () => undefined,
      forget: () => 'absent',
      stateOf: (sessionId) => (sessionId.startsWith('busy') ? 'working' : 'idle-waiting'),
    },
  })
}

function serviceOf(provides: readonly { readonly name: string; readonly value: unknown }[]): Record<string, unknown> {
  const hit = provides.find((entry) => entry.name === MEETING_REMOTE_SERVICE)
  expect(hit, `没有登记名为 ${MEETING_REMOTE_SERVICE} 的服务`).toBeDefined()
  return hit!.value as Record<string, unknown>
}

// ===========================================================================

describe('Typert Remote 契约：按上游要求复刻，不 import 上游', () => {
  it('登记成 Cordis 服务，键与命名空间正确', () => {
    const { ctx, provides } = makeCtx()
    const handle = registerMeetingRemote({ ctx, console: makeConsole([]) })

    expect(handle.registered).toBe(true)
    expect(handle.serviceKey).toBe(MEETING_REMOTE_SERVICE)
    expect(handle.namespace).toBe(MEETING_REMOTE_NAMESPACE)
    expect(provides.map((entry) => entry.name)).toEqual([MEETING_REMOTE_SERVICE])
    expect(handle.notes.join(' ')).toMatch(/已注册会议室面板端点/)
  })

  it('**binding.service 严格等于服务实例自身**（上游 !== 就抛 binding-invalid）', () => {
    const { ctx, provides } = makeCtx()
    registerMeetingRemote({ ctx, console: makeConsole([]) })
    const service = serviceOf(provides)

    const binding = service['typertRemote'] as Record<string, unknown> | undefined
    expect(binding).toBeDefined()
    // 用的是同一个对象引用，不是副本 —— 这一点上游是 `!==` 判定的。
    expect(binding!['service']).toBe(service)
    expect(binding!['serviceKey']).toBe(MEETING_REMOTE_SERVICE)
    expect(typeof binding!['namespace']).toBe('string')
    expect(binding!['namespace']).toBe(MEETING_REMOTE_NAMESPACE)
  })

  it('**原型上有那个普通字符串键的描述符**，version=1、7 个 direct 端点', () => {
    const { ctx, provides } = makeCtx()
    registerMeetingRemote({ ctx, console: makeConsole([]) })
    const service = serviceOf(provides)
    const prototype = Object.getPrototypeOf(service) as object

    // 关键：这是 getOwnPropertyDescriptor 能读到的**自有属性**，不是继承来的。
    const descriptor = Object.getOwnPropertyDescriptor(prototype, UPSTREAM_DESCRIPTOR_KEY)
    expect(descriptor, '描述符键必须与上游字面量完全一致（改了上游就等于端点 404）').toBeDefined()

    const value = descriptor!.value as { version: number; methods: readonly { method: string; invocation: { kind: string } }[] }
    expect(value.version).toBe(1)
    expect(value.methods.map((marker) => marker.method)).toEqual([...EXPECTED_METHODS])
    for (const marker of value.methods) {
      expect(marker.invocation.kind).toBe('direct')
    }
    expect(handle0(provides).methods).toEqual([...EXPECTED_METHODS])
  })

  it('每个方法**恰好一个名为 request 的形参**，且没有 signal', () => {
    const { ctx, provides } = makeCtx()
    registerMeetingRemote({ ctx, console: makeConsole([]) })
    const service = serviceOf(provides)

    for (const method of EXPECTED_METHODS) {
      const fn = service[method] as ((...args: unknown[]) => unknown) | undefined
      expect(typeof fn, `${method} 必须是函数`).toBe('function')
      const signature = /\(([^)]*)\)/.exec(fn!.toString())
      expect(signature, `${method} 的签名读不出来`).not.toBeNull()
      const params = (signature?.[1] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
      // 实参键与形参名必须一致，所以形参名就是 wire 字段名。
      expect(params, `${method} 的参数必须是恰好一个 request`).toEqual(['request'])
      expect(params).not.toContain('signal')
    }
  })

  it('直接调用真的走数据面（读、建房间、加人、移人）', async () => {
    const console = makeConsole(['sess-a', 'sess-b'])
    const { ctx, provides } = makeCtx()
    registerMeetingRemote({ ctx, console })
    const service = serviceOf(provides)

    const call = (method: string, request: unknown): Promise<unknown> =>
      (service[method] as (request: unknown) => Promise<unknown>)(request)

    // 默认空：一个房间都没有
    const empty = (await call('overview', { viewerId: HUMAN_PARTICIPANT })) as { rooms: unknown[] }
    expect(empty.rooms).toEqual([])

    const created = (await call('createRoom', { id: 'r1', name: '房间一' })) as { ok: boolean }
    expect(created.ok).toBe(true)

    const added = (await call('addSession', { roomId: 'r1', sessionId: 'sess-a' })) as { ok: boolean }
    expect(added.ok).toBe(true)

    // 面板是给**人**看的，所以固定看全量
    const view = (await call('overview', { viewerId: HUMAN_PARTICIPANT })) as {
      rooms: { id: string; name: string; members?: { sessionId: string; state?: string }[] }[]
    }
    expect(view.rooms).toHaveLength(1)
    expect(view.rooms[0]?.members?.map((member) => member.sessionId)).toEqual(['sess-a'])
    expect(view.rooms[0]?.members?.[0]?.state).toBe('idle-waiting')

    // 候选列表分"能加 / 加不了（附理由）"
    const candidates = (await call('candidates', { roomId: 'r1' })) as { rejected: { code: string; reason: string }[] }
    expect(candidates.rejected.some((entry) => entry.code === 'already-member')).toBe(true)

    const removed = (await call('removeSession', { roomId: 'r1', sessionId: 'sess-a' })) as { ok: boolean }
    expect(removed.ok).toBe(true)

    const detail = (await call('detail', { roomId: 'r1', viewerId: HUMAN_PARTICIPANT })) as { ok: boolean; meetings: unknown[] }
    expect(detail.ok).toBe(true)
    expect(detail.meetings).toEqual([])
  })

  it('空会议室 id 被明确拒绝（不是静默建一个无名房间）', async () => {
    const { ctx, provides } = makeCtx()
    registerMeetingRemote({ ctx, console: makeConsole([]) })
    const service = serviceOf(provides)
    const result = (await (service['createRoom'] as (request: unknown) => Promise<unknown>)({ id: '   ' })) as {
      ok: boolean
      reason: string
    }
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/不能为空/)
  })

  it('liveMeeting：没有会正在开时 ok:false（正常分支，不是错误）', async () => {
    const { ctx, provides } = makeCtx()
    registerMeetingRemote({ ctx, console: makeConsole(['sess-a']) })
    const service = serviceOf(provides)

    const view = (await (service['liveMeeting'] as (request: unknown) => Promise<unknown>)({
      viewerId: HUMAN_PARTICIPANT,
    })) as { ok: boolean; reason?: string }
    expect(view.ok).toBe(false)
    expect(view.reason).toMatch(/没有正在进行的会议/)
  })

  it('liveMeeting：会议进行中时返回实时快照（轮次 / 在场 / transcript）', async () => {
    const active: ActiveMeetingView = {
      roomId: 'r1',
      meetingId: 'room-1-r1',
      scope: 'global',
      calledBy: HUMAN_PARTICIPANT,
      reason: '对齐口径',
      round: 2,
      maxRounds: 6,
      present: ['sess-a', 'sess-b'],
      absent: [],
      transcript: [
        { seq: 1, round: 1, speaker: 'sess-a', kind: 'speech', text: '第一轮发言', at: 1790000000000 },
        { seq: 2, round: 2, speaker: 'sess-b', kind: 'speech', text: '第二轮发言', at: 1790000001000 },
      ],
    }
    const { ctx, provides } = makeCtx()
    registerMeetingRemote({ ctx, console: makeConsole(['sess-a', 'sess-b'], { activeMeeting: active }) })
    const service = serviceOf(provides)

    const view = (await (service['liveMeeting'] as (request: unknown) => Promise<unknown>)({
      viewerId: HUMAN_PARTICIPANT,
    })) as { ok: boolean; meeting?: ActiveMeetingView }
    expect(view.ok).toBe(true)
    expect(view.meeting?.round).toBe(2)
    expect(view.meeting?.present).toEqual(['sess-a', 'sess-b'])
    expect(view.meeting?.transcript.map((turn) => turn.text)).toEqual(['第一轮发言', '第二轮发言'])
  })
})

describe('面板端点坏掉也不能把宿主带下线', () => {
  it('ctx 没有 provide → 只记诊断，不抛', () => {
    const { ctx } = makeCtx({ provide: 'missing' })
    const handle = registerMeetingRemote({ ctx, console: makeConsole([]) })
    expect(handle.registered).toBe(false)
    expect(handle.notes.join(' ')).toMatch(/没有 provide/)
  })

  it('服务键已被占用（provide 抛错）→ 只记诊断，不抛', () => {
    const { ctx } = makeCtx({ provide: 'throws' })
    const handle = registerMeetingRemote({ ctx, console: makeConsole([]) })
    expect(handle.registered).toBe(false)
    expect(handle.notes.join(' ')).toMatch(/注册会议室面板端点失败/)
  })

  it('dispose 会真的注销（否则重载后端点会重复登记）', () => {
    const { ctx, disposeCalls } = makeCtx()
    const handle = registerMeetingRemote({ ctx, console: makeConsole([]) })
    expect(disposeCalls.count).toBe(0)
    handle.dispose()
    expect(disposeCalls.count).toBe(1)
  })
})

/** 小工具：从 provide 记录里取 handle 视图（只用到 methods 字段）。 */
function handle0(provides: readonly { readonly name: string; readonly value: unknown }[]): { methods: readonly string[] } {
  const names = Object.getOwnPropertyNames(Object.getPrototypeOf(serviceOf(provides)))
  return { methods: names.filter((name) => name !== UPSTREAM_DESCRIPTOR_KEY) }
}
