import { SERVICE_MANIFEST_FILE, type ProbeOutcome } from '../schema/service'
import type { AcceptanceCriterion, ExperimentReference } from '../schema/contract'
import { severityForClass, type Finding } from '../schema/evidence'
import type { TestCaseOutcome } from '../schema/baseline'
import {
  REQUIREMENT_SCHEMA_VERSION,
  type ExperimentResolution,
  type RequirementClauseResult,
  type RequirementCoverage,
  type UnverifiedReason,
} from '../schema/requirement'

/**
 * Requirement Verification (Doc 1 — claim/evidence/binding model): pure
 * composition over evidence the engine ALREADY produced. It joins a clause's
 * contract bindings to existing per-test outcomes (baseline, per-test mode)
 * and probe outcomes (service phase), applies the Doc 1 §4 clause state
 * machine, and emits findings plus the per-clause results behind the
 * "Requirement verification" report section. It runs NO new experiments: any
 * required evidence that is unavailable leaves the clause UNVERIFIED with that
 * reason — never guessed (I3, I5).
 *
 * The only claim this layer is allowed to make (Doc 1 §1, I1):
 *   clause VERIFIED ⇔ every bound experiment ran against the recorded
 *   after-state, as an established approved instrument — one whose definition
 *   identity is anchored at the before state and unchanged — and passed.
 */

/** Whole-file definition digest per compared state; null = unreadable (unknown, not divergence, not novelty — I9). */
export type DefinitionDigestReader = (
  state: 'before' | 'after',
  path: string,
) => Promise<string | null>

export interface RequirementProbeSide {
  /** Executed outcomes recorded at this state, by probeId. */
  outcomes: ReadonlyMap<string, ProbeOutcome>
  /**
   * Definition identity per DECLARED probe at this state (Doc 1 §2.3).
   * Presence in the map establishes the probe was declared; a null identity
   * means the declaration exists but could not be resolved (unreadable
   * document). An empty map with `declarationsKnown: true` establishes that
   * NOTHING was declared (absent manifest).
   */
  definitionIdentities: ReadonlyMap<string, string | null>
  /**
   * False when the declared probe set is unknowable at this state (invalid
   * manifest, or the service phase never ran): probe absence then cannot be
   * distinguished from unavailability, so it resolves unresolved — never
   * experiment-new (I9's epistemic guard).
   */
  declarationsKnown: boolean
}

export interface RequirementTestSide {
  /** False when only suite-level outcomes exist: test ids cannot be resolved (Doc 1 §3). */
  perTest: boolean
  tests: readonly TestCaseOutcome[]
}

export interface RequirementSideInputs {
  tests: RequirementTestSide
  probes: RequirementProbeSide
}

export interface RequirementInputs {
  before: RequirementSideInputs
  after: RequirementSideInputs
  /** Repo-relative paths this change deleted (context for unresolved detail). */
  deletedPaths: readonly string[]
  /** Whole-file test definition digests per state (Doc 1 §2.3 deliberate granularity). */
  fileDigest: DefinitionDigestReader
  /**
   * Normalized binding sets (sorted reference identities per clause id) of the
   * repo-tracked before-state contract, or null when no drift check applies:
   * the contract path is unknown, outside the repo, or absent at the before
   * state — binding identity is then established at the governing approval
   * (Doc 1 §2.6 new-contract provenance, I8).
   */
  beforeBindings: ReadonlyMap<string, readonly string[]> | null
  /** Repo-relative contract path, when known (drift findings point at it). */
  contractPath?: string
}

export interface RequirementAnalysis {
  schemaVersion: typeof REQUIREMENT_SCHEMA_VERSION
  clauses: RequirementClauseResult[]
  coverage: RequirementCoverage
  findings: Finding[]
  /**
   * Doc 1 §6, question 1: any clause FAILED -> 'no'; all clauses VERIFIED ->
   * 'yes'; otherwise 'partial' — clauses declared but unverified are
   * uncertainty, not failure, and never success.
   */
  accomplishedContribution: 'yes' | 'partial' | 'no'
}

/** Locale-independent deterministic string ordering. */
function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function shortDigest(digest: string): string {
  return digest.slice(0, 10)
}

function dedupeSorted(values: readonly UnverifiedReason[]): UnverifiedReason[] {
  return [...new Set(values)].sort(compareStrings)
}

