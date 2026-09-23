/**
 * 会议室：一个**多轮群聊会话**。
 *
 * ## 与上一版的区别
 *
 * 上一版把会议做成了"第 1 轮结构化发言（进度/障碍/需要三段式）+ 后续讨论"。
 * 需求明确否掉了这个方向：
 *
 * > 我觉得没必要做结构化的东西，AI 会自动讨论出合理结果的（这个主要还是针对 AI agent 的集会）
 *
 * 所以本版：
 *
 * - **发言内容不设模板**。入场 prompt 只做定位（你是谁、议题是什么、在场有谁），
 *   然后请对方自然表达，不强制分段、不强制字段；
 * - **阶段不分 brief/discuss**，统一是 `speech`；
 * - **发言顺序交给主持人**（`moderator.ts`），会议室本身只负责记录与预算。
 *
 * 唯一保留的"硬约束"是**长度上限**——它不是发言格式，而是防上下文爆炸的工程底线
 * （N 人 × R 轮不做限制就会线性膨胀）。上限宽松且可配。
 *
 * ## 上下文预算
 *
 * 群聊最大的风险是上下文爆炸。`transcriptProjection()` 只保留最近窗口，
 * 并显式标注省略了多少条；总长恒在预算内，不随轮数线性增长。
 */

import type { AgentSlotId, MeetingScope } from './types.js'
import { countChars } from './briefing-text.js'
import { HUMAN_PARTICIPANT } from './participant.js'

/** 一条会议记录。 */
export type MeetingTurnKind =
  /** 入场：系统注入的引导（不是 Agent 说的话）。 */
  | 'entry'
  /** Agent 的一次发言。内容不做结构化。 */
  | 'speech'
  /** 主持人控场发言（点名理由、宣布散会）。 */
  | 'moderator'
  /** 人类发言。 */
  | 'human'

export interface MeetingTurn {
  readonly seq: number
  readonly round: number
  /** 发言者：成员 id、`human`、或 `moderator`。 */
  readonly speaker: string
  readonly kind: MeetingTurnKind
  readonly text: string
  readonly chars: number
  readonly at: number
}

export interface MeetingRoomPolicy {
  /**
   * **第一轮（汇报）**提示词里说的字数（"1600 字以下"）。
   *
   * ⚠️ 与 {@link reportMaxChars}（硬上限）必须分开，且**只把软目标告诉模型**。
   * 一旦把硬上限说出去，模型就会把精力花在"我到底输出了多少字"上，
   * 反复确认、甚至调工具数——那才是真正的算力黑洞。
   * 所以报错时也**只重复软目标**，绝不提硬上限。
   */
  readonly reportGuidanceChars: number
  /** 第一轮的**硬上限**。**绝不能写进提示词**，它只是防空洞。 */
  readonly reportMaxChars: number
  /** **第二轮起（讨论）**提示词里说的字数（"100-200 字"）。 */
  readonly discussGuidanceChars: number
  /** 讨论轮的**硬上限**。超过就报错，但**报错里不说这个数字**。 */
  readonly discussMaxChars: number
  /** 轮次硬顶（防无限循环的兜底；主要判据仍由主持人给出）。 */
  readonly maxRounds: number
  /** 注入模型的 transcript 预算。 */
  readonly transcriptBudgetChars: number
  /**
   * 记忆投影的字符上限。
   *
   * 必须给足量：一次性子 Agent 要"带着 A 的上下文"去发言，
   * 只借一小段尾巴是"披着角色外衣的陌生人"。详见 `dsh-session-catalog.readSessionContext`。
   */
  readonly memoryProjectionChars: number
  /** 等一个正在工作的成员入场的最长时间（毫秒）。超时按缺席处理。 */
  readonly entryWaitMs: number
}

