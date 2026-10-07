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

/**
 * Contract-sourced expectation (M5b): the response is validated against an
 * operation declared in a repo-checked-in OpenAPI document. The spec supplies
 * deterministic RUNTIME expectations for declared probes — this is not a
 * spec-diff compatibility analyzer.
 */
export const ContractRefSchema = z.object({
  /** Repo-relative path to the OpenAPI document (JSON or YAML). */
  file: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  /** Operation path exactly as declared under openapi paths (e.g. '/health'). */
  path: z.string().min(1),
  /** Response status whose declaration becomes the expectation. */
  status: z.number().int(),
})
export type ContractRef = z.infer<typeof ContractRefSchema>

export const ProbeExpectationSchema = z
  .object({
    /** Expected HTTP status code. */
    status: z.number().int().optional(),
    /** Substring the response body must contain. */
    bodyContains: z.string().optional(),
    /**
     * When present, expectations are sourced from the referenced OpenAPI
     * operation (status + declared JSON schema, validated against the PINNED
     * subset). MUTUALLY EXCLUSIVE with inline status/bodyContains (M5b.1):
     * configuration that looks like all assertions matter while two silently
     * don't is exactly the hidden precedence this engine refuses. Unresolvable
     * refs / missing operations / unsupported schema constructs yield
     * UNKNOWN, never silent passes.
     */
    fromContract: ContractRefSchema.optional(),
  })
  .refine(
    (expectation) =>
      expectation.fromContract === undefined ||
      (expectation.status === undefined && expectation.bodyContains === undefined),
    {
      message:
        'expect must be EITHER inline (status/bodyContains) OR fromContract — not both; inline fields next to a contract ref would be silently ignored',
    },
  )
export type ProbeExpectation = z.infer<typeof ProbeExpectationSchema>

/**
 * Per-probe contract identity (M5b.1): comparability is a property of EACH
 * contract-backed probe, not the service phase as a whole. A change to one
 * API document must never make probes backed by other documents appear
 * non-comparable. `documentDigest` is null when the referenced document
 * could not be read/parsed (the outcome itself is unknown with detail).
 */
export const ContractIdentitySchema = z.object({
  file: z.string(),
  documentDigest: z.string().nullable(),
  method: ContractRefSchema.shape.method,
  path: z.string(),
  status: z.number().int(),
})
export type ContractIdentity = z.infer<typeof ContractIdentitySchema>

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

/**
 * STRICT (same rationale as the change contract): a misplaced manifest key
 * fails loudly instead of silently narrowing what verification was declared.
 */
export const ServiceManifestSchema = z.strictObject({
  version: z.literal(1).default(1),
  services: z.array(ServiceDeclarationSchema).min(1),
  probes: z.array(ProbeDeclarationSchema).default([]),
})
export type ServiceManifest = z.infer<typeof ServiceManifestSchema>

/** One probe execution result against a running service. */
export const ProbeOutcomeSchema = z.object({
  probeId: z.string(),
  service: z.string(),
  /** passed = every expectation met; failed = expectation violated; unknown = execution error/timeout/unresolvable contract. */
  status: z.enum(['passed', 'failed', 'unknown']),
  /** Which kind of expectation produced this outcome — routes the finding class on regression. */
  expectation: z.enum(['inline', 'contract']).default('inline'),
  /** Present on contract-sourced probes: the per-probe contract identity (M5b.1 — the authoritative comparability unit). */
  contractIdentity: ContractIdentitySchema.optional(),
  /**
   * Per-probe definition identity (Doc 1 §2.3/§5): canonical digest of this
   * probe's parsed declaration plus, for contract-sourced probes, the
   * referenced OpenAPI document's digest. Compared across states to decide
   * whether the instrument is the same one. null = the definition could not be
   * resolved at this state (unreadable document) — unknown, never divergence,
   * never novelty (the M5b.1 null-digest discipline).
   */
  definitionIdentity: z.string().nullable().optional(),
  httpStatus: z.number().int().nullable(),
  durationMs: z.number().int(),
  detail: z.string().optional(),
})
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>

/**
 * Manifest-digest sentinel recorded for a side whose recorded state DECLARES a
 * manifest that cannot be loaded (unparseable YAML / schema-invalid): the
 * schema's `manifestDigest` is a plain string, so the invalid state is carried
 * explicitly instead of being conflated with 'absent'. Never collides with a
 * real digest (all real digests are `<prefix>_`-prefixed hashes).
 */
export const INVALID_MANIFEST_DIGEST = 'invalid'

/** Per-side probe execution block on the baseline comparison. */
export const ProbeRunResultSchema = z.object({
  label: z.enum(['before', 'after']),
  ref: z.string(),
  /** Manifest digest both sides were declared from (comparability). */
  manifestDigest: z.string(),
  /**
   * Per-side API-contract identity (M5b): a digest over the parsed OpenAPI
   * documents this side's contract probes reference ('oasl_…'). null when no
   * probe references a contract, or when a referenced document is
   * missing/unparseable (the probes themselves report unknown with details).
   */
  contractDigest: z.string().nullable().default(null),
  /** Services that reached readiness within their timeout. */
  servicesReady: z.array(z.string()).default([]),
  probes: z.array(ProbeOutcomeSchema).default([]),
  durationMs: z.number().int(),
})
export type ProbeRunResult = z.infer<typeof ProbeRunResultSchema>
