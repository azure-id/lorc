"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const stats = require("../bin/lib/stats.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lorc-stats-"));

test("sums transcript usage in the run window and prices it", () => {
  const root = tmp();
  const home = tmp();
  const dir = stats.transcriptDir(root, home);
  fs.mkdirSync(path.join(dir, "S1", "subagents"), { recursive: true });
  const line = (ts, model, u) => JSON.stringify({ timestamp: ts, sessionId: "S1", message: { model, usage: u } });
  fs.writeFileSync(path.join(dir, "S1.jsonl"), [
    line("2026-10-11T09:00:00Z", "claude-opus-5-5", { input_tokens: 999, output_tokens: 999 }), // before the run
    line("2026-10-11T09:31:00Z", "claude-opus-5-5", { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000 }),
    "not json",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "S1", "subagents", "a1.jsonl"),
    line("2026-10-11T09:32:00Z", "claude-sonnet-5", { input_tokens: 500, output_tokens: 50 }) + "\n");
  fs.mkdirSync(path.join(root, ".claude", "lorc"), { recursive: true });
  const rows = [
    { slug: "a", tier: "mid", executor: "sonnet-5-med", duration_s: 600, session_id: "S1", started_at: "2026-10-11T09:30:00Z", ended_at: "2026-10-11T09:40:00Z" },
    { slug: "b", session_id: "NOPE", started_at: "2026-10-11T10:00:00Z", ended_at: "2026-10-11T10:10:00Z" },
  ];
  fs.writeFileSync(path.join(root, ".claude", "lorc", "runs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = stats.collect(root, { home });
  const a = out.runs.find((r) => r.slug === "a");
  assert.deepStrictEqual(a.tokens, { input: 1500, output: 150, cache_read: 10000, cache_write: 2000, total: 13650 });
  // opus 5.5: 1000*4 + 100*20 + 10000*0.2 + 2000*5 = 18000; sonnet 5: 500*2 + 50*10 = 1500 → /1e6
  assert.strictEqual(a.cost_usd, 0.0195);
  assert.ok(a.models["claude-sonnet-5"]);
  const b = out.runs.find((r) => r.slug === "b");
  assert.strictEqual(b.tokens, null);
  assert.strictEqual(b.note, "no transcript");
  assert.strictEqual(out.totals.no_transcript, 1);
});
