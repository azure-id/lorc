"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const jev = require("../bin/lib/jev.js");
const { runAsync, LORC, TS_KEYS } = require("./prep-fixture.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lorc-jev-"));
const P = (low, mid, high, complex) => ({ low, mid, high, complex });
const ans = (pa, pb, ca = "mid", cb = ca) => ({ tier: { choice: ca, probabilities: pa }, tier_rev: { choice: cb, probabilities: pb } });
const GOOD = P(0.05, 0.85, 0.05, 0.05);
const body = (answers = ans(GOOD, GOOD)) => ({ model: "jev-1.13.0", answers: Object.assign({ new_component: { noul: 0.123 } }, answers), usage: { input_tokens: 500 } });
const res = (status, b, headers = {}) => ({ ok: status < 300, status, headers: { get: (h) => headers[h] }, json: async () => b });
// A fake fetch that records each call and gives the next answer from the list.
function fake(...list) {
  const f = async (url, opts) => { f.calls.push({ url, opts }); const r = list[Math.min(f.calls.length - 1, list.length - 1)]; return typeof r === "function" ? r(url, opts) : r; };
  f.calls = [];
  return f;
}
const KEY = { TYPESAFE_API_KEY: "k-1234567890ab" };
const run = (fetchImpl, { env = KEY, settings = {}, timeoutMs } = {}) => jev.judge({ request: "add a page", tier_hint: { files_likely: 3 }, files: ["a.js"] }, { settings, env, home: tmp(), fetchImpl, timeoutMs });

test("resolve: env key, file key, none; base and model", () => {
  const home = tmp();
  assert.deepStrictEqual(jev.resolve({ env: {}, home }), { key: null, source: null, base: "https://api.typesafe.ai", model: "jev-latest" });
  jev.saveKey("file-key-123456", { home });
  assert.strictEqual(jev.resolve({ env: {}, home }).source, "file");
  assert.strictEqual(jev.resolve({ env: {}, home }).key, "file-key-123456");
  const r = jev.resolve({ env: { TYPESAFE_API_KEY: "env-key", TYPESAFE_BASE_URL: "https://h.x/", TYPESAFE_DEFAULT_MODEL: "jev-9" }, home });
  assert.deepStrictEqual(r, { key: "env-key", source: "env", base: "https://h.x", model: "jev-9" });
  assert.strictEqual(jev.DEFAULT_BASE, "https://api.typesafe.ai");
  assert.strictEqual(jev.DEFAULT_MODEL, "jev-latest");
});

test("checkBase", () => {
  for (const b of ["https://x.y", "http://127.0.0.1:9", "http://localhost:9", "http://[::1]:9"]) assert.strictEqual(jev.checkBase(b), null, b);
  assert.strictEqual(jev.checkBase("http://example.com"), "base URL must use https");
  assert.strictEqual(jev.checkBase("not a url"), "bad base URL");
});

test("state: counts as words, cuts", () => {
  const f = (n) => jev.state("r", { files_likely: n }).code_search.files_found;
  assert.deepStrictEqual([0, 2, 4, 7, 25].map(f), ["none found", "1 to 2 files", "3 to 5 files", "6 to 20 files", "more than 20 files"]);
  const a = (n) => jev.state("r", { areas: n }).code_search.areas_found;
  assert.deepStrictEqual([0, 1, 3, 4].map(a), ["none found", "1 area", "2 to 3 areas", "more than 3 areas"]);
  assert.strictEqual(jev.state("r", { new_files_likely: true }).code_search.new_files_likely, "yes");
  assert.strictEqual(jev.state("r", {}).code_search.new_files_likely, "no");
  const s = jev.state("x".repeat(900), {}, Array.from({ length: 12 }, (_, i) => `f${i}.js`));
  assert.strictEqual(s.request.length, 600);
  assert.strictEqual(s.code_search.files.length, 8);
});

test("questions: keys, order, types", () => {
  const q = jev.questions();
  assert.deepStrictEqual(Object.keys(q), ["tier", "tier_rev", "new_component", "migration", "ordered_steps", "multi_area"]);
  assert.deepStrictEqual(Object.keys(q.tier.criteria), ["low", "mid", "high", "complex"]);
  assert.deepStrictEqual(Object.keys(q.tier_rev.criteria), ["complex", "high", "mid", "low"]);
  assert.strictEqual(q.tier.type, "choice");
  assert.strictEqual(q.tier_rev.type, "choice");
  for (const k of ["new_component", "migration", "ordered_steps", "multi_area"]) assert.strictEqual(q[k].type, "noul");
});

