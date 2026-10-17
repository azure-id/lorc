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

// W20b: the context section, the requirement doc and the derived focus.
const sliceLib = require("../bin/lib/slice.js");
const it = (kind, file, start, end, what, extra = {}) => Object.assign({ kind, file, start, end, what, why: kind }, extra);
function withPack(e, pack, opts = {}) {
  const slug = runs.startRun(e.root, { request: opts.request || "add subtract to math", doc: opts.doc, now: Date.UTC(2026, 9, 11, 9, 30) }).slug;
  fs.writeFileSync(path.join(runs.runDir(e.root, slug), "context.json"), JSON.stringify(pack));
  return slug;
}

test("MAX_BYTES is 32,768", () => {
  assert.strictEqual(sliceLib.MAX_BYTES, 32768);
});

test("context: task files first, refs, exemplars/tests/reuse only on create, entities by term", () => {
  const e = repo({ "src/other.js": "module.exports = {};\n", "src/ref.js": "module.exports = {};\n" });
  const pack = {
    targets: [it("route", "src/math.js", 1, 3, "add()", { code: "function add(a, b) {" }), it("route", "src/far.js", 1, 2, "far")],
    exemplars: [it("exemplar", "src/other.js", 1, 1, "other exemplar")],
    tests: [it("test", "test/math.test.js", 1, 4, "setup")],
    reuse: [it("reuse", "src/ref.js", 1, 1, "ref reuse")],
    entities: [{ name: "Subtract", type: "symbol", at: ["src/sub.js:1-2"] }, { name: "Nowhere", type: "symbol", at: ["src/x.js:1"] }],
  };
  const slug = withPack(e, pack);
  const modify = sliceLib.buildSlice(e.root, slug, "1", { title: "Change add", files: ["src/math.js"], refs: ["src/ref.js:1-1"] });
  const md = fs.readFileSync(modify.path, "utf8");
  assert.ok(md.includes("## Context (request, doc and graph) — read these ranges with offset/limit, never whole files"), md);
  const ctx = md.split("## Context (")[1].split("\n## ")[0];
  assert.ok(ctx.includes("src/math.js:1-3 — add()") && ctx.includes("function add(a, b) {"));
  assert.ok(ctx.includes("src/ref.js:1 — ref reuse"), "ref file");
  assert.ok(/## Read first — ONE call\nRead .+read-1\.md \(ONE Read call, \d+ B\)/.test(md), md);
  assert.ok(!ctx.includes("src/far.js") && !ctx.includes("other exemplar") && !ctx.includes("Subtract"), ctx);
  const create = sliceLib.buildSlice(e.root, slug, "2", { title: "Add subtract", files: ["src/sub.js"] });
  const c2 = fs.readFileSync(create.path, "utf8").split("## Context (")[1].split("\n## ")[0];
  // 0.4.2: the plan prints the test setup, so its Context line goes.
  assert.ok(c2.includes("other exemplar") && !c2.includes("test/math.test.js:1-4") && c2.includes("ref reuse"), c2);
  assert.ok(fs.readFileSync(create.path, "utf8").includes("math.test.js:1-4"));
  assert.ok(c2.includes("src/sub.js:1-2 — Subtract (symbol)") && !c2.includes("Nowhere"), c2);
  assert.ok(c2.indexOf("other exemplar") < c2.indexOf("ref reuse") && c2.indexOf("ref reuse") < c2.indexOf("Subtract"));
});

test("context: the section keeps ≤ 7,000 B; inline code ≤ 2,500 B", () => {
  const e = repo();
  const code = "x".repeat(900);
  const targets = Array.from({ length: 80 }, (_, i) => it("route", "src/math.js", i + 1, i + 1, "w".repeat(120), { code }));
  const slug = withPack(e, { targets });
  const r = sliceLib.buildSlice(e.root, slug, "1", { title: "Change add", files: ["src/math.js"] });
  const md = fs.readFileSync(r.path, "utf8");
  const sec = "## Context (" + md.split("## Context (")[1].split("\n## ")[0];
  assert.ok(Buffer.byteLength(sec) <= 7000, `context ${Buffer.byteLength(sec)} B`);
  assert.ok(Buffer.byteLength(sec) > 5000);
  const codeB = (sec.match(/```\n[\s\S]*?\n```/g) || []).reduce((n, b) => n + Buffer.byteLength(b) + 1, 0);
  assert.ok(codeB > 0 && codeB <= 2500, `code ${codeB} B`);
});

test("requirement: a doc ≤ 8,192 B is inlined and dropped from refs; bigger → path + headings", () => {
  const e = repo({ "docs/req.md": "# Title\n\nSome text.\n## Step 1\nAmount.\n", "docs/big.md": "# Big\n" + "line of text\n".repeat(800) + "## Part 2\nend\n" });
  const small = withPack(e, {}, { doc: "docs/req.md" });
  const a = fs.readFileSync(sliceLib.buildSlice(e.root, small, "1", { title: "Do it", files: ["src/math.js"], refs: ["docs/req.md — the requirement", "src/math.js:1-2"] }).path, "utf8");
  assert.ok(a.includes("## Requirement (verbatim — do not open the file again)") && a.includes("## Step 1\nAmount."), a);
  assert.ok(!/^- docs\/req\.md/m.test(a), "doc not in refs");
  assert.ok(/^- src\/math\.js:1-2/m.test(a));
  const big = withPack(e, {}, { doc: "docs/big.md" });
  const b = fs.readFileSync(sliceLib.buildSlice(e.root, big, "1", { title: "Do it", files: ["src/math.js"] }).path, "utf8");
  assert.ok(!b.includes("## Requirement (verbatim"));
  assert.ok(b.includes("docs/big.md") && b.includes("- 1: # Big") && b.includes("- 802: ## Part 2"), b);
});

test("derived focus: title words + basenames + request words, verbs dropped, ≤ 8", () => {
  const f = sliceLib.deriveFocus("Build the transfer stepper", ["src/views/TransferFund.vue"], "create outward remittance route shell with amount method fund button");
  const w = f.split(",");
  assert.ok(w.length <= 8);
  assert.deepStrictEqual(w.slice(0, 3), ["transfer", "stepper", "TransferFund"]);
  assert.ok(!w.includes("build") && !w.includes("create"));
});

test("0.4.1: a long ref with no range gets the card's range, or a read-a-range note", () => {
  const long = Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";
  const e = repo({ "src/Big.vue": long, "src/Other.vue": long, "src/small.js": "module.exports = {};\n" });
  const pack = { exemplars: [it("exemplar", "src/Big.vue", 1, 200, "template 1-147 · methods: data 210, countryOptions 247")] };
  const slug = withPack(e, pack);
  const r = sliceLib.buildSlice(e.root, slug, "1", { title: "Change add", files: ["src/math.js"], refs: ["src/Big.vue — the form", "src/Other.vue", "src/small.js"] });
  const md = fs.readFileSync(r.path, "utf8");
  assert.ok(md.includes("- src/Big.vue:1-147 — the form (card: template 1-147 · methods: data 210, countryOptions 247)"), md);
  assert.ok(md.includes("- src/Other.vue (200 lines — read a range, not the whole file)"), md);
  assert.ok(md.includes("- src/small.js\n") || md.includes("- src/small.js\r\n"), md);
  assert.ok(!md.includes("// line 150"), "no inlined code");
});
