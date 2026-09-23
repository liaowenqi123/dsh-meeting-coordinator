/**
 * 会话目录：从上游 `ctx.sessions` 读出"可以被加入会议室的会话"，
 * 以及"借一个会话的上下文"。
 *
 * ## 两件事
 *
 * 1. **候选列表**：面板要列"有哪些会话可以加"。来源是 `SessionStore.list()`。
 * 2. **借它的上下文**：选 B 路线后，成员发言是我们拿它的上下文 + 它的基模型
 *    做一次性外部调用。所以必须能**读出一个会话的上下文**——
 *    `Session.deriveMessages()` 正是把事件流派生为模型可见消息的那个方法。
 *
 * ## 零 `@deepseek-ai/*` import
 *
 * 与仓库其它适配层同规矩：全部按结构化鸭子类型访问，上游改导出/改包名
 * 都不会让本插件编译失败；拿不到就如实返回空数组，绝不编造。
 */

import type { SessionCandidate } from '../core/membership.js'
import type { SessionActivityTracker } from '../core/activity-tracker.js'
import { readService, type DshContextFace } from './dsh-team-runtime.js'

/** 上游 `SessionStore`（`ctx.sessions`）我们实际用到的成员。 */
export interface DshSessionStoreFace {
  list?(): readonly unknown[]
  get?(id: unknown): unknown
}

/** 上游 `Session` 我们实际用到的成员。 */
export interface DshSessionFace {
  readonly id?: unknown
  readonly header?: { readonly parentSession?: unknown; readonly origin?: unknown } | undefined
  /** 该会话自己的模型。成员发言要"借它的基模型"，所以必须能读到。 */
  readonly model?: unknown
  /** 该会话自己的事件流。 */
  ownEvents?(): readonly unknown[]
  /** 把事件流派生为模型可见的消息列表 —— "借它的上下文"靠这个。 */
  deriveMessages?(): readonly unknown[]
}

/** 上游 `sessionTitle`（`@deepseek-ai/dsh-session-title`）我们实际用到的成员。 */
export interface DshSessionTitleFace {
  /** 取该会话最新的标题快照（`session/title` 事件的 latest-wins 折出）。 */
  get?(session: unknown): { readonly title?: unknown } | undefined
}

/**
 * 上游 `sessionController.list()` 的行（`SessionSummary`）我们实际用到的成员。
 *
 * 这份列表是**持久化**的全量会话（侧栏显示的就是它），而 `ctx.sessions.list()`
 * 只给**已加载**的会话。合并两者才能让面板看到"所有会话"。
 */
export interface DshSessionSummaryFace {
  readonly sessionId?: unknown
  readonly running?: unknown
  readonly parentSessionId?: unknown
  readonly origin?: unknown
  readonly cwd?: unknown
  /** 投影缓存：`values.title` 就是标题快照（或纯字符串）。 */
  readonly projections?: { readonly values?: Record<string, unknown> } | undefined
}

export interface SessionCatalogOptions {
  readonly ctx: DshContextFace
  /** 忙/闲的来源。由会话事件驱动（见 `dsh-session-state.ts` 的接线）。 */
  readonly activity: SessionActivityTracker
  /** 会话的展示名。给了就**覆盖**内置解析（内置会读 `sessionTitle` 服务 + 回退派生）。 */
  readonly titleOf?: ((sessionId: string) => string | undefined) | undefined
  readonly modelOf?: ((sessionId: string) => string | undefined) | undefined
  readonly workspaceOf?: ((sessionId: string) => string | undefined) | undefined
  /**
   * 持久化会话行（来自 `sessionController.list()`）。
   *
   * **同步读取**：实现方负责缓存（那个接口是异步的，见 host 里的旁路缓存）。
   * 不给就退回"只列已加载的会话"的旧行为。
   */
  readonly persisted?: (() => readonly unknown[]) | undefined
}

