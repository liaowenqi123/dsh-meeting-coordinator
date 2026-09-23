/**
 * 私有领域协议 `meeting.dsh/v1alpha1` / `BriefingBoard`。
 *
 * ## 为什么需要一份新协议，而不是复用 Agent / Session
 *
 * 1. `@dsh-std/agent` **没有发布 npm 包**（只有 `docs/proposals/agent.zh.md`），
 *    无法作为依赖；且它的语义是"活动 Agent 的控制与配置"，不表达"跨领域简报交换"。
 * 2. `@dsh-std/session` 已发布，但操作集是穷举且封闭的：
 *    SessionCatalog = list|get|create|rename|delete|watch，
 *    SessionHistory = read|follow|fork。没有 append / turn / prompt，
 *    因此无法承载"Agent 提交简报"这一写操作。
 * 3. dsh-std 明确鼓励这条路：AGENTS.md 写明
 *    「Private protocols use their own namespaced `apiVersion` and participate through
 *    the same core declaration and negotiation mechanism as public protocols.」
 *
 * ## 本定义遵守的 core 元协议不变量
 *
 * - 协商结果与注册顺序无关（确定性）；
 * - 协议专属字段由本 definition 拥有，core 不解释；
 * - agreement 是 lossless JSON 数据（无 Date / Map / undefined）；
 * - 多 provider 歧义必须由**显式 policy** 仲裁，不能按注册顺序。
 */

import type {
  ProtocolDefinition,
  ProtocolIssue,
  ProtocolNegotiationInput,
  ProtocolNegotiationOutcome,
  ProtocolRequirementEntry,
  ProtocolSupportEntry,
  ProtocolValidationContext,
} from '@dsh-std/core'
import type { BriefingBoardOperation, MeetingScope } from '../core/types.js'
import { DEFAULT_MAX_BRIEFING_CHARS } from '../core/briefing-text.js'

export const MEETING_API_VERSION = 'meeting.dsh/v1alpha1'
export const BRIEFING_BOARD_KIND = 'BriefingBoard'

/** 默认议程摘要预算。 */
export const DEFAULT_MAX_AGENDA_CHARS = 1200

const ALL_OPERATIONS: readonly BriefingBoardOperation[] = ['publish', 'read', 'subscribe', 'convene']
const ALL_SCOPES: readonly MeetingScope[] = ['local', 'global']

// ---------------------------------------------------------------------------
// 声明的 spec
// ---------------------------------------------------------------------------

/** 消费方（领域 Agent 槽位）声明自己需要这块简报板的哪些能力。 */
export interface BriefingBoardRequirementSpec {
  /**
   * 要加入的简报板标识（项目级，例如 `quant-trading`）。
   *
   * **可选**：core 把整个 `spec` 设为可选，消费方常常只声明
   * "我需要 BriefingBoard" 而不带任何 spec。此时的语义是
   * "接受本次协商范围内 coordinator 提供的那块板"。
   * 若显式给出，则必须与最终选中的 coordinator 的板一致。
   */
  readonly boardDomain?: string | undefined
  /**
   * 每一项都必须被 coordinator 满足，否则协商失败。
   * 完全省略 spec 时默认为 `publish` + `read`（能提交、能读回）。
   */
  readonly operations: readonly BriefingBoardOperation[]
  /** 缺失时不阻止协商，只出现在协商报告的未满足列表里。 */
  readonly optionalOperations?: readonly BriefingBoardOperation[] | undefined
  /** 调用方希望的简报长度上限。小于 coordinator 上限时取更严者。 */
  readonly maxBriefingChars?: number | undefined
  /** 调用方希望的会议规模。必须与 coordinator 有交集。 */
  readonly scopes?: readonly MeetingScope[] | undefined
}

/** 协调器声明自己实际能提供的能力。只能声明**当前真正实现**的操作。 */
export interface BriefingBoardSupportSpec {
  readonly boardDomain: string
  readonly operations: readonly BriefingBoardOperation[]
  readonly scopes: readonly MeetingScope[]
  /** coordinator 强制的简报硬上限（字符，按 code point）。 */
  readonly maxBriefingChars: number
  readonly limits?: BriefingBoardLimits | undefined
}

