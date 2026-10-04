import type { TestCaseOutcome, TestStatus } from '../schema/baseline'

/**
 * Parses jest/vitest JSON reports into individual test outcomes. Both runners
 * share the same shape (verified against vitest 5's --reporter=json output).
 * Returns null when the payload does not match, so the caller falls back to
 * suite-level classification rather than guessing.
 */

interface RawAssertion {
  fullName?: unknown
  title?: unknown
  status?: unknown
  failureMessages?: unknown
}

interface RawTestResult {
  name?: unknown
  testResults?: unknown
  assertionResults?: unknown
}

function mapStatus(status: unknown): TestStatus {
  switch (status) {
    case 'passed':
      return 'passed'
    case 'failed':
      return 'failed'
    case 'pending':
    case 'skipped':
      return 'skipped'
    case 'todo':
      return 'todo'
    default:
      return 'unknown'
  }
}

function firstFailureMessage(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined
  }
  const first = messages.find((message): message is string => typeof message === 'string')
  if (first === undefined) {
    return undefined
  }
  const trimmed = first.trim()
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed
}

export function parseRunnerJson(
  text: string,
  options: { stripPrefix?: string } = {},
): TestCaseOutcome[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const testResults = (parsed as RawTestResult).testResults
  if (!Array.isArray(testResults)) {
    return null
  }

  const outcomes: TestCaseOutcome[] = []
  for (const suite of testResults) {
    if (typeof suite !== 'object' || suite === null) {
      continue
    }
    const rawName = suite.name
    const suiteName =
      typeof rawName === 'string'
        ? options.stripPrefix && rawName.startsWith(options.stripPrefix)
          ? rawName.slice(options.stripPrefix.length).replace(/^[\\/]/, '')
          : rawName
        : undefined

    const assertions = suite.assertionResults
    if (!Array.isArray(assertions)) {
      continue
    }
    for (const assertion of assertions as RawAssertion[]) {
      if (typeof assertion !== 'object' || assertion === null) {
        continue
      }
      const title = typeof assertion.title === 'string' ? assertion.title : '(untitled)'
      const id = typeof assertion.fullName === 'string' && assertion.fullName.length > 0 ? assertion.fullName : title
      outcomes.push({
        id,
        title,
        file: suiteName,
        status: mapStatus(assertion.status),
        failureMessage: firstFailureMessage(assertion.failureMessages),
      })
    }
  }

  return outcomes
}
