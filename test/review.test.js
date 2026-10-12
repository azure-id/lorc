"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { repo } = require("./prep-fixture.js");
const runs = require("../bin/lib/runs.js");

function setup() {
  const e = repo();
  const slug = runs.startRun(e.root, { request: "review" }).slug;
  runs.addTask(e.root, slug, { n: 1, title: "t", files: ["src/math.js"], accept: ["add stays pure"] });
  return { e, slug };
}
const review = (e, slug, more = []) => {
  const r = e.lorc(["review", "prep", "--run", slug, "--json", ...more]);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  return { o, md: fs.readFileSync(o.path, "utf8") };
};

test("small diff → every hunk, dispatch false under auto", () => {
  const { e, slug } = setup();
  e.write("src/math.js", "function add(a, b) {\n  return b + a;\n}\nmodule.exports = { add };\n");
  const { o, md } = review(e, slug);
  assert.strictEqual(o.dispatch, false);
  assert.ok(o.reason.startsWith("auto"));
  assert.strictEqual(o.files, 1);
  assert.ok(o.changed_lines >= 2);
  for (const h of ["## Acceptance", "## Lint", "## Changed symbols", "## Hunks"]) assert.ok(md.includes(h), h);
  assert.ok(md.includes("[1] add stays pure"));
  assert.ok(md.includes("+  return b + a;"));
  assert.ok(!md.includes("not shown"));
  assert.ok(!md.includes("## Gotchas"));
});

test("review_agent_min_lines 50 + a 60-line diff → dispatch true with reason", () => {
  const { e, slug } = setup();
  e.lorc(["settings", "set", "review_agent_min_lines", "50"]);
  e.write("src/big.js", Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n");
  const { o } = review(e, slug);
  assert.strictEqual(o.dispatch, true);
  assert.ok(o.reason.includes("review_agent_min_lines 50"), o.reason);
});

test("a file named auth.js → dispatch true", () => {
  const { e, slug } = setup();
  e.write("src/auth.js", "module.exports = 1;\n");
  const { o } = review(e, slug);
  assert.strictEqual(o.dispatch, true);
  assert.ok(o.reason.includes("src/auth.js"), o.reason);
});

test("--tier complex and settings review agent/inline", () => {
  const { e, slug } = setup();
  e.write("src/math.js", "module.exports = {};\n");
  assert.strictEqual(review(e, slug, ["--tier", "complex"]).o.dispatch, true);
  e.lorc(["settings", "set", "review", "inline"]);
  assert.strictEqual(review(e, slug, ["--tier", "complex"]).o.dispatch, false);
});

test("a gotcha whose scope matches a changed file is in the packet (gotchas.md is read only)", () => {
  const { e, slug } = setup();
  const g = [
    "# Gotchas", "",
    "## G-001 · js · repair", "- trigger:   math", "- symptom:   wrong sum", "- cause:     order", "- fix:       keep a + b",
    "- scope:     src/**/*.js", "- origin:    x", "- hits:      1", "- last_seen: 01-10-2026", "",
    "## G-002 · py · repair", "- trigger:   y", "- symptom:   y", "- cause:     y", "- fix:       y",
    "- scope:     api/**/*.py", "- origin:    y", "- hits:      1", "- last_seen: 01-10-2026", "",
  ].join("\n");
  e.write(".claude/orc/gotchas.md", g);
  e.write("src/math.js", "module.exports = {};\n");
  const { md } = review(e, slug);
  assert.ok(md.includes("## Gotchas"));
  assert.ok(md.includes("G-001"));
  assert.ok(!md.includes("G-002"));
  assert.strictEqual(fs.readFileSync(path.join(e.root, ".claude", "orc", "gotchas.md"), "utf8"), g);
});

test("a big diff shows only flagged hunks and lists the rest", () => {
  const { e, slug } = setup();
  for (let i = 0; i < 8; i++) e.write(`src/blob${i}.txt`, "x".repeat(80).concat("\n").repeat(60));
  const { md } = review(e, slug);
  assert.ok(md.includes("(not shown)"));
  assert.ok(Buffer.byteLength(md) < 40 * 1024);
});
