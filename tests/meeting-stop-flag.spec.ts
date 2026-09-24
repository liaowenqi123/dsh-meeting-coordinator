/**
 * 急停闭环：工具写的 `stop.flag` 与宿主读的**必须是同一个文件**。
 *
 * 这是 2026-09-23 查出来的一个静默 bug：`registerMeetingTool` 完全没接
 * `rootDir`，自己算了一遍 `DSH_MEETING_ROOT ?? join(cwd, '.dsh-meeting')`。
 * 于是只要 config 里显式给了 `rootDir`（`cordis.patch.yml` 里就给了），
 * 工具写的标志文件和宿主 `stopRequested` 读的**不是同一个路径**——
 * `stop` 动作返回 `ok: true` 并给出一个看起来正确的路径，
 * 而正在进行的会议毫无反应。**静默失效的急停比没有急停更糟**：
 * 人会以为自己已经叫停了。
 *
 * 这个文件把这个不变量钉死：无论用哪种方式给坐标，两侧都必须落到同一个文件。
 *
 * 另有一个更直接的 bug 也在这里钉住：`action=stop` 曾经被 `roomId` 校验挡在前面，
 * 于是急停**永远走不到自己的分支**，一律返回"需要 roomId"。急停不该要房间。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMeetingTool } from '../src/adapters/dsh-meeting-tool.js'
import { MeetingConsole } from '../src/core/console.js'
import { RoomRegistry } from '../src/core/room-registry.js'
import { RoomMinutesLog } from '../src/core/room-minutes.js'
import { resolveMeetingRootDir } from '../src/core/meeting-root.js'

/** 一个够用的空 console：本文件只关心 stop 分支，不需要真实房间。 */
function emptyConsole(rootDir: string): MeetingConsole {
  return new MeetingConsole({
    registry: new RoomRegistry({ rootDir }),
    minutes: new RoomMinutesLog({ rootDir }),
    candidates: { list: () => [] },
    runtime: {
      convene: () => Promise.reject(new Error('本文件不该召集会议')),
      activeRoom: () => undefined,
      activeMeeting: () => undefined,
      enroll: () => undefined,
      forget: () => 'absent',
      stateOf: () => undefined,
    },
  })
}

describe('急停标志的同源性', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-meeting-stop-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('stop 写出的文件路径 = 宿主 stopRequested 读的路径', async () => {
    // 宿主侧读的就是这一个表达式（src/host.ts 的 stopRequested）。
    const hostReads = join(root, 'stop.flag')
    expect(existsSync(hostReads)).toBe(false)

    const result = (await runMeetingTool({
      console: emptyConsole(root),
      args: { action: 'stop' },
      rootDir: root,
    })) as { ok: boolean; note: string }

    expect(result.ok).toBe(true)
    // 工具**确实**写出了宿主会去读的那个文件——而不是别处的一个同名文件。
    expect(existsSync(hostReads)).toBe(true)
    expect(readFileSync(hostReads, 'utf8').length).toBeGreaterThan(0)
  })

  it('config 显式给了 rootDir 时两侧依然同源（这正是旧实现失效的场景）', async () => {
    // 旧实现：工具忽略 config 里的 rootDir，自己按 env/cwd 另算。
    // 于是 cwd 下的 stop.flag 被写出来，而宿主在看 config 指定的目录。
    const configRoot = join(root, 'config-specified')
    const hostReads = join(configRoot, 'stop.flag')

    const result = (await runMeetingTool({
      console: emptyConsole(root),
      args: { action: 'stop' },
      rootDir: configRoot,
    })) as { ok: boolean; note: string }

    expect(result.ok).toBe(true)
    expect(existsSync(hostReads)).toBe(true)
    // 关键判据：**没有**在 cwd 下另写一个 stop.flag。
    expect(existsSync(join(process.cwd(), 'stop.flag'))).toBe(false)
  })

  it('提示里给出的路径就是真实写入的路径（不该只说个大概）', async () => {
    const result = (await runMeetingTool({
      console: emptyConsole(root),
      args: { action: 'stop' },
      rootDir: root,
    })) as { ok: boolean; note: string }

    expect(result.note).toContain(join(root, 'stop.flag'))
  })

  it('数据根还不存在时会自动创建（stop 不该因目录缺失而失败）', async () => {
    const missing = join(root, 'not-created-yet')
    expect(existsSync(missing)).toBe(false)

    const result = (await runMeetingTool({
      console: emptyConsole(root),
      args: { action: 'stop' },
      rootDir: missing,
    })) as { ok: boolean }

    expect(result.ok).toBe(true)
    expect(existsSync(join(missing, 'stop.flag'))).toBe(true)
  })

  it('stop 不需要 roomId —— 急停不该被房间相关的前置条件挡住', async () => {
    // 旧实现把 roomId 校验写在 stop 分支之前，于是这里会拿到
    // "action=room / convene 需要 roomId"，急停通道整个是死的。
    const result = (await runMeetingTool({
      console: emptyConsole(root),
      args: { action: 'stop' }, // 刻意不给 roomId
      rootDir: root,
    })) as { ok: boolean; note?: string; reason?: string }

    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(existsSync(join(root, 'stop.flag'))).toBe(true)
  })

  it('resolveMeetingRootDir 与工具传入的值一致（解析器是唯一坐标来源）', async () => {
    // 宿主用解析器算 rootDir，再把同一个值传给工具。这里模拟这条链路。
    const env = { DSH_HOME: join(root, 'dsh-home') }
    const hostRoot = resolveMeetingRootDir(undefined, env)

    await runMeetingTool({ console: emptyConsole(root), args: { action: 'stop' }, rootDir: hostRoot })

    expect(existsSync(join(hostRoot, 'stop.flag'))).toBe(true)
    // 而且它落在 DSH_HOME 下，不在 cwd 下。
    expect(hostRoot.startsWith(join(root, 'dsh-home'))).toBe(true)
  })
})
