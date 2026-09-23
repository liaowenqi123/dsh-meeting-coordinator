/**
 * 私有领域协议 `meeting.dsh/v1alpha1` / `BriefingBoard`。
 *
 * ## 为什么需要一份新协议，而不是复用 Agent / Session
 *
 * 1. `@dsh-std/agent` **没有发布 npm 包**（只有 `docs/proposals/agent.zh.md`），
 *    无法作为依赖；且它的语义是"活动 Agent 的控制与配置"，不表达"跨领域简报交换"。
 * 2. `@dsh-std/session` 已发布，但操作集是穷举且封闭的：
 *    SessionCatalog = list|get|create|rename|delete|watch，
 *    SessionHistory = read|follow|fork。没有 append / turn / prompt，
 *    因此无法承载"Agent 提交简报"这一写操作。
 * 3. dsh-std 明确鼓励这条路：AGENTS.md 写明
 *    「Private protocols use their own namespaced `apiVersion` and participate through
 *    the same core declaration and negotiation mechanism as public protocols.」
 *
 * ## 本定义遵守的 core 元协议不变量
 *
 * - 协商结果与注册顺序无关（确定性）；
 * - 协议专属字段由本 definition 拥有，core 不解释；
 * - agreement 是 lossless JSON 数据（无 Date / Map / undefined）；
 * - 多 provider 歧义必须由**显式 policy** 仲裁，不能按注册顺序。
 */
import type { ProtocolDefinition } from '@dsh-std/core';
import type { BriefingBoardOperation, MeetingScope } from '../core/types.js';
export declare const MEETING_API_VERSION = "meeting.dsh/v1alpha1";
export declare const BRIEFING_BOARD_KIND = "BriefingBoard";
/** 默认议程摘要预算。 */
export declare const DEFAULT_MAX_AGENDA_CHARS = 1200;
/** 消费方（领域 Agent 槽位）声明自己需要这块简报板的哪些能力。 */
export interface BriefingBoardRequirementSpec {
    /**
     * 要加入的简报板标识（项目级，例如 `quant-trading`）。
     *
     * **可选**：core 把整个 `spec` 设为可选，消费方常常只声明
     * "我需要 BriefingBoard" 而不带任何 spec。此时的语义是
     * "接受本次协商范围内 coordinator 提供的那块板"。
     * 若显式给出，则必须与最终选中的 coordinator 的板一致。
     */
    readonly boardDomain?: string | undefined;
    /**
     * 每一项都必须被 coordinator 满足，否则协商失败。
     * 完全省略 spec 时默认为 `publish` + `read`（能提交、能读回）。
     */
    readonly operations: readonly BriefingBoardOperation[];
    /** 缺失时不阻止协商，只出现在协商报告的未满足列表里。 */
    readonly optionalOperations?: readonly BriefingBoardOperation[] | undefined;
    /** 调用方希望的简报长度上限。小于 coordinator 上限时取更严者。 */
    readonly maxBriefingChars?: number | undefined;
    /** 调用方希望的会议规模。必须与 coordinator 有交集。 */
    readonly scopes?: readonly MeetingScope[] | undefined;
}
/** 协调器声明自己实际能提供的能力。只能声明**当前真正实现**的操作。 */
export interface BriefingBoardSupportSpec {
    readonly boardDomain: string;
    readonly operations: readonly BriefingBoardOperation[];
    readonly scopes: readonly MeetingScope[];
    /** coordinator 强制的简报硬上限（字符，按 code point）。 */
    readonly maxBriefingChars: number;
    readonly limits?: BriefingBoardLimits | undefined;
}
export interface BriefingBoardLimits {
    /** 含 coordinator 在内的最大成员数。 */
    readonly maxParticipants?: number | undefined;
    /** 广播摘要在所有成员上的总预算。 */
    readonly maxAgendaChars?: number | undefined;
}
/**
 * 协商产物。必须是 lossless JSON：只含有限数字、字符串、布尔、null、数组与普通对象。
 */
export interface BriefingBoardAgreement {
    readonly boardDomain: string;
    /** 被选中的 coordinator participant id。 */
    readonly coordinator: string;
    /** 加入该板的 client participant id，已按 code-unit 字典序规范化。 */
    readonly clients: readonly string[];
    /** 协商后实际可用的操作，已按规范顺序排列。 */
    readonly operations: readonly BriefingBoardOperation[];
    /** 被满足的可选操作。 */
    readonly optionalOperationsSatisfied: readonly BriefingBoardOperation[];
    /** 可用会议规模。 */
    readonly scopes: readonly MeetingScope[];
    /** 协商后的简报硬上限（对全体成员一致）。 */
    readonly maxBriefingChars: number;
    readonly maxAgendaChars: number;
    readonly maxParticipants: number;
}
/** 协商 policy：唯一被允许的多 provider 仲裁入口。 */
export interface BriefingBoardNegotiationPolicy {
    /** 显式指定哪个 participant 担任 coordinator；缺省且候选不唯一时报歧义。 */
    readonly selectCoordinator?: string | undefined;
}
/**
 * 交给 `ProtocolCatalog.register()` 的 definition。
 *
 * 注意这里**没有** `accepts`：core 的 `validateDefinition` 会把
 * `apiVersion` 本身并入可接受集合，因此 `accepts` 只能列出**额外**的、
 * 且与主坐标不同的版本；重复列出主坐标会被直接判为 definition 错误
 * （`node_modules/@dsh-std/core/lib/index.js` 的 `validateDefinition`）。
 * 本协议目前只有 v1alpha1 一个坐标，所以省略该字段。
 */
export declare const briefingBoardProtocol: ProtocolDefinition<BriefingBoardRequirementSpec, BriefingBoardSupportSpec, BriefingBoardAgreement, BriefingBoardNegotiationPolicy>;
//# sourceMappingURL=meeting-protocol.d.ts.map