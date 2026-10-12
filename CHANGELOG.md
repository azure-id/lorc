# Changelog

## 0.1.11 — 12-10-2026
- Revert the skill's L5 fix-round paragraph to the 0.1.8 text (eval: 0.1.8 was clean on step 1 — 5/5 PASS, e2e all pass; the 0.1.9/0.1.10 wording gave broken step-1 runs). Everything else stays.

## 0.1.10 — 12-10-2026
- Skill L5: with no SendMessage tool, a P0/P1 fix larger than 10 lines goes to ONE new executor with the slice and the finding; a P0/P1 is never left open (eval: listing it under Not done gave a PARTIAL verdict).

## 0.1.9 — 12-10-2026
- Skill L5: after `lorc check` the main session never runs tests, coverage, builds or diagnostic scripts; with no SendMessage tool a P0/P1 fix is inline only when ≤ 10 lines, else it is listed under Not done (eval: the fallback cost P2 marks).

## 0.1.8 — 12-10-2026
- `lorc check` writes coverage under the repo root `.claude/lorc/coverage/<project-dir>/`, never inside a sub-project folder (0.1.6 wrote `client/.claude/lorc/coverage`).
- Skill: coverage numbers come from the executor return or `lorc check`; the main session never runs coverage itself.

## 0.1.7 — 11-10-2026
- Executor rule: edit only with the Edit and Write tools, never with a scripted string replace; re-read an edited style block and check its variables (eval l3-lo-2: a scripted replace broke a SCSS line and the app did not boot).

## 0.1.6 — 12-10-2026
- K1: `lorc check` and the slice `## Commands` find the PROJECT DIR of each file (the nearest folder up to the repo root with `package.json`, `pytest.ini` or `pyproject.toml`). Runner, lint, typecheck and coverage use that folder. Commands run there with paths relative to it. A JSON step gets `"dir"`; a slice line starts with `cd <dir> && ` when the dir is not `.`.
- K2: SKILL.md L1: start with ONE `lorc graph ctx <sym1> <sym2> … --anchors --json`, then read only the anchored ranges.
- K3: SKILL.md L6: reply in at most 12 lines — count them; one short line per item.

## 0.1.5 — 11-10-2026
- P1: the rules card gets `## Project P0 rules (CLAUDE.md)` after the house rules: each CLAUDE.md heading that starts with `P0` (first 2 non-empty lines) and the bullets of a `# P0` section. Cap 1,800 B, whole items, `(+N more in CLAUDE.md)`. Not in the 2,560 B core budget.
- P2: when the project turns coverage on, the slice `## Commands` gets a `- coverage:` line for the task files. The executor return gets `"coverage"` per file.
- P3: SKILL.md L5: a fix goes to the SAME executor with SendMessage, never to a new executor; fixes of 10 lines or less are made inline. The executor `self_check` gets `"coverage_bar_met"`.

## 0.1.4 — 11-10-2026
- S1: `lorc slice` inlines each ref with a line range as verbatim code in a `## Reference code` section (≤ 16,384 B). The slice cap is now 24,576 B. Trim order: anchors, conventions, wiki, facts, then reference code (whole blocks, last first; a dropped block is listed as `(not inlined)`).
- S2: SKILL.md L2: work with ≥ 6 files or ≥ 2 new components is tier high and is split into 2–3 disjoint groups, dispatched in one message. L4: one shared interface in every slice's facts, and a join check before L5.
- S3: executor rule: plan every edit, then write each file in one Write.

## 0.1.3 — 11-10-2026
- H1: the reviewer is read-only (`tools: Read, Grep, Glob`). It never runs tests, builds or coverage.
- H2: SKILL.md L5: after the review, the main session never runs tests, jest, coverage or a build. A P0/P1 fix is followed by one `lorc check --run <slug> --review --json`.
- H3: the PostToolUse `changes` card is removed from the hook. `lorc update` removes an old lorc PostToolUse entry from settings.json.
- H4: when the project turns on jest coverage, `lorc check` runs the affected tests with coverage for the changed source files and prints `coverage: {file: {lines, branches}}` (≤ 600 B).

## 0.1.2 — 11-10-2026
- G1: `lorc slice` accepts `facts` (≤ 40 lines, ≤ 3,000 B) and writes a "Known facts" section after `## Task`. The facts are trimmed last, after anchors, conventions and wiki. The executor does not re-read files to learn a known fact. SKILL.md L4 tells the main session to put every L1 fact in `facts`.
- G2: `lorc check --review` writes the review packet in the same call (with the lint result inside) and prints `review: { path, bytes, dispatch, reason }`. With `--lint-only`, `tests` is `trusted: executor reported green`. SKILL.md merges L5 and L6 into `L5 CHECK + REVIEW`; FINISH is now L6. `lorc review prep` does not change.

## 0.1.1 — 11-10-2026
- F1: `lorc usage` exits 0 on `unknown` (exit codes: 0 ok or unknown · 1 limit · 3 weekly). The JSON `state` still says `unknown`.
- F2: `lorc slice` accepts `refs` (≤ 6, `path[:start-end][ — why]`) and writes a "Model on these" section after `## Files`. A ref that does not exist is dropped and named in `refs_dropped`.
- F3: executor rules: read the refs and anchors first, batch reads, at most 3 test runs in total, fix every cause before a re-run.
- F4: `lorc check --lint-only`. The command always prints one JSON object (`no changed files`, or `{"error"}` with exit 2). Fix: the output trim threw on a skipped step, so nothing went to stdout.
- F5: SKILL.md usage gate: re-check usage before L4 and L6 only when prep showed `five_hour` ≥ 80 %.
- F6: SKILL.md L4 slice example has `refs`, and a tip to pipe a long JSON from a file.

## 0.1.0 — 11-10-2026
- Repo skeleton.
- CLI router with `help` and `version`.
- `paths` helpers with ORC detection (`MIN_ORC_DELEGATE` 2.2.0).
- Vendor script with hash pins.
- First vendor copy: graph engine, pricing, rule packs.
