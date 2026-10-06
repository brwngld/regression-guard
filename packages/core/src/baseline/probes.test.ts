import { describe, expect, it } from 'vitest'
import { summarize } from './compare'
import {
  buildProbeFindings,
  compareManifests,
  divergedContractProbes,
  probeBaselineStatus,
  probeTransitions,
  type ManifestSide,
} from './probes'
import type { TestTransition } from '../schema/baseline'
import type { ProbeOutcome, ProbeRunResult, ServiceManifest } from '../schema/service'

const DIGEST_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DIGEST_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const side = (digest: string | null): ManifestSide => ({ digest, manifest: null })

const probe = (
  probeId: string,
  status: ProbeOutcome['status'],
  detail?: string,
  expectation: ProbeOutcome['expectation'] = 'inline',
): ProbeOutcome => ({
  probeId,
  service: 'api',
  status,
  expectation,
  httpStatus: status === 'unknown' ? null : status === 'passed' ? 200 : 500,
  durationMs: 12,
  detail,
})

const run = (
  label: 'before' | 'after',
  probes: ProbeOutcome[],
  overrides: Partial<Pick<ProbeRunResult, 'manifestDigest' | 'contractDigest' | 'servicesReady'>> = {},
): ProbeRunResult => ({
  label,
  ref: label === 'before' ? 'HEAD~1' : 'working-tree',
  manifestDigest: DIGEST_A,
  contractDigest: null,
  servicesReady: probes.length > 0 ? ['api'] : [],
  probes,
  durationMs: 250,
  ...overrides,
})

const findingsFor = (
  beforeProbes: ProbeOutcome[],
  afterProbes: ProbeOutcome[],
  manifest: { before?: string; after?: string } = {},
) => {
  const beforeRun = run('before', beforeProbes, { manifestDigest: manifest.before ?? DIGEST_A })
  const afterRun = run('after', afterProbes, { manifestDigest: manifest.after ?? DIGEST_A })
  const transitions = probeTransitions(beforeProbes, afterProbes)
  return buildProbeFindings({
    beforeRun,
    afterRun,
    transitions,
    summary: summarize(transitions),
    diverged: divergedContractProbes(beforeRun, afterRun),
  })
}

const contractProbe = (
  probeId: string,
  status: ProbeOutcome['status'],
  file: string,
  digest: string | null,
): ProbeOutcome => ({
  ...probe(probeId, status),
  expectation: 'contract',
  contractIdentity: {
    file,
    documentDigest: digest,
    method: 'GET',
    path: '/x',
    status: 200,
  },
})

describe('probeTransitions', () => {
  type Row = {
    case: string
    before: ProbeOutcome['status']
    after: ProbeOutcome['status'] | null
    kind: TestTransition['kind']
  }
  const rows: Row[] = [
    { case: 'PASS -> PASS stays preserved', before: 'passed', after: 'passed', kind: 'preserved' },
    { case: 'PASS -> FAIL is a regression', before: 'passed', after: 'failed', kind: 'regression' },
    { case: 'FAIL -> FAIL is pre-existing', before: 'failed', after: 'failed', kind: 'pre-existing' },
    { case: 'FAIL -> PASS is an improvement', before: 'failed', after: 'passed', kind: 'improvement' },
    { case: 'PASS -> missing is unknown', before: 'passed', after: null, kind: 'unknown' },
    { case: 'PASS -> unknown is unknown', before: 'passed', after: 'unknown', kind: 'unknown' },
    { case: 'unknown before can never regress', before: 'unknown', after: 'failed', kind: 'unknown' },
  ]

  it.each(rows)('$case', ({ before, after, kind }) => {
    const transitions = probeTransitions(
      [probe('health', before)],
      after === null ? [] : [probe('health', after)],
    )
    expect(transitions).toEqual([
      { id: 'health', title: 'health', file: undefined, before, after: after ?? 'missing', kind },
    ])
  })

  it('ignores probes that only exist after the change', () => {
    const transitions = probeTransitions(
      [probe('health', 'passed')],
      [probe('health', 'passed'), probe('new-endpoint', 'failed')],
    )
    expect(transitions).toHaveLength(1)
    expect(transitions[0]!.kind).toBe('preserved')
  })

  it('uses probe ids as identities and summarizes with the shared table', () => {
    const transitions = probeTransitions(
      [probe('a', 'passed'), probe('b', 'failed'), probe('c', 'unknown')],
      [probe('a', 'failed'), probe('b', 'failed'), probe('c', 'passed')],
    )
    expect(transitions.map((transition) => transition.id)).toEqual(['a', 'b', 'c'])
    expect(summarize(transitions)).toEqual({
      preserved: 0,
      regressed: 1,
      preExisting: 1,
      improved: 0,
      unknown: 1,
    })
  })
})

