// Public API of the Regression Guard core engine.

export {
  SensitiveCategorySchema,
  PathRuleSchema,
  AcceptanceCriterionSchema,
  FindingClassSchema,
  PolicyActionSchema,
  ContractPathsSchema,
  ChangeContractSchema,
  ContractValidationError,
  CONTRACT_SCHEMA_VERSION,
  parseContract,
} from './schema/contract'
export type {
  SensitiveCategory,
  PathRule,
  AcceptanceCriterion,
  FindingClass,
  PolicyAction,
  ChangeContract,
} from './schema/contract'

export {
  ChangeStatusSchema,
  HunkSummarySchema,
  ChangeRecordSchema,
  DependencyChangeSchema,
  DependencyChangesSchema,
  ChangeSetSchema,
} from './schema/changeset'
export type {
  ChangeStatus,
  HunkSummary,
  ChangeRecord,
  DependencyChange,
  ChangeSet,
  EnrichedRecord,
  EnrichedChangeSet,
} from './schema/changeset'

export {
  ScopeClassificationSchema,
  PathAssessmentSchema,
  ScopeAssessmentSchema,
} from './schema/scope'
export type { ScopeClassification, PathAssessment, ScopeAssessment } from './schema/scope'

export { EvidenceSchema, EvidenceKindSchema, FindingSchema, severityForClass } from './schema/evidence'
export type { Evidence, EvidenceKind, Finding } from './schema/evidence'

export { VerdictSchema, GateDecisionSchema } from './schema/gate'
export type { Verdict, GateDecision } from './schema/gate'

export {
  ThreeQuestionsSchema,
  RegressionStatusSchema,
  ReportStatisticsSchema,
  VerificationReportSchema,
  REPORT_SCHEMA_VERSION,
} from './schema/report'
export type {
  ThreeQuestions,
  RegressionStatus,
  ReportStatistics,
  VerificationReport,
} from './schema/report'

export {
  ImpactLevelSchema,
  ReachabilitySchema,
  GraphOriginSchema,
  ImpactNodeSchema,
  AffectedTestSchema,
  UnresolvedEdgeSchema,
  ImpactCompletenessSchema,
  CoverageReviewSchema,
  PredictionReviewSchema,
  ImpactAssessmentSchema,
} from './schema/impact'
export type {
  ImpactLevel,
  Reachability,
  GraphOrigin,
  ImpactNode,
  AffectedTest,
  UnresolvedEdge,
  ImpactCompleteness,
  CoverageReview,
  PredictionReview,
  ImpactAssessment,
} from './schema/impact'

export {
  StateIdentitySchema,
  ExperimentKindSchema,
  ExperimentGranularitySchema,
  ReproductionCommandSchema,
  ReproductionExperimentSchema,
  AttemptOutcomeSchema,
  ReproductionAttemptSchema,
  ReproductionStabilitySchema,
  ReproductionAssessmentSchema,
  ReproductionConfigSchema,
} from './schema/reproduction'
export type {
  StateIdentity,
  ExperimentKind,
  ExperimentGranularity,
  ReproductionCommand,
  ReproductionExperiment,
  AttemptOutcome,
  ReproductionAttempt,
  ReproductionStability,
  ReproductionAssessment,
  ReproductionConfig,
} from './schema/reproduction'

export {
  RepairPathModeSchema,
  RepairPathConstraintSchema,
  RepairStateIdentitiesSchema,
  RepairContractProposalSchema,
  EvidencePackageImpactSchema,
  EvidencePackageSchema,
} from './schema/repair'
export type {
  RepairPathMode,
  RepairPathConstraint,
  RepairStateIdentities,
  RepairContractProposal,
  EvidencePackageImpact,
  EvidencePackage,
} from './schema/repair'

export {
  buildExperiments,
  runExperiments,
  aggregateAssessment,
  shellQuote,
  commandStringFor,
} from './reproduction/engine'
export type { ExperimentContext, AssessmentWithDetail } from './reproduction/engine'

export { verificationContextId, verificationRunId, canonicalJson } from './reproduction/identity'
export type { LineageInput } from './reproduction/identity'

export { buildEvidencePackage } from './repair/proposal'
export type { PackageInput } from './repair/proposal'

export { GitError } from './vcs/exec'
export { GitAdapter } from './vcs/git'
export { parseNameStatus, parseUnifiedDiff } from './vcs/parse'
export type { RawStatusEntry, UnifiedSection } from './vcs/parse'

export { runCommand, startProcess } from './exec/run'
export type { RunOutcome, RunningProcess } from './exec/run'

export {
  TestStatusSchema,
  TestCaseOutcomeSchema,
  TestRunResultSchema,
  BaselineSummarySchema,
  BaselineComparisonSchema,
  TransitionKindSchema,
} from './schema/baseline'
export type {
  TestStatus,
  TestCaseOutcome,
  TestRunResult,
  BaselineSummary,
  BaselineComparison,
  TransitionKind,
  TestTransition,
} from './schema/baseline'
export { discoverTestCommand, packageJsonHasDependencies } from './baseline/discover'
export type { TestCommandPlan } from './baseline/discover'
export { parseRunnerJson } from './baseline/parse'
export { classifyPerTest, classifySuite, summarize, suiteStatusOf } from './baseline/compare'
export type { SuiteStatus } from './baseline/compare'
export { runBaselineVerification } from './baseline/runner'
export type { BaselineOptions, BaselineOutcome } from './baseline/runner'

export {
  buildGraph,
  collectJsImports,
  isTestPath,
  refReader,
  workingTreeReader,
} from './intel/graph'
export type { FileKind, FileNode, DependencyGraph, RepoReader } from './intel/graph'
export {
  isRelativeSpecifier,
  packageNameOf,
  resolveSpecifier,
  normalizePath,
} from './intel/resolve'

export { categorizePath, diffDependencies, enrichChangeSet } from './analyzer/change'
export { analyzeScope } from './analyzer/scope'
export type { ScopeResult } from './analyzer/scope'
export { computeImpact } from './analyzer/impact'
export type { ImpactSeed, ImpactGraphs, ImpactModel } from './analyzer/impact'

export { DEFAULT_POLICY, applyPolicy } from './gate/policy'

export { renderMarkdownReport } from './report/markdown'

export { verifyChange } from './pipeline'
export type { VerifyInput, VerifyOutput } from './pipeline'

export { nullAdvisor } from './advisor'
export type { ContractAdvisor } from './advisor'

export {
  ServiceReadinessSchema,
  ServiceDeclarationSchema,
  ProbeExpectationSchema,
  ProbeDeclarationSchema,
  ServiceManifestSchema,
  ProbeOutcomeSchema,
  ProbeRunResultSchema,
  SERVICE_MANIFEST_FILE,
} from './schema/service'
export type {
  ServiceReadiness,
  ServiceDeclaration,
  ProbeExpectation,
  ProbeDeclaration,
  ServiceManifest,
  ProbeOutcome,
  ProbeRunResult,
} from './schema/service'

export { evaluateProbe } from './service/probe-eval'
export type { ProbeResponse, ProbeEvaluation } from './service/probe-eval'
export { parseServiceManifest, manifestDigest } from './service/manifest'
export { runServiceProbes } from './service/runtime'
export type { ProbeExecutionOptions, ServicePhaseResult } from './service/runtime'

export { compareManifests, probeTransitions, buildProbeFindings, probeBaselineStatus } from './baseline/probes'
export type {
  ManifestSide,
  ManifestComparison,
  ProbeFindingInput,
  ProbeStatusRun,
  ProbeStatusInput,
  ProbeStatusContribution,
} from './baseline/probes'
