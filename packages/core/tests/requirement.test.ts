import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { verifyChange } from '../src/pipeline'
import { SERVICE_MANIFEST_FILE } from '../src/schema/service'
import { SAMPLE_APP, TempRepo, fakeVitestApp, PASSING_SPECS } from './helpers/repo'

/**
 * Requirement Verification integration (Doc 1 §8 walkthrough — the design's
 * end-to-end test). The layer composes evidence the engine already produced:
 *   A  true fix, established instrument      -> VERIFIED, accomplished yes
 *   B  false completion (tests green, API broken) -> requirement-failed, REJECT
 *   C  instrument tampering                  -> requirement-experiment-modified
 *   D  new feature, new instrument (I9)      -> UNVERIFIED (experiment-new)
 *   E  binding swap with a tracked contract  -> requirement-binding-changed
 * plus unresolved ids, suite-mode bindings (E6), the policy override, and the
 * zero-clause silence of the layer.
 */

const PORT = 47230

const HEALTHY = JSON.stringify({ status: 200, body: 'ok' }, null, 2)

const SERVER = `import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const health = JSON.parse(await readFile(new URL('../health.json', import.meta.url), 'utf8'))

const server = createServer((request, response) => {
  if (request.url === '/ready') {
    response.writeHead(204)
    response.end()
    return
  }
  if (request.url === '/health') {
    response.writeHead(health.status, { 'content-type': 'text/plain' })
    response.end(health.body)
    return
  }
  if (request.url === '/version') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('v1')
    return
  }
  response.writeHead(404)
  response.end('not found')
})

server.listen(${PORT}, '127.0.0.1')
`

const MANIFEST = `version: 1
services:
  - name: demo
    command: node tools/server.mjs
    readiness: { port: ${PORT}, path: /ready, timeoutMs: 15000 }
probes:
  - id: health
    service: demo
    request: { method: GET, path: /health }
    expect: { status: 200, bodyContains: ok }
  - id: version
    service: demo
    request: { method: GET, path: /version }
    expect: { status: 200, bodyContains: v1 }
`

function serviceApp(healthJson: string, withManifest = true): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'req-app', version: '1.0.0', type: 'module' }, null, 2),
    'health.json': healthJson,
    'tools/server.mjs': SERVER,
    'README.md': '# req-app\n',
  }
  if (withManifest) {
    files[SERVICE_MANIFEST_FILE] = MANIFEST
  }
  return files
}

const acceptance = (
  entries: string,
  { mustChange = '["README.md"]', policy = '' }: { mustChange?: string; policy?: string } = {},
) =>
  `version: 1\nid: req-ver\ngoal: required behavior\npaths:\n  mustChange: ${mustChange}\n${policy}acceptance:\n${entries}\n`

const HEALTH_BOUND = `  - id: REQ-001
    description: The service reports healthy.
    experiments:
      - kind: probe
        probeId: health
`

