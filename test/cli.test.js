"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");

const CLI = path.join(__dirname, "..", "bin", "lorc.js");
const PKG = require("../package.json");
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8" });

test("version --json matches package.json", () => {
  const r = run("version", "--json");
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), { name: PKG.name, version: PKG.version });
});

test("help lists version", () => {
  const r = run("help");
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /version/);
});

test("unknown command exits 2", () => {
  const r = run("nope");
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /lorc: unknown command "nope" — run "lorc help"/);
});

test("W33: no store → heal builds nothing and suggests; update --if-exists skips; update builds; heal updates a changed file", () => {
  const { repo } = require("./prep-fixture.js");
  const fs = require("fs");
  const R = require("../bin/lib/graph-router.js");
  const e = repo();
  const meta = path.join(e.root, ".claude", "lorc", "orc", "graph", "meta.json");
  const h = R.heal(e.root, { home: e.home });
  assert.strictEqual(h.state, "none");
  assert.strictEqual(h.suggest, "lorc graph scan");
  assert.strictEqual(h.line, "graph: none — run: lorc graph scan (builds the code graph once, zero tokens)");
  assert.ok(!fs.existsSync(meta));
  const s = e.lorc(["graph", "update", "--if-exists"]);
  assert.strictEqual(s.status, 0, s.stderr);
  assert.strictEqual(s.stdout.trim(), "graph: none — skipped (run: lorc graph scan)");
  assert.ok(!fs.existsSync(meta));
  const b = e.lorc(["graph", "update"]);
  assert.strictEqual(b.status, 0, b.stderr);
  assert.ok(fs.existsSync(meta));
  e.write("src/math.js", "function add(a, b) {\n  return a + b;\n}\nfunction sub(a, b) {\n  return a - b;\n}\nmodule.exports = { add, sub };\n");
  const u = R.heal(e.root, { home: e.home });
  assert.ok(u.healed && u.healed.changed === 1, JSON.stringify(u.healed));
  assert.ok(!("suggest" in u));
});

test("W30b: graph scan = graph update (plain line and --json keys)", () => {
  const { repo } = require("./prep-fixture.js");
  const e = repo();
  const s = e.lorc(["graph", "scan", "--json", "--dir", e.root]);
  assert.strictEqual(s.status, 0, s.stderr);
  const sj = JSON.parse(s.stdout);
  const g = repo();
  const u = g.lorc(["graph", "update", "--json", "--dir", g.root]);
  assert.strictEqual(u.status, 0, u.stderr);
  assert.deepStrictEqual(Object.keys(sj).sort(), Object.keys(JSON.parse(u.stdout)).sort());
  const f = repo();
  const p = f.lorc(["graph", "scan", "--dir", f.root]);
  assert.strictEqual(p.status, 0, p.stderr);
  assert.match(p.stdout, /^graph: built first index/);
});
