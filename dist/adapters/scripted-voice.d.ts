/**
 * 脚本化声音：确定性测试替身，也是 demo 的载体。
 *
 * 它让**全部会议调度语义**都能在无模型、无网络的情况下被断言：
 * 会籍、召集、延迟入场、主持人控场、人类插话、个性化压缩、散会状态。
 *
 * ## 关于"每个人的模型"
 *
 * 每次 `speak()` 都会收到 `request.model`（该会话自己的模型）。
 * 本替身把收到的模型记进 `calls`，因此测试可以断言
 * "**每个成员确实是用自己的模型发言的**，主持人用的是召集者的模型"。
 *
 * ## 关于默认纪要替身
 *
 * `defaultReflect` 用正则从群聊里挑"与本人相关"的行，只是一个**可复现的替身**，
 * 用来验证"每人一份且互不相同"这一不变量。它产出的文本**不代表真实质量**——
 * 真实质量取决于模型。demo 里刻意用显式脚本给出纪要。
 */
import type { MeetingVoicePort, MeetingVoiceRequest, VoiceCapabilities } from '../ports/meeting-voice.js';
export interface ScriptedParticipantScript {
    /** 依次消费的发言脚本。 */
    readonly speeches?: readonly string[] | undefined;
    /** 会后纪要；缺省时用内置替身。 */
    readonly reflect?: ((transcript: string) => string) | undefined;
}
export interface ScriptedVoiceOptions {
    readonly scripts: Readonly<Record<string, ScriptedParticipantScript>>;
    readonly minutesMaxChars?: number | undefined;
}
export declare class ScriptedMeetingVoice implements MeetingVoicePort {
    readonly port = "scripted";
    private readonly scripts;
    private readonly cursors;
    private readonly minutesMaxChars;
    /** 记录每一次调用：喂了什么 prompt、用了哪个模型。 */
    readonly calls: {
        readonly participant: string;
        readonly purpose: string;
        readonly model: string | undefined;
        readonly prompt: string;
    }[];
    constructor(options: ScriptedVoiceOptions);
    capabilities(): VoiceCapabilities;
    speak(request: MeetingVoiceRequest): Promise<string>;
    /** 某成员还剩几条发言脚本，用于断言会议被主持人正确收束。 */
    remaining(participant: string): number;
}
//# sourceMappingURL=scripted-voice.d.ts.map