/** 回退标题的字符上限。纯展示用，不参与任何判据。 */
const FALLBACK_TITLE_MAX_CHARS = 48

/**
 * 读出一个会话的展示标题。
 *
 * ## 为什么需要它
 *
 * 面板原先只显示 `session-750e30ff-0fe5-…` 这种原始 id —— **人能看，但看不出是哪个会话**。
 * 会话其实是有标题的（侧栏里显示的就是它），只是要主动去读。
 *
 * ## 两级来源（都不 import 上游包）
 *
 * 1. **权威来源**：Cordis 服务 `sessionTitle`（`@deepseek-ai/dsh-session-title`）的
 *    `get(session)` → `{ title, source, eventSeq }`。它是 `session/title` 事件的
 *    latest-wins 折叠，用户显式改名、模型生成、内置回退三种来源都在这里。
 * 2. **回退**：会话还没被起过标题时（新建、没说过话），按上游同类语义用
 *    **第一条人类消息**派生一个单行短标题。
 *
 * 上游自己有个 `fallbackSessionTitle(input, maxWords, maxBytes)` 做第 2 步，
 * 但按本仓库的规矩不 import 上游包（避免第二份依赖）。这里的实现是等价语义的
 * 简化版：单行、折叠空白、按**码点**截断（不能按字节截，中文会被切坏）。
 * 差异只影响观感，不影响任何判据——所以不做逐字对齐。
 */
export function readSessionTitle(ctx: DshContextFace, session: DshSessionFace): string | undefined {
  const titles = readService(ctx, 'sessionTitle') as DshSessionTitleFace | undefined
  if (titles !== undefined && typeof titles.get === 'function') {
    try {
      const snapshot = titles.get(session)
      const raw = snapshot === undefined || snapshot === null ? undefined : snapshot.title
      const normalized = normalizeTitle(typeof raw === 'string' ? raw : undefined)
      if (normalized !== undefined) return normalized
    } catch {
      // 服务在但调用不友好：走回退，不抛。
    }
  }
  return fallbackTitleFromMessages(session)
}

/** 单行化：折叠空白、去掉控制字符；空则 undefined。 */
function normalizeTitle(input: string | undefined): string | undefined {
  if (input === undefined) return undefined
  // eslint-disable-next-line no-control-regex
  const oneLine = input.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return oneLine.length === 0 ? undefined : truncateByCodePoints(oneLine, FALLBACK_TITLE_MAX_CHARS)
}

/** 按**码点**截断，不切碎代理对（emoji / 部分汉字）。 */
function truncateByCodePoints(input: string, maxChars: number): string {
  const points = [...input]
  return points.length <= maxChars ? input : `${points.slice(0, maxChars - 1).join('')}…`
}

/** 用第一条人类消息派生回退标题。 */
function fallbackTitleFromMessages(session: DshSessionFace): string | undefined {
  if (typeof session.deriveMessages !== 'function') return undefined
  let messages: readonly unknown[]
  try {
    messages = session.deriveMessages()
  } catch {
    return undefined
  }
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = message as { role?: unknown; content?: unknown; text?: unknown }
    if (record.role !== undefined && record.role !== 'user') continue
    const body =
      typeof record.content === 'string'
        ? record.content
        : Array.isArray(record.content)
          ? record.content.map(blockText).filter((part) => part.length > 0).join(' ')
          : typeof record.text === 'string'
            ? record.text
            : ''
    const normalized = normalizeTitle(body)
    if (normalized !== undefined) return normalized
  }
  return undefined
}

/**
 * 列出全部会话作为候选。
 *
 * `isSubagent` 的两个信号都看（`header.parentSession` 与 `header.origin`）：
 * 上游把"这个会话是派生的"这件事分散在会话元数据里，任一命中即算派生。
 * 判错的代价不对称——漏判会让子 Agent 混进会籍（等于自我增票），
 * 所以宁严勿松。
 */