describe('Requirement verification (Doc 1 §8 walkthrough)', () => {
  it('Case A: true fix, established passing instrument -> VERIFIED, accomplished yes, ACCEPT', async () => {
    const repo = await TempRepo.create(serviceApp(HEALTHY))
    await repo.git('branch', 'base')
    await repo.write({ 'README.md': '# req-app\n\nchanged\n' })
    await repo.commit('docs change')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: acceptance(HEALTH_BOUND),
    })

    expect(report.requirement).toBeDefined()
    expect(report.requirement?.clauses).toEqual([
      {
        clauseId: 'REQ-001',
        description: 'The service reports healthy.',
        status: 'verified',
        reasons: [],
        experiments: [
          expect.objectContaining({ provenance: 'established', result: 'passed', reasons: [] }),
        ],
      },
    ])
    expect(report.requirement?.coverage).toEqual({ total: 1, verified: 1, failed: 0, unverified: 0 })
    // Question 1 aggregates real clause evidence instead of the structural slice.
    expect(report.threeQuestions.accomplished).toBe('yes')
    expect(report.verdict).toBe('ACCEPT')
    // The runner stamped the per-probe definition identity on BOTH sides (Doc 1 §5 anchor).
    const beforeIdentity = report.baseline?.probes?.before.probes[0]?.definitionIdentity
    const afterIdentity = report.baseline?.probes?.after.probes[0]?.definitionIdentity
    expect(beforeIdentity).toMatch(/^def_[0-9a-f]{64}$/)
    expect(afterIdentity).toBe(beforeIdentity)
    expect(report.markdown).toContain('### Requirement verification')
    expect(report.markdown).toContain('REQ-001  The service reports healthy.')
    expect(report.markdown).toContain('Experiment: probe health (established instrument)')
    expect(report.markdown).toContain('Result: PASS')
    expect(report.markdown).toContain('Status: VERIFIED')
    expect(report.markdown).toContain('Requirement coverage: 1 of 1 clauses VERIFIED, 0 FAILED, 0 UNVERIFIED.')
    await repo.destroy()
  })

  it('Case B: false completion — unit tests green, API broken -> requirement-failed, REJECT, accomplished no', async () => {
    const repo = await TempRepo.create({
      ...fakeVitestApp(PASSING_SPECS),
      'health.json': HEALTHY,
      'tools/server.mjs': SERVER,
      [SERVICE_MANIFEST_FILE]: MANIFEST,
      'README.md': '# req-app\n',
    })
    await repo.git('branch', 'base')
    // The "fix" breaks the service behavior while every bound test stays green.
    await repo.write({ 'health.json': JSON.stringify({ status: 500, body: 'ok' }, null, 2) })
    await repo.commit('break the API behind green tests')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1
id: req-false
goal: the service reports healthy
paths:
  mustChange: ["health.json"]
acceptance:
  - id: REQ-001
    description: The service reports healthy.
    experiments:
      - kind: probe
        probeId: health
      - kind: test
        id: "tasks > adds a task"
`,
    })

    const failed = report.findings.find((finding) => finding.findingClass === 'requirement-failed')
    expect(failed).toBeDefined()
    expect(failed?.severity).toBe('critical')
    expect(failed?.evidence.kind).toBe('requirement')
    expect(failed?.message).toContain('REQ-001')
    expect(report.requirement?.clauses[0]?.status).toBe('failed')
    expect(report.requirement?.coverage).toEqual({ total: 1, verified: 0, failed: 1, unverified: 0 })
    expect(report.threeQuestions.accomplished).toBe('no')
    expect(report.verdict).toBe('REJECT')
    expect(report.markdown).toContain('Status: FAILED')
    expect(report.markdown).toContain('Requirement coverage: 0 of 1 clauses VERIFIED, 1 FAILED, 0 UNVERIFIED.')
    await repo.destroy()
  })

  it('Case C: instrument tampering — the change modifies the bound probe -> UNVERIFIED (instrument-modified)', async () => {
    const repo = await TempRepo.create(serviceApp(HEALTHY))
    await repo.git('branch', 'base')
    // The change narrows the probe declaration to a trivially-passing form.
    await repo.write({
      [SERVICE_MANIFEST_FILE]: MANIFEST.replace('bodyContains: ok', 'bodyContains: k'),
      'health.json': JSON.stringify({ status: 200, body: 'ok' }, null, 2),
    })
    await repo.commit('narrow the bound probe')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1
id: req-tamper
goal: the service reports healthy
paths:
  mustChange: ["${SERVICE_MANIFEST_FILE}"]
  mayChange: ["health.json"]
acceptance:
${HEALTH_BOUND}`,
    })

    const modified = report.findings.find((finding) => finding.findingClass === 'requirement-experiment-modified')
    expect(modified).toBeDefined()
    expect(modified?.severity).toBe('warn')
    expect(modified?.message).toContain('probe "health"')
    expect(modified?.message).toMatch(/definition def_[0-9a-f]{6} -> def_[0-9a-f]{6}/)
    expect(report.requirement?.clauses[0]?.status).toBe('unverified')
    expect(report.requirement?.clauses[0]?.reasons).toEqual(['instrument-modified'])
    // Nothing is certified by a self-modified instrument, even though it passed.
    expect(report.threeQuestions.accomplished).toBe('partial')
    expect(report.verdict).toBe('REVIEW')
    expect(report.markdown).toContain('Experiment: probe health (instrument modified by this change)')
    expect(report.markdown).toContain('Status: UNVERIFIED (instrument-modified)')
    await repo.destroy()
  })

  it('Case D: new feature — clause and probe both arrive in this change -> UNVERIFIED (experiment-new), info, never VERIFIED (I9)', async () => {
    const repo = await TempRepo.create(serviceApp(HEALTHY, false))
    await repo.git('branch', 'base')
    // The change introduces the entire service-probe layer.
    await repo.write({
      [SERVICE_MANIFEST_FILE]: MANIFEST,
      'tools/server.mjs': SERVER,
      'health.json': HEALTHY,
    })
    await repo.commit('add the health service and its probe')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1
id: req-new
goal: the service reports healthy
paths:
  mustChange: ["${SERVICE_MANIFEST_FILE}", "tools/**", "health.json"]
acceptance:
${HEALTH_BOUND}`,
    })

    const fresh = report.findings.find((finding) => finding.findingClass === 'experiment-new')
    expect(fresh).toBeDefined()
    expect(fresh?.severity).toBe('info')
    expect(report.requirement?.clauses[0]?.status).toBe('unverified')
    expect(report.requirement?.clauses[0]?.reasons).toEqual(['experiment-new'])
    expect(report.requirement?.clauses[0]?.experiments[0]).toMatchObject({ provenance: 'new', result: 'passed' })
    // Evidence without provenance: the recorded result is shown, VERIFIED is not claimed.
    expect(report.markdown).toContain('Experiment: probe health (new instrument — no before anchor)')
    expect(report.markdown).toContain('Result: PASS')
    expect(report.markdown).toContain('Status: UNVERIFIED (experiment-new)')
    expect(report.threeQuestions.accomplished).toBe('partial')
    expect(report.verdict).not.toBe('ACCEPT')
    await repo.destroy()
  })

  it('Case E: binding swap with a repo-tracked contract -> requirement-binding-changed; without the path, approval establishes identity', async () => {
    const oldContract = acceptance(HEALTH_BOUND, { mustChange: '["req.contract.yaml"]' })
    const newContract = acceptance(`  - id: REQ-001
    description: The service reports healthy.
    experiments:
      - kind: probe
        probeId: version
`, { mustChange: '["req.contract.yaml"]' })
    const repo = await TempRepo.create({ ...serviceApp(HEALTHY), 'req.contract.yaml': oldContract })
    await repo.git('branch', 'base')
    // The change rebinds REQ-001 from health to the harmless version probe.
    await repo.write({ 'req.contract.yaml': newContract })
    await repo.commit('rebind REQ-001')

    const common = {
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: newContract,
    } as const

    const swapped = await verifyChange({ ...common, contractPath: join(repo.dir, 'req.contract.yaml') })
    const drift = swapped.findings.find((finding) => finding.findingClass === 'requirement-binding-changed')
    expect(drift).toBeDefined()
    expect(drift?.severity).toBe('warn')
    expect(drift?.paths).toEqual(['req.contract.yaml'])
    expect(swapped.requirement?.clauses[0]?.status).toBe('unverified')
    expect(swapped.requirement?.clauses[0]?.reasons).toEqual(['binding-changed'])
    // The swapped-in instrument's own anchor status is still evaluated normally.
    expect(swapped.requirement?.clauses[0]?.experiments[0]).toMatchObject({
      provenance: 'established',
      result: 'passed',
    })
    expect(swapped.markdown).toContain('Status: UNVERIFIED (binding-changed)')
    expect(swapped.verdict).toBe('REVIEW')

    // Same change, contract provided without its path: no before-state binding
    // identity is comparable, so the binding was established at approval — no
    // drift, and the established passing instrument verifies the clause.
    const untracked = await verifyChange(common)
    expect(untracked.findings.some((finding) => finding.findingClass === 'requirement-binding-changed')).toBe(false)
    expect(untracked.requirement?.clauses[0]?.status).toBe('verified')
    expect(untracked.verdict).toBe('ACCEPT')
    await repo.destroy()
  })

  it('E4/E6: unresolved test id -> UNVERIFIED (unresolved); suite-mode binding -> UNVERIFIED (unknown-observability)', async () => {
    const repo = await TempRepo.create(fakeVitestApp(PASSING_SPECS))
    await repo.git('branch', 'base')
    await repo.write({ 'README.md': '# fake-vitest-app\n\nchanged\n' })
    await repo.commit('innocent change')

    const unresolved = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: acceptance(`  - id: REQ-001
    description: The ghost behavior.
    experiments:
      - kind: test
        id: "tasks > does not exist"
`),
    })
    expect(unresolved.requirement?.clauses[0]?.status).toBe('unverified')
    expect(unresolved.requirement?.clauses[0]?.reasons).toEqual(['unresolved'])
    expect(unresolved.threeQuestions.accomplished).toBe('partial')
    expect(unresolved.markdown).toContain('Status: UNVERIFIED (unresolved)')
    await repo.destroy()

    // The SAMPLE_APP test command is a generic script: suite-level outcomes
    // only, so a test binding is honestly unresolvable (Doc 1 §3).
    const suiteRepo = await TempRepo.create(SAMPLE_APP)
    await suiteRepo.git('branch', 'base')
    await suiteRepo.write({ 'src/style.css': 'body { margin: 0; padding: 1rem; }\n' })
    await suiteRepo.commit('polish styles')
    const suite = await verifyChange({
      repo: suiteRepo.dir,
      before: 'base',
      after: 'HEAD',
      contract: acceptance(`  - id: REQ-001
    description: The suite covers it.
    experiments:
      - kind: test
        id: "whatever > it"
`, { mustChange: '["src/style.css"]' }),
    })
    expect(suite.requirement?.clauses[0]?.status).toBe('unverified')
    expect(suite.requirement?.clauses[0]?.reasons).toEqual(['unknown-observability'])
    expect(suite.markdown).toContain('Status: UNVERIFIED (unknown-observability)')
    expect(suite.verdict).toBe('REVIEW')
    await suiteRepo.destroy()
  })

  it('unbound-kind (dom-flow) gates review by default; the policy override accepts explicitly (OQ1)', async () => {
    const repo = await TempRepo.create(serviceApp(HEALTHY))
    await repo.git('branch', 'base')
    await repo.write({ 'README.md': '# req-app\n\nchanged\n' })
    await repo.commit('docs change')

    const domFlow = `  - id: REQ-001
    description: The UI shows the error.
    experiments:
      - kind: dom-flow
        flowId: decl-error-shown
`
    const reviewing = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: acceptance(domFlow),
    })
    expect(reviewing.requirement?.clauses[0]?.status).toBe('unverified')
    expect(reviewing.requirement?.clauses[0]?.reasons).toEqual(['unbound-kind'])
    expect(reviewing.markdown).toContain('Experiment: dom-flow decl-error-shown (kind not yet available)')
    expect(reviewing.verdict).toBe('REVIEW')

    const accepted = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: acceptance(domFlow, { policy: 'policy:\n  requirement-unverified: accept\n' }),
    })
    expect(accepted.requirement?.clauses[0]?.status).toBe('unverified')
    expect(accepted.verdict).toBe('ACCEPT')
    await repo.destroy()
  })

  it('zero declared clauses: the layer stays silent and structural accomplished semantics hold', async () => {
    const repo = await TempRepo.create(SAMPLE_APP)
    await repo.git('branch', 'base')
    await repo.write({ 'src/style.css': 'body { margin: 0; padding: 1rem; }\n' })
    await repo.commit('polish styles')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: 'version: 1\nid: no-reqs\ngoal: styling only\npaths:\n  mustChange: ["src/style.css"]\nacceptance: []\n',
    })

    expect(report.requirement).toBeUndefined()
    expect(report.markdown).not.toContain('### Requirement verification')
    // Structural semantics: every must-change area was touched.
    expect(report.threeQuestions.accomplished).toBe('yes')
    expect(report.verdict).toBe('ACCEPT')
    await repo.destroy()
  })
})
