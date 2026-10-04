import { describe, expect, it } from 'vitest'
import { verifyChange } from '../src/pipeline'
import { TempRepo, fakeVitestApp, PASSING_SPECS, SAMPLE_APP, type FakeTestSpec } from './helpers/repo'

/**
 * M3 integration: evidence-backed blast radius, deletion/rename semantics,
 * graph honesty, impact coverage, and prediction-vs-reality — over real
 * temporary repositories. M3 is report-only: every test here also guards that
 * invariant (no impact-derived findings, no M2 interference).
 */

const PERMISSIVE = (mustChange: string) =>
  `version: 1\nid: impact-test\ngoal: structural change\npaths:\n  mustChange: ["${mustChange}"]\n`

/** A chain app: auth <- login <- app <- main <- index.html, one test on login. */
const CHAIN_APP: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'chain-app', version: '1.0.0', type: 'module', scripts: { test: 'node tests/run.js' } },
    null,
    2,
  ),
  'index.html': '<html><body><script type="module" src="/src/main.js"></script></body></html>\n',
  'src/lib/auth.js': 'export const auth = true\n',
  'src/login.js': `import { auth } from './lib/auth.js'

export function login() {
  return auth
}
`,
  'src/app.js': `import { login } from './login.js'

export const app = login
`,
  'src/main.js': `import { app } from './app.js'

console.log(app)
`,
  'src/login.test.js': `import { login } from './login.js'

console.log(login())
`,
  'tests/run.js': "console.log('suite ok')\n",
}

async function chainRepo(): Promise<TempRepo> {
  const repo = await TempRepo.create(CHAIN_APP)
  await repo.git('branch', 'base')
  return repo
}

describe('M3: blast radius with evidence chains', () => {
  it('produces HIGH/MEDIUM/LOW by minimum distance with via chains and coverage', async () => {
    const repo = await chainRepo()
    await repo.write({ 'src/lib/auth.js': 'export const auth = false\n' })
    await repo.commit('change auth')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: PERMISSIVE('src/lib/auth.js'),
    })

    const impact = report.impact
    expect(impact?.seeds).toEqual(['src/lib/auth.js'])
    expect(impact?.completeness).toBe('complete')

    const byPath = new Map(impact?.affected.map((node) => [node.path, node]))
    expect(byPath.get('src/login.js')).toMatchObject({ level: 'HIGH', distance: 1, changed: false })
    expect(byPath.get('src/app.js')).toMatchObject({ level: 'MEDIUM', distance: 2 })
    expect(byPath.get('src/main.js')).toMatchObject({ level: 'LOW', distance: 3 })
    expect(byPath.get('index.html')?.level).toBe('LOW') // 4 hops, entrypoint terminal
    expect(byPath.get('src/lib/auth.js')).toMatchObject({ level: 'DIRECT', changed: true, distance: 0 })
    expect(byPath.get('src/login.js')?.via[0]).toEqual(['src/lib/auth.js', 'src/login.js'])
    expect(byPath.get('src/main.js')?.via[0]).toEqual([
      'src/lib/auth.js',
      'src/login.js',
      'src/app.js',
      'src/main.js',
    ])

    // Affected test with an explainable chain.
    expect(impact?.affectedTests).toEqual([
      {
        path: 'src/login.test.js',
        sources: ['src/lib/auth.js'],
        evidencePaths: [['src/lib/auth.js', 'src/login.js', 'src/login.test.js']],
      },
    ])

    // Coverage: login.js is on the test's chain; app.js/main.js/index.html are not.
    expect(impact?.coverage).toMatchObject({ affectedAreas: 4, coveredAreas: 1, uncoveredAreas: 3 })
    expect(impact?.coverage.covered).toEqual(['src/login.js'])
    expect(impact?.coverage.uncovered).toEqual(['index.html', 'src/app.js', 'src/main.js'])

    // Report-only invariant: same findings as M1/M2 would produce (scope-clean
    // change, suite green) — impact adds nothing to the gate.
    expect(report.findings).toEqual([])
    expect(report.verdict).toBe('ACCEPT')
    expect(report.markdown).toContain('Impact analysis')
    expect(report.markdown).toContain('src/lib/auth.js → src/login.js')
    expect(report.markdown).toContain('src/login.test.js ← src/login.js ← src/lib/auth.js')
    expect(report.markdown).toContain('⚠')
    await repo.destroy()
  })

  it('marks completeness partial when the graph has unresolved relationships', async () => {
    const repo = await chainRepo()
    await repo.write({
      'src/dodgy.js': `import x from './missing.js'

console.log(x)
`,
      'src/lib/auth.js': 'export const auth = false\n',
    })
    await repo.commit('add unresolved import and change auth')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: PERMISSIVE('src/lib/auth.js'),
    })

    expect(report.impact?.completeness).toBe('partial')
    expect(report.impact?.unresolvedEdges).toContainEqual({
      from: 'src/dodgy.js',
      specifier: './missing.js',
      kind: 'unresolved-import',
    })
    expect(report.markdown).toContain('PARTIAL')
    await repo.destroy()
  })
})

