import { describe, expect, it } from 'vitest'
import { computeImpact, type ImpactSeed } from './impact'
import type { DependencyGraph, FileKind, FileNode } from '../intel/graph'
import type { ImpactNode, UnresolvedEdge } from '../schema/impact'

function node(path: string, kind: FileKind, imports: string[] = []): FileNode {
  return { path, kind, imports, externalImports: [] }
}

/**
 * Builds a DependencyGraph from FileNodes, deriving importedBy in the given
 * entry order. `unresolvedEdges` is attached structurally because the field is
 * optional on DependencyGraph.
 */
function graph(entries: FileNode[], unresolvedEdges?: UnresolvedEdge[]): DependencyGraph {
  const files: Record<string, FileNode> = {}
  const importedBy: Record<string, string[]> = {}
  for (const entry of entries) {
    files[entry.path] = entry
  }
  for (const entry of entries) {
    for (const target of entry.imports) {
      ;(importedBy[target] ??= []).push(entry.path)
    }
  }
  return { files, importedBy, ...(unresolvedEdges ? { unresolvedEdges } : {}) } as DependencyGraph
}

function seed(path: string, status: ImpactSeed['status'] = 'modified', oldPath?: string): ImpactSeed {
  return oldPath ? { path, status, oldPath } : { path, status }
}

function impactOf(affected: ImpactNode[], path: string): ImpactNode | undefined {
  return affected.find((candidate) => candidate.path === path)
}

describe('computeImpact traversal levels', () => {
  it('assigns HIGH/MEDIUM/LOW at reverse distances 1/2/3+', () => {
    const after = graph([
      node('src/a.ts', 'source'),
      node('src/b.ts', 'source', ['src/a.ts']),
      node('src/c.ts', 'source', ['src/b.ts']),
      node('src/d.ts', 'source', ['src/c.ts']),
      node('src/e.ts', 'source', ['src/d.ts']),
    ])
    const result = computeImpact([seed('src/a.ts')], { after })

    const expected: [string, ImpactNode['level'], number][] = [
      ['src/a.ts', 'DIRECT', 0],
      ['src/b.ts', 'HIGH', 1],
      ['src/c.ts', 'MEDIUM', 2],
      ['src/d.ts', 'LOW', 3],
      ['src/e.ts', 'LOW', 4],
    ]
    expect(result.affected.map((entry) => [entry.path, entry.level, entry.distance])).toEqual(expected)

    const b = impactOf(result.affected, 'src/b.ts')!
    expect(b.changed).toBe(false)
    expect(b.via).toEqual([['src/a.ts', 'src/b.ts']])
    expect(b.sources).toEqual(['src/a.ts'])
    expect(b.reasons).toEqual(['imports chain from src/a.ts (distance 1, after graph)'])

    const c = impactOf(result.affected, 'src/c.ts')!
    expect(c.reasons).toEqual(['imports chain from src/a.ts (distance 2, after graph)'])

    expect(result.completeness).toBe('complete')
  })
})

describe('computeImpact multi-seed merging', () => {
  const after = graph([
    node('src/a.ts', 'source'),
    node('src/b.ts', 'source', ['src/a.ts']),
    node('src/p.ts', 'source', ['src/a.ts']),
    node('src/m.ts', 'source', ['src/p.ts', 'src/x.ts']),
    node('src/x.ts', 'source'),
  ])

  it('lets the minimum distance across seeds decide the level and merges sources', () => {
    // Deliberately unsorted input seeds.
    const result = computeImpact([seed('src/x.ts'), seed('src/a.ts')], { after })

    const m = impactOf(result.affected, 'src/m.ts')!
    // Distance 2 from a.ts but 1 from x.ts: HIGH, both sources recorded.
    expect(m.level).toBe('HIGH')
    expect(m.distance).toBe(1)
    expect(m.sources).toEqual(['src/a.ts', 'src/x.ts'])
    expect(m.via).toEqual([['src/x.ts', 'src/m.ts']])
    expect(m.reasons).toEqual([
      'imports chain from src/a.ts (distance 2, after graph)',
      'imports chain from src/x.ts (distance 1, after graph)',
    ])

    const p = impactOf(result.affected, 'src/p.ts')!
    expect(p.level).toBe('HIGH')
    expect(p.distance).toBe(1)
  })

  it('keeps a changed file DIRECT even when reachable from another seed', () => {
    const result = computeImpact([seed('src/a.ts'), seed('src/b.ts')], { after })

    const b = impactOf(result.affected, 'src/b.ts')!
    expect(b.changed).toBe(true)
    expect(b.level).toBe('DIRECT')
    expect(b.distance).toBe(0)
    expect(b.via).toEqual([['src/b.ts']])
    expect(b.sources).toEqual(['src/a.ts', 'src/b.ts'])
    expect(b.reasons).toEqual([
      'changed file src/b.ts (modified)',
      'imports chain from src/a.ts (distance 1, after graph)',
    ])
  })
})

