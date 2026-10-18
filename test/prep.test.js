"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { repo } = require("./prep-fixture.js");
const prep = require("../bin/lib/prep.js");

const KEYS = ["usage", "graph", "rules", "wiki", "pattern", "extra", "settings", "resume", "slug", "tier_judge", "ask_judge", "tier_engine"];

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
  for (const k of ["tier", "score", "conf", "cap", "groups", "est_files", "executor", "why"]) assert.ok(k in o.tier_engine, `tier_engine.${k}`);
  const pj = JSON.parse(fs.readFileSync(path.join(o.run_dir, "prep.json"), "utf8"));
  assert.ok(pj.tier_engine && pj.tier_engine.detail);
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
  assert.ok(o.graph && o.settings && o.tier_judge);
});

test("tier_hint: only on the table path", () => {
  const e = repo();
  const on = JSON.parse(e.lorc(["prep", "add subtract", "--json", "--no-start"]).stdout);
  assert.ok(!("tier_hint" in on), JSON.stringify(on.tier_judge));
  e.write(".claude/lorc/settings.json", JSON.stringify({ tier_engine: "off" }));
  const off = JSON.parse(e.lorc(["prep", "add subtract", "--json", "--no-start"]).stdout);
  assert.strictEqual(off.tier_judge.by, "table");
  assert.ok(off.tier_hint && Array.isArray(off.tier_hint.risky_paths), JSON.stringify(off));
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
  e.lorc(["graph", "update"]); // W33: prep builds no graph; the user does.
  const on = JSON.parse(e.lorc(["prep", "change chargeCard payments", "--json", "--no-start"]).stdout);
  assert.ok(on.tier_engine.why.some((w) => /risk: money.*src\/payments\/charge\.js/.test(w)), JSON.stringify(on.tier_engine));
  e.write(".claude/lorc/settings.json", JSON.stringify({ tier_engine: "off" }));
  const r = e.lorc(["prep", "change chargeCard payments", "--json", "--no-start"]);
  const o = JSON.parse(r.stdout);
  assert.ok(o.tier_hint.risky_paths.includes("src/payments/charge.js"), JSON.stringify(o.graph));
});

test("W20b: context in the JSON — path with a run, no path with --no-start", () => {
  const e = repo();
  const o = JSON.parse(e.lorc(["prep", "add a subtract helper next to add in math", "--json"]).stdout);
  assert.ok(o.context && typeof o.context.items === "number" && typeof o.context.bytes === "number", JSON.stringify(o.context));
  assert.ok(o.context.path && fs.existsSync(o.context.path) && fs.existsSync(path.join(o.run_dir, "context.json")));
  const run = JSON.parse(fs.readFileSync(path.join(o.run_dir, "run.json"), "utf8"));
  assert.ok("doc" in run);
  const n = JSON.parse(e.lorc(["prep", "add subtract", "--json", "--no-start"]).stdout);
  assert.ok(n.context && !("path" in n.context) && typeof n.context.items === "number", JSON.stringify(n.context));
});

test("W20b: heal runs in process through graph-router.heal (no child)", () => {
  const e = repo();
  const R = require("../bin/lib/graph-router.js");
  const old = R.heal;
  let calls = 0;
  R.heal = (root) => { calls++; assert.strictEqual(root, e.root); return { state: "fresh" }; };
  try {
    const o = prep.prep(e.root, "add subtract", { start: false });
    assert.strictEqual(calls, 1);
    assert.strictEqual(o.graph.state, "fresh");
  } finally { R.heal = old; }
  assert.ok(!/lorcJson\(root, \["graph", "(status|sync)"/.test(fs.readFileSync(require.resolve("../bin/lib/prep.js"), "utf8")));
});

test("W20b: fit keeps must_ask and context.path; seen.at cut to 1", () => {
  const big = "q".repeat(1200);
  const o = {
    graph: { focus: [] }, wiki: { pages: [] }, pad: "z".repeat(2800),
    must_ask: [{ kind: "route_path", seen: [{ v: "/a", at: ["x.js:1", "y.js:2", "z.js:3"] }] }],
    context: { path: "/run/context.md", items: 12, bytes: 4000, note: big },
  };
  const out = prep.fit(o);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 4096);
  assert.strictEqual(out.must_ask.length, 1);
  assert.deepStrictEqual(out.must_ask[0].seen[0].at, ["x.js:1"]);
  assert.deepStrictEqual(out.context, { path: "/run/context.md" });
});

test("mapWords: every content word, verbs dropped, ≤ 12", () => {
  const w = prep.mapWords("Build outward remittance create-transaction route shell with 4-step stepper and step 1 Amount & Method; wire Transfer Fund button");
  assert.ok(!w.includes("build") && !w.includes("create") && !w.includes("wire"));
  assert.ok(w.includes("remittance") && w.includes("button") && w.length <= 12, w.join(","));
  assert.deepStrictEqual(prep.packRows({ targets: [{ what: "w".repeat(50), file: "a.js", start: 3 }], exemplars: [{ what: "e", file: "b.js", start: 1 }] }),
    [{ sym: "w".repeat(40), file: "a.js", line: 3 }, { sym: "e", file: "b.js", line: 1 }]);
});

test("keywords drop stop words and short words, ≤ 6", () => {
  assert.deepStrictEqual(prep.keywords("Please add a new export button to the orders page and the invoice list today"), ["export", "button", "orders", "page", "invoice", "list"]);
});

const P = { low: 0.05, mid: 0.05, high: 0.85, complex: 0.05 };
const JEV = { model: "jev-1.13.0", answers: { tier: { choice: "high", probabilities: P }, tier_rev: { choice: "high", probabilities: P } }, usage: { input_tokens: 500 } };
function mock() {
  return new Promise((ok) => {
    const s = http.createServer((req, rs) => { let b = ""; req.on("data", (x) => { b += x; }); req.on("end", () => { s.bodies.push(b); rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify(JEV)); }); });
    s.bodies = [];
    s.listen(0, "127.0.0.1", () => ok(s));
  });
}
const KEY = "k-1234567890ab";

