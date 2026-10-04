import { z } from 'zod'

/**
 * M3 Impact Model. Impact answers: "given the changes that actually occurred,
 * what parts of the system could reasonably be affected?" — a different
 * question from Scope ("should this have changed?") and from Baseline
 * ("did known behavior regress?"). The model is derived deterministically
 * from the ChangeSet (all records, regardless of scope classification) and
 * reverse dependency traversal. It informs reporting only: it never gates and
 * never reduces M2's baseline execution.
 */

export const ImpactLevelSchema = z.enum(['DIRECT', 'HIGH', 'MEDIUM', 'LOW'])
export type ImpactLevel = z.infer<typeof ImpactLevelSchema>

/**
 * Structural reachability of a node. 'no-graph-evidence' means the dependency
 * graph cannot speak about this path (e.g. a changed binary/config file with
 * no graph node) — unknown, never safe. A changed file stays DIRECT even when
 * its reachability is unknown: DIRECT states that the file itself changed.
 */
export const ReachabilitySchema = z.enum(['known', 'no-graph-evidence'])
export type Reachability = z.infer<typeof ReachabilitySchema>

/** Which repository state's graph produced a node's relationships. */
export const GraphOriginSchema = z.enum(['after', 'before', 'both'])
export type GraphOrigin = z.infer<typeof GraphOriginSchema>

export const ImpactNodeSchema = z.object({
  path: z.string(),
  changed: z.boolean(),
  level: ImpactLevelSchema,
  /** Minimum graph distance from any seed (0 for the changed files themselves). */
  distance: z.number().int(),
  reachability: ReachabilitySchema,
  origin: GraphOriginSchema.default('after'),
  /** Up to three shortest evidence chains, seed -> ... -> node (inclusive). */
  via: z.array(z.array(z.string())).default([]),
  /** Seeds that can reach this node. */
  sources: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
})
export type ImpactNode = z.infer<typeof ImpactNodeSchema>

export const AffectedTestSchema = z.object({
  path: z.string(),
  sources: z.array(z.string()).default([]),
  /** Evidence chains seed -> ... -> test (print reversed for humans). */
  evidencePaths: z.array(z.array(z.string())).default([]),
})
export type AffectedTest = z.infer<typeof AffectedTestSchema>

export const UnresolvedEdgeSchema = z.object({
  from: z.string(),
  specifier: z.string(),
  kind: z.enum(['unresolved-import', 'dynamic-import']),
})
export type UnresolvedEdge = z.infer<typeof UnresolvedEdgeSchema>

export const ImpactCompletenessSchema = z.enum(['complete', 'partial'])
export type ImpactCompleteness = z.infer<typeof ImpactCompletenessSchema>

export const CoverageReviewSchema = z.object({
  /** Impacted non-test, non-seed areas (the blast radius proper). */
  affectedAreas: z.number().int(),
  coveredAreas: z.number().int(),
  uncoveredAreas: z.number().int(),
  coveragePercent: z.number(),
  covered: z.array(z.string()).default([]),
  uncovered: z.array(z.string()).default([]),
})
export type CoverageReview = z.infer<typeof CoverageReviewSchema>

/**
 * Measurement of Impact Analyzer quality against M2's observed regressions.
 * Report intelligence only: prediction misses indicate analyzer incompleteness
 * and must never become gate findings — M2 already handles real regressions.
 */
export const PredictionReviewSchema = z.object({
  mode: z.enum(['per-test', 'suite', 'not-applicable']),
  predictedTests: z.number().int(),
  observedRegressions: z.number().int(),
  predictedRegressions: z.number().int(),
  predictionMisses: z
    .array(z.object({ test: z.string(), file: z.string().optional() }))
    .default([]),
})
export type PredictionReview = z.infer<typeof PredictionReviewSchema>

export const ImpactAssessmentSchema = z.object({
  /** All actually-changed canonical paths (and rename old paths). */
  seeds: z.array(z.string()).default([]),
  affected: z.array(ImpactNodeSchema).default([]),
  affectedTests: z.array(AffectedTestSchema).default([]),
  coverage: CoverageReviewSchema,
  /**
   * Unresolved relationships originating inside the impact region: from a
   * changed seed or a node the traversal reached, in the graph that traversal
   * used (deletions consult the BEFORE region, modifications/creations the
   * AFTER region, renames both). Only these can make completeness partial.
   */
  unresolvedEdges: z.array(UnresolvedEdgeSchema).default([]),
  /** All unresolved relationships found in the repository graphs, impact-relevant or not. */
  repositoryUnresolvedEdges: z.array(UnresolvedEdgeSchema).default([]),
  completeness: ImpactCompletenessSchema,
  predictionReview: PredictionReviewSchema.optional(),
})
export type ImpactAssessment = z.infer<typeof ImpactAssessmentSchema>
