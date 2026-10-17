"use strict";
// W19c: parallel extraction (worker_threads). The store must be the same bytes
// with and without workers, and a worker that fails must not fail the update.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const G = require("../bin/lib/graph/graph.js");

const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// 30 js + 10 vue files that import and call each other.
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-gpar-"));
  temps.push(d);
  const root = path.join(d, "proj");
  fs.mkdirSync(root, { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  for (let i = 0; i < 30; i++) {
    const prev = i ? `const { fn${i - 1} } = require('./m${i - 1}');\n` : "";
    const call = i ? `  return fn${i - 1}(x) + ${i};\n` : "  return x;\n";
    const pad = "// filler line\n".repeat(i * 3);
    write(path.join(root, "src", `m${i}.js`), `${prev}${pad}function fn${i}(x) {\n${call}}\nfunction helper${i}() {\n  return fn${i}(${i});\n}\nmodule.exports = { fn${i}, helper${i} };\n`);
  }
  for (let i = 0; i < 10; i++) {
    write(
      path.join(root, "src", "components", `C${i}.vue`),
      `<template>\n  <div>{{ v }}</div>\n</template>\n<script>\nimport { fn${i} } from '../m${i}';\nexport default {\n  name: 'C${i}',\n  methods: {\n    load() {\n      return fn${i}(1);\n    },\n    again() {\n      return this.load();\n    },\n  },\n};\n</script>\n`
    );
  }
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { d, root };
}

// Run fn with these env values, then restore the old ones.
function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

const build = (claudeDir, root) => G.graphUpdate(claudeDir, root, { enabled: true });
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const store = (claudeDir) => {
  const g = G.graphPaths(claudeDir);
  const derived = readJson(g.derived);
  return {
    index: readJson(g.meta).index,
    derived: { resolved: derived.resolved, names: derived.names, map: derived.map },
  };
};

test("1. the store is the same with 0 and with 3 workers", () => {
  const env = repo();
  const a = path.join(env.d, "a");
  const b = path.join(env.d, "b");
  const ua = withEnv({ LORC_GRAPH_WORKERS: "0", LORC_GRAPH_PARALLEL_MIN: "1" }, () => build(a, env.root));
  const ub = withEnv({ LORC_GRAPH_WORKERS: "3", LORC_GRAPH_PARALLEL_MIN: "1" }, () => build(b, env.root));
  assert.strictEqual(ua.state, "built", JSON.stringify(ua));
  assert.strictEqual(ub.state, "built", JSON.stringify(ub));
  assert.strictEqual(ua.workers, 0);
  assert.strictEqual(ub.workers, 3);
  assert.strictEqual(typeof ub.extract_ms, "number");
  assert.strictEqual(ub.parsed, 40);
  assert.deepStrictEqual(store(b), store(a));
});

test("2. a worker that throws: the main thread extracts its chunk, same store", () => {
  const env = repo();
  const a = path.join(env.d, "a");
  const b = path.join(env.d, "b");
  withEnv({ LORC_GRAPH_WORKERS: "0", LORC_GRAPH_PARALLEL_MIN: "1" }, () => build(a, env.root));
  const ub = withEnv({ LORC_GRAPH_WORKERS: "3", LORC_GRAPH_PARALLEL_MIN: "1", LORC_GRAPH_WORKER_FAIL: "1" }, () => build(b, env.root));
  assert.strictEqual(ub.ok, true, JSON.stringify(ub));
  assert.strictEqual(ub.state, "built");
  assert.strictEqual(ub.exit, 0);
  assert.deepStrictEqual(store(b), store(a));
});

test("3. below PARALLEL_MIN no worker starts", () => {
  const env = repo();
  const u = withEnv({ LORC_GRAPH_WORKERS: undefined, LORC_GRAPH_PARALLEL_MIN: undefined }, () => build(path.join(env.d, "a"), env.root));
  assert.strictEqual(u.state, "built");
  assert.strictEqual(u.workers, 0);
});