export interface BriefingBoardLimits {
  /** 含 coordinator 在内的最大成员数。 */
  readonly maxParticipants?: number | undefined
  /** 广播摘要在所有成员上的总预算。 */
  readonly maxAgendaChars?: number | undefined
}

// ---------------------------------------------------------------------------
// agreement
// ---------------------------------------------------------------------------

/**
 * 协商产物。必须是 lossless JSON：只含有限数字、字符串、布尔、null、数组与普通对象。
 */
export interface BriefingBoardAgreement {
  readonly boardDomain: string
  /** 被选中的 coordinator participant id。 */
  readonly coordinator: string
  /** 加入该板的 client participant id，已按 code-unit 字典序规范化。 */
  readonly clients: readonly string[]
  /** 协商后实际可用的操作，已按规范顺序排列。 */
  readonly operations: readonly BriefingBoardOperation[]
  /** 被满足的可选操作。 */
  readonly optionalOperationsSatisfied: readonly BriefingBoardOperation[]
  /** 可用会议规模。 */
  readonly scopes: readonly MeetingScope[]
  /** 协商后的简报硬上限（对全体成员一致）。 */
  readonly maxBriefingChars: number
  readonly maxAgendaChars: number
  readonly maxParticipants: number
}

/** 协商 policy：唯一被允许的多 provider 仲裁入口。 */
export interface BriefingBoardNegotiationPolicy {
  /** 显式指定哪个 participant 担任 coordinator；缺省且候选不唯一时报歧义。 */
  readonly selectCoordinator?: string | undefined
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

class SpecInvalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MeetingSpecInvalid'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNonEmptyString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SpecInvalid(`${where} 的 ${key} 必须是非空字符串。`)
  }
  return value
}

function readOperationList(
  source: Record<string, unknown>,
  key: string,
  where: string,
  required: boolean,
): readonly BriefingBoardOperation[] {
  const value = source[key]
  if (value === undefined) {
    if (required) throw new SpecInvalid(`${where} 缺少必填字段 ${key}。`)
    return []
  }
  if (!Array.isArray(value)) throw new SpecInvalid(`${where} 的 ${key} 必须是数组。`)
  const seen = new Set<BriefingBoardOperation>()
  for (const item of value) {
    if (typeof item !== 'string' || !ALL_OPERATIONS.includes(item as BriefingBoardOperation)) {
      throw new SpecInvalid(
        `${where} 的 ${key} 含未知操作 ${JSON.stringify(item)}；允许值：${ALL_OPERATIONS.join(', ')}。`,
      )
    }
    if (seen.has(item as BriefingBoardOperation)) {
      throw new SpecInvalid(`${where} 的 ${key} 含重复操作 ${item}。`)
    }
    seen.add(item as BriefingBoardOperation)
  }
  return [...seen]
}

function readScopeList(
  source: Record<string, unknown>,
  key: string,
  where: string,
  required: boolean,
  fallback: readonly MeetingScope[],
): readonly MeetingScope[] {
  const value = source[key]
  if (value === undefined) {
    if (required) throw new SpecInvalid(`${where} 缺少必填字段 ${key}。`)
    return fallback
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new SpecInvalid(`${where} 的 ${key} 必须是非空数组。`)
  }
  for (const item of value) {
    if (typeof item !== 'string' || !ALL_SCOPES.includes(item as MeetingScope)) {
      throw new SpecInvalid(`${where} 的 ${key} 含未知规模 ${JSON.stringify(item)}。`)
    }
  }
  return [...new Set(value as MeetingScope[])]
}

function readPositiveInt(
  source: Record<string, unknown>,
  key: string,
  where: string,
  required: boolean,
): number | undefined {
  const value = source[key]
  if (value === undefined) {
    if (required) throw new SpecInvalid(`${where} 缺少必填字段 ${key}。`)
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SpecInvalid(`${where} 的 ${key} 必须是正整数，实际 ${JSON.stringify(value)}。`)
  }
  return value
}

