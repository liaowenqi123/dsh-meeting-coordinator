/**
 * 会议室机制测试 —— 直接对应需求里的每一条语义。
 *
 * 需求原文摘录（作为断言依据）：
 *
 * > 不是每一个会话都是可被召集或唤起的。你可以把某一个会话加入会议室，
 * > 加入会议室自动获得"唤起会议"和"参会"的权利和义务。
 * > 不同工作区下的会话可以进入同一个会议室。
 * > 一个 agent 正在 working（不论是正在输出还是在调用工具 ing），
 * > 都将在调用结束后进入会议室（有一个等待的过程）。
 * > 设置一个主持人吧，模型使用唤起会话的模型，但是这个主持人直接没有上下文，
 * > 不会被任何人的上下文带偏。
 * > 一个会话只能属于一个会议室。
 * > AI 自然收敛加上限兜底吧，主要靠主持人的控场。
 * > 每个参会就使用那个会话的对应模型就行。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentParticipant,
  DEFAULT_ROOM_POLICY,
  HUMAN_PARTICIPANT,
  MeetingOrchestrator,
  MeetingOrchestratorError,
  MeetingRoom,
  ParticipantStateError,
  RoomRegistry,
  RoomRegistryError,
  RoundRobinModerator,
  ScriptedMeetingVoice,
  ScriptedModerator,
  buildModeratorPrompt,
  parseModeratorDecision,
  safeFallback,
  type AgentParticipantSpec,
  type MeetingVoicePort,
  type ModeratorPort,
} from '../src/index.js'

let root: string
let clock: number
const now = (): number => clock

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-meeting-room-'))
  clock = Date.parse('2026-01-01T00:00:00.000Z')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const SPECS: readonly AgentParticipantSpec[] = [
  { id: 'neural-net', workspace: 'quant-lab', model: 'deepseek-v4-pro', domain: 'neural-net', title: '神经网络专家', systemPrompt: '只做网络结构、梯度、论文复现。' },
  { id: 'live-trading', workspace: 'quant-live', model: 'deepseek-v4.1-flash', domain: 'live-trading', title: '实盘/泛化专家', systemPrompt: '只做滑点、仓位、泛化陷阱。' },
  { id: 'trad-algo', workspace: 'quant-lab', model: 'deepseek-v4-pro', domain: 'trad-algo', title: '传统金融算法专家', systemPrompt: '只做统计因子与经典金融算法。' },
]

const SPEECHES = {
  'neural-net': [
    '残差宽度消融 37 组做完了，val loss 0.183，超参冻结。我这边需要知道实盘换手率量级，才能判断值不值得上真仓。',
    '如果 trad-algo 的 60 日窗口要上线，我的重训频率得同步改成 60 日一次，否则特征分布对不上。',
  ],
  'live-trading': [
    '逐笔滑点重算完了，taker 成本吃掉 41% 的夏普。障碍是仓位模型在跳空开盘时反复触发同一个止损，收紧阈值没用。需要 neural-net 确认新配置能不能降换手。',
    '换手率量级在 8-12 倍/月。压到 5 倍以下的话，滑点成本能从 41% 降到 22% 左右。',
  ],
  'trad-algo': [
    '14 个因子的 IC 重建完成，3 个在 2024 后失效了。怀疑跟市场结构变化有关，需要 live-trading 的成交结构数据。',
    '2024 后大单占比上升 9%，时间点和因子失效完全吻合。建议 IC 窗口从 250 日缩到 60 日。',
  ],
} as const

const MINUTES = {
  'neural-net': '待办：与 live-trading 对齐上线后的重训频率；若 60 日窗口上线，我的重训周期同步改为 60 日。',
  'live-trading': '待办：在 60 日窗口下重跑滑点估计并验证稳定性。换手降到 4.8 倍后滑点约 20%。',
  'trad-algo': '待办：在 60 日窗口下重做统计显著性检验。我的方向被采纳：这是市场结构问题不是换手率问题。',
} as const

function makeVoice(overrides?: {
  speeches?: Record<string, readonly string[]>
  minutes?: Record<string, string>
  reflect?: (participant: string) => string
  minutesMaxChars?: number
}) {
  const scripts: Record<string, { speeches: string[]; reflect?: (t: string) => string }> = {}
  for (const spec of SPECS) {
    const speeches = overrides?.speeches?.[spec.id] ?? SPEECHES[spec.id as keyof typeof SPEECHES]
    const customMinutes = overrides?.minutes?.[spec.id] ?? MINUTES[spec.id as keyof typeof MINUTES]
    const reflectFn =
      overrides?.reflect !== undefined
        ? () => overrides.reflect?.(spec.id) ?? ''
        : () => customMinutes
    scripts[spec.id] = { speeches: [...speeches as readonly string[]], reflect: reflectFn }
  }
  return new ScriptedMeetingVoice({ scripts, minutesMaxChars: overrides?.minutesMaxChars ?? 300 })
}

/** 建一个登记齐全、全员已加入会议室、且都在 working 的编排器。 */
function setup(options?: {
  moderator?: ScriptedModerator | RoundRobinModerator
  voice?: ScriptedMeetingVoice
  joinAll?: boolean
  roomId?: string
}) {
  const registry = new RoomRegistry({ rootDir: root, now })
  const voice = options?.voice ?? makeVoice()
  const moderator = options?.moderator ?? new RoundRobinModerator({ minSpeechesPerMember: 1, minRounds: 2 })
  const orchestrator = new MeetingOrchestrator({ registry, voice, moderator, now })
  for (const spec of SPECS) orchestrator.enroll(spec)

  const roomId = options?.roomId ?? 'quant-sync'
  registry.createRoom({ id: roomId, name: '量化同步会' })
  if (options?.joinAll !== false) {
    for (const spec of SPECS) orchestrator.joinRoom(spec.id, roomId)
  }
  return { registry, voice, moderator, orchestrator, roomId }
}

