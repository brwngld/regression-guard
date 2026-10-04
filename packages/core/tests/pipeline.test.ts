import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildGraph } from '../src/intel/graph'
import { verifyChange } from '../src/pipeline'
import { GitAdapter } from '../src/vcs/git'
import { SAMPLE_APP, TempRepo } from './helpers/repo'

describe('repository intelligence graph', () => {
  let repo: TempRepo

  beforeAll(async () => {
    repo = await TempRepo.create(SAMPLE_APP)
  })

  afterAll(async () => {
    await repo.destroy()
  })

  it('builds import edges, reverse edges, and kinds from a real git ref', async () => {
    const git = await GitAdapter.open(repo.dir)
    const graph = await buildGraph(git, 'HEAD')

    expect(graph.files['src/main.js']?.imports.sort()).toEqual([
      'src/style.css',
      'src/tasks.js',
      'src/ui/render.js',
    ])
    expect(graph.files['src/tasks.test.js']?.kind).toBe('test')
    expect(graph.files['index.html']?.imports).toEqual(['src/main.js'])
    expect(graph.files['index.html']?.kind).toBe('entry-html')
    expect(graph.files['src/tasks.test.js']?.externalImports).toEqual([])
    expect(graph.importedBy['src/tasks.js']?.sort()).toEqual(['src/main.js', 'src/tasks.test.js'])
  })
})

const UI_CONTRACT = `
id: ui-polish
goal: Polish the app's visual styling
paths:
  mustChange:
    - "src/style.css"
  mayChange:
    - "index.html"
  mustPreserve:
    - "src/tasks.js"
  prohibited:
    - category: dependency-addition
`

