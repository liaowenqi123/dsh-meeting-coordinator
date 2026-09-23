/**
 * DSH 运行时适配层。
 *
 * ## 这个文件是整个仓库里**唯一**接触上游 DSH 形状的地方
 *
 * 它刻意做到了三件事，直接对应"隔离上游破坏性变更、降低维护成本"这一目标：
 *
 * 1. **零 `@deepseek-ai/*` import**。全仓库不存在对上游包的类型依赖，
 *    上游重构导出、改包名、改类型都不会让本插件编译失败。
 *    做法抄自 `@dsh-std/adapter-dsh` 自己：它把会话适配器的上游形状
 *    声明为本地结构接口（`DshSessionControllerFace`），并用新旧字段双读兼容。
 * 2. **所有上游成员都是 optional**。上游删掉 `interrupt`，这里只是能力探测返回
 *    `canInterrupt: false`，而不是编译期爆炸或运行期 `undefined is not a function`。
 * 3. **能力是探测出来的，不是假设出来的**。拿不到 `agentTeams` 就明确报告降级，
 *    绝不假装能开会 —— dsh-std core 反复强调的
 *    "安装了某个包不能代替运行中的 support 声明"，这里把同一原则用在适配层。
 *
 * ## 已核实的上游形状（基线：`@deepseek-ai/dsh@0.1.6-alpha.2`）
 *
 * 来源：`node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/index.d.ts`
 * 与 `.../types.d.ts`（该包随 dsh 自身嵌套安装）：
 *
 * - `spawnTeammate(caller, { name, description, prompt: ContentBlock[], context: 'fresh'|'fork',
 *    provider, signal }) => Promise<{ member }>`
 * - `sendMessage(caller, { target, content: ContentBlock[], signal }) => Promise<{ messageId, status }>`
 * - `interrupt(caller, targetName) => { previousStatus }`
 * - `createTask(caller, { subject, description, blockedBy?, writeScopes? })`（原生共享任务板）
 *
 * `ContentBlock` 的文本形态为 `{ type: 'text', text: string }`。
 *
 * ## 两条上游路径的取舍（诚实记录）
 *
 * | | `ctx.agentTeams` | `ctx.subagents` |
 * |---|---|---|
 * | 持久 peer 信箱 | ✅ 原生 | ❌ |
 * | 共享任务板 / 写域隔离 | ✅ `createTask(writeScopes)` | ❌ |
 * | 指定 `model` / `reasoningEffort` | ❌ 无 `agentOptions` | ✅ `agentOptions` |
 *
 * 例会场景需要的是"持久信箱 + 名册 + 任务 DAG"，所以默认走 `agentTeams`；
 * 领域隔离靠**不同的 systemPrompt**达成，而不是靠不同模型。
 * 需要按槽位选模型时显式传 `preferred: 'subagents'`，代价是失去原生信箱。
 */
import { RuntimeUnavailable } from '../ports/agent-runtime.js';
/**
 * 默认上下文模式是 `fresh`，且**强烈不建议**改成 `fork`。
 *
 * `fork` 会让子 Agent 继承父上下文——那正是本插件要解决的"上下文污染"本身。
 * 领域隔离的前提就是每个槽位从干净上下文起步，只通过限长简报互通。
 */
