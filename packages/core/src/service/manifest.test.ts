import { describe, expect, it } from 'vitest'
import { loadServiceManifest, manifestDigest, parseServiceManifest } from './manifest'

const VALID_MINIMAL = `
services:
  - name: api
    command: node server.mjs
    readiness:
      port: 8080
      timeoutMs: 5000
probes:
  - id: health
    service: api
    request:
      path: /
    expect:
      status: 200
`

/** Same semantics as VALID_MINIMAL: keys reordered, formatting changed, defaults spelled out. */
const VALID_REORDERED_EXPLICIT = `
probes:
  - timeoutMs: 10000
    expect:
      status: 200
    service: api
    id: health
    request:
      path: /
      method: GET
services:
  - readiness:
      timeoutMs: 5000
      path: /
      port: 8080
    command: node server.mjs
    name: api
version: 1
`

describe('parseServiceManifest', () => {
  it('parses a valid manifest and applies schema defaults', () => {
    const manifest = parseServiceManifest(VALID_MINIMAL)
    expect(manifest).not.toBeNull()
    expect(manifest?.version).toBe(1)
    expect(manifest?.services[0]?.readiness.path).toBe('/')
    expect(manifest?.probes[0]?.request.method).toBe('GET')
    expect(manifest?.probes[0]?.timeoutMs).toBe(10_000)
    expect(manifest?.probes[0]?.expect.status).toBe(200)
  })

  it('returns null for absent text', () => {
    expect(parseServiceManifest(null)).toBeNull()
  })

  it.each([
    { name: 'empty document', text: '' },
    { name: 'whitespace document', text: '   \n  \n' },
    { name: 'unparseable YAML', text: 'services:\n  - [unclosed\n' },
    { name: 'scalar document', text: 'just a string' },
    { name: 'wrong version literal', text: 'version: 2\nservices:\n  - name: a\n    command: x\n    readiness: { port: 1 }\nprobes: []' },
    { name: 'empty services array', text: 'services: []\nprobes: []' },
    { name: 'service missing readiness', text: 'services:\n  - name: a\n    command: x\nprobes: []' },
    { name: 'readiness port out of range', text: 'services:\n  - name: a\n    command: x\n    readiness: { port: 99999 }\nprobes: []' },
    { name: 'probe with empty id', text: 'services:\n  - name: a\n    command: x\n    readiness: { port: 80 }\nprobes:\n  - id: ""\n    service: a\n    request: {}\n' },
  ])('returns null for invalid input: $name', ({ text }) => {
    expect(parseServiceManifest(text)).toBeNull()
  })
})

