# Regression Guard — Architecture

Regression Guard is a **change integrity verification system**. It sits between any
change producer and acceptance of that change, and answers three independent
questions about every change:

1. **Was the requested change accomplished?**
2. **Did the change stay within its permitted scope?**
3. **Did the permitted changes break something that used to work?**

These are deliberately independent. An engineer — human or AI — can stay
completely within scope and still introduce a regression. Conversely a feature can
work perfectly while an unrelated database schema was silently modified. Those are
different failures and the system reports them separately.

## Core framing

We verify **software changes**, not authors. The change producer is a pluggable
input, not the thing the architecture revolves around:

```
OLD
User Request → AI Coder → Verify AI's Changes

NEW
Change Request → Change Producer → Verify the Change
                       │
              ┌────────┼─────────┐
              │        │         │
            Human     AI       Automation
```

The product launches around AI coding agents because that is where the problem is
currently most visible, but the engine is author-agnostic from day one.

### Why the verifier is deterministic (engineering rationale)

> **Verification adds the most value when the verifier's failure modes are
> independent of the producer's. Regression Guard therefore verifies changes
> through deterministic experiments and explicit evidence rather than
> probabilistic judgment. When it cannot establish a fact, it reports
> uncertainty rather than inferring safety.**

"Verify the change, not the AI" is the memorable slogan; the paragraph above
is the engineering rationale. An LLM verifier judging LLM-produced code
inherits correlated failure modes — shared training distributions, shared
blind spots, plausible-sounding wrong answers — so its second opinion is less
independent than it feels. A deterministic verifier fails in legible, bounded
ways (a graph missed an edge, a probe timed out, a manifest did not parse),
and every such failure surfaces as `unknown` / `partial`, never as a confident
wrong answer. AI may eventually draft *inputs* (contracts, candidate probes)
through the same `status: proposed` → explicit-approval seam that repair
proposals use, under one rule:

> **AI may propose an experiment. AI may never decide what the experiment
> proved.**

## Pipeline

```
CHANGE REQUEST
                           │
                           ▼
              ┌────────────────────────┐
              │ 1. CHANGE CONTRACT     │
              │ • Intended outcome     │
              │ • Must change          │
              │ • May change           │
              │ • Must preserve        │
              │ • Prohibited changes   │
              │ • Acceptance criteria  │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │ 2. REPOSITORY          │
              │    INTELLIGENCE        │
              │ • Module/import graph  │
              │ • Entry points         │
              │ • Tests ↔ modules      │
              │ • (later: APIs, DB,    │
              │    feature graph)      │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │ 3. BASELINE ENGINE     │
              │ Capture known-good     │
              │ behavior before change │
              └───────────┬────────────┘
                          ▼
                 ┌─────────────────┐
                 │ 4. CHANGE       │
                 │    PRODUCER     │
                 │ • Human         │
                 │ • AI agent      │
                 │ • Team          │
                 │ • Script/tool   │
                 │ • Dependency bot│
                 └────────┬────────┘
                          ▼
                 MODIFIED CODEBASE
                          ▼
              ┌────────────────────────┐
              │ 5. CHANGE ANALYZER     │
              │ Before ↔ After: files, │
              │ dependencies, sensitive│
              │ categories             │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │ 6a. SCOPE ANALYZER     │
              │ "Should this have      │
              │  changed?"             │
              ├────────────────────────┤
              │ 6b. IMPACT ANALYZER    │
              │ "What could this      │
              │  change have         │
              │  affected?"           │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │ 7. VERIFICATION ENGINE │
              │ Existing, generated,   │
              │ regression, browser,   │
              │ API, contract,         │
              │ security, adversarial, │
              │ runtime tests          │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │ 8. EVIDENCE ENGINE     │
              │ Claim → Experiment     │
              │       → Observation    │
              │       → Reproduction   │
              │       → Evidence       │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │ 9. CHANGE INTEGRITY    │
              │    GATE                │
              │ ACCEPT / WARN /        │
              │ REVIEW / REJECT        │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │ 10. REPORT / REPAIR    │
              │ • What changed         │
              │ • What broke           │
              │ • Evidence             │
              │ • Root-cause candidate │
              │ • Repair constraints   │
              └────────────────────────┘
```

### Scope Analysis vs. Impact Analysis

These are separated conceptually (even if they may share a service) because they
answer different questions:

**Scope analysis — "Should this have changed?"**

```
Home.tsx              EXPECTED
homepage.css          EXPECTED
Header.tsx            RELATED
auth.ts               SUSPICIOUS
database.sql          OUT OF SCOPE
```

**Impact analysis — "What could this change have affected?"**

```
Header.tsx changed
       │
       ├── Login
       ├── Logout
       ├── Navigation
       ├── Search
       └── Mobile menu

Therefore: TEST THESE FEATURES
```

A change can pass scope and fail preservation, or pass both and still carry a
regression inside its blast radius. Keeping the questions apart is what lets the
gate distinguish those failures.

