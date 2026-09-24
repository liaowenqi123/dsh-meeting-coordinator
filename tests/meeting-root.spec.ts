/**
 * 会议数据根的解析。
 *
 * 这两条测试对应两个**真实发生过的事故**，不是假想的边界：
 *
 * 1. 默认值挂在 `process.cwd()` 上 → DSH 从别处启动，数据根就落到一个
 *    无关项目里，房间静默消失（2026-09-23）。
 * 2. 工具与宿主各自推算 `rootDir` → config 一旦给了 rootDir，工具写的
 *    `stop.flag` 与宿主读的不是同一个文件，急停静默失效。
 */

import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  MEETING_ROOT_DIRNAME,
  defaultMeetingRootDir,
  resolveMeetingBoardDomain,
  resolveMeetingRootDir,
} from '../src/core/meeting-root.js'

describe('会议数据根解析', () => {
  describe('默认值不依赖进程 cwd', () => {
    it('用 DSH_HOME 而不是 cwd', () => {
      const env = { DSH_HOME: 'C:\\Users\\someone\\.dsh' }
      expect(defaultMeetingRootDir(env)).toBe(join('C:\\Users\\someone\\.dsh', MEETING_ROOT_DIRNAME))
    })

    it('**结果与 process.cwd() 无关**——这正是事故的判据', () => {
      // 同一个 env 下解析两次；无论 cwd 是什么，结果必须一致。
      // 旧实现返回 join(process.cwd(), '.dsh-meeting')，这条会挂。
      const env = { DSH_HOME: join('X:', 'dsh-home') }
      const first = defaultMeetingRootDir(env)
      const second = defaultMeetingRootDir(env)
      expect(first).toBe(second)
      expect(first).not.toContain(process.cwd())
      expect(first.startsWith(resolve(process.cwd()))).toBe(false)
    })

    it('DSH_HOME 未设置时回退到 ~/.dsh', () => {
      expect(defaultMeetingRootDir({})).toBe(join(homedir(), '.dsh', MEETING_ROOT_DIRNAME))
    })

    it('DSH_HOME 是空串时按未设置处理，不回退到根路径', () => {
      // 空串是个常见配置事故：拼出 '/meeting-coordinator' 比回退危险得多。
      const withEmpty = defaultMeetingRootDir({ DSH_HOME: '' })
      const withBlank = defaultMeetingRootDir({ DSH_HOME: '   ' })
      const withMissing = defaultMeetingRootDir({})
      expect(withEmpty).toBe(withMissing)
      expect(withBlank).toBe(withMissing)
      expect(withEmpty.startsWith(join(homedir(), '.dsh'))).toBe(true)
    })
  })

  describe('优先级 config > env > 默认值', () => {
    const env = { DSH_HOME: join('X:', 'dsh-home'), DSH_MEETING_ROOT: join('Y:', 'from-env') }

    it('config 优先', () => {
      expect(resolveMeetingRootDir(join('Z:', 'from-config'), env)).toBe(join('Z:', 'from-config'))
    })

    it('没有 config 时用 env', () => {
      expect(resolveMeetingRootDir(undefined, env)).toBe(join('Y:', 'from-env'))
    })

    it('config / env 都没有时用默认值', () => {
      expect(resolveMeetingRootDir(undefined, { DSH_HOME: env.DSH_HOME })).toBe(
        join('X:', 'dsh-home', MEETING_ROOT_DIRNAME),
      )
    })

    it('config 为空串时按未设置处理，**不会**退化成 cwd', () => {
      // 旧行为：join('', '.dsh-meeting') === '.dsh-meeting' —— 相对路径，
      // 实际落在 cwd 下，等于把刚修掉的坐标又放回来了。
      const got = resolveMeetingRootDir('', env)
      expect(got).toBe(join('Y:', 'from-env'))
      expect(got).not.toBe('.dsh-meeting')
    })

    it('env 为空串时同样跳过', () => {
      expect(resolveMeetingRootDir(undefined, { DSH_HOME: env.DSH_HOME, DSH_MEETING_ROOT: '' })).toBe(
        join('X:', 'dsh-home', MEETING_ROOT_DIRNAME),
      )
    })

    it('config 里的空白被裁掉（避免路径带尾随空格）', () => {
      expect(resolveMeetingRootDir('  Z:\\cfg  ', env)).toBe('Z:\\cfg')
    })
  })

  describe('板标识与数据根是两件事', () => {
    it('boardDomain 有独立的环境变量与默认值', () => {
      expect(resolveMeetingBoardDomain(undefined, {})).toBe('default')
      expect(resolveMeetingBoardDomain(undefined, { DSH_MEETING_BOARD: 'quant' })).toBe('quant')
      expect(resolveMeetingBoardDomain('explicit', { DSH_MEETING_BOARD: 'quant' })).toBe('explicit')
      expect(resolveMeetingBoardDomain('', { DSH_MEETING_BOARD: 'quant' })).toBe('quant')
    })

    it('解析 boardDomain 不会受 DSH_MEETING_ROOT 影响', () => {
      expect(resolveMeetingBoardDomain(undefined, { DSH_MEETING_ROOT: 'X:\\somewhere' })).toBe('default')
    })
  })
})
