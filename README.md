# Light ORC (lorc)

**Latest version:** 0.1.11 — 12-10-2026 (in development, not published)

## What it is

lorc is one coding skill for Claude Code: `/lorc`.
It takes these parts from ORC: the code graph, house rules, wiki, code pattern, executors, orc extra, review, and wait on limit.
When ORC is installed, lorc calls ORC.
When ORC is not installed, lorc does the work itself.
lorc has zero dependencies.

Status: in development. The benchmark table below measures 0.1.10: step 2 passed the gate in both arms; step 1 did not (RMT1 LS, RMT1 LO — two broken runs). 0.1.11 restores the skill text of 0.1.8, which was clean on step 1 in the earlier-version runs (5 of 5 PASS). A full re-run on 0.1.11 is not done yet.

## Benchmark — Light ORC vs /orc-quick (company Vue repo)

Setup: 3 runs per cell. The table shows medians. The main model is the same in every arm: Opus 5.5 medium. ORC 2.3.0 freeze. Date: 11/12-10-2026.
lorc picks its own executor. /orc-quick uses its pinned executor, Opus 5.5 low.
Arms: Q = /orc-quick. LS = lorc alone. LO = lorc with ORC installed.
Gate per cell: cost lower AND tokens lower AND lane time lower AND score median not lower than Q AND the critical e2e steps pass in 3 of 3 runs.

| Step | Arm | Lane s | Cost $ | Tokens | Fresh | Peak ctx main / agent | Turns | Subagents | Score | E2E pass | Δ lane / cost / tokens / score vs Q | Gate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RMT1 | Q | 785 | 3.95 | 5.90M | 302.3k | 108.4k / 143.7k | 3 | 1 | 84 | 3/3 | — | — |
| RMT1 | LS | 864 | 3.38 | 4.15M | 333.0k | 77.6k / 130.1k | 3 | 4 | 80 | 2/3 | +10 % / −14 % / −30 % / −4 | FAIL |
| RMT1 | LO | 740 | 3.60 | 4.79M | 419.4k | 98.6k / 135.3k | 2 | 4 | 76 | 2/3 | −6 % / −9 % / −19 % / −8 | FAIL |
| RMT3 | Q | 962 | 4.09 | 6.65M | 291.8k | 116.6k / 116.4k | 3 | 1 | 84 | 3/3 | — | — |
| RMT3 | LS | 690 | 2.52 | 4.10M | 285.1k | 71.6k / 124.2k | 2 | 2 | 84 | 3/3 | −28 % / −38 % / −38 % / 0 | PASS |
| RMT3 | LO | 546 | 2.34 | 3.04M | 285.9k | 85.2k / 114.2k | 2 | 2 | 84 | 3/3 | −43 % / −43 % / −54 % / 0 | PASS |

RMT1 fails for two reasons. One LS run put the route on a path that the request did not ask for. One LO run used an SCSS variable that does not exist, so the app did not start.

Earlier versions (score per run, PASS count):

| Version | Step | LS scores | LO scores |
|---|---|---|---|
| 0.1.8 | RMT1 | 85, 84 (2 PASS of 2) | 82, 82, 83 (3 PASS of 3) |
| 0.1.10 | RMT1 | 80, 58, 83 (2 PASS of 3) | 76, 83, 45 (1 PASS of 3) |
| 0.1.9 | RMT3 | 85, 87, 81 (3 PASS of 3) | 82, 72 (1 PASS of 2) |
| 0.1.10 | RMT3 | 84, 85, 84 (3 PASS of 3) | 85, 84, 77 (2 PASS of 3) |

0.1.8 has the better quality on RMT1. On RMT3, 0.1.9 and 0.1.10 are almost equal.
The grader has noise: a second grade of the same run moved the score by up to 3 points.
The raw data is in the eval kit.

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
