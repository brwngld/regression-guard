import { z } from 'zod'
import { FindingSchema } from './evidence'

export const VerdictSchema = z.enum(['ACCEPT', 'WARN', 'REVIEW', 'REJECT'])
export type Verdict = z.infer<typeof VerdictSchema>

export const GateDecisionSchema = z.object({
  verdict: VerdictSchema,
  /** Actions that were triggered, worst first. */
  triggeredActions: z.array(z.enum(['accept', 'warn', 'review', 'reject'])).default([]),
  /**
   * The findings behind the decision, ordered worst-policy-action first. The
   * gate owns the reasons for its decision; consumers should not have to
   * reconstruct them from elsewhere.
   */
  findings: z.array(FindingSchema).default([]),
})
export type GateDecision = z.infer<typeof GateDecisionSchema>
