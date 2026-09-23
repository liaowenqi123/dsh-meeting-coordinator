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
import { VoiceUnavailable } from '../ports/meeting-voice.js';
/**
 * 默认纪要实现：按"相关性"给群聊行打分，只保留与自己相关的。
 *
 * 打分优先"明确点名了我"，其次是"对我提了要求/建议"。
 */
function defaultReflect(participant, transcript, maxChars) {
    const scored = [];
    for (const line of transcript.split('\n')) {
        if (!line.startsWith('[R'))
            continue;
        const body = line.replace(/^\[R\d+\]\s*/, '');
        const speaker = body.split(':')[0]?.trim() ?? '';
        if (speaker === participant)
            continue;
        if (body.includes(participant)) {
            scored.push({ score: 2, line: `- ${body}` });
            continue;
        }
        if (/请你|需要你|要求你|建议你/.test(body)) {
            scored.push({ score: 1, line: `- ${body}` });
        }
    }
    if (scored.length === 0)
        return '本次会议无与我相关的事项。';
    scored.sort((left, right) => right.score - left.score);
    const kept = [];
    let used = 0;
    for (const entry of scored) {
        const cost = entry.line.length + (kept.length > 0 ? 1 : 0);
        if (used + cost > maxChars)
            break;
        kept.push(entry.line);
        used += cost;
    }
    if (kept.length === 0) {
        const first = scored[0];
        return first.line.slice(0, Math.max(1, maxChars - 1)) + '…';
    }
    return kept.join(' ');
}
export class ScriptedMeetingVoice {
    port = 'scripted';
    scripts;
    cursors = new Map();
    minutesMaxChars;
    /** 记录每一次调用：喂了什么 prompt、用了哪个模型。 */
    calls = [];
    constructor(options) {
        this.scripts = options.scripts;
        this.minutesMaxChars = options.minutesMaxChars ?? 300;
    }
    capabilities() {
        return {
            port: this.port,
            canSpeak: true,
            canReflect: true,
            notes: ['脚本化声音：仅用于测试与演示，不做真实模型调用。'],
        };
    }
    async speak(request) {
        this.calls.push({
            participant: request.participant,
            purpose: request.purpose,
            model: request.model,
            prompt: request.prompt,
        });
        const script = this.scripts[request.participant];
        if (request.purpose === 'reflect') {
            const custom = script?.reflect;
            if (custom !== undefined)
                return custom(extractTranscript(request.prompt));
            return defaultReflect(request.participant, extractTranscript(request.prompt), this.minutesMaxChars);
        }
        if (script === undefined) {
            throw new VoiceUnavailable(`脚本化声音没有为 ${request.participant} 配置任何发言。`);
        }
        const cursor = this.cursors.get(request.participant) ?? 0;
        const next = script.speeches?.[cursor];
        if (next === undefined) {
            throw new VoiceUnavailable(`${request.participant} 没有更多的发言脚本（已消费 ${cursor} 条）。若会议需要它再次发言，请补足脚本。`);
        }
        this.cursors.set(request.participant, cursor + 1);
        return next;
    }
    /** 某成员还剩几条发言脚本，用于断言会议被主持人正确收束。 */
    remaining(participant) {
        return (this.scripts[participant]?.speeches?.length ?? 0) - (this.cursors.get(participant) ?? 0);
    }
}
function extractTranscript(prompt) {
    const marker = '完整会议记录：';
    const index = prompt.indexOf(marker);
    if (index < 0)
        return prompt;
    return prompt.slice(index + marker.length).trim();
}
//# sourceMappingURL=scripted-voice.js.map