import type { DependencyGraph, FileKind } from '../intel/graph'
import type { ChangeStatus } from '../schema/changeset'
import type {
  AffectedTest,
  GraphOrigin,
  ImpactAssessment,
  ImpactLevel,
  ImpactNode,
  UnresolvedEdge,
} from '../schema/impact'

/**
 * The Impact Analyzer answers: "given the changes that actually occurred, what
 * parts of the system could reasonably be affected?"
 *
 * The traversal is fully deterministic:
 * - created/modified seeds traverse reverse dependencies (importedBy) in the
 *   AFTER graph; deleted seeds traverse the BEFORE graph; renames traverse the
 *   old path in the BEFORE graph and the new path in the AFTER graph.
 * - Reverse BFS assigns distance 1 -> HIGH, 2 -> MEDIUM, 3+ -> LOW. The minimum
 *   distance across all seeds/paths wins. LOW is weaker structural evidence,
 *   never a safety claim.
 * - Test and entry nodes are terminal: they are recorded as impacted but their
 *   importers are not expanded (tests are verification leaves; entrypoints are
 *   terminal for upward traversal).
 * - Evidence paths (`via`) are capped at the three lexicographically smallest
 *   shortest paths, enumerated with a bounded layered search (see
 *   {@link collectShortestPaths}) — never an unbounded path enumeration.
 * - A seed absent from its graph is never dropped: it stays DIRECT with
 *   reachability 'no-graph-evidence' and via [[path]].
 */

/** Schema contract: "up to three shortest evidence chains". */
const MAX_VIA_PATHS = 3

/** Kinds whose importers are not expanded (terminal for upward traversal). */
const TERMINAL_KINDS: ReadonlySet<FileKind> = new Set<FileKind>([
  'test',
  'entry-html',
  'entry-package',
])

export interface ImpactSeed {
  path: string
  status: 'modified' | 'created' | 'deleted' | 'renamed'
  /** Present for renames. */
  oldPath?: string
}

export interface ImpactGraphs {
  after: DependencyGraph
  /** Required only when deletions/renames must be traversed; optional otherwise. */
  before?: DependencyGraph
}

/** Everything except predictionReview (the pipeline fills that from M2 results). */
export type ImpactModel = Omit<ImpactAssessment, 'predictionReview'>

interface TraversalRoot {
  path: string
  graph: DependencyGraph
  graphKey: 'after' | 'before'
  status: ChangeStatus
  /** Layered BFS distances from the root; null when the graph cannot speak about the path. */
  distances: Map<string, number> | null
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function isTerminalKind(kind: FileKind | undefined): boolean {
  return kind !== undefined && TERMINAL_KINDS.has(kind)
}

/**
 * Lexicographic element-wise comparison for evidence paths. Enumeration already
 * emits in this order; sorting again makes the guarantee independent of
 * internal traversal details.
 */
function comparePaths(a: string[], b: string[]): number {
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index++) {
    const left = a[index]!
    const right = b[index]!
    if (left < right) return -1
    if (left > right) return 1
  }
  return a.length - b.length
}

/** Cycle-safe reverse BFS over importedBy. Terminal nodes are not expanded. */
function bfsLayers(graph: DependencyGraph, root: string): Map<string, number> {
  const distances = new Map<string, number>([[root, 0]])
  const queue: string[] = [root]
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!
    if (isTerminalKind(graph.files[current]?.kind)) continue
    const layer = distances.get(current)! + 1
    for (const importer of sortedUnique(graph.importedBy[current] ?? [])) {
      if (distances.has(importer)) continue
      distances.set(importer, layer)
      queue.push(importer)
    }
  }
  return distances
}

/**
 * rev(x) = minimum importer-edge steps from x to `target`, over paths whose
 * intermediate nodes are all non-terminal (the same legality rule the forward
 * BFS applies). Computed by BFS from the target over `imports` edges, capped at
 * `maxDepth` layers. Used to prune the evidence-path search so it only ever
 * walks nodes that lie on some shortest path to the target.
 */
function reverseDistances(graph: DependencyGraph, target: string, maxDepth: number): Map<string, number> {
  const distances = new Map<string, number>([[target, 0]])
  const queue: string[] = [target]
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!
    const layer = distances.get(current)!
    if (layer >= maxDepth) continue
    for (const imported of sortedUnique(graph.files[current]?.imports ?? [])) {
      if (distances.has(imported) || isTerminalKind(graph.files[imported]?.kind)) continue
      distances.set(imported, layer + 1)
      queue.push(imported)
    }
  }
  return distances
}

