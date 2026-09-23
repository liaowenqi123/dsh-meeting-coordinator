/**
 * Facet 入口：把例会机制装进 dsh-std 的 **composition / lifecycle / facet 模型**。
 *
 * ## 为什么必须有两个角色
 *
 * `LifecycleCoordinator.activateOne` 在激活任何 facet 之前，会先做一次
 * **真实的 pre-activation 协商**：把该 facet 的 `requires`（`plannedDeclaration`）
 * 与**当前已发布的 supports**（`publications.declarations()`）一起交给
 * `ProtocolCatalog.negotiate`；只要有 error 级 issue，激活直接失败。
 *
 * 这决定了一个必须诚实面对的事实：**同一个 facet 不能既 `require` 又 `support` 同一份协议**。
 * 所以本插件按标准拆成两种 facet：
 *
 * - **coordinator facet**：`support` `meeting.dsh/v1alpha1/BriefingBoard`。
 *   它是简报板与会议的所有者，预算由自己给定（它就是权威）。
 * - **agent facet**（每个领域方向一个）：`require` 同一份协议。
 *   预算来自协商出的 agreement —— 消费方不能自己说了算。
 *
 * 这正好落实"按需激活、卸载即回收"：
 * 一个领域方向就是一个 facet，不激活就不加载、不占上下文；卸载时 scope 关闭 → 成员回收。
 *
 * ## 零泄漏怎么保证
 *
 * 协调器**不持有任何定时器**（时间由外部 `tick()` 驱动），所有句柄都登记进
 * `context.scope`。卸载即 scope 关闭，不依赖任何人"记得"手动清理。
 */
import { type FacetModule } from '@dsh-std/sdk';
import type { ProtocolSupport } from '@dsh-std/core';
import type { AgentHandle } from './ports/agent-runtime.js';
import { BriefingBoard } from './core/briefing-board.js';
import { MeetingCoordinator, type MeetingRecord, type TriggerPolicyPolicy } from './core/coordinator.js';
import { type BriefingBoardAgreement } from './protocol/meeting-protocol.js';
import type { AgentSlotId, AgentSlotSpec, BriefingDraft, MeetingCall } from './core/types.js';
import type { AgentRuntimePort } from './ports/agent-runtime.js';
/** 本插件协议的坐标，供宿主协商与 `context.protocols.*` 查询。 */
export declare const PROTOCOL_REFERENCE: {
    readonly apiVersion: "meeting.dsh/v1alpha1";
    readonly kind: "BriefingBoard";
};
/** 协调器通过协议对外暴露的实现面。 */
export interface BriefingBoardImplementation {
    readonly agreement: BriefingBoardAgreement;
    publish(draft: BriefingDraft): void;
    briefings(): readonly unknown[];
    convene(call: MeetingCall): Promise<MeetingRecord>;
    meetings(): readonly MeetingRecord[];
}
/**
 * 进程内共享状态。
 *
 * 简报板是**跨 facet 的共享通道**，但 agreement 只说"你能用这块板"，
 * 不提供板的句柄 —— 按标准它应当由协调器实现并通过协议暴露。
 * 本仓库的 MVP 在同一进程内直接共享句柄，不自造 IPC 层；
 * 跨进程时由 `@dsh-std/connection` 的 attachment 取代它
 * （见 docs/架构调研结论.md 的"演进路径"一节）。
 */
