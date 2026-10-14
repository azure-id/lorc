"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { repo } = require("./prep-fixture.js");
const runs = require("../bin/lib/runs.js");

function setup() {
  const e = repo();
  e.lorc(["graph", "update", "--json"]);
  const slug = runs.startRun(e.root, { request: "check" }).slug;
  return { e, slug };
}

test("a failing node --test file → passed false, failed names it, tail, exit 1", () => {
  const { e, slug } = setup();
  e.write("test/math.test.js", "const test = require(\"node:test\");\nconst assert = require(\"node:assert\");\ntest(\"breaks on purpose\", () => { assert.strictEqual(1, 2); });\n");
  const r = e.lorc(["check", "--run", slug, "--json"]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.ok(Buffer.byteLength(r.stdout.trim()) <= 3000);
  const o = JSON.parse(r.stdout);
  const t = o.steps.find((s) => s.step === "tests");
  assert.strictEqual(t.passed, false);
  assert.ok(t.cmd.startsWith("node --test"), t.cmd);
  assert.ok(t.failed.some((n) => n.includes("breaks on purpose")), JSON.stringify(t.failed));
  assert.ok(t.tail && t.tail.split("\n").length <= 30);
  const run = JSON.parse(fs.readFileSync(path.join(runs.runDir(e.root, slug), "run.json"), "utf8"));
  assert.strictEqual(run.checks.length, 1);
  assert.strictEqual(run.checks[0].ok, false);
});

test("a source change reaches its test through the graph → pass, exit 0", () => {
  const { e, slug } = setup();
  e.write("src/math.js", "function add(a, b) {\n  return b + a;\n}\nmodule.exports = { add };\n");
  const r = e.lorc(["check", "--run", slug, "--json"]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const t = JSON.parse(r.stdout).steps.find((s) => s.step === "tests");
  assert.strictEqual(t.passed, true);
  assert.ok(t.cmd.includes("test/math.test.js"), t.cmd);
  assert.ok(!("tail" in t));
});

test("changed files skip .claude, lockfiles and node_modules", () => {
  const { e } = setup();
  e.write("package-lock.json", "{}");
  e.write("node_modules/x/index.js", "1");
  e.write("src/new.js", "1");
  const files = require("../bin/lib/check.js").changedFiles(e.root);
  assert.deepStrictEqual(files, ["src/new.js"]);
});

test("no changed files → one JSON object with a note, exit 0", () => {
  const { e, slug } = setup();
  const r = e.lorc(["check", "--run", slug, "--json"]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepStrictEqual(o.steps, []);
  assert.strictEqual(o.note, "no changed files");
});

test("--lint-only runs no tests; with no lint it still prints JSON", () => {
  const { e, slug } = setup();
  e.write("test/math.test.js", "require(\"node:test\")(\"x\", () => { throw new Error(\"no\"); });\n");
  const r = e.lorc(["check", "--run", slug, "--lint-only", "--json"]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const o = JSON.parse(r.stdout);
  assert.ok(!o.steps.some((s) => s.step === "tests" || s.step === "typecheck"), r.stdout);
});

test("fit() does not throw on a skipped step when the output is over the cap", () => {
  const { fit, MAX_BYTES } = require("../bin/lib/check.js");
  const out = fit({ ok: false, changed: 1, steps: [
    { step: "tests", skipped: "no test runner found", files: ["a.test.js"] },
    { step: "lint", cmd: "x".repeat(5000), exit: 1, passed: false, failed: [], tail: "y" },
  ] });
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= MAX_BYTES);
});

test("--lint-only --review → lint, trusted tests and the review packet in one call", () => {
  const { e, slug } = setup();
  e.write("src/math.js", "function add(a, b) {\n  return b + a;\n}\nmodule.exports = { add };\n");
  const r = e.lorc(["check", "--run", slug, "--lint-only", "--review", "--json"]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.tests, "trusted: executor reported green");
  assert.ok(!o.steps.some((s) => s.step === "tests"));
  assert.ok(o.review && fs.existsSync(o.review.path), r.stdout);
  assert.strictEqual(typeof o.review.dispatch, "boolean");
  assert.ok(o.review.reason && o.review.bytes > 0);
});

test("0.1.3: coverageOn reads the test script, package.json jest and jest.config", () => {
  const { coverageOn, coverageArgs } = require("../bin/lib/check.js");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-cov-"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  assert.strictEqual(coverageOn(d), false);
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "jest --coverage" } }));
  assert.strictEqual(coverageOn(d), true);
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "jest" }, jest: { collectCoverage: true } }));
  assert.strictEqual(coverageOn(d), true);
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  fs.writeFileSync(path.join(d, "jest.config.js"), "module.exports = { collectCoverage: true };");
  assert.strictEqual(coverageOn(d), true);
  assert.match(coverageArgs(["src/a.js"]), /--coverage .*--collectCoverageFrom=src\/a\.js/);
  assert.ok(coverageArgs(["src/a.js"]).includes("--coverageReporters=lcovonly"));
});

test("0.3.1: readCoverage reads lcov data → src_branches; no data → null", () => {
  const { readCoverage, covDir } = require("../bin/lib/check.js");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-rcov-"));
  try {
    fs.mkdirSync(path.join(d, "src"));
    fs.writeFileSync(path.join(d, "src/a.js"), "module.exports = (x) => (x ? 1 : 2);\n");
    const groups = { ".": ["src/a.js"] };
    assert.strictEqual(readCoverage(d, groups), null);
    fs.mkdirSync(covDir(d, "."), { recursive: true });
    fs.writeFileSync(path.join(covDir(d, "."), "lcov.info"), "SF:src/a.js\nDA:1,1\nBRDA:1,0,0,1\nBRDA:1,0,1,0\nLF:1\nLH:1\nend_of_record\n");
    const out = readCoverage(d, groups);
    assert.strictEqual(out["src/a.js"].src_branches, 50);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("0.1.6: tests in a sub-project folder run there (client/)", () => {
  const { e } = setup();
  e.write("client/package.json", JSON.stringify({ name: "c", scripts: { test: "node --test" } }));
  e.write("client/src/a.js", "module.exports = 1;\n");
  e.write("client/test/a.test.js", "const test = require(\"node:test\");\nconst assert = require(\"node:assert\");\ntest(\"client breaks\", () => { assert.strictEqual(1, 2); });\n");
  const r = e.lorc(["check", "--json"]);
  const o = JSON.parse(r.stdout);
  const t = o.steps.find((s) => s.step === "tests" && s.dir === "client");
  assert.ok(t && !t.skipped, r.stdout);
  assert.strictEqual(t.passed, false);
  assert.ok(t.cmd.includes("test/a.test.js") && !t.cmd.includes("client/"), t.cmd);
  const line = require("../bin/lib/slice.js").commandsPart(e.root, ["client/src/a.js", "client/test/a.test.js"])
    .split("\n").find((l) => l.startsWith("- tests for this task:"));
  assert.ok(line.includes("- tests for this task: cd client && "), line);
});
