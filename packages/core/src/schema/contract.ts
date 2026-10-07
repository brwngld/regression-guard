import { z } from 'zod'

/**
 * Named sensitive-file categories. Contracts can reference these by name in any
 * path rule (e.g. `prohibited: [{ category: schema-migration }]`) so authors
 * don't have to re-glob common risk areas per repository.
 */
export const SensitiveCategorySchema = z.enum([
  'schema-migration',
  'database-schema',
  'env-secrets',
  'lockfile',
  'ci-config',
  'dependency-addition',
  'dependency-removal',
])
export type SensitiveCategory = z.infer<typeof SensitiveCategorySchema>

/**
 * A path rule is either a glob (picomatch syntax, repo-root relative,
 * forward slashes) or a named sensitive category.
 */
export const PathRuleSchema = z.union([
  z.string().min(1),
  z.object({
    category: SensitiveCategorySchema,
    description: z.string().optional(),
  }),
])
export type PathRule = z.infer<typeof PathRuleSchema>

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
})
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>

export const FindingClassSchema = z.enum([
  'prohibited-change',
  'preserved-area-changed',
  'out-of-scope-change',
  'new-dependency',
  'removed-dependency',
  'changed-dependency',
  'deleted-test',
  'sensitive-file-changed',
  'unfulfilled-contract',
  // M2 (Baseline Engine):
  'test-regression',
  'pre-existing-failure',
  'baseline-incomplete',
  // M2.1 (baseline comparability): the test command itself changed across refs.
  'test-command-changed',
  // M5 (service verification):
  'service-regression',
  'service-manifest-changed',
  // M5b (API contract verification):
  'api-contract-regression',
  'api-contract-changed',
  'service-manifest-invalid',
  // Hardening (adversarial stress tests): the package manifest is missing or
  // unparseable at a compared state, so the dependency diff is UNKNOWN.
  // Unknown is reported as unknown — never collapsed into removal findings.
  'dependency-state-unknown',
])
export type FindingClass = z.infer<typeof FindingClassSchema>

export const PolicyActionSchema = z.enum(['accept', 'warn', 'review', 'reject'])
export type PolicyAction = z.infer<typeof PolicyActionSchema>

/**
 * STRICT by design (found in adversarial verification): a misplaced contract
 * key must fail loudly, never silently vanish. The motivating case —
 * `prohibited:` written at the top level instead of under `paths:` — parsed
 * as a valid contract with NO prohibitions, so the tool honestly verified
 * against rules the author believed they had declared. Declared-incorrectly
 * is an error, exactly like an invalid service manifest.
 */
export const ContractPathsSchema = z.strictObject({
  mustChange: z.array(PathRuleSchema).default([]),
  mayChange: z.array(PathRuleSchema).default([]),
  mustPreserve: z.array(PathRuleSchema).default([]),
  prohibited: z.array(PathRuleSchema).default([]),
})

/** Contracts carry an explicit schema version so future format changes are detectable. */
export const CONTRACT_SCHEMA_VERSION = 1

export const ChangeContractSchema = z.strictObject({
  /** Defaults to 1 so contracts written before versioning still parse. */
  version: z.literal(CONTRACT_SCHEMA_VERSION).default(CONTRACT_SCHEMA_VERSION),
  id: z.string().min(1),
  goal: z.string().min(1),
  paths: ContractPathsSchema.default(() => ({
    mustChange: [],
    mayChange: [],
    mustPreserve: [],
    prohibited: [],
  })),
  acceptance: z.array(AcceptanceCriterionSchema).default([]),
  policy: z.record(z.string(), PolicyActionSchema).default({}),
  /** Bounded N-of-M reproduction configuration (M4). Attempts are capped at 10. */
  reproduction: z
    .object({
      attempts: z.number().int().min(1).max(10).default(5),
      timeoutMs: z.number().int().positive().default(30_000),
    })
    .default(() => ({ attempts: 5, timeoutMs: 30_000 })),
})
export type ChangeContract = z.infer<typeof ChangeContractSchema>

export class ContractValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message)
    this.name = 'ContractValidationError'
  }
}

const PATH_RULE_KEYS = ['mustChange', 'mayChange', 'mustPreserve', 'prohibited'] as const

/**
 * Upgrade unrecognized-key issues into pointed guidance when the misplaced
 * key is a path rule — the single most likely authoring mistake, and the one
 * with the worst silent failure mode when it slips through.
 */
function describeIssue(issue: { path: PropertyKey[]; message: string }): string {
  const where = issue.path.join('.') || '(root)'
  const misplaced = PATH_RULE_KEYS.filter((key) => issue.message.includes(`"${key}"`) || issue.message.includes(key))
  if (issue.path.length === 0 && misplaced.length > 0) {
    const names = `"${misplaced.join('", "')}"`
    return `${where}: ${names} ${misplaced.length === 1 ? 'is a path rule and belongs' : 'are path rules and belong'} under 'paths:' — a top-level path rule would otherwise be silently ignored, which this schema refuses`
  }
  return `${where}: ${issue.message}`
}

/** Parse a contract from a parsed YAML/JSON value with a helpful error. */
export function parseContract(input: unknown): ChangeContract {
  const result = ChangeContractSchema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map(describeIssue)
    throw new ContractValidationError(`Invalid change contract:\n  - ${issues.join('\n  - ')}`, issues)
  }
  return result.data
}
