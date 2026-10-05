import type { ProbeExpectation } from '../schema/service'

/**
 * M5 probe expectation evaluation — pure and deterministic. A manifest
 * declares fixed expectations (status code + body substring); a probe
 * execution produces one ProbeResponse; this module decides passed/failed
 * with a stable detail string. No timing assertions, no fuzzy matching:
 * identical inputs always yield the identical verdict and detail.
 */

/** The executed HTTP response a probe produced. */
export interface ProbeResponse {
  status: number
  body: string
}

export interface ProbeEvaluation {
  passed: boolean
  detail: string
}

/** Failure details quote a bounded slice of the body — never the whole thing. */
const DETAIL_BODY_LIMIT = 200

export function evaluateProbe(expectation: ProbeExpectation, response: ProbeResponse): ProbeEvaluation {
  // Deterministic check order: status first, then body substring.
  if (expectation.status !== undefined && expectation.status !== response.status) {
    return { passed: false, detail: `expected status ${expectation.status}, got ${response.status}` }
  }
  if (expectation.bodyContains !== undefined && !response.body.includes(expectation.bodyContains)) {
    return {
      passed: false,
      detail: `body does not contain "${truncate(expectation.bodyContains)}"${bodyContext(response.body)}`,
    }
  }
  // Both expectations omitted (or all met): a response that was received at
  // all satisfies the vacuous expectation.
  return { passed: true, detail: '' }
}

function bodyContext(body: string): string {
  if (body.length === 0) {
    return ' (body was empty)'
  }
  return ` (body: "${truncate(body)}")`
}

function truncate(text: string): string {
  return text.length <= DETAIL_BODY_LIMIT ? text : `${text.slice(0, DETAIL_BODY_LIMIT)}…[truncated]`
}
