# Regression Guard

**Author-agnostic change integrity verification.** Regression Guard sits between
any change producer — human, AI agent, team, script, or dependency bot — and
acceptance of that change, and answers three independent questions:

1. **Was the requested change accomplished?**
2. **Did the change stay within its permitted scope?**
3. **Did the permitted changes break something that used to work?**

These are deliberately separate. A change can pass scope and still carry a
regression; a feature can work perfectly while an unrelated schema file was
silently modified. Different failures, reported differently.

The engine is deterministic — no LLM in the core, ever. Verdicts are derived
from git facts, the repository's import graph, and a change contract; every
finding carries evidence and a reproduction command. Read
[docs/architecture.md](docs/architecture.md) for the full design.

## Quick start

```bash
npm install
npm run build
npm test            # core unit + integration, CLI e2e, example app tests
npm run verify:demo # watch the engine reject a disguised out-of-scope change
```

The demo copies `examples/todo-app` into a temp repo, commits a plausible
"UI polish" change that quietly rewrites the localStorage key, weakens input
validation (deterministically breaking an existing test), and adds a
dependency. Verification runs the app's real vitest suite against both
revisions in isolated worktrees and produces a REJECT on two independent
axes: out-of-scope changes, and a test regression caught by the Baseline
Engine.

## Usage

```bash
# Scaffold a contract for your change
npx regression-guard init

# Edit it (must/may/preserve/prohibit paths), then verify any two refs.
# The existing test suite runs against both revisions in isolated worktrees.
npx regression-guard verify \
  --contract regression-guard.contract.yaml \
  --before main \
  --after my-feature

# Verify uncommitted changes (a coding agent's work-in-progress) without committing
npx regression-guard verify \
  --contract regression-guard.contract.yaml \
  --before main \
  --working-tree

# Skip regression verification, or bound hanging runners (default 300s per run)
npx regression-guard verify ... --skip-tests
npx regression-guard verify ... --test-timeout 120000
```

A contract looks like this (see [examples/todo-app/contracts/ui-polish.yaml](examples/todo-app/contracts/ui-polish.yaml)):

```yaml
id: todo-ui-polish
goal: Polish the to-do app's visual styling without touching persistence behavior
paths:
  mustChange: ["src/style.css"]
  mayChange: ["index.html", "src/main.js"]
  mustPreserve: ["src/tasks.js", "src/tasks.test.js"]
  prohibited:
    - category: dependency-addition
    - category: env-secrets
```

Every changed file between the two refs is classified:

| Classification | Meaning                                             | Default action |
| -------------- | --------------------------------------------------- | -------------- |
| `EXPECTED`     | matched a must-change rule                          | accept         |
| `RELATED`      | matched a may-change rule or is import-adjacent     | accept         |
| `SUSPICIOUS`   | touched a must-preserve area                        | **reject**     |
| `OUT_OF_SCOPE` | no rule authorizes it                               | review         |
| `PROHIBITED`   | matched a prohibition (glob or sensitive category)  | **reject**     |

Exit codes: `0` accept/warn, `1` review/reject, `2` usage or contract errors —
so the same gate works locally, in code review, and in CI. Policies are
overridable per finding class in the contract.

## Status

| Milestone | Scope | Status |
| --------- | ----- | ------ |
| M1 | Change Contract, Repository Intelligence (module graph), Change Analyzer, **Scope Analyzer**, Integrity Gate, evidence-backed reports | **shipped** |
| M2 | **Baseline Engine**: existing-test regression detection (per-test where the runner provides outcomes, suite-level fallback), `--working-tree` mode, hard timeouts with process-tree kill | **shipped** |
| M3 | **Impact Analyzer**: evidence-backed blast radius, affected tests, impact coverage, prediction-vs-reality (report-only, never gates) | **shipped** |
| M4 | Evidence reproduction, repair-loop report contract | planned |
| M5 | LLM advisors (contract inference, test generation), browser/API/security verification, CI actions | planned |

Regression classification is conservative at every branch: PASS→PASS is
preserved, PASS→FAIL is a regression (REJECT by default), FAIL→FAIL is
pre-existing and never worsens the verdict alone, FAIL→PASS is an improvement,
and missing or inconclusive executions report `partial` — never silently a
pass.

## Repository layout

```
packages/core     # engine: schemas, git adapter, import graph, analyzers, gate, reports
packages/cli      # regression-guard verify / init
examples/todo-app # demo target: a real (small) app with a change contract
docs/             # architecture
scripts/demo.mjs  # the verify:demo scenario
```