export interface MeetingSharedState {
    readonly board: BriefingBoard;
    readonly registry: MeetingRegistry;
    /**
     * 成员 facet 被卸载时的回调。
     *
     * 协调器的名册必须跟着 facet 生命周期走，否则"卸载即回收"只回收了 Agent，
     * 协调器里还留着指向已关闭句柄的悬空引用。
     * 由宿主在创建协调器后接上。
     */
    onMemberGone?: ((slot: AgentSlotId) => void) | undefined;
}
/** 协调器与成员 facet 之间的最小注册表：只说"谁在、怎么找到它"。 */
export declare class MeetingRegistry {
    private readonly handles;
    register(slot: string, handle: AgentHandle): void;
    unregister(slot: string): void;
    get(slot: string): AgentHandle | undefined;
    slots(): readonly string[];
}
export interface MeetingBaseConfig {
    /** 简报板标识（项目级）。 */
    readonly boardDomain: string;
    /** 简报板与会议记录的持久化根目录。 */
    readonly rootDir: string;
    readonly now?: (() => number) | undefined;
}
export interface CoordinatorFacetConfig extends MeetingBaseConfig {
    /** 简报字符硬上限。协调器是预算权威。 */
    readonly maxBriefingChars?: number | undefined;
    /** 广播摘要总预算。 */
    readonly maxAgendaChars?: number | undefined;
    /** 成员数上限（含协调器）。 */
    readonly maxParticipants?: number | undefined;
    /** 触发与召集节流策略。 */
    readonly policy?: TriggerPolicyPolicy | undefined;
}
export interface CoordinatorFacetHandle {
    readonly role: 'coordinator';
    readonly facet: FacetModule;
    /** 宿主据此协商；同进程成员 facet 的 `require` 由它满足。 */
    readonly support: ProtocolSupport;
    /** 激活后把协调器绑定进来（需要运行时，而运行时来自宿主）。 */
    bind(coordinator: MeetingCoordinator): void;
    coordinator(): MeetingCoordinator | undefined;
    /** 激活后才有值；成员 facet 依赖它拿共享句柄。 */
    shared(): MeetingSharedState | undefined;
}
export interface AgentFacetConfig extends MeetingBaseConfig {
    /** 该 facet 代表的领域隔离 Agent。 */
    readonly slot: AgentSlotSpec;
    /** 运行时端口。生产用 `createDshMeetingRuntime(...)`，测试用 `InMemoryAgentRuntime`。 */
    readonly runtime: AgentRuntimePort;
    readonly shared: MeetingSharedState;
}
export interface AgentFacetHandle {
    readonly role: 'agent';
    readonly facet: FacetModule;
    handle(): AgentHandle | undefined;
    /**
     * 重新尝试启动该成员。返回是否成功。
     *
     * 存在的理由：**启动成员需要"活的 Agent"作为上游授权凭据，而插件是在
     * dsh 启动时加载的——那一刻可能一个会话都还没有**。这不是错误，
     * 只是时机未到。所以启动失败降级而不是抛错（否则一个插件能把整个 dsh 带下线），
     * 由宿主在后续轮次里重试。
     */
    retry(): Promise<boolean>;
    /** 上次启动失败的原因；成功过则为 undefined。 */
    lastFailure(): string | undefined;
}
export declare function createCoordinatorFacet(config: CoordinatorFacetConfig): CoordinatorFacetHandle;
/**
 * 构造成员 facet：代表**一个**领域隔离子 Agent。
 *
 * 激活时做三件事：
 * 1. 从协商结果读出自己被允许的简报预算（消费方不能自己说了算）；
 * 2. 校验 agreement 的 boardDomain 与本地配置一致；
 * 3. 启动自己的 Agent，并把句柄登记进 `context.scope` —— 卸载即回收。
 *
 * ## 为什么"启动失败"不抛错（这一点是被真实 boot 逼出来的）
 *
 * 启动成员要调上游 `spawnTeammate(caller, …)`，而 `caller` 必须是**活的 Agent**。
 * 插件是在 dsh 启动时加载的——**那一刻用户可能还没开任何会话，一个 Agent 都没有**。
 * 那时抛错的后果不是"这个成员没起来"，而是
 * `plugin tree failed to load` → **整个 dsh 起不来**。
 *
 * 一个插件的成员起不来，绝不该让宿主下线。所以这里：
 * - 协商类失败（拿不到 agreement、boardDomain 不一致）**照旧抛** —— 那是契约错误；
 * - 启动类失败**降级**并记下原因，由宿主在后续轮次用 `retry()` 重试。
 *
 * 降级的影响面是有限的：成员句柄只服务于**轻量路径**的消息投递；
 * 正式会议室路径的发言走 one-shot 子调用（`voice`），不依赖句柄。
 */
export declare function createAgentFacet(config: AgentFacetConfig): AgentFacetHandle;
//# sourceMappingURL=facet.d.ts.map