import { z } from 'zod'
import { ProbeRunResultSchema } from './service'

/**
 * Baseline Engine data model (M2). The engine executes the repository's
 * existing test command against the before and after revisions in isolated
 * worktrees and models outcomes at the finest granularity the runner
 * provides — with an honest suite-level fallback.
 */

export const TestStatusSchema = z.enum(['passed', 'failed', 'skipped', 'todo', 'unknown'])
export type TestStatus = z.infer<typeof TestStatusSchema>

export const TestCaseOutcomeSchema = z.object({
  /** Runner-unique identity (jest/vitest fullName). */
  id: z.string(),
  title: z.string(),
  file: z.string().optional(),
  status: TestStatusSchema,
  failureMessage: z.string().optional(),
})
export type TestCaseOutcome = z.infer<typeof TestCaseOutcomeSchema>

export const TestRunResultSchema = z.object({
  label: z.enum(['before', 'after']),
  /** The git ref (or 'working-tree') this run executed against. */
  ref: z.string(),
  sha: z.string(),
  /** 'per-test' when individual outcomes were parsed; 'suite' when only the exit status is trustworthy. */
  mode: z.enum(['per-test', 'suite']),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  spawnError: z.string().nullable().default(null),
  durationMs: z.number().int(),
  stdoutSummary: z.string(),
  stderrSummary: z.string(),
  tests: z.array(TestCaseOutcomeSchema).default([]),
  /** Working-tree state fingerprint (after-run in working-tree mode only). */
  fingerprint: z.string().optional(),
  /** How dependencies were restored before this run. */
  dependencyInstall: z.object({
    strategy: z.enum(['npm-ci', 'npm-install', 'none']),
    command: z.string(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int(),
  }).optional(),
})
export type TestRunResult = z.infer<typeof TestRunResultSchema>

export const BaselineSummarySchema = z.object({
  preserved: z.number().int(),
  regressed: z.number().int(),
  preExisting: z.number().int(),
  improved: z.number().int(),
  unknown: z.number().int(),
})
export type BaselineSummary = z.infer<typeof BaselineSummarySchema>

export const BaselineComparisonSchema = z.object({
  /** Human-facing test command (what a developer would run). */
  userCommand: z.string(),
  /** Exact internal command the engine executed. */
  executedCommand: z.string(),
  perTest: z.boolean(),
  before: TestRunResultSchema,
  after: TestRunResultSchema,
  summary: BaselineSummarySchema,
  /** M5 service-probe phase, present when a service manifest existed at either state. */
  probes: z
    .object({
      before: ProbeRunResultSchema,
      after: ProbeRunResultSchema,
      summary: BaselineSummarySchema,
      /** 'comparable' | 'non-comparable' (from compareManifests; 'none' never reaches here). */
      manifestMode: z.enum(['comparable', 'non-comparable']),
    })
    .optional(),
})
export type BaselineComparison = z.infer<typeof BaselineComparisonSchema>

export const TransitionKindSchema = z.enum(['preserved', 'regression', 'pre-existing', 'improvement', 'unknown'])
export type TransitionKind = z.infer<typeof TransitionKindSchema>

/**
 * A before→after outcome pair for one comparable unit (an individual test or,
 * in suite fallback mode, the suite as a whole). Statuses are strings because
 * suite mode uses pass/fail while per-test mode uses runner statuses.
 */
export interface TestTransition {
  id: string
  title: string
  file?: string
  before: string
  after: string
  kind: TransitionKind
}