test("combine", () => {
  const ok = jev.combine(Object.assign(ans(GOOD, GOOD), { migration: { noul: 0.4567 } }));
  assert.strictEqual(ok.tier, "mid");
  assert.strictEqual(ok.consistent, true);
  assert.strictEqual(ok.conf, 0.8); // (4 * 0.85 - 1) / 3
  assert.deepStrictEqual(ok.signals, { migration: 0.46 });
  const bad = jev.combine(ans(P(0.3, 0.7, 0, 0), P(0, 0.3, 0.7, 0), "mid", "high"));
  assert.strictEqual(bad.consistent, false);
  assert.ok(bad.conf < ok.conf);
  assert.strictEqual(bad.conf, 0.33);
  assert.strictEqual(jev.combine(ans(P(0.5, 0.5, 0, 0), P(0.5, 0.5, 0, 0))).tier, "mid");
  assert.strictEqual(jev.combine({ tier_rev: { probabilities: GOOD } }), null);
  assert.strictEqual(jev.combine({ tier: { choice: "mid", probabilities: GOOD } }).consistent, null);
});

test("judge: success sends the right request", async () => {
  const f = fake(res(200, body()));
  const r = await run(f);
  assert.strictEqual(r.by, "jev");
  assert.strictEqual(r.tier, "mid");
  assert.strictEqual(r.conf, 0.8);
  assert.strictEqual(r.model, "jev-1.13.0");
  assert.strictEqual(r.tokens, 500);
  assert.strictEqual(f.calls.length, 1);
  const { url, opts } = f.calls[0];
  assert.strictEqual(url, "https://api.typesafe.ai/v1/systemone");
  assert.strictEqual(opts.method, "POST");
  assert.strictEqual(opts.headers.authorization, "Bearer k-1234567890ab");
  const b = JSON.parse(opts.body);
  assert.strictEqual(b.model, "jev-latest");
  assert.strictEqual(b.state.request, "add a page");
  assert.ok(b.questions.tier);
});

test("judge: no call when off, no key, or http base", async () => {
  const f = fake(res(200, body()));
  assert.deepStrictEqual(await run(f, { settings: { tier_judge: "off" } }), { by: "table", reason: "off" });
  assert.deepStrictEqual(await run(f, { env: {} }), { by: "table", reason: "no key" });
  assert.deepStrictEqual(await run(f, { env: Object.assign({ TYPESAFE_BASE_URL: "http://example.com" }, KEY) }), { by: "table", reason: "base URL must use https" });
  assert.strictEqual(f.calls.length, 0);
});

test("judge: http errors, retry, network, timeout, bad body", async () => {
  assert.strictEqual((await run(fake(res(401, {})))).reason, "http 401");
  let f = fake(res(429, {}, { "retry-after": "0" }), res(200, body()));
  assert.strictEqual((await run(f)).by, "jev");
  assert.strictEqual(f.calls.length, 2);
  f = fake(res(429, {}, { "retry-after": "0" }));
  assert.strictEqual((await run(f)).reason, "http 429");
  assert.strictEqual(f.calls.length, 2);
  assert.strictEqual((await run(fake(() => Promise.reject(new Error("x"))))).reason, "network");
  // This fetch never answers; it fails only when the signal aborts.
  const hang = fake((u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("abort")))));
  assert.strictEqual((await run(hang, { timeoutMs: 50 })).reason, "timeout");
  const broken = { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("bad"); } };
  assert.strictEqual((await run(fake(broken))).reason, "bad response");
  assert.strictEqual((await run(fake(res(200, { answers: { new_component: { noul: 1 } } })))).reason, "bad response");
});

test("judge: low confidence → table, unless min_conf 0", async () => {
  const flat = body(ans(P(0.25, 0.3, 0.25, 0.2), P(0.25, 0.3, 0.25, 0.2)));
  const r = await run(fake(res(200, flat)));
  assert.strictEqual(r.by, "table");
  assert.strictEqual(r.reason, "low confidence");
  assert.strictEqual(r.jev.tier, "mid");
  assert.strictEqual((await run(fake(res(200, flat)), { settings: { tier_judge_min_conf: 0 } })).by, "jev");
});

