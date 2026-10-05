import { describe, expect, it } from 'vitest'
import { canonicalJson, verificationContextId, verificationRunId, type LineageInput } from './identity'

const BEFORE = { label: 'main', kind: 'ref' as const, sha: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1' }
const AFTER = { label: 'feature', kind: 'ref' as const, sha: 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2' }

function input(overrides: Partial<LineageInput> = {}): LineageInput {
  return {
    contractId: 'spec-update',
    contractVersion: 1,
    before: BEFORE,
    after: AFTER,
    findingIds: ['SCOPE-001', 'TEST-001'],
    ...overrides,
  }
}

describe('verificationContextId', () => {
  it('is a full sha256 hex digest prefixed ctx_', () => {
    expect(verificationContextId(input())).toMatch(/^ctx_[0-9a-f]{64}$/)
  })

  it('is deterministic for the same input', () => {
    expect(verificationContextId(input())).toBe(verificationContextId(input()))
  })

  it.each([
    { component: 'contractId', change: { contractId: 'other-contract' } },
    { component: 'contractVersion', change: { contractVersion: 2 } },
    { component: 'before.label', change: { before: { ...BEFORE, label: 'trunk' } } },
    { component: 'before.sha', change: { before: { ...BEFORE, sha: 'c3'.padEnd(40, 'c3') } } },
    { component: 'after.sha', change: { after: { ...AFTER, sha: 'd4'.padEnd(40, 'd4') } } },
    {
      component: 'after.kind (working-tree with fingerprint)',
      change: {
        after: {
          label: 'working-tree',
          kind: 'working-tree' as const,
          sha: null,
          baseSha: BEFORE.sha,
          fingerprint: 'sha256:dirty',
        },
      },
    },
    { component: 'after.fingerprint', change: { after: { ...AFTER, fingerprint: 'sha256:other' } } },
    { component: 'findingIds', change: { findingIds: ['SCOPE-001'] } },
  ])('changes when any single component changes: $component', ({ change }) => {
    const base = verificationContextId(input())
    expect(verificationContextId(input(change))).not.toBe(base)
  })

  it('is insensitive to finding-id ordering (sorted defensively)', () => {
    const sorted = verificationContextId(input({ findingIds: ['SCOPE-001', 'TEST-001'] }))
    const shuffled = verificationContextId(input({ findingIds: ['TEST-001', 'SCOPE-001'] }))
    expect(shuffled).toBe(sorted)
  })

  it('omits undefined optional state fields from the hash', () => {
    const explicit = verificationContextId(input())
    const withUndefined = verificationContextId(
      input({
        before: { ...BEFORE, baseSha: undefined, fingerprint: undefined },
        after: { ...AFTER, baseSha: undefined, fingerprint: undefined },
      }),
    )
    expect(withUndefined).toBe(explicit)
  })
})

describe('verificationRunId', () => {
  const contextId = verificationContextId(input())
  const at = new Date('2026-10-04T12:34:56.789Z')

  it('embeds the 12-hex context prefix and a basic ISO timestamp', () => {
    expect(verificationRunId(contextId, at)).toBe(`run_${contextId.slice(4, 16)}_20261004T123456Z`)
  })

  it('is identical for the same context and time, different for different times', () => {
    expect(verificationRunId(contextId, at)).toBe(verificationRunId(contextId, at))
    expect(verificationRunId(contextId, new Date('2026-10-04T12:34:57.000Z'))).not.toBe(
      verificationRunId(contextId, at),
    )
  })

  it('changes with the context prefix and defaults to now when no date is given', () => {
    const otherContext = verificationContextId(input({ contractId: 'other' }))
    expect(verificationRunId(otherContext, at)).not.toBe(verificationRunId(contextId, at))
    expect(verificationRunId(contextId)).toMatch(/^run_[0-9a-f]{12}_\d{8}T\d{6}Z$/)
  })
})

describe('canonicalJson', () => {
  it('orders keys recursively regardless of insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
    expect(canonicalJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}')
  })

  it('omits undefined fields at every level', () => {
    expect(canonicalJson({ a: undefined, b: { c: undefined, d: 1 } })).toBe('{"b":{"d":1}}')
  })

  it('preserves array order (arrays are data, not maps)', () => {
    expect(canonicalJson({ list: [2, 1] })).toBe('{"list":[2,1]}')
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]))
  })

  it('passes primitives and null through', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(42)).toBe('42')
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(true)).toBe('true')
  })
})
