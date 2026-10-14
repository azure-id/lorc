# Changelog

## 0.3.5 — 14-10-2026
Docs only. README: short sections with links to new pages under `docs/` (how-it-works, tiers, executors, orc, features, settings, commands, benchmark); live npm version badge. No fact was removed: the README text moved into the `docs/` pages. No code change.

## 0.3.4 — 14-10-2026
Docs only. README benchmark: step 1 (RMT1) results of lorc 0.3.0–0.3.3 against `/orc-quick` and plain Claude Code (no skill, wiki and bare), as a table and as 4 Mermaid bar charts (cost, tokens, lane time, score). lorc 0.3.3 passes the step-1 gate: 746 s, $2.82, 4.31M tokens, score 86, e2e 3 of 3 (Q: 785 s, $3.95, 5.90M, 84). README install: from npm (`npm i -g @azure-id/lorc`); GitHub is the other way. No code change.

## 0.3.3 — 14-10-2026
Why: eval of 0.3.2 (L1 LS × 3: 721 s, $3.15, 4.34M tokens, 84 points, e2e 2 of 3). In l1-ls-1 (PARTIAL, 58), the lane made up the route path `outwards/transfer` and did not ask. The repo already named `outwards/create` in a router comment (client/src/router/index.js:755) and in a test (`/remittances/outwards/create`, RemittanceLayout.spec.js:126). 0.1.10 l1-ls-2 failed in the same way.
- New `bin/lib/ask-facts.js`: `lorc prep` gives `must_ask[]` (only when it is not empty): `[{ q: "route path of the new page (router <file>)", seen: [{ path, at[] }] }]`. These are facts only, not a decision.
- Trigger: the engine found a router, and the request or the doc adds a page or a route (route words, or an engine `creates` noun such as page, screen, view, step, wizard, modal).
- `seen`: quoted path strings near the feature (stems of the request) that the router does not define yet. lorc ignores imports, URLs, file names, and paths that an API client, a mock or a fixture names. Rank = stems in the path × file weight (router 3, test 2, other code 1, docs 0.5). Max 3 paths, max 3 `at` each.
- `fit()` never removes `must_ask`. Over the byte cap, it cuts each `seen[].at` to 1.
- SKILL.md L3 item 2, new last line: one ❓ for each `must_ask` item, never your own pick; ➡️ on its first `seen` path, cite `at`.

## 0.3.2 — 13-10-2026
Why: eval of 0.3.1 (L1 LS × 3: 813 s, $3.32, 5.63M tokens, 81 points, e2e 3 of 3). In l1-ls-2, the coverage `note` "map covers 14 of ~299 script lines" made the reviewer write "coverage not proven" as a P1. The user said "fix the P1", and the main session did its own coverage runs (v8 provider, a custom transformer): 1069 s, $4.37, 7.37M tokens. In l1-ls-1, the reviewer found a real bug (a zero amount enables Continue) but graded it P2. Thus the user had to ask for the fix in one more turn, and in that turn the main session edited with python and ran jest itself. The executor deleted a failing focus test and did not fix it. The 0.3.0 coverage defect (83.33 % branches) did not occur again in 0.3.1 (0 of 3 runs).
- `lorc cov`: the SFC field `note` is now `tool_limit`, with the text `source map has <lf> of ~<n> script lines; not a gap in the change`. The file line shows `· tool limit: …`.
- Review packet `## Coverage`: the per-file lines do not show the tool limit. When a file has one, one more line follows: `Tool limit — NOT a finding (do not raise it, do not ask for a fix, do not measure again): <file> (<text>); …`.
- Executor contract: never delete, skip or weaken a failing test to get green. Fix the cause, or return `partial` and name the test. A `tool_limit` is a fact, not a miss: never try another coverage provider or transform.
- Reviewer: an acceptance item that the code does not meet is P1 (`met: false` and a finding). A coverage "Tool limit" in the packet is never a finding.
- SKILL.md L6: a new last line. A later "fix it" goes to the L5 fix path, then `lorc check --run <slug> --review --json` one time. No jest.