export function listSessionCandidates(options: SessionCatalogOptions): readonly SessionCandidate[] {
  // --- 来源一：已加载的会话（有 header / deriveMessages，信息最权威）---------
  const live = new Map<string, SessionCandidate>()
  const store = readService(options.ctx, 'sessions') as DshSessionStoreFace | undefined
  if (store !== undefined && typeof store.list === 'function') {
    for (const raw of store.list()) {
      const session = raw as DshSessionFace
      const sessionId = readId(session.id)
      if (sessionId === undefined) continue
      const header = session.header
      const parentSession = header === undefined ? undefined : readId(header.parentSession)
      const origin = header === undefined ? undefined : header.origin
      const title = options.titleOf?.(sessionId) ?? readSessionTitle(options.ctx, session)
      const model = options.modelOf?.(sessionId) ?? readId(session.model)
      const workspace = options.workspaceOf?.(sessionId)
      live.set(sessionId, {
        sessionId,
        isSubagent: parentSession !== undefined || origin === 'subagent',
        active: options.activity.isBusy(sessionId),
        loaded: true,
        ...(title === undefined ? {} : { title }),
        ...(model === undefined ? {} : { model }),
        ...(workspace === undefined ? {} : { workspace }),
      })
    }
  }

  // --- 来源二：持久化列表（没点开过的会话只在这里）-------------------------
  //
  // 顺序上**以持久化列表为准**（它按最近使用排序，和侧栏一致，用户能对上号），
  // 已加载的会话在同一位置上用更权威的数据覆盖。
  const out: SessionCandidate[] = []
  const seen = new Set<string>()
  for (const raw of options.persisted?.() ?? []) {
    const row = raw as DshSessionSummaryFace
    const sessionId = readId(row.sessionId)
    if (sessionId === undefined || seen.has(sessionId)) continue
    seen.add(sessionId)
    const liveOne = live.get(sessionId)
    if (liveOne !== undefined) {
      out.push(liveOne)
      continue
    }
    const parentSessionId = readId(row.parentSessionId)
    const title = readPersistedTitle(row)
    const workspace = readId(row.cwd)
    out.push({
      sessionId,
      // 不在进程里 = 不可能正在跑。这是持久化行 `running` 的兜底，宁可用它也别猜。
      isSubagent: parentSessionId !== undefined || row.origin === 'subagent',
      active: row.running === true,
      // 关键：**标记未加载**，面板要据此提示"它的上下文借不到"。
      loaded: false,
      ...(title === undefined ? {} : { title }),
      ...(workspace === undefined ? {} : { workspace }),
    })
  }
  // 已加载但不在持久化列表里的（极少数：刚建还没落列表）也要给出来。
  for (const [sessionId, candidate] of live) {
    if (!seen.has(sessionId)) out.push(candidate)
  }
  return out
}

/** 持久化行里的标题：投影缓存里可能是快照对象，也可能是纯字符串。 */
function readPersistedTitle(row: DshSessionSummaryFace): string | undefined {
  const values = row.projections?.values
  if (values === undefined || values === null) return undefined
  const raw = values['title']
  if (typeof raw === 'string') return normalizeTitle(raw)
  if (typeof raw === 'object' && raw !== null) {
    const nested = (raw as { title?: unknown }).title
    if (typeof nested === 'string') return normalizeTitle(nested)
  }
  return undefined
}

/**
 * 借出一个会话的上下文（限长）。
 *
 * 只取**末尾**若干条消息：我们要的是"它现在大概在做什么"，
 * 不是把它的全部历史搬走。上限由 `maxChars` 兜底，
 * 与 `AgentParticipant.memoryProjection(maxChars)` 的口径一致。
 *
 * 拿不到时返回 `undefined`——调用方应退回"没有私有上下文"的正常路径，
 * 而不是伪造一段。
 */
