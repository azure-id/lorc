"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const S = require("../bin/lib/settings.js");

const CLI = path.join(__dirname, "..", "bin", "lorc.js");
function tmp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-set-"));
  const root = path.join(base, "proj");
  const home = path.join(base, "home");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, home };
}
const run = (t, ...a) => spawnSync(process.execPath, [CLI, ...a, "--dir", t.root], {
  encoding: "utf8", env: { ...process.env, LORC_HOME: t.home },
});

test("defaults when no file exists", () => {
  const t = tmp();
  const s = S.load(t.root, { home: t.home });
  assert.deepStrictEqual(s.values, S.DEFAULTS);
  assert.strictEqual(s.sources.limit_pct, "default");
  assert.strictEqual(S.DEFAULTS.limit_pct, 90);
  assert.strictEqual(S.DEFAULTS.statusline_writes_orc, true);
});

test("project beats global beats default", () => {
  const t = tmp();
  S.set("global", t.root, "limit_pct", "70", { home: t.home });
  S.set("global", t.root, "review", "inline", { home: t.home });
  S.set("project", t.root, "limit_pct", "80", { home: t.home });
  const s = S.load(t.root, { home: t.home });
  assert.strictEqual(s.values.limit_pct, 80);
  assert.strictEqual(s.sources.limit_pct, "project");
  assert.strictEqual(s.values.review, "inline");
  assert.strictEqual(s.sources.review, "global");
  assert.strictEqual(s.sources.dispatch, "default");
});

test("set / reset round trip", () => {
  const t = tmp();
  assert.ok(S.set("project", t.root, "statusline_writes_orc", "false", { home: t.home }).ok);
  assert.strictEqual(S.load(t.root, { home: t.home }).values.statusline_writes_orc, false);
  S.reset("project", t.root, "statusline_writes_orc", { home: t.home });
  const s = S.load(t.root, { home: t.home });
  assert.strictEqual(s.values.statusline_writes_orc, true);
  assert.strictEqual(s.sources.statusline_writes_orc, "default");
});

test("CLI: set prints, bad key and bad value exit 2", () => {
  const t = tmp();
  let r = run(t, "settings", "set", "limit_pct", "85");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /set limit_pct = 85 \(project\)/);
  r = run(t, "settings", "set", "nope", "1");
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /limit_pct/);
  r = run(t, "settings", "set", "limit_pct", "20");
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /integer 50-99/);
  r = run(t, "setting", "load", "--json");
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).values.limit_pct, 85);
});

test("executor opus-4-8-high needs executors all", () => {
  const t = tmp();
  assert.strictEqual(S.set("project", t.root, "executor", "opus-4-8-high", { home: t.home }).ok, false);
  assert.ok(S.set("project", t.root, "executors", "all", { home: t.home }).ok);
  assert.ok(S.set("project", t.root, "executor", "opus-4-8-high", { home: t.home }).ok);
  assert.strictEqual(S.load(t.root, { home: t.home }).values.executor, "opus-4-8-high");
});

test("atomic write leaves no tmp file", () => {
  const t = tmp();
  S.set("project", t.root, "dispatch", "manual", { home: t.home });
  assert.deepStrictEqual(fs.readdirSync(path.join(t.root, ".claude", "lorc")), ["settings.json"]);
});
