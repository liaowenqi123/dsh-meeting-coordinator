/**
 * 全局会议室工具：**"开会"这个按钮**。
 *
 * ## 为什么是全局工具，而不是按会话装
 *
 * 上游 `ctx.tools.register` 的契约写明 "Register **globally** or in the calling
 * agent scope"。在 `apply(ctx)` 里调用就是**全局注册**——所有会话都能看到它。
 * 这正是需求要的形态：不需要"入会才装、退出就卸"的按会话作用域，
 * 全局注册一次即可。
 *
 * ## "一大坨"在哪
 *
 * 上游 `ToolSchema = { name, description, parameters }`，而 **`description`
 * 本来就会进入该会话的模型上下文**。所以需求里"像系统提示词一样注入一大坨、
 * 同时给新的 tool call / 权限 / 义务"落地下来就是一件事：
 * **把说明写进 `description`**。按钮是它，说明书也是它。
 *
 * ## 那"入会"这件事还改了什么
 *
 * 工具的**可见**是全局的，但工具**能读到什么**受会籍约束
 * （见 `MeetingConsole` 的可见性口径）：非成员只能看到"存在这些房间、我不在其中"。
 * 而"入会/退出"之所以要挑非活动时点，是因为它们会改变**该会话的会中身份**，
 * 且按需求要伴随一次说明注入——往正在跑的 Agent 上做这件事有扰动风险。
 *
 * ## 绝不把宿主带下线
 *
 * `register` 会校验定义，写错会抛。但插件入口抛异常的后果是
 * `plugin tree failed to load` → **整个 dsh 起不来**（本插件已经这么崩过两次）。
 * 所以这里全程 try/catch，注册失败只记诊断，不抛。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HUMAN_PARTICIPANT } from '../core/participant.js'
import { readService } from './dsh-team-runtime.js'
import type { MeetingConsole } from '../core/console.js'

/** 上游 `ctx.tools` 我们实际用到的成员。 */
export interface DshToolsFace {
  register?(definition: unknown): unknown
}

/** 上游 `ToolRunContext`：我们只用它认出"是谁在调"。 */
export interface DshToolRunContextFace {
  readonly agent?: { readonly id?: unknown } | undefined
  readonly signal?: AbortSignal | undefined
}

export interface RegisterMeetingToolOptions {
  /**
   * 插件 ctx。类型放宽成 `unknown` 并在内部做鸭子类型探测：
   * `ctx.tools` 是上游服务，插件侧不该为它引入编译期形状依赖
   * （与仓库其它适配层同规矩：零 `@deepseek-ai/*` import）。
   */
  readonly ctx: unknown
  readonly console: MeetingConsole
  /**
   * 会议数据根。**必须由宿主传入**，不要在工具里自己算。
   *
   * 曾经这里自己算了一遍 `DSH_MEETING_ROOT ?? join(cwd, '.dsh-meeting')`，
   * 结果是：只要在 config 里显式给了 `rootDir`（`cordis.patch.yml` 里就给了），
   * 工具写的 `stop.flag` 与宿主 `stopRequested` 读的**就不是同一个文件**——
   * 急停看上去"成功"了，实际什么也没停。两处独立推算同一个坐标，
   * 迟早会不一致；传进来是唯一能保证同源的做法。
   */
  readonly rootDir: string
}

export interface MeetingToolRegistration {
  readonly registered: boolean
  /** 诊断行。注册成功给一句说明；失败给原因。 */
  readonly notes: readonly string[]
  readonly toolName: string
  /** 注册返回的 disposer（未被 Cordis 接管时用于手动卸载）。 */
  dispose(): void
}

/** 工具名。用上游的 snake_case 惯例（`plugin_manager`、`run_code` …）。 */
export const MEETING_TOOL_NAME = 'dsh_meeting'

/**
 * 工具说明——**这就是需求里那"一大坨"**。
 *
 * 写成函数是为了可测：义务与边界必须能被断言，而不是散在字符串字面量里。
 */
