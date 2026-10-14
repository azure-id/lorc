"use strict";
// Shared fixture for the prep / slice / check / review tests: a tiny git repo
// whose test script is `node --test` (no install), and a fake home.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const LORC = path.join(__dirname, "..", "bin", "lorc.js");

const TS_KEYS = ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_DEFAULT_MODEL"];

function runAsync(args, { cwd, input, env }) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, args, { cwd, env });
    let stdout = "", stderr = "";
    c.stdout.setEncoding("utf8"); c.stderr.setEncoding("utf8");
    c.stdout.on("data", (x) => { stdout += x; });
    c.stderr.on("data", (x) => { stderr += x; });
    c.on("error", reject);
    c.on("close", (status) => resolve({ status, stdout, stderr }));
    c.stdin.end(input == null ? "" : input);
  });
}

function repo(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-w4a-"));
  const root = path.join(d, "proj");
  const home = path.join(d, "home");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  const files = Object.assign({
    "package.json": JSON.stringify({ name: "fx", version: "1.0.0", scripts: { test: "node --test" } }, null, 2) + "\n",
    "src/math.js": "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n",
    "test/math.test.js": "const test = require(\"node:test\");\nconst assert = require(\"node:assert\");\nconst { add } = require(\"../src/math.js\");\ntest(\"adds two numbers\", () => { assert.strictEqual(add(1, 2), 3); });\n",
  }, extra);
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), t);
  }
  git(["add", "-A"]); git(["commit", "-q", "-m", "base"]);
  const write = (f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
  // The TYPESAFE_* keys are removed: a real key on this machine must not reach the network.
  const mkEnv = (env) => {
    const e = Object.assign({}, process.env);
    for (const k of TS_KEYS) delete e[k];
    return Object.assign(e, { LORC_HOME: home }, env || {});
  };
  const lorc = (args, input, env) => spawnSync(process.execPath, [LORC, ...args, "--dir", root], {
    cwd: root, encoding: "utf8", input, env: mkEnv(env),
  });
  // Async: an in-process mock server can answer while the child runs.
  const lorcAsync = (args, { input, env } = {}) => runAsync([LORC, ...args, "--dir", root], { cwd: root, input, env: mkEnv(env) });
  return { d, root, home, git, write, lorc, lorcAsync };
}

module.exports = { repo, runAsync, LORC, TS_KEYS };