describe('loadServiceManifest', () => {
  it('classifies null text as absent', () => {
    expect(loadServiceManifest(null)).toEqual({ status: 'absent' })
  })

  it('classifies empty and whitespace-only text as absent', () => {
    expect(loadServiceManifest('')).toEqual({ status: 'absent' })
    expect(loadServiceManifest('   \n  \n')).toEqual({ status: 'absent' })
  })

  it('classifies unparseable YAML as invalid with the parser message', () => {
    const result = loadServiceManifest('services:\n  - [unclosed\n')
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.errors).toHaveLength(1)
    expect(typeof result.errors[0]).toBe('string')
    expect(result.errors[0]?.length ?? 0).toBeGreaterThan(0)
  })

  it('classifies a non-object document as invalid without a path prefix', () => {
    const result = loadServiceManifest('just a string')
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.errors).toHaveLength(1)
    // Root-level issue: no `<dotted.path>: ` prefix, just the bare message.
    expect(result.errors[0]).not.toMatch(/^\w+(\.\w+)*: /)
  })

  it('classifies a missing services list as invalid with the services path', () => {
    const result = loadServiceManifest('version: 1\nprobes: []\n')
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some((e) => e.startsWith('services'))).toBe(true)
  })

  it('classifies an out-of-range readiness port as invalid with the full path', () => {
    const result = loadServiceManifest(
      'services:\n  - name: a\n    command: x\n    readiness: { port: 99999 }\nprobes: []\n',
    )
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some((e) => e.startsWith('services.0.readiness.port'))).toBe(true)
  })

  it('sorts schema issues lexicographically regardless of schema key order', () => {
    // Zod walks shape keys (services before probes); sorted output must
    // reorder the probes issue first. Exercises the ordering guarantee.
    const text = [
      'services:',
      '  - name: a',
      '    command: x',
      '    readiness: { port: 99999 }',
      'probes:',
      '  - id: ""',
      '    service: a',
      '    request: {}',
    ].join('\n')
    const result = loadServiceManifest(text)
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') return
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
    expect(result.errors[0]).toMatch(/^probes\.0\.id\b/)
    expect(result.errors.some((e) => e.startsWith('services.0.readiness.port'))).toBe(true)
    expect([...result.errors]).toEqual([...result.errors].sort())
  })

  it('produces identical errors on repeated loads (deterministic)', () => {
    const text = 'services:\n  - name: a\n    command: x\n    readiness: { port: 0 }\nprobes: []\n'
    const first = loadServiceManifest(text)
    const second = loadServiceManifest(text)
    expect(second).toEqual(first)
  })

  it('classifies a valid manifest as valid with manifest and digest', () => {
    const result = loadServiceManifest(VALID_MINIMAL)
    expect(result.status).toBe('valid')
    if (result.status !== 'valid') return
    expect(result.manifest).toEqual(parseServiceManifest(VALID_MINIMAL))
    expect(result.digest).toBe(manifestDigest(result.manifest))
    expect(result.digest).toMatch(/^svc_[0-9a-f]{64}$/)
  })

  it('gives equivalent reordered manifests the same digest', () => {
    const a = loadServiceManifest(VALID_MINIMAL)
    const b = loadServiceManifest(VALID_REORDERED_EXPLICIT)
    expect(a.status).toBe('valid')
    expect(b.status).toBe('valid')
    if (a.status !== 'valid' || b.status !== 'valid') return
    expect(b.digest).toBe(a.digest)
  })

  it('keeps parseServiceManifest behavior unchanged (collapses to null)', () => {
    expect(parseServiceManifest(null)).toBeNull()
    expect(parseServiceManifest('')).toBeNull()
    expect(parseServiceManifest('services:\n  - [unclosed\n')).toBeNull()
    expect(
      parseServiceManifest('services:\n  - name: a\n    command: x\n    readiness: { port: 99999 }\nprobes: []\n'),
    ).toBeNull()
    expect(parseServiceManifest(VALID_MINIMAL)).toEqual(
      (loadServiceManifest(VALID_MINIMAL) as { manifest: unknown }).manifest,
    )
  })
})

describe('manifestDigest', () => {
  it('is svc_ + full sha256 hex', () => {
    expect(manifestDigest(parseServiceManifest(VALID_MINIMAL)!)).toMatch(/^svc_[0-9a-f]{64}$/)
  })

  it('is stable across formatting and key-order differences (same parsed content)', () => {
    const a = parseServiceManifest(VALID_MINIMAL)!
    const b = parseServiceManifest(VALID_REORDERED_EXPLICIT)!
    expect(b).not.toBeNull()
    expect(manifestDigest(a)).toBe(manifestDigest(b))
  })

  it('is deterministic for repeated calls', () => {
    const manifest = parseServiceManifest(VALID_MINIMAL)!
    expect(manifestDigest(manifest)).toBe(manifestDigest(manifest))
  })

  it.each([
    {
      name: 'probe expectation rule changed',
      other: VALID_MINIMAL.replace('status: 200', 'status: 201'),
    },
    {
      name: 'service port changed',
      other: VALID_MINIMAL.replace('port: 8080', 'port: 9090'),
    },
    {
      name: 'readiness timeout changed',
      other: VALID_MINIMAL.replace('timeoutMs: 5000', 'timeoutMs: 6000'),
    },
    {
      name: 'probe path changed',
      other: VALID_MINIMAL.replace('path: /', 'path: /health'),
    },
  ])('diverges when a declared rule changes: $name', ({ other }) => {
    const base = manifestDigest(parseServiceManifest(VALID_MINIMAL)!)
    const changed = parseServiceManifest(other)
    expect(changed).not.toBeNull()
    expect(manifestDigest(changed!)).not.toBe(base)
  })
})
