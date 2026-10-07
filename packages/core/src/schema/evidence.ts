import { z } from 'zod'
import { FindingClassSchema, type FindingClass } from './contract'
import { ReproductionAssessmentSchema } from './reproduction'

/**
 * Discriminator for how the evidence was produced. M1 emits only `diff` and
 * `dependency`; later milestones add test/runtime/browser/api observations
 * without redefining what an Evidence object is.
 */
export const EvidenceKindSchema = z.enum(['diff', 'dependency', 'test', 'runtime', 'browser', 'api', 'api-contract'])
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>

export const EvidenceSchema = z.object({
  kind: EvidenceKindSchema,
  /** What the system claims, in one sentence. */
  claim: z.string(),
  /** What was directly observed (diff facts, dependency facts, test outcomes). */
  observation: z.string(),
  /** Hunk coordinates per offending file, when diff-level evidence exists. */
  changedLines: z
    .array(
      z.object({
        file: z.string(),
        hunks: z
          .array(
            z.object({
              before: z.string(),
              after: z.string(),
              added: z.number().int(),
              removed: z.number().int(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  /** A command a human can run to reproduce the observation. */
  reproduction: z.string(),
})
export type Evidence = z.infer<typeof EvidenceSchema>

export const FindingSchema = z.object({
  /** Stable per-report identifier, e.g. SCOPE-001. */
  id: z.string(),
  findingClass: FindingClassSchema,
  severity: z.enum(['info', 'warn', 'critical']),
  message: z.string(),
  paths: z.array(z.string()).default([]),
  evidence: EvidenceSchema,
  /**
   * M4 enrichment: reproduction results qualify the finding's stability.
   * Evidence only — no reproduction outcome ever deletes, downgrades, or
   * re-gates the original observation.
   */
  reproduction: ReproductionAssessmentSchema.optional(),
})
export type Finding = z.infer<typeof FindingSchema>

export function severityForClass(findingClass: FindingClass | string): 'info' | 'warn' | 'critical' {
  switch (findingClass) {
    case 'prohibited-change':
    case 'preserved-area-changed':
    case 'test-regression':
    case 'service-regression':
    case 'api-contract-regression':
      return 'critical'
    case 'changed-dependency':
    case 'pre-existing-failure':
    case 'baseline-incomplete':
    case 'test-command-changed':
    case 'service-manifest-changed':
    case 'api-contract-changed':
    case 'service-manifest-invalid':
    case 'dependency-state-unknown':
      return 'info'
    case 'test-coverage-reduced':
      // H2: shrunken executed coverage is a warning — real evidence loss, but
      // not a deterministic behavioral violation.
      return 'warn'
    default:
      return 'warn'
  }
}
