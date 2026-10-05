import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runCommand, type RunOutcome } from '../exec/run'
import {
  discoverTestCommand,
  packageJsonHasDependencies,
  selectDependencyInstall,
  TEST_RESULT_FILE,
} from '../baseline/discover'
import { parseRunnerJson } from '../baseline/parse'
import type { TestCaseOutcome } from '../schema/baseline'
import type { ChangeRecord } from '../schema/changeset'
import type { Finding } from '../schema/evidence'
import { SERVICE_MANIFEST_FILE, type ProbeOutcome } from '../schema/service'
import { parseServiceManifest } from '../service/manifest'
import { runServiceProbes } from '../service/runtime'
import type {
  AttemptOutcome,
  ExperimentGranularity,
  ReproductionAssessment,
  ReproductionAttempt,
  ReproductionCommand,
  ReproductionExperiment,
  StateIdentity,
} from '../schema/reproduction'
import type { GitAdapter } from '../vcs/git'

/**
 * M4 Reproduction Engine. A finding is stronger evidence when it can be
 * reproduced: experiments re-execute deterministic evidence against the EXACT
 * recorded state, and the assessment qualifies stability without ever
 * rewriting the original observation (M2's finding stands regardless of the
 * reproduction outcome).
 *
 * M4.1 invariants:
 * - Attempt isolation: every attempt gets a FRESH materialization (its own
 *   mkdtemp base, worktree, and dependency restoration), so attempt outcomes
 *   can never be contaminated by earlier attempts' filesystem side effects.
 * - Immutable execution: only immutable identities (recorded SHAs, verified
 *   fingerprints) cross the execution boundary; labels are presentation.
 * - Per-attempt attribution: every recorded attempt carries its experiment id
 *   and the state identity it executed against.
 *
 * The user's checkout is never mutated: worktrees live in mkdtemp directories
 * and are removed even on failure. Working-tree states are guarded by the
 * M2.1 fingerprint — re-verified per attempt; on drift nothing executes.
 */

export interface ExperimentContext {
  git: GitAdapter
  /** Identity of the BEFORE state (ref mode: the before ref; working-tree mode: same as after's base). */
  before: StateIdentity
  /** Identity of the verified AFTER state (ref or working-tree with baseSha+fingerprint). */
  after: StateIdentity
  /** Test command knowledge derived from the RECORDED after state (null when it declares no test command). */
  testPlan: {
    runner: 'vitest' | 'jest' | 'generic'
    userCommand: string
    buildExecutedCommand: () => string
    /** Whether deps were declared (install needed in worktrees). */
    testCommandInstalled: boolean
  } | null
  config: { attempts: number; timeoutMs: number }
}

/**
 * M4.2: derive the reproduction test plan from the RECORDED immutable after
 * state — never from a movable label. A branch that moves after verification
 * (even to a commit whose package.json declares an entirely different runner)
 * cannot redefine what the experiment means.
 *
 * - refs mode: read package.json at the recorded after SHA.
 * - working-tree mode: re-derive the dirty state against the recorded before
 *   SHA and verify the fingerprint. On a match, package.json comes from the
 *   overlay when the change touched it (the fingerprint proves the current
 *   checkout IS the recorded state) or from the recorded base SHA otherwise.
 *   On drift, fall back to the base SHA's package.json: whatever plan is
 *   derived, every attempt re-verifies the fingerprint per attempt and aborts
 *   as inconclusive — the drifted checkout can never redefine the experiment.
 */
export async function deriveReproductionTestPlan(
  git: GitAdapter,
  before: StateIdentity,
  after: StateIdentity,
): Promise<ExperimentContext['testPlan']> {
  let pkgText: string | null = null

  if (after.kind === 'ref') {
    pkgText = after.sha === null ? null : await git.readFileAt(after.sha, 'package.json')
  } else {
    // Only immutable identities: the recorded before SHA anchors the dirty
    // state; the recorded base SHA backs the package.json. A null SHA (never
    // produced by the pipeline) yields no plan rather than a label fallback.
    const beforeSha = before.sha
    const baseSha = after.baseSha ?? before.sha
    if (beforeSha === null || baseSha === null) {
      return null
    }
    const now = await git.diffWorkingTree(beforeSha)
    const matched = now.workingTree?.fingerprint !== undefined && now.workingTree.fingerprint === after.fingerprint
    const overlayTouchedPackageJson = matched
      ? now.records.some(
          (record) => record.path === 'package.json' && (record.status === 'modified' || record.status === 'created'),
        )
      : false
    pkgText = matched && overlayTouchedPackageJson
      ? await readFile(join(git.repoRoot, 'package.json'), 'utf8').catch(() => null)
      : await git.readFileAt(baseSha, 'package.json')
  }

  const plan = discoverTestCommand(pkgText)
  if (plan === null) {
    return null
  }
  return {
    runner: plan.runner,
    userCommand: plan.userCommand,
    buildExecutedCommand: plan.buildExecutedCommand,
    testCommandInstalled: packageJsonHasDependencies(pkgText),
  }
}

/** Runtime-only enrichment: the persisted schema carries `stateMatched`, not prose. */
export type AssessmentWithDetail = ReproductionAssessment & { detail?: string }

type DirectRunner = 'vitest' | 'jest'

/** Finding classes whose evidence is a path-shaped diff fact. */
const GIT_DIFF_CLASSES: ReadonlySet<string> = new Set([
  'prohibited-change',
  'preserved-area-changed',
  'out-of-scope-change',
  'sensitive-file-changed',
  'deleted-test',
  'new-dependency',
  'removed-dependency',
  'changed-dependency',
])

