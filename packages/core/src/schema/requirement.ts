import { z } from 'zod'
import { ExperimentReferenceSchema } from './contract'

/**
 * Requirement Verification result model (Doc 1 — claim/evidence/binding
 * model). This layer is pure composition over evidence the engine already
 * produced: a clause is VERIFIED only when every bound experiment ran against
 * the recorded after-state, as an established approved instrument (definition
 * identity anchored at the before state and unchanged), and passed (I1).
 * Everything else is UNVERIFIED with a reason — never inferred away (I3).
 */

export const REQUIREMENT_SCHEMA_VERSION = 1

/**
 * Why a clause is UNVERIFIED (Doc 1 §4 — reason variants surfaced distinctly,
 * plus the observability/result facts the composition layer honestly reports).
 */
export const UnverifiedReasonSchema = z.enum([
  /** The clause declares no experiment binding at all. */
  'no-binding',
  /** The bound kind is reserved and not yet executable (dom-flow pre-M5c). */
  'unbound-kind',
  /** The referenced instrument does not resolve at the compared states. */
  'unresolved',
  /** The instrument's definition identity drifted from its before anchor. */
  'instrument-modified',
  /** The instrument has no before-state definition identity (I9). */
  'experiment-new',
  /** The (clause, reference) association changed since the before-state contract. */
  'binding-changed',
  /** The runner cannot attribute outcomes to individual test ids (suite mode). */
  'unknown-observability',
  /** The instrument ran but its outcome was inconclusive. */
  'unknown-outcome',
])
export type UnverifiedReason = z.infer<typeof UnverifiedReasonSchema>

export const RequirementStatusSchema = z.enum(['verified', 'failed', 'unverified'])
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>

/** How one bound experiment resolved at the verified after-state. */
export const ExperimentResolutionSchema = z.object({
  reference: ExperimentReferenceSchema,
  /**
   * Provenance of the instrument (Doc 1 §5): 'established' anchors at the
   * before state unchanged; 'modified' drifted from that anchor; 'new' has no
   * before-state definition identity (never counts toward VERIFIED, I9); the
   * remaining values record why no provenance could be established.
   */
  provenance: z.enum([
    'established',
    'modified',
    'new',
    'unresolved',
    'unbound-kind',
    'unknown-observability',
  ]),
  /** Execution result recorded at the after state, when the experiment ran. */
  result: z.enum(['passed', 'failed', 'unknown']).optional(),
  /** This experiment's insufficient reasons (sorted, deduped). */
  reasons: z.array(UnverifiedReasonSchema).default([]),
  /** Human-readable resolution detail (resolved file, definition digests). */
  detail: z.string().optional(),
})
export type ExperimentResolution = z.infer<typeof ExperimentResolutionSchema>

export const RequirementClauseResultSchema = z.object({
  clauseId: z.string(),
  description: z.string(),
  status: RequirementStatusSchema,
  /** Sorted, deduped union of the bound experiments' insufficient reasons. */
  reasons: z.array(UnverifiedReasonSchema).default([]),
  experiments: z.array(ExperimentResolutionSchema).default([]),
})
export type RequirementClauseResult = z.infer<typeof RequirementClauseResultSchema>

export const RequirementCoverageSchema = z.object({
  total: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unverified: z.number().int().nonnegative(),
})
export type RequirementCoverage = z.infer<typeof RequirementCoverageSchema>

export const RequirementVerificationSchema = z.object({
  schemaVersion: z.literal(REQUIREMENT_SCHEMA_VERSION),
  clauses: z.array(RequirementClauseResultSchema),
  coverage: RequirementCoverageSchema,
})
export type RequirementVerification = z.infer<typeof RequirementVerificationSchema>
