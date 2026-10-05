import { describe, expect, it } from 'vitest'
import { evaluateProbe, type ProbeResponse } from './probe-eval'

describe('evaluateProbe', () => {
  it.each([
    {
      name: 'status match passes with empty detail',
      expectation: { status: 200 },
      response: { status: 200, body: 'anything' },
      passed: true,
      detail: '',
    },
    {
      name: 'status mismatch fails with expected/got detail',
      expectation: { status: 200 },
      response: { status: 500, body: '' },
      passed: false,
      detail: 'expected status 200, got 500',
    },
    {
      name: 'bodyContains present passes',
      expectation: { bodyContains: 'ok' },
      response: { status: 200, body: 'status: ok (healthy)' },
      passed: true,
      detail: '',
    },
    {
      name: 'bodyContains missing fails',
      expectation: { bodyContains: 'needle' },
      response: { status: 200, body: 'haystack only' },
      passed: false,
      detailContains: 'body does not contain "needle"',
    },
    {
      name: 'both expectations met passes',
      expectation: { status: 200, bodyContains: 'ok' },
      response: { status: 200, body: 'ok' },
      passed: true,
      detail: '',
    },
    {
      name: 'status mismatch wins when both fail (deterministic check order)',
      expectation: { status: 201, bodyContains: 'ok' },
      response: { status: 500, body: 'nope' },
      passed: false,
      detail: 'expected status 201, got 500',
    },
    {
      name: 'both omitted passes vacuously',
      expectation: {},
      response: { status: 503, body: '' },
      passed: true,
      detail: '',
    },
    {
      name: 'bodyContains on empty body fails and says the body was empty',
      expectation: { bodyContains: 'ok' },
      response: { status: 200, body: '' },
      passed: false,
      detailContains: ['body does not contain "ok"', 'body was empty'],
    },
  ])('$name', ({ expectation, response, passed, detail, detailContains }) => {
    const result = evaluateProbe(expectation, response as ProbeResponse)
    expect(result.passed).toBe(passed)
    if (detail !== undefined) {
      expect(result.detail).toBe(detail)
    }
    for (const expected of detailContains ?? []) {
      expect(result.detail).toContain(expected)
    }
  })

  it('truncates long bodies in the failure detail', () => {
    const result = evaluateProbe(
      { bodyContains: 'needle' },
      { status: 200, body: 'x'.repeat(5_000) },
    )
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('body does not contain "needle"')
    expect(result.detail.length).toBeLessThan(600)
    expect(result.detail).toContain('[truncated]')
    expect(result.detail).not.toContain('x'.repeat(300))
  })

  it('is deterministic: identical inputs yield identical results', () => {
    const expectation = { status: 200, bodyContains: 'ok' }
    const response: ProbeResponse = { status: 404, body: 'missing' }
    expect(evaluateProbe(expectation, response)).toEqual(evaluateProbe(expectation, response))
  })
})