/** Deterministic, class-specific purpose strings for git-diff experiments. */
const GIT_DIFF_PURPOSE: Readonly<Record<string, string>> = {
  'prohibited-change': 'Re-derive the state diff to confirm the prohibited path changed.',
  'preserved-area-changed': 'Re-derive the state diff to confirm the must-preserve path changed.',
  'out-of-scope-change': 'Re-derive the state diff to confirm the out-of-scope path changed.',
  'sensitive-file-changed': 'Re-derive the state diff to confirm the sensitive file changed.',
  'deleted-test': 'Re-derive the state diff to confirm the test file was deleted.',
  'new-dependency': 'Re-derive the state diff to confirm the dependency manifest gained an entry.',
  'removed-dependency': 'Re-derive the state diff to confirm the dependency manifest lost an entry.',
  'changed-dependency': 'Re-derive the state diff to confirm the dependency manifest entry changed.',
}

const GIT_DIFF_PURPOSE_FALLBACK = 'Re-derive the state diff to confirm the finding path changed.'

const TEST_PURPOSE: Readonly<Record<Exclude<ExperimentGranularity, 'n/a'>, string>> = {
  case: 'Re-run the single failing test case against the recorded after state.',
  file: 'Re-run the failing test file against the recorded after state.',
  suite: 'Re-run the full test suite against the recorded after state.',
  probe: 'Re-run the failing HTTP probe against the recorded after state.',
}

/**
 * Build experiments from gate-ordered findings. Deterministic: experiments
 * follow finding order, ids are REPRO-001… over the experiments actually
 * created, and every command is a structured executable+args form (a shell
 * string is never the source of truth). Unsafe-to-quote test names downgrade
 * the granularity ladder rather than being executed.
 */
export function buildExperiments(
  findings: Finding[],
  context: ExperimentContext,
): ReproductionExperiment[] {
  const experiments: ReproductionExperiment[] = []
  for (const finding of findings) {
    let experiment: ReproductionExperiment | null = null
    if (finding.findingClass === 'test-regression') {
      experiment = buildTestExperiment(finding, context, nextExperimentId(experiments.length))
    } else if (
      finding.findingClass === 'service-regression' ||
      finding.findingClass === 'api-contract-regression'
    ) {
      // Contract-sourced probe regressions (M5b) reproduce exactly like inline
      // ones: the probe id rides the shared `Probe "<id>"` message pattern, and
      // the one-probe rerun performs the same contract evaluation because the
      // filtered manifest copies the probe declaration — fromContract included —
      // verbatim and the materialized worktree carries the recorded OpenAPI file.
      experiment = buildProbeExperiment(finding, context, nextExperimentId(experiments.length))
    } else if (GIT_DIFF_CLASSES.has(finding.findingClass)) {
      experiment = buildGitDiffExperiment(finding, context, nextExperimentId(experiments.length))
    }
    // unfulfilled-contract, pre-existing-failure, baseline-incomplete,
    // test-command-changed, service-manifest-changed, api-contract-changed,
    // service-manifest-invalid (and anything pathless) get no experiment.
    if (experiment !== null) {
      experiments.push(experiment)
    }
  }
  return experiments
}

function nextExperimentId(created: number): string {
  return `REPRO-${String(created + 1).padStart(3, '0')}`
}

/**
 * `test-regression` experiment with a granularity ladder that records what was
 * ACHIEVED, never more:
 * - file: the regressed test's file is known (and safely quotable) → run just
 *   that file; the case-level OUTCOME is still determined precisely by
 *   matching `testName` against the runner's parsed results;
 * - suite: fallback — the canonical result-file suite command (direct runners)
 *   or `npm test` (generic runner, so the declared script — including shell
 *   operators — executes verbatim under npm's own shell).
 *
 * Runner name-pattern flags (`-t`) are deliberately NOT used for execution:
 * their matching semantics differ across runners and versions (vitest matches
 * against ` > `-joined internal names while its JSON reporter emits
 * space-joined fullNames — a `-t` filter built from the reported name
 * silently matched nothing in practice, reporting all tests skipped).
 *
 * Returns null when no test command is known at all: without a command there
 * is nothing honest to re-run.
 */
function buildTestExperiment(
  finding: Finding,
  context: ExperimentContext,
  id: string,
): ReproductionExperiment | null {
  const plan = context.testPlan
  if (plan === null) {
    return null
  }
  const file = finding.paths[0]
  const name = testTargetName(finding)

  let command: ReproductionCommand
  let granularity: Exclude<ExperimentGranularity, 'n/a'>
  if (plan.runner === 'vitest' || plan.runner === 'jest') {
    const built = directRunnerCommand(plan.runner, file)
    command = built.command
    granularity = built.granularity
  } else {
    // Generic scripts are arbitrary shell strings; the structured command
    // never re-tokenizes a shell string, so the rerun goes through npm.
    command = { executable: 'npm', args: ['test'], cwd: '<isolated-worktree>' }
    granularity = 'suite'
  }

  return {
    id,
    kind: 'test',
    purpose: TEST_PURPOSE[granularity],
    command,
    granularity,
    timeoutMs: context.config.timeoutMs,
    stateIdentity: context.after,
    sourceFindingIds: [finding.id],
    testName: name,
  }
}