test("ask_judge: no key → false; text line says off", () => {
  const e = repo();
  assert.strictEqual(JSON.parse(e.lorc(["prep", "add subtract", "--json", "--no-start"]).stdout).ask_judge, false);
  const r = e.lorc(["prep", "add subtract", "--no-start"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("ask judge off"), r.stdout);
});

test("ask_judge: key + local base → how; off setting or http base → false", async () => {
  const e = repo();
  const s = await mock(); const port = s.address().port; await new Promise((r) => s.close(r));
  const env = { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` };
  const get = (en) => JSON.parse(e.lorc(["prep", "add subtract", "--json", "--no-start"], undefined, en).stdout).ask_judge;
  const a = get(env);
  assert.strictEqual(typeof a.how, "string", JSON.stringify(a));
  assert.ok(a.how.includes("lorc jev ask --run ") && a.how.includes("<slug>"), a.how);
  const started = JSON.parse(e.lorc(["prep", "add subtract", "--json"], undefined, env).stdout);
  assert.ok(started.ask_judge.how.includes("lorc jev ask --run " + started.slug), started.ask_judge.how);
  assert.strictEqual(get({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: "http://example.com" }), false);
  e.write(".claude/lorc/settings.json", JSON.stringify({ ask_judge: "off" }));
  assert.strictEqual(get(env), false);
});

test("tier_judge: no key → engine; engine off → table", () => {
  const e = repo();
  const o = JSON.parse(e.lorc(["prep", "add subtract", "--json", "--no-start"]).stdout);
  assert.strictEqual(o.tier_judge.by, "engine", JSON.stringify(o.tier_judge));
  assert.strictEqual(o.tier_judge.reason, "no key");
  assert.strictEqual(o.tier_judge.tier, o.tier_engine.tier);
  e.write(".claude/lorc/settings.json", JSON.stringify({ tier_engine: "off" }));
  const o2 = JSON.parse(e.lorc(["prep", "add subtract", "--json", "--no-start"]).stdout);
  assert.deepStrictEqual(o2.tier_judge, { by: "table", reason: "no key" });
  assert.ok(!("tier_engine" in o2));
});

test("tier_judge: off wins over a key", async () => {
  const e = repo();
  e.write(".claude/lorc/settings.json", JSON.stringify({ tier_judge: "off" }));
  const s = await mock(); const port = s.address().port; await new Promise((r) => s.close(r));
  const r = e.lorc(["prep", "add subtract", "--json", "--no-start"], undefined, { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` });
  const j = JSON.parse(r.stdout).tier_judge;
  assert.strictEqual(j.by, "engine", JSON.stringify(j));
  assert.strictEqual(j.reason, "off");
  e.write(".claude/lorc/settings.json", JSON.stringify({ tier_judge: "off", tier_engine: "off" }));
  const r2 = e.lorc(["prep", "add subtract", "--json", "--no-start"], undefined, { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` });
  assert.deepStrictEqual(JSON.parse(r2.stdout).tier_judge, { by: "table", reason: "off" });
});

test("tier_judge: jev via a mock server; full answer in prep.json", async () => {
  const e = repo();
  const s = await mock();
  try {
    const r = await e.lorcAsync(["prep", "add subtract", "--json"], { env: { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: `http://127.0.0.1:${s.address().port}` } });
    assert.strictEqual(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.strictEqual(o.tier_judge.by, "jev", JSON.stringify(o.tier_judge));
    assert.strictEqual(o.tier_judge.tier, "high");
    assert.strictEqual(o.tier_judge.engine, o.tier_engine.tier);
    assert.ok(!("p" in o.tier_judge));
    assert.ok(s.bodies.length >= 1);
    for (const b of s.bodies) {
      const est = JSON.parse(b).state.estimate;
      assert.ok(est && est.source_files_to_change, b.slice(0, 300));
      assert.ok(!("tier" in est));
    }
    const pj = JSON.parse(fs.readFileSync(path.join(o.run_dir, "prep.json"), "utf8"));
    assert.ok(pj.tier_judge.p);
  } finally { s.close(); }
});

test("tier_judge: closed port → engine, exit 0", async () => {
  const e = repo();
  const s = await mock(); const port = s.address().port; await new Promise((r) => s.close(r));
  const r = await e.lorcAsync(["prep", "add subtract", "--json", "--no-start"], { env: { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` } });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout).tier_judge;
  assert.strictEqual(j.by, "engine", JSON.stringify(j));
  assert.ok(["network", "timeout"].includes(j.reason), j.reason);
});

test("text mode shows the tier judge line", () => {
  const e = repo();
  const r = e.lorc(["prep", "add subtract", "--no-start"]);
  for (const t of ["tier engine: ", "tier judge: engine", "(jev: no key)"]) assert.ok(r.stdout.includes(t), r.stdout);
});

test("--doc: the doc is not part of the request", () => {
  const e = repo();
  e.write("req.md", Array.from({ length: 90 }, (_, i) => `line ${i} of the requirement`).join("\n") + "\n");
  const r = e.lorc(["prep", "build the step", "--doc", "req.md", "--json", "--no-start"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.ok(o.tier_engine && o.tier_engine.tier, JSON.stringify(o.tier_engine));
  // The request a run records: the words only, not the doc path.
  const r2 = e.lorc(["prep", "build the step", "--doc", "req.md", "--json"]);
  assert.strictEqual(r2.status, 0, r2.stderr);
  const run = JSON.parse(fs.readFileSync(path.join(JSON.parse(r2.stdout).run_dir, "run.json"), "utf8"));
  assert.strictEqual(run.request, "build the step");
});

test("decideTier: jev, then engine, then table", () => {
  assert.deepStrictEqual(prep.decideTier({ by: "jev", tier: "high", conf: 0.8 }, { tier: "mid", conf: 0.6 }), { by: "jev", tier: "high", conf: 0.8, engine: "mid" });
  assert.deepStrictEqual(prep.decideTier({ by: "table", reason: "no key" }, { tier: "mid", conf: 0.6 }), { by: "engine", tier: "mid", conf: 0.6, reason: "no key" });
  assert.deepStrictEqual(prep.decideTier({ error: "x" }, null), { by: "table", reason: "judge failed" });
});

test("judgeOut drops p, ms, tokens", () => {
  const o = prep.judgeOut({ by: "jev", tier: "mid", conf: 0.8, p: {}, ms: 3, tokens: 9, signals: {}, model: "m" });
  for (const k of ["p", "ms", "tokens"]) assert.ok(!(k in o), k);
  assert.strictEqual(o.tier, "mid");
});
test("0.3.3: fit keeps must_ask and cuts seen[].at to 1 over the cap", () => {
  const seen = [{ path: "/a/b", at: ["x.js:1", "y.js:2", "z.js:3"] }];
  const o = { must_ask: [{ q: "route path of the new page (router r.js)", seen }], pad: "z".repeat(5000) };
  const out = prep.fit(o);
  assert.ok(Array.isArray(out.must_ask) && out.must_ask.length === 1);
  assert.deepStrictEqual(out.must_ask[0].seen[0].at, ["x.js:1"]);
  const small = prep.fit({ must_ask: [{ q: "q", seen: [{ path: "/a/b", at: ["x.js:1", "y.js:2"] }] }] });
  assert.strictEqual(small.must_ask[0].seen[0].at.length, 2);
});

test("0.3.3: no router in the fixture -> no must_ask key", () => {
  const e = repo();
  const out = JSON.parse(e.lorc(["prep", "add a new page for subtract", "--json", "--no-start"]).stdout);
  assert.ok(!("must_ask" in out), JSON.stringify(out.must_ask));
});

test("W33: no store → graph.suggest, and prep builds no store", () => {
  const e = repo();
  const r = e.lorc(["prep", "add subtract", "--json", "--no-start"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.graph.suggest, "lorc graph scan");
  assert.ok(!fs.existsSync(path.join(e.root, ".claude", "lorc", "orc", "graph", "meta.json")));
});
