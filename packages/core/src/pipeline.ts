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
import type { PredictionReview } from './schema/impact'
import { REPORT_SCHEMA_VERSION } from './schema/report'
import type { VerificationReport } from './schema/report'
import { runBaselineVerification } from './baseline/runner'
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
 *   (report-only annotation) → integrity gate → evidence-backed report.
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
    findings: gate.findings,
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

  return { ...report, markdown: renderMarkdownReport(report), json: JSON.stringify(report, null, 2) }
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
