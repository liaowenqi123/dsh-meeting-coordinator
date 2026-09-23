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
import type { SessionCandidate } from '../core/membership.js';
import type { SessionActivityTracker } from '../core/activity-tracker.js';
import { type DshContextFace } from './dsh-team-runtime.js';
/** 上游 `SessionStore`（`ctx.sessions`）我们实际用到的成员。 */
export interface DshSessionStoreFace {
    list?(): readonly unknown[];
    get?(id: unknown): unknown;
}
/** 上游 `Session` 我们实际用到的成员。 */
export interface DshSessionFace {
    readonly id?: unknown;
    readonly header?: {
        readonly parentSession?: unknown;
        readonly origin?: unknown;
    } | undefined;
    /** 该会话自己的模型。成员发言要"借它的基模型"，所以必须能读到。 */
    readonly model?: unknown;
    /** 该会话自己的事件流。 */
    ownEvents?(): readonly unknown[];
    /** 把事件流派生为模型可见的消息列表 —— "借它的上下文"靠这个。 */
    deriveMessages?(): readonly unknown[];
}
/** 上游 `sessionTitle`（`@deepseek-ai/dsh-session-title`）我们实际用到的成员。 */
export interface DshSessionTitleFace {
    /** 取该会话最新的标题快照（`session/title` 事件的 latest-wins 折出）。 */
    get?(session: unknown): {
        readonly title?: unknown;
    } | undefined;
}
/**
 * 上游 `sessionController.list()` 的行（`SessionSummary`）我们实际用到的成员。
 *
 * 这份列表是**持久化**的全量会话（侧栏显示的就是它），而 `ctx.sessions.list()`
 * 只给**已加载**的会话。合并两者才能让面板看到"所有会话"。
 */
export interface DshSessionSummaryFace {
    readonly sessionId?: unknown;
    readonly running?: unknown;
    readonly parentSessionId?: unknown;
    readonly origin?: unknown;
    readonly cwd?: unknown;
    /** 投影缓存：`values.title` 就是标题快照（或纯字符串）。 */
    readonly projections?: {
        readonly values?: Record<string, unknown>;
    } | undefined;
}
export interface SessionCatalogOptions {
    readonly ctx: DshContextFace;
    /** 忙/闲的来源。由会话事件驱动（见 `dsh-session-state.ts` 的接线）。 */
    readonly activity: SessionActivityTracker;
    /** 会话的展示名。给了就**覆盖**内置解析（内置会读 `sessionTitle` 服务 + 回退派生）。 */
    readonly titleOf?: ((sessionId: string) => string | undefined) | undefined;
    readonly modelOf?: ((sessionId: string) => string | undefined) | undefined;
    readonly workspaceOf?: ((sessionId: string) => string | undefined) | undefined;
    /**
     * 持久化会话行（来自 `sessionController.list()`）。
     *
     * **同步读取**：实现方负责缓存（那个接口是异步的，见 host 里的旁路缓存）。
     * 不给就退回"只列已加载的会话"的旧行为。
     */
    readonly persisted?: (() => readonly unknown[]) | undefined;
}
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
export declare function readSessionTitle(ctx: DshContextFace, session: DshSessionFace): string | undefined;
/**
 * 列出全部会话作为候选。
 *
 * `isSubagent` 的两个信号都看（`header.parentSession` 与 `header.origin`）：
 * 上游把"这个会话是派生的"这件事分散在会话元数据里，任一命中即算派生。
 * 判错的代价不对称——漏判会让子 Agent 混进会籍（等于自我增票），
 * 所以宁严勿松。
 */
export declare function listSessionCandidates(options: SessionCatalogOptions): readonly SessionCandidate[];
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
export declare function readSessionContext(options: {
    readonly ctx: DshContextFace;
    readonly sessionId: string;
    readonly maxChars: number;
    /**
     * 取末尾多少条消息。
     *
     * ⚠️ 默认给 48，刻意**远大于**"尾巴几条"。一次性子 Agent 是空白上下文，
     * 它"是谁、正在做什么"全靠这一段带进去；只取末尾两三条的话，
     * 它就是个"披着名字外衣的陌生人"——看起来是 A 在发言，实际谁都不是。
     * 真正的边界由 `maxChars` 控制（`MeetingRoomPolicy.memoryProjectionChars`，
     * 默认 6000），不要让"条数"把上下文悄悄截短。
     */
    readonly maxMessages?: number | undefined;
}): string | undefined;
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
export declare function isBoilerplateUserMessage(message: unknown): boolean;
//# sourceMappingURL=dsh-session-catalog.d.ts.map