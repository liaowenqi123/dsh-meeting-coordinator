/**
 * 简报提交 CLI 的测试。
 *
 * 这里断言的是**通道本身成立**，而不是"参数解析好看"：
 * 1. 写出的行必须与 `BriefingBoard.publish()` 写出的行同构（不存在第二套磁盘格式）——
 *    否则协调器的重放会读到看不懂的记录；
 * 2. 校验与预算是**真的**在生效（超限不落盘，而不是静默截断）；
 * 3. 缺字段时**不替成员编造** `round`（编了会让"连续 N 轮未更新"的停滞判定失真）。
 *
 * 全部用例走进程内调用（`argv/env/cwd/io` 注入），不 spawn 子进程：
 * 通道的正确性属于纯逻辑，没有理由依赖进程边界。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BriefingBoard } from '../src/index.js'
import { parseArgs, submitBriefing } from '../src/bin/submit-briefing.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-briefing-cli-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const BOARD_DOMAIN = 'demo'

function boardFile(): string {
  return join(root, BOARD_DOMAIN, 'board.jsonl')
}

interface RunResult {
  readonly code: number
  readonly out: readonly string[]
  readonly err: readonly string[]
  /** stdout 最后一行 = 机器可读回执。 */
  readonly receipt: () => Record<string, unknown>
}

function run(argv: readonly string[], extras: { stdin?: string } = {}): RunResult {
  const out: string[] = []
  const err: string[] = []
  const code = submitBriefing({
    argv,
    // 坐标走 env（与 host.ts 的解析顺序一致），省得每条用例都重复写 flag。
    env: { DSH_MEETING_ROOT: root, DSH_MEETING_BOARD: BOARD_DOMAIN },
    cwd: root,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      readStdin: () => extras.stdin ?? '',
    },
  })
  return {
    code,
    out,
    err,
    receipt: () => {
      const last = out[out.length - 1]
      if (last === undefined) throw new Error('stdout 为空，没有回执。')
      return JSON.parse(last) as Record<string, unknown>
    },
  }
}

const VALID = [
  '--slot',
  'neural-net',
  '--domain',
  'quant-lab',
  '--round',
  '1',
  '--status',
  '模型：3 层残差已定型',
] as const

describe('简报提交 CLI · 成功路径', () => {
  it('提交成功并落盘，协调器可直接读到', () => {
    const result = run(VALID)
    expect(result.code).toBe(0)
    expect(existsSync(boardFile())).toBe(true)

    const receipt = result.receipt()
    expect(receipt['ok']).toBe(true)
    expect(receipt['slot']).toBe('neural-net')
    expect(receipt['boardRevision']).toBe(1)

    // 用生产类的读路径复算，证明 CLI 写的行能被协调器解释。
    const snapshot = new BriefingBoard({
      rootDir: root,
      boardDomain: BOARD_DOMAIN,
      maxBriefingChars: 200,
      maxAgendaChars: 1200,
    }).snapshot()
    expect(snapshot.revision).toBe(1)
    expect(snapshot.briefings.map((item) => item.slot)).toEqual(['neural-net'])
  })

  it('写出的记录与 BriefingBoard.publish 的磁盘格式同构', () => {
    run(VALID)
    const raw = readFileSync(boardFile(), 'utf8').trim()
    const record = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual(
      ['at', 'blocker', 'domain', 'needs', 'requestedFrom', 'round', 'slot', 'status', 'v'].sort(),
    )
    expect(record['v']).toBe(1)
    expect(record['domain']).toBe('quant-lab')
    expect(record['round']).toBe(1)
    expect(record['blocker']).toBeNull()
    expect(record['needs']).toEqual([])
  })

  it('--json 从 stdin 读草稿', () => {
    const result = run(
      ['--json', '-'],
      {
        stdin: JSON.stringify({
          slot: 'live-trading',
          domain: 'quant-live',
          round: 2,
          status: '等待样本外对齐',
          needs: ['holdout 口径'],
        }),
      },
    )
    expect(result.code).toBe(0)
    expect(result.receipt()['slot']).toBe('live-trading')
    expect(result.receipt()['needs']).toEqual(['holdout 口径'])
  })

  it('requestedFrom 去重并排序（与看板一致）', () => {
    const result = run([...VALID, '--requested-from', 'live-trading,neural-net,live-trading'])
    expect(result.code).toBe(0)
    expect(result.receipt()['requestedFrom']).toEqual(['live-trading', 'neural-net'])
  })

  it('同一槽位重复提交：revision 递增，快照仍只保留最新一条', () => {
    run(VALID)
    run([...VALID, '--round', '2', '--status', '第 2 轮：训练节奏已定'])
    const board = new BriefingBoard({
      rootDir: root,
      boardDomain: BOARD_DOMAIN,
      maxBriefingChars: 200,
      maxAgendaChars: 1200,
    })
    const snapshot = board.snapshot()
    expect(snapshot.revision).toBe(2)
    expect(snapshot.briefings).toHaveLength(1)
    expect(snapshot.briefings[0]?.round).toBe(2)
  })
})