export const DEFAULT_ROOM_POLICY: MeetingRoomPolicy = {
  // 第一轮 = 汇报：提示词说"1600 字以下"，硬上限 5000（**不说出去**）。
  reportGuidanceChars: 1600,
  reportMaxChars: 5000,
  // 第二轮起 = 讨论：提示词说"100-200 字"，硬上限 1000（**不说出去**）。
  discussGuidanceChars: 200,
  discussMaxChars: 1000,
  maxRounds: 6,
  transcriptBudgetChars: 12000,
  // 记忆投影给足量（见字段注释）。
  memoryProjectionChars: 20000,
  entryWaitMs: 120_000,
}

/** 入场引导 prompt。刻意**不**规定发言格式。 */
export interface EntryPromptTemplate {
  build(input: {
    readonly participant: AgentSlotId
    readonly domain: string
    readonly title: string
    readonly reason: string
    readonly scope: MeetingScope
    readonly calledBy: string
    readonly present: readonly string[]
    readonly absent: readonly string[]
    readonly memoryProjection: string
    readonly humanPresent: boolean
    /** 第一轮软目标：说给模型听的建议长度（硬上限不说）。 */
    readonly reportGuidanceChars: number
  }): string
}

export const DEFAULT_ENTRY_PROMPT: EntryPromptTemplate = {
  build(input) {
    const lines = [
      `【会议室入场】你是「${input.title}」（领域 ${input.domain}）。`,
      `本次会议议题：${input.reason}`,
      `召集者：${input.calledBy}；规模：${input.scope === 'global' ? '大会（全体成员）' : '小会（部分成员）'}。`,
      `在场：${input.present.join('、')}${input.humanPresent ? '、human（人类，有发言权）' : ''}`,
      input.absent.length > 0 ? `还没到场（正在忙别的事，到了会自己进来）：${input.absent.join('、')}` : '',
      '',
      '你被叫来开这个会。**用最简单的语言汇报你所面临的处境**，比如：',
      '**发言的第一句话请先报你是谁、在哪个工作区、负责什么方向**（一两句即可），' +
        '这样别人才知道该向谁求助。',
      '- 你现在做到哪了；',
      '- 你遇到了什么问题、卡在哪里；',
      '- 你需要谁的什么帮助，或者你能给别人提供什么。',
      '如果你这边确实没有新的、与议题相关的内容，直接说一句就行，不要为了凑话重复别人。',
      '',
      '规则：',
      '- 这是一个多轮会议，由主持人控场决定发言顺序；你会在轮到你时被叫到。',
      '- 只讲**你自己方向**的事，不要替别人判断他们的领域。',
      input.humanPresent ? '- 人类可能在任意时刻插话，插话后请优先响应人类。' : '',
      `- 字数要求 ${input.reportGuidanceChars} 字以下。`,
      '- 没有固定格式，怎么表达清楚就怎么来。',
      '',
      '你的私有记忆投影（只包含与你相关的部分；别人看不到这些）：',
      input.memoryProjection,
    ]
    return lines.filter((line) => line.length > 0).join('\n')
  },
}

export interface MeetingRoomOptions {
  readonly id: string
  readonly scope: MeetingScope
  /** 召集者：成员 id 或 `human`。 */
  readonly calledBy: string
  readonly reason: string
  /** **已到场**、可以发言的成员。 */
  readonly present: readonly string[]
  /** 被召集但还没到场的成员（还在忙）。他们到了会由 `admit()` 加进来。 */
  readonly absent?: readonly string[] | undefined
  readonly policy?: MeetingRoomPolicy | undefined
  readonly entryPrompt?: EntryPromptTemplate | undefined
  readonly now?: (() => number) | undefined
  /**
   * **每条 turn 落盘的钩子**。
   *
   * 在 `push()` 成功后立刻**同步**调用。存在它的唯一理由是"开一半就得落盘"：
   * 散会后才写一次记录的话，进程被强杀就等于这场会从没开过
   * （实测暴露的真实缺口）。同步调用是为了保证它真的已经写进文件。
   */
  readonly onTurn?: ((turn: MeetingTurn) => void) | undefined
}

export class MeetingRoomError extends Error {
  readonly code = 'meeting/room'

  constructor(message: string) {
    super(message)
    this.name = 'MeetingRoomError'
  }
}

