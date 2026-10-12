"use strict";
// Shared fixture for the prep / slice / check / review tests: a tiny git repo
// whose test script is `node --test` (no install), and a fake home.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const LORC = path.join(__dirname, "..", "bin", "lorc.js");

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
  const lorc = (args, input) => spawnSync(process.execPath, [LORC, ...args, "--dir", root], {
    cwd: root, encoding: "utf8", input, env: Object.assign({}, process.env, { LORC_HOME: home }),
  });
  return { d, root, home, git, write, lorc };
}

module.exports = { repo, LORC };
