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
  /**
   * M5b.1: per-probe contract divergence (from divergedContractProbes).
   * Diverged probes are EXCLUDED from regression/pre-existing attribution —
   * each side ran under a different promise, so a transition between them
   * cannot be attributed to the change. They surface via api-contract-changed
   * and force partial instead.
   */
  diverged?: DivergedContract[]
}

/** Per-report identifier counter: unique within one verification run. */
function createFindingIdFactory(prefix: 'SPROBE' | 'APROBE' | 'PPROBE' | 'SMAN' | 'ACON') {
  let counter = 0
  return () => {
    counter += 1
    return `${prefix}-${String(counter).padStart(3, '0')}`
  }
}

/**
 * M5b.1/M5b.2: contract comparability is a property of EACH contract-backed
 * probe's COMPLETE contract identity, never of the service phase as a whole.
 * The digest answers "is the referenced document the same content?"; file,
 * method, path, and status answer "is this the same contract operation?" —
 * separate facts, both required for comparability. A null digest (document
 * missing/unparseable) is NOT a divergence — the probe itself reports unknown
 * with details. Probes backed by other documents stay fully comparable.
 */
export interface DivergedContract {
  probeId: string
  file: string
  /** Non-null by construction: entries exist only when both digests resolved. */
  beforeDigest: string
  afterDigest: string
  /** Which identity components changed, sorted (file | document | method | path | status). */
  changedComponents: string[]
  /** Human-readable before/after summary of the operation reference. */
  beforeOperation: string
  afterOperation: string
}

function operationLabel(identity: NonNullable<ProbeOutcome['contractIdentity']>): string {
  return `${identity.method} ${identity.path} ${identity.status} (${identity.file})`
}

export function divergedContractProbes(beforeRun: ProbeRunResult, afterRun: ProbeRunResult): DivergedContract[] {
  const beforeById = new Map(beforeRun.probes.map((probe) => [probe.probeId, probe]))
  const diverged: DivergedContract[] = []
  for (const afterProbe of afterRun.probes) {
    if (afterProbe.expectation !== 'contract' || afterProbe.contractIdentity === undefined) continue
    const beforeProbe = beforeById.get(afterProbe.probeId)
    if (beforeProbe?.expectation !== 'contract' || beforeProbe.contractIdentity === undefined) continue
    const before = beforeProbe.contractIdentity
    const after = afterProbe.contractIdentity
    // M5b.1 invariant, enforced BEFORE any dimension comparison: a null
    // digest on either side means the document is unresolved — we do not
    // possess a complete contract identity on that side, so no divergence may
    // be inferred from the remaining fields. The probe itself reports unknown
    // with details; unknown is not divergence.
    if (before.documentDigest === null || after.documentDigest === null) continue
    const changedComponents = [
      before.file !== after.file ? 'file' : null,
      before.documentDigest !== after.documentDigest ? 'document' : null,
      before.method !== after.method ? 'method' : null,
      before.path !== after.path ? 'path' : null,
      before.status !== after.status ? 'status' : null,
    ].filter((component): component is string => component !== null)
    if (changedComponents.length === 0) continue
    diverged.push({
      probeId: afterProbe.probeId,
      file: after.file,
      beforeDigest: before.documentDigest,
      afterDigest: after.documentDigest,
      changedComponents,
      beforeOperation: operationLabel(before),
      afterOperation: operationLabel(after),
    })
  }
  return diverged.sort((left, right) => (left.probeId < right.probeId ? -1 : left.probeId > right.probeId ? 1 : 0))
}

/**
 * Deterministic findings from a probe comparison:
 * - `service-regression` (critical), one per INLINE regression transition
 *   (SPROBE-001...), evidence kind 'api'.
 * - `api-contract-regression` (critical), one per CONTRACT regression
 *   transition (APROBE-001...), evidence kind 'api-contract' — routing keys on
 *   the AFTER outcome's expectation, the declaration that produced the verdict.
 * - `pre-existing-failure` (info), one grouped finding (PPROBE-001...); when
 *   the group mixes contract and inline probes, the text says so.
 * - `service-manifest-changed` (info) when the two sides' manifest digests
 *   make the runs non-comparable (SMAN-001...).
 * - `api-contract-changed` (info) when both sides ran contract probes against
 *   differing recorded OpenAPI documents (ACON-001...).
 *
 * Pure and order-independent: transitions may arrive in any order; they are
 * canonically sorted by probe id, so equal inputs give deep-equal findings.
 */
