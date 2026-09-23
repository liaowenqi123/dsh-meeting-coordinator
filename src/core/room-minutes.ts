/**
 * 会议室会议记录：**落盘**与读回。
 *
 * ## 为什么必须落盘（这是一个被发现的真实缺口）
 *
 * 原先 `MeetingOrchestrator` 把会议记录只推进一个内存数组
 * （`this.history.push(record)`）。后果是：**进程重启即丢，一条都留不下**。
 *
 * 而"会议室面板"要给人看的东西恰恰是"这个房间开过第 1、2、3 次会议、
 * 每次都说了什么"。没有落盘，面板能渲染出来的只有空列表。
 *
 * ## 记什么、不记什么
 *
 * 记 **完整 transcript**（每条 `MeetingTurn` 的 speaker / kind / round / text）
 * 与**每人各自的纪要**。理由：这是"可审计"的落点——
 * 面板要能回答"这次会是谁开的、谁到场、谁没来、谁说了什么、
 * 会后每个人各自记住了什么"。纪要每人不同正是本项目的核心主张之一，
 * 不记下来就无从验证。
 *
 * **入场引导（`kind === 'entry'`）里的记忆投影也一并记下**，
 * 因为它是"会上到底给了这位成员什么私有信息"的唯一证据，
 * 出了上下文污染争议时要靠它自证。
 *
 * ## 与 `meetings.jsonl`（轻量路径）的区别
 *
 * 轻量路径的 `meetings.jsonl` 记的是"简报汇总 + 投递结果"，零模型调用；
 * 这里记的是**正式会议室的整场会**。两者刻意分开：
 * 一个是节律心跳，一个是正式会议，混在一个文件里会互相淹没。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingTurn, MeetingTurnKind } from './meeting-room.js'
import type { RoomMeetingRecord } from './room-orchestrator.js'

/** 一条会议记录的落盘形态。字段名刻意短：这是追加式日志，会一直长。 */
export interface RoomMeetingLine {
  readonly v: 1
  readonly roomId: string
  readonly meetingId: string
  readonly at: number
  readonly calledBy: string
  readonly scope: 'local' | 'global'
  readonly reason: string
  readonly summoned: readonly string[]
  readonly deferred: readonly string[]
  readonly admittedLate: readonly string[]
  readonly absent: readonly string[]
  readonly rounds: number
  readonly adjournedReason: string
  readonly transcript: readonly {
    readonly seq: number
    readonly round: number
    readonly speaker: string
    readonly kind: MeetingTurnKind
    readonly text: string
    readonly at: number
  }[]
  /** 每人各自的纪要。**内容应当互不相同。** */
  readonly notes: readonly { readonly participant: string; readonly text: string; readonly chars: number }[]
}

/** 索引行（给面板的"历次会议"列表，不含 transcript 正文）。 */
export interface RoomMeetingIndexEntry {
  readonly meetingId: string
  readonly at: number
  readonly rounds: number
  readonly participated: number
  readonly adjournedReason: string
}

export interface RoomMinutesLogOptions {
  readonly rootDir: string
  readonly now?: (() => number) | undefined
}

/**
 * 会议记录的落点。
 *
 * 定义成窄接口而不是直接用 `RoomMinutesLog`：编排器只该知道"把记录交出去"，
 * 不该知道文件在哪、格式如何。测试也就能用一个数组替身当场断言。
 */
export interface RoomMinutesSink {
  /** 开会立刻落一行（会议 header）。 */
  beginMeeting(roomId: string, header: MeetingHeader): void
  /** **每条 turn 立刻落一行**。这是"开一半就得落盘"的落点。 */
  appendTurn(roomId: string, meetingId: string, turn: MeetingTurnRecord): void
  /** 散会时汇总落一行（供面板读），并清掉进行中转录。 */
  write(roomId: string, record: RoomMeetingRecord): void
}

/** 开会时就落盘的 header（供崩溃恢复重建会议元数据）。 */
export interface MeetingHeader {
  readonly meetingId: string
  readonly at: number
  readonly calledBy: string
  readonly scope: 'local' | 'global'
  readonly reason: string
  readonly summoned: readonly string[]
  readonly deferred: readonly string[]
}

/** 一条 turn 的落盘形态（`MeetingTurn` 的短字段版）。 */
export interface MeetingTurnRecord {
  readonly seq: number
  readonly round: number
  readonly speaker: string
  readonly kind: MeetingTurnKind
  readonly text: string
  readonly at: number
}

/**
 * 可读可写的会议记录（面板需要读，编排器只需要写）。
 *
 * 拆成两个接口是刻意的：编排器只该拿到 `RoomMinutesSink`（写），
 * 面板拿到 `RoomMinutesStore`（读写）。能力给窄了，误用就少了。
 */