export class MeetingRoom {
  readonly id: string
  readonly scope: MeetingScope
  readonly calledBy: string
  readonly reason: string
  readonly policy: MeetingRoomPolicy

  private readonly entryPrompt: EntryPromptTemplate
  private readonly now: () => number
  private readonly onTurn: ((turn: MeetingTurn) => void) | undefined
  private readonly turns: MeetingTurn[] = []
  private readonly presentSet: Set<string>
  private readonly absentSet: Set<string>
  private sequence = 0
  private currentRound = 0
  private closed = false
  /** 本轮"发言失败 / 被拒绝"的成员。推进轮次时清空。 */
  private readonly unavailableSet = new Set<string>()

  constructor(options: MeetingRoomOptions) {
    if (options.reason.trim().length === 0) {
      throw new MeetingRoomError('会议必须有议题；没有议题的会只会制造噪声。')
    }
    if (options.present.length === 0) {
      throw new MeetingRoomError('会议至少要有一个人已经到场。')
    }
    this.id = options.id
    this.scope = options.scope
    this.calledBy = options.calledBy
    this.reason = options.reason
    this.policy = options.policy ?? DEFAULT_ROOM_POLICY
    this.entryPrompt = options.entryPrompt ?? DEFAULT_ENTRY_PROMPT
    this.now = options.now ?? (() => Date.now())
    this.onTurn = options.onTurn
    this.presentSet = new Set(options.present)
    this.absentSet = new Set((options.absent ?? []).filter((id) => !this.presentSet.has(id)))
  }

  get humanPresent(): boolean {
    return this.presentSet.has(HUMAN_PARTICIPANT)
  }

  /** 已到场可发言的成员（含可能的人类）。 */
  get present(): readonly string[] {
    return [...this.presentSet].sort(compareCodeUnit)
  }

  /** 被召集但还没到场的成员。 */
  get absent(): readonly string[] {
    return [...this.absentSet].sort(compareCodeUnit)
  }

  /** 纯 Agent 成员（排除人类），已到场。 */
  get agentPresent(): readonly AgentSlotId[] {
    return this.present.filter((id) => id !== HUMAN_PARTICIPANT)
  }

  get round(): number {
    return this.currentRound
  }

  get isClosed(): boolean {
    return this.closed
  }

  get transcript(): readonly MeetingTurn[] {
    return [...this.turns]
  }

  // --- 生命周期 -----------------------------------------------------------

  /**
   * 开场：为**已到场**的每位成员注入入场引导。
   *
   * 迟到的成员会在 `admit()` 时单独拿到自己的入场引导——先开会、后到场，
   * 不让一个慢会话把整场会拖住（需求里"有一个等待的过程"，等的边界由调用方控制）。
   */
  open(input: {
    readonly memoryProjection: (participant: AgentSlotId) => string
    readonly titles: Readonly<Record<string, { title: string; domain: string }>>
  }): readonly MeetingTurn[] {
    if (this.closed) throw new MeetingRoomError(`会议 ${this.id} 已结束，不能重复开会。`)
    if (this.currentRound !== 0) throw new MeetingRoomError(`会议 ${this.id} 已经开过场了。`)
    const entered = this.agentPresent.map((id) => this.makeEntryTurn(id, this.present, input))
    this.currentRound = 1
    return entered
  }

  /** 一位迟到的成员入场。会为它补注入场引导。 */
  admit(
    participant: AgentSlotId,
    input: {
      readonly memoryProjection: (participant: AgentSlotId) => string
      readonly titles: Readonly<Record<string, { title: string; domain: string }>>
    },
  ): MeetingTurn | undefined {
    if (this.closed) return undefined
    if (this.presentSet.has(participant)) return undefined
    this.absentSet.delete(participant)
    this.presentSet.add(participant)
    return this.makeEntryTurn(participant, this.present, input)
  }