describe('compareManifests', () => {
  it.each([
    { case: 'no manifest on either side', before: null, after: null, mode: 'none' },
    { case: 'equal digests are comparable', before: DIGEST_A, after: DIGEST_A, mode: 'comparable' },
    { case: 'differing digests are non-comparable', before: DIGEST_A, after: DIGEST_B, mode: 'non-comparable' },
    { case: 'manifest only before the change', before: DIGEST_A, after: null, mode: 'non-comparable' },
    { case: 'manifest only after the change', before: null, after: DIGEST_B, mode: 'non-comparable' },
  ])('$case', ({ before, after, mode }) => {
    const comparison = compareManifests(side(before), side(after))
    expect(comparison.mode).toBe(mode)
    expect(comparison.reason === undefined).toBe(mode !== 'non-comparable')
  })

  it('explains non-comparable digest differences with both short digests', () => {
    const comparison = compareManifests(side(DIGEST_A), side(DIGEST_B))
    expect(comparison.reason).toContain('aaaaaaaaaa')
    expect(comparison.reason).toContain('bbbbbbbbbb')
  })

  it('keys comparability on the digest even when the parsed manifest is not carried', () => {
    const manifest: ServiceManifest = {
      version: 1,
      services: [{ name: 'api', command: 'npm start', readiness: { port: 3000, path: '/', timeoutMs: 20_000 } }],
      probes: [],
    }
    expect(compareManifests({ digest: DIGEST_A, manifest }, { digest: DIGEST_A, manifest: null })).toEqual({
      mode: 'comparable',
    })
  })
})

