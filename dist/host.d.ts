/**
 * 宿主装配：**自托管**的组合 + 生命周期激活路径。
 *
 * ## 为什么需要"自托管"
 *
 * 真实装载契约（已在 `@deepseek-ai/dsh@0.1.6-alpha.2` 上核实）是：
 * 内核读 `package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` → 加载本包的
 * `apply(ctx, config)`。**内核不读 `dsh-plugin.json`**。
 *
 * 而 dsh-std 的 facet 模型要求"先协商、再激活"：`LifecycleCoordinator.activate(plan)`
 * 需要一个 `CompositionPlan`，它由 `compose()` 产出，而 `compose()` 需要
 * manifests + drivers + protocol catalog。**DSH 0.1.6 没有 dsh-std host 来提供这些**。
 *
 * 所以本文件临时承担 host 的职责：跑真实的 `compose()` 与 `LifecycleCoordinator`，
 * 而不是绕开标准自己写一套生命周期。这样做的好处是：
 *
 * - 现在就能端到端跑通"协商 → 激活 → 运行 → 卸载回收"的完整标准路径；
 * - 一旦出现符合 dsh-std 的 host，删掉本文件的 compose 部分、
 *   换成"从宿主拿 plan"即可，**facet 与协调器代码一行都不用改**。
 *
 * ## 两个入口
 *
 * - `activateMeetingHost(options)`：可编程入口，测试与 headless 使用；
 * - `apply(ctx, config)`：Cordis 插件入口，真实 DSH 装载使用。
 */
import { type CompositionPlan } from '@dsh-std/composition';
import { LifecycleCoordinator } from '@dsh-std/lifecycle';
import { MeetingCoordinator, type TriggerPolicyPolicy } from './core/coordinator.js';
import { RoomRegistry } from './core/room-registry.js';
import { MeetingOrchestrator, type RoomMeetingRecord } from './core/room-orchestrator.js';
import type { MeetingRoomPolicy } from './core/meeting-room.js';
import type { MeetingVoicePort } from './ports/meeting-voice.js';
import type { ModeratorPort } from './core/moderator.js';
import type { AgentSlotSpec, Briefing } from './core/types.js';
import type { StallSignal } from './core/stall-detector.js';
import { MeetingConsole, type CandidateSource } from './core/console.js';
import { type RoomMinutesStore } from './core/room-minutes.js';
import type { AgentRuntimePort } from './ports/agent-runtime.js';
import { type DshContextFace } from './adapters/dsh-team-runtime.js';
import { SessionActivityTracker } from './core/activity-tracker.js';
import type { TriggerEvaluation } from './core/triggers.js';
/** 协调器 facet 的名称（provider）。 */
export declare const COORDINATOR_FACET = "coordinator";
/** 成员 facet 的名称前缀（consumer）：`agent-<slotId>`。 */
export declare const AGENT_FACET_PREFIX = "agent-";
/** 本插件声明的 activation driver id。 */
export declare const MEETING_DRIVER_ID = "dsh-meeting/facet-module";
export interface MeetingHostOptions {
    readonly slots: readonly AgentSlotSpec[];
    readonly runtime: AgentRuntimePort;
    /**
     * 会议室用的"声音"（成员发言 / 会后纪要）。
     *
     * 生产环境传 `createDshMeetingVoice(createDshOneShotRunner({ ctx, resolveCaller }))`；
     * 测试与演示传 `ScriptedMeetingVoice`。
     */
    readonly voice: MeetingVoicePort;
    /** 主持人：有控场权、**没有**与会者上下文。生产传 `createDshModerator(...)`。 */
    readonly moderator: ModeratorPort;
    readonly boardDomain: string;
    readonly rootDir: string;
    /** 会议室 id。默认用 `boardDomain`。所有 slot 会被自动加入该会议室。 */
    readonly roomId?: string | undefined;
    readonly roomPolicy?: MeetingRoomPolicy | undefined;
    readonly minutesMaxChars?: number | undefined;
    readonly policy?: TriggerPolicyPolicy | undefined;
    readonly maxBriefingChars?: number | undefined;
    readonly maxAgendaChars?: number | undefined;
    readonly now?: (() => number) | undefined;
    /** 自定义清单路径；默认读包根的 dsh-plugin.json。 */
    readonly manifestPath?: string | undefined;
    /**
     * 组合计划计算完成、**尚未激活**时的回调。
     *
     * 存在的理由：装配失败时（例如某个 facet 的 require 无人满足），
     * 排查必须能看到"当时到底组合出了什么"，而不是只拿到一句 activation error。
     */
    readonly onPlan?: ((plan: CompositionPlan) => void) | undefined;
    /**
     * 额外的诊断行，在"升级未成立"时附加到理由后面。
     *
     * 存在的理由：升级失败最常见的原因是配置性问题（会话没映射、上游看不到成员），
     * 而这类原因没法在编排器内部知道。把它作为注入点，让宿主把观察到的实情带进来，
     * 失败信息才能自解释，而不是只说一句"全部成员都在工作中"。
     */
    readonly extraDiagnostics?: (() => readonly string[]) | undefined;
    /**
     * 成员被成功补起之后调用（`retryMembers()` 里）。
     *
     * 存在的理由：成员是新 spawn 的，它的上游会话 id 在 spawn 之前不存在，
     * 所以"会话 → 成员"映射必须在这之后重探一次，否则新成员的事件要等下一轮才认得出来。
     */
    readonly onMembersSpawned?: (() => Promise<void>) | undefined;
    /** 正式会议记录的落点。由编排器在散会后自动写入。 */
    readonly minutes?: RoomMinutesStore | undefined;
    /** 可加入会议的会话来源（宿主从 `ctx.sessions` 读）。 */
    readonly candidates?: CandidateSource | undefined;
    /** 候选会话"忙/闲"的判据来源（入会要求非活动）。 */
    readonly activity?: SessionActivityTracker | undefined;
    /** 成员状态读取，让面板能显示"谁在忙、谁空闲"。 */
    readonly stateOf?: ((sessionId: string) => string | undefined) | undefined;
    /**
     * 借一个会话当前的私有上下文（限长）。
     *
     * 生产环境由 `apply()` 接到 `readSessionContext()`（读真实会话的末尾若干条
     * 消息）；测试与 demo 可以不给——那就回到"只有议题没有背景"的旧行为。
     * 语义与失败处理见 `MeetingOrchestrator` 的 `contextOf`。
     */
    readonly contextOf?: ((sessionId: string, maxChars: number) => string | undefined) | undefined;
    /**
     * 解析一个成员的**上游 Agent 对象**（`ctx.agents.get(sessionId)`）。
     *
     * 给了它，发言就会走 `fork` provider：上游把那个人**已完成的对话轮次
     * 一次性 seed 进子会话**，于是进会场的那个人带着自己的完整上下文
     * ——而不是只带一段投影。这才是"掏过来当作我的上下文注入"。
     */
    readonly agentOf?: ((sessionId: string) => unknown) | undefined;
    /**
     * **会后回到工作区**：把纪要当作用户输入发回那个会话。
     *
     * 生产环境由 `apply()` 接到 `ctx.agents.get(id).inbox.append('nextTurn', …)`。
     */
    readonly resumeWork?: ((sessionId: string, text: string) => void | Promise<void>) | undefined;
}
/**
 * 一次「停滞升级到正式会议室」的结果。
 *
 * 刻意**不抛错**：升级失败（全员在工作中、已有一场会在进行）是运行期的正常分支，
 * 不是异常。把它变成异常会让定时器把整棵插件树炸掉。
 */
