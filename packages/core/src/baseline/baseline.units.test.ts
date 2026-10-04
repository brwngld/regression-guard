import { describe, expect, it } from 'vitest'
import { discoverTestCommand, packageJsonHasDependencies } from './discover'
import { parseRunnerJson } from './parse'
import { classifyPerTest, classifySuite, suiteStatusOf, summarize } from './compare'

describe('discoverTestCommand', () => {
  it('injects a JSON result file for vitest scripts', () => {
    const plan = discoverTestCommand(JSON.stringify({ scripts: { test: 'vitest run' } }))
    expect(plan?.runner).toBe('vitest')
    expect(plan?.userCommand).toBe('npm test')
    expect(plan?.buildExecutedCommand()).toBe(
      'npx vitest run --reporter=json --outputFile=.regression-guard-tests.json',
    )
  })

  it('preserves extra vitest arguments and accepts bare vitest scripts', () => {
    const withCoverage = discoverTestCommand(JSON.stringify({ scripts: { test: 'vitest run --coverage' } }))
    expect(withCoverage?.buildExecutedCommand()).toContain('--coverage')
    const bare = discoverTestCommand(JSON.stringify({ scripts: { test: 'vitest' } }))
    expect(bare?.buildExecutedCommand()).toContain('npx vitest run --reporter=json')
  })

  it('injects --json for jest scripts', () => {
    const plan = discoverTestCommand(JSON.stringify({ scripts: { test: 'jest --silent' } }))
    expect(plan?.runner).toBe('jest')
    expect(plan?.buildExecutedCommand()).toContain('npx jest --json --outputFile=.regression-guard-tests.json --silent')
  })

  it('runs unknown scripts verbatim (suite-level fallback)', () => {
    const plan = discoverTestCommand(JSON.stringify({ scripts: { test: 'node tests/run.js --fast' } }))
    expect(plan?.runner).toBe('generic')
    expect(plan?.buildExecutedCommand()).toBe('node tests/run.js --fast')
  })

  it('returns null without a usable test script', () => {
    expect(discoverTestCommand(null)).toBeNull()
    expect(discoverTestCommand(JSON.stringify({}))).toBeNull()
    expect(discoverTestCommand(JSON.stringify({ scripts: {} }))).toBeNull()
    expect(discoverTestCommand(JSON.stringify({ scripts: { test: '  ' } }))).toBeNull()
    expect(discoverTestCommand('not json')).toBeNull()
  })

  it('detects whether dependencies need installing', () => {
    expect(packageJsonHasDependencies(null)).toBe(false)
    expect(packageJsonHasDependencies(JSON.stringify({}))).toBe(false)
    expect(packageJsonHasDependencies(JSON.stringify({ devDependencies: { vitest: '^5' } }))).toBe(true)
    expect(packageJsonHasDependencies(JSON.stringify({ dependencies: {} }))).toBe(false)
  })
})

// Shape recorded from vitest 5 --reporter=json output (jest-compatible).
const VITEST_JSON = JSON.stringify({
  numTotalTests: 2,
  numPassedTests: 1,
  numFailedTests: 1,
  success: false,
  testResults: [
    {
      name: '/repo/worktree/tests/app.test.ts',
      status: 'failed',
      message: '',
      assertionResults: [
        { ancestorTitles: ['tasks'], fullName: 'tasks > adds a task', title: 'adds a task', status: 'passed', failureMessages: [] },
        {
          ancestorTitles: ['tasks'],
          fullName: 'tasks > rejects blank',
          title: 'rejects blank',
          status: 'failed',
          failureMessages: ['Error: expected throw\n    at file.ts:1:1'],
        },
      ],
    },
  ],
})