// ===========================================================================

describe('会籍：会议室是持久实体，加入才有权利与义务', () => {
  it('加入会议室后才有资格被召集；没加入的会话叫不动', async () => {
    const { orchestrator, roomId } = setup({ joinAll: false })
    // 三人已登记但都没加入会议室
    await expect(orchestrator.convene({ roomId, calledBy: 'live-trading', scope: 'global', reason: 'r' })).rejects.toThrow(
      /没有召集权|不是会议室/,
    )
  })

  it('一个会话只能属于一个会议室（排他）', () => {
    const { registry, orchestrator, roomId } = setup()
    registry.createRoom({ id: 'other-room' })
    expect(() => orchestrator.joinRoom('neuro'.replace('neuro', 'neural-net'), 'other-room')).toThrow(RoomRegistryError)
    // 原会籍不受影响
    expect(registry.roomOf('neural-net')?.id).toBe(roomId)
  })

  it('不同工作区的会话可以在同一个会议室里', () => {
    const { registry, roomId } = setup()
    const room = registry.room(roomId)
    expect(room?.members.map((m) => `${m.sessionId}@${m.workspace}`)).toEqual([
      'live-trading@quant-live',
      'neural-net@quant-lab',
      'trad-algo@quant-lab',
    ])
  })

  it('会籍落盘：新实例重放后成员关系与所属关系都不丢', () => {
    const { registry, roomId } = setup()
    registry.leave('trad-algo')
    expect(registry.isMember('trad-algo')).toBe(false)

    // 模拟进程重启
    const reopened = new RoomRegistry({ rootDir: root, now })
    expect(reopened.room(roomId)?.members.map((m) => m.sessionId)).toEqual(['live-trading', 'neural-net'])
    expect(reopened.roomOf('neural-net')?.id).toBe(roomId)
    expect(reopened.roomOf('trad-algo')).toBeUndefined()
  })

  it('人类不需要会籍也能召集会议室', async () => {
    const { orchestrator, roomId } = setup()
    // 需要至少一位成员能立刻到场，否则会因"全员在工作中"而无法开始
    orchestrator.member('neural-net').beginIdleWaiting()
    orchestrator.member('trad-algo').beginIdleWaiting()
    const record = await orchestrator.convene({ roomId, calledBy: HUMAN_PARTICIPANT, scope: 'global', reason: '人工召集' })
    expect(record.calledBy).toBe(HUMAN_PARTICIPANT)
  })
})

