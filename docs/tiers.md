# Task tiers

[← README](../README.md)

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

## Tier engine (lorc's own)

`lorc tier "<request>" [--doc <path>] [--json] [--brief] [--no-history]` is lorc's own tier engine. It is deterministic: one repo state and one request give one answer. It reads; it never writes code. It gives the tier, a score, the confidence, the cap, the split, the executor and the evidence lines.

**The order in `lorc prep`.** 1. jev, when a key is connected and jev is confident. 2. The engine (`tier_judge.by = "engine"`, with the reason jev did not decide). 3. The table, only when `tier_engine: off` or the engine fails. jev gets the engine's evidence as words (estimated source files, new components, areas, callers, similar commits, mechanical), never the engine's tier. The prep JSON has a compact `tier_engine` (tier, score, conf, cap, groups, est_files, executor, why ≤ 3, split). `prep.json` in the run folder keeps the full answer. `lorc prep` also takes `--doc <path>` (a requirement doc). When the request adds a page or a route and the repo has a router, the prep JSON has `must_ask[]`: `{ q, seen: [{ path, at[] }] }`. The skill asks the user about each item and does not pick the value itself.

**Signals.**
- Request text: new-file units (page, component, modal, endpoint, service, model …) against element edits (button, field, column …), named targets (`code`, CamelCase, paths), wiring verbs, layers, risk classes, and cues (mechanical, signature, refactor, migration, ordered, state, algorithm). A requirement doc adds lines, items and API calls.
- Code graph: core files, named symbols with their callers and the files that import them (blast radius), the feature folder, router and API-client files, locale and test files, layers, project folders. A generic component that exists already is reused, not new.
- Git history (cached by HEAD in `.claude/lorc/tier/git.json`): the units that landed on the main line (`git log --first-parent -m`): a squash or direct commit, or a whole merged PR (all its files). Commits inside a PR branch are not units. A merge's subject is the PR title plus the branch words. Vue 2 SPA eval repo: 1,003 units (242 merged PRs) instead of 2,921 commits, read in 0.26 s. Signals: co-change partners (conf ≥ 0.6, support ≥ 3, at most +3), similar past changes (median source files), and the wiring ratio (existing files changed per new file, learned; default 2).
- lorc's finished runs: the final tiers of similar requests (Wilson lower bound ≥ 0.55, in practice 5 of 5 agreeing runs → move one band) and their source-file counts.

**New signals (0.4.0).**
- A client router is UI wiring, not "api".
- A repo with no UI files: UI nouns count as logic (0.5.1).
- The API module comes from the doc endpoint or a doc file name. It counts as changed only when the endpoint is new.
- Doc names count as changed only after a change verb. The feature folder is where new files go.
- Split groups list real files: the UI group with router, keys and locale; the API group with the module and its spec. Placeholders go into real files.
- Structural analog: the closest existing flow and its 1-hop footprint. It works with no git history.
- Git analogs are IDF-weighted, with a dynamic k (Kocaguneli et al., TSE 2012). A cue prior comes from the history of the repo.
- Confidence comes from the agreement of the signals.

RMT1: high with the correct split (0.3.3: router in the "api" group). RMT3: mid, est 3 (0.3.3: high, est 6). Backtest on 40 Vue 2 SPA commits (`bench-tier`): seed 1 median absolute error 2 → 1, within ±1 file 48 → 53 %, within ×1.5 25 → 33 %; seed 2 level.

**Self-calibration.** `lorc run end` copies the engine's answer from `prep.json` into the run record: `engine_tier`, `est_files`, `est_raw` (the estimate before calibration) and `jev_tier` (when jev decided). After 5 finished runs with a real size (`src_files`) and `est_raw`, the engine multiplies its estimate by the median of real ÷ raw over the last 30 runs (clamped 0.5–2; used only when it differs from 1 by 0.1 or more). The evidence says `calibrated ×<f> from <n> runs`. The engine learns from the raw estimate, never from its own calibrated output. `lorc tier eval` shows the factor (`calibration:` line; `calibration` in `--json`).

**Files and guards.** The engine counts SOURCE files. Tests, locale files, docs and lock files do not count (tests and 2 locale files are 2–4 of every UI change). The table rows do not change. The highest row that a signal reaches wins. A migration or ordered steps with no data-layer evidence → high, not complex. With data-layer evidence, a migration is complex only for a DATA migration (backfill, split, merge, rename, drop, convert a format) or a big change; a small schema migration (add a column, an index) → high. A mechanical change (rename, signature) with no new file → mid at most (one executor). A negated migration ("No DB migration") is not a migration cue (0.5.2). A back-end ticket that names files sets a minimum size: the new files + the named wiring and worker files (0.5.2). A background worker is an area. Types (class, struct, interface, trait, enum, protocol) often share one file: two count as one new component.

