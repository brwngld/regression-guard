import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifyChange } from '../src/pipeline'
import { buildExperiments, runExperiments, type ExperimentContext } from '../src/reproduction/engine'
import { GitAdapter } from '../src/vcs/git'
import { TempRepo } from './helpers/repo'

/**
 * M4/M4.1 integration: reproduction, stability accounting, state identity,
 * evidence packages, and repair proposals — over real temporary repositories.
 * The load-bearing invariants under test:
 *   - no reproduction outcome ever deletes, downgrades, or re-gates M2's
 *     findings (the verdict stays attributable to the actual regression);
 *   - reproduction never mutates the user checkout;
 *   - every attempt gets FRESH materialization: attempt N cannot observe
 *     filesystem mutations from attempt N-1 (external conditions may vary,
 *     repository state may not);
 *   - execution uses immutable identities (SHAs/fingerprints); labels are
 *     presentation only and can move without affecting reproduction;
 *   - state-identity mismatch aborts per attempt rather than improvising;
 *   - restoration is an operation constraint, never disguised permission.
 */

const PERMISSIVE = (mustChange: string) =>
  `version: 1\nid: m4-test\ngoal: test change\npaths:\n  mustChange: ["${mustChange}"]\n`

describe('M4: reproduction stability accounting', () => {
  it('the nasty mixed sequence FAIL/PASS/FAIL/TIMEOUT/FAIL keeps the finding, the verdict, and reports honest counts', async () => {
    // The variance source is EXTERNAL to the reproduced repository state: a
    // counter file outside every worktree drives a fixed global sequence.
    // Invocation order: M2-before=1, M2-after=2, reproduction=3..7.
    // Desired: 1 pass (green baseline), 2 fail (regression), then
    // fail, pass, fail, HANG (killed by the engine timeout), fail —
    // identical repository state every attempt, varying external condition.
    // That is the only thing 'unstable'-style results legitimately mean.
    const seqDir = await mkdtemp(join(tmpdir(), 'rg-seq-'))
    const FLAKY_RUNNER = `import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'

const strict = existsSync('strict-mode')
const counter = '${seqDir.replace(/\\/g, '/')}/count'
let count = 0
try {
  count = Number(await readFile(counter, 'utf8')) || 0
} catch {}
await writeFile(counter, String(count + 1))
const index = count + 1

if (index === 1 || index === 4) {
  console.log('flaky: passing invocation', index)
  process.exit(0)
}
if (index === 6) {
  console.log('flaky: hanging invocation')
  // Stay alive until the engine's timeout kills the process tree.
  setInterval(() => {}, 60000)
} else if (strict) {
  console.log('flaky: failing invocation', index)
  process.exit(1)
} else {
  console.log('flaky: ok (lenient state)', index)
  process.exit(0)
}
`
    const repo = await TempRepo.create({
      'package.json': JSON.stringify(
        { name: 'flaky-app', version: '1.0.0', type: 'module', scripts: { test: 'node tools/flaky.js' } },
        null,
        2,
      ),
      'tools/flaky.js': FLAKY_RUNNER,
      'README.md': '# flaky app\n',
    })
    await repo.git('branch', 'base')
    await repo.write({ 'strict-mode': 'on\n' })
    await repo.commit('introduce strict behavior')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: m4-flaky\ngoal: strict mode\npaths:\n  mustChange: ["strict-mode"]\nreproduction:\n  attempts: 5\n  timeoutMs: 4000\n`,
    })

    // M2's regression stands, attributable and unchanged.
    expect(report.threeQuestions.regressions).toMatchObject({ status: 'fail', regressionsFound: 1 })
    expect(report.verdict).toBe('REJECT')

    const finding = report.findings.find((f) => f.findingClass === 'test-regression')
    expect(finding).toBeDefined()
    const reproduction = finding?.reproduction
    expect(reproduction).toMatchObject({
      attemptsRequested: 5,
      attemptsCompleted: 4,
      reproduced: 3,
      notReproduced: 1,
      inconclusive: 1,
      stability: 'inconclusive',
      stateMatched: true,
    })
    expect(reproduction?.attempts.map((attempt) => attempt.outcome)).toEqual([
      'reproduced',
      'not-reproduced',
      'reproduced',
      'inconclusive',
      'reproduced',
    ])
    expect(reproduction?.attempts[3]?.timedOut).toBe(true)
    expect(report.markdown).toContain('3/5 attempts reproduced')
    expect(report.markdown).toContain('INCONCLUSIVE')

    // The checkout was never touched by any reproduction attempt.
    const status = await repo.git('status', '--porcelain')
    expect(status.trim()).toBe('')
    const worktrees = (await repo.git('worktree', 'list', '--porcelain')).trim().split('\n\n').length
    expect(worktrees).toBe(1)
    await repo.destroy()
    await rm(seqDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  })

  it('M4.1: every attempt gets fresh materialization — attempt N cannot observe attempt N-1 mutations', async () => {
    // The runner plants a marker file on its first invocation in a given
    // worktree and PASSES whenever the marker already exists. With per-attempt
    // fresh materialization every attempt starts clean: all 5 attempts plant
    // the marker and fail. Under the old shared-worktree behavior attempts
    // 2..5 would see the marker and pass — so 5/5-reproduced is a real lock.
    const MARKER_RUNNER = `import { existsSync, writeFileSync } from 'node:fs'

const strict = existsSync('strict-mode')
if (existsSync('was-here')) {
  console.log('marker: CONTAMINATED start (marker survived)')
  process.exit(0)
}
writeFileSync('was-here', 'attempt was here')
if (strict) {
  console.log('marker: clean start, failing (strict state)')
  process.exit(1)
}
console.log('marker: clean start, ok (lenient state)')
process.exit(0)
`
    const repo = await TempRepo.create({
      'package.json': JSON.stringify(
        { name: 'marker-app', version: '1.0.0', type: 'module', scripts: { test: 'node tools/marker.js' } },
        null,
        2,
      ),
      'tools/marker.js': MARKER_RUNNER,
      'README.md': '# marker\n',
    })
    await repo.git('branch', 'base')
    await repo.write({ 'strict-mode': 'on\n' })
    await repo.commit('introduce strict behavior')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: m4-marker\ngoal: strict mode\npaths:\n  mustChange: ["strict-mode"]\nreproduction:\n  attempts: 5\n  timeoutMs: 10000\n`,
    })

    // Baseline: lenient state passes; after state fails -> regression.
    expect(report.threeQuestions.regressions).toMatchObject({ status: 'fail', regressionsFound: 1 })
    const reproduction = report.findings.find((f) => f.findingClass === 'test-regression')?.reproduction
    expect(reproduction).toMatchObject({
      attemptsRequested: 5,
      attemptsCompleted: 5,
      reproduced: 5,
      notReproduced: 0,
      inconclusive: 0,
      stability: 'stable',
      stateMatched: true,
    })
    // Per-attempt attribution: every attempt records its experiment and the
    // immutable state it executed against.
    for (const attempt of reproduction?.attempts ?? []) {
      expect(attempt.experimentId).toMatch(/^REPRO-/)
      expect(attempt.stateIdentity).toMatchObject({ kind: 'ref', sha: report.afterSha })
    }
    await repo.destroy()
  })

  it('reproduces a deterministic regression 5/5 as stable without changing anything', async () => {
    const repo = await TempRepo.create({
      'package.json': JSON.stringify(
        { name: 'stable-app', version: '1.0.0', type: 'module', scripts: { test: 'node tools/suite.js' } },
        null,
        2,
      ),
      'tools/suite.js': `import { behavior } from '../src/lib.js'

if (!behavior()) {
  console.error('broken behavior')
  process.exit(1)
}
console.log('ok')
`,
      'src/lib.js': 'export const behavior = () => true\n',
      'README.md': '# stable\n',
    })
    await repo.git('branch', 'base')
    await repo.write({
      'src/lib.js': 'export const behavior = () => false\n',
      'README.md': '# stable\n\nchanged\n',
    })
    await repo.commit('break behavior deterministically')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: m4-stable\ngoal: break and repair\npaths:\n  mustChange: ["src/lib.js"]\nreproduction:\n  attempts: 5\n  timeoutMs: 15000\n`,
    })

    const reproduction = report.findings.find((f) => f.findingClass === 'test-regression')?.reproduction
    expect(reproduction).toMatchObject({
      attemptsRequested: 5,
      attemptsCompleted: 5,
      reproduced: 5,
      notReproduced: 0,
      inconclusive: 0,
      stability: 'stable',
    })
    expect(report.verdict).toBe('REJECT')
    await repo.destroy()
  })
})

describe('M4: state identity', () => {
  it('aborts (inconclusive, no execution) when the working-tree fingerprint drifted', async () => {
    const repo = await TempRepo.create({
      'package.json': JSON.stringify(
        { name: 'wt-app', version: '1.0.0', type: 'module', scripts: { test: 'node tools/suite.js' } },
        null,
        2,
      ),
      'tools/suite.js': "console.log('ok')\n",
      'README.md': '# wt\n',
    })
    await repo.git('branch', 'base')
    const git = await GitAdapter.open(repo.dir)

    // Record the identity of the ORIGINAL dirty state.
    await repo.write({ 'README.md': '# wt\n\ndirty state one\n' })
    const recorded = await git.diffWorkingTree('base')
    const fingerprint = recorded.workingTree?.fingerprint
    expect(fingerprint).toBeDefined()

    // ...then the developer keeps editing before reproduction happens.
    await repo.write({ 'README.md': '# wt\n\ndirty state TWO\n' })

    const afterState = {
      label: 'working-tree',
      kind: 'working-tree' as const,
      sha: null,
      baseSha: recorded.workingTree?.baseSha,
      fingerprint,
    }
    const context: ExperimentContext = {
      git,
      before: { label: 'base', kind: 'ref' as const, sha: recorded.beforeSha },
      after: afterState,
      testPlan: {
        runner: 'generic' as const,
        userCommand: 'npm test',
        buildExecutedCommand: () => 'node tools/suite.js',
        testCommandInstalled: false,
      },
      config: { attempts: 3, timeoutMs: 10_000 },
    }
    const experiments = buildExperiments(
      [
        {
          id: 'TEST-001',
          findingClass: 'test-regression',
          severity: 'critical',
          message: 'suite regressed',
          paths: [],
          evidence: { kind: 'test', claim: 'c', observation: 'o', changedLines: [], reproduction: 'npm test' },
        },
      ],
      context,
    )
    expect(experiments).toHaveLength(1)
    const assessments = await runExperiments(experiments, context)

    // M4.1: every attempt is individually recorded as inconclusive with full
    // attribution — the drift is detected PER ATTEMPT, never improvised past.
    expect(assessments[0]).toMatchObject({
      stateMatched: false,
      stability: 'inconclusive',
      attemptsRequested: 3,
      attemptsCompleted: 0,
      reproduced: 0,
      notReproduced: 0,
      inconclusive: 3,
    })
    expect(assessments[0]?.attempts).toHaveLength(3)
    for (const attempt of assessments[0]?.attempts ?? []) {
      expect(attempt.outcome).toBe('inconclusive')
      expect(attempt.detail).toContain('fingerprint')
      expect(attempt.stateIdentity.fingerprint).toBe(fingerprint)
    }
    await repo.destroy()
  })

  it('M4.1: moving a branch after verification cannot change what reproduction executes (labels are presentation, SHAs are execution)', async () => {
    const repo = await TempRepo.create({
      'package.json': JSON.stringify(
        { name: 'refmove-app', version: '1.0.0', type: 'module', scripts: { test: 'node tools/suite.js' } },
        null,
        2,
      ),
      'tools/suite.js': "console.log('ok')\n",
      'src/auth.ts': 'export const auth = 1\n',
      'README.md': '# refmove\n',
    })
    await repo.git('branch', 'base')

    // The violating state B: feature branch changes src/auth.ts.
    await repo.git('checkout', '-q', '-b', 'feat')
    await repo.write({ 'src/auth.ts': 'export const auth = 2\n' })
    await repo.commit('quietly change auth')
    const featSha = (await repo.git('rev-parse', 'HEAD')).trim()
    const baseSha = (await repo.git('rev-parse', 'base')).trim()

    // AFTER verification is recorded, the branch KEEPS MOVING — and the new
    // commit reverts the very change the finding is about. Label-based
    // execution would diff base..feat-at-HEAD and see nothing; SHA-based
    // execution must still see the recorded A->B change.
    await repo.write({ 'src/auth.ts': 'export const auth = 1\n' })
    await repo.commit('revert auth change on feat (moves the label)')

    const git = await GitAdapter.open(repo.dir)
    const context: ExperimentContext = {
      git,
      before: { label: 'base', kind: 'ref' as const, sha: baseSha },
      after: { label: 'feat', kind: 'ref' as const, sha: featSha },
      testPlan: null,
      config: { attempts: 5, timeoutMs: 10_000 },
    }
    const experiments = buildExperiments(
      [
        {
          id: 'SCOPE-001',
          findingClass: 'prohibited-change',
          severity: 'critical',
          message: 'src/auth.ts changed but the contract prohibits it.',
          paths: ['src/auth.ts'],
          evidence: { kind: 'diff', claim: 'c', observation: 'o', changedLines: [], reproduction: 'git diff' },
        },
      ],
      context,
    )
    expect(experiments).toHaveLength(1)
    // The structured command carries the immutable SHAs, never the labels.
    expect(experiments[0]?.command.args).toContain(baseSha)
    expect(experiments[0]?.command.args).toContain(featSha)
    expect(experiments[0]?.command.args).not.toContain('feat')

    const assessments = await runExperiments(experiments, context)
    expect(assessments[0]).toMatchObject({
      stateMatched: true,
      stability: 'stable',
      reproduced: 1,
    })
    await repo.destroy()
  })

  it('derives an identical context id for identical comparisons and unique run ids per execution', async () => {
    const repo = await TempRepo.create({
      'package.json': JSON.stringify(
        { name: 'lineage-app', version: '1.0.0', type: 'module', scripts: { test: 'node tools/suite.js' } },
        null,
        2,
      ),
      'tools/suite.js': "console.log('ok')\n",
      'README.md': '# lineage\n',
    })
    await repo.git('branch', 'base')
    await repo.write({ 'README.md': '# lineage\n\nchanged\n' })
    await repo.commit('change')

    const contract = PERMISSIVE('README.md')
    const first = await verifyChange({ repo: repo.dir, before: 'base', after: 'HEAD', contract })
    const second = await verifyChange({ repo: repo.dir, before: 'base', after: 'HEAD', contract })

    // Same logical verification situation: deterministic content identity.
    expect(first.verificationContextId).toBe(second.verificationContextId)
    expect(first.verificationContextId).toMatch(/^ctx_[0-9a-f]{64}$/)
    // Different executions: unique run identity sharing the context prefix.
    expect(first.verificationRunId).not.toBe(second.verificationRunId)
    expect(second.verificationRunId.startsWith('run_')).toBe(true)
    await repo.destroy()
  })
})

describe('M4: evidence package and repair proposal', () => {
  it('proposes restore-to-baseline (never editable) for prohibited changed paths, E2E', async () => {
    const repo = await TempRepo.create({
      'package.json': JSON.stringify(
        { name: 'repair-app', version: '1.0.0', type: 'module', scripts: { test: 'node tools/suite.js' } },
        null,
        2,
      ),
      'tools/suite.js': "console.log('ok')\n",
      'src/home.ts': 'export const home = 1\n',
      'src/auth.ts': 'export const auth = 1\n',
      'README.md': '# repair\n',
    })
    await repo.git('branch', 'base')
    await repo.write({
      'src/home.ts': 'export const home = 2\n',
      'src/auth.ts': 'export const auth = 2\n', // prohibited by contract
    })
    await repo.commit('redesign home, quietly touch auth')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: redesign\ngoal: redesign home\npaths:\n  mustChange: ["src/home.ts"]\n  prohibited: ["src/auth.ts"]\n`,
    })

    expect(report.verdict).toBe('REJECT')
    const proposal = report.evidencePackage?.repairProposal
    expect(proposal?.status).toBe('proposed')
    expect(proposal?.proposedBy).toBe('deterministic-evidence')
    expect(proposal?.stateIdentities.originalBaseline.sha).toBe(report.beforeSha)
    expect(proposal?.stateIdentities.violatingState.sha).toBe(report.afterSha)
    expect(proposal?.evidenceRequired.join(' ')).toContain('B -> C')
    expect(proposal?.evidenceRequired.join(' ')).toContain('A -> C')

    const constraints = new Map(proposal?.pathConstraints.map((constraint) => [constraint.path, constraint.mode]))
    // The safety property: a prohibited, changed path is authorized to
    // RESTORE — not to redesign.
    expect(constraints.get('src/auth.ts')).toBe('restore-to-baseline')
    expect(constraints.get('src/home.ts')).toBe('editable')

    // Scope findings got diff experiments; the package carries reproductions.
    expect(report.evidencePackage?.reproductions.length).toBeGreaterThanOrEqual(1)
    const preservedFinding = report.findings.find((f) => f.findingClass === 'prohibited-change')
    expect(preservedFinding?.reproduction?.granularity).toBe('n/a')
    expect(preservedFinding?.reproduction?.stability).toBe('stable')
    expect(report.markdown).toContain('Evidence package & repair proposal')
    expect(report.markdown).toContain('RESTORE-TO-BASELINE')
    expect(report.markdown).toContain('PROPOSAL ONLY')
    await repo.destroy()
  })

  it('reproduction: false disables enrichment while keeping the package machinery', async () => {
    const repo = await TempRepo.create({
      'package.json': JSON.stringify(
        { name: 'norepro-app', version: '1.0.0', type: 'module', scripts: { test: 'node tools/suite.js' } },
        null,
        2,
      ),
      'tools/suite.js': "console.log('ok')\n",
      'README.md': '# norepro\n',
    })
    await repo.git('branch', 'base')
    await repo.write({ 'docs.txt': 'unauthorized\n' })
    await repo.commit('out of scope change')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: PERMISSIVE('README.md'),
      reproduction: false,
    })

    expect(report.findings.every((finding) => finding.reproduction === undefined)).toBe(true)
    expect(report.evidencePackage?.reproductions).toEqual([])
    expect(report.evidencePackage?.repairProposal.status).toBe('proposed')
    await repo.destroy()
  })
})
