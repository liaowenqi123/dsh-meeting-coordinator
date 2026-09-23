/**
 * 会议室机制端到端演示。
 *
 * 运行：`pnpm run demo:room`
 *
 * 逐条演示并断言需求里的语义：
 *
 * 1. 会议室是**持久实体**，会话**主动加入**才获得"唤起/参会"的权利与义务；
 * 2. 没加入的会话**叫不动**；
 * 3. 成员可来自**不同工作区**，各有**自己的模型**；
 * 4. 正在 working 的会话**不被打断**，先进"待入场"，等当前工作单元结束才入场；
 * 5. 入场时预注入 prompt（含各自记忆投影，不含别人私有记忆），**不做结构化模板**；
 * 6. 主持人控场：**用召集者的模型，但没有上下文**，不会被任何人的私有记忆带偏；
 * 7. 人在会中可插话，不占轮次；
 * 8. 每个参会者用**自己的模型**发言；
 * 9. 会后每人各自压缩出**不同**的纪要；
 * 10. 散会后**所有**成员回到工作状态。
 */

import {
  HUMAN_PARTICIPANT,
  MeetingOrchestrator,
  RoundRobinModerator,
  RoomRegistry,
  ScriptedMeetingVoice,
  buildModeratorPrompt,
  type AgentParticipantSpec,
  type ModeratorContext,
  type ModeratorDecision,
} from '../index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------

const SPECS: readonly AgentParticipantSpec[] = [
  {
    id: 'neural-net',
    workspace: 'quant-lab',
    model: 'deepseek-v4-pro',
    domain: 'neural-net',
    title: '神经网络专家',
    systemPrompt: '只负责模型架构、梯度行为与论文复现；不评估交易成本，不判断仓位。',
  },
  {
    id: 'live-trading',
    workspace: 'quant-live',
    model: 'deepseek-v4.1-flash',
    domain: 'live-trading',
    title: '实盘/泛化专家',
    systemPrompt: '只负责回测滑点、仓位管理与泛化陷阱；不设计网络结构。',
  },
  {
    id: 'trad-algo',
    workspace: 'quant-lab',
    model: 'deepseek-v4-pro',
    domain: 'trad-algo',
    title: '传统金融算法专家',
    systemPrompt: '只负责统计因子与传统金融算法；不接触深度学习训练细节。',
  },
  {
    id: 'data-infra',
    workspace: 'infra',
    model: 'deepseek-v4-pro',
    domain: 'data-infra',
    title: '数据基建',
    systemPrompt: '只负责数据管道与存储。',
  },
]

const SPEECHES: Record<string, string[]> = {
  'neural-net': [
    '残差宽度消融 37 组做完了，val loss 0.183，超参冻结。我需要知道实盘换手率量级，才能判断值不值得上真仓。',
    '补一句：如果 60 日 IC 窗口要上线，我的重训频率得同步改成 60 日一次，否则特征分布对不上。',
  ],
  'live-trading': [
    '逐笔滑点重算完了，taker 成本吃掉 41% 的夏普。障碍是仓位模型在跳空开盘时反复触发同一个止损，收紧阈值和加缓冲都试过，没改善。',
    '换手率量级在 8-12 倍/月。压到 5 倍以下的话，滑点成本能从 41% 降到 22% 左右，那我就不需要那么激进的止损了。',
  ],
  'trad-algo': [
    '14 个因子的 IC 重建完成，3 个在 2024 后失效。我怀疑跟市场结构变化有关，需要成交结构数据。',
    '2024 后大单占比上升 9%，时间点和因子失效完全吻合。建议 IC 窗口从 250 日缩到 60 日——这是市场结构问题，不是换手率问题。',
  ],
}

const MINUTES: Record<string, string> = {
  'neural-net':
    '待办：与 live-trading 对齐上线后的重训频率。会上确认换手降到 4.8 倍可行；若 60 日窗口上线，我的重训周期同步改为 60 日。',
  'live-trading':
    '待办：在 60 日 IC 窗口下重跑滑点估计并验证稳定性（我的责任）。会上确认换手压到 5 倍以下后滑点约 20%，止损问题缓解。',
  'trad-algo':
    '待办：在 60 日窗口下重做统计显著性检验。我的判断被采纳：这是市场结构问题而非换手率问题；模型侧已承诺同步重训周期。',
}

// ---------------------------------------------------------------------------

