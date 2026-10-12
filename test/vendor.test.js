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
    const f = path.join(d, "vendor", "graph", "graph-map.js");
    const buf = fs.readFileSync(f);
    buf[0] = buf[0] ^ 1;
    fs.writeFileSync(f, buf);
    const r = run("--check", "--root", d);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /vendor\/graph\/graph-map\.js/);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("vendored engine loads", () => {
  const G = require("../vendor/graph/graph.js");
  require("../vendor/graph/graph-query.js");
  assert.ok(G.ENGINE);
});