describe('verifyChange end-to-end', () => {
  let repo: TempRepo

  beforeAll(async () => {
    repo = await TempRepo.create(SAMPLE_APP)
    await repo.git('branch', 'base')
  })

  afterAll(async () => {
    await repo.destroy()
  })

  it('accepts an in-scope styling change', async () => {
    await repo.write({ 'src/style.css': 'body { margin: 0; padding: 1rem; }\n' })
    await repo.commit('polish styles')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'HEAD', contract: UI_CONTRACT })

    expect(report.verdict).toBe('ACCEPT')
    expect(report.threeQuestions).toEqual({
      accomplished: 'yes',
      withinScope: 'yes',
      regressions: 'not-verified',
    })
    expect(report.statistics).toMatchObject({ filesChanged: 1, expected: 1 })
    expect(report.findings).toEqual([])
    expect(report.markdown).toContain('## Verdict: ACCEPT')
  })

  it('rejects a change that touches the must-preserve logic file', async () => {
    await repo.write({
      'src/style.css': 'body { margin: 2rem; }\n',
      'src/tasks.js': `export function addTask(tasks, text) {
  return [...tasks, { text, done: false }]
}
`,
    })
    await repo.commit('also refactor logic')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'HEAD', contract: UI_CONTRACT })

    expect(report.verdict).toBe('REJECT')
    expect(report.threeQuestions.withinScope).toBe('no')
    const classes = report.findings.map((finding) => finding.findingClass)
    expect(classes).toContain('preserved-area-changed')
    const tasks = report.perPath.find((item) => item.path === 'src/tasks.js')
    expect(tasks?.classification).toBe('SUSPICIOUS')

    const finding = report.findings.find((item) => item.findingClass === 'preserved-area-changed')
    expect(finding?.evidence.reproduction).toContain('git -C <repo> diff base HEAD -- src/tasks.js')
    expect(finding?.evidence.changedLines[0]?.hunks.length).toBeGreaterThan(0)
  })

  it('rejects prohibited dependency additions and flags them separately', async () => {
    await repo.write({
      'package.json': JSON.stringify(
        {
          name: 'sample-app',
          version: '1.0.0',
          type: 'module',
          dependencies: { vitest: '^5.0.0', leftpad: '^1.0.0' },
        },
        null,
        2,
      ),
    })
    await repo.commit('add leftpad')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'HEAD', contract: UI_CONTRACT })

    expect(report.verdict).toBe('REJECT')
    const classes = report.findings.map((finding) => finding.findingClass)
    expect(classes).toContain('prohibited-change')
    expect(classes).toContain('new-dependency')
    expect(report.findings.find((f) => f.findingClass === 'new-dependency')?.message).toContain('leftpad')
  })

  it('reviews an out-of-scope change and reports the unfulfilled contract', async () => {
    await repo.git('checkout', '-q', '-b', 'docs-only', 'base')
    await repo.write({ 'README.md': '# Sample app\n\nNow with more docs.\n' })
    await repo.commit('docs tweak')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'docs-only', contract: UI_CONTRACT })

    expect(report.verdict).toBe('REVIEW')
    const classes = report.findings.map((finding) => finding.findingClass)
    expect(classes).toEqual(['out-of-scope-change', 'unfulfilled-contract'])
    expect(report.threeQuestions.accomplished).toBe('no')
    expect(report.markdown).toContain('NOT VERIFIED')
    expect(() => JSON.parse(report.json)).not.toThrow()
  })

  it('classifies graph-adjacent changes as RELATED in a real repo', async () => {
    await repo.git('checkout', '-q', '-b', 'adjacent', 'base')
    await repo.write({
      'src/style.css': 'body { margin: 4rem; }\n',
      // main.js is not named in the contract, but it imports the declared
      // area src/style.css, so touching it is plausibly required.
      'src/main.js': `import { addTask } from './tasks.js'
import { render } from './ui/render.js'
import './style.css'

render(addTask([], 'hello'), document.body)
`,
    })
    await repo.commit('wire styles')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'adjacent', contract: UI_CONTRACT })

    const main = report.perPath.find((item) => item.path === 'src/main.js')
    expect(main?.classification).toBe('RELATED')
    expect(main?.reason).toBe('imports:src/style.css')
    expect(report.verdict).toBe('ACCEPT')
  })

  it('flags deleted tests and sensitive files outside scope', async () => {
    await repo.git('checkout', '-q', '-b', 'risky', 'base')
    await repo.write({ 'src/style.css': 'body { margin: 0; }\n' })
    await repo.remove(['src/tasks.test.js'])
    await repo.write({ 'db/schema.sql': 'CREATE TABLE users;\n' })
    await repo.commit('risky cleanup')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'risky', contract: UI_CONTRACT })

    const classes = report.findings.map((finding) => finding.findingClass)
    expect(classes).toContain('deleted-test')
    expect(classes).toContain('out-of-scope-change')
    expect(classes).toContain('sensitive-file-changed')
    expect(report.verdict).toBe('REVIEW')
  })

  it('handles renames against must-change globs', async () => {
    await repo.git('checkout', '-q', '-b', 'rename', 'base')
    await repo.renamePath('src/style.css', 'src/theme.css')
    await repo.write({ 'src/main.js': SAMPLE_APP['src/main.js']?.replace('./style.css', './theme.css') ?? '' })
    await repo.commit('rename stylesheet')

    const report = await verifyChange({ repo: repo.dir, before: 'base', after: 'rename', contract: UI_CONTRACT })

    // The renamed file matches must-change via its old path, and the
    // import-site edit stays RELATED through change adjacency.
    const renamed = report.perPath.find((item) => item.path === 'src/theme.css')
    expect(renamed?.classification).toBe('EXPECTED')
    const main = report.perPath.find((item) => item.path === 'src/main.js')
    expect(main?.classification).toBe('RELATED')
    expect(report.verdict).toBe('ACCEPT')
  })

  it('fails clearly for unknown refs', async () => {
    await expect(
      verifyChange({ repo: repo.dir, before: 'base', after: 'does-not-exist', contract: UI_CONTRACT }),
    ).rejects.toThrow(/does-not-exist/)
  })
})
