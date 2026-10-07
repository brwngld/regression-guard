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
  // Deterministic PASS -> FAIL transitions reject by default. Pre-existing
  // failures are visible but must not independently worsen the gate verdict.
  'test-regression': 'reject',
  'pre-existing-failure': 'accept',
  // H1 (verification completeness): partial/inconclusive verification must
  // not ACCEPT by default — an incomplete baseline hides regressions rather
  // than proving their absence. Infra failure is a human decision, not a
  // violation: review, never reject, by default; a contract policy override
  // (`policy: { baseline-incomplete: accept }`) is the explicit authorization.
  'baseline-incomplete': 'review',
  // H1: a changed test plan is also incomplete verification (each side ran a
  // different command), so it reviews by default — never rejects on its own;
  // the explicit contract override remains the authorization mechanism.
  'test-command-changed': 'review',
  // Deterministic PASS -> FAIL probe transitions reject by default, exactly
  // like test regressions; a changed manifest is visible but never worsens
  // the gate on its own (it forces partial probe comparability instead).
  'service-regression': 'reject',
  'service-manifest-changed': 'accept',
  // Contract-sourced PASS -> FAIL probe transitions reject like the others;
  // spec changes and invalid declarations are visible but force partial
  // comparability rather than independently worsening the gate.
  'api-contract-regression': 'reject',
  'api-contract-changed': 'accept',
  'service-manifest-invalid': 'accept',
  // Hardening: a missing/malformed package manifest makes the dependency diff
  // unknowable. Visible but never independently gate-worsening — the missing
  // or broken manifest is already penalized through out-of-scope scope
  // findings (and baseline partial when tests run).
  'dependency-state-unknown': 'accept',
  // H2: baseline test ids with no after outcome mean the executed coverage
  // shrank. Warn-severity, reviews by default — a coverage loss is a decision
  // to re-authorize, not a deterministic violation, and a contract override
  // can accept it explicitly.
  'test-coverage-reduced': 'review',
  // Requirement Verification defaults (Doc 1 §6, formerly strawmen OQ2/OQ4/
  // OQ7/OQ1): a failed requirement is deterministic evidence the required
  // behavior does not hold — reject. Instrument tampering and binding drift
  // invalidate WHAT is being verified without proving anything — review until
  // the contract is re-approved. UNVERIFIED requirements must not ACCEPT by
  // default (the H1 pattern: incomplete verification hides regressions rather
  // than proving their absence); the contract override accepts explicitly.
  'requirement-failed': 'reject',
  'requirement-experiment-modified': 'review',
  'requirement-binding-changed': 'review',
  'requirement-unverified': 'review',
  // Doc 1 I9: a new instrument's result is recorded but it never counts toward
  // VERIFIED — the clause already stays UNVERIFIED, so the signal itself is
  // informational only and must never gate on its own.
  'experiment-new': 'accept',
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
