"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const CLI = path.join(__dirname, "..", "bin", "lorc.js");

function setup(script) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-gdel-"));
  const root = path.join(d, "proj");
  const home = path.join(d, "home");
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: root });
  const cli = path.join(d, "fake-orc.js");
  const log = path.join(d, "argv.json");
  fs.writeFileSync(cli, script.replace("LOG", JSON.stringify(log)));
  fs.writeFileSync(path.join(root, ".claude", "hooks", "orc-version.json"), JSON.stringify({ version: "2.3.0", cli }));
  fs.writeFileSync(path.join(root, ".claude", "orc.config.yaml"), "code_graph: on\n");
  return { root, home, log };
}
const run = (e, ...a) => spawnSync(process.execPath, [CLI, "graph", ...a], { cwd: e.root, encoding: "utf8", env: { ...process.env, LORC_HOME: e.home } });

test("delegate calls ORC with graph status --json", () => {
  const e = setup("require('fs').writeFileSync(LOG, JSON.stringify(process.argv.slice(2)));process.stdout.write('{\"ok\":true}');");
  const r = run(e, "status", "--json");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(e.log, "utf8")), ["graph", "status", "--json"]);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.store.mode, "delegate");
});

test("a broken ORC falls back to own mode with fallback set", () => {
  const e = setup("process.stdout.write('garbage');process.exit(1);");
  const r = run(e, "status", "--json");
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.store.mode, "own");
  assert.match(out.fallback, /not JSON/);
});

test("W30b: delegate update --if-exists with no ORC store skips and does not call ORC", () => {
  const e = setup("require('fs').writeFileSync(LOG, JSON.stringify(process.argv.slice(2)));process.stdout.write('{\"ok\":true}');");
  const r = run(e, "update", "--if-exists");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), "graph: none — skipped (run: lorc graph scan)");
  assert.ok(!fs.existsSync(e.log));
  fs.mkdirSync(path.join(e.root, ".claude", "orc", "graph"), { recursive: true });
  fs.writeFileSync(path.join(e.root, ".claude", "orc", "graph", "meta.json"), "{\"generation\":1}");
  const s = run(e, "scan", "--if-exists");
  assert.strictEqual(s.status, 0, s.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(e.log, "utf8")), ["graph", "update", "--json"]);
});
