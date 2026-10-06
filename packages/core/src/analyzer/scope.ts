import picomatch from 'picomatch'
import type { EnrichedChangeSet, EnrichedRecord } from '../schema/changeset'
import type { ChangeContract, FindingClass, PathRule, SensitiveCategory } from '../schema/contract'
import type { Finding, Evidence } from '../schema/evidence'
import { severityForClass } from '../schema/evidence'
import type { PathAssessment, ScopeAssessment, ScopeClassification } from '../schema/scope'
import type { DependencyGraph } from '../intel/graph'

/**
 * The Scope Analyzer answers: "should this have changed?"
 *
 * Classification precedence (stricter wins):
 *   PROHIBITED > SUSPICIOUS > EXPECTED > RELATED > OUT_OF_SCOPE
 *
 * Impact ("what could this change have affected?") is a separate question and
 * ships in a later milestone.
 */

export interface ScopeResult {
  assessment: ScopeAssessment
  findings: Finding[]
}

const MATCH_OPTIONS = { dot: true } as const

function globMatches(glob: string, path: string): boolean {
  return picomatch.isMatch(path, glob, MATCH_OPTIONS)
}

function describeRule(rule: PathRule): string {
  return typeof rule === 'string' ? `glob:${rule}` : `category:${rule.category}`
}

/**
 * Human reproduction command. 'working-tree' is a display label, not a git
 * ref — a bare `git diff <ref>` already compares against the working tree,
 * so the nonexistent ref must never be named in a runnable command.
 */
function gitDiffReproduction(before: string, after: string, path?: string): string {
  const suffix = path === undefined ? '' : ` -- ${path}`
  const refs = after === 'working-tree' ? before : `${before} ${after}`
  return `git -C <repo> diff ${refs}${suffix}`
}

function recordPaths(record: EnrichedRecord): string[] {
  return record.oldPath ? [record.path, record.oldPath] : [record.path]
}

/**
 * A category rule matches a record either through path patterns (enrichment)
 * or — for dependency-addition/removal — through the detected dependency diff.
 */
function categoryMatches(
  category: SensitiveCategory,
  record: EnrichedRecord,
  enriched: EnrichedChangeSet,
): boolean {
  if (category === 'dependency-addition') {
    return recordPaths(record).includes('package.json') && enriched.dependencies.added.length > 0
  }
  if (category === 'dependency-removal') {
    return recordPaths(record).includes('package.json') && enriched.dependencies.removed.length > 0
  }
  return record.categories.includes(category)
}

function ruleMatches(rule: PathRule, record: EnrichedRecord, enriched: EnrichedChangeSet): boolean {
  if (typeof rule === 'string') {
    return recordPaths(record).some((path) => globMatches(rule, path))
  }
  return categoryMatches(rule.category, record, enriched)
}

function firstMatchingRule(
  rules: PathRule[],
  record: EnrichedRecord,
  enriched: EnrichedChangeSet,
): PathRule | undefined {
  return rules.find((rule) => ruleMatches(rule, record, enriched))
}

/** All repository paths matched by the contract's must/may globs. */
function declaredAreaPaths(contract: ChangeContract, graph: DependencyGraph): Set<string> {
  const globs = [...contract.paths.mustChange, ...contract.paths.mayChange].filter(
    (rule): rule is string => typeof rule === 'string',
  )
  const areas = new Set<string>()
  if (globs.length === 0) {
    return areas
  }
  for (const path of Object.keys(graph.files)) {
    if (globs.some((glob) => globMatches(glob, path))) {
      areas.add(path)
    }
  }
  return areas
}

/** One-hop graph adjacency between a changed path and a declared area. */
function areaAdjacencyReason(
  record: EnrichedRecord,
  areas: Set<string>,
  graph: DependencyGraph,
): string | null {
  for (const path of recordPaths(record)) {
    const node = graph.files[path]
    for (const target of node?.imports ?? []) {
      if (areas.has(target)) {
        return `imports:${target}`
      }
    }
    for (const importer of graph.importedBy[path] ?? []) {
      if (areas.has(importer)) {
        return `imported-by:${importer}`
      }
    }
  }
  return null
}

/**
 * One-hop adjacency between a changed path and another *changed* path that the
 * contract authorizes. This keeps mechanical follow-ups RELATED — e.g. after a
 * rename, the import-site edit is adjacent to the renamed (EXPECTED) file even
 * though the original declared area no longer exists at the after ref.
 */
function changeAdjacencyReason(
  record: EnrichedRecord,
  authorizedPaths: Set<string>,
  graph: DependencyGraph,
): string | null {
  for (const path of recordPaths(record)) {
    const node = graph.files[path]
    for (const target of node?.imports ?? []) {
      if (authorizedPaths.has(target)) {
        return `imports:${target}`
      }
    }
    for (const importer of graph.importedBy[path] ?? []) {
      if (authorizedPaths.has(importer)) {
        return `imported-by:${importer}`
      }
    }
    // A rename itself creates an implicit edge old -> new.
    if (record.oldPath && authorizedPaths.has(record.path)) {
      return `renamed-from:${record.oldPath}`
    }
  }
  return null
}

