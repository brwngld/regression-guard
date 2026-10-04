import type { FindingClass, PolicyAction } from '../schema/contract'
import type { Finding } from '../schema/evidence'
import type { GateDecision, Verdict } from '../schema/gate'

/**
 * The Change Integrity Gate maps findings to actions and composes the final
 * verdict. Defaults are deliberately conservative; contracts can override any
 * class (e.g. soften `out-of-scope-change` to `warn` for docs-only repos).
 */
export const DEFAULT_POLICY: Record<FindingClass, PolicyAction> = {
  'prohibited-change': 'reject',
  'preserved-area-changed': 'reject',
  'out-of-scope-change': 'review',
  'new-dependency': 'review',
  'removed-dependency': 'review',
  'changed-dependency': 'warn',
  'deleted-test': 'review',
  'sensitive-file-changed': 'review',
  'unfulfilled-contract': 'review',
}

const ACTION_RANK: Record<PolicyAction, number> = {
  accept: 0,
  warn: 1,
  review: 2,
  reject: 3,
}

const ACTION_TO_VERDICT: Record<PolicyAction, Verdict> = {
  accept: 'ACCEPT',
  warn: 'WARN',
  review: 'REVIEW',
  reject: 'REJECT',
}

export function applyPolicy(
  findings: Finding[],
  overrides: Partial<Record<FindingClass, PolicyAction>> = {},
): GateDecision {
  const policy = { ...DEFAULT_POLICY, ...overrides }
  const actionFor = (finding: Finding): PolicyAction =>
    (policy as Record<string, PolicyAction | undefined>)[finding.findingClass] ?? 'warn'

  const triggered = findings.map(actionFor)

  const worst = triggered.reduce<PolicyAction>(
    (current, action) => (ACTION_RANK[action] > ACTION_RANK[current] ? action : current),
    'accept',
  )

  const triggeredActions = [...new Set(triggered)].sort(
    (left, right) => ACTION_RANK[right] - ACTION_RANK[left],
  )

  // Worst policy action first; stable within the same action so finding ids
  // keep their generation order.
  const orderedFindings = [...findings].sort(
    (left, right) => ACTION_RANK[actionFor(right)] - ACTION_RANK[actionFor(left)],
  )

  return { verdict: ACTION_TO_VERDICT[worst], triggeredActions, findings: orderedFindings }
}
