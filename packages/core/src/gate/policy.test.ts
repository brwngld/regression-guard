import { describe, expect, it } from 'vitest'
import { applyPolicy, DEFAULT_POLICY } from './policy'
import type { Finding } from '../schema/evidence'
import type { FindingClass } from '../schema/contract'

function findingOf(findingClass: FindingClass, id = 'X-001'): Finding {
  return {
    id,
    findingClass,
    severity: 'warn',
    message: 'x',
    paths: [],
    evidence: { kind: 'diff', claim: 'c', observation: 'o', changedLines: [], reproduction: 'r' },
  }
}

describe('applyPolicy', () => {
  it('accepts when there are no findings', () => {
    expect(applyPolicy([])).toEqual({ verdict: 'ACCEPT', triggeredActions: [], findings: [] })
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

  it('accepts test-command-changed findings without worsening the verdict', () => {
    expect(DEFAULT_POLICY['test-command-changed']).toBe('accept')
    expect(applyPolicy([findingOf('test-command-changed')]).verdict).toBe('ACCEPT')
  })

  it('falls back to warn for findings from a future schema version', () => {
    // Finding.findingClass is a closed enum now; this cast simulates a
    // deserialized report from a newer engine being re-gated, which the
    // defensive fallback in applyPolicy must handle.
    const futureFinding: Finding = {
      ...findingOf('out-of-scope-change'),
      findingClass: 'future-class' as FindingClass,
    }
    expect(applyPolicy([futureFinding]).verdict).toBe('WARN')
  })

  it('carries its findings ordered worst policy action first', () => {
    const decision = applyPolicy(
      [findingOf('out-of-scope-change', 'A-001'), findingOf('prohibited-change', 'B-001'), findingOf('changed-dependency', 'C-001')],
    )
    expect(decision.findings.map((finding) => finding.id)).toEqual(['B-001', 'A-001', 'C-001'])
    expect(decision.verdict).toBe('REJECT')
  })
})
