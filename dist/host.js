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
import { ProtocolCatalog } from '@dsh-std/core';
import { compose, CompositionRuleCatalog } from '@dsh-std/composition';
import { ActivationDriverRegistry, FACET_MODULE_API_VERSION, FACET_MODULE_KIND, LifecycleCoordinator, PublicationRegistry, } from '@dsh-std/lifecycle';
import { parseManifest, projectManifest } from '@dsh-std/manifest';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MeetingRegistry, createAgentFacet, createCoordinatorFacet, } from './facet.js';
import { MeetingCoordinator, DEFAULT_COORDINATOR_POLICY } from './core/coordinator.js';
import { RoomRegistry } from './core/room-registry.js';
import { resolveMeetingBoardDomain, resolveMeetingRootDir } from './core/meeting-root.js';
import { MeetingOrchestrator } from './core/room-orchestrator.js';
import { DEFAULT_MAX_BRIEFING_CHARS } from './core/briefing-text.js';
import { BRIEFING_BOARD_KIND, MEETING_API_VERSION, briefingBoardProtocol } from './protocol/meeting-protocol.js';
import { existsSync } from 'node:fs';
import { briefingBoardCompositionRule } from './protocol/meeting-composition-rule.js';
import { MeetingConsole } from './core/console.js';
import { RoomMinutesLog } from './core/room-minutes.js';
import { RuntimeUnavailable } from './ports/agent-runtime.js';
import { createDshMeetingRuntime, readService, resolveLiveAgent } from './adapters/dsh-team-runtime.js';
import { createDshMeetingVoice, createDshModerator, createDshOneShotRunner, } from './adapters/dsh-meeting-voice.js';
import { attachDshBoundaryWatcher } from './adapters/dsh-boundary-watcher.js';
import { attachDshSessionState } from './adapters/dsh-session-state.js';
import { listSessionCandidates, readSessionContext } from './adapters/dsh-session-catalog.js';
import { registerMeetingTool } from './adapters/dsh-meeting-tool.js';
import { registerMeetingRemote } from './adapters/dsh-meeting-remote.js';
import { SessionActivityTracker } from './core/activity-tracker.js';
import { HUMAN_PARTICIPANT } from './core/participant.js';
/** 协调器 facet 的名称（provider）。 */
export const COORDINATOR_FACET = 'coordinator';
/** 成员 facet 的名称前缀（consumer）：`agent-<slotId>`。 */
export const AGENT_FACET_PREFIX = 'agent-';
/** 本插件声明的 activation driver id。 */
export const MEETING_DRIVER_ID = 'dsh-meeting/facet-module';
/**
 * 会话的短标签。
 *
 * 用于"会籍恢复时标题还没探到"的兜底：面板里显示完整 id 认不出，短 id 至少能对上号。
 * 格式与面板的 `shortId` 保持一致，这样两边指的是同一个东西。
 */
