import { describe, expect, it } from 'vitest'
import {
  analyzeRequirements,
  bindingSetsOfContract,
  normalizeReferenceIdentity,
  type RequirementInputs,
  type RequirementProbeSide,
  type RequirementTestSide,
} from './verify'
import { SERVICE_MANIFEST_FILE, type ProbeOutcome } from '../schema/service'
import type { AcceptanceCriterion, ExperimentReference } from '../schema/contract'
import type { TestCaseOutcome } from '../schema/baseline'

/**
 * Doc 1 §4 clause state machine, table-driven over the resolution of each
 * bound experiment:
 *   established ∧ passed -> satisfied | established ∧ failed -> FAILED (terminal)
 *   everything else      -> insufficient, carrying its reason(s)
 * plus the §6 findings and the accomplished contribution.
 */

function probeOutcome(id: string, status: ProbeOutcome['status'], identity: string | null): ProbeOutcome {
  return {
    probeId: id,
    service: 'demo',
    status,
    expectation: 'inline',
    definitionIdentity: identity,
    httpStatus: status === 'unknown' ? null : 200,
    durationMs: 1,
  }
}

function probeSide(
  entries: Array<{ id: string; status: ProbeOutcome['status']; identity: string | null }>,
  declarationsKnown = true,
): RequirementProbeSide {
  return {
    outcomes: new Map(entries.map((entry) => [entry.id, probeOutcome(entry.id, entry.status, entry.identity)])),
    definitionIdentities: new Map(entries.map((entry) => [entry.id, entry.identity])),
    declarationsKnown,
  }
}

const NO_PROBES = probeSide([])
const UNKNOWN_PROBES = probeSide([], false)

function testOutcome(id: string, status: TestCaseOutcome['status'], file = 'src/behavior.test.js'): TestCaseOutcome {
  return { id, title: id, file, status }
}

function testSide(tests: TestCaseOutcome[], perTest = true): RequirementTestSide {
  return { perTest, tests }
}

const NO_TESTS = testSide([])

/**
 * Default digest reader: every file reads as the SAME definition at both
 * states (an unchanged instrument). State-dependent or null-returning readers
 * are supplied per case.
 */
function unchangedFiles(_state: 'before' | 'after', path: string): Promise<string> {
  return Promise.resolve(`def_${path}`)
}

function inputs(overrides: Partial<RequirementInputs> = {}): RequirementInputs {
  return {
    before: { tests: NO_TESTS, probes: NO_PROBES },
    after: { tests: NO_TESTS, probes: NO_PROBES },
    deletedPaths: [],
    fileDigest: unchangedFiles,
    beforeBindings: null,
    ...overrides,
  }
}

function clauseOf(...experiments: ExperimentReference[]): AcceptanceCriterion[] {
  return [{ id: 'REQ-001', description: 'The behavior holds.', experiments }]
}

const PROBE = (probeId = 'health'): ExperimentReference => ({ kind: 'probe', probeId })
const TEST = (id = 'behavior > holds'): ExperimentReference => ({ kind: 'test', id })

const probeEstablished = (status: ProbeOutcome['status'], identity = 'def_aaaa1111') => ({
  id: 'health',
  status,
  identity,
})