/**
 * Highest rung achievable for a direct runner. The canonical result-file
 * invocation is used at every rung (deterministic, safely quotable); extra
 * flags declared in the script are not carried into reproduction because the
 * structured command is authoritative, not the script's shell string.
 */
function directRunnerCommand(
  runner: DirectRunner,
  file: string | undefined,
): { command: ReproductionCommand; granularity: 'file' | 'suite' } {
  const base =
    runner === 'vitest'
      ? ['vitest', 'run', '--reporter=json', `--outputFile=${TEST_RESULT_FILE}`]
      : ['jest', '--json', `--outputFile=${TEST_RESULT_FILE}`]
  if (file !== undefined && shellQuote(file) !== null) {
    return {
      command: { executable: 'npx', args: [...base, file], cwd: '<isolated-worktree>' },
      granularity: 'file',
    }
  }
  return { command: { executable: 'npx', args: base, cwd: '<isolated-worktree>' }, granularity: 'suite' }
}

/**
 * The regression's test name, as quoted by the Baseline Engine's findings.
 * The greedy patterns capture quotes INSIDE the name (they stay part of the
 * name and force a granularity downgrade, rather than silently truncating to
 * a wrong `-t` filter); the simple pattern is the fallback for messages that
 * only embed the name without a verb anchor. Message patterns always take
 * precedence over claim patterns.
 */
function testTargetName(finding: Finding): string | undefined {
  return (
    /Test "(.+)" passed at baseline/.exec(finding.message)?.[1] ??
    /Test "([^"]+)"/.exec(finding.message)?.[1] ??
    /Test "(.+)" regressed/.exec(finding.evidence.claim)?.[1] ??
    /Test "([^"]+)"/.exec(finding.evidence.claim)?.[1]
  )
}

/**
 * `service-regression` / `api-contract-regression` experiment (M5/M5b): re-run
 * the ONE failing probe against the recorded after state. The structured
 * command names an ENGINE-INTERNAL execution path — the service startup is a
 * repo-declared shell string from the manifest, never a fixed binary, so no
 * shell rendering exists: each attempt materializes the recorded state fresh
 * (M4.1), derives the manifest from that state, and executes a one-probe run
 * via the service runtime. The one-probe manifest copies the probe declaration
 * verbatim, so a `fromContract` probe re-evaluates against the OpenAPI file
 * recorded in the same materialized state. Returns null when the finding
 * carries no quotable probe id.
 */
function buildProbeExperiment(
  finding: Finding,
  context: ExperimentContext,
  id: string,
): ReproductionExperiment | null {
  const probeId = probeTargetName(finding)
  if (probeId === undefined) {
    return null
  }
  return {
    id,
    kind: 'http-probe',
    purpose: TEST_PURPOSE.probe,
    command: {
      executable: 'regression-guard-internal',
      args: ['service-probe', probeId],
      cwd: '<isolated-worktree>',
    },
    granularity: 'probe',
    timeoutMs: context.config.timeoutMs,
    stateIdentity: context.after,
    sourceFindingIds: [finding.id],
  }
}

/**
 * The regression's probe id, as quoted by the Baseline Engine's probe
 * findings — the exact mirror of testTargetName's message-first discipline.
 */
function probeTargetName(finding: Finding): string | undefined {
  return (
    /Probe "(.+)" passed at baseline/.exec(finding.message)?.[1] ??
    /Probe "([^"]+)"/.exec(finding.message)?.[1] ??
    /Probe "(.+)" regressed/.exec(finding.evidence.claim)?.[1] ??
    /Probe "([^"]+)"/.exec(finding.evidence.claim)?.[1]
  )
}

/** git-diff experiment: re-derive the path's presence between the two states. */
function buildGitDiffExperiment(
  finding: Finding,
  context: ExperimentContext,
  id: string,
): ReproductionExperiment | null {
  const path = finding.paths[0]
  if (path === undefined) {
    return null
  }
  const beforeToken = refToken(context.before)
  // Immutable SHAs, never labels: labels are presentation and can move after
  // verification. In working-tree mode the recorded baseSha is the after-side
  // immutable anchor ('HEAD' is a label that resolves differently later).
  const afterToken =
    context.after.kind === 'ref' ? refToken(context.after) : (context.after.baseSha ?? 'HEAD')
  return {
    id,
    kind: 'git-diff',
    purpose: GIT_DIFF_PURPOSE[finding.findingClass] ?? GIT_DIFF_PURPOSE_FALLBACK,
    command: { executable: 'git', args: ['diff', beforeToken, afterToken, '--', path], cwd: '<repo>' },
    granularity: 'n/a',
    timeoutMs: context.config.timeoutMs,
    stateIdentity: context.after,
    sourceFindingIds: [finding.id],
  }
}

/** Ref-ish token for a state identity: the immutable SHA when known. */
function refToken(identity: StateIdentity): string {
  if (identity.kind === 'ref' && identity.sha !== null) {
    return identity.sha
  }
  if (identity.baseSha !== undefined) {
    return identity.baseSha
  }
  return identity.label
}

/**
 * Execute experiments in isolation, sequentially (deterministic). NEVER
 * touches the user checkout: test experiments materialize a FRESH isolated
 * worktree per ATTEMPT and remove it afterwards (attempt isolation — see
 * runTestExperiment); http-probe experiments follow the same per-attempt
 * materialization via the service runtime (runProbeExperiment); git-diff
 * experiments re-derive evidence read-only through the git adapter.
 */
