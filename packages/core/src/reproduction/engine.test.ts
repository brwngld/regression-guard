import { describe, expect, it } from 'vitest'
import type { FindingClass } from '../schema/contract'
import type { Finding } from '../schema/evidence'
import type {
  AttemptOutcome,
  ReproductionAttempt,
  ReproductionExperiment,
} from '../schema/reproduction'
import type { GitAdapter } from '../vcs/git'
import {
  aggregateAssessment,
  buildExperiments,
  commandStringFor,
  shellQuote,
  type ExperimentContext,
} from './engine'

const BEFORE_SHA = 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1'
const AFTER_SHA = 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2'

function context(overrides: Partial<ExperimentContext> = {}): ExperimentContext {
  return {
    git: {} as unknown as GitAdapter,
    before: { label: 'main', kind: 'ref', sha: BEFORE_SHA },
    after: { label: 'feature', kind: 'ref', sha: AFTER_SHA },
    testPlan: {
      runner: 'vitest',
      userCommand: 'npm test',
      buildExecutedCommand: () =>
        'npx vitest run --reporter=json --outputFile=.regression-guard-tests.json',
      testCommandInstalled: true,
    },
    config: { attempts: 3, timeoutMs: 30_000 },
    ...overrides,
  }
}

function finding(id: string, findingClass: FindingClass, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    findingClass,
    severity: 'warn',
    message: '',
    paths: [],
    evidence: { kind: 'diff', claim: '', observation: '', changedLines: [], reproduction: '' },
    ...overrides,
  }
}

function regressionFinding(overrides: Partial<Finding> = {}): Finding {
  return finding('TEST-001', 'test-regression', {
    severity: 'critical',
    message: 'Test "tasks > rejects blank" passed at baseline and fails after the change.',
    paths: ['tests/app.test.ts'],
    evidence: {
      kind: 'test',
      claim: 'Test "tasks > rejects blank" regressed: it passed before the change and fails after it.',
      observation: 'Experiment.',
      changedLines: [],
      reproduction: 'npm test',
    },
    ...overrides,
  })
}

describe('buildExperiments', () => {
  it('maps classes to kinds and numbers ids in finding order', () => {
    const findings = [
      finding('SCOPE-001', 'unfulfilled-contract'),
      finding('SCOPE-002', 'prohibited-change', { paths: ['db/migrate.sql'] }),
      regressionFinding(),
      finding('TEST-002', 'pre-existing-failure'),
      finding('BASE-001', 'baseline-incomplete'),
      finding('BASE-002', 'test-command-changed'),
    ]
    const experiments = buildExperiments(findings, context())
    expect(experiments.map((experiment) => experiment.id)).toEqual(['REPRO-001', 'REPRO-002'])
    expect(experiments.map((experiment) => experiment.kind)).toEqual(['git-diff', 'test'])
    expect(experiments.map((experiment) => experiment.sourceFindingIds)).toEqual([
      ['SCOPE-002'],
      ['TEST-001'],
    ])
  })

  it.each([
    'prohibited-change',
    'preserved-area-changed',
    'out-of-scope-change',
    'sensitive-file-changed',
    'deleted-test',
    'new-dependency',
    'removed-dependency',
    'changed-dependency',
  ] as const)('builds a git-diff experiment for %s', (findingClass) => {
    const [experiment] = buildExperiments([finding('S-001', findingClass, { paths: ['src/x.ts'] })], context())
    expect(experiment).toMatchObject({
      id: 'REPRO-001',
      kind: 'git-diff',
      granularity: 'n/a',
      command: {
        executable: 'git',
        args: ['diff', BEFORE_SHA, AFTER_SHA, '--', 'src/x.ts'],
        cwd: '<repo>',
      },
    })
  })

  it('uses the recorded baseSha (not the movable HEAD label) as the after token in working-tree mode', () => {
    const workingTree = context({
      after: {
        label: 'working-tree',
        kind: 'working-tree',
        sha: null,
        baseSha: 'c4'.padEnd(40, 'c4'),
        fingerprint: 'sha256:dirty',
      },
    })
    const [experiment] = buildExperiments(
      [finding('S-001', 'prohibited-change', { paths: ['src/x.ts'] })],
      workingTree,
    )
    expect(experiment?.command.args).toEqual(['diff', BEFORE_SHA, 'c4'.padEnd(40, 'c4'), '--', 'src/x.ts'])
  })

  it('carries immutable SHAs — never the labels — in the git-diff command args', () => {
    // Labels deliberately distinct from (and confusable with) the SHAs: a ref
    // named like a short SHA must not leak into the authoritative command.
    const ctx = context({
      before: { label: 'develop', kind: 'ref', sha: BEFORE_SHA },
      after: { label: 'release/candidate', kind: 'ref', sha: AFTER_SHA },
    })
    const [experiment] = buildExperiments(
      [finding('S-001', 'prohibited-change', { paths: ['src/x.ts'] })],
      ctx,
    )
    expect(experiment?.command.args).toEqual(['diff', BEFORE_SHA, AFTER_SHA, '--', 'src/x.ts'])
    expect(experiment?.command.args).not.toContain('develop')
    expect(experiment?.command.args).not.toContain('release/candidate')
  })

  it('emits deterministic, class-specific purpose strings', () => {
    const two = buildExperiments(
      [
        finding('S-001', 'prohibited-change', { paths: ['db/a.sql'] }),
        finding('S-002', 'prohibited-change', { paths: ['db/b.sql'] }),
        finding('S-003', 'preserved-area-changed', { paths: ['docs/api.md'] }),
      ],
      context(),
    )
    expect(two[0]?.purpose).toBe(two[1]?.purpose)
    expect(two[0]?.purpose).not.toBe(two[2]?.purpose)
  })

  it('skips pathless git-diff candidates and test regressions without a test plan', () => {
    expect(buildExperiments([finding('S-001', 'prohibited-change')], context())).toEqual([])
    expect(buildExperiments([regressionFinding()], context({ testPlan: null }))).toEqual([])
  })

  it('carries the after state identity and configured timeout on every experiment', () => {
    const ctx = context()
    const experiments = buildExperiments(
      [finding('S-001', 'out-of-scope-change', { paths: ['src/x.ts'] }), regressionFinding()],
      ctx,
    )
    for (const experiment of experiments) {
      expect(experiment.stateIdentity).toEqual(ctx.after)
      expect(experiment.timeoutMs).toBe(ctx.config.timeoutMs)
    }
  })
})