## 0.3.1 — 13-10-2026
Why: in 3 of 3 eval runs of 0.3.0, the coverage miss cost points. The raw branch number included branches that a transform added, and an old file was judged on all its old code.
- New `lorc cov [--bar <n>] [--json] [--dir <repo>]`: coverage per changed source file from the lcov data in `.claude/lorc/coverage/<dir>`. It does not run the tests. Per file: `lines`, `branches` (raw), `src_branches`, `generated`, `uncovered` (source lines, max 10), `note`, `changed`, `bar_met`. With `--bar`, exit 1 when the bar is not met.
- Source and generated branches: a branch is generated when its line is past the end of the file, an import or export-from statement line (also multi-line), a blank line, a comment-only line, an SFC tag line (`<script>`, `</template>` …), or a line where lcov puts a Babel or TS helper function (`_interopRequireDefault`, `_asyncToGenerator`, `__awaiter` …). All other branches are source branches.
- A file that existed at HEAD is judged on its added lines only (`changed`: lines and source branches). A new file is judged on the whole file. The bar is met when lines ≥ bar and source branches ≥ bar.
- `lorc check` coverage: jest also writes `lcovonly`. lorc check reads the coverage after the tests and also with `--lint-only` (the data that the executor's coverage command wrote). The `coverage` field has `src_branches`.
- The slice `- coverage:` command writes json-summary and lcovonly to lorc's coverage folder, then tells the executor to run `lorc cov --bar <project bar> --json` (not a test run), and to reach the bar on lines and SOURCE branches.
- Executor contract: the return `coverage` entry has `src_branches` and `uncovered`. When the bar is not met: `coverage_bar_met:false` and the `uncovered` lines from `lorc cov`. The executor says "generated/tooling" only when `lorc cov` shows that source branches meet the bar.
- The review packet has a `## Coverage` section (between Lint and Changed symbols): one line per changed source file, or "not measured", or "no changed source files".
- Evidence from the eval sandboxes: `AmountAndMethod.vue` raw branches 83.33 % → source branches 100 %, generated: 2 uncovered at line 236 (import) (l1-ls-3; the same at line 249 in l1-ls-1 and line 251 in l1-ls-2). `remittance.api.js` (an old file that the task extended): whole file 61.11 % lines → changed lines 100 % / 100 %, bar met. A plain `.js` util with real gaps stays a gap (source branches 4.17 %, uncovered lines listed).

## 0.3.0 — 12-10-2026
- New `lorc tier "<request>" [--doc <path>] [--json] [--brief] [--no-history]`: lorc's own deterministic tier engine. `lorc tier eval [--recompute] [--json]` measures the engine and jev against the finished runs.
- `lorc tier` builds or updates the code graph first, as `lorc prep` does. `--no-heal` skips it; prep gives the engine `--no-heal`. `lorc tier eval --recompute` also heals first.
- With no graph, `lorc tier` takes the facts from git: related files from tracked paths (rarity weight, then change count), named symbols and their users from `git grep`. Dashboard repo, step 2 with the doc: no graph went from mid, ~5 files, 41 % to high, ~10 files, 67 % (graph: high, ~10, 74 %). `--json` shows `detail.graph.source`.
- `lorc prep` order: jev (a key, confident) → the engine (`tier_judge.by = "engine"`, with the reason jev did not decide) → the table (only when `tier_engine: off` or the engine fails). jev gets the engine's evidence as words (estimated source files, new components, areas, callers, similar commits, mechanical), never its tier.
- The prep JSON has a compact `tier_engine` (tier, score, conf, cap, groups, est_files, executor, why ≤ 3, split). `prep.json` in the run folder keeps the full answer. `lorc prep` takes `--doc <path>` (a requirement doc).
- Text signals: new-file units (page, component, modal, endpoint, service, model …) against element edits (button, field, column …), named targets (`code`, CamelCase, paths), wiring verbs, layers, risk classes, cues (mechanical, signature, refactor, migration, ordered, state, algorithm); a requirement doc (lines, items, API calls).
- Code-graph signals: core files, named symbols with their callers and the files that import them (blast radius), the feature folder, router and API-client files, a generic component that exists already is reused (not new), locale and test files, layers, project folders.
- Git-history signals (the last 1,500 non-merge commits, cached by HEAD in `.claude/lorc/tier/git.json`): co-change partners (conf ≥ 0.6, support ≥ 3, +3 max), similar past commits (median source files), the wiring ratio (existing files changed per new file, learned; default 2).
- Run-history signals: the final tiers of similar requests (Wilson lower bound ≥ 0.55, in practice 5 of 5 agreeing runs → move one band) and their source-file counts.
- Files are SOURCE files: tests, locale files, docs and lock files do not count. The table rows do not change; the highest row that a signal reaches wins. Guards: a migration or ordered steps with no data-layer evidence → high, not complex; with data-layer evidence, complex only for a DATA migration (backfill, split, merge, rename, drop, convert a format) or a big change, else a small schema migration → high; a mechanical change (rename, signature) with no new file → mid at most (one executor); types (class, struct, interface, trait, enum, protocol) count as half a component.
- Any language: the text, git and run signals do not depend on the language; the graph reads JS, TS, Vue, Python, Go, Java, Kotlin, C#, PHP, Ruby, Rust and C; the path rules (layers, routers, project folders, tests, locale, lock and generated files) cover Django, FastAPI, Go, Spring, Android, ASP.NET, Rails, Laravel, Rust, iOS and Flutter; type names count as their kind (`OrderSerializer` → serializer).
- Confidence 10–95 % from the margin inside the band and the evidence (the graph found core files, the analogs agree, history).
- Split for high and complex: 2–3 disjoint groups by project, then by layer, else by new component (the page and its wiring first).
- Executor: ORC's facet formula on the estimated facets (B + N + L + T + fan + U, risk floor 70) → haiku-5-high < 30 · sonnet-5-med < 65 · opus-5-low < 90 · opus-5-med; the low tier is inline; a cheaper executor with clean runs at the tier wins when its Wilson lower bound is ≥ 0.55 (in practice 5 of 5). SKILL.md L3: ➡️ on `tier_engine.executor` unless L1 shows that it cannot do the work.
- Run record: `files_changed` and `src_files` (files changed during the run; files dirty at the start do not count); `tier_by` = `jev` | `engine` | `table`.
- New setting `tier_engine` (`auto` default | `off`). `lorc doctor` has a `tier-engine` row.
- Measured on the eval sandboxes (dashboard repo, 12 lorc runs, requirement doc given): mean absolute error 0.92 source files (1.58 without the doc). Step 1 → high (same as the model), ~6 files against 5–6 real; step 2 → mid, ~5 against 5–7 real (the model picked high). Small sample.
- Self-calibration: `lorc run end` copies `engine_tier`, `est_files`, `est_raw` (the estimate before calibration) and `jev_tier` (when jev decided) from `prep.json` into the run record. After 5 finished runs with `src_files` and `est_raw`, the engine multiplies its estimate by the median of real ÷ raw over the last 30 runs (clamped 0.5–2; used only when it differs from 1 by 0.1 or more). Evidence: `calibrated ×<f> from <n> runs`. It learns from the raw estimate only. `lorc tier eval` shows the factor (`calibration:`; `calibration` in `--json`).
- Whole PRs: the git history is the units that landed on the main line (`git log --first-parent -m`): a squash or direct commit, or a whole merged PR (all its files). Commits inside a PR branch are not units. A merge's subject is the PR title plus the branch words. Similar past changes, co-change and the wiring ratio use these units. Dashboard repo: 1,003 units (242 merged PRs) instead of 2,921 commits, read in 0.26 s.
- Language: the skill gives the request to prep in English (L0). The parser also reads Indonesian: request verbs (tambah, buat, ubah, perbaiki, hapus …), nouns as their English kind (halaman → page, tombol → button …), plurals such as `halaman-halaman`, cues and risk words (migrasi, pembayaran, kata sandi …). "tambah halaman detail pesanan dengan tombol batal" → 1 new page + 1 element edit → mid (before: nothing found).
- Cleanups: prep puts `tier_hint` in its JSON only when the table decides. `ask_judge` is `false` or `{ how }`: prep writes the exact `lorc jev ask --run <slug>` command with the JSON shape; SKILL.md L3 only says "`ask_judge.how` set → do it first". SKILL.md is 7,996 B of 8,192. The graph store already caches the import edges (11 ms): no change.

- The git part also runs when the graph finds no related file (a language it does not read, such as Swift or Dart); git wins only when it finds some. The parts of a resolved name (`OrderService`) do not rank files by path words (they reached `PaymentService` and set a false risk floor).
## 0.2.0 — 12-10-2026
- `lorc prep` asks TypeSafe jev for the L2 tier when a key is connected; the answer is `tier_judge` in the prep JSON.
- One `POST /v1/systemone` call: the tier Choice two times with the options in opposite order (averaged), plus 4 Noul signals (`new_component`, `migration`, `ordered_steps`, `multi_area`). lorc computes the tier and the confidence in code; a tie goes to the higher tier. lorc sends paths and counts, never file content.
- Confidence gate: below `tier_judge_min_conf` the built-in table decides and prep shows the jev pick as a hint.
- Fallback to the table with a reason: `no key`, `off`, `base URL must use https`, `http <status>`, `timeout` (5 s; one retry on 429/529), `network`, `bad response`, `low confidence`, `judge failed`. No key or `off` = no network call and no extra process. A jev failure never stops a run.
- New `lorc jev` command: `status [--ping] [--json]`, `connect -` (key on stdin; `GET /v1/models` check, `--no-check` skips it), `disconnect`, `tier`.
- New settings: `tier_judge` (`auto` | `off`) and `tier_judge_min_conf` (default 60, integer 0–99).
- `lorc doctor` has a `jev` row. `lorc run end` records `tier_by` (`jev` or `table`). `prep.json` keeps the full jev answer.
- SKILL.md L2: the tier is the jev tier; the main session can raise it one row only for a named L1 fact that jev did not see, and never lowers it. The tier line shows `jev NN %` or `table`.
- Option judge: `lorc jev ask [--run <slug>] -` rates each L3 option. One Noul per option; each Noul sees all the options. The percentages are independent (they do not add up to 100 %). `rec` is the top option only when it is at least 50 % and at least 10 points over the next option, else null. `--run` adds the run's request and appends the answer to `asks-jev.jsonl` in the run folder. Limits: 10 questions, 8 options per call.
- `lorc prep` returns `ask_judge: true` when `ask_judge` is `auto`, a key exists and the base URL is https (or localhost).
- New setting `ask_judge` (`auto` | `off`), separate from `tier_judge`. `lorc jev status` and the doctor `jev` row show it.
- Option judge fallback `{ by: "self", reason }`: `no key`, `off`, `base URL must use https`, `no questions`, `http <status>`, `timeout`, `network`, `bad response`. Then the session recommends alone, with no percentages.
- SKILL.md L3 item 2: with `ask_judge` true, pipe the questions to `lorc jev ask`, show each option as `(NN %)` and put ➡️ on `rec` (`rec` null or `by = self` → the session's own pick).
- Key handling: `TYPESAFE_API_KEY` wins over the saved key; the saved key is in `~/.claude/lorc/jev.json` (user folder only, mode 600 on macOS/Linux); https only (http only to localhost); status never prints the full key.

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