describe('状态机：working 的会话不会被会议打断，而是等边界入场', () => {
  it('summon 对 working 只标记待入场；对 idle-waiting / done 立即入场', () => {
    const working = new AgentParticipant({ id: 'w', domain: 'd', title: 't', systemPrompt: 's' })
    working.summon()
    expect(working.state).toBe('awaiting-entry')
    expect(working.isInMeeting()).toBe(false)
    working.onWorkUnitComplete()
    expect(working.state).toBe('in-meeting')

    const idle = new AgentParticipant({ id: 'i', domain: 'd', title: 't', systemPrompt: 's' })
    idle.beginIdleWaiting()
    idle.summon()
    expect(idle.state).toBe('in-meeting')

    const done = new AgentParticipant({ id: 'x', domain: 'd', title: 't', systemPrompt: 's' })
    done.complete()
    done.summon()
    expect(done.state).toBe('in-meeting')
  })

  it('onWorkUnitComplete 只对 awaiting-entry 有效，不误伤其他状态', () => {
    const p = new AgentParticipant({ id: 'w', domain: 'd', title: 't', systemPrompt: 's' })
    p.onWorkUnitComplete()
    expect(p.state).toBe('working')
  })

  it('取消召集把 awaiting-entry 还原回召集前的状态', () => {
    // 忙成员被召集 → awaiting-entry → 取消 → 还在忙。
    const busy = new AgentParticipant({ id: 'w', domain: 'd', title: 't', systemPrompt: 's' })
    busy.summon()
    busy.cancelSummon()
    expect(busy.state).toBe('working')

    // 空闲成员被召集是**直接入场**的，根本没有 awaiting-entry 可取消。
    const idle = new AgentParticipant({ id: 'i', domain: 'd', title: 't', systemPrompt: 's' })
    idle.beginIdleWaiting()
    idle.summon()
    expect(idle.state).toBe('in-meeting')
    idle.cancelSummon()
    expect(idle.state).toBe('in-meeting')
  })

  it('散会还原到召集前的状态，不留僵尸（awaiting-entry 也一并清掉）', () => {
    // ① 忙成员：散会后它**还在忙**，不该被说成空闲。
    const busy = new AgentParticipant({ id: 'w', domain: 'd', title: 't', systemPrompt: 's' })
    busy.summon()
    expect(busy.state).toBe('awaiting-entry')
    busy.dismiss()
    expect(busy.state).toBe('working')

    // ② 已完成成员：还原成 done。
    const done = new AgentParticipant({ id: 'q', domain: 'd', title: 't', systemPrompt: 's' })
    done.complete()
    done.summon()
    done.dismiss()
    expect(done.state).toBe('done')
    expect(() => done.dismiss()).toThrow(ParticipantStateError)

    // ③ ★ 空闲成员（真实环境里的常态）：散会后必须回到**空闲**，而不是 working。
    //
    // 这是真实故障的回归断言。曾经 `dismiss()` 写死回 `working`，于是空闲成员
    // 开完一次会被标成"正在干活"，而 `summon()` 对 `working` 的反应是派去
    // `awaiting-entry`——去等一个**永远不会到来**的工作单元边界。
    // 表现出来就是：**一个会议室只要开过一次会，就再也召集不起来了**，
    // 理由永远是"全部成员都在工作中"。会议中途失败时尤其致命。
    const idle = new AgentParticipant({ id: 'i', domain: 'd', title: 't', systemPrompt: 's' })
    idle.beginIdleWaiting()
    idle.summon()
    expect(idle.state).toBe('in-meeting')
    idle.dismiss()
    expect(idle.state).toBe('idle-waiting')

    // 而且它**立刻就能再被召集**——这才是"还原"真正要保证的事。
    idle.summon()
    expect(idle.state).toBe('in-meeting')
    idle.dismiss()
    expect(idle.state).toBe('idle-waiting')
  })

  it('全员都在工作时会议无法开始，且**不留下**任何待入场状态', async () => {
    const { orchestrator, roomId } = setup()
    // 把所有人都置为 working（默认就是），召集应当失败
    await expect(orchestrator.convene({ roomId, calledBy: HUMAN_PARTICIPANT, scope: 'global', reason: 'r' })).rejects.toThrow(
      /都在工作中|无法开始/,
    )
    // 关键：不能留下 awaiting-entry 僵尸
    expect(orchestrator.states()).toEqual({
      'live-trading': 'working',
      'neural-net': 'working',
      'trad-algo': 'working',
    })
  })
})

describe('入场：迟到成员在边界补入场，并拿到自己的入场引导', () => {
  it('忙碌成员在会议中通过 onWorkUnitComplete 入场，且收到入场引导', async () => {
    const { orchestrator, roomId } = setup()
    // 让 neural-net / trad-algo 空闲，live-trading 保持 working（忙）
    orchestrator.member('neural-net').beginIdleWaiting()
    orchestrator.member('trad-algo').complete()
    // 关键：记忆必须在**入场之前**就存在，否则投影当然是空的。
    orchestrator.member('live-trading').remember('逐笔滑点重算完成，taker 成本占 41% 夏普')
    orchestrator.member('neural-net').remember('残差宽度消融 37 组完成')

    const record = await orchestrator.convene({
      roomId,
      calledBy: 'neural-net',
      scope: 'global',
      reason: '跨工作区同步',
      hooks: {
        onOpened: (room) => {
          // 会已经开了，live-trading 还在忙 —— 先确认它还没到场
          expect(room.hasPresent('live-trading')).toBe(false)
          expect(room.absent).toContain('live-trading')
          // 模拟它的当前工作单元结束
          expect(orchestrator.onWorkUnitComplete('live-trading')).toBe(true)
          expect(room.hasPresent('live-trading')).toBe(true)
        },
      },
    })

    expect(record.deferred).toContain('live-trading')
    expect(record.admittedLate).toContain('live-trading')

    // 迟到者也拿到了入场引导，且含它自己的记忆投影
    const liveEntry = record.room.transcript.find((t) => t.kind === 'entry' && t.speaker === 'live-trading')
    expect(liveEntry).toBeDefined()
    expect(liveEntry?.text).toContain('逐笔滑点重算完成')
    // 别人的私有记忆不在它的引导里
    expect(liveEntry?.text).not.toContain('残差宽度消融')
  })

  it('始终没入场的成员按缺席处理，散会后同样回到 working', async () => {
    const { orchestrator, roomId } = setup()
    orchestrator.member('neural-net').beginIdleWaiting()
    orchestrator.member('trad-algo').beginIdleWaiting()
    // live-trading 保持 working，且不触发 onWorkUnitComplete

    const record = await orchestrator.convene({ roomId, calledBy: 'neural-net', scope: 'global', reason: 'r' })
    expect(record.deferred).toContain('live-trading')
    expect(record.admittedLate).toEqual([])
    expect(record.absent).toContain('live-trading')
    // 缺席者也必须被回收
    expect(orchestrator.member('live-trading').state).toBe('working')
  })
})

