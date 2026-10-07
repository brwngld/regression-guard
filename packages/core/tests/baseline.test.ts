import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyChange } from '../src/pipeline'
import { GitAdapter } from '../src/vcs/git'
import { TempRepo, fakeVitestApp, PASSING_SPECS, SAMPLE_APP, type FakeTestSpec } from './helpers/repo'

const SPEC_CONTRACT = `
version: 1
id: spec-update
goal: Update the test specification
paths:
  mustChange: ["tests/spec.json"]
`

async function specJson(specs: FakeTestSpec[]): Promise<string> {
  return JSON.stringify({ tests: specs }, null, 2)
}

describe('baseline engine (per-test mode via direct runner)', () => {
  let repo: TempRepo

  beforeAll(async () => {
    repo = await TempRepo.create(fakeVitestApp(PASSING_SPECS))
    await repo.markExecutable('node_modules/.bin/vitest')
    await repo.git('branch', 'base')
  })

  afterAll(async () => {
    await repo.destroy()
  })

  it('reports preserved baseline (pass) for a change that breaks nothing', async () => {
    await repo.write({ 'README.md': '# fake app\n\nmore\n' })
    await repo.commit('docs')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: SPEC_CONTRACT.replaceAll('tests/spec.json', 'README.md'),
    })

    expect(report.threeQuestions.regressions).toEqual({ status: 'pass', baselineTests: 2, regressionsFound: 0 })
    expect(report.verdict).toBe('ACCEPT')
    expect(report.baseline?.perTest).toBe(true)
  })

  it('detects a deterministic PASS->FAIL regression and rejects', async () => {
    await repo.git('checkout', '-q', '-b', 'break', 'base')
    const broken: FakeTestSpec[] = [
      PASSING_SPECS[0]!,
      { fullName: 'tasks > rejects blank', title: 'rejects blank', status: 'failed', failureMessage: 'Expected throw but nothing was thrown' },
    ]
    await repo.write({ 'tests/spec.json': await specJson(broken) })
    await repo.commit('break a test')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'break', contract: SPEC_CONTRACT })

    expect(report.threeQuestions.regressions).toEqual({ status: 'fail', baselineTests: 2, regressionsFound: 1 })
    expect(report.verdict).toBe('REJECT')

    const regression = report.findings.find((finding) => finding.findingClass === 'test-regression')
    expect(regression?.evidence.kind).toBe('test')
    expect(regression?.evidence.claim).toContain('tasks > rejects blank')
    expect(regression?.evidence.observation).toContain('Before')
    expect(regression?.evidence.observation).toContain('After')
    expect(regression?.evidence.observation).toContain('Expected throw but nothing was thrown')
    expect(regression?.evidence.reproduction).toBe('npm test')
    expect(report.baseline?.summary).toMatchObject({ preserved: 1, regressed: 1, preExisting: 0 })
  })

  it('leaves worktrees cleaned up and the checkout untouched after verification', async () => {
    const worktrees = (await repo.git('worktree', 'list', '--porcelain')).trim().split('\n\n').length
    expect(worktrees).toBe(1)
    const status = await repo.git('status', '--porcelain')
    expect(status.trim()).toBe('')
  })

  it('treats FAIL->FAIL as pre-existing, never worsening the verdict', async () => {
    // Fresh repo whose baseline already has one failing test.
    const dirty = await TempRepo.create(
      fakeVitestApp([
        PASSING_SPECS[0]!,
        { fullName: 'tasks > rejects blank', title: 'rejects blank', status: 'failed', failureMessage: 'broken before the change' },
      ]),
    )
    await dirty.markExecutable('node_modules/.bin/vitest')
    await dirty.git('branch', 'base')
    await dirty.write({ 'README.md': '# changed\n' })
    await dirty.commit('innocent change')

    const report = await verifyChange({
      repo: dirty.dir,
      before: 'base',
      after: 'HEAD',
      contract: SPEC_CONTRACT.replaceAll('tests/spec.json', 'README.md'),
    })

    expect(report.threeQuestions.regressions).toEqual({ status: 'pass', baselineTests: 2, regressionsFound: 0 })
    expect(report.baseline?.summary).toMatchObject({ preserved: 1, preExisting: 1, regressed: 0 })
    const preExisting = report.findings.find((finding) => finding.findingClass === 'pre-existing-failure')
    expect(preExisting?.severity).toBe('info')
    // The spec's key requirement: a pre-existing failure alone must not reject.
    expect(report.verdict).toBe('ACCEPT')
    await dirty.destroy()
  })

  it('treats FAIL->PASS as an improvement (pass, no finding)', async () => {
    const repair = await TempRepo.create(
      fakeVitestApp([
        PASSING_SPECS[0]!,
        { fullName: 'tasks > rejects blank', title: 'rejects blank', status: 'failed', failureMessage: 'broken before' },
      ]),
    )
    await repair.markExecutable('node_modules/.bin/vitest')
    await repair.git('branch', 'base')
    await repair.write({ 'tests/spec.json': await specJson(PASSING_SPECS) })
    await repair.commit('repair the test')

    const report = await verifyChange({ repo: repair.dir, before: 'base', after: 'HEAD', contract: SPEC_CONTRACT })

    expect(report.baseline?.summary).toMatchObject({ preserved: 1, improved: 1, regressed: 0 })
    expect(report.threeQuestions.regressions.status).toBe('pass')
    expect(report.verdict).toBe('ACCEPT')
    await repair.destroy()
  })

  it('classifies missing-after tests as inconclusive (partial), never silently passing', async () => {
    await repo.git('checkout', '-q', '-b', 'remove-test', 'base')
    await repo.write({ 'tests/spec.json': await specJson([PASSING_SPECS[0]!]) })
    await repo.commit('remove a test')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'remove-test', contract: SPEC_CONTRACT })

    expect(report.threeQuestions.regressions.status).toBe('partial')
    expect(report.baseline?.summary).toMatchObject({ preserved: 1, unknown: 1 })
    expect(report.findings.map((finding) => finding.findingClass)).toContain('baseline-incomplete')
    await repo.git('checkout', '-q', '-')
  })
})

