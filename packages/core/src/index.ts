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

export { GitError } from './vcs/exec'
export { GitAdapter } from './vcs/git'
export { parseNameStatus, parseUnifiedDiff } from './vcs/parse'
export type { RawStatusEntry, UnifiedSection } from './vcs/parse'

export { runCommand } from './exec/run'
export type { RunOutcome } from './exec/run'

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

export { DEFAULT_POLICY, applyPolicy } from './gate/policy'

export { renderMarkdownReport } from './report/markdown'

export { verifyChange } from './pipeline'
export type { VerifyInput, VerifyOutput } from './pipeline'

export { nullAdvisor } from './advisor'
export type { ContractAdvisor } from './advisor'