describe('parseRunnerJson', () => {
  it('parses jest/vitest assertion results into test outcomes', () => {
    const outcomes = parseRunnerJson(VITEST_JSON)
    expect(outcomes).toEqual([
      { id: 'tasks > adds a task', title: 'adds a task', file: '/repo/worktree/tests/app.test.ts', status: 'passed', failureMessage: undefined },
      {
        id: 'tasks > rejects blank',
        title: 'rejects blank',
        file: '/repo/worktree/tests/app.test.ts',
        status: 'failed',
        failureMessage: 'Error: expected throw\n    at file.ts:1:1',
      },
    ])
  })

  it('relativizes file names against the worktree prefix', () => {
    const outcomes = parseRunnerJson(VITEST_JSON, { stripPrefix: '/repo/worktree' })
    expect(outcomes?.[0]?.file).toBe('tests/app.test.ts')
  })

  it('maps pending/todo statuses and falls back to unknown', () => {
    const outcomes = parseRunnerJson(
      JSON.stringify({
        testResults: [
          {
            name: 't.ts',
            assertionResults: [
              { fullName: 'a', title: 'a', status: 'pending', failureMessages: [] },
              { fullName: 'b', title: 'b', status: 'todo', failureMessages: [] },
              { fullName: 'c', title: 'c', status: 'weird', failureMessages: [] },
            ],
          },
        ],
      }),
    )
    expect(outcomes?.map((outcome) => outcome.status)).toEqual(['skipped', 'todo', 'unknown'])
  })

  it('returns null for non-matching payloads', () => {
    expect(parseRunnerJson('not json')).toBeNull()
    expect(parseRunnerJson('{"success":true}')).toBeNull()
    expect(parseRunnerJson('[]')).toBeNull()
  })
})

describe('transition classification', () => {
  const test = (id: string, status: 'passed' | 'failed' | 'skipped') => ({ id, title: id, status })

  it('classifies the four canonical transitions', () => {
    const transitions = classifyPerTest(
      [test('a', 'passed'), test('b', 'passed'), test('c', 'failed'), test('d', 'failed')],
      [test('a', 'passed'), test('b', 'failed'), test('c', 'failed'), test('d', 'passed')],
    )
    expect(transitions.map((transition) => transition.kind)).toEqual([
      'preserved',
      'regression',
      'pre-existing',
      'improvement',
    ])
  })

  it('treats missing or inconclusive after-outcomes as unknown, never pass', () => {
    const transitions = classifyPerTest(
      [test('a', 'passed'), test('b', 'failed')],
      [test('a', 'skipped')],
    )
    expect(transitions.map((transition) => transition.kind)).toEqual(['unknown', 'unknown'])
    expect(summarize(transitions)).toEqual({ preserved: 0, regressed: 0, preExisting: 0, improved: 0, unknown: 2 })
  })

  it('ignores tests that only exist after the change', () => {
    const transitions = classifyPerTest([test('a', 'passed')], [test('a', 'passed'), test('new', 'passed')])
    expect(transitions).toHaveLength(1)
  })

  it('derives suite status from exit code, timeout, and spawn errors', () => {
    expect(suiteStatusOf({ exitCode: 0, timedOut: false, spawnError: null })).toBe('pass')
    expect(suiteStatusOf({ exitCode: 1, timedOut: false, spawnError: null })).toBe('fail')
    expect(suiteStatusOf({ exitCode: null, timedOut: true, spawnError: null })).toBe('unknown')
    expect(suiteStatusOf({ exitCode: null, timedOut: false, spawnError: 'spawn ENOENT' })).toBe('unknown')
  })

  it('classifies suites with the same table', () => {
    expect(classifySuite('pass', 'pass')).toBe('preserved')
    expect(classifySuite('pass', 'fail')).toBe('regression')
    expect(classifySuite('fail', 'fail')).toBe('pre-existing')
    expect(classifySuite('fail', 'pass')).toBe('improvement')
    expect(classifySuite('unknown', 'pass')).toBe('unknown')
    expect(classifySuite('pass', 'unknown')).toBe('unknown')
  })
})