// Child env: no TYPESAFE_* keys unless the test sets them.
function cliEnv(home, extra = {}) {
  const e = Object.assign({}, process.env);
  for (const k of TS_KEYS) delete e[k];
  return Object.assign(e, { LORC_HOME: home }, extra);
}

test("CLI: status, connect, disconnect, tier, bogus", () => {
  const home = tmp();
  const dir = tmp();
  const cli = (args, input) => spawnSync(process.execPath, [LORC, "jev", ...args, "--dir", dir], { encoding: "utf8", input, env: cliEnv(home) });
  let r = cli(["status", "--json"]);
  assert.strictEqual(r.status, 0, r.stderr);
  let o = JSON.parse(r.stdout);
  assert.strictEqual(o.connected, false);
  assert.strictEqual(o.source, null);
  assert.strictEqual(o.tier_judge, "auto");
  assert.strictEqual(o.min_conf, 60);
  assert.strictEqual(cli(["connect"]).status, 2);
  assert.strictEqual(cli(["connect", "-"], "abc def").status, 2);
  r = cli(["connect", "-", "--no-check", "--json"], "test-key-123456789");
  assert.strictEqual(r.status, 0, r.stderr);
  const file = path.join(home, ".claude", "lorc", "jev.json");
  assert.ok(fs.existsSync(file));
  assert.ok(r.stdout.includes("…6789"));
  assert.ok(!r.stdout.includes("test-key-123456789"));
  r = cli(["status", "--json"]);
  o = JSON.parse(r.stdout);
  assert.strictEqual(o.connected, true);
  assert.strictEqual(o.source, "file");
  assert.ok(!r.stdout.includes("test-key-123456789"));
  r = cli(["disconnect", "--json"]);
  assert.strictEqual(JSON.parse(r.stdout).removed, true);
  assert.ok(!fs.existsSync(file));
  r = cli(["tier", "--json"], "{}");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { by: "table", reason: "no key" });
  assert.strictEqual(cli(["bogus"]).status, 2);
});

function mock(handler) {
  return new Promise((ok) => {
    const seen = [];
    const s = http.createServer((req, rs) => {
      let b = "";
      req.on("data", (x) => { b += x; });
      req.on("end", () => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b }); handler(req, rs); });
    });
    s.listen(0, "127.0.0.1", () => ok({ s, seen, base: `http://127.0.0.1:${s.address().port}` }));
  });
}
const send = (rs, status, b) => { rs.writeHead(status, { "content-type": "application/json" }); rs.end(JSON.stringify(b)); };

test("CLI tier against a mock server", async () => {
  const m = await mock((req, rs) => send(rs, 200, body()));
  try {
    const input = JSON.stringify({ request: "add a page", tier_hint: { files_likely: 3, areas: 1 }, files: ["a.js"] });
    const r = await runAsync([LORC, "jev", "tier", "--json", "--dir", tmp()], { input, env: cliEnv(tmp(), { TYPESAFE_API_KEY: "k-1234567890ab", TYPESAFE_BASE_URL: m.base }) });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).by, "jev", r.stdout);
    assert.ok(m.seen.some((x) => x.method === "POST" && x.url === "/v1/systemone" && x.auth === "Bearer k-1234567890ab"));
  } finally { m.s.close(); }
});

test("CLI connect: key check 401 → exit 1, no file", async () => {
  const m = await mock((req, rs) => send(rs, 401, {}));
  try {
    const home = tmp();
    const r = await runAsync([LORC, "jev", "connect", "-", "--dir", tmp()], { input: "test-key-123456789", env: cliEnv(home, { TYPESAFE_BASE_URL: m.base }) });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.ok(m.seen.some((x) => x.method === "GET" && x.url === "/v1/models"));
    assert.ok(!fs.existsSync(path.join(home, ".claude", "lorc", "jev.json")));
  } finally { m.s.close(); }
});

const Q1 = { id: "q1", q: "which?", facts: "f", options: { a: "A", b: "B" } };

