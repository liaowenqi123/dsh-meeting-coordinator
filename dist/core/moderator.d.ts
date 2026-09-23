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
import type { ModeratorDecision } from './types.js';
export type { ModeratorDecision };
/** 主持人做决定时能看到的**全部**信息（刻意不含任何私有记忆）。 */
export interface ModeratorContext {
    readonly roomName: string;
    readonly reason: string;
    /** 会议室全体成员。 */
    readonly members: readonly string[];
    /** 已入场、可以发言的成员。 */
    readonly present: readonly string[];
    /** 被召集但尚未到场（还在忙）或已缺席的成员。 */
    readonly absent: readonly string[];
    /** 当前轮次（从 1 开始）。 */
    readonly round: number;
    readonly maxRounds: number;
    readonly transcript: string;
    /** 本轮已经说过话的人。 */
    readonly spokeThisRound: readonly string[];
    /** 全会累计发言次数，用于判断"是否人人都有机会"。 */
    readonly spokeCounts: Readonly<Record<string, number>>;
}
export interface ModeratorPort {
    readonly port: string;
    /**
     * 做一次控场决定。
     *
     * `model` 是**召集者会话的模型**；实现方应当用它来产出决定。
     */
    decide(input: ModeratorContext & {
        readonly model?: string | undefined;
    }): Promise<ModeratorDecision>;
}
/**
 * 构造主持人 prompt。
 *
 * 两处刻意的写法：
 * 1. 开头就声明"你没有与会者的上下文"——这是防止模型臆测他人状态的第一道闸；
 * 2. 明确"如果你判断讨论已收敛就散会"，否则模型倾向于无限邀请发言。
 */
export declare function buildModeratorPrompt(input: ModeratorContext): string;
/**
 * 解析主持人的决定。
 *
 * **健壮性优先**：主持人是模型，输出可能带 markdown 代码块、前后寒暄、或完全跑偏。
 * 解析失败时回退到安全默认值（点名本轮还没发言的人），
 * 而不是抛错或让会议卡死——一个主持人卡住不该让整队人陪着挂。
 */
export declare function parseModeratorDecision(raw: string, fallback: {
    readonly present: readonly string[];
    readonly spokeThisRound: readonly string[];
}): ModeratorDecision;
/** 安全回退：优先点名本轮还没发言、且确实在场的人。 */
export declare function safeFallback(input: {
    readonly present: readonly string[];
    readonly spokeThisRound: readonly string[];
}): ModeratorDecision;
//# sourceMappingURL=moderator.d.ts.map