export function meetingToolDescription(): string {
  return [
    '# 会议室（多 Agent 例会）',
    '',
    '你可以通过这个工具查看会议室、以及**你自己所在会议室**的成员与历次会议内容。',
    '会议室是一个**持久实体**，不是临时群聊：会话主动加入它，才同时获得"唤起会议"的权利',
    '与"参会"的义务。',
    '',
    '## 会籍 = 权利 + 义务',
    '',
    '- **权利**：召集一场会议（大会 = 全体成员；小会 = 你点名的人）。',
    '- **义务**：你是某个会议室的成员时，成员之间的会议**可能把你算进去**；',
    '  会后你会拿到一份**只属于你**的纪要（内容与你相关，不是全体发言的复制）。',
    '- 你看不到别人的上下文，别人也看不到你的。会中交换只经由我们的汇总，不直接把别人的发言塞给你。',
    '',
    '## 你不需要知道的事',
    '',
    '会议"中间怎么进行的"与你无关，也不必关心：**你只需要拿到纪要**。',
    '没有加入任何会议室的会话，既不能召集、也不会被召集。',
    '',
    '## 可见性',
    '',
    '- 不传 `roomId`：列出所有会议室。你只会看到**自己加入的那些**的成员与会议场次；',
    '  其余房间只显示"存在 + 名字 + 你不在其中"。',
    '- 传 `roomId` 查看详情：**只有成员**能看到成员名单与历次会议内容。',
    '',
    '## 动作',
    '',
    '- `overview`：全部会议室总览（默认）。',
    '- `room`：某个会议室的详情（含历次会议的完整记录与每人纪要）。需会籍。',
    '- `convene`：召集一场会议。需会籍，并需给出 `reason`。',
    '',
    '> 加入/退出会议室是**人类在面板上**的操作，不是本工具的动作：',
    '> 加入要往那个会话注入新的工具与义务，因此只在它**非活动**时才允许，且必须由人决定。',
  ].join('\n')
}

/** 参数的 JSON Schema。 */
export function meetingToolParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['overview', 'room', 'convene', 'stop'],
        description: '要执行的动作。缺省为 overview。',
      },
      roomId: { type: 'string', description: '会议室 id。action=room / convene 时必填。' },
      reason: { type: 'string', description: '召集理由。action=convene 时必填，会进会议记录的 header。' },
      scope: {
        type: 'string',
        enum: ['global', 'local'],
        description: '会议规模。global = 全体成员；local = 只叫 invitees 点名的人。默认 global。',
      },
      invitees: {
        type: 'array',
        items: { type: 'string' },
        description: 'scope=local 时要点名的成员会话 id。',
      },
    },
    required: ['action'],
    additionalProperties: false,
  }
}