function validateRequirementSpec(
  spec: unknown,
  context: ProtocolValidationContext,
): BriefingBoardRequirementSpec {
  const where = `${context.apiVersion}/${context.kind} requirement`

  // core 允许 requirement 不带 spec（`spec?: Spec`）。这是最常见的真实写法：
  // "我需要这块协议"，由协调器按其能力提供。必须接受，而不是判为非法。
  if (spec === undefined) {
    return { operations: ['publish', 'read'] }
  }
  if (!isPlainObject(spec)) throw new SpecInvalid(`${where} 的 spec 必须是对象。`)

  const rawDomain = spec['boardDomain']
  const boardDomain =
    rawDomain === undefined ? undefined : readNonEmptyString(spec, 'boardDomain', where)
  const operations = readOperationList(spec, 'operations', where, true)
  const optionalOperations = readOperationList(spec, 'optionalOperations', where, false)
  const maxBriefingChars = readPositiveInt(spec, 'maxBriefingChars', where, false)
  const scopes = spec['scopes'] === undefined ? undefined : readScopeList(spec, 'scopes', where, false, ALL_SCOPES)

  for (const op of optionalOperations) {
    if (operations.includes(op)) {
      throw new SpecInvalid(`${where} 中 ${op} 同时出现在 operations 与 optionalOperations。`)
    }
  }

  return {
    boardDomain,
    operations,
    optionalOperations,
    maxBriefingChars,
    scopes,
  }
}

function validateSupportSpec(spec: unknown, context: ProtocolValidationContext): BriefingBoardSupportSpec {
  const where = `${context.apiVersion}/${context.kind} support`
  if (!isPlainObject(spec)) throw new SpecInvalid(`${where} 的 spec 必须是对象。`)
  const boardDomain = readNonEmptyString(spec, 'boardDomain', where)
  const operations = readOperationList(spec, 'operations', where, true)
  const scopes = readScopeList(spec, 'scopes', where, true, ALL_SCOPES)
  const maxBriefingChars = readPositiveInt(spec, 'maxBriefingChars', where, true)
  if (maxBriefingChars === undefined) throw new SpecInvalid(`${where} 缺少 maxBriefingChars。`)

  const rawLimits = spec['limits']
  let limits: BriefingBoardLimits | undefined
  if (rawLimits !== undefined) {
    if (!isPlainObject(rawLimits)) throw new SpecInvalid(`${where} 的 limits 必须是对象。`)
    limits = {
      maxParticipants: readPositiveInt(rawLimits, 'maxParticipants', `${where}.limits`, false),
      maxAgendaChars: readPositiveInt(rawLimits, 'maxAgendaChars', `${where}.limits`, false),
    }
  }

  return { boardDomain, operations, scopes, maxBriefingChars, limits }
}

// ---------------------------------------------------------------------------
// 确定性排序辅助
// ---------------------------------------------------------------------------

/** code-unit 字典序；不使用 locale collation（core 的确定性要求）。 */
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalOperations(operations: Iterable<BriefingBoardOperation>): readonly BriefingBoardOperation[] {
  const present = new Set(operations)
  return ALL_OPERATIONS.filter((op) => present.has(op))
}

function canonicalScopes(scopes: Iterable<MeetingScope>): readonly MeetingScope[] {
  const present = new Set(scopes)
  return ALL_SCOPES.filter((scope) => present.has(scope))
}

// ---------------------------------------------------------------------------
// 协商
// ---------------------------------------------------------------------------

class IssueCollector {
  readonly issues: ProtocolIssue[] = []

  error(code: string, message: string, participant?: string): void {
    this.issues.push(
      participant === undefined
        ? { code, severity: 'error', message }
        : { code, severity: 'error', participant, message },
    )
  }

  warning(code: string, message: string, participant?: string): void {
    this.issues.push(
      participant === undefined
        ? { code, severity: 'warning', message }
        : { code, severity: 'warning', participant, message },
    )
  }
}

/**
 * 协商算法（纯函数，与注册顺序无关）。
 *
 * 步骤：
 * 1. 全部 requirement 必须指向同一块板（boardDomain 一致），否则报 domain 冲突；
 * 2. 按 boardDomain 筛出候选 support；0 个报错；>1 个必须有显式 policy 仲裁；
 * 3. 校验 coordinator 的操作集覆盖所有必需操作；
 * 4. 求会议规模交集，空集报错；
 * 5. 简报上限取 min(coordinator 上限, 各 requirement 诉求)；
 * 6. 校验成员数不超过 limit；
 * 7. clients 按 code-unit 排序 —— 保证双方复算得到相同 agreement。
 */
