import { describe, expect, it } from 'vitest'
import { buildEvidencePackage, type PackageInput } from './proposal'
import { ChangeContractSchema, FindingClassSchema } from '../schema/contract'
import type { ChangeContract, FindingClass } from '../schema/contract'
import { severityForClass } from '../schema/evidence'
import type { Finding } from '../schema/evidence'
import type { ImpactAssessment } from '../schema/impact'
import { EvidencePackageSchema } from '../schema/repair'
import type { ReproductionAssessment, StateIdentity } from '../schema/reproduction'
import type { PathAssessment, ScopeClassification } from '../schema/scope'

const STATE_BEFORE: StateIdentity = { label: 'main', kind: 'ref', sha: 'a'.repeat(40) }
const STATE_AFTER: StateIdentity = { label: 'feature', kind: 'ref', sha: 'b'.repeat(40) }

const APPROVAL_NOTE =
  'PROPOSAL ONLY — no repair is authorized until a human or supervised producer explicitly approves this contract outside Regression Guard. Impact analysis informed this proposal but grants no permission; only approval authorizes.'

const EVIDENCE_B_TO_C =
  "B -> C repair-scope integrity: verify the repair change (C) against the violating state (B) — the repair must stay within this proposal's authorized constraints."
const EVIDENCE_A_TO_C =
  'A -> C final behavioral integrity: verify C against the original baseline (A) — the resulting system must be healthy relative to known-good.'

/** The fixed objective wording, pinned per finding class (dependency classes share one sentence). */
const EXPECTED_OBJECTIVES: Record<FindingClass, string> = {
  'prohibited-change': 'Eliminate the prohibited change.',
  'preserved-area-changed': 'Restore the preserved area to its required behavior.',
  'out-of-scope-change': 'Remove or authorize the out-of-scope change.',
  'new-dependency': 'Revert the unauthorized dependency change.',
  'removed-dependency': 'Revert the unauthorized dependency change.',
  'changed-dependency': 'Revert the unauthorized dependency change.',
  'deleted-test': 'Restore the deleted test coverage.',
  'sensitive-file-changed': 'Remove or authorize the sensitive-file change.',
  'unfulfilled-contract': 'Accomplish the required must-change work.',
  'test-regression': 'Repair the regression so the affected test passes again.',
  'pre-existing-failure': 'Optionally fix the pre-existing failure.',
  'baseline-incomplete': 'Complete baseline verification.',
  'test-command-changed': 'Reconcile the test command change or re-authorize the baseline.',
  'service-regression': 'Repair the service regression so the probe passes again.',
  'service-manifest-changed': 'Reconcile the service manifest change or re-authorize the probe baseline.',
  'api-contract-regression': 'Repair the API contract violation so the contract-sourced probe passes again.',
  'api-contract-changed': 'Reconcile the API specification change or re-authorize the contract baseline.',
  'service-manifest-invalid': 'Fix the invalid service manifest so verification can execute.',
}

function contractOf(paths: Record<string, unknown> = {}): ChangeContract {
  return ChangeContractSchema.parse({ id: 'contract-1', goal: 'Refactor the login flow', paths })
}

function findingOf(id: string, findingClass: FindingClass): Finding {
  return {
    id,
    findingClass,
    severity: severityForClass(findingClass),
    message: `${id}: ${findingClass}`,
    paths: [],
    evidence: { kind: 'diff', claim: 'c', observation: 'o', changedLines: [], reproduction: 'r' },
  }
}

function pathAssessment(path: string, classification: ScopeClassification): PathAssessment {
  return { path, status: 'modified', classification, reason: 'test' }
}

function impactOf(options: { seeds?: string[]; affected?: string[]; tests?: string[] } = {}): ImpactAssessment {
  return {
    seeds: options.seeds ?? [],
    affected: (options.affected ?? []).map((path) => ({
      path,
      changed: true,
      level: 'DIRECT',
      distance: 0,
      reachability: 'known',
      origin: 'after',
      via: [],
      sources: [],
      reasons: [],
    })),
    affectedTests: (options.tests ?? []).map((path) => ({ path, sources: [], evidencePaths: [] })),
    coverage: {
      affectedAreas: 0,
      coveredAreas: 0,
      uncoveredAreas: 0,
      coveragePercent: 0,
      covered: [],
      uncovered: [],
    },
    unresolvedEdges: [],
    repositoryUnresolvedEdges: [],
    completeness: 'complete',
  }
}

