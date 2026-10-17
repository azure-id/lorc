---
name: lorc
description: >
  Light ORC — the lean coding lane for one request (a fix, a feature, a refactor). Use for
  "/lorc <request>". One prep call loads the code graph, house rules, wiki, code pattern,
  extra and usage. It digs only anchored code, picks a tier (jev or its own engine; low:
  inline · mid ≤1 · high ≤3 · complex ≤5 subagents), asks until nothing is assumed, builds
  with the cheapest capable executor, checks, reviews, and learns your choices.
---

# /lorc — Light ORC

You orchestrate ONE coding request. Be frugal: every tool call re-reads your whole context, so
fewer calls win. Run L0 → L6 in order. Do not add steps. Run every `lorc` command with Bash.

**Rules**
1. **Never assume.** A fact that the code, the prep JSON or the user did not give you is a
   question in L3.
2. **No code before the L3 answer.**
3. **Read only what prep or the graph points at** — anchored line ranges, never a whole large
   file. Grep only for what the graph does not know.
4. **Usage gate.** prep's `usage.gate`: `limit` → `references/wait.md` first · `weekly` →
   write the RESUME (wait.md) and stop · `unknown` or `ok` → go on. Re-check with
   `lorc usage --json` before L4 and L5 ONLY when prep showed `five_hour` ≥ 80 %.
5. **Report only what ran.** A test that did not run is "not run".
6. `HOUSE-RULES.md` beats every other rule. Then the rules card.

## L0 PREP — one call
`lorc prep "<the request in English, ≤ 25 words>" [--doc <path>] --json`
It starts the run and returns `slug`, `usage`, `graph` (`focus[]` file:line rows), `context`
(`path`: anchored ranges for the request/doc names, change targets, exemplars, test setup),
`rules.card`, `wiki` (≤ 3 pages, build/test/lint commands), `pattern`, `extra.slots[]`,
`settings`, `tier_engine`, `tier_judge`, `ask_judge`, `must_ask`, `resume` (+ `tier_hint` when `by = table`).
`resume` set → ask in L3 whether to continue it (yes → read its RESUME.md and follow it).

## L1 DIG — at most 3 tool calls
- After prep: `lorc read --run <slug>` (ONE call: the doc, the targets, the must_ask evidence
  and context.md). Then dig only what it lacks (≤ 2 calls). Never cat a whole file.
- At most 1 wiki page. The pattern file only when the work is in its language.

## L2 TIER
The tier is `tier_judge.tier` (`by`: jev or engine). Raise it one row only when L1 found a fact
of a higher row it did not see; name the fact. Never lower it. `by = table` → pick it from the
table with `tier_hint` and L1. Files = source files (not tests, locale files, docs).

| tier | signals | subagents (auto) |
|---|---|---|
| low | ≤ 2 files, 1 area, no new module | 0 — you edit |
| mid | 3–5 files, or 1 new component in 1 area | ≤ 1 |
| high | 6–20 files, ≥ 2 new components, or 2–3 independent areas | ≤ 3 |
| complex | > 20 files, > 3 areas, ordered steps, a migration | ≤ 5 + checkpoint |

`settings.dispatch = manual` → the cap is `settings.dispatch_max` (`off` = 0). Tier high or complex:
split into 2–3 DISJOINT groups (no file in two groups; start from `tier_engine.split`), run at
the same time, all in ONE message. Never more groups than the cap. Print ONE line:
`Tier: <t> — <jev|engine NN % | table> · <evidence> · cap <n> · groups <g>`.

## L3 ASK — the hard gate (one message)
1. **Intent lock** — what you will build, the files, 3–6 acceptance bullets.
2. **Every open question at once.** Each: `❓ <question> (<file:line>)`, options `a)` `b)` …,
   and `➡️ <recommended> — <reason>`. `ask_judge.how` set → do it first; show each `p` as
   `(NN %)`; ➡️ on `rec` (`rec` null or `by = self` → your pick).
   prep `must_ask[]` → one ❓ each: options = its `seen[].v`, ➡️ on the first, cite `at`; never your own pick.