export function readSessionContext(options: {
  readonly ctx: DshContextFace
  readonly sessionId: string
  readonly maxChars: number
  /**
   * 取末尾多少条消息。
   *
   * ⚠️ 默认给 48，刻意**远大于**"尾巴几条"。一次性子 Agent 是空白上下文，
   * 它"是谁、正在做什么"全靠这一段带进去；只取末尾两三条的话，
   * 它就是个"披着名字外衣的陌生人"——看起来是 A 在发言，实际谁都不是。
   * 真正的边界由 `maxChars` 控制（`MeetingRoomPolicy.memoryProjectionChars`，
   * 默认 6000），不要让"条数"把上下文悄悄截短。
   */
  readonly maxMessages?: number | undefined
}): string | undefined {
  const maxMessages = options.maxMessages ?? 48
  const store = readService(options.ctx, 'sessions') as DshSessionStoreFace | undefined
  if (store === undefined || typeof store.get !== 'function') return undefined
  let session: DshSessionFace | undefined
  try {
    session = store.get(options.sessionId) as DshSessionFace | undefined
  } catch {
    // 上游对未知会话可能抛错而不是返回 undefined：两种都按"借不到"处理。
    return undefined
  }
  if (session === undefined || session === null) return undefined

  const lines: string[] = []
  try {
    if (typeof session.deriveMessages === 'function') {
      const messages = session.deriveMessages()
      // **必须先过滤 system 再截尾部**。
      //
      // 实测踩过（端到端测试）：`deriveMessages()` 把宿主系统提示词作为
      // 第一条消息返回，它有几千字，而每个会话的都不一样不到哪去——纯样板。
      // 不过滤的话，限长预算全被它占满，真正的用户/助手对话被截断挤出投影，
      // 表现是"借了上下文，但借来的全是废话"——比不借更隐蔽。
      // 顺序也重要：先过滤再 slice(-N)，否则尾部窗口里还混着系统消息。
      const conversational = [...messages].filter((message) => {
        const record = message as { role?: unknown; content?: unknown; text?: unknown } | null
        const role = record?.role
        // 1) system 消息全是宿主样板，先剔掉。
        if (role === 'system') return false
        // 2) **样板 user 消息也要剔**——这是实测踩出来的关键一坑：
        //    DSH 会把「runtime context 快照」「<system-reminder> 技能清单」
        //    「sandbox policy」等作为 **role: 'user'** 的消息注入，
        //    而 `deriveMessages()` 会把它们算进"对话"。
        //    不剔的话，"取末尾 N 条"的窗口全被这些样板占满，
        //    真正的用户/助手对话被挤出去，表现就是
        //    **"借了上下文，但借来的全是废话"**——比不借更隐蔽。
        if (isBoilerplateUserMessage(record)) return false
        return true
      })
      const kept = conversational.slice(-maxMessages)
      for (const message of kept) {
        const text = extractMessageText(message)
        if (text !== undefined) lines.push(text)
      }
    } else if (typeof session.ownEvents === 'function') {
      // 退化路径：没有消息派生能力时，只取事件里的文本片段。
      const events = session.ownEvents()
      for (const event of [...events].slice(-(options.maxMessages ?? 8))) {
        const text = extractEventText(event)
        if (text !== undefined) lines.push(text)
      }
    }
  } catch {
    // 派生失败（半死状态、事件流损坏）时同样按"借不到"处理——
    // 借上下文是尽力而为的增强，绝不能因为它让一场会开不成。
    return undefined
  }
  if (lines.length === 0) return undefined

  // 按对话流拼接，让模型读成"我自己的历史"。逐条之间用分隔符，
  // 保持 `[role]` 前缀——这正是"掏过来当作我的上下文"的形状。
  const joined = lines.join('\n')
  if (joined.length <= options.maxChars) return joined
  // 超预算时**保留最近的**（当前状态对开会最重要），并如实标注。
  const kept = joined.slice(joined.length - options.maxChars)
  const cutAt = kept.indexOf('\n')
  return `…（更早的上下文已省略）\n${cutAt >= 0 ? kept.slice(cutAt + 1) : kept}`
}

