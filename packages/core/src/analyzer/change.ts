import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ChangeSet,
  DependencyChange,
  EnrichedChangeSet,
  EnrichedRecord,
} from '../schema/changeset'
import type { SensitiveCategory } from '../schema/contract'
import type { GitAdapter } from '../vcs/git'
import { isTestPath } from '../intel/graph'

/**
 * The Change Analyzer enriches the raw ChangeSet with meaning: sensitive-file
 * categories, dependency additions/removals/updates, and test-file detection.
 */

const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
])

/** Path-pattern detection for the built-in sensitive categories. */
export function categorizePath(path: string): SensitiveCategory[] {
  const categories: SensitiveCategory[] = []
  const basename = path.slice(path.lastIndexOf('/') + 1)

  if (LOCKFILE_BASENAMES.has(basename) || path.endsWith('.lock')) {
    categories.push('lockfile')
  }
  if (/(^|\/)migrations?\//.test(path) || /\/prisma\/migrations\//.test(path)) {
    categories.push('schema-migration')
  }
  if (/(^|\/)(db|database)\/schema/.test(path) || /schema\.(prisma|sql)$/.test(path) || /(^|\/)db\/migrate\//.test(path)) {
    categories.push('database-schema')
  }
  if (/(^|\/)\.env/.test(basename) || /\.(pem|key)$/.test(path) || /(^|\/)secrets?\//i.test(path) || /credentials/i.test(basename)) {
    categories.push('env-secrets')
  }
  if (/^\.github\/workflows\//.test(path) || /^\.gitlab-ci/.test(path) || /(^|\/)Jenkinsfile$/.test(path) || /^\.circleci\//.test(path)) {
    categories.push('ci-config')
  }
  return categories
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

type PackageJsonLike = Record<string, Record<string, string> | undefined>

function dependencyMapOf(pkg: unknown): PackageJsonLike {
  if (typeof pkg !== 'object' || pkg === null) {
    return {}
  }
  return pkg as PackageJsonLike
}

export function diffDependencies(beforePkg: unknown, afterPkg: unknown): {
  added: DependencyChange[]
  removed: DependencyChange[]
  changed: DependencyChange[]
} {
  const before = dependencyMapOf(beforePkg)
  const after = dependencyMapOf(afterPkg)
  const added: DependencyChange[] = []
  const removed: DependencyChange[] = []
  const changed: DependencyChange[] = []

  for (const section of DEPENDENCY_SECTIONS) {
    const beforeDeps = before[section] ?? {}
    const afterDeps = after[section] ?? {}
    for (const [name, version] of Object.entries(afterDeps)) {
      if (!(name in beforeDeps)) {
        added.push({ name, section, version })
      } else if (beforeDeps[name] !== version) {
        changed.push({ name, section, from: beforeDeps[name], to: version })
      }
    }
    for (const [name, version] of Object.entries(beforeDeps)) {
      if (!(name in afterDeps)) {
        removed.push({ name, section, version })
      }
    }
  }

  return { added, removed, changed }
}

/** Enrich a ChangeSet with categories, test detection, and dependency changes. */
export async function enrichChangeSet(
  git: GitAdapter,
  changeSet: ChangeSet,
): Promise<EnrichedChangeSet> {
  const records: EnrichedRecord[] = changeSet.records.map((record) => ({
    ...record,
    categories: categorizePath(record.path),
    isTest: isTestPath(record.path) || (record.oldPath !== undefined && isTestPath(record.oldPath)),
  }))

  const [beforePkgRaw, afterPkgRaw] = await Promise.all([
    git.readFileAt(changeSet.before, 'package.json'),
    // 'working-tree' is a display label, not a git ref: reading it via
    // `git show` fails and parses as an EMPTY manifest, falsely reporting
    // every declared dependency as removed. The after package.json in
    // working-tree mode is the materialized file on disk — the exact state
    // the fingerprint identifies.
    changeSet.after === 'working-tree'
      ? readFile(join(git.repoRoot, 'package.json'), 'utf8').catch(() => null)
      : git.readFileAt(changeSet.after, 'package.json'),
  ])

  const parseJson = (raw: string | null): unknown => {
    if (raw === null) {
      return {}
    }
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }

  return {
    changeSet,
    records,
    dependencies: diffDependencies(parseJson(beforePkgRaw), parseJson(afterPkgRaw)),
  }
}
