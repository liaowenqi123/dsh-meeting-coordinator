/**
 * Agent 参与者：私有记忆 + 生命状态机。
 *
 * ## 这个文件承载的核心语义
 *
 * 用户对"唤起"的定义是**状态层面**的，不是消息层面：
 *
 * > 一个 agent 选择开会后，可以召集所有在工作或者不在工作的 agent
 * > （不在工作状态指的是输出完毕等待用户回复，或已完成任务），
 * > 开完会后，所有 agent 都会回到工作状态。
 *
 * 所以这里必须有一个显式状态机，而不是"发条消息就算叫过了"：
 *
 * ```
 *                    summon()                dismiss()
 *   working ────────────────┐            ┌──────────────▶ working
 *   idle-waiting ───────────┼──▶ in-meeting ──┘
 *   done ───────────────────┘
 * ```
 *
 * `working` / `idle-waiting` / `done` **都是可被召集的状态**；
 * 散会（`dismiss()`）把所有人**无条件**推回 `working` —— 这正是用户要的
 * "开完会后所有 agent 都会回到工作状态"，也解决了
 * "已完成任务的 Agent 散会后不知道该干嘛"的问题。
 *
 * ## 私有记忆的结构
 *
 * 用户明确：
 * > 回去之后每个 AI 的记忆就会变成"原私有上下文 + 自己相关的会议纪要"
 *
 * 因此记忆分两段，且**只增不改**：
 *
 * - `context`：私有工作记录（自己的探索、日志、结论）；
 * - `notes`：历次会议中**与自己相关**的纪要（由会后压缩生成，每人不同）。
 *
 * 注入会议室时只取这两段的**限长投影**，绝不把完整上下文倒进去。
 */
import type { AgentSlotId } from './types.js';
/**
 * 参与者状态的完整取值。
 *
 * `awaiting-entry` 是需求里"**有一个等待的过程**"的落点：
 * 一个会话正在 working（在输出、或在调用工具）时**不会被会议打断**，
 * 它先被标记为"待入场"，等当前工作单元走到边界再真正进入会议室。
 */
export type ParticipantState = 
/** 正在自己的工作方向上推进（可能在输出，也可能在调用工具）。 */
'working'
/** 输出完毕，等用户回复（用户口中的"不在工作"之一）。 */
 | 'idle-waiting'
/** 任务已完成（用户口中的"不在工作"之一）。 */
 | 'done'
/** 被召集了，但当前工作单元还没结束，正在等边界入场。 */
 | 'awaiting-entry'
/** 已在会议室里。 */
 | 'in-meeting';
/** 人被当作一个特殊参与者，可以召集会议、也可以在会中发言。 */
export declare const HUMAN_PARTICIPANT: "human";
export type HumanParticipantId = typeof HUMAN_PARTICIPANT;
/** 一条"与自己相关"的会议纪要。 */
export interface MeetingNote {
    readonly meetingId: string;
    readonly text: string;
    readonly chars: number;
    /** 会议规模，用于区分大会/小会带来的信息量差异。 */
    readonly scope: 'local' | 'global';
    readonly at: number;
}
export declare class ParticipantStateError extends Error {
    readonly code = "meeting/participant-state";
    constructor(message: string);
}
export interface AgentParticipantSpec {
    readonly id: AgentSlotId;
    readonly domain: string;
    readonly title: string;
    readonly systemPrompt: string;
    /** 该会话所在的工作区。会议室允许跨工作区，所以这里必须显式记录。 */
    readonly workspace?: string | undefined;
    /** 该会话自己的模型。会议里它发言就用它——协调器不选模型。 */
    readonly model?: string | undefined;
}
/**
 * 一个长期存活的领域 Agent 参与者。
 *
 * 它**不属于**任何一次会议：会议只是它生命周期里的一个插曲。
 * 它自己持有记忆，因此"带着私有上下文进入会议室"是天然成立的。
 */