describe('computeImpact evidence path cap', () => {
  it('keeps exactly three of four equal-length paths, deterministically the lexicographically first', () => {
    const after = graph([
      node('src/s.ts', 'source'),
      node('src/w.ts', 'source', ['src/s.ts']),
      node('src/x.ts', 'source', ['src/s.ts']),
      node('src/y.ts', 'source', ['src/s.ts']),
      node('src/z.ts', 'source', ['src/s.ts']),
      node('src/t.ts', 'source', ['src/w.ts', 'src/x.ts', 'src/y.ts', 'src/z.ts']),
    ])
    const result = computeImpact([seed('src/s.ts')], { after })

    const t = impactOf(result.affected, 'src/t.ts')!
    expect(t.distance).toBe(2)
    expect(t.via).toEqual([
      ['src/s.ts', 'src/w.ts', 'src/t.ts'],
      ['src/s.ts', 'src/x.ts', 'src/t.ts'],
      ['src/s.ts', 'src/y.ts', 'src/t.ts'],
    ])

    // Nothing covers the blast radius: zero coverage over five areas.
    expect(result.coverage.affectedAreas).toBe(5)
    expect(result.coverage.coveredAreas).toBe(0)
    expect(result.coverage.coveragePercent).toBe(0)
  })
})

describe('computeImpact determinism', () => {
  const entries = [
    node('src/s.ts', 'source'),
    node('src/w.ts', 'source', ['src/s.ts']),
    node('src/x.ts', 'source', ['src/s.ts']),
    node('src/t.ts', 'source', ['src/w.ts', 'src/x.ts']),
    node('src/t.test.ts', 'test', ['src/t.ts']),
  ]

  it('produces identical output across two calls', () => {
    const seeds = [seed('src/s.ts')]
    const first = computeImpact(seeds, { after: graph(entries) })
    const second = computeImpact(seeds, { after: graph(entries) })
    expect(first).toEqual(second)
  })

  it('is unaffected by shuffled graph construction order', () => {
    const first = computeImpact([seed('src/s.ts')], { after: graph(entries) })
    const second = computeImpact([seed('src/s.ts')], { after: graph([...entries].reverse()) })
    expect(first).toEqual(second)
  })
})