describe('buildExperiments granularity ladder (test-regression)', () => {
  it('runs at file level for a direct runner with a known path, carrying the case target as data', () => {
    const [experiment] = buildExperiments([regressionFinding()], context())
    expect(experiment?.granularity).toBe('file')
    expect(experiment?.testName).toBe('tasks > rejects blank')
    expect(experiment?.command).toEqual({
      executable: 'npx',
      args: ['vitest', 'run', '--reporter=json', '--outputFile=.regression-guard-tests.json', 'tests/app.test.ts'],
      cwd: '<isolated-worktree>',
    })
    expect(commandStringFor(experiment!.command)).toBe(
      'npx vitest run --reporter=json --outputFile=.regression-guard-tests.json tests/app.test.ts',
    )
    // Runner name-pattern flags are never used for execution: their matching
    // semantics are unreliable across runners and versions.
    expect(experiment?.command.args).not.toContain('-t')
  })

  it.each([
    { hazard: 'double quote', name: 'weird "quoted" name' },
    { hazard: 'backslash', name: 'weird \\ name' },
    { hazard: 'backtick', name: 'weird ` name' },
    { hazard: 'control character', name: 'weird\nname' },
    { hazard: 'dollar sign', name: 'weird $HOME name' },
  ])('carries a $hazard in the test name as data without touching the command', ({ name }) => {
    const message = `Test "${name}" passed at baseline and fails after the change.`
    const [experiment] = buildExperiments([regressionFinding({ message })], context())
    expect(experiment?.granularity).toBe('file')
    expect(experiment?.testName).toBe(name)
    expect(experiment?.command.args.slice(-1)).toEqual(['tests/app.test.ts'])
  })

  it('falls to suite level when no path is known (testName still carried)', () => {
    const [experiment] = buildExperiments([regressionFinding({ paths: [] })], context())
    expect(experiment?.granularity).toBe('suite')
    expect(experiment?.testName).toBe('tasks > rejects blank')
    expect(commandStringFor(experiment!.command)).toBe(
      'npx vitest run --reporter=json --outputFile=.regression-guard-tests.json',
    )
  })

  it('falls to file level when no test name is extractable but the file is known', () => {
    const [experiment] = buildExperiments(
      [regressionFinding({ message: 'The test suite regressed.', evidence: { kind: 'test', claim: 'The test suite regressed.', observation: 'x', changedLines: [], reproduction: 'npm test' } })],
      context(),
    )
    expect(experiment?.granularity).toBe('file')
    expect(experiment?.testName).toBeUndefined()
    expect(experiment?.purpose).toBe('Re-run the failing test file against the recorded after state.')
  })

  it('builds the analogous jest file command', () => {
    const jest = context({
      testPlan: {
        runner: 'jest',
        userCommand: 'npm test',
        buildExecutedCommand: () => 'npx jest --json --outputFile=.regression-guard-tests.json',
        testCommandInstalled: true,
      },
    })
    const [experiment] = buildExperiments([regressionFinding()], jest)
    expect(experiment?.command.args).toEqual([
      'jest',
      '--json',
      '--outputFile=.regression-guard-tests.json',
      'tests/app.test.ts',
    ])
  })

  it('runs generic runners at suite level through npm test (never re-tokenizing the script)', () => {
    const generic = context({
      testPlan: {
        runner: 'generic',
        userCommand: 'npm test',
        buildExecutedCommand: () => 'node tests/run.js --fast',
        testCommandInstalled: false,
      },
    })
    const [experiment] = buildExperiments([regressionFinding()], generic)
    expect(experiment?.granularity).toBe('suite')
    expect(experiment?.command).toEqual({ executable: 'npm', args: ['test'], cwd: '<isolated-worktree>' })
  })
})

