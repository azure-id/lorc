"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const cov = require("../bin/lib/coverage.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lorc-covt-"));
const rm = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* none */ } };
const hasGit = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const git = (root, args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.strictEqual(r.status, 0, r.stderr);
};
const rec = (o = {}) => ({ lf: 0, lh: 0, fns: [], brda: [], da: new Map(), ...o });

test("parseLcov reads SF / DA / FN / BRDA / LF / LH of two records", () => {
  const m = cov.parseLcov([
    "TN:", "SF:src/a.js", "FN:3,_interopRequireDefault", "DA:1,1", "DA:2,0",
    "BRDA:5,0,0,1", "BRDA:5,0,1,-", "LF:2", "LH:1", "end_of_record",
    "SF:/abs/b.js", "DA:1,4", "LF:1", "LH:1", "end_of_record",
  ].join("\n"));
  assert.strictEqual(m.size, 2);
  const a = m.get("src/a.js");
  assert.deepStrictEqual(a.fns, [{ line: 3, name: "_interopRequireDefault" }]);
  assert.deepStrictEqual(a.brda, [{ line: 5, hits: 1 }, { line: 5, hits: 0 }]);
  assert.strictEqual(a.da.get(2), 0);
  assert.strictEqual(a.lf, 2);
  assert.strictEqual(a.lh, 1);
  assert.strictEqual(m.get("/abs/b.js").da.get(1), 4);
});

test("quietLines marks import / export-from / blank / comment / tag lines only", () => {
  const text = [
    "import {", "  a,", "  b", "} from './x.js';", // 1-4
    "import './a.css';", // 5
    "export * from './y';", // 6
    "export { a } from './z';", // 7
    "", // 8
    "// c", // 9
    " * doc", // 10
    "<script>", // 11
    "</template>", // 12
    "const x = import('./lazy');", // 13
    "export default {", // 14
    "};", // 15
  ].join("\n");
  const { quiet } = cov.quietLines(text);
  for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.strictEqual(quiet.get(n), "import", `line ${n}`);
  assert.strictEqual(quiet.get(8), "blank");
  assert.strictEqual(quiet.get(9), "comment");
  assert.strictEqual(quiet.get(10), "comment");
  assert.strictEqual(quiet.get(11), "tag");
  assert.strictEqual(quiet.get(12), "tag");
  assert.ok(!quiet.has(13));
  assert.ok(!quiet.has(14));
});

const VUE = [
  "<template>", // 1
  "  <div>x</div>", // 2
  "</template>", // 3
  "<script>", // 4
  "import {", // 5
  "  a,", // 6
  "} from './constants/k.js';", // 7
  "export default {", // 8
  "  f(x) { return x ? a : 2; },", // 9
  "};", // 10
  "</script>", // 11
].join("\n");

test("analyze: import-line arms are generated (the AmountAndMethod case)", () => {
  const r = rec({ lf: 3, lh: 3, fns: [{ line: 7, name: "_interopRequireDefault" }],
    brda: [{ line: 7, hits: 0 }, { line: 7, hits: 0 }, { line: 7, hits: 3 }, { line: 9, hits: 1 }, { line: 9, hits: 2 }] });
  const o = cov.analyze(r, VUE);
  assert.strictEqual(o.src_branches, 100);
  assert.ok(o.branches < 100, String(o.branches));
  assert.match(o.generated, /2 uncovered at 7 \(import\)/);
  assert.ok(!o.uncovered);
});

test("analyze: a real uncovered source arm stays a gap; helper and past-end arms are generated", () => {
  const r = rec({ fns: [{ line: 2, name: "_regeneratorDefine2" }],
    brda: [{ line: 9, hits: 1 }, { line: 9, hits: 0 }, { line: 2, hits: 0 }, { line: 99, hits: 0 }] });
  const o = cov.analyze(r, VUE);
  assert.deepStrictEqual(o.uncovered, [9]);
  assert.strictEqual(o.src_branches, 50);
  assert.match(o.generated, /2 \(helper\)/);
  assert.match(o.generated, /99 \(past end\)/);
});

test("analyze with added lines: changed numbers and uncovered on those lines only", () => {
  const text = Array.from({ length: 10 }, (_, i) => `f${i}(a ? 1 : 2);`).join("\n");
  const da = new Map([[1, 0], [2, 0], [8, 1], [9, 1]]);
  const r = rec({ lf: 4, lh: 2, da, brda: [{ line: 1, hits: 0 }, { line: 8, hits: 1 }, { line: 9, hits: 1 }, { line: 9, hits: 0 }] });
  const o = cov.analyze(r, text, null, new Set([8, 9]));
  assert.deepStrictEqual(o.changed, { lines: 100, src_branches: 66.67 });
  assert.deepStrictEqual(o.uncovered, [9]);
  const e = cov.analyze(r, text, null, new Set());
  assert.deepStrictEqual(e.changed, { lines: 100, src_branches: 100 });
  assert.ok(!e.uncovered);
});

