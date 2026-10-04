import { z } from 'zod'
import { FindingSchema } from './evidence'
import { PathAssessmentSchema } from './scope'
import { VerdictSchema } from './gate'

export const ThreeQuestionsSchema = z.object({
  /** Deterministic M1 slice: did the diff touch every must-change area? */
  accomplished: z.enum(['yes', 'partial', 'no', 'unknown']),
  withinScope: z.enum(['yes', 'no', 'unknown']),
  /** Requires the Baseline Engine (M2). Reported honestly until then. */
  regressions: z.literal('not-verified'),
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
