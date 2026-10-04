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
"UI polish" change that quietly rewrites the localStorage key and adds a
dependency, and verifies it against the app's change contract — resulting in a
REJECT with evidence for both violations.

## Usage

```bash
# Scaffold a contract for your change
npx regression-guard init

# Edit it (must/may/preserve/prohibit paths), then verify any two refs
npx regression-guard verify \
  --contract regression-guard.contract.yaml \
  --before main \
  --after my-feature
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
| M2 | Baseline Engine + existing-test regression diffing, `--working-tree` mode | planned |
| M3 | Impact Analyzer: blast radius, affected-test selection | planned |
| M4 | Evidence reproduction, repair-loop report contract | planned |
| M5 | LLM advisors (contract inference, test generation), browser/API/security verification, CI actions | planned |

Question 3 (regressions) is reported honestly as **NOT VERIFIED** until M2.

## Repository layout

```
packages/core     # engine: schemas, git adapter, import graph, analyzers, gate, reports
packages/cli      # regression-guard verify / init
examples/todo-app # demo target: a real (small) app with a change contract
docs/             # architecture
scripts/demo.mjs  # the verify:demo scenario
```