describe('M3: deletion and rename semantics', () => {
  it('traverses deletions through the BEFORE graph with origin provenance', async () => {
    const repo = await chainRepo()
    await repo.remove(['src/lib/auth.js'])
    await repo.commit('delete auth')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: PERMISSIVE('src/lib/auth.js'),
    })

    const byPath = new Map(report.impact?.affected.map((node) => [node.path, node]))
    // login.js imported the deleted module: affected via the BEFORE graph.
    expect(byPath.get('src/login.js')).toMatchObject({ level: 'HIGH', distance: 1, origin: 'before' })
    expect(byPath.get('src/lib/auth.js')).toMatchObject({ changed: true, origin: 'before' })
    expect(report.impact?.affectedTests.map((test) => test.path)).toContain('src/login.test.js')
    await repo.destroy()
  })

  it('seeds renames from both old (before) and new (after) paths', async () => {
    const repo = await chainRepo()
    await repo.renamePath('src/lib/auth.js', 'src/lib/session.js')
    await repo.write({
      'src/login.js': `import { auth } from './lib/session.js'

export function login() {
  return auth
}
`,
    })
    await repo.commit('rename auth to session')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: PERMISSIVE('src/**'),
    })

    expect(report.impact?.seeds).toContain('src/lib/auth.js')
    expect(report.impact?.seeds).toContain('src/lib/session.js')
    const byPath = new Map(report.impact?.affected.map((node) => [node.path, node]))
    expect(byPath.get('src/lib/auth.js')?.origin).toBe('before')
    expect(byPath.get('src/lib/session.js')?.origin).toBe('after')
    // login.js is itself changed (import update) but still structurally
    // connected to the renamed module through the before graph.
    expect(byPath.get('src/login.js')?.changed).toBe(true)
    await repo.destroy()
  })
})