describe('baseline engine (suite-level fallback)', () => {
  it('detects suite regressions for runners without per-test output', async () => {
    const repo = await TempRepo.create(SAMPLE_APP)
    await repo.git('branch', 'base')
    // Break the code the suite exercises; contract authorizes it (scope-clean).
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
      contract: `version: 1\nid: logic\ngoal: change logic\npaths:\n  mustChange: ["src/tasks.js"]\n`,
    })

    expect(report.baseline?.perTest).toBe(false)
    expect(report.threeQuestions.regressions).toEqual({ status: 'fail', baselineTests: 1, regressionsFound: 1 })
    expect(report.findings.map((finding) => finding.findingClass)).toContain('test-regression')
    await repo.destroy()
  })

  it('reports partial when the baseline suite itself fails (attribution impossible)', async () => {
    const files = { ...SAMPLE_APP, 'tests/run.js': `console.log('always failing')\nprocess.exit(1)\n` }
    const repo = await TempRepo.create(files)
    await repo.git('branch', 'base')
    await repo.write({ 'README.md': '# changed\n' })
    await repo.commit('docs')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: docs\ngoal: update docs\npaths:\n  mustChange: ["README.md"]\n`,
    })

    expect(report.threeQuestions.regressions.status).toBe('partial')
    const classes = report.findings.map((finding) => finding.findingClass)
    expect(classes).toContain('baseline-incomplete')
    expect(classes).not.toContain('test-regression')
    // H1: partial verification no longer ACCEPTs by default (frozen spec).
    expect(report.verdict).toBe('REVIEW')
    await repo.destroy()
  })

  it('stays not-verified when the repository declares no test command', async () => {
    const files = { ...SAMPLE_APP }
    files['package.json'] = JSON.stringify({ name: 'no-tests', version: '1.0.0', type: 'module' }, null, 2)
    const repo = await TempRepo.create(files)
    await repo.git('branch', 'base')
    await repo.write({ 'README.md': '# changed\n' })
    await repo.commit('docs')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: docs\ngoal: docs\npaths:\n  mustChange: ["README.md"]\n`,
    })

    expect(report.threeQuestions.regressions).toEqual({ status: 'not-verified' })
    expect(report.baseline).toBeUndefined()
    await repo.destroy()
  })

  it('times out hanging suites, kills the process tree, and reports partial', async () => {
    const files = {
      ...fakeVitestApp(PASSING_SPECS),
      'package.json': JSON.stringify(
        { name: 'hanging-app', version: '1.0.0', type: 'module', scripts: { test: 'node tools/hang.js' } },
        null,
        2,
      ),
      'tools/hang.js': 'setInterval(() => {}, 1000)\nconsole.log("hanging forever")\n',
    }
    const repo = await TempRepo.create(files)
    await repo.git('branch', 'base')

    const startedAt = Date.now()
    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: SPEC_CONTRACT,
      testTimeoutMs: 4_000,
    })
    const elapsed = Date.now() - startedAt

    expect(elapsed).toBeLessThan(60_000)
    expect(report.baseline?.before.timedOut).toBe(true)
    expect(report.baseline?.after.timedOut).toBe(true)
    expect(report.threeQuestions.regressions.status).toBe('partial')
    expect(report.findings.map((finding) => finding.findingClass)).toContain('baseline-incomplete')
    await repo.destroy()
  })

  it('reports partial when the test command itself cannot run', async () => {
    const files = {
      ...fakeVitestApp(PASSING_SPECS),
      'package.json': JSON.stringify(
        { name: 'broken-cmd', version: '1.0.0', type: 'module', scripts: { test: 'node tools/does-not-exist.js' } },
        null,
        2,
      ),
    }
    const repo = await TempRepo.create(files)
    await repo.git('branch', 'base')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'HEAD', contract: SPEC_CONTRACT })

    expect(report.threeQuestions.regressions.status).toBe('partial')
    expect(report.findings.map((finding) => finding.findingClass)).not.toContain('test-regression')
    await repo.destroy()
  })
})

