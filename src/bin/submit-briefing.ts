/**
 * 简报提交入口 —— 成员侧**唯一的写入通道**。
 *
 * ## 为什么必须有这个文件（实证，不是推测）
 *
 * `dsh-team-runtime.ts` 的 `buildSpawnPrompt()` 对每个成员说：
 * "每完成一轮工作，提交一份不超过 200 字的简报"。
 * 但插件**没有注册任何 tool / command**（`ctx.tools`、命令注册在全仓 grep 零命中），
 * 成员手里只有文件系统 —— 也就是：这句话在实现上没有落点，成员没有嘴。
 *
 * 实证：demo 板连跑 3 轮 `trigger=stall`，`rev=0`，摘要文案始终是
 * "缺席(未提交简报): live-trading, neural-net"。
 * 这不是成员不配合，是通道不存在。本文件补上通道。
 *
 * ## 为什么复用 `BriefingBoard.publish` 而不是直接 append JSONL
 *
 * 直接写文件能落盘，但会绕过 `assertDraftWellFormed` 与 `assertWithinBudget`
 * （200 字符硬上限的意义正是"显式报错，不静默超长"）。
 * 本入口复用生产同一个类、同一条"先校验后落盘"路径，保证 CLI 写出的行与
 * 协调器 `publish()` 写出的行完全同构 —— 不存在第二套磁盘格式。
 *
 * ## 用法
 *
 *   pnpm exec tsx src/bin/submit-briefing.ts \
 *     --slot neural-net --domain quant-lab --round 1 \
 *     --status '模型：3 层残差定型，正在压第 2 轮训练节奏' \
 *     --blocker '缺 holdout 切分口径' \
 *     --need '与 live-trading 对齐样本外起点'
 *
 * 整份草稿走 JSON（回避 shell 引号问题，`-` 表示读 stdin）：
 *   echo '{"slot":"neural-net","domain":"quant-lab","round":1,"status":"..."}' \
 *     | pnpm exec tsx src/bin/submit-briefing.ts --json -
 *
 * 先自检预算不落盘：加 `--dry-run`。
 *
 * 看板坐标解析顺序（与 `host.ts` 的 apply 完全一致，不另立一套）：
 *   `--root-dir` / `--board-domain` > `DSH_MEETING_ROOT` / `DSH_MEETING_BOARD` > 默认值。
 *
 * 退出码：0 成功；1 用法或配置错误；2 草稿非法/看板损坏；3 超预算。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoardCorrupted, BriefingBoard } from '../core/briefing-board.js'
import {
  BriefingBudgetExceeded,
  BriefingInvalid,
  DEFAULT_MAX_BRIEFING_CHARS,
  assertDraftWellFormed,
  assertWithinBudget,
} from '../core/briefing-text.js'
import type { BriefingDraft } from '../core/types.js'

/** 默认议程预算，与 facet/host 的 `maxAgendaChars` 缺省保持一致。 */
const DEFAULT_MAX_AGENDA_CHARS = 1200

const USAGE = [
  '用法：submit-briefing --slot <id> --domain <domain> --round <n> --status <文本>',
  '                        [--blocker <文本>] [--need <文本>]... [--needs a,b]',
  '                        [--requested-from <slot>[,<slot>]]',
  '                        [--root-dir <dir>] [--board-domain <name>]',
  '                        [--max-chars <n>] [--max-agenda-chars <n>]',
  '                        [--json <json>|-] [--dry-run] [--help]',
  '',
  '简报计入预算的字段：status + blocker + needs（合计不超过 --max-chars，缺省 200）。',
].join('\n')

/** 用法级错误（缺参数、格式不对）—— 与看板校验失败区分开，退出码不同。 */
export class BriefingCliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BriefingCliUsageError'
  }
}

export interface CliOptions {
  slot: string | undefined
  domain: string | undefined
  round: number | undefined
  status: string | undefined
  blocker: string | null | undefined
  needs: string[]
  requestedFrom: string[]
  rootDir: string | undefined
  boardDomain: string | undefined
  maxChars: number | undefined
  maxAgendaChars: number | undefined
  json: string | undefined
  dryRun: boolean
  help: boolean
}

