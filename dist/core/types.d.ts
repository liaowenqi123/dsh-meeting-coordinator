/**
 * 例会协调器领域模型。
 *
 * 本文件不 import 任何 DSH 或 dsh-std 符号：领域模型必须能在 headless CI 里以纯数据方式构造与断言。
 * 与协议的耦合只发生在 `src/protocol/`。
 */
/** 一个领域隔离子 Agent 的逻辑槽位标识。 */
export type AgentSlotId = string;
/** 会议规模：小会（局部，仅 scope 成员）/ 大会（全局）。 */
export type MeetingScope = 'local' | 'global';
/** 简报板支持的操作。协商按 operation 求交集，缺一即不构成 agreement。 */
export type BriefingBoardOperation = 'publish' | 'read' | 'subscribe' | 'convene';
/**
 * 触发来源。用于审计"这次会是谁开的"。
 *
 * `peer-call` 是本插件的精髓之一：**任何** Agent 都能召集同伴，而不是只有协调器能开会。
 * 一个 Agent 卡住了、做完了一个里程碑、发现方向偏了，都可以立刻把相关同伴唤起来开会。
 */
export type MeetingTriggerKind = 'timer' | 'round' | 'stall' | 'peer-call' | 'on-demand';
/**
 * 一次「召集」。这是 Agent 之间**互相唤起**的载体。
 *
 * 与 {@link MeetingAgenda} 的区别：agenda 是协调器**汇总后**的结果，
 * call 是发起者**提交前**的请求。call 可以被节流、可以被拒绝（reason 会回到发起者）。
 */
export interface MeetingCall {
    /** 谁召集的。必须是已注册的槽位。 */
    readonly calledBy: AgentSlotId;
    /** 小会（局部）/ 大会（全局）。 */
    readonly scope: MeetingScope;
    /** 一句话说明为什么要开会——会原样进入广播摘要的 header。 */
    readonly reason: string;
    /**
     * 可选的显式点名。为空时按 scope 推断：
     * - `global` → 全体；
     * - `local` → 有障碍/有诉求的成员 + 它们点名要的人。
     */
    readonly invitees?: readonly AgentSlotId[] | undefined;
    /**
     * 这是一次**响应式召集**：某个成员收到上一场会的摘要后，自己又开了一场。
     *
     * 它让"互相唤起"形成可审计的链条，而不是一团无法解释的广播。
     */
    readonly inResponseTo?: string | undefined;
}
/**
 * 一个领域隔离子 Agent 的启动规格。
 *
 * `systemPrompt` 是领域隔离的载体：每个槽位只拿到自己方向的提示词，
 * 全局目标通过简报板（而非共享上下文）传播。
 */
export interface AgentSlotSpec {
    readonly id: AgentSlotId;
    readonly domain: string;
    readonly title: string;
    readonly systemPrompt: string;
    readonly model?: string | undefined;
    /** 宿主（DSH）侧的 agent preset 名称；适配层可缺省降级为内联 systemPrompt。 */
    readonly preset?: string | undefined;
    /**
     * 该会话所在的工作区。
     *
     * 会议室**允许跨工作区**，所以成员必须各自带着它；
     * 缺省时按 `default` 处理，用于诊断"这个群里有哪些工作区的人"。
     */
    readonly workspace?: string | undefined;
}
/** 简报草稿：Agent 在提交前构造的内容，尚未经过长度预算与指纹计算。 */
export interface BriefingDraft {
    readonly slot: AgentSlotId;
    readonly domain: string;
    /** 该 Agent 自报的工作轮次。用于"连续 N 轮未更新"判定。 */
    readonly round: number;
    /** 当前状态，一句话。 */
    readonly status: string;
    /** 障碍；无障碍时为 null。 */
    readonly blocker?: string | null | undefined;
    /** 需要的输入/下游依赖。 */
    readonly needs?: readonly string[] | undefined;
    /** 希望得到谁的回答；空数组表示广播给全体。 */
    readonly requestedFrom?: readonly AgentSlotId[] | undefined;
}
/** 已落板的简报：带长度计量、内容指纹、看板 revision 与时间戳。 */
export interface Briefing {
    readonly slot: AgentSlotId;
    readonly domain: string;
    readonly round: number;
    readonly status: string;
    readonly blocker: string | null;
    readonly needs: readonly string[];
    readonly requestedFrom: readonly AgentSlotId[];
    /** 该简报写入时的看板 revision（写入后递增）。 */
    readonly boardRevision: number;
    /** 写入时刻，epoch 毫秒。由调用方注入以便测试可重复。 */
    readonly at: number;
    /** 内容指纹，用于死循环检测（同状态反复提交）。 */
    readonly fingerprint: string;
    /** 计入预算的字符数（按 Unicode code point 计，非 UTF-16 code unit）。 */
    readonly chars: number;
}
/** 看板快照：每个槽位的最新简报 + 全局 revision。 */
export interface BoardSnapshot {
    readonly revision: number;
    readonly briefings: readonly Briefing[];
}
/** 一次会议议程：由协调器根据成员最新简报汇总而成。 */
export interface MeetingAgenda {
    readonly id: string;
    readonly scope: MeetingScope;
    readonly trigger: MeetingTriggerKind;
    readonly reason: string;
    readonly at: number;
    readonly boardRevision: number;
    readonly participants: readonly AgentSlotId[];
    /** 逐槽位聚合后的议题，已按 charBudget 截断。 */
    readonly items: readonly AgendaItem[];
    /** 供广播给全体成员的摘要正文（受 maxAgendaChars 约束）。 */
    readonly digest: string;
    readonly digestChars: number;
    readonly truncated: boolean;
}
export interface AgendaItem {
    readonly slot: AgentSlotId;
    readonly domain: string;
    readonly round: number;
    readonly status: string;
    readonly blocker: string | null;
    readonly needs: readonly string[];
    /** 该槽位是否存在停滞/空转信号。 */
    readonly stalled: boolean;
}
/**
 * 主持人的控场决定。
 *
 * 这是协调器与主持人之间的**控制通道**，不是给 AI 的发言模板——
 * 会议发言内容本身不做结构化（让 AI 自然讨论），
 * 但"下一个谁说话 / 是否散会"必须机器可读。
 */
export type ModeratorDecision = {
    readonly action: 'invite';
    readonly next: string;
    readonly note?: string | undefined;
} | {
    readonly action: 'adjourn';
    readonly reason: string;
};
//# sourceMappingURL=types.d.ts.map