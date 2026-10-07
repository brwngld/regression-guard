import { parse as parseYaml } from 'yaml'
import picomatch from 'picomatch'
import { enrichChangeSet } from './analyzer/change'
import { analyzeScope } from './analyzer/scope'
import { computeImpact } from './analyzer/impact'
import type { ImpactModel, ImpactSeed } from './analyzer/impact'
import { buildGraph, refReader, workingTreeReader } from './intel/graph'
import { applyPolicy } from './gate/policy'
import { renderMarkdownReport } from './report/markdown'
import { ContractValidationError, parseContract } from './schema/contract'
import type { ChangeContract, FindingClass, PolicyAction } from './schema/contract'
import type { Finding } from './schema/evidence'
import type { ImpactAssessment, PredictionReview } from './schema/impact'
import type { ReproductionAssessment, StateIdentity } from './schema/reproduction'
import { REPORT_SCHEMA_VERSION } from './schema/report'
import type { VerificationReport } from './schema/report'
import { runBaselineVerification } from './baseline/runner'
import {
  buildExperiments,
  deriveReproductionTestPlan,
  runExperiments,
  type AssessmentWithDetail,
  type ExperimentContext,
} from './reproduction/engine'
import { contractFingerprint, verificationContextId, verificationRunId } from './reproduction/identity'
import { buildEvidencePackage } from './repair/proposal'
import { GitAdapter } from './vcs/git'

export const DEFAULT_TEST_TIMEOUT_MS = 300_000

export interface VerifyInput {
  /** Any directory inside the target repository. */
  repo: string
  before: string
  /** Required in refs mode; ignored (and must be absent) in working-tree mode. */
  after?: string
  /** Parsed contract, or raw YAML text. */
  contract: ChangeContract | string
  /** 'refs' (default) compares two refs; 'working-tree' verifies uncommitted changes on top of `before`. */
  mode?: 'refs' | 'working-tree'
  /** Execute the existing test suite for regression detection (default true). */
  runTests?: boolean
  /** Per-run timeout for test execution in each worktree. */
  testTimeoutMs?: number
  /** false disables reproduction; otherwise overrides contract defaults. */
  reproduction?: false | { attempts?: number; timeoutMs?: number }
}

export interface VerifyOutput extends VerificationReport {
  markdown: string
  json: string
}