describe('working-tree verification (uncommitted changes)', () => {
  it('does not falsely report dependencies removed when package.json declares deps (found in hands-on verification)', async () => {
    // Regression: enrichChangeSet read the after package.json via the
    // nonexistent git ref 'working-tree', which parsed as an empty manifest
    // and reported every declared dependency as removed. The after package
    // is the materialized file on disk — the state the fingerprint names.
    const repo = await TempRepo.create({
      ...SAMPLE_APP,
      'package.json': JSON.stringify(
        {
          name: 'dep-wt-app',
          version: '1.0.0',
          type: 'module',
          scripts: { test: 'node tests/run.js' },
          devDependencies: { vite: '^8.0.0', vitest: '^5.0.0' },
        },
        null,
        2,
      ),
    })
    await repo.git('branch', 'base')

    // Uncommitted styling edit; package.json untouched.
    await repo.write({ 'src/style.css': 'body { margin: 1rem; }\n' })

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      mode: 'working-tree',
      contract: 'version: 1\nid: wt-deps\ngoal: polish styles\npaths:\n  mustChange: ["src/style.css"]\n',
      runTests: false,
      reproduction: false,
    })

    const classes = report.findings.map((finding) => finding.findingClass)
    expect(classes).not.toContain('removed-dependency')
    expect(classes).not.toContain('new-dependency')
    expect(classes).not.toContain('changed-dependency')
    expect(report.verdict).toBe('ACCEPT')

    // And findings that DO exist render runnable reproduction commands —
    // never naming the 'working-tree' pseudo-ref.
    await repo.write({ 'docs.txt': 'stray file\n' })
    const withStray = await verifyChange({
      repo: repo.dir,
      before: 'base',
      mode: 'working-tree',
      contract: 'version: 1\nid: wt-deps\ngoal: polish styles\npaths:\n  mustChange: ["src/style.css"]\n',
      runTests: false,
      reproduction: false,
    })
    const stray = withStray.findings.find((finding) => finding.findingClass === 'out-of-scope-change')
    expect(stray?.evidence.reproduction).toBe('git -C <repo> diff base -- docs.txt')
    await repo.destroy()
  })

  it('verifies dirty changes without committing and without mutating the checkout', async () => {
    const repo = await TempRepo.create(fakeVitestApp(PASSING_SPECS))
    await repo.markExecutable('node_modules/.bin/vitest')
    await repo.git('branch', 'base')
    const headBefore = (await repo.git('rev-parse', 'HEAD')).trim()

    // Dirty change: flip one test to failing, no commit.
    const broken: FakeTestSpec[] = [
      PASSING_SPECS[0]!,
      { fullName: 'tasks > rejects blank', title: 'rejects blank', status: 'failed', failureMessage: 'regressed in working tree' },
    ]
    await repo.write({ 'tests/spec.json': JSON.stringify({ tests: broken }, null, 2) })

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      mode: 'working-tree',
      contract: SPEC_CONTRACT,
    })

    expect(report.after).toBe('working-tree')
    expect(report.threeQuestions.regressions).toEqual({ status: 'fail', baselineTests: 2, regressionsFound: 1 })
    expect(report.verdict).toBe('REJECT')

    // M2.1 identity: HEAD's SHA must not masquerade as the tested state.
    expect(report.afterSha).toBeNull()
    expect(report.workingTree?.baseSha).toBe(headBefore)
    expect(report.workingTree?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(report.markdown).toContain('working-tree (base ')
    expect(report.markdown).toContain('sha256:')

    // The checkout was not mutated or committed.
    const headAfter = (await repo.git('rev-parse', 'HEAD')).trim()
    expect(headAfter).toBe(headBefore)
    const status = await repo.git('status', '--porcelain')
    expect(status).toContain('tests/spec.json')
    const worktrees = (await repo.git('worktree', 'list', '--porcelain')).trim().split('\n\n').length
    expect(worktrees).toBe(1)
    await repo.destroy()
  })
})

