"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { repo } = require("./prep-fixture.js");
const runs = require("../bin/lib/runs.js");

function started(e) {
  return runs.startRun(e.root, { request: "add subtract", now: Date.UTC(2026, 9, 11, 9, 30) }).slug;
}

test("stdin JSON → slice file ≤ 24,576 B with every section; a missing file is create", () => {
  const e = repo();
  e.lorc(["graph", "update", "--json"]);
  const slug = started(e);
  const input = JSON.stringify({ title: "Add subtract", files: ["src/math.js", "src/sub.js"], focus: "add math", accept: ["subtract(3,1) is 2", "add still works"], notes: "keep CommonJS" });
  const r = e.lorc(["slice", "--run", slug, "--task", "1", "-"], input);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.ok(o.path.endsWith(path.join(slug, "slice-1.md")));
  assert.ok(o.bytes <= 24576);
  assert.strictEqual(typeof o.trimmed, "boolean");
  const md = fs.readFileSync(o.path, "utf8");
  assert.strictEqual(Buffer.byteLength(md), o.bytes);
  for (const h of ["# Slice 1 — Add subtract", "## Task", "## Acceptance", "## Files", "## Code pattern (", "### Invariants (never break)", "## Rules", "## Commands", "## Return"]) {
    assert.ok(md.includes(h), `missing ${h}`);
  }
  assert.ok(md.includes("- src/math.js (modify)"));
  assert.ok(md.includes("- src/sub.js (create)"));
  assert.ok(md.includes("- subtract(3,1) is 2"));
  assert.ok(md.includes("keep CommonJS"));
  assert.ok(md.includes('"files_changed"'));
  assert.ok(md.includes("## Graph anchors"), md);
  assert.ok(/node --test .*test\/math\.test\.js/.test(md), md);
  const run = JSON.parse(fs.readFileSync(path.join(runs.runDir(e.root, slug), "run.json"), "utf8"));
  assert.strictEqual(run.tasks.length, 1);
  assert.deepStrictEqual([run.tasks[0].n, run.tasks[0].title], [1, "Add subtract"]);
  assert.deepStrictEqual(run.tasks[0].files, ["src/math.js", "src/sub.js"]);
});

test("missing files → exit 2", () => {
  const e = repo();
  const slug = started(e);
  const r = e.lorc(["slice", "--run", slug, "--task", "1", "-"], JSON.stringify({ title: "x" }));
  assert.strictEqual(r.status, 2);
  const r2 = e.lorc(["slice", "--run", slug, "--task", "1", "-"], JSON.stringify({ files: ["a.js"] }));
  assert.strictEqual(r2.status, 2);
});

test("the return shape equals the executor template's", () => {
  const tpl = fs.readFileSync(path.join(__dirname, "..", "agents-src", "executor.template.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(tpl.includes(require("../bin/lib/slice.js").RETURN_SHAPE));
});

test("refs → a 'Model on these' section after Files; a missing ref is dropped", () => {
  const e = repo();
  e.lorc(["graph", "update", "--json"]);
  const slug = started(e);
  const input = JSON.stringify({ title: "Add subtract", files: ["src/sub.js"], refs: ["src/math.js:1-5 — same export style", "src/nope.js:3-9"] });
  const r = e.lorc(["slice", "--run", slug, "--task", "1", "-"], input);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepStrictEqual(o.refs_dropped, ["src/nope.js:3-9"]);
  const md = fs.readFileSync(o.path, "utf8");
  const i = md.indexOf("## Model on these (read them first — they are the closest existing code)");
  assert.ok(i > md.indexOf("## Files"), md);
  assert.ok(md.includes("- src/math.js:1-5 — same export style"));
  assert.ok(!md.includes("nope.js"));
});

test("facts[] render as Known facts right after the task", () => {
  const e = repo();
  e.lorc(["graph", "update", "--json"]);
  const slug = started(e);
  const input = JSON.stringify({ title: "Add subtract", files: ["src/math.js"], accept: ["x"], notes: "keep CommonJS", facts: ["add lives in src/math.js", "exports use module.exports"] });
  const r = e.lorc(["slice", "--run", slug, "--task", "1", "-"], input);
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(JSON.parse(r.stdout).path, "utf8");
  const k = md.indexOf("## Known facts (the orchestrator already read these");
  assert.ok(k > md.indexOf("## Task") && k < md.indexOf("## Acceptance"), md);
  assert.ok(md.includes("- add lives in src/math.js"));
});

test("a ref range is inlined verbatim as a fenced block", () => {
  const e = repo();
  const slug = started(e);
  const src = fs.readFileSync(path.join(e.root, "src/math.js"), "utf8").replace(/\r\n/g, "\n").split("\n");
  const input = JSON.stringify({ title: "Add subtract", files: ["src/sub.js"], refs: ["src/math.js:1-2 — same style", "src/math.js — path only"] });
  const r = e.lorc(["slice", "--run", slug, "--task", "1", "-"], input);
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(JSON.parse(r.stdout).path, "utf8");
  assert.ok(md.indexOf("## Reference code (verbatim — model your code on it; do not re-read these ranges)") > 0, md);
  assert.ok(md.includes("src/math.js:1-2\n```js\n" + src.slice(0, 2).join("\n") + "\n```"), md);
  assert.ok(md.includes("- src/math.js — path only"));
});

test("over budget: whole reference blocks drop, listed as not inlined", () => {
  const e = repo();
  const slug = started(e);
  const big = Array.from({ length: 400 }, (_, k) => `const v${k} = "${"x".repeat(40)}";`).join("\n") + "\n";
  fs.writeFileSync(path.join(e.root, "src/big.js"), big);
  const input = JSON.stringify({ title: "t", files: ["src/sub.js"], refs: ["src/big.js:1-200 — a", "src/big.js:201-400 — b"] });
  const r = e.lorc(["slice", "--run", slug, "--task", "1", "-"], input);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.ok(o.bytes <= 24576);
  const md = fs.readFileSync(o.path, "utf8");
  assert.ok(md.includes("src/big.js:1-200\n```js\n"), md.slice(0, 500));
  assert.ok(md.includes('const v199 = "'));
  assert.ok(md.includes("- src/big.js:201-400 (not inlined)"), md);
  assert.ok(!md.includes('const v200 = "'));
});

test("0.1.5: coverage on (jest --coverage) → a coverage line per task file; off → none", () => {
  const os = require("os");
  const slice = require("../bin/lib/slice.js");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-cov-"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "jest --coverage" }, devDependencies: { jest: "1" } }));
  const on = slice.commandsPart(d, ["src/a.js", "src/b.js"]);
  assert.match(on, /- coverage: npx jest --silent --coverage --coverageReporters=json-summary --coverageReporters=lcovonly "?--coverageDirectory=[^ ]+ "?--collectCoverageFrom=src\/a\.js"? "?--collectCoverageFrom=src\/b\.js"? then \x60lorc cov --bar /);
  assert.ok(on.includes("SOURCE branches"), on);
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "jest" }, devDependencies: { jest: "1" } }));
  assert.ok(!slice.commandsPart(d, ["src/a.js"]).includes("- coverage:"));
  assert.ok(slice.RETURN_SHAPE.includes('"coverage":{"<file>"') && slice.RETURN_SHAPE.includes('"coverage_bar_met"'));
  assert.ok(slice.RETURN_SHAPE.includes('"src_branches"'));
});
