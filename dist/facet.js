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
import { defineFacet } from '@dsh-std/sdk';
import { BriefingBoard } from './core/briefing-board.js';
import { DEFAULT_MAX_BRIEFING_CHARS } from './core/briefing-text.js';
import { MeetingCoordinator } from './core/coordinator.js';
import { BRIEFING_BOARD_KIND, MEETING_API_VERSION } from './protocol/meeting-protocol.js';
import { RuntimeUnavailable } from './ports/agent-runtime.js';
/** 本插件协议的坐标，供宿主协商与 `context.protocols.*` 查询。 */
export const PROTOCOL_REFERENCE = { apiVersion: MEETING_API_VERSION, kind: BRIEFING_BOARD_KIND };
/** 协调器与成员 facet 之间的最小注册表：只说"谁在、怎么找到它"。 */
export class MeetingRegistry {
    handles = new Map();
    register(slot, handle) {
        this.handles.set(slot, handle);
    }
    unregister(slot) {
        this.handles.delete(slot);
    }
    get(slot) {
        return this.handles.get(slot);
    }
    slots() {
        return [...this.handles.keys()].sort();
    }
}
export function createCoordinatorFacet(config) {
    let bound;
    let state;
    const support = {
        apiVersion: MEETING_API_VERSION,
        kind: BRIEFING_BOARD_KIND,
        spec: {
            boardDomain: config.boardDomain,
            operations: ['publish', 'read', 'subscribe', 'convene'],
            scopes: ['local', 'global'],
            maxBriefingChars: config.maxBriefingChars ?? DEFAULT_MAX_BRIEFING_CHARS,
            limits: {
                maxAgendaChars: config.maxAgendaChars ?? 1200,
            },
        },
    };
    const facet = defineFacet((context) => {
        const agreement = {
            boardDomain: config.boardDomain,
            coordinator: context.identity.participantId,
            clients: [],
            operations: ['publish', 'read', 'subscribe', 'convene'],
            optionalOperationsSatisfied: [],
            scopes: ['local', 'global'],
            maxBriefingChars: config.maxBriefingChars ?? DEFAULT_MAX_BRIEFING_CHARS,
            maxAgendaChars: config.maxAgendaChars ?? 1200,
            maxParticipants: config.maxParticipants ?? 64,
        };
        const board = new BriefingBoard({
            rootDir: config.rootDir,
            boardDomain: config.boardDomain,
            maxBriefingChars: agreement.maxBriefingChars,
            maxAgendaChars: agreement.maxAgendaChars,
            now: config.now,
        });
        state = { board, registry: new MeetingRegistry() };
        const implementation = {
            agreement,
            publish: (draft) => {
                board.publish(draft);
            },
            briefings: () => board.snapshot().briefings,
            convene: async (call) => {
                const local = bound;
                if (local === undefined)
                    throw new RuntimeUnavailable('协调器尚未绑定运行时。');
                const result = await local.callMeeting(call);
                if (!result.accepted)
                    throw new RuntimeUnavailable(`召集被拒绝：${result.reason}`);
                return result.meeting;
            },
            meetings: () => bound?.meetingHistory ?? [],
        };
        // 暂存实现；lifecycle 在 driver 返回成功且重新协商通过后才发布它
        // （publication barrier）。后激活的成员 facet 因此能在自己的
        // pre-activation 协商里看到这份 support。
        const dispose = context.protocols.implement(support, implementation);
        context.scope.add(dispose);
    }, undefined, () => {
        const local = bound;
        if (local === undefined) {
            return {
                state: 'degraded',
                message: '协调器 facet 已激活但尚未绑定运行时（等待宿主注入 Agent 槽位）。',
            };
        }
        const capabilities = local.capabilities;
        const meetings = local.meetingHistory;
        return {
            state: capabilities.canSpawn && capabilities.canDeliver ? 'active' : 'degraded',
            extensions: [
                {
                    apiVersion: MEETING_API_VERSION,
                    kind: BRIEFING_BOARD_KIND,
                    name: config.boardDomain,
                    status: {
                        port: capabilities.port,
                        canWake: capabilities.canWake,
                        canWaitForActivity: capabilities.canWaitForActivity,
                        hasNativeTaskBoard: capabilities.hasNativeTaskBoard,
                        slots: local.slotIds,
                        currentRound: local.currentRound,
                        meetings: meetings.length,
                        wakeChain: local.wakeGraph(),
                        notes: capabilities.notes,
                    },
                },
            ],
        };
    });
    return {
        role: 'coordinator',
        facet,
        support,
        bind: (coordinator) => {
            bound = coordinator;
        },
        coordinator: () => bound,
        shared: () => state,
    };
}
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
export function createAgentFacet(config) {
    let current;
    let failure;
    const start = async () => {
        const capabilities = config.runtime.capabilities();
        if (!capabilities.canSpawn) {
            throw new RuntimeUnavailable(`运行时 ${capabilities.port} 不具备 spawn 能力。诊断：${capabilities.notes.join(' / ') || '上游未提供说明'}`);
        }
        const handle = await config.runtime.spawn(config.slot);
        current = handle;
        failure = undefined;
        config.shared.registry.register(config.slot.id, handle);
    };
    const facet = defineFacet(async (context) => {
        const negotiated = context.protocols.agreement(PROTOCOL_REFERENCE);
        if (negotiated === undefined) {
            throw new RuntimeUnavailable(`成员 facet ${context.identity.facet} 无法激活：协商范围内没有 ` +
                `${MEETING_API_VERSION}/${BRIEFING_BOARD_KIND} 的 agreement。` +
                '协调器 facet 必须先激活并发布该 support。');
        }
        const agreement = negotiated.agreement;
        if (agreement === undefined) {
            throw new RuntimeUnavailable('agreement 存在但没有载荷，无法确定简报预算。');
        }
        if (agreement.boardDomain !== config.boardDomain) {
            throw new RuntimeUnavailable(`boardDomain 不一致：agreement=${agreement.boardDomain}，facet 配置=${config.boardDomain}。`);
        }
        if (!agreement.operations.includes('publish')) {
            throw new RuntimeUnavailable('协商结果未授予 publish 操作，成员无法提交简报。');
        }
        try {
            await start();
        }
        catch (error) {
            // 不抛：见上面的说明。原因留着给 retry() 与诊断读。
            failure = error instanceof Error ? error.message : String(error);
        }
        // 单条 cleanup 同时撤销注册与回收实例 —— 逆序、幂等由 scope 保证。
        // 即使启动失败也要挂上：retry() 成功之后同一条 cleanup 才能生效。
        context.scope.add(async () => {
            config.shared.registry.unregister(config.slot.id);
            config.shared.onMemberGone?.(config.slot.id);
            const handle = current;
            current = undefined;
            if (handle !== undefined)
                await config.runtime.close(handle);
        });
    }, undefined, () => current !== undefined
        ? { state: 'active' }
        : {
            state: 'degraded',
            message: `领域 Agent ${config.slot.id} 尚未启动` +
                (failure === undefined ? '（尚无活的 Agent 会话可作授权凭据）。' : `：${failure}`),
        });
    return {
        role: 'agent',
        facet,
        handle: () => current,
        lastFailure: () => failure,
        retry: async () => {
            if (current !== undefined)
                return true;
            try {
                await start();
                return true;
            }
            catch (error) {
                failure = error instanceof Error ? error.message : String(error);
                return false;
            }
        },
    };
}
//# sourceMappingURL=facet.js.map