function shortSessionLabel(sessionId) {
    return sessionId.length <= 14 ? sessionId : `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
}
function defaultManifestPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/host.js -> 包根；tsx 下 src/host.ts -> 包根
    return join(here, '..', 'dsh-plugin.json');
}
function compareCodeUnit(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
/**
 * 取宿主 logger。
 *
 * ⚠️ 读服务属性**必须包 try/catch**：Cordis 对未在 `inject` 里声明的服务，
 * 属性访问会抛 `cannot get property "X" without inject`（不是返回 undefined）。
 * 而 `ctx.logger` 是 Context 内建的（不属于"需要 inject 的服务"），所以正常能用；
 * 这层兜底只为防它在别的部署形态下变成需要 inject 的服务。
 * 拿不到就退回 `ctx.get('logger')`。
 */
function resolveLogger(ctx) {
    try {
        const direct = ctx.logger;
        if (direct !== undefined && direct !== null)
            return direct;
    }
    catch {
        // 属性访问被 cordis 拒绝：继续走 ctx.get。
    }
    const viaGet = readService(ctx, 'logger');
    return viaGet === undefined || viaGet === null
        ? undefined
        : viaGet;
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
export function selectRoomInvitees(input) {
    const allowed = new Set(input.candidates);
    const chosen = new Set();
    for (const signal of input.signals) {
        for (const slot of signal.slots)
            chosen.add(slot);
    }
    for (const briefing of input.briefings) {
        if (briefing.blocker !== null || briefing.needs.length > 0 || briefing.requestedFrom.length > 0) {
            chosen.add(briefing.slot);
            for (const target of briefing.requestedFrom)
                chosen.add(target);
        }
    }
    return [...chosen].filter((slot) => allowed.has(slot)).sort(compareCodeUnit);
}
/**
 * 选一个"该在哪儿开这场干预会"的会议室。
 *
 * 默认会籍意味着**房间可能一个都没有**，所以升级必须能回答"没有房间时怎么办"。
 * 优先级：含停滞成员的房间（先局部解决）→ 任何有成员的房间 → 无（不升级）。
 */
export function pickEscalationRoom(registry, stalledSlots) {
    const rooms = registry.list().filter((room) => room.members.length > 0);
    const stalled = new Set(stalledSlots);
    const preferred = rooms.find((room) => room.members.some((member) => stalled.has(member.sessionId)));
    const chosen = preferred ?? rooms[0];
    return chosen === undefined ? undefined : { id: chosen.id };
}
/**
 * 用真实的 compose() + LifecycleCoordinator 激活本插件。
 *
 * 关键设计：**provider facet 先于 consumer facet 激活**。
 * 这不是我们手动排序的，而是 `compose()` 的 `facetActivationOrder` 按
 * "provider 先于 consumer"拓扑排序得出的；因此协调器的 support 在成员 facet
 * 做 pre-activation 协商时已经发布，`context.protocols.agreement()` 才拿得到。
 */
export async function activateMeetingHost(options) {
    const manifestPath = options.manifestPath ?? defaultManifestPath();
    const boardDomain = options.boardDomain;
    const maxBriefingChars = options.maxBriefingChars ?? DEFAULT_MAX_BRIEFING_CHARS;
    const maxAgendaChars = options.maxAgendaChars ?? 1200;
    // --- 1. 协议目录：注册我们自己的 definition ---------------------------
    const protocols = new ProtocolCatalog({ name: 'dsh-meeting-coordinator', version: '0.1.0' });
    protocols.register(briefingBoardProtocol);
    // --- 2. manifests：一个 provider + 每个领域方向一个 consumer -----------
    const pluginManifest = parseManifest(readFileSync(manifestPath, 'utf8'), { source: manifestPath });
    const projected = projectManifest(pluginManifest);
    const providerFacet = {
        name: COORDINATOR_FACET,
        activation: {
            apiVersion: FACET_MODULE_API_VERSION,
            kind: FACET_MODULE_KIND,
            spec: { module: pluginManifest.facets.host.entry },
        },
        protocols: {
            supports: [
                {
                    apiVersion: MEETING_API_VERSION,
                    kind: BRIEFING_BOARD_KIND,
                    spec: {
                        boardDomain,
                        operations: ['publish', 'read', 'subscribe', 'convene'],
                        scopes: ['local', 'global'],
                        maxBriefingChars,
                        limits: { maxAgendaChars },
                    },
                },
            ],
        },
    };
    const providerManifest = {
        ...projected,
        spec: { ...projected.spec, facets: [providerFacet] },
    };
    const consumerManifests = options.slots.map((slot) => ({
        apiVersion: projected.apiVersion,
        kind: 'Component',
        metadata: { name: `${projected.metadata.name}.${slot.id}`, version: projected.metadata.version },
        spec: {
            facets: [
                {
                    name: `${AGENT_FACET_PREFIX}${slot.id}`,
                    activation: {
                        apiVersion: FACET_MODULE_API_VERSION,
                        kind: FACET_MODULE_KIND,
                        spec: { module: pluginManifest.facets.host.entry },
                    },
                    protocols: {
                        requires: [{ apiVersion: MEETING_API_VERSION, kind: BRIEFING_BOARD_KIND }],
                    },
                },
            ],
        },
    }));
    const manifests = [providerManifest, ...consumerManifests];
    // --- 3. 组合预检 -------------------------------------------------------
    // 必须注册本协议的组合规则：`compose()` 的 provider→consumer 激活顺序
    // 完全由规则产出的 bindings 推导，只声明 requires/supports 是不够的。
    const rules = new CompositionRuleCatalog();
    rules.register(briefingBoardCompositionRule);
    const plan = compose({
        manifests,
        drivers: [{ id: MEETING_DRIVER_ID, apiVersion: FACET_MODULE_API_VERSION, kind: FACET_MODULE_KIND }],
        protocols,
        select: [
            { component: providerManifest.metadata.name, facet: COORDINATOR_FACET, required: true },
            ...options.slots.map((slot) => ({
                component: `${providerManifest.metadata.name}.${slot.id}`,
                facet: `${AGENT_FACET_PREFIX}${slot.id}`,
                required: true,
            })),
        ],
    }, rules);
    if (!plan.compatible) {
        const errors = plan.issues.filter((issue) => issue.severity === 'error');
        throw new RuntimeUnavailable(`组合预检未通过：${errors.map((issue) => `${issue.code}@${issue.path}: ${issue.message}`).join('; ')}`);
    }
    const unexpectedSkips = plan.skipped.filter((row) => row.code === 'activation-unavailable');
    if (unexpectedSkips.length > 0) {
        throw new RuntimeUnavailable(`以下 facet 因缺少 activation driver 被跳过：${unexpectedSkips.map((row) => row.message).join('; ')}`);
    }
    // --- 4. facet 与 driver -------------------------------------------------
    let shared;
    const coordinatorFacet = createCoordinatorFacet({
        boardDomain,
        rootDir: options.rootDir,
        maxBriefingChars,
        maxAgendaChars,
        now: options.now,
    });
    const agentFacets = options.slots.map((slot) => createAgentFacet({
        boardDomain,
        rootDir: options.rootDir,
        slot,
        runtime: options.runtime,
        // 占位：真正的 shared 在 coordinator facet 激活后才有值；
        // 由于协调器先激活，成员 facet 激活时它一定已就绪。
        get shared() {
            if (shared === undefined) {
                throw new RuntimeUnavailable('协调器 facet 尚未激活，成员 facet 无法取得共享简报板。');
            }
            return shared;
        },
        now: options.now,
    }));
    const agentsByFacet = new Map(options.slots.map((slot, index) => [`${AGENT_FACET_PREFIX}${slot.id}`, agentFacets[index]]));
    const drivers = new ActivationDriverRegistry();
    const driver = {
        id: MEETING_DRIVER_ID,
        apiVersion: FACET_MODULE_API_VERSION,
        kind: FACET_MODULE_KIND,
        async activate(request) {
            const name = request.selected.facet.name;
            if (name === COORDINATOR_FACET) {
                await coordinatorFacet.facet.activate(request.context);
                shared = coordinatorFacet.shared();
                if (shared === undefined)
                    throw new RuntimeUnavailable('协调器 facet 激活后没有产出共享状态。');
                return;
            }
            const agent = agentsByFacet.get(name);
            if (agent === undefined) {
                throw new RuntimeUnavailable(`未知的 facet ${name}；driver 只认识 ${COORDINATOR_FACET} 与 ${AGENT_FACET_PREFIX}<slot>。`);
            }
            await agent.facet.activate(request.context);
        },
    };
    drivers.register(driver);
    // --- 5. 真实生命周期激活 ----------------------------------------------
    const lifecycle = new LifecycleCoordinator(protocols, drivers, new PublicationRegistry());
    let coordinator;
    options.onPlan?.(plan);
    try {
        const handles = await lifecycle.activate(plan);
        if (shared === undefined)
            throw new RuntimeUnavailable('激活完成但没有共享状态。');
        // 协调器认领由成员 facet 启动的句柄 —— 启动是 facet 的职责，协调器只做召集。
        //
        // 注意：**认领不到不是错误**。插件在 dsh 启动时加载，那一刻可能还没有任何
        // 活的 Agent 会话，成员 facet 会降级（详见 `createAgentFacet`）。
        // 槽位规格已经由构造函数登记，所以简报板、停滞检测、甚至会议室发言
        // （走 one-shot 子调用，不经句柄）都不受影响；受影响的只有"投递摘要到该成员"。
        coordinator = new MeetingCoordinator({
            board: shared.board,
            runtime: options.runtime,
            slots: options.slots,
            policy: options.policy ?? DEFAULT_COORDINATOR_POLICY,
            now: options.now,
        });
        for (const slot of options.slots) {
            const handle = shared.registry.get(slot.id);
            if (handle === undefined)
                continue;
            coordinator.adopt(handle);
        }
        coordinatorFacet.bind(coordinator); // 成员 facet 卸载时同步缩编协调器名册。
        shared.onMemberGone = (slot) => {
            coordinator?.forget(slot);
        };
        // --- 正式路径：会议室（会籍 + 多轮会议）---------------------------------
        //
        // ⚠️ 这里**刻意什么都不做**：不建房间、不拉人入会。
        //
        // 会籍是权限边界，而"默认满员"会让这条边界从第一天就失效——
        // 上一版就是这么写的：`createRoom` + 对每个 slot `joinRoom`，
        // 于是每个会话一装上就莫名有了会议室、有了义务，还会自动开会。
        //
        // 正确的形态是：**房间由人在面板上建、成员由人把非活动会话加进来**，
        // 默认状态是"没有任何房间、没有任何会籍"。见 `MeetingConsole`。
        const roomId = options.roomId ?? boardDomain;
        const rooms = new RoomRegistry({ rootDir: options.rootDir, now: options.now });
        const orchestrator = new MeetingOrchestrator({
            registry: rooms,
            voice: options.voice,
            moderator: options.moderator,
            roomPolicy: options.roomPolicy,
            minutesMaxChars: options.minutesMaxChars,
            minutes: options.minutes,
            // B 路线的"借上下文"：成员发言前现读它真实会话的末尾若干条消息。
            // 不给就退回"没有私有上下文"，行为与旧版一致。
            ...(options.contextOf === undefined ? {} : { contextOf: options.contextOf }),
            // **外部停会**：读 stop.flag 文件。UI 里没有暂停按钮时，
            // 任何会话都能写这个文件（或调工具 action=stop）来叫停当前这场会。
            stopRequested: () => existsSync(join(options.rootDir, 'stop.flag')),
            // **fork 那个人过来**：由调用方解析成员的上游 Agent 对象（`ctx.agents.get()`），
            // 让发言走 `fork` provider —— 那个人的完整上下文被 seed 进子会话。
            ...(options.agentOf === undefined ? {} : { agentOf: options.agentOf }),
            ...(options.resumeWork === undefined ? {} : { resumeWork: options.resumeWork }),
            now: options.now,
        });
        for (const slot of options.slots) {
            if (!orchestrator.participantIds.includes(slot.id)) {
                orchestrator.enroll({
                    id: slot.id,
                    domain: slot.domain,
                    title: slot.title,
                    systemPrompt: slot.systemPrompt,
                    workspace: slot.workspace,
                    model: slot.model,
                });
            }
            // 注意：**不再** `joinRoom`。预声明的槽位只是"登记在册"，
            // 要成为某个房间的成员仍需显式加入。
        }
        /**
         * 把**持久化会籍**里的成员补进编排器名册（幂等）。
         *
         * 为什么必须有这一步：`rooms.jsonl` 持久化了房间与成员，但
         * `MeetingOrchestrator.members` 是**纯内存**的。重启后房间还在、成员还在，
         * 编排器名册却是空的 —— 而 `convene()` 的候选范围是
         * `room.members.filter(id => this.members.has(id))`，于是算出"没有可召集的成员"。
         *
         * 用户看到的正是这个：**重启后必须先删掉成员再加回来，才能开会**。
         *
         * 顺带补"入会即空闲"，与面板加人走同一套语义。标题随候选列表补齐：
         * 刚启动时候选缓存可能还没预热，先用短 id 兜底，之后每次调用再补。
         */
        const ensureRoster = () => {
            const titles = new Map();
            for (const candidate of options.candidates?.list() ?? []) {
                if (candidate.title !== undefined)
                    titles.set(candidate.sessionId, candidate.title);
            }
            for (const room of rooms.list()) {
                for (const member of room.members) {
                    const title = titles.get(member.sessionId);
                    if (orchestrator.participantIds.includes(member.sessionId)) {
                        // 已在册：只补标题（建名册时可能还没探到）。
                        if (title !== undefined)
                            orchestrator.member(member.sessionId).retitle(title);
                        continue;
                    }
                    orchestrator.enroll({
                        id: member.sessionId,
                        // 成员是用户的**真实会话**，没有"领域"这个概念。
                        // 这里用工作区兜住——它只进会议内部提示，不参与任何判据。
                        domain: member.workspace,
                        title: title ?? shortSessionLabel(member.sessionId),
                        systemPrompt: '',
                        workspace: member.workspace,
                        ...(member.model === undefined ? {} : { model: member.model }),
                    });
                    // 与 `enroll` 端口同一约定：入会那一刻该会话必然非活动（见 `core/membership.ts`），
                    // 所以直接补一笔空闲，别让它卡在状态机的初始值 `working` 上。
                    const participant = orchestrator.member(member.sessionId);
                    if (participant.state === 'working')
                        participant.beginIdleWaiting();
                }
            }
        };
        // 启动就补一次，让面板第一眼就能看到成员与状态。
        ensureRoster();
        const console = new MeetingConsole({
            registry: rooms,
            minutes: options.minutes ?? new RoomMinutesLog({ rootDir: options.rootDir, now: options.now }),
            candidates: options.candidates ?? { list: () => [] },
            runtime: {
                convene: (call) => {
                    // 召集前再补一次名册：成员可能是重启后从 `rooms.jsonl` 恢复的，
                    // 而编排器名册是纯内存的。这一次也顺便把标题补齐（候选缓存此时已预热）。
                    ensureRoster();
                    return orchestrator.convene(call);
                },
                activeRoom: () => (orchestrator.activeRoom() === undefined ? undefined : { id: orchestrator.activeRoom()?.id ?? roomId }),
                // 实时会议视图：会议进行中每次调用重算，面板轮询拿到多新取决于问得多勤。
                activeMeeting: () => orchestrator.activeMeeting(),
                enroll: (spec) => {
                    if (orchestrator.participantIds.includes(spec.id))
                        return;
                    orchestrator.enroll({
                        id: spec.id,
                        domain: spec.domain,
                        title: spec.title,
                        // 真实会话有自己的系统提示词，我们**不**再塞一份——
                        // 成员元数据只用于会议内部提示与模型选择。
                        systemPrompt: '',
                        ...(spec.workspace === undefined ? {} : { workspace: spec.workspace }),
                        ...(spec.model === undefined ? {} : { model: spec.model }),
                    });
                    // 补一笔"入会即空闲"。
                    //
                    // 依据是一个**已经成立的不变量**：准入策略要求入会那一刻该会话**非活动**
                    // （见 `core/membership.ts`）。所以它此刻必然是空闲的。
                    //
                    // 不补这一笔的后果很具体：成员会停在状态机的初始值 `working`，
                    // 一直等到它**下一次** `turn/end` 才会转空闲 —— 而"下一次"可能是几分钟后，
                    // 也可能要等用户去那个会话里再说一句话。表现出来就是
                    // "我刚把人加进去，就告诉我全员在工作中，开不了会"。
                    const member = orchestrator.member(spec.id);
                    if (member.state === 'working')
                        member.beginIdleWaiting();
                },
                forget: (sessionId) => orchestrator.forget(sessionId),
                stateOf: (sessionId) => {
                    try {
                        return orchestrator.member(sessionId).state;
                    }
                    catch {
                        return undefined;
                    }
                },
            },
            now: options.now,
        });
        const local = coordinator;
        /**
         * 重试启动尚未起来的成员。
         *
         * 成员 facet 在激活期尝试 spawn，失败就降级（最常见原因：dsh 刚启动，
         * 还没有任何活的 Agent 会话可以充当上游授权凭据）。
         * 这里让宿主在后续轮次里把它们补起来 —— 用户开了会话之后就该成功。
         */
        const retryMembers = async () => {
            // 闭包里 TS 不再收窄 `shared`，这里显式再判一次（激活成功时必非空）。
            const state = shared;
            if (state === undefined)
                return [];
            const recovered = [];
            for (const slot of options.slots) {
                if (state.registry.get(slot.id) !== undefined)
                    continue;
                const facet = agentsByFacet.get(`${AGENT_FACET_PREFIX}${slot.id}`);
                if (facet === undefined)
                    continue;
                if (!(await facet.retry()))
                    continue;
                const handle = state.registry.get(slot.id);
                if (handle === undefined)
                    continue;
                local.adopt(handle);
                recovered.push(slot.id);
            }
            // 新成员的会话 id 在 spawn 之前不存在，所以必须在这之后重探一次映射。
            if (recovered.length > 0)
                await options.onMembersSpawned?.();
            return recovered;
        };
        /**
         * 把一次触发评估升级成正式会议室。
         *
         * `calledBy` 用人类席位而不是某个成员，理由是刻意的：
         * 这是**外部干预**（停滞由外部计算，不依赖 Agent 自述），
         * 借用某个成员的身份会同时污染两件事——
         * 主持人会拿到那个成员的模型（`callerModel`），
         * 以及审计里会记成"是它召集的"，而它并没有。
         */
        const escalate = async (evaluation) => {
            // 自动升级也是一次"召集"，同样要先补齐名册（见 `ensureRoster`）。
            ensureRoster();
            const signals = evaluation.stallSignals.map((signal) => `${signal.kind}：${signal.detail}`);
            const withDiagnostics = (reason) => {
                const extra = options.extraDiagnostics?.() ?? [];
                return extra.length === 0 ? reason : `${reason}\n诊断：${extra.join(' ')}`;
            };
            if (evaluation.stallSignals.length === 0) {
                return { escalated: false, reason: '本轮没有停滞信号，无需升级到正式会议室。', signals };
            }
            if (orchestrator.activeRoom() !== undefined) {
                return { escalated: false, reason: '已有一场会议在进行中；一次只主持一场。', signals };
            }
            // 默认会籍意味着房间可能一个都没有。没有可开的房间不是异常，是一个正常分支。
            const target = pickEscalationRoom(rooms, evaluation.stallSignals.flatMap((signal) => [...signal.slots]));
            if (target === undefined) {
                return {
                    escalated: false,
                    reason: '还没有任何"有成员的会议室"，无从升级。请先在面板上建一个会议室并加入会话。',
                    signals,
                };
            }
            const candidates = orchestrator.participantIds.filter((id) => local.slotIds.includes(id));
            const invitees = selectRoomInvitees({
                signals: evaluation.stallSignals,
                briefings: local.latestBriefings(),
                candidates,
            });
            const reason = evaluation.stallSignals[0]?.detail ?? '检测到停滞，由外部发起干预会议。';
            try {
                const record = await orchestrator.convene({
                    roomId: target.id,
                    calledBy: HUMAN_PARTICIPANT,
                    scope: invitees.length === 0 ? 'global' : 'local',
                    reason,
                    ...(invitees.length === 0 ? {} : { invitees }),
                });
                return {
                    escalated: true,
                    reason: `停滞升级成立（${invitees.length === 0 ? '大会' : `小会：${invitees.join('、')}`}）；` +
                        `在场 ${record.summoned.length} 人，${record.rounds} 轮，` +
                        `每人纪要 ${record.notes.length} 份，散会原因：${record.adjournedReason}`,
                    record,
                    signals,
                };
            }
            catch (error) {
                // 全员在工作中、没有可召集成员……都是运行期的正常分支。
                // 升级失败绝不能变成异常从定时器里抛出去。
                return {
                    escalated: false,
                    reason: withDiagnostics(`升级未成立：${error instanceof Error ? error.message : String(error)}`),
                    signals,
                };
            }
        };
        return {
            plan,
            coordinator: local,
            rooms,
            orchestrator,
            console,
            defaultRoomId: roomId,
            lifecycle,
            activated: handles.map((handle) => handle.identity.participantId),
            // 用 getter 而不是快照：retryMembers() 补起成员之后它必须立刻变空，
            // 否则诊断信息会撒谎（这正是"看起来像插件坏了"的来源）。
            get pendingMembers() {
                const state = shared;
                if (state === undefined)
                    return options.slots.map((slot) => slot.id);
                return options.slots
                    .filter((slot) => state.registry.get(slot.id) === undefined)
                    .map((slot) => slot.id);
            },
            tick: () => local.tick(),
            escalate,
            retryMembers,
            pulse: async () => {
                // 每轮先补起还没起来的成员：插件加载时可能还没有活的 Agent 会话，
                // 用户开了会话之后就该成功。这一步不该让整轮失败。
                await retryMembers().catch(() => []);
                // 触发评估**只跑一次**，并复用它的结果决定是否升级。
                // 不能让 escalate 自己再评估一次：evaluateTriggers 依赖 lastMeetingAt /
                // lastMeetingRound，跑两遍会把节流状态推乱。
                const light = await local.tick();
                return { light, escalation: await escalate(light.evaluation) };
            },
            callMeeting: (call) => local.callMeeting(call),
            shutdown: async () => {
                // 先让会议室散会（若有会议在进行），再逆序卸载 facet。
                // 顺序很重要：facet 回收会关闭成员句柄，若有会议还挂着就会读到失效句柄。
                if (orchestrator.activeRoom() !== undefined) {
                    for (const id of orchestrator.participantIds) {
                        const member = orchestrator.member(id);
                        if (member.isInMeeting() || member.isAwaitingEntry())
                            member.dismiss();
                    }
                }
                for (const handle of [...handles].reverse()) {
                    await handle.deactivate('meeting host shutting down');
                }
            },
        };
    }
    catch (error) {
        throw new RuntimeUnavailable(`facet 激活失败，已由 lifecycle 回滚：${error instanceof Error ? error.message : String(error)}`);
    }
}
/** 渲染给成员看的标准简报指令，随 spawn 提示词一起送进去。 */
export function renderBriefingInstruction(maxChars) {
    return [
        '## 简报契约',
        `每完成一轮工作，提交一份不超过 ${maxChars} 字的简报，必须包含三部分：`,
        '1. 当前状态（一句话，你做到了哪一步）',
        '2. 障碍（卡在哪里；没有就写"无"）',
        '3. 需要的输入（需要谁给你什么；没有就写"无"）',
        '',
        '硬规则：',
        '- 超过字数上限会被**拒绝**，不会自动截断；请自己压缩。',
        '- 反复尝试同类操作失败、或长时间没有实质进展时，**主动提交简报说明卡在哪里**。',
        '- 收到 `[meeting-digest]` 表示例会已汇总全体成员的最新简报，请据此调整下一步。',
        '- 你可以主动召集同伴开会（小会=只叫相关的人，大会=全体）。',
        '- 你看不到别人的上下文，别人也看不到你的；简报是唯一的共享通道。',
    ].join('\n');
}
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
export function readSlotsFromEnv(env) {
    const raw = env['DSH_MEETING_SLOTS'];
    if (raw === undefined || raw.trim().length === 0)
        return [];
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new RuntimeUnavailable(`DSH_MEETING_SLOTS 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed)) {
        throw new RuntimeUnavailable('DSH_MEETING_SLOTS 必须是 JSON 数组（元素为 { id, domain, title, systemPrompt }）。');
    }
    return parsed.map((item, index) => {
        if (typeof item !== 'object' || item === null) {
            throw new RuntimeUnavailable(`DSH_MEETING_SLOTS[${index}] 不是对象。`);
        }
        const record = item;
        for (const key of ['id', 'domain', 'title', 'systemPrompt']) {
            if (typeof record[key] !== 'string' || record[key].length === 0) {
                throw new RuntimeUnavailable(`DSH_MEETING_SLOTS[${index}].${key} 必须是非空字符串。`);
            }
        }
        return record;
    });
}
/**
 * Cordis 插件入口。
 *
 * 装配顺序：探测上游运行时能力 → 用真实的 compose/lifecycle 激活 facet →
 * 注册定时驱动（通过 `ctx` 的生命周期，不自己持有裸定时器）。
 */