describe('M2.1: working-tree state identity', () => {
  it('fingerprint tracks dirty content while HEAD stays identical, and is stable', async () => {
    const repo = await TempRepo.create(fakeVitestApp(PASSING_SPECS))
    await repo.markExecutable('node_modules/.bin/vitest')
    await repo.git('branch', 'base')
    const git = await GitAdapter.open(repo.dir)

    const clean = await git.diffWorkingTree('base')
    await repo.write({ 'README.md': '# dirty state A\n' })
    const dirtyA = await git.diffWorkingTree('base')
    const dirtyARepeat = await git.diffWorkingTree('base')
    await repo.write({ 'README.md': '# dirty state B\n' })
    const dirtyB = await git.diffWorkingTree('base')

    expect(clean.workingTree?.fingerprint).toBeDefined()
    expect(dirtyA.workingTree?.fingerprint).not.toBe(clean.workingTree?.fingerprint)
    // Same dirty state read twice -> identical fingerprint (determinism).
    expect(dirtyARepeat.workingTree?.fingerprint).toBe(dirtyA.workingTree?.fingerprint)
    // Same HEAD, different dirty content -> different identity.
    expect(dirtyB.workingTree?.fingerprint).not.toBe(dirtyA.workingTree?.fingerprint)
    expect(dirtyA.afterSha).toBeNull()
    await repo.destroy()
  })

  it('represents staged, unstaged, and untracked changes in one identity', async () => {
    const repo = await TempRepo.create(fakeVitestApp(PASSING_SPECS))
    await repo.markExecutable('node_modules/.bin/vitest')
    await repo.git('branch', 'base')
    const head = (await repo.git('rev-parse', 'HEAD')).trim()

    await repo.write({ 'src/index.js': 'export function addTask() {\n  return [1]\n}\n' }) // unstaged
    await repo.write({ 'README.md': '# staged edit\n' })
    await repo.git('add', 'README.md') // staged
    await repo.write({ 'notes-untracked.txt': 'untracked\n' }) // untracked

    const git = await GitAdapter.open(repo.dir)
    const changeSet = await git.diffWorkingTree('base')
    const paths = changeSet.records.map((record) => record.path).sort()
    expect(paths).toEqual(['README.md', 'notes-untracked.txt', 'src/index.js'])

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      mode: 'working-tree',
      contract: `version: 1\nid: anything\ngoal: change anything\npaths:\n  mayChange: ["**"]\n`,
    })
    expect(report.afterSha).toBeNull()
    expect(report.workingTree?.baseSha).toBe(head)
    await repo.destroy()
  })
})

describe('M2.1: deterministic dependency restoration', () => {
  it('selects npm ci when a lockfile exists and records the strategy (failure stays partial)', async () => {
    // Declared dependency + lockfile => npm ci is the chosen strategy. The
    // dependency deliberately cannot resolve, so this proves both the ci
    // selection AND the conservative failure path, deterministically offline.
    const bogus = 'regression-guard-definitely-not-a-real-package'
    const files = {
      ...fakeVitestApp(PASSING_SPECS),
      'package.json': JSON.stringify(
        {
          name: 'ci-app',
          version: '1.0.0',
          type: 'module',
          scripts: { test: 'vitest run' },
          dependencies: { [bogus]: '1.0.0' },
        },
        null,
        2,
      ),
      'package-lock.json': JSON.stringify(
        {
          name: 'ci-app',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'ci-app', version: '1.0.0', dependencies: { [bogus]: '1.0.0' } },
            [`node_modules/${bogus}`]: {
              version: '1.0.0',
              resolved: `https://registry.npmjs.org/${bogus}/-/1.0.0.tgz`,
              integrity: 'sha512-0000000000000000000000000000000000000000000000000000000000000000',
            },
          },
        },
        null,
        2,
      ),
    }
    const repo = await TempRepo.create(files)
    await repo.markExecutable('node_modules/.bin/vitest')
    await repo.git('branch', 'base')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'HEAD', contract: SPEC_CONTRACT })

    expect(report.baseline?.before.dependencyInstall?.strategy).toBe('npm-ci')
    expect(report.baseline?.before.dependencyInstall?.command).toContain('npm ci')
    // Install failure: honest partial, never pass, never a silent regression.
    expect(report.threeQuestions.regressions.status).toBe('partial')
    expect(report.findings.map((finding) => finding.findingClass)).not.toContain('test-regression')
    const incomplete = report.findings.find((finding) => finding.findingClass === 'baseline-incomplete')
    expect(incomplete?.message).toContain('npm-ci')
    await repo.destroy()
  })
})

