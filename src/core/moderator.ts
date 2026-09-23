/**
 * 主持人：**有控场权，但没有上下文**。
 *
 * ## 设计要点（来自需求原话）
 *
 * > 设置一个主持人吧，模型使用唤起会话的模型，但是这个主持人**直接没有上下文**，
 * > 不会被任何人的上下文带偏。
 *
 * 这一条把两件事彻底解耦了：
 *
 * - **控场**（谁下一个说、什么时候散会）由主持人负责；
 * - **参会者发言**由各自的会话产出，且各自带着**自己的**记忆。
 *
 * 主持人只拿到**群聊记录 + 成员名单 + 议题**，拿不到任何人的私有记忆投影。
 * 因此它不可能因为"某人的上下文更长/更详细"而偏好某人——
 * 这正是"不会被任何人的上下文带偏"的机制保证。
 *
 * 用**召集者会话的模型**是为了让"谁开的会就像谁在主持"，风格一致，
 * 同时避免为协调器单独引入一个模型依赖。
 *
 * ## 关于"结构化"
 *
 * 会议**发言内容**不做结构化模板（不强制"进度/障碍/需要"三段式），
 * 让 AI 自然讨论收敛。但主持人的**控制决定**必须是机器可读的——
 * 这不是给 AI 的模板，而是协调器与主持人之间的控制通道。
 * 而且解析失败时**绝不能卡住会议**：{@link parseModeratorDecision} 会回退到安全默认值。
 */

import type { ModeratorDecision } from './types.js'

export type { ModeratorDecision }

/** 主持人做决定时能看到的**全部**信息（刻意不含任何私有记忆）。 */
export interface ModeratorContext {
  readonly roomName: string
  readonly reason: string
  /** 会议室全体成员。 */
  readonly members: readonly string[]
  /** 已入场、可以发言的成员。 */
  readonly present: readonly string[]
  /** 被召集但尚未到场（还在忙）或已缺席的成员。 */
  readonly absent: readonly string[]
  /** 当前轮次（从 1 开始）。 */
  readonly round: number
  readonly maxRounds: number
  readonly transcript: string
  /** 本轮已经说过话的人。 */
  readonly spokeThisRound: readonly string[]
  /** 全会累计发言次数，用于判断"是否人人都有机会"。 */
  readonly spokeCounts: Readonly<Record<string, number>>
}

export interface ModeratorPort {
  readonly port: string
  /**
   * 做一次控场决定。
   *
   * `model` 是**召集者会话的模型**；实现方应当用它来产出决定。
   */
  decide(
    input: ModeratorContext & { readonly model?: string | undefined },
  ): Promise<ModeratorDecision>
}

/**
 * 构造主持人 prompt。
 *
 * 两处刻意的写法：
 * 1. 开头就声明"你没有与会者的上下文"——这是防止模型臆测他人状态的第一道闸；
 * 2. 明确"如果你判断讨论已收敛就散会"，否则模型倾向于无限邀请发言。
 */
export function buildModeratorPrompt(input: ModeratorContext): string {
  const quiet = input.present.filter((member) => input.spokeThisRound.includes(member) === false)
  return [
    '【会议主持】你是本次会议的主持人。',
    `会议室：${input.roomName}｜议题：${input.reason}｜第 ${input.round}/${input.maxRounds} 轮。`,
    '',
    '你的信息范围（重要）：',
    '- 你**没有任何与会者的私有上下文**：看不到他们的工作记忆、代码、日志、历史会话。',
    '- 你只能看到下面的群聊记录、成员名单，以及谁还没说话。',
    '- 因此不要臆测某人的内部状态，只根据群里实际说了什么来判断。',
    '',
    '你的职责（只做控场，不替他们讨论）：',
    '1. 决定下一个该谁发言；',
    '2. 当讨论已经收敛——没有新的分歧、没有悬而未决的问题、没人明确要求继续——宣布散会；',
    '3. 不要让同一个人连续发言两次；',
    '4. 优先让"被点名提问"或"有未回答诉求"的人发言；',
    '5. 尽量让每个人都有机会说话。',
    '',
    `成员：${input.members.join('、') || '(无)'}`,
    `已到场：${input.present.join('、') || '(无)'}`,
    input.absent.length > 0 ? `未到场（还在忙或缺席）：${input.absent.join('、')}` : '未到场：无',
    quiet.length > 0 ? `本轮还没发言：${quiet.join('、')}` : '本轮所有人都已发言',
    `累计发言次数：${Object.entries(input.spokeCounts).map(([id, count]) => `${id}=${count}`).join('，') || '(无)'}`,
    '',
    '群聊记录：',
    input.transcript,
    '',
    '请只输出一个 JSON 对象，二选一：',
    '{"action":"invite","next":"<上面出现过的成员id>","note":"一句话说明为什么点他"}',
    '{"action":"adjourn","reason":"一句话说明为什么可以散会"}',
    '不要输出任何其他文字。',
  ].join('\n')
}

/**
 * 解析主持人的决定。
 *
 * **健壮性优先**：主持人是模型，输出可能带 markdown 代码块、前后寒暄、或完全跑偏。
 * 解析失败时回退到安全默认值（点名本轮还没发言的人），
 * 而不是抛错或让会议卡死——一个主持人卡住不该让整队人陪着挂。
 */
export function parseModeratorDecision(
  raw: string,
  fallback: { readonly present: readonly string[]; readonly spokeThisRound: readonly string[] },
): ModeratorDecision {
  const json = extractJsonObject(raw)
  if (json !== undefined) {
    const action = json['action']
    if (action === 'adjourn') {
      const reason = typeof json['reason'] === 'string' && json['reason'].trim().length > 0 ? json['reason'].trim() : '主持人宣布散会。'
      return { action: 'adjourn', reason }
    }
    if (action === 'invite') {
      const next = json['next']
      if (typeof next === 'string' && fallback.present.includes(next)) {
        const note = typeof json['note'] === 'string' ? json['note'].trim() : undefined
        return { action: 'invite', next, note }
      }
    }
  }
  return safeFallback(fallback)
}

/** 安全回退：优先点名本轮还没发言、且确实在场的人。 */
export function safeFallback(input: {
  readonly present: readonly string[]
  readonly spokeThisRound: readonly string[]
}): ModeratorDecision {
  const quiet = input.present.filter((member) => input.spokeThisRound.includes(member) === false)
  const next = quiet[0] ?? input.present[0]
  if (next === undefined) {
    return { action: 'adjourn', reason: '没有可发言的在场成员，会议结束。' }
  }
  return { action: 'invite', next, note: '主持人输出无法解析，按轮转回退。' }
}

/** 从可能包含 markdown 围栏或寒暄的文本里抠出第一个 JSON 对象。 */
function extractJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  const candidates: string[] = []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim())
  candidates.push(trimmed)

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined
}
