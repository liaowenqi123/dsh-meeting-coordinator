/**
 * MVP 第一步的端到端演示：**两个（以上）领域隔离子 Agent 交换简报 + 互相唤起**。
 *
 * 运行：`pnpm run demo`
 *
 * 这个脚本同时是"第一步如何验证"的可执行答案。它按顺序证明 6 件事：
 *
 * 1. 领域隔离：每个槽位的上下文里只有自己的东西；
 * 2. 跨上下文通信：A 的简报能被 B 读到，但 A 的私有笔记**不会**过去；
 * 3. 长度硬预算：超 200 字直接报错，不静默截断；
 * 4. 外部干预：死循环信号由**外部计算**出来，不依赖 Agent 自述；
 * 5. 开会：协调器汇总成一条限长 digest 广播；
 * 6. **互相唤起**：投递使用 wake 语义，空闲成员被真正叫起来（idle → running），
 *    并且成员收到摘要后可以自己再召集一场会，形成可审计的唤起链。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BriefingBoard } from '../core/briefing-board.js'
import { BriefingBudgetExceeded, DEFAULT_MAX_BRIEFING_CHARS } from '../core/briefing-text.js'
import { MeetingCoordinator } from '../core/coordinator.js'
import { InMemoryAgentRuntime } from '../adapters/in-memory-runtime.js'
import type { AgentSlotSpec } from '../core/types.js'

const BOARD_DOMAIN = 'quant-trading'

/** 量化的三个方向，各自独立上下文。注意每个 systemPrompt 只讲自己的领域。 */
const SLOTS: readonly AgentSlotSpec[] = [
  {
    id: 'neural-net',
    domain: 'neural-net',
    title: '神经网络专家',
    systemPrompt:
      '你负责模型架构、梯度行为与论文复现。只在这个方向上工作；' +
      '不评估交易成本，不判断仓位管理。',
  },
  {
    id: 'live-trading',
    domain: 'live-trading',
    title: '实盘/泛化专家',
    systemPrompt:
      '你负责回测滑点、仓位管理与泛化陷阱。只在这个方向上工作；' +
      '不设计网络结构，不修改训练损失。',
  },
  {
    id: 'trad-algo',
    domain: 'trad-algo',
    title: '传统金融算法专家',
    systemPrompt:
      '你负责传统金融算法与统计特征。只在这个方向上工作；不接触深度学习训练细节。',
  },
]

function heading(step: number, title: string): void {
  console.log(`\n${'─'.repeat(72)}\n[${step}] ${title}\n${'─'.repeat(72)}`)
}

function ok(message: string): void {
  console.log(`  ✓ ${message}`)
}

