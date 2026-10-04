/**
 * End-to-end demo: copy the example app into a temp repo, commit a plausible
 * "UI polish" change that quietly rewrites the storage key and adds a
 * dependency, then verify it against the app's change contract.
 *
 * The demo always ends REJECT — that is the point: the change looks like
 * styling work but violates the contract in two independent ways.
 */
import { execFile as execFileCb } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFileCb)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(root, 'packages', 'cli', 'dist', 'cli.js')
const contract = path.join(root, 'examples', 'todo-app', 'contracts', 'ui-polish.yaml')

const dir = await mkdtemp(path.join(tmpdir(), 'rg-demo-'))

const git = (...args) =>
  exec(
    'git',
    ['-c', 'user.name=Regression Guard', '-c', 'user.email=rg@example.com', '-c', 'core.autocrlf=false', ...args],
    { cwd: dir, windowsHide: true },
  )

try {
  await cp(path.join(root, 'examples', 'todo-app'), dir, {
    recursive: true,
    filter: (source) => !source.includes('node_modules'),
  })
  await git('init', '-q')
  await git('add', '-A')
  await git('commit', '-qm', 'base: todo app')
  await git('branch', 'base')

  // The change producer (human, AI agent, or bot — the engine cannot tell,
  // by design) makes its change: real styling work, plus two quiet edits.
  const css = await readFile(path.join(dir, 'src', 'style.css'), 'utf8')
  await writeFile(path.join(dir, 'src', 'style.css'), `${css}\n.todo-app { max-width: 34rem; margin-inline: auto; }\n`)

  const tasks = await readFile(path.join(dir, 'src', 'tasks.js'), 'utf8')
  await writeFile(path.join(dir, 'src', 'tasks.js'), tasks.replace("'todo-list.tasks'", "'todo.tasks.v2'"))

  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
  pkg.dependencies = { ...(pkg.dependencies ?? {}), lodash: '^4.17.21' }
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

  await git('add', '-A')
  await git('commit', '-qm', 'polish UI (and friends)')

  let stdout = ''
  let stderr = ''
  let code = 0
  try {
    const result = await exec(
      process.execPath,
      [cliEntry, 'verify', '--contract', contract, '--before', 'base', '--after', 'HEAD'],
      { cwd: dir, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    )
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    stdout = error.stdout ?? ''
    stderr = error.stderr ?? ''
    code = error.code ?? 1
  }

  process.stdout.write(stdout.replace(/\r\n/g, '\n'))
  process.stderr.write(stderr.replace(/\r\n/g, '\n'))
  process.exitCode = code === 0 ? 1 : code
} finally {
  await rm(dir, { recursive: true, force: true })
}