test("askItems: filters, caps, ids, cuts", () => {
  const items = jev.askItems({ questions: [
    { id: "x", options: { a: "A" } },
    { id: "y", options: ["a", "b"] },
    { id: "z" },
    { id: "bad id!", q: "q".repeat(500), facts: "f".repeat(700), options: { a: "t".repeat(400), "b-c": "no", b: { n: 1 } } },
    { id: "dup", options: { a: 1, b: 2 } },
    { id: "dup", options: { a: 1, b: 2 } },
  ] });
  assert.deepStrictEqual(items.map((i) => i.id), ["q4", "dup", "q6x"]);
  const it = items[0];
  assert.strictEqual(it.q.length, 400);
  assert.strictEqual(it.facts.length, 600);
  assert.deepStrictEqual(Object.keys(it.options), ["a", "b"]);
  assert.strictEqual(it.options.a.length, 300);
  assert.strictEqual(it.options.b, "{\"n\":1}");
  assert.strictEqual(items[1].options.a, "1");
  const opts = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`o${i}`, "x"]));
  const many = jev.askItems({ questions: Array.from({ length: 14 }, () => ({ options: opts })) });
  assert.strictEqual(many.length, 10);
  assert.strictEqual(Object.keys(many[0].options).length, 8);
  assert.deepStrictEqual(jev.askItems({}), []);
});

test("askQuestions: one noul per option", () => {
  const q = jev.askQuestions(jev.askItems({ questions: [Object.assign({}, Q1, { facts: "" })] }));
  assert.deepStrictEqual(Object.keys(q), ["q1__a", "q1__b"]);
  const a = q.q1__a;
  assert.strictEqual(a.type, "noul");
  assert.strictEqual(a.instructions.question, "which?");
  assert.strictEqual(a.instructions.facts, "none");
  assert.deepStrictEqual(a.instructions.options, { a: "A", b: "B" });
  assert.ok(a.instructions.ask.includes("`a`"));
  assert.ok(q.q1__b.instructions.ask.includes("`b`"));
  assert.ok(a.criteria.true && a.criteria.false);
});

test("askVerdict: p, rec, gap, floor, missing, clamp", () => {
  const items = jev.askItems({ questions: [Q1] });
  const v = (na, nb) => {
    const a = {};
    if (na !== undefined) a.q1__a = { noul: na };
    if (nb !== undefined) a.q1__b = { noul: nb };
    return jev.askVerdict(items, a).q1;
  };
  assert.deepStrictEqual(v(0.9, 0.3), { p: { a: 90, b: 30 }, rec: "a" });
  assert.strictEqual(v(0.55, 0.5).rec, null);
  assert.strictEqual(v(0.45, 0.2).rec, null);
  assert.deepStrictEqual(v(0.9), { p: { a: 90 }, rec: null });
  assert.strictEqual(v(1.4, 0.1).p.a, 100);
});

const askBody = (answers = { q1__a: { noul: 0.9 }, q1__b: { noul: 0.3 } }) => ({ model: "jev-1.13.0", answers, usage: { input_tokens: 300 } });
const ask = (fetchImpl, { env = KEY, settings = {}, input } = {}) =>
  jev.judgeAsk(input || { request: "add a page", intent: "fast", questions: [Q1] }, { settings, env, home: tmp(), fetchImpl });

test("judgeAsk: success sends the right request", async () => {
  const f = fake(res(200, askBody()));
  const r = await ask(f);
  assert.strictEqual(r.by, "jev");
  assert.strictEqual(r.questions.q1.rec, "a");
  assert.strictEqual(r.model, "jev-1.13.0");
  assert.strictEqual(r.tokens, 300);
  assert.strictEqual(f.calls.length, 1);
  const b = JSON.parse(f.calls[0].opts.body);
  assert.strictEqual(b.state.request, "add a page");
  assert.strictEqual(b.state.intent, "fast");
  assert.strictEqual(b.model, "jev-latest");
  assert.ok(b.questions.q1__a);
});

test("judgeAsk: no call when off, no key, http base, no questions", async () => {
  const f = fake(res(200, askBody()));
  assert.deepStrictEqual(await ask(f, { settings: { ask_judge: "off" } }), { by: "self", reason: "off" });
  assert.strictEqual((await ask(f, { env: {} })).reason, "no key");
  assert.strictEqual((await ask(f, { env: Object.assign({ TYPESAFE_BASE_URL: "http://example.com" }, KEY) })).reason, "base URL must use https");
  assert.strictEqual((await ask(f, { input: { questions: [{ options: { a: 1 } }] } })).reason, "no questions");
  assert.strictEqual(f.calls.length, 0);
});

