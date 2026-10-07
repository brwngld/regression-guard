import { describe, expect, it } from 'vitest'
import { analyzeScope } from './scope'
import { parseContract } from '../schema/contract'
import type { EnrichedChangeSet, EnrichedRecord } from '../schema/changeset'
import type { DependencyGraph } from '../intel/graph'

function record(overrides: Partial<EnrichedRecord> & { path: string }): EnrichedRecord {
  return {
    status: 'modified',
    binary: false,
    hunks: [
      { beforeStart: 1, beforeCount: 1, afterStart: 1, afterCount: 2, added: 1, removed: 0 },
    ],
    addedLines: 1,
    removedLines: 0,
    categories: [],
    isTest: false,
    ...overrides,
  }
}

function enriched(
  records: EnrichedRecord[],
  dependencies: EnrichedChangeSet['dependencies'] = { added: [], removed: [], changed: [] },
  manifestReadability: EnrichedChangeSet['manifestReadability'] = { before: 'parsed', after: 'parsed' },
): EnrichedChangeSet {
  return {
    changeSet: {
      before: 'main',
      after: 'feature',
      beforeSha: 'aaaaaaa',
      afterSha: 'bbbbbbb',
      records,
    },
    records,
    dependencies,
    manifestReadability,
  }
}

const GRAPH: DependencyGraph = {
  files: {
    'src/pages/Home.tsx': { path: 'src/pages/Home.tsx', kind: 'source', imports: ['src/components/Header.tsx'], externalImports: [] },
    'src/components/Header.tsx': { path: 'src/components/Header.tsx', kind: 'source', imports: [], externalImports: [] },
    'src/components/Header.test.tsx': { path: 'src/components/Header.test.tsx', kind: 'test', imports: ['src/components/Header.tsx'], externalImports: ['vitest'] },
    'src/tasks.js': { path: 'src/tasks.js', kind: 'source', imports: [], externalImports: [] },
    'package.json': { path: 'package.json', kind: 'config', imports: [], externalImports: [] },
  },
  importedBy: {
    'src/components/Header.tsx': ['src/pages/Home.tsx', 'src/components/Header.test.tsx'],
    'src/tasks.js': [],
  },
}

function contractOf(paths: Record<string, unknown>): ReturnType<typeof parseContract> {
  return parseContract({ id: 'test', goal: 'test goal', paths })
}