  private makeEntryTurn(
    participant: AgentSlotId,
    presentAfterAdmit: readonly string[],
    input: {
      readonly memoryProjection: (participant: AgentSlotId) => string
      readonly titles: Readonly<Record<string, { title: string; domain: string }>>
    },
  ): MeetingTurn {
    const meta = input.titles[participant] ?? { title: participant, domain: participant }
    const text = this.entryPrompt.build({
      participant,
      domain: meta.domain,
      title: meta.title,
      reason: this.reason,
      scope: this.scope,
      calledBy: this.calledBy,
      // 在场名单里排除自己与人类：人类由 `humanPresent` 单独说明，
      // 否则会出现 "在场：human、a、b、human（人类，有发言权）" 这种重复。
      present: presentAfterAdmit.filter((id) => id !== participant && id !== HUMAN_PARTICIPANT),
      absent: this.absent,
      memoryProjection: input.memoryProjection(participant),
      humanPresent: this.humanPresent,
      reportGuidanceChars: this.policy.reportGuidanceChars,
    })
    return this.push(0, participant, 'entry', text, Number.MAX_SAFE_INTEGER)
  }

  /**
   * 第 1 轮的发言顺序：全体已到场成员，按确定性顺序。
   *
   * 第 2 轮起不再由会议室决定——交给主持人（见 `moderator.ts`）。
   */
  firstRoundOrder(): readonly AgentSlotId[] {
    return [...this.agentPresent]
  }

  /** 进入下一轮。 */
  nextRound(): number {
    if (this.closed) throw new MeetingRoomError(`会议 ${this.id} 已结束。`)
    this.currentRound += 1
    // 新的一轮：上一轮的"不可用"不再有效，让大家重新有机会发言。
    this.unavailableSet.clear()
    return this.currentRound
  }

  /** 是否已达轮次硬顶。 */
  atRoundLimit(): boolean {
    return this.currentRound >= this.policy.maxRounds
  }

  /** 某成员是否已到场。 */
  hasPresent(member: string): boolean {
    return this.presentSet.has(member)
  }

  // --- 记录 ---------------------------------------------------------------

  /**
   * 本次发言的硬上限（按轮次分）。
   *
   * 第一轮是**汇报**（上限宽松），第二轮起是**讨论**（上限收紧）。
   * 这两个数字**都不进提示词**——只把软目标告诉模型，报错时也只重复软目标。
   */
  private speechCap(): number {
    return this.currentRound <= 1 ? this.policy.reportMaxChars : this.policy.discussMaxChars
  }

  /** 记录一次 Agent 发言。超长**硬拒绝**，不静默截断。 */
  appendSpeech(speaker: string, text: string): MeetingTurn {
    if (!this.presentSet.has(speaker)) {
      throw new MeetingRoomError(`${speaker} 不在场（未入场），不能发言。`)
    }
    return this.push(this.currentRound, speaker, 'speech', text, this.speechCap())
  }

  /**
   * 人类插话。
   *
   * 人的发言**不占轮次也不占发言名额**：会议是一群 Agent 的循环，
   * 人不该被主持人的调度排队。
   */
  appendHumanTurn(text: string): MeetingTurn {
    if (!this.humanPresent) {
      throw new MeetingRoomError(`会议 ${this.id} 未邀请人类，不能注入人类发言。`)
    }
    return this.push(this.currentRound, HUMAN_PARTICIPANT, 'human', text, this.policy.discussMaxChars)
  }

  /** 主持人控场发言（点名理由、宣布散会）。不占发言名额。 */
  appendModeratorTurn(text: string): MeetingTurn {
    return this.push(this.currentRound, 'moderator', 'moderator', text, this.policy.discussMaxChars)
  }

  close(): readonly MeetingTurn[] {
    this.closed = true
    return this.transcript
  }

  // --- 查询 ---------------------------------------------------------------

  /** 本轮已发言的成员。 */
  spokeThisRound(): readonly AgentSlotId[] {
    const speakers = new Set<string>()
    for (const turn of this.turns) {
      if (turn.round === this.currentRound && turn.kind === 'speech') speakers.add(turn.speaker)
    }
    return [...speakers].sort(compareCodeUnit)
  }