export function buildProbeFindings(input: ProbeFindingInput): Finding[] {
  const { beforeRun, afterRun } = input
  const findings: Finding[] = []

  const nextRegressionId = createFindingIdFactory('SPROBE')
  const nextContractRegressionId = createFindingIdFactory('APROBE')
  const nextPreExistingId = createFindingIdFactory('PPROBE')
  const nextManifestId = createFindingIdFactory('SMAN')
  const nextContractId = createFindingIdFactory('ACON')

  const experiment = `Experiment: ran the declared service probes against ${beforeRun.ref} and ${afterRun.ref} in isolated worktrees.`

  // M5b.1: diverged-contract probes are excluded from regression/pre-existing
  // attribution — each side ran under a different promise, so a transition
  // between them cannot be attributed to the change. They surface via
  // api-contract-changed and force partial instead.
  const divergedIds = new Set((input.diverged ?? []).map((entry) => entry.probeId))
  const ordered = [...input.transitions]
    .filter((transition) => !divergedIds.has(transition.id))
    .sort((left, right) => compareStrings(left.id, right.id))

  for (const transition of ordered) {
    if (transition.kind !== 'regression') {
      continue
    }
    const afterProbe = afterRun.probes.find((probe) => probe.probeId === transition.id)
    const detail = afterProbe?.detail?.split('\n')[0]
    if (afterProbe?.expectation === 'contract') {
      findings.push({
        id: nextContractRegressionId(),
        findingClass: 'api-contract-regression',
        severity: severityForClass('api-contract-regression'),
        message: `Probe "${transition.id}" violated the declared API contract: it passed at baseline and fails after the change.`,
        paths: [],
        evidence: {
          kind: 'api-contract',
          claim: `Probe "${transition.id}" violated the declared API contract: it passed before the change and fails after it.`,
          observation: `${experiment} Before: PASSED. After: FAILED${detail ? ` — ${detail}` : ''} (validated against the recorded OpenAPI operation).`,
          changedLines: [],
          reproduction: `probe "${transition.id}" (see ${SERVICE_MANIFEST_FILE})`,
        },
      })
      continue
    }
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
    const preExisting = ordered.filter((transition) => transition.kind === 'pre-existing')
    const names = preExisting.map((transition) => `"${transition.id}"`)
    const expectationOf = (id: string) =>
      afterRun.probes.find((probe) => probe.probeId === id)?.expectation
    const contractNames = preExisting
      .filter((transition) => expectationOf(transition.id) === 'contract')
      .map((transition) => `"${transition.id}"`)
    const inlineNames = preExisting
      .filter((transition) => expectationOf(transition.id) !== 'contract')
      .map((transition) => `"${transition.id}"`)
    // Mixed groups stay ONE finding; the text carries the split so a reader can
    // tell contract-sourced failures (spec-declared) from inline ones.
    const mixedNote =
      contractNames.length > 0 && inlineNames.length > 0
        ? ` (contract-sourced: ${contractNames.join(', ')}; inline: ${inlineNames.join(', ')})`
        : ''
    findings.push({
      id: nextPreExistingId(),
      findingClass: 'pre-existing-failure',
      severity: severityForClass('pre-existing-failure'),
      message: `${input.summary.preExisting} baseline probe failure(s) pre-date this change and are not attributed to it: ${names.join(', ')}${mixedNote}.`,
      paths: [],
      evidence: {
        kind: 'api',
        claim: 'These probe failures existed at the baseline revision; they are not regressions introduced by the change.',
        observation: `${experiment} FAIL -> FAIL for: ${names.join(', ')}${mixedNote}.`,
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

  // M5b.1/M5b.2: per-probe contract divergence over the COMPLETE identity.
  // Only the probes whose own contract reference changed become
  // non-comparable; probes with unchanged identities keep their full
  // transitions above. The finding names the affected probe, which identity
  // components changed, and the before/after operation reference, so the
  // reader knows exactly which declared promise changed and how.
  const diverged = input.diverged ?? []
  if (diverged.length > 0) {
    const entries = diverged.map(
      (entry) =>
        `"${entry.probeId}" [${entry.changedComponents.join('+')}]: ${entry.beforeOperation} -> ${entry.afterOperation}`,
    )
    findings.push({
      id: nextContractId(),
      findingClass: 'api-contract-changed',
      severity: severityForClass('api-contract-changed'),
      message: `The declared contract reference changed for ${diverged.length === 1 ? 'probe' : 'probes'} ${entries.join(', ')}; each side was executed against its own recorded contract, so ${diverged.length === 1 ? 'its outcome is' : 'their outcomes are'} of limited comparability.`,
      paths: [...new Set(diverged.map((entry) => entry.file))].sort(),
      evidence: {
        kind: 'api-contract',
        claim: 'The after state cannot silently redefine what the API promised: probes whose contract identity (document, operation, or expected status) changed ran against different promises on each side, so their transitions are excluded from regression attribution.',
        observation: `${experiment} Contract identity diverged for ${entries.join(', ')}; those probes are reported non-comparable (forced partial) instead of attributed. Probes with unchanged contract identities remain fully comparable.`,
        changedLines: [],
        reproduction: `inspect the OpenAPI document(s) referenced by ${SERVICE_MANIFEST_FILE} at both compared states`,
      },
    })
  }

  return findings
}

/**
 * The `service-manifest-invalid` finding (info): a side DECLARED a service
 * manifest that cannot be loaded (unparseable YAML / schema-invalid), so no
 * declared probes executed on either side and the probe contribution is forced
 * partial — visible, never worsening. Absent manifests never reach here:
 * "nothing was declared" and "something invalid was declared" are different
 * facts with different remedies. Pure; the id is stable (one per run).
 */
export function buildManifestInvalidFinding(
  /** Invalid sides in before-then-after order; each carries its load errors. */
  sides: ReadonlyArray<{ label: 'before' | 'after'; errors: string[] }>,
): Finding {
  const described = sides.map((side) => `${side.label}: ${side.errors[0] ?? 'no error reported'}`)
  const sideNames =
    sides.length === 1 && sides[0] !== undefined ? `the ${sides[0].label} side` : 'both sides'
  return {
    id: 'SMINV-001',
    findingClass: 'service-manifest-invalid',
    severity: severityForClass('service-manifest-invalid'),
    message: `The service manifest is invalid on ${sideNames} (${described.join('; ')}); its declared probes did not execute.`,
    paths: [SERVICE_MANIFEST_FILE],
    evidence: {
      kind: 'api',
      claim: 'A declared-but-unloadable manifest means its probes never executed: the comparison is marked non-comparable and the probe verdict is forced to partial, never silently passed.',
      observation: `Experiment: read ${SERVICE_MANIFEST_FILE} from both compared states in isolated worktrees; load failed for ${described.join('; ')}. No declared probes were executed.`,
      changedLines: [],
      reproduction: `validate ${SERVICE_MANIFEST_FILE} at both compared states`,
    },
  }
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
   * M5b.1: per-probe contract divergence (from `divergedContractProbes`).
   * Affected probes ran under different promises on each side; their
   * comparability is limited, so the contribution is forced partial with one
   * reason naming each affected probe.
   */
  diverged?: DivergedContract[]
  /**
   * True when a side DECLARED a manifest that could not be loaded
   * (`loadServiceManifest` invalid): its probes did not execute. Subsumes the
   * generic non-comparable reason — "invalid" is the more precise fact.
   */
  manifestInvalid?: boolean
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
 *   non-comparable, when a run declared probes but readied no service, when a
 *   declared manifest could not be loaded, or when the recorded API contracts
 *   diverge across sides.
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
  if (input.manifestInvalid) {
    incompleteReasons.push(
      'the service manifest is invalid on at least one side, so its declared probes did not execute',
    )
  } else if (input.manifestMode === 'non-comparable') {
    incompleteReasons.push(
      'the service manifest changed between the compared states, so the before and after probe runs are not directly comparable',
    )
  }
  if ((input.diverged ?? []).length > 0) {
    const names = (input.diverged ?? []).map((entry) => `"${entry.probeId}" (${entry.file})`).join(', ')
    incompleteReasons.push(
      `the referenced API contract changed for probe(s) ${names}, so their outcomes are of limited comparability`,
    )
  }

  return incompleteReasons.length > 0
    ? { status: 'partial', incompleteReasons }
    : { status: 'pass', incompleteReasons: [] }
}
