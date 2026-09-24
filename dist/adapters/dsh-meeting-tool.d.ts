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
import { HUMAN_PARTICIPANT } from '../core/participant.js';
import type { MeetingConsole } from '../core/console.js';
/** 上游 `ctx.tools` 我们实际用到的成员。 */
export interface DshToolsFace {
    register?(definition: unknown): unknown;
}
/** 上游 `ToolRunContext`：我们只用它认出"是谁在调"。 */
export interface DshToolRunContextFace {
    readonly agent?: {
        readonly id?: unknown;
    } | undefined;
    readonly signal?: AbortSignal | undefined;
}
export interface RegisterMeetingToolOptions {
    /**
     * 插件 ctx。类型放宽成 `unknown` 并在内部做鸭子类型探测：
     * `ctx.tools` 是上游服务，插件侧不该为它引入编译期形状依赖
     * （与仓库其它适配层同规矩：零 `@deepseek-ai/*` import）。
     */
    readonly ctx: unknown;
    readonly console: MeetingConsole;
    /**
     * 会议数据根。**必须由宿主传入**，不要在工具里自己算。
     *
     * 曾经这里自己算了一遍 `DSH_MEETING_ROOT ?? join(cwd, '.dsh-meeting')`，
     * 结果是：只要在 config 里显式给了 `rootDir`（`cordis.patch.yml` 里就给了），
     * 工具写的 `stop.flag` 与宿主 `stopRequested` 读的**就不是同一个文件**——
     * 急停看上去"成功"了，实际什么也没停。两处独立推算同一个坐标，
     * 迟早会不一致；传进来是唯一能保证同源的做法。
     */
    readonly rootDir: string;
}
export interface MeetingToolRegistration {
    readonly registered: boolean;
    /** 诊断行。注册成功给一句说明；失败给原因。 */
    readonly notes: readonly string[];
    readonly toolName: string;
    /** 注册返回的 disposer（未被 Cordis 接管时用于手动卸载）。 */
    dispose(): void;
}
/** 工具名。用上游的 snake_case 惯例（`plugin_manager`、`run_code` …）。 */
export declare const MEETING_TOOL_NAME = "dsh_meeting";
/**
 * 工具说明——**这就是需求里那"一大坨"**。
 *
 * 写成函数是为了可测：义务与边界必须能被断言，而不是散在字符串字面量里。
 */
export declare function meetingToolDescription(): string;
/** 参数的 JSON Schema。 */
export declare function meetingToolParameters(): Record<string, unknown>;
export declare function registerMeetingTool(options: RegisterMeetingToolOptions): MeetingToolRegistration;
/**
 * 工具的实际执行。**只读会籍过滤后的数据**，且不抛异常——
 * 失败以结构化结果返回，让模型能看懂为什么没成，而不是拿到一个栈。
 */
export declare function runMeetingTool(input: {
    readonly console: MeetingConsole;
    readonly args: unknown;
    readonly exec?: DshToolRunContextFace | undefined;
    /**
     * 会议数据根。**必填**——留着可选就等于允许调用方漏传，
     * 而漏传的后果是急停静默失效（见 `RegisterMeetingToolOptions.rootDir`）。
     */
    readonly rootDir: string;
}): Promise<unknown>;
export { HUMAN_PARTICIPANT };
//# sourceMappingURL=dsh-meeting-tool.d.ts.map