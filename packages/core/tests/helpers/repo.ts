import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Creates disposable git repositories for integration tests. Every git call
 * pins identity and disables autocrlf so behavior is identical on Windows
 * and POSIX. Fixtures are deliberately dependency-free so test execution is
 * offline and fast.
 */
export class TempRepo {
  private constructor(readonly dir: string) {}

  static async create(files: Record<string, string>): Promise<TempRepo> {
    const dir = await mkdtemp(join(tmpdir(), 'regression-guard-'))
    const repo = new TempRepo(dir)
    await repo.write(files)
    await repo.git('init', '-q')
    await repo.git('add', '-A')
    await repo.commit('base')
    return repo
  }

  async write(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      const target = join(this.dir, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
  }

  async remove(paths: string[]): Promise<void> {
    for (const path of paths) {
      await rm(join(this.dir, path), { force: true })
    }
  }

  async renamePath(from: string, to: string): Promise<void> {
    await mkdir(dirname(join(this.dir, to)), { recursive: true })
    await rename(join(this.dir, from), join(this.dir, to))
  }

  /** Mark a tracked path executable so POSIX worktrees honor the bit. */
  async markExecutable(path: string): Promise<void> {
    await chmod(join(this.dir, path), 0o755)
    await this.git('add', path)
    await this.git('update-index', '--chmod=+x', path)
    await this.commit(`chmod +x ${path}`)
  }

  async git(...args: string[]): Promise<string> {
    const { stdout } = await exec(
      'git',
      ['-c', 'user.name=Regression Guard', '-c', 'user.email=rg@example.com', '-c', 'core.autocrlf=false', ...args],
      { cwd: this.dir, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
    )
    return stdout.replace(/\r\n/g, '\n')
  }

  async commit(message: string): Promise<void> {
    await this.git('add', '-A')
    await this.git('commit', '-qm', message)
  }

  async destroy(): Promise<void> {
    // Windows can briefly lock .git objects after concurrent git activity.
    await rm(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

/** A small multi-file app that exercises imports, tests, styles, and html. */
export const SAMPLE_APP: Record<string, string> = {
  'index.html': `<!doctype html>
<html>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
  'package.json': JSON.stringify(
    {
      name: 'sample-app',
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'node tests/run.js' },
    },
    null,
    2,
  ),
  'README.md': '# Sample app\n',
  'src/main.js': `import { addTask } from './tasks.js'
import { render } from './ui/render.js'
import './style.css'

render(addTask([], 'hello'))
`,
  'src/tasks.js': `export const STORAGE_KEY = 'sample.tasks'

export function addTask(tasks, text) {
  const normalized = String(text ?? '').trim()
  if (!normalized) {
    throw new Error('Task cannot be blank.')
  }
  return [...tasks, { id: 'fixed-id', text: normalized, completed: false }]
}
`,
  'src/tasks.test.js': `import { addTask } from './tasks.js'

it('adds', () => {})
`,
  'src/ui/render.js': `export function render(tasks) {
  return tasks.length
}
`,
  'src/style.css': 'body { margin: 0; }\n',
  'tests/run.js': `import { addTask } from '../src/tasks.js'

let failed = 0

const trimmed = addTask([], '  x  ')[0]
if (trimmed.text !== 'x' || trimmed.completed !== false) {
  console.error('FAIL addTask normalizes task text')
  failed += 1
}
if (Object.keys(trimmed).sort().join(',') !== 'completed,id,text') {
  console.error('FAIL addTask task shape changed:', Object.keys(trimmed).sort().join(','))
  failed += 1
}

try {
  addTask([], '   ')
  console.error('FAIL addTask rejects blank input')
  failed += 1
} catch {
  // expected
}

console.log(failed === 0 ? 'suite ok' : 'suite failing')
process.exit(failed === 0 ? 0 : 1)
`,
}

const FAKE_VITEST_RUNNER = `import { readFile, writeFile } from 'node:fs/promises'
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
  numPendingTests: 0,
  numTodoTests: 0,
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
console.log(\`fake-vitest: \${tests.length - failed.length}/\${tests.length} passing\`)
process.exit(failed.length === 0 ? 0 : 1)
`

export interface FakeTestSpec {
  fullName: string
  title: string
  status: 'passed' | 'failed'
  failureMessage?: string
}

/**
 * A dependency-free app whose `test` script is `vitest run`. A local
 * node_modules/.bin/vitest shim emits jest/vitest-shaped JSON, so the engine's
 * direct-runner path (command construction + JSON parsing + per-test
 * classification) is exercised end-to-end, offline.
 */
export function fakeVitestApp(specs: FakeTestSpec[]): Record<string, string> {
  return {
    'package.json': JSON.stringify(
      {
        name: 'fake-vitest-app',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'vitest run' },
      },
      null,
      2,
    ),
    'src/index.js': `export function addTask() {
  return []
}
`,
    'tests/spec.json': JSON.stringify({ tests: specs }, null, 2),
    'tools/fake-vitest.mjs': FAKE_VITEST_RUNNER,
    'node_modules/.bin/vitest': `#!/usr/bin/env node
import '../../tools/fake-vitest.mjs'
`,
    // Forward slashes on purpose: node accepts them on Windows, and this
    // avoids any backslash-escape mangling when the fixture is written.
    'node_modules/.bin/vitest.cmd': `@node "%~dp0/../../tools/fake-vitest.mjs" %*
`,
  }
}

export const PASSING_SPECS: FakeTestSpec[] = [
  { fullName: 'tasks > adds a task', title: 'adds a task', status: 'passed' },
  { fullName: 'tasks > rejects blank', title: 'rejects blank', status: 'passed' },
]
