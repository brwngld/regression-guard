import { describe, expect, it } from 'vitest'
import { verifyChange } from '../src/pipeline'
import { TempRepo } from './helpers/repo'

/**
 * M5b integration: API contract verification — the eight locked scenarios.
 * Chain under test: declared probe -> contract-sourced expectation ->
 * OpenAPI operation -> runtime response -> deterministic validation ->
 * PASS/FAIL/UNKNOWN -> existing transition table. The spec supplies runtime
 * expectations; this is NOT a spec-diff compatibility analyzer.
 */

const PORT = 47220

const OPENAPI = (schemaExtras = '') => `openapi: 3.1.0
info: { title: demo, version: 1.0.0 }
paths:
  /health:
    get:
      responses:
        '200':
          description: healthy
          content:
            application/json:
              schema:
                type: object
                required: [ok]
                properties:
                  ok: { type: boolean }${schemaExtras}
`

const MANIFEST = `version: 1
services:
  - name: demo
    command: node tools/server.mjs
    readiness: { port: ${PORT}, path: /ready, timeoutMs: 15000 }
probes:
  - id: health-contract
    service: demo
    request: { method: GET, path: /health }
    expect:
      fromContract: { file: openapi.yaml, method: GET, path: /health, status: 200 }
`

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
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(health))
    return
  }
  response.writeHead(404)
  response.end('not found')
})

