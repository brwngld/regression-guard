import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Project, SyntaxKind, type StringLiteral } from 'ts-morph'
import type { UnresolvedEdge } from '../schema/impact'
import type { GitAdapter } from '../vcs/git'
import { isRelativeSpecifier, packageNameOf, resolveSpecifier } from './resolve'

export type FileKind = 'source' | 'test' | 'entry-html' | 'entry-package' | 'style' | 'config' | 'other'

export interface FileNode {
  path: string
  kind: FileKind
  /** Resolved repo-relative paths this file imports. */
  imports: string[]
  /** Bare package specifiers (external dependencies). */
  externalImports: string[]
}

export interface DependencyGraph {
  files: Record<string, FileNode>
  /** Reverse edges: path -> paths that import it. */
  importedBy: Record<string, string[]>
  /**
   * Relationships the graph cannot resolve statically: relative specifiers
   * with no target among the listed paths, and computed dynamic import()
   * calls. These are boundaries, not guesses — no nodes are fabricated for
   * them. buildGraph always populates this list, deterministically sorted by
   * (from, specifier, kind); the field is optional only so hand-assembled
   * graphs (e.g. in tests) remain valid literals.
   */
  unresolvedEdges?: UnresolvedEdge[]
}

const PARSE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'])

export function isTestPath(path: string): boolean {
  return /(\.|\/)(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)(__tests__|tests?|e2e)\//.test(path)
}

function kindForPath(path: string): FileKind {
  if (isTestPath(path)) {
    return 'test'
  }
  if (path.endsWith('.html') || path.endsWith('.htm')) {
    return 'entry-html'
  }
  if (path === 'package.json') {
    return 'config'
  }
  if (path.endsWith('.css') || path.endsWith('.scss') || path.endsWith('.sass') || path.endsWith('.less')) {
    return 'style'
  }
  if (PARSE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) {
    return 'source'
  }
  return 'other'
}

function htmlScriptSources(content: string): string[] {
  const sources: string[] = []
  const pattern = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    sources.push(match[1] ?? '')
  }
  return sources.filter(Boolean)
}

function packageEntryPaths(content: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return []
  }
  const pkg = parsed as Record<string, unknown>
  const entries: string[] = []
  for (const field of ['main', 'module']) {
    if (typeof pkg[field] === 'string') {
      entries.push(pkg[field] as string)
    }
  }
  if (typeof pkg.bin === 'string') {
    entries.push(pkg.bin)
  } else if (typeof pkg.bin === 'object' && pkg.bin !== null) {
    for (const value of Object.values(pkg.bin as Record<string, unknown>)) {
      if (typeof value === 'string') {
        entries.push(value)
      }
    }
  }
  return entries
}

/**
 * Parse imports out of one JS/TS file's content using ts-morph (in-memory).
 * `relative`/`external` hold statically classifiable specifiers (deduplicated);
 * `computedDynamicImports` counts dynamic import() calls whose first argument
 * is not a string literal (e.g. `await import(moduleName)`) — their targets
 * are decided at runtime and cannot be resolved statically.
 */
export function collectJsImports(content: string): {
  relative: string[]
  external: string[]
  computedDynamicImports: number
} {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sourceFile = project.createSourceFile('/virtual.js', content, { overwrite: true })

  const relative: string[] = []
  const external: string[] = []
  let computedDynamicImports = 0

  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue()
    if (!specifier) {
      continue
    }
    if (isRelativeSpecifier(specifier)) {
      relative.push(specifier)
    } else {
      external.push(packageNameOf(specifier))
    }
  }

  for (const declaration of sourceFile.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifier()?.getLiteralValue()
    if (!specifier) {
      continue
    }
    if (isRelativeSpecifier(specifier)) {
      relative.push(specifier)
    } else {
      external.push(packageNameOf(specifier))
    }
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'import') {
      continue
    }
    const argument = call.getArguments()[0]
    if (!argument) {
      continue
    }
    if (argument.getKind() === SyntaxKind.StringLiteral) {
      const specifier = (argument as StringLiteral).getLiteralText()
      if (isRelativeSpecifier(specifier)) {
        relative.push(specifier)
      } else {
        external.push(packageNameOf(specifier))
      }
    } else {
      // import(<non-string>) — computed at runtime, not statically resolvable.
      computedDynamicImports += 1
    }
  }

  return {
    relative: [...new Set(relative)],
    external: [...new Set(external)],
    computedDynamicImports,
  }
}