describe('requirement clause state machine (Doc 1 §4)', () => {
  it('VERIFIED: established instrument, ran, passed', async () => {
    const analysis = await analyzeRequirements(clauseOf(PROBE()), inputs({
      before: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
      after: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
    }))
    expect(analysis.clauses).toHaveLength(1)
    expect(analysis.clauses[0]).toMatchObject({
      clauseId: 'REQ-001',
      status: 'verified',
      reasons: [],
    })
    expect(analysis.clauses[0]?.experiments[0]).toMatchObject({
      provenance: 'established',
      result: 'passed',
      reasons: [],
    })
    expect(analysis.coverage).toEqual({ total: 1, verified: 1, failed: 0, unverified: 0 })
    expect(analysis.findings).toEqual([])
    expect(analysis.accomplishedContribution).toBe('yes')
  })

  it('FAILED: established instrument ran and failed — terminal, with a requirement-failed finding', async () => {
    const analysis = await analyzeRequirements(clauseOf(PROBE()), inputs({
      before: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
      after: { tests: NO_TESTS, probes: probeSide([probeEstablished('failed')]) },
    }))
    expect(analysis.clauses[0]?.status).toBe('failed')
    expect(analysis.clauses[0]?.reasons).toEqual([])
    expect(analysis.accomplishedContribution).toBe('no')
    expect(analysis.findings).toHaveLength(1)
    const finding = analysis.findings[0]
    expect(finding).toMatchObject({
      id: 'RFAIL-001',
      findingClass: 'requirement-failed',
      severity: 'critical',
    })
    expect(finding?.evidence.kind).toBe('requirement')
    expect(finding?.paths).toEqual([SERVICE_MANIFEST_FILE])
    expect(finding?.message).toContain('REQ-001')
  })

  it('insufficient (instrument-modified): probe definition drifted from the before anchor', async () => {
    const analysis = await analyzeRequirements(clauseOf(PROBE()), inputs({
      before: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed', 'def_aaaa1111')]) },
      after: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed', 'def_bbbb2222')]) },
    }))
    expect(analysis.clauses[0]?.status).toBe('unverified')
    expect(analysis.clauses[0]?.reasons).toEqual(['instrument-modified'])
    expect(analysis.clauses[0]?.experiments[0]).toMatchObject({ provenance: 'modified', result: 'passed' })
    const modified = analysis.findings.find((finding) => finding.findingClass === 'requirement-experiment-modified')
    expect(modified).toMatchObject({ severity: 'warn', paths: [SERVICE_MANIFEST_FILE] })
    // names what changed: probe, before vs after definition digests (short forms)
    expect(modified?.message).toContain('probe "health"')
    expect(modified?.message).toContain('def_aaaa11')
    expect(modified?.message).toContain('def_bbbb22')
    expect(analysis.accomplishedContribution).toBe('partial')
  })

  it('insufficient (instrument-modified): whole-file digest of the bound test changed', async () => {
    const analysis = await analyzeRequirements(clauseOf(TEST()), inputs({
      before: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: NO_PROBES },
      after: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: NO_PROBES },
      fileDigest: (state, path) => Promise.resolve(`def_${state === 'before' ? 'old' : 'new'}_${path}`),
    }))
    expect(analysis.clauses[0]?.status).toBe('unverified')
    expect(analysis.clauses[0]?.reasons).toEqual(['instrument-modified'])
    const modified = analysis.findings.find((finding) => finding.findingClass === 'requirement-experiment-modified')
    expect(modified?.message).toContain('src/behavior.test.js')
    expect(modified?.paths).toEqual(['src/behavior.test.js'])
  })

  it('insufficient (experiment-new): instrument exists only after — result recorded, info signal, never VERIFIED (I9)', async () => {
    const analysis = await analyzeRequirements(clauseOf(PROBE()), inputs({
      before: { tests: NO_TESTS, probes: NO_PROBES },
      after: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
    }))
    expect(analysis.clauses[0]?.status).toBe('unverified')
    expect(analysis.clauses[0]?.reasons).toEqual(['experiment-new'])
    expect(analysis.clauses[0]?.experiments[0]).toMatchObject({ provenance: 'new', result: 'passed' })
    const fresh = analysis.findings.find((finding) => finding.findingClass === 'experiment-new')
    expect(fresh?.severity).toBe('info')
    expect(fresh?.message).toContain('no before-state definition identity')
    expect(analysis.accomplishedContribution).toBe('partial')
  })

  it('I9 guard: unknown before-state declarations resolve unresolved, NEVER experiment-new', async () => {
    const analysis = await analyzeRequirements(clauseOf(PROBE()), inputs({
      before: { tests: NO_TESTS, probes: UNKNOWN_PROBES },
      after: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
    }))
    expect(analysis.clauses[0]?.reasons).toEqual(['unresolved'])
    expect(analysis.clauses[0]?.experiments[0]?.provenance).toBe('unresolved')
    expect(analysis.findings.some((finding) => finding.findingClass === 'experiment-new')).toBe(false)
  })

  it('I9 guard: unreadable test file at a state is unresolved, never modified nor new', async () => {
    const analysis = await analyzeRequirements(clauseOf(TEST()), inputs({
      before: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: NO_PROBES },
      after: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: NO_PROBES },
      fileDigest: (state) => Promise.resolve(state === 'after' ? null : 'def_present'),
    }))
    expect(analysis.clauses[0]?.reasons).toEqual(['unresolved'])
    expect(analysis.findings.some((finding) => finding.findingClass === 'requirement-experiment-modified')).toBe(false)
    expect(analysis.findings.some((finding) => finding.findingClass === 'experiment-new')).toBe(false)
  })

  it('insufficient (unresolved): deleted instrument, missing id, unreadable after-file', async () => {
    // E4: the bound probe was deleted by the change.
    const deletedProbe = await analyzeRequirements(clauseOf(PROBE()), inputs({
      before: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
      after: { tests: NO_TESTS, probes: NO_PROBES },
    }))
    expect(deletedProbe.clauses[0]?.reasons).toEqual(['unresolved'])

    // no such test id at either state.
    const missingTest = await analyzeRequirements(clauseOf(TEST('nope > missing')), inputs({
      before: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: NO_PROBES },
      after: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: NO_PROBES },
    }))
    expect(missingTest.clauses[0]?.reasons).toEqual(['unresolved'])

    // after file deleted: unresolved, annotated with the deleted path.
    const deletedFile = await analyzeRequirements(clauseOf(TEST()), inputs({
      before: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: NO_PROBES },
      after: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: NO_PROBES },
      deletedPaths: ['src/behavior.test.js'],
      fileDigest: (state) => Promise.resolve(state === 'after' ? null : 'def_present'),
    }))
    expect(deletedFile.clauses[0]?.reasons).toEqual(['unresolved'])
    expect(deletedFile.clauses[0]?.experiments[0]?.detail).toContain('file deleted by this change')
  })

  it('insufficient (unbound-kind): dom-flow is schema-valid but always UNVERIFIED until M5c', async () => {
    const analysis = await analyzeRequirements(
      clauseOf({ kind: 'dom-flow', flowId: 'decl-error-shown' }),
      inputs(),
    )
    expect(analysis.clauses[0]?.status).toBe('unverified')
    expect(analysis.clauses[0]?.reasons).toEqual(['unbound-kind'])
    expect(analysis.clauses[0]?.experiments[0]?.provenance).toBe('unbound-kind')
  })

  it('insufficient (unknown-observability): suite-mode runner cannot resolve test bindings (E6)', async () => {
    const analysis = await analyzeRequirements(clauseOf(TEST()), inputs({
      before: { tests: testSide([], false), probes: NO_PROBES },
      after: { tests: testSide([], false), probes: NO_PROBES },
    }))
    expect(analysis.clauses[0]?.status).toBe('unverified')
    expect(analysis.clauses[0]?.reasons).toEqual(['unknown-observability'])
    expect(analysis.clauses[0]?.experiments[0]?.provenance).toBe('unknown-observability')
  })

  it('insufficient (unknown-outcome): established instrument ran inconclusively', async () => {
    const analysis = await analyzeRequirements(clauseOf(PROBE()), inputs({
      before: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
      after: { tests: NO_TESTS, probes: probeSide([probeEstablished('unknown')]) },
    }))
    expect(analysis.clauses[0]?.status).toBe('unverified')
    expect(analysis.clauses[0]?.reasons).toEqual(['unknown-outcome'])
    expect(analysis.clauses[0]?.experiments[0]).toMatchObject({ provenance: 'established', result: 'unknown' })
  })

  it('insufficient (no binding): a clause without experiments stays UNVERIFIED', async () => {
    const analysis = await analyzeRequirements(
      [{ id: 'REQ-001', description: 'The behavior holds.' }],
      inputs(),
    )
    expect(analysis.clauses[0]?.status).toBe('unverified')
    expect(analysis.clauses[0]?.reasons).toEqual(['no-binding'])
    expect(analysis.clauses[0]?.experiments).toEqual([])
  })

  it('multi-experiment clauses: ALL bound experiments must pass', async () => {
    const satisfied = inputs({
      before: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: probeSide([probeEstablished('passed')]) },
      after: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: probeSide([probeEstablished('passed')]) },
    })
    const allPass = await analyzeRequirements(clauseOf(PROBE(), TEST()), satisfied)
    expect(allPass.clauses[0]?.status).toBe('verified')
    expect(allPass.accomplishedContribution).toBe('yes')

    const oneFails = await analyzeRequirements(clauseOf(PROBE(), TEST()), inputs({
      before: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: probeSide([probeEstablished('passed')]) },
      after: { tests: testSide([testOutcome('behavior > holds', 'failed')]), probes: probeSide([probeEstablished('passed')]) },
    }))
    expect(oneFails.clauses[0]?.status).toBe('failed')
    expect(oneFails.accomplishedContribution).toBe('no')

    const oneInsufficient = await analyzeRequirements(clauseOf(PROBE(), TEST('gone > missing')), inputs({
      before: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: probeSide([probeEstablished('passed')]) },
      after: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: probeSide([probeEstablished('passed')]) },
    }))
    expect(oneInsufficient.clauses[0]?.status).toBe('unverified')
    expect(oneInsufficient.clauses[0]?.reasons).toEqual(['unresolved'])
    expect(oneInsufficient.accomplishedContribution).toBe('partial')
  })

  it('FAILED takes precedence over insufficient reasons (terminal), drift still surfaces as its own finding', async () => {
    const analysis = await analyzeRequirements(clauseOf(PROBE(), TEST('gone > missing')), inputs({
      before: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: probeSide([probeEstablished('passed')]) },
      after: { tests: testSide([testOutcome('behavior > holds', 'passed')]), probes: probeSide([probeEstablished('failed')]) },
    }))
    expect(analysis.clauses[0]?.status).toBe('failed')
    expect(analysis.clauses[0]?.reasons).toEqual([])
  })
})