test("tool_limit: an SFC with a big <script> and a small LF; a plain .js has none", () => {
  const body = Array.from({ length: 80 }, (_, i) => `const v${i} = ${i};`);
  const sfc = ["<template>", "</template>", "<script>", ...body, "</script>"].join("\n");
  const r = rec({ lf: 5, lh: 5 });
  assert.match(cov.analyze(r, sfc).tool_limit, /source map has 5 of ~80 script lines; not a gap in the change/);
  assert.ok(!cov.analyze(r, body.join("\n")).tool_limit);
});

test("judge: whole file, changed lines, one miss → false", () => {
  assert.strictEqual(cov.judge({ a: { lines: 95, src_branches: 92 } }, 90), true);
  const c = { a: { lines: 61.11, src_branches: 40, changed: { lines: 100, src_branches: 100 } } };
  assert.strictEqual(cov.judge(c, 90), true);
  assert.strictEqual(c.a.bar_met, true);
  const m = { a: { lines: 100, src_branches: 100 }, b: { lines: 100, src_branches: 4.17 } };
  assert.strictEqual(cov.judge(m, 90), false);
  assert.strictEqual(m.b.bar_met, false);
});

function gitRepo() {
  const root = tmp();
  git(root, ["init", "-q"]);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/old.js"), "const a = 1;\nconst b = 2;\nmodule.exports = { a, b };\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  fs.appendFileSync(path.join(root, "src/old.js"), "function c(x) {\n  return x ? 1 : 2;\n}\n");
  fs.writeFileSync(path.join(root, "src/new.js"), "module.exports = (x) => (x ? 1 : 2);\n");
  return root;
}
function writeLcov(root, newHits) {
  const dir = cov.covDir(root, ".");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "lcov.info"), [
    "SF:src/old.js", "DA:1,0", "DA:2,0", "DA:5,2", "BRDA:5,0,0,1", "BRDA:5,0,1,1", "LF:3", "LH:1", "end_of_record",
    `SF:${path.join(root, "src", "new.js")}`, `DA:1,${newHits}`, `BRDA:1,0,0,${newHits}`, "BRDA:1,0,1,1", "LF:1", `LH:${newHits ? 1 : 0}`, "end_of_record",
  ].join("\n"));
}

test("collect + addedLines in a git repo: old file has changed, new file has not", (t) => {
  if (!hasGit) { t.skip("git not on PATH"); return; }
  const root = gitRepo();
  try {
    assert.deepStrictEqual([...cov.addedLines(root, "src/old.js")], [4, 5, 6]);
    assert.strictEqual(cov.addedLines(root, "src/new.js"), null);
    writeLcov(root, 0);
    const out = cov.collect(root, { ".": ["src/old.js", "src/new.js"] });
    assert.deepStrictEqual(out["src/old.js"].changed, { lines: 100, src_branches: 100 });
    assert.ok(out["src/new.js"], JSON.stringify(out));
    assert.ok(!("changed" in out["src/new.js"]));
    assert.strictEqual(out["src/new.js"].src_branches, 50);
  } finally { rm(root); }
});

function runCmd(argv) {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = function (s, ...rest) { if (/^\{/.test(String(s))) { out += s; return true; } return orig.call(this, s, ...rest); };
  try { return { code: cov.cmd(argv), o: JSON.parse(out) }; } finally { process.stdout.write = orig; }
}

test("cmd --json --bar: exit code follows bar_met; no data → note", (t) => {
  if (!hasGit) { t.skip("git not on PATH"); return; }
  const root = gitRepo();
  try {
    let r = runCmd(["--json", "--bar", "90", "--dir", root]);
    assert.strictEqual(r.code, 0);
    assert.match(r.o.note, /no coverage data/);
    writeLcov(root, 0);
    r = runCmd(["--json", "--bar", "90", "--dir", root]);
    assert.strictEqual(r.o.bar_met, false);
    assert.strictEqual(r.code, 1);
    writeLcov(root, 1);
    r = runCmd(["--json", "--bar", "90", "--dir", root]);
    assert.strictEqual(r.o.bar_met, true);
    assert.strictEqual(r.code, 0);
  } finally { rm(root); }
});