function reproductionOf(experimentId: string): ReproductionAssessment {
  return {
    experimentId,
    sourceFindingIds: [],
    attemptsRequested: 1,
    attemptsCompleted: 1,
    reproduced: 1,
    notReproduced: 0,
    inconclusive: 0,
    stability: 'stable',
    granularity: 'case',
    attempts: [
      {
        index: 1,
        experimentId,
        stateIdentity: STATE_AFTER,
        outcome: 'reproduced',
        exitCode: 1,
        durationMs: 12,
        timedOut: false,
      },
    ],
    stateIdentity: STATE_AFTER,
    stateMatched: true,
  }
}

function packageInput(overrides: Partial<PackageInput> = {}): PackageInput {
  return {
    contract: contractOf(),
    findings: [],
    scopeAssessment: [],
    impact: impactOf(),
    reproductions: [],
    stateIdentities: { before: STATE_BEFORE, after: STATE_AFTER },
    verificationRunId: 'run-1',
    verificationContextId: 'ctx-1',
    repositoryPaths: [],
    verdict: 'REJECT',
    ...overrides,
  }
}

function constraintsOf(input: PackageInput) {
  return buildEvidencePackage(input).repairProposal.pathConstraints
}

describe('buildEvidencePackage path constraints', () => {
  it.each(['PROHIBITED', 'SUSPICIOUS', 'OUT_OF_SCOPE'] as const)(
    'constrains a %s changed path to restore-to-baseline, never editable',
    (classification) => {
      const input = packageInput({
        contract: contractOf({ prohibited: ['src/auth.ts'] }),
        scopeAssessment: [pathAssessment('src/auth.ts', classification)],
        repositoryPaths: ['src/auth.ts'],
      })
      expect(constraintsOf(input)).toEqual([{ path: 'src/auth.ts', mode: 'restore-to-baseline' }])
    },
  )

  it.each(['EXPECTED', 'RELATED'] as const)('constrains a %s changed path as editable', (classification) => {
    const input = packageInput({
      scopeAssessment: [pathAssessment('src/login.ts', classification)],
      repositoryPaths: ['src/login.ts'],
    })
    expect(constraintsOf(input)).toEqual([{ path: 'src/login.ts', mode: 'editable' }])
  })

  it('marks unchanged paths matching prohibited globs as prohibited (dotfiles included)', () => {
    const input = packageInput({
      contract: contractOf({ prohibited: ['infrastructure/**', 'secrets/**'] }),
      scopeAssessment: [pathAssessment('src/login.ts', 'EXPECTED')],
      repositoryPaths: [
        'infrastructure/deploy.tf',
        'secrets/.env.local',
        'src/login.ts',
        'docs/readme.md',
      ],
    })
    expect(constraintsOf(input)).toEqual([
      { path: 'infrastructure/deploy.tf', mode: 'prohibited' },
      { path: 'secrets/.env.local', mode: 'prohibited' },
      { path: 'src/login.ts', mode: 'editable' },
    ])
  })

  it('marks unchanged paths matching prohibited categories as prohibited', () => {
    const input = packageInput({
      contract: contractOf({ prohibited: [{ category: 'lockfile' }, { category: 'ci-config' }] }),
      scopeAssessment: [pathAssessment('src/login.ts', 'EXPECTED')],
      repositoryPaths: ['pnpm-lock.yaml', '.github/workflows/ci.yml', 'src/login.ts', 'src/main.ts'],
    })
    expect(constraintsOf(input)).toEqual([
      { path: '.github/workflows/ci.yml', mode: 'prohibited' },
      { path: 'pnpm-lock.yaml', mode: 'prohibited' },
      { path: 'src/login.ts', mode: 'editable' },
    ])
  })

  it('prohibits an unchanged package.json when dependency categories are prohibited', () => {
    const input = packageInput({
      contract: contractOf({ prohibited: [{ category: 'dependency-addition' }] }),
      repositoryPaths: ['package.json', 'src/main.ts'],
    })
    expect(constraintsOf(input)).toEqual([{ path: 'package.json', mode: 'prohibited' }])
  })

  it('never double-constrains a changed path: rule 1 wins for a changed package.json', () => {
    const input = packageInput({
      contract: contractOf({ prohibited: [{ category: 'dependency-addition' }, 'src/auth.ts'] }),
      scopeAssessment: [
        pathAssessment('package.json', 'EXPECTED'),
        pathAssessment('src/auth.ts', 'PROHIBITED'),
      ],
      repositoryPaths: ['package.json', 'src/auth.ts', 'src/main.ts'],
    })
    expect(constraintsOf(input)).toEqual([
      { path: 'package.json', mode: 'editable' },
      { path: 'src/auth.ts', mode: 'restore-to-baseline' },
    ])
  })

  it('sorts constraints by path and keeps one constraint per path', () => {
    const input = packageInput({
      scopeAssessment: [
        pathAssessment('src/zeta.ts', 'EXPECTED'),
        pathAssessment('src/alpha.ts', 'RELATED'),
        pathAssessment('src/mid.ts', 'OUT_OF_SCOPE'),
      ],
      repositoryPaths: ['src/zeta.ts', 'src/alpha.ts', 'src/mid.ts'],
    })
    expect(constraintsOf(input).map((constraint) => [constraint.path, constraint.mode])).toEqual([
      ['src/alpha.ts', 'editable'],
      ['src/mid.ts', 'restore-to-baseline'],
      ['src/zeta.ts', 'editable'],
    ])
  })
})