const DEFAULT_CONTEXT_MODE = 'fresh';
const DEFAULT_PROVIDER = 'spawn';
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------
export function createDshMeetingRuntime(options) {
    return new DshMeetingRuntime(options);
}
class DshMeetingRuntime {
    port;
    options;
    timeoutMs;
    /** slot -> 上游标识（teammate name 或 child id）。 */
    upstream = new Map();
    /** 已解析的后端；探测一次后缓存，但每次调用仍走 optional 检查。 */
    backend;
    constructor(options) {
        this.options = options;
        this.timeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
        this.port = `dsh/${options.preferred ?? 'auto'}`;
    }
    capabilities() {
        const team = this.teamService();
        const subagents = this.subagentRuntime();
        const notes = [];
        const teamUsable = team !== undefined && typeof team.spawnTeammate === 'function';
        const subagentsUsable = subagents !== undefined && typeof subagents.start === 'function';
        let backend;
        if (this.options.preferred === 'subagents') {
            backend = subagentsUsable ? 'subagents' : undefined;
        }
        else if (this.options.preferred === 'agentTeams') {
            backend = teamUsable ? 'agentTeams' : undefined;
        }
        else {
            backend = teamUsable ? 'agentTeams' : subagentsUsable ? 'subagents' : undefined;
        }
        this.backend = backend;
        if (backend === undefined) {
            if (team === undefined && subagents === undefined) {
                notes.push('ctx.get("agentTeams") 与 ctx.get("subagents") 均不可用；宿主未装载 agent-team 或 subagent 服务。');
            }
            else if (this.options.preferred === 'agentTeams' && !teamUsable) {
                notes.push('请求了 agentTeams 后端，但 ctx.get("agentTeams") 缺少 spawnTeammate。');
            }
            else if (this.options.preferred === 'subagents' && !subagentsUsable) {
                notes.push('请求了 subagents 后端，但 ctx.get("subagents") 缺少 start。');
            }
        }
        const canDeliver = backend === 'agentTeams'
            ? team !== undefined && typeof team.sendMessage === 'function'
            : subagents !== undefined && typeof subagents.sendMessage === 'function';
        const canInterrupt = backend === 'agentTeams'
            ? team !== undefined && typeof team.interrupt === 'function'
            : subagents !== undefined && typeof subagents.interrupt === 'function';
        if (backend === 'agentTeams' && !canDeliver) {
            notes.push('agentTeams.sendMessage 不可用：能起成员但无法投递简报，例会不成立。');
        }
        if (backend === 'agentTeams') {
            notes.push('agentTeams 后端不暴露 agentOptions：AgentSlotSpec.model 仅作审计记录，不会真正生效。');
            if (team !== undefined && typeof team.createTask !== 'function') {
                notes.push('agentTeams.createTask 不可用：无法使用上游原生共享任务板（writeScopes/blockedBy）。');
            }
            notes.push('agentTeams.sendMessage 是持久信箱：对空闲成员会直接起一个新回合（真正的"唤起"），' +
                '对运行中的成员在最近步骤边界送达。');
            notes.push('agentTeams 没有独立的 steer 通道：投递语义由上游按目标状态决定，mode 字段对上游不可见。');
        }
        if (backend === 'subagents') {
            notes.push('subagents 后端无原生持久 peer 信箱：简报靠 subagents.sendMessage 直投，重启后不保证可重放。');
            if (subagents !== undefined) {
                notes.push('subagents 后端支持 agentOptions.model，可按槽位指定模型。');
            }
        }
        const canWaitForActivity = team !== undefined && typeof team.waitForChange === 'function';
        if (backend === 'agentTeams' && !canWaitForActivity) {
            notes.push('agentTeams.waitForChange 不可用：会议只能"广播后不等待"，无法收集回执。');
        }
        const mode = this.options.contextMode ?? DEFAULT_CONTEXT_MODE;
        if (mode === 'fork') {
            notes.push('contextMode=fork 会让子 Agent 继承父上下文，可能重新引入上下文污染。');
        }
        return {
            port: this.port,
            canSpawn: backend !== undefined,
            canDeliver,
            // 两条上游路径的 sendMessage 都是 durable mailbox 语义：投递即可唤起空闲同伴。
            canWake: canDeliver,
            canInterrupt,
            canWaitForActivity,
            hasNativeTaskBoard: team !== undefined && typeof team.createTask === 'function',
            notes,
        };
    }
    async spawn(spec, options) {
        const backend = this.resolveBackend();
        const caller = await this.resolveCaller();
        const name = teammateName(spec.id);
        if (this.upstream.has(spec.id)) {
            throw new RuntimeUnavailable(`槽位 ${spec.id} 已在上游注册为 ${name}；slot id 必须唯一。`);
        }
        const prompt = this.buildSpawnPrompt(spec);
        const contextMode = this.options.contextMode ?? DEFAULT_CONTEXT_MODE;
        const provider = this.options.provider ?? DEFAULT_PROVIDER;
        const upstreamId = await this.withTimeout(options?.signal, async (signal) => {
            if (backend === 'agentTeams') {
                const team = this.mustTeam();
                const result = await team.spawnTeammate?.(caller, {
                    name,
                    description: `${spec.title}（${spec.domain}）`,
                    prompt,
                    context: contextMode,
                    provider,
                    signal,
                });
                return readMemberName(result) ?? name;
            }
            const subagents = this.mustSubagents();
            const request = { label: name, prompt, parent: caller, signal };
            if (spec.model !== undefined) {
                request.agentOptions = { model: spec.model };
            }
            const result = await subagents.start?.(provider === 'fork' ? 'fork' : 'spawn', request);
            return readChildId(result) ?? name;
        }, `启动槽位 ${spec.id}`);
        this.upstream.set(spec.id, upstreamId);
        return { id: upstreamId, slot: spec.id, runtimeRef: `${backend}:${upstreamId}` };
    }
    async deliver(handle, delivery) {
        const backend = this.resolveBackend();
        const caller = await this.resolveCaller();
        const target = this.upstream.get(handle.slot) ?? handle.id;
        const content = [{ type: 'text', text: delivery.text }];
        await this.withTimeout(undefined, async (signal) => {
            if (backend === 'agentTeams') {
                const team = this.mustTeam();
                // 上游 agentTeams.sendMessage 只有一个投递语义：排队 + 立即尝试送达。
                // 对空闲成员它直接起一个新回合，因此天然满足 mode='wake'。
                // 它**没有**"只插入当前回合"的 steer 通道；`mode` 对上游不可见，
                // 这里如实保留字段而不伪造行为（能力说明里已写清）。
                await team.sendMessage?.(caller, { target, content, signal });
                return;
            }
            const subagents = this.mustSubagents();
            await subagents.sendMessage?.(caller, target, content);
        }, `向槽位 ${handle.slot} 投递 ${delivery.kind}/${delivery.mode}`);
    }
    async interrupt(handle) {
        const backend = this.resolveBackend();
        const caller = await this.resolveCaller();
        const target = this.upstream.get(handle.slot) ?? handle.id;
        if (backend === 'agentTeams') {
            const team = this.mustTeam();
            if (typeof team.interrupt !== 'function') {
                throw new RuntimeUnavailable('上游 agentTeams 不支持 interrupt。');
            }
            team.interrupt(caller, target);
            return;
        }
        const subagents = this.mustSubagents();
        if (typeof subagents.interrupt !== 'function') {
            throw new RuntimeUnavailable('上游 subagents 不支持 interrupt。');
        }
        await subagents.interrupt(target, '例会召集：中断当前回合');
    }
    /**
     * 等待同伴产生活动。
     *
     * 有它，例会才是"交换"而不是"广播"：协调器唤醒 N 个成员后可以等回执，
     * 再决定要不要开第二轮。上游只有 `agentTeams.waitForChange` 提供这个能力；
     * 拿不到时明确抛错，让调用方降级为"不等回执"，而不是让例会在无声中变成单向通知。
     */
    async waitForActivity(handle, timeoutMs, signal) {
        const capabilities = this.capabilities();
        if (!capabilities.canWaitForActivity) {
            throw new RuntimeUnavailable(`运行时 ${capabilities.port} 不支持 waitForActivity：${capabilities.notes.join(' / ') || '上游未提供 waitForChange'}`);
        }
        const caller = await this.resolveCaller();
        const controller = new AbortController();
        const onExternalAbort = () => controller.abort();
        signal?.addEventListener('abort', onExternalAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const team = this.mustTeam();
            const result = await team.waitForChange?.(caller, timeoutMs, controller.signal);
            return { kind: 'changed', detail: describeWaitResult(result, handle.slot) };
        }
        catch {
            return { kind: 'timeout', detail: `等待 ${handle.slot} 在 ${timeoutMs}ms 内没有可观察活动。` };
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onExternalAbort);
        }
    }
    /**
     * 关闭槽位。
     *
     * `agentTeams` **没有** close/kill 成员的方法（只有 `interrupt`），
     * 所以这里只能解除本地映射并如实记录，不能假装成员已经被销毁。
     * 这是上游能力缺口，必须显式暴露而不是静默吞掉。
     */
    async close(handle) {
        const backend = this.resolveBackend();
        if (backend === 'agentTeams') {
            this.upstream.delete(handle.slot);
            return;
        }
        const target = this.upstream.get(handle.slot) ?? handle.id;
        const subagents = this.mustSubagents();
        this.upstream.delete(handle.slot);
        if (typeof subagents.stop === 'function') {
            await subagents.stop(target, '例会结束：撤出该槽位');
            return;
        }
        if (typeof subagents.interrupt === 'function') {
            await subagents.interrupt(target, '例会结束：撤出该槽位');
            return;
        }
        throw new RuntimeUnavailable('上游 subagents 既无 stop 也无 interrupt，无法撤出槽位。');
    }
    /**
     * 探测"槽位 → 上游会话 id"的映射。
     *
     * 依据（按 `@deepseek-ai/dsh@0.1.6-alpha.2` 的 `.d.ts` 核对）：
     * `TeamMemberView` 同时带 `id: SessionId` 与 `name`，而成员是我们用
     * `teammateName(slot)` 起的名字，所以按名字对齐就能拿到**权威的会话 id**。
     *
     * 为什么必须做这件事：上游 `session/event` 携带的是 DSH 自己的会话 id
     * （UUID），与本项目的 slot id 无关。拿不到映射时，边界事件与活动事件都
     * 归属不到任何成员——表现是"插件装好了、日志也不报错，但没人被登记为
     * 空闲、没人入场，会议室永远开不起来"。这是最容易被误判成"插件没生效"的坑。
     */
    async memberSessions() {
        if (this.resolveBackend() !== 'agentTeams') {
            // subagents 后端的子运行 id 由 start() 返回，但它不是**会话** id，
            // 不能当作 session/event 的归属依据。如实返回空，不编造映射。
            return [];
        }
        const team = this.mustTeam();
        if (typeof team.listMembers !== 'function')
            return [];
        const caller = await this.resolveCaller();
        const views = await team.listMembers(caller);
        const byName = new Map();
        for (const raw of views) {
            if (typeof raw !== 'object' || raw === null)
                continue;
            const record = raw;
            if (typeof record.name !== 'string' || record.name.length === 0)
                continue;
            const sessionId = readIdString(record.id);
            if (sessionId !== undefined)
                byName.set(record.name, sessionId);
        }
        const out = [];
        for (const slot of this.upstream.keys()) {
            const sessionId = byName.get(teammateName(slot));
            if (sessionId !== undefined)
                out.push({ slot, sessionId });
        }
        return out;
    }
    // --- 内部 ---------------------------------------------------------------
    resolveBackend() {
        if (this.backend === undefined) {
            const capabilities = this.capabilities();
            if (!capabilities.canSpawn) {
                throw new RuntimeUnavailable(`DSH 适配层找不到可用的多 Agent 后端。诊断：${capabilities.notes.join(' / ') || 'ctx.get 未返回 agentTeams/subagents'}`);
            }
        }
        const backend = this.backend;
        if (backend === undefined) {
            throw new RuntimeUnavailable('DSH 适配层后端解析失败。');
        }
        return backend;
    }
    teamService() {
        const value = readService(this.options.ctx, 'agentTeams');
        return isFace(value, ['spawnTeammate', 'sendMessage', 'interrupt', 'listMembers', 'createTask']);
    }
    subagentRuntime() {
        const value = readService(this.options.ctx, 'subagents');
        return isFace(value, ['start', 'sendMessage', 'interrupt', 'stop']);
    }
    mustTeam() {
        const team = this.teamService();
        if (team === undefined)
            throw new RuntimeUnavailable('ctx.get("agentTeams") 不可用。');
        return team;
    }
    mustSubagents() {
        const subagents = this.subagentRuntime();
        if (subagents === undefined)
            throw new RuntimeUnavailable('ctx.get("subagents") 不可用。');
        return subagents;
    }
    async resolveCaller() {
        const caller = await this.options.resolveCaller();
        if (caller === undefined || caller === null) {
            throw new RuntimeUnavailable('无法解析当前活的 Lead Agent。agentTeams/subagents 要求 exact live Agent 作为授权凭据，' +
                '请在宿主侧把 resolveCaller 接到当前会话的 agent 上。');
        }
        return caller;
    }
    /**
     * 构造 spawn 提示词。
     *
     * 只放**领域提示词 + 简报协议**，不放全局项目上下文 —— 后者会立刻把新建的
     * 干净上下文重新污染成"全知但无用"。全局目标通过例会简报逐步注入。
     */
    buildSpawnPrompt(spec) {
        const lines = [
            `# 角色：${spec.title}`,
            '',
            spec.systemPrompt,
            '',
            '## 协作契约（例会机制）',
            `你是一个领域隔离的 Agent，domain=${spec.domain}。`,
            '你**看不到**其他 Agent 的上下文；其他 Agent 也看不到你的。',
            '你唯一需要遵守的对外通道是"简报"：',
            '- 每完成一轮工作，提交一份不超过 200 字的简报，包含三部分：当前状态 / 障碍 / 需要的输入。',
            '- 简报会由协调器汇总后广播给相关成员。',
            '- 当你收到 `[meeting-digest]` 时，那是全体成员的汇总摘要，请据此调整自己的下一步。',
            '- 当你反复尝试同类操作失败、或长时间没有实质进展时，**主动提交一份简报说明卡在哪里**。',
        ];
        return [{ type: 'text', text: lines.join('\n') }];
    }
    /** 统一超时：上游调用必须可取消，否则协调器会被一个卡住的上游拖死。 */
    async withTimeout(external, run, what) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const onExternalAbort = () => controller.abort();
        external?.addEventListener('abort', onExternalAbort, { once: true });
        try {
            return await run(controller.signal);
        }
        catch (error) {
            if (controller.signal.aborted) {
                throw new RuntimeUnavailable(`${what} 超时（${this.timeoutMs}ms）或被取消。`);
            }
            throw new RuntimeUnavailable(`${what} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            clearTimeout(timer);
            external?.removeEventListener('abort', onExternalAbort);
        }
    }
}
// ---------------------------------------------------------------------------
// 纯函数辅助
// ---------------------------------------------------------------------------
/** 从 Cordis `Context` 取服务；`get` 本身也可能缺失。 */
export function readService(ctx, name) {
    if (typeof ctx.get !== 'function')
        return undefined;
    try {
        return ctx.get(name);
    }
    catch {
        // 上游对未装载服务可能抛错而不是返回 undefined；两种都要容错。
        return undefined;
    }
}
/** 值是否至少具备给定成员之一 —— 避免把任意对象误认成服务。 */
export function isFace(value, members) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    const hit = members.some((member) => typeof record[member] === 'function');
    return hit ? value : undefined;
}
/** 一个对象是否长得像"活的 Agent"：上游 `tryMembership` 第一件事就是读 `agent.id`。 */
export function isLiveAgent(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const id = value.id;
    if (typeof id === 'string' && id.length > 0)
        return true;
    // branded id 通常是 string；有些实现用 { toString() } 包装。
    return typeof id === 'object' && id !== null && String(id) !== '[object Object]';
}
/**
 * 解析一个**确实活着的 Agent** 作为上游授权凭据。
 *
 * ## 为什么必须这样解，而不能直接返回 `ctx.get('agents')`
 *
 * 实测踩过：`apply(ctx)` 里把 `ctx.get('agents')` 原样交给 `spawnTeammate`，
 * 上游报 `agent "undefined" is not a member of an active Agent Team` ——
 * 因为它读 `agent.id`，而服务对象没有 `id`。上游的 `tryMembership` 第一条判据是
 * `ctx.agents.get(agent.id) === agent`（**exact live Agent**，同一个对象引用），
 * 所以只能从 registry 里取，不能自己造。
 *
 * ## 三级取值，顺序有理由
 *
 * 1. `currentInitiator()` —— 在 Agent 驱动的调用链里最准确（就是"是谁发起的"）；
 *    但它是 AsyncLocalStorage 语义，**插件加载与定时器路径下必然为 undefined**。
 * 2. `roots()[0]` —— 无 owner 的根 Agent（Lead）。非 Agent 驱动路径只有它可用。
 * 3. `list()[0]` —— 兜底：任何活着的 Agent 都能当授权凭据。
 *
 * 都拿不到时返回 `undefined`（由调用方决定是报错还是稍后重试）——
 * 这**不是**异常情况：`dsh web` 刚启动、用户还没开任何会话时就是如此。
 */
export function resolveLiveAgent(ctx) {
    const agents = readService(ctx, 'agents');
    if (agents === undefined || agents === null)
        return undefined;
    const registry = agents;
    if (typeof registry.currentInitiator === 'function') {
        try {
            const initiator = registry.currentInitiator();
            if (isLiveAgent(initiator))
                return initiator;
        }
        catch {
            // 没有发起者边界时会抛（或服务已 dispose）；这属于正常情况，继续往下找。
        }
    }
    for (const candidate of safeCall(() => registry.roots?.() ?? [])) {
        if (isLiveAgent(candidate))
            return candidate;
    }
    for (const candidate of safeCall(() => registry.list?.() ?? [])) {
        if (isLiveAgent(candidate))
            return candidate;
    }
    return undefined;
}
function safeCall(fn) {
    try {
        const value = fn();
        return Array.isArray(value) ? value : [];
    }
    catch {
        return [];
    }
}
/**
 * 槽位 id -> 上游 teammate 名。
 *
 * 上游要求 lower-kebab-case，且名字是持久身份（收件箱按名字寻址），
 * 因此这里必须是**确定性**映射：同一个 slot id 永远得到同一个名字。
 */
export function teammateName(slot) {
    const lowered = slot.toLowerCase();
    const normalized = lowered.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const safe = normalized.length > 0 ? normalized : 'slot';
    return safe.length <= 64 ? safe : safe.slice(0, 64).replace(/-+$/, '');
}
function readMemberName(result) {
    if (typeof result !== 'object' || result === null)
        return undefined;
    const member = result.member;
    if (typeof member !== 'object' || member === null)
        return undefined;
    const name = member.name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
}
function readChildId(result) {
    if (typeof result !== 'object' || result === null)
        return undefined;
    for (const key of ['childId', 'id', 'sessionId', 'agentId']) {
        const value = result[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
        if (typeof value === 'bigint')
            return value.toString();
    }
    return undefined;
}
/**
 * 把上游的 id 值压成字符串。
 *
 * 上游的 `SessionId` 是 branded string，但也可能是带 `toString` 的包装对象
 * （与 `readSessionId` 处理的情形相同），所以这里两种都接受。
 */
function readIdString(value) {
    if (typeof value === 'string' && value.length > 0)
        return value;
    if (typeof value === 'bigint')
        return value.toString();
    if (typeof value !== 'object' || value === null)
        return undefined;
    const text = String(value);
    return text.length > 0 && text !== '[object Object]' ? text : undefined;
}
/** 把上游 `waitForChange` 的返回压成一句可读诊断，不把上游对象泄漏到领域层。 */
function describeWaitResult(result, slot) {
    if (typeof result !== 'object' || result === null) {
        return `槽位 ${slot} 产生了活动（上游未返回结构化结果）。`;
    }
    const record = result;
    const kind = record['type'] ?? record['kind'] ?? record['status'];
    return typeof kind === 'string'
        ? `槽位 ${slot} 产生活动：${kind}。`
        : `槽位 ${slot} 产生了活动。`;
}
//# sourceMappingURL=dsh-team-runtime.js.map