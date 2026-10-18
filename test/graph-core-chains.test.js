"use strict";
// lorc 0.5.0 (W32b): a call on a call result is a CHAIN (never a bare-name
// edge), a call on a local or a parameter is `lv`, and TS / JS test helpers
// are noise.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const X = require("../bin/lib/graph/graph-extract.js");
const G = require("../bin/lib/graph/graph.js");
const Q = require("../bin/lib/graph/graph-query.js");

// A sandbox with node_modules/typescript (the borrowed walker rung).
const TS_ROOT = "C:/Users/joshu/AppData/Local/Temp/claude/C--dev-lorc/b99c0c9b-45a4-4c99-b678-8cb4794baad8/scratchpad/be-ts-ekyc";
const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function noBorrow(fn) {
  const was = process.env.ORC_GRAPH_NO_BORROW;
  process.env.ORC_GRAPH_NO_BORROW = "1";
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.ORC_GRAPH_NO_BORROW;
    else process.env.ORC_GRAPH_NO_BORROW = was;
  }
}
function withBorrow(fn) {
  const was = process.env.ORC_GRAPH_NO_BORROW;
  delete process.env.ORC_GRAPH_NO_BORROW;
  try {
    return fn();
  } finally {
    if (was !== undefined) process.env.ORC_GRAPH_NO_BORROW = was;
  }
}
const heuristic = (rel, lang, src) => noBorrow(() => X.extractOne({ rel, lang, src }, null));
const hasTs = () => fs.existsSync(TS_ROOT) && withBorrow(() => !!X._findTypeScript(TS_ROOT));
function walker(rel, lang, src) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-chains-"));
  temps.push(d);
  const abs = path.join(d, path.basename(rel));
  fs.writeFileSync(abs, src);
  const rec = withBorrow(() => X.extractBatch([{ rel, abs, lang, src }], { root: TS_ROOT }).get(rel));
  assert.match(rec.extractor || "", /^typescript@/, `walker rung: ${rec.extractor}`);
  return rec;
}
const symOf = (rec, name) => rec.symbols.find((s) => s.name === name);
const callOf = (s, name) => s.calls.find((c) => c.name === name && !c.ref);

const JS = [
  "async function load(db) {",
  "  const row = await db('users').where({ id: 1 }).first();",
  "  row.save();",
  "  return knexHelper();",
  "}",
  "",
].join("\n");
function checkJs(rec) {
  const s = symOf(rec, "load");
  assert.ok(s, "load is a symbol");
  for (const n of ["where", "first"]) {
    const c = callOf(s, n);
    assert.ok(c, `${n}: ${JSON.stringify(s.calls)}`);
    assert.strictEqual(c.chain, true, n);
  }
  const save = callOf(s, "row.save");
  assert.ok(save, `row.save: ${JSON.stringify(s.calls)}`);
  assert.strictEqual(save.lv, true);
  const k = callOf(s, "knexHelper");
  assert.ok(k);
  assert.ok(!k.chain && !k.lv);
}
test("C4/C5 JS: a knex chain is chain, a call on a local is lv (heuristic)", () => checkJs(heuristic("src/load.js", "js", JS)));
test("C4/C5 JS: the same in the walker", (t) => {
  if (!hasTs()) return t.skip("no typescript");
  checkJs(walker("src/load.js", "js", JS));
});

const TS = [
  "class C {",
  "  constructor(private readonly svc: Svc) {}",
  "  run(reply: Reply) {",
  "    reply.code(400).send({});",
  "    this.svc.go();",
  "  }",
  "}",
  "",
].join("\n");
function checkTs(rec) {
  const s = symOf(rec, "run");
  assert.ok(s, "run is a symbol");
  const send = callOf(s, "send");
  assert.ok(send, `send: ${JSON.stringify(s.calls)}`);
  assert.strictEqual(send.chain, true);
  // lorc 0.5.0 (W32d): a typed parameter is a local alias (`reply: Reply`).
  const code = callOf(s, "Reply.code");
  assert.ok(code && code.alias === "reply", `reply.code: ${JSON.stringify(s.calls)}`);
  assert.ok(!code.lv);
  // `this.svc` is a parameter property: the alias step names its class.
  const go = s.calls.find((c) => /(^|.)go$/.test(c.name) && (c.self || c.alias === "svc"));
  assert.ok(go, `this.svc.go: ${JSON.stringify(s.calls)}`);
  assert.ok(!go.lv);
}
test("C4/C5 TS: reply.code(400).send() and a parameter property (heuristic)", () => checkTs(heuristic("src/c.ts", "ts", TS)));
test("C4/C5 TS: the same in the walker", (t) => {
  if (!hasTs()) return t.skip("no typescript");
  checkTs(walker("src/c.ts", "ts", TS));
});

