# Commands

[← README](../README.md)

## Install and update

**Requirements:** Claude Code, Node.js 18 or newer.

```bash
# 1. Install the CLI from npm
npm i -g @azure-id/lorc
#    or the newest commit from GitHub:
#    npm i -g github:azure-id/lorc

# 2. Install lorc into your project (.claude/)
lorc init
#    or into your user folder (~/.claude/)
lorc init --global

# 3. Optional: make HOUSE-RULES.md in the repo root
lorc rules init
```

Then, in Claude Code:

```
/lorc <your request>
```

Example of a run (an example only, the real text changes per request):

```
Prep:    graph ok · rules card · wiki 2 pages · pattern vue · usage 5h 31 %
Tier:    high — engine 74 % · 2 new components, ~6 source files · cap 3 · groups 2
❓ Put the route under /transfers or /payments? (src/router/index.ts:88)
   a) /transfers (90 %)  b) /payments (30 %)   ➡️ a — the menu already links /transfers
Executor: 1 haiku · 2 sonnet ➡️ · 3 opus low · 4 opus med
Answer, and I start. Nothing runs until you answer.
Build:   lorc-executor-sonnet-5-med — 4 files, tests passed
Check:   lint ok · typecheck ok · review inline, 1 P3 listed
Changed: 4 files · Verified: unit tests, lint · Findings: 1 P3
```

## Command reference

| Command | What it does |
|---|---|
| `lorc help` | print the usage |
| `lorc version` | print the lorc version (`--json` for one JSON object) |
| `lorc settings` (`setting`) | show, set or reset lorc settings |
| `lorc init` | install lorc into `.claude` (no overwrite) |
| `lorc update` | reinstall lorc files (overwrite); `--prune` removes orphans |
| `lorc prune` | same as `update --prune` |
| `lorc where` | print the install and data paths |
| `lorc doctor` | check the install; `--fix` repairs |
| `lorc upgrade` | `npm i -g @azure-id/lorc@latest`, then update |
| `lorc changelog` | versions newer than the installed one |
| `lorc usage` | 5h, weekly and context usage and the limit gate |
| `lorc wait` | wait for the 5h window reset (zero tokens) |
| `lorc cli` | `bypass`, `restore`, `status` of the status line |
| `lorc run` | run record: `checkpoint`, `end`, `resume`, `list`, `show` |
| `lorc habits` | habit proposals; `accept` or `decline <id>` |
| `lorc stats` | tokens and cost per finished run |
| `lorc graph` | code graph: `where`, `status [--heal]`, `update`, `scan`, `upgrade`, `gc`, `ctx`, `map`, `changes`, `sync` |
| `lorc context` | `context "<request>" [--doc <path>] [--run <slug>] [--json]`: the context pack (anchored line ranges for the request) |
| `lorc wiki` | `status`, `sync`, `pick "<words>"`, `commands` |
| `lorc pattern` | code pattern `status [<lang>]`, `show <lang>` |
| `lorc rules` | house rules: `init`, `show`, `card`, `lint [--diff]` |
| `lorc extra` | extra executors: `status`, `list`, `dispatch --slot <s> --slice <path>` |
| `lorc prep` | `prep "<request>" [--json] [--no-start]`: the one L0 call of `/lorc` |
| `lorc read` | `read --run <slug> [--task <n>] [--json]`: print the read plan. Without `--task`: the main plan (doc, targets, `must_ask` evidence, context; ≤ 20 KB). With `--task <n>`: the task plan |
| `lorc slice` | `slice --run <slug> --task <n> -`: write an executor slice (JSON on stdin) |
| `lorc check` | `check --run <slug> [--lint-only] [--build] [--full]`: affected tests, lint, typecheck |
| `lorc cov` | `cov [--bar <n>] [--json] [--dir <repo>]`: coverage of the changed source files from the lcov data (no test run); exit 1 when the bar is not met |
| `lorc review` | `review prep --run <slug> [--tier <t>]`: write the review packet |
| `lorc tier` | `tier "<request>" [--doc <path>] [--json] [--brief] [--no-heal]`: lorc's tier engine · `tier eval [--recompute]` |
| `lorc jev` | `status [--ping]`, `connect -`, `disconnect`, `tier`, `ask [--run <slug>] -`: the TypeSafe jev judges |

**Code graph commands.** `lorc graph scan` is the same as `lorc graph update`. It is a clearer name for a full build. lorc never builds the first graph by itself: run `lorc graph scan` once. `lorc graph update --if-exists` does nothing when no graph exists. `lorc graph update --json` gives `files`, `symbols`, `modules`, `parsed`, `reused`, `ms` and `written_bytes`. `lorc graph upgrade` converts a format-1 store (lorc ≤ 0.3.x, `graph@7`) to format 2 in place. A language parses again only when its extractor version changed. Any update also upgrades the store. `lorc graph sync` stays only for older skills: it is a no-op. `lorc graph gc` keeps every file that the current or the previous manifest lists and deletes the other bucket files at once. It deletes a stray temp file only when it is older than 10 minutes (the grace time). More: [graph.md](graph.md).

**Context pack.** `lorc context` links the names in the request and the doc (identifiers, files, CSS classes, endpoints, quoted UI text) to anchored line ranges. It adds the change targets, the closest exemplars with cards, the test setup to copy and 1-hop reuse. With `--run <slug>` it writes `<run>/context.md` and `context.json`. `lorc prep` does this for each run.

**Coverage: source and generated branches.** A transform (Babel, TS) adds branches that the source map puts on an import line or on a helper function line. These arms are not in the code that you wrote. `lorc cov` counts them as `generated` and judges the bar on lines and source branches (`src_branches`). For a file that existed at HEAD, it judges only the added lines (`changed`). Example: `AmountAndMethod.vue` raw branches 83.33 % → source branches 100 % (2 uncovered arms on an import line). A real gap stays a gap: the uncovered source lines are listed. When the source map of an SFC covers only a small part of its script, `lorc cov` sets `tool_limit`. This is a fact about the tooling. It is not a finding, and the review packet tells the reviewer so.

## Files lorc writes

| Scope | Path | What |
|---|---|---|
| Project | `.claude/lorc/settings.json` | project settings |
| Project | `.claude/lorc/run/<slug>/` | run state, `checkpoint.json`, `RESUME.md` |
| Project | `.claude/lorc/run/<slug>/read-<n>.md` | the task read plan (≤ 20 KB), written by `lorc slice`; the executor reads it in one Read |
| Project | `.claude/lorc/runs.jsonl` | finished runs |
| Project | `.claude/lorc/behaviour.jsonl`, `habits-state.json` | behaviour records and habit answers |
| Project | `.claude/lorc/rules-card.md` | the rules card |
| Project | `.claude/lorc/usage.json` | the status-line usage reading |
| Project | `.claude/lorc/tier/git.json` | the git-history cache of the tier engine |
| Project | `.claude/lorc/orc/graph/` | lorc's code graph store (format 2) |
| Project | `.claude/lorc/run/<slug>/context.md`, `context.json` | the context pack of the run |
| Project | `.claude/lorc/coverage/` | coverage output of `lorc check` |
| Global | `~/.claude/lorc/settings.json` | global settings |
| Global | `~/.claude/lorc/jev.json` | the saved TypeSafe key (`lorc jev connect`) |
| Repo root | `HOUSE-RULES.md` | your house rules |