  /**
   * 标记一位成员本轮不可用（发言失败，或产出被拒绝）。
   *
   * 他**不算发言**，但本轮不该再被主持人点名——否则每次点都失败，
   * 会议会一直卡在同一轮里原地打转，直到步数上限。
   */
  markUnavailable(sessionId: string): void {
    this.unavailableSet.add(sessionId)
  }

  /** 本轮失败/被拒的成员。 */
  unavailableThisRound(): readonly AgentSlotId[] {
    return [...this.unavailableSet].sort(compareCodeUnit)
  }

  /**
   * 本轮**已经处理过**的成员 = 发言过 ∪ 失败过。
   *
   * 轮次推进和主持人点名都该看这个（而不是 `spokeThisRound()`）：
   * 失败过的人不必再点，否则一次网络抖动就能让会议原地打转。
   */
  settledThisRound(): readonly AgentSlotId[] {
    const settled = new Set([...this.spokeThisRound(), ...this.unavailableSet])
    return [...settled].sort(compareCodeUnit)
  }

  /** 全会累计发言次数。 */
  spokeCounts(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {}
    for (const turn of this.turns) {
      if (turn.kind !== 'speech') continue
      counts[turn.speaker] = (counts[turn.speaker] ?? 0) + 1
    }
    for (const id of this.agentPresent) {
      if (counts[id] === undefined) counts[id] = 0
    }
    return counts
  }

  /** 某位成员自己的全部发言，用于生成个性化纪要。 */
  turnsBy(speaker: string): readonly MeetingTurn[] {
    return this.turns.filter((turn) => turn.speaker === speaker)
  }

  /**
   * 生成给模型看的群聊上下文（滚动窗口，恒在预算内）。
   *
   * 从最近往前收，直到预算耗尽；被丢掉的部分显式标注。
   */
  transcriptProjection(): string {
    const header = `【会议室】${this.id}｜议题=${this.reason}｜规模=${this.scope}｜第 ${this.currentRound} 轮`
    const rendered = this.turns
      .filter((turn) => turn.kind !== 'entry')
      .map((turn) => `[R${turn.round}] ${turn.speaker}: ${turn.text}`)

    const kept: string[] = []
    let used = countChars(header) + 1
    for (let index = rendered.length - 1; index >= 0; index -= 1) {
      const line = rendered[index] as string
      const cost = countChars(line) + 1
      if (used + cost > this.policy.transcriptBudgetChars) break
      kept.unshift(line)
      used += cost
    }
    const dropped = rendered.length - kept.length
    const middle = dropped > 0 ? [`  （已省略更早的 ${dropped} 条发言以控制上下文预算）`] : []
    const entries = this.turns
      .filter((turn) => turn.kind === 'entry')
      .map((turn) => `  (已向 ${turn.speaker} 注入入场引导，内容按其私有记忆定制)`)
    return [header, ...entries, ...middle, ...kept].join('\n')
  }

  private push(round: number, speaker: string, kind: MeetingTurnKind, text: string, cap: number): MeetingTurn {
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (trimmed.length === 0) {
      throw new MeetingRoomError(`${speaker} 的发言为空。`)
    }
    const chars = countChars(trimmed)
    if (chars > cap) {
      // ⚠️ 报错里**只重复字数要求（软目标）**，绝不提硬上限数字。
      // 一旦说了硬上限，模型就会花精力去数"我到底输出了多少字"。
      const ask = round <= 1
        ? `请用最简单的语言汇报，控制在 ${this.policy.reportGuidanceChars} 字以下。`
        : `讨论请用最简洁的语言表达观点，${this.policy.discussGuidanceChars} 字以内。`
      throw new MeetingRoomError(`${speaker} 的发言超长：${ask}`)
    }
    this.sequence += 1
    const turn: MeetingTurn = { seq: this.sequence, round, speaker, kind, text: trimmed, chars, at: this.now() }
    this.turns.push(turn)
    // **每条 turn 立刻落盘**：同步调用，不排队。
    // 散会后才写一次的话，进程被强杀就等于这场会从没开过（实测暴露的真实缺口）。
    this.onTurn?.(turn)
    return turn
  }
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
