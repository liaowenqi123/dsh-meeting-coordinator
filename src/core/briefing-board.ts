/**
 * 简报板：领域隔离子 Agent 之间**唯一**的共享通道。
 *
 * ## 设计依据（来自竞品调研的失败教训）
 *
 * - **必须外置持久化**。Caucus 是内存态，重启清空需重 join；
 *   dsh-ai-solution-council 进程重启后 queued/running 一律标 failed。
 *   本实现用追加式 JSONL 作唯一事实来源，进程重启后 `revision` 与简报历史不丢。
 * - **追加式而非覆盖式**。覆盖写会在并发下丢数据，且无法审计"谁在第几轮说了什么"。
 * - **长度硬上限**。简报通道是全体成员每轮都要付的固定上下文成本，
 *   超限显式报错（见 `BriefingBudgetExceeded`），不静默截断。
 *
 * ## 并发契约（明确受限，不假装是数据库）
 *
 * 多个 Agent 进程可同时 append：单次 `appendFileSync` 在 O_APPEND 语义下对小记录
 * 是原子的。但**本实现不提供跨进程事务**。因此：
 * - 单条记录必须短（受 `maxBriefingChars` 约束，天然满足）；
 * - `revision` 由重放得出，不依赖计数器文件，避免读改写竞态；
 * - 读到尾部残行（进程在写入中途被杀）时丢弃该行而不是抛错。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertDraftWellFormed,
  assertWithinBudget,
  briefingFingerprint,
  countChars,
  normalizeField,
} from './briefing-text.js'
import type {
  AgentSlotId,
  AgendaItem,
  BoardSnapshot,
  Briefing,
  BriefingDraft,
  MeetingAgenda,
  MeetingScope,
  MeetingTriggerKind,
} from './types.js'

/** 落盘记录：`Briefing` 去掉可由重放推导的字段，保证磁盘格式最小且前向兼容。 */
interface BoardRecord {
  readonly v: 1
  readonly slot: string
  readonly domain: string
  readonly round: number
  readonly status: string
  readonly blocker: string | null
  readonly needs: readonly string[]
  readonly requestedFrom: readonly AgentSlotId[]
  readonly at: number
}

export interface BriefingBoardOptions {
  /** 板的持久化根目录。每个 boardDomain 一个子目录。 */
  readonly rootDir: string
  readonly boardDomain: string
  /** 简报字符硬上限（code point）。 */
  readonly maxBriefingChars: number
  /** 广播摘要总预算。 */
  readonly maxAgendaChars: number
  /** 注入时钟，便于测试与复现。 */
  readonly now?: (() => number) | undefined
}

export class BoardCorrupted extends Error {
  readonly code = 'meeting/board-corrupted'

  constructor(message: string) {
    super(message)
    this.name = 'BoardCorrupted'
  }
}

/**
 * 文件支撑的简报板。
 *
 * 每次 `publish` 追加一行；每次读取重放。
 * `revision` == 有效记录条数，因此**可从磁盘内容独立复算**，不需要额外的计数器文件。
 */
export class BriefingBoard {
  readonly boardDomain: string
  private readonly rootDir: string
  private readonly maxBriefingChars: number
  private readonly maxAgendaChars: number
  private readonly now: () => number

  constructor(options: BriefingBoardOptions) {
    if (normalizeField(options.boardDomain).length === 0) {
      throw new BoardCorrupted('boardDomain 不能为空。')
    }
    this.boardDomain = options.boardDomain
    this.rootDir = join(options.rootDir, sanitizeSegment(options.boardDomain))
    this.maxBriefingChars = options.maxBriefingChars
    this.maxAgendaChars = options.maxAgendaChars
    this.now = options.now ?? (() => Date.now())
  }

  /** 该板的 JSONL 文件绝对路径。 */
  get filePath(): string {
    return join(this.rootDir, 'board.jsonl')
  }