describe('buildProbeFindings', () => {
  it('emits one critical service-regression finding per regression transition', () => {
    const findings = findingsFor(
      [probe('health', 'passed'), probe('stats', 'passed')],
      [probe('health', 'failed', 'expected status 200, got 500'), probe('stats', 'failed')],
    )
    expect(findings.map((finding) => [finding.id, finding.findingClass, finding.severity])).toEqual([
      ['SPROBE-001', 'service-regression', 'critical'],
      ['SPROBE-002', 'service-regression', 'critical'],
    ])
    expect(findings[0]!.paths).toEqual([])
    expect(findings[0]!.evidence.kind).toBe('api')
    expect(findings[0]!.evidence.changedLines).toEqual([])
    expect(findings[0]!.message).toBe('Probe "health" passed at baseline and fails after the change.')
    expect(findings[0]!.evidence.claim).toBe('Probe "health" regressed: it passed before the change and fails after it.')
    expect(findings[0]!.evidence.observation).toBe(
      'Experiment: ran the declared service probes against HEAD~1 and working-tree in isolated worktrees. Before: PASSED. After: FAILED — expected status 200, got 500.',
    )
    expect(findings[0]!.evidence.reproduction).toBe('probe "health" (see regression-guard.services.yaml)')
  })

  it('ends the observation cleanly when the after outcome carries no detail', () => {
    const findings = findingsFor([probe('stats', 'passed')], [probe('stats', 'failed')])
    expect(findings[0]!.evidence.observation).toBe(
      'Experiment: ran the declared service probes against HEAD~1 and working-tree in isolated worktrees. Before: PASSED. After: FAILED.',
    )
  })

  it('groups pre-existing probe failures into a single info finding', () => {
    const findings = findingsFor(
      [probe('old-a', 'failed'), probe('old-b', 'failed'), probe('ok', 'passed')],
      [probe('old-b', 'failed'), probe('ok', 'passed'), probe('old-a', 'failed')],
    )
    const grouped = findings.find((finding) => finding.findingClass === 'pre-existing-failure')
    expect(grouped).toBeDefined()
    expect(grouped?.id).toBe('PPROBE-001')
    expect(grouped?.severity).toBe('info')
    expect(grouped?.evidence.kind).toBe('api')
    expect(grouped?.message).toBe(
      '2 baseline probe failure(s) pre-date this change and are not attributed to it: "old-a", "old-b".',
    )
    expect(grouped?.evidence.observation).toBe(
      'Experiment: ran the declared service probes against HEAD~1 and working-tree in isolated worktrees. FAIL -> FAIL for: "old-a", "old-b".',
    )
    expect(grouped?.evidence.reproduction).toBe(
      'probes "old-a", "old-b" (see regression-guard.services.yaml)',
    )
    // Preserved and improved probes never produce findings.
    expect(findings).toHaveLength(1)
  })

  it('flags a changed manifest only when the sides are non-comparable', () => {
    expect(findingsFor([], [], { before: DIGEST_A, after: DIGEST_A })).toEqual([])

    const findings = findingsFor([], [], { before: DIGEST_A, after: DIGEST_B })
    expect(findings).toHaveLength(1)
    const manifestFinding = findings[0]!
    expect(manifestFinding.id).toBe('SMAN-001')
    expect(manifestFinding.findingClass).toBe('service-manifest-changed')
    expect(manifestFinding.severity).toBe('info')
    expect(manifestFinding.paths).toEqual(['regression-guard.services.yaml'])
    expect(manifestFinding.evidence.kind).toBe('api')
    expect(manifestFinding.message).toBe(
      'The service manifest is not the same on both sides: before: aaaaaaaaaa -> after: bbbbbbbbbb.',
    )
    expect(manifestFinding.evidence.observation).toContain('forced to partial')
    expect(manifestFinding.evidence.reproduction).toContain('regression-guard.services.yaml')
  })

  it('is deterministic across shuffled input arrays', () => {
    const beforeProbes = [
      probe('p1', 'passed'),
      probe('p2', 'passed'),
      probe('p3', 'failed'),
      probe('p4', 'unknown'),
    ]
    const afterProbes = [
      probe('p1', 'failed', 'boom'),
      probe('p2', 'passed'),
      probe('p3', 'failed'),
      probe('p4', 'passed'),
      probe('p5', 'passed'),
    ]
    expect(findingsFor(beforeProbes, afterProbes)).toEqual(
      findingsFor([...beforeProbes].reverse(), [...afterProbes].reverse()),
    )
  })
})

