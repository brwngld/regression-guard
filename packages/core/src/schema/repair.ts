import { z } from 'zod'
import { FindingSchema } from './evidence'
import { VerdictSchema } from './gate'
import { PathAssessmentSchema } from './scope'
import { ReproductionAssessmentSchema, StateIdentitySchema } from './reproduction'

/**
 * M4 Repair model. Regression Guard strengthens evidence and PREPARES
 * repairs; it never repairs code, never approves repairs, and never lets
 * impact analysis grant modification permission. The Repair Contract is a
 * PROPOSAL: authorization happens explicitly, outside the Guard.
 */

/**
 * Restoration is an operation constraint, not permission under another name:
 * 'restore-to-baseline' authorizes reverting the path toward the original
 * baseline state — never redesigning it. 'editable' is ordinary repair
 * latitude. 'prohibited' carries forward hard prohibitions.
 */
export const RepairPathModeSchema = z.enum(['editable', 'restore-to-baseline', 'prohibited'])
export type RepairPathMode = z.infer<typeof RepairPathModeSchema>

export const RepairPathConstraintSchema = z.object({
  path: z.string(),
  mode: RepairPathModeSchema,
})
export type RepairPathConstraint = z.infer<typeof RepairPathConstraintSchema>

export const RepairStateIdentitiesSchema = z.object({
  /** A — the known-good pre-change baseline the original contract compared from. */
  originalBaseline: StateIdentitySchema,
  /** B — the violating state the original verification judged. */
  violatingState: StateIdentitySchema,
})
export type RepairStateIdentities = z.infer<typeof RepairStateIdentitiesSchema>

export const RepairContractProposalSchema = z.object({
  /** A proposal only ever leaves the engine as 'proposed'. */
  status: z.literal('proposed'),
  proposedBy: z.literal('deterministic-evidence'),
  originalContractId: z.string(),
  verificationRunId: z.string(),
  verificationContextId: z.string(),
  targetFindingIds: z.array(z.string()).default([]),
  objectives: z.array(z.string()).default([]),
  pathConstraints: z.array(RepairPathConstraintSchema).default([]),
  /** Carried forward from the original contract's must-preserve rules. */
  mustPreserve: z.array(z.string()).default([]),
  /**
   * What the eventual repair change must prove. The dual-baseline rule:
   * B → C checks repair-scope integrity; A → C checks final behavioral
   * integrity against the known-good baseline.
   */
  evidenceRequired: z.array(z.string()).default([]),
  stateIdentities: RepairStateIdentitiesSchema,
  approvalNote: z.string(),
})
export type RepairContractProposal = z.infer<typeof RepairContractProposalSchema>

export const EvidencePackageImpactSchema = z.object({
  seeds: z.array(z.string()).default([]),
  affectedCount: z.number().int(),
  affectedTests: z.array(z.string()).default([]),
})
export type EvidencePackageImpact = z.infer<typeof EvidencePackageImpactSchema>

/**
 * The evidence-backed problem statement handed to a change producer: contract,
 * verdict, enriched findings, scope, impact chains, reproduction results, and
 * the repair proposal — an answer to "what exactly must be fixed and why",
 * not an invitation to modify the repository until tests turn green.
 */
export const EvidencePackageSchema = z.object({
  verificationRunId: z.string(),
  verificationContextId: z.string(),
  contractId: z.string(),
  goal: z.string(),
  verdict: VerdictSchema,
  findings: z.array(FindingSchema).default([]),
  scopeAssessment: z.array(PathAssessmentSchema).default([]),
  impact: EvidencePackageImpactSchema,
  reproductions: z.array(ReproductionAssessmentSchema).default([]),
  repairProposal: RepairContractProposalSchema,
})
export type EvidencePackage = z.infer<typeof EvidencePackageSchema>