function hunkText(record: EnrichedRecord): string {
  if (record.binary) {
    return 'binary content'
  }
  if (record.hunks.length === 0) {
    return 'no content hunks'
  }
  return record.hunks
    .map(
      (hunk) =>
        `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@ (+${hunk.added}/-${hunk.removed})`,
    )
    .join(' ; ')
}

function diffEvidence(
  enriched: EnrichedChangeSet,
  record: EnrichedRecord,
  claim: string,
  observation: string,
): Evidence {
  return {
    kind: 'diff',
    claim,
    observation,
    changedLines:
      record.hunks.length > 0
        ? [
            {
              file: record.path,
              hunks: record.hunks.map((hunk) => ({
                before: `${hunk.beforeStart},${hunk.beforeCount}`,
                after: `${hunk.afterStart},${hunk.afterCount}`,
                added: hunk.added,
                removed: hunk.removed,
              })),
            },
          ]
        : [],
    reproduction: gitDiffReproduction(enriched.changeSet.before, enriched.changeSet.after, record.path),
  }
}

function classPrefix(findingClass: FindingClass): string {
  switch (findingClass) {
    case 'new-dependency':
    case 'removed-dependency':
    case 'changed-dependency':
      return 'DEP'
    case 'deleted-test':
      return 'TEST'
    case 'unfulfilled-contract':
      return 'CONTRACT'
    default:
      return 'SCOPE'
  }
}

class FindingLog {
  private findings: Finding[] = []
  private counters = new Map<string, number>()

  add(findingClass: FindingClass, message: string, paths: string[], evidence: Evidence): void {
    const prefix = classPrefix(findingClass)
    const next = (this.counters.get(prefix) ?? 0) + 1
    this.counters.set(prefix, next)
    this.findings.push({
      id: `${prefix}-${String(next).padStart(3, '0')}`,
      findingClass,
      severity: severityForClass(findingClass),
      message,
      paths,
      evidence,
    })
  }

  all(): Finding[] {
    return this.findings
  }
}

