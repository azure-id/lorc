"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(ROOT, "scripts", "vendor.js");
const run = (...a) => spawnSync(process.execPath, [VENDOR, ...a], { encoding: "utf8" });

test("vendor --check passes on the repo", () => {
  const r = run("--check");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /vendor OK/);
});

test("vendor --check names a changed file", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-vendor-"));
  try {
    fs.cpSync(path.join(ROOT, "vendor"), path.join(d, "vendor"), { recursive: true });
    const f = path.join(d, "vendor", "core", "wiki-core.js");
    const buf = fs.readFileSync(f);
    buf[0] = buf[0] ^ 1;
    fs.writeFileSync(f, buf);
    const r = run("--check", "--root", d);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /vendor\/core\/wiki-core\.js/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("lorc owns the graph engine in bin/lib/graph", () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT, "vendor", "graph")), false);
  const G = require("../bin/lib/graph/graph.js");
  require("../bin/lib/graph/graph-query.js");
  assert.strictEqual(G.ENGINE, "lgraph@1");
});

test("graph-router loads the engine from bin/lib/graph", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-engine-"));
  try {
    const sel = require("../bin/lib/graph-router.js").selectStore(d, { home: d });
    assert.strictEqual(sel.engine.engine, "lgraph@1");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