export interface RoomMinutesStore extends RoomMinutesSink {
  readonly path: string
  read(roomId: string, limit?: number | undefined): readonly RoomMeetingLine[]
  readAll(): readonly RoomMeetingLine[]
  indexByRoom(): ReadonlyMap<string, readonly RoomMeetingIndexEntry[]>
  /**
   * 把**半途死掉**的会议从实时转录补写进 `room-meetings.jsonl`，然后清掉转录。
   *
   * 应当在插件装载时调用一次。没有它，崩溃前那些"进行中"的转录永远停在 live 目录里，
   * 面板看不到它们，也就等于"这场会没开过"。
   */
  reconcileLive(): readonly string[]
}

export class RoomMinutesCorrupted extends Error {
  readonly code = 'meeting/room-minutes-corrupted'

  constructor(message: string) {
    super(message)
    this.name = 'RoomMinutesCorrupted'
  }
}

/**
 * 追加式房间会议日志。
 *
 * 追加式（而不是每次重写全量）的理由与简报板一致：单次 `appendFileSync`
 * 在 O_APPEND 语义下对小记录是原子的，多进程/多次运行不会互相撕碎记录。
 */
export class RoomMinutesLog implements RoomMinutesStore {
  private readonly dir: string
  private readonly filePath: string
  private readonly liveDir: string
  private readonly now: () => number

  constructor(options: RoomMinutesLogOptions) {
    this.dir = options.rootDir
    this.filePath = join(this.dir, 'room-meetings.jsonl')
    // 进行中的转录：每条 turn 立刻写这里，崩溃后可恢复。
    this.liveDir = join(this.dir, 'live')
    this.now = options.now ?? (() => Date.now())
  }

  get path(): string {
    return this.filePath
  }

  private livePath(meetingId: string): string {
    // meetingId 是我们自己生成的（`room-N-<roomId>`），但仍做一次安全映射，
    // 防止将来 roomId 里带路径分隔符时逃出 liveDir。
    const safe = meetingId.replace(/[^A-Za-z0-9._-]/g, '_')
    return join(this.liveDir, `${safe}.jsonl`)
  }

  /**
   * 开会立刻落一行。
   *
   * **必须在第一轮发言之前调用**：这样即使第一条发言就崩，
   * 至少能知道"这场会开过、谁被召集了"。
   */
  beginMeeting(roomId: string, header: MeetingHeader): void {
    if (!existsSync(this.liveDir)) mkdirSync(this.liveDir, { recursive: true })
    appendFileSync(this.livePath(header.meetingId), `${JSON.stringify({ v: 1, t: 'header', roomId, ...header })}\n`, {
      encoding: 'utf8',
      flag: 'a',
    })
  }

  /**
   * **每条 turn 立刻落一行**。
   *
   * 这是"开一半就得落盘"的落点。不要攒起来等散会——
   * 强杀进程时攒着的全丢，正是用户抱怨的"整个会议还会直接消失"。
   */
  appendTurn(roomId: string, meetingId: string, turn: MeetingTurnRecord): void {
    if (!existsSync(this.liveDir)) mkdirSync(this.liveDir, { recursive: true })
    appendFileSync(this.livePath(meetingId), `${JSON.stringify({ v: 1, t: 'turn', roomId, ...turn })}\n`, {
      encoding: 'utf8',
      flag: 'a',
    })
  }

  /** 落一次正式会议。`roomId` 由编排器给出——会议 id 里嵌着它，但不该靠解析得到。 */
  write(roomId: string, record: RoomMeetingRecord): void {
    const line = this.toLine(roomId, record)
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    appendFileSync(this.filePath, `${JSON.stringify(line)}\n`, { encoding: 'utf8', flag: 'a' })
    // 汇总已落盘，进行中的转录就可以退役了。
    rmSync(this.livePath(record.room.id), { force: true })
  }

  /** 纯转换，便于测试单独断言落盘形态。 */
  toLine(roomId: string, record: RoomMeetingRecord): RoomMeetingLine {
    const room = record.room
    return {
      v: 1,
      roomId,
      meetingId: room.id,
      at: this.now(),
      calledBy: record.calledBy,
      scope: room.scope,
      reason: room.reason,
      summoned: [...record.summoned],
      deferred: [...record.deferred],
      admittedLate: [...record.admittedLate],
      absent: [...record.absent],
      rounds: record.rounds,
      adjournedReason: record.adjournedReason,
      transcript: room.transcript.map((turn: MeetingTurn) => ({
        seq: turn.seq,
        round: turn.round,
        speaker: turn.speaker,
        kind: turn.kind,
        text: turn.text,
        at: turn.at,
      })),
      notes: record.notes.map((note) => ({ participant: note.participant, text: note.text, chars: note.chars })),
    }
  }