describe('computeImpact cycles', () => {
  it('terminates on an import cycle and keeps distances minimal', () => {
    const after = graph([
      node('src/a.ts', 'source', ['src/b.ts']),
      node('src/b.ts', 'source', ['src/a.ts']),
      node('src/c.ts', 'source', ['src/b.ts']),
    ])
    const result = computeImpact([seed('src/a.ts')], { after })

    expect(result.affected.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    const b = impactOf(result.affected, 'src/b.ts')!
    expect(b.distance).toBe(1)
    expect(b.level).toBe('HIGH')
    const c = impactOf(result.affected, 'src/c.ts')!
    expect(c.distance).toBe(2)
    expect(c.level).toBe('MEDIUM')
    expect(c.via).toEqual([['src/a.ts', 'src/b.ts', 'src/c.ts']])
  })
})

describe('computeImpact terminal nodes', () => {
  it('impacts test nodes without expanding their importers', () => {
    const after = graph([
      node('src/a.ts', 'source'),
      node('src/a.test.ts', 'test', ['src/a.ts']),
      node('src/imports-the-test.ts', 'source', ['src/a.test.ts']),
    ])
    const result = computeImpact([seed('src/a.ts')], { after })

    // Code-unit sort: 'src/a.test.ts' < 'src/a.ts' ('e' < 's' at the first difference).
    expect(result.affected.map((entry) => entry.path)).toEqual(['src/a.test.ts', 'src/a.ts'])
    const test = impactOf(result.affected, 'src/a.test.ts')!
    expect(test.level).toBe('HIGH')
    expect(test.via).toEqual([['src/a.ts', 'src/a.test.ts']])
    expect(result.affectedTests).toEqual([
      { path: 'src/a.test.ts', sources: ['src/a.ts'], evidencePaths: [['src/a.ts', 'src/a.test.ts']] },
    ])
  })

  it('treats entry-html and entry-package nodes as terminal for upward traversal', () => {
    const after = graph([
      node('src/s.ts', 'source'),
      node('index.html', 'entry-html', ['src/s.ts']),
      node('bin/cli.ts', 'entry-package', ['src/s.ts']),
      node('src/odd.ts', 'source', ['index.html']),
      node('src/odd2.ts', 'source', ['bin/cli.ts']),
    ])
    const result = computeImpact([seed('src/s.ts')], { after })

    expect(result.affected.map((entry) => entry.path)).toEqual([
      'bin/cli.ts',
      'index.html',
      'src/s.ts',
    ])
    const html = impactOf(result.affected, 'index.html')!
    expect(html.level).toBe('HIGH')
    expect(html.distance).toBe(1)
  })
})

describe('computeImpact graph-absent seeds', () => {
  it('keeps a changed file with no graph node as DIRECT no-graph-evidence', () => {
    const after = graph([node('src/a.ts', 'source')])
    const result = computeImpact([seed('assets/logo.png'), seed('src/a.ts')], { after })

    const logo = impactOf(result.affected, 'assets/logo.png')!
    expect(logo).toEqual({
      path: 'assets/logo.png',
      changed: true,
      level: 'DIRECT',
      distance: 0,
      reachability: 'no-graph-evidence',
      origin: 'after',
      via: [['assets/logo.png']],
      sources: ['assets/logo.png'],
      reasons: ['changed file assets/logo.png (modified)'],
    })
    expect(result.seeds).toContain('assets/logo.png')
  })

  it('returns an empty vacuous model for no seeds', () => {
    const result = computeImpact([], { after: graph([node('src/a.ts', 'source')]) })
    expect(result.seeds).toEqual([])
    expect(result.affected).toEqual([])
    expect(result.affectedTests).toEqual([])
    expect(result.coverage).toEqual({
      affectedAreas: 0,
      coveredAreas: 0,
      uncoveredAreas: 0,
      coveragePercent: 100,
      covered: [],
      uncovered: [],
    })
    expect(result.completeness).toBe('complete')
  })
})

describe('computeImpact deletions', () => {
  const before = graph([
    node('src/old.ts', 'source'),
    node('src/util.ts', 'source', ['src/old.ts']),
    node('src/main.ts', 'source', ['src/util.ts']),
  ])
  const after = graph([
    node('src/util.ts', 'source'),
    node('src/main.ts', 'source', ['src/util.ts']),
  ])

  it('traverses the BEFORE graph for deleted seeds with origin before', () => {
    const result = computeImpact([seed('src/old.ts', 'deleted')], { after, before })

    const old = impactOf(result.affected, 'src/old.ts')!
    expect(old.level).toBe('DIRECT')
    expect(old.distance).toBe(0)
    expect(old.origin).toBe('before')
    expect(old.reachability).toBe('known')

    const util = impactOf(result.affected, 'src/util.ts')!
    expect(util.level).toBe('HIGH')
    expect(util.distance).toBe(1)
    expect(util.origin).toBe('before')
    expect(util.via).toEqual([['src/old.ts', 'src/util.ts']])

    const main = impactOf(result.affected, 'src/main.ts')!
    expect(main.level).toBe('MEDIUM')
    expect(main.origin).toBe('before')
  })

  it('degrades to no-graph-evidence when the BEFORE graph is missing', () => {
    const result = computeImpact([seed('src/old.ts', 'deleted')], { after })
    expect(result.affected).toEqual([
      expect.objectContaining({
        path: 'src/old.ts',
        changed: true,
        level: 'DIRECT',
        distance: 0,
        reachability: 'no-graph-evidence',
        origin: 'before',
        via: [['src/old.ts']],
      }),
    ])
  })
})

describe('computeImpact renames', () => {
  it('seeds from oldPath in the BEFORE graph and path in the AFTER graph, yielding origin both', () => {
    const before = graph([
      node('src/old.ts', 'source'),
      node('src/c.ts', 'source', ['src/old.ts']),
    ])
    const after = graph([
      node('src/new.ts', 'source'),
      node('src/c.ts', 'source', ['src/new.ts']),
    ])
    const result = computeImpact([seed('src/new.ts', 'renamed', 'src/old.ts')], { after, before })

    expect(result.seeds).toEqual(['src/new.ts', 'src/old.ts'])

    const old = impactOf(result.affected, 'src/old.ts')!
    expect(old.changed).toBe(true)
    expect(old.level).toBe('DIRECT')
    expect(old.origin).toBe('before')
    expect(old.reasons).toEqual(['changed file src/old.ts (renamed)'])

    const updated = impactOf(result.affected, 'src/new.ts')!
    expect(updated.changed).toBe(true)
    expect(updated.origin).toBe('after')

    const c = impactOf(result.affected, 'src/c.ts')!
    expect(c.level).toBe('HIGH')
    expect(c.distance).toBe(1)
    expect(c.origin).toBe('both')
    expect(c.sources).toEqual(['src/new.ts', 'src/old.ts'])
    expect(c.via).toEqual([
      ['src/new.ts', 'src/c.ts'],
      ['src/old.ts', 'src/c.ts'],
    ])
    expect(c.reasons).toEqual([
      'imports chain from src/new.ts (distance 1, both graphs)',
      'imports chain from src/old.ts (distance 1, both graphs)',
    ])
  })

  it('degrades the old path to no-graph-evidence when the BEFORE graph is missing', () => {
    const after = graph([node('src/new.ts', 'source')])
    const result = computeImpact([seed('src/new.ts', 'renamed', 'src/old.ts')], { after })
    const old = impactOf(result.affected, 'src/old.ts')!
    expect(old.reachability).toBe('no-graph-evidence')
    expect(old.via).toEqual([['src/old.ts']])
    expect(result.affected.map((entry) => entry.path)).toEqual(['src/new.ts', 'src/old.ts'])
  })
})

describe('computeImpact affected tests', () => {
  it('selects tests importing impacted modules with their evidence chains', () => {
    const after = graph([
      node('src/util.ts', 'source'),
      node('src/a.ts', 'source', ['src/util.ts']),
      node('src/util.test.ts', 'test', ['src/util.ts']),
      node('src/a.test.ts', 'test', ['src/a.ts']),
    ])
    const result = computeImpact([seed('src/util.ts')], { after })

    expect(result.affectedTests).toEqual([
      {
        path: 'src/a.test.ts',
        sources: ['src/util.ts'],
        evidencePaths: [['src/util.ts', 'src/a.ts', 'src/a.test.ts']],
      },
      {
        path: 'src/util.test.ts',
        sources: ['src/util.ts'],
        evidencePaths: [['src/util.ts', 'src/util.test.ts']],
      },
    ])
  })
})

describe('computeImpact coverage review', () => {
  it('splits covered/uncovered areas, excludes seeds and tests from the population', () => {
    const after = graph([
      node('src/util.ts', 'source'),
      node('src/a.ts', 'source', ['src/util.ts']),
      node('src/b.ts', 'source', ['src/util.ts']),
      node('src/a.test.ts', 'test', ['src/a.ts']),
      node('src/util.test.ts', 'test', ['src/util.ts']),
    ])
    const result = computeImpact([seed('src/util.ts')], { after })

    // Population: src/a.ts and src/b.ts (seed and tests excluded).
    expect(result.coverage).toEqual({
      affectedAreas: 2,
      coveredAreas: 1,
      uncoveredAreas: 1,
      coveragePercent: 50,
      covered: ['src/a.ts'],
      uncovered: ['src/b.ts'],
    })
  })

  it('reports vacuous 100 percent coverage when there is nothing to cover', () => {
    const after = graph([
      node('src/a.ts', 'source'),
      node('src/a.test.ts', 'test', ['src/a.ts']),
    ])
    const result = computeImpact([seed('src/a.ts')], { after })
    expect(result.coverage).toEqual({
      affectedAreas: 0,
      coveredAreas: 0,
      uncoveredAreas: 0,
      coveragePercent: 100,
      covered: [],
      uncovered: [],
    })
  })
})

describe('computeImpact completeness', () => {
  it('marks the model partial and copies unresolved edges (after first, then before, deduped)', () => {
    const importEdge: UnresolvedEdge = {
      from: 'src/a.ts',
      specifier: './missing',
      kind: 'unresolved-import',
    }
    const dynamicEdge: UnresolvedEdge = {
      from: 'src/b.ts',
      specifier: 'legacy-module',
      kind: 'dynamic-import',
    }
    const beforeOnlyEdge: UnresolvedEdge = {
      from: 'src/island.ts',
      specifier: './gone',
      kind: 'unresolved-import',
    }
    const after = graph(
      [
        node('src/a.ts', 'source'),
        node('src/b.ts', 'source', ['src/a.ts']),
      ],
      // Both edges originate inside the after impact region (seed + reached).
      [importEdge, dynamicEdge],
    )
    const before = graph(
      [
        node('src/a.ts', 'source'),
        node('src/b.ts', 'source', ['src/a.ts']),
        node('src/island.ts', 'source'),
      ],
      // Duplicate of an after edge (deduped away) plus one edge from a node
      // the before traversal never reaches (modified seed → no before roots).
      [dynamicEdge, importEdge, beforeOnlyEdge],
    )

    const result = computeImpact([seed('src/a.ts')], { after, before })
    expect(result.completeness).toBe('partial')
    expect(result.unresolvedEdges).toEqual([importEdge, dynamicEdge])
    expect(result.repositoryUnresolvedEdges).toEqual([importEdge, dynamicEdge, beforeOnlyEdge])
  })

  it('treats an unresolved-import edge from an impacted (reached) node as impact-relevant', () => {
    const edge: UnresolvedEdge = { from: 'src/b.ts', specifier: './missing', kind: 'unresolved-import' }
    const after = graph(
      [node('src/a.ts', 'source'), node('src/b.ts', 'source', ['src/a.ts'])],
      [edge],
    )
    const result = computeImpact([seed('src/a.ts')], { after })
    expect(result.completeness).toBe('partial')
    expect(result.unresolvedEdges).toEqual([edge])
    expect(result.repositoryUnresolvedEdges).toEqual([edge])
  })

  it('treats a computed dynamic-import edge from an impacted node as impact-relevant', () => {
    const edge: UnresolvedEdge = { from: 'src/b.ts', specifier: '(computed)', kind: 'dynamic-import' }
    const after = graph(
      [node('src/a.ts', 'source'), node('src/b.ts', 'source', ['src/a.ts'])],
      [edge],
    )
    const result = computeImpact([seed('src/a.ts')], { after })
    expect(result.completeness).toBe('partial')
    expect(result.unresolvedEdges).toEqual([edge])
  })

  it('stays complete for unresolved edges from nodes outside the impact region', () => {
    const islandEdge: UnresolvedEdge = {
      from: 'src/island.ts',
      specifier: './missing',
      kind: 'unresolved-import',
    }
    const after = graph(
      [node('src/a.ts', 'source'), node('src/island.ts', 'source')],
      [islandEdge],
    )
    const result = computeImpact([seed('src/a.ts')], { after })
    // The island is neither a seed nor reached: its uncertainty cannot make
    // the whole assessment partial, but it stays visible repository-wide.
    expect(result.completeness).toBe('complete')
    expect(result.unresolvedEdges).toEqual([])
    expect(result.repositoryUnresolvedEdges).toEqual([islandEdge])
  })

  it('evaluates deletions against the traversed BEFORE region', () => {
    const edge: UnresolvedEdge = { from: 'src/util.ts', specifier: './missing', kind: 'unresolved-import' }
    const before = graph(
      [
        node('src/old.ts', 'source'),
        node('src/util.ts', 'source', ['src/old.ts']),
        node('src/main.ts', 'source', ['src/util.ts']),
      ],
      [edge],
    )
    const after = graph([
      node('src/util.ts', 'source'),
      node('src/main.ts', 'source', ['src/util.ts']),
    ])
    // util.ts is reached only via the before traversal; the before-graph edge
    // from it is impact-relevant even though nothing about it exists after.
    const result = computeImpact([seed('src/old.ts', 'deleted')], { after, before })
    expect(result.completeness).toBe('partial')
    expect(result.unresolvedEdges).toEqual([edge])
    expect(result.repositoryUnresolvedEdges).toEqual([edge])
  })

  it('ignores an after-graph edge from an unreached node for deletions (before region only)', () => {
    const edge: UnresolvedEdge = { from: 'src/util.ts', specifier: './missing', kind: 'unresolved-import' }
    const before = graph([
      node('src/old.ts', 'source'),
      node('src/util.ts', 'source', ['src/old.ts']),
      node('src/main.ts', 'source', ['src/util.ts']),
    ])
    // Same-shaped edge, but present ONLY in the after graph: the deletion
    // traversal never visits the after graph, so the pairing (edge graph,
    // node origin) fails and the edge is not impact-relevant.
    const after = graph(
      [
        node('src/util.ts', 'source'),
        node('src/main.ts', 'source', ['src/util.ts']),
      ],
      [edge],
    )
    const result = computeImpact([seed('src/old.ts', 'deleted')], { after, before })
    expect(result.completeness).toBe('complete')
    expect(result.unresolvedEdges).toEqual([])
    expect(result.repositoryUnresolvedEdges).toEqual([edge])
  })

  it('evaluates renames against both regions — a before-side edge alone flips completeness', () => {
    const beforeEdge: UnresolvedEdge = {
      from: 'src/before-importer.ts',
      specifier: './gone',
      kind: 'unresolved-import',
    }
    const before = graph(
      [
        node('src/old.ts', 'source'),
        node('src/before-importer.ts', 'source', ['src/old.ts']),
      ],
      [beforeEdge],
    )
    const after = graph([node('src/new.ts', 'source')])
    const result = computeImpact([seed('src/new.ts', 'renamed', 'src/old.ts')], { after, before })
    // before-importer.ts is reached only via the old path in the BEFORE graph;
    // that alone is enough to make the rename assessment partial.
    expect(result.completeness).toBe('partial')
    expect(result.unresolvedEdges).toEqual([beforeEdge])
    expect(result.repositoryUnresolvedEdges).toEqual([beforeEdge])
  })

  it('evaluates renames against both regions — an after-side edge alone flips completeness', () => {
    const afterEdge: UnresolvedEdge = {
      from: 'src/after-importer.ts',
      specifier: './gone',
      kind: 'unresolved-import',
    }
    const before = graph([node('src/old.ts', 'source')])
    const after = graph(
      [
        node('src/new.ts', 'source'),
        node('src/after-importer.ts', 'source', ['src/new.ts']),
      ],
      [afterEdge],
    )
    const result = computeImpact([seed('src/new.ts', 'renamed', 'src/old.ts')], { after, before })
    // after-importer.ts is reached only via the new path in the AFTER graph;
    // that alone is enough to make the rename assessment partial.
    expect(result.completeness).toBe('partial')
    expect(result.unresolvedEdges).toEqual([afterEdge])
    expect(result.repositoryUnresolvedEdges).toEqual([afterEdge])
  })

  it('is deterministic across repeat calls including both edge populations', () => {
    const reachedEdge: UnresolvedEdge = {
      from: 'src/b.ts',
      specifier: './missing',
      kind: 'unresolved-import',
    }
    const islandEdge: UnresolvedEdge = {
      from: 'src/island.ts',
      specifier: './missing',
      kind: 'unresolved-import',
    }
    const buildGraphs = () => ({
      after: graph(
        [node('src/a.ts', 'source'), node('src/b.ts', 'source', ['src/a.ts']), node('src/island.ts', 'source')],
        [reachedEdge, islandEdge],
      ),
      before: graph([node('src/a.ts', 'source')], [reachedEdge]),
    })
    const first = computeImpact([seed('src/a.ts')], buildGraphs())
    const second = computeImpact([seed('src/a.ts')], buildGraphs())
    expect(first).toEqual(second)
    expect(first.unresolvedEdges).toEqual([reachedEdge])
    expect(first.repositoryUnresolvedEdges).toEqual([reachedEdge, islandEdge])
  })

  it('stays complete without unresolved edges', () => {
    const after = graph([node('src/a.ts', 'source')])
    const result = computeImpact([seed('src/a.ts')], { after })
    expect(result.completeness).toBe('complete')
    expect(result.unresolvedEdges).toEqual([])
    expect(result.repositoryUnresolvedEdges).toEqual([])
  })
})