function negotiateBriefingBoard(
  input: ProtocolNegotiationInput<
    BriefingBoardRequirementSpec,
    BriefingBoardSupportSpec,
    BriefingBoardNegotiationPolicy
  >,
): ProtocolNegotiationOutcome<BriefingBoardAgreement> {
  const issues = new IssueCollector()

  if (input.requirements.length === 0) {
    // 没有消费方就不构成 agreement，也不算失败。
    return {}
  }

  // core 把 spec 声明为可选字段（`spec?: Spec`）。这里在入口统一落地成
  // 必含 spec 的视图，避免后续每一步都做一次非空判断。
  // 注意：`spec` 缺失是**合法**的（消费方只说"我需要这块协议"），
  // 由 `validateRequirement` 已经补成默认 spec；能走到这里说明 core 已校验过。
  const requirementViews: { participant: string; spec: BriefingBoardRequirementSpec }[] = []
  for (const entry of input.requirements) {
    const spec = entry.requirement.spec
    requirementViews.push({
      participant: entry.participant,
      spec: spec ?? { operations: ['publish', 'read'] },
    })
  }

  const supportViews: { participant: string; spec: BriefingBoardSupportSpec }[] = []
  for (const entry of input.supports) {
    const spec = entry.support.spec
    if (spec === undefined) continue
    supportViews.push({ participant: entry.participant, spec })
  }

  // (1) 板标识一致性。只有**显式给出** boardDomain 的 requirement 参与校验；
  // 没给的表示"接受本次协商范围内 coordinator 提供的那块板"。
  const requestedDomains = [
    ...new Set(
      requirementViews
        .map((view) => view.spec.boardDomain)
        .filter((domain): domain is string => domain !== undefined),
    ),
  ].sort(byCodeUnit)
  if (requestedDomains.length > 1) {
    issues.error(
      'meeting/board-domain-conflict',
      `一次 BriefingBoard 协商只能服务一个 boardDomain，实际收到 ${requestedDomains.join(', ')}。` +
        '需要多块板时请分别发起独立协商。',
    )
    return { issues: issues.issues }
  }
  const requestedDomain = requestedDomains[0]

  // (2) coordinator 选择。
  const candidates = supportViews
    .filter((view) => requestedDomain === undefined || view.spec.boardDomain === requestedDomain)
    .slice()
    .sort((left, right) => byCodeUnit(left.participant, right.participant))

  if (candidates.length === 0) {
    issues.error(
      'meeting/board-unavailable',
      requestedDomain === undefined
        ? '没有任何 support 提供 BriefingBoard。'
        : `没有任何 support 提供 boardDomain=${requestedDomain} 的简报板。`,
    )
    return { issues: issues.issues }
  }

  let coordinatorView: { participant: string; spec: BriefingBoardSupportSpec }
  if (candidates.length === 1) {
    coordinatorView = candidates[0] as { participant: string; spec: BriefingBoardSupportSpec }
  } else {
    const selected = input.policy?.selectCoordinator
    if (selected === undefined) {
      issues.error(
        'meeting/coordinator-ambiguous',
        `boardDomain=${requestedDomain ?? "(未指定)"} 有 ${candidates.length} 个候选 coordinator ` +
          `(${candidates.map((view) => view.participant).join(', ')})，必须在 policy 中显式选择；` +
          '注册顺序不能作为仲裁规则。',
      )
      return { issues: issues.issues }
    }
    const found = candidates.find((view) => view.participant === selected)
    if (found === undefined) {
      issues.error(
        'meeting/coordinator-not-found',
        `policy 指定的 coordinator ${selected} 并未提供 boardDomain=${requestedDomain ?? "(未指定)"}。`,
      )
      return { issues: issues.issues }
    }
    coordinatorView = found
  }

  const coordinator = coordinatorView.participant
  const support = coordinatorView.spec
  // 最终生效的板标识：显式请求优先，否则取被选中 coordinator 自己声明的那块。
  const boardDomain = support.boardDomain

  // 同一位 participant 对同一块板发布多个 support 是声明冲突，不能挑一个了事。
  const sameParticipant = candidates.filter((view) => view.participant === coordinator)
  if (sameParticipant.length > 1) {
    issues.error(
      'meeting/coordinator-duplicate-support',
      `participant ${coordinator} 对 boardDomain=${coordinatorView.spec.boardDomain} 发布了 ${sameParticipant.length} 个 support，声明冲突。`,
      coordinator,
    )
    return { issues: issues.issues }
  }

  // (3) 操作集覆盖。
  const requiredOps = new Set<BriefingBoardOperation>()
  const optionalOps = new Set<BriefingBoardOperation>()
  for (const view of requirementViews) {
    for (const op of view.spec.operations) requiredOps.add(op)
    for (const op of view.spec.optionalOperations ?? []) optionalOps.add(op)
  }
  const supportOps = new Set(support.operations)
  let failed = false
  for (const op of [...requiredOps].sort(byCodeUnit)) {
    if (!supportOps.has(op)) {
      issues.error(
        'meeting/operation-not-negotiated',
        `coordinator ${coordinator} 未声明支持必需操作 ${op}。`,
        coordinator,
      )
      failed = true
    }
  }
  if (failed) return { issues: issues.issues }

  const optionalSatisfied = [...optionalOps].filter((op) => supportOps.has(op))
  for (const op of [...optionalOps].sort(byCodeUnit)) {
    if (!supportOps.has(op)) {
      issues.warning('meeting/optional-operation-missing', `coordinator 未支持可选操作 ${op}，已跳过。`, coordinator)
    }
  }

  // (4) 会议规模交集。
  let scopes = new Set<MeetingScope>(support.scopes)
  for (const view of requirementViews) {
    const wanted = view.spec.scopes ?? ALL_SCOPES
    scopes = new Set([...scopes].filter((scope) => wanted.includes(scope)))
  }
  if (scopes.size === 0) {
    issues.error(
      'meeting/scope-not-negotiated',
      `coordinator 与消费方在会议规模上没有交集（coordinator 提供 ${support.scopes.join(', ')}）。`,
      coordinator,
    )
    return { issues: issues.issues }
  }

  // (5) 简报上限：取最严者。
  let maxBriefingChars = support.maxBriefingChars
  for (const view of requirementViews) {
    const wanted = view.spec.maxBriefingChars
    if (wanted !== undefined && wanted < maxBriefingChars) {
      maxBriefingChars = wanted
    }
  }
  if (maxBriefingChars <= 0) {
    issues.error('meeting/briefing-budget-invalid', `协商得到的简报上限非法：${maxBriefingChars}。`, coordinator)
    return { issues: issues.issues }
  }
  if (support.maxBriefingChars > DEFAULT_MAX_BRIEFING_CHARS) {
    issues.warning(
      'meeting/budget-above-default',
      `coordinator 的简报上限 ${support.maxBriefingChars} 高于默认 ${DEFAULT_MAX_BRIEFING_CHARS}；` +
        '例会通道是全体成员每轮都要付的固定上下文成本，建议收紧。',
      coordinator,
    )
  }

  // (6) 成员数上限。
  const clients = [...new Set(requirementViews.map((view) => view.participant))].sort(byCodeUnit)
  if (clients.length !== requirementViews.length) {
    issues.error(
      'meeting/duplicate-participant',
      '同一 participant 在一次协商中提交了多个 requirement；participant identity 必须唯一。',
    )
    return { issues: issues.issues }
  }
  const maxParticipants = support.limits?.maxParticipants ?? clients.length + 1
  if (clients.length + 1 > maxParticipants) {
    issues.error(
      'meeting/too-many-participants',
      `成员数 ${clients.length + 1}（含 coordinator）超过上限 ${maxParticipants}。`,
      coordinator,
    )
    return { issues: issues.issues }
  }

  const agreement: BriefingBoardAgreement = {
    boardDomain,
    coordinator,
    clients,
    operations: canonicalOperations(requiredOps),
    optionalOperationsSatisfied: canonicalOperations(optionalSatisfied),
    scopes: canonicalScopes(scopes),
    maxBriefingChars,
    maxAgendaChars: support.limits?.maxAgendaChars ?? DEFAULT_MAX_AGENDA_CHARS,
    maxParticipants,
  }

  return issues.issues.length > 0 ? { agreement, issues: issues.issues } : { agreement }
}

