/**
 * DSH 模型调用适配：把"某个会话说一句话"接到上游的真实模型上。
 *
 * ## 上游机制（已按 `@deepseek-ai/dsh@0.1.6-alpha.2` 的 `.d.ts` 核对）
 *
 * ```
 * const run = await ctx.subagents.start('spawn', {
 *   label, prompt: ContentBlock[], parent: Agent, signal,
 *   agentOptions: { model },          // ← 支持按会话指定模型
 * })
 * const result = await run.result     // SubagentResult
 * result.output                       // ContentBlock[]，最后一个非空 assistant 消息
 * await run.dispose()
 * ```
 *
 * 要点：
 * - `spawn` 提供**一次性（one-shot）**子运行，**上下文干净**，并且**能读回最终输出**；
 * - `agentOptions.model` 支持按调用指定模型 → 这就兑现了需求里的
 *   "**每个参会就使用那个会话的对应模型**"；
 * - `run.result` 在子级失败时**不 reject**，而是以 `stopReason: 'error'` 解析，
 *   所以必须检查 `stopReason`（忽略它会把一次失败当成"沉默的成员"）。
 *
 * 对比另一条路：`ctx.agentTeams.sendMessage` 是**持久信箱**，只返回
 * `{ messageId, status }`，**不回传发言内容**——因此它适合做"唤起/通知"，
 * 不适合做"让某个会话发言并读回结果"。例会需要后者，所以这里走 `subagents`。
 *
 * ## 为什么每轮用一次性调用，而不是累积同一个子会话
 *
 * 三层理由：
 *
 * 1. **可行性**：只有 one-shot 路径能直接读回输出；
 * 2. **上下文预算**：每轮干净调用 + 显式注入"该会话的记忆投影 + 群聊记录"，
 *    使单轮上下文恒有界。若让子会话累积，N 人 × R 轮的群聊会把上下文撑爆
 *    （调研里 Selector/Swarm 的"broadcast 给所有成员"就是这个坑）；
 * 3. **归属清晰**：会话的**身份与记忆**由 `AgentParticipant` 持有（在我们这里），
 *    上游子运行只是"这次发言的执行者"。记忆不会因为上游会话生命周期而漂移。
 *
 * 代价说清楚：成员在会上的多轮发言之间**没有上游侧的上下文连续性**，
 * 连续性靠协调器把 transcript 注入每一轮 prompt 来维持。
 * 若将来需要真正的持久子会话，用 `startContinuable` + 会话事件观察替代本实现。
 */
