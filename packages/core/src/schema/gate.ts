import { z } from 'zod'

export const VerdictSchema = z.enum(['ACCEPT', 'WARN', 'REVIEW', 'REJECT'])
export type Verdict = z.infer<typeof VerdictSchema>

export const GateDecisionSchema = z.object({
  verdict: VerdictSchema,
  /** Actions that were triggered, worst first. */
  triggeredActions: z.array(z.enum(['accept', 'warn', 'review', 'reject'])).default([]),
})
export type GateDecision = z.infer<typeof GateDecisionSchema>