/**
 * `validateAgreement`：在 agreement 进入协商报告与 plan digest **之前**执行 definition-owned 规范化。
 *
 * 它同时是"双方独立复算必须得到同一 digest"的守卫：排序不规范的 agreement 直接拒绝，
 * 而不是被静默接受后产生两个不同的 digest。
 */
function validateAgreement(agreement: unknown, context: ProtocolValidationContext): BriefingBoardAgreement {
  const where = `${context.apiVersion}/${context.kind} agreement`
  if (!isPlainObject(agreement)) throw new SpecInvalid(`${where} 必须是对象。`)

  const boardDomain = readNonEmptyString(agreement, 'boardDomain', where)
  const coordinator = readNonEmptyString(agreement, 'coordinator', where)

  const rawClients = agreement['clients']
  if (!Array.isArray(rawClients) || rawClients.some((item) => typeof item !== 'string')) {
    throw new SpecInvalid(`${where} 的 clients 必须是字符串数组。`)
  }
  const clients = rawClients as string[]
  const sortedClients = [...clients].sort(byCodeUnit)
  if (sortedClients.length !== new Set(sortedClients).size) {
    throw new SpecInvalid(`${where} 的 clients 含重复 participant。`)
  }
  if (clients.join('\u0000') !== sortedClients.join('\u0000')) {
    throw new SpecInvalid(`${where} 的 clients 未按 code-unit 字典序规范化，双方无法复算同一 digest。`)
  }

  const operations = readOperationList(agreement, 'operations', where, true)
  if (operations.join('\u0000') !== canonicalOperations(operations).join('\u0000')) {
    throw new SpecInvalid(`${where} 的 operations 未按规范顺序排列（应为 ${ALL_OPERATIONS.join(' < ')}）。`)
  }

  const optionalOperationsSatisfied = readOperationList(agreement, 'optionalOperationsSatisfied', where, false)
  const scopes = readScopeList(agreement, 'scopes', where, true, ALL_SCOPES)
  if (scopes.join('\u0000') !== canonicalScopes(scopes).join('\u0000')) {
    throw new SpecInvalid(`${where} 的 scopes 未按规范顺序排列（应为 ${ALL_SCOPES.join(' < ')}）。`)
  }

  const maxBriefingChars = readPositiveInt(agreement, 'maxBriefingChars', where, true)
  const maxAgendaChars = readPositiveInt(agreement, 'maxAgendaChars', where, true)
  const maxParticipants = readPositiveInt(agreement, 'maxParticipants', where, true)

  return {
    boardDomain,
    coordinator,
    clients: sortedClients,
    operations,
    optionalOperationsSatisfied,
    scopes,
    maxBriefingChars: maxBriefingChars ?? 0,
    maxAgendaChars: maxAgendaChars ?? 0,
    maxParticipants: maxParticipants ?? 0,
  }
}

/**
 * 交给 `ProtocolCatalog.register()` 的 definition。
 *
 * 注意这里**没有** `accepts`：core 的 `validateDefinition` 会把
 * `apiVersion` 本身并入可接受集合，因此 `accepts` 只能列出**额外**的、
 * 且与主坐标不同的版本；重复列出主坐标会被直接判为 definition 错误
 * （`node_modules/@dsh-std/core/lib/index.js` 的 `validateDefinition`）。
 * 本协议目前只有 v1alpha1 一个坐标，所以省略该字段。
 */
export const briefingBoardProtocol: ProtocolDefinition<
  BriefingBoardRequirementSpec,
  BriefingBoardSupportSpec,
  BriefingBoardAgreement,
  BriefingBoardNegotiationPolicy
> = {
  apiVersion: MEETING_API_VERSION,
  kind: BRIEFING_BOARD_KIND,
  validateRequirement: (spec, context) => validateRequirementSpec(spec, context),
  validateSupport: (spec, context) => validateSupportSpec(spec, context),
  validateAgreement: (agreement, context) => validateAgreement(agreement, context),
  negotiate: (input) => negotiateBriefingBoard(input),
}