describe('analyzeScope classification', () => {
  it('classifies must-change matches as EXPECTED', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'] }),
      enriched([record({ path: 'src/style.css' })]),
      GRAPH,
    )
    expect(result.assessment.perPath[0]?.classification).toBe('EXPECTED')
    expect(result.findings).toEqual([])
  })

  it('classifies may-change matches as RELATED', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'], mayChange: ['index.html'] }),
      enriched([record({ path: 'src/style.css' }), record({ path: 'index.html' })]),
      GRAPH,
    )
    expect(result.assessment.perPath.map((item) => [item.path, item.classification])).toEqual([
      ['src/style.css', 'EXPECTED'],
      ['index.html', 'RELATED'],
    ])
  })

  it('classifies graph-adjacent changes as RELATED with an edge reason', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/pages/Home.tsx'] }),
      enriched([record({ path: 'src/pages/Home.tsx' }), record({ path: 'src/components/Header.tsx' })]),
      GRAPH,
    )
    const header = result.assessment.perPath.find((item) => item.path === 'src/components/Header.tsx')
    expect(header?.classification).toBe('RELATED')
    expect(header?.reason).toBe('imported-by:src/pages/Home.tsx')
  })

  it('classifies must-preserve matches as SUSPICIOUS with a finding', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'], mustPreserve: ['src/tasks.js'] }),
      enriched([record({ path: 'src/style.css' }), record({ path: 'src/tasks.js' })]),
      GRAPH,
    )
    const tasks = result.assessment.perPath.find((item) => item.path === 'src/tasks.js')
    expect(tasks?.classification).toBe('SUSPICIOUS')
    expect(result.findings.map((finding) => finding.findingClass)).toContain('preserved-area-changed')
  })

  it('classifies prohibited matches as PROHIBITED, winning over must-change', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/**'], prohibited: ['src/tasks.js'] }),
      enriched([record({ path: 'src/tasks.js' })]),
      GRAPH,
    )
    expect(result.assessment.perPath[0]?.classification).toBe('PROHIBITED')
    expect(result.findings.map((finding) => finding.findingClass)).toEqual(['prohibited-change'])
  })

  it('classifies unmatched changes as OUT_OF_SCOPE with a finding', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'] }),
      enriched([record({ path: 'src/style.css' }), record({ path: 'README.md' })]),
      GRAPH,
    )
    const readme = result.assessment.perPath.find((item) => item.path === 'README.md')
    expect(readme?.classification).toBe('OUT_OF_SCOPE')
    expect(result.findings.map((finding) => finding.findingClass)).toEqual(['out-of-scope-change'])
  })

  it('flags sensitive out-of-scope files separately', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'] }),
      enriched([record({ path: 'db/schema.sql', categories: ['database-schema'] })]),
      GRAPH,
    )
    expect(result.findings.map((finding) => finding.findingClass)).toEqual([
      'out-of-scope-change',
      'sensitive-file-changed',
      'unfulfilled-contract',
    ])
  })

  it('matches prohibited dependency-addition category through the dependency diff', () => {
    const result = analyzeScope(
      contractOf({
        mustChange: ['src/style.css'],
        prohibited: [{ category: 'dependency-addition' }],
      }),
      enriched(
        [record({ path: 'src/style.css' }), record({ path: 'package.json' })],
        { added: [{ name: 'leftpad', section: 'dependencies', version: '^1.0.0' }], removed: [], changed: [] },
      ),
      GRAPH,
    )
    const pkg = result.assessment.perPath.find((item) => item.path === 'package.json')
    expect(pkg?.classification).toBe('PROHIBITED')
    expect(result.findings.map((finding) => finding.findingClass)).toEqual([
      'prohibited-change',
      'new-dependency',
    ])
  })

  it('flags unauthorized test deletion', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'] }),
      enriched([record({ path: 'src/components/Header.test.tsx', status: 'deleted', isTest: true, hunks: [] })]),
      GRAPH,
    )
    expect(result.findings.map((finding) => finding.findingClass)).toEqual([
      'out-of-scope-change',
      'deleted-test',
      'unfulfilled-contract',
    ])
  })

  it('does not flag authorized test deletion', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/components/Header.test.tsx'] }),
      enriched([record({ path: 'src/components/Header.test.tsx', status: 'deleted', isTest: true, hunks: [] })]),
      GRAPH,
    )
    expect(result.findings).toEqual([])
  })

  it('matches renames against the old path', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'] }),
      enriched([record({ path: 'src/theme.css', oldPath: 'src/style.css', status: 'renamed' })]),
      GRAPH,
    )
    expect(result.assessment.perPath[0]?.classification).toBe('EXPECTED')
  })

  it('reports unfulfilled must-change areas', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'] }),
      enriched([record({ path: 'README.md' })]),
      GRAPH,
    )
    expect(result.findings.map((finding) => finding.findingClass)).toEqual([
      'out-of-scope-change',
      'unfulfilled-contract',
    ])
  })

  it('attaches evidence with a kind and reproduction command to every finding', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'], mustPreserve: ['src/tasks.js'] }),
      enriched([record({ path: 'src/tasks.js' })]),
      GRAPH,
    )
    const finding = result.findings[0]
    expect(finding?.evidence.kind).toBe('diff')
    expect(finding?.evidence.reproduction).toBe('git -C <repo> diff main feature -- src/tasks.js')
    expect(finding?.evidence.claim).toContain('must-preserve')
    expect(finding?.evidence.changedLines[0]?.file).toBe('src/tasks.js')
  })

  it('marks dependency findings with dependency evidence kind', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'] }),
      enriched([record({ path: 'src/style.css' }), record({ path: 'package.json' })], {
        added: [{ name: 'leftpad', section: 'dependencies', version: '^1.0.0' }],
        removed: [],
        changed: [],
      }),
      GRAPH,
    )
    const dep = result.findings.find((finding) => finding.findingClass === 'new-dependency')
    expect(dep?.evidence.kind).toBe('dependency')
  })
})

describe('dependency state unknown (missing or malformed package manifest)', () => {
  it('reports one informational DEPU finding instead of a diff when the after manifest is malformed', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'] }),
      enriched(
        [record({ path: 'src/style.css' }), record({ path: 'package.json' })],
        { added: [], removed: [], changed: [] },
        { before: 'parsed', after: 'malformed' },
      ),
      GRAPH,
    )
    const classes = result.findings.map((finding) => finding.findingClass)
    expect(classes).not.toContain('new-dependency')
    expect(classes).not.toContain('removed-dependency')
    expect(classes).not.toContain('changed-dependency')
    const unknown = result.findings.filter((finding) => finding.findingClass === 'dependency-state-unknown')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.id).toBe('DEPU-001')
    expect(unknown[0]?.severity).toBe('info')
    expect(unknown[0]?.paths).toEqual(['package.json'])
    expect(unknown[0]?.message).toBe(
      'Dependency state unknown: the after package manifest is malformed; no dependency comparison is claimed.',
    )
    expect(unknown[0]?.evidence.kind).toBe('dependency')
    expect(unknown[0]?.evidence.claim).toContain('UNKNOWN, not unchanged')
    expect(unknown[0]?.evidence.observation).toContain('before: parsed, after: malformed')
    expect(unknown[0]?.evidence.reproduction).toBe('git -C <repo> show feature:package.json')
  })

  it('names both sides and stays runnable in working-tree mode when neither manifest is readable', () => {
    const fixture = enriched([], { added: [], removed: [], changed: [] }, {
      before: 'missing',
      after: 'malformed',
    })
    fixture.changeSet = { ...fixture.changeSet, after: 'working-tree' }

    const result = analyzeScope(contractOf({}), fixture, GRAPH)
    const classes = result.findings.map((finding) => finding.findingClass)
    expect(classes).toEqual(['dependency-state-unknown'])
    const unknown = result.findings[0]
    expect(unknown?.message).toBe(
      'Dependency state unknown: the before package manifest is missing and the after package manifest is malformed; no dependency comparison is claimed.',
    )
    expect(unknown?.evidence.reproduction).toBe(
      'git -C <repo> show main:package.json ; read package.json from the working tree',
    )
  })

  it('never emits a dependency diff from unreadable evidence, even if a diff was supplied', () => {
    // Defense in depth: enrichChangeSet empties the diff when a manifest is
    // unreadable, but the analyzer must not trust that — a stale or hand-built
    // diff must not turn "could not read" into "removed".
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'] }),
      enriched(
        [record({ path: 'package.json' })],
        {
          added: [],
          removed: [{ name: 'vite', section: 'devDependencies', version: '^5.0.0' }],
          changed: [],
        },
        { before: 'parsed', after: 'missing' },
      ),
      GRAPH,
    )
    const classes = result.findings.map((finding) => finding.findingClass)
    expect(classes).not.toContain('removed-dependency')
    expect(classes.filter((cls) => cls === 'dependency-state-unknown')).toHaveLength(1)
  })

  it('still diffs dependencies when both manifests parsed (existing behavior)', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/style.css'] }),
      enriched(
        [record({ path: 'src/style.css' }), record({ path: 'package.json' })],
        { added: [], removed: [{ name: 'vite', section: 'devDependencies', version: '^5.0.0' }], changed: [] },
        { before: 'parsed', after: 'parsed' },
      ),
      GRAPH,
    )
    const classes = result.findings.map((finding) => finding.findingClass)
    expect(classes).toContain('removed-dependency')
    expect(classes).not.toContain('dependency-state-unknown')
  })
})

describe('adjacency lock-down (must not become authorization propagation)', () => {
  // A imports B, B imports C — a strictly linear chain.
  const CHAIN: DependencyGraph = {
    files: {
      'src/A.js': { path: 'src/A.js', kind: 'source', imports: ['src/B.js'], externalImports: [] },
      'src/B.js': { path: 'src/B.js', kind: 'source', imports: ['src/C.js'], externalImports: [] },
      'src/C.js': { path: 'src/C.js', kind: 'source', imports: [], externalImports: [] },
    },
    importedBy: {
      'src/B.js': ['src/A.js'],
      'src/C.js': ['src/B.js'],
    },
  }

  const CHANGED = ['src/A.js', 'src/B.js', 'src/C.js'].map((path) => record({ path }))

  it('RELATED is one-hop and non-transitive: A→B→C stays EXPECTED/RELATED/OUT_OF_SCOPE', () => {
    const result = analyzeScope(contractOf({ mustChange: ['src/A.js'] }), enriched(CHANGED), CHAIN)
    expect(result.assessment.perPath.map((item) => [item.path, item.classification])).toEqual([
      ['src/A.js', 'EXPECTED'],
      ['src/B.js', 'RELATED'],
      ['src/C.js', 'OUT_OF_SCOPE'],
    ])
  })

  it('graph adjacency can never override mustPreserve', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/A.js'], mustPreserve: ['src/C.js'] }),
      enriched(CHANGED),
      CHAIN,
    )
    const byPath = new Map(result.assessment.perPath.map((item) => [item.path, item.classification]))
    expect(byPath.get('src/B.js')).toBe('RELATED')
    expect(byPath.get('src/C.js')).toBe('SUSPICIOUS')
  })

  it('graph adjacency can never override prohibited', () => {
    const result = analyzeScope(
      contractOf({ mustChange: ['src/A.js'], prohibited: ['src/C.js'] }),
      enriched(CHANGED),
      CHAIN,
    )
    const byPath = new Map(result.assessment.perPath.map((item) => [item.path, item.classification]))
    expect(byPath.get('src/B.js')).toBe('RELATED')
    expect(byPath.get('src/C.js')).toBe('PROHIBITED')
  })
})
