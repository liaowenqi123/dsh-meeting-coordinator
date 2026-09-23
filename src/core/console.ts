/**
 * 会议室控制台：**面板与全局工具共用的唯一数据面**。
 *
 * ## 为什么要有这一层
 *
 * "面板"（人看的）和"全局工具"（Agent 调的）是同一件事的两个入口。
 * 如果各自实现一遍"有哪些房间、谁在里面、开过几次会"，
 * 两边的**可见性口径**迟早会漂移——而会籍是权限边界，边界漂移就是漏洞。
 *
 * 所以：**一份数据面，两个入口**。这一层不知道 UI，也不知道 tool 的 JSON Schema，
 * 只回答"谁能看到什么、谁可以做什么"。
 *
 * ## 可见性口径（刻意分级）
 *
 * | 观察者 | 看得到 |
 * |---|---|
 * | 人类（`human` 观察者） | 全部：所有房间的成员名单与历次会议 |
 * | 某会话 | 只有**它自己加入的房间**的成员名单与历次会议；其余房间只回"存在 + 名字 + 你没在里面" |
 *
 * 为什么会话侧要收窄：如果任何会话都能通过全局工具读到别的房间的会议内容，
 * 那等于把别人的会议记录倒进一个无关会话的上下文——正是本项目最反对的
 * "上下文污染"，只是换了个入口。而且那会直接架空"会籍 = 权限边界"：
 * 非成员根本不需要加入，读一遍就知道了。
 *
 * ## 动作与权限
 *
 * - `createRoom` / `addSession` / `removeSession`：**人类操作**（面板）。会走准入策略。
 * - `convene`：成员或人类都可。**非成员不行**——这正是"会籍 = 召集权"。
 *   返回值刻意只回**调用者自己那份纪要**，不回 transcript：
 *   把别人的全部发言发回去，就只是把"广播"换了个说法，那正是污染本身。
 */

import { HUMAN_PARTICIPANT } from './participant.js'
import type { RoomRegistry, MeetingRoomEntity, RoomMember } from './room-registry.js'
import type { RoomMeetingLine, RoomMinutesStore } from './room-minutes.js'
import type { ActiveMeetingView, RoomMeetingCall, RoomMeetingRecord } from './room-orchestrator.js'
import {
  admitSession,
  partitionCandidates,
  type Admission,
  type AdmissionCode,
  type MembershipOperation,
  type SessionCandidate,
} from './membership.js'

/** 面板/工具需要的"成员"视图。 */
export interface ConsoleMemberView {
  readonly sessionId: string
  /**
   * 会话标题（人看的名字）。
   *
   * 没有它，面板只能显示 `session-750e30ff-0fe5-…` —— 看不出是哪个会话。
   * 成员已被关闭、不在会话列表里时可能取不到，此时面板退回短 id。
   */
  readonly title?: string | undefined
  readonly workspace?: string | undefined
  readonly model?: string | undefined
  /** 成员状态机当前状态（`working` / `idle-waiting` / `in-meeting` …）。 */
  readonly state?: string | undefined
}

export interface ConsoleRoomView {
  readonly id: string
  readonly name: string
  /** 观察者是否在这个房间里。 */
  readonly mine: boolean
  /** 成员名单。**非成员房间不给**（见可见性口径）。 */
  readonly members?: readonly ConsoleMemberView[] | undefined
  /** 已开过的正式会议场次。**非成员房间不给**。 */
  readonly meetingCount?: number | undefined
  readonly lastMeetingAt?: number | undefined
}

export interface ConsoleOverview {
  readonly rooms: readonly ConsoleRoomView[]
  /** 观察者自己的会籍。 */
  readonly myRoomIds: readonly string[]
}

export type ConsoleRoomDetail =
  | {
      readonly ok: true
      readonly room: ConsoleRoomView
      /** 历次正式会议，**最新在前**。 */
      readonly meetings: readonly RoomMeetingLine[]
    }
  | { readonly ok: false; readonly code: 'no-such-room' | 'not-a-member'; readonly reason: string }