export async function apply(ctx, config = {}) {
    // 槽位是**可选**的（预声明的领域成员）。默认没有成员、没有房间——
    // 那是正确的初始状态，不是配置错误。
    const slots = config.slots ?? readSlotsFromEnv(process.env);
    // ⚠️ 默认值**绝不能**是 `join(process.cwd(), ...)`：DSH 进程的 cwd 由
    // "用户从哪敲下的 dsh web"决定，与会话、工作区都无关，于是数据根会
    // 悄悄落到一个无关目录里（2026-09-23 实测踩过：房间全丢，且无任何报错）。
    // 解析规则与理由集中在 `core/meeting-root.ts`，三个入口共用同一份。
    const rootDir = resolveMeetingRootDir(config.rootDir, process.env);
    const boardDomain = resolveMeetingBoardDomain(config.boardDomain, process.env);
    const resolveCaller = () => {
        // 上游要求 **exact live Agent**（同一个对象引用）作为授权凭据：
        // `agentTeams` 的 `tryMembership` 第一条判据就是 `ctx.agents.get(agent.id) === agent`。
        //
        // 所以绝不能把 `ctx.get('agents')` 这个**服务对象**直接传下去 ——
        // 实测会得到 `agent "undefined" is not a member of an active Agent Team`
        // （上游读 `agent.id`，服务对象没有 id），而且那个错会以
        // "plugin tree failed to load" 的形式把整个 dsh 带下线。
        const agent = resolveLiveAgent(ctx);
        if (agent === undefined) {
            throw new RuntimeUnavailable('还没有任何活的 Agent 会话可以充当授权凭据。' +
                '这在 dsh 刚启动、用户尚未开启任何会话时是正常状态，' +
                '成员会在后续轮次由 retryMembers() 补起。');
        }
        return agent;
    };
    const runtime = createDshMeetingRuntime({
        ctx,
        resolveCaller,
        // 后端默认交给运行时**探测**决定（`preferredBackend` 可显式固化）。
        //
        // 为什么不在这里写死 `subagents`：写死会让"旧模型测试"（断言成员在激活期
        // 被 spawn 出来）整批变红，而那些断言正是下一轮要清理的遗留路径。
        // 真实 profile 里 `agentTeams` 已经不在 bundle 列表里，所以探测结果**必然**
        // 是 subagents —— 也就是新版模型要的那条：发言借会话自己的上下文与基模型。
        ...(config.preferredBackend === undefined ? {} : { preferred: config.preferredBackend }),
    });
    // ⚠️⚠️ 下面两道门**刻意不再是致命门**。这是被真实 boot 打出来的教训。⚠️⚠️
    //
    // 上一版它们在 `apply()` 期 `throw`，代价是**整个 dsh 起不来**：
    //
    //   dsh: plugin tree failed to load: failed to apply loader entry
    //   dsh-meeting-coordinator: DSH 模型调用通道不可用……
    //   诊断：ctx.subagents 未注册 provider "spawn"（当前：(无)）
    //
    // 根因是**时序**，不是配置错误：插件加载的那一刻，上游的 subagent provider
    // 还没注册完成。用"加载期探测"去判定一件"调用期才发生的事"，本来就是错的判据。
    //
    // 而新模型下 boot 期根本不需要模型通道：默认没有房间、没有成员、没有节律，
    // 一次模型调用都不会发生。真正需要它的时刻是"有人开会"——
    // 所以判据落在那时：`convene()` 会把失败理由如实回给调用者，**不假装开成了会**；
    // 这里只把缺陷记成诊断，让"为什么开不起来"当场可读。
    // 模型调用：成员发言 / 会后纪要 / 主持人控场都走同一条 one-shot 通道。
    const runner = createDshOneShotRunner({
        ctx,
        resolveCaller,
        ...(config.voiceProvider === undefined ? {} : { provider: config.voiceProvider }),
        ...(config.voiceTimeoutMs === undefined ? {} : { callTimeoutMs: config.voiceTimeoutMs }),
    });
    const voice = createDshMeetingVoice(runner);
    const moderator = createDshModerator(runner);
    /**
     * 当下的能力缺口。**每次调用重新探测**，不缓存。
     *
     * `runtime.capabilities()` 与 `runner.capabilities()` 都是惰性的（重新读服务），
     * 所以"现在没有"只是"现在"的结论。这一点很要紧：
     *
     * `spawn` provider 由 `dsh-base` 的 `subagent-spawn-in-process` 注册，
     * 而本插件是 profile 的**最后一层**、与它**并行**加载 —— boot 那一刻探到
     * `ctx.subagents 未注册 provider "spawn"（当前：(无)）` 是**真的事实**，
     * 但到用户真正开会时它早就注册好了。
     *
     * 所以措辞必须与事实对齐：这里是"当下探测"，不是"终局判定"。
     */
    const runtimeGap = () => {
        const caps = runtime.capabilities();
        if (caps.canSpawn && caps.canDeliver)
            return [];
        return [
            `运行时不具备例会所需的全部能力（canSpawn=${String(caps.canSpawn)}, ` +
                `canDeliver=${String(caps.canDeliver)}）。诊断：${caps.notes.join(' / ') || '上游未提供说明'}`,
        ];
    };
    const voiceGap = () => {
        const probe = runner.capabilities();
        if (probe.available)
            return [];
        return [
            `模型调用通道不可用（现在开会会失败，但面板与工具仍可用）：${probe.notes.join(' / ') || '上游未提供说明'}`,
        ];
    };
    /**
     * **加载期**的能力快照，只写进 `startup.jsonl` 供事后对照。
     *
     * ⚠️ 它不代表终局 —— 见 `runtimeGap()` 的说明。真正的判据在
     * `extraDiagnostics()`（升级失败时重探）和 `convene()`（失败即如实报错）。
     */
    const gapsAtLoad = [...runtimeGap(), ...voiceGap()];
    /**
     * 上游会话 id → 成员 id。
     *
     * ## 判据是**实时名册**，不是静态配置
     *
     * 这里曾经只认 `config.slots` 声明过的槽位 id。那在新版模型下是**错的**：
     * 成员现在是**用户在面板上加进来的真实会话**，它们不在任何配置里。
     * 后果是事件到了也归属不到成员 —— 没人转空闲 → 全员停在初始的 `working` →
     * `convene()` 永远报「全部 N 位成员都在工作中」。
     * （真实症状：4 个会话明明都跑完了，会议室还坚持说它们在工作中。）
     *
     * 所以改成问**编排器的实时名册**：名字在册，就认它自己。
     * 名册会随入会/退出变化，所以必须是函数、不能是快照。
     *
     * 优先级：
     * 1. 配置里的显式映射（`config.memberSessions`）——把会话 id 指到**另一个**成员 id 的场景；
     * 2. 在册的会话 id 本身；
     * 3. 都不是 → undefined，表示"这不是受管成员"（候选列表里的其它会话就属于这类）。
     */
    const sessionIndex = new Map();
    for (const [sessionId, memberId] of Object.entries(config.memberSessions ?? {})) {
        sessionIndex.set(sessionId, memberId);
    }
    // 由 `activateMeetingHost` 建好名册后回填（避免这里的声明顺序问题）。
    let rosterOf = () => [];
    const resolveMemberId = (sessionId) => {
        const roster = rosterOf();
        const mapped = sessionIndex.get(sessionId);
        if (mapped !== undefined)
            return roster.includes(mapped) ? mapped : undefined;
        return roster.includes(sessionId) ? sessionId : undefined;
    };
    /**
     * 诊断：把"为什么开不起来会"直接说出来。
     *
     * 没有这层，最常见的生产故障（会话 id 没映射上 → 没人转空闲 → 升级永远
     * 报"全部成员都在工作中"）看起来会像插件没生效，排查要从读源码开始。
     */
    let sessionSink;
    const unmappedSessions = new Set();
    /**
     * 探测失败的原因。用 `Set` 而不是数组：这个诊断每轮都会被读一次，
     * 累加的数组会让诊断文本每次都变（同一个错误重复出现），
     * 既刷屏、又让"结论变化才报告"的去重完全失效。
     */
    const discoveryErrors = new Set();
    /**
     * 激活后填上，供诊断读取"哪些成员还没起来"。
     * 用持有变量而不是直接闭包引用 `host`：`extraDiagnostics` 要在 `host` 之前交给宿主，
     * 而它只在升级失败时才被调用（那时 `host` 必然已就绪）。
     */
    let hostRef;
    /**
     * 成员会话重探的间接引用。
     *
     * `activateMeetingHost` 要拿到它（成员补起后立刻重探会话），但它依赖
     * 在 host 之后才定义的 `refreshMemberSessions`。用持有变量 + 惰性调用绕开这个
     * 先有鸡后有蛋：传进去的是闭包，真正被调用时实现已经填好。
     */
    let refreshSessions = async () => undefined;
    const extraDiagnostics = () => {
        const notes = [];
        // 能力缺口：**当下重探**而不是复用加载期快照 ——
        // 加载时探到的"provider 还没注册"到这时候通常早就不成立了（时序问题）。
        notes.push(...runtimeGap(), ...voiceGap());
        const pending = hostRef?.pendingMembers ?? [];
        if (pending.length > 0) {
            notes.push(`成员 ${pending.join('、')} 尚未启动：启动成员需要上游的**活 Agent** 作授权凭据，` +
                'dsh 刚启动、用户还没开任何会话时会失败。这些成员无法接收摘要投递；' +
                'pulse() 每轮会自动重试。');
        }
        for (const observation of sessionSink?.observations ?? []) {
            if (observation.memberId === undefined)
                unmappedSessions.add(observation.sessionId);
        }
        if (unmappedSessions.size > 0) {
            notes.push(`观察到 ${unmappedSessions.size} 个未映射的上游会话 id（例如 ${[...unmappedSessions].slice(0, 3).join('、')}）：` +
                '它们的活动与边界都不会归属到任何成员。请用 config.memberSessions 显式映射，' +
                '或确认上游 agentTeams.listMembers 能看到这些成员（那会自动建立映射）。');
        }
        if (sessionIndex.size === 0) {
            notes.push('当前没有任何"会话 → 成员"映射：成员状态只能靠上游事件驱动，而事件也归属不到成员。' +
                '真实 DSH 环境下这一定需要 config.memberSessions 或 agentTeams.listMembers。');
        }
        if (discoveryErrors.size > 0) {
            notes.push(`成员会话探测失败：${[...discoveryErrors].slice(0, 2).join('；')}`);
        }
        return notes;
    };
    // 候选会话与"忙/闲"判据。默认会籍要求能列出"哪些会话可以加进来"，
    // 而入会必须挑它非活动的时点（往正在跑的 Agent 里装工具有扰动风险）。
    const activity = new SessionActivityTracker();
    /**
     * 持久化会话列表的**旁路缓存**（stale-while-revalidate）。
     *
     * ## 为什么需要它
     *
     * `ctx.sessions.list()` 只给**已加载**的会话 —— 用户没点开过的会话根本不在里面。
     * 所以面板的候选列表原先只显示"你点过的那几个"，用户得先把每个会话点开一遍
     * 才能把它们加进会议室。全量列表在 `sessionController.list()`（侧栏用的就是它）。
     *
     * ## 为什么是缓存而不是直接 await
     *
     * 那个接口是**异步**的，而候选列表接口是**同步**的（console / 工具 / 面板端点
     * 都按同步设计，改异步会牵连一大片）。所以：读的时候返回缓存，同时后台刷新一次。
     * 首次读可能是空的（还没刷到），预热调用 + 1.5 秒 TTL 让这件事基本看不见。
     *
     * 刷新失败**不抛**：继续用上一版缓存，并在诊断里记一笔。
     */
    const PERSISTED_TTL_MS = 1500;
    const persisted = { rows: [], at: 0 };
    let persistedRefreshing = false;
    const refreshPersistedSessions = () => {
        if (persistedRefreshing)
            return;
        const controller = readService(ctx, 'sessionController');
        if (controller === undefined || typeof controller.list !== 'function')
            return;
        const list = controller.list.bind(controller);
        persistedRefreshing = true;
        void Promise.resolve()
            .then(() => list({}, new AbortController().signal))
            .then((value) => {
            const items = value?.items;
            if (Array.isArray(items)) {
                persisted.rows = items;
                persisted.at = Date.now();
            }
        })
            .catch((error) => {
            discoveryErrors.add(`会话列表读取失败：${error instanceof Error ? error.message : String(error)}`);
        })
            .finally(() => {
            persistedRefreshing = false;
        });
    };
    const persistedRows = () => {
        if (Date.now() - persisted.at > PERSISTED_TTL_MS)
            refreshPersistedSessions();
        return persisted.rows;
    };
    // 预热：让面板第一次打开时缓存就是热的。
    refreshPersistedSessions();
    const candidates = {
        list: () => listSessionCandidates({
            ctx,
            activity,
            persisted: persistedRows,
            // ⚠️ 这里**不要**再写 `titleOf: (sessionId) => sessionId`。
            //
            // 曾经就是这一行把 id 当成了标题，于是面板里所有会话都显示成
            // `session-750e30ff-0fe5-…` —— 人能看，但认不出是哪个会话。
            // 标题的真来源是 Cordis 服务 `sessionTitle`（`session/title` 事件的
            // latest-wins 折叠），会话还没起过标题时按首条人类消息派生。
            // 这些都内置在 `readSessionTitle()` 里；`titleOf` 只留给**要覆盖**它的场景。
        }),
    };
    const minutes = new RoomMinutesLog({ rootDir });
    const host = await activateMeetingHost({
        slots,
        runtime,
        voice,
        moderator,
        boardDomain,
        rootDir,
        extraDiagnostics,
        onMembersSpawned: () => refreshSessions(),
        minutes,
        candidates,
        activity,
        // B 路线的"借上下文"：成员发言前，读它**自己那个真实会话**的末尾若干条
        // 消息，拼进发言 prompt。读不到（会话没加载、上游抛错）就退回
        // "没有私有上下文"——`readSessionContext` 与编排器两侧都保证不伪造。
        //
        // 为什么在 host 层而不是 adapters 层接：core 不许 import adapters
        // （依赖方向是 core ← adapters），所以由宿主把函数喂进编排器。
        contextOf: (sessionId, maxChars) => readSessionContext({ ctx, sessionId, maxChars }),
        ...(config.minutesMaxChars === undefined ? {} : { minutesMaxChars: config.minutesMaxChars }),
        // **fork 那个人过来**：解析成员的上游 Agent 对象，让发言走 `fork` provider。
        // fork 的原生语义是"把 parent 已完成的对话轮次 seed 进子会话"，
        // 于是进会场的那个人**带着自己的完整上下文**——这才是"掏过来当作我的上下文注入"。
        agentOf: (sessionId) => {
            const agents = readService(ctx, 'agents');
            if (agents === undefined || typeof agents.get !== 'function')
                return undefined;
            try {
                return agents.get(sessionId);
            }
            catch {
                return undefined;
            }
        },
        // **会后回到工作区**：把纪要当作一条用户输入塞进那个会话的 inbox。
        // 它就像收到用户消息一样继续干活（idle 的会话会因此起一个新回合）。
        resumeWork: (sessionId, text) => {
            const agents = readService(ctx, 'agents');
            const agent = agents?.get?.(sessionId);
            const inbox = agent?.inbox;
            if (inbox === undefined || typeof inbox.append !== 'function')
                return;
            // `UserMessage` 必须带 `id` 与 `source`（`Message` 基类强制），
            // 手动补齐而不是 import 上游的 createUserMessage —— 本仓库对上游零依赖。
            inbox.append('nextTurn', {
                id: `meeting-resume-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
            });
        },
        ...(config.everyHours === undefined && config.everyRounds === undefined && config.staleRounds === undefined
            ? {}
            : {
                policy: {
                    ...DEFAULT_COORDINATOR_POLICY,
                    ...(config.everyHours === undefined ? {} : { everyMs: config.everyHours * 60 * 60 * 1000 }),
                    ...(config.everyRounds === undefined ? {} : { everyRounds: config.everyRounds }),
                    ...(config.staleRounds === undefined ? {} : { staleRounds: config.staleRounds }),
                },
            }),
    });
    hostRef = host;
    // 名册回填：会话 id → 成员 id 的判据是"它在不在册"。
    // 名册由编排器持有、且随入会/退出变化，所以给的是**取函数**而不是快照 ——
    // 快照会在用户加人之后立刻过期，那正是"全员卡在 working"那个 bug 的同类形态。
    rosterOf = () => host.orchestrator.participantIds;
    // 成员会话映射：先配置、后探测。
    // 成员是在 facet 激活期 spawn 的，所以必须在 host 建好之后才探测得到。
    // 探测用 teammate name 对齐 `agentTeams.listMembers`，拿到的是权威的会话 id——
    // 上游 `session/event` 带的是这种 UUID，不是我们的 slot id。
    const refreshMemberSessions = async () => {
        if (typeof runtime.memberSessions !== 'function')
            return;
        try {
            for (const { slot, sessionId } of await runtime.memberSessions()) {
                if (sessionId.length > 0 && resolveMemberId(slot) !== undefined)
                    sessionIndex.set(sessionId, slot);
            }
        }
        catch (error) {
            discoveryErrors.add(error instanceof Error ? error.message : String(error));
        }
    };
    refreshSessions = refreshMemberSessions;
    await refreshMemberSessions();
    // 等边界入场：把上游会话事件接到编排器。
    // 需求要求"正在调用工具的会话，在调用结束后进入会议室"，`step/end` 正是那个边界。
    const watcher = attachDshBoundaryWatcher({
        ctx,
        boundary: config.entryBoundary ?? 'step-end',
        resolveMemberId,
        onBoundary: ({ memberId }) => {
            host.orchestrator.onWorkUnitComplete(memberId);
        },
    });
    // 会话活动 → 成员状态。
    //
    // 没有这一层，全体成员永远停在初始的 `working`，于是 `convene()` 永远抛
    // 「全部成员都在工作中，会议无法开始」，正式会议室在真实宿主里永远开不起来。
    // 事件名与映射都可配，且监听器永不抛错（与边界监听器同一约定）。
    const applyActivity = (input) => {
        // 先喂活动跟踪：**按会话 id 记**，因为候选列表要对全部会话（含非成员）判断忙/闲。
        if (input.kind === 'busy')
            activity.markBusy(input.sessionId);
        else
            activity.markIdle(input.sessionId);
        const memberId = input.memberId;
        if (memberId === undefined)
            return; // 非成员：只更新忙/闲，不碰状态机。
        let member;
        try {
            member = host.orchestrator.member(memberId);
        }
        catch {
            return; // 未知成员：忽略，不算错误。
        }
        if (input.kind === 'busy') {
            // 已被召集（待入场/在会中）时不回退成 working——那会把会议状态踩掉。
            if (member.state === 'idle-waiting' || member.state === 'done')
                member.resume();
            return;
        }
        // idle：输出完毕、等用户回复 → 变成"可被召集且能立刻到场"的状态。
        // 若正在待入场，说明它这一轮已经跑完了，直接放它进会场。
        if (member.isAwaitingEntry()) {
            host.orchestrator.onWorkUnitComplete(memberId);
            return;
        }
        if (member.state === 'working')
            member.beginIdleWaiting();
        // 其余状态（in-meeting / 已 idle）保持不动。
        // 状态机自己会拒绝非法迁移；让异常冒泡给 sink 记录，保持单一错误通道。
    };
    const sink = attachDshSessionState({
        ctx,
        resolveMemberId,
        onActivity: (input) => {
            applyActivity(input);
        },
    });
    // 交给诊断闭包读取（未映射会话 id 的线索就在 observations 里）。
    sessionSink = sink;
    // 统一的拆卸过程。**幂等**：它会被三个入口触发（返回的 disposer、
    // ctx.effect 的清理、ctx.on('dispose')），Cordis 卸载时可能三路都到。
    let tornDown = false;
    /** 全局工具的卸载器。注册发生在 teardown 定义之后，所以用持有变量。 */
    let toolDispose = () => undefined;
    const teardown = async () => {
        if (tornDown)
            return;
        tornDown = true;
        try {
            toolDispose();
        }
        catch {
            // 卸载工具失败不该阻断其它清理。
        }
        watcher.detach();
        sink.detach();
        await host.shutdown();
    };
    /**
     * 把每一轮的结论报出去。
     *
     * **只在结论变化时报告**：轮次本身是每分钟一次的心跳，原样刷日志会把它淹掉，
     * 那又是"什么都没发生"的另一种写法。
     */
    let lastPulseNote;
    const logger = resolveLogger(ctx);
    const reportPulse = (result) => {
        const escalation = result.escalation;
        const note = escalation.escalated
            ? `已升级到会议室：${escalation.reason}`
            : escalation.signals.length === 0
                ? undefined // 没有停滞信号：安静轮次，不值得记录
                : `未升级到会议室：${escalation.reason}`;
        if (note === undefined || note === lastPulseNote)
            return;
        lastPulseNote = note;
        try {
            if (escalation.escalated)
                logger?.info?.(`[dsh-meeting] ${note}`);
            else
                logger?.warn?.(`[dsh-meeting] ${note}`);
        }
        catch {
            // 宿主日志本身出问题不能影响轮次。
        }
        try {
            const line = JSON.stringify({
                v: 1,
                at: Date.now(),
                escalated: escalation.escalated,
                reason: escalation.reason,
                signals: escalation.signals,
                trigger: result.light.evaluation.decisions[0]?.kind ?? null,
                meeting: result.light.meeting?.agenda.id ?? null,
            });
            mkdirSync(rootDir, { recursive: true });
            appendFileSync(join(rootDir, 'pulse.jsonl'), `${line}\n`, { encoding: 'utf8', flag: 'a' });
        }
        catch {
            // 落盘失败同样不能影响轮次。
        }
    };
    // 全局会议室工具（"开会"按钮）。注册失败只记诊断，绝不把宿主带下线。
    //
    // 但"注册失败"是静默的（工具会直接消失，没人会在意），所以把它**落盘**，
    // 让人有地方查。这是本轮里第二次遇到"静默降级看起来像插件没生效"。
    const tool = registerMeetingTool({ ctx, console: host.console, rootDir });
    toolDispose = tool.dispose;
    // 浏览器面板的数据端点（Typert Remote）。
    //
    // 面板和工具是**同一份数据面**的两个入口：工具给 Agent 调（按会籍过滤），
    // 端点给人看的面板调（`human` 观察者，看全部）。边界只在 console 里写一次。
    //
    // 同样是尽力而为：注册失败只记诊断。这是"给人看的面板"，
    // 它坏了不该让整个 dsh 起不来——这个教训上一轮已经付过一次代价了。
    const remote = registerMeetingRemote({ ctx, console: host.console });
    toolDispose = (() => {
        const inner = toolDispose;
        return () => {
            inner();
            remote.dispose();
        };
    })();
    try {
        mkdirSync(rootDir, { recursive: true });
        appendFileSync(join(rootDir, 'startup.jsonl'), `${JSON.stringify({
            v: 1,
            at: Date.now(),
            toolRegistered: tool.registered,
            remoteRegistered: remote.registered,
            remoteService: `${remote.namespace}/<${remote.methods.join(', ')}>`,
            // 加载期的能力快照（不阻断 boot；**不代表终局**，调用时会重探）。
            gapsAtLoad,
            notes: [...tool.notes, ...remote.notes],
        })}\n`, { encoding: 'utf8', flag: 'a' });
    }
    catch {
        // 诊断落盘不能影响启动。
    }
    // 定时驱动交给宿主生命周期管理，插件自己不持有裸 setInterval。
    //
    // ⚠️ **默认不启**。上一版默认启 + 自动入会 + `onStall: true`，
    // 结果是"插件一装上就自己开始每分钟开会"，而用户既看不到也停不掉。
    // 现在要自动节律必须显式打开：`config.autoPulse === true`。
    if (config.autoPulse === true && typeof ctx.effect === 'function') {
        ctx.effect(() => {
            const timer = setInterval(() => {
                // 每轮先重探一次成员会话：上游会补起 teammate、会话也可能重建，
                // 只在启动时探一次会让后来出现的成员永远映射不上。
                // pulse = 补起未启动的成员 + 轻量路径 + 停滞成立时升级到正式会议室。
                void refreshSessions()
                    .then(() => host.pulse())
                    .then(reportPulse)
                    .catch(() => {
                    // 轮次里的失败绝不能让定时器抛出未处理的 rejection。
                });
            }, 60_000);
            return () => {
                clearInterval(timer);
                void teardown();
            };
        });
    }
    if (typeof ctx.on === 'function') {
        ctx.on('dispose', () => {
            void teardown();
        });
    }
    // 返回 disposer（Cordis 允许），句柄挂在 `.host` 上供程序化调用。
    return Object.assign(() => teardown(), { host, notes: [...tool.notes, ...remote.notes, ...gapsAtLoad] });
}
export default apply;
//# sourceMappingURL=host.js.map