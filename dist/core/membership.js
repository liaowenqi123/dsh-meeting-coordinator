/**
 * 会籍准入策略。
 *
 * ## 为什么单独一个文件
 *
 * 会籍是**权限边界**：只有加入了会议室的会话才能召集、才会被召集。
 * 既然是边界，"谁能进来"就不能散落在 UI 代码和宿主接线里各写一遍——
 * 面板点"加入"与工具调"加入"必须走**同一条判据**，否则边界会从两处漏。
 *
 * ## 三条硬规则（都有上游依据）
 *
 * 1. **子 Agent 不许入会**。上游 `Agent` 的会话元数据里带
 *    `meta.origin === 'subagent'` 与 `meta.parentSession`，据此可以精确识别。
 *    不拦的话，一个会话 spawn N 个子 Agent 就能把自己在房间里的票数刷成 N+1 ——
 *    那等于**自我赋能、自我增票**，会籍作为边界就名存实亡了。
 * 2. **入会那一刻必须是非活动状态**。这条的理由是**注入安全**：
 *    入会要往那个会话里装新工具（见"入会即授权"），而往一个**正在跑**的 Agent
 *    的工具集里塞东西，可能扰动它当前的任务——那是不可接受的风险。
 *    注意口径是**时点**而非永久：只在入会那一瞬间要求非活动；
 *    加入之后它可以随便忙，会籍不受影响。
 * 3. **退出同样要求非活动**。退出是卸工具，与入会同属"改变该会话工具集"的动作，
 *    风险相同。于是整套系统里**只有入会与退出两个时点会碰那个会话**；
 *    **会议过程本身不碰它**——发言走一次性外部调用（借它的上下文与基模型），
 *    所以开会时它忙不忙都无所谓。
 * 4. **一个会话只能作为一个实例、且只能在一个房间里**。前者是结构性的
 *    （上游 `Agent.id === SessionId`，一个会话本来就只有一个 Agent），
 *    后者是刻意排他（否则"唤起"会变成跨房间广播，审计也说不清是谁叫的）。
 */
/**
 * 判定一个会话能否加入某个会议室。
 *
 * 返回**带理由的拒绝**而不是布尔值：面板要把"为什么加不了"直接显示出来，
 * 否则用户只会看到按钮灰着却不知道为什么。
 */
export function admitSession(input) {
    const { candidate, roomId, currentRoomId } = input;
    const operation = input.operation ?? 'join';
    if (candidate === undefined) {
        return { ok: false, code: 'unknown-session', reason: '这个会话已经不在运行中的会话列表里了。' };
    }
    if (candidate.isSubagent) {
        return {
            ok: false,
            code: 'subagent',
            reason: `会话 ${candidate.sessionId} 是别的会话派生出来的子 Agent，不享有进入会议室的能力。` +
                '只有顶级会话才能作为成员。',
        };
    }
    if (operation === 'leave') {
        if (currentRoomId !== roomId) {
            return { ok: false, code: 'not-member', reason: `会话 ${candidate.sessionId} 不在会议室 ${roomId} 里。` };
        }
    }
    else {
        if (currentRoomId === roomId) {
            return { ok: false, code: 'already-member', reason: `会话 ${candidate.sessionId} 已经在这个会议室里了。` };
        }
        if (currentRoomId !== undefined) {
            return {
                ok: false,
                code: 'already-elsewhere',
                reason: `会话 ${candidate.sessionId} 已经加入了会议室 ${currentRoomId}；` +
                    '一个会话只能属于一个会议室。请先让它退出。',
            };
        }
    }
    // 注入安全：入会与退出都会改变该会话的工具集，所以都必须在它非活动时做。
    if (candidate.active) {
        return {
            ok: false,
            code: 'active',
            reason: (operation === 'join'
                ? `会话 ${candidate.sessionId} 正在活动（正在输出或调用工具），暂时不能加入会议室：` +
                    '加入要往它的工具集里装东西，正在执行的任务可能被扰动。'
                : `会话 ${candidate.sessionId} 正在活动，暂时不能退出会议室：` +
                    '退出要从它的工具集里卸东西，正在执行的任务可能被扰动。') +
                '等它这一轮结束（空闲或已完成）再操作。会籍本身不受影响，它的会中义务照旧。',
        };
    }
    return { ok: true };
}
/** 面板展示用：把候选列表分成"可以加"和"加不了（附理由）"。 */
export function partitionCandidates(input) {
    const admittable = [];
    const rejected = [];
    for (const candidate of input.candidates) {
        const verdict = admitSession({
            candidate,
            roomId: input.roomId,
            currentRoomId: input.roomOf(candidate.sessionId),
            ...(input.operation === undefined ? {} : { operation: input.operation }),
        });
        if (verdict.ok)
            admittable.push(candidate);
        else
            rejected.push({ candidate, reason: verdict.reason, code: verdict.code });
    }
    return { admittable, rejected };
}
//# sourceMappingURL=membership.js.map