**Languages.** The text, git-history and run-history signals do not depend on the language. The code graph reads JS, TS, Vue, Python, Go, Java, Kotlin, C#, PHP, Ruby, Rust and C. The path rules (layers, routers, project folders, tests, locale files, lock and generated files) cover Django, FastAPI, Go, Spring, Android, ASP.NET, Rails, Laravel, Rust, iOS and Flutter layouts. Type names count as their kind (`OrderSerializer` → serializer, `PaymentService` → service). Swift and Dart have no graph: the engine uses the text and the history only. The skill gives the request to prep in English (L0). The parser also reads Indonesian: request verbs (tambah, buat, ubah, ganti, perbaiki, hapus, hubungkan …), nouns as their English kind (halaman → page, komponen → component, tombol → button …), plurals such as `halaman-halaman`, and cues and risk words (migrasi, pembayaran, kata sandi …). Example: "tambah halaman detail pesanan dengan tombol batal" → 1 new page + 1 element edit → mid (before: nothing found). The measured numbers below come from one Vue repo.

**Graph or git.** `lorc tier "<request>"` builds the code graph when there is none, else updates the changed files: the same step `lorc prep` runs. `--no-heal` skips it. prep gives the engine `--no-heal` because prep did this step already. `lorc tier eval --recompute` also heals first. With no graph (`--no-heal` or a failed build), or a graph that finds no related file (a language it does not read, such as Swift or Dart), the engine takes the same facts from git. The parts of a resolved name (`OrderService` → order, service) find files by the name only, not by path words. Related files are tracked source files whose path holds a request word that few paths use (the same rarity weight as the graph's focus words), ranked by that weight, then by how often git changed them. For a named symbol, `git grep` finds its definition and the files that use the name (blast radius). The feature folder, wiring files, router, co-change and the other signals then work as with the graph. Related files from paths add less confidence (+8 points; the graph adds +15). The evidence says `no graph (<reason>): related files from git paths`; `--json` shows `detail.graph.source` (`graph` or `git`). Not a git repo and no graph: text and run history only, `no graph: <reason>`. Measured on the Vue 2 SPA eval repo (step 2, with the doc): graph → high, ~10 files, 74 %; no graph before → mid, ~5, 41 %; git part → high, ~10, 67 %, in about 0.3 s against 1 s.

**Confidence** is 10–95 %. It comes from the margin inside the band and the evidence (the graph found core files, the analogs agree, history).

**Split.** For high and complex: 2–3 disjoint groups by project, then by layer, else by new component (the page and its wiring first). A back-end split groups the work by layer (api / logic / data / worker). Wiring files join a real group (0.5.2).

**Executor.** ORC's facet formula on the estimated facets (B + N + L + T + fan + U, risk floor 70): haiku-5-high < 30 · sonnet-5-med < 65 · opus-5-low < 90 · else opus-5-med. The low tier is inline. A cheaper executor with clean runs at the tier wins when its Wilson lower bound is ≥ 0.55 (in practice 5 of 5 clean runs). In L3, ➡️ is on `tier_engine.executor`, unless L1 shows that it cannot do the work. The risk floor counts only the risky files that the work changes. A risky file that the work only reads (for example an existing migration file) does not count. High or complex work never goes to haiku: sonnet is the minimum, unless the change is mechanical (0.5.2).

**History and eval.** `lorc run end` records `files_changed` and `src_files` (files changed during the run; files dirty at the start do not count) and `tier_by` (`jev`, `engine` or `table`). `lorc tier eval [--recompute] [--json]` measures the engine and jev against the finished runs.

**Measured.** On the eval sandboxes (Vue 2 SPA eval repo, 12 lorc runs, the requirement doc given): estimated against real source files, the mean absolute error is 0.92 files. Without the doc it is 1.58. Step 1 (route shell + step) → high, the same as the model's pick, ~6 files against 5–6 real. Step 2 (one new step in the existing wizard) → mid, ~5 against 5–7 real (the model picked high). The sample is small: run `lorc tier eval` on your own repo.

Example of the output (the evidence lines change per request):

```
$ lorc tier "add the transfer page with a confirm step" --doc docs/transfer.md
Tier: high — engine 74 % · score 58 · cap 3 · groups 2 · executor sonnet-5-med
  <evidence line>
  <evidence line>
  G1 ui: <units>
  G2 <layer>: <units>
  executor formula <facets>
```

**Why.**
- SWE-bench / Multi-SWE-bench: no predictor finds the size before the solve from the issue text alone.
- ROSE (Zimmermann et al. 2004): co-change predicts more files.
- Story-point replications: median and analogy baselines are strong; the requirement length helps.
- LLM routers: rules first, then check them on your own data.

## Tier judge (TypeSafe jev)

TypeSafe jev is a "System One" model (https://docs.typesafe.ai). It does not write text. It returns typed decisions (Choice, Score, Noul) with calibrated probabilities and a confidence value. lorc uses jev as the L2 tier judge. When a key is connected, `lorc prep` asks jev for the tier. The answer is in the prep JSON as `tier_judge`.

**Connect.** Get a key at https://console.typesafe.ai/keys. Then do one of these:

```bash
# 1. Set the key in the environment (or in the "env" block of ~/.claude/settings.json)
export TYPESAFE_API_KEY=<your key>
# 2. Save the key. The key comes on stdin, so it is not in the shell history.
lorc jev connect - < key.txt
```

- `lorc jev connect` checks the key with `GET /v1/models` first. `--no-check` skips the check. The key goes to `~/.claude/lorc/jev.json` in your user folder, never into the project (file mode 600 on macOS/Linux).
- The env key wins over the saved key. `lorc jev status [--ping] [--json]` shows the state. It shows only `…` and the last 4 characters of the key. `lorc jev disconnect` removes the saved key.
- Optional env: `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`) and `TYPESAFE_DEFAULT_MODEL` (default `jev-latest`). Pin a version such as `jev-1.13.0` to keep the answers stable.

**What lorc sends.** One `POST /v1/systemone` per run: the request text (≤ 600 characters), at most 8 focus file paths, the file and area counts as words, the risky paths, and "new files likely" yes/no. lorc never sends file content. The key goes only in the `Authorization: Bearer` header and only over https. Plain http is for localhost only (tests). lorc refuses all other base URLs.

**The questions.** One call asks the tier Choice (low, mid, high, complex) two times, with the options in opposite order. jev leans to the first option, so lorc averages the two answers. The call also asks 4 yes/no signals: `new_component`, `migration`, `ordered_steps`, `multi_area`. lorc computes the tier and the confidence in code. A tie goes to the higher tier.

**Confidence gate.** Below `tier_judge_min_conf` (default 60), the built-in table decides. prep shows the jev pick as a hint, for example `tier judge: table (low confidence; jev mid 42 %)`.

**Fallback.** Then lorc's tier engine decides (`tier_judge.by` is `engine`, with the reason). Only when `tier_engine` is `off` or the engine fails, `tier_judge.by` is `table`, and the skill picks the tier from the table with `tier_hint`. prep puts `tier_hint` in its JSON only in this case. A jev failure never stops a run.

| Reason | What happens |
|---|---|
| `no key`, `off` | the table decides; no network call and no extra process |
| `base URL must use https` | no call; the table decides |
| `http <status>`, `timeout` (5 s; one retry on 429/529), `network`, `bad response`, `judge failed` | the table decides |
| `low confidence` | the table decides; prep shows the jev pick as a hint |

**Raise one row.** With `by = jev`, the tier is the jev tier. The main session can raise it one row only when L1 found a fact of a higher row that jev did not see. It names the fact. It never lowers the tier. `lorc run end` records `tier_by` (`jev` or `table`). `prep.json` in the run folder keeps the full jev answer.

**Cost.** TypeSafe lists $0.042 per million input tokens and free output tokens (12-10-2026). One call uses a few thousand input tokens at most, so a run costs less than $0.001.

## Option judge (L3 questions)

With a key connected (the same key as the tier judge), jev also rates the options of each L3 question. Example: `a) /transfers (90 %)  b) /payments (30 %)   ➡️ a — the menu already links /transfers`.

**The flow.** prep returns `ask_judge: false` or `ask_judge: { how }`. It returns `how` when the `ask_judge` setting is `auto`, a key exists and the base URL is https (or localhost). `how` is the exact `lorc jev ask --run <slug> --json -` command with the JSON shape. SKILL.md L3 only says: `ask_judge.how` set → do it first. The skill pipes its questions to the command (JSON on stdin) before the L3 message:

```json
{"intent":"…","questions":[{"id":"q1","q":"…","facts":"<file:line — fact>","options":{"a":"…","b":"…"}}]}
```

`--run` adds the run's request and appends the answer to `asks-jev.jsonl` in the run folder.

**The questions.** jev gets one yes/no question (Noul) per option: "is this option the right answer for the request?". Each Noul sees the question, the facts and all the options, so it rates the option against the others. Each percentage is independent: the percentages do not add up to 100 %.

**The recommendation.** `rec` is the top option only when it is at least 50 % and at least 10 points over the next option. Else `rec` is null: jev is not sure, and the main session puts ➡️ on its own pick. The session shows the percentages in both cases.

**Limits.** At most 10 questions and 8 options per call. Option keys are 1–8 letters or digits. lorc cuts the question text at 400, the facts at 600 and each option at 300 characters.

**Fallback.** The answer is `{ by: "self", reason }` for `no key`, `off`, `base URL must use https`, `no questions`, `http <status>`, `timeout`, `network` or `bad response`. Then the session recommends alone, the same as before 0.2.0, with no percentages.

**Cost.** One more jev call per L3 round, the same price as the tier call (less than $0.001).