export interface RoomEscalationResult {
    readonly escalated: boolean;
    /** 为什么升级 / 为什么没升级。直接进日志与诊断。 */
    readonly reason: string;
    /** 成功时的会议记录。 */
    readonly record?: RoomMeetingRecord | undefined;
    /** 发起升级时所依据的停滞信号摘要。 */
    readonly signals: readonly string[];
}
export interface MeetingPulseResult {
    /** 轻量路径的结果（简报落板 + 汇总广播）。 */
    readonly light: Awaited<ReturnType<MeetingCoordinator['tick']>>;
    /** 停滞成立时的升级结果；未成立也带 reason 说明为什么不升级。 */
    readonly escalation: RoomEscalationResult;
}
export interface MeetingHostHandle {
    /** 真实的组合计划。`compatible=false` 时不可能走到这里。 */
    readonly plan: CompositionPlan;
    /** 轻量路径：简报板 + 停滞检测 + 汇总广播。 */
    readonly coordinator: MeetingCoordinator;
    /** 正式路径：会议室会籍 + 多轮会议。 */
    readonly rooms: RoomRegistry;
    readonly orchestrator: MeetingOrchestrator;
    /**
     * 会议室控制台：**面板与全局工具共用的唯一数据面**。
     *
     * 房间与成员的增删只走它；默认状态是"没有任何房间、没有任何会籍"。
     */
    readonly console: MeetingConsole;
    /**
     * 默认会议室名（`options.roomId ?? boardDomain`）。
     *
     * ⚠️ 它**只是一个名字**：本插件不再自动创建这个房间。
     * 房间是否存在于 registry，取决于谁在面板上建过它。
     */
    readonly defaultRoomId: string;
    readonly lifecycle: LifecycleCoordinator;
    /** 组合中被选中并激活的 facet participant id。 */
    readonly activated: readonly string[];
    /**
     * 还没成功启动的成员槽位。
     *
     * 非空**不是错误**：插件在 dsh 启动时加载，那一刻可能还没有任何活的 Agent 会话。
     * `pulse()` 每轮会重试；也可手动调 `retryMembers()`。
     */
    readonly pendingMembers: readonly string[];
    /** 重试启动尚未起来的成员，返回本次成功的槽位。 */
    retryMembers(): Promise<readonly string[]>;
    /** 推进一轮并评估触发；成立则自动开会。**只走轻量路径。** */
    tick(): Promise<ReturnType<MeetingCoordinator['tick']> extends Promise<infer T> ? T : never>;
    /**
     * 把一次触发评估升级成**正式会议室**。
     *
     * 这是 README 第五节那条 `轻量路径 ──检测到停滞/按需召集──▶ 正式路径` 箭头的落点。
     * 没有它，`MeetingOrchestrator` 在真实宿主里永远无人调用 ——
     * 会议室、主持人控场、每人个性化纪要全成了只有测试才会执行的死代码。
     */
    escalate(evaluation: TriggerEvaluation): Promise<RoomEscalationResult>;
    /** 定时器用的完整一轮：轻量路径 + 停滞成立时升级到会议室。**永不抛错。** */
    pulse(): Promise<MeetingPulseResult>;
    /** 任何成员都可召集（互相唤起的入口）。 */
    callMeeting(call: Parameters<MeetingCoordinator['callMeeting']>[0]): ReturnType<MeetingCoordinator['callMeeting']>;
    shutdown(): Promise<void>;
}
/**
 * 从停滞信号推出"该叫谁来开这场干预会"。
 *
 * 口径与 `MeetingCoordinator.selectParticipants` 的 `local` 分支**刻意保持一致**：
 * 出问题的成员 + 明确有障碍/求助的成员 + 它们点名要的人。
 * 不把停滞广播给健康成员——那正是"上下文污染"本身。
 *
 * 返回空数组表示"没有可以精确点名的对象"，调用方应退化为大会（`global`），
 * 因为 `scope: 'local'` 在没有 invitees 时会被编排器拒绝。
 */
