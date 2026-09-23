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

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RoomMember {
  readonly sessionId: string
  /** 该会话所在的工作区。会议室**允许**跨工作区。 */
  readonly workspace: string
  /**
   * 该会话自己的模型标识。
   *
   * 会议里这个成员发言时用的就是它——**协调器不选模型**。
   * 主持人用的则是"召集者会话的模型"（见 `moderator.ts`）。
   */
  readonly model?: string | undefined
  readonly joinedAt: number
}

export interface MeetingRoomEntity {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly members: readonly RoomMember[]
}

export class RoomRegistryError extends Error {
  readonly code = 'meeting/room-registry'

  constructor(message: string) {
    super(message)
    this.name = 'RoomRegistryError'
  }
}

type RoomEvent =
  | { readonly v: 1; readonly kind: 'room-created'; readonly id: string; readonly name: string; readonly at: number }
  | {
      readonly v: 1
      readonly kind: 'member-joined'
      readonly roomId: string
      readonly sessionId: string
      readonly workspace: string
      readonly model?: string | undefined
      readonly at: number
    }
  | { readonly v: 1; readonly kind: 'member-left'; readonly sessionId: string; readonly at: number }

export interface RoomRegistryOptions {
  /** 持久化根目录。 */
  readonly rootDir: string
  readonly now?: (() => number) | undefined
}

/**
 * 会议室注册表。
 *
 * 全部状态可从事件日志重放得出，因此"谁是哪个群的成员"在重启后可恢复。
 */
export class RoomRegistry {
  private readonly dir: string
  private readonly now: () => number
  private rooms = new Map<string, { id: string; name: string; createdAt: number; members: Map<string, RoomMember> }>()
  /** sessionId → roomId 的反向索引，用于排他会籍判定。 */
  private membership = new Map<string, string>()
  private loaded = false

  constructor(options: RoomRegistryOptions) {
    this.dir = options.rootDir
    this.now = options.now ?? (() => Date.now())
  }

  get logPath(): string {
    return join(this.dir, 'rooms.jsonl')
  }

  // --- 持久化 -------------------------------------------------------------

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.logPath)) return
    const text = readFileSync(this.logPath, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let event: RoomEvent
      try {
        event = JSON.parse(trimmed) as RoomEvent
      } catch {
        // 尾部残行（写入被中断）忽略；中间损坏必须暴露。
        if (!text.endsWith('\n')) continue
        throw new RoomRegistryError(`会籍日志 ${this.logPath} 存在无法解析的记录：${trimmed.slice(0, 120)}`)
      }
      this.apply(event)
    }
  }

  private append(event: RoomEvent): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' })
  }

  private apply(event: RoomEvent): void {
    if (event.kind === 'room-created') {
      if (!this.rooms.has(event.id)) {
        this.rooms.set(event.id, { id: event.id, name: event.name, createdAt: event.at, members: new Map() })
      }
      return
    }
    if (event.kind === 'member-joined') {
      const room = this.rooms.get(event.roomId)
      if (room === undefined) return
      room.members.set(event.sessionId, {
        sessionId: event.sessionId,
        workspace: event.workspace,
        model: event.model,
        joinedAt: event.at,
      })
      this.membership.set(event.sessionId, event.roomId)
      return
    }
    // member-left
    const roomId = this.membership.get(event.sessionId)
    if (roomId !== undefined) {
      this.rooms.get(roomId)?.members.delete(event.sessionId)
      this.membership.delete(event.sessionId)
    }
  }

  // --- 写 -----------------------------------------------------------------

  createRoom(input: { readonly id: string; readonly name?: string | undefined }): MeetingRoomEntity {
    this.ensureLoaded()
    if (this.rooms.has(input.id)) {
      throw new RoomRegistryError(`会议室 ${input.id} 已存在。`)
    }
    const at = this.now()
    this.append({ v: 1, kind: 'room-created', id: input.id, name: input.name ?? input.id, at })
    this.apply({ v: 1, kind: 'room-created', id: input.id, name: input.name ?? input.id, at })
    return this.requireRoom(input.id)
  }

  /**
   * 把会话加入会议室。
   *
   * **排他**：会话已属于别的会议室时直接报错，要求先退出。
   * 不做"自动迁移"——那会在用户不知情的情况下把它从一个群里摘出去。
   */
  join(input: {
    readonly sessionId: string
    readonly roomId: string
    readonly workspace: string
    readonly model?: string | undefined
  }): MeetingRoomEntity {
    this.ensureLoaded()
    if (input.sessionId.trim().length === 0) {
      throw new RoomRegistryError('sessionId 不能为空。')
    }
    if (input.workspace.trim().length === 0) {
      throw new RoomRegistryError(`会话 ${input.sessionId} 缺少 workspace。`)
    }
    const existing = this.membership.get(input.sessionId)
    if (existing !== undefined && existing !== input.roomId) {
      throw new RoomRegistryError(
        `会话 ${input.sessionId} 已属于会议室 ${existing}；一个会话只能属于一个会议室，请先 leave()。`,
      )
    }
    const room = this.requireRoom(input.roomId)
    if (room.members.some((member) => member.sessionId === input.sessionId)) return room

    const event: RoomEvent = {
      v: 1,
      kind: 'member-joined',
      roomId: input.roomId,
      sessionId: input.sessionId,
      workspace: input.workspace,
      model: input.model,
      at: this.now(),
    }
    this.append(event)
    this.apply(event)
    return this.requireRoom(input.roomId)
  }

  /** 退出会议室。退出后不再有参会义务，也不能再召集该室的会议。 */
  leave(sessionId: string): void {
    this.ensureLoaded()
    if (!this.membership.has(sessionId)) return
    const event: RoomEvent = { v: 1, kind: 'member-left', sessionId, at: this.now() }
    this.append(event)
    this.apply(event)
  }

  // --- 读 -----------------------------------------------------------------

  room(id: string): MeetingRoomEntity | undefined {
    this.ensureLoaded()
    const room = this.rooms.get(id)
    return room === undefined ? undefined : freezeRoom(room)
  }

  /** 某会话所属的会议室。未加入任何会议室时返回 undefined。 */
  roomOf(sessionId: string): MeetingRoomEntity | undefined {
    this.ensureLoaded()
    const id = this.membership.get(sessionId)
    return id === undefined ? undefined : this.room(id)
  }

  list(): readonly MeetingRoomEntity[] {
    this.ensureLoaded()
    return [...this.rooms.values()].map(freezeRoom).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  }

  /** 会话是否有资格召集/被召集。没加入会议室的一律不行。 */
  isMember(sessionId: string): boolean {
    this.ensureLoaded()
    return this.membership.has(sessionId)
  }

  private requireRoom(id: string): MeetingRoomEntity {
    const room = this.rooms.get(id)
    if (room === undefined) throw new RoomRegistryError(`会议室 ${id} 不存在。`)
    return freezeRoom(room)
  }
}

function freezeRoom(room: {
  id: string
  name: string
  createdAt: number
  members: Map<string, RoomMember>
}): MeetingRoomEntity {
  return Object.freeze({
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    members: Object.freeze(
      [...room.members.values()].sort((left, right) => (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0)),
    ),
  })
}