export async function runExperiments(
  experiments: ReproductionExperiment[],
  context: ExperimentContext,
): Promise<ReproductionAssessment[]> {
  const assessments: ReproductionAssessment[] = []
  for (const experiment of experiments) {
    assessments.push(
      experiment.kind === 'git-diff'
        ? await runGitDiffExperiment(experiment, context)
        : experiment.kind === 'http-probe'
          ? await runProbeExperiment(experiment, context)
          : await runTestExperiment(experiment, context),
    )
  }
  return assessments
}

/**
 * The immutable token an EXECUTION path may use: the recorded SHA (or, for
 * working-tree bases, the base SHA). Labels never cross the execution
 * boundary — they are presentation and can move after verification. Throws
 * when an identity carries no immutable token at all.
 */
function immutableToken(identity: StateIdentity): string {
  if (identity.sha !== null) {
    return identity.sha
  }
  if (identity.baseSha !== undefined) {
    return identity.baseSha
  }
  throw new Error(`state '${identity.label}' carries no immutable SHA to execute against`)
}

/**
 * git-diff experiment: no worktree needed. Ref mode re-derives via
 * diffRefs(before SHA, after SHA) — the recorded immutable identities, never
 * the labels; working-tree mode re-derives diffWorkingTree NOW against the
 * recorded before SHA and requires the fingerprint to still match.
 * Reproduced iff the finding's path appears among the re-derived records.
 * One attempt only — the evidence is deterministic.
 */
async function runGitDiffExperiment(
  experiment: ReproductionExperiment,
  context: ExperimentContext,
): Promise<AssessmentWithDetail> {
  const requested = 1
  const startedAt = Date.now()
  try {
    let records: ChangeRecord[]
    if (context.after.kind === 'ref') {
      // Refs are immutable → stateMatched = true. Execute by SHA: a label can
      // have moved to a different commit since verification.
      records = (
        await context.git.diffRefs(immutableToken(context.before), immutableToken(context.after))
      ).records
    } else {
      const rederived = await context.git.diffWorkingTree(immutableToken(context.before))
      const current = rederived.workingTree?.fingerprint
      const recorded = context.after.fingerprint
      if (recorded === undefined || current !== recorded) {
        return withDetail(
          aggregateAssessment(experiment, [], false, requested),
          fingerprintMismatchDetail(recorded, current),
        )
      }
      records = rederived.records
    }

    const path = diffTargetPath(experiment)
    const hit = path !== undefined ? records.find((r) => r.path === path || r.oldPath === path) : undefined
    const durationMs = Date.now() - startedAt
    const attempt: ReproductionAttempt = {
      index: 1,
      experimentId: experiment.id,
      stateIdentity: { ...experiment.stateIdentity },
      outcome: hit !== undefined ? 'reproduced' : 'not-reproduced',
      // No child process ran; 0 denotes "the deterministic evidence step completed".
      exitCode: 0,
      durationMs,
      timedOut: false,
      detail:
        hit !== undefined
          ? `path ${hit.path} present in the re-derived diff (status ${hit.status})`
          : `path ${path ?? '(none)'} absent from the re-derived diff`,
    }
    return aggregateAssessment(experiment, [attempt], true, requested)
  } catch (error) {
    return withDetail(
      aggregateAssessment(experiment, [], false, requested),
      `state could not be re-derived: ${errorMessage(error)}`,
    )
  }
}

/**
 * Test experiment: EVERY attempt executes against a FRESH isolated
 * materialization of the recorded state (mkdtemp base → worktree at the
 * recorded immutable SHA, plus the verified overlay in working-tree mode →
 * dependency restoration → execution → cleanup). Attempt N therefore never
 * runs on filesystem state left behind by attempt N-1, so outcome variance
 * means genuine inconsistency, never cross-attempt contamination. Working-tree
 * states are fingerprint-verified PER ATTEMPT (the developer may keep editing
 * between attempts); a mismatched attempt is recorded as inconclusive with
 * stateMatched-false semantics and never executes. Cost is accepted
 * deliberately: correctness over performance (no caching, no state reset).
 */
async function runTestExperiment(
  experiment: ReproductionExperiment,
  context: ExperimentContext,
): Promise<AssessmentWithDetail> {
  const requested = context.config.attempts
  const attempts: ReproductionAttempt[] = []
  let stateMatched = true
  for (let index = 1; index <= requested; index += 1) {
    const isolated = await runIsolatedAttempt(experiment, context, index)
    attempts.push(isolated.attempt)
    if (!isolated.stateMatched) {
      stateMatched = false
    }
  }
  return aggregateAssessment(experiment, attempts, stateMatched, requested)
}

/**
 * One attempt inside its own fresh materialization. Nothing crosses the
 * attempt boundary: a new mkdtemp base per attempt, worktree creation from
 * the recorded SHA (never a label), the same selectDependencyInstall
 * discipline per materialization, and cleanup in finally (removeWorktree +
 * retrying rm) even on failure.
 */