  private ensureDir(): void {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true })
    }
  }

  /**
   * 提交一份简报。
   *
   * 校验顺序刻意固定：先结构、再预算，最后落盘。任何一步失败都不产生副作用。
   */
  publish(draft: BriefingDraft): Briefing {
    assertDraftWellFormed(draft)
    const chars = assertWithinBudget(draft, this.maxBriefingChars)

    const blocker = draft.blocker == null ? null : normalizeField(draft.blocker)
    const needs = (draft.needs ?? []).map(normalizeField).filter((item) => item.length > 0)
    const requestedFrom = [...new Set(draft.requestedFrom ?? [])].sort(compareCodeUnit)

    const record: BoardRecord = {
      v: 1,
      slot: normalizeField(draft.slot),
      domain: normalizeField(draft.domain),
      round: draft.round,
      status: normalizeField(draft.status),
      blocker: blocker === '' ? null : blocker,
      needs,
      requestedFrom,
      at: this.now(),
    }

    this.ensureDir()
    // 单次 append：依赖 O_APPEND 的原子性；不做读改写，避免跨进程竞态。
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })

    const revision = this.records().length
    return this.toBriefing(record, revision)
  }

  /** 重放全部有效记录。尾部残行被忽略（进程中途被杀）。 */
  private records(): readonly BoardRecord[] {
    if (!existsSync(this.filePath)) return []
    const text = readFileSync(this.filePath, 'utf8')
    const out: BoardRecord[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        // 只可能发生在最后一行（写入被中断）；中间损坏说明有人手改了文件，必须暴露。
        if (out.length > 0 && !text.endsWith('\n')) continue
        throw new BoardCorrupted(`简报板 ${this.filePath} 存在无法解析的记录：${trimmed.slice(0, 120)}`)
      }
      out.push(coerceRecord(parsed, this.filePath))
    }
    return out
  }

  private toBriefing(record: BoardRecord, revision: number): Briefing {
    const draft: BriefingDraft = {
      slot: record.slot,
      domain: record.domain,
      round: record.round,
      status: record.status,
      blocker: record.blocker,
      needs: record.needs,
      requestedFrom: record.requestedFrom,
    }
    return {
      slot: record.slot,
      domain: record.domain,
      round: record.round,
      status: record.status,
      blocker: record.blocker,
      needs: record.needs,
      requestedFrom: record.requestedFrom,
      boardRevision: revision,
      at: record.at,
      fingerprint: briefingFingerprint(draft),
      chars: countChars(record.status) + (record.blocker === null ? 0 : countChars(record.blocker)) +
        record.needs.reduce((sum, need) => sum + countChars(need), 0),
    }
  }

  /** 当前看板快照：每个槽位的最新简报，按 slot code-unit 排序。 */
  snapshot(): BoardSnapshot {
    const records = this.records()
    const latest = new Map<string, { record: BoardRecord; revision: number }>()
    records.forEach((record, index) => {
      latest.set(record.slot, { record, revision: index + 1 })
    })
    const briefings = [...latest.values()]
      .map((entry) => this.toBriefing(entry.record, entry.revision))
      .sort((left, right) => compareCodeUnit(left.slot, right.slot))
    return { revision: records.length, briefings }
  }

  /** 某个槽位的最新简报。 */
  latest(slot: AgentSlotId): Briefing | undefined {
    return this.snapshot().briefings.find((briefing) => briefing.slot === slot)
  }

  /** 全部槽位的简报时间线（按写入顺序）。 */
  history(): readonly Briefing[] {
    const records = this.records()
    return records.map((record, index) => this.toBriefing(record, index + 1))
  }

  /**
   * 汇总议程。只取 scope 内成员的最新简报 —— 这是"隔离 + 跨上下文通信"的落点：
   * 每个成员贡献的是**自己产出的限长摘要**，而不是它的上下文。
   */
  summarize(input: {
    readonly scope: MeetingScope
    readonly trigger: MeetingTriggerKind
    readonly reason: string
    readonly participants: readonly AgentSlotId[]
  }): MeetingAgenda {
    const snapshot = this.snapshot()
    const wanted = new Set(input.participants)
    const inScope = snapshot.briefings.filter((briefing) => wanted.has(briefing.slot))

    let truncated = false
    const items: AgendaItem[] = []
    for (const briefing of inScope) {
      items.push({
        slot: briefing.slot,
        domain: briefing.domain,
        round: briefing.round,
        status: briefing.status,
        blocker: briefing.blocker,
        needs: briefing.needs,
        stalled: false,
      })
    }
    const missing = [...wanted].filter((slot) => !inScope.some((briefing) => briefing.slot === slot)).sort(compareCodeUnit)

    const header =
      `[例会] board=${this.boardDomain} scope=${input.scope} trigger=${input.trigger} ` +
      `rev=${snapshot.revision} reason=${input.reason}`

    const lines: string[] = [header]
    for (const item of items) {
      const parts = [`${item.slot}(${item.domain} r${item.round}) ${item.status}`]
      if (item.blocker !== null) parts.push(`障碍:${item.blocker}`)
      if (item.needs.length > 0) parts.push(`需要:${item.needs.join('/')}`)
      lines.push(`- ${parts.join(' | ')}`)
    }
    if (missing.length > 0) {
      truncated = true
      lines.push(`- 缺席(未提交简报): ${missing.join(', ')}`)
    }

    const { text, wasTruncated } = truncateLines(lines, this.maxAgendaChars)
    truncated = truncated || wasTruncated

    return {
      id: `meeting-${this.boardDomain}-${snapshot.revision}-${input.trigger}`,
      scope: input.scope,
      trigger: input.trigger,
      reason: input.reason,
      at: this.now(),
      boardRevision: snapshot.revision,
      participants: [...wanted].sort(compareCodeUnit),
      items,
      digest: text,
      digestChars: countChars(text),
      truncated,
    }
  }
}

