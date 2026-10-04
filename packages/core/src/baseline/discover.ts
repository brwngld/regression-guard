/**
 * Deterministic test-command discovery. No LLM: the repository's declared
 * `scripts.test` is the source of truth.
 *
 * - `vitest`/`jest` scripts are re-invoked directly with machine-readable
 *   output so individual test outcomes can be modeled.
 * - Any other script runs verbatim through the shell with an honest
 *   suite-level fallback (exit status only).
 */

export type TestCommandPlan = {
  runner: 'vitest' | 'jest' | 'generic'
  /** What a human would run. */
  userCommand: string
  /**
   * Exact command the engine executes with cwd set to the worktree. Direct
   * runners write results to a fixed RELATIVE filename — quoting through the
   * Windows shell is avoided by construction.
   */
  buildExecutedCommand: () => string
} | null

/** Result file (relative to the worktree) for direct-runner modes. */
export const TEST_RESULT_FILE = '.regression-guard-tests.json'

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

export function packageJsonHasDependencies(pkgText: string | null): boolean {
  if (pkgText === null) {
    return false
  }
  try {
    const pkg = JSON.parse(pkgText) as Record<string, unknown>
    return DEPENDENCY_SECTIONS.some((section) => {
      const value = pkg[section]
      return typeof value === 'object' && value !== null && Object.keys(value).length > 0
    })
  } catch {
    return false
  }
}

export interface DependencyInstallPlan {
  strategy: 'npm-ci' | 'npm-install' | 'none'
  command: string | null
}

/**
 * Deterministic dependency-restoration strategy. `npm ci` (lockfile-exact, no
 * mutation) is preferred whenever a lockfile exists; `npm install` is the
 * fallback for lockfile-less repositories; nothing runs when there are no
 * declared dependencies to restore.
 */
export function selectDependencyInstall(
  pkgText: string | null,
  lockfileExists: boolean,
): DependencyInstallPlan {
  if (!packageJsonHasDependencies(pkgText)) {
    return { strategy: 'none', command: null }
  }
  return lockfileExists
    ? { strategy: 'npm-ci', command: 'npm ci --no-audit --no-fund --loglevel=error' }
    : { strategy: 'npm-install', command: 'npm install --no-audit --no-fund --loglevel=error' }
}

export function discoverTestCommand(pkgText: string | null): TestCommandPlan {
  if (pkgText === null) {
    return null
  }

  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(pkgText) as Record<string, unknown>
  } catch {
    return null
  }

  const scripts = pkg.scripts
  if (typeof scripts !== 'object' || scripts === null) {
    return null
  }
  const test = (scripts as Record<string, unknown>).test
  if (typeof test !== 'string' || test.trim().length === 0) {
    return null
  }

  const script = test.trim()

  if (/^vitest(\s|$)/.test(script)) {
    const remainder = script
      .replace(/^vitest\s*/, '')
      .replace(/^(--run|run)(\s+|$)/, '')
      .trim()
    return {
      runner: 'vitest',
      userCommand: 'npm test',
      buildExecutedCommand: () =>
        `npx vitest run --reporter=json --outputFile=${TEST_RESULT_FILE}${remainder ? ` ${remainder}` : ''}`,
    }
  }

  if (/^jest(\s|$)/.test(script)) {
    const remainder = script.replace(/^jest\s*/, '').trim()
    return {
      runner: 'jest',
      userCommand: 'npm test',
      buildExecutedCommand: () =>
        `npx jest --json --outputFile=${TEST_RESULT_FILE}${remainder ? ` ${remainder}` : ''}`,
    }
  }

  return {
    runner: 'generic',
    userCommand: 'npm test',
    buildExecutedCommand: () => script,
  }
}