describe('入场引导：不做结构化模板', () => {
  it('引导里有定位信息与开放式提示，但没有强制的三段式字段', () => {
    const room = new MeetingRoom({
      id: 'r1',
      scope: 'global',
      calledBy: 'human',
      reason: '同步进度',
      present: ['a', 'b'],
    })
    const entries = room.open({
      memoryProjection: (id) => `记忆-${id}`,
      titles: { a: { title: '专家A', domain: 'da' }, b: { title: '专家B', domain: 'db' } },
    })
    const text = entries[0]?.text ?? ''
    // 必须有的定位信息
    expect(text).toContain('【会议室入场】')
    expect(text).toContain('议题：同步进度')
    expect(text).toContain('记忆-a')
    expect(text).not.toContain('记忆-b')
    // 不能有旧版的强制三段式模板
    expect(text).not.toContain('请严格按')
    expect(text).not.toContain('第 1 轮每人按上面的结构发言')
    // 应当是开放式的自然表达引导
    expect(text).toMatch(/自然|怎么表达清楚/)
  })

  it('长度上限只是预算提示，不是格式要求', () => {
    const room = new MeetingRoom({ id: 'r2', scope: 'global', calledBy: 'a', reason: 'r', present: ['a'] })
    const entries = room.open({ memoryProjection: () => 'm', titles: {} })
    expect(entries[0]?.text).toMatch(/字数要求/)
    
  })
})

describe('主持人：有控场权，但没有上下文', () => {
  it('主持人 prompt 明确声明拿不到与会者的私有上下文', () => {
    const prompt = buildModeratorPrompt({
      roomName: 'r1',
      reason: '同步',
      members: ['a', 'b'],
      present: ['a', 'b'],
      absent: ['c'],
      round: 2,
      maxRounds: 6,
      transcript: '[R1] a: 我的私有进度是 X',
      spokeThisRound: ['a'],
      spokeCounts: { a: 1, b: 0 },
    })
    expect(prompt).toContain('没有任何与会者的私有上下文')
    expect(prompt).toContain('不要臆测某人的内部状态')
    expect(prompt).toContain('宣布散会')
    expect(prompt).toContain('不要让同一个人连续发言两次')
  })

  it('主持人输出可解析（含 markdown 围栏与寒暄）', () => {
    const fallback = { present: ['a', 'b'], spokeThisRound: [] as string[] }
    expect(parseModeratorDecision('```json\n{"action":"invite","next":"b"}\n```', fallback)).toEqual({
      action: 'invite',
      next: 'b',
      note: undefined,
    })
    expect(parseModeratorDecision('好的，我决定散会：{"action":"adjourn","reason":"已收敛"}', fallback)).toEqual({
      action: 'adjourn',
      reason: '已收敛',
    })
    // 点名不在场的人 → 安全回退
    expect(parseModeratorDecision('{"action":"invite","next":"zzz"}', fallback).action).toBe('invite')
    // 完全跑偏 → 安全回退，而不是卡住会议
    const garbage = parseModeratorDecision('我觉得大家说得都很好', fallback)
    expect(garbage).toEqual({ action: 'invite', next: 'a', note: '主持人输出无法解析，按轮转回退。' })
  })

  it('safeFallback 在没人可发言时宣布散会', () => {
    expect(safeFallback({ present: [], spokeThisRound: [] })).toEqual({
      action: 'adjourn',
      reason: '没有可发言的在场成员，会议结束。',
    })
  })

  it('主持人使用的是**召集者会话的模型**', async () => {
    const seenModels: (string | undefined)[] = []
    const spy: ConstructorParameters<typeof ScriptedModerator>[0] = []
    const moderator = new ScriptedModerator(spy)
    const original = moderator.decide.bind(moderator)
    moderator.decide = async (input) => {
      seenModels.push(input.model)
      return original(input)
    }

    const { orchestrator, roomId } = setup({ moderator })
    orchestrator.member('neural-net').beginIdleWaiting()
    orchestrator.member('trad-algo').beginIdleWaiting()
    await orchestrator.convene({ roomId, calledBy: 'live-trading', scope: 'global', reason: 'r' })

    expect(seenModels.length).toBeGreaterThan(0)
    // live-trading 的模型是 deepseek-v4.1-flash
    expect(new Set(seenModels)).toEqual(new Set(['deepseek-v4.1-flash']))
  })

  it('RoundRobinModerator 满足最小轮次且人人发言足够后宣布散会', async () => {
    const moderator = new RoundRobinModerator({ minSpeechesPerMember: 1, minRounds: 2 })
    const { orchestrator, roomId, voice } = setup({ moderator })
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()

    const record = await orchestrator.convene({ roomId, calledBy: 'neural-net', scope: 'global', reason: 'r' })
    expect(record.adjournedReason).toMatch(/会议结束/)
    // 每个人都至少说过一次
    for (const spec of SPECS) {
      expect(orchestrator.member(spec.id).meetingNoteCount).toBe(1)
    }
    expect(voice.remaining('neural-net')).toBeGreaterThanOrEqual(0)
  })
})

