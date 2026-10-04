import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Creates disposable git repositories for integration tests. Every git call
 * pins identity and disables autocrlf so behavior is identical on Windows
 * and POSIX.
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
    await rm(this.dir, { recursive: true, force: true })
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
      dependencies: { vitest: '^5.0.0' },
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
  'src/tasks.js': `export function addTask(tasks, text) {
  return [...tasks, { text }]
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
}
