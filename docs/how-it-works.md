# How a run works

[← README](../README.md)

| Step | What happens | Typical tool calls |
|---|---|---|
| L0 PREP | One `lorc prep "<request in English>" --json` call. It starts the run and returns the graph focus, rules card, wiki, pattern, extra slots, settings, usage, a tier hint (only when the table decides), the jev tier judge and lorc's tier engine (`tier_engine`). | 1 |
| L1 DIG | One `lorc graph ctx … --anchors` call, then reads of only the anchored line ranges. At most 1 wiki page. | ≤ 4 |
| L2 TIER | When a key is connected and jev is confident, jev judges the tier. Else lorc's tier engine judges it. Else lorc picks it from the table. lorc prints `Tier: <t> — <jev NN % \| engine NN % \| table> · <evidence> · cap <n> · groups <g>`. | 0 |
| L3 ASK | One message: the intent lock, every open question with a recommendation, the executor menu, a pattern-miss question. With a key, jev rates each option (%). | 0 |
| L4 BUILD | Inline edits (cap 0), or one slice per task and the executors in one message. | 1 per task |
| L5 CHECK + REVIEW | `lorc check --run <slug> --review --json` (or `--lint-only` when the executor tests passed), then the review: inline or the reviewer agent. P0/P1 are fixed, P2/P3 are listed. | 1–3 |
| L6 FINISH | `lorc run end`: graph update, run record, at most one habit proposal. A reply of at most 12 lines. | 1 |

**The hard gate.** lorc never assumes. A fact that the code, the prep output or you did not give is a question in L3.
lorc asks until nothing is assumed. No code is written before your answer.