## Central data model

The architecture revolves around four objects:

| Object            | Question                |
| ----------------- | ----------------------- |
| **Change Contract** | What should change?   |
| **Baseline**      | What worked before?     |
| **Change Graph**  | What was affected?      |
| **Evidence**      | What can we prove?      |

The core principle is to operate on:

```
Intent → Baseline → Change → Impact → Experiment → Evidence
```

rather than:

```
Code → LLM → Opinion
```

No finding leaves the engine without evidence and a reproduction command. Both
`ChangeContract` and `VerificationReport` carry explicit schema versions
(`version: 1` / `schemaVersion: 1`), and every evidence object declares its
kind (`diff`, `dependency`, later `test`/`runtime`/`browser`/`api`) so later
milestones extend the model instead of replacing it.

## The gate

```
ACCEPT   — change is within contract, no findings
WARN     — tolerable anomalies worth surfacing
REVIEW   — needs a human decision (e.g. out-of-scope file touched)
REJECT   — contract violation (e.g. prohibited area changed)
```

Policies map finding classes to actions and are configurable per contract, so the
same engine works locally, in code review, and in CI.

## Implementation status

The engine is deterministic (no LLM in the core). LLM *advisors* — contract
inference, test generation — attach later behind a reserved interface and never
replace the deterministic verdicts. Question 3 (regressions) is answered by the
Baseline Engine against the repository's existing tests; it reports
`not-verified` only when regression verification was not performed.

| Milestone | Scope                                                   | Status |
| --------- | ------------------------------------------------------- | ------ |
| M1        | Change Contract, Repository Intelligence (module graph), Change Analyzer, **Scope Analyzer**, Integrity Gate, Evidence-backed report | **shipped** |
| M2        | **Baseline Engine**: deterministic existing-test regression detection, `--working-tree` mode | **shipped** |
| M3        | Impact Analyzer: evidence-backed blast radius, affected tests, impact coverage, prediction-vs-reality | **shipped** |
| M4        | Reproduction engine, evidence packages, repair contract proposals | **shipped** |
| M5a       | **Service Verification**: declared HTTP services + deterministic probes (execution evidence; browser-DOM execution and LLM advisors deliberately deferred) | **shipped** |
| M5b       | **API Contract Verification**: contract-sourced probe expectations from repo-checked-in OpenAPI documents (pinned JSON-schema subset; separated manifest / contract / runtime identities) | **shipped** |

### Baseline Engine (M2)

The engine discovers the repository's declared `scripts.test` and executes it
against the before and after revisions in **isolated temporary git worktrees**;
the user's checkout is never mutated (working-tree mode materializes dirty
state by overlaying it onto a base worktree). Outcomes are modeled per test
where the runner provides them (vitest/jest JSON reports); otherwise an honest
suite-level fallback applies. Transitions are classified conservatively:

```
PASS -> PASS   preserved          PASS -> FAIL   regression (REJECT by default)
FAIL -> FAIL   pre-existing       FAIL -> PASS   improvement
missing/inconclusive              unknown -> partial, never silently a pass
```

Every execution runs under a hard timeout with process-tree kill and capped
output capture — test runners hang, servers stay alive, and children spawn
children, so the execution boundary is enforced from day one.

**Reproducibility hardening (M2.1):**

- **Working-tree identity** — no commit SHA can identify HEAD-plus-dirty-overlay,
  so working-tree mode reports `afterSha: null` with an explicit
  `{ baseSha, fingerprint }` identity; the fingerprint deterministically hashes
  the materialized changed state (staged, unstaged, and untracked alike).
- **Deterministic dependency restoration** — `npm ci` (lockfile-exact) whenever
  a lockfile exists, `npm install` only as a lockfile-less fallback; the
  strategy and outcome are recorded per run, and install failures report
  `partial` with an environment-drift hint, never a silent pass.
- **Test-plan comparability** — the declared test command is discovered
  independently from each side's materialized `package.json`; when the plans
  differ, each side runs its own command, a `test-command-changed` finding is
  emitted, and the regression status is forced to `partial` — the after state
  can never silently redefine what the baseline means.

In M1, question 3 (regressions) is reported as **NOT VERIFIED** — honestly, until
the Baseline Engine (M2) ships.

### Impact Analyzer (M3)

The Impact Analyzer answers "given the changes that actually occurred, what
could this change affect?" Seeds are ALL actual changes regardless of scope
classification — blast radius is a property of the change, not of the contract.
Every affected node carries a level (DIRECT for the changed files themselves;
HIGH/MEDIUM/LOW by minimum reverse-dependency distance) and up to three
shortest evidence chains (`seed → … → node`), so every "affected" claim is
inspectable rather than asserted. Tests and entrypoints are terminal: recorded
as affected, never expanded upward. Deletions are traced through the
before-state graph, renames through both states. Unresolved imports and
computed dynamic imports surface as `unresolvedEdges` that mark the analysis
PARTIAL rather than being guessed away. Impact coverage lists affected areas no
relevant test exercises, and the prediction review compares predicted affected
tests against M2's observed regressions — a prediction miss measures analyzer
incompleteness, never extra risk in the change. The invariant: M3 informs but
never reduces M2's full baseline — `--affected-only` is deliberately absent
until prediction data justifies it.

