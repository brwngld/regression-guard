import { Project, SyntaxKind, type StringLiteral } from 'ts-morph'
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

/** Parse imports out of one JS/TS file's content using ts-morph (in-memory). */
export function collectJsImports(content: string): { relative: string[]; external: string[] } {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sourceFile = project.createSourceFile('/virtual.js', content, { overwrite: true })

  const relative: string[] = []
  const external: string[] = []

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
    if (argument && argument.getKind() === SyntaxKind.StringLiteral) {
      const specifier = (argument as StringLiteral).getLiteralText()
      if (isRelativeSpecifier(specifier)) {
        relative.push(specifier)
      } else {
        external.push(packageNameOf(specifier))
      }
    }
  }

  return {
    relative: [...new Set(relative)],
    external: [...new Set(external)],
  }
}

/**
 * Build the repository intelligence graph at a ref: file nodes, import edges,
 * and reverse (importedBy) edges. Only tracked files are considered, so
 * node_modules and build output are invisible by construction.
 */
export async function buildGraph(git: GitAdapter, ref: string): Promise<DependencyGraph> {
  const paths = await git.listFiles(ref)
  const existing = new Set(paths)
  const files: Record<string, FileNode> = {}

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
      const content = await git.readFileAt(ref, path)
      if (content !== null) {
        const { relative, external } = collectJsImports(content)
        node.imports = relative
          .map((specifier) => resolveSpecifier(path, specifier, existing))
          .filter((resolved): resolved is string => resolved !== null)
        node.externalImports = external
      }
      continue
    }

    if (node.kind === 'entry-html') {
      const content = await git.readFileAt(ref, path)
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
      const content = await git.readFileAt(ref, path)
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

  return { files, importedBy }
}
