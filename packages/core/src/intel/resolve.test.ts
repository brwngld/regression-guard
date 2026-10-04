import { describe, expect, it } from 'vitest'
import {
  isRelativeSpecifier,
  normalizePath,
  packageNameOf,
  resolveSpecifier,
} from './resolve'

const FILES = new Set([
  'index.html',
  'package.json',
  'src/main.js',
  'src/tasks.js',
  'src/tasks.test.js',
  'src/ui/render.ts',
  'src/ui/index.ts',
  'src/style.css',
])

describe('resolveSpecifier', () => {
  it('resolves exact relative paths', () => {
    expect(resolveSpecifier('src/main.js', './tasks.js', FILES)).toBe('src/tasks.js')
  })

  it('resolves extensionless specifiers', () => {
    expect(resolveSpecifier('src/main.js', './tasks', FILES)).toBe('src/tasks.js')
  })

  it('resolves directory index files', () => {
    expect(resolveSpecifier('src/main.js', './ui', FILES)).toBe('src/ui/index.ts')
  })

  it('maps .js specifiers onto .ts sources (TS convention)', () => {
    expect(resolveSpecifier('src/main.js', './ui/render.js', FILES)).toBe('src/ui/render.ts')
  })

  it('resolves parent-relative specifiers', () => {
    expect(resolveSpecifier('src/ui/render.ts', '../style.css', FILES)).toBe('src/style.css')
  })

  it('resolves css imports for styling-aware adjacency', () => {
    expect(resolveSpecifier('src/main.js', './style.css', FILES)).toBe('src/style.css')
  })

  it('returns null for unresolvable specifiers', () => {
    expect(resolveSpecifier('src/main.js', './missing.js', FILES)).toBeNull()
  })
})

describe('helpers', () => {
  it('normalizes ../ and ./ segments', () => {
    expect(normalizePath('src/ui/../tasks.js')).toBe('src/tasks.js')
    expect(normalizePath('./src/./main.js')).toBe('src/main.js')
  })

  it('detects relative vs bare specifiers', () => {
    expect(isRelativeSpecifier('./x')).toBe(true)
    expect(isRelativeSpecifier('../x')).toBe(true)
    expect(isRelativeSpecifier('vitest')).toBe(false)
  })

  it('extracts scoped and plain package names', () => {
    expect(packageNameOf('@scope/pkg/sub')).toBe('@scope/pkg')
    expect(packageNameOf('vitest')).toBe('vitest')
  })
})
