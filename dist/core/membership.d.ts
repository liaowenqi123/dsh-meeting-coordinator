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
/** 一次会籍变更的方向。两个方向的风险相同（都在改该会话的工具集）。 */
export type MembershipOperation = 'join' | 'leave';
/** 一个候选会话（面板的候选列表项）。 */
export interface SessionCandidate {
    readonly sessionId: string;
    /** 展示名。缺省时面板用短 id。 */
    readonly title?: string | undefined;
    readonly workspace?: string | undefined;
    readonly model?: string | undefined;
    /**
     * 是否由别的会话派生出来（子 Agent）。
     *
     * 上游两个信号任一命中即算：`meta.origin === 'subagent'`、
     * `header.parentSession !== undefined`。
     */
    readonly isSubagent: boolean;
    /** 是否正在活动（上游 `running`）。 */
    readonly active: boolean;
    /**
     * 该会话**当前是否已加载**（在 `ctx.sessions` 里活着）。
     *
     * 为什么需要这个字段：`ctx.sessions.list()` 只给已加载的会话 ——
     * 用户没点开过的会话不在里面，所以面板原先只显示"你点过的那几个"。
     * 现在候选列表并入持久化列表（`sessionController.list()`）取全量，
     * 代价是有些候选**不在进程里**：
     *
     * - 它的"忙/闲"只能读持久化行里的 `running`（没有实时活动事件）；
     * - **借不到它的上下文**（`store.get()` 读不到），发言会退化成"只有议题没有背景"。
     *
     * 这两点都不影响入会资格（它确实是非活动的），但面板必须**看得见**，
     * 否则用户会以为会议室坏了。缺省视为已加载。
     */
    readonly loaded?: boolean | undefined;
}
export type AdmissionCode = 'subagent' | 'active' | 'unknown-session' | 'already-member' | 'already-elsewhere' | 'not-member';
export type Admission = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly code: AdmissionCode;
    readonly reason: string;
};
export interface AdmissionInput {
    readonly candidate: SessionCandidate | undefined;
    readonly roomId: string;
    /** 该会话目前已加入的房间（`undefined` 表示没有会籍）。 */
    readonly currentRoomId: string | undefined;
    /** 变更方向。默认 `join`。 */
    readonly operation?: MembershipOperation | undefined;
}
/**
 * 判定一个会话能否加入某个会议室。
 *
 * 返回**带理由的拒绝**而不是布尔值：面板要把"为什么加不了"直接显示出来，
 * 否则用户只会看到按钮灰着却不知道为什么。
 */
export declare function admitSession(input: AdmissionInput): Admission;
/** 面板展示用：把候选列表分成"可以加"和"加不了（附理由）"。 */
export declare function partitionCandidates(input: {
    readonly candidates: readonly SessionCandidate[];
    readonly roomId: string;
    readonly roomOf: (sessionId: string) => string | undefined;
    readonly operation?: MembershipOperation | undefined;
}): {
    readonly admittable: readonly SessionCandidate[];
    readonly rejected: readonly {
        readonly candidate: SessionCandidate;
        readonly reason: string;
        readonly code: AdmissionCode;
    }[];
};
//# sourceMappingURL=membership.d.ts.map