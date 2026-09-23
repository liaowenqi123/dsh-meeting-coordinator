/**
 * 私有协议 `meeting.dsh/v1alpha1/BriefingBoard` 的协商测试。
 *
 * 重点验证 core 元协议的硬性要求：
 * - 结果与注册顺序无关（确定性）；
 * - 多 provider 歧义必须由**显式 policy** 仲裁；
 * - agreement 必须规范化，否则双方复算不出同一 digest。
 */

import { ProtocolCatalog, defineProtocolDeclaration } from '@dsh-std/core'
import { describe, expect, it } from 'vitest'
import {
  BRIEFING_BOARD_KIND,
  MEETING_API_VERSION,
  briefingBoardProtocol,
  type BriefingBoardAgreement,
  type BriefingBoardNegotiationPolicy,
  type BriefingBoardRequirementSpec,
  type BriefingBoardSupportSpec,
} from '../src/protocol/meeting-protocol.js'

const REF = { apiVersion: MEETING_API_VERSION, kind: BRIEFING_BOARD_KIND }

function supportSpec(overrides: Partial<BriefingBoardSupportSpec> = {}): BriefingBoardSupportSpec {
  return {
    boardDomain: 'quant',
    operations: ['publish', 'read', 'subscribe', 'convene'],
    scopes: ['local', 'global'],
    maxBriefingChars: 200,
    ...overrides,
  }
}

function requirementSpec(overrides: Partial<BriefingBoardRequirementSpec> = {}): BriefingBoardRequirementSpec {
  return { boardDomain: 'quant', operations: ['publish', 'read'], ...overrides }
}

function catalog(): ProtocolCatalog {
  const c = new ProtocolCatalog({ name: 'test', version: '0' })
  c.register(briefingBoardProtocol)
  return c
}

function negotiate(
  requirements: { participant: string; spec: BriefingBoardRequirementSpec }[],
  supports: { participant: string; spec: BriefingBoardSupportSpec }[],
  policy?: BriefingBoardNegotiationPolicy,
) {
  const declarations = [
    ...requirements.map((row) => defineProtocolDeclaration({ participant: { id: row.participant }, requires: [{ ...REF, spec: row.spec }] })),
    ...supports.map((row) => defineProtocolDeclaration({ participant: { id: row.participant }, supports: [{ ...REF, spec: row.spec }] })),
  ]
  return catalog().negotiate(declarations, policy)
}

function agreementOf(report: ReturnType<typeof negotiate>): BriefingBoardAgreement {
  const row = report.protocols.find((p) => p.apiVersion === MEETING_API_VERSION && p.kind === BRIEFING_BOARD_KIND)
  expect(row, '协商报告里应当出现 BriefingBoard').toBeDefined()
  return row?.agreement as BriefingBoardAgreement
}