### Reproduction & Repair Preparation (M4)

Findings become **structured experiments**: a command is executable + args (the
authoritative form; any human-readable rendering is derived, never the source
of truth) plus the exact state it must run against. Experiments re-execute the
evidence in isolated worktrees — the user's checkout is never mutated — and in
working-tree mode the M2.1 fingerprint is re-verified first: if the tree
drifted since verification, nothing executes and the assessment is honestly
`inconclusive` with `stateMatched: false`; a different state is never silently
substituted. Test reruns climb a case → file → suite granularity ladder and
record the rung actually achieved, never a finer one (unsafely quotable test
names force a downgrade rather than an unsafe shell string).

Reproduction is bounded N-of-M — default 5 attempts, capped at 10 — with
deliberately conservative stability semantics: any inconclusive attempt makes
the headline INCONCLUSIVE while the honest counts stay visible, and `unstable`
means consistent inconsistency across identical reruns, not statistical
flakiness. Reproduction only *enriches* findings; it never deletes, downgrades,
or re-gates an M2 observation, and the gate verdict is never recomputed from
reproduction outcomes.

When findings exist, the report carries an **Evidence Package**: the enriched
findings, scope, impact, and reproductions, plus a Repair Contract with
`status: proposed`. Every changed path gets exactly one operation constraint —
`editable`, `restore-to-baseline` (an operation constraint — revert toward the
original baseline, never permission to redesign), or `prohibited` for unchanged
paths the contract bans. Approval of a repair is explicitly outside Regression
Guard: impact analysis may inform the proposal but grants no permission. The
package carries dual-baseline state identities — A (original baseline) and B
(violating state) — so a future repair C can be verified both B → C (repair
scope) and A → C (final health) as full verifications. Lineage is explicit: a
deterministic verification context id plus a unique run id. There is no
automatic repair, no impact-derived permissions, and no orchestration.

### Service Verification (M5a)

Repositories DECLARE runnable services and deterministic HTTP probes in a
checked-in manifest (`regression-guard.services.yaml`, trusted like
`scripts.test`). The Baseline Extension runs each side's probes inside the
SAME isolated before/after worktrees the test phase materialized — reading the
manifest from each worktree on disk, so the immutable-identity rule holds
exactly as test-plan discovery does. Outcomes are classified with the SHARED
transition table (PASS → FAIL is a `service-regression` finding that rejects
by default; FAIL → FAIL is pre-existing; unknown forces partial); when the two
sides' manifest digests differ, each side still runs its own declaration and
the comparison is marked non-comparable (forced partial, info finding).
Reproduction reruns the ONE failing probe N-of-M against the recorded after
state, deriving the manifest immutably per side (recorded SHA, or verified
fingerprint / base SHA in working-tree mode) with the same per-attempt
materialization discipline as test experiments. Deliberately out of scope: no
LLM, no browser-DOM execution engine, no generated tests.

### API Contract Verification (M5b)

A probe may source its expectation from the repository instead of spelling it
inline: `expect.fromContract` names an OpenAPI operation (file, method, path,
response status) in a repo-checked-in document, and the chain is declared
probe → inline OR contract-sourced expectation → OpenAPI operation → runtime
response → deterministic validation → PASS / FAIL / UNKNOWN — feeding the same
transition table as everything else (contract-sourced PASS → FAIL is an
`api-contract-regression` that REJECTs by default). The boundary is locked: the
spec supplies RUNTIME expectations for declared probes; this is NOT a spec-diff
compatibility analyzer. Schema validation is pinned to an explicit keyword
subset — `type`, `properties`, `required`, `items`, `enum`, `nullable`,
`additionalProperties` — and anything else (`pattern`, `format`, `oneOf`, …) is
reported as unknown: never ignored (an ignored constraint would manufacture a
pass the spec never declared), never failed (we cannot judge what we cannot
validate). Three identities stay separated: the service manifest is WHAT
EXECUTES, the API contract is WHAT IS PROMISED, the runtime observation is WHAT
HAPPENED — so a changed openapi.yaml diverges the per-side contract digests
(info finding, forced partial) instead of silently redefining what an endpoint
promised, mirroring the branch-move rule. Manifest loading discriminates absent
from invalid: absent means "no verification was declared" (the phase is
skipped), invalid means "verification was declared incorrectly"
(`service-manifest-invalid` info finding, no probes execute, forced partial).

## Repository layout

```
packages/core     # engine: schemas, git adapter, intel graph, analyzers, gate, reports
packages/cli      # regression-guard verify / init
examples/todo-app # built-in demo target with scripted change scenarios
```
