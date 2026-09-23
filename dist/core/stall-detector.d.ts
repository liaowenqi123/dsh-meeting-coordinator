/**
 * 停滞 / 死循环信号检测。
 *
 * 这是"外部干预"的判据层：**不依赖 Agent 自述"我卡住了"**。
 * 竞品调研显示 Caucus 的 `ask_operator` 完全依赖 Agent 自判，
 * 而陷入死循环的 Agent 恰恰最不可能正确自判——所以判据必须由外部计算。
 *
 * 三层信号（对应调研建议的"三层防护"）：
 * 1. `silent-slot`       —— 某成员从未提交过简报；
 * 2. `stale-briefing`    —— 某成员连续 N 轮 / 超过 T 时间没有更新；
 * 3. `repeated-fingerprint` —— 同一成员连续提交**内容指纹相同**的简报（典型的空转）；
 * 4. `no-progress`       —— 整块看板 revision 长时间没有增长。
 */
import type { AgentSlotId, BoardSnapshot, Briefing } from './types.js';
export type StallSignalKind = 'silent-slot' | 'stale-briefing' | 'repeated-fingerprint' | 'no-progress';
export interface StallSignal {
    readonly kind: StallSignalKind;
    readonly slots: readonly AgentSlotId[];
    readonly detail: string;
}
export interface StallDetectionOptions {
    /** 连续多少轮未更新即视为停滞。 */
    readonly staleRounds: number;
    /** 距上次更新超过多少毫秒即视为停滞（默认 4 小时，对应"每 4 小时开会"）。 */
    readonly staleMs: number;
    /** 连续多少份指纹相同的简报即视为空转。 */
    readonly repeatedFingerprints: number;
    /** 整块看板多久没有新增即视为无进展。 */
    readonly noProgressMs: number;
}
export declare const DEFAULT_STALL_OPTIONS: StallDetectionOptions;
export interface StallDetectionInput {
    readonly snapshot: BoardSnapshot;
    /** 完整时间线，用于计算指纹连续段。 */
    readonly history: readonly Briefing[];
    /** 期望参会的成员全集（含从未提交者）。 */
    readonly slots: readonly AgentSlotId[];
    /** 协调器维护的当前轮次，用于 `staleRounds` 判定。 */
    readonly currentRound: number;
    readonly now: number;
    readonly options?: Partial<StallDetectionOptions> | undefined;
}
/**
 * 计算全部停滞信号。纯函数：给定相同输入必得相同输出，便于单测与复现。
 */
export declare function detectStall(input: StallDetectionInput): readonly StallSignal[];
//# sourceMappingURL=stall-detector.d.ts.map