/**
 * Bounded enumeration of shortest evidence paths (seed -> ... -> target) at
 * exactly `distance` steps.
 *
 * Determinism and boundedness:
 * - Seeds are visited by the caller in sorted order and importer candidates are
 *   visited in sorted order, so pre-order DFS emits paths in lexicographic
 *   order of the whole path sequence; the cap therefore keeps exactly the
 *   lexicographically first paths.
 * - A candidate is only stepped to when its forward BFS layer is depth+1 AND
 *   its reverse distance to the target is the remaining budget. Every explored
 *   step lies on a shortest path to the target, so there are no dead ends and
 *   the work is proportional to the paths actually emitted (early exit at
 *   `cap`), never to the number of paths that exist.
 * - Strictly increasing layers make the paths simple by construction.
 */
function collectShortestPaths(options: {
  graph: DependencyGraph
  rootPath: string
  forward: Map<string, number>
  reverse: Map<string, number>
  target: string
  distance: number
  collected: string[][]
  cap: number
}): void {
  const { graph, rootPath, forward, reverse, target, distance, collected, cap } = options
  const path: string[] = [rootPath]
  const visit = (current: string, depth: number): void => {
    if (collected.length >= cap) return
    if (depth === distance) {
      if (current === target) collected.push([...path])
      return
    }
    const remaining = distance - depth - 1
    for (const importer of sortedUnique(graph.importedBy[current] ?? [])) {
      if (collected.length >= cap) return
      if (forward.get(importer) !== depth + 1) continue
      if (reverse.get(importer) !== remaining) continue
      path.push(importer)
      visit(importer, depth + 1)
      path.pop()
    }
  }
  visit(rootPath, 0)
}

/** `unresolvedEdges` is an optional DependencyGraph field (populated by buildGraph). */
function unresolvedEdgesOf(graph: DependencyGraph | undefined): UnresolvedEdge[] {
  if (!graph) return []
  return graph.unresolvedEdges ?? []
}

function originGraphLabel(origin: GraphOrigin): string {
  return origin === 'both' ? 'both graphs' : `${origin} graph`
}