/**
 * Canonical reference identity of one experiment binding (Doc 1 §2.3): the
 * stable address used by binding sets and reports. An omitted probe manifest
 * normalizes to the conventional manifest file, so both spellings of the same
 * instrument share one binding identity.
 */
export function normalizeReferenceIdentity(reference: ExperimentReference): string {
  switch (reference.kind) {
    case 'test':
      return `test:${reference.id}`
    case 'probe':
      return `probe:${reference.manifest ?? SERVICE_MANIFEST_FILE}:${reference.probeId}`
    case 'dom-flow':
      return `dom-flow:${reference.flowId}`
  }
}

/** Normalized (sorted) binding set per clause id — the binding identity of a contract (Doc 1 §2.6). */
export function bindingSetsOfContract(
  acceptance: readonly AcceptanceCriterion[],
): Map<string, string[]> {
  const sets = new Map<string, string[]>()
  for (const clause of acceptance) {
    sets.set(
      clause.id,
      (clause.experiments ?? []).map(normalizeReferenceIdentity).sort(compareStrings),
    )
  }
  return sets
}

/** Display label of one bound experiment, as the report renders it. */
function referenceLabel(reference: ExperimentReference): string {
  switch (reference.kind) {
    case 'test':
      return `test "${reference.id}"`
    case 'probe':
      return `probe "${reference.probeId}"`
    case 'dom-flow':
      return `dom-flow "${reference.flowId}"`
  }
}

/** Repo-relative file a bound experiment is defined in, when known. */
function referenceFile(
  reference: ExperimentReference,
  resolved: ResolvedExperiment | undefined,
): string | undefined {
  if (reference.kind === 'probe') {
    return SERVICE_MANIFEST_FILE
  }
  return resolved?.file
}

/** Human hint for re-running one bound experiment. */
function reproductionHint(
  reference: ExperimentReference,
  resolved: ResolvedExperiment | undefined,
): string {
  switch (reference.kind) {
    case 'test':
      return `run test "${reference.id}"${resolved?.file !== undefined ? ` (${resolved.file})` : ''}`
    case 'probe':
      return `run probe "${reference.probeId}" (see ${SERVICE_MANIFEST_FILE})`
    case 'dom-flow':
      return `run dom-flow "${reference.flowId}" (kind reserved for M5c)`
  }
}

/** Everything the findings need beyond the schema-typed resolution. */
interface ResolvedExperiment {
  resolution: ExperimentResolution
  /** Stable instrument key (dedupes findings when one instrument serves several clauses). */
  instrumentKey: string
  file?: string
  beforeDigest?: string
  afterDigest?: string
  result?: 'passed' | 'failed' | 'unknown'
}

function resolvedExperiment(
  resolution: ExperimentResolution,
  instrumentKey: string,
  extra: Partial<Pick<ResolvedExperiment, 'file' | 'beforeDigest' | 'afterDigest' | 'result'>> = {},
): ResolvedExperiment {
  return { resolution, instrumentKey, result: resolution.result, ...extra }
}

function insufficient(
  reference: ExperimentReference,
  provenance: ExperimentResolution['provenance'],
  reasons: UnverifiedReason[],
  detail: string,
  extra: Partial<Pick<ResolvedExperiment, 'file' | 'beforeDigest' | 'afterDigest' | 'result'>> = {},
): ResolvedExperiment {
  return resolvedExperiment(
    { reference, provenance, result: extra.result, reasons: dedupeSorted(reasons), detail },
    normalizeReferenceIdentity(reference),
    extra,
  )
}

/** Map a runner test status onto the recorded execution result. */
function testResultOf(status: TestCaseOutcome['status']): 'passed' | 'failed' | 'unknown' {
  return status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'unknown'
}

function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Resolve one `test` binding (Doc 1 §4/§5): the before-run per-test population
 * is the before anchor; the whole FILE containing the test (reported by the
 * before run) is the definition identity (deliberate granularity — a test's
 * observable strength lives in its module context).
 */