describe('shellQuote / commandStringFor', () => {
  it('passes plain words through untouched', () => {
    expect(shellQuote('vitest')).toBe('vitest')
    expect(shellQuote('--outputFile=.regression-guard-tests.json')).toBe(
      '--outputFile=.regression-guard-tests.json',
    )
    expect(shellQuote('tests/app.test.ts')).toBe('tests/app.test.ts')
  })

  it('double-quotes args with shell metacharacters', () => {
    expect(shellQuote('tasks > rejects blank')).toBe('"tasks > rejects blank"')
    expect(shellQuote('')).toBe('""')
  })

  it('returns null for args that cannot be quoted safely', () => {
    expect(shellQuote('a"b')).toBeNull()
    expect(shellQuote('a\\b')).toBeNull()
    expect(shellQuote('a`b')).toBeNull()
    expect(shellQuote('a\nb')).toBeNull()
    expect(shellQuote('a$b')).toBeNull()
  })

  it('joins executable and quoted args, and refuses unquotable args', () => {
    expect(
      commandStringFor({ executable: 'git', args: ['diff', 'a b', '--', 'src/x.ts'], cwd: '<repo>' }),
    ).toBe('git diff "a b" -- src/x.ts')
    expect(() => commandStringFor({ executable: 'npx', args: ['vitest', 'a"b'], cwd: '<repo>' })).toThrow(
      /cannot be quoted safely/,
    )
  })
})

/** A fixed experiment for aggregation semantics; aggregateAssessment is pure. */
const EXPERIMENT: ReproductionExperiment = {
  id: 'REPRO-001',
  kind: 'test',
  purpose: 'Re-run the single failing test case against the recorded after state.',
  command: { executable: 'npx', args: ['vitest'], cwd: '<isolated-worktree>' },
  granularity: 'case',
  timeoutMs: 30_000,
  stateIdentity: { label: 'feature', kind: 'ref', sha: AFTER_SHA },
  sourceFindingIds: ['TEST-001'],
}

const GIT_DIFF_EXPERIMENT: ReproductionExperiment = {
  ...EXPERIMENT,
  kind: 'git-diff',
  granularity: 'n/a',
  command: { executable: 'git', args: ['diff', BEFORE_SHA, AFTER_SHA, '--', 'src/x.ts'], cwd: '<repo>' },
}

function attempt(index: number, outcome: AttemptOutcome): ReproductionAttempt {
  return {
    index,
    experimentId: EXPERIMENT.id,
    stateIdentity: EXPERIMENT.stateIdentity,
    outcome,
    exitCode: outcome === 'reproduced' ? 1 : outcome === 'not-reproduced' ? 0 : null,
    durationMs: 10,
    timedOut: false,
  }
}

function attemptsOf(shape: { reproduced: number; notReproduced: number; inconclusive: number }): ReproductionAttempt[] {
  const attempts: ReproductionAttempt[] = []
  let index = 0
  for (let i = 0; i < shape.reproduced; i += 1) attempts.push(attempt(++index, 'reproduced'))
  for (let i = 0; i < shape.notReproduced; i += 1) attempts.push(attempt(++index, 'not-reproduced'))
  for (let i = 0; i < shape.inconclusive; i += 1) attempts.push(attempt(++index, 'inconclusive'))
  return attempts
}