server.listen(${PORT}, '127.0.0.1')
`

function contractRepo(healthJson: string, openapi = OPENAPI(), manifest = MANIFEST): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'contract-app', version: '1.0.0', type: 'module' }, null, 2),
    'health.json': healthJson,
    'openapi.yaml': openapi,
    'regression-guard.services.yaml': manifest,
    'tools/server.mjs': SERVER,
    'README.md': '# contract-app\n',
  }
}

const HEALTHY = JSON.stringify({ ok: true }, null, 2)
const BROKEN = JSON.stringify({ ok: 'yes' }, null, 2)
const contract = (mustChange: string, extra = '') =>
  `version: 1\nid: m5b\ngoal: contract scenario\npaths:\n  mustChange: ["${mustChange}"]${extra}\n`

describe('M5b: API contract verification scenarios', () => {
  it('1+3+6: preserved contract passes; pre-existing violation never poisons; absent manifest means no phase', async () => {
    // Scenario 1: contract preserved.
    const repo = await TempRepo.create(contractRepo(HEALTHY))
    await repo.git('branch', 'base')
    await repo.write({ 'README.md': '# contract-app\n\nchanged\n' })
    await repo.commit('innocent change')

    const preserved = await verifyChange({
      repo: repo.dir, before: 'base', after: 'HEAD', contract: contract('README.md'),
    })
    expect(preserved.threeQuestions.regressions).toMatchObject({ status: 'pass', regressionsFound: 0, baselineTests: 1 })
    expect(preserved.verdict).toBe('ACCEPT')
    expect(preserved.baseline?.probes?.manifestMode).toBe('comparable')
    await repo.destroy()

    // Scenario 3: pre-existing contract violation (base already violates).
    const pre = await TempRepo.create(contractRepo(BROKEN))
    await pre.git('branch', 'base')
    await pre.write({ 'README.md': '# contract-app\n\nchanged\n' })
    await pre.commit('innocent change')
    const preExisting = await verifyChange({
      repo: pre.dir, before: 'base', after: 'HEAD', contract: contract('README.md'),
    })
    expect(preExisting.threeQuestions.regressions).toMatchObject({ status: 'pass', regressionsFound: 0 })
    const classes = preExisting.findings.map((f) => f.findingClass)
    expect(classes).toContain('pre-existing-failure')
    expect(classes).not.toContain('api-contract-regression')
    expect(preExisting.verdict).toBe('ACCEPT')
    await pre.destroy()

    // Scenario 6: manifest absent -> no service verification declared at all.
    const files = contractRepo(HEALTHY)
    delete files['regression-guard.services.yaml']
    const none = await TempRepo.create(files)
    await none.git('branch', 'base')
    await none.write({ 'README.md': '# contract-app\n\nchanged\n' })
    await none.commit('innocent change')
    const absent = await verifyChange({
      repo: none.dir, before: 'base', after: 'HEAD', contract: contract('README.md'),
    })
    expect(absent.baseline?.probes).toBeUndefined()
    expect(absent.threeQuestions.regressions.status).toBe('not-verified')
    await none.destroy()
  })

  it('2: contract broken (PASS->FAIL) -> api-contract-regression, REJECT, api-contract evidence, N-of-M reproduction', async () => {
    const repo = await TempRepo.create(contractRepo(HEALTHY))
    await repo.git('branch', 'base')
    await repo.write({ 'health.json': BROKEN })
    await repo.commit('break the contract')

    const report = await verifyChange({
      repo: repo.dir, before: 'base', after: 'HEAD',
      contract: `version: 1\nid: m5b-broken\ngoal: change health\npaths:\n  mustChange: ["health.json"]\nreproduction:\n  attempts: 3\n  timeoutMs: 20000\n`,
    })

    expect(report.threeQuestions.regressions).toMatchObject({ status: 'fail', regressionsFound: 1, baselineTests: 1 })
    expect(report.verdict).toBe('REJECT')
    const finding = report.findings.find((f) => f.findingClass === 'api-contract-regression')
    expect(finding).toBeDefined()
    expect(finding?.severity).toBe('critical')
    expect(finding?.evidence.kind).toBe('api-contract')
    expect(finding?.evidence.observation).toContain('OpenAPI')
    expect(finding?.reproduction).toMatchObject({
      attemptsRequested: 3, attemptsCompleted: 3, reproduced: 3, stability: 'stable', granularity: 'probe',
    })
    expect(report.markdown).toContain('Service probes:')
    await repo.destroy()
  })

  it('4: specification changed (A != B) -> each side runs its own recorded contract -> partial + info finding', async () => {
    const repo = await TempRepo.create(contractRepo(HEALTHY))
    await repo.git('branch', 'base')
    // Loosen the recorded after-spec; the server satisfies both specs, so the
    // only fact in play is that the CONTRACT IDENTITY changed.
    await repo.write({
      'openapi.yaml': OPENAPI('\n                  count: { type: integer }'),
      'health.json': JSON.stringify({ ok: true, count: 5 }, null, 2),
    })
    await repo.commit('extend the API contract')

    const report = await verifyChange({
      repo: repo.dir, before: 'base', after: 'HEAD',
      contract: contract('openapi.yaml', '\n  mayChange: ["health.json"]'),
    })

    expect(report.threeQuestions.regressions.status).toBe('partial')
    const changed = report.findings.find((f) => f.findingClass === 'api-contract-changed')
    expect(changed?.severity).toBe('info')
    expect(changed?.evidence.kind).toBe('api-contract')
    expect(report.verdict).toBe('ACCEPT')
    await repo.destroy()
  })

  it('5+8: unresolvable contracts (missing operation / unsupported schema keyword / absent document) -> UNKNOWN -> partial, never pass', async () => {
    // Missing operation in the referenced document.
    const missing = await TempRepo.create(contractRepo(HEALTHY))
    await missing.git('branch', 'base')
    await missing.write({
      'regression-guard.services.yaml': MANIFEST.replace('path: /health, status: 200', 'path: /does-not-exist, status: 200'),
    })
    await missing.commit('reference a missing operation')
    const missingReport = await verifyChange({
      repo: missing.dir, before: 'base', after: 'HEAD', contract: contract('regression-guard.services.yaml'),
    })
    expect(missingReport.threeQuestions.regressions.status).toBe('partial')
    const probe = missingReport.baseline?.probes?.after.probes[0]
    expect(probe?.status).toBe('unknown')
    expect(probe?.detail).toContain('no operation')
    expect(missingReport.findings.map((f) => f.findingClass)).not.toContain('api-contract-regression')
    await missing.destroy()

    // Unsupported schema keyword: the pinned subset must report, never ignore.
    const unsupported = await TempRepo.create(contractRepo(HEALTHY, OPENAPI('\n                  when: { format: date-time }')))
    await unsupported.git('branch', 'base')
    await unsupported.write({ 'README.md': '# contract-app\n\nchanged\n' })
    await unsupported.commit('innocent change')
    const unsupportedReport = await verifyChange({
      repo: unsupported.dir, before: 'base', after: 'HEAD', contract: contract('README.md'),
    })
    expect(unsupportedReport.threeQuestions.regressions.status).toBe('partial')
    const unknownProbe = unsupportedReport.baseline?.probes?.before.probes[0]
    expect(unknownProbe?.status).toBe('unknown')
    expect(unknownProbe?.detail).toContain('unsupported schema construct')
    await unsupported.destroy()

    // OpenAPI document deleted while still referenced — NOT equivalent to
    // "no contract requested".
    const deleted = await TempRepo.create(contractRepo(HEALTHY))
    await deleted.git('branch', 'base')
    await deleted.remove(['openapi.yaml'])
    await deleted.commit('delete the referenced contract document')
    const deletedReport = await verifyChange({
      repo: deleted.dir, before: 'base', after: 'HEAD', contract: contract('openapi.yaml'),
    })
    expect(deletedReport.threeQuestions.regressions.status).toBe('partial')
    const afterProbe = deletedReport.baseline?.probes?.after.probes[0]
    expect(afterProbe?.status).toBe('unknown')
    expect(afterProbe?.detail).toContain('missing or unparseable')
    await deleted.destroy()
  })

  it('7: invalid manifest -> verification declared incorrectly -> partial + explicit finding, no execution', async () => {
    const files = contractRepo(HEALTHY)
    files['regression-guard.services.yaml'] = 'services: [ this is not a valid manifest\n'
    const repo = await TempRepo.create(files)
    await repo.git('branch', 'base')
    await repo.write({ 'README.md': '# contract-app\n\nchanged\n' })
    await repo.commit('innocent change')

    const report = await verifyChange({
      repo: repo.dir, before: 'base', after: 'HEAD', contract: contract('README.md'),
    })

    expect(report.threeQuestions.regressions.status).toBe('partial')
    const invalid = report.findings.find((f) => f.findingClass === 'service-manifest-invalid')
    expect(invalid?.severity).toBe('info')
    expect(invalid?.paths).toContain('regression-guard.services.yaml')
    expect(report.baseline?.probes?.before.probes).toEqual([])
    expect(report.baseline?.probes?.after.probes).toEqual([])
    await repo.destroy()
  })
})
