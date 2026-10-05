import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ProbeDeclaration,
  ProbeOutcome,
  ServiceDeclaration,
  ServiceManifest,
} from '../schema/service'
import { startProcess, type RunningProcess } from '../exec/run'
import { evaluateProbe } from './probe-eval'
import { checkAgainstSchema, parseOpenApiDocument, resolveContractExpectation } from './contract'

/**
 * M5 service verification runtime: boot each needed service inside an
 * isolated worktree, wait for readiness, execute its declared probes, then
 * tear everything down — leak-free by construction (process-TREE kill) and
 * total by construction (one broken service or probe is recorded, never
 * propagated). The phase result is deterministic evidence, not a verdict:
 * interpretation happens upstream.
 *
 * M5b: probes with `expect.fromContract` resolve their expectation from the
 * OpenAPI document recorded in the same worktree (`cwd`) and are validated
 * against its declared operation (status + pinned-subset JSON schema); every
 * unresolvable state is recorded as unknown, never a silent pass.
 */

export interface ProbeExecutionOptions {
  cwd: string
  manifest: ServiceManifest
}

export interface ServicePhaseResult {
  servicesReady: string[]
  probes: ProbeOutcome[]
  durationMs: number
}

const READINESS_POLL_INTERVAL_MS = 250
/** Cap per readiness fetch attempt so a wedged connect cannot stall the poll loop. */
const READINESS_REQUEST_TIMEOUT_MS = 1_000
/** Hard startProcess timeout = readiness budget + margin for the probe pass. */
const STARTUP_KILL_MARGIN_MS = 10_000

/**
 * Boot each service referenced by a probe (sorted by name), wait for
 * readiness, run that service's probes in manifest order, kill everything.
 * Never throws.
 */
export async function runServiceProbes(options: ProbeExecutionOptions): Promise<ServicePhaseResult> {
  const startedAt = Date.now()
  const servicesReady: string[] = []
  const probes: ProbeOutcome[] = []

  const declared = new Map(options.manifest.services.map((service) => [service.name, service]))
  const referenced = new Set(options.manifest.probes.map((probe) => probe.service))

  // Probes pointing at undeclared services can never execute: record them as
  // unknown instead of silently dropping evidence.
  for (const probe of options.manifest.probes) {
    if (!declared.has(probe.service)) {
      probes.push(
        unknownOutcome(probe, `service "${probe.service}" is not declared in the manifest`),
      )
    }
  }

  // Only services referenced by probes are started; deterministic order.
  const toStart = [...declared.values()]
    .filter((service) => referenced.has(service.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  const running: RunningProcess[] = []
  try {
    for (const service of toStart) {
      try {
        const proc = startProcess(service.command, {
          cwd: options.cwd,
          timeoutMs: service.readiness.timeoutMs + STARTUP_KILL_MARGIN_MS,
          env: service.env,
        })
        running.push(proc)

        const ready = await waitForReadiness(service, proc)
        if (!ready) {
          for (const probe of probesOf(options.manifest, service.name)) {
            probes.push(
              unknownOutcome(probe, `service did not become ready within ${service.readiness.timeoutMs}ms`),
            )
          }
          continue
        }
        servicesReady.push(service.name)

        for (const probe of probesOf(options.manifest, service.name)) {
          probes.push(await executeProbe(probe, service, options.cwd))
        }
      } catch (error) {
        // Defensive totality: a broken service must not abort the phase.
        const detail = error instanceof Error ? error.message : String(error)
        for (const probe of probesOf(options.manifest, service.name)) {
          probes.push(unknownOutcome(probe, `service execution error: ${detail}`))
        }
      }
    }
  } finally {
    // Leak-free by design: kill every started tree, then wait for actual
    // death so the caller observes freed ports when the phase resolves.
    await Promise.allSettled(running.map((proc) => proc.kill()))
    await Promise.allSettled(running.map((proc) => proc.exited))
  }

  return { servicesReady, probes, durationMs: Date.now() - startedAt }
}

/** Manifest-order probes belonging to one service. */
function probesOf(manifest: ServiceManifest, serviceName: string): ProbeDeclaration[] {
  return manifest.probes.filter((probe) => probe.service === serviceName)
}

/**
 * Poll the readiness URL every 250ms until ANY HTTP response (any status
 * counts — the port is open and speaking HTTP) or the readiness budget
 * elapses. A command that has already exited can never become ready: the
 * poll stops early instead of burning the full window.
 */
async function waitForReadiness(service: ServiceDeclaration, proc: RunningProcess): Promise<boolean> {
  const url = `http://127.0.0.1:${service.readiness.port}${service.readiness.path}`
  const deadline = Date.now() + service.readiness.timeoutMs
  let exitedEarly = false
  void proc.exited.then(() => {
    exitedEarly = true
  })

  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return false
    }
    try {
      await fetchWithTimeout(url, Math.min(remaining, READINESS_REQUEST_TIMEOUT_MS))
      return true
    } catch {
      if (exitedEarly) {
        return false
      }
    }
    await sleep(Math.min(READINESS_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)))
  }
}

/**
 * One probe against a ready service: fetch with abort at timeoutMs, map the outcome.
 *
 * A probe with `expect.fromContract` is judged ENTIRELY against the referenced
 * OpenAPI operation (contract-sourced expectation); inline status/bodyContains
 * are never consulted — fromContract takes precedence, so a probe cannot be
 * rescued or condemned by a hand-written expectation next to the contract ref.
 */