async function resolveTest(
  reference: Extract<ExperimentReference, { kind: 'test' }>,
  inputs: RequirementInputs,
): Promise<ResolvedExperiment> {
  const { before, after } = inputs
  if (!before.tests.perTest || !after.tests.perTest) {
    return insufficient(
      reference,
      'unknown-observability',
      ['unknown-observability'],
      'the runner provided suite-level outcomes only, so the bound test id cannot be resolved (Doc 1 §3)',
    )
  }
  const beforeOutcome = before.tests.tests.find((test) => test.id === reference.id)
  const afterOutcome = after.tests.tests.find((test) => test.id === reference.id)

  if (afterOutcome === undefined) {
    if (beforeOutcome === undefined) {
      return insufficient(
        reference,
        'unresolved',
        ['unresolved'],
        `no test id "${reference.id}" exists at either compared state`,
      )
    }
    const file = beforeOutcome.file !== undefined ? normalizeFilePath(beforeOutcome.file) : undefined
    const deleted =
      file !== undefined && inputs.deletedPaths.includes(file) ? ' (file deleted by this change)' : ''
    return insufficient(
      reference,
      'unresolved',
      ['unresolved'],
      `test id "${reference.id}" has no after outcome — deleted or excluded from execution${deleted}`,
      { file },
    )
  }
  const result = testResultOf(afterOutcome.status)

  if (beforeOutcome === undefined) {
    // Per-test mode enumerates the executed population, so before-absence is
    // ESTABLISHED absence: a new instrument (Doc 1 §5, I9) — its result is
    // recorded, but it can never count toward VERIFIED.
    return insufficient(
      reference,
      'new',
      ['experiment-new'],
      'new instrument — no before-state outcome for this test id (I9: evidence without provenance)',
      { result },
    )
  }

  const beforeFile = beforeOutcome.file !== undefined ? normalizeFilePath(beforeOutcome.file) : undefined
  if (beforeFile === undefined) {
    return insufficient(
      reference,
      'unresolved',
      ['unresolved'],
      'the runner did not report the file containing the test, so its definition identity is unavailable',
    )
  }
  const afterFile =
    afterOutcome.file !== undefined ? normalizeFilePath(afterOutcome.file) : beforeFile
  const beforeDigest = await inputs.fileDigest('before', beforeFile)
  if (beforeDigest === null) {
    return insufficient(
      reference,
      'unresolved',
      ['unresolved'],
      `definition identity unavailable (file "${beforeFile}" unreadable at the before state)`,
      { file: beforeFile },
    )
  }
  const afterDigest = await inputs.fileDigest('after', afterFile)
  if (afterDigest === null) {
    const deleted = inputs.deletedPaths.includes(afterFile) ? ' — file deleted by this change' : ''
    return insufficient(
      reference,
      'unresolved',
      ['unresolved'],
      `definition identity unavailable (file "${afterFile}" unreadable at the after state${deleted})`,
      { file: afterFile, beforeDigest },
    )
  }
  if (beforeDigest !== afterDigest) {
    return insufficient(
      reference,
      'modified',
      ['instrument-modified'],
      `definition ${shortDigest(beforeDigest)} -> ${shortDigest(afterDigest)} (whole-file digest of "${afterFile}")`,
      { file: afterFile, beforeDigest, afterDigest, result },
    )
  }
  if (result === 'passed') {
    return resolvedExperiment(
      { reference, provenance: 'established', result: 'passed', reasons: [] },
      normalizeReferenceIdentity(reference),
      { file: afterFile, beforeDigest, afterDigest, result },
    )
  }
  if (result === 'failed') {
    return resolvedExperiment(
      { reference, provenance: 'established', result: 'failed', reasons: [] },
      normalizeReferenceIdentity(reference),
      { file: afterFile, beforeDigest, afterDigest, result },
    )
  }
  return insufficient(
    reference,
    'established',
    ['unknown-outcome'],
    `the bound test ran but its outcome was inconclusive (${afterOutcome.status})`,
    { file: afterFile, beforeDigest, afterDigest, result },
  )
}

/**
 * Resolve one `probe` binding: the after-state manifest is the declaration of
 * record; before-state presence (or established absence) decides provenance
 * per Doc 1 §5, and per-probe definition identities decide drift.
 */