describe('requirement binding identity (Doc 1 §2.6)', () => {
  const beforeBindings = new Map([['REQ-001', [normalizeReferenceIdentity(PROBE())]]])

  it('same binding set -> no drift; changed set -> binding-changed reason + finding', async () => {
    const unchanged = await analyzeRequirements(clauseOf(PROBE()), inputs({
      before: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
      after: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
      beforeBindings,
    }))
    expect(unchanged.clauses[0]?.status).toBe('verified')
    expect(unchanged.findings).toEqual([])

    const swapped = await analyzeRequirements(clauseOf(PROBE('harmless')), inputs({
      // Both probes are established instruments at BOTH states — only the
      // (clause, reference) association changed (Doc 1 §8 Case E).
      before: { tests: NO_TESTS, probes: probeSide([
        probeEstablished('passed', 'def_aaaa1111'),
        { id: 'harmless', status: 'passed', identity: 'def_cccc3333' },
      ]) },
      after: { tests: NO_TESTS, probes: probeSide([
        probeEstablished('passed', 'def_aaaa1111'),
        { id: 'harmless', status: 'passed', identity: 'def_cccc3333' },
      ]) },
      beforeBindings,
      contractPath: 'req.contract.yaml',
    }))
    expect(swapped.clauses[0]?.status).toBe('unverified')
    expect(swapped.clauses[0]?.reasons).toEqual(['binding-changed'])
    // Case E: the swapped-in instrument's own anchor status is still evaluated normally.
    expect(swapped.clauses[0]?.experiments[0]).toMatchObject({ provenance: 'established', result: 'passed' })
    const drift = swapped.findings.find((finding) => finding.findingClass === 'requirement-binding-changed')
    expect(drift).toMatchObject({ severity: 'warn', paths: ['req.contract.yaml'] })
    expect(drift?.message).toContain('probe:regression-guard.services.yaml:health')
    expect(drift?.message).toContain('probe:regression-guard.services.yaml:harmless')
  })

  it('E1: silently removing a clause from the contract is binding drift', async () => {
    const analysis = await analyzeRequirements(
      [{ id: 'REQ-002', description: 'Unrelated.', experiments: [] }],
      inputs({ beforeBindings }),
    )
    const drift = analysis.findings.filter((finding) => finding.findingClass === 'requirement-binding-changed')
    expect(drift).toHaveLength(1)
    expect(drift[0]?.message).toContain('REQ-001')
    expect(drift[0]?.message).toContain('clause removed')
  })

  it('a new clause (or a contract with no before-state predecessor) establishes identity at approval — never drift', async () => {
    // REQ-002 arrives on top of an unchanged REQ-001: the new clause has no
    // before-state binding identity, so its approval here is not drift.
    const bothProbes = probeSide([
      probeEstablished('passed', 'def_aaaa1111'),
      { id: 'other', status: 'passed', identity: 'def_dddd4444' },
    ])
    const newClause = await analyzeRequirements(
      [
        { id: 'REQ-001', description: 'ok', experiments: [PROBE()] },
        { id: 'REQ-002', description: 'New clause.', experiments: [PROBE('other')] },
      ],
      inputs({
        before: { tests: NO_TESTS, probes: bothProbes },
        after: { tests: NO_TESTS, probes: bothProbes },
        beforeBindings: new Map([['REQ-001', [normalizeReferenceIdentity(PROBE())]]]),
      }),
    )
    expect(newClause.clauses.map((clause) => clause.status)).toEqual(['verified', 'verified'])
    expect(newClause.findings).toEqual([])

    const noPredecessor = await analyzeRequirements(clauseOf(PROBE()), inputs({
      before: { tests: NO_TESTS, probes: NO_PROBES },
      after: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
      beforeBindings: null,
    }))
    // No drift check (§2.6) — but instrument provenance is evaluated independently: still experiment-new.
    expect(noPredecessor.clauses[0]?.reasons).toEqual(['experiment-new'])
    expect(noPredecessor.findings.some((finding) => finding.findingClass === 'requirement-binding-changed')).toBe(false)
  })
})

