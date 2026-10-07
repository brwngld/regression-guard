import { describe, expect, it } from 'vitest'
import { verifyChange } from '../src/pipeline'
import { TempRepo, fakeVitestApp, PASSING_SPECS } from './helpers/repo'

/**
 * H5 boundary tripwire: attack 2b as a PERMANENT suite fixture.
 *
 * Before: two passing tests. Change: break the real behavior (src/index.js)
 * AND gut the catching test's assertion while KEEPING its id/title identical —
 * same test ids, same count, same command, all green after. The contract
 * authorizes the test edit (mayChange) and the must-change area is touched.
 *
 * INTENT (verbatim): this fixture documents the Class-B boundary — semantic
 * test weakening with identical id/count/command is not deterministically
 * detectable; if this test ever FAILS because the engine started detecting it
 * heuristically, that is the alarm that the boundary was "fixed" with
 * guesswork. The fixture exists to keep the limitation honest, not to
 * celebrate it.
 */
describe('H5: verification-surface boundary (attack 2b)', () => {
  it('semantic test weakening with identical id/count/command still ACCEPTs (documented boundary)', async () => {
    const repo = await TempRepo.create(fakeVitestApp(PASSING_SPECS))
    await repo.markExecutable('node_modules/.bin/vitest')
    await repo.git('branch', 'base')

    // Break real behavior: addTask no longer validates anything.
    await repo.write({
      'src/index.js': `export function addTask() {
  return [{ id: 'fixed-id', text: '   ', completed: false }]
}
`,
      // Gut the catching test's assertion while keeping its id/title/outcome
      // identical: the spec entry is edited (a real change to the test file,
      // authorized by the contract) but still reports 'passed' — in this
      // harness the assertion's strength lives in the spec data, and a gutted
      // assertion is one that no longer checks what it used to.
      'tests/spec.json': JSON.stringify(
        {
          tests: PASSING_SPECS.map((spec) =>
            spec.fullName === 'tasks > rejects blank'
              ? { ...spec, note: 'assertion gutted — same id, weaker check' }
              : spec,
          ),
        },
        null,
        2,
      ),
    })
    await repo.commit('break behavior, quietly weaken the catching test')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: boundary-2b\ngoal: change the app area; tests may evolve\npaths:\n  mustChange: ["src/index.js"]\n  mayChange: ["tests/**"]\n`,
    })

    // The boundary: every id still executes and passes, so verification is
    // complete and green — nothing deterministic distinguishes this from a
    // legitimate test edit. ACCEPT is the honest verdict today.
    expect(report.threeQuestions.regressions).toEqual({ status: 'pass', baselineTests: 2, regressionsFound: 0 })
    expect(report.verdict).toBe('ACCEPT')
    // Tripwire detail: no finding of any kind fires on this shape — not even
    // test-coverage-reduced (coverage is id-based and every id is present).
    expect(report.findings).toEqual([])
    await repo.destroy()
  })
})