  /**
   * 读某个房间的历次会议，**最新的在前**。
   *
   * @param roomId - 房间 id。
   * @param limit - 最多返回多少场；缺省全部。
   */
  read(roomId: string, limit?: number | undefined): readonly RoomMeetingLine[] {
    const all = this.readAll().filter((line) => line.roomId === roomId)
    const newestFirst = [...all].reverse()
    return limit === undefined ? newestFirst : newestFirst.slice(0, limit)
  }

  /** 全部记录（用于面板的总览与计数）。 */
  readAll(): readonly RoomMeetingLine[] {
    if (!existsSync(this.filePath)) return []
    const text = readFileSync(this.filePath, 'utf8')
    const out: RoomMeetingLine[] = []
    for (const raw of text.split('\n')) {
      const trimmed = raw.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        throw new RoomMinutesCorrupted(`会议记录 ${this.filePath} 存在无法解析的行：${trimmed.slice(0, 120)}`)
      }
      if (typeof parsed !== 'object' || parsed === null) {
        throw new RoomMinutesCorrupted(`${this.filePath} 含非对象记录。`)
      }
      const record = parsed as Partial<RoomMeetingLine>
      if (record.v !== 1) {
        throw new RoomMinutesCorrupted(`${this.filePath} 含未知记录版本 ${JSON.stringify(record.v)}。`)
      }
      out.push(record as RoomMeetingLine)
    }
    return out
  }

  /** 每个房间的会议索引（不含 transcript 正文，面板列表用）。 */
  indexByRoom(): ReadonlyMap<string, readonly RoomMeetingIndexEntry[]> {
    const grouped = new Map<string, RoomMeetingIndexEntry[]>()
    for (const line of this.readAll()) {
      const bucket = grouped.get(line.roomId) ?? []
      bucket.push({
        meetingId: line.meetingId,
        at: line.at,
        rounds: line.rounds,
        participated: line.summoned.length,
        adjournedReason: line.adjournedReason,
      })
      grouped.set(line.roomId, bucket)
    }
    // 每个房间内部也按时间倒序，与 read() 一致。
    return new Map([...grouped].map(([roomId, entries]) => [roomId, [...entries].reverse()]))
  }

  /**
   * 把**半途死掉**的会议从实时转录补写进 `room-meetings.jsonl`，然后清掉转录。
   *
   * 这就是"开一半就得落盘"的兑现：即使进程被强杀，已经发生的发言一条都不少，
   * 只是这场会没有散会纪要。补写的记录会标注
   * `adjournedReason: '进程中断；会议记录从实时转录恢复'`，
   * 让人一眼看出它不是一场正常结束的会。
   *
   * @returns 被恢复的会议 id 列表。
   */
  reconcileLive(): readonly string[] {
    if (!existsSync(this.liveDir)) return []
    const recovered: string[] = []
    for (const name of readdirSync(this.liveDir)) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(this.liveDir, name)
      let header: (MeetingHeader & { roomId: string }) | undefined
      const transcript: MeetingTurnRecord[] = []
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        const trimmed = raw.trim()
        if (trimmed.length === 0) continue
        let row: Record<string, unknown>
        try {
          row = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          // 尾部残行（写入被中断）忽略；中间损坏的行跳过而不是让整场会报废。
          continue
        }
        if (row['t'] === 'header') {
          header = row as unknown as MeetingHeader & { roomId: string }
        } else if (row['t'] === 'turn') {
          transcript.push(row as unknown as MeetingTurnRecord)
        }
      }
      const meetingId = header?.meetingId ?? name.replace(/\.jsonl$/, '')
      const roomId = header?.roomId ?? 'unknown'
      const maxRound = transcript.reduce((max, turn) => Math.max(max, turn.round), 0)
      const line: RoomMeetingLine = {
        v: 1,
        roomId,
        meetingId,
        at: header?.at ?? this.now(),
        calledBy: header?.calledBy ?? 'unknown',
        scope: header?.scope ?? 'global',
        reason: header?.reason ?? '(会议中断，原因未知)',
        summoned: header?.summoned ?? [],
        deferred: header?.deferred ?? [],
        admittedLate: [],
        absent: [],
        rounds: maxRound,
        adjournedReason: '进程中断；会议记录从实时转录恢复（无散会纪要）',
        transcript: transcript.map((turn) => ({
          seq: turn.seq,
          round: turn.round,
          speaker: turn.speaker,
          kind: turn.kind,
          text: turn.text,
          at: turn.at,
        })),
        notes: [],
      }
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.filePath, `${JSON.stringify(line)}\n`, { encoding: 'utf8', flag: 'a' })
      rmSync(file, { force: true })
      recovered.push(meetingId)
    }
    return recovered
  }
}