describe('每个参会者使用自己的模型', () => {
  it('发言请求里带的是该会话自己的 model', async () => {
    const voice = makeVoice()
    const { orchestrator, roomId } = setup({ voice })
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()

    await orchestrator.convene({ roomId, calledBy: 'neural-net', scope: 'global', reason: 'r' })

    const speechCalls = voice.calls.filter((call) => call.purpose === 'speak')
    expect(speechCalls.length).toBeGreaterThan(0)
    for (const call of speechCalls) {
      const expected = SPECS.find((spec) => spec.id === call.participant)?.model
      expect(call.model).toBe(expected)
    }
    // 确认确实出现了两种不同模型
    expect(new Set(speechCalls.map((c) => c.model)).size).toBe(2)
  })
})

describe('编排器：完整流程与散会', () => {
  it('人召集：全员参会、各自纪要不同、散会后各自还原到召集前状态', async () => {
    const { orchestrator, roomId, voice } = setup()
    orchestrator.member('neural-net').beginIdleWaiting()
    orchestrator.member('trad-algo').complete()
    orchestrator.member('live-trading').beginIdleWaiting()

    const record = await orchestrator.convene({
      roomId,
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: '成本与市场结构对齐',
      humanPresent: true,
      humanInput: [{ afterRound: 1, text: '这次只讨论成本与结构，请控制篇幅。' }],
    })

    expect([...record.summoned].sort()).toEqual(['live-trading', 'neural-net', 'trad-algo'])
    // 人类发言进入 transcript，且不是 speech
    const human = record.room.transcript.find((t) => t.kind === 'human')
    expect(human?.text).toContain('只讨论成本与结构')

    // 主持人留下了控场/散会记录
    expect(record.room.transcript.some((t) => t.kind === 'moderator')).toBe(true)

    // 每人一份，内容不同
    expect(record.notes).toHaveLength(3)
    expect(new Set(record.notes.map((n) => n.text)).size).toBe(3)

    // 记忆 = 原私有上下文 + 自己的纪要
    for (const spec of SPECS) {
      expect(orchestrator.member(spec.id).meetingNoteCount).toBe(1)
    }

    // 散会：还原到**召集前**的状态，而不是无脑回 working。
    // neural-net / live-trading 召集前空闲 → 还原成空闲（还能立刻再被召集）；
    // trad-algo 召集前已完成 → 还原成 done。
    expect(orchestrator.states()).toEqual({
      'live-trading': 'idle-waiting',
      'neural-net': 'idle-waiting',
      'trad-algo': 'done',
    })

    // 生成纪要的 prompt 每人不同
    const reflectPrompts = voice.calls.filter((c) => c.purpose === 'reflect').map((c) => c.prompt)
    expect(new Set(reflectPrompts).size).toBe(3)
  })

  it('★ 同一会议室能连开两场（散会后成员回到可召集状态）', async () => {
    // 这是真实故障的回归断言。
    //
    // 现场是：第一场会开完后成员被错标成 `working`，于是第二次点"召集"永远失败，
    // 理由永远是"全部 3 位成员都在工作中"。会议室**一次性报废**。
    const { orchestrator, roomId } = setup()
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()

    const first = await orchestrator.convene({
      roomId,
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: '第一场',
    })
    expect(first.notes).toHaveLength(3)

    // 第二场——修复前这里就抛了。
    const second = await orchestrator.convene({
      roomId,
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: '第二场',
    })
    expect(second.notes).toHaveLength(3)
    expect(orchestrator.meetings).toHaveLength(2)
  })

  it('★ 一个人发言失败不再毁掉整场会：其余人照常说，纪要照常出', async () => {
    // 用户现场：第一个人发言 1123 字、超了 800 上限 → 异常一路冒出去 →
    // 后面的人**根本没有机会发言**，整场断掉。
    //
    // 设计的本意是"拒绝**这一次发言**"（长度是硬预算，超限拒绝而不是截断），
    // 不是"拒绝**这一场会议**"。
    const crashRoot = join(root, 'partial-fail')
    const registry = new RoomRegistry({ rootDir: crashRoot, now })

    let failOnce = true
    const voice: MeetingVoicePort = {
      port: 'partial-fail',
      capabilities: () => ({ port: 'partial-fail', canSpeak: true, canReflect: true, notes: [] }),
      speak: async (request) => {
        // 只有**第一位**发言人失败一次，之后都成功 —— 这就是"部分失败"的场景。
        if (request.purpose === 'speak' && failOnce) {
          failOnce = false
          throw new Error('发言超长：上限 800 字，实际 1123 字。')
        }
        return `${request.participant} 的观点`
      },
    }
    const orchestrator = new MeetingOrchestrator({
      registry,
      voice,
      moderator: new RoundRobinModerator({ minSpeechesPerMember: 1, minRounds: 2 }),
      now,
    })
    for (const spec of SPECS) orchestrator.enroll(spec)
    registry.createRoom({ id: 'partial-room' })
    for (const spec of SPECS) orchestrator.joinRoom(spec.id, 'partial-room')
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()

    // ① 会议**没有崩**，正常散会。
    const record = await orchestrator.convene({
      roomId: 'partial-room',
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: 'r',
    })

    // ② 失败被如实写进 transcript（不掩盖，"谁没说上话、为什么"看得见）。
    const failures = record.room.transcript.filter(
      (turn) => turn.kind === 'moderator' && turn.text.includes('发言失败'),
    )
    expect(failures.length).toBeGreaterThan(0)

    // ③ 关键：其余人**照常发言**，且每个人都有自己的纪要。
    const speeches = record.room.transcript.filter((turn) => turn.kind === 'speech')
    expect(speeches.length).toBeGreaterThanOrEqual(2)
    expect(record.notes).toHaveLength(3)

    // ④ 散会理由里也带上了失败项。
    expect(record.adjournedReason).toMatch(/失败/)

    // ⑤ 成员状态还原，不留僵尸。
    for (const spec of SPECS) {
      expect(orchestrator.member(spec.id).state).toBe('idle-waiting')
    }
  })

  it('★ 所有人发言都失败时，会议明确报错（不假装开成了）', async () => {
    // 上面那条的另一半：一个都没说上话的会是假的，必须报错而不是"正常散会"。
    const allFailRoot = join(root, 'all-fail')
    const registry = new RoomRegistry({ rootDir: allFailRoot, now })
    const voice: MeetingVoicePort = {
      port: 'all-fail',
      capabilities: () => ({ port: 'all-fail', canSpeak: true, canReflect: true, notes: [] }),
      speak: async (request) => {
        if (request.purpose === 'speak') throw new Error('Connection error')
        return '纪要'
      },
    }
    const orchestrator = new MeetingOrchestrator({
      registry,
      voice,
      moderator: new RoundRobinModerator({ minSpeechesPerMember: 1, minRounds: 2 }),
      now,
    })
    for (const spec of SPECS) orchestrator.enroll(spec)
    registry.createRoom({ id: 'all-fail-room' })
    for (const spec of SPECS) orchestrator.joinRoom(spec.id, 'all-fail-room')
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()

    await expect(
      orchestrator.convene({
        roomId: 'all-fail-room',
        calledBy: HUMAN_PARTICIPANT,
        scope: 'global',
        reason: 'r',
      }),
    ).rejects.toThrow(/没有任何成员发言成功/)

    // 失败了也必须把状态收干净：不留半开的会，也不留僵尸成员。
    expect(orchestrator.activeRoom()).toBeUndefined()
    for (const spec of SPECS) {
      expect(orchestrator.member(spec.id).state).toBe('idle-waiting')
    }
  })

  it('★ 主持人调用失败不毁掉整场会：第 1 轮已开的内容照常落盘，按安全轮转继续', async () => {
    // 与"发言失败不毁全场"同一条原则的另一半：主持人的模型调用失败
    // （鉴权 / 超时 / 抖动）曾让异常一路冒出去——第 1 轮所有人都已经发言了，
    // 会议却在主持人环节整个报废，record 不落盘、纪要全丢。
    // 这是端到端测试逼近真实场景（mock 之外还有别的 provider 在跑）时
    // 最容易踩的坑，所以钉死：降级成确定性轮转，失败如实可见。
    const modFailRoot = join(root, 'mod-fail')
    const registry = new RoomRegistry({ rootDir: modFailRoot, now })
    const voice: MeetingVoicePort = {
      port: 'mod-fail',
      capabilities: () => ({ port: 'mod-fail', canSpeak: true, canReflect: true, notes: [] }),
      speak: async (request) => (request.purpose === 'speak' ? `${request.participant} 的观点` : '纪要'),
    }
    const moderator: ModeratorPort = {
      port: 'throwing-moderator',
      decide: async () => {
        throw new Error('模型请求失败：Connection error')
      },
    }
    const orchestrator = new MeetingOrchestrator({
      registry,
      voice,
      moderator,
      now,
      // 轮次上限压小，避免安全轮转把测试拖长（但要 ≥3，否则主持人在
      // 被咨询之前就撞上限散会，这条用例就什么都验不到了）。
      roomPolicy: { ...DEFAULT_ROOM_POLICY, maxRounds: 3 },
    })
    for (const spec of SPECS) orchestrator.enroll(spec)
    registry.createRoom({ id: 'mod-fail-room' })
    for (const spec of SPECS) orchestrator.joinRoom(spec.id, 'mod-fail-room')
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()

    const record = await orchestrator.convene({
      roomId: 'mod-fail-room',
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: 'r',
    })

    // ① 会开完了：第 1 轮的发言与每人的纪要都在。
    const speeches = record.room.transcript.filter((turn) => turn.kind === 'speech')
    expect(speeches.length).toBeGreaterThanOrEqual(3)
    expect(record.notes).toHaveLength(3)

    // ② 主持人的失败被如实记进 transcript 与散会理由，不被悄悄吞掉。
    const noted = record.room.transcript.filter(
      (turn) => turn.kind === 'moderator' && turn.text.includes('主持人本次决定失败'),
    )
    expect(noted.length).toBeGreaterThan(0)
    expect(record.adjournedReason).toMatch(/主持人失败/)

    // ③ 成员状态还原，不留僵尸。
    for (const spec of SPECS) {
      expect(orchestrator.member(spec.id).state).toBe('idle-waiting')
    }
  })

  it('小会只叫被点名的人', async () => {
    const { orchestrator, roomId } = setup()
    orchestrator.member('live-trading').beginIdleWaiting()
    orchestrator.member('neural-net').beginIdleWaiting()
    orchestrator.member('trad-algo').beginIdleWaiting()

    const record = await orchestrator.convene({
      roomId,
      calledBy: 'live-trading',
      scope: 'local',
      reason: '只对齐换手率',
      invitees: ['live-trading', 'neural-net'],
    })
    expect([...record.summoned].sort()).toEqual(['live-trading', 'neural-net'])
    expect(orchestrator.member('trad-algo').meetingNoteCount).toBe(0)
    expect(orchestrator.member('trad-algo').state).toBe('idle-waiting')
  })

  it('小会必须显式点名', async () => {
    const { orchestrator, roomId } = setup()
    await expect(
      orchestrator.convene({ roomId, calledBy: 'live-trading', scope: 'local', reason: 'r' }),
    ).rejects.toThrow(/必须用 invitees 点名/)
  })

  it('会中人类可实时插话', async () => {
    const { orchestrator, roomId } = setup()
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()

    let injected = false
    const record = await orchestrator.convene({
      roomId,
      calledBy: 'live-trading',
      scope: 'global',
      reason: 'r',
      humanPresent: true,
      hooks: {
        onDecision: () => {
          if (!injected) {
            orchestrator.injectHumanTurn('我插一句：只讨论成本，别谈结构。')
            injected = true
          }
        },
      },
    })
    expect(injected).toBe(true)
    expect(record.room.transcript.some((t) => t.kind === 'human' && t.text.includes('只讨论成本'))).toBe(true)
  })

  it('会后压缩不合格时整场会议报错，但所有人仍被回收', async () => {
    const wordy = '这是一段刻意写得很长很长的所谓纪要，它不可能是对会议的压缩。'.repeat(20)
    const voice = makeVoice({ reflect: () => wordy })
    const { orchestrator, roomId } = setup({ voice })
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()

    await expect(
      orchestrator.convene({ roomId, calledBy: 'live-trading', scope: 'global', reason: 'r' }),
    ).rejects.toThrow(/会后压缩被拒绝/)

    // 整场会失败了，成员也必须被还原到**可再次召集**的状态——
    // 否则这个会议室就废了（下次召集只会说"全员都在工作中"）。
    expect(orchestrator.states()).toEqual({
      'live-trading': 'idle-waiting',
      'neural-net': 'idle-waiting',
      'trad-algo': 'idle-waiting',
    })
  })

  it('嵌套会议被拒绝', async () => {
    const { orchestrator, roomId } = setup()
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()
    const first = orchestrator.convene({ roomId, calledBy: 'live-trading', scope: 'global', reason: 'a' })
    await expect(orchestrator.convene({ roomId, calledBy: 'live-trading', scope: 'global', reason: 'b' })).rejects.toThrow(
      /正在进行中|一次只主持一场/,
    )
    await first
  })

  it('超过轮次上限时由协调器强制散会（上限兜底）', async () => {
    // 主持人在这件事上"永远想继续"，看上限是否兜得住。
    const stubborn = new ScriptedModerator([], new RoundRobinModerator({ minSpeechesPerMember: 99, minRounds: 99 }))
    // 用**独立的持久化目录**，避免与其它用例共享会籍日志。
    const capRoot = join(root, 'cap-test')
    const registry = new RoomRegistry({ rootDir: capRoot, now })
    const voices = new ScriptedMeetingVoice({
      scripts: Object.fromEntries(
        SPECS.map((spec) => [
          spec.id,
          {
            speeches: Array.from({ length: 30 }, (_, index) => `${spec.id} 第 ${index + 1} 次发言`),
            reflect: () => '待办：无。',
          },
        ]),
      ),
      minutesMaxChars: 300,
    })
    const orchestrator = new MeetingOrchestrator({
      registry,
      voice: voices,
      moderator: stubborn,
      now,
      roomPolicy: {
        reportGuidanceChars: 400,
        reportMaxChars: 800,
        discussGuidanceChars: 100,
        discussMaxChars: 200,
        maxRounds: 2,
        transcriptBudgetChars: 6000,
        memoryProjectionChars: 800,
        entryWaitMs: 1000,
      },
    })
    for (const spec of SPECS) orchestrator.enroll(spec)
    registry.createRoom({ id: 'cap-room' })
    for (const spec of SPECS) orchestrator.joinRoom(spec.id, 'cap-room')
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()

    const record = await orchestrator.convene({
      roomId: 'cap-room',
      calledBy: 'live-trading',
      scope: 'global',
      reason: 'r',
    })
    expect(record.adjournedReason).toMatch(/轮次上限/)
    expect(record.rounds).toBeLessThanOrEqual(2)
    // 兜底散会后依然全部回收：还原到召集前的空闲状态（还能再开下一场）。
    for (const spec of SPECS) {
      expect(orchestrator.member(spec.id).state).toBe('idle-waiting')
    }
  })
})