async function runIsolatedAttempt(
  experiment: ReproductionExperiment,
  context: ExperimentContext,
  index: number,
): Promise<{ attempt: ReproductionAttempt; stateMatched: boolean }> {
  let baseDir: string | null = null
  let worktreeDir: string | null = null
  try {
    baseDir = await mkdtemp(join(tmpdir(), 'rg-repro-'))

    // State verification + materialization, per attempt.
    let overlay: ChangeRecord[] | undefined
    let checkoutRef: string
    if (context.after.kind === 'ref') {
      // Refs are immutable → stateMatched = true. The checkout target is the
      // recorded SHA; a label may have moved since verification.
      checkoutRef = immutableToken(context.after)
    } else {
      // Re-derive per attempt against the recorded immutable before SHA; the
      // developer may keep editing, so the fingerprint is verified EVERY attempt.
      const rederived = await context.git.diffWorkingTree(immutableToken(context.before))
      const current = rederived.workingTree?.fingerprint
      const recorded = context.after.fingerprint
      if (recorded === undefined || current !== recorded) {
        // Never silently reproduce against a different state. This attempt is
        // inconclusive with stateMatched-false semantics; no execution.
        return {
          attempt: unexecutedAttempt(experiment, index, fingerprintMismatchDetail(recorded, current)),
          stateMatched: false,
        }
      }
      overlay = rederived.records
      checkoutRef = context.after.baseSha ?? rederived.workingTree?.baseSha ?? immutableToken(context.after)
    }

    worktreeDir = join(baseDir, 'worktree')
    await context.git.createWorktree(worktreeDir, checkoutRef)
    if (overlay !== undefined) {
      await overlayWorkingTree(context.git, worktreeDir, overlay)
    }

    // Dependency restoration, exactly as baseline discovery dictates.
    const installFailure = await restoreDependencies(worktreeDir, context)
    if (installFailure !== null) {
      // The state matched and materialized; the toolchain could not be
      // restored, so the test command never executed in THIS attempt.
      return {
        attempt: unexecutedAttempt(
          experiment,
          index,
          `dependency installation failed (${installFailure.strategy}, exit ${installFailure.exitCode ?? 'killed'}): the test command never executed`,
          installFailure.timedOut,
        ),
        stateMatched: true,
      }
    }

    return { attempt: await runSingleAttempt(experiment, context, worktreeDir, index), stateMatched: true }
  } catch (error) {
    return {
      attempt: unexecutedAttempt(experiment, index, `state could not be materialized: ${errorMessage(error)}`),
      stateMatched: false,
    }
  } finally {
    if (worktreeDir !== null) {
      await context.git.removeWorktree(worktreeDir).catch(() => {})
    }
    if (baseDir !== null) {
      // Retries: Windows may briefly lock files held by just-killed trees.
      await rm(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    }
  }
}

/** An attempt that never executed: attributable to its experiment and the recorded state, with the reason. */
function unexecutedAttempt(
  experiment: ReproductionExperiment,
  index: number,
  detail: string,
  timedOut: boolean = false,
): ReproductionAttempt {
  return {
    index,
    experimentId: experiment.id,
    stateIdentity: { ...experiment.stateIdentity },
    outcome: 'inconclusive',
    exitCode: null,
    durationMs: 0,
    timedOut,
    detail,
  }
}

/**
 * http-probe experiment (M5): bounded N-of-M, every attempt a FRESH
 * materialization of the recorded after state (same M4.1 discipline as test
 * experiments). The execution path is engine-internal, not a shell: the
 * attempt derives the service manifest from the RECORDED state, filters it to
 * the one target probe, boots the declared services via the service runtime,
 * and maps the probe outcome — failed reproduces, passed does not, unknown is
 * inconclusive with its reason.
 */
async function runProbeExperiment(
  experiment: ReproductionExperiment,
  context: ExperimentContext,
): Promise<AssessmentWithDetail> {
  const requested = context.config.attempts
  const attempts: ReproductionAttempt[] = []
  let stateMatched = true
  for (let index = 1; index <= requested; index += 1) {
    const isolated = await runIsolatedProbeAttempt(experiment, context, index)
    attempts.push(isolated.attempt)
    if (!isolated.stateMatched) {
      stateMatched = false
    }
  }
  return aggregateAssessment(experiment, attempts, stateMatched, requested)
}

/** The probe id an http-probe experiment targets (carried in its structured command args). */
function probeIdOf(experiment: ReproductionExperiment): string | undefined {
  const args = experiment.command.args
  const flag = args.indexOf('service-probe')
  const value = flag !== -1 ? args[flag + 1] : args.at(-1)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * One probe attempt inside its own fresh materialization: mkdtemp base →
 * worktree at the recorded immutable SHA (plus the fingerprint-verified
 * overlay in working-tree mode, re-verified EVERY attempt) → dependency
 * restoration → manifest-derived one-probe execution → cleanup in finally.
 */
async function runIsolatedProbeAttempt(
  experiment: ReproductionExperiment,
  context: ExperimentContext,
  index: number,
): Promise<{ attempt: ReproductionAttempt; stateMatched: boolean }> {
  let baseDir: string | null = null
  let worktreeDir: string | null = null
  try {
    baseDir = await mkdtemp(join(tmpdir(), 'rg-repro-probe-'))

    // State verification + materialization, per attempt — identical rules to
    // test attempts: recorded SHAs only, fingerprint re-verified per attempt.
    let overlay: ChangeRecord[] | undefined
    let checkoutRef: string
    if (context.after.kind === 'ref') {
      checkoutRef = immutableToken(context.after)
    } else {
      const rederived = await context.git.diffWorkingTree(immutableToken(context.before))
      const current = rederived.workingTree?.fingerprint
      const recorded = context.after.fingerprint
      if (recorded === undefined || current !== recorded) {
        return {
          attempt: unexecutedAttempt(experiment, index, fingerprintMismatchDetail(recorded, current)),
          stateMatched: false,
        }
      }
      overlay = rederived.records
      checkoutRef = context.after.baseSha ?? rederived.workingTree?.baseSha ?? immutableToken(context.after)
    }

    worktreeDir = join(baseDir, 'worktree')
    await context.git.createWorktree(worktreeDir, checkoutRef)
    if (overlay !== undefined) {
      await overlayWorkingTree(context.git, worktreeDir, overlay)
    }

    // The service command is repo-declared and may need dependencies exactly
    // like a test command (a repo can declare services with no test command
    // at all): same deterministic restoration per materialization.
    const installFailure = await restoreProbeDependencies(worktreeDir, context)
    if (installFailure !== null) {
      return {
        attempt: unexecutedAttempt(
          experiment,
          index,
          `dependency installation failed (${installFailure.strategy}, exit ${installFailure.exitCode ?? 'killed'}): the declared service never started`,
          installFailure.timedOut,
        ),
        stateMatched: true,
      }
    }

    return {
      attempt: await executeProbeAttempt(experiment, context, worktreeDir, overlay, index),
      stateMatched: true,
    }
  } catch (error) {
    return {
      attempt: unexecutedAttempt(experiment, index, `state could not be materialized: ${errorMessage(error)}`),
      stateMatched: false,
    }
  } finally {
    if (worktreeDir !== null) {
      await context.git.removeWorktree(worktreeDir).catch(() => {})
    }
    if (baseDir !== null) {
      // Retries: Windows may briefly lock files held by just-killed trees.
      await rm(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    }
  }
}

/**
 * The service-manifest text of the RECORDED after state — the same immutable
 * derivation discipline as deriveReproductionTestPlan: refs read the file at
 * the recorded SHA; working-tree mode reads the fingerprint-verified overlay
 * when the change touched the manifest (the fingerprint proves the checkout
 * IS the recorded state), the recorded base SHA otherwise. Labels never cross
 * the boundary.
 */
async function manifestTextForState(
  context: ExperimentContext,
  overlay: ChangeRecord[] | undefined,
): Promise<string | null> {
  if (context.after.kind === 'ref') {
    return context.after.sha === null
      ? null
      : await context.git.readFileAt(context.after.sha, SERVICE_MANIFEST_FILE)
  }
  const overlayTouchedManifest = (overlay ?? []).some(
    (record) =>
      record.path === SERVICE_MANIFEST_FILE && (record.status === 'modified' || record.status === 'created'),
  )
  if (overlayTouchedManifest) {
    return readFile(join(context.git.repoRoot, SERVICE_MANIFEST_FILE), 'utf8').catch(() => null)
  }
  const baseSha = context.after.baseSha ?? (context.before.kind === 'ref' ? context.before.sha : null)
  return baseSha === null ? null : await context.git.readFileAt(baseSha, SERVICE_MANIFEST_FILE)
}

/** Execute the one target probe against a materialized worktree; map its outcome onto attempt semantics. */
async function executeProbeAttempt(
  experiment: ReproductionExperiment,
  context: ExperimentContext,
  worktreeDir: string,
  overlay: ChangeRecord[] | undefined,
  index: number,
): Promise<ReproductionAttempt> {
  const probeId = probeIdOf(experiment)
  if (probeId === undefined) {
    return unexecutedAttempt(experiment, index, 'the experiment carries no target probe id')
  }

  const manifest = parseServiceManifest(await manifestTextForState(context, overlay))
  if (manifest === null) {
    return unexecutedAttempt(
      experiment,
      index,
      `no usable service manifest (${SERVICE_MANIFEST_FILE}) at the recorded after state`,
    )
  }

  const target = manifest.probes.find((probe) => probe.id === probeId)
  if (target === undefined) {
    return unexecutedAttempt(
      experiment,
      index,
      `probe "${probeId}" is not declared in the manifest of the recorded after state`,
    )
  }

  // One-probe manifest, same declared services: only the target executes, so
  // the attempt's outcome is exactly that probe's outcome.
  const phase = await runServiceProbes({
    cwd: worktreeDir,
    manifest: { ...manifest, probes: [target] },
  })
  const outcome = phase.probes.find((probe) => probe.probeId === probeId)
  if (outcome === undefined) {
    return unexecutedAttempt(
      experiment,
      index,
      `probe "${probeId}" produced no outcome against the recorded after state`,
    )
  }
  const decision = probeAttemptOutcome(outcome)
  return {
    index,
    experimentId: experiment.id,
    stateIdentity: { ...experiment.stateIdentity },
    outcome: decision.outcome,
    // 0/1 mirror the probe's own conclusive result; unknown carries no code.
    exitCode: outcome.status === 'unknown' ? null : outcome.status === 'failed' ? 1 : 0,
    durationMs: phase.durationMs,
    timedOut: false,
    detail: decision.detail,
  }
}

/** Map a probe outcome onto reproduction semantics: failed reproduces, passed does not, unknown stays honest. */
function probeAttemptOutcome(outcome: ProbeOutcome): { outcome: AttemptOutcome; detail: string } {
  if (outcome.status === 'failed') {
    const detail = outcome.detail?.split('\n')[0]
    return {
      outcome: 'reproduced',
      detail: `probe failed (HTTP ${outcome.httpStatus ?? 'n/a'})${detail ? ` — ${detail}` : ''}`,
    }
  }
  if (outcome.status === 'passed') {
    return { outcome: 'not-reproduced', detail: `probe passed (HTTP ${outcome.httpStatus ?? 'n/a'})` }
  }
  return { outcome: 'inconclusive', detail: outcome.detail ?? 'probe outcome was inconclusive' }
}

/**
 * Restore dependencies for a probe attempt from the MATERIALIZED worktree's
 * own package.json — deliberately not gated on the test plan: a repository
 * may declare services without declaring any test command, and the declared
 * service command deserves the same deterministic restoration discipline.
 */
async function restoreProbeDependencies(
  worktreeDir: string,
  context: ExperimentContext,
): Promise<{ strategy: string; exitCode: number | null; timedOut: boolean } | null> {
  const pkgText = await readFile(join(worktreeDir, 'package.json'), 'utf8').catch(() => null)
  const lockfileExists = await readFile(join(worktreeDir, 'package-lock.json'), 'utf8')
    .then(() => true)
    .catch(() => false)
  const install = selectDependencyInstall(pkgText, lockfileExists)
  if (install.command === null) {
    return null
  }
  const outcome = await runCommand(install.command, { cwd: worktreeDir, timeoutMs: context.config.timeoutMs })
  if (outcome.exitCode === 0) {
    return null
  }
  return { strategy: install.strategy, exitCode: outcome.exitCode, timedOut: outcome.timedOut }
}

/**
 * Pure assessment accounting — factored out so the exact semantics are
 * unit-testable without executing anything:
 * - attemptsRequested: how many attempts the config asked for (git-diff: 1);
 * - attemptsCompleted: attempts whose outcome is not 'inconclusive';
 * - stability: stateMatched false → 'inconclusive'; any inconclusive attempt
 *   or zero executed attempts → 'inconclusive' (the headline never claims
 *   more certainty than the worst attempt); all completed reproduced →
 *   'stable'; none reproduced → 'not-reproduced'; otherwise 'unstable'.
 */
export function aggregateAssessment(
  experiment: ReproductionExperiment,
  attempts: ReproductionAttempt[],
  stateMatched: boolean,
  attemptsRequested: number = attempts.length,
): ReproductionAssessment {
  const reproduced = attempts.filter((attempt) => attempt.outcome === 'reproduced').length
  const notReproduced = attempts.filter((attempt) => attempt.outcome === 'not-reproduced').length
  const inconclusive = attempts.filter((attempt) => attempt.outcome === 'inconclusive').length
  const attemptsCompleted = attempts.filter((attempt) => attempt.outcome !== 'inconclusive').length

  let stability: ReproductionAssessment['stability']
  if (!stateMatched || attempts.length === 0 || inconclusive > 0) {
    stability = 'inconclusive'
  } else if (reproduced > 0 && notReproduced === 0) {
    stability = 'stable'
  } else if (reproduced === 0 && notReproduced > 0) {
    stability = 'not-reproduced'
  } else {
    stability = 'unstable'
  }

  return {
    experimentId: experiment.id,
    sourceFindingIds: [...experiment.sourceFindingIds],
    attemptsRequested,
    attemptsCompleted,
    reproduced,
    notReproduced,
    inconclusive,
    stability,
    granularity: experiment.granularity,
    attempts: attempts.map((attempt) => ({
      ...attempt,
      // Attribution is required since M4.2; every recorded attempt carries it.
      stateIdentity: { ...attempt.stateIdentity },
    })),
    stateIdentity: { ...experiment.stateIdentity },
    stateMatched,
  }
}

function withDetail(assessment: ReproductionAssessment, detail: string): AssessmentWithDetail {
  return { ...assessment, detail }
}

function fingerprintMismatchDetail(recorded: string | undefined, current: string | undefined): string {
  return (
    `working-tree fingerprint drifted since verification ` +
    `(recorded ${recorded ?? '(none)'} / now ${current ?? '(none)'}); ` +
    `refusing to reproduce against a different state`
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Restore dependencies in a fresh worktree per baseline discovery's selection. */
async function restoreDependencies(
  worktreeDir: string,
  context: ExperimentContext,
): Promise<{ strategy: string; exitCode: number | null; timedOut: boolean; detail: string } | null> {
  const plan = context.testPlan
  if (plan === null || !plan.testCommandInstalled) {
    return null
  }
  const pkgText = await readFile(join(worktreeDir, 'package.json'), 'utf8').catch(() => null)
  const lockfileExists = await readFile(join(worktreeDir, 'package-lock.json'), 'utf8')
    .then(() => true)
    .catch(() => false)
  const install = selectDependencyInstall(pkgText, lockfileExists)
  if (install.command === null) {
    return null
  }
  const outcome = await runCommand(install.command, { cwd: worktreeDir, timeoutMs: context.config.timeoutMs })
  if (outcome.exitCode === 0) {
    return null
  }
  return {
    strategy: install.strategy,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    detail: `${install.command} failed with exit ${outcome.exitCode ?? 'killed'} in the isolated worktree`,
  }
}

/** One attempt: execute the structured command's rendering in the worktree. */
async function runSingleAttempt(
  experiment: ReproductionExperiment,
  context: ExperimentContext,
  worktreeDir: string,
  index: number,
): Promise<ReproductionAttempt> {
  let command: string
  try {
    command = commandStringFor(experiment.command)
  } catch (error) {
    return unexecutedAttempt(
      experiment,
      index,
      `command could not be rendered safely: ${errorMessage(error)}`,
    )
  }

  const outcome = await runCommand(command, { cwd: worktreeDir, timeoutMs: context.config.timeoutMs })
  const runner = context.testPlan?.runner ?? 'generic'
  const direct = runner === 'vitest' || runner === 'jest'
  const tests = direct ? await readResultFile(worktreeDir) : null
  const decision = decideOutcome(experiment, direct, tests, outcome)

  return {
    index,
    experimentId: experiment.id,
    stateIdentity: { ...experiment.stateIdentity },
    outcome: decision.outcome,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    timedOut: outcome.timedOut,
    detail: decision.detail,
  }
}

/** Parse the runner's JSON result file; null means "fall back to suite level". */
async function readResultFile(worktreeDir: string): Promise<TestCaseOutcome[] | null> {
  const text = await readFile(join(worktreeDir, TEST_RESULT_FILE), 'utf8').catch(() => null)
  return text === null ? null : parseRunnerJson(text, { stripPrefix: worktreeDir })
}

function decideOutcome(
  experiment: ReproductionExperiment,
  directRunner: boolean,
  tests: TestCaseOutcome[] | null,
  outcome: RunOutcome,
): { outcome: AttemptOutcome; detail?: string } {
  if (outcome.timedOut) {
    return { outcome: 'inconclusive', detail: `timed out after ${outcome.durationMs}ms` }
  }
  if (outcome.spawnError !== null) {
    return { outcome: 'inconclusive', detail: outcome.spawnError }
  }
  if (outcome.exitCode === null) {
    return { outcome: 'inconclusive', detail: 'process did not report an exit code' }
  }

  if (directRunner && tests !== null) {
    // Case-precision outcome: when the experiment knows the regressed test's
    // name, that specific test's status decides. The run executed at file (or
    // suite) granularity — the precision comes from the parsed results, not
    // from unreliable runner name-filter flags.
    const target = experiment.testName
    if (target !== undefined) {
      const named = tests.find((test) => test.id === target || test.title === target)
      if (named !== undefined) {
        return {
          outcome: named.status === 'failed' ? 'reproduced' : 'not-reproduced',
          detail: firstFailureLine(named.status === 'failed' ? named : undefined),
        }
      }
      // Target not reported by this run (filtered, renamed, removed): fall
      // through to file-level semantics with an explicit note.
      const failure = tests.find((test) => test.status === 'failed')
      return {
        outcome: failure !== undefined ? 'reproduced' : 'not-reproduced',
        detail: `target test "${target}" not present in results${failure ? `; decided at file level: ${firstFailureLine(failure) ?? 'a test failed'}` : ''}`,
      }
    }
    const failure = tests.find((test) => test.status === 'failed')
    return {
      outcome: failure !== undefined ? 'reproduced' : 'not-reproduced',
      detail: firstFailureLine(failure),
    }
  }

  // Generic runner, or the result file failed to parse: exit status only.
  return { outcome: outcome.exitCode !== 0 ? 'reproduced' : 'not-reproduced' }
}

function firstFailureLine(test: TestCaseOutcome | undefined): string | undefined {
  const message = test?.failureMessage
  if (message === undefined) {
    return undefined
  }
  const line = message.split('\n')[0]?.trim()
  return line === '' || line === undefined ? undefined : line
}

/** The finding path a git-diff experiment re-derives (after the `--` separator). */
function diffTargetPath(experiment: ReproductionExperiment): string | undefined {
  const args = experiment.command.args
  const separator = args.indexOf('--')
  if (separator !== -1 && separator + 1 < args.length) {
    return args[separator + 1]
  }
  return args.at(-1)
}

/** Copy dirty files (tracked modifications + untracked) into a worktree. */
async function overlayWorkingTree(
  git: GitAdapter,
  targetDir: string,
  changes: ChangeRecord[],
): Promise<void> {
  for (const record of changes) {
    if (record.path.includes('node_modules/') || record.path === '.git' || record.path.startsWith('.git/')) {
      continue
    }
    if (record.status === 'deleted') {
      await rm(join(targetDir, record.path), { force: true })
      continue
    }
    if (record.status === 'renamed' && record.oldPath) {
      await rm(join(targetDir, record.oldPath), { force: true })
    }
    const source = join(git.repoRoot, record.path)
    const target = join(targetDir, record.path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }
}

/**
 * Quote one argument for a shell-string rendering. Plain words (no
 * metacharacters) pass through untouched; anything else is double-quoted ONLY
 * when it contains no double quotes, backslashes, backticks, control
 * characters, or `$` (POSIX expansion/substitution stays live inside double
 * quotes — an expansion hazard, not just a fidelity one). Otherwise null: the
 * caller must downgrade granularity rather than execute the argument.
 */
const WORD_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/
const QUOTE_FORBIDDEN = /["\\`$\u0000-\u001f\u007f]/

export function shellQuote(arg: string): string | null {
  if (WORD_SAFE.test(arg)) {
    return arg
  }
  if (QUOTE_FORBIDDEN.test(arg)) {
    return null
  }
  return `"${arg}"`
}

/**
 * Render a structured command for runCommand: executable + args joined with
 * strict shell quoting. Args that cannot be quoted safely are a build-time
 * contract violation — buildExperiments downgrades instead — so this throws
 * rather than ever emitting an unsafe string.
 */
export function commandStringFor(command: ReproductionCommand): string {
  const parts = [command.executable, ...command.args]
  const quoted: string[] = []
  for (const part of parts) {
    const value = shellQuote(part)
    if (value === null) {
      throw new Error(`command argument cannot be quoted safely: ${JSON.stringify(part)}`)
    }
    quoted.push(value)
  }
  return quoted.join(' ')
}
