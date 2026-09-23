/**
 * 会议室（"群"）与会籍：**持久实体 + 排他会籍**。
 *
 * ## 为什么需要这一层
 *
 * 关键区分：**不是会话属于会议，而是会话加入会议室**。
 *
 * - 会议室是**持久实体**，不是每次开会临时建的；
 * - **只有加入了会议室**的会话才获得「唤起会议」的权利（能召集）和「参会」的义务（被叫必须到）；
 * - 没加入的会话**叫不动**——这是权限边界，也是"不是什么都能被唤起"的落点；
 * - 成员可**跨工作区**：会议室的成员列表里带 workspace，但不因此分裂成多个群；
 * - 一个会话**最多属于一个会议室**（排他）：符合"一个会话就是一个人"的直觉，
 *   也避免把两个群的发言混进同一份上下文。
 *
 * ## 持久化
 *
 * 追加式 JSONL 事件日志（`room-created` / `member-joined` / `member-left`）。
 * 重放即恢复，因此进程重启后会籍不丢——这与简报板用的是同一套理由：
 * 内存态的群成员关系在重启后会静默消失，让"唤起"变成无声失败。
 */
export interface RoomMember {
    readonly sessionId: string;
    /** 该会话所在的工作区。会议室**允许**跨工作区。 */
    readonly workspace: string;
    /**
     * 该会话自己的模型标识。
     *
     * 会议里这个成员发言时用的就是它——**协调器不选模型**。
     * 主持人用的则是"召集者会话的模型"（见 `moderator.ts`）。
     */
    readonly model?: string | undefined;
    readonly joinedAt: number;
}
export interface MeetingRoomEntity {
    readonly id: string;
    readonly name: string;
    readonly createdAt: number;
    readonly members: readonly RoomMember[];
}
export declare class RoomRegistryError extends Error {
    readonly code = "meeting/room-registry";
    constructor(message: string);
}
export interface RoomRegistryOptions {
    /** 持久化根目录。 */
    readonly rootDir: string;
    readonly now?: (() => number) | undefined;
}
/**
 * 会议室注册表。
 *
 * 全部状态可从事件日志重放得出，因此"谁是哪个群的成员"在重启后可恢复。
 */
export declare class RoomRegistry {
    private readonly dir;
    private readonly now;
    private rooms;
    /** sessionId → roomId 的反向索引，用于排他会籍判定。 */
    private membership;
    private loaded;
    constructor(options: RoomRegistryOptions);
    get logPath(): string;
    private ensureLoaded;
    private append;
    private apply;
    createRoom(input: {
        readonly id: string;
        readonly name?: string | undefined;
    }): MeetingRoomEntity;
    /**
     * 把会话加入会议室。
     *
     * **排他**：会话已属于别的会议室时直接报错，要求先退出。
     * 不做"自动迁移"——那会在用户不知情的情况下把它从一个群里摘出去。
     */
    join(input: {
        readonly sessionId: string;
        readonly roomId: string;
        readonly workspace: string;
        readonly model?: string | undefined;
    }): MeetingRoomEntity;
    /** 退出会议室。退出后不再有参会义务，也不能再召集该室的会议。 */
    leave(sessionId: string): void;
    room(id: string): MeetingRoomEntity | undefined;
    /** 某会话所属的会议室。未加入任何会议室时返回 undefined。 */
    roomOf(sessionId: string): MeetingRoomEntity | undefined;
    list(): readonly MeetingRoomEntity[];
    /** 会话是否有资格召集/被召集。没加入会议室的一律不行。 */
    isMember(sessionId: string): boolean;
    private requireRoom;
}
//# sourceMappingURL=room-registry.d.ts.map