const MULTI = ["function q() {", "  const q = knex('t')", "    .select('a')", "    .orderBy('a');", "  return q;", "}", ""].join("\n");
function checkMulti(rec) {
  const s = symOf(rec, "q");
  for (const n of ["select", "orderBy"]) {
    const c = callOf(s, n);
    assert.ok(c, `${n}: ${JSON.stringify(s.calls)}`);
    assert.strictEqual(c.chain, true, n);
  }
}
test("C4: a chain over lines (heuristic)", () => checkMulti(heuristic("src/q.js", "js", MULTI)));
test("C4: a chain over lines in the walker", (t) => {
  if (!hasTs()) return t.skip("no typescript");
  checkMulti(walker("src/q.js", "js", MULTI));
});

test("resolver: a chain call is UNRESOLVED; an imported bare call stays IMPORT", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-chains-store-"));
  temps.push(d);
  const root = path.join(d, "proj");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(root, "src", "a.js"), "export function send() {}\n");
  fs.writeFileSync(path.join(root, "src", "b.js"), "function send() {}\nmodule.exports = { send };\n");
  fs.writeFileSync(path.join(root, "src", "h.js"), "function h(reply) { return reply.code(400).send(); }\nmodule.exports = { h };\n");
  fs.writeFileSync(path.join(root, "src", "c.js"), "import { send } from './a';\nexport function c() { return send(); }\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const claudeDir = path.join(root, ".claude", "lorc");
  noBorrow(() => G.graphUpdate(claudeDir, root, { enabled: true }));
  const model = Q.loadModel(claudeDir, root, { noCache: true });
  const h = model.byFile["src/h.js"].symbols.find((s) => s.name === "h");
  const send = h.calls.find((c) => c.name === "send");
  assert.ok(send && send.chain, `h calls: ${JSON.stringify(h.calls)}`);
  assert.strictEqual(Q.resolveCall(model, "src/h.js", h, send).state, "UNRESOLVED");
  const c = model.byFile["src/c.js"].symbols.find((s) => s.name === "c");
  const plain = c.calls.find((x) => x.name === "send");
  assert.ok(plain && !plain.chain);
  assert.strictEqual(Q.resolveCall(model, "src/c.js", c, plain).state, "IMPORT");
});

const SPEC = "it('a', async () => { when(m.get()).thenResolve(1); await expect(f()).rejects.toThrow(); f(); });\n";
function checkSpec(rec) {
  // An `it` block is not a symbol: the module of a test file owns its calls.
  const t = rec.symbols.find((s) => s.kind === "test") || rec.symbols.find((s) => s.kind === "module");
  assert.ok(t, `a test symbol: ${JSON.stringify(rec.symbols.map((s) => s.kind))}`);
  const names = t.calls.filter((c) => !c.ref).map((c) => c.name);
  assert.ok(names.includes("f"), JSON.stringify(names));
  for (const n of ["when", "thenResolve", "rejects", "toThrow"]) assert.ok(!names.includes(n), `${n} in ${JSON.stringify(names)}`);
}
test("C3: ts-mockito and jest helpers are dropped in a spec (heuristic)", () => checkSpec(heuristic("test/x.spec.ts", "ts", SPEC)));
test("C3: the same in the walker", (t) => {
  if (!hasTs()) return t.skip("no typescript");
  checkSpec(walker("test/x.spec.ts", "ts", SPEC));
});

test("C4 Python borrowed: s.query(1).filter(x).all() is a chain", (t) => {
  if (!withBorrow(() => X._findPython())) return t.skip("no python");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-chains-py-"));
  temps.push(d);
  const src = "def f(s):\n    return s.query(1).filter(x).all()\n";
  const abs = path.join(d, "f.py");
  fs.writeFileSync(abs, src);
  const rec = withBorrow(() => X.extractBatch([{ rel: "f.py", abs, lang: "py", src }], { root: d }).get("f.py"));
  const s = symOf(rec, "f");
  for (const n of ["filter", "all"]) {
    const c = callOf(s, n);
    assert.ok(c, `${n}: ${JSON.stringify(s.calls)}`);
    assert.strictEqual(c.chain, true, n);
  }
});
