import picomatch from 'picomatch'
import { categorizePath } from '../analyzer/change'
import type { ChangeContract, FindingClass, PathRule } from '../schema/contract'
import type { Finding } from '../schema/evidence'
import type { Verdict } from '../schema/gate'
import type { ImpactAssessment } from '../schema/impact'
import type { EvidencePackage, RepairPathConstraint, RepairContractProposal } from '../schema/repair'
import type { ReproductionAssessment, StateIdentity } from '../schema/reproduction'
import type { PathAssessment } from '../schema/scope'

/**
 * M4 Evidence Package assembly. Regression Guard strengthens evidence and
 * PREPARES repairs; it never performs them and never approves them. This module
 * is a pure, deterministic function: the same inputs always produce a
 * deep-equal package, so a proposal can be replayed and audited bit for bit.
 *
 * The repair proposal inside the package is a PROPOSAL ONLY — impact analysis
 * may inform it, but nothing computed here grants modification permission.
 */

export interface PackageInput {
  contract: ChangeContract
  /** Gate-ordered findings, possibly enriched with reproduction assessments. */
  findings: Finding[]
  scopeAssessment: PathAssessment[]
  impact: ImpactAssessment
  reproductions: ReproductionAssessment[]
  stateIdentities: { before: StateIdentity; after: StateIdentity }
  verificationRunId: string
  verificationContextId: string
  /** All repository file paths at the after state (for expanding prohibited rules). */
  repositoryPaths: string[]
  /** The gate verdict this package answers. */
  verdict: Verdict
}

/**
 * One deterministic objective sentence per finding class. Complete over
 * FindingClassSchema (the record type enforces exhaustiveness at compile time).
 */
const OBJECTIVES_BY_CLASS: Record<FindingClass, string> = {
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
}

/** The dual-baseline rule every eventual repair change must satisfy. */
const EVIDENCE_REQUIRED: readonly string[] = [
  "B -> C repair-scope integrity: verify the repair change (C) against the violating state (B) — the repair must stay within this proposal's authorized constraints.",
  'A -> C final behavioral integrity: verify C against the original baseline (A) — the resulting system must be healthy relative to known-good.',
]

const APPROVAL_NOTE =
  'PROPOSAL ONLY — no repair is authorized until a human or supervised producer explicitly approves this contract outside Regression Guard. Impact analysis informed this proposal but grants no permission; only approval authorizes.'

const MATCH_OPTIONS = { dot: true } as const

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Objectives: one fixed sentence per distinct class present, sorted by class name, deduped. */
function deriveObjectives(findings: Finding[]): string[] {
  const classes = [...new Set(findings.map((finding) => finding.findingClass))].sort(compareStrings)
  const seen = new Set<string>()
  const objectives: string[] = []
  for (const findingClass of classes) {
    const objective = OBJECTIVES_BY_CLASS[findingClass]
    if (!seen.has(objective)) {
      seen.add(objective)
      objectives.push(objective)
    }
  }
  return objectives
}

/**
 * Does a contract `prohibited` rule cover this unchanged repository path?
 * Glob rules match via picomatch; category rules match via path categorization,
 * with dependency-addition/removal expressed through the manifest file that
 * would carry the change ('package.json').
 */
function prohibitedRuleMatches(rule: PathRule, path: string): boolean {
  if (typeof rule === 'string') {
    return picomatch.isMatch(path, rule, MATCH_OPTIONS)
  }
  if (rule.category === 'dependency-addition' || rule.category === 'dependency-removal') {
    return path === 'package.json'
  }
  return categorizePath(path).includes(rule.category)
}

/**
 * Safety-critical constraint derivation. Rule 1: every CHANGED path gets
 * exactly one operation constraint — editable when the scope verdict authorized
 * the change (EXPECTED/RELATED), restore-to-baseline when it did not
 * (SUSPICIOUS/PROHIBITED/OUT_OF_SCOPE). Restoration is an operation constraint
 * (revert toward the original baseline), never permission to redesign.
 * Rule 2: unchanged repository paths covered by `prohibited` rules are carried
 * forward as prohibited so the repair cannot newly touch them; a changed path
 * is never double-constrained (rule 1 wins). Result: sorted by path, one
 * constraint per path.
 */
function derivePathConstraints(
  contract: ChangeContract,
  scopeAssessment: PathAssessment[],
  repositoryPaths: string[],
): RepairPathConstraint[] {
  const constraints = new Map<string, RepairPathConstraint>()

  for (const entry of scopeAssessment) {
    const mode =
      entry.classification === 'EXPECTED' || entry.classification === 'RELATED'
        ? ('editable' as const)
        : ('restore-to-baseline' as const)
    constraints.set(entry.path, { path: entry.path, mode })
  }

  const changedPaths = new Set(scopeAssessment.map((entry) => entry.path))
  for (const path of repositoryPaths) {
    if (changedPaths.has(path)) continue
    if (contract.paths.prohibited.some((rule) => prohibitedRuleMatches(rule, path))) {
      constraints.set(path, { path, mode: 'prohibited' })
    }
  }

  return [...constraints.values()].sort((left, right) => compareStrings(left.path, right.path))
}

/** must-preserve rules as strings: globs verbatim, categories as `category:<name>`. */
function renderPreserveRule(rule: PathRule): string {
  return typeof rule === 'string' ? rule : `category:${rule.category}`
}

function buildRepairProposal(input: PackageInput): RepairContractProposal {
  return {
    status: 'proposed',
    proposedBy: 'deterministic-evidence',
    originalContractId: input.contract.id,
    verificationRunId: input.verificationRunId,
    verificationContextId: input.verificationContextId,
    targetFindingIds: [...new Set(input.findings.map((finding) => finding.id))].sort(
      compareStrings,
    ),
    objectives: deriveObjectives(input.findings),
    pathConstraints: derivePathConstraints(
      input.contract,
      input.scopeAssessment,
      input.repositoryPaths,
    ),
    mustPreserve: [...new Set(input.contract.paths.mustPreserve.map(renderPreserveRule))].sort(
      compareStrings,
    ),
    evidenceRequired: [...EVIDENCE_REQUIRED],
    stateIdentities: {
      originalBaseline: input.stateIdentities.before,
      violatingState: input.stateIdentities.after,
    },
    approvalNote: APPROVAL_NOTE,
  }
}

/**
 * Assemble the evidence-backed problem statement handed to a change producer.
 * Pure and deterministic: array inputs may arrive in any order; every derived
 * array in the output is canonically sorted, so equal inputs give deep-equal
 * packages.
 */
export function buildEvidencePackage(input: PackageInput): EvidencePackage {
  return {
    verificationRunId: input.verificationRunId,
    verificationContextId: input.verificationContextId,
    contractId: input.contract.id,
    goal: input.contract.goal,
    verdict: input.verdict,
    findings: input.findings,
    scopeAssessment: input.scopeAssessment,
    impact: {
      seeds: [...new Set(input.impact.seeds)].sort(compareStrings),
      affectedCount: input.impact.affected.length,
      affectedTests: [...new Set(input.impact.affectedTests.map((test) => test.path))].sort(
        compareStrings,
      ),
    },
    reproductions: input.reproductions,
    repairProposal: buildRepairProposal(input),
  }
}
