import { classifyPerTest, summarize } from './compare'
import type { BaselineSummary, TestCaseOutcome, TestTransition } from '../schema/baseline'
import { severityForClass, type Finding } from '../schema/evidence'
import { SERVICE_MANIFEST_FILE, type ProbeOutcome, type ProbeRunResult, type ServiceManifest } from '../schema/service'

/**
 * M5 Service Verification: the pure interpretation layer over executed probe
 * outcomes. This module never boots a service, never issues an HTTP request,
 * and never touches git — it maps already-recorded `ProbeOutcome`s onto the
 * SAME transition table the test baseline uses
 * (PASS -> FAIL regression, FAIL -> FAIL pre-existing, unknown -> partial)
 * and renders the deterministic findings plus the regressions-status
 * contribution. Probes are matched across sides by their declared `probeId`,
 * exactly like tests are matched by runner id.
 */

/** Short human-facing digest form (first 10 chars, like SHA prefixes). */
function shortDigest(digest: string): string {
  return digest.slice(0, 10)
}

/** Locale-independent deterministic string ordering. */
function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** One side's service-manifest state. `digest: null` means no manifest exists at this state. */
export interface ManifestSide {
  digest: string | null
  manifest: ServiceManifest | null
}

export interface ManifestComparison {
  mode: 'none' | 'comparable' | 'non-comparable'
  /** Present exactly when the mode is non-comparable. */
  reason?: string
}

/**
 * Can the before and after probe runs be compared at all? Both sides absent
 * -> none (the M5 layer has nothing to verify). Equal digests -> comparable.
 * Anything else (differing content, or a manifest on only one side) ->
 * non-comparable: each side ran its own declaration, so outcomes are of
 * limited comparability and the probe verdict is forced partial.
 *
 * Comparability is keyed on the digest; the parsed `manifest` is carried for
 * callers and never consulted here.
 */
export function compareManifests(before: ManifestSide, after: ManifestSide): ManifestComparison {
  const beforeDigest = before.digest
  const afterDigest = after.digest

  if (beforeDigest === null && afterDigest === null) {
    return { mode: 'none' }
  }
  if (beforeDigest !== null && afterDigest !== null) {
    return beforeDigest === afterDigest
      ? { mode: 'comparable' }
      : {
          mode: 'non-comparable',
          reason: `the service manifest differs between the compared states (before ${shortDigest(beforeDigest)} -> after ${shortDigest(afterDigest)})`,
        }
  }
  // Exactly one side declares a manifest (the both-null case returned above).
  return {
    mode: 'non-comparable',
    reason:
      beforeDigest === null
        ? `the service manifest is declared only after the change (digest ${shortDigest(afterDigest ?? '')})`
        : `the service manifest is declared only before the change (digest ${shortDigest(beforeDigest)})`,
  }
}

/** Map a probe outcome onto the test-outcome shape the shared transition table consumes. */
function toTestCase(outcome: ProbeOutcome): TestCaseOutcome {
  return {
    id: outcome.probeId,
    title: outcome.probeId,
    status: outcome.status,
    file: undefined,
  }
}

/**
 * Classify before/after probe outcomes with the SHARED transition table
 * (`classifyPerTest` + `summarize` semantics apply verbatim):
 *
 *   passed -> passed   preserved
 *   passed -> failed   regression
 *   failed -> failed   pre-existing failure (NOT a regression)
 *   failed -> passed   improvement
 *   missing/unknown    unknown — never silently treated as pass
 *
 * Probes that only exist after the change are new declarations, not
 * transitions (same rule as new tests).
 */
export function probeTransitions(before: ProbeOutcome[], after: ProbeOutcome[]): TestTransition[] {
  return classifyPerTest(before.map(toTestCase), after.map(toTestCase))
}

export interface ProbeFindingInput {
  beforeRun: ProbeRunResult
  afterRun: ProbeRunResult
  transitions: TestTransition[]
  summary: BaselineSummary
}

/** Per-report identifier counter: unique within one verification run. */
function createFindingIdFactory(prefix: 'SPROBE' | 'PPROBE' | 'SMAN') {
  let counter = 0
  return () => {
    counter += 1
    return `${prefix}-${String(counter).padStart(3, '0')}`
  }
}

/**
 * Deterministic findings from a probe comparison:
 * - `service-regression` (critical), one per regression transition (SPROBE-001...).
 * - `pre-existing-failure` (info), one grouped finding (PPROBE-001...).
 * - `service-manifest-changed` (info) when the two sides' manifest digests
 *   make the runs non-comparable (SMAN-001...).
 *
 * Pure and order-independent: transitions may arrive in any order; they are
 * canonically sorted by probe id, so equal inputs give deep-equal findings.
 * Evidence kind is 'api' throughout.
 */