describe('requirement analysis envelope', () => {
  it('zero declared clauses: empty analysis (callers skip the layer entirely)', async () => {
    const analysis = await analyzeRequirements([], inputs())
    expect(analysis.clauses).toEqual([])
    expect(analysis.coverage).toEqual({ total: 0, verified: 0, failed: 0, unverified: 0 })
    expect(analysis.findings).toEqual([])
  })

  it('requirement-unverified: ONE grouped finding listing clauses and reasons, only when something is unverified', async () => {
    const mixed = await analyzeRequirements(
      [
        { id: 'REQ-001', description: 'ok', experiments: [PROBE()] },
        { id: 'REQ-002', description: 'reserved', experiments: [{ kind: 'dom-flow', flowId: 'f' }] },
        { id: 'REQ-003', description: 'unbound', experiments: [] },
      ],
      inputs({
        before: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
        after: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
      }),
    )
    expect(mixed.coverage).toEqual({ total: 3, verified: 1, failed: 0, unverified: 2 })
    const grouped = mixed.findings.filter((finding) => finding.findingClass === 'requirement-unverified')
    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.id).toBe('RUNVER-001')
    expect(grouped[0]?.message).toContain('2 of 3')
    expect(grouped[0]?.message).toContain('REQ-002 (unbound-kind)')
    expect(grouped[0]?.message).toContain('REQ-003 (no binding)')
    expect(mixed.accomplishedContribution).toBe('partial')

    const allVerified = await analyzeRequirements(clauseOf(PROBE()), inputs({
      before: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
      after: { tests: NO_TESTS, probes: probeSide([probeEstablished('passed')]) },
    }))
    expect(allVerified.findings.some((finding) => finding.findingClass === 'requirement-unverified')).toBe(false)
  })

  it('declared clauses with none VERIFIED and none FAILED contribute partial — uncertainty, not failure', async () => {
    const analysis = await analyzeRequirements(
      [{ id: 'REQ-001', description: 'reserved', experiments: [{ kind: 'dom-flow', flowId: 'f' }] }],
      inputs(),
    )
    expect(analysis.coverage).toEqual({ total: 1, verified: 0, failed: 0, unverified: 1 })
    expect(analysis.accomplishedContribution).toBe('partial')
  })

  it('is deterministic: shuffled side data yields a deep-equal analysis', async () => {
    const acceptance = clauseOf(PROBE(), TEST())
    acceptance.push({ id: 'REQ-002', description: 'Second.', experiments: [PROBE('other')] })
    const make = (reverse: boolean): RequirementInputs => {
      const tests = [
        testOutcome('behavior > holds', 'passed'),
        testOutcome('other > x', 'passed', 'src/other.test.js'),
      ]
      const probes = probeSide([
        probeEstablished('passed'),
        { id: 'other', status: 'passed', identity: 'def_dddd4444' },
      ])
      return inputs({
        before: { tests: testSide(reverse ? [...tests].reverse() : tests), probes: probes },
        after: { tests: testSide(reverse ? [...tests].reverse() : tests), probes: probes },
        beforeBindings: new Map([
          ['REQ-001', [normalizeReferenceIdentity(PROBE()), normalizeReferenceIdentity(TEST())]],
          ['REQ-002', [normalizeReferenceIdentity(PROBE('other'))]],
        ]),
      })
    }
    expect(await analyzeRequirements(acceptance, make(true))).toEqual(
      await analyzeRequirements(acceptance, make(false)),
    )
  })
})

describe('binding identity normalization', () => {
  it('an omitted probe manifest normalizes to the conventional manifest file', () => {
    expect(normalizeReferenceIdentity(PROBE())).toBe(normalizeReferenceIdentity({
      kind: 'probe',
      manifest: SERVICE_MANIFEST_FILE,
      probeId: 'health',
    }))
    expect(normalizeReferenceIdentity(PROBE('x'))).toBe(`probe:${SERVICE_MANIFEST_FILE}:x`)
    expect(normalizeReferenceIdentity(TEST('a > b'))).toBe('test:a > b')
    expect(normalizeReferenceIdentity({ kind: 'dom-flow', flowId: 'f' })).toBe('dom-flow:f')
  })

  it('bindingSetsOfContract sorts reference identities per clause', () => {
    const sets = bindingSetsOfContract([{
      id: 'REQ-001',
      description: 'd',
      experiments: [TEST(), PROBE()],
    }])
    expect(sets.get('REQ-001')).toEqual([
      `probe:${SERVICE_MANIFEST_FILE}:health`,
      'test:behavior > holds',
    ])
  })
})
