import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runCommand, type RunOutcome } from '../exec/run'
import type { ChangeRecord } from '../schema/changeset'
import type { Finding } from '../schema/evidence'
import type { RegressionStatus } from '../schema/report'
import type {
  BaselineComparison,
  BaselineSummary,
  TestCaseOutcome,
  TestRunResult,
  TestTransition,
} from '../schema/baseline'
import {
  INVALID_MANIFEST_DIGEST,
  SERVICE_MANIFEST_FILE,
  type ProbeDeclaration,
  type ProbeOutcome,
  type ProbeRunResult,
  type ServiceManifest,
} from '../schema/service'
import { loadServiceManifest } from '../service/manifest'
import { apiContractDigest, parseOpenApiDocument } from '../service/contract'

import { runServiceProbes } from '../service/runtime'
import { canonicalJson } from '../reproduction/identity'
import type { GitAdapter } from '../vcs/git'
import {
  discoverTestCommand,
  selectDependencyInstall,
  TEST_RESULT_FILE,
  type TestCommandPlan,
} from './discover'
import { parseRunnerJson } from './parse'
import { classifyPerTest, classifySuite, summarize, suiteStatusOf, type SuiteStatus } from './compare'
import {
  divergedContractProbes,
  buildManifestInvalidFinding,
  buildProbeFindings,
  compareManifests,
  probeBaselineStatus,
  probeTransitions,
  type ManifestSide,
  type ProbeStatusContribution,
} from './probes'

type ResolvedPlan = Exclude<TestCommandPlan, null>

export interface BaselineOptions {
  git: GitAdapter
  before: { ref: string }
  after: { ref: string } | { workingTree: true }
  /** Changed records, used to overlay the working tree onto a worktree. */
  workingTreeChanges?: ChangeRecord[]
  /** Working-tree identity (base HEAD + dirty-state fingerprint) of the verified after state. */
  workingTree?: { baseSha: string; fingerprint: string }
  /**
   * Repo-relative paths the change DELETED (both modes). Used only to
   * classify coverage loss as explained (the test file is gone) versus
   * unexplained (the file exists but its ids no longer executed).
   */
  deletedPaths?: string[]
  timeoutMs: number
}

export interface BaselineOutcome {
  baseline?: BaselineComparison
  regressions: RegressionStatus
  findings: Finding[]
}

/** Per-report identifier counter: unique within one verification run. */
function createFindingIdFactory() {
  let counter = 0
  return () => {
    counter += 1
    return `TEST-${String(counter).padStart(3, '0')}`
  }
}

function tailSummary(text: string): string {
  const tail = text.trim().split('\n').slice(-20).join('\n')
  return tail.length > 2_000 ? `${tail.slice(0, 2_000)}…` : tail
}

/** Two plans are comparable when they run the same runner and the same command. */
function plansEquivalent(left: ResolvedPlan, right: ResolvedPlan): boolean {
  return left.runner === right.runner && left.buildExecutedCommand() === right.buildExecutedCommand()
}

/**
 * Execute the repository's existing test command against the before and after
 * revisions in isolated temporary worktrees. The user's checkout is never
 * mutated; worktrees are removed even on failure.
 *
 * Each side is discovered from its OWN materialized package.json (the after
 * worktree includes the dirty overlay in working-tree mode), so a change that
 * redefines the test command can never silently redefine the baseline: when
 * the two plans differ, each side runs its own command and the comparison is
 * explicitly marked non-comparable (forced partial).
 */
