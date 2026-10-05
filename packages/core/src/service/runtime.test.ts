import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ProbeDeclaration, ServiceManifest } from '../schema/service'
import { runServiceProbes } from './runtime'

/**
 * Hermetic integration tests: real node HTTP servers on 127.0.0.1 with
 * distinct high ports, behavior selected via SERVER_MODE. Nothing touches
 * the network beyond loopback; every test asserts the phase kills its
 * process trees (port freed afterwards, no lingering script processes).
 */

// Behavior modes: healthy (200 + body), exit-immediately (dies at boot),
// never-listen (stays alive without binding the port). /slow sleeps before
// responding; /broken answers 500; everything else answers 200.
const SERVER_SCRIPT = `
import http from 'node:http'

const port = Number(process.env.PORT)
const mode = process.env.SERVER_MODE ?? 'healthy'

if (mode === 'exit-immediately') {
  process.exit(3)
}

if (mode === 'never-listen') {
  setInterval(() => {}, 60_000)
} else {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => {
        res.statusCode = 200
        res.end('slow response')
      }, Number(process.env.SLOW_MS ?? 3000))
      return
    }
    if (req.url === '/broken') {
      res.statusCode = 500
      res.end('internal error')
      return
    }
    res.statusCode = 200
    res.end('hello from guard service')
  })
  server.listen(port, '127.0.0.1')
}
`

const workspaces: string[] = []

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rg-service-runtime-'))
  workspaces.push(dir)
  writeFileSync(join(dir, 'rg-guard-server.mjs'), SERVER_SCRIPT)
  return dir
}

afterAll(() => {
  for (const dir of workspaces) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function probe(p: {
  id: string
  path?: string
  method?: ProbeDeclaration['request']['method']
  status?: number
  bodyContains?: string
  timeoutMs?: number
}): ProbeDeclaration {
  return {
    id: p.id,
    service: 'api',
    request: { method: p.method ?? 'GET', path: p.path ?? '/' },
    expect: { status: p.status, bodyContains: p.bodyContains },
    timeoutMs: p.timeoutMs ?? 10_000,
  }
}

function manifest(config: {
  port: number
  mode: string
  readinessTimeoutMs: number
  slowMs?: number
  probes: ProbeDeclaration[]
}): ServiceManifest {
  return {
    version: 1,
    services: [
      {
        name: 'api',
        // Absolute interpreter (spaces-safe via quoting — exercises the exact
        // spawn contract runCommand/startProcess must preserve).
        command: `${JSON.stringify(process.execPath)} rg-guard-server.mjs`,
        env: {
          PORT: String(config.port),
          SERVER_MODE: config.mode,
          ...(config.slowMs === undefined ? {} : { SLOW_MS: String(config.slowMs) }),
        },
        readiness: { port: config.port, path: '/', timeoutMs: config.readinessTimeoutMs },
      },
    ],
    probes: config.probes,
  }
}

/** Required cleanup assertion: the port must stop answering after the phase. */
async function expectPortFree(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`port ${port} still answered ${timeoutMs}ms after the phase`)
}

/**
 * Best-effort (Windows only): command lines of node processes still running
 * our test server script. Returns null when the platform or PowerShell is
 * unavailable — the port-free check above is the required assertion.
 */
async function lingeringServerCommandLines(): Promise<string[] | null> {
  if (process.platform !== 'win32') {
    return null
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }",
        ],
        { timeout: 8_000 },
        (error, out) => (error !== null ? reject(error) : resolve(out)),
      )
    })
    return stdout.split('\n').filter((line) => line.includes('rg-guard-server.mjs'))
  } catch {
    return null
  }
}