export declare class AgentParticipant {
    readonly id: AgentSlotId;
    readonly domain: string;
    /**
     * 展示名。因为**会籍恢复**的需要，它不是 `readonly`：
     * 重启后重建名册时只能用短 id 兜底（那时标题可能还没探到），
     * 拿到真实标题后要能补齐（见 `retitle()`）。
     */
    title: string;
    readonly systemPrompt: string;
    /** 该会话所在的工作区。 */
    readonly workspace: string;
    /** 该会话自己的模型。 */
    readonly model: string | undefined;
    private _state;
    /**
     * 被召集**之前**的状态，散会 / 取消召集时还原。
     *
     * 为什么不直接写死一个"散会后去哪"的常量：因为成员的真实处境不同。
     * 一个空闲会话被拉进会场，散会后它应该回到**空闲**（还可以再被召集）；
     * 一个正在跑自己回合的会话被召集（等边界入场），会议结束时它**还在忙**，
     * 散会就不该把它说成空闲。还原成召集前的状态对两种情形都成立。
     */
    private stateBeforeSummon;
    private readonly context;
    private readonly notes;
    constructor(spec: AgentParticipantSpec);
    get state(): ParticipantState;
    /** 工作记忆条数，用于诊断"这个 Agent 到底攒了多少东西"。 */
    get contextSize(): number;
    get meetingNoteCount(): number;
    get privateContext(): readonly string[];
    get meetingNotes(): readonly MeetingNote[];
    /**
     * 更新展示名。
     *
     * 用于**会籍恢复**：重启后重建名册时标题可能还没探到（候选列表尚未预热），
     * 于是先用短 id 兜底；等真实标题拿到后再补上。
     * 只影响会议内部的提示文案，不参与任何判据。
     */
    retitle(title: string): void;
    /** 任何非会议状态都可被召集（已经被召集或已在会中的不能再召）。 */
    canBeSummoned(): boolean;
    /** 是否人已在会议室里（`awaiting-entry` 还不算）。 */
    isInMeeting(): boolean;
    /** 是否正在等边界入场。 */
    isAwaitingEntry(): boolean;
    /** 输出完毕、等用户回复。 */
    beginIdleWaiting(): void;
    /** 任务完成。 */
    complete(): void;
    /** 回到工作。 */
    resume(): void;
    /**
     * 被召集。
     *
     * 关键分支：
     * - **正在 working** 的会话**不被打断**——进入 `awaiting-entry`，
     *   等它当前的工作单元（本次输出 / 本次工具调用）结束后再入场；
     * - 空闲（`idle-waiting`）或已完成（`done`）的会话没有工作单元要等，直接入场。
     */
    summon(): void;
    /**
     * 当前工作单元结束。
     *
     * 由宿主在"本次输出结束"或"本次工具调用返回"的**边界**调用。
     * 这正是"有一个等待的过程"的结束点：到这里才真正入场，中途绝不打断。
     */
    onWorkUnitComplete(): void;
    /** 取消召集（例如会议在它入场前就散了，或人类喊停）。 */
    cancelSummon(): void;
    /**
     * 散会：把成员还原到**被召集之前**的状态。
     *
     * ⚠️ 这里曾经写死成 `working`，是一个会造成**永久锁死**的 bug：
     * 成员明明是空闲的（它是从 `idle-waiting` 被召集的），散会后却被标成
     * "正在干活"，于是 `summon()` 下一次把它派去 `awaiting-entry`——
     * 而 `awaiting-entry` 要等一个**永远不会到来**的工作单元边界。
     * 表现出来就是：**开过一次会之后，那个会议室再也召集不起来**，
     * 理由永远是"全部成员都在工作中"。会议中途失败时尤其致命。
     *
     * `awaiting-entry` 也要一起还原——否则会留下一个永远在等边界入场、
     * 但会议早已结束的僵尸状态。
     */
    dismiss(): void;
    /**
     * 还原到召集前的状态。
     *
     * 兜底值取 `idle-waiting` 而不是 `working`：新模型下成员是**用户的会话**，
     * 会议结束对它而言意味着"恢复空闲、可再次被召集"，而不是"开始干活"。
     * 正常情况下这个兜底走不到（`summon()` 一定会记下来源状态）。
     */
    private restoreAfterSummon;
    private transition;
    /** 写入私有工作记忆。 */
    remember(text: string): void;
    /** 会后吸收"与自己相关"的纪要。每人拿到的内容不同，这是刻意的。 */
    absorbNote(note: MeetingNote): void;
    /**
     * 生成注入会议室的**记忆投影**（限长）。
     *
     * ⚠️ 这里刻意**不限制条数**，只受 `maxChars` 兜底——
     * 一次性子 Agent 是空白上下文，它"是谁、正在做什么"全靠这一段带进去。
     * 只取最近三条的话，它就是个"披着名字外衣的陌生人"。
     *
     * 但这仍然**不把 A 的私有上下文搬进 B 的会场**：这里取的是**自己的**记忆，
     * 只进发言者自己那一份 prompt（`MeetingRoom` 按发言者分发）。
     */
    memoryProjection(maxChars: number): string;
}
//# sourceMappingURL=participant.d.ts.map