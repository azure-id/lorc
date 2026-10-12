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
