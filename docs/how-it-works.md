# How a run works

[← README](../README.md)

| Step | What happens | Typical tool calls |
|---|---|---|
| L0 PREP | One `lorc prep "<request in English>" --json` call. It runs in one process (one model load; graph heal, tier engine and context run in it, with no graph child processes). It starts the run, writes the context pack (`context.path`) and returns the graph focus, rules card, wiki, pattern, extra slots, settings, usage, a tier hint (only when the table decides), the jev tier judge and lorc's tier engine (`tier_engine`). | 1 |
| L1 DIG | Read `context.path` first. Then `lorc read --run <slug>`: the main read plan (doc, targets, `must_ask` evidence, context; ≤ 20 KB). Then at most 3 dig calls (`lorc graph ctx … --anchors`, reads of only the anchored line ranges). At most 1 wiki page. | ≤ 3 |
| L2 TIER | When a key is connected and jev is confident, jev judges the tier. Else lorc's tier engine judges it. Else lorc picks it from the table. lorc prints `Tier: <t> — <jev NN % \| engine NN % \| table> · <evidence> · cap <n> · groups <g>`. | 0 |
| L3 ASK | One message: the intent lock, every open question with a recommendation (one ❓ for each `must_ask` item, with its options), the executor menu, a pattern-miss question. With a key, jev rates each option (%). | 0 |
| L4 BUILD | Inline edits (cap 0), or one slice per task and the executors in one message. The slice carries the context items of the task and the requirement doc. | 1 per task |
| L5 CHECK + REVIEW | `lorc check --run <slug> --review --json` (or `--lint-only` when the executor tests passed), then the review: inline or the reviewer agent. P0/P1 are fixed, P2/P3 are listed. | 1–3 |
| L6 FINISH | `lorc run end`: graph update, run record, at most one habit proposal. A reply of at most 12 lines. | 1 |

**The context pack.** `<run>/context.md` + `context.json` link the names in the request and the doc (identifiers, files, CSS classes incl. nested SCSS BEM, endpoints, quoted UI text, phrases such as "create recipient component") to anchored line ranges. It adds:
- the change targets: route rows + the insertion point, API exports + the append line, feature constants, the i18n block, the entry/CTA;
- the closest exemplars with cards (props, emits, methods, children);
- the test setup to copy, and 1-hop reuse.

Back ends get the same sections (0.5.1): source-file exemplars with symbol ranges, the server route group + an insert hint, and wiring targets (the files that import the module). Big spec files give sections, not the full file.

Back ends also get (0.5.2):
- **Mirror**: the closest existing feature. It lists the files of that feature that the ticket does not name yet (for example its DI container) and its unit tests as the first test exemplars.
- **Reuse** rows for code that already holds the exact text of the ticket, and for the code that uses a named constant.
- Narrow ranges (the main symbol, ≤ 40 lines) instead of whole files. In Go, a reuse row comes only from a file whose symbols an exemplar uses (no rows for a whole package).

The slice and the executor read plan carry the Mirror rows. Front-end packs do not change.

Eval repo (RMT1): changed files 5 of 5 with their regions, 15 of the 20 files that executors read in 0.3.3 runs, precision 0.71, 8 KB.

**Slice sections.** A slice holds the task, the known facts, the context items of the task, the reference code, the requirement doc inline (≤ 8 KB, with "do not open it again") and the commands. Cap: 32 KB. The executor reads only the listed ranges and never opens the requirement file again.

**The read plan.** `lorc slice` writes the task read plan to `<run>/read-<n>.md` (≤ 20 KB, high-precision ranges only). The slice says `Read <path> (ONE Read call, <bytes> B)`. The executor does one Read of that file first. Then it reads only what the file lacks, all in one batched message. The executor creates a file with one Write (never a shell heredoc). It sends all edits of a step in one message. Before it writes tests, it reads the fields of the thrown error and one test of the same layer. For a back-end task, the read plan also holds the definition of an error class that the ticket names (≤ 40 lines), so the tests assert the correct error fields. The read plan shows the schema block of TypeScript types generated from OpenAPI (`components['schemas'][…]` aliases). At the end, the executor runs the lint command once on every file that it changed or created. eslint runs with a cache, so the final check lints again only the changed files. The slice lint line lists every declared task file, also new files and test files. The executor never waits in a loop for a file that another group creates.

**The hard gate.** lorc never assumes. A fact that the code, the prep output or you did not give is a question in L3.
lorc asks until nothing is assumed. No code is written before your answer.

