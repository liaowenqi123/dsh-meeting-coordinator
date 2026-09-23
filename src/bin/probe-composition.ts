/**
 * 诊断脚本：打印真实的组合计划，用来确认 facet 激活顺序与 provider/consumer 关系。
 * 不属于交付物，但与 `pnpm run verify` 一起保留，便于日后排查宿主装配问题。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryAgentRuntime } from '../adapters/in-memory-runtime.js'
import { RoundRobinModerator } from '../adapters/moderators.js'
import { ScriptedMeetingVoice } from '../adapters/scripted-voice.js'
import { activateMeetingHost } from '../host.js'
import type { AgentSlotSpec } from '../core/types.js'

const SLOTS: readonly AgentSlotSpec[] = [
  { id: 'neural-net', domain: 'neural-net', title: '神经网络', systemPrompt: '只做网络结构。', workspace: 'lab' },
  { id: 'live-trading', domain: 'live-trading', title: '实盘', systemPrompt: '只做滑点与仓位。', workspace: 'live' },
]

const root = mkdtempSync(join(tmpdir(), 'dsh-meeting-probe-'))
try {
  const runtime = new InMemoryAgentRuntime()
  const host = await activateMeetingHost({
    slots: SLOTS,
    runtime,
    // 组合探针只关心 facet 装配，因此用不打模型的替身。
    voice: new ScriptedMeetingVoice({
      scripts: Object.fromEntries(SLOTS.map((slot) => [slot.id, { speeches: ['探针发言'], reflect: () => '探针纪要' }])),
    }),
    moderator: new RoundRobinModerator(),
    boardDomain: 'quant',
    rootDir: root,
    onPlan: (plan) => {
      console.log('compatible:', plan.compatible)
      console.log('activationOrder:')
      for (const key of plan.activationOrder) console.log('  ', key)
      console.log('selected:')
      for (const row of plan.selected) {
        console.log('  ', row.identity.component, '|', row.identity.facet, '| driver=', row.driver?.id)
      }
      console.log('skipped:', JSON.stringify(plan.skipped, null, 2))
      console.log('issues:', JSON.stringify(plan.issues, null, 2))
    },
  })
  console.log('activated:', host.activated)
  await host.shutdown()
} catch (error) {
  console.error('probe failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
