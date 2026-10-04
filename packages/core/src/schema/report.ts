import { z } from 'zod'
import { FindingSchema } from './evidence'
import { PathAssessmentSchema } from './scope'
import { VerdictSchema } from './gate'

/** Reports carry an explicit schema version so consumers can evolve independently. */
export const REPORT_SCHEMA_VERSION = 1

/**
 * Regression status is structured so the Baseline Engine (M2) can report
 * pass/fail/partial outcomes with counts. M1 always emits `not-verified` —
 * honestly, since nothing has executed tests.
 */
export const RegressionStatusSchema = z.object({
  status: z.enum(['not-verified', 'pass', 'fail', 'partial']),
  /** Number of baseline tests compared (M2+). */
  baselineTests: z.number().int().optional(),
  /** Number of PASS -> FAIL transitions found (M2+). */
  regressionsFound: z.number().int().optional(),
})
export type RegressionStatus = z.infer<typeof RegressionStatusSchema>

export const ThreeQuestionsSchema = z.object({
  /**
   * Deterministic M1 slice: did the diff touch every must-change area? This
   * does NOT prove the requested feature works — only that every checkable
   * required change area was touched. M2+ should aggregate actual acceptance
   * evidence here rather than conflating "area changed" with "criterion
   * satisfied".
   */
  accomplished: z.enum(['yes', 'partial', 'no', 'unknown']),
  withinScope: z.enum(['yes', 'no', 'unknown']),
  /** Requires the Baseline Engine (M2). Reported honestly until then. */
  regressions: RegressionStatusSchema,
})
export type ThreeQuestions = z.infer<typeof ThreeQuestionsSchema>

export const ReportStatisticsSchema = z.object({
  filesChanged: z.number().int(),
  expected: z.number().int(),
  related: z.number().int(),
  suspicious: z.number().int(),
  outOfScope: z.number().int(),
  prohibited: z.number().int(),
  findings: z.number().int(),
})
export type ReportStatistics = z.infer<typeof ReportStatisticsSchema>

export const VerificationReportSchema = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  generatedAt: z.string(),
  contractId: z.string(),
  goal: z.string(),
  repoRoot: z.string(),
  before: z.string(),
  after: z.string(),
  beforeSha: z.string(),
  afterSha: z.string(),
  threeQuestions: ThreeQuestionsSchema,
  verdict: VerdictSchema,
  triggeredActions: z.array(z.string()).default([]),
  perPath: z.array(PathAssessmentSchema).default([]),
  findings: z.array(FindingSchema).default([]),
  statistics: ReportStatisticsSchema,
})
export type VerificationReport = z.infer<typeof VerificationReportSchema>