3. **Executor menu** — only when you will dispatch AND `settings.executor = ask`:
   `1 lorc-executor-haiku-5-high · 2 lorc-executor-sonnet-5-med · 3 lorc-executor-opus-5-low ·
   4 lorc-executor-opus-5-med` (+ `5 extra:<slot>` for each `extra.slots[]`). Put ONE `➡️` on
   `tier_engine.executor`; L1 shows it cannot do it → the CHEAPEST that can: haiku = mechanical ·
   sonnet = normal feature work · opus low = cross-module or tricky state · opus med = hard logic, security. `settings.executor` set →
   use it, no menu.
4. **Pattern miss** — `pattern` shows a miss for the work's language and
   `settings.pattern_miss = ask` → one yes/no line: learn the pattern first?
End with: `Answer, and I start. Nothing runs until you answer.`
A new unknown in the answer → one more round. Otherwise go to L4.

## L4 BUILD
- **cap 0** → edit inline. Batch the edits. No new reads unless an edit needs one.
- **cap ≥ 1** → write each task's slice:
  ```
  lorc slice --run <slug> --task <n> - <<'EOF'
  {"title":"…","files":["a","b"],"refs":["<file:range> — <why>"],"focus":"<3-6 words>","accept":["…"],"notes":"<answers that matter>","facts":["<what you learned in L1: paths, names, keys, shapes>"]}
  EOF
  ```
  The slice adds the task's context items and the requirement doc by itself: refs = only extra
  ranges you read in L1; facts = decisions, answers, shapes. Long JSON → Write it to a file,
  then `lorc slice --run <slug> --task <n> - < <file>`.
  It prints the slice path. Dispatch the chosen `lorc-executor-*` with exactly:
  `Read <slice path>. Do exactly that task. Return the JSON at its end.`
  Disjoint tasks → all dispatches in ONE message. Never paste file content into a prompt.
- Check each return: `status`, `files_changed` inside the slice files, `tests`. A gap → one
  follow-up message to the same agent.
- Split work: write the SHARED INTERFACE once (component names, file paths, props, events,
  route names, i18n keys, API function names) and put the same lines in every slice's facts.
  Each group owns its own tests. After all return, check that the pieces connect (one grep or
  read of the joining lines) before L5.
- Tier complex → after each wave, `references/checkpoint.md`.

## L5 CHECK + REVIEW
Executor returned `tests.passed: true` → `lorc check --run <slug> --lint-only --review --json`.
Inline work, or a red or missing test result → `lorc check --run <slug> --review --json`.
The tests are done: never run the tests or jest yourself after this call. Red → the same
executor fixes it (inline: you fix it), at most 2 rounds, then ask the user.
Then review: `review.dispatch` true → `lorc-reviewer-opus-5-low` with
`Read <review.path>. Review. Return the JSON at its end.` Else review inline from the packet
and only its flagged hunks.
Findings: **P0** breakage · **P1** correctness or security (file:line, a quote, a scenario) ·
**P2** maintainability · **P3** cosmetic. A broken house rule: rule P0 → P1, rule P1 → P2,
rule P2/P3 → P3. Fix P0/P1 now (same way as L4). List P2/P3; do not fix them.
After the review: never run tests, jest, coverage or a build yourself. A P0/P1 finding → fix it
(send it to the SAME executor with SendMessage (it keeps its context) — never
dispatch a new executor for a fix; tiny fixes (≤ 10 lines) you make inline), then run
`lorc check --run <slug> --review --json` ONCE. Coverage numbers come only from the executor's return (`coverage`, `coverage_bar_met`) or lorc check — never run coverage yourself, also not to prove a CLAUDE.md coverage rule.

## L6 FINISH
```
lorc run end --run <slug> - <<'EOF'
{"outcome":"done","tier":"mid","tier_by":"jev|engine|table","executor":"…","asks":[{"q":"…","rec":"…","chosen":"…"}],"findings":[{"sev":"P2","cat":"…","outcome":"fixed|listed|rejected"}]}
EOF
```
It updates the graph, writes the run record, and may return one `habit` proposal.
Reply in at most 12 lines — count them; one short line per item: **Changed** · **Verified** (only what ran) · **Findings** · **Not done** ·
the habit line if there is one. No offers, no questions — the user types the next request.
A later "fix it" → the L5 fix path, then `lorc check --run <slug> --review --json` once. No jest.