async function resolveProbe(
  reference: Extract<ExperimentReference, { kind: 'probe' }>,
  inputs: RequirementInputs,
): Promise<ResolvedExperiment> {
  const { before, after } = inputs
  const file = reference.manifest !== undefined ? normalizeFilePath(reference.manifest) : SERVICE_MANIFEST_FILE
  if (file !== SERVICE_MANIFEST_FILE) {
    return insufficient(
      reference,
      'unresolved',
      ['unresolved'],
      `no probes are declared under manifest "${reference.manifest}" (the engine executes ${SERVICE_MANIFEST_FILE})`,
    )
  }

  const declaredAfter = after.probes.definitionIdentities.has(reference.probeId)
  const declaredBefore = before.probes.definitionIdentities.has(reference.probeId)
  const outcomeAfter = after.probes.outcomes.get(reference.probeId)

  if (!declaredAfter) {
    if (!after.probes.declarationsKnown) {
      return insufficient(
        reference,
        'unresolved',
        ['unresolved'],
        'the after-state declared probe set is unknown (service verification did not run, or its manifest is invalid)',
      )
    }
    if (declaredBefore) {
      return insufficient(
        reference,
        'unresolved',
        ['unresolved'],
        `probe "${reference.probeId}" is not declared after the change — the bound instrument was deleted`,
      )
    }
    return insufficient(
      reference,
      'unresolved',
      ['unresolved'],
      `probe "${reference.probeId}" is not declared at either compared state`,
    )
  }
  const result: 'passed' | 'failed' | 'unknown' = outcomeAfter?.status ?? 'unknown'

  if (!declaredBefore) {
    if (!before.probes.declarationsKnown) {
      // I9 guard: an unavailable before-state declaration is UNKNOWN, never novelty.
      return insufficient(
        reference,
        'unresolved',
        ['unresolved'],
        'the before-state declared probe set is unknown, so instrument provenance cannot be established (I9)',
        { result },
      )
    }
    return insufficient(
      reference,
      'new',
      ['experiment-new'],
      'new instrument — no definition identity at the before state (I9: evidence without provenance)',
      { file, result },
    )
  }

  const beforeDigest = before.probes.definitionIdentities.get(reference.probeId) ?? null
  const afterDigest = after.probes.definitionIdentities.get(reference.probeId) ?? null
  if (beforeDigest === null || afterDigest === null) {
    return insufficient(
      reference,
      'unresolved',
      ['unresolved'],
      'definition identity unavailable (the probe declaration or its referenced document could not be resolved at a compared state)',
      { file, result },
    )
  }
  if (beforeDigest !== afterDigest) {
    return insufficient(
      reference,
      'modified',
      ['instrument-modified'],
      `definition ${shortDigest(beforeDigest)} -> ${shortDigest(afterDigest)}`,
      { file, beforeDigest, afterDigest, result },
    )
  }
  if (result === 'passed') {
    return resolvedExperiment(
      { reference, provenance: 'established', result: 'passed', reasons: [] },
      normalizeReferenceIdentity(reference),
      { file, beforeDigest, afterDigest, result },
    )
  }
  if (result === 'failed') {
    return resolvedExperiment(
      { reference, provenance: 'established', result: 'failed', reasons: [] },
      normalizeReferenceIdentity(reference),
      { file, beforeDigest, afterDigest, result },
    )
  }
  return insufficient(
    reference,
    'established',
    ['unknown-outcome'],
    `the bound probe ran but its outcome was inconclusive${outcomeAfter?.detail !== undefined ? ` (${outcomeAfter.detail})` : ''}`,
    { file, beforeDigest, afterDigest, result },
  )
}

/** dom-flow is schema-valid but reserved (Doc 2): always UNVERIFIED (unbound-kind). */
function resolveDomFlow(
  reference: Extract<ExperimentReference, { kind: 'dom-flow' }>,
): ResolvedExperiment {
  return insufficient(
    reference,
    'unbound-kind',
    ['unbound-kind'],
    'kind not yet available — dom-flow is reserved for M5c (Doc 2)',
  )
}

/**
 * The §4 clause state machine, per bound experiment:
 *   established ∧ passed          -> satisfied
 *   established ∧ failed          -> FAILED (terminal)
 *   everything else               -> insufficient, with its reason(s)
 * Clause VERIFIED needs >=1 binding and ALL contributions satisfied; FAILED is
 * terminal; anything else is UNVERIFIED carrying its (deduped, sorted) reasons.
 */