async function executeProbe(
  probe: ProbeDeclaration,
  service: ServiceDeclaration,
  cwd: string,
): Promise<ProbeOutcome> {
  if (probe.expect.fromContract !== undefined) {
    return executeContractProbe(probe, service, cwd)
  }
  const startedAt = Date.now()
  const url = `http://127.0.0.1:${service.readiness.port}${probe.request.path}`
  const method = probe.request.method
  const canSendBody = method !== 'GET' && method !== 'HEAD'
  try {
    const response = await fetchWithTimeout(url, probe.timeoutMs, {
      method,
      headers: probe.request.headers,
      body: canSendBody ? probe.request.body : undefined,
    })
    // HEAD responses carry no body by definition: the empty body vacuously
    // satisfies bodyContains instead of failing every substring check.
    const body = method === 'HEAD' ? '' : await response.text()
    const expectation = method === 'HEAD' ? { status: probe.expect.status } : probe.expect
    const evaluation = evaluateProbe(expectation, { status: response.status, body })
    return {
      probeId: probe.id,
      service: probe.service,
      status: evaluation.passed ? 'passed' : 'failed',
      expectation: 'inline',
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      ...(evaluation.detail === '' ? {} : { detail: evaluation.detail }),
    }
  } catch (error) {
    return {
      probeId: probe.id,
      service: probe.service,
      status: 'unknown',
      expectation: 'inline',
      httpStatus: null,
      durationMs: Date.now() - startedAt,
      detail: networkErrorDetail(error, probe.timeoutMs),
    }
  }
}

/**
 * One contract-sourced probe (M5b): resolve the declared OpenAPI operation
 * FIRST (a missing document or an unresolvable ref is unknown — an OpenAPI
 * document that is absent when referenced is NEVER equivalent to "no contract
 * was requested"), then fetch and validate deterministically:
 *
 * - status mismatch vs the resolved declared status -> failed (inline-style detail)
 * - declared schema: body must parse as JSON (failure -> failed), then
 *   checkAgainstSchema — valid passes, invalid fails with the path-bearing
 *   reason, and an unsupported construct is UNKNOWN (never silently passed,
 *   never failed on a construct we cannot judge)
 * - status-only contracts (no declared schema) validate the status only.
 */
async function executeContractProbe(
  probe: ProbeDeclaration,
  service: ServiceDeclaration,
  cwd: string,
): Promise<ProbeOutcome> {
  const ref = probe.expect.fromContract!
  const startedAt = Date.now()
  const base = {
    probeId: probe.id,
    service: probe.service,
    expectation: 'contract' as const,
  }

  const docText = await readFile(join(cwd, ref.file), 'utf8').catch(() => null)
  const doc = parseOpenApiDocument(docText)
  if (doc === null) {
    return { ...base, status: 'unknown', httpStatus: null, durationMs: Date.now() - startedAt, detail: `contract document "${ref.file}" missing or unparseable` }
  }
  const resolution = resolveContractExpectation(doc, ref)
  if (resolution.status === 'unresolvable') {
    return { ...base, status: 'unknown', httpStatus: null, durationMs: Date.now() - startedAt, detail: resolution.reason }
  }
  const expectation = resolution.expectation

  const url = `http://127.0.0.1:${service.readiness.port}${probe.request.path}`
  const method = probe.request.method
  const canSendBody = method !== 'GET' && method !== 'HEAD'
  try {
    const response = await fetchWithTimeout(url, probe.timeoutMs, {
      method,
      headers: probe.request.headers,
      body: canSendBody ? probe.request.body : undefined,
    })
    if (response.status !== expectation.status) {
      return {
        ...base,
        status: 'failed',
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        detail: `expected status ${expectation.status}, got ${response.status}`,
      }
    }
    if (expectation.schema === undefined) {
      // Status-only contract: the declaration asked nothing about the body.
      return { ...base, status: 'passed', httpStatus: response.status, durationMs: Date.now() - startedAt }
    }
    const body = method === 'HEAD' ? '' : await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return {
        ...base,
        status: 'failed',
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        detail: 'response body is not valid JSON',
      }
    }
    const check = checkAgainstSchema(parsed, expectation.schema)
    if (check.verdict === 'valid') {
      return { ...base, status: 'passed', httpStatus: response.status, durationMs: Date.now() - startedAt }
    }
    if (check.verdict === 'invalid') {
      return {
        ...base,
        status: 'failed',
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        detail: check.reason,
      }
    }
    return {
      ...base,
      status: 'unknown',
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      detail: `unsupported schema construct: ${check.keyword}`,
    }
  } catch (error) {
    return {
      ...base,
      status: 'unknown',
      httpStatus: null,
      durationMs: Date.now() - startedAt,
      detail: networkErrorDetail(error, probe.timeoutMs),
    }
  }
}

/** Maps fetch rejections to stable probe details: aborts → timeout, ECONNREFUSED → connection refused. */
function networkErrorDetail(error: unknown, timeoutMs: number): string {
  if ((error as { name?: string } | null)?.name === 'AbortError') {
    return `timeout after ${timeoutMs}ms`
  }
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause
  if (cause?.code === 'ECONNREFUSED') {
    return 'connection refused'
  }
  const fallback = error instanceof Error ? error.message : String(error)
  return cause?.message ?? fallback ?? 'network error'
}

function unknownOutcome(probe: ProbeDeclaration, detail: string): ProbeOutcome {
  return {
    probeId: probe.id,
    service: probe.service,
    status: 'unknown',
    expectation: probe.expect.fromContract ? 'contract' : 'inline',
    httpStatus: null,
    durationMs: 0,
    detail,
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
