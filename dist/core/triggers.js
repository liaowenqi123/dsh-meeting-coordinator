/**
 * 触发规则：决定"什么时候开会"。
 *
 * 三类触发，与需求一一对应：
 * - `timer`     —— 每 N 毫秒（默认 4 小时）；
 * - `round`     —— 每 N 轮（Agent 持续循环工作时的周期性简报交换）；
 * - `stall`     —— 由 {@link detectStall} 计算的停滞信号驱动（打破死循环的核心）；
 * - `on-demand` —— 任何成员按需召集，绕过节流（但仍有最小间隔，防止广播风暴）。
 *
 * 节流来自竞品调研的教训：Caucus 需要令牌桶限流，Anthropic 的 MAS 经验是
 * 多 Agent 约 15× token 成本，因此**默认绝不能每轮都开会**。
 */
import { detectStall } from './stall-detector.js';
export const DEFAULT_TRIGGER_POLICY = {
    everyMs: 4 * 60 * 60 * 1000,
    everyRounds: 20,
    onStall: true,
    minIntervalMs: 10 * 60 * 1000,
    periodicScope: 'global',
};
/**
 * 评估全部触发规则。
 *
 * 返回**全部**成立的触发而不是第一条：调用方（或 UI）可以据此解释"为什么现在要开会"。
 * 但 `decisions` 已按优先级排序，`decisions[0]` 即应当执行的那一个。
 */
export function evaluateTriggers(state, policy = DEFAULT_TRIGGER_POLICY) {
    const all = [];
    const stallSignals = policy.onStall
        ? detectStall({
            snapshot: state.snapshot,
            history: state.history,
            slots: state.slots,
            currentRound: state.currentRound,
            now: state.now,
        })
        : [];
    for (const signal of stallSignals) {
        all.push({
            kind: 'stall',
            // 停滞先开小会：只叫上出问题的成员，避免用全局广播污染健康成员的上下文。
            scope: 'local',
            reason: signal.detail,
            priority: 1,
        });
    }
    if (policy.everyRounds > 0 && state.currentRound > 0) {
        const lastRound = state.lastMeetingRound ?? 0;
        if (state.currentRound - lastRound >= policy.everyRounds) {
            all.push({
                kind: 'round',
                scope: policy.periodicScope,
                reason: `距上次例会已过 ${state.currentRound - lastRound} 轮（阈值 ${policy.everyRounds}）。`,
                priority: 2,
            });
        }
    }
    if (policy.everyMs > 0 && state.lastMeetingAt !== undefined && state.now - state.lastMeetingAt >= policy.everyMs) {
        all.push({
            kind: 'timer',
            scope: policy.periodicScope,
            reason: `距上次例会已过 ${Math.round((state.now - state.lastMeetingAt) / 60000)} 分钟（阈值 ${Math.round(policy.everyMs / 60000)} 分钟）。`,
            priority: 3,
        });
    }
    all.sort((left, right) => left.priority - right.priority || compareCodeUnit(left.reason, right.reason));
    const sinceLast = state.lastMeetingAt === undefined ? Number.POSITIVE_INFINITY : state.now - state.lastMeetingAt;
    // 首次会议不受节流限制（lastMeetingAt 为 undefined 时 sinceLast 为 Infinity）。
    if (sinceLast >= policy.minIntervalMs) {
        return { decisions: all, suppressed: [], stallSignals };
    }
    // 节流生效：仍允许"手动的等价物"——即最高优先级的停滞触发透过，
    // 否则一个刚开完会就卡死的 Agent 会被限流规则挡住，违背设立触发器的初衷。
    const pass = all.filter((decision) => decision.priority <= 1);
    const suppressed = all.filter((decision) => decision.priority > 1);
    return { decisions: pass, suppressed, stallSignals };
}
/**
 * 构造一次"按需"触发。任何成员都可召集。
 *
 * `local` 的成员集合由调用方给出；这里不推断成员关系——推断需要知道领域拓扑，
 * 而协调器只负责召集/汇总/广播，不做任务路由。
 */
export function demandTrigger(input) {
    return {
        kind: 'on-demand',
        scope: input.scope,
        reason: `由 ${input.requestedBy} 按需召集：${input.reason}`,
        priority: 0,
    };
}
function compareCodeUnit(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
//# sourceMappingURL=triggers.js.map