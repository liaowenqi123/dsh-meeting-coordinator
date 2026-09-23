/**
 * 简报文本预算与指纹。
 *
 * 设计依据：简报通道是"每个 Agent 开口前都要付的固定成本"，
 * 因此长度必须是**硬上限 + 分字段预算**，而不是一句"请写 200 字以内"的提示词约定。
 * 超限一律显式报错（`BriefingBudgetExceeded`），不静默截断——
 * 静默截断会让 Agent 误以为自己的诉求已经传达。
 */
import type { BriefingDraft } from './types.js';
/** 领域默认预算：200 字符（按 code point 计）。 */
export declare const DEFAULT_MAX_BRIEFING_CHARS = 200;
export declare class BriefingBudgetExceeded extends Error {
    readonly code = "meeting/briefing-budget-exceeded";
    readonly limit: number;
    readonly actual: number;
    constructor(limit: number, actual: number);
}
export declare class BriefingInvalid extends Error {
    readonly code = "meeting/briefing-invalid";
    constructor(message: string);
}
/**
 * 按 Unicode code point 计数。
 *
 * 不用 `string.length`：中文与 emoji 在 UTF-16 下会多算，导致"200 字"对中英文不等价。
 */
export declare function countChars(value: string): number;
/** 归一化：去首尾空白，折叠内部连续空白（含换行）为单个空格。 */
export declare function normalizeField(value: string): string;
/**
 * 计算一份草稿计入预算的字符数。
 *
 * 计入项：status + blocker + 每个 need。
 * 不计入：slot / domain / round / requestedFrom —— 这些是寻址元数据，不是 Agent 的表达内容。
 */
export declare function briefingCharCount(draft: BriefingDraft): number;
/** 在预算内校验草稿；超限抛出 {@link BriefingBudgetExceeded}。 */
export declare function assertWithinBudget(draft: BriefingDraft, maxChars: number): number;
/** 校验必填字段非空。 */
export declare function assertDraftWellFormed(draft: BriefingDraft): void;
/**
 * 内容指纹：用于识别"同一份状态被反复提交"这一死循环信号。
 *
 * 刻意**不含** round 与时间：Agent 每轮都报同一句话，正是要检出的空转模式。
 * 使用规范化后的 status+blocker+needs。
 */
export declare function briefingFingerprint(draft: BriefingDraft): string;
/**
 * FNV-1a 64 位（BigInt 实现，输出 16 位十六进制）。
 *
 * 选它而不是 Node `crypto`：指纹只需稳定、跨进程一致、无依赖，
 * 不承担安全职责（简报不是凭据）。与 @dsh-std/composition 内部 digest 的选择保持一致。
 */
export declare function fnv1a64(input: string): string;
//# sourceMappingURL=briefing-text.d.ts.map