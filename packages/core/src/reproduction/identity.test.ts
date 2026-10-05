import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { parseContract } from '../schema/contract'
import {
  canonicalJson,
  contractFingerprint,
  verificationContextId,
  verificationRunId,
  type LineageInput,
} from './identity'

const BEFORE = { label: 'main', kind: 'ref' as const, sha: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1' }
const AFTER = { label: 'feature', kind: 'ref' as const, sha: 'a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2' }

function input(overrides: Partial<LineageInput> = {}): LineageInput {
  return {
    contractId: 'spec-update',
    contractVersion: 1,
    contractFingerprint: 'cfx_fixedfingerprint',
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
    { component: 'contractFingerprint', change: { contractFingerprint: 'cfx_otherfingerprint' } },
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

  it('embeds the 12-hex context prefix, a basic ISO timestamp, and random hex entropy', () => {
    const runId = verificationRunId(contextId, at)
    expect(runId.startsWith(`run_${contextId.slice(4, 16)}_20261004T123456Z_`)).toBe(true)
    expect(runId).toMatch(/^run_[0-9a-f]{12}_\d{8}T\d{6}Z_[0-9a-f]{16}$/)
  })

  it('is collision-resistant: same context AND same timestamp still yield distinct ids', () => {
    const first = verificationRunId(contextId, at)
    const second = verificationRunId(contextId, at)
    expect(first).not.toBe(second)
    // Both share the deterministic part (context prefix + timestamp); only the
    // entropy differs.
    const deterministicPrefix = (id: string): string => id.slice(0, id.lastIndexOf('_'))
    expect(deterministicPrefix(first)).toBe(deterministicPrefix(second))
  })

  it('keeps distinct deterministic parts across times and contexts, and defaults to now', () => {
    expect(verificationRunId(contextId, new Date('2026-10-04T12:34:57.000Z'))).not.toBe(
      verificationRunId(contextId, at),
    )
    const otherContext = verificationContextId(input({ contractId: 'other' }))
    const otherRun = verificationRunId(otherContext, at)
    expect(otherRun.slice(4, 16)).not.toBe(verificationRunId(contextId, at).slice(4, 16))
    expect(verificationRunId(contextId)).toMatch(/^run_[0-9a-f]{12}_\d{8}T\d{6}Z_[0-9a-f]{16}$/)
  })
})

describe('contractFingerprint', () => {
  /** Block-style YAML with sections in one order. */
  const BLOCK_STYLE = `version: 1
id: spec-update
goal: Update the specification
paths:
  mustChange:
    - docs/spec.md
  prohibited:
    - db/**
acceptance:
  - id: AC-1
    description: Spec updated
policy:
  prohibited-change: reject
reproduction:
  attempts: 3
  timeoutMs: 15000
`
  /** Same contract: flow style, different key order, all defaults explicit. */
  const FLOW_STYLE_EXPLICIT_DEFAULTS = `{goal: Update the specification, id: spec-update, version: 1,
paths: {prohibited: ["db/**"], mustChange: ["docs/spec.md"], mayChange: [], mustPreserve: []},
acceptance: [{id: AC-1, description: Spec updated}],
policy: {prohibited-change: reject},
reproduction: {attempts: 3, timeoutMs: 15000}}`
  /** Same contract: optional sections omitted so zod defaults fill them. */
  const OMITTED_DEFAULTS = `id: spec-update
goal: Update the specification
paths:
  mustChange: ["docs/spec.md"]
  prohibited: ["db/**"]
acceptance:
  - {id: AC-1, description: Spec updated}
policy: {prohibited-change: reject}
reproduction: {attempts: 3, timeoutMs: 15000}
`

  it('identifies semantically identical, differently formatted contracts identically', () => {
    const block = contractFingerprint(parseContract(parseYaml(BLOCK_STYLE)))
    const flowExplicit = contractFingerprint(parseContract(parseYaml(FLOW_STYLE_EXPLICIT_DEFAULTS)))
    const omitted = contractFingerprint(parseContract(parseYaml(OMITTED_DEFAULTS)))
    expect(block).toMatch(/^cfx_[0-9a-f]{64}$/)
    expect(flowExplicit).toBe(block)
    expect(omitted).toBe(block)
  })

  it('diverges when the rules change under the same id and version', () => {
    const fingerprint = (yaml: string): string => contractFingerprint(parseContract(parseYaml(yaml)))
    const mustChange = fingerprint('id: spec-update\ngoal: g\npaths:\n  mustChange: ["src/a.ts"]\n')
    const prohibited = fingerprint('id: spec-update\ngoal: g\npaths:\n  prohibited: ["src/a.ts"]\n')
    const extraRule = fingerprint(
      'id: spec-update\ngoal: g\npaths:\n  mustChange: ["src/a.ts"]\n  mustPreserve: ["src/b.ts"]\n',
    )
    expect(prohibited).not.toBe(mustChange)
    expect(extraRule).not.toBe(mustChange)
    expect(extraRule).not.toBe(prohibited)
  })

  it('feeds the context hash: same id/version, changed rules → different verificationContextId', () => {
    const fingerprint = (yaml: string): string => contractFingerprint(parseContract(parseYaml(yaml)))
    const mustChange = fingerprint('id: spec-update\ngoal: g\npaths:\n  mustChange: ["src/a.ts"]\n')
    const prohibited = fingerprint('id: spec-update\ngoal: g\npaths:\n  prohibited: ["src/a.ts"]\n')
    expect(
      verificationContextId(input({ contractFingerprint: mustChange })),
    ).not.toBe(verificationContextId(input({ contractFingerprint: prohibited })))
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
