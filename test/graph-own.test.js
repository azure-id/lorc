"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const CLI = path.join(__dirname, "..", "bin", "lorc.js");

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-gown-"));
  const home = path.join(d, "home");
  const root = path.join(d, "proj");
  fs.mkdirSync(root, { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(root, "a.js"), "const { middle } = require('./b');\nfunction top() {\n  return middle(1);\n}\nmodule.exports = { top };\n");
  fs.writeFileSync(path.join(root, "b.js"), "const { bottomWork } = require('./c');\nfunction middle(x) {\n  return bottomWork(x) + 1;\n}\nmodule.exports = { middle };\n");
  fs.writeFileSync(path.join(root, "c.js"), "function bottomWork(x) {\n  return x * 2;\n}\nmodule.exports = { bottomWork };\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { root, home };
}
function lorc(env, ...args) {
  const r = spawnSync(process.execPath, [CLI, "graph", ...args, "--dir", env.root], { encoding: "utf8", env: { ...process.env, LORC_HOME: env.home } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) {}
  return { ...r, json };
}

test("own mode: update, status, ctx --anchors, map, changes, heal", () => {
  const env = repo();
  let r = lorc(env, "update", "--json");
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(r.json.store.mode, "own");
  assert.ok(fs.existsSync(path.join(env.root, ".claude", "lorc", "orc", "graph", "meta.json")));

  r = lorc(env, "status", "--json");
  assert.strictEqual(r.json.state, "fresh", r.stdout);
  assert.strictEqual(r.status, 0);

  r = lorc(env, "ctx", "middle", "--anchors", "--json");
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok((r.json.callers || []).some((c) => c.file === "a.js"), JSON.stringify(r.json.callers));
  assert.ok(r.json.anchors);

  r = lorc(env, "map", "--focus=middle", "--json");
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(Array.isArray(r.json.files) && r.json.files.length > 0, r.stdout);

  r = lorc(env, "changes", "--files=b.js", "--json");
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.json.ok, true);
  assert.strictEqual(typeof r.json.line, "string");

  fs.appendFileSync(path.join(env.root, "c.js"), "function extraFn() { return 3; }\n");
  r = lorc(env, "status", "--json");
  assert.strictEqual(r.json.state, "drifted", r.stdout);
  assert.strictEqual(r.status, 2);
  r = lorc(env, "status", "--heal", "--json");
  assert.strictEqual(r.json.state, "fresh", r.stdout);
  assert.ok(r.json.healed);
});
