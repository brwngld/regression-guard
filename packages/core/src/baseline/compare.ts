import type { TestCaseOutcome, TestStatus } from '../schema/baseline'
import type { TestTransition, TransitionKind } from '../schema/baseline'

/**
 * Transition classification between baseline and post-change executions.
 *
 *   PASS -> PASS   preserved
 *   PASS -> FAIL   regression
 *   FAIL -> FAIL   pre-existing failure (NOT a regression)
 *   FAIL -> PASS   improvement
 *   missing/inconclusive  unknown — never silently treated as pass
 */

export type SuiteStatus = 'pass' | 'fail' | 'unknown'

export function suiteStatusOf(run: {
  exitCode: number | null
  timedOut: boolean
  spawnError: string | null
}): SuiteStatus {
  if (run.timedOut || run.spawnError !== null || run.exitCode === null) {
    return 'unknown'
  }
  return run.exitCode === 0 ? 'pass' : 'fail'
}

function classifyCell(before: TestStatus, after: TestStatus | 'missing'): TransitionKind {
  if (after === 'missing' || after === 'skipped' || after === 'todo' || after === 'unknown') {
    return 'unknown'
  }
  if (before === 'passed') {
    return after === 'failed' ? 'regression' : 'preserved'
  }
  if (before === 'failed') {
    return after === 'passed' ? 'improvement' : 'pre-existing'
  }
  // Baseline itself was inconclusive for this test (skipped/todo/unknown):
  // it was not part of the passing baseline, so it cannot regress.
  return 'unknown'
}

export function classifyPerTest(before: TestCaseOutcome[], after: TestCaseOutcome[]): TestTransition[] {
  const afterById = new Map(after.map((test) => [test.id, test]))
  const transitions: TestTransition[] = []

  for (const beforeTest of before) {
    const afterTest = afterById.get(beforeTest.id)
    const afterStatus: TestStatus | 'missing' = afterTest ? afterTest.status : 'missing'
    transitions.push({
      id: beforeTest.id,
      title: beforeTest.title,
      file: beforeTest.file,
      before: beforeTest.status,
      after: afterStatus,
      kind: classifyCell(beforeTest.status, afterStatus),
    })
  }

  // Tests that only exist after the change are new coverage, not transitions.
  return transitions
}

export function classifySuite(before: SuiteStatus, after: SuiteStatus): TransitionKind {
  if (before === 'unknown' || after === 'unknown') {
    return 'unknown'
  }
  if (before === 'pass') {
    return after === 'fail' ? 'regression' : 'preserved'
  }
  return after === 'pass' ? 'improvement' : 'pre-existing'
}

export function summarize(transitions: TestTransition[]): {
  preserved: number
  regressed: number
  preExisting: number
  improved: number
  unknown: number
} {
  const summary = { preserved: 0, regressed: 0, preExisting: 0, improved: 0, unknown: 0 }
  for (const transition of transitions) {
    switch (transition.kind) {
      case 'preserved':
        summary.preserved += 1
        break
      case 'regression':
        summary.regressed += 1
        break
      case 'pre-existing':
        summary.preExisting += 1
        break
      case 'improvement':
        summary.improved += 1
        break
      default:
        summary.unknown += 1
    }
  }
  return summary
}