function info(message: string): void {
  console.log(`  · ${message}`)
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-meeting-demo-'))
  let clock = Date.parse('2026-01-01T00:00:00.000Z')
  const now = (): number => clock

  try {
    const runtime = new InMemoryAgentRuntime()
    const board = new BriefingBoard({
      rootDir: root,
      boardDomain: BOARD_DOMAIN,
      maxBriefingChars: DEFAULT_MAX_BRIEFING_CHARS,
      maxAgendaChars: 1200,
      now,
    })
    const coordinator = new MeetingCoordinator({ board, runtime, slots: SLOTS, now })

    console.log(`DSH 例会协调器 · MVP 第一步演示`)
    console.log(`简报板目录: ${root}`)
    info(`运行时能力: ${JSON.stringify(coordinator.capabilities, null, 2).replace(/\n/g, '\n  ')}`)

    // ---------------------------------------------------------------------
    heading(1, '启动领域隔离子 Agent')
    const handles = await coordinator.start()
    ok(`已启动 ${handles.length} 个领域隔离 Agent：${handles.map((h) => h.slot).join(', ')}`)
    for (const handle of handles) {
      info(`${handle.slot} -> 私有上下文首行: ${runtime.inspectContext(handle.slot)[0]}`)
    }

    // ---------------------------------------------------------------------
    heading(2, '证明领域隔离：各自的私有工作互不可见')
    // 每个私有笔记都带一个只可能出现在**私有上下文**里的唯一标记。
    // 断言必须打在这个标记上，而不是"残差宽度"这类业务词——
    // 后者本来就该出现在别人的摘要里（那正是被授权的共享内容）。
    const NN_PRIVATE = '【私有-neural-net】跑了 37 组残差宽度消融，验证梯度方差随深度下降 12%；私有日志 4.2MB'
    const LIVE_PRIVATE = '【私有-live-trading】重算了 2023-2025 逐笔滑点，taker 成本吃掉 41% 理论夏普；私有日志 9.8MB'
    const ALGO_PRIVATE = '【私有-trad-algo】重建了 14 个统计因子的 IC 序列；私有日志 6.1MB'
    runtime.recordPrivate('neural-net', NN_PRIVATE)
    runtime.recordPrivate('live-trading', LIVE_PRIVATE)
    runtime.recordPrivate('trad-algo', ALGO_PRIVATE)

    if (runtime.contextContains('live-trading', NN_PRIVATE)) {
      throw new Error('隔离失败：实盘专家的上下文里出现了神经网络专家的私有笔记。')
    }
    ok('实盘专家的上下文里**没有**神经网络专家的私有笔记')
    if (runtime.contextContains('neural-net', LIVE_PRIVATE)) {
      throw new Error('隔离失败：神经网络专家的上下文里出现了实盘专家的私有笔记。')
    }
    ok('神经网络专家的上下文里**没有**实盘专家的私有笔记')
    if (runtime.contextContains('trad-algo', NN_PRIVATE) || runtime.contextContains('trad-algo', LIVE_PRIVATE)) {
      throw new Error('隔离失败：传统金融专家的上下文里出现了别人的私有笔记。')
    }
    ok('传统金融专家的上下文里**没有**其他任何方向的私有笔记')

    // ---------------------------------------------------------------------
    heading(3, `简报长度硬预算（上限 ${DEFAULT_MAX_BRIEFING_CHARS} 字）`)
    coordinator.publish({
      slot: 'neural-net',
      domain: 'neural-net',
      round: 7,
      status: '残差宽度消融完成 37 组，最佳配置 val loss 0.183，已冻结超参。',
      blocker: null,
      needs: ['需要实盘方向提供滑点量级以判断该配置是否值得上真仓'],
    })
    ok('神经网络的简报落板')

    // 16 字 × 20 = 320 字，稳定超过 200 的硬上限。
    const tooLong = '这是一段刻意写得很长的状态描述。'.repeat(20)
    try {
      coordinator.publish({
        slot: 'trad-algo',
        domain: 'trad-algo',
        round: 7,
        status: tooLong,
      })
      throw new Error('预算校验失效：超长简报竟然落板了。')
    } catch (error) {
      if (!(error instanceof BriefingBudgetExceeded)) throw error
      ok(`超长简报被拒：上限 ${error.limit} / 实际 ${error.actual} 字，且**没有**静默截断`)
    }

    coordinator.publish({
      slot: 'live-trading',
      domain: 'live-trading',
      round: 7,
      status: '滑点重算完成，taker 成本占 41% 理论夏普。',
      blocker: '现有仓位模型在跳空开盘时反复触发同一止损',
      needs: ['神经网络方向确认新配置是否降低换手率'],
      requestedFrom: ['neural-net'],
    })
    coordinator.publish({
      slot: 'trad-algo',
      domain: 'trad-algo',
      round: 7,
      status: '14 个统计因子 IC 重建完成，其中 3 个在 2024 后失效。',
      blocker: null,
      needs: [],
    })
    ok('三份简报全部落板')

    // ---------------------------------------------------------------------
    heading(4, '死循环信号：由外部计算，不依赖 Agent 自述')
    // 让实盘专家连续 3 轮提交同一份状态——典型的"原地打转"。
    clock += 5 * 60 * 1000
    for (let round = 8; round <= 10; round += 1) {
      coordinator.publish({
        slot: 'live-trading',
        domain: 'live-trading',
        round,
        status: '滑点重算完成，taker 成本占 41% 理论夏普。',
        blocker: '现有仓位模型在跳空开盘时反复触发同一止损',
        needs: ['神经网络方向确认新配置是否降低换手率'],
        requestedFrom: ['neural-net'],
      })
      clock += 60 * 1000
    }
    ok('实盘专家已连续 3 轮提交内容完全相同的简报（指纹相同）')

    // 把同伴都置于空闲，模拟"各自跑完一轮正在等下一轮"。
    for (const slot of coordinator.slotIds) runtime.markIdle(slot)
    info(`会议前状态: ${coordinator.slotIds.map((s) => `${s}=${runtime.state(s)}`).join(', ')}`)

    clock += 60 * 1000
    const tick = await coordinator.tick()
    const signals = tick.evaluation.stallSignals
    if (signals.length === 0) throw new Error('停滞检测失效：应当检出 repeated-fingerprint。')
    for (const signal of signals) {
      info(`信号 ${signal.kind}: ${signal.detail}`)
    }

    const first = tick.meeting
    if (first === undefined) throw new Error('停滞信号成立但协调器没有开会。')
    ok(`协调器召集小会（trigger=${first.agenda.trigger}, scope=${first.agenda.scope}）`)
    info(`议程 id: ${first.agenda.id}`)
    console.log(`\n--- 广播给全体成员的摘要（${first.agenda.digestChars} 字，截断=${first.agenda.truncated}）---`)
    console.log(first.agenda.digest)
    console.log('--- 摘要结束 ---\n')

    // ---------------------------------------------------------------------
    heading(5, '互相唤起：投递即唤醒，空闲成员真的动起来了')
    ok(`本次会议唤起的成员: ${first.woke.join(', ') || '(无)'}`)
    for (const slot of first.woke) {
      const state = runtime.state(slot)
      const wakes = runtime.wakeCount(slot)
      if (state !== 'running' || wakes < 1) {
        throw new Error(`唤起失败：${slot} 状态=${state}, 唤醒次数=${wakes}。`)
      }
      info(`${slot}: idle -> ${state}，累计被唤起 ${wakes} 次`)
    }
    ok('空闲成员被真正唤起（idle → running），不是只留了一条没人看的新消息')

    const digestInContext = runtime.contextContains('live-trading', '[例会] board=')
    if (!digestInContext) throw new Error('唤醒投递没有进入成员上下文。')
    ok('摘要确实进入了成员的上下文（唤醒 = 起一个新回合并带上这条消息）')

    const privateStillPrivate = !runtime.contextContains('live-trading', NN_PRIVATE)
    if (!privateStillPrivate) throw new Error('隔离被破坏：唤醒过程中泄漏了私有上下文。')
    ok('唤醒过程中**没有**泄漏任何私有上下文——只传了那份限长摘要')

    // ---------------------------------------------------------------------
    heading(6, '成员也能召集：A 唤起 B，B 再唤起 C')
    runtime.markIdle('trad-algo')
    info(`召集前 trad-algo 状态: ${runtime.state('trad-algo')}（空闲）`)
    clock += 2 * 60 * 1000

    const call = await coordinator.callMeeting({
      calledBy: 'live-trading',
      scope: 'local',
      reason: '需要传统金融方向确认统计因子失效是否与我这边换手率有关',
      invitees: ['trad-algo'],
      inResponseTo: first.agenda.id,
    })
    if (!call.accepted) throw new Error(`成员召集被拒：${call.reason}`)
    ok(`${call.meeting.calledBy} 成功召集了一场小会（trigger=${call.meeting.agenda.trigger}）`)
    ok(`被唤起的成员: ${call.meeting.woke.join(', ')}`)
    const algoState = runtime.state('trad-algo')
    if (algoState !== 'running') throw new Error(`trad-algo 未被唤起，状态=${algoState}。`)
    info(`trad-algo: idle -> ${algoState}，累计被唤起 ${runtime.wakeCount('trad-algo')} 次`)

    const graph = coordinator.wakeGraph()
    if (graph.length === 0) throw new Error('没有记录到唤起链。')
    ok('可审计的唤起链:')
    for (const edge of graph) {
      info(`${edge.from}  --(${edge.by})-->  ${edge.to}`)
    }

    // 节流：同一个成员立刻再召集应被拒绝，并带回理由。
    const throttled = await coordinator.callMeeting({
      calledBy: 'live-trading',
      scope: 'global',
      reason: '再来一次',
    })
    if (throttled.accepted) throw new Error('召集节流失效：短时间内第二次召集被接受了。')
    ok(`召集节流生效，且理由被明确带回发起者: ${throttled.reason}`)

    // ---------------------------------------------------------------------
    heading(7, '回收：卸载即回收，零泄漏')
    await coordinator.shutdown()
    const live = runtime.liveSlots()
    if (live.length !== 0) throw new Error(`回收失败，仍有存活槽位: ${live.join(', ')}`)
    ok(`全部 ${handles.length} 个槽位已回收，存活槽位: 0`)

    // ---------------------------------------------------------------------
    console.log(`\n${'═'.repeat(72)}`)
    console.log('演示全部通过。核心结论：')
    console.log('  1) 领域隔离成立：私有工作不跨上下文；')
    console.log('  2) 跨上下文通信成立：只通过 ≤200 字的限长简报交换；')
    console.log('  3) 外部干预成立：死循环由外部信号检出并触发会议；')
    console.log('  4) 开会成立：汇总为一条限长 digest 并广播；')
    console.log('  5) 互相唤起成立：投递即唤醒，空闲成员被真正叫起来，且成员可再召集形成唤起链。')
    console.log(`  会议记录（可审计）: ${join(root, BOARD_DOMAIN, 'meetings.jsonl')}`)
    console.log(`  简报时间线: ${join(root, BOARD_DOMAIN, 'board.jsonl')}`)
    console.log('═'.repeat(72))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error('\n演示失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