function heading(step: number, title: string): void {
  console.log(`\n${'─'.repeat(78)}\n[${step}] ${title}\n${'─'.repeat(78)}`)
}
function ok(message: string): void {
  console.log(`  ✓ ${message}`)
}
function info(message: string): void {
  console.log(`  · ${message}`)
}
function show(text: string, indent = '    '): void {
  for (const line of text.split('\n')) console.log(`${indent}${line}`)
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`)
}
function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(`断言失败：${message}`)
  return value
}

/** 包一层 RoundRobinModerator，把主持人每次看到什么、决定了什么打印出来。 */
class LoggingModerator extends RoundRobinModerator {
  decisions = 0

  override async decide(input: ModeratorContext & { readonly model?: string | undefined }): Promise<ModeratorDecision> {
    const decision = await super.decide(input)
    this.decisions += 1
    if (this.decisions <= 4) {
      info(
        `主持人（模型=${input.model ?? '宿主默认'}，看到的上下文只有群聊记录）：` +
          `在场 ${input.present.join('/')}${input.absent.length > 0 ? `，未到场 ${input.absent.join('/')}` : ''}` +
          ` → ${decision.action === 'invite' ? `点名 ${decision.next}（${decision.note ?? ''}）` : `散会（${decision.reason}）`}`,
      )
    }
    return decision
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-meeting-room-demo-'))
  let clock = Date.parse('2026-01-01T00:00:00.000Z')
  const now = (): number => clock

  try {
    const registry = new RoomRegistry({ rootDir: root, now })
    const voice = new ScriptedMeetingVoice({
      scripts: Object.fromEntries(
        SPECS.filter((spec) => SPEECHES[spec.id] !== undefined).map((spec) => [
          spec.id,
          { speeches: SPEECHES[spec.id] as string[], reflect: () => MINUTES[spec.id] as string },
        ]),
      ),
      minutesMaxChars: 300,
    })
    const moderator = new LoggingModerator({ minSpeechesPerMember: 1, minRounds: 2 })
    const orchestrator = new MeetingOrchestrator({ registry, voice, moderator, now })

    console.log('DSH 例会协调器 · 会议室机制演示')
    console.log('（用脚本化声音代替真实模型调用；调度、会籍、状态机、压缩校验都与真实运行一致）')

    // ---------------------------------------------------------------------
    heading(1, '会议室是持久实体；会话主动加入才有"唤起/参会"的权利与义务')
    registry.createRoom({ id: 'quant-sync', name: '量化同步会' })
    for (const spec of SPECS) orchestrator.enroll(spec)
    for (const spec of SPECS.filter((s) => s.id !== 'data-infra')) {
      orchestrator.joinRoom(spec.id, 'quant-sync')
    }

    const room = required(registry.room('quant-sync'), '会议室应当存在')
    ok(`会议室「${room.name}」成员 ${room.members.length} 人：`)
    for (const member of room.members) {
      info(`${member.sessionId}  工作区=${member.workspace}  模型=${member.model ?? '(默认)'}`)
    }
    ok('成员来自 2 个不同工作区（quant-lab / quant-live），各有自己的模型')
    assert(new Set(room.members.map((m) => m.workspace)).size === 2, '成员应当跨工作区')

    // ---------------------------------------------------------------------
    heading(2, '不是所有会话都能被唤起：没加入的会话叫不动')
    info('data-infra 已登记为会话，但**没有加入**这个会议室')
    try {
      await orchestrator.convene({ roomId: 'quant-sync', calledBy: 'data-infra', scope: 'global', reason: '越权召集' })
      throw new Error('越权召集竟然成功了')
    } catch (error) {
      ok(`越权召集被拒绝：${error instanceof Error ? error.message : error}`)
    }
    // 它也不在候选名单里
    assert(!registry.isMember('data-infra'), 'data-infra 不应有会籍')
    ok('会籍 = 召集权 + 参会义务；没加入的会话既不能开会被叫，也不会被误叫')

    // ---------------------------------------------------------------------
    heading(3, '三个成员处于不同状态：在跑 / 等用户回复 / 已完成')
    orchestrator.member('neural-net').beginIdleWaiting()
    orchestrator.member('trad-algo').complete()
    orchestrator.member('live-trading').remember('逐笔滑点重算完成，taker 成本占 41% 夏普')
    orchestrator.member('live-trading').remember('私有日志 9.8MB，未对外共享')
    info(`召集前：${Object.entries(orchestrator.states()).map(([k, v]) => `${k}=${v}`).join('，')}`)
    ok('live-trading 还在 working（可能正在输出或调用工具），另两个空闲')

    // ---------------------------------------------------------------------
    heading(4, '人召集会议：working 的先进"待入场"，空闲的直接入场')
    // 记住召集前的状态：散会的判据是**还原**，不是一刀切回 working
    // （旧版写死 working，把"等用户回复"的会话谎报成在干活，导致会议室
    // 崩一次就永久锁死——见 participant.ts 的 dismiss 注释）。
    const statesBefore = orchestrator.states()
    const record = await orchestrator.convene({
      roomId: 'quant-sync',
      calledBy: HUMAN_PARTICIPANT,
      scope: 'global',
      reason: '对齐成本约束与市场结构变化',
      humanPresent: true,
      humanInput: [{ afterRound: 1, text: '这次只讨论成本和结构，不讨论网络结构本身。请控制篇幅。' }],
      hooks: {
        onOpened: async (meetingRoom) => {
          info(`会议已开始，入场情况：在场=${meetingRoom.present.join('/')}  未到场=${meetingRoom.absent.join('/')}`)
          info('live-trading 还在忙着，没有被打断 —— 它被记为"待入场"')
          assert(meetingRoom.absent.includes('live-trading'), 'live-trading 应当处于待入场')

          // 模拟：它的当前工作单元（本次输出 / 本次工具调用）结束
          clock += 60 * 1000
          info('→ 现在 live-trading 的当前工作单元结束了（onWorkUnitComplete）')
          const admitted = orchestrator.onWorkUnitComplete('live-trading')
          assert(admitted, 'live-trading 应当在此刻入场')
          info(`会场更新：在场=${meetingRoom.present.join('/')}  未到场=${meetingRoom.absent.join('/') || '(无)'}`)
        },
      },
    })

    ok(`召集名单：${record.summoned.join('、')}`)
    ok(`其中需要等边界的：${record.deferred.join('、') || '(无)'}；会议中入场的：${record.admittedLate.join('、') || '(无)'}`)
    assert(record.deferred.includes('live-trading'), 'live-trading 应当被延迟入场')
    assert(record.admittedLate.includes('live-trading'), 'live-trading 应当在会议中入场')

    // ---------------------------------------------------------------------
    heading(5, '入场引导：预注入 prompt + 自己的记忆投影，别人看不到')
    const entry = required(
      record.room.transcript.find((t) => t.kind === 'entry' && t.speaker === 'live-trading'),
      'live-trading 应当收到入场引导',
    )
    console.log(`\n--- live-trading 收到的入场引导（原文，${entry.chars} 字）---`)
    show(entry.text)
    console.log('--- 入场引导结束 ---\n')
    assert(entry.text.includes('逐笔滑点重算完成'), '应当包含它自己的记忆投影')
    assert(!entry.text.includes('残差宽度消融'), '不能包含别人的私有记忆')
    assert(!entry.text.includes('请严格按'), '不应有强制发言模板')
    ok('引导里有定位信息与开放式提示，但**没有**强制的三段式模板')
    ok('只有"单次发言字数上限"这一条硬约束，且注明它不是格式要求')

    // ---------------------------------------------------------------------
    heading(6, '主持人控场：用召集者的模型，但自己没有任何上下文')
    const probePrompt = buildModeratorPrompt({
      roomName: record.room.id,
      reason: record.room.reason,
      members: room.members.map((m) => m.sessionId),
      present: record.room.present,
      absent: record.room.absent,
      round: 2,
      maxRounds: 6,
      transcript: record.room.transcriptProjection(),
      spokeThisRound: record.room.spokeThisRound(),
      spokeCounts: record.room.spokeCounts(),
    })
    console.log('\n--- 主持人 prompt 的关键部分 ---')
    show(probePrompt.split('\n').slice(0, 12).join('\n'))
    console.log('    …')
    console.log('--- 结束 ---\n')
    assert(probePrompt.includes('没有任何与会者的私有上下文'), '必须声明主持人没有上下文')
    ok('主持人只拿到群聊记录 + 名单 + 谁还没说话；拿不到任何人的私有记忆')
    ok('因此它不可能因为"谁的上下文更长"而偏好谁 —— 这就是"不会被带偏"的机制保证')

    // ---------------------------------------------------------------------
    heading(7, '第 1 轮发言 + 人在会中插话')
    for (const turn of record.room.transcript.filter((t) => t.kind === 'speech')) {
      console.log(`\n  【R${turn.round}】${turn.speaker}（${turn.chars} 字）`)
      console.log(`    ${turn.text}`)
    }
    const human = required(record.room.transcript.find((t) => t.kind === 'human'), '人类发言应当存在')
    ok(`人类插话已进入群聊（不占轮次、不占发言名额）：${human.text}`)

    const moderatorTurns = record.room.transcript.filter((t) => t.kind === 'moderator')
    ok(`主持人控场记录 ${moderatorTurns.length} 条，最后一条：${moderatorTurns[moderatorTurns.length - 1]?.text ?? '(无)'}`)
    info(`散会原因：${record.adjournedReason}`)
    info(`共 ${record.rounds} 轮，主持人做了 ${moderator.decisions} 次决定`)

    // ---------------------------------------------------------------------
    heading(8, '每个参会者用的是自己的模型')
    const speechCalls = voice.calls.filter((c) => c.purpose === 'speak')
    const byModel = new Map<string, string[]>()
    for (const call of speechCalls) {
      const key = call.model ?? '(默认)'
      byModel.set(key, [...(byModel.get(key) ?? []), call.participant])
    }
    for (const [model, speakers] of byModel) {
      info(`模型 ${model} ← ${[...new Set(speakers)].join('、')}`)
    }
    assert(byModel.size === 2, '应当出现两种不同的会话模型')
    ok('协调器不选模型：每个成员用它自己会话配置的模型发言')

    // ---------------------------------------------------------------------
    heading(9, '会后压缩：每人各自提炼"与自己相关"的内容')
    console.log(`\n  群聊记录总长：${record.room.transcriptProjection().length} 字`)
    for (const note of record.notes) {
      console.log(`\n  ── ${note.participant}（${note.chars} 字）`)
      console.log(`     ${note.text}`)
    }
    assert(record.notes.length === 3, '每位在场成员一份纪要')
    assert(new Set(record.notes.map((n) => n.text)).size === 3, '纪要内容必须各不相同')
    ok('三份纪要内容不同 —— 这是"与自己相关"，不是"全局会议总结"')

    // ---------------------------------------------------------------------
    heading(10, '记忆 = 原私有上下文 + 自己相关的会议纪要')
    const live = orchestrator.member('live-trading')
    info(`live-trading 的私有上下文（${live.privateContext.length} 条，会议未改动）：`)
    for (const line of live.privateContext) console.log(`      - ${line}`)
    info(`新增的会议纪要（${live.meetingNoteCount} 条）：`)
    for (const note of live.meetingNotes) console.log(`      - [${note.meetingId}] ${note.text}`)
    assert(live.privateContext.length === 2, '私有上下文数量不变')
    assert(live.meetingNoteCount === 1, '应当新增 1 条纪要')

    // ---------------------------------------------------------------------
    heading(11, '散会：所有成员回到**召集前**的状态')
    const after = orchestrator.states()
    info(`散会后：${Object.entries(after).map(([k, v]) => `${k}=${v}`).join('，')}`)
    for (const [id, state] of Object.entries(after)) {
      assert(state === statesBefore[id], `${id} 应当回到召集前的 ${statesBefore[id]}，实际 ${state}`)
    }
    ok('在跑的还在跑、等用户回复的继续等、已完成的仍然完成——不谎报状态，才不会锁死会议室')

    // ---------------------------------------------------------------------
    console.log(`\n${'═'.repeat(78)}`)
    console.log('演示全部通过。会议室机制：')
    console.log('  1) 会议室是持久实体，会话主动加入才获得"唤起/参会"的权利与义务；')
    console.log('  2) 没加入的会话叫不动；成员可跨工作区，各有自己的模型；')
    console.log('  3) working 的会话不被打断，先进"待入场"，当前工作单元结束才入场；')
    console.log('  4) 入场注入定位 prompt + 自己的记忆投影，不含别人私有记忆，且不做结构化模板；')
    console.log('  5) 主持人用召集者的模型、但没有上下文，只做控场，不会被谁的私有记忆带偏；')
    console.log('  6) 人可召集、可在会中插话，不占轮次；')
    console.log('  7) 每个参会者用自己会话的模型发言；')
    console.log('  8) 会后每人各自压缩出不同的纪要；散会后所有人回到召集前的状态。')
    console.log('═'.repeat(78))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error('\n演示失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
