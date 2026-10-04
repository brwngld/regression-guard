import { describe, expect, it } from 'vitest'
import { buildGraph, collectJsImports, type RepoReader } from './graph'
import { UnresolvedEdgeSchema } from '../schema/impact'

/**
 * In-memory RepoReader: listFiles returns keys in insertion order (buildGraph
 * must establish determinism itself, not inherit it from the listing).
 */
function memoryReader(files: Record<string, string>): RepoReader {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (path) => files[path] ?? null,
  }
}

describe('buildGraph graph honesty (unresolved edges)', () => {
  it('records an unresolvable relative import as an unresolved-import edge and creates no node for it', async () => {
    const graph = await buildGraph(memoryReader({
      'src/main.ts': "import x from './missing.js'\n",
    }))

    expect(graph.unresolvedEdges).toEqual([
      { from: 'src/main.ts', specifier: './missing.js', kind: 'unresolved-import' },
    ])
    expect(UnresolvedEdgeSchema.safeParse(graph.unresolvedEdges?.[0]).success).toBe(true)

    // No guessed target: only the importing file exists as a node.
    expect(Object.keys(graph.files)).toEqual(['src/main.ts'])
    expect(graph.files['src/main.ts']?.imports).toEqual([])
    expect(graph.importedBy['src/missing.js']).toBeUndefined()
    expect(graph.importedBy['src/missing.ts']).toBeUndefined()
  })

  it('records a computed dynamic import as a dynamic-import edge with specifier (computed)', async () => {
    const graph = await buildGraph(memoryReader({
      'src/loader.ts': 'const mod = await import(moduleName)\n',
    }))

    expect(graph.unresolvedEdges).toEqual([
      { from: 'src/loader.ts', specifier: '(computed)', kind: 'dynamic-import' },
    ])
    expect(Object.keys(graph.files)).toEqual(['src/loader.ts'])
    expect(graph.files['src/loader.ts']?.imports).toEqual([])
  })

  it('produces no unresolved edges for resolvable relative imports; bare specifiers stay external', async () => {
    const graph = await buildGraph(memoryReader({
      'src/main.ts': "import { helper } from './helper.js'\nimport { describe } from 'vitest'\n",
      'src/helper.ts': 'export const helper = 1\n',
    }))

    expect(graph.unresolvedEdges).toEqual([])
    expect(graph.files['src/main.ts']?.imports).toEqual(['src/helper.ts'])
    expect(graph.files['src/main.ts']?.externalImports).toEqual(['vitest'])
    expect(graph.importedBy['src/helper.ts']).toEqual(['src/main.ts'])
  })

  it('deduplicates: repeated computed dynamic imports and repeated unresolvable specifiers yield one edge each', async () => {
    const content = [
      'async function one() { return await import(name) }',
      'async function two() { return await import(other) }',
      "import a from './ghost.js'",
      "import b from './ghost.js'",
    ].join('\n')

    expect(collectJsImports(content).computedDynamicImports).toBe(2)

    const graph = await buildGraph(memoryReader({ 'src/twice.ts': `${content}\n` }))
    expect(graph.unresolvedEdges).toEqual([
      { from: 'src/twice.ts', specifier: '(computed)', kind: 'dynamic-import' },
      { from: 'src/twice.ts', specifier: './ghost.js', kind: 'unresolved-import' },
    ])
  })

  it('orders unresolvedEdges deterministically by (from, specifier, kind) regardless of listing order', async () => {
    // Deliberately listed out of order: b before a.
    const graph = await buildGraph(memoryReader({
      'src/b.ts': "import x from './missing.js'\nexport async function pick(n: string) {\n  return await import(n)\n}\n",
      'src/a.ts': "import gone from './gone.js'\nimport also from './missing.js'\n",
    }))

    expect(graph.unresolvedEdges).toEqual([
      { from: 'src/a.ts', specifier: './gone.js', kind: 'unresolved-import' },
      { from: 'src/a.ts', specifier: './missing.js', kind: 'unresolved-import' },
      { from: 'src/b.ts', specifier: '(computed)', kind: 'dynamic-import' },
      { from: 'src/b.ts', specifier: './missing.js', kind: 'unresolved-import' },
    ])
  })

  it('represents a mixed file correctly: resolved import, unresolved import, computed dynamic, bare external', async () => {
    const graph = await buildGraph(memoryReader({
      'src/app.ts': [
        "import { helper } from './helper.js'",
        "import lost from './missing.js'",
        'const mod = await import(name)',
        "import { describe } from 'vitest'",
      ].join('\n') + '\n',
      'src/helper.ts': 'export const helper = 1\n',
    }))

    // Nodes: only real files — nothing fabricated for './missing.js'.
    expect(Object.keys(graph.files).sort()).toEqual(['src/app.ts', 'src/helper.ts'])

    // The resolved edge is a normal import; the bare specifier stays external.
    expect(graph.files['src/app.ts']?.imports).toEqual(['src/helper.ts'])
    expect(graph.files['src/app.ts']?.externalImports).toEqual(['vitest'])
    expect(graph.importedBy['src/helper.ts']).toEqual(['src/app.ts'])

    // Both unresolvable facts are surfaced, sorted ('(' sorts before '.').
    expect(graph.unresolvedEdges).toEqual([
      { from: 'src/app.ts', specifier: '(computed)', kind: 'dynamic-import' },
      { from: 'src/app.ts', specifier: './missing.js', kind: 'unresolved-import' },
    ])
  })
})

describe('collectJsImports computed dynamic imports', () => {
  it('counts dynamic imports whose argument is not a string literal', () => {
    const content = 'const a = await import(name)\nconst b = await import(`./mods/${m}`)\n'
    const result = collectJsImports(content)
    expect(result.computedDynamicImports).toBe(2)
    expect(result.relative).toEqual([])
    expect(result.external).toEqual([])
  })

  it('keeps string dynamic imports statically classified and reports zero computed', () => {
    const content = "import x from './a.js'\nimport('vitest')\nimport('./b.js')\n"
    const result = collectJsImports(content)
    expect(result.computedDynamicImports).toBe(0)
    expect(result.relative).toEqual(['./a.js', './b.js'])
    expect(result.external).toEqual(['vitest'])
  })
})
