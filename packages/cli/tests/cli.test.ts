import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const exec = promisify(execFile)

const CLI_ENTRY = join(import.meta.dirname, '..', 'dist', 'cli.js')

const SAMPLE_APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'sample-app', version: '1.0.0', type: 'module' }, null, 2),
  'index.html': '<html><body><script type="module" src="/src/main.js"></script></body></html>\n',
  'src/main.js': `import { addTask } from './tasks.js'
import './style.css'

console.log(addTask([], 'hi'))
`,
  'src/tasks.js': `export function addTask(tasks, text) {
  return [...tasks, { text }]
}
`,
  'src/tasks.test.js': `import { addTask } from './tasks.js'
it('adds', () => {})
`,
  'src/style.css': 'body { margin: 0; }\n',
}

const CONTRACT = `
id: ui-polish
goal: Polish the app styling
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

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

async function runCli(args: string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, stdout: stdout.replace(/\r\n/g, '\n'), stderr: stderr.replace(/\r\n/g, '\n') }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: failure.code ?? -1,
      stdout: (failure.stdout ?? '').replace(/\r\n/g, '\n'),
      stderr: (failure.stderr ?? '').replace(/\r\n/g, '\n'),
    }
  }
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(
    'git',
    ['-c', 'user.name=Regression Guard', '-c', 'user.email=rg@example.com', '-c', 'core.autocrlf=false', ...args],
    { cwd: dir, windowsHide: true },
  )
  return stdout
}

describe('regression-guard CLI (end-to-end)', () => {
  let repoDir: string

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'rg-cli-'))
    for (const [file, content] of Object.entries(SAMPLE_APP)) {
      const target = join(repoDir, file)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    await writeFile(join(repoDir, 'contract.yaml'), CONTRACT, 'utf8')
    await git(repoDir, 'init', '-q')
    await git(repoDir, 'add', '-A')
    await git(repoDir, 'commit', '-qm', 'base')
    await git(repoDir, 'branch', 'base')
  })

  afterAll(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it('exits 0 and prints an ACCEPT report for an in-scope change', async () => {
    await writeFile(join(repoDir, 'src/style.css'), 'body { margin: 1rem; }\n', 'utf8')
    await git(repoDir, 'add', '-A')
    await git(repoDir, 'commit', '-qm', 'polish')

    const result = await runCli(
      ['verify', '--contract', 'contract.yaml', '--before', 'base', '--after', 'HEAD'],
      repoDir,
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('## Verdict: ACCEPT')
    expect(result.stdout).toContain('1. **Requested change accomplished?** yes')
    expect(result.stderr).toContain('ACCEPT')
  })

  it('exits 1 with a REJECT report and evidence when must-preserve is touched', async () => {
    await writeFile(join(repoDir, 'src/tasks.js'), `export function addTask(tasks, text) {
  return [...tasks, { text, done: false }]
}
`, 'utf8')
    await git(repoDir, 'add', '-A')
    await git(repoDir, 'commit', '-qm', 'touch logic')

    const result = await runCli(
      ['verify', '--contract', 'contract.yaml', '--before', 'base', '--after', 'HEAD'],
      repoDir,
    )

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('## Verdict: REJECT')
    expect(result.stdout).toContain('preserved-area-changed')
    expect(result.stdout).toContain('git -C <repo> diff base HEAD -- src/tasks.js')
    expect(result.stderr).toContain('in-scope: no')
  })

  it('emits machine-readable JSON with --format json', async () => {
    const result = await runCli(
      ['verify', '--contract', 'contract.yaml', '--before', 'base', '--after', 'HEAD', '--format', 'json'],
      repoDir,
    )

    expect(result.code).toBe(1)
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number
      verdict: string
      threeQuestions: { regressions: { status: string } }
      findings: { findingClass: string; evidence: { kind: string } }[]
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.verdict).toBe('REJECT')
    expect(parsed.threeQuestions.regressions.status).toBe('not-verified')
    expect(parsed.findings.map((finding) => finding.findingClass)).toContain('preserved-area-changed')
    expect(parsed.findings.every((finding) => ['diff', 'dependency'].includes(finding.evidence.kind))).toBe(true)
  })

  it('writes the report to a file with --out', async () => {
    const result = await runCli(
      ['verify', '--contract', 'contract.yaml', '--before', 'base', '--after', 'HEAD', '--out', 'report.md'],
      repoDir,
    )

    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    const written = await readFile(join(repoDir, 'report.md'), 'utf8')
    expect(written).toContain('## Verdict: REJECT')
  })

  it('exits 2 with a readable error for unknown refs', async () => {
    const result = await runCli(
      ['verify', '--contract', 'contract.yaml', '--before', 'base', '--after', 'nope'],
      repoDir,
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('nope')
  })

  it('exits 2 for a missing contract file', async () => {
    const result = await runCli(
      ['verify', '--contract', 'missing.yaml', '--before', 'base', '--after', 'HEAD'],
      repoDir,
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Cannot read contract file')
  })

  it('exits 2 for a malformed contract', async () => {
    // Valid YAML, invalid schema — exercises zod validation errors.
    await writeFile(join(repoDir, 'bad.yaml'), 'id: []\ngoal: 5\npaths: nope\n', 'utf8')
    const result = await runCli(
      ['verify', '--contract', 'bad.yaml', '--before', 'base', '--after', 'HEAD'],
      repoDir,
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Invalid change contract')
  })

  it('scaffolds a contract with init and refuses to overwrite without --force', async () => {
    const first = await runCli(['init'], repoDir)
    expect(first.code).toBe(0)
    const scaffold = await readFile(join(repoDir, 'regression-guard.contract.yaml'), 'utf8')
    expect(scaffold).toContain('mustChange')

    const second = await runCli(['init'], repoDir)
    expect(second.code).toBe(2)
    expect(second.stderr).toContain('already exists')

    const forced = await runCli(['init', '--force'], repoDir)
    expect(forced.code).toBe(0)
  })
})

describe('regression-guard CLI (M2: baseline + working-tree)', () => {
  let repoDir: string

  const FAKE_VITEST_FILES: Record<string, string> = {
    'package.json': JSON.stringify(
      { name: 'fake-vitest-app', version: '1.0.0', type: 'module', scripts: { test: 'vitest run' } },
      null,
      2,
    ),
    'tests/spec.json': JSON.stringify(
      {
        tests: [
          { fullName: 'tasks > adds a task', title: 'adds a task', status: 'passed' },
          { fullName: 'tasks > rejects blank', title: 'rejects blank', status: 'passed' },
        ],
      },
      null,
      2,
    ),
    'tools/fake-vitest.mjs': `import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