describe('buildEvidencePackage objectives', () => {
  it('covers exactly the finding classes present, in class-name order', () => {
    const input = packageInput({
      findings: [
        findingOf('T-001', 'test-regression'),
        findingOf('S-001', 'prohibited-change'),
        findingOf('B-001', 'baseline-incomplete'),
        findingOf('D-001', 'new-dependency'),
      ],
    })
    expect(input.findings.map((finding) => finding.findingClass).sort()).toEqual([
      // sanity: the classes above, sorted
      'baseline-incomplete',
      'new-dependency',
      'prohibited-change',
      'test-regression',
    ] as FindingClass[])
    expect(buildEvidencePackage(input).repairProposal.objectives).toEqual([
      EXPECTED_OBJECTIVES['baseline-incomplete'],
      EXPECTED_OBJECTIVES['new-dependency'],
      EXPECTED_OBJECTIVES['prohibited-change'],
      EXPECTED_OBJECTIVES['test-regression'],
    ])
  })

  it('dedupes the shared dependency objective', () => {
    const input = packageInput({
      findings: [
        findingOf('D-003', 'changed-dependency'),
        findingOf('D-001', 'new-dependency'),
        findingOf('D-002', 'removed-dependency'),
      ],
    })
    expect(buildEvidencePackage(input).repairProposal.objectives).toEqual([
      'Revert the unauthorized dependency change.',
    ])
  })

  it.each([...FindingClassSchema.options])('renders the fixed objective for %s', (findingClass) => {
    const input = packageInput({ findings: [findingOf('X-001', findingClass)] })
    expect(buildEvidencePackage(input).repairProposal.objectives).toEqual([
      EXPECTED_OBJECTIVES[findingClass],
    ])
  })
})

describe('buildEvidencePackage mustPreserve', () => {
  it('renders globs verbatim and categories as category:<name>', () => {
    const input = packageInput({
      contract: contractOf({
        mustPreserve: ['docs/api-contract.md', 'src/legacy/**', { category: 'lockfile' }],
      }),
    })
    expect(buildEvidencePackage(input).repairProposal.mustPreserve).toEqual([
      'category:lockfile',
      'docs/api-contract.md',
      'src/legacy/**',
    ])
  })
})

describe('buildEvidencePackage evidence and states', () => {
  it('requires both B -> C and A -> C evidence, in that order', () => {
    const evidenceRequired = buildEvidencePackage(packageInput()).repairProposal.evidenceRequired
    expect(evidenceRequired).toEqual([EVIDENCE_B_TO_C, EVIDENCE_A_TO_C])
    expect(evidenceRequired[0]).toContain('B -> C repair-scope integrity')
    expect(evidenceRequired[1]).toContain('A -> C final behavioral integrity')
  })

  it('maps originalBaseline to the before state (A) and violatingState to the after state (B)', () => {
    const { stateIdentities } = buildEvidencePackage(packageInput()).repairProposal
    expect(stateIdentities.originalBaseline).toBe(STATE_BEFORE)
    expect(stateIdentities.violatingState).toBe(STATE_AFTER)
  })
})