/**
 * 实时会议视图：**正在开**的那场会。
 *
 * 与 {@link ConsoleRoomDetail} 的分工是刻意的：detail 回答"这个房间开过什么"，
 * 本视图回答"这场会现在开到哪了"。会议是几十秒的多轮过程，
 * 只有散会后的记录的话，用户全程只能猜——那就是"看不到会议过程"。
 *
 * `ok: false` 不是错误：没有会正在开、或观察者无权看，都是正常分支。
 */
export type ConsoleLiveView =
  | { readonly ok: true; readonly meeting: ActiveMeetingView }
  | { readonly ok: false; readonly reason: string }

export type ConsoleActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AdmissionCode | 'no-such-room' | 'duplicate-room' | 'not-a-member'; readonly reason: string }

/**
 * 会议室运行时（编排器）的窄端口。
 *
 * 为什么入会/退出必须同时动编排器：`RoomRegistry` 只管"谁在哪个房间"（会籍、
 * 可持久化）；而"能不能被叫到、能不能发言"取决于编排器的成员名册。
 * 只登记会籍而没进名册，会得到一个"在名单上却叫不到"的僵尸成员。
 */
export interface RoomRuntimePort {
  convene(call: RoomMeetingCall): Promise<RoomMeetingRecord>
  activeRoom(): { readonly id: string } | undefined
  /** 当前进行中会议的实时快照（面板"会议进行中"视图用）；没有则 undefined。 */
  activeMeeting(): ActiveMeetingView | undefined
  /** 把一个会话登记进会议室名册。 */
  enroll(spec: { readonly id: string; readonly title: string; readonly domain: string; readonly workspace?: string | undefined; readonly model?: string | undefined }): void
  /** 退出时同步缩编名册。返回 `'busy'` 表示它在会中，不能摘。 */
  forget(sessionId: string): 'ok' | 'busy' | 'absent'
  /** 成员状态机当前状态，供面板显示"谁在忙、谁空闲"。 */
  stateOf(sessionId: string): string | undefined
}

/** 候选会话的来源（宿主从 `ctx.sessions` 读）。 */
export interface CandidateSource {
  list(): readonly SessionCandidate[]
}

export interface MeetingConsoleOptions {
  readonly registry: RoomRegistry
  readonly minutes: RoomMinutesStore
  readonly candidates: CandidateSource
  readonly runtime: RoomRuntimePort
  readonly now?: (() => number) | undefined
}

/** 只有人类观察者可以看全量；会话只能看自己加入的房间。 */
function seesEverything(viewerId: string): boolean {
  return viewerId === HUMAN_PARTICIPANT
}

export class MeetingConsole {
  private readonly registry: RoomRegistry
  private readonly minutes: RoomMinutesStore
  private readonly candidates: CandidateSource
  private readonly runtime: RoomRuntimePort
  private readonly now: () => number

  constructor(options: MeetingConsoleOptions) {
    this.registry = options.registry
    this.minutes = options.minutes
    this.candidates = options.candidates
    this.runtime = options.runtime
    this.now = options.now ?? (() => Date.now())
  }

  // --- 读 -----------------------------------------------------------------

  /** 观察者当前所在的房间 id（没有会籍则为空数组）。 */
  private roomIdsOf(sessionId: string): readonly string[] {
    const entity = this.registry.roomOf(sessionId)
    return entity === undefined ? [] : [entity.id]
  }

  /** 房间总览。默认按观察者过滤可见内容。 */
  overview(viewerId: string): ConsoleOverview {
    const all = seesEverything(viewerId)
    const myRoomIds = this.roomIdsOf(viewerId)
    const index = this.minutes.indexByRoom()
    const rooms: ConsoleRoomView[] = this.registry.list().map((room) => {
      const mine = myRoomIds.includes(room.id)
      if (!all && !mine) {
        // 非成员只看得到"存在、叫什么、你没在里面"。
        return { id: room.id, name: room.name, mine: false }
      }
      const entries = index.get(room.id) ?? []
      return {
        id: room.id,
        name: room.name,
        mine,
        members: room.members.map((member) => this.memberView(member)),
        meetingCount: entries.length,
        ...(entries[0] === undefined ? {} : { lastMeetingAt: entries[0].at }),
      }
    })
    return { rooms, myRoomIds }
  }