export function analyzeScope(
  contract: ChangeContract,
  enriched: EnrichedChangeSet,
  graph: DependencyGraph,
): ScopeResult {
  const areas = declaredAreaPaths(contract, graph)
  const log = new FindingLog()
  const perPath: PathAssessment[] = []

  // Pass 1: rule-based classification only.
  const ruleResults: { record: EnrichedRecord; classification: ScopeClassification | null; reason: string }[] =
    enriched.records.map((record) => {
      const prohibitedRule = firstMatchingRule(contract.paths.prohibited, record, enriched)
      const preservedRule = firstMatchingRule(contract.paths.mustPreserve, record, enriched)
      const expectedRule = firstMatchingRule(contract.paths.mustChange, record, enriched)
      const allowedRule = firstMatchingRule(contract.paths.mayChange, record, enriched)

      if (prohibitedRule) {
        return { record, classification: 'PROHIBITED' as const, reason: describeRule(prohibitedRule) }
      }
      if (preservedRule) {
        return { record, classification: 'SUSPICIOUS' as const, reason: describeRule(preservedRule) }
      }
      if (expectedRule) {
        return { record, classification: 'EXPECTED' as const, reason: describeRule(expectedRule) }
      }
      if (allowedRule) {
        return { record, classification: 'RELATED' as const, reason: describeRule(allowedRule) }
      }
      return { record, classification: null, reason: '' }
    })

  const authorizedPaths = new Set(
    ruleResults
      .filter((result) => result.classification === 'EXPECTED' || result.classification === 'RELATED')
      .flatMap((result) => recordPaths(result.record)),
  )

  // Pass 2: adjacency for records no rule covers.
  for (const result of ruleResults) {
    if (result.classification !== null) {
      continue
    }
    const areaReason = areaAdjacencyReason(result.record, areas, graph)
    if (areaReason) {
      result.classification = 'RELATED'
      result.reason = areaReason
      continue
    }
    const changeReason = changeAdjacencyReason(result.record, authorizedPaths, graph)
    if (changeReason) {
      result.classification = 'RELATED'
      result.reason = changeReason
      continue
    }
    result.classification = 'OUT_OF_SCOPE'
    result.reason = 'no contract rule matches this path'
  }

  for (const { record, classification, reason } of ruleResults) {
    // Pass 2 always fills nulls; the fallback is purely for type completeness.
    const resolved: ScopeClassification = classification ?? 'OUT_OF_SCOPE'
    perPath.push({ path: record.path, status: record.status, classification: resolved, reason })

    const displayPath = record.oldPath ? `${record.oldPath} -> ${record.path}` : record.path

    if (classification === 'PROHIBITED') {
      log.add(
        'prohibited-change',
        `${displayPath} changed but the contract prohibits it (${reason}).`,
        [record.path],
        diffEvidence(
          enriched,
          record,
          `The change modifies ${record.path}, which the contract prohibits.`,
          `Path matched prohibited rule ${reason}. Status: ${record.status}. ${hunkText(record)}.`,
        ),
      )
    } else if (classification === 'SUSPICIOUS') {
      log.add(
        'preserved-area-changed',
        `${displayPath} changed but the contract requires it to be preserved (${reason}).`,
        [record.path],
        diffEvidence(
          enriched,
          record,
          `The change modifies ${record.path}, which the contract marks must-preserve.`,
          `Path matched must-preserve rule ${reason}. Status: ${record.status}. ${hunkText(record)}.`,
        ),
      )
    } else if (classification === 'OUT_OF_SCOPE') {
      log.add(
        'out-of-scope-change',
        `${displayPath} changed but no contract rule authorizes it.`,
        [record.path],
        diffEvidence(
          enriched,
          record,
          `The change modifies ${record.path}, which is outside the contract's declared scope.`,
          `No must/may rule matched and the file is not adjacent to a declared area. Status: ${record.status}. ${hunkText(record)}.`,
        ),
      )

      if (record.categories.length > 0) {
        log.add(
          'sensitive-file-changed',
          `${displayPath} is a sensitive file (${record.categories.join(', ')}) changed outside the contract's scope.`,
          [record.path],
          diffEvidence(
            enriched,
            record,
            `A sensitive file (${record.categories.join(', ')}) changed without contract authorization.`,
            `Detected categories: ${record.categories.join(', ')}. Status: ${record.status}. ${hunkText(record)}.`,
          ),
        )
      }
    }

    if (
      record.isTest &&
      record.status === 'deleted' &&
      classification !== 'EXPECTED' &&
      classification !== 'RELATED'
    ) {
      log.add(
        'deleted-test',
        `Test file ${displayPath} was deleted without contract authorization — verification coverage was reduced.`,
        [record.path],
        diffEvidence(
          enriched,
          record,
          `The change deletes test file ${record.path}, reducing coverage without authorization.`,
          `Status: deleted; classified ${classification} (${reason}).`,
        ),
      )
    }
  }

  const { added, removed, changed } = enriched.dependencies
  if (added.length > 0) {
    log.add(
      'new-dependency',
      `New dependencies introduced: ${added.map((dep) => `${dep.name}@${dep.version ?? '?'} (${dep.section})`).join(', ')}.`,
      ['package.json'],
      {
        kind: 'dependency',
        claim: 'The change introduces dependencies that were not present before.',
        observation: `Added: ${added.map((dep) => `${dep.name}@${dep.version ?? '?'}`).join(', ')}.`,
        changedLines: [],
        reproduction: gitDiffReproduction(enriched.changeSet.before, enriched.changeSet.after, 'package.json'),
      },
    )
  }
  if (removed.length > 0) {
    log.add(
      'removed-dependency',
      `Dependencies removed: ${removed.map((dep) => `${dep.name} (${dep.section})`).join(', ')}.`,
      ['package.json'],
      {
        kind: 'dependency',
        claim: 'The change removes dependencies that were present before.',
        observation: `Removed: ${removed.map((dep) => dep.name).join(', ')}.`,
        changedLines: [],
        reproduction: gitDiffReproduction(enriched.changeSet.before, enriched.changeSet.after, 'package.json'),
      },
    )
  }
  if (changed.length > 0) {
    log.add(
      'changed-dependency',
      `Dependency versions changed: ${changed.map((dep) => `${dep.name} ${dep.from} -> ${dep.to}`).join(', ')}.`,
      ['package.json'],
      {
        kind: 'dependency',
        claim: 'The change updates dependency versions.',
        observation: `Changed: ${changed.map((dep) => `${dep.name} ${dep.from} -> ${dep.to}`).join(', ')}.`,
        changedLines: [],
        reproduction: gitDiffReproduction(enriched.changeSet.before, enriched.changeSet.after, 'package.json'),
      },
    )
  }

  // Contract fulfillment: every mustChange glob should have at least one change.
  for (const rule of contract.paths.mustChange) {
    if (typeof rule !== 'string') {
      continue
    }
    const touched = enriched.records.some((record) =>
      recordPaths(record).some((path) => globMatches(rule, path)),
    )
    if (!touched) {
      log.add(
        'unfulfilled-contract',
        `The contract requires changes under ${rule}, but no changed path matches it.`,
        [],
        {
          kind: 'diff',
          claim: `The requested change appears unaccomplished: must-change area ${rule} was not touched.`,
          observation: `No path in the diff between ${enriched.changeSet.before} and ${enriched.changeSet.after} matches ${rule}.`,
          changedLines: [],
          reproduction: `git -C <repo> diff --name-only ${enriched.changeSet.after === 'working-tree' ? enriched.changeSet.before : `${enriched.changeSet.before} ${enriched.changeSet.after}`}`,
        },
      )
    }
  }

  return { assessment: { perPath }, findings: log.all() }
}