describe('probeBaselineStatus', () => {
  it('fails when any probe regressed, even alongside unknown outcomes', () => {
    const transitions = probeTransitions(
      [probe('health', 'passed'), probe('flaky', 'passed')],
      [probe('health', 'failed'), probe('flaky', 'unknown')],
    )
    const result = probeBaselineStatus({
      transitions,
      summary: summarize(transitions),
      manifestMode: 'non-comparable',
      runs: [],
    })
    expect(result).toEqual({ status: 'fail', incompleteReasons: [] })
  })

  it('is partial with a human reason when outcomes are unknown', () => {
    const transitions = probeTransitions([probe('health', 'passed')], [probe('health', 'unknown')])
    const result = probeBaselineStatus({ transitions, manifestMode: 'comparable', runs: [] })
    expect(result.status).toBe('partial')
    expect(result.incompleteReasons).toEqual([
      '1 baseline probe(s) have inconclusive outcomes after the change',
    ])
  })

  it('is partial when the manifest is non-comparable', () => {
    const result = probeBaselineStatus({ transitions: [], manifestMode: 'non-comparable', runs: [] })
    expect(result.status).toBe('partial')
    expect(result.incompleteReasons).toEqual([
      'the service manifest changed between the compared states, so the before and after probe runs are not directly comparable',
    ])
  })

  it('is partial when a run declared probes but readied no service', () => {
    const transitions = probeTransitions([probe('health', 'passed')], [probe('health', 'passed')])
    const notReady = {
      label: 'before' as const,
      servicesReady: [],
      probes: [probe('health', 'unknown')],
    }
    const result = probeBaselineStatus({
      transitions,
      manifestMode: 'comparable',
      runs: [notReady],
    })
    expect(result.status).toBe('partial')
    expect(result.incompleteReasons).toEqual([
      'before probe run could not execute: no declared service reached readiness within its timeout',
    ])
  })

  it('passes when every probe is conclusive and the manifest is comparable', () => {
    const beforeProbes = [probe('health', 'passed'), probe('old', 'failed')]
    const afterProbes = [probe('health', 'passed'), probe('old', 'failed')]
    const transitions = probeTransitions(beforeProbes, afterProbes)
    const runs = [
      { label: 'before' as const, servicesReady: ['api'], probes: beforeProbes },
      { label: 'after' as const, servicesReady: ['api'], probes: afterProbes },
    ]
    expect(probeBaselineStatus({ transitions, manifestMode: 'comparable', runs })).toEqual({
      status: 'pass',
      incompleteReasons: [],
    })
  })

  it('derives the summary from transitions when omitted', () => {
    const transitions = probeTransitions([probe('health', 'passed')], [probe('health', 'failed')])
    expect(
      probeBaselineStatus({ transitions, manifestMode: 'comparable', runs: [] }).status,
    ).toBe('fail')
  })

  it('contributes a neutral pass when no manifest exists on either side', () => {
    expect(probeBaselineStatus({ transitions: [], manifestMode: 'none', runs: [] })).toEqual({
      status: 'pass',
      incompleteReasons: [],
    })
  })
})