  /** 单个房间详情（含历次会议正文）。非成员一律拒绝。 */
  detail(roomId: string, viewerId: string): ConsoleRoomDetail {
    const room = this.registry.room(roomId)
    if (room === undefined) {
      return { ok: false, code: 'no-such-room', reason: `会议室 ${roomId} 不存在。` }
    }
    const mine = this.roomIdsOf(viewerId).includes(roomId)
    if (!seesEverything(viewerId) && !mine) {
      return {
        ok: false,
        code: 'not-a-member',
        reason:
          `你不是会议室 ${roomId} 的成员，看不到它的成员名单与会议内容。` +
          '需要先被加入这个会议室。',
      }
    }
    const entries = this.minutes.read(roomId)
    return {
      ok: true,
      room: {
        id: room.id,
        name: room.name,
        mine,
        members: room.members.map((member) => this.memberView(member)),
        meetingCount: entries.length,
        ...(entries[0] === undefined ? {} : { lastMeetingAt: entries[0].at }),
      },
      meetings: entries,
    }
  }

  /**
   * 当前正在开的会议（实时视图）。
   *
   * 可见性口径与 {@link detail} 完全一致：人类看全部；会话只能看
   * **自己加入的房间**正在进行的那场。非成员连"开到哪了"都看不到——
   * 会籍是权限边界，围观权也是边界的一部分。
   *
   * 没有会正在开时 `ok: false` 且带理由——这是正常分支
   * （面板多数轮询都会落在这里），不是错误。
   */
  liveMeeting(viewerId: string): ConsoleLiveView {
    const meeting = this.runtime.activeMeeting()
    if (meeting === undefined) {
      return { ok: false, reason: '当前没有正在进行的会议。' }
    }
    if (!seesEverything(viewerId) && !this.roomIdsOf(viewerId).includes(meeting.roomId)) {
      return {
        ok: false,
        reason: `会议室 ${meeting.roomId} 的会议正在进行，但你不是它的成员，看不到会议内容。`,
      }
    }
    return { ok: true, meeting }
  }

  /** 某个房间的候选会话：能加的 / 加不了的（附理由）。面板直接渲染这个。 */
  candidatesFor(roomId: string, operation: MembershipOperation = 'join'): {
    readonly admittable: readonly SessionCandidate[]
    readonly rejected: readonly { readonly candidate: SessionCandidate; readonly reason: string; readonly code: AdmissionCode }[]
  } {
    return partitionCandidates({
      candidates: this.candidates.list(),
      roomId,
      roomOf: (sessionId) => this.registry.roomOf(sessionId)?.id,
      operation,
    })
  }

  // --- 写（人类操作；走准入策略）------------------------------------------

  createRoom(input: { readonly id: string; readonly name?: string | undefined }): ConsoleActionResult {
    if (this.registry.room(input.id) !== undefined) {
      return { ok: false, code: 'duplicate-room', reason: `会议室 ${input.id} 已经存在。` }
    }
    this.registry.createRoom({ id: input.id, name: input.name ?? input.id })
    return { ok: true }
  }

  /**
   * 把一个会话加入会议室。
   *
   * 准入由 {@link admitSession} 决定——**面板与工具走的是同一条判据**。
   * 关键约束：入会要往该会话的工具集里装东西，所以它必须是**非活动**状态。
   */
  addSession(roomId: string, sessionId: string): ConsoleActionResult {
    if (this.registry.room(roomId) === undefined) {
      return { ok: false, code: 'no-such-room', reason: `会议室 ${roomId} 不存在。` }
    }
    const verdict = this.admit(roomId, sessionId, 'join')
    if (!verdict.ok) return verdict
    const candidate = this.findCandidate(sessionId)
    this.registry.join({
      sessionId,
      roomId,
      workspace: candidate?.workspace ?? 'default',
      model: candidate?.model,
    })
    // 会籍与名册必须一起动，否则会出现"在名单上却叫不到"的僵尸成员。
    this.runtime.enroll({
      id: sessionId,
      title: candidate?.title ?? sessionId,
      domain: candidate?.workspace ?? 'default',
      ...(candidate?.workspace === undefined ? {} : { workspace: candidate.workspace }),
      ...(candidate?.model === undefined ? {} : { model: candidate.model }),
    })
    return { ok: true }
  }