function parseContractYaml(text: string): unknown {
  try {
    return parseYaml(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ContractValidationError(`Invalid change contract (YAML syntax): ${detail}`, [])
  }
}

/**
 * Full pipeline:
 *   contract → git diff → enrichment → intelligence graph → scope analysis →
 *   baseline engine (existing tests, before ↔ after) → impact analysis
 *   (report-only annotation) → integrity gate → reproduction (M4, enrichment
 *   only — never re-gates) → evidence-backed report with evidence package.
 */
export async function verifyChange(input: VerifyInput): Promise<VerifyOutput> {
  const contract =
    typeof input.contract === 'string' ? parseContract(parseContractYaml(input.contract)) : input.contract

  const mode = input.mode ?? 'refs'
  if (mode === 'refs' && !input.after) {
    throw new Error('refs mode requires --after (or use working-tree mode)')
  }

  const git = await GitAdapter.open(input.repo)

  const changeSet =
    mode === 'working-tree'
      ? await git.diffWorkingTree(input.before)
      : await git.diffRefs(input.before, input.after ?? 'HEAD')

  const reader =
    mode === 'working-tree'
      ? workingTreeReader(git)
      : refReader(git, input.after ?? 'HEAD')

  const [enriched, graph] = await Promise.all([enrichChangeSet(git, changeSet), buildGraph(reader)])

  const { assessment, findings: scopeFindings } = analyzeScope(contract, enriched, graph)

  // Baseline Engine: deterministic existing-test regression detection.
  let regressions: VerificationReport['threeQuestions']['regressions'] = { status: 'not-verified' }
  let baselineFindings: typeof scopeFindings = []
  let baseline: VerificationReport['baseline']
  if (input.runTests !== false) {
    const outcome = await runBaselineVerification({
      git,
      before: { ref: input.before },
      after: mode === 'working-tree' ? { workingTree: true } : { ref: input.after ?? 'HEAD' },
      workingTreeChanges: mode === 'working-tree' ? changeSet.records : undefined,
      workingTree: mode === 'working-tree' ? changeSet.workingTree : undefined,
      // H2: deleted paths classify coverage loss as explained (file deleted)
      // vs unexplained (file present, ids gone from execution). Both modes.
      deletedPaths: changeSet.records
        .filter((record) => record.status === 'deleted')
        .map((record) => record.path),
      timeoutMs: input.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
    })
    regressions = outcome.regressions
    baselineFindings = outcome.findings
    if (outcome.baseline) {
      baseline = outcome.baseline
    }
  }

  // Impact Analyzer (M3): given every change that actually occurred —
  // regardless of scope classification — compute the evidence-backed blast
  // radius over the intelligence graphs. Pure annotation: it never contributes
  // findings, gate decisions, or verdicts, and never reduces what the Baseline
  // Engine executed.
  let impact: VerificationReport['impact']
  if (changeSet.records.length > 0) {
    const seeds: ImpactSeed[] = changeSet.records.map((record) => ({
      path: record.path,
      status: record.status,
      oldPath: record.oldPath,
    }))
    // The before-state graph is only needed to trace deletions and renames
    // (their importers exist only pre-change); build it lazily so runs
    // without them pay for a single graph pass.
    const needsBeforeGraph = changeSet.records.some(
      (record) => record.status === 'deleted' || record.status === 'renamed',
    )
    const beforeGraph = needsBeforeGraph
      ? await buildGraph(refReader(git, input.before))
      : undefined
    const model = computeImpact(seeds, { after: graph, before: beforeGraph })
    impact = {
      ...model,
      predictionReview: reviewPredictions(model, baseline, baselineFindings, regressions),
    }
  }

  const findings = [...scopeFindings, ...baselineFindings]
  const gate = applyPolicy(findings, contract.policy as Partial<Record<FindingClass, PolicyAction>>)

  // M4 lineage. Two deliberately distinct identities: the context id is a
  // deterministic hash of (contract identity — id, version AND parsed content
  // fingerprint — + compared state identities + finding identities) — the same
  // logical verification situation yields the same id across runs and repair
  // loops; the run id additionally carries a timestamp and random entropy so
  // each execution stays distinguishable.
  const beforeState: StateIdentity = { label: input.before, kind: 'ref', sha: changeSet.beforeSha }
  const afterState: StateIdentity =
    mode === 'working-tree'
      ? {
          label: 'working-tree',
          kind: 'working-tree',
          sha: null,
          baseSha: changeSet.workingTree?.baseSha,
          fingerprint: changeSet.workingTree?.fingerprint,
        }
      // Refs mode always resolves the after SHA (diffRefs rev-parses it);
      // null is a working-tree-mode-only value.
      : { label: input.after ?? 'HEAD', kind: 'ref', sha: changeSet.afterSha! }
  const contextId = verificationContextId({
    contractId: contract.id,
    contractVersion: contract.version,
    contractFingerprint: contractFingerprint(contract),
    before: beforeState,
    after: afterState,
    findingIds: findings.map((finding) => finding.id),
  })
  const runId = verificationRunId(contextId)

  // Reproduction Engine (M4): re-execute deterministic evidence against the
  // EXACT recorded state, in isolation. Enrichment only — no outcome ever
  // deletes, downgrades, or re-gates the findings above.
  let assessments: ReproductionAssessment[] = []
  const reproductionConfig =
    input.reproduction === false
      ? null
      : {
          attempts: input.reproduction?.attempts ?? contract.reproduction.attempts,
          timeoutMs: input.reproduction?.timeoutMs ?? contract.reproduction.timeoutMs,
        }
  if (reproductionConfig !== null && findings.length > 0) {
    // M4.2: the reproduction plan is derived from the RECORDED immutable after
    // state (recorded SHA, or base SHA + verified fingerprint) — a movable
    // label can never redefine what the experiment means.
    const experimentContext: ExperimentContext = {
      git,
      before: beforeState,
      after: afterState,
      testPlan: await deriveReproductionTestPlan(git, beforeState, afterState),
      config: reproductionConfig,
    }
    const experiments = buildExperiments(findings, experimentContext)
    if (experiments.length > 0) {
      assessments = (await runExperiments(experiments, experimentContext)).map(stripRuntimeDetail)
    }
  }

  // Enrich the gate's ordered findings after the fact: order and ids are
  // preserved and the gate decision itself is never recomputed.
  const reproductionByFinding = new Map<string, ReproductionAssessment>()
  for (const assessment of assessments) {
    for (const findingId of assessment.sourceFindingIds) {
      reproductionByFinding.set(findingId, assessment)
    }
  }
  const reportedFindings = gate.findings.map((finding) => {
    const reproduction = reproductionByFinding.get(finding.id)
    return reproduction === undefined ? finding : { ...finding, reproduction }
  })

  const mustChangeGlobs = contract.paths.mustChange.filter(
    (rule): rule is string => typeof rule === 'string',
  )
  const touchedGlobs = mustChangeGlobs.filter((glob) =>
    enriched.records.some((record) =>
      (record.oldPath ? [record.path, record.oldPath] : [record.path]).some((path) =>
        pathMatchesGlob(path, glob),
      ),
    ),
  )
  const accomplished: VerificationReport['threeQuestions']['accomplished'] =
    mustChangeGlobs.length === 0
      ? 'unknown'
      : touchedGlobs.length === mustChangeGlobs.length
        ? 'yes'
        : touchedGlobs.length === 0
          ? 'no'
          : 'partial'

  const withinScope = findings.some((finding) =>
    ['prohibited-change', 'preserved-area-changed', 'out-of-scope-change'].includes(finding.findingClass),
  )
    ? 'no'
    : 'yes'

  const count = (classification: string) =>
    assessment.perPath.filter((item) => item.classification === classification).length

  const report: VerificationReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    verificationContextId: contextId,
    verificationRunId: runId,
    contractId: contract.id,
    goal: contract.goal,
    repoRoot: git.repoRoot,
    before: input.before,
    after: mode === 'working-tree' ? 'working-tree' : (input.after ?? 'HEAD'),
    beforeSha: changeSet.beforeSha,
    afterSha: changeSet.afterSha,
    threeQuestions: { accomplished, withinScope, regressions },
    verdict: gate.verdict,
    triggeredActions: gate.triggeredActions,
    perPath: assessment.perPath,
    findings: reportedFindings,
    statistics: {
      filesChanged: assessment.perPath.length,
      expected: count('EXPECTED'),
      related: count('RELATED'),
      suspicious: count('SUSPICIOUS'),
      outOfScope: count('OUT_OF_SCOPE'),
      prohibited: count('PROHIBITED'),
      findings: findings.length,
    },
  }
  if (baseline !== undefined) {
    report.baseline = baseline
  }
  if (impact !== undefined) {
    report.impact = impact
  }
  if (changeSet.workingTree !== undefined) {
    report.workingTree = changeSet.workingTree
  }

  // Evidence Package (M4): the evidence-backed problem statement handed to a
  // change producer, including the PROPOSAL-ONLY repair contract. Findings
  // imply changed records, which imply impact — the empty guard below only
  // covers a hypothetical findings-without-records run.
  if (findings.length > 0) {
    report.evidencePackage = buildEvidencePackage({
      contract,
      findings: reportedFindings,
      scopeAssessment: assessment.perPath,
      impact: impact ?? EMPTY_IMPACT,
      reproductions: assessments,
      stateIdentities: { before: beforeState, after: afterState },
      verificationRunId: runId,
      verificationContextId: contextId,
      repositoryPaths: Object.keys(graph.files),
      verdict: gate.verdict,
    })
  }

  return { ...report, markdown: renderMarkdownReport(report), json: JSON.stringify(report, null, 2) }
}