let outputFile = null
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--outputFile' && argv[i + 1] !== undefined) {
    outputFile = argv[++i]
  } else if (arg.startsWith('--outputFile=')) {
    outputFile = arg.slice('--outputFile='.length)
  }
}
const spec = JSON.parse(await readFile(join(base, '..', 'tests', 'spec.json'), 'utf8'))
const tests = spec.tests ?? []
const failed = tests.filter((test) => test.status === 'failed')
const report = {
  numTotalTests: tests.length,
  numPassedTests: tests.length - failed.length,
  numFailedTests: failed.length,
  success: failed.length === 0,
  testResults: [
    {
      name: join(base, '..', 'tests', 'spec.vtest.js'),
      status: failed.length === 0 ? 'passed' : 'failed',
      message: '',
      assertionResults: tests.map((test) => ({
        ancestorTitles: [],
        fullName: test.fullName,
        title: test.title,
        status: test.status,
        failureMessages: test.failureMessage ? [test.failureMessage] : [],
      })),
    },
  ],
}
if (outputFile) {
  await writeFile(outputFile, JSON.stringify(report, null, 2))
}
process.exit(failed.length === 0 ? 0 : 1)
`,
    'node_modules/.bin/vitest': `#!/usr/bin/env node
import '../../tools/fake-vitest.mjs'
`,
    'node_modules/.bin/vitest.cmd': `@node "%~dp0/../../tools/fake-vitest.mjs" %*
