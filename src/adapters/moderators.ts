/**
 * 主持人的两种实现。
 *
 * - {@link RoundRobinModerator}：**不需要模型**的确定性主持人。
 *   按"优先点名本轮还没说话的人"轮转，满足最小轮次后宣布散会。
 *   它既是测试/演示的可靠默认，也是"主持人模型不可用"时的降级路径
 *   （会议绝不能因为主持人拿不到模型就挂住）。
 * - {@link ScriptedModerator}：按脚本给出决定，用于精确验证"主持人控场"的每一条路径
 *   （包括输出跑偏、点名不在场的人等异常）。
 *
 * 真实部署里应当再有一个"用召集者会话模型"的实现（`ModeratorPort`），
 * 它的 prompt 由 `buildModeratorPrompt()` 构造——**不含任何与会者的私有上下文**。
 */

import type { ModeratorContext, ModeratorPort } from '../core/moderator.js'
import { safeFallback } from '../core/moderator.js'
import type { ModeratorDecision } from '../core/types.js'

export interface RoundRobinModeratorOptions {
  /** 每位在场成员至少要发过几次言才考虑散会。默认 1。 */
  readonly minSpeechesPerMember?: number | undefined
  /** 至少经过几轮才考虑散会。默认 2。 */
  readonly minRounds?: number | undefined
}

/**
 * 确定性主持人：不调用模型。
 *
 * 控场规则（刻意保守：宁可多问一轮，也不要过早掐断讨论）：
 * 1. 优先点名"本轮还没发言"的在场成员；
 * 2. 若本轮所有人都已发言，则点名"累计发言次数最少"的人，实现轮转；
 * 3. 满足最小轮次 且 每位在场成员都发言过 `minSpeechesPerMember` 次 → 散会；
 * 4. 到达 `maxRounds` → 散会（上限兜底）。
 */
export class RoundRobinModerator implements ModeratorPort {
  readonly port = 'round-robin'
  private readonly minSpeeches: number
  private readonly minRounds: number

  constructor(options: RoundRobinModeratorOptions = {}) {
    this.minSpeeches = options.minSpeechesPerMember ?? 1
    this.minRounds = options.minRounds ?? 2
  }

  async decide(input: ModeratorContext & { readonly model?: string | undefined }): Promise<ModeratorDecision> {
    if (input.present.length === 0) {
      return { action: 'adjourn', reason: '没有在场成员，会议结束。' }
    }
    if (input.round >= input.maxRounds) {
      return { action: 'adjourn', reason: `已达轮次上限 ${input.maxRounds} 轮，会议结束。` }
    }
    const allSpokeEnough = input.present.every((member) => (input.spokeCounts[member] ?? 0) >= this.minSpeeches)
    if (input.round >= this.minRounds && allSpokeEnough) {
      return { action: 'adjourn', reason: '每位在场成员都已发言，且没有新的分歧需要继续讨论，会议结束。' }
    }

    const quiet = input.present.filter((member) => input.spokeThisRound.includes(member) === false)
    if (quiet.length > 0) {
      return { action: 'invite', next: quiet[0] as string, note: '本轮还没发言' }
    }

    // 本轮都说过话了 → 轮转到累计发言最少的人。
    const sorted = [...input.present].sort((left, right) => {
      const diff = (input.spokeCounts[left] ?? 0) - (input.spokeCounts[right] ?? 0)
      return diff !== 0 ? diff : left < right ? -1 : left > right ? 1 : 0
    })
    return { action: 'invite', next: sorted[0] as string, note: '本轮已轮转，继续均衡发言' }
  }
}

/**
 * 脚本化主持人：按预设队列给出决定。
 *
 * 队列耗尽后回退到 {@link RoundRobinModerator} 的规则——这样测试可以只脚本化
 * 关心的那几步，剩下的交给确定性规则，不必把整场会写死。
 */
export class ScriptedModerator implements ModeratorPort {
  readonly port = 'scripted-moderator'
  private readonly decisions: ModeratorDecision[]
  private readonly fallback: RoundRobinModerator
  /** 记录每次拿到的上下文，便于断言"主持人到底看到了什么"。 */
  readonly seen: ModeratorContext[] = []

  constructor(decisions: readonly ModeratorDecision[], fallback?: RoundRobinModerator) {
    this.decisions = [...decisions]
    this.fallback = fallback ?? new RoundRobinModerator()
  }

  async decide(input: ModeratorContext & { readonly model?: string | undefined }): Promise<ModeratorDecision> {
    this.seen.push(input)
    const next = this.decisions.shift()
    if (next === undefined) return this.fallback.decide(input)
    // 主持人点名了不在场的人 → 走安全回退，而不是让会议卡住。
    if (next.action === 'invite' && !input.present.includes(next.next)) {
      return safeFallback({ present: input.present, spokeThisRound: input.spokeThisRound })
    }
    return next
  }
}