export declare function selectRoomInvitees(input: {
    readonly signals: readonly StallSignal[];
    readonly briefings: readonly Briefing[];
    readonly candidates: readonly string[];
}): readonly string[];
/**
 * 选一个"该在哪儿开这场干预会"的会议室。
 *
 * 默认会籍意味着**房间可能一个都没有**，所以升级必须能回答"没有房间时怎么办"。
 * 优先级：含停滞成员的房间（先局部解决）→ 任何有成员的房间 → 无（不升级）。
 */
export declare function pickEscalationRoom(registry: RoomRegistry, stalledSlots: readonly string[]): {
    readonly id: string;
} | undefined;
/**
 * 用真实的 compose() + LifecycleCoordinator 激活本插件。
 *
 * 关键设计：**provider facet 先于 consumer facet 激活**。
 * 这不是我们手动排序的，而是 `compose()` 的 `facetActivationOrder` 按
 * "provider 先于 consumer"拓扑排序得出的；因此协调器的 support 在成员 facet
 * 做 pre-activation 协商时已经发布，`context.protocols.agreement()` 才拿得到。
 */
export declare function activateMeetingHost(options: MeetingHostOptions): Promise<MeetingHostHandle>;
/** 宿主配置。可以由 `apply(ctx, config)` 传入，或从环境变量读取。 */
export interface MeetingPluginConfig {
    readonly boardDomain?: string | undefined;
    readonly rootDir?: string | undefined;
    readonly slots?: readonly AgentSlotSpec[] | undefined;
    readonly preferredBackend?: 'agentTeams' | 'subagents' | undefined;
    readonly staleRounds?: number | undefined;
    readonly everyRounds?: number | undefined;
    readonly everyHours?: number | undefined;
    /** 模型调用使用的 subagent provider。默认 `spawn`（全新上下文）。 */
    readonly voiceProvider?: string | undefined;
    /** 单次模型调用超时（毫秒）。默认 120000。 */
    readonly voiceTimeoutMs?: number | undefined;
    /** 会后纪要字数上限。默认 300。 */
    readonly minutesMaxChars?: number | undefined;
    /** 入场等待采用的边界。默认 `step-end`（对应"调用结束后"）。 */
    readonly entryBoundary?: 'step-end' | 'turn-end' | undefined;
    /**
     * 是否启用每 60 秒的自动节律（停滞检测 + 自动升级到会议室）。
     *
     * **默认 `false`**。上一版是默认开，后果是"插件一装上就自己开始开会"——
     * 而会籍本该是权限边界，开会本该是人先建房间、先加人。
     * 打开它是显式选择：你要无人值守的自动干预，才开。
     */
    readonly autoPulse?: boolean | undefined;
    /**
     * 上游会话 id → 成员 id 的显式映射。
     *
     * 生产环境**必须**提供（或保证会话 id 恰好等于 slot id）：
     * 上游 `session/event` 携带的是 DSH 自己的会话 id，默认的恒等映射
     * 会让边界事件与活动事件都匹配不到任何成员——
     * 表现是"插件装好了、日志也不报错，但永远没人入场、会议室永远开不起来"。
     *
     * 例：`{ 'a1b2c3-session-uuid': 'live-trading' }`
     */
    readonly memberSessions?: Readonly<Record<string, string>> | undefined;
}
/** Cordis 插件所需的极窄 context 视图：零 `@deepseek-ai/*` import。 */
export interface DshPluginContextFace extends DshContextFace {
    on?(event: string, listener: (...args: unknown[]) => unknown): unknown;
    effect?(callback: () => unknown): unknown;
    /**
     * Cordis 的 logger 服务（可选）。
     *
     * 它的存在是必需的，不是因为"日志好看"：例会节律跑在定时器里，
     * 而本插件没有 UI、也（暂时）没有命令 —— 升级失败的原因**没有别的地方可去**。
     * 不接它，用户看到的就只是"什么都没发生"，而这正是最难排查的一种表现。
     */
    logger?: {
        info?(message: string, ...rest: unknown[]): unknown;
        warn?(message: string, ...rest: unknown[]): unknown;
        error?(message: string, ...rest: unknown[]): unknown;
    } | undefined;
}
/** 渲染给成员看的标准简报指令，随 spawn 提示词一起送进去。 */
export declare function renderBriefingInstruction(maxChars: number): string;
/**
 * 从环境变量读槽位配置。
 *
 * 存在的理由：配置文件（`cordis.patch.yml`）里写不下时，或者想让同一份
 * bundle patch 服务不同工作区时，可以用环境变量喂成员名单。
 * 报错文案早就承诺了这个变量，之前却没有任何代码读它——这里补上。
 *
 * 格式：`DSH_MEETING_SLOTS` = 一个 JSON 数组，元素是 {@link AgentSlotSpec}。
 * 解析失败一律**明确报错**，不静默当作"没有槽位"——
 * 后者会让人以为插件在跑，实际一个成员都没有。
 */