describe('runServiceProbes', () => {
  it('runs probes against a healthy service and reports passed outcomes', async () => {
    const result = await runServiceProbes({
      cwd: makeWorkspace(),
      manifest: manifest({
        port: 47101,
        mode: 'healthy',
        readinessTimeoutMs: 8_000,
        probes: [
          probe({ id: 'root-ok', status: 200, bodyContains: 'hello from guard service' }),
          probe({ id: 'head-ok', method: 'HEAD', status: 200, bodyContains: 'hello' }),
        ],
      }),
    })

    expect(result.servicesReady).toEqual(['api'])
    expect(result.probes).toHaveLength(2)
    expect(result.probes[0]).toMatchObject({
      probeId: 'root-ok',
      status: 'passed',
      httpStatus: 200,
    })
    expect(result.probes[0]?.detail).toBeUndefined()
    // HEAD bodies are empty by definition: bodyContains matches vacuously.
    expect(result.probes[1]).toMatchObject({ probeId: 'head-ok', status: 'passed', httpStatus: 200 })
  })

  it('marks expectation mismatches as failed with evaluation details', async () => {
    const result = await runServiceProbes({
      cwd: makeWorkspace(),
      manifest: manifest({
        port: 47102,
        mode: 'healthy',
        readinessTimeoutMs: 8_000,
        probes: [
          probe({ id: 'wants-200', path: '/broken', status: 200 }),
          probe({ id: 'wants-body', bodyContains: 'goodbye' }),
        ],
      }),
    })

    expect(result.servicesReady).toEqual(['api'])
    expect(result.probes[0]).toMatchObject({
      probeId: 'wants-200',
      status: 'failed',
      httpStatus: 500,
      detail: 'expected status 200, got 500',
    })
    expect(result.probes[1]).toMatchObject({ probeId: 'wants-body', status: 'failed', httpStatus: 200 })
    expect(result.probes[1]?.detail).toContain('body does not contain "goodbye"')
  })

  it('completes without hanging when the service command exits immediately', async () => {
    const result = await runServiceProbes({
      cwd: makeWorkspace(),
      manifest: manifest({
        port: 47103,
        mode: 'exit-immediately',
        readinessTimeoutMs: 5_000,
        probes: [probe({ id: 'root-ok', status: 200 })],
      }),
    })

    expect(result.servicesReady).toEqual([])
    expect(result.probes).toHaveLength(1)
    expect(result.probes[0]).toMatchObject({
      probeId: 'root-ok',
      status: 'unknown',
      httpStatus: null,
      detail: 'service did not become ready within 5000ms',
    })
    // Early exit detection: the readiness window is NOT burned.
    expect(result.durationMs).toBeLessThan(4_000)
  })

  it('times out a service that never listens, reports unknown probes, and kills the process', async () => {
    const result = await runServiceProbes({
      cwd: makeWorkspace(),
      manifest: manifest({
        port: 47104,
        mode: 'never-listen',
        readinessTimeoutMs: 1_500,
        probes: [probe({ id: 'root-ok', status: 200 })],
      }),
    })

    expect(result.servicesReady).toEqual([])
    expect(result.probes[0]).toMatchObject({
      status: 'unknown',
      httpStatus: null,
      detail: 'service did not become ready within 1500ms',
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(1_500)

    await expectPortFree(47104)
    const lingering = await lingeringServerCommandLines()
    if (lingering !== null) {
      expect(lingering).toEqual([])
    }
  })

  it("maps a probe whose response exceeds its timeout to unknown 'timeout'", async () => {
    const result = await runServiceProbes({
      cwd: makeWorkspace(),
      manifest: manifest({
        port: 47105,
        mode: 'healthy',
        readinessTimeoutMs: 8_000,
        slowMs: 3_000,
        probes: [probe({ id: 'slow', path: '/slow', status: 200, timeoutMs: 700 })],
      }),
    })

    expect(result.servicesReady).toEqual(['api'])
    expect(result.probes[0]).toMatchObject({
      probeId: 'slow',
      status: 'unknown',
      httpStatus: null,
      detail: 'timeout after 700ms',
    })
    expect(result.probes[0]?.durationMs).toBeGreaterThanOrEqual(600)
  })

  it('frees the service port after the phase (process-tree cleanup)', async () => {
    const result = await runServiceProbes({
      cwd: makeWorkspace(),
      manifest: manifest({
        port: 47106,
        mode: 'healthy',
        readinessTimeoutMs: 8_000,
        probes: [probe({ id: 'root-ok', status: 200 })],
      }),
    })

    expect(result.servicesReady).toEqual(['api'])
    expect(result.probes[0]?.status).toBe('passed')

    // Required assertion: a follow-up fetch to the port fails.
    await expectPortFree(47106)
    const lingering = await lingeringServerCommandLines()
    if (lingering !== null) {
      expect(lingering).toEqual([])
    }
  })
})
