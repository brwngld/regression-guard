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
| M3        | Impact Analyzer: blast radius, affected-test selection   | planned |
| M4        | Evidence reproduction (flaky re-runs), repair-loop report contract | planned |
| M5        | LLM advisors, browser/API/contract/security/adversarial verification, non-JS languages, CI actions | planned |

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

## Repository layout

```
packages/core     # engine: schemas, git adapter, intel graph, analyzers, gate, reports
packages/cli      # regression-guard verify / init
examples/todo-app # built-in demo target with scripted change scenarios
```