async function resolveReference(
  reference: ExperimentReference,
  inputs: RequirementInputs,
): Promise<ResolvedExperiment> {
  switch (reference.kind) {
    case 'test':
      return resolveTest(reference, inputs)
    case 'probe':
      return resolveProbe(reference, inputs)
    case 'dom-flow':
      return resolveDomFlow(reference)
  }
}

/** Per-report identifier counter: unique within one analysis. */
function createFindingIdFactory(prefix: string) {
  let counter = 0
  return () => {
    counter += 1
    return `${prefix}-${String(counter).padStart(3, '0')}`
  }
}

/** Human label for a reason, as findings and the report render it. */
function reasonLabel(reason: UnverifiedReason): string {
  return reason === 'no-binding' ? 'no binding' : reason
}

function findingEvidence(
  claim: string,
  observation: string,
  reproduction: string,
): Finding['evidence'] {
  return { kind: 'requirement', claim, observation, changedLines: [], reproduction }
}

/**
 * Analyze the contract's acceptance clauses against already-recorded evidence.
 * Deterministic: clauses are processed in declared order, findings are emitted
 * in a fixed class order (failed -> binding-changed -> experiment-modified ->
 * experiment-new -> unverified) with per-class sequential ids, and all reason
 * lists are sorted and deduped — equal inputs give deep-equal analyses.
 */
