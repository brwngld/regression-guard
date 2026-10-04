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
  packageJsonHasDependencies,
  TEST_RESULT_FILE,
  type TestCommandPlan,
} from './discover'
import { parseRunnerJson } from './parse'
import { classifyPerTest, classifySuite, summarize, suiteStatusOf, type SuiteStatus } from './compare'

export interface BaselineOptions {
  git: GitAdapter
  before: { ref: string }
  after: { ref: string } | { workingTree: true }
  /** Changed records, used to overlay the working tree onto a worktree. */
  workingTreeChanges?: ChangeRecord[]
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

/**
 * Execute the repository's existing test command against the before and after
 * revisions in isolated temporary worktrees. The user's checkout is never
 * mutated; worktrees are removed even on failure.
 */
export async function runBaselineVerification(options: BaselineOptions): Promise<BaselineOutcome> {
  const { git } = options

  // Discovery reads the AFTER state's package.json: the change under
  // verification defines how its own tests are run.
  const afterPkgText =
    'ref' in options.after
      ? await git.readFileAt(options.after.ref, 'package.json')
      : await readFile(join(git.repoRoot, 'package.json'), 'utf8').catch(() => null)

  const plan: TestCommandPlan = discoverTestCommand(afterPkgText)
  if (plan === null) {
    return { regressions: { status: 'not-verified' }, findings: [] }
  }

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
    const afterSha = 'ref' in options.after ? await git.revParse(options.after.ref) : await git.revParse('HEAD')
    const afterLabel = 'ref' in options.after ? options.after.ref : 'working-tree'

    const beforeRun = await executeSuite(beforeDir, plan, options.timeoutMs)
    const afterRun = await executeSuite(afterDir, plan, options.timeoutMs)

    const beforeTests = await parseResultFile(beforeRun, beforeDir)
    const afterTests = await parseResultFile(afterRun, afterDir)

    const beforeResult = toRunResult('before', options.before.ref, beforeSha, plan, beforeRun, beforeTests)
    const afterResult = toRunResult('after', afterLabel, afterSha, plan, afterRun, afterTests)

    return conclude(plan, beforeResult, afterResult)
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
  installOutcome: RunOutcome | null
  resultFile: string | null
}

async function executeSuite(
  worktreeDir: string,
  plan: NonNullable<TestCommandPlan>,
  timeoutMs: number,
): Promise<SuiteExecution> {
  const resultFile = plan.runner === 'generic' ? null : join(worktreeDir, TEST_RESULT_FILE)
  const command = plan.buildExecutedCommand()

  const pkgText = await readFile(join(worktreeDir, 'package.json'), 'utf8').catch(() => null)
  let installOutcome: RunOutcome | null = null
  if (pkgText !== null && packageJsonHasDependencies(pkgText)) {
    installOutcome = await runCommand('npm install --no-audit --no-fund --loglevel=error', {
      cwd: worktreeDir,
      timeoutMs,
    })
    if (installOutcome.exitCode !== 0) {
      return {
        command,
        outcome: {
          command,
          cwd: worktreeDir,
          exitCode: null,
          timedOut: installOutcome.timedOut,
          spawnError: `dependency installation failed (exit ${installOutcome.exitCode ?? 'killed'})`,
          durationMs: installOutcome.durationMs,
          stdout: installOutcome.stdout,
          stderr: installOutcome.stderr,
          stdoutTruncated: installOutcome.stdoutTruncated,
          stderrTruncated: installOutcome.stderrTruncated,
        },
        installOutcome,
        resultFile,
      }
    }
  }

  const outcome = await runCommand(command, { cwd: worktreeDir, timeoutMs })
  return { command, outcome, installOutcome, resultFile }
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
  plan: NonNullable<TestCommandPlan>,
  execution: SuiteExecution,
  tests: TestCaseOutcome[] | null,
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
    durationMs: execution.outcome.durationMs + (execution.installOutcome?.durationMs ?? 0),
    stdoutSummary: tailSummary(execution.outcome.stdout),
    stderrSummary: tailSummary(execution.outcome.stderr),
    tests: tests ?? [],
  }
}

type Conclude = (plan: NonNullable<TestCommandPlan>, before: TestRunResult, after: TestRunResult) => BaselineOutcome

const conclude: Conclude = (plan, before, after) => {
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

  const experiment = `Experiment: ran "${plan.userCommand}" against ${before.ref} (${before.sha.slice(0, 10)}) and ${after.ref} (${after.sha.slice(0, 10)}) in isolated worktrees.`

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
        reproduction: plan.userCommand,
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
        reproduction: plan.userCommand,
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
        reproduction: plan.userCommand,
      },
    })
  }

  return {
    baseline: {
      userCommand: plan.userCommand,
      executedCommand: before.command,
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
