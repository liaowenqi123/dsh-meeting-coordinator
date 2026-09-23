/**
 * 主持人的两种实现。
 *
 * - {@link RoundRobinModerator}：**不需要模型**的确定性主持人。
 *   按"优先点名本轮还没说话的人"轮转，满足最小轮次后宣布散会。
 *   它既是测试/演示的可靠默认，也是"主持人模型不可用"时的降级路径
 *   （会议绝不能因为主持人拿不到模型就挂住）。
 * - {@link ScriptedModerator}：按脚本给出决定，用于精确验证"主持人控场"的每一条路径
 *   （包括输出跑偏、点名不在场的人等异常）。
 *
 * 真实部署里应当再有一个"用召集者会话模型"的实现（`ModeratorPort`），
 * 它的 prompt 由 `buildModeratorPrompt()` 构造——**不含任何与会者的私有上下文**。
 */
import type { ModeratorContext, ModeratorPort } from '../core/moderator.js';
import type { ModeratorDecision } from '../core/types.js';
export interface RoundRobinModeratorOptions {
    /** 每位在场成员至少要发过几次言才考虑散会。默认 1。 */
    readonly minSpeechesPerMember?: number | undefined;
    /** 至少经过几轮才考虑散会。默认 2。 */
    readonly minRounds?: number | undefined;
}
/**
 * 确定性主持人：不调用模型。
 *
 * 控场规则（刻意保守：宁可多问一轮，也不要过早掐断讨论）：
 * 1. 优先点名"本轮还没发言"的在场成员；
 * 2. 若本轮所有人都已发言，则点名"累计发言次数最少"的人，实现轮转；
 * 3. 满足最小轮次 且 每位在场成员都发言过 `minSpeechesPerMember` 次 → 散会；
 * 4. 到达 `maxRounds` → 散会（上限兜底）。
 */
export declare class RoundRobinModerator implements ModeratorPort {
    readonly port = "round-robin";
    private readonly minSpeeches;
    private readonly minRounds;
    constructor(options?: RoundRobinModeratorOptions);
    decide(input: ModeratorContext & {
        readonly model?: string | undefined;
    }): Promise<ModeratorDecision>;
}
/**
 * 脚本化主持人：按预设队列给出决定。
 *
 * 队列耗尽后回退到 {@link RoundRobinModerator} 的规则——这样测试可以只脚本化
 * 关心的那几步，剩下的交给确定性规则，不必把整场会写死。
 */
export declare class ScriptedModerator implements ModeratorPort {
    readonly port = "scripted-moderator";
    private readonly decisions;
    private readonly fallback;
    /** 记录每次拿到的上下文，便于断言"主持人到底看到了什么"。 */
    readonly seen: ModeratorContext[];
    constructor(decisions: readonly ModeratorDecision[], fallback?: RoundRobinModerator);
    decide(input: ModeratorContext & {
        readonly model?: string | undefined;
    }): Promise<ModeratorDecision>;
}
//# sourceMappingURL=moderators.d.ts.map