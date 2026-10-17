# Light ORC (lorc)

One lean coding skill for Claude Code.

[![npm](https://img.shields.io/npm/v/@azure-id/lorc?label=npm)](https://www.npmjs.com/package/@azure-id/lorc) ![node](https://img.shields.io/badge/node-%E2%89%A5%2018-green) ![license](https://img.shields.io/badge/license-MIT-lightgrey) ![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Latest version:** 0.4.3 — 17-10-2026 · npm: [`@azure-id/lorc`](https://www.npmjs.com/package/@azure-id/lorc)

## What it is

lorc is one skill: `/lorc`. It does one coding request: a fix, a feature or a refactor.
lorc started from ORC parts: house rules, wiki, code pattern, executors, orc extra, review, and wait on limit.
Since 0.4.0, lorc owns its code graph engine (forked from ORC 2.3.0).
When ORC 2.2.0 or newer is installed, lorc calls ORC.
When ORC is not installed, lorc does the same work itself.
lorc has zero runtime dependencies.

## Why

Measured on the company Vue repo, medians of 3 runs, against `/orc-quick` (same main model, Opus 5.5 medium):

- Step 1 (RMT1), lorc 0.4.3 alone, against `/orc-quick`: lane time −20 %, cost −40 %, tokens −42 %, score 88 (Q: 84), e2e 3 of 3.
- Against lorc 0.3.3: lane −16 %, cost −16 %, tokens −21 %, score +2, graph calls 1 → 0.
- lorc 0.3.3 against plain Claude Code (1 run per arm): cost −38 % to −39 %, tokens −44 % to −46 %, score 1–2 points lower.
- Step 2 (RMT3), lorc 0.1.10 alone: lane time −28 %, cost −38 %, tokens −38 %, same score (84). With ORC: −43 %, −43 %, −54 %, same score.
- See [docs/benchmark.md](docs/benchmark.md).

## Quick start

Requirements: Claude Code, Node.js 18 or newer.
```bash
npm i -g @azure-id/lorc   # 1. install the CLI
lorc init                 # 2. install lorc into .claude/ (--global: ~/.claude/)
lorc rules init           # 3. optional: HOUSE-RULES.md in the repo root
```
Then, in Claude Code: `/lorc <your request>`. Other install paths and an example run: [docs/commands.md](docs/commands.md#install-and-update).

## Contents

| Topic | What you find there | Link |
|---|---|---|
| How a run works | the L0–L6 steps, the context pack and the hard gate | [docs/how-it-works.md](docs/how-it-works.md) |
| Tiers | the tier table, lorc's tier engine, the jev tier and option judges | [docs/tiers.md](docs/tiers.md) |
| Executors | the executor and reviewer agents and their models | [docs/executors.md](docs/executors.md) |
| Works with ORC | the delegate rule, shared files, store modes | [docs/orc.md](docs/orc.md) |
| Code graph | store format 2, write and read path, upgrade, numbers | [docs/graph.md](docs/graph.md) |
| More features | house rules, wiki, code pattern, usage limit, status line, habits | [docs/features.md](docs/features.md) |
| Settings | all setting keys with defaults | [docs/settings.md](docs/settings.md) |
| Commands | install, all commands, coverage, files lorc writes | [docs/commands.md](docs/commands.md) |
| Benchmark | full tables, charts, gate verdicts, limits | [docs/benchmark.md](docs/benchmark.md) |

## How a run works

L0 PREP (one `lorc prep` call, in one process: graph heal, tier engine, context pack) →
L1 DIG (`lorc read` (one call: the requirement doc, the change targets, the `must_ask` evidence and the context pack), then ≤ 2 more calls) →
L2 TIER → L3 ASK (one message, nothing runs before your answer) →
L4 BUILD (inline or executors) → L5 CHECK + REVIEW → L6 FINISH (`lorc run end`).
lorc never assumes: an unknown fact is a question in L3.
The context pack (`<run>/context.md`) links the names in the request and the doc to anchored line ranges: change targets, exemplars, the test setup.
The executor slice carries its context items, the requirement doc and a small read file (one Read), so executors do not dig again.
More: [docs/how-it-works.md](docs/how-it-works.md)

## Tiers

| Tier | Signals | Subagents (auto) |
|---|---|---|
| low | ≤ 2 files, 1 area, no new module | 0 — lorc edits inline |
| mid | 3–5 files, or 1 new component in 1 area | ≤ 1 |
| high | 6–20 files, ≥ 2 new components, or 2–3 independent areas | ≤ 3 |
| complex | > 20 files, > 3 areas, ordered steps, a migration | ≤ 5 + a checkpoint after each wave |

Who decides the tier: TypeSafe jev (with a key, when confident) → lorc's tier engine → the table.
More: [docs/tiers.md](docs/tiers.md)

## Executors

haiku-5-high → mechanical work · sonnet-5-med → normal feature work · opus-5-low → cross-module work, tricky state ·
opus-5-med → hard logic, security · reviewer opus-5-low → the review of large or risky diffs.
Agent names: `lorc-executor-<name>`, `lorc-reviewer-opus-5-low`.
More: [docs/executors.md](docs/executors.md)

## Works with ORC

When ORC 2.2.0 or newer is installed, lorc calls `orc graph`, `orc wiki`, `orc pattern` and `orc extra`. When a call fails,
lorc uses its own path. Since 0.4.0, lorc owns its graph engine (`bin/lib/graph/`, `lgraph@1`).
Delegate mode stays; the `orc-store` and `copy` store modes are removed. lorc and ORC share the wiki and the code patterns.
More: [docs/orc.md](docs/orc.md)

## More features

- House rules and anti-slop: `HOUSE-RULES.md` beats every other rule; `lorc rules lint` checks with zero tokens.
- Wiki and code pattern: `/lorc-wiki` and `/lorc-pattern` build them in ORC's file format.
- Usage limit and the status line: lorc waits at 90 % of the 5-hour window and stops at 98 % of the week.
- Behaviour learning: lorc proposes habits from your answers and never applies one without your yes.

More: [docs/features.md](docs/features.md)

## Settings

Set a value with `lorc settings set <key> <value> [--global]`. A project value beats a global value.
Most used keys: `dispatch` (`auto`), `dispatch_max` (`5`), `executor` (`ask`), `review` (`auto`), `limit_pct` (`90`).
More: [docs/settings.md](docs/settings.md)

## Commands

| Command | What it does |
|---|---|
| `lorc init` | install lorc into `.claude` (no overwrite) |
| `lorc prep` | the one L0 call of `/lorc` |
| `lorc check` | affected tests, lint, typecheck |
| `lorc cov` | coverage of the changed source files |
| `lorc tier` | lorc's tier engine |
| `lorc context` | the context pack: anchored line ranges for a request |
| `lorc read` | the read plan: the code ranges a run or a task needs, in one call |
| `lorc graph upgrade` | convert a format-1 graph store in place |
| `lorc run end` | finish the run: graph update, run record |
| `lorc doctor` | check the install; `--fix` repairs |
| `lorc upgrade` | install the latest version, then update |

All commands: [docs/commands.md](docs/commands.md)

## Benchmark

| Arm | Lane s | Cost $ | Tokens | Score | E2E |
|---|---|---|---|---|---|
| Q (`/orc-quick`) | 785 | 3.95 | 5.90M | 84 | 3/3 |
| LS 0.3.3 | 746 | 2.82 | 4.31M | 86 | 3/3 |
| **LS 0.4.3** | **627** | **2.36** | **3.40M** | **88** | **3/3** |

Step 1 (RMT1), company Vue repo, lorc alone, medians of 3 runs.
0.4.3 vs 0.3.3: lane −16 %, cost −16 %, tokens −21 %, score +2.
0.4.3 vs `/orc-quick`: lane −20 %, cost −40 %, tokens −42 %, score +4.
More (full tables + charts): [docs/benchmark.md](docs/benchmark.md)

## Development

```bash
npm test               # the node:test suite
npm run verify         # the package integrity check
npm run vendor         # copy the ORC rule packs and price table from ../orc (hash pinned; no graph engine)
npm run build:agents   # generate the executor agents from agents-src/executor.template.md
```

Never edit `vendor/` by hand: run `npm run vendor`.
Never edit the generated executor files. Edit `agents-src/executor.template.md`, then run `npm run build:agents`.

## Changelog

### 0.4.3 — 17-10-2026
The 0.4 line in short:

- **Eval medians vs 0.3.3 (RMT1): lane 746 → 627 s, cost $2.82 → $2.36, tokens 4.31M → 3.40M, score 86 → 88, graph calls 1 → 0.**
- Read file: each executor task gets a small read file (one Read); `lorc read` prints the main read plan in one call.
- lorc owns the graph engine: store format 2, 1-file update 11.5 MB → 254 KB written, cold build 3.7 s → 2.0 s.
- More robust graph: zero-symbol files 60 → 8, partial files 72 → 17, API functions with a URL 43 → 248.
- Context pack: anchored line ranges for the names in the request and the doc.
- Smarter tier engine, and `must_ask` items with options and evidence.
- `lorc graph upgrade` converts an old store; old stores stay readable.

Full notes: [CHANGELOG.md](CHANGELOG.md)

<details><summary>History</summary>

- 0.4.2 — read plan: `lorc read` prints the code a run or a task needs
- 0.4.1 — executor: fewer messages; slice refs get a range
- 0.4.0 — lorc owns the graph engine (store format 2, upgrade), context pack, smarter tier engine
- 0.3.5 — README split into short sections with links to `docs/` pages
- 0.3.4 — README benchmark: step 1 vs `/orc-quick` and no skill; 0.3.3 passes the gate
- 0.3.3 — prep `must_ask[]`: ask the route path of a new page, never pick it
- 0.3.2 — coverage tool limit is "NOT a finding"; an unmet acceptance item is P1
- 0.3.1 — `lorc cov`: source branches apart from generated branches
- 0.3.0 — lorc's own deterministic tier engine (`lorc tier`)
- 0.2.0 — TypeSafe jev judges the tier and rates the L3 options
- 0.1.11 — The L5 fix-round paragraph is back to the 0.1.8 text
- 0.1.10 — No SendMessage: a P0/P1 fix larger than 10 lines goes to one new executor
- 0.1.9 — After `lorc check` the main session never runs tests, coverage or builds
- 0.1.8 — Coverage output under the repo-root `.claude/lorc/`, not inside a sub-project folder
- 0.1.7 — Executor edits only with the Edit and Write tools
- 0.1.6 — Eval round 7 fixes: tests in a sub-project folder, graph-first dig, short reply
- 0.1.5 — Eval round 6 fixes: the project P0 rules and the coverage bar reach the executor
- 0.1.4 — Eval round 5 fixes: parallel split and reference code in the slice
- 0.1.3 — Eval round 4 fixes: no duplicate test work after the executor
- 0.1.2 — Eval round 3 fixes: slice known facts, one call for check and review
- 0.1.1 — Eval round 2 fixes: usage exit code, slice refs, executor test runs, L5 lint-only check
- 0.1.0 — Repo skeleton, vendor script

</details>

## License

MIT
