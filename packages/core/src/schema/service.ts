import { z } from 'zod'

/**
 * M5 Service Verification: deterministic execution evidence. Repositories
 * DECLARE runnable services and HTTP probes in a checked-in manifest
 * (`regression-guard.services.yaml`). The Baseline Extension boots each
 * service inside the isolated before/after worktrees, executes the probes,
 * and diffs outcomes with the same transition semantics as tests
 * (PASS->FAIL regression, FAIL->FAIL pre-existing, unknown -> partial).
 * Reproduction reruns failing probes N-of-M against the recorded state.
 *
 * Deterministic only: fixed requests, fixed expectations (status code +
 * body substring). No timing assertions, no fuzzing, no inference.
 */

export const SERVICE_MANIFEST_FILE = 'regression-guard.services.yaml'

export const ServiceReadinessSchema = z.object({
  port: z.number().int().min(1).max(65535),
  path: z.string().default('/'),
  timeoutMs: z.number().int().positive().default(20_000),
})
export type ServiceReadiness = z.infer<typeof ServiceReadinessSchema>

export const ServiceDeclarationSchema = z.object({
  name: z.string().min(1),
  /** Shell command (repo-declared, trusted like scripts.test) that starts the service. */
  command: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  readiness: ServiceReadinessSchema,
})
export type ServiceDeclaration = z.infer<typeof ServiceDeclarationSchema>

export const ProbeExpectationSchema = z.object({
  /** Expected HTTP status code. */
  status: z.number().int().optional(),
  /** Substring the response body must contain. */
  bodyContains: z.string().optional(),
})
export type ProbeExpectation = z.infer<typeof ProbeExpectationSchema>

export const ProbeDeclarationSchema = z.object({
  /** Stable probe identity used for before/after matching (like a test id). */
  id: z.string().min(1),
  service: z.string().min(1),
  request: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
    path: z.string().default('/'),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  }),
  expect: ProbeExpectationSchema.default({}),
  timeoutMs: z.number().int().positive().default(10_000),
})
export type ProbeDeclaration = z.infer<typeof ProbeDeclarationSchema>

export const ServiceManifestSchema = z.object({
  version: z.literal(1).default(1),
  services: z.array(ServiceDeclarationSchema).min(1),
  probes: z.array(ProbeDeclarationSchema).default([]),
})
export type ServiceManifest = z.infer<typeof ServiceManifestSchema>

/** One probe execution result against a running service. */
export const ProbeOutcomeSchema = z.object({
  probeId: z.string(),
  service: z.string(),
  /** passed = every expectation met; failed = expectation violated; unknown = execution error/timeout. */
  status: z.enum(['passed', 'failed', 'unknown']),
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int(),
  detail: z.string().optional(),
})
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>

/** Per-side probe execution block on the baseline comparison. */
export const ProbeRunResultSchema = z.object({
  label: z.enum(['before', 'after']),
  ref: z.string(),
  /** Manifest digest both sides were declared from (comparability). */
  manifestDigest: z.string(),
  /** Services that reached readiness within their timeout. */
  servicesReady: z.array(z.string()).default([]),
  probes: z.array(ProbeOutcomeSchema).default([]),
  durationMs: z.number().int(),
})
export type ProbeRunResult = z.infer<typeof ProbeRunResultSchema>