import { buildModeratorPrompt, parseModeratorDecision } from '../core/moderator.js';
import { VoiceUnavailable } from '../ports/meeting-voice.js';
import { readService } from './dsh-team-runtime.js';
const DEFAULT_PROVIDER = 'spawn';
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export function createDshOneShotRunner(options) {
    const provider = options.provider ?? DEFAULT_PROVIDER;
    const timeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const service = () => {
        const value = readService(options.ctx, 'subagents');
        if (typeof value !== 'object' || value === null)
            return undefined;
        const candidate = value;
        return typeof candidate.start === 'function' ? candidate : undefined;
    };
    const capabilities = () => {
        const found = service();
        if (found === undefined) {
            return {
                available: false,
                notes: [
                    'ctx.get("subagents") 不可用或缺少 start()：无法调用模型。',
                    '请确认部署中装载了 @deepseek-ai/dsh-subagent 及其 provider（spawn）。',
                ],
            };
        }
        const providers = typeof found.list === 'function' ? found.list() : undefined;
        const notes = [];
        if (providers !== undefined && !providers.includes(provider)) {
            notes.push(`ctx.subagents 未注册 provider "${provider}"（当前：${providers.join(', ') || '(无)'}）；` +
                '例会会尝试调用但很可能失败。');
        }
        return { available: notes.length === 0, notes };
    };
    return {
        port: `dsh/subagents:${provider}`,
        capabilities,
        async run(input) {
            const found = service();
            if (found === undefined) {
                throw new VoiceUnavailable('DSH 模型调用不可用：ctx.get("subagents") 缺少 start()。' +
                    '例会需要它来让会话发言；没有它就只能报告降级，不能假装开完了会。');
            }
            const baseParent = await options.resolveCaller();
            if (baseParent === undefined || baseParent === null) {
                throw new VoiceUnavailable('无法解析当前活的 Agent 作为 subagent 的 parent，模型调用无法进行。');
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const onExternalAbort = () => controller.abort();
            input.signal?.addEventListener('abort', onExternalAbort, { once: true });
            let run;
            try {
                // **以谁的身份发言**：给了 `forkFrom` 就用 `fork` provider。
                // fork 的原生语义是"把 parent 已完成的对话轮次一次性 seed 进子会话"，
                // 于是子 Agent **带着那个人的完整上下文**——这正是"掏过来当作我的上下文注入"。
                // 没给就退回 spawn（干净上下文），由 prompt 里的上下文注入兜底。
                const useFork = input.forkFrom !== undefined && input.forkFrom !== null;
                const chosenProvider = useFork ? 'fork' : provider;
                const parent = useFork ? input.forkFrom : baseParent;
                const request = {
                    label: input.label,
                    prompt: [{ type: 'text', text: input.prompt }],
                    parent,
                    signal: controller.signal,
                    // **开会只管讨论，一个工具都不给**：上游会让这些工具从子 Agent 的
                    // 提示词里一起消失，它就不会想着回去探索项目。
                    toolFilter: input.toolFilter ?? { allow: [] },
                };
                // 带着角色发言：一次性子 Agent 天生空白，persona 是上游给它人格的唯一入口。
                if (input.persona !== undefined && input.persona.trim().length > 0) {
                    request.persona = input.persona;
                }
                // 按会话指定模型：需求要求"每个参会就使用那个会话的对应模型"。
                if (input.model !== undefined)
                    request.agentOptions = { model: input.model };
                run = await found.start?.(chosenProvider, request);
                if (run === undefined || run.result === undefined) {
                    throw new VoiceUnavailable(`ctx.subagents.start("${chosenProvider}") 没有返回带 result 的 run；无法读回发言内容。`);
                }
                // 注意：result 在子级失败时不 reject，而是带 stopReason: 'error' 解析。
                //
                // 还必须与 abort 信号**竞速**：超时只发信号是不够的——上游若忽略信号，
                // `await run.result` 会永远挂住，整场会议就死在那里。
                const result = await raceWithAbort(run.result, controller.signal, input.label);
                return extractOutput(result);
            }
            catch (error) {
                if (controller.signal.aborted) {
                    throw new VoiceUnavailable(`${input.label} 的模型调用超时（${timeoutMs}ms）或被取消。`);
                }
                throw error instanceof VoiceUnavailable
                    ? error
                    : new VoiceUnavailable(`${input.label} 的模型调用失败：${error instanceof Error ? error.message : String(error)}`);
            }
            finally {
                clearTimeout(timer);
                input.signal?.removeEventListener('abort', onExternalAbort);
                // run 必须被 dispose，否则子运行的工作与资源不会被取消和释放。
                try {
                    await run?.dispose?.();
                }
                catch {
                    // dispose 失败不应掩盖真正的调用结果。
                }
            }
        },
    };
}
/**
 * 等待一个 promise，但可被 abort 信号打断。
 *
 * 存在的理由：上游 `SubagentRun.result` 在正常情况下会 settle，
 * 但如果上游忽略了 abort 信号（或处于半死状态），单靠"发信号"不能解除 `await`，
 * 整个会议会静默挂住。所以必须显式竞速。
 */
function raceWithAbort(promise, signal, label) {
    if (signal.aborted) {
        return Promise.reject(new VoiceUnavailable(`${label} 的模型调用已被取消。`));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            reject(new VoiceUnavailable(`${label} 的模型调用超时或被取消（上游未在超时前返回）。`));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
}
/**
 * 从 `SubagentResult` 里取文本。
 *
 * 三个必须处理的真实情况：
 * 1. `stopReason !== 'completed'` → 抛错。**不能**把失败当成"这位成员没话说"，
 *    否则一场因为模型全挂而沉默的会议，看上去像"大家都没意见"。**这是最危险的静默失败。**
 * 2. `output` 为 undefined/空 → 抛错（同上，沉默不等于同意）。
 * 3. 只有非 text block → 抛错（我们不要图片/工具结果当发言）。
 */
export function extractOutput(result) {
    const stopReason = result.stopReason;
    if (stopReason !== undefined && stopReason !== 'completed') {
        const detail = result.diagnostic === undefined ? '' : `（${result.diagnostic}）`;
        throw new VoiceUnavailable(`模型调用未正常完成：stopReason=${stopReason}${detail}。` +
            '例会把它当失败处理，而不是当成"该成员没有补充"。');
    }
    const blocks = result.output ?? [];
    const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim();
    if (text.length === 0) {
        throw new VoiceUnavailable(`模型返回了空文本（blocks=${blocks.length}，stopReason=${stopReason ?? 'unknown'}）。` +
            '空发言会被例会判为失败，而不是静默跳过。');
    }
    return text;
}
/**
 * DSH 支持的 `MeetingVoicePort`：成员发言与会后纪要。
 *
 * 每次调用都是一次干净的 one-shot 运行，prompt 由协调器构造
 * （含该成员自己的记忆投影与群聊记录），并使用**该会话自己的模型**。
 */
export function createDshMeetingVoice(runner) {
    return {
        port: runner.port,
        capabilities() {
            const probe = runner.capabilities();
            return {
                port: runner.port,
                canSpeak: probe.available,
                canReflect: probe.available,
                notes: [
                    ...probe.notes,
                    '每次发言/纪要都是一次干净的 one-shot 子调用：上下文由 prompt 显式注入，不在上游会话里累积。',
                ],
            };
        },
        async speak(request) {
            return await runner.run({
                label: request.purpose === 'reflect' ? `minutes:${request.participant}` : `speech:${request.participant}`,
                prompt: request.prompt,
                model: request.model,
                persona: request.persona,
                forkFrom: request.forkFrom,
            });
        },
    };
}
/**
 * DSH 支持的 `ModeratorPort`：**没有上下文**的控场者。
 *
 * 它发出的 prompt 只由 `buildModeratorPrompt()` 产出（群聊记录 + 名单 + 谁没说话），
 * `model` 是**召集者会话的模型**。与会者之间没有私有记忆进入这个调用。
 */
export function createDshModerator(runner) {
    return {
        port: `${runner.port}:moderator`,
        async decide(input) {
            const raw = await runner.run({
                label: 'moderator',
                prompt: buildModeratorPrompt(input),
                model: input.model,
            });
            return parseModeratorDecision(raw, {
                present: input.present,
                spokeThisRound: input.spokeThisRound,
            });
        },
    };
}
//# sourceMappingURL=dsh-meeting-voice.js.map