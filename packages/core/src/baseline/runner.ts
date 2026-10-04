import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runCommand, type RunOutcome } from '../exec/run'
import type { Finding } from '../schema/evidence'
import type { RegressionStatus } from '../schema/report'
import type {
  BaselineComparison,
  TestCaseOutcome,
  TestRunResult,
} from '../schema/baseline'
import type { ChangeRecord } from '../schema/changeset'
import type { GitAdapter } from '../vcs/git'
import {
  discoverTestCommand,
  selectDependencyInstall,
  TEST_RESULT_FILE,
  type TestCommandPlan,
} from './discover'
import { parseRunnerJson } from './parse'
import { classifyPerTest, classifySuite, summarize, suiteStatusOf, type SuiteStatus } from './compare'

type ResolvedPlan = Exclude<TestCommandPlan, null>

export interface BaselineOptions {
  git: GitAdapter
  before: { ref: string }
  after: { ref: string } | { workingTree: true }
  /** Changed records, used to overlay the working tree onto a worktree. */
  workingTreeChanges?: ChangeRecord[]
  /** Working-tree identity (base HEAD + dirty-state fingerprint) of the verified after state. */
  workingTree?: { baseSha: string; fingerprint: string }
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

    if (beforePlan === null && afterPlan === null) {
      return { regressions: { status: 'not-verified' }, findings: [] }
    }

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

    return conclude({ beforePlan, afterPlan, comparable, before: beforeResult, after: afterResult })
  } finally {
    await git.removeWorktree(beforeDir).catch(() => {})
    await git.removeWorktree(afterDir).catch(() => {})
    // Retries: Windows may briefly lock files held by just-killed trees.
    await rm(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
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
}

const conclude = (input: ConcludeInput): BaselineOutcome => {
  const { before, after } = input
  const findings: Finding[] = []
  const nextFindingId = createFindingIdFactory()
  const perTest = before.mode === 'per-test' && after.mode === 'per-test'

  const transitions = perTest
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

  const baselineTests = perTest
    ? before.tests.filter((test) => test.status === 'passed' || test.status === 'failed').length
    : 1

  const userCommand = input.afterPlan?.userCommand ?? input.beforePlan?.userCommand ?? 'npm test'

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

  if (!input.comparable) {
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

  // Status derivation — conservative at every branch.
  let status: RegressionStatus['status']
  const incompleteReasons: string[] = []

  const beforeSuite: SuiteStatus = suiteStatusOf(before)
  const afterSuite: SuiteStatus = suiteStatusOf(after)

  if (beforeSuite === 'unknown' || afterSuite === 'unknown') {
    status = 'partial'
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
    status = 'partial'
    incompleteReasons.push('the baseline suite itself fails, so post-change failures cannot be attributed to the change')
  } else if (summary.regressed > 0) {
    status = 'fail'
  } else if (summary.unknown > 0) {
    status = 'partial'
    incompleteReasons.push(`${summary.unknown} baseline test(s) have inconclusive outcomes after the change`)
  } else {
    status = 'pass'
  }

  // A changed test command means the after state redefined how its own tests
  // run; the comparison is never apples-to-apples, so a pass cannot be claimed.
  if (!input.comparable) {
    status = 'partial'
    incompleteReasons.push(
      `the test command changed between the compared states (before: "${before.command}" -> after: "${after.command}"), so the before and after runs are not directly comparable`,
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
    },
    regressions: {
      status,
      baselineTests,
      regressionsFound: summary.regressed,
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