export async function analyzeRequirements(
  acceptance: readonly AcceptanceCriterion[],
  inputs: RequirementInputs,
): Promise<RequirementAnalysis> {
  const clauses: RequirementClauseResult[] = []
  /** Full per-clause resolutions behind `clauses` (carries finding-only extras). */
  const acceptedClauses: Array<{ clause: RequirementClauseResult; resolved: ResolvedExperiment[] }> = []
  const findings: Finding[] = []
  const nextFailedId = createFindingIdFactory('RFAIL')
  const nextBindingId = createFindingIdFactory('RBIND')
  const nextModifiedId = createFindingIdFactory('RMOD')
  const nextNewId = createFindingIdFactory('RNEW')

  // Binding drift (Doc 1 §2.6): compare normalized binding sets between the
  // before-state contract and the governing contract — per clause, plus the
  // clauses the change removed entirely. No before-state contract (null) means
  // binding identity is established at governing approval: no drift check.
  const drift: Array<{ clauseId: string; before: string[]; after: string[] }> = []
  if (inputs.beforeBindings !== null) {
    const governing = bindingSetsOfContract(acceptance)
    for (const clause of acceptance) {
      const before = inputs.beforeBindings.get(clause.id)
      if (before === undefined) {
        continue // new clause: binding identity established at this approval
      }
      const after = governing.get(clause.id) ?? []
      if (before.length !== after.length || before.some((entry, index) => entry !== after[index])) {
        drift.push({ clauseId: clause.id, before: [...before], after })
      }
    }
    for (const [clauseId, before] of inputs.beforeBindings) {
      if (!governing.has(clauseId)) {
        drift.push({ clauseId, before: [...before], after: [] })
      }
    }
    drift.sort((left, right) => compareStrings(left.clauseId, right.clauseId))
  }

  for (const clause of acceptance) {
    const refs = clause.experiments ?? []
    const clauseDrift = drift.some((entry) => entry.clauseId === clause.id)
    const resolved: ResolvedExperiment[] = []
    for (const reference of refs) {
      resolved.push(await resolveReference(reference, inputs))
    }

    // FAILED is terminal (Doc 1 §4): only an ESTABLISHED instrument's failure
    // proves the required behavior does not hold.
    const terminalFailure = resolved.some(
      (entry) => entry.resolution.provenance === 'established' && entry.resolution.result === 'failed',
    )
    const allSatisfied =
      resolved.length > 0 &&
      resolved.every(
        (entry) =>
          entry.resolution.provenance === 'established' && entry.resolution.result === 'passed',
      )

    let status: RequirementClauseResult['status']
    let reasons: UnverifiedReason[] = []
    if (terminalFailure) {
      status = 'failed'
    } else if (allSatisfied && !clauseDrift) {
      status = 'verified'
    } else {
      status = 'unverified'
      reasons = dedupeSorted([
        ...resolved.flatMap((entry) => entry.resolution.reasons),
        ...(clauseDrift ? (['binding-changed'] as const) : []),
        ...(refs.length === 0 ? (['no-binding'] as const) : []),
      ])
    }

    const clauseResult: RequirementClauseResult = {
      clauseId: clause.id,
      description: clause.description,
      status,
      reasons,
      experiments: resolved.map((entry) => entry.resolution),
    }
    clauses.push(clauseResult)
    acceptedClauses.push({ clause: clauseResult, resolved })

    if (status === 'failed') {
      const paths = [
        ...new Set(
          refs
            .map((reference, index) => referenceFile(reference, resolved[index]))
            .filter((file): file is string => file !== undefined),
        ),
      ].sort(compareStrings)
      const observation = resolved
        .map(
          (entry) =>
            `${referenceLabel(entry.resolution.reference)}: ${
              entry.resolution.result === 'failed' ? 'FAILED' : (entry.resolution.result ?? 'UNKNOWN').toUpperCase()
            }${entry.resolution.detail !== undefined ? ` (${entry.resolution.detail})` : ''}`,
        )
        .join('; ')
      findings.push({
        id: nextFailedId(),
        findingClass: 'requirement-failed',
        severity: severityForClass('requirement-failed'),
        message: `Requirement "${clause.id}" failed: the bound experiment observed the required behavior does not hold.`,
        paths,
        evidence: findingEvidence(
          `Requirement clause "${clause.id}" is FAILED: an established bound experiment ran against the recorded after-state and the required observable behavior does not hold (Doc 1 §4).`,
          `Clause: ${clause.description}. Bound experiments: ${observation}.`,
          refs.map((reference, index) => reproductionHint(reference, resolved[index])).join('; '),
        ),
      })
    }
  }

  // requirement-binding-changed: one finding per drifted clause, sorted by
  // clause id (governing and removed clauses alike — removing a clause is the
  // E1 attack shape).
  for (const entry of drift) {
    const removed = entry.after.length === 0
    findings.push({
      id: nextBindingId(),
      findingClass: 'requirement-binding-changed',
      severity: severityForClass('requirement-binding-changed'),
      message: `The binding of requirement clause "${entry.clauseId}" changed since the before-state contract: [${entry.before.join(', ')}] -> [${entry.after.join(', ')}]${removed ? ' (clause removed from the contract)' : ''}.`,
      paths: inputs.contractPath !== undefined ? [inputs.contractPath] : [],
      evidence: findingEvidence(
        'Binding identity drifted between the before-state contract and the governing contract (Doc 1 §2.6, I8): the change altered WHAT is being verified. Affected clauses are UNVERIFIED (binding-changed) until the contract is re-approved.',
        `Clause "${entry.clauseId}" bindings at the before state: [${entry.before.join(', ')}]; at the governing contract: [${entry.after.join(', ')}]${removed ? ' — the clause no longer exists in the governing contract' : ''}.`,
        inputs.contractPath !== undefined
          ? `diff the contract file "${inputs.contractPath}" between the compared states`
          : 'compare the contract text against the before-state contract',
      ),
    })
  }

  // requirement-experiment-modified / experiment-new: one finding per modified
  // or new instrument, naming every clause it serves (I2: no hidden certificates).
  // The full ResolvedExperiment (resolved file, before/after digests) is
  // instrument-level data, identical across clauses; the first occurrence
  // carries it.
  const modified = new Map<string, { resolved: ResolvedExperiment; clauseIds: string[] }>()
  const fresh = new Map<string, { resolved: ResolvedExperiment; clauseIds: string[] }>()
  for (const clause of acceptedClauses) {
    for (const entry of clause.resolved) {
      const key = entry.instrumentKey
      const target = entry.resolution.provenance === 'modified' ? modified : entry.resolution.provenance === 'new' ? fresh : null
      if (target === undefined || target === null) {
        continue
      }
      const existing = target.get(key)
      if (existing === undefined) {
        target.set(key, { resolved: entry, clauseIds: [clause.clause.clauseId] })
      } else {
        existing.clauseIds.push(clause.clause.clauseId)
      }
    }
  }

  // Preserve first-appearance order (clauses processed in declared order,
  // experiments in binding order) so ids are deterministic.
  const orderedModified = [...modified.values()]
  const orderedNew = [...fresh.values()]
  for (const { resolved: entry, clauseIds } of orderedModified) {
    findings.push({
      id: nextModifiedId(),
      findingClass: 'requirement-experiment-modified',
      severity: severityForClass('requirement-experiment-modified'),
      message: `The experiment bound to requirement clause(s) ${clauseIds.map((id) => `"${id}"`).join(', ')} was modified by this change: ${referenceLabel(entry.resolution.reference)} (${entry.resolution.detail ?? 'definition identity changed'}); it certifies nothing until the contract is re-approved (Doc 1 §5).`,
      paths: [referenceFile(entry.resolution.reference, entry)].filter(
        (file): file is string => file !== undefined,
      ),
      evidence: findingEvidence(
        'An anchored instrument\'s definition identity changed in this change: it is no longer the established approved instrument, so its clause is UNVERIFIED (instrument-modified) regardless of the recorded result.',
        `${referenceLabel(entry.resolution.reference)} definition identity: before ${entry.beforeDigest ?? '(unavailable)'} -> after ${entry.afterDigest ?? '(unavailable)'}. Serves clause(s): ${clauseIds.join(', ')}.`,
        `restore "${entry.resolution.reference.kind === 'probe' ? SERVICE_MANIFEST_FILE : entry.file ?? 'the instrument file'}" to the approved definition, or re-approve the contract with the new definition`,
      ),
    })
  }
  for (const { resolved: entry, clauseIds } of orderedNew) {
    findings.push({
      id: nextNewId(),
      findingClass: 'experiment-new',
      severity: severityForClass('experiment-new'),
      message: `New experiment bound to requirement clause(s) ${clauseIds.map((id) => `"${id}"`).join(', ')}: ${referenceLabel(entry.resolution.reference)} has no before-state definition identity; its result is recorded but it cannot count toward VERIFIED (Doc 1 I9).`,
      paths: [referenceFile(entry.resolution.reference, entry)].filter(
        (file): file is string => file !== undefined,
      ),
      evidence: findingEvidence(
        'A new instrument has no before anchor to prove it was not shaped by the change it verifies: the clause stays UNVERIFIED (experiment-new) permanently, and the instrument becomes established at the next verification whose before state contains it unchanged (Doc 1 §5, I9).',
        `${referenceLabel(entry.resolution.reference)} exists only at the after state${entry.resolution.result !== undefined ? `; recorded result: ${entry.resolution.result.toUpperCase()}` : ''}. Serves clause(s): ${clauseIds.join(', ')}.`,
        reproductionHint(entry.resolution.reference, entry),
      ),
    })
  }

  // requirement-unverified: ONE grouped finding, only when something ended UNVERIFIED.
  const unverified = clauses.filter((clause) => clause.status === 'unverified')
  if (unverified.length > 0) {
    findings.push({
      id: 'RUNVER-001',
      findingClass: 'requirement-unverified',
      severity: severityForClass('requirement-unverified'),
      message: `Requirement verification incomplete: ${unverified.length} of ${clauses.length} clause(s) UNVERIFIED — ${unverified
        .map((clause) => `${clause.clauseId} (${clause.reasons.map(reasonLabel).join(', ')})`)
        .join(', ')}.`,
      paths: [],
      evidence: findingEvidence(
        'UNVERIFIED is never inferred away (Doc 1 I3): clauses without established passing evidence stay unverified. This finding gates by default (review); a contract policy override accepts it explicitly.',
        unverified
          .map(
            (clause) =>
              `${clause.clauseId} "${clause.description}" — UNVERIFIED (${clause.reasons.join(', ')})`,
          )
          .join('; '),
        'see the "Requirement verification" report section for each clause\'s bound experiments and reasons',
      ),
    })
  }

  const coverage: RequirementCoverage = {
    total: clauses.length,
    verified: clauses.filter((clause) => clause.status === 'verified').length,
    failed: clauses.filter((clause) => clause.status === 'failed').length,
    unverified: unverified.length,
  }
  const accomplishedContribution =
    coverage.failed > 0 ? 'no' : coverage.total > 0 && coverage.unverified === 0 ? 'yes' : 'partial'

  return {
    schemaVersion: REQUIREMENT_SCHEMA_VERSION,
    clauses,
    coverage,
    findings,
    accomplishedContribution,
  }
}