describe('M3: prediction vs reality', () => {
  it('annotates an observed regression inside the predicted population (hit)', async () => {
    const repo = await TempRepo.create(SAMPLE_APP)
    await repo.git('branch', 'base')
    // Break tasks.js: predicted affected tests include src/tasks.test.js and
    // tests/run.js (both import it), and the suite regresses.
    await repo.write({
      'src/tasks.js': `export const STORAGE_KEY = 'sample.tasks'

export function addTask(tasks, text) {
  return [...tasks, { id: 'fixed-id', text: String(text ?? ''), completed: false }]
}
`,
    })
    await repo.commit('break normalization')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: PERMISSIVE('src/tasks.js'),
    })

    const review = report.impact?.predictionReview
    expect(review?.mode).toBe('suite') // SAMPLE_APP uses a generic runner
    expect(review?.observedRegressions).toBe(1)
    expect(review?.predictedTests).toBeGreaterThanOrEqual(2)
    // Suite mode claims no per-test attribution — honestly.
    expect(review?.predictionMisses).toEqual([])
    expect(report.markdown).toContain('per-test attribution unavailable')
    await repo.destroy()
  })

  it('surfaces a regression OUTSIDE the predicted population as a measurement miss (fake per-test runner)', async () => {
    // The fake runner DERIVES one test's outcome from src/index.js, so the
    // regressing test file never changes — only the module does. The test
    // file has no structural connection to the module, so the regression is
    // genuinely outside the predicted population: the deliberate miss case.
    const DERIVED_RUNNER = `import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addTask } from '../src/index.js'

const base = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
let outputFile = null
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--outputFile' && argv[i + 1] !== undefined) {
    outputFile = argv[++i]
  } else if (arg.startsWith('--outputFile=')) {
    outputFile = arg.slice('--outputFile='.length)
  }
}

const spec = JSON.parse(await readFile(join(base, '..', 'tests', 'spec.json'), 'utf8'))
const healthy = Array.isArray(addTask()) && addTask().length === 1
const tests = spec.tests.map((test, index) =>
  index === 0
    ? {
        ...test,
        status: healthy ? 'passed' : 'failed',
        failureMessage: healthy ? undefined : 'Error: derived regression from src/index.js',
      }
    : test,
)
const failed = tests.filter((test) => test.status === 'failed')
const report = {
  numTotalTests: tests.length,
  numPassedTests: tests.length - failed.length,
  numFailedTests: failed.length,
  success: failed.length === 0,
  testResults: [
    {
      name: join(base, '..', 'tests', 'spec.vtest.js'),
      status: failed.length === 0 ? 'passed' : 'failed',
      message: '',
      assertionResults: tests.map((test) => ({
        ancestorTitles: [],
        fullName: test.fullName,
        title: test.title,
        status: test.status,
        failureMessages: test.failureMessage ? [test.failureMessage] : [],
      })),
    },
  ],
}
if (outputFile) {
  await writeFile(outputFile, JSON.stringify(report, null, 2))
}
process.exit(failed.length === 0 ? 0 : 1)
`
    const repo = await TempRepo.create({
      'package.json': JSON.stringify(
        { name: 'derived-app', version: '1.0.0', type: 'module', scripts: { test: 'vitest run' } },
        null,
        2,
      ),
      'src/index.js': `export function addTask() {
  return ['x']
}
`,
      'tests/spec.json': JSON.stringify({ tests: PASSING_SPECS }, null, 2),
      'tools/fake-vitest.mjs': DERIVED_RUNNER,
      'node_modules/.bin/vitest': `#!/usr/bin/env node
import '../../tools/fake-vitest.mjs'
`,
      'node_modules/.bin/vitest.cmd': `@node "%~dp0/../../tools/fake-vitest.mjs" %*
`,
    })
    await repo.markExecutable('node_modules/.bin/vitest')
    await repo.git('branch', 'base')

    // Change ONLY the module; the derived test flips to failing on its own.
    await repo.write({
      'src/index.js': `export function addTask() {
  return ['x', 'y']
}
`,
    })
    await repo.commit('break the derived behavior')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: PERMISSIVE('src/index.js'),
    })

    const review = report.impact?.predictionReview
    expect(review?.mode).toBe('per-test')
    expect(review?.observedRegressions).toBe(1)
    expect(review?.predictedTests).toBe(0)
    expect(review?.predictedRegressions).toBe(0)
    expect(review?.predictionMisses).toEqual([
      { test: 'tasks > adds a task', file: 'tests/spec.vtest.js' },
    ])

    // CRITICAL: a prediction miss is analyzer incompleteness, never a gate
    // finding. M2 owns the real regression (and rejects on it); impact adds
    // no finding class of its own.
    const classes = report.findings.map((finding) => finding.findingClass)
    expect(classes).toContain('test-regression')
    expect(classes).not.toContain('prediction-miss')
    expect(classes).not.toContain('coverage-gap')
    expect(report.verdict).toBe('REJECT') // from M2's regression alone
    expect(report.markdown).toContain('prediction miss')
    await repo.destroy()
  })
})

describe('M3: lock-down — impact must not alter M2', () => {
  it('leaves M2 execution and regression semantics byte-identical', async () => {
    const repo = await TempRepo.create(fakeVitestApp(PASSING_SPECS))
    await repo.markExecutable('node_modules/.bin/vitest')
    await repo.git('branch', 'base')
    const broken: FakeTestSpec[] = [
      PASSING_SPECS[0]!,
      { fullName: 'tasks > rejects blank', title: 'rejects blank', status: 'failed', failureMessage: 'boom' },
    ]
    await repo.write({ 'tests/spec.json': JSON.stringify({ tests: broken }, null, 2) })
    await repo.commit('break one test')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: PERMISSIVE('tests/spec.json'),
    })

    // M2 executed exactly what it would have without M3.
    expect(report.baseline?.before.command).toBe(
      'npx vitest run --reporter=json --outputFile=.regression-guard-tests.json',
    )
    expect(report.baseline?.after.command).toBe(report.baseline?.before.command)
    expect(report.baseline?.before.tests).toHaveLength(2)
    expect(report.threeQuestions.regressions).toEqual({ status: 'fail', baselineTests: 2, regressionsFound: 1 })
    expect(report.verdict).toBe('REJECT')

    // And the findings/gate contain ONLY M1/M2 classes — impact is invisible
    // to the gate.
    expect(report.findings.map((finding) => finding.findingClass)).toEqual(['test-regression'])
    expect(report.triggeredActions).toEqual(['reject'])
    expect(report.impact).toBeDefined()
    await repo.destroy()
  })
})
