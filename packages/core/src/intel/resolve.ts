/**
 * Relative-specifier resolution for ESM-style imports, mapped onto the set of
 * paths git reports as tracked. TypeScript's `.js` specifier convention (an
 * import of `./foo.js` may refer to a physical `foo.ts`) is honored.
 */

const JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

export function normalizePath(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..'
}

/** Bare-specifier package name: `@scope/name` or `name`. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : (parts[0] ?? specifier)
}

export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  existingPaths: ReadonlySet<string>,
): string | null {
  const base = normalizePath(`${dirname(fromPath)}/${specifier}`)
  const candidates: string[] = [base]

  const dot = base.lastIndexOf('.')
  const hasExtension = dot > base.lastIndexOf('/')

  if (hasExtension) {
    // `./foo.js` may physically be `foo.ts` / `foo.tsx`.
    const stem = base.slice(0, dot)
    const extension = base.slice(dot)
    if (extension === '.js') {
      candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.jsx`)
    }
    if (extension === '.mjs' || extension === '.cjs') {
      candidates.push(`${stem}.js`, `${stem}.ts`)
    }
  } else {
    for (const extension of JS_EXTENSIONS) {
      candidates.push(`${base}${extension}`)
    }
    for (const extension of JS_EXTENSIONS) {
      candidates.push(`${base}/index${extension}`)
    }
  }

  for (const candidate of candidates) {
    if (existingPaths.has(candidate)) {
      return candidate
    }
  }
  return null
}