describe('M5b.1: per-probe contract identity', () => {
  const DOC_A = 'oas_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0'
  const DOC_B = 'oas_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0'

  it('diverges only the probe whose own document changed; other documents stay comparable', () => {
    const before = [
      contractProbe('users', 'passed', 'users.openapi.yaml', DOC_A),
      contractProbe('billing', 'passed', 'billing.openapi.yaml', DOC_A),
    ]
    const after = [
      contractProbe('users', 'passed', 'users.openapi.yaml', DOC_A),
      contractProbe('billing', 'failed', 'billing.openapi.yaml', DOC_B),
    ]
    const diverged = divergedContractProbes(run('before', before), run('after', after))
    expect(diverged).toHaveLength(1)
    expect(diverged[0]).toMatchObject({
      probeId: 'billing',
      file: 'billing.openapi.yaml',
      changedComponents: ['document'],
      beforeDigest: DOC_A,
      afterDigest: DOC_B,
    })
  })

  it('a null digest (unreadable document) is not divergence — the probe reports unknown', () => {
    const before = [contractProbe('p', 'passed', 'x.yaml', DOC_A)]
    const after = [contractProbe('p', 'unknown', 'x.yaml', null)]
    expect(divergedContractProbes(run('before', before), run('after', after))).toEqual([])
  })

  it('M5b.2 regression: a null digest suppresses divergence even when file/method/path/status ALL changed', () => {
    // The document is unresolved on the after side, so we do not possess a
    // complete contract identity there — no divergence may be inferred from
    // the remaining fields. Unknown is not divergence (M5b.1 invariant).
    const beforeProbe: ProbeOutcome = {
      ...contractProbe('p', 'passed', 'a.yaml', DOC_A),
      contractIdentity: { file: 'a.yaml', documentDigest: DOC_A, method: 'GET', path: '/users', status: 200 },
    }
    const afterProbe: ProbeOutcome = {
      ...contractProbe('p', 'unknown', 'b.yaml', null),
      contractIdentity: { file: 'b.yaml', documentDigest: null, method: 'POST', path: '/members', status: 201 },
    }
    expect(divergedContractProbes(run('before', [beforeProbe]), run('after', [afterProbe]))).toEqual([])
    // Symmetric case: null digest on the BEFORE side.
    expect(divergedContractProbes(run('before', [afterProbe]), run('after', [beforeProbe]))).toEqual([])
  })

  it.each([
    {
      case: 'method changed (GET -> POST)',
      before: { method: 'GET' as const },
      after: { method: 'POST' as const },
      component: 'method',
    },
    {
      case: 'path changed (/users -> /members)',
      before: { path: '/users' },
      after: { path: '/members' },
      component: 'path',
    },
    {
      case: 'expected status changed (200 -> 201)',
      before: { status: 200 },
      after: { status: 201 },
      component: 'status',
    },
    {
      // The strongest case: identical document CONTENT in two different files.
      // Comparing digests alone would call this comparable; identity must not.
      case: 'file changed while document digest is identical',
      before: { file: 'a.openapi.yaml' },
      after: { file: 'b.openapi.yaml' },
      component: 'file',
    },
  ])('diverges on a complete-identity change: $case', ({ before, after, component }) => {
    const identity = { method: 'GET' as const, path: '/users', status: 200 }
    const beforeProbe: ProbeOutcome = {
      ...contractProbe('p', 'passed', 'users.openapi.yaml', DOC_A),
      contractIdentity: { file: 'users.openapi.yaml', documentDigest: DOC_A, ...identity, ...before },
    }
    const afterProbe: ProbeOutcome = {
      ...contractProbe('p', 'failed', 'users.openapi.yaml', DOC_A),
      contractIdentity: { file: 'users.openapi.yaml', documentDigest: DOC_A, ...identity, ...after },
    }
    const diverged = divergedContractProbes(run('before', [beforeProbe]), run('after', [afterProbe]))
    expect(diverged).toHaveLength(1)
    expect(diverged[0]?.changedComponents).toEqual([component])
    expect(diverged[0]?.beforeOperation).toBeTruthy()
    expect(diverged[0]?.afterOperation).toBeTruthy()
  })

  it('identical identities never diverge even when outcomes differ', () => {
    const before = [contractProbe('p', 'passed', 'x.yaml', DOC_A)]
    const after = [contractProbe('p', 'failed', 'x.yaml', DOC_A)]
    expect(divergedContractProbes(run('before', before), run('after', after))).toEqual([])
  })

  it('excludes diverged probes from regression attribution and names them in api-contract-changed', () => {
    const before = [
      contractProbe('users', 'passed', 'users.openapi.yaml', DOC_A),
      contractProbe('billing', 'passed', 'billing.openapi.yaml', DOC_A),
    ]
    const after = [
      contractProbe('users', 'failed', 'users.openapi.yaml', DOC_A),
      contractProbe('billing', 'failed', 'billing.openapi.yaml', DOC_B),
    ]
    // users: comparable regression -> APROBE finding. billing: diverged ->
    // EXCLUDED from attribution, named by api-contract-changed instead.
    const findings = findingsFor(before, after)
    const classes = findings.map((finding) => finding.findingClass)
    expect(classes).toContain('api-contract-regression')
    expect(classes).not.toContain('service-regression')
    const changed = findings.find((finding) => finding.findingClass === 'api-contract-changed')
    expect(changed?.message).toContain('billing')
    expect(changed?.message).toContain('billing.openapi.yaml')
    expect(changed?.paths).toEqual(['billing.openapi.yaml'])
    expect(changed?.message).not.toContain('users')
    const regression = findings.find((finding) => finding.findingClass === 'api-contract-regression')
    expect(regression?.message).toContain('users')
  })

  it('probeBaselineStatus forces partial naming only the affected probe', () => {
    const contribution = probeBaselineStatus({
      transitions: [],
      manifestMode: 'comparable',
      diverged: [
        {
          probeId: 'billing',
          file: 'billing.openapi.yaml',
          beforeDigest: DOC_A,
          afterDigest: DOC_B,
          changedComponents: ['document'],
          beforeOperation: 'GET /billing 200 (billing.openapi.yaml)',
          afterOperation: 'GET /billing 200 (billing.openapi.yaml)',
        },
      ],
      runs: [],
    })
    expect(contribution.status).toBe('partial')
    expect(contribution.incompleteReasons).toEqual([
      'the referenced API contract changed for probe(s) "billing" (billing.openapi.yaml), so their outcomes are of limited comparability',
    ])
  })
})
