import { describe, expect, it } from 'vitest'
import { manifestDigest, parseServiceManifest } from './manifest'

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