describe('aggregateAssessment semantics table', () => {
  it.each([
    {
      case: 'all reproduced -> stable',
      shape: { reproduced: 3, notReproduced: 0, inconclusive: 0 },
      stateMatched: true,
      expected: 'stable',
    },
    {
      case: 'mixed reproduced/not-reproduced -> unstable',
      shape: { reproduced: 2, notReproduced: 1, inconclusive: 0 },
      stateMatched: true,
      expected: 'unstable',
    },
    {
      case: '3/1/1 -> inconclusive, counts preserved',
      shape: { reproduced: 3, notReproduced: 1, inconclusive: 1 },
      stateMatched: true,
      expected: 'inconclusive',
    },
    {
      case: '3/0/2 -> inconclusive, counts preserved',
      shape: { reproduced: 3, notReproduced: 0, inconclusive: 2 },
      stateMatched: true,
      expected: 'inconclusive',
    },
    {
      case: 'none reproduced -> not-reproduced',
      shape: { reproduced: 0, notReproduced: 3, inconclusive: 0 },
      stateMatched: true,
      expected: 'not-reproduced',
    },
  ])('$case', ({ shape, stateMatched, expected }) => {
    const attempts = attemptsOf(shape)
    const assessment = aggregateAssessment(EXPERIMENT, attempts, stateMatched)
    expect(assessment.stability).toBe(expected)
    expect(assessment.reproduced).toBe(shape.reproduced)
    expect(assessment.notReproduced).toBe(shape.notReproduced)
    expect(assessment.inconclusive).toBe(shape.inconclusive)
    expect(assessment.attemptsCompleted).toBe(shape.reproduced + shape.notReproduced)
    expect(assessment.attempts).toHaveLength(attempts.length)
  })

  it('defaults attemptsRequested to the attempt count when not given', () => {
    const assessment = aggregateAssessment(
      EXPERIMENT,
      attemptsOf({ reproduced: 2, notReproduced: 1, inconclusive: 0 }),
      true,
    )
    expect(assessment.attemptsRequested).toBe(3)
  })

  it('keeps the requested count visible when attempts are inconclusive (3/0/2 over 5 requested)', () => {
    const assessment = aggregateAssessment(
      EXPERIMENT,
      attemptsOf({ reproduced: 3, notReproduced: 0, inconclusive: 2 }),
      true,
      5,
    )
    expect(assessment.attemptsRequested).toBe(5)
    expect(assessment.attemptsCompleted).toBe(3)
    expect(assessment.stability).toBe('inconclusive')
  })

  it('reports zero executed attempts as inconclusive, never stable', () => {
    const assessment = aggregateAssessment(EXPERIMENT, [], true, 3)
    expect(assessment).toMatchObject({
      attemptsRequested: 3,
      attemptsCompleted: 0,
      reproduced: 0,
      notReproduced: 0,
      inconclusive: 0,
      stability: 'inconclusive',
      attempts: [],
    })
  })

  it('reports state mismatches as inconclusive with empty attempts and zero counts', () => {
    const assessment = aggregateAssessment(EXPERIMENT, [], false, 3)
    expect(assessment).toMatchObject({
      stateMatched: false,
      attemptsRequested: 3,
      attemptsCompleted: 0,
      reproduced: 0,
      notReproduced: 0,
      inconclusive: 0,
      stability: 'inconclusive',
      attempts: [],
    })
  })

  it('carries the experiment identity fields through defensively copied', () => {
    const attempts = attemptsOf({ reproduced: 1, notReproduced: 0, inconclusive: 0 })
    const assessment = aggregateAssessment(GIT_DIFF_EXPERIMENT, attempts, true, 1)
    expect(assessment.experimentId).toBe('REPRO-001')
    expect(assessment.granularity).toBe('n/a')
    expect(assessment.stateIdentity).toEqual(EXPERIMENT.stateIdentity)
    expect(assessment.sourceFindingIds).toEqual(['TEST-001'])

    attempts[0]!.outcome = 'not-reproduced'
    attempts[0]!.experimentId = 'REPRO-999'
    attempts[0]!.stateIdentity = { label: 'mutated', kind: 'ref', sha: 'm1'.padEnd(40, 'm1') }
    expect(assessment.attempts[0]!.outcome).toBe('reproduced')
    expect(assessment.attempts[0]!.experimentId).toBe('REPRO-001')
    expect(assessment.attempts[0]!.stateIdentity).toEqual(EXPERIMENT.stateIdentity)
  })

  it('attributes every attempt independently: experiment id + the state identity it ran against', () => {
    const attempts = attemptsOf({ reproduced: 2, notReproduced: 1, inconclusive: 0 })
    const assessment = aggregateAssessment(EXPERIMENT, attempts, true, 3)
    expect(assessment.attempts).toHaveLength(3)
    for (const attempt of assessment.attempts) {
      expect(attempt.experimentId).toBe(EXPERIMENT.id)
      expect(attempt.stateIdentity).toEqual(EXPERIMENT.stateIdentity)
    }
  })
})
