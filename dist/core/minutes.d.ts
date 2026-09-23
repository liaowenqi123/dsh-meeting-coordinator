/**
 * 会后纪要：为**每个参与者分别**压缩出一份"与自己相关"的会议纪要。
 *
 * ## 用户对这一步的定义
 *
 * > 在会议结束后，每个 AI 会带着自己的上下文总结一下这个会议和自己相关的内容
 * > （对会议内容做一下上下文压缩），然后回去之后每个 AI 的记忆就会变成
 * > "原私有上下文 + 自己相关的会议纪要"。
 *
 * 三个要点，缺一不可：
 *
 * 1. **每人一份，内容不同**。不是"一份全局会议纪要发给所有人"——
 *    那只是把广播换了个说法。A 关心的是"B 说我换手率太高，我要去验证"，
 *    C 关心的是"会上决定推迟上线，我的排期可以放松"。
 * 2. **是压缩，不是抄录**。纪要要显著短于会议本身，否则上下文照样膨胀。
 * 3. **只提炼"与自己相关"**。别人的完整发言不进我的记忆——
 *    这是与"上下文污染"之间那条线。
 *
 * ## 这里做什么、不做什么
 *
 * 本文件**不做** LLM 调用。它负责：
 * - 构造带明确"相关性"定义的压缩 prompt（这是最容易做错的一步）；
 * - 校验压缩结果确实变短了（否则压缩等于没做，必须暴露而不是接受）。
 *
 * 真正的生成由 `MeetingVoice.reflect()` 端口完成，可替换为任意模型或测试替身。
 */
import type { MeetingTurn } from './meeting-room.js';
/**
 * 纪要的**硬上限**。
 *
 * 刻意放宽到 1600：这是"防空洞"，不是"纪要长度"。
 * 提示词里给的是软目标（`guidanceChars`，大致 300 字），
 * 硬上限只有在模型明显失控时才碰到——紧贴实际长度的硬上限
 * 会逼模型去数字数甚至调工具核对字数，那是真实的算力黑洞。
 */
export declare const DEFAULT_MINUTES_MAX_CHARS = 1600;
/** 提示词里的软目标（"大致 300 字"）。 */
export declare const DEFAULT_MINUTES_GUIDANCE_CHARS = 300;
/**
 * "与自己相关"的**可操作定义**。
 *
 * 不给定义只说"总结与你相关的"，模型大概率会写一份通用会议摘要。
 * 这四条是判据：命中任意一条才算相关。
 */
export declare const RELEVANCE_RULES: readonly string[];
export interface ReflectionPromptInput {
    readonly participant: string;
    readonly title: string;
    readonly domain: string;
    readonly meetingId: string;
    readonly reason: string;
    /**
     * 提示词里的**软目标**字数（"大致 X 字"）。
     *
     * 与 `maxChars`（硬上限）分开是刻意的：紧贴实际长度的硬上限会让模型
     * 去数字数甚至调工具核对，那是真实的算力黑洞。
     */
    readonly guidanceChars: number;
    /** **硬上限**。只有超过它才被 `validateMinutes` 拒绝。 */
    readonly maxChars: number;
    /** 群聊上下文（经分层投影，已在预算内）。 */
    readonly transcript: string;
    /** 该参与者在会上的全部发言。 */
    readonly ownTurns: readonly MeetingTurn[];
}
/**
 * 构造个性化压缩 prompt。
 *
 * 刻意包含**反面指令**（"不要做什么"）。实测经验与竞品调研都表明：
 * 只说"总结要点"，模型会写一份会议纪要模板；
 * 必须显式禁止复述别人的完整发言、禁止写通用结论。
 */
export declare function buildReflectionPrompt(input: ReflectionPromptInput): string;
export declare class MinutesError extends Error {
    readonly code = "meeting/minutes";
    constructor(message: string);
}
export interface MinutesCandidate {
    readonly participant: string;
    readonly text: string;
}
/**
 * 校验压缩结果。
 *
 * 两条硬规则，都对应真实的失败模式：
 *
 * 1. **必须比它压缩的对象短**。纪要是对**会议内容**的压缩，所以比较基准是
 *    transcript 的总字符数，而不是某个人自己的发言量。
 *    （早先版本拿"自己的发言量"当基准，结果当某人在会上只说了一句话时，
 *    任何有信息量的纪要都会"比他说的还长"而被误拒。）
 * 2. **不能是空话**。空白或纯客套直接拒绝。
 */
export declare function validateMinutes(input: {
    readonly candidate: MinutesCandidate;
    readonly transcriptChars: number;
    readonly maxChars: number;
}): {
    readonly ok: true;
    readonly chars: number;
} | {
    readonly ok: false;
    readonly reason: string;
};
//# sourceMappingURL=minutes.d.ts.map