export interface SubmitBriefingIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** 读 stdin（`--json -`）。与网络/时钟无关，测试可注入。 */
  readonly readStdin: () => string
}

export interface SubmitBriefingInput {
  readonly argv: readonly string[]
  readonly env: Record<string, string | undefined>
  readonly cwd: string
  readonly io: SubmitBriefingIo
}

/**
 * 解析参数。
 *
 * 支持 `--k v` 与 `--k=v` 两种写法（后者在脚本里更安全，不会被 shell 吃掉取值）。
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    slot: undefined,
    domain: undefined,
    round: undefined,
    status: undefined,
    blocker: undefined,
    needs: [],
    requestedFrom: [],
    rootDir: undefined,
    boardDomain: undefined,
    maxChars: undefined,
    maxAgendaChars: undefined,
    json: undefined,
    dryRun: false,
    help: false,
  }

  /** 取一个带取值的 flag；返回下一个待解析下标。 */
  const take = (index: number, arg: string): { value: string; next: number } => {
    const eq = arg.indexOf('=')
    if (eq >= 0) return { value: arg.slice(eq + 1), next: index + 1 }
    const value = argv[index + 1]
    if (value === undefined) throw new BriefingCliUsageError(`参数 ${arg} 缺少取值。`)
    return { value, next: index + 2 }
  }

  const commaList = (value: string): string[] =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)

  for (let i = 0; i < argv.length; ) {
    const arg = argv[i]
    if (arg === undefined) break
    const eq = arg.indexOf('=')
    const flag = eq >= 0 ? arg.slice(0, eq) : arg

    switch (flag) {
      case '--slot': {
        const taken = take(i, arg)
        opts.slot = taken.value
        i = taken.next
        break
      }
      case '--domain': {
        const taken = take(i, arg)
        opts.domain = taken.value
        i = taken.next
        break
      }
      case '--round': {
        const taken = take(i, arg)
        opts.round = parseInteger(taken.value, '--round')
        i = taken.next
        break
      }
      case '--status': {
        const taken = take(i, arg)
        opts.status = taken.value
        i = taken.next
        break
      }
      case '--blocker': {
        const taken = take(i, arg)
        opts.blocker = taken.value
        i = taken.next
        break
      }
      case '--need': {
        const taken = take(i, arg)
        opts.needs.push(taken.value)
        i = taken.next
        break
      }
      case '--needs': {
        const taken = take(i, arg)
        opts.needs.push(...commaList(taken.value))
        i = taken.next
        break
      }
      case '--requested-from': {
        const taken = take(i, arg)
        opts.requestedFrom.push(...commaList(taken.value))
        i = taken.next
        break
      }
      case '--root-dir': {
        const taken = take(i, arg)
        opts.rootDir = taken.value
        i = taken.next
        break
      }
      case '--board-domain': {
        const taken = take(i, arg)
        opts.boardDomain = taken.value
        i = taken.next
        break
      }
      case '--max-chars': {
        const taken = take(i, arg)
        opts.maxChars = parseInteger(taken.value, '--max-chars')
        i = taken.next
        break
      }
      case '--max-agenda-chars': {
        const taken = take(i, arg)
        opts.maxAgendaChars = parseInteger(taken.value, '--max-agenda-chars')
        i = taken.next
        break
      }
      case '--json': {
        const taken = take(i, arg)
        opts.json = taken.value
        i = taken.next
        break
      }
      case '--dry-run': {
        opts.dryRun = true
        i += 1
        break
      }
      case '--help':
      case '-h': {
        opts.help = true
        i += 1
        break
      }
      default: {
        throw new BriefingCliUsageError(`未知参数 ${arg}。`)
      }
    }
  }

  return opts
}

/**
 * 提交简报。**不调 `process`**，`argv/env/cwd/io` 全部注入 ——
 * 这样测试可以覆盖真实的校验与落盘路径，而不必 spawn 子进程。
 *
 * @returns 退出码（语义见文件头）。
 */