/** Minimal empty impact model for the guarded evidence-package path. */
const EMPTY_IMPACT: ImpactAssessment = {
  seeds: [],
  affected: [],
  affectedTests: [],
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

/**
 * runExperiments may attach a runtime-only `detail` to an assessment; the
 * persisted ReproductionAssessment schema has no such field, so it is stripped
 * before the assessment is attached to a finding or the evidence package.
 */
function stripRuntimeDetail(assessment: AssessmentWithDetail): ReproductionAssessment {
  const { detail: _detail, ...persisted } = assessment
  return persisted
}

function pathMatchesGlob(path: string, glob: string): boolean {
  return picomatch.isMatch(path, glob, { dot: true })
}

/**
 * Prediction-vs-reality: measure how well the Impact Analyzer's predicted test
 * population explains the regressions the Baseline Engine actually observed.
 * Measurement only — a prediction miss means the analyzer's blast radius was
 * incomplete, never that the change deserves additional rejection (M2's
 * findings already cover the real regressions).
 */
function reviewPredictions(
  impact: ImpactModel,
  baseline: VerificationReport['baseline'],
  findings: Finding[],
  regressions: VerificationReport['threeQuestions']['regressions'],
): PredictionReview {
  const predictedTests = impact.affectedTests.length
  const observedRegressions = regressions.regressionsFound ?? 0
  if (baseline === undefined) {
    // No baseline ran (tests skipped, or the runner could not verify
    // anything): there is no observed reality to compare predictions against.
    return {
      mode: 'not-applicable',
      predictedTests,
      observedRegressions,
      predictedRegressions: 0,
      predictionMisses: [],
    }
  }
  if (!baseline.perTest) {
    // Suite-level outcomes carry no per-test attribution; predicted/misses
    // would be noise, so the mode alone conveys the limitation.
    return {
      mode: 'suite',
      predictedTests,
      observedRegressions,
      predictedRegressions: 0,
      predictionMisses: [],
    }
  }
  const affectedTestPaths = new Set(impact.affectedTests.map((test) => test.path))
  let predictedRegressions = 0
  const predictionMisses: PredictionReview['predictionMisses'] = []
  for (const finding of findings) {
    if (finding.findingClass !== 'test-regression') continue
    const canonical = canonicalTestPath(finding.paths[0], affectedTestPaths)
    if (canonical !== undefined && affectedTestPaths.has(canonical)) {
      predictedRegressions += 1
      continue
    }
    predictionMisses.push({
      test: regressionDisplayName(finding, canonical ?? finding.paths[0]),
      file: canonical ?? finding.paths[0],
    })
  }
  return { mode: 'per-test', predictedTests, observedRegressions, predictedRegressions, predictionMisses }
}

/**
 * Reduce a regression finding's reported test file to a repo-relative canonical
 * path. Runners report suite paths as absolute worktree locations on some
 * platforms, so a file is canonical when it equals an affected test path or
 * ends with it as a path segment (`…/before/src/a.test.js` → `src/a.test.js`).
 * Returns undefined when no file was reported.
 */
function canonicalTestPath(
  file: string | undefined,
  knownPaths: Set<string>,
): string | undefined {
  if (file === undefined) return undefined
  const normalized = file.replace(/\\/g, '/')
  const candidates = [...knownPaths].sort((a, b) => b.length - a.length)
  for (const candidate of candidates) {
    if (normalized === candidate || normalized.endsWith(`/${candidate}`)) return candidate
  }
  return file
}

/** `Test "X" …` → `X`; falls back to the file basename when no quoted name exists. */
function regressionDisplayName(finding: Finding, file: string | undefined): string {
  const quoted =
    /Test "([^"]+)"/.exec(finding.evidence.claim) ?? /Test "([^"]+)"/.exec(finding.message)
  if (quoted?.[1] !== undefined) return quoted[1]
  if (file !== undefined) return file.slice(file.lastIndexOf('/') + 1) || file
  return '(unnamed test)'
}
