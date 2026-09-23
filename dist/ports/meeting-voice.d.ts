/**
 * 会议室里的"声音"：让某个参与者在某个时刻产出一段文本。
 *
 * ## 为什么单独抽一个端口
 *
 * 会议室的核心逻辑（谁发言、发言顺序、上下文预算、会后压缩）是**纯调度**，
 * 不该和"怎么调模型"耦合。抽出来之后：
 *
 * - `ScriptedMeetingVoice`：确定性测试替身 + demo 载体，无需真实模型即可验证全部调度语义；
 * - DSH 实现：把 prompt 投给某个 Agent 的会话，读回它的输出。
 *
 * ## 与"私有上下文"的关系
 *
 * `speak()` 的 `prompt` 已经包含该参与者的**记忆投影**与群聊上下文
 * （由 `MeetingRoom` 与 `minutes.ts` 构造）。
 * 因此实现方**不需要也不应该**自己去翻别的 Agent 的记忆——
 * 一切跨参与者信息都必须经由 prompt 显式传入，这正是隔离的保证。
 */
export interface VoiceCapabilities {
    readonly port: string;
    /** 能否产出发言。 */
    readonly canSpeak: boolean;
    /** 能否在会后做个性化压缩。 */
    readonly canReflect: boolean;
    readonly notes: readonly string[];
}
export type VoicePurpose = 'speak' | 'reflect';
export interface MeetingVoiceRequest {
    /** 发言者（成员 id）。 */
    readonly participant: string;
    readonly purpose: VoicePurpose;
    /** 完整 prompt（已含该成员自己的记忆投影 / 群聊上下文 / 相关性规则）。 */
    readonly prompt: string;
    /** 输出字符上限。实现方应尽量遵守，最终由 `MeetingRoom` 硬校验。 */
    readonly maxChars: number;
    /**
     * **该会话自己的模型**。
     *
     * 需求明确："每个参会就使用那个会话的对应模型就行"。
     * 协调器不选模型，只把会话已有的模型配置透传下来。
     * 未配置时为 undefined，由实现方使用宿主默认模型。
     */
    readonly model?: string | undefined;
    /**
     * **该会话的角色/人格**（即它的 `systemPrompt`）。
     *
     * 一次性子 Agent 必须带着对应成员的角色去发言，否则它只是一个
     * "披着名字外衣的陌生人"——看起来是 A 在说话，实际谁都不是。
     * 实现方应把它送到上游 `SubagentStartRequest.persona`。
     */
    readonly persona?: string | undefined;
    /**
     * **以谁的身份发言**（那个人的 exact live Agent）。
     *
     * 给了它，实现方应当走 `fork` provider：上游会把那个人**已完成的对话轮次
     * 一次性 seed 进子会话**，于是这个子 Agent **就是**那个人
     * ——它的完整上下文成为这个子 Agent 自己的上下文。
     *
     * 用户原话：
     * > 我希望这个会话可以把那个人的所有上下文掏过来，当作我的上下文注入。
     *
     * 不给就退回干净上下文，由 prompt 里的上下文注入兜底。
     */
    readonly forkFrom?: unknown;
}
export interface MeetingVoicePort {
    readonly port: string;
    capabilities(): VoiceCapabilities;
    /** 产出一次发言（`purpose` 决定语义，调用形态统一）。 */
    speak(request: MeetingVoiceRequest): Promise<string>;
}
/** 主持人端口见 `core/moderator.ts`：它**没有**与会者的上下文，是独立的控制通道。 */
export { type ModeratorPort, type ModeratorContext } from '../core/moderator.js';
export declare class VoiceUnavailable extends Error {
    readonly code = "meeting/voice-unavailable";
    constructor(message: string);
}
//# sourceMappingURL=meeting-voice.d.ts.map