export function submitBriefing(input: SubmitBriefingInput): number {
  const { argv, env, cwd, io } = input

  let opts: CliOptions
  try {
    opts = parseArgs(argv)
  } catch (error) {
    io.err(`✗ 用法错误：${messageOf(error)}`)
    io.err(USAGE)
    return 1
  }

  if (opts.help) {
    io.out(USAGE)
    return 0
  }

  // 坐标解析顺序刻意与 host.ts 的 apply() 一致：flag > env > 默认值。
  const rootDir = opts.rootDir ?? env['DSH_MEETING_ROOT'] ?? join(cwd, '.dsh-meeting')
  const boardDomain = opts.boardDomain ?? env['DSH_MEETING_BOARD'] ?? 'default'
  const maxBriefingChars =
    opts.maxChars ?? positiveInteger(env['DSH_MEETING_MAX_BRIEFING_CHARS']) ?? DEFAULT_MAX_BRIEFING_CHARS
  const maxAgendaChars =
    opts.maxAgendaChars ?? positiveInteger(env['DSH_MEETING_MAX_AGENDA_CHARS']) ?? DEFAULT_MAX_AGENDA_CHARS

  let draft: BriefingDraft
  try {
    const source = readDraftSource(opts, io)
    draft = buildDraft(opts, source)
  } catch (error) {
    io.err(`✗ 用法错误：${messageOf(error)}`)
    io.err(USAGE)
    return 1
  }

  const board = new BriefingBoard({ rootDir, boardDomain, maxBriefingChars, maxAgendaChars })

  if (opts.dryRun) {
    try {
      assertDraftWellFormed(draft)
      const chars = assertWithinBudget(draft, maxBriefingChars)
      io.out(
        `✓ 草稿合法（--dry-run 未落盘）：${draft.slot}@${draft.domain} r${draft.round}，` +
          `计入预算 ${chars}/${maxBriefingChars} 字符。`,
      )
      io.out(
        JSON.stringify({
          ok: true,
          dryRun: true,
          slot: draft.slot,
          domain: draft.domain,
          round: draft.round,
          chars,
          limit: maxBriefingChars,
          boardDomain,
          file: board.filePath,
        }),
      )
      return 0
    } catch (error) {
      return reportFailure(error, io)
    }
  }

  try {
    const briefing = board.publish(draft)
    io.out(
      `✓ 已提交简报：${briefing.slot}@${briefing.domain} r${briefing.round} → 看板 rev=${briefing.boardRevision} ` +
        `（计入预算 ${briefing.chars}/${maxBriefingChars} 字符，指纹 ${briefing.fingerprint}）`,
    )
    // 机器可读回执：成员据此确认"确实写进去了"，而不是自认为写了。
    io.out(JSON.stringify({ ok: true, ...briefing, limit: maxBriefingChars, boardDomain, file: board.filePath }))
    return 0
  } catch (error) {
    return reportFailure(error, io)
  }
}

// ---------------------------------------------------------------------------
// 纯函数辅助

/** 把失败翻译成"能照着改"的提示 + 稳定退出码。 */
function reportFailure(error: unknown, io: SubmitBriefingIo): number {
  if (error instanceof BriefingBudgetExceeded) {
    io.err(`✗ 简报超长：上限 ${error.limit} 字符，实际 ${error.actual} 字符。请压缩 status / blocker / needs 后重试。`)
    io.err(JSON.stringify({ ok: false, code: error.code, limit: error.limit, actual: error.actual }))
    return 3
  }
  if (error instanceof BriefingInvalid) {
    io.err(`✗ 简报非法：${error.message}`)
    io.err(JSON.stringify({ ok: false, code: error.code }))
    return 2
  }
  if (error instanceof BoardCorrupted) {
    // 看板损坏不能当成"这次没提交上"糊过去 —— 它会影响全体成员的重放结果。
    io.err(`✗ 看板损坏（未写入）：${error.message}`)
    io.err(JSON.stringify({ ok: false, code: error.code }))
    return 2
  }
  io.err(`✗ 提交失败：${messageOf(error)}`)
  return 1
}