test("judgeAsk: http 401, bad response", async () => {
  assert.strictEqual((await ask(fake(res(401, {})))).reason, "http 401");
  assert.strictEqual((await ask(fake(res(200, askBody({}))))).reason, "bad response");
});

test("CLI ask: no key, bad run slugs, status", () => {
  const home = tmp();
  const dir = tmp();
  const cli = (args, input) => spawnSync(process.execPath, [LORC, "jev", ...args, "--dir", dir], { encoding: "utf8", input, env: cliEnv(home) });
  let r = cli(["ask", "--json", "-"], JSON.stringify({ request: "x", questions: [Q1] }));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { by: "self", reason: "no key" });
  assert.strictEqual(cli(["ask", "--run", "../x", "--json", "-"], "{}").status, 2);
  assert.strictEqual(cli(["ask", "--run", "nosuchrun", "--json", "-"], "{}").status, 2);
  r = cli(["status", "--json"]);
  assert.strictEqual(JSON.parse(r.stdout).ask_judge, "auto");
});

test("CLI ask --run against a mock server", async () => {
  const m = await mock((req, rs) => {
    const b = JSON.parse(m.seen[m.seen.length - 1].body);
    const answers = {};
    for (const k of Object.keys(b.questions)) answers[k] = { noul: k.endsWith("__a") ? 0.9 : 0.3 };
    send(rs, 200, { model: "jev-1.13.0", answers });
  });
  try {
    const dir = tmp();
    const rd = path.join(dir, ".claude", "lorc", "run", "r1");
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, "run.json"), JSON.stringify({ request: "add a transfers page" }));
    const input = JSON.stringify({ intent: "x", questions: [{ id: "q1", q: "?", options: { a: "A", b: "B" } }] });
    const env = cliEnv(tmp(), { TYPESAFE_API_KEY: "k-1234567890ab", TYPESAFE_BASE_URL: m.base });
    let r = await runAsync([LORC, "jev", "ask", "--run", "r1", "--json", "-", "--dir", dir], { input, env });
    assert.strictEqual(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.strictEqual(o.by, "jev", r.stdout);
    assert.strictEqual(o.questions.q1.rec, "a");
    assert.strictEqual(JSON.parse(m.seen[0].body).state.request, "add a transfers page");
    const lines = fs.readFileSync(path.join(rd, "asks-jev.jsonl"), "utf8").trim().split("\n");
    assert.strictEqual(lines.length, 1);
    const l = JSON.parse(lines[0]);
    assert.ok(l.items && l.by);
    r = await runAsync([LORC, "jev", "ask", "--run", "r1", "-", "--dir", dir], { input, env });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("q1: a 90 % ➡️ · b 30 %"), r.stdout);
  } finally { m.s.close(); }
});

test("state: engine evidence as words; none without it", () => {
  const s = jev.state("r", {}, [], { est_files: 7, creates: ["page"], areas: 2, blast: 0, similar: { n: 3, median: 9 }, mechanical: false });
  assert.strictEqual(s.estimate.source_files_to_change, "6 to 20 files");
  assert.strictEqual(s.estimate.areas, "2 to 3 areas");
  assert.match(s.estimate.similar_past_commits, /3/);
  assert.ok(!("tier" in s.estimate));
  assert.ok(!("estimate" in jev.state("r")));
  assert.match(jev.CRITERIA.low, /source files/);
});

test("judge: the engine evidence goes into state.estimate", async () => {
  const f = fake(res(200, body()));
  await jev.judge({ request: "add a page", tier_hint: {}, files: [], engine: { est_files: 4, creates: ["page"], areas: 1, blast: 0, similar: null, mechanical: false } }, { settings: {}, env: KEY, home: tmp(), fetchImpl: f });
  assert.strictEqual(f.calls.length, 1);
  const b = JSON.parse(f.calls[0].opts.body);
  assert.ok(b.state.estimate, JSON.stringify(b.state));
  assert.strictEqual(b.state.estimate.source_files_to_change, "3 to 5 files");
});