export function computeImpact(seeds: ImpactSeed[], graphs: ImpactGraphs): ImpactModel {
  const after = graphs.after
  const before = graphs.before

  // Sort seeds up front so caller ordering never leaks into the output.
  const orderedSeeds = [...seeds].sort((a, b) =>
    a.path < b.path
      ? -1
      : a.path > b.path
        ? 1
        : a.status < b.status
          ? -1
          : a.status > b.status
            ? 1
            : 0,
  )

  const roots: TraversalRoot[] = []
  const seenRoots = new Set<string>()
  const addRoot = (
    path: string,
    graph: DependencyGraph | undefined,
    graphKey: 'after' | 'before',
    status: ChangeStatus,
  ): void => {
    const key = `${graphKey}:${path}`
    if (seenRoots.has(key)) return
    seenRoots.add(key)
    const present = graph !== undefined && graph.files[path] !== undefined
    roots.push({
      path,
      // A null-graph placeholder is unreachable for traversal; keep `after` for type completeness.
      graph: graph ?? after,
      graphKey,
      status,
      distances: present && graph ? bfsLayers(graph, path) : null,
    })
  }

  for (const seed of orderedSeeds) {
    if (seed.status === 'deleted') {
      // The file may not exist after; its importers only exist in the BEFORE graph.
      addRoot(seed.path, before, 'before', seed.status)
    } else if (seed.status === 'renamed') {
      if (seed.oldPath) addRoot(seed.oldPath, before, 'before', seed.status)
      addRoot(seed.path, after, 'after', seed.status)
    } else {
      addRoot(seed.path, after, 'after', seed.status)
    }
  }

  interface Accumulated {
    path: string
    changed: boolean
    /** True when at least one root for this path had graph evidence. */
    traversed: boolean
    minDistance: number
    origins: Set<'after' | 'before'>
    sources: Set<string>
    distanceBySource: Map<string, number>
    status?: ChangeStatus
  }

  const accumulated = new Map<string, Accumulated>()
  const accumulate = (path: string): Accumulated => {
    let entry = accumulated.get(path)
    if (!entry) {
      entry = {
        path,
        changed: false,
        traversed: false,
        minDistance: Number.POSITIVE_INFINITY,
        origins: new Set(),
        sources: new Set(),
        distanceBySource: new Map(),
      }
      accumulated.set(path, entry)
    }
    return entry
  }
  const recordDistance = (entry: Accumulated, source: string, distance: number): void => {
    const previous = entry.distanceBySource.get(source)
    if (previous === undefined || distance < previous) entry.distanceBySource.set(source, distance)
    if (distance < entry.minDistance) entry.minDistance = distance
  }

  for (const root of roots) {
    const entry = accumulate(root.path)
    entry.changed = true
    entry.traversed = entry.traversed || root.distances !== null
    entry.status ??= root.status
    entry.origins.add(root.graphKey)
    entry.sources.add(root.path)
    recordDistance(entry, root.path, 0)
    if (root.distances === null) continue
    for (const [path, distance] of root.distances) {
      const reached = accumulate(path)
      reached.origins.add(root.graphKey)
      reached.sources.add(root.path)
      recordDistance(reached, root.path, distance)
    }
  }

  const kindOf = (path: string): FileKind =>
    after.files[path]?.kind ?? before?.files[path]?.kind ?? 'other'

  const rootsForPaths = [...roots].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.graphKey < b.graphKey ? -1 : a.graphKey > b.graphKey ? 1 : 0,
  )

  const affected: ImpactNode[] = []
  for (const entry of accumulated.values()) {
    const origin: GraphOrigin =
      entry.origins.has('after') && entry.origins.has('before')
        ? 'both'
        : entry.origins.has('before')
          ? 'before'
          : 'after'
    const level: ImpactLevel =
      entry.changed || entry.minDistance === 0
        ? 'DIRECT'
        : entry.minDistance === 1
          ? 'HIGH'
          : entry.minDistance === 2
            ? 'MEDIUM'
            : 'LOW'

    let via: string[][]
    if (entry.changed) {
      // Minimum distance is 0; the only shortest path is the node itself.
      via = [[entry.path]]
    } else {
      via = []
      const reverseByGraphKey = new Map<'after' | 'before', Map<string, number>>()
      for (const root of rootsForPaths) {
        if (via.length >= MAX_VIA_PATHS) break
        if (root.distances === null || root.distances.get(entry.path) !== entry.minDistance) continue
        let reverse = reverseByGraphKey.get(root.graphKey)
        if (!reverse) {
          reverse = reverseDistances(root.graph, entry.path, entry.minDistance)
          reverseByGraphKey.set(root.graphKey, reverse)
        }
        collectShortestPaths({
          graph: root.graph,
          rootPath: root.path,
          forward: root.distances,
          reverse,
          target: entry.path,
          distance: entry.minDistance,
          collected: via,
          cap: MAX_VIA_PATHS,
        })
      }
      via.sort(comparePaths)
    }

    const sources = sortedUnique([...entry.sources])
    const reasons = sources
      .map((source) => {
        if (source === entry.path) {
          return `changed file ${entry.path} (${entry.status ?? 'modified'})`
        }
        const distance = entry.distanceBySource.get(source) ?? entry.minDistance
        return `imports chain from ${source} (distance ${distance}, ${originGraphLabel(origin)})`
      })
      .sort()

    affected.push({
      path: entry.path,
      changed: entry.changed,
      level,
      distance: entry.minDistance,
      reachability: entry.changed && !entry.traversed ? 'no-graph-evidence' : 'known',
      origin,
      via,
      sources,
      reasons,
    })
  }
  affected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const affectedTests: AffectedTest[] = affected
    .filter((candidate) => kindOf(candidate.path) === 'test')
    .map((candidate) => ({
      path: candidate.path,
      sources: candidate.sources,
      evidencePaths: candidate.via,
    }))
  affectedTests.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  // Coverage population: impacted non-test, non-seed nodes (seeds excluded even
  // when they appear on a test's evidence chain).
  const rootPaths = new Set(roots.map((root) => root.path))
  const coveredOnTestPaths = new Set<string>()
  for (const test of affectedTests) {
    for (const evidencePath of test.evidencePaths) {
      for (const path of evidencePath.slice(0, -1)) coveredOnTestPaths.add(path)
    }
  }
  const population = affected
    .filter((candidate) => !rootPaths.has(candidate.path) && kindOf(candidate.path) !== 'test')
    .map((candidate) => candidate.path)
  const covered = population.filter((path) => coveredOnTestPaths.has(path)).sort()
  const uncovered = population.filter((path) => !coveredOnTestPaths.has(path)).sort()
  // Vacuous truth: an empty blast radius leaves nothing uncovered, so coverage
  // is 100 (with affectedAreas 0), not a misleading 0.
  const coveragePercent =
    population.length === 0 ? 100 : Math.round((covered.length / population.length) * 1000) / 10

  const unresolvedEdges: UnresolvedEdge[] = []
  const seenEdges = new Set<string>()
  for (const edge of [...unresolvedEdgesOf(after), ...unresolvedEdgesOf(before)]) {
    const key = `${edge.kind}|${edge.from}|${edge.specifier}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    unresolvedEdges.push(edge)
  }

  return {
    seeds: sortedUnique(
      orderedSeeds.flatMap((seed) => (seed.oldPath ? [seed.path, seed.oldPath] : [seed.path])),
    ),
    affected,
    affectedTests,
    coverage: {
      affectedAreas: population.length,
      coveredAreas: covered.length,
      uncoveredAreas: uncovered.length,
      coveragePercent,
      covered,
      uncovered,
    },
    unresolvedEdges,
    completeness: unresolvedEdges.length > 0 ? ('partial' as const) : ('complete' as const),
  }
}