/** `--json` 取值；`-` 表示读 stdin。 */
function readDraftSource(opts: CliOptions, io: SubmitBriefingIo): Record<string, unknown> {
  if (opts.json === undefined) return {}
  const text = opts.json === '-' ? io.readStdin() : opts.json
  if (text.trim().length === 0) throw new BriefingCliUsageError('--json 取值为空（若用 `-` 请从 stdin 传入 JSON 对象）。')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new BriefingCliUsageError(`--json 不是合法 JSON：${messageOf(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BriefingCliUsageError('--json 必须是 JSON 对象（形如 {"slot":...,"domain":...,"round":1,"status":"..."}）。')
  }
  return parsed as Record<string, unknown>
}

/**
 * 合成草稿：显式 flag 优先于 `--json` 里的同名字段。
 *
 * 缺 `slot`/`domain`/`round`/`status` 一律当成**用法错误**（退出码 1），
 * 而不是塞默认值 —— `round` 是成员的自报轮次，替它编一个数会让
 * "连续 N 轮未更新"的停滞判定失真。
 */
function buildDraft(opts: CliOptions, source: Record<string, unknown>): BriefingDraft {
  const slot = opts.slot ?? optionalString(source['slot'], 'slot')
  const domain = opts.domain ?? optionalString(source['domain'], 'domain')
  const status = opts.status ?? optionalString(source['status'], 'status')
  const round = opts.round ?? optionalInteger(source['round'], 'round')

  if (slot === undefined) throw new BriefingCliUsageError('缺少 --slot（成员 id，如 neural-net）。')
  if (domain === undefined) throw new BriefingCliUsageError('缺少 --domain（领域，如 quant-lab）。')
  if (round === undefined) throw new BriefingCliUsageError('缺少 --round（自报工作轮次，非负整数）。')
  if (status === undefined) throw new BriefingCliUsageError('缺少 --status（当前状态，一句话）。')

  const blocker =
    opts.blocker !== undefined ? opts.blocker : source['blocker'] == null ? null : optionalString(source['blocker'], 'blocker')

  const needs = opts.needs.length > 0 ? opts.needs : optionalStringArray(source['needs'], 'needs')
  const requestedFrom =
    opts.requestedFrom.length > 0
      ? opts.requestedFrom
      : optionalStringArray(source['requestedFrom'], 'requestedFrom')

  return {
    slot,
    domain,
    round,
    status,
    blocker: blocker ?? null,
    needs,
    requestedFrom,
  }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new BriefingCliUsageError(`${name} 必须是字符串。`)
  return value
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string') return parseInteger(value, name)
  throw new BriefingCliUsageError(`${name} 必须是整数。`)
}

function optionalStringArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) throw new BriefingCliUsageError(`${name} 必须是字符串或字符串数组。`)
  return value.map((item) => {
    if (typeof item !== 'string') throw new BriefingCliUsageError(`${name} 的元素必须是字符串。`)
    return item
  })
}

function parseInteger(value: string, name: string): number {
  const trimmed = value.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) throw new BriefingCliUsageError(`${name} 取值 ${JSON.stringify(value)} 不是整数。`)
  return Number.parseInt(trimmed, 10)
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number.parseInt(trimmed, 10)
  return parsed > 0 ? parsed : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 进程入口：这里才第一次碰 `process`。 */
function main(): void {
  const exitCode = submitBriefing({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    io: {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      readStdin: () => readFileSync(0, 'utf8'),
    },
  })
  if (exitCode !== 0) process.exitCode = exitCode
}

// 只在作为入口直接运行时执行；被测试 import 时不碰 process。
if (process.argv[1] !== undefined && import.meta.url === pathToFileUrlSafe(process.argv[1])) {
  main()
}

/** Windows 上 `process.argv[1]` 是反斜杠路径，必须转成 file URL 才能与 `import.meta.url` 比较。 */
function pathToFileUrlSafe(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return new URL(normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`).href
}
