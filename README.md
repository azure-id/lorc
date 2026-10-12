# Light ORC (lorc)

One lean coding skill for Claude Code.

![version](https://img.shields.io/badge/version-0.1.11-blue)
![node](https://img.shields.io/badge/node-%E2%89%A5%2018-green)
![license](https://img.shields.io/badge/license-MIT-lightgrey)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Latest version:** 0.1.11 — 12-10-2026 (on GitHub; not on npm yet)

## What it is

lorc is one skill: `/lorc`. It does one coding request: a fix, a feature or a refactor.
It takes these parts from ORC: the code graph, house rules, wiki, code pattern, executors, orc extra, review, and wait on limit.
When ORC 2.2.0 or newer is installed, lorc calls ORC.
When ORC is not installed, lorc does the same work itself.
lorc has zero runtime dependencies.

## Why

Measured on step 2 (RMT3) of the benchmark, against `/orc-quick` (medians of 3 runs):

- lorc alone: lane time −28 %, cost −38 %, tokens −38 %, same score (84).
- lorc with ORC: lane time −43 %, cost −43 %, tokens −54 %, same score (84).
- Both arms passed the gate on step 2.
- Step 1 (RMT1) did not pass the gate on 0.1.10. See [Benchmark](#benchmark--light-orc-vs-orc-quick).

## Quick start

**Requirements:** Claude Code, Node.js 18 or newer.

```bash
# 1. Install the CLI
# lorc is not on npm yet. Install it from GitHub:
npm i -g github:azure-id/lorc
# When it is on npm:
# npm i -g @azure-id/lorc

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
Tier:    mid — 4 files in 1 area · cap 1 · groups 1
❓ Put the route under /transfers or /payments? (src/router/index.ts:88)
   a) /transfers  b) /payments   ➡️ a — the menu already links /transfers
Executor: 1 haiku · 2 sonnet ➡️ · 3 opus low · 4 opus med
Answer, and I start. Nothing runs until you answer.
Build:   lorc-executor-sonnet-5-med — 4 files, tests passed
Check:   lint ok · typecheck ok · review inline, 1 P3 listed
Changed: 4 files · Verified: unit tests, lint · Findings: 1 P3
```

## How a run works

| Step | What happens | Typical tool calls |
|---|---|---|
| L0 PREP | One `lorc prep "<request>" --json` call. It starts the run and returns the graph focus, rules card, wiki, pattern, extra slots, settings, usage and a tier hint. | 1 |
| L1 DIG | One `lorc graph ctx … --anchors` call, then reads of only the anchored line ranges. At most 1 wiki page. | ≤ 4 |
| L2 TIER | lorc picks the tier and prints `Tier: <t> — <evidence> · cap <n> · groups <g>`. | 0 |
| L3 ASK | One message: the intent lock, every open question with a recommendation, the executor menu, a pattern-miss question. | 0 |
| L4 BUILD | Inline edits (cap 0), or one slice per task and the executors in one message. | 1 per task |
| L5 CHECK + REVIEW | `lorc check --run <slug> --review --json` (or `--lint-only` when the executor tests passed), then the review: inline or the reviewer agent. P0/P1 are fixed, P2/P3 are listed. | 1–3 |
| L6 FINISH | `lorc run end`: graph update, run record, at most one habit proposal. A reply of at most 12 lines. | 1 |

**The hard gate.** lorc never assumes. A fact that the code, the prep output or you did not give is a question in L3.
lorc asks until nothing is assumed. No code is written before your answer.

## Task tiers and subagents

| Tier | Signals | Subagents (auto) |
|---|---|---|
| low | ≤ 2 files, 1 area, no new module | 0 — lorc edits inline |
| mid | 3–5 files, or 1 new component in 1 area | ≤ 1 |
| high | 6–20 files, ≥ 2 new components, or 2–3 independent areas | ≤ 3 |
| complex | > 20 files, > 3 areas, ordered steps, a migration | ≤ 5 + a checkpoint after each wave |

- Work with ≥ 6 files or ≥ 2 new components is split into 2–3 disjoint groups. No file is in two groups. The groups run at the same time.
- `dispatch: auto` (default): lorc starts the executors. `dispatch: manual`: lorc asks first, and the cap is `dispatch_max`.
- `dispatch_max`: the most executors at the same time, `1`–`5` or `off` (no executors). Default `5`.

## Executors

| Agent | Model id | Effort | Use it for |
|---|---|---|---|
| `lorc-executor-haiku-5-high` | `claude-haiku-5-5` | high | mechanical work |
| `lorc-executor-sonnet-5-med` | `claude-sonnet-5-5` | medium | normal feature work |
| `lorc-executor-opus-5-low` | `claude-opus-5-5` | low | cross-module work, tricky state |
| `lorc-executor-opus-5-med` | `claude-opus-5-5` | medium | hard logic, security |
| `lorc-reviewer-opus-5-low` | `claude-opus-5-5` | low | the review of large or risky diffs |

- lorc recommends the cheapest executor that can do the task. It asks you only when it dispatches and `executor` is `ask`.
- An `extra:<slot>` choice shows for each ORC extra slot.
- `executors: all` installs the other models too: `haiku-4-5`, `sonnet-4-6-med`, `sonnet-4-6-high`, `sonnet-5-high`, `opus-4-7-med`, `opus-4-7-high`, `opus-4-8-high`, `opus-5-high`.
- `/lorc-wiki` uses `lorc-wiki-scanner-opus-5-low` and `lorc-wiki-scanner-sonnet-5-high`. `/lorc-pattern` uses `lorc-pattern-codifier-sonnet-5-high`.

## Works with ORC

**The delegate rule.** When ORC 2.2.0 or newer is installed, lorc calls `orc graph`, `orc wiki`, `orc pattern` and `orc extra`.
lorc checks each result. When a call fails, lorc uses its own path.

**Shared files.** lorc and ORC use the same files:

| What | Path |
|---|---|
| Code graph store | `.claude/orc/graph/` |
| Wiki | `wiki/` |
| Code patterns | `.claude/orc/patterns/` |

**The daily graph copy.** `lorc prep` runs `lorc graph sync --if-older 24`. This copies ORC's graph store to `.claude/lorc/copy/` when the copy is older than 24 hours.
lorc reads the copy when ORC's store has a different engine version.

**ORC 2.3.0** shows lorc in `orc ui` (the Light ORC panel) and has the `orc lorc …` commands.

## House rules and anti-slop

- `lorc rules init` writes `HOUSE-RULES.md` in the repo root, with the levels P0, P1, P2 and P3.
- `HOUSE-RULES.md` beats every other rule.
- The rules card holds: your house rules, the P0 rules of the project `CLAUDE.md`, and ORC's code and delivery anti-slop rules. `lorc rules card` writes it to `.claude/lorc/rules-card.md`.
- `lorc rules show` prints the rules. `lorc rules lint [--diff]` checks the code with zero tokens.
- In the review, a broken house rule moves one level: rule P0 → P1, rule P1 → P2, rule P2/P3 → P3.

## Wiki and code pattern

- lorc reads at most 3 wiki page paths from prep, and the build, test and lint commands. L1 reads at most 1 page.
- lorc reads the code pattern file only when the work is in its language.
- `/lorc-wiki` builds the wiki. `/lorc-pattern` builds the code pattern. Both use ORC's file format.
- When no pattern matches and `pattern_miss` is `ask`, lorc asks one yes/no question: learn the pattern first?

## Usage limit and the status line

- `lorc usage` shows the 5-hour, weekly and context usage. Exit code: `0` ok or unknown · `1` limit · `3` weekly.
- At `limit_pct` (default 90 % of the 5-hour window), lorc waits for the reset. `lorc wait` waits with zero tokens.
- At `limit_weekly_pct` (default 98 % of the weekly window), lorc writes a RESUME file and stops.
- `lorc cli bypass` sets the lorc status line. `lorc cli restore` puts back the old one. `lorc cli status` shows which one is active.

The status line shows:

```
ctx <n>% · 5h <n>% · reset <n>m · wk <n>%
```

When ORC is installed and `statusline_writes_orc` is `true`, the status line also writes ORC's usage file.

## Behaviour learning

- lorc records your answers to its questions in `.claude/lorc/behaviour.jsonl`.
- From these records, lorc can make a habit proposal. It uses ORC's rule: at least 5 records, a Wilson lower bound of 0.55, and the last 3 records agree.
- lorc never applies a habit without your yes.
- `lorc habits` lists the proposals. `lorc habits accept <id>` and `lorc habits decline <id>` answer them.
- The `habits` setting: `off`, `observe` (default) or `propose`.

## Settings

Set a value with `lorc settings set <key> <value> [--global]`. Show all with `lorc settings`.
A project value beats a global value.

| Key | Default | Allowed values | What it does |
|---|---|---|---|
| `dispatch` | `auto` | `auto`, `manual` | auto = lorc starts executors; manual = lorc asks first |
| `dispatch_max` | `5` | `off`, `1`–`5` | most executors at the same time |
| `limit_pct` | `90` | integer 50–99 | stop at this used % of the 5-hour window |
| `limit_weekly_pct` | `98` | integer 50–100 | stop at this used % of the weekly window |
| `executor` | `ask` | `ask`, `haiku-5-high`, `sonnet-5-med`, `opus-5-low`, `opus-5-med` (+ the others with `executors: all`) | the executor model |
| `executors` | `core` | `core`, `all` | core = 5 executor choices; all = every model |
| `review` | `auto` | `auto`, `inline`, `agent` | how lorc reviews the change |
| `review_agent_min_lines` | `400` | integer 50–5000 | auto review uses an agent from this many changed lines |
| `pattern_miss` | `ask` | `ask`, `on`, `off` | what to do when no code pattern matches |
| `extra` | `auto` | `auto`, `off` | use ORC extra providers when ORC has them |
| `habits` | `observe` | `off`, `observe`, `propose` | habit capture level |
| `house_rules_warn_kb` | `4` | integer 1–64 | warn when house rules are bigger than this (KB) |
| `review_mute` | `""` | comma list of `a-z` and `-` | finding categories lorc does not list at P2/P3 |
| `statusline_writes_orc` | `true` | `true`, `false` | the status line also writes the ORC usage file |

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
| `lorc graph` | code graph: `where`, `status`, `update`, `ctx`, `map`, `changes`, `sync` |
| `lorc wiki` | `status`, `sync`, `pick "<words>"`, `commands` |
| `lorc pattern` | code pattern `status [<lang>]`, `show <lang>` |
| `lorc rules` | house rules: `init`, `show`, `card`, `lint [--diff]` |
| `lorc extra` | extra executors: `status`, `list`, `dispatch --slot <s> --slice <path>` |
| `lorc prep` | `prep "<request>" [--json] [--no-start]`: the one L0 call of `/lorc` |
| `lorc slice` | `slice --run <slug> --task <n> -`: write an executor slice (JSON on stdin) |
| `lorc check` | `check --run <slug> [--lint-only] [--build] [--full]`: affected tests, lint, typecheck |
| `lorc review` | `review prep --run <slug> [--tier <t>]`: write the review packet |

## Files lorc writes

| Scope | Path | What |
|---|---|---|
| Project | `.claude/lorc/settings.json` | project settings |
| Project | `.claude/lorc/run/<slug>/` | run state, `checkpoint.json`, `RESUME.md` |
| Project | `.claude/lorc/runs.jsonl` | finished runs |
| Project | `.claude/lorc/behaviour.jsonl`, `habits-state.json` | behaviour records and habit answers |
| Project | `.claude/lorc/rules-card.md` | the rules card |
| Project | `.claude/lorc/usage.json` | the status-line usage reading |
| Project | `.claude/lorc/copy/` | the copy of ORC's graph store |
| Project | `.claude/lorc/coverage/` | coverage output of `lorc check` |
| Global | `~/.claude/lorc/settings.json` | global settings |
| Repo root | `HOUSE-RULES.md` | your house rules |

## Benchmark — Light ORC vs /orc-quick

**Method.** Company Vue repo. 3 runs per cell. The table shows medians. The main model is the same in every arm: Opus 5.5 medium. ORC 2.3.0 freeze. Date: 11/12-10-2026.
`/orc-quick` uses its pinned executor, Opus 5.5 low. lorc picks its own executor.
Arms: Q = `/orc-quick`. LS = lorc alone. LO = lorc with ORC installed.
Gate per cell: cost lower AND tokens lower AND lane time lower AND score median not lower than Q AND the critical e2e steps pass in 3 of 3 runs.

Version measured: 0.1.10.

| Step | Arm | Lane s | Cost $ | Tokens | Fresh | Peak ctx main / agent | Turns | Subagents | Score | E2E pass | Δ lane / cost / tokens / score vs Q | Gate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RMT1 | Q | 785 | 3.95 | 5.90M | 302.3k | 108.4k / 143.7k | 3 | 1 | 84 | 3/3 | — | — |
| RMT1 | LS | 864 | 3.38 | 4.15M | 333.0k | 77.6k / 130.1k | 3 | 4 | 80 | 2/3 | +10 % / −14 % / −30 % / −4 | FAIL |
| RMT1 | LO | 740 | 3.60 | 4.79M | 419.4k | 98.6k / 135.3k | 2 | 4 | 76 | 2/3 | −6 % / −9 % / −19 % / −8 | FAIL |
| RMT3 | Q | 962 | 4.09 | 6.65M | 291.8k | 116.6k / 116.4k | 3 | 1 | 84 | 3/3 | — | — |
| RMT3 | LS | 690 | 2.52 | 4.10M | 285.1k | 71.6k / 124.2k | 2 | 2 | 84 | 3/3 | −28 % / −38 % / −38 % / 0 | PASS |
| RMT3 | LO | 546 | 2.34 | 3.04M | 285.9k | 85.2k / 114.2k | 2 | 2 | 84 | 3/3 | −43 % / −43 % / −54 % / 0 | PASS |

**Gate verdicts.** RMT3 LS PASS · RMT3 LO PASS · RMT1 LS FAIL (time, score, e2e) · RMT1 LO FAIL (score, e2e).

RMT1 fails for two reasons. One LS run put the route on a path that the request did not ask for. One LO run used an SCSS variable that does not exist, so the app did not start.

**Earlier versions** (score per run, PASS count):

| Version | Step | LS scores | LO scores |
|---|---|---|---|
| 0.1.8 | RMT1 | 85, 84 (2 PASS of 2) | 82, 82, 83 (3 PASS of 3) |
| 0.1.10 | RMT1 | 80, 58, 83 (2 PASS of 3) | 76, 83, 45 (1 PASS of 3) |
| 0.1.9 | RMT3 | 85, 87, 81 (3 PASS of 3) | 82, 72 (1 PASS of 2) |
| 0.1.10 | RMT3 | 84, 85, 84 (3 PASS of 3) | 85, 84, 77 (2 PASS of 3) |

0.1.8 has the better quality on RMT1. On RMT3, 0.1.9 and 0.1.10 are almost equal.

**About 0.1.11.** 0.1.11 restores the L5 skill text of 0.1.8. That text was clean on step 1 in the earlier runs (5 of 5 PASS). 0.1.11 itself is not re-run yet.

**Grader noise.** A second grade of the same run moved the score by up to 3 points. Gaps of 1–3 points are inside the noise.

The raw data is in the eval kit.

## Development

```bash
npm test               # the node:test suite
npm run verify         # the package integrity check
npm run vendor         # copy the ORC engine files from ../orc (hash pinned)
npm run build:agents   # generate the executor agents from agents-src/executor.template.md
```

- Never edit `vendor/` by hand. Run `npm run vendor`.
- Never edit the generated executor files. Edit `agents-src/executor.template.md`, then run `npm run build:agents`.

## Changelog

### 0.1.11 — 12-10-2026
The skill's L5 fix-round paragraph is back to the 0.1.8 text, which scored clean on step 1 in the eval.

<details><summary>History</summary>

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
