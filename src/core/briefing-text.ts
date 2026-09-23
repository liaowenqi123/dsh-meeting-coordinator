/**
 * 简报文本预算与指纹。
 *
 * 设计依据：简报通道是"每个 Agent 开口前都要付的固定成本"，
 * 因此长度必须是**硬上限 + 分字段预算**，而不是一句"请写 200 字以内"的提示词约定。
 * 超限一律显式报错（`BriefingBudgetExceeded`），不静默截断——
 * 静默截断会让 Agent 误以为自己的诉求已经传达。
 */

import type { BriefingDraft } from './types.js'

/** 领域默认预算：200 字符（按 code point 计）。 */
export const DEFAULT_MAX_BRIEFING_CHARS = 200

export class BriefingBudgetExceeded extends Error {
  readonly code = 'meeting/briefing-budget-exceeded'
  readonly limit: number
  readonly actual: number

  constructor(limit: number, actual: number) {
    super(`简报超长：上限 ${limit} 字符，实际 ${actual} 字符。请压缩 status / blocker / needs 后重新提交。`)
    this.name = 'BriefingBudgetExceeded'
    this.limit = limit
    this.actual = actual
  }
}

export class BriefingInvalid extends Error {
  readonly code = 'meeting/briefing-invalid'

  constructor(message: string) {
    super(message)
    this.name = 'BriefingInvalid'
  }
}

/**
 * 按 Unicode code point 计数。
 *
 * 不用 `string.length`：中文与 emoji 在 UTF-16 下会多算，导致"200 字"对中英文不等价。
 */
export function countChars(value: string): number {
  return [...value].length
}

/** 归一化：去首尾空白，折叠内部连续空白（含换行）为单个空格。 */
export function normalizeField(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 计算一份草稿计入预算的字符数。
 *
 * 计入项：status + blocker + 每个 need。
 * 不计入：slot / domain / round / requestedFrom —— 这些是寻址元数据，不是 Agent 的表达内容。
 */
export function briefingCharCount(draft: BriefingDraft): number {
  let total = countChars(normalizeField(draft.status))
  const blocker = draft.blocker
  if (blocker != null && normalizeField(blocker).length > 0) {
    total += countChars(normalizeField(blocker))
  }
  for (const need of draft.needs ?? []) {
    total += countChars(normalizeField(need))
  }
  return total
}

/** 在预算内校验草稿；超限抛出 {@link BriefingBudgetExceeded}。 */
export function assertWithinBudget(draft: BriefingDraft, maxChars: number): number {
  const actual = briefingCharCount(draft)
  if (actual > maxChars) {
    throw new BriefingBudgetExceeded(maxChars, actual)
  }
  return actual
}

/** 校验必填字段非空。 */
export function assertDraftWellFormed(draft: BriefingDraft): void {
  if (normalizeField(draft.slot).length === 0) {
    throw new BriefingInvalid('简报缺少 slot。')
  }
  if (normalizeField(draft.domain).length === 0) {
    throw new BriefingInvalid(`槽位 ${draft.slot} 的简报缺少 domain。`)
  }
  if (!Number.isInteger(draft.round) || draft.round < 0) {
    throw new BriefingInvalid(`槽位 ${draft.slot} 的 round 必须是非负整数，实际 ${String(draft.round)}。`)
  }
  if (normalizeField(draft.status).length === 0) {
    throw new BriefingInvalid(`槽位 ${draft.slot} 的简报缺少 status。`)
  }
}

/**
 * 内容指纹：用于识别"同一份状态被反复提交"这一死循环信号。
 *
 * 刻意**不含** round 与时间：Agent 每轮都报同一句话，正是要检出的空转模式。
 * 使用规范化后的 status+blocker+needs。
 */
export function briefingFingerprint(draft: BriefingDraft): string {
  const parts = [
    normalizeField(draft.status),
    draft.blocker == null ? '' : normalizeField(draft.blocker),
    (draft.needs ?? []).map(normalizeField).join('\u001f'),
  ]
  const payload = parts.join('\u001e')
  return fnv1a64(payload)
}

/**
 * FNV-1a 64 位（BigInt 实现，输出 16 位十六进制）。
 *
 * 选它而不是 Node `crypto`：指纹只需稳定、跨进程一致、无依赖，
 * 不承担安全职责（简报不是凭据）。与 @dsh-std/composition 内部 digest 的选择保持一致。
 */
export function fnv1a64(input: string): string {
  const FNV_OFFSET = 0xcbf29ce484222325n
  const FNV_PRIME = 0x100000001b3n
  const MASK = 0xffffffffffffffffn
  let hash = FNV_OFFSET
  for (const byte of utf8Bytes(input)) {
    hash = (hash ^ BigInt(byte)) & MASK
    hash = (hash * FNV_PRIME) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}

function* utf8Bytes(input: string): Generator<number> {
  for (const char of input) {
    const cp = char.codePointAt(0)
    if (cp === undefined) continue
    if (cp < 0x80) {
      yield cp
    } else if (cp < 0x800) {
      yield 0xc0 | (cp >> 6)
      yield 0x80 | (cp & 0x3f)
    } else if (cp < 0x10000) {
      yield 0xe0 | (cp >> 12)
      yield 0x80 | ((cp >> 6) & 0x3f)
      yield 0x80 | (cp & 0x3f)
    } else {
      yield 0xf0 | (cp >> 18)
      yield 0x80 | ((cp >> 12) & 0x3f)
      yield 0x80 | ((cp >> 6) & 0x3f)
      yield 0x80 | (cp & 0x3f)
    }
  }
}
