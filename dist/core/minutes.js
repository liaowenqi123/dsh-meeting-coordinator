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
import { countChars } from './briefing-text.js';
/**
 * 纪要的**硬上限**。
 *
 * 刻意放宽到 1600：这是"防空洞"，不是"纪要长度"。
 * 提示词里给的是软目标（`guidanceChars`，大致 300 字），
 * 硬上限只有在模型明显失控时才碰到——紧贴实际长度的硬上限
 * 会逼模型去数字数甚至调工具核对字数，那是真实的算力黑洞。
 */
export const DEFAULT_MINUTES_MAX_CHARS = 1600;
/** 提示词里的软目标（"大致 300 字"）。 */
export const DEFAULT_MINUTES_GUIDANCE_CHARS = 300;
/**
 * "与自己相关"的**可操作定义**。
 *
 * 不给定义只说"总结与你相关的"，模型大概率会写一份通用会议摘要。
 * 这四条是判据：命中任意一条才算相关。
 */
export const RELEVANCE_RULES = [
    '别人点名了你，或向你提出了问题、请求、要求',
    '会上产生的决策、结论或方向调整会影响你接下来做什么',
    '你答应了要做的事、或别人答应给你什么输入',
    '与你的领域直接相关的风险、障碍、失败经验',
];
/**
 * 构造个性化压缩 prompt。
 *
 * 刻意包含**反面指令**（"不要做什么"）。实测经验与竞品调研都表明：
 * 只说"总结要点"，模型会写一份会议纪要模板；
 * 必须显式禁止复述别人的完整发言、禁止写通用结论。
 */
export function buildReflectionPrompt(input) {
    const ownSpeech = input.ownTurns.length === 0
        ? '（你在本次会议上没有发言）'
        : input.ownTurns.map((turn) => `- [R${turn.round}] ${turn.text}`).join('\n');
    return [
        `【会后纪要】你刚参加完会议（议题：${input.reason}），现在回到你自己的工作中。`,
        `你是「${input.title}」（领域 ${input.domain}）。`,
        '',
        '请写一段**只与你相关**的纪要，之后会写进你的长期记忆。',
        '',
        '「与你相关」的判据（命中任意一条即可）：',
        ...RELEVANCE_RULES.map((rule, index) => `${index + 1}. ${rule}`),
        '',
        '硬性要求：',
        `- 大致 ${input.guidanceChars} 字上下就行，不用掐字数。`,
        '- 用你自己的视角写，不要写"会议讨论了…"这种旁白式回顾；',
        '- **不要**复述别人的完整发言，只写别人对你的要求/承诺，以及会影响你的结论；',
        '- **不要**写通用会议总结或客套话；',
        '- 如果会上没有任何与你相关的内容，就写"本次会议无与我相关的事项"。',
        '',
        '你在会上的发言：',
        ownSpeech,
        '',
        '完整会议记录：',
        input.transcript,
    ].join('\n');
}
export class MinutesError extends Error {
    code = 'meeting/minutes';
    constructor(message) {
        super(message);
        this.name = 'MinutesError';
    }
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
export function validateMinutes(input) {
    const text = input.candidate.text.replace(/\s+/g, ' ').trim();
    if (text.length === 0) {
        return { ok: false, reason: `${input.candidate.participant} 的纪要为空。` };
    }
    const chars = countChars(text);
    if (chars > input.maxChars) {
        return {
            ok: false,
            reason: `${input.candidate.participant} 的纪要超长：上限 ${input.maxChars} 字，实际 ${chars} 字。`,
        };
    }
    if (input.transcriptChars > 0 && chars >= input.transcriptChars) {
        return {
            ok: false,
            reason: `${input.candidate.participant} 的纪要（${chars} 字）不短于会议记录本身（${input.transcriptChars} 字），` +
                '这不是压缩。请只保留与你相关的结论与待办。',
        };
    }
    return { ok: true, chars };
}
//# sourceMappingURL=minutes.js.map