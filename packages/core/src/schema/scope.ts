import { z } from 'zod'

/**
 * Authorization verdict for a single changed path: "should this have changed?"
 * (Impact — "what could it affect?" — is a separate question and a later milestone.)
 */
export const ScopeClassificationSchema = z.enum([
  'EXPECTED',
  'RELATED',
  'SUSPICIOUS',
  'OUT_OF_SCOPE',
  'PROHIBITED',
])
export type ScopeClassification = z.infer<typeof ScopeClassificationSchema>

export const PathAssessmentSchema = z.object({
  path: z.string(),
  status: z.string(),
  classification: ScopeClassificationSchema,
  /** Machine-readable explanation, e.g. `glob:src/style.css` or `imported-by:src/main.js`. */
  reason: z.string(),
})
export type PathAssessment = z.infer<typeof PathAssessmentSchema>

export const ScopeAssessmentSchema = z.object({
  perPath: z.array(PathAssessmentSchema),
})
export type ScopeAssessment = z.infer<typeof ScopeAssessmentSchema>