describe('buildEvidencePackage proposal envelope', () => {
  it('is a proposal by deterministic-evidence with the fixed approval note', () => {
    const proposal = buildEvidencePackage(
      packageInput({
        contract: contractOf(),
        verificationRunId: 'run-42',
        verificationContextId: 'ctx-42',
      }),
    ).repairProposal
    expect(proposal.status).toBe('proposed')
    expect(proposal.proposedBy).toBe('deterministic-evidence')
    expect(proposal.originalContractId).toBe('contract-1')
    expect(proposal.verificationRunId).toBe('run-42')
    expect(proposal.verificationContextId).toBe('ctx-42')
    expect(proposal.approvalNote).toBe(APPROVAL_NOTE)
  })

  it('targets every finding id, sorted', () => {
    const proposal = buildEvidencePackage(
      packageInput({
        findings: [findingOf('SCOPE-002', 'out-of-scope-change'), findingOf('SCOPE-001', 'deleted-test')],
      }),
    ).repairProposal
    expect(proposal.targetFindingIds).toEqual(['SCOPE-001', 'SCOPE-002'])
  })
})

describe('buildEvidencePackage determinism', () => {
  const base = packageInput({
    contract: contractOf({
      prohibited: [{ category: 'lockfile' }],
      mustPreserve: ['docs/api-contract.md'],
    }),
    findings: [
      findingOf('SCOPE-002', 'out-of-scope-change'),
      findingOf('SCOPE-001', 'prohibited-change'),
      findingOf('TEST-001', 'test-regression'),
    ],
    scopeAssessment: [
      pathAssessment('src/auth.ts', 'PROHIBITED'),
      pathAssessment('src/login.ts', 'EXPECTED'),
    ],
    impact: impactOf({
      seeds: ['src/login.ts', 'src/auth.ts'],
      affected: ['src/login.ts', 'src/auth.ts'],
      tests: ['tests/login.test.ts', 'tests/auth.test.ts'],
    }),
    reproductions: [reproductionOf('exp-1')],
    repositoryPaths: ['pnpm-lock.yaml', 'src/auth.ts', 'src/login.ts', 'src/main.ts'],
  })

  it('produces deep-equal packages from shuffled-equivalent inputs', () => {
    const shuffled: PackageInput = {
      ...base,
      repositoryPaths: [...base.repositoryPaths].reverse(),
      impact: impactOf({
        seeds: [...base.impact.seeds].reverse(),
        affected: [...base.impact.affected].reverse().map((node) => node.path),
        tests: [...base.impact.affectedTests].reverse().map((test) => test.path),
      }),
    }
    expect(buildEvidencePackage(shuffled)).toEqual(buildEvidencePackage(base))
  })

  it('produces deep-equal proposals from shuffled findings and scope assessments', () => {
    const shuffled: PackageInput = {
      ...base,
      findings: [...base.findings].reverse(),
      scopeAssessment: [...base.scopeAssessment].reverse(),
    }
    expect(buildEvidencePackage(shuffled).repairProposal).toEqual(
      buildEvidencePackage(base).repairProposal,
    )
  })
})

describe('buildEvidencePackage degenerate inputs', () => {
  it('builds with no findings: empty targets and objectives, constraints from rules only', () => {
    const input = packageInput({
      contract: contractOf({ prohibited: ['infrastructure/**'] }),
      findings: [],
      scopeAssessment: [],
      repositoryPaths: ['infrastructure/deploy.tf', 'src/main.ts'],
    })
    const pkg = buildEvidencePackage(input)
    expect(pkg.repairProposal.targetFindingIds).toEqual([])
    expect(pkg.repairProposal.objectives).toEqual([])
    expect(pkg.repairProposal.pathConstraints).toEqual([
      { path: 'infrastructure/deploy.tf', mode: 'prohibited' },
    ])
    expect(pkg.findings).toEqual([])
    expect(pkg.impact).toEqual({ seeds: [], affectedCount: 0, affectedTests: [] })
  })
})

describe('buildEvidencePackage contract compliance', () => {
  it('round-trips through EvidencePackageSchema', () => {
    const input = packageInput({
      contract: contractOf({ prohibited: ['src/auth.ts'] }),
      findings: [findingOf('SCOPE-001', 'prohibited-change')],
      scopeAssessment: [pathAssessment('src/auth.ts', 'PROHIBITED')],
      impact: impactOf({ seeds: ['src/auth.ts'], affected: ['src/auth.ts'], tests: ['tests/auth.test.ts'] }),
      reproductions: [reproductionOf('exp-1')],
      repositoryPaths: ['src/auth.ts', 'src/main.ts'],
    })
    expect(() => EvidencePackageSchema.parse(buildEvidencePackage(input))).not.toThrow()
  })
})
