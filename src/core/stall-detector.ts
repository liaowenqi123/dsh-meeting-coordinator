/**
 * 停滞 / 死循环信号检测。
 *
 * 这是"外部干预"的判据层：**不依赖 Agent 自述"我卡住了"**。
 * 竞品调研显示 Caucus 的 `ask_operator` 完全依赖 Agent 自判，
 * 而陷入死循环的 Agent 恰恰最不可能正确自判——所以判据必须由外部计算。
 *
 * 三层信号（对应调研建议的"三层防护"）：
 * 1. `silent-slot`       —— 某成员从未提交过简报；
 * 2. `stale-briefing`    —— 某成员连续 N 轮 / 超过 T 时间没有更新；
 * 3. `repeated-fingerprint` —— 同一成员连续提交**内容指纹相同**的简报（典型的空转）；
 * 4. `no-progress`       —— 整块看板 revision 长时间没有增长。
 */

import type { AgentSlotId, BoardSnapshot, Briefing } from './types.js'

export type StallSignalKind = 'silent-slot' | 'stale-briefing' | 'repeated-fingerprint' | 'no-progress'

export interface StallSignal {
  readonly kind: StallSignalKind
  readonly slots: readonly AgentSlotId[]
  readonly detail: string
}

export interface StallDetectionOptions {
  /** 连续多少轮未更新即视为停滞。 */
  readonly staleRounds: number
  /** 距上次更新超过多少毫秒即视为停滞（默认 4 小时，对应"每 4 小时开会"）。 */
  readonly staleMs: number
  /** 连续多少份指纹相同的简报即视为空转。 */
  readonly repeatedFingerprints: number
  /** 整块看板多久没有新增即视为无进展。 */
  readonly noProgressMs: number
}

export const DEFAULT_STALL_OPTIONS: StallDetectionOptions = {
  staleRounds: 5,
  staleMs: 4 * 60 * 60 * 1000,
  repeatedFingerprints: 3,
  noProgressMs: 2 * 60 * 60 * 1000,
}

export interface StallDetectionInput {
  readonly snapshot: BoardSnapshot
  /** 完整时间线，用于计算指纹连续段。 */
  readonly history: readonly Briefing[]
  /** 期望参会的成员全集（含从未提交者）。 */
  readonly slots: readonly AgentSlotId[]
  /** 协调器维护的当前轮次，用于 `staleRounds` 判定。 */
  readonly currentRound: number
  readonly now: number
  readonly options?: Partial<StallDetectionOptions> | undefined
}

/**
 * 计算全部停滞信号。纯函数：给定相同输入必得相同输出，便于单测与复现。
 */
export function detectStall(input: StallDetectionInput): readonly StallSignal[] {
  const options: StallDetectionOptions = { ...DEFAULT_STALL_OPTIONS, ...input.options }
  const signals: StallSignal[] = []
  const expected = [...input.slots].sort(compareCodeUnit)

  // (1) 从未提交过简报。
  const silent = expected.filter((slot) => !input.snapshot.briefings.some((briefing) => briefing.slot === slot))
  if (silent.length > 0) {
    signals.push({
      kind: 'silent-slot',
      slots: silent,
      detail: `${silent.length} 个成员从未提交简报：${silent.join(', ')}`,
    })
  }

  // (2) 轮次 / 时间双阈值。任一超限即报，取更早成立者。
  const stale: AgentSlotId[] = []
  const staleDetails: string[] = []
  for (const briefing of input.snapshot.briefings) {
    const roundLag = input.currentRound - briefing.round
    const timeLag = input.now - briefing.at
    if (roundLag >= options.staleRounds) {
      stale.push(briefing.slot)
      staleDetails.push(`${briefing.slot}(落后 ${roundLag} 轮)`)
    } else if (timeLag >= options.staleMs) {
      stale.push(briefing.slot)
      staleDetails.push(`${briefing.slot}(静默 ${Math.round(timeLag / 60000)} 分钟)`)
    }
  }
  if (stale.length > 0) {
    signals.push({
      kind: 'stale-briefing',
      slots: [...stale].sort(compareCodeUnit),
      detail: `简报过期：${staleDetails.join('、')}`,
    })
  }

  // (3) 指纹连续重复。只看每个槽位自己的时间线，按写入顺序。
  const repeated: AgentSlotId[] = []
  const repeatedDetails: string[] = []
  for (const slot of expected) {
    const timeline = input.history.filter((briefing) => briefing.slot === slot)
    const run = trailingRunLength(timeline)
    if (run >= options.repeatedFingerprints) {
      repeated.push(slot)
      repeatedDetails.push(`${slot}(连续 ${run} 次相同)`)
    }
  }
  if (repeated.length > 0) {
    signals.push({
      kind: 'repeated-fingerprint',
      slots: repeated,
      detail: `疑似空转：${repeatedDetails.join('、')}。同一状态被反复提交，通常意味着 Agent 在原地打转。`,
    })
  }

  // (4) 全局无进展。
  const lastWrite = input.history.length === 0 ? undefined : input.history[input.history.length - 1]
  if (lastWrite === undefined) {
    if (expected.length > 0) {
      signals.push({
        kind: 'no-progress',
        slots: expected,
        detail: '看板从未有任何简报写入。',
      })
    }
  } else if (input.now - lastWrite.at >= options.noProgressMs) {
    signals.push({
      kind: 'no-progress',
      slots: expected,
      detail: `看板已 ${Math.round((input.now - lastWrite.at) / 60000)} 分钟没有任何新增。`,
    })
  }

  return signals
}

/** 时间线末尾连续相同指纹的长度。 */
function trailingRunLength(timeline: readonly Briefing[]): number {
  if (timeline.length === 0) return 0
  const last = timeline[timeline.length - 1]
  if (last === undefined) return 0
  let run = 0
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const current = timeline[index]
    if (current === undefined || current.fingerprint !== last.fingerprint) break
    run += 1
  }
  return run
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
