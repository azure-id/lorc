"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOK = path.join(__dirname, "..", "templates", "hooks", "lorc-graph-hook.js");
const hook = (input, home) => spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env: { ...process.env, LORC_HOME: home } });

function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-ghook-"));
  const root = path.join(d, "proj");
  fs.mkdirSync(root, { recursive: true });
  return { root, home: path.join(d, "home") };
}
const grep = (cwd, pattern) => JSON.stringify({ hook_event_name: "PreToolUse", cwd, tool_name: "Grep", tool_input: { pattern } });

test("no .current → empty output, exit 0", () => {
  const p = project();
  const r = hook(grep(p.root, "middleware"), p.home);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, "");
  assert.strictEqual(r.stderr, "");
});

test(".current + names.json + a Grep of a known symbol → the hint", () => {
  const p = project();
  const g = path.join(p.root, ".claude", "lorc", "orc", "graph");
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, "meta.json"), JSON.stringify({ generation: 3 }));
  fs.writeFileSync(path.join(g, "names.json"), JSON.stringify({ generation: 3, names: { loadOrders: [["orders.loadOrders", "function", "src/orders.js", 10, 20, 2]] } }));
  fs.mkdirSync(path.join(p.root, ".claude", "lorc", "run"), { recursive: true });
  fs.writeFileSync(path.join(p.root, ".claude", "lorc", "run", ".current"), JSON.stringify({ slug: "s1", store_dir: g, mode: "own", at: new Date().toISOString() }));
  const r = hook(grep(p.root, "loadOrders\\("), p.home);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, "");
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /"loadOrders" is defined at orders\.loadOrders \(function\) src\/orders\.js:10-20/);
});

test("a stale .current → silent", () => {
  const p = project();
  fs.mkdirSync(path.join(p.root, ".claude", "lorc", "run"), { recursive: true });
  fs.writeFileSync(path.join(p.root, ".claude", "lorc", "run", ".current"), JSON.stringify({ slug: "s1", at: new Date(Date.now() - 7 * 3600e3).toISOString() }));
  const r = hook(grep(p.root, "loadOrders"), p.home);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, "");
});

test("garbage stdin → exit 0, no stderr", () => {
  const p = project();
  const r = hook("{not json", p.home);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, "");
  assert.strictEqual(r.stdout, "");
});

test("0.1.3: PostToolUse Agent → silent (the changes card is gone)", () => {
  const p = project();
  fs.mkdirSync(path.join(p.root, ".claude", "lorc", "run"), { recursive: true });
  fs.writeFileSync(path.join(p.root, ".claude", "lorc", "run", ".current"), JSON.stringify({ slug: "s1", at: new Date().toISOString() }));
  const r = hook(JSON.stringify({ hook_event_name: "PostToolUse", cwd: p.root, tool_name: "Agent", tool_use_id: "t1", tool_input: { subagent_type: "lorc-executor-sonnet-5-medium" } }), p.home);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, "");
});
