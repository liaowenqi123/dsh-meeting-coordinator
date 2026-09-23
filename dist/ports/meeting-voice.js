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
/** 主持人端口见 `core/moderator.ts`：它**没有**与会者的上下文，是独立的控制通道。 */
export {} from '../core/moderator.js';
export class VoiceUnavailable extends Error {
    code = 'meeting/voice-unavailable';
    constructor(message) {
        super(message);
        this.name = 'VoiceUnavailable';
    }
}
//# sourceMappingURL=meeting-voice.js.map