describe('简报提交 CLI · 不许静默失败', () => {
  it('超预算：退出码 3 且一个字都不落盘', () => {
    const result = run([...VALID, '--status', 'x'.repeat(250)])
    expect(result.code).toBe(3)
    expect(existsSync(boardFile())).toBe(false)
    expect(result.err.join('\n')).toContain('上限 200 字符')
    expect(result.err.join('\n')).toContain('实际 250 字符')
  })

  it('--dry-run 只校验不落盘', () => {
    const result = run([...VALID, '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.receipt()['dryRun']).toBe(true)
    expect(existsSync(boardFile())).toBe(false)
  })

  it('缺 --status 是用法错误（退出码 1），不落盘', () => {
    const result = run(['--slot', 'neural-net', '--domain', 'quant-lab', '--round', '1'])
    expect(result.code).toBe(1)
    expect(existsSync(boardFile())).toBe(false)
    expect(result.err.join('\n')).toContain('--status')
  })

  it('缺 --round 时不替成员编造轮次', () => {
    const result = run(['--slot', 'neural-net', '--domain', 'quant-lab', '--status', '状态'])
    expect(result.code).toBe(1)
    expect(existsSync(boardFile())).toBe(false)
    expect(result.err.join('\n')).toContain('--round')
  })

  it('round 非整数在解析阶段就被拦下', () => {
    const result = run([...VALID, '--round', '一轮'])
    expect(result.code).toBe(1)
    expect(existsSync(boardFile())).toBe(false)
  })

  it('round 为负数交给看板校验（退出码 2）', () => {
    const result = run(['--json', JSON.stringify({ slot: 'neural-net', domain: 'quant-lab', round: -1, status: '状态' })])
    expect(result.code).toBe(2)
    expect(existsSync(boardFile())).toBe(false)
  })

  it('未知参数被拒绝', () => {
    const result = run([...VALID, '--verbose'])
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('未知参数')
  })

  it('--help 退出码 0 且不落盘', () => {
    const result = run(['--help'])
    expect(result.code).toBe(0)
    expect(result.out.join('\n')).toContain('用法')
    expect(existsSync(boardFile())).toBe(false)
  })
})

describe('简报提交 CLI · 参数解析', () => {
  it('支持 --k=v 写法', () => {
    const opts = parseArgs(['--slot=neural-net', '--round=3', '--needs=a,b'])
    expect(opts.slot).toBe('neural-net')
    expect(opts.round).toBe(3)
    expect(opts.needs).toEqual(['a', 'b'])
  })

  it('--need 可重复，--needs 逗号分隔', () => {
    const opts = parseArgs(['--need', '一', '--need', '二', '--needs', '三,四'])
    expect(opts.needs).toEqual(['一', '二', '三', '四'])
  })
})