describe('会议记录', () => {
  it('每次发言都是一个 turn，且都带轮次与长度', async () => {
    const { orchestrator, roomId } = setup()
    for (const spec of SPECS) orchestrator.member(spec.id).beginIdleWaiting()
    const record = await orchestrator.convene({ roomId, calledBy: 'live-trading', scope: 'global', reason: 'r' })
    const speeches = record.room.transcript.filter((t) => t.kind === 'speech')
    expect(speeches.length).toBeGreaterThanOrEqual(3)
    for (const turn of speeches) {
      expect(turn.round).toBeGreaterThanOrEqual(1)
      expect(turn.chars).toBeGreaterThan(0)
      expect(turn.chars).toBeLessThanOrEqual(orchestrator.policySnapshot.reportMaxChars)
    }
  })

  it('会议记录超预算时按滚动窗口投影，并标注省略条数', () => {
    const room = new MeetingRoom({
      id: 'r',
      scope: 'global',
      calledBy: 'human',
      reason: 'r',
      present: ['a', 'b'],
      policy: { reportGuidanceChars: 200, reportMaxChars: 500, discussGuidanceChars: 50, discussMaxChars: 120, maxRounds: 50, transcriptBudgetChars: 400, memoryProjectionChars: 100, entryWaitMs: 1000 },
    })
    room.open({ memoryProjection: () => 'm', titles: {} })
    for (let index = 0; index < 40; index += 1) {
      room.appendSpeech('a', `第 ${index + 1} 条发言，占用一些字符来做预算测试`)
      room.appendSpeech('b', `第 ${index + 1} 条发言，占用一些字符来做预算测试`)
    }
    const projection = room.transcriptProjection()
    expect(projection).toMatch(/已省略更早的 \d+ 条发言/)
    expect(projection.length).toBeLessThan(400 + 400)
  })
})