  /** 让一个会话退出会议室。与入会同属"改它工具集"的动作，同样要求非活动。 */
  removeSession(roomId: string, sessionId: string): ConsoleActionResult {
    const verdict = this.admit(roomId, sessionId, 'leave')
    if (!verdict.ok) return verdict
    // 名册先摘：正在会中的成员不能摘，否则会挖空一场进行中的会议。
    if (this.runtime.forget(sessionId) === 'busy') {
      return {
        ok: false,
        code: 'not-a-member',
        reason: `会话 ${sessionId} 正在会议中，不能退出；等这场会议散会后再操作。`,
      }
    }
    this.registry.leave(sessionId)
    return { ok: true }
  }

  // --- 召集 ---------------------------------------------------------------

  /**
   * 召集一场会议，并只回**调用者自己那份记要**。
   *
   * 这就是需求里那个"按钮"：按下去得到会议纪要，中间过程不必告诉它。
   *
   * @param roomId - 要开会的会议室。
   * @param calledBy - 召集者（成员 id 或 `human`）。非成员没有召集权。
   */
  async convene(input: {
    readonly roomId: string
    readonly calledBy: string
    readonly reason: string
    readonly scope?: 'local' | 'global' | undefined
    readonly invitees?: readonly string[] | undefined
  }): Promise<
    | {
        readonly ok: true
        readonly meetingId: string
        readonly rounds: number
        readonly adjournedReason: string
        readonly attended: readonly string[]
        readonly absent: readonly string[]
        /** 召集者自己那份纪要。缺席或非成员时为 undefined。 */
        readonly myNote?: { readonly text: string; readonly chars: number } | undefined
      }
    | { readonly ok: false; readonly code: string; readonly reason: string }
  > {
    if (this.registry.room(input.roomId) === undefined) {
      return { ok: false, code: 'no-such-room', reason: `会议室 ${input.roomId} 不存在。` }
    }
    if (!seesEverything(input.calledBy) && !this.registry.isMember(input.calledBy)) {
      return {
        ok: false,
        code: 'not-a-member',
        reason:
          `会话 ${input.calledBy} 不是会议室 ${input.roomId} 的成员，没有召集权。` +
          '只有加入了会议室的会话才能唤起会议。',
      }
    }
    const scope = input.scope ?? 'global'
    if (scope === 'local' && (input.invitees === undefined || input.invitees.length === 0)) {
      return { ok: false, code: 'local-needs-invitees', reason: '小会必须显式点名至少一位成员。' }
    }
    try {
      const record = await this.runtime.convene({
        roomId: input.roomId,
        calledBy: input.calledBy,
        reason: input.reason,
        scope,
        ...(input.invitees === undefined ? {} : { invitees: input.invitees }),
      })
      const mine = record.notes.find((note) => note.participant === input.calledBy)
      return {
        ok: true,
        meetingId: record.room.id,
        rounds: record.rounds,
        adjournedReason: record.adjournedReason,
        attended: [...record.summoned],
        absent: [...record.absent],
        ...(mine === undefined ? {} : { myNote: { text: mine.text, chars: mine.chars } }),
      }
    } catch (error) {
      return {
        ok: false,
        code: 'convene-failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // --- 内部 ---------------------------------------------------------------

  private admit(roomId: string, sessionId: string, operation: MembershipOperation): Admission {
    return admitSession({
      candidate: this.findCandidate(sessionId),
      roomId,
      currentRoomId: this.registry.roomOf(sessionId)?.id,
      operation,
    })
  }

  private findCandidate(sessionId: string): SessionCandidate | undefined {
    return this.candidates.list().find((candidate) => candidate.sessionId === sessionId)
  }

  private memberView(member: RoomMember): ConsoleMemberView {
    const state = this.runtime.stateOf(member.sessionId)
    // 成员也是会话，所以标题与候选列表**同源**（`ctx.sessions` + `sessionTitle`）。
    // 走候选列表而不是再读一次上游：一份数据源，两条视图不会漂移。
    const title = this.findCandidate(member.sessionId)?.title
    return {
      sessionId: member.sessionId,
      ...(title === undefined ? {} : { title }),
      ...(member.workspace === undefined ? {} : { workspace: member.workspace }),
      ...(member.model === undefined ? {} : { model: member.model }),
      ...(state === undefined ? {} : { state }),
    }
  }
}

export type { MeetingRoomEntity }
