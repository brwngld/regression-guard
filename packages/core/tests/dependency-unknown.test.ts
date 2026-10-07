import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyChange } from '../src/pipeline'
import { TempRepo } from './helpers/repo'

/**
 * Adversarial attacks 5 and 6 (analyzer hardening): the change state makes the
 * package manifest UNREADABLE — malformed JSON (5) or deleted outright (6).
 * The analyzer must not collapse "could not read the evidence" into "the
 * evidence says removed": no dependency diff findings may be claimed, and
 * exactly one informational dependency-state-unknown finding states the limit.
 *
 * Runs are hermetic: the fixture declares devDependencies but installs
 * nothing, and tests/reproduction are skipped — the dependency analysis runs
 * regardless of both.
 */

const CONTRACT = `
id: style-polish
goal: Polish the app's visual styling
paths:
  mustChange:
    - "src/style.css"
`

/** Base state: a valid manifest declaring vite + vitest, plus a style edit target. */
const BASE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'dep-attack-app',
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'node tests/run.js' },
      devDependencies: { vite: '^5.0.0', vitest: '^1.2.3' },
    },
    null,
    2,
  ),
  'src/style.css': 'body { margin: 0; }\n',
  'tests/run.js': "console.log('suite ok')\n",
}

/** Truncated on purpose: this is not parseable JSON. */
const MALFORMED_PACKAGE_JSON = '{"name":"x","devDependencies":'

const DEPENDENCY_DIFF_CLASSES = ['new-dependency', 'removed-dependency', 'changed-dependency'] as const

function assertNoFalseDependencyClaims(classes: string[]): void {
  for (const dependencyClass of DEPENDENCY_DIFF_CLASSES) {
    expect(classes, `must not claim ${dependencyClass} from unreadable evidence`).not.toContain(
      dependencyClass,
    )
  }
}

async function prepareRepo(change: (repo: TempRepo) => Promise<void>): Promise<TempRepo> {
  const repo = await TempRepo.create(BASE_FILES)
  await repo.git('branch', 'base')
  await repo.write({ 'src/style.css': 'body { margin: 0; padding: 1rem; }\n' })
  await change(repo)
  await repo.commit('apply attack change')
  return repo
}

describe('ATTACK 5: malformed package.json must not diff as mass dependency removal', () => {
  let repo: TempRepo

  beforeAll(async () => {
    repo = await prepareRepo(async (theRepo) => {
      await theRepo.write({ 'package.json': MALFORMED_PACKAGE_JSON })
    })
  })

  afterAll(async () => {
    await repo.destroy()
  })

  it('reports dependency state unknown instead of removed-dependency findings', async () => {
    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: CONTRACT,
      runTests: false,
      reproduction: false,
    })

    const classes = report.findings.map((finding) => finding.findingClass)
    assertNoFalseDependencyClaims(classes)

    const unknown = report.findings.filter(
      (finding) => finding.findingClass === 'dependency-state-unknown',
    )
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.id).toBe('DEPU-001')
    expect(unknown[0]?.severity).toBe('info')
    expect(unknown[0]?.message).toBe(
      'Dependency state unknown: the after package manifest is malformed; no dependency comparison is claimed.',
    )
    expect(unknown[0]?.evidence.claim).toContain('UNKNOWN, not unchanged')
    // Accepted, never independently gate-worsening — but visible.
    expect(report.triggeredActions).toContain('accept')
    // The declared vite/vitest must not be named as removed anywhere.
    expect(report.findings.map((finding) => finding.message).join('\n')).not.toContain('vite')
  })

  it('still classifies the manifest change out of scope and refuses a clean pass', async () => {
    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: CONTRACT,
      runTests: false,
      reproduction: false,
    })

    const pkg = report.perPath.find((item) => item.path === 'package.json')
    expect(pkg?.classification).toBe('OUT_OF_SCOPE')
    expect(report.threeQuestions.withinScope).toBe('no')
    expect(report.verdict).toBe('REVIEW')
    expect(report.threeQuestions.regressions.status).not.toBe('pass')
  })
})

describe('ATTACK 6: deleted package.json must not diff as mass dependency removal', () => {
  let repo: TempRepo

  beforeAll(async () => {
    repo = await prepareRepo(async (theRepo) => {
      await theRepo.remove(['package.json'])
    })
  })

  afterAll(async () => {
    await repo.destroy()
  })

  it('reports dependency state unknown instead of removed-dependency findings', async () => {
    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: CONTRACT,
      runTests: false,
      reproduction: false,
    })

    const classes = report.findings.map((finding) => finding.findingClass)
    assertNoFalseDependencyClaims(classes)

    const unknown = report.findings.filter(
      (finding) => finding.findingClass === 'dependency-state-unknown',
    )
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.id).toBe('DEPU-001')
    expect(unknown[0]?.severity).toBe('info')
    expect(unknown[0]?.message).toBe(
      'Dependency state unknown: the after package manifest is missing; no dependency comparison is claimed.',
    )
    expect(unknown[0]?.evidence.reproduction).toBe('git -C <repo> show HEAD:package.json')
    expect(report.triggeredActions).toContain('accept')
    expect(report.findings.map((finding) => finding.message).join('\n')).not.toContain('vitest')
  })

  it('still classifies the manifest deletion out of scope and refuses a clean pass', async () => {
    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: CONTRACT,
      runTests: false,
      reproduction: false,
    })

    const pkg = report.perPath.find((item) => item.path === 'package.json')
    expect(pkg?.classification).toBe('OUT_OF_SCOPE')
    expect(pkg?.status).toBe('deleted')
    expect(report.threeQuestions.withinScope).toBe('no')
    expect(report.verdict).toBe('REVIEW')
    expect(report.threeQuestions.regressions.status).not.toBe('pass')
  })
})