// ---------------------------------------------------------------------------

function readId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value !== 'object' || value === null) return undefined
  const text = String(value)
  return text.length > 0 && text !== '[object Object]' ? text : undefined
}

/**
 * 判断一条 **user** 消息是不是宿主注入的样板。
 *
 * ## 为什么要判这个（实测踩出来的坑）
 *
 * DSH 会把下面这些东西作为 `role: 'user'` 的消息塞进会话：
 *
 * - `Current runtime context. This snapshot supersedes…`（运行时上下文快照）
 * - `<system-reminder> A skill is a reusable set of…`（技能清单）
 * - `Approval prompts are disabled in this session…`（审批策略）
 * - `Tokens prefixed with @ are workspace paths…`（工具使用约定）
 * - `<available_skills>`（技能目录）
 *
 * 它们**每个会话都一样**，占满预算却没有任何区分度。
 * 只过滤 `role === 'system'` 拦不住它们——它们的 role 是 `user`。
 * 结果是"借了上下文，借来的全是废话"，比不借更隐蔽：
 * 模型看到的"上下文"是系统提示词片段，于是它对这个成员一无所知，
 * 发言就变成了泛泛而谈（实测里成员上来没报自己工作区，根因就是这个）。
 *
 * 判据是**文本特征**而非 role：role 骗人，文本骗不了人。
 */
export function isBoilerplateUserMessage(message: unknown): boolean {
  const record = message as { content?: unknown; text?: unknown } | null
  const body =
    typeof record?.content === 'string'
      ? record.content
      : Array.isArray(record?.content)
        ? record.content.map(blockText).filter((part) => part.length > 0).join('\n')
        : typeof record?.text === 'string'
          ? record.text
          : ''
  const head = body.trimStart()
  if (head.length === 0) return true
  return (
    head.startsWith('Current runtime context') ||
    head.startsWith('Approval prompts are disabled') ||
    head.startsWith('Tokens prefixed with @') ||
    head.startsWith('Non-zero exits are reported') ||
    head.startsWith('<system-reminder>') ||
    head.includes('<system-reminder>') ||
    head.includes('<available_skills>') ||
    head.startsWith('Use the read tool')
  )
}

/** 从一条 `Message` 里抠出可读文本。形状不保证，所以逐字段探测。 */
function extractMessageText(message: unknown): string | undefined {
  if (typeof message === 'string') return message
  if (typeof message !== 'object' || message === null) return undefined
  const record = message as { role?: unknown; content?: unknown; text?: unknown }
  const role = typeof record.role === 'string' ? record.role : '?'
  const body =
    typeof record.content === 'string'
      ? record.content
      : Array.isArray(record.content)
        ? record.content.map(blockText).filter((part) => part.length > 0).join('\n')
        : typeof record.text === 'string'
          ? record.text
          : ''
  const trimmed = body.trim()
  return trimmed.length === 0 ? undefined : `[${role}] ${trimmed}`
}

function blockText(block: unknown): string {
  if (typeof block === 'string') return block
  if (typeof block !== 'object' || block === null) return ''
  const record = block as { type?: unknown; text?: unknown }
  return typeof record.text === 'string' ? record.text : ''
}

function extractEventText(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as { type?: unknown; text?: unknown; message?: unknown; content?: unknown }
  if (typeof record.text === 'string' && record.text.trim().length > 0) return record.text
  if (typeof record.message === 'string' && record.message.trim().length > 0) return record.message
  if (Array.isArray(record.content)) {
    const joined = record.content.map(blockText).filter((part) => part.length > 0).join('\n')
    if (joined.trim().length > 0) return joined
  }
  return undefined
}