export declare function readSlotsFromEnv(env: Record<string, string | undefined>): readonly AgentSlotSpec[];
/**
 * Cordis 插件入口的返回值。
 *
 * ## 为什么必须是"可调用的函数 + 属性"，而不是直接返回句柄
 *
 * Cordis 对插件 effect 的判定是（`Fiber._execute` → `safeCollect`）：
 *
 * ```js
 * const effect = runner.execute.call(this)
 * if (typeof effect === 'function') return runner.collect(effect)   // ← disposer，合法
 * else if (isNullable(effect)) {}                                   // ← 什么都不返回，合法
 * else if (!isObject(effect)) throw new TypeError('Invalid effect')
 * else if ('then' in effect) return effect.then(safeCollect)         // ← async 的返回值走这里
 * …
 * ```
 *
 * 也就是说：**async `apply` 的 resolve 值只能是 `undefined` 或一个函数**。
 * 直接 resolve 一个句柄对象 → `safeCollect` 抛 `TypeError: Invalid effect` →
 * 整个 dsh `plugin tree failed to load`。（真实踩过。）
 *
 * 所以这里返回一个 disposer 函数既满足契约、又顺带拿到了正规的卸载清理；
 * 程序化调用方（测试、headless）通过 `.host` 属性取句柄。
 */
export interface MeetingPluginActivation {
    /** 拆掉插件：解除订阅、停掉定时器、散会、卸载 facet。**幂等**。 */
    (): Promise<void>;
    readonly host: MeetingHostHandle;
    /**
     * 装配诊断。主要用来看**全局工具到底注册上没有**——
     * 注册失败不会让宿主下线，所以它会静默消失，必须有个地方能看到。
     */
    readonly notes: readonly string[];
}
/**
 * Cordis 插件入口。
 *
 * 装配顺序：探测上游运行时能力 → 用真实的 compose/lifecycle 激活 facet →
 * 注册定时驱动（通过 `ctx` 的生命周期，不自己持有裸定时器）。
 */
export declare function apply(ctx: DshPluginContextFace, config?: MeetingPluginConfig): Promise<MeetingPluginActivation>;
export default apply;
//# sourceMappingURL=host.d.ts.map