export async function runBaselineVerification(options: BaselineOptions): Promise<BaselineOutcome> {
  const { git } = options

  const baseDir = await mkdtemp(join(tmpdir(), 'rg-baseline-'))
  const beforeDir = join(baseDir, 'before')
  const afterDir = join(baseDir, 'after')

  try {
    await git.createWorktree(beforeDir, options.before.ref)
    if ('ref' in options.after) {
      await git.createWorktree(afterDir, options.after.ref)
    } else {
      // Materialize the working tree without touching it: check out the base
      // ref, then overlay the dirty files.
      await git.createWorktree(afterDir, options.before.ref)
      await overlayWorkingTree(git, afterDir, options.workingTreeChanges ?? [])
    }

    const beforeSha = await git.revParse(options.before.ref)
    const afterSha = 'ref' in options.after
      ? await git.revParse(options.after.ref)
      : (options.workingTree?.baseSha ?? await git.revParse('HEAD'))
    const afterLabel = 'ref' in options.after ? options.after.ref : 'working-tree'

    // Discovery reads each side's package.json from its materialized worktree
    // on disk; for the after side in working-tree mode this naturally covers
    // the dirty overlay.
    const beforePkgText = await readFile(join(beforeDir, 'package.json'), 'utf8').catch(() => null)
    const afterPkgText = await readFile(join(afterDir, 'package.json'), 'utf8').catch(() => null)

    const beforePlan = discoverTestCommand(beforePkgText)
    const afterPlan = discoverTestCommand(afterPkgText)

    const comparable =
      beforePlan !== null && afterPlan !== null && plansEquivalent(beforePlan, afterPlan)

    const beforeExecution =
      beforePlan !== null ? await executeSuite(beforeDir, beforePlan, options.timeoutMs) : null
    const afterExecution =
      afterPlan !== null ? await executeSuite(afterDir, afterPlan, options.timeoutMs) : null

    const beforeTests =
      beforeExecution !== null ? await parseResultFile(beforeExecution, beforeDir) : null
    const afterTests =
      afterExecution !== null ? await parseResultFile(afterExecution, afterDir) : null

    const beforeResult =
      beforePlan !== null && beforeExecution !== null
        ? toRunResult('before', options.before.ref, beforeSha, beforePlan, beforeExecution, beforeTests)
        : syntheticRunResult('before', options.before.ref, beforeSha)
    const afterResult =
      afterPlan !== null && afterExecution !== null
        ? toRunResult('after', afterLabel, afterSha, afterPlan, afterExecution, afterTests, {
            fingerprint: 'ref' in options.after ? undefined : options.workingTree?.fingerprint,
          })
        : syntheticRunResult('after', afterLabel, afterSha)

    // M5 service phase — AFTER the test executions, BEFORE cleanup: the probe
    // runs reuse the SAME materialized worktrees (they ARE the recorded
    // states), so the manifest is read from each worktree on disk exactly like
    // the test-plan discovery above. 'none' (no usable manifest on either
    // side) leaves the phase absent and the outcome byte-identical to pre-M5.
    const probes = await runServicePhase({
      beforeDir,
      afterDir,
      beforeRef: options.before.ref,
      afterRef: afterLabel,
    })

    if (beforePlan === null && afterPlan === null && probes === undefined) {
      return { regressions: { status: 'not-verified' }, findings: [] }
    }

    return conclude({
      beforePlan,
      afterPlan,
      comparable,
      before: beforeResult,
      after: afterResult,
      probes,
      deletedPaths: new Set((options.deletedPaths ?? []).map((path) => path.replace(/\\/g, '/'))),
    })
  } finally {
    await git.removeWorktree(beforeDir).catch(() => {})
    await git.removeWorktree(afterDir).catch(() => {})
    // Retries: Windows may briefly lock files held by just-killed trees.
    await rm(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
}

/**
 * One side's service-manifest state, kept DISCRIMINATED (M5b): absent means
 * "no verification was declared", invalid means "verification was declared
 * incorrectly" — different facts with different remedies, never merged.
 */
type ManifestSideState =
  | { status: 'absent' }
  | { status: 'valid'; digest: string; manifest: ServiceManifest }
  | { status: 'invalid'; errors: string[] }

/**
 * Digest sentinel recorded for a side whose recorded state declares no usable
 * manifest: the schema's `manifestDigest` is a string, while comparability was
 * already decided from the discriminated load result. Invalid sides carry the
 * shared INVALID_MANIFEST_DIGEST sentinel instead, so reports can tell the two
 * apart; valid sides always carry their real 'svc_…' digest.
 */
const ABSENT_MANIFEST_DIGEST = 'absent'

/** The manifestDigest string an empty (never-executed) run records for a side. */
function manifestDigestSentinel(side: ManifestSideState): string {
  if (side.status === 'valid') {
    return side.digest
  }
  return side.status === 'invalid' ? INVALID_MANIFEST_DIGEST : ABSENT_MANIFEST_DIGEST
}

/** An honest empty run: this side's probes never executed. */
function emptyProbeRun(label: 'before' | 'after', ref: string, side: ManifestSideState): ProbeRunResult {
  return {
    label,
    ref,
    manifestDigest: manifestDigestSentinel(side),
    contractDigest: null,
    servicesReady: [],
    probes: [],
    durationMs: 0,
  }
}

async function readManifestSide(worktreeDir: string): Promise<ManifestSideState> {
  const text = await readFile(join(worktreeDir, SERVICE_MANIFEST_FILE), 'utf8').catch(() => null)
  const result = loadServiceManifest(text)
  if (result.status === 'valid') {
    return { status: 'valid', digest: result.digest, manifest: result.manifest }
  }
  return result.status === 'invalid' ? { status: 'invalid', errors: result.errors } : { status: 'absent' }
}


interface ServicePhaseInput {
  beforeDir: string
  afterDir: string
  beforeRef: string
  afterRef: string
}

/** Everything `conclude` needs to fold the probe phase into the baseline outcome. */
interface ServicePhaseResult {
  before: ProbeRunResult
  after: ProbeRunResult
  manifestMode: 'comparable' | 'non-comparable'
  transitions: TestTransition[]
  summary: BaselineSummary
  findings: Finding[]
  status: ProbeStatusContribution
}

/**
 * M5 service phase: run each side's declared probes inside its ALREADY
 * materialized worktree (the recorded state), then classify with the shared
 * transition table. Returns undefined when neither side declares a manifest at
 * all (mode 'none') — behavior identical to pre-M5. A manifest that is DECLARED
 * but unloadable on any side short-circuits to `invalidManifestPhase`; even
 * when the manifests are non-comparable each side runs its OWN declaration: it
 * is the transition interpretation that gets limited, never execution.
 */
async function runServicePhase(input: ServicePhaseInput): Promise<ServicePhaseResult | undefined> {
  const beforeSide = await readManifestSide(input.beforeDir)
  const afterSide = await readManifestSide(input.afterDir)
  if (beforeSide.status === 'absent' && afterSide.status === 'absent') {
    return undefined
  }
  if (beforeSide.status === 'invalid' || afterSide.status === 'invalid') {
    return invalidManifestPhase(input, beforeSide, afterSide)
  }

  const toComparableSide = (side: ManifestSideState): ManifestSide =>
    side.status === 'valid' ? { digest: side.digest, manifest: side.manifest } : { digest: null, manifest: null }
  const comparison = compareManifests(toComparableSide(beforeSide), toComparableSide(afterSide))
  // Both sides are valid here, so both digests are non-null and the mode can
  // never be 'none' (that requires both digests null); narrow for the result.
  const manifestMode: 'comparable' | 'non-comparable' =
    comparison.mode === 'comparable' ? 'comparable' : 'non-comparable'

  const beforeRun = await runOneProbeSide('before', input.beforeRef, input.beforeDir, beforeSide)
  const afterRun = await runOneProbeSide('after', input.afterRef, input.afterDir, afterSide)

  const transitions = probeTransitions(beforeRun.probes, afterRun.probes)
  const summary = summarize(transitions)
  // M5b.1: divergence is per-probe (same probe id, contract-sourced on both
  // sides, differing document digests). Diverged probes are excluded from
  // attribution in buildProbeFindings and force partial here.
  const diverged = divergedContractProbes(beforeRun, afterRun)
  const findings = buildProbeFindings({ beforeRun, afterRun, transitions, summary, diverged })
  const status = probeBaselineStatus({
    transitions,
    summary,
    manifestMode,
    diverged,
    runs: [beforeRun, afterRun],
  })
  return { before: beforeRun, after: afterRun, manifestMode, transitions, summary, findings, status }
}

/**
 * Declared-but-unloadable manifest phase: when ANY side's manifest is invalid,
 * no probes execute on EITHER side (each side's declaration would judge the
 * other, so there is nothing comparable to run). Both runs are honestly empty
 * with digest sentinels ('invalid' for invalid sides, 'absent' for absent
 * ones, the real digest for a valid side); the comparison is non-comparable,
 * the `service-manifest-invalid` finding is visible-but-never-worsening
 * (gate: accept), and the probe contribution is forced partial with the
 * invalid reason — never a silent pass.
 */
function invalidManifestPhase(
  input: ServicePhaseInput,
  beforeSide: ManifestSideState,
  afterSide: ManifestSideState,
): ServicePhaseResult {
  const beforeRun = emptyProbeRun('before', input.beforeRef, beforeSide)
  const afterRun = emptyProbeRun('after', input.afterRef, afterSide)
  const invalidSides: Array<{ label: 'before' | 'after'; errors: string[] }> = []
  if (beforeSide.status === 'invalid') {
    invalidSides.push({ label: 'before', errors: beforeSide.errors })
  }
  if (afterSide.status === 'invalid') {
    invalidSides.push({ label: 'after', errors: afterSide.errors })
  }
  const transitions = probeTransitions([], [])
  const summary = summarize(transitions)
  return {
    before: beforeRun,
    after: afterRun,
    manifestMode: 'non-comparable',
    transitions,
    summary,
    findings: [buildManifestInvalidFinding(invalidSides)],
    status: probeBaselineStatus({
      transitions,
      summary,
      manifestMode: 'non-comparable',
      manifestInvalid: true,
      runs: [beforeRun, afterRun],
    }),
  }
}

/**
 * Per-probe definition identity (Doc 1 §2.3/§5 — instrument integrity): a
 * canonical digest over the probe's PARSED declaration plus, for
 * contract-sourced probes, the referenced OpenAPI document's digest. Compared
 * across the compared states it decides whether the bound instrument is still
 * the same one. null = the definition could not be resolved at this state
 * (unreadable document) — unknown, never divergence, never novelty (the same
 * M5b.1 null-digest discipline).
 */
async function probeDefinitionIdentity(
  worktreeDir: string,
  probe: ProbeDeclaration,
): Promise<string | null> {
  const ref = probe.expect.fromContract
  let contractDigest: string | null = null
  if (ref !== undefined) {
    const text = await readFile(join(worktreeDir, ref.file), 'utf8').catch(() => null)
    const doc = parseOpenApiDocument(text)
    if (doc === null) {
      return null
    }
    contractDigest = apiContractDigest(doc)
  }
  return `def_${createHash('sha256')
    .update(canonicalJson({ declaration: probe, contract: contractDigest }), 'utf8')
    .digest('hex')}`
}

/**
 * Execute one side's probes; a side with no usable manifest (absent while the
 * other side declares one) records an honest empty run instead. Every outcome
 * is stamped with its declaration's definition identity so the Requirement
 * Verification layer (Doc 1) can compare instrument identity across states.
 */
async function runOneProbeSide(
  label: 'before' | 'after',
  ref: string,
  worktreeDir: string,
  side: ManifestSideState,
): Promise<ProbeRunResult> {
  if (side.status !== 'valid') {
    return emptyProbeRun(label, ref, side)
  }
  const phase = await runServiceProbes({ cwd: worktreeDir, manifest: side.manifest })
  // Every outcome belongs to a declared probe (undeclared-service and
  // not-ready probes are recorded as unknown outcomes), so the identity map
  // keyed by declaration id covers them all.
  const identities = new Map<string, string | null>()
  for (const probe of side.manifest.probes) {
    if (!identities.has(probe.id)) {
      identities.set(probe.id, await probeDefinitionIdentity(worktreeDir, probe))
    }
  }
  return {
    label,
    ref,
    manifestDigest: side.digest,
    // M5b.1: DISPLAY-ONLY aggregate over the per-probe identities the runtime
    // stamped (sorted unique document digests). Comparability is authoritative
    // per probe via contractIdentity on each outcome — never this aggregate.
    contractDigest: aggregateContractDigest(phase.probes),
    servicesReady: phase.servicesReady,
    probes: phase.probes.map((outcome) => ({
      ...outcome,
      definitionIdentity: identities.get(outcome.probeId) ?? null,
    })),
    durationMs: phase.durationMs,
  }
}

/** Sorted-unique document digests from a side's contract-probe identities; null when none. */
function aggregateContractDigest(probes: ProbeOutcome[]): string | null {
  const digests = [
    ...new Set(
      probes
        .filter((probe) => probe.contractIdentity?.documentDigest != null)
        .map((probe) => probe.contractIdentity!.documentDigest),
    ),
  ].sort()
  if (digests.length === 0) {
    return null
  }
  return `oasl_${createHash('sha256').update(canonicalJson(digests), 'utf8').digest('hex')}`
}

interface SuiteExecution {
  command: string
  outcome: RunOutcome
  dependencyInstall: NonNullable<TestRunResult['dependencyInstall']>
  /**
   * Install duration to add on top of `outcome.durationMs`. Zero when the
   * outcome itself is the failed-install synthetic (which already includes it).
   */
  installDurationMs: number
  resultFile: string | null
}

async function executeSuite(
  worktreeDir: string,
  plan: ResolvedPlan,
  timeoutMs: number,
): Promise<SuiteExecution> {
  const resultFile = plan.runner === 'generic' ? null : join(worktreeDir, TEST_RESULT_FILE)
  const command = plan.buildExecutedCommand()

  const pkgText = await readFile(join(worktreeDir, 'package.json'), 'utf8').catch(() => null)
  const lockfileExists = await readFile(join(worktreeDir, 'package-lock.json'), 'utf8')
    .then(() => true)
    .catch(() => false)
  const install = selectDependencyInstall(pkgText, lockfileExists)

  if (install.command === null) {
    const outcome = await runCommand(command, { cwd: worktreeDir, timeoutMs })
    return {
      command,
      outcome,
      dependencyInstall: { strategy: 'none', command: '', exitCode: 0, durationMs: 0 },
      installDurationMs: 0,
      resultFile,
    }
  }

  // Restore dependencies deterministically: `npm ci` against the lockfile
  // whenever one exists, `npm install` only as a lockfile-less fallback.
  const installOutcome = await runCommand(install.command, { cwd: worktreeDir, timeoutMs })
  const dependencyInstall: NonNullable<TestRunResult['dependencyInstall']> = {
    strategy: install.strategy,
    command: install.command,
    exitCode: installOutcome.exitCode,
    durationMs: installOutcome.durationMs,
  }
  if (installOutcome.exitCode !== 0) {
    // A failed install means the suite never ran: report an honest synthetic
    // unknown (partial), never a pass.
    const hint =
      install.strategy === 'npm-ci'
        ? ' — the lockfile may be out of sync with package.json (environment drift, not a code regression)'
        : ''
    return {
      command,
      outcome: {
        command,
        cwd: worktreeDir,
        exitCode: null,
        timedOut: installOutcome.timedOut,
        spawnError: `${install.strategy} dependency installation failed (exit ${installOutcome.exitCode ?? 'killed'})${hint}`,
        durationMs: installOutcome.durationMs,
        stdout: installOutcome.stdout,
        stderr: installOutcome.stderr,
        stdoutTruncated: installOutcome.stdoutTruncated,
        stderrTruncated: installOutcome.stderrTruncated,
      },
      dependencyInstall,
      installDurationMs: 0,
      resultFile,
    }
  }

  const outcome = await runCommand(command, { cwd: worktreeDir, timeoutMs })
  return { command, outcome, dependencyInstall, installDurationMs: installOutcome.durationMs, resultFile }
}

/** Parse the runner's JSON result file; null means "fall back to suite level". */
async function parseResultFile(
  execution: SuiteExecution,
  worktreeDir: string,
): Promise<TestCaseOutcome[] | null> {
  if (execution.resultFile === null) {
    return null
  }
  // A failed install short-circuits executeSuite before the test run, so
  // reaching here with a result file means the suite actually executed.
  const text = await readFile(execution.resultFile, 'utf8').catch(() => null)
  return text === null ? null : parseRunnerJson(text, { stripPrefix: worktreeDir })
}

function toRunResult(
  label: 'before' | 'after',
  ref: string,
  sha: string,
  plan: ResolvedPlan,
  execution: SuiteExecution,
  tests: TestCaseOutcome[] | null,
  identity?: { fingerprint?: string },
): TestRunResult {
  const perTest = plan.runner !== 'generic' && tests !== null
  return {
    label,
    ref,
    sha,
    mode: perTest ? 'per-test' : 'suite',
    command: execution.command,
    exitCode: execution.outcome.exitCode,
    timedOut: execution.outcome.timedOut,
    spawnError: execution.outcome.spawnError,
    durationMs: execution.outcome.durationMs + execution.installDurationMs,
    stdoutSummary: tailSummary(execution.outcome.stdout),
    stderrSummary: tailSummary(execution.outcome.stderr),
    tests: tests ?? [],
    fingerprint: identity?.fingerprint,
    dependencyInstall: execution.dependencyInstall,
  }
}

/** Stand-in run for a side that declares no test command at all. */
function syntheticRunResult(label: 'before' | 'after', ref: string, sha: string): TestRunResult {
  return {
    label,
    ref,
    sha,
    mode: 'suite',
    command: '(none)',
    exitCode: null,
    timedOut: false,
    spawnError: 'no test command is declared in package.json at this state',
    durationMs: 0,
    stdoutSummary: '',
    stderrSummary: '',
    tests: [],
    dependencyInstall: { strategy: 'none', command: '', exitCode: 0, durationMs: 0 },
  }
}

interface ConcludeInput {
  beforePlan: TestCommandPlan
  afterPlan: TestCommandPlan
  /** True when both sides ran the same runner and the same executed command. */
  comparable: boolean
  before: TestRunResult
  after: TestRunResult
  /** M5 service-probe phase; absent when neither state declared a manifest. */
  probes?: ServicePhaseResult
  /** Repo-relative deleted paths (forward slashes); explains coverage loss. */
  deletedPaths: Set<string>
}

const conclude = (input: ConcludeInput): BaselineOutcome => {
  const { before, after } = input
  const findings: Finding[] = []
  const nextFindingId = createFindingIdFactory()
  const perTest = before.mode === 'per-test' && after.mode === 'per-test'
  // The test phase ran at all when either side declared a test command; a
  // manifest-only repository reaches conclude purely on its probe phase.
  const testPhaseRan = input.beforePlan !== null || input.afterPlan !== null

  const transitions = !testPhaseRan
    ? []
    : perTest
      ? classifyPerTest(before.tests, after.tests)
      : [
          {
            id: '(suite)',
            title: 'test suite',
            before: suiteStatusOf(before),
            after: suiteStatusOf(after),
            kind: classifySuite(suiteStatusOf(before), suiteStatusOf(after)),
          },
        ]
  const summary = summarize(transitions)

  const baselineTests = !testPhaseRan
    ? 0
    : perTest
      ? before.tests.filter((test) => test.status === 'passed' || test.status === 'failed').length
      : 1

  const userCommand = !testPhaseRan
    ? '(none)'
    : (input.afterPlan?.userCommand ?? input.beforePlan?.userCommand ?? 'npm test')

  // In working-tree mode the after state is HEAD plus a dirty overlay: the
  // fingerprint (not any commit SHA) identifies what was actually tested.
  const afterDescriptor =
    after.fingerprint !== undefined
      ? `working-tree (base ${after.sha.slice(0, 10)} + ${after.fingerprint.slice(0, 19)}…)`
      : `${after.ref} (${after.sha.slice(0, 10)})`
  const commandPhrase = input.comparable
    ? `ran "${userCommand}"`
    : `ran each side's own test command (before: "${before.command}" -> after: "${after.command}")`
  const experiment = `Experiment: ${commandPhrase} against ${before.ref} (${before.sha.slice(0, 10)}) and ${afterDescriptor} in isolated worktrees.`

  for (const transition of transitions) {
    if (transition.kind !== 'regression') {
      continue
    }
    const afterTest = after.tests.find((test) => test.id === transition.id)
    findings.push({
      id: nextFindingId(),
      findingClass: 'test-regression',
      severity: 'critical',
      message: perTest
        ? `Test "${transition.id}" passed at baseline and fails after the change.`
        : 'The test suite passed at baseline and fails after the change.',
      paths: transition.file ? [transition.file] : [],
      evidence: {
        kind: 'test',
        claim: perTest
          ? `Test "${transition.id}" regressed: it passed before the change and fails after it.`
          : 'The test suite regressed: it passed before the change and fails after it.',
        observation: `${experiment} Before (exit ${before.exitCode ?? 'n/a'}): ${String(transition.before).toUpperCase()}. After (exit ${after.exitCode ?? 'n/a'}): ${String(transition.after).toUpperCase()}${afterTest?.failureMessage ? ` — ${afterTest.failureMessage.split('\n')[0]}` : ''}.`,
        changedLines: [],
        reproduction: userCommand,
      },
    })
  }

  if (summary.preExisting > 0) {
    const names = transitions
      .filter((transition) => transition.kind === 'pre-existing')
      .map((transition) => (perTest ? `"${transition.id}"` : 'the test suite'))
    findings.push({
      id: nextFindingId(),
      findingClass: 'pre-existing-failure',
      severity: 'info',
      message: `${summary.preExisting} baseline failure(s) pre-date this change and are not attributed to it: ${names.join(', ')}.`,
      paths: [...new Set(transitions.filter((t) => t.kind === 'pre-existing').map((t) => t.file).filter((f): f is string => Boolean(f)))],
      evidence: {
        kind: 'test',
        claim: 'These failures existed at the baseline revision; they are not regressions introduced by the change.',
        observation: `${experiment} FAIL -> FAIL for: ${names.join(', ')}.`,
        changedLines: [],
        reproduction: userCommand,
      },
    })
  }

  if (testPhaseRan && !input.comparable) {
    findings.push({
      id: nextFindingId(),
      findingClass: 'test-command-changed',
      severity: 'info',
      message: `The test command is not the same on both sides: before: "${before.command}" -> after: "${after.command}".`,
      paths: ['package.json'],
      evidence: {
        kind: 'test',
        claim: 'The after state cannot silently redefine the baseline: each side was executed with its own declared test command, so the outcomes are of limited comparability.',
        observation: `${experiment} The comparison is therefore marked non-comparable and the regression status is forced to partial.`,
        changedLines: [],
        reproduction: userCommand,
      },
    })
  }

  // H2 coverage signal: ONE grouped finding when per-test baseline ids have no
  // after outcome at all — the executed coverage shrank, whatever the cause.
  // Coverage is id-based: a rename that PRESERVES ids emits nothing (every
  // before id still executed), and new-after ids are improvements, never
  // flagged. Suite-fallback mode has no ids, so it never emits this finding
  // (command-plan changes are already flagged by test-command-changed).
  const missingAfter = perTest
    ? transitions.filter((transition) => transition.after === 'missing')
    : []
  if (missingAfter.length > 0) {
    // Explained loss: the before-id's test FILE is gone (a deletion in the
    // change set — already flagged as deleted-test at scope level when
    // unauthorized). Unexplained loss: the file is still present, so the id
    // vanished from execution some other way.
    const describeLoss = (transition: TestTransition): string => {
      const file = transition.file?.replace(/\\/g, '/')
      if (file !== undefined && input.deletedPaths.has(file)) {
        return `"${transition.id}" in ${file} (file deleted — see the deleted-test scope finding)`
      }
      return `"${transition.id}"${file !== undefined ? ` in ${file}` : ''} (no matching after outcome — excluded, filtered, renamed beyond recognition, or runner configuration changed)`
    }
    findings.push({
      id: 'TCOV-001',
      findingClass: 'test-coverage-reduced',
      severity: 'warn',
      message: `Test coverage was reduced: ${missingAfter.length} baseline test id(s) have no outcome after the change: ${missingAfter.map((transition) => `"${transition.id}"`).join(', ')}.`,
      paths: [
        ...new Set(
          missingAfter
            .map((transition) => transition.file)
            .filter((file): file is string => Boolean(file)),
        ),
      ],
      evidence: {
        kind: 'test',
        claim: 'Test ids that existed at baseline produced no after outcome, so the behavior they verified is no longer checked — regardless of why they vanished.',
        observation: `${experiment} Missing after outcomes: ${missingAfter.map(describeLoss).join('; ')}. Tests that only exist after the change are new coverage (improvements) and are not flagged.`,
        changedLines: [],
        reproduction: userCommand,
      },
    })
  }

  // M5: the service-probe findings append to the test findings and flow
  // through the same gate (service-regression rejects by default).
  findings.push(...(input.probes?.findings ?? []))

  // Status derivation — conservative at every branch.
  const incompleteReasons: string[] = []

  const beforeSuite: SuiteStatus = suiteStatusOf(before)
  const afterSuite: SuiteStatus = suiteStatusOf(after)

  /** The test phase's own status; 'not-verified' when it never ran at all. */
  let testStatus: RegressionStatus['status']
  if (!testPhaseRan) {
    testStatus = 'not-verified'
  } else if (beforeSuite === 'unknown' || afterSuite === 'unknown') {
    testStatus = 'partial'
    for (const run of [before, after]) {
      if (run.timedOut) {
        incompleteReasons.push(`${run.label} run timed out after ${Math.round(run.durationMs / 1000)}s`)
      }
      if (run.spawnError !== null) {
        incompleteReasons.push(`${run.label} run could not execute: ${run.spawnError}`)
      }
    }
  } else if (!perTest && beforeSuite === 'fail') {
    // Suite-level baseline was not green: after-failures cannot be attributed.
    testStatus = 'partial'
    incompleteReasons.push('the baseline suite itself fails, so post-change failures cannot be attributed to the change')
  } else if (summary.regressed > 0) {
    testStatus = 'fail'
  } else if (summary.unknown > 0) {
    testStatus = 'partial'
    incompleteReasons.push(`${summary.unknown} baseline test(s) have inconclusive outcomes after the change`)
  } else {
    testStatus = 'pass'
  }

  // A changed test command means the after state redefined how its own tests
  // run; the comparison is never apples-to-apples, so a pass cannot be claimed.
  if (testPhaseRan && !input.comparable) {
    testStatus = 'partial'
    incompleteReasons.push(
      `the test command changed between the compared states (before: "${before.command}" -> after: "${after.command}"), so the before and after runs are not directly comparable`,
    )
  }

  // M5 combination: fail if either phase failed; else partial if either phase
  // is partial; else pass when EITHER phase ran; 'not-verified' survives only
  // when neither ran (which never reaches conclude — see runBaselineVerification).
  const probeStatus = input.probes?.status.status
  let status: RegressionStatus['status']
  if (testStatus === 'fail' || probeStatus === 'fail') {
    status = 'fail'
  } else if (testStatus === 'partial' || probeStatus === 'partial') {
    status = 'partial'
  } else if (testPhaseRan || input.probes !== undefined) {
    status = 'pass'
  } else {
    status = 'not-verified'
  }
  if (input.probes !== undefined) {
    incompleteReasons.push(...input.probes.status.incompleteReasons)
  }

  // H3 cross-reference: when coverage loss is among the reasons verification
  // is incomplete, say so and point at the finding that carries the detail.
  if (missingAfter.length > 0) {
    incompleteReasons.push(
      `${missingAfter.length} baseline test id(s) have no after outcome — coverage reduced (see TCOV-001)`,
    )
  }

  if (status === 'partial' && incompleteReasons.length > 0) {
    findings.push({
      id: nextFindingId(),
      findingClass: 'baseline-incomplete',
      severity: 'info',
      message: `Regression verification is incomplete: ${incompleteReasons.join('; ')}.`,
      paths: [],
      evidence: {
        kind: 'test',
        claim: 'The baseline comparison could not be completed, so no pass is claimed.',
        observation: `${experiment} ${incompleteReasons.join('; ')}.`,
        changedLines: [],
        reproduction: userCommand,
      },
    })
  }

  // M5 count folding: probes join the baseline population (comparable = the
  // before side's passed/failed probes) and probe regressions join the total.
  const comparableProbes = input.probes
    ? input.probes.before.probes.filter(
        (probe) => probe.status === 'passed' || probe.status === 'failed',
      ).length
    : 0

  return {
    baseline: {
      userCommand,
      executedCommand: input.comparable
        ? before.command
        : `before: "${before.command}" -> after: "${after.command}"`,
      perTest,
      before,
      after,
      summary,
      ...(input.probes !== undefined
        ? {
            probes: {
              before: input.probes.before,
              after: input.probes.after,
              summary: input.probes.summary,
              manifestMode: input.probes.manifestMode,
            },
          }
        : {}),
    },
    regressions: {
      status,
      baselineTests: baselineTests + comparableProbes,
      regressionsFound: summary.regressed + (input.probes?.summary.regressed ?? 0),
    },
    findings,
  }
}

/** Copy dirty files (tracked modifications + untracked) into a worktree. */
async function overlayWorkingTree(git: GitAdapter, targetDir: string, changes: ChangeRecord[]): Promise<void> {
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
