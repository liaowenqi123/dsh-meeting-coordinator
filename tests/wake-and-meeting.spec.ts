/**
 * 「开会」与「互相唤起」的机制测试 —— 这是本插件最核心的一组断言。
 *
 * 三件事必须成立：
 * 1. 任何成员都能召集（不只是协调器）；
 * 2. 投递使用 wake 语义，能把 idle 的同伴真正叫起来（idle → running）；
 * 3. 成员收到摘要后能再召集，形成可审计的唤起链，且有节流兜底。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BriefingBoard, DEFAULT_MAX_BRIEFING_CHARS, MeetingCoordinator } from '../src/index.js'
import { InMemoryAgentRuntime } from '../src/adapters/in-memory-runtime.js'
import type { AgentSlotSpec } from '../src/index.js'

let root: string
let clock: number
const now = (): number => clock

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-meeting-wake-'))
  clock = Date.parse('2026-01-01T00:00:00.000Z')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const SLOTS: readonly AgentSlotSpec[] = [
  { id: 'alpha', domain: 'alpha', title: 'A', systemPrompt: '只做 A 方向。' },
  { id: 'beta', domain: 'beta', title: 'B', systemPrompt: '只做 B 方向。' },
  { id: 'gamma', domain: 'gamma', title: 'C', systemPrompt: '只做 C 方向。' },
]

function setup(options?: { minCallIntervalMs?: number }) {
  const runtime = new InMemoryAgentRuntime()
  const board = new BriefingBoard({
    rootDir: root,
    boardDomain: 'quant',
    maxBriefingChars: DEFAULT_MAX_BRIEFING_CHARS,
    maxAgendaChars: 1200,
    now,
  })
  const coordinator = new MeetingCoordinator({
    board,
    runtime,
    slots: SLOTS,
    now,
    policy: {
      everyMs: 0,
      everyRounds: 0,
      onStall: true,
      minIntervalMs: 0,
      periodicScope: 'global',
      minCallIntervalMs: options?.minCallIntervalMs ?? 0,
    },
  })
  return { runtime, board, coordinator }
}

describe('互相唤起：投递即唤醒', () => {
  it('wake 语义把空闲成员从 idle 叫起来并进入 running', async () => {
    const { runtime, coordinator } = setup()
    await coordinator.start()
    for (const slot of coordinator.slotIds) runtime.markIdle(slot)

    const result = await coordinator.callMeeting({ calledBy: 'alpha', scope: 'global', reason: '里程碑' })
    expect(result.accepted).toBe(true)
    if (!result.accepted) return

    // 全体都被唤起。
    expect([...result.meeting.woke].sort()).toEqual(['alpha', 'beta', 'gamma'])
    for (const slot of coordinator.slotIds) {
      expect(runtime.state(slot)).toBe('running')
      expect(runtime.wakeCount(slot)).toBe(1)
    }
  })

  it('steer 语义不会唤起空闲成员 —— 两种语义确实不同', async () => {
    const runtime = new InMemoryAgentRuntime()
    const handle = await runtime.spawn(SLOTS[0] as AgentSlotSpec)
    runtime.markIdle('alpha')

    await runtime.deliver(handle, { kind: 'stall-notice', mode: 'steer', text: '提醒' })
    expect(runtime.state('alpha')).toBe('idle')
    expect(runtime.wakeCount('alpha')).toBe(0)
    // 投递没有被丢掉，但仍处于排队状态 —— 差异被显式计数而不是静默吞掉。
    expect(runtime.steerWhileIdle('alpha')).toBe(1)

    await runtime.deliver(handle, { kind: 'meeting-digest', mode: 'wake', text: '摘要' })
    expect(runtime.state('alpha')).toBe('running')
    expect(runtime.wakeCount('alpha')).toBe(1)
  })

  it('关键区分：wake 投递的正文是限长摘要，而不是任何成员的私有上下文', async () => {
    const { runtime, coordinator } = setup()
    await coordinator.start()
    runtime.recordPrivate('alpha', '【私有-alpha】420 万行实验日志')
    runtime.recordPrivate('beta', '【私有-beta】980 万行实验日志')

    coordinator.publish({ slot: 'alpha', domain: 'alpha', round: 1, status: 'A 完成了第一步' })
    coordinator.publish({
      slot: 'beta',
      domain: 'beta',
      round: 1,
      status: 'B 卡住了',
      blocker: '同一个止损反复触发',
      requestedFrom: ['alpha'],
    })

    const result = await coordinator.callMeeting({ calledBy: 'beta', scope: 'global', reason: '求助' })
    expect(result.accepted).toBe(true)

    // 唤醒正文包含被授权的简报…
    expect(runtime.contextContains('alpha', 'B 卡住了')).toBe(true)
    // …但不包含任何私有笔记。
    expect(runtime.contextContains('alpha', '【私有-beta】')).toBe(false)
    expect(runtime.contextContains('beta', '【私有-alpha】')).toBe(false)
  })
})

describe('任何成员都能召集（大会 / 小会）', () => {
  it('成员发起的召集被接受，并记录 calledBy 与 inResponseTo', async () => {
    const { coordinator } = setup()
    await coordinator.start()
    coordinator.publish({ slot: 'alpha', domain: 'alpha', round: 1, status: 'ok' })

    const first = await coordinator.callMeeting({ calledBy: 'alpha', scope: 'global', reason: '第一次' })
    expect(first.accepted).toBe(true)
    if (!first.accepted) return
    expect(first.meeting.calledBy).toBe('alpha')
    expect(first.meeting.inResponseTo).toBeNull()

    const second = await coordinator.callMeeting({
      calledBy: 'beta',
      scope: 'local',
      reason: '响应式再召集',
      inResponseTo: first.meeting.agenda.id,
      invitees: ['gamma'],
    })
    expect(second.accepted).toBe(true)
    if (!second.accepted) return
    expect(second.meeting.inResponseTo).toBe(first.meeting.agenda.id)
    // 显式 invitees 生效：只叫 gamma，不叫 alpha。
    expect(second.meeting.agenda.participants).toEqual(['gamma'])
  })

  it('小会默认只叫有障碍/有诉求的成员，避免污染健康成员的上下文', async () => {
    const { coordinator } = setup()
    await coordinator.start()
    coordinator.publish({ slot: 'alpha', domain: 'alpha', round: 1, status: '一切正常' })
    coordinator.publish({
      slot: 'beta',
      domain: 'beta',
      round: 1,
      status: '卡住',
      blocker: '止损反复触发',
      requestedFrom: ['gamma'],
    })

    // 不带 invitees 的 local 会议：alpha 健康，不应被叫进来。
    const result = await coordinator.callMeeting({ calledBy: 'beta', scope: 'local', reason: '局部求助' })
    expect(result.accepted).toBe(true)
    if (!result.accepted) return
    expect(result.meeting.agenda.participants).toEqual(['beta', 'gamma'])
    expect(result.meeting.agenda.participants).not.toContain('alpha')
  })

  it('未注册的槽位不能召集', async () => {
    const { coordinator } = setup()
    await coordinator.start()
    const result = await coordinator.callMeeting({ calledBy: '外部人', scope: 'global', reason: '插队' })
    expect(result.accepted).toBe(false)
  })

  it('没有 reason 的召集被拒绝（无议题的会只制造噪声）', async () => {
    const { coordinator } = setup()
    await coordinator.start()
    const result = await coordinator.callMeeting({ calledBy: 'alpha', scope: 'global', reason: '   ' })
    expect(result.accepted).toBe(false)
  })

  it('召集节流：同一成员短时间内第二次召集被拒，且理由明确带回发起者', async () => {
    const { coordinator } = setup({ minCallIntervalMs: 60_000 })
    await coordinator.start()

    const first = await coordinator.callMeeting({ calledBy: 'alpha', scope: 'global', reason: '第一次' })
    expect(first.accepted).toBe(true)

    const second = await coordinator.callMeeting({ calledBy: 'alpha', scope: 'global', reason: '立刻再来' })
    expect(second.accepted).toBe(false)
    if (!second.accepted) expect(second.reason).toMatch(/过于频繁/)

    // 另一个成员不受别人节流的影响。
    const other = await coordinator.callMeeting({ calledBy: 'beta', scope: 'global', reason: 'B 的会' })
    expect(other.accepted).toBe(true)

    clock += 61_000
    const third = await coordinator.callMeeting({ calledBy: 'alpha', scope: 'global', reason: '时间到了' })
    expect(third.accepted).toBe(true)
  })
})

describe('唤起链可审计', () => {
  it('wakeGraph 记录 A 唤起 B、B 唤起 C 的链条', async () => {
    const { coordinator, runtime } = setup()
    await coordinator.start()

    const first = await coordinator.callMeeting({ calledBy: 'alpha', scope: 'global', reason: '开局' })
    expect(first.accepted).toBe(true)
    if (!first.accepted) return
    // 成员干完活回到空闲，等着被下一次唤起 —— 这才是"互相唤起"的常态。
    runtime.markIdle('gamma')

    const second = await coordinator.callMeeting({
      calledBy: 'beta',
      scope: 'local',
      reason: '响应 alpha',
      inResponseTo: first.meeting.agenda.id,
      invitees: ['gamma'],
    })
    expect(second.accepted).toBe(true)
    if (!second.accepted) return
    runtime.markIdle('alpha')

    const third = await coordinator.callMeeting({
      calledBy: 'gamma',
      scope: 'local',
      reason: '响应 beta',
      inResponseTo: second.meeting.agenda.id,
      invitees: ['alpha'],
    })
    expect(third.accepted).toBe(true)
    if (!third.accepted) return

    expect(coordinator.wakeGraph()).toEqual([
      { from: first.meeting.agenda.id, to: second.meeting.agenda.id, by: 'beta' },
      { from: second.meeting.agenda.id, to: third.meeting.agenda.id, by: 'gamma' },
    ])
    // 唤起次数只在 idle -> running 时递增，因此"被唤起过两次"是真的被重新叫起来两次。
    expect(runtime.wakeCount('alpha')).toBe(2)
    expect(runtime.wakeCount('beta')).toBe(1)
    expect(runtime.wakeCount('gamma')).toBe(2)
  })

  it('会议记录落盘 meetings.jsonl，含 calledBy / woke 名单，可审计', async () => {
    const { coordinator, board } = setup()
    await coordinator.start()
    const result = await coordinator.callMeeting({ calledBy: 'beta', scope: 'local', reason: '审计用', invitees: ['gamma'] })
    expect(result.accepted).toBe(true)

    const logPath = join(board.filePath, '..', 'meetings.jsonl')
    const lines = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim().length > 0)
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>
    expect(record['calledBy']).toBe('beta')
    expect(record['trigger']).toBe('peer-call')
    expect(record['woke']).toEqual(['gamma'])
    expect(record['deliveredTo']).toEqual(['gamma'])
  })
})

describe('回收', () => {
  it('shutdown 后全部槽位被回收（零泄漏）', async () => {
    const { coordinator, runtime } = setup()
    await coordinator.start()
    expect(runtime.liveSlots()).toHaveLength(3)
    await coordinator.shutdown()
    expect(runtime.liveSlots()).toHaveLength(0)
  })

  it('运行时无 spawn 能力时启动立即失败，而不是静默空转', async () => {
    const runtime = new InMemoryAgentRuntime({ disableSpawn: true })
    const board = new BriefingBoard({ rootDir: root, boardDomain: 'q', maxBriefingChars: 200, maxAgendaChars: 1200 })
    const coordinator = new MeetingCoordinator({ board, runtime, slots: SLOTS, now })
    await expect(coordinator.start()).rejects.toThrow(/不具备 spawn 能力/)
  })
})