describe('M2.1: test-plan comparability', () => {
  it('a changed test command cannot silently yield PASS: partial + finding, verdict unpoisoned', async () => {
    const repo = await TempRepo.create(SAMPLE_APP)
    await repo.git('branch', 'base')

    // The change redefines how tests run (both commands are runnable).
    await repo.write({
      'tests/other.js': `console.log('other suite ok')\n`,
      'package.json': JSON.stringify(
        { name: 'sample-app', version: '1.0.0', type: 'module', scripts: { test: 'node tests/other.js' } },
        null,
        2,
      ),
    })
    await repo.commit('redefine the test command')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: tooling\ngoal: change test tooling\npaths:\n  mustChange: ["package.json"]\n  mayChange: ["tests/**"]\n`,
    })

    expect(report.threeQuestions.regressions.status).toBe('partial')
    const classes = report.findings.map((finding) => finding.findingClass)
    expect(classes).toContain('test-command-changed')
    expect(classes).toContain('baseline-incomplete')
    expect(classes).not.toContain('out-of-scope-change')
    const changed = report.findings.find((finding) => finding.findingClass === 'test-command-changed')
    expect(changed?.message).toContain('node tests/run.js')
    expect(changed?.message).toContain('node tests/other.js')
    expect(changed?.severity).toBe('info')
    // Scope-clean change: the info finding alone must not poison the gate.
    // H1: partial verification no longer ACCEPTs by default (frozen spec).
    expect(report.verdict).toBe('REVIEW')
    await repo.destroy()
  })

  it('a baseline without any test command on one side is also non-comparable', async () => {
    const repo = await TempRepo.create({
      ...SAMPLE_APP,
      'package.json': JSON.stringify({ name: 'no-test-script', version: '1.0.0', type: 'module' }, null, 2),
      'tests/run.js': SAMPLE_APP['tests/run.js'] ?? '',
    })
    await repo.git('branch', 'base')
    // The change INTRODUCES a test command where none existed.
    await repo.write({
      'package.json': JSON.stringify(
        { name: 'no-test-script', version: '1.0.0', type: 'module', scripts: { test: 'node tests/run.js' } },
        null,
        2,
      ),
    })
    await repo.commit('add tests')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: tooling\ngoal: add tests\npaths:\n  mustChange: ["package.json"]\n`,
    })

    expect(report.threeQuestions.regressions.status).toBe('partial')
    expect(report.findings.map((finding) => finding.findingClass)).toContain('test-command-changed')
    await repo.destroy()
  })

  it('unchanged test commands keep exact PASS->FAIL regression behavior', async () => {
    // Covered end-to-end by the earlier per-test regression tests; this locks
    // the comparable path's evidence phrasing to the single-command form.
    const repo = await TempRepo.create(fakeVitestApp(PASSING_SPECS))
    await repo.markExecutable('node_modules/.bin/vitest')
    await repo.git('branch', 'base')
    await repo.write({
      'tests/spec.json': JSON.stringify(
        {
          tests: [
            PASSING_SPECS[0]!,
            { fullName: 'tasks > rejects blank', title: 'rejects blank', status: 'failed', failureMessage: 'boom' },
          ],
        },
        null,
        2,
      ),
    })
    await repo.commit('break one test')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'HEAD', contract: SPEC_CONTRACT })

    expect(report.threeQuestions.regressions).toEqual({ status: 'fail', baselineTests: 2, regressionsFound: 1 })
    const regression = report.findings.find((finding) => finding.findingClass === 'test-regression')
    expect(regression?.evidence.observation).toContain('ran "npm test"')
    expect(report.findings.map((finding) => finding.findingClass)).not.toContain('test-command-changed')
    await repo.destroy()
  })
})
