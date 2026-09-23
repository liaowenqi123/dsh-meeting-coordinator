/**
 * 安装前静态校验：**不执行任何插件代码**，只用 dsh-std 的纯函数算出兼容性。
 *
 * 运行：`pnpm run check:manifest`
 *
 * 这直接兑现 README 里承诺的 "Know Before Installing (No crash roulette)"：
 * 市场、宿主与 CI 可以在毫秒级判断这份清单能不能装，而不是装完再炸。
 *
 * 用到的三个纯函数来自 `@dsh-std/manifest`：
 *   `parseManifest`            解析包根 dsh-plugin.json（不联网、不取 schema）
 *   `projectManifest`          投影成宿主组合模型（ComponentManifest）
 *   `ManifestDefinitionCatalog.validate`  逐 facet 校验并产出机器可读报告
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ProtocolCatalog } from '@dsh-std/core'
import {
  ManifestDefinitionCatalog,
  parseManifest,
  projectManifest,
  type ComponentManifest,
  type ManifestValidationReport,
  type PluginManifest,
} from '@dsh-std/manifest'
import { facetModuleActivationDefinition } from '@dsh-std/lifecycle'
import { briefingBoardProtocol, BRIEFING_BOARD_KIND, MEETING_API_VERSION } from '../protocol/meeting-protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(here, '..', '..', 'dsh-plugin.json')

function buildProtocolCatalog(): ProtocolCatalog {
  const catalog = new ProtocolCatalog({ name: 'dsh-meeting-coordinator', version: '0.1.0' })
  // 注册本插件自己的协议 definition。不注册它会得到 `unknown-protocol` 警告 ——
  // 这正是"安装前可知兼容性"要暴露的信息：宿主不认识这份坐标就不能协商它。
  catalog.register(briefingBoardProtocol)
  return catalog
}

function buildManifestCatalog(): ManifestDefinitionCatalog {
  const catalog = new ManifestDefinitionCatalog()
  // v0.15 的 facet activation 恒为 lifecycle.dsh/v1alpha1 + FacetModule，
  // 直接复用 dsh-std lifecycle 导出的真实 validator，不自建 driver。
  catalog.registerActivation(facetModuleActivationDefinition)
  return catalog
}

function report(label: string, value: PluginManifest | ComponentManifest): void {
  console.log(`\n=== ${label} ===`)
  console.log(JSON.stringify(value, null, 2))
}

function printValidation(reportValue: ManifestValidationReport): void {
  console.log('\n=== 校验报告 ===')
  console.log(`source     : ${reportValue.source}`)
  console.log(`digest     : ${reportValue.digest}`)
  console.log(`plugin     : ${reportValue.manifest.name}@${reportValue.manifest.version}`)
  console.log(`compatible : ${reportValue.compatible ? 'YES' : 'NO'}`)
  if (reportValue.issues.length === 0) {
    console.log('issues     : (无)')
    return
  }
  console.log('issues     :')
  for (const issue of reportValue.issues) {
    console.log(`  [${issue.severity}] ${issue.code} @ ${issue.path} — ${issue.message}`)
  }
}

function main(): void {
  const source = readFileSync(manifestPath, 'utf8')

  // 1) 纯静态解析：不执行插件代码、不联网。
  const manifest = parseManifest(source, { source: manifestPath })
  report('parseManifest -> Community v0.15 清单', manifest)

  // 2) 投影成宿主组合模型（facets / activation / protocols 的形状在这一层才出现）。
  const component = projectManifest(manifest)
  report('projectManifest -> 宿主组合模型', component)

  // 3) 结合 protocol catalog 做兼容性校验。
  const validation = buildManifestCatalog().validate(component, buildProtocolCatalog(), {
    source: manifestPath,
  })
  printValidation(validation)

  const declared = new Set(
    (manifest.requires?.contracts ?? []).map((contract) => `${contract.apiVersion}/${contract.kind}`),
  )
  const expected = `${MEETING_API_VERSION}/${BRIEFING_BOARD_KIND}`
  if (!declared.has(expected)) {
    throw new Error(`清单没有声明自己的协议坐标 ${expected}。`)
  }
  console.log(`\n已声明协议坐标: ${[...declared].sort().join(', ')}`)

  if (!validation.compatible) {
    throw new Error('清单校验未通过：存在 error 级 issue。')
  }
  console.log('\n✓ 清单静态校验通过：宿主可在不运行本插件任何代码的前提下判定兼容性。')
}

try {
  main()
} catch (error) {
  console.error('\n✗ 清单校验失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
}
