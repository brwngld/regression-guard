import { describe, expect, it } from 'vitest'
import { applyPolicy, DEFAULT_POLICY } from './policy'
import type { Finding } from '../schema/evidence'

function findingOf(findingClass: string): Finding {
  return {
    id: 'X-001',
    findingClass,
    severity: 'warn',
    message: 'x',
    paths: [],
    evidence: { claim: 'c', observation: 'o', changedLines: [], reproduction: 'r' },
  }
}

describe('applyPolicy', () => {
  it('accepts when there are no findings', () => {
    expect(applyPolicy([])).toEqual({ verdict: 'ACCEPT', triggeredActions: [] })
  })

  it('composes the worst triggered action', () => {
    const decision = applyPolicy([findingOf('changed-dependency'), findingOf('out-of-scope-change')])
    expect(decision.verdict).toBe('REVIEW')
    expect(decision.triggeredActions).toEqual(['review', 'warn'])
  })

  it('lets contract overrides soften or harden classes', () => {
    expect(applyPolicy([findingOf('out-of-scope-change')], { 'out-of-scope-change': 'warn' }).verdict).toBe('WARN')
    expect(applyPolicy([findingOf('changed-dependency')], { 'changed-dependency': 'reject' }).verdict).toBe('REJECT')
  })

  it('defaults prohibited and preserved-area violations to reject', () => {
    expect(applyPolicy([findingOf('prohibited-change')]).verdict).toBe('REJECT')
    expect(applyPolicy([findingOf('preserved-area-changed')]).verdict).toBe('REJECT')
    expect(DEFAULT_POLICY['new-dependency']).toBe('review')
  })

  it('falls back to warn for unknown finding classes', () => {
    expect(applyPolicy([findingOf('something-new')]).verdict).toBe('WARN')
  })
})
