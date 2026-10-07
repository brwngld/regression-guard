import { describe, expect, it } from 'vitest'
import { verifyChange } from '../src/pipeline'
import { TempRepo } from './helpers/repo'

/**
 * M5 integration: service verification over real repositories with real HTTP
 * services. Invariants under test:
 *   - probe PASS->FAIL is a regression (REJECT by default) with kind:'api'
 *     evidence and N-of-M reproduction at probe granularity;
 *   - FAIL->FAIL probes are pre-existing and never poison the gate alone;
 *   - unknown probe outcomes (service never ready) report partial, never pass;
 *   - a changed manifest forces partial comparability with an info finding;
 *   - manifest-only repositories (no test script) verify their probes.
 */

const PERMISSIVE = (mustChange: string) =>
  `version: 1\nid: m5-test\ngoal: service change\npaths:\n  mustChange: ["${mustChange}"]\n`

const HEALTHY = JSON.stringify({ status: 200, body: 'ok' }, null, 2)

/** A dependency-free HTTP service whose behavior is driven by health.json. */
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
  response.writeHead(404)
  response.end('not found')
})

server.listen(${47210}, '127.0.0.1')
`

const MANIFEST = `version: 1
services:
  - name: demo
    command: node tools/server.mjs
    readiness: { port: ${47210}, path: /ready, timeoutMs: 15000 }
probes:
  - id: health
    service: demo
    request: { method: GET, path: /health }
    expect: { status: 200, bodyContains: ok }
`

function serviceRepo(healthJson: string): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'svc-app', version: '1.0.0', type: 'module' }, null, 2),
    'health.json': healthJson,
    'tools/server.mjs': SERVER,
    'regression-guard.services.yaml': MANIFEST,
    'README.md': '# svc\n',
  }
}

describe('M5: service verification', () => {
  it('detects a probe regression (PASS->FAIL), rejects with api evidence, and reproduces N-of-M at probe granularity', async () => {
    const repo = await TempRepo.create(serviceRepo(HEALTHY))
    await repo.git('branch', 'base')

    // The change breaks the service behavior deterministically.
    await repo.write({ 'health.json': JSON.stringify({ status: 500, body: 'ok' }, null, 2) })
    await repo.commit('break the service')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: m5-reg\ngoal: change health behavior\npaths:\n  mustChange: ["health.json"]\nreproduction:\n  attempts: 3\n  timeoutMs: 20000\n`,
    })

    expect(report.threeQuestions.regressions).toMatchObject({ status: 'fail', regressionsFound: 1, baselineTests: 1 })
    expect(report.verdict).toBe('REJECT')

    const finding = report.findings.find((f) => f.findingClass === 'service-regression')
    expect(finding).toBeDefined()
    expect(finding?.severity).toBe('critical')
    expect(finding?.evidence.kind).toBe('api')
    expect(finding?.evidence.observation).toContain('Before: PASSED')
    expect(finding?.evidence.observation).toContain('After: FAILED')

    const reproduction = finding?.reproduction
    expect(reproduction).toMatchObject({
      attemptsRequested: 3,
      attemptsCompleted: 3,
      reproduced: 3,
      stability: 'stable',
      granularity: 'probe',
      stateMatched: true,
    })
    for (const attempt of reproduction?.attempts ?? []) {
      expect(attempt.experimentId).toMatch(/^REPRO-/)
      expect(attempt.stateIdentity.kind).toBe('ref')
    }

    expect(report.baseline?.probes?.manifestMode).toBe('comparable')
    expect(report.markdown).toContain('Service probes:')
    expect(report.markdown).toContain('0 passed, 1 failed')
    await repo.destroy()
  })

  it('treats FAIL->FAIL probes as pre-existing — never poisoning the gate alone', async () => {
    const repo = await TempRepo.create(serviceRepo(JSON.stringify({ status: 500, body: 'ok' }, null, 2)))
    await repo.git('branch', 'base')
    await repo.write({ 'README.md': '# svc\n\nchanged\n' })
    await repo.commit('innocent docs change')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: PERMISSIVE('README.md'),
    })

    expect(report.threeQuestions.regressions).toMatchObject({ status: 'pass', regressionsFound: 0 })
    const classes = report.findings.map((finding) => finding.findingClass)
    expect(classes).toContain('pre-existing-failure')
    expect(classes).not.toContain('service-regression')
    expect(report.verdict).toBe('ACCEPT')
    await repo.destroy()
  })

  it('reports partial (never pass) when the changed service never becomes ready', async () => {
    const repo = await TempRepo.create(serviceRepo(HEALTHY))
    await repo.git('branch', 'base')

    // The change makes the service crash on boot: health.json becomes invalid
    // JSON, so server startup throws and readiness can never succeed.
    await repo.write({ 'health.json': '{ this is not json' })
    await repo.commit('crash the service on boot')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: PERMISSIVE('health.json'),
    })

    expect(report.threeQuestions.regressions.status).toBe('partial')
    const classes = report.findings.map((finding) => finding.findingClass)
    expect(classes).not.toContain('service-regression')
    expect(classes).toContain('baseline-incomplete')
    expect(report.baseline?.probes?.after.servicesReady).toEqual([])
    await repo.destroy()
  })

  it('a changed manifest forces partial comparability with an info finding, without poisoning the gate', async () => {
    const repo = await TempRepo.create(serviceRepo(HEALTHY))
    await repo.git('branch', 'base')

    // The change redefines the probe expectation (manifest digest changes).
    await repo.write({
      'regression-guard.services.yaml': MANIFEST.replace('bodyContains: ok', 'bodyContains: ok-v2'),
      'health.json': JSON.stringify({ status: 200, body: 'ok-v2' }, null, 2),
    })
    await repo.commit('redefine the probe')

    const report = await verifyChange({
      repo: repo.dir,
      before: 'base',
      after: 'HEAD',
      contract: `version: 1\nid: m5-manifest\ngoal: redefine the probe\npaths:\n  mustChange: ["regression-guard.services.yaml"]\n  mayChange: ["health.json"]\n`,
    })

    expect(report.threeQuestions.regressions.status).toBe('partial')
    const changed = report.findings.find((f) => f.findingClass === 'service-manifest-changed')
    expect(changed?.severity).toBe('info')
    expect(changed?.paths).toContain('regression-guard.services.yaml')
    // H1: partial verification no longer ACCEPTs by default (frozen spec).
    expect(report.verdict).toBe('REVIEW')
    await repo.destroy()
  })
})
