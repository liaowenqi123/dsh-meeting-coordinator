/**
 * 简报板 + 停滞检测 + 触发规则的测试。
 *
 * 这里断言的是"打破死循环"的判据质量：信号必须由**外部**计算出来，
 * 且不能因为一个刚开完会就卡住的 Agent 被节流规则挡住。
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BriefingBoard,
  BriefingBudgetExceeded,
  countChars,
  briefingFingerprint,
  BriefingInvalid,
} from '../src/index.js'
import { detectStall, DEFAULT_STALL_OPTIONS } from '../src/core/stall-detector.js'
import { evaluateTriggers, type TriggerPolicy } from '../src/core/triggers.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-meeting-test-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function board(maxBriefingChars = 200, now?: () => number): BriefingBoard {
  return new BriefingBoard({
    rootDir: root,
    boardDomain: 'quant',
    maxBriefingChars,
    maxAgendaChars: 1200,
    ...(now === undefined ? {} : { now }),
  })
}

describe('简报预算', () => {
  it('按 code point 计数，中文与 emoji 不吃亏', () => {
    // '中' 是 1 个 code point / 1 个 UTF-16 unit；'𝄞' 是 1 个 code point / 2 个 UTF-16 unit。
    expect(countChars('中')).toBe(1)
    expect(countChars('𝄞')).toBe(1)
    expect(countChars('𝄞'.repeat(10))).toBe(10)
  })

  it('超限直接抛错，绝不静默截断', () => {
    const b = board(10)
    expect(() => b.publish({ slot: 'a', domain: 'd', round: 1, status: '一二三四五六七八九十十一' })).toThrow(
      BriefingBudgetExceeded,
    )
    // 失败不能产生副作用。
    expect(b.snapshot().revision).toBe(0)
  })

  it('status + blocker + needs 共同计入预算', () => {
    const b = board(20)
    // status 5 + blocker 5 + needs 5+5 = 20，刚好通过。
    expect(() =>
      b.publish({ slot: 'a', domain: 'd', round: 1, status: '一二三四五', blocker: '六七八九十', needs: ['甲乙丙丁戊', '子丑寅卯辰'] }),
    ).not.toThrow()
    expect(() =>
      b.publish({ slot: 'a', domain: 'd', round: 2, status: '一二三四五', blocker: '六七八九十', needs: ['甲乙丙丁戊', '子丑寅卯辰已'] }),
    ).toThrow(BriefingBudgetExceeded)
  })

  it('缺少必填字段时报结构错误而不是预算错误', () => {
    expect(() => board().publish({ slot: 'a', domain: 'd', round: 1, status: '   ' })).toThrow(BriefingInvalid)
    expect(() => board().publish({ slot: '', domain: 'd', round: 1, status: 'x' })).toThrow(BriefingInvalid)
    expect(() => board().publish({ slot: 'a', domain: 'd', round: -1, status: 'x' })).toThrow(BriefingInvalid)
  })
})

describe('简报板持久化', () => {
  it('追加式 JSONL 是唯一事实来源：新实例重放得到相同 revision 与简报', () => {
    const now = (): number => 1_000
    const b1 = board(200, now)
    b1.publish({ slot: 'a', domain: 'x', round: 1, status: 's1' })
    b1.publish({ slot: 'b', domain: 'y', round: 1, status: 's2' })
    b1.publish({ slot: 'a', domain: 'x', round: 2, status: 's3' })

    // 全新实例（模拟进程重启）不应依赖任何内存状态。
    const b2 = board(200, now)
    const snapshot = b2.snapshot()
    expect(snapshot.revision).toBe(3)
    expect(snapshot.briefings.map((x) => `${x.slot}:${x.status}`)).toEqual(['a:s3', 'b:s2'])
    expect(b2.history()).toHaveLength(3)
  })

  it('尾部残行（写入被中断）被忽略而不是让整块板报废', () => {
    const b1 = board(200)
    b1.publish({ slot: 'a', domain: 'x', round: 1, status: 's1' })
    const file = b1.filePath
    // 模拟进程在写第二行途中被杀。
    appendFileSync(file, '{"v":1,"slot":"b","dom', { encoding: 'utf8' })

    const b2 = board(200)
    expect(b2.snapshot().revision).toBe(1)
    expect(b2.snapshot().briefings[0]?.slot).toBe('a')
  })

  it('会议记录与简报时间线各自落盘，路径可审计', () => {
    const b = board(200)
    b.publish({ slot: 'a', domain: 'x', round: 1, status: 's1' })
    expect(b.filePath.endsWith('board.jsonl')).toBe(true)
    // 文件确实已经存在，且只包含一条记录。
    const lines = readFileSync(b.filePath, 'utf8').split('\n').filter((line) => line.trim().length > 0)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ v: 1, slot: 'a', domain: 'x', round: 1, status: 's1' })
  })
})

describe('内容指纹', () => {
  it('同一内容（忽略 round 与时间）产生同一指纹', () => {
    const base = { slot: 'a', domain: 'x', status: '卡在止损', blocker: '反复触发', needs: ['确认换手率'] }
    expect(briefingFingerprint({ ...base, round: 1 })).toBe(briefingFingerprint({ ...base, round: 9 }))
  })

  it('内容变化会改变指纹', () => {
    const a = briefingFingerprint({ slot: 'a', domain: 'x', round: 1, status: 's1' })
    const b = briefingFingerprint({ slot: 'a', domain: 'x', round: 1, status: 's2' })
    expect(a).not.toBe(b)
  })
})

describe('停滞检测', () => {
  const slots = ['a', 'b']

  it('从未提交简报的成员报 silent-slot', () => {
    const b = board()
    b.publish({ slot: 'a', domain: 'x', round: 1, status: 'ok' })
    const signals = detectStall({ snapshot: b.snapshot(), history: b.history(), slots, currentRound: 1, now: 1 })
    expect(signals.some((s) => s.kind === 'silent-slot' && s.slots.includes('b'))).toBe(true)
  })

  it('连续提交相同内容达到阈值时报 repeated-fingerprint', () => {
    const b = board()
    for (let round = 1; round <= 3; round += 1) {
      b.publish({ slot: 'a', domain: 'x', round, status: '同一句话' })
    }
    const signals = detectStall({
      snapshot: b.snapshot(),
      history: b.history(),
      slots: ['a'],
      currentRound: 3,
      now: 1,
      options: { repeatedFingerprints: 3 },
    })
    const signal = signals.find((s) => s.kind === 'repeated-fingerprint')
    expect(signal).toBeDefined()
    expect(signal?.slots).toEqual(['a'])
  })

  it('轮次落后达到阈值时报 stale-briefing', () => {
    const b = board()
    b.publish({ slot: 'a', domain: 'x', round: 1, status: 'ok' })
    b.publish({ slot: 'b', domain: 'y', round: 10, status: 'ok' })
    const signals = detectStall({
      snapshot: b.snapshot(),
      history: b.history(),
      slots,
      currentRound: 10,
      now: 1,
      options: { staleRounds: 5, staleMs: Number.MAX_SAFE_INTEGER },
    })
    const signal = signals.find((s) => s.kind === 'stale-briefing')
    expect(signal?.slots).toEqual(['a'])
  })

  it('看板长期无新增时报 no-progress', () => {
    const publishedAt = 1_000_000
    const b = board(200, () => publishedAt)
    b.publish({ slot: 'a', domain: 'x', round: 1, status: 'ok' })
    const signals = detectStall({
      snapshot: b.snapshot(),
      history: b.history(),
      slots: ['a'],
      currentRound: 1,
      now: publishedAt + DEFAULT_STALL_OPTIONS.noProgressMs + 10,
      options: { noProgressMs: DEFAULT_STALL_OPTIONS.noProgressMs, staleRounds: 999, staleMs: Number.MAX_SAFE_INTEGER },
    })
    expect(signals.some((s) => s.kind === 'no-progress')).toBe(true)
  })
})

describe('触发规则', () => {
  const policy: TriggerPolicy = {
    everyMs: 4 * 60 * 60 * 1000,
    everyRounds: 10,
    onStall: false,
    minIntervalMs: 10 * 60 * 1000,
    periodicScope: 'global',
  }

  function state(overrides: Partial<Parameters<typeof evaluateTriggers>[0]>) {
    const b = board()
    b.publish({ slot: 'a', domain: 'x', round: 1, status: 'ok' })
    return {
      snapshot: b.snapshot(),
      history: b.history(),
      slots: ['a'],
      currentRound: 1,
      now: 0,
      lastMeetingAt: undefined,
      lastMeetingRound: undefined,
      ...overrides,
    }
  }

  it('首次会议不受最小间隔节流', () => {
    const result = evaluateTriggers(state({ lastMeetingAt: undefined }), policy)
    expect(result.decisions).toHaveLength(0)
    // 没有 lastMeetingAt 时不应有 suppressed。
    expect(result.suppressed).toHaveLength(0)
  })

  it('轮次阈值成立时给出 round 触发', () => {
    const result = evaluateTriggers(
      // now 必须距上次会议超过 minIntervalMs，否则会被节流压制成 suppressed。
      state({ currentRound: 11, lastMeetingRound: 0, lastMeetingAt: 0, now: policy.minIntervalMs + 1 }),
      policy,
    )
    expect(result.decisions.some((d) => d.kind === 'round')).toBe(true)
  })

  it('定时阈值成立时给出 timer 触发', () => {
    const result = evaluateTriggers(
      state({ now: policy.everyMs + 1, lastMeetingAt: 0, lastMeetingRound: 100 }),
      policy,
    )
    expect(result.decisions.some((d) => d.kind === 'timer')).toBe(true)
  })

  it('刚开完会时非停滞触发被压制，且压制原因可读', () => {
    const result = evaluateTriggers(
      state({ currentRound: 100, lastMeetingRound: 0, lastMeetingAt: 100, now: 200 }),
      policy,
    )
    expect(result.decisions).toHaveLength(0)
    expect(result.suppressed.length).toBeGreaterThan(0)
  })

  it('停滞触发（最高优先级）能穿透节流：刚开完会就卡死的 Agent 不会被挡住', () => {
    const b = board()
    for (let round = 1; round <= 3; round += 1) {
      b.publish({ slot: 'a', domain: 'x', round, status: '同一句话' })
    }
    const result = evaluateTriggers(
      {
        snapshot: b.snapshot(),
        history: b.history(),
        slots: ['a'],
        currentRound: 3,
        now: 200,
        lastMeetingAt: 100,
        lastMeetingRound: 3,
      },
      { ...policy, onStall: true, minIntervalMs: 10 * 60 * 1000 },
    )
    expect(result.decisions.some((d) => d.kind === 'stall')).toBe(true)
  })
})

describe('议程摘要', () => {
  it('只包含 scope 内成员，缺席者被列出且标记 truncated', () => {
    const b = board()
    b.publish({ slot: 'a', domain: 'x', round: 1, status: '状态A' })
    const agenda = b.summarize({ scope: 'local', trigger: 'peer-call', reason: '测试', participants: ['a', 'missing'] })
    expect(agenda.items.map((i) => i.slot)).toEqual(['a'])
    expect(agenda.digest).toContain('缺席')
    expect(agenda.truncated).toBe(true)
  })

  it('摘要超预算时按行整体截断，不切出半行', () => {
    const b = new BriefingBoard({ rootDir: root, boardDomain: 'q2', maxBriefingChars: 200, maxAgendaChars: 120 })
    for (const slot of ['a', 'b', 'c', 'd']) {
      b.publish({ slot, domain: 'x', round: 1, status: `${slot} 的状态描述占用一些字符` })
    }
    const agenda = b.summarize({ scope: 'global', trigger: 'timer', reason: 'r', participants: ['a', 'b', 'c', 'd'] })
    expect(agenda.truncated).toBe(true)
    expect(agenda.digestChars).toBeLessThanOrEqual(120 + countChars('\n…(议程超出 120 字符预算，已截断)'))
    // 每一条保留的行都必须是完整的一行（以 header 或 "- " 开头）。
    for (const line of agenda.digest.split('\n')) {
      if (line.length === 0) continue
      expect(line.startsWith('[例会]') || line.startsWith('- ') || line.startsWith('…')).toBe(true)
    }
  })
})