// ---------------------------------------------------------------------------

function sanitizeSegment(value: string): string {
  // 只允许安全字符，防止 boardDomain 里的 `..` 或路径分隔符逃出 rootDir。
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_')
  if (safe === '' || safe === '.' || safe === '..') {
    throw new BoardCorrupted(`boardDomain ${JSON.stringify(value)} 无法映射为安全目录名。`)
  }
  return safe
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function coerceRecord(value: unknown, filePath: string): BoardRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BoardCorrupted(`${filePath} 含非对象记录。`)
  }
  const raw = value as Record<string, unknown>
  if (raw['v'] !== 1) {
    throw new BoardCorrupted(`${filePath} 含未知记录版本 ${JSON.stringify(raw['v'])}。`)
  }
  const needsRaw = raw['needs']
  const requestedRaw = raw['requestedFrom']
  return {
    v: 1,
    slot: String(raw['slot']),
    domain: String(raw['domain']),
    round: Number(raw['round']),
    status: String(raw['status']),
    blocker: raw['blocker'] == null ? null : String(raw['blocker']),
    needs: Array.isArray(needsRaw) ? needsRaw.map(String) : [],
    requestedFrom: Array.isArray(requestedRaw) ? requestedRaw.map(String) : [],
    at: Number(raw['at']),
  }
}

/**
 * 按行截断到预算内。
 *
 * 不会切出半行：要么整行保留，要么丢弃并标记 `truncated`。
 * 半行摘要比没有摘要更糟——它会制造"看起来完整"的误导性信息。
 */
function truncateLines(lines: readonly string[], budget: number): { text: string; wasTruncated: boolean } {
  const kept: string[] = []
  let used = 0
  let wasTruncated = false
  for (const line of lines) {
    const cost = countChars(line) + (kept.length > 0 ? 1 : 0)
    if (used + cost > budget) {
      wasTruncated = true
      break
    }
    kept.push(line)
    used += cost
  }
  if (kept.length < lines.length) wasTruncated = true
  const text = wasTruncated ? `${kept.join('\n')}\n…(议程超出 ${budget} 字符预算，已截断)` : kept.join('\n')
  return { text, wasTruncated }
}