`,
  }

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'rg-cli-m2-'))
    for (const [file, content] of Object.entries(FAKE_VITEST_FILES)) {
      const target = join(repoDir, file)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    await writeFile(
      join(repoDir, 'contract.yaml'),
      'version: 1\nid: spec-update\ngoal: update spec\npaths:\n  mustChange: ["tests/spec.json"]\n',
      'utf8',
    )
    await git(repoDir, 'init', '-q')
    await git(repoDir, 'add', '-A')
    await git(repoDir, 'commit', '-qm', 'base')
    await git(repoDir, 'branch', 'base')
    await git(repoDir, 'update-index', '--chmod=+x', 'node_modules/.bin/vitest')
    await git(repoDir, 'commit', '-qm', 'chmod' )
    await git(repoDir, 'branch', '-f', 'base')
  })

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  it('verifies uncommitted changes with --working-tree without mutating the checkout', async () => {
    const headBefore = (await git(repoDir, 'rev-parse', 'HEAD')).trim()
    // Dirty change: flip one test to failing, uncommitted.
    await writeFile(
      join(repoDir, 'tests', 'spec.json'),
      JSON.stringify(
        {
          tests: [
            { fullName: 'tasks > adds a task', title: 'adds a task', status: 'passed' },
            { fullName: 'tasks > rejects blank', title: 'rejects blank', status: 'failed', failureMessage: 'dirty regression' },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const result = await runCli(
      ['verify', '--contract', 'contract.yaml', '--before', 'base', '--working-tree'],
      repoDir,
    )

    expect(result.code).toBe(1)
    expect(result.stdout).toContain('## Verdict: REJECT')
    expect(result.stdout).toContain('test-regression')
    expect(result.stdout).toContain('tasks > rejects blank')
    expect(result.stderr).toContain('regressions: fail (1)')

    // No commit happened; the checkout is still dirty; no worktrees leaked.
    const headAfter = (await git(repoDir, 'rev-parse', 'HEAD')).trim()
    expect(headAfter).toBe(headBefore)
    const status = await git(repoDir, 'status', '--porcelain')
    expect(status).toContain('tests/spec.json')
    const worktrees = (await git(repoDir, 'worktree', 'list', '--porcelain')).trim().split('\n\n')
    expect(worktrees).toHaveLength(1)
  })

  it('rejects --working-tree together with --after', async () => {
    const result = await runCli(
      ['verify', '--contract', 'contract.yaml', '--before', 'base', '--after', 'HEAD', '--working-tree'],
      repoDir,
    )
    expect(result.code).toBe(2)
  })

  it('requires --after unless --working-tree is given', async () => {
    const result = await runCli(['verify', '--contract', 'contract.yaml', '--before', 'base'], repoDir)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--after is required')
  })

  it('skips regression verification with --skip-tests', async () => {
    await git(repoDir, 'checkout', '-q', '-b', 'clean', 'base')
    await writeFile(join(repoDir, 'tests', 'spec.json'), JSON.stringify({ tests: [{ fullName: 'x', title: 'x', status: 'passed' }] }, null, 2), 'utf8')
    await git(repoDir, 'add', '-A')
    await git(repoDir, 'commit', '-qm', 'spec change')

    const result = await runCli(
      ['verify', '--contract', 'contract.yaml', '--before', 'base', '--after', 'HEAD', '--skip-tests', '--format', 'json'],
      repoDir,
    )
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout) as { threeQuestions: { regressions: { status: string } }; baseline?: unknown }
    expect(parsed.threeQuestions.regressions.status).toBe('not-verified')
    expect(parsed.baseline).toBeUndefined()
  })
})