/** Abstract read access to a repository snapshot (a ref or the working tree). */
export interface RepoReader {
  listFiles(): Promise<string[]>
  readFile(path: string): Promise<string | null>
}

export function refReader(git: GitAdapter, ref: string): RepoReader {
  return {
    listFiles: () => git.listFiles(ref),
    readFile: (path) => git.readFileAt(ref, path),
  }
}

/** Tracked + untracked (non-ignored) files, read from disk. */
export function workingTreeReader(git: GitAdapter): RepoReader {
  const listOnce = async (): Promise<string[]> => {
    const tracked = await git.listFiles('HEAD')
    const untracked = await git.listUntracked()
    return [...new Set([...tracked, ...untracked])]
  }
  let cached: Promise<string[]> | null = null
  return {
    listFiles: () => (cached ??= listOnce()),
    readFile: async (path) => {
      try {
        return await readFile(join(git.repoRoot, path), 'utf8')
      } catch {
        return null
      }
    },
  }
}

function compareUnresolvedEdges(a: UnresolvedEdge, b: UnresolvedEdge): number {
  if (a.from !== b.from) {
    return a.from < b.from ? -1 : 1
  }
  if (a.specifier !== b.specifier) {
    return a.specifier < b.specifier ? -1 : 1
  }
  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1
  }
  return 0
}

/**
 * Build the repository intelligence graph over a snapshot: file nodes, import
 * edges, and reverse (importedBy) edges. node_modules and build output are
 * invisible by construction (git-tracked or gitignored files only).
 * Relationships that cannot be resolved statically — unresolvable relative
 * imports and computed dynamic import() calls — are surfaced as
 * `unresolvedEdges` (deterministically ordered by from, specifier, kind)
 * rather than silently dropped. No nodes or guessed targets are created for
 * them: they are boundaries of what the graph honestly knows.
 */
export async function buildGraph(reader: RepoReader): Promise<DependencyGraph> {
  const paths = await reader.listFiles()
  const existing = new Set(paths)
  const files: Record<string, FileNode> = {}
  const unresolvedEdges: UnresolvedEdge[] = []

  const ensureNode = (path: string): FileNode => {
    let node = files[path]
    if (!node) {
      node = { path, kind: kindForPath(path), imports: [], externalImports: [] }
      files[path] = node
    }
    return node
  }

  for (const path of paths) {
    const node = ensureNode(path)

    if (PARSE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) {
      const content = await reader.readFile(path)
      if (content !== null) {
        const { relative, external, computedDynamicImports } = collectJsImports(content)
        const imports: string[] = []
        for (const specifier of relative) {
          const resolved = resolveSpecifier(path, specifier, existing)
          if (resolved === null) {
            unresolvedEdges.push({ from: path, specifier, kind: 'unresolved-import' })
          } else {
            imports.push(resolved)
          }
        }
        node.imports = imports
        node.externalImports = external
        if (computedDynamicImports > 0) {
          unresolvedEdges.push({ from: path, specifier: '(computed)', kind: 'dynamic-import' })
        }
      }
      continue
    }

    if (node.kind === 'entry-html') {
      const content = await reader.readFile(path)
      if (content === null) {
        continue
      }
      const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      node.imports = htmlScriptSources(content)
        .filter((source) => !/^https?:\/\//i.test(source))
        .map((source) => {
          const candidate = source.startsWith('/') ? source.slice(1) : `${base ? `${base}/` : ''}${source}`
          return resolveSpecifier(path, `./${candidate.startsWith('/') ? candidate.slice(1) : candidate}`, existing)
        })
        .filter((resolved): resolved is string => resolved !== null)
      continue
    }

    if (path === 'package.json') {
      const content = await reader.readFile(path)
      if (content === null) {
        continue
      }
      node.imports = packageEntryPaths(content)
        .map((entry) => resolveSpecifier(path, entry.startsWith('./') ? entry : `./${entry}`, existing))
        .filter((resolved): resolved is string => resolved !== null)
    }
  }

  const importedBy: Record<string, string[]> = {}
  for (const node of Object.values(files)) {
    for (const target of node.imports) {
      ensureNode(target)
      ;(importedBy[target] ??= []).push(node.path)
    }
  }

  return { files, importedBy, unresolvedEdges: unresolvedEdges.sort(compareUnresolvedEdges) }
}
