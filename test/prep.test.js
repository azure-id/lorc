"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { repo } = require("./prep-fixture.js");
const prep = require("../bin/lib/prep.js");

const KEYS = ["usage", "graph", "rules", "wiki", "pattern", "extra", "settings", "tier_hint", "resume", "slug"];

test("prep --json: one object ≤ 4,096 B with every key, run started", () => {
  const e = repo();
  const r = e.lorc(["prep", "add a subtract helper next to add in math", "--json"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout.trim()) <= 4096);
  const o = JSON.parse(r.stdout);
  for (const k of KEYS) assert.ok(k in o, `missing ${k}`);
  assert.strictEqual(typeof o.slug, "string");
  assert.ok(["unknown", "ok", "limit", "weekly"].includes(o.usage.gate));
  assert.strictEqual(o.graph.mode, "own");
  assert.ok(Array.isArray(o.graph.focus));
  assert.ok(o.rules.card && fs.existsSync(o.rules.card));
  const cur = JSON.parse(fs.readFileSync(path.join(e.root, ".claude", "lorc", "run", ".current"), "utf8"));
  assert.strictEqual(cur.slug, o.slug);
  assert.ok(cur.store_dir);
});

test("--no-start → no slug, no .current", () => {
  const e = repo();
  const r = e.lorc(["prep", "add subtract", "--json", "--no-start"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.ok(!("slug" in o));
  assert.ok(!fs.existsSync(path.join(e.root, ".claude", "lorc", "run", ".current")));
});

test("a broken part has error, the rest goes on, exit 0", () => {
  const e = repo();
  // A wiki/ folder that is a FILE breaks the wiki scan.
  e.write("wiki", "not a folder");
  fs.mkdirSync(path.join(e.root, ".claude", "orc"), { recursive: true });
  fs.mkdirSync(path.join(e.root, ".claude", "orc", "wiki-meta.json"));
  const r = e.lorc(["prep", "add subtract", "--json", "--no-start"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.ok(o.wiki.error, JSON.stringify(o.wiki));
  assert.ok(o.graph && o.settings && o.tier_hint);
});

test("trimming: role first, then focus rows, then pages; sets trimmed", () => {
  const row = (i) => ({ sym: "sym" + i, file: `src/area${i}/file${i}.js`, line: i, kind: "function", role: "r".repeat(100) });
  const small = { graph: { focus: [row(1)] }, wiki: { pages: ["wiki/a.md"] } };
  assert.ok(!("trimmed" in prep.fit(JSON.parse(JSON.stringify(small)))));
  const o = { usage: {}, graph: { mode: "own", focus: Array.from({ length: 8 }, (_, i) => row(i)) }, wiki: { pages: ["wiki/a.md"] }, pad: "z".repeat(3000) };
  const out = prep.fit(o);
  assert.strictEqual(out.trimmed, true);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 4096);
  assert.ok(out.graph.focus.every((r) => !("role" in r)));
  assert.strictEqual(out.graph.focus.length, 8, "rows kept: dropping role was enough");
  const o2 = { graph: { focus: Array.from({ length: 8 }, (_, i) => Object.assign(row(i), { file: "f".repeat(400) })) }, wiki: { pages: ["wiki/a.md"] }, pad: "z".repeat(1500) };
  const out2 = prep.fit(o2);
  assert.ok(out2.graph.focus.length < 8 && out2.wiki.pages.length === 1);
  assert.ok(Buffer.byteLength(JSON.stringify(out2)) <= 4096);
});

test("prep on a risky path sets tier_hint.risky_paths", () => {
  const e = repo({ "src/payments/charge.js": "function chargeCard(x) { return x; }\nmodule.exports = { chargeCard };\n" });
  const r = e.lorc(["prep", "change chargeCard payments", "--json", "--no-start"]);
  const o = JSON.parse(r.stdout);
  assert.ok(o.tier_hint.risky_paths.includes("src/payments/charge.js"), JSON.stringify(o.graph));
});

test("keywords drop stop words and short words, ≤ 6", () => {
  assert.deepStrictEqual(prep.keywords("Please add a new export button to the orders page and the invoice list today"), ["export", "button", "orders", "page", "invoice", "list"]);
});