export function registerMeetingTool(options: RegisterMeetingToolOptions): MeetingToolRegistration {
  const notes: string[] = []
  // ⚠️ **绝不能写 `ctx.tools`**。
  //
  // Cordis 对"未在 `inject` 里声明的服务"的属性访问会**直接抛**：
  //   `cannot get property "tools" without inject`
  // 而把它加进 `inject` 又会让整个 boot **挂死**（inject 会等服务出现，
  // 这个 profile 里它不在本入口之前就绪）——两边都试过了，都会崩。
  //
  // 唯一安全的读法是 `ctx.get(name)`：拿不到就返回 undefined，
  // 而 `readService` 内部还有 try/catch 兜底。
  const tools = readService(options.ctx as never, 'tools') as DshToolsFace | undefined

  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    return {
      registered: false,
      notes: ['ctx.tools 不可用：无法注册全局会议室工具。会议室仍可通过面板使用。'],
      toolName: MEETING_TOOL_NAME,
      dispose: () => undefined,
    }
  }

  const definition = {
    name: MEETING_TOOL_NAME,
    description: meetingToolDescription(),
    parameters: meetingToolParameters(),
    output: {
      // 输出是结构化 JSON，字段由下面的 execute 决定。
      schema: { type: 'object' },
      render: (_args: unknown, value: unknown): readonly { readonly type: 'text'; readonly text: string }[] => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    async execute(args: unknown, exec: DshToolRunContextFace): Promise<unknown> {
      return runMeetingTool({ console: options.console, args, exec, rootDir: options.rootDir })
    },
  }

  let dispose: () => void = () => undefined
  try {
    const returned = tools.register(definition)
    if (typeof returned === 'function') dispose = returned as () => void
    notes.push(`已全局注册 ${MEETING_TOOL_NAME}（所有会话可见；内容按会籍过滤）。`)
  } catch (error) {
    // 注册失败绝不能把宿主带下线。
    notes.push(
      `注册全局工具 ${MEETING_TOOL_NAME} 失败（已忽略，不影响 dsh 启动）：` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
    return { registered: false, notes, toolName: MEETING_TOOL_NAME, dispose: () => undefined }
  }

  return { registered: true, notes, toolName: MEETING_TOOL_NAME, dispose }
}

/**
 * 工具的实际执行。**只读会籍过滤后的数据**，且不抛异常——
 * 失败以结构化结果返回，让模型能看懂为什么没成，而不是拿到一个栈。
 */
export async function runMeetingTool(input: {
  readonly console: MeetingConsole
  readonly args: unknown
  readonly exec?: DshToolRunContextFace | undefined
  /**
   * 会议数据根。**必填**——留着可选就等于允许调用方漏传，
   * 而漏传的后果是急停静默失效（见 `RegisterMeetingToolOptions.rootDir`）。
   */
  readonly rootDir: string
}): Promise<unknown> {
  const args = (typeof input.args === 'object' && input.args !== null ? input.args : {}) as Record<string, unknown>
  const action = typeof args['action'] === 'string' && args['action'].length > 0 ? args['action'] : 'overview'

  // 调用者身份：来自工具执行上下文。**认不出来时按"非成员"处理**——
  // 绝不能在认不出来的时候退化成人类观察者，那等于把全量可见性白送出去。
  const callerId = readCallerId(input.exec)
  const viewerId = callerId ?? `unknown:${MEETING_TOOL_NAME}`

  if (action === 'overview') {
    const overview = input.console.overview(viewerId)
    return {
      ok: true,
      you: callerId ?? null,
      rooms: overview.rooms,
      roomOfYou: overview.myRoomIds,
      hint:
        overview.myRoomIds.length === 0
          ? '你还没有加入任何会议室。加入需要人类在会议室面板上操作（且只允许在你非活动时进行）。'
          : undefined,
    }
  }

  // ⚠️ `stop` 必须排在 roomId 校验**之前**。
  //
  // 它曾经排在这道校验后面，于是 `action=stop` 一律返回
  // "action=room / convene 需要 roomId" —— **急停通道整个是死的**，
  // 而且报错信息还在误导人以为是自己没给 roomId。
  // 急停是"停一切"，天然不需要指定房间；它也不该被任何房间相关的
  // 前置条件挡住——否则最需要它的时候（房间状态已经乱了）它恰好不工作。
  if (action === 'stop') {
    // 写 stop.flag：协调器每步检查它，当前这场会会立刻散会并落盘。
    // 这是 UI 里没有"暂停/停会按钮"时的外部急停通道（实测暴露的缺口）。
    const flagPath = stopFlagPath(input.rootDir)
    writeFileSync(flagPath, `${new Date().toISOString()} 被要求停止\n`, 'utf8')
    return {
      ok: true,
      note: `已写入停会标志 ${flagPath}。正在进行的会议会在下一步散会并把已发生的发言落盘；` +
        '重启后 reconcileLive() 会把半途的转录补写进会议记录。',
    }
  }

  const roomId = typeof args['roomId'] === 'string' && args['roomId'].length > 0 ? args['roomId'] : undefined
  if (roomId === undefined) {
    return { ok: false, reason: 'action=room / convene 需要 roomId。先用 action=overview 看有哪些会议室。' }
  }

  if (action === 'room') {
    const detail = input.console.detail(roomId, viewerId)
    if (!detail.ok) return { ok: false, code: detail.code, reason: detail.reason }
    return { ok: true, room: detail.room, meetings: detail.meetings }
  }

  if (action === 'convene') {
    const reason = typeof args['reason'] === 'string' ? args['reason'] : ''
    if (reason.trim().length === 0) {
      return { ok: false, reason: '召集必须给出 reason；没有议题的会只会制造噪声。' }
    }
    const scope = args['scope'] === 'local' ? 'local' : 'global'
    const invitees = Array.isArray(args['invitees'])
      ? args['invitees'].filter((item): item is string => typeof item === 'string')
      : undefined
    const result = await input.console.convene({
      roomId,
      // 认不出调用者时不允许召集：召集是成员权利，不是匿名公共接口。
      calledBy: callerId ?? 'unknown',
      reason,
      scope,
      ...(invitees === undefined ? {} : { invitees }),
    })
    if (!result.ok) return { ok: false, code: result.code, reason: result.reason }
    return {
      ok: true,
      meetingId: result.meetingId,
      rounds: result.rounds,
      adjournedReason: result.adjournedReason,
      attended: result.attended,
      absent: result.absent,
      // **只回调用者自己那份纪要**。把别人的发言发回去就只是把"广播"换个说法。
      yourMinutes: result.myNote ?? null,
      note:
        result.myNote === undefined
          ? '你不在本次参会名单里（可能缺席或在会中），所以没有分到纪要。'
          : '以上是只与你相关的那份纪要。会议中间过程与你无关，不必追问。',
    }
  }

  return { ok: false, reason: `未知 action：${action}。可用：overview / room / convene / stop。` }
}

/**
 * 停会标志文件的路径。
 *
 * 与 `host.ts` 里 `stopRequested` 读的是**同一个文件**——
 * 一边写一边读，才能构成"外部急停"这条闭环。
 *
 * `rootDir` 由宿主传入（与 `host.ts` 用的是同一个解析结果），
 * 所以这里**不再自己推算**：两处独立推算同一个坐标，迟早会不一致，
 * 而这次不一致的代价是急停静默失效。
 */
function stopFlagPath(rootDir: string): string {
  mkdirSync(rootDir, { recursive: true })
  return join(rootDir, 'stop.flag')
}

function readCallerId(exec: DshToolRunContextFace | undefined): string | undefined {
  const agent = exec?.agent
  if (agent === undefined || agent === null) return undefined
  const id = agent.id
  if (typeof id === 'string' && id.length > 0) return id
  if (typeof id !== 'object' || id === null) return undefined
  const text = String(id)
  return text.length > 0 && text !== '[object Object]' ? text : undefined
}

export { HUMAN_PARTICIPANT }