describe('BriefingBoard 协议协商', () => {
  it('需求与支持匹配时形成 agreement，并规范化为 canonical 顺序', () => {
    const report = negotiate(
      [
        { participant: 'neural-net', spec: requirementSpec({ operations: ['read', 'publish'] }) },
        { participant: 'live-trading', spec: requirementSpec({ operations: ['publish'] }) },
      ],
      [{ participant: 'coordinator', spec: supportSpec() }],
    )

    expect(report.compatible).toBe(true)
    const agreement = agreementOf(report)
    expect(agreement.boardDomain).toBe('quant')
    expect(agreement.coordinator).toBe('coordinator')
    // clients 必须按 code-unit 字典序，与提交顺序无关。
    expect(agreement.clients).toEqual(['live-trading', 'neural-net'])
    // operations 必须按协议定义的 canonical 顺序，而不是提交顺序。
    expect(agreement.operations).toEqual(['publish', 'read'])
    expect(agreement.maxBriefingChars).toBe(200)
  })

  it('多个候选 coordinator 且无 policy 时返回歧义错误，而不是按注册顺序挑一个', () => {
    const report = negotiate(
      [{ participant: 'neural-net', spec: requirementSpec() }],
      [
        { participant: 'coordinator-b', spec: supportSpec() },
        { participant: 'coordinator-a', spec: supportSpec() },
      ],
    )
    expect(report.compatible).toBe(false)
    const issue = report.issues.find((row) => row.code === 'meeting/coordinator-ambiguous')
    expect(issue?.severity).toBe('error')
    // 诊断里必须列出全部候选，便于人来看清为什么有歧义。
    expect(issue?.message).toContain('coordinator-a')
    expect(issue?.message).toContain('coordinator-b')
  })

  it('policy 显式指定 coordinator 后可以消解歧义', () => {
    const report = negotiate(
      [{ participant: 'neural-net', spec: requirementSpec() }],
      [
        { participant: 'coordinator-b', spec: supportSpec() },
        { participant: 'coordinator-a', spec: supportSpec() },
      ],
      { selectCoordinator: 'coordinator-b' },
    )
    expect(report.compatible).toBe(true)
    expect(agreementOf(report).coordinator).toBe('coordinator-b')
  })

  it('coordinator 缺少必需操作时协商失败，并指名缺哪一个', () => {
    const report = negotiate(
      [{ participant: 'neural-net', spec: requirementSpec({ operations: ['publish', 'convene'] }) }],
      [{ participant: 'coordinator', spec: supportSpec({ operations: ['publish', 'read'] }) }],
    )
    expect(report.compatible).toBe(false)
    const issue = report.issues.find((row) => row.code === 'meeting/operation-not-negotiated')
    expect(issue?.message).toContain('convene')
  })

  it('会议规模无交集时协商失败', () => {
    const report = negotiate(
      [{ participant: 'neural-net', spec: requirementSpec({ scopes: ['global'] }) }],
      [{ participant: 'coordinator', spec: supportSpec({ scopes: ['local'] }) }],
    )
    expect(report.compatible).toBe(false)
    expect(report.issues.some((row) => row.code === 'meeting/scope-not-negotiated')).toBe(true)
  })

  it('没有 coordinator 时协商失败', () => {
    const report = negotiate(
      [{ participant: 'neural-net', spec: requirementSpec() }],
      [{ participant: 'other', spec: supportSpec({ boardDomain: '别的板' }) }],
    )
    expect(report.compatible).toBe(false)
    expect(report.issues.some((row) => row.code === 'meeting/board-unavailable')).toBe(true)
  })

  it('简报上限取最严者', () => {
    const report = negotiate(
      [
        { participant: 'a', spec: requirementSpec({ maxBriefingChars: 120 }) },
        { participant: 'b', spec: requirementSpec({ maxBriefingChars: 300 }) },
      ],
      [{ participant: 'coordinator', spec: supportSpec({ maxBriefingChars: 200 }) }],
    )
    expect(agreementOf(report).maxBriefingChars).toBe(120)
  })

  it('一次协商只能服务一块板，多 boardDomain 必须报错', () => {
    const report = negotiate(
      [
        { participant: 'a', spec: requirementSpec({ boardDomain: 'quant' }) },
        { participant: 'b', spec: requirementSpec({ boardDomain: 'nlp' }) },
      ],
      [{ participant: 'coordinator', spec: supportSpec() }],
    )
    expect(report.compatible).toBe(false)
    expect(report.issues.some((row) => row.code === 'meeting/board-domain-conflict')).toBe(true)
  })

  it('requirement 结构非法时 validateRequirement 直接拒绝', () => {
    // 完全省略 spec 是合法的（消费方只说"我需要这块协议"），会补成默认 operation 集。
    expect(briefingBoardProtocol.validateRequirement(undefined, REF)).toEqual({ operations: ['publish', 'read'] })
    // 给了 spec 就必须结构正确。
    expect(() => briefingBoardProtocol.validateRequirement({}, REF)).toThrow(/operations/)
    expect(() =>
      briefingBoardProtocol.validateRequirement({ boardDomain: 'q', operations: ['teleport'] }, REF),
    ).toThrow(/未知操作/)
    expect(() =>
      briefingBoardProtocol.validateRequirement({ boardDomain: 'q', operations: ['publish'], maxBriefingChars: -1 }, REF),
    ).toThrow(/正整数/)
    // boardDomain 可选，但给了就不能是空白。
    expect(() => briefingBoardProtocol.validateRequirement({ boardDomain: '  ', operations: ['publish'] }, REF)).toThrow(
      /boardDomain/,
    )
  })

  it('validateAgreement 拒绝未规范化的 agreement（双方无法复算同一 digest）', () => {
    const bad = {
      boardDomain: 'quant',
      coordinator: 'coordinator',
      clients: ['zzz', 'aaa'], // 未排序
      operations: ['read', 'publish'], // 非 canonical
      optionalOperationsSatisfied: [],
      scopes: ['global', 'local'], // 非 canonical
      maxBriefingChars: 200,
      maxAgendaChars: 1200,
      maxParticipants: 4,
    }
    expect(() => briefingBoardProtocol.validateAgreement?.(bad, REF)).toThrow(/code-unit 字典序/)
  })

  it('协商结果与声明提交顺序无关（确定性）', () => {
    const requirements = [
      { participant: 'neural-net', spec: requirementSpec() },
      { participant: 'live-trading', spec: requirementSpec() },
    ]
    const supports = [{ participant: 'coordinator', spec: supportSpec() }]
    const first = agreementOf(negotiate(requirements, supports))
    const second = agreementOf(negotiate([...requirements].reverse(), supports))
    expect(second).toEqual(first)
  })
})
