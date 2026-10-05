import { z } from 'zod'

/**
 * M4 Reproduction model. A failure is stronger evidence when Regression Guard
 * can reproduce it: experiments re-execute deterministic evidence against the
 * EXACT recorded state, in isolation, and the assessment qualifies stability
 * without ever rewriting the original observation (M2's finding stands
 * regardless of reproduction outcome).
 */

/** Identity of one compared repository state (ref or working tree). */
export const StateIdentitySchema = z.object({
  /** Human label: the ref name, or 'working-tree'. */
  label: z.string(),
  kind: z.enum(['ref', 'working-tree']),
  /** Commit SHA; null in working-tree mode (no commit identifies the dirty state). */
  sha: z.string().nullable(),
  /** Working-tree base (HEAD) SHA. */
  baseSha: z.string().optional(),
  /** Working-tree dirty-state fingerprint (M2.1). */
  fingerprint: z.string().optional(),
})
export type StateIdentity = z.infer<typeof StateIdentitySchema>

export const ExperimentKindSchema = z.enum(['git-diff', 'test'])
export type ExperimentKind = z.infer<typeof ExperimentKindSchema>

/**
 * The run granularity an experiment actually achieved. Never claim case-level
 * reproduction when the runner only supports coarser reruns.
 */
export const ExperimentGranularitySchema = z.enum(['case', 'file', 'suite', 'n/a'])
export type ExperimentGranularity = z.infer<typeof ExperimentGranularitySchema>

/**
 * Structured command: executable + args is the authoritative representation.
 * A human-readable rendering exists for reports, but no shell string is ever
 * the source of truth (and engine-built commands use strict quoting that
 * downgrades granularity rather than executing unsafe arguments).
 */
export const ReproductionCommandSchema = z.object({
  executable: z.string(),
  args: z.array(z.string()),
  /** Logical working-directory descriptor, e.g. '<repo>' or '<isolated-worktree>'. */
  cwd: z.string(),
})
export type ReproductionCommand = z.infer<typeof ReproductionCommandSchema>

export const ReproductionExperimentSchema = z.object({
  id: z.string(),
  kind: ExperimentKindSchema,
  purpose: z.string(),
  command: ReproductionCommandSchema,
  granularity: ExperimentGranularitySchema,
  timeoutMs: z.number().int().positive(),
  /** The exact state this experiment must be executed against. */
  stateIdentity: StateIdentitySchema,
  sourceFindingIds: z.array(z.string()).default([]),
  /**
   * Case-level outcome target for test experiments: the regressed test's
   * name, used to match the specific test in the runner's parsed results.
   * Structured data only — never interpolated into a shell command. (Runner
   * `-t`/name-pattern flags are NOT used for execution: their matching
   * semantics differ across runners and versions, which silently matched
   * nothing in practice. The run executes at file/suite granularity and the
   * outcome is determined at case precision from the JSON report.)
   */
  testName: z.string().optional(),
})
export type ReproductionExperiment = z.infer<typeof ReproductionExperimentSchema>

export const AttemptOutcomeSchema = z.enum(['reproduced', 'not-reproduced', 'inconclusive'])
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>

export const ReproductionAttemptSchema = z.object({
  /** 1-based attempt number. */
  index: z.number().int(),
  /**
   * Per-attempt attribution (M4.1): the experiment this attempt belongs to.
   * Optional only for backward compatibility with pre-M4.1 persisted
   * assessments — the reproduction engine records it on EVERY attempt.
   */
  experimentId: z.string().optional(),
  /**
   * Per-attempt attribution (M4.1): the recorded state identity this attempt
   * executed against (for attempts that never executed, the identity that
   * failed verification — the reason is in `detail`). Optional only for
   * backward compatibility; the engine records it on EVERY attempt.
   */
  stateIdentity: StateIdentitySchema.optional(),
  outcome: AttemptOutcomeSchema,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int(),
  timedOut: z.boolean(),
  detail: z.string().optional(),
})
export type ReproductionAttempt = z.infer<typeof ReproductionAttemptSchema>

/**
 * Stability semantics — deliberately conservative headline with honest
 * accounting:
 * - any inconclusive attempt → 'inconclusive' (the headline never claims more
 *   certainty than the worst attempt), while the counts preserve the useful
 *   observation that completed attempts may all have reproduced;
 * - all completed attempts reproduced → 'stable';
 * - none reproduced → 'not-reproduced';
 * - mixed reproduced/not-reproduced with no inconclusive → 'unstable'
 *   (consistent outcomes across the same experiment — a defensible word;
 *   "flaky" implies statistics we do not yet claim);
 * - 'not-attempted' when reproduction was disabled or inapplicable.
 */
export const ReproductionStabilitySchema = z.enum([
  'stable',
  'unstable',
  'not-reproduced',
  'inconclusive',
  'not-attempted',
])
export type ReproductionStability = z.infer<typeof ReproductionStabilitySchema>

export const ReproductionAssessmentSchema = z.object({
  experimentId: z.string(),
  sourceFindingIds: z.array(z.string()).default([]),
  attemptsRequested: z.number().int(),
  /** Attempts that actually executed (requested minus inconclusive-by-execution-failure). */
  attemptsCompleted: z.number().int(),
  reproduced: z.number().int(),
  notReproduced: z.number().int(),
  inconclusive: z.number().int(),
  stability: ReproductionStabilitySchema,
  granularity: ExperimentGranularitySchema,
  attempts: z.array(ReproductionAttemptSchema).default([]),
  stateIdentity: StateIdentitySchema,
  /**
   * False when the recorded state could not be rematerialized exactly (e.g.
   * working-tree fingerprint drift since verification): no execution happens,
   * stability is inconclusive. Never silently reproduce against a different
   * state and claim the original finding was reproduced.
   */
  stateMatched: z.boolean(),
})
export type ReproductionAssessment = z.infer<typeof ReproductionAssessmentSchema>

/** Bounded N-of-M configuration (attempt caps prevent "Regression Weekend"). */
export const ReproductionConfigSchema = z.object({
  attempts: z.number().int().min(1).max(10).default(5),
  timeoutMs: z.number().int().positive().default(30_000),
})
export type ReproductionConfig = z.infer<typeof ReproductionConfigSchema>