export function buildProbeFindings(input: ProbeFindingInput): Finding[] {
  const { beforeRun, afterRun } = input
  const findings: Finding[] = []

  const nextRegressionId = createFindingIdFactory('SPROBE')
  const nextPreExistingId = createFindingIdFactory('PPROBE')
  const nextManifestId = createFindingIdFactory('SMAN')

  const experiment = `Experiment: ran the declared service probes against ${beforeRun.ref} and ${afterRun.ref} in isolated worktrees.`

  const ordered = [...input.transitions].sort((left, right) => compareStrings(left.id, right.id))

  for (const transition of ordered) {
    if (transition.kind !== 'regression') {
      continue
    }
    const afterProbe = afterRun.probes.find((probe) => probe.probeId === transition.id)
    const detail = afterProbe?.detail?.split('\n')[0]
    findings.push({
      id: nextRegressionId(),
      findingClass: 'service-regression',
      severity: severityForClass('service-regression'),
      message: `Probe "${transition.id}" passed at baseline and fails after the change.`,
      paths: [],
      evidence: {
        kind: 'api',
        claim: `Probe "${transition.id}" regressed: it passed before the change and fails after it.`,
        observation: `${experiment} Before: PASSED. After: FAILED${detail ? ` — ${detail}` : ''}.`,
        changedLines: [],
        reproduction: `probe "${transition.id}" (see ${SERVICE_MANIFEST_FILE})`,
      },
    })
  }

  if (input.summary.preExisting > 0) {
    const names = ordered
      .filter((transition) => transition.kind === 'pre-existing')
      .map((transition) => `"${transition.id}"`)
    findings.push({
      id: nextPreExistingId(),
      findingClass: 'pre-existing-failure',
      severity: severityForClass('pre-existing-failure'),
      message: `${input.summary.preExisting} baseline probe failure(s) pre-date this change and are not attributed to it: ${names.join(', ')}.`,
      paths: [],
      evidence: {
        kind: 'api',
        claim: 'These probe failures existed at the baseline revision; they are not regressions introduced by the change.',
        observation: `${experiment} FAIL -> FAIL for: ${names.join(', ')}.`,
        changedLines: [],
        reproduction: `probes ${names.join(', ')} (see ${SERVICE_MANIFEST_FILE})`,
      },
    })
  }

  const manifestComparison = compareManifests(
    { digest: beforeRun.manifestDigest, manifest: null },
    { digest: afterRun.manifestDigest, manifest: null },
  )
  if (manifestComparison.mode === 'non-comparable') {
    const beforeShort = shortDigest(beforeRun.manifestDigest)
    const afterShort = shortDigest(afterRun.manifestDigest)
    findings.push({
      id: nextManifestId(),
      findingClass: 'service-manifest-changed',
      severity: severityForClass('service-manifest-changed'),
      message: `The service manifest is not the same on both sides: before: ${beforeShort} -> after: ${afterShort}.`,
      paths: [SERVICE_MANIFEST_FILE],
      evidence: {
        kind: 'api',
        claim: 'The after state cannot silently redefine the probe baseline: each side executed its probes from its own declared manifest, so the outcomes are of limited comparability.',
        observation: `${experiment} Each side ran its own declared service manifest (before ${beforeShort} -> after ${afterShort}), so the probe outcomes are of limited comparability; the comparison is marked non-comparable and the probe verdict is forced to partial.`,
        changedLines: [],
        reproduction: `inspect ${SERVICE_MANIFEST_FILE} at both compared states`,
      },
    })
  }

  return findings
}

/** Per-side run facts consulted for run-level execution failures. */
export type ProbeStatusRun = Pick<ProbeRunResult, 'label' | 'servicesReady' | 'probes'>

export interface ProbeStatusInput {
  /** Probe transitions (from `probeTransitions`), classified with the shared table. */
  transitions: TestTransition[]
  /** Precomputed summary; derived from `transitions` via `summarize` when omitted. */
  summary?: BaselineSummary
  /** Manifest comparability mode (from `compareManifests`). */
  manifestMode: ManifestComparison['mode']
  /**
   * Per-side runs. A run counts as an execution failure when it declared
   * probes (the execution layer records them as unknown outcomes) yet no
   * service reached readiness — its probes could not actually execute.
   */
  runs: ProbeStatusRun[]
}

export interface ProbeStatusContribution {
  status: 'pass' | 'partial' | 'fail'
  /** Human-readable reasons; non-empty exactly when the status is partial. */
  incompleteReasons: string[]
}

/**
 * The probe layer's contribution to the overall regressions status —
 * conservative at every branch:
 *
 * - 'fail' when any PASS -> FAIL probe regression was observed (a regression
 *   is a regression even when other outcomes are inconclusive).
 * - 'partial' when any transition is unknown, when the manifest mode is
 *   non-comparable, or when a run declared probes but readied no service.
 * - 'pass' only when every probe transition was conclusive, comparable, and
 *   executed against ready services.
 *
 * A 'none' manifest mode with no declared probes contributes a neutral
 * 'pass'; whether the M5 layer applies to a change at all is the caller's
 * decision. Pure: no I/O, no clocks, deterministic reasons.
 */
export function probeBaselineStatus(input: ProbeStatusInput): ProbeStatusContribution {
  const summary = input.summary ?? summarize(input.transitions)

  if (summary.regressed > 0) {
    return { status: 'fail', incompleteReasons: [] }
  }

  const incompleteReasons: string[] = []
  if (summary.unknown > 0) {
    incompleteReasons.push(`${summary.unknown} baseline probe(s) have inconclusive outcomes after the change`)
  }
  for (const run of input.runs) {
    if (run.probes.length > 0 && run.servicesReady.length === 0) {
      incompleteReasons.push(
        `${run.label} probe run could not execute: no declared service reached readiness within its timeout`,
      )
    }
  }
  if (input.manifestMode === 'non-comparable') {
    incompleteReasons.push(
      'the service manifest changed between the compared states, so the before and after probe runs are not directly comparable',
    )
  }

  return incompleteReasons.length > 0
    ? { status: 'partial', incompleteReasons }
    : { status: 'pass', incompleteReasons: [] }
}
