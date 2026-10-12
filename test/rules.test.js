"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const rules = require("../bin/lib/rules.js");

const CLI = path.join(__dirname, "..", "bin", "lorc.js");

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-rules-"));
  const root = path.join(d, "proj");
  const home = path.join(d, "home");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  return { root, home, git };
}
const run = (e, ...a) => spawnSync(process.execPath, [CLI, "rules", ...a], { cwd: e.root, encoding: "utf8", env: { ...process.env, LORC_HOME: e.home } });

test("init writes the template; a second init exits 1 and keeps the file", () => {
  const e = repo();
  const r1 = run(e, "init");
  assert.strictEqual(r1.status, 0, r1.stderr);
  const f = path.join(e.root, "HOUSE-RULES.md");
  assert.match(fs.readFileSync(f, "utf8"), /^<!-- lorc-rules v1 -->/);
  fs.appendFileSync(f, "- mine\n");
  const before = fs.readFileSync(f, "utf8");
  const r2 = run(e, "init");
  assert.strictEqual(r2.status, 1);
  assert.strictEqual(fs.readFileSync(f, "utf8"), before);
});

test("house parses P0–P3 and an override id; the template is empty", () => {
  const e = repo();
  rules.init(e.root);
  const empty = rules.house(e.root, { home: e.home });
  assert.deepStrictEqual(empty.blocks, { P0: "", P1: "", P2: "", P3: "" });
  assert.deepStrictEqual(empty.overrides, []);
  fs.writeFileSync(path.join(e.root, "HOUSE-RULES.md"), "pre text OSC-01\n## P0\n- never touch db/\n## P1\n- test it\n### P2\n- named exports\n# P3\nOSC-07: end markers are fine here\n");
  const h = rules.house(e.root, { home: e.home });
  assert.strictEqual(h.blocks.P0, "- never touch db/");
  assert.strictEqual(h.blocks.P3, "OSC-07: end markers are fine here");
  assert.deepStrictEqual(h.overrides, ["OSC-07"]);
  assert.strictEqual(h.warn, false);
  assert.strictEqual(rules.house(repo().root), null);
});

test("buildCard: order, override removal, ui only for UI files, core part at most 2,560 B", () => {
  const e = repo();
  fs.writeFileSync(path.join(e.root, "HOUSE-RULES.md"), "## P0\n- never touch db/\n## P2\nOSC-07: fine\n");
  const r = rules.buildCard(e.root, { files: ["src/a.js"], home: e.home });
  const text = fs.readFileSync(r.path, "utf8");
  assert.ok(r.path.endsWith(path.join(".claude", "lorc", "rules-card.md")));
  const iHouse = text.indexOf("## House rules (read first)");
  const iCard = text.indexOf("HOUSE RULES (standing");
  const iCode = text.indexOf("[Code]");
  assert.ok(iHouse === 0 && iHouse < iCard && iCard < iCode, "house rules, then the house card, then the packs");
  assert.ok(text.includes("OSD-"), "delivery pack present");
  assert.ok(/OSW-01/.test(text) && /OSW-23/.test(text));
  assert.ok(!/OSC-07 ·/.test(text), "overridden id dropped");
  assert.strictEqual(r.ui, false);
  assert.ok(!text.includes("OSU-"));
  assert.ok(r.core_bytes <= rules.CARD_CORE_MAX, `core part ${r.core_bytes} B`);
  const u = rules.buildCard(e.root, { files: ["src/App.vue"], home: e.home });
  assert.strictEqual(u.ui, true);
  assert.ok(fs.readFileSync(u.path, "utf8").includes("OSU-"));
  assert.ok(u.core_bytes <= rules.CARD_CORE_MAX, `core part with ui ${u.core_bytes} B`);
});

test("lint --diff: a banned phrase in a changed line; an overridden id is ignored", () => {
  const e = repo();
  fs.writeFileSync(path.join(e.root, "a.js"), "// it's worth noting this is old\nconst x = 1;\n");
  e.git(["add", "-A"]); e.git(["commit", "-q", "-m", "base"]);
  fs.writeFileSync(path.join(e.root, "a.js"), "// it's worth noting this is old\nconst x = 1;\n// at the end of the day it works\n// TODO: fix this\n");
  const f = rules.lint(e.root, { diff: true, home: e.home });
  assert.ok(f.some((x) => x.id === "OSW-11" && x.file === "a.js" && x.line === 3), JSON.stringify(f));
  assert.ok(!f.some((x) => x.file === "a.js" && x.line === 1), "unchanged line not reported");
  assert.ok(f.some((x) => x.id === "OSC-05"));
  fs.writeFileSync(path.join(e.root, "HOUSE-RULES.md"), "## P1\nOSC-05: vague TODOs are fine\n");
  const g = rules.lint(e.root, { diff: true, home: e.home });
  assert.ok(!g.some((x) => x.id === "OSC-05"));
  assert.ok(g.some((x) => x.id === "OSW-11"));
});

test("0.1.5: CLAUDE.md P0 headings and a # P0 section's bullets go into the card, capped", () => {
  const e = repo();
  fs.writeFileSync(path.join(e.root, "CLAUDE.md"), [
    "# CLAUDE.md", "", "# P0", "- bump the version", "- update the README", "",
    "## Other", "text", "",
    "### P0.4 — Tests with ≥ 90% coverage", "", "Drive that file to > 90 % line and branch coverage.", "Use jest.", "Third line is not kept.",
    "### P1 — style", "not P0",
  ].join("\n"));
  const r = rules.buildCard(e.root, { home: e.home });
  const md = fs.readFileSync(r.path, "utf8");
  assert.ok(md.includes("## Project P0 rules (CLAUDE.md)"));
  assert.ok(md.includes("- P0: bump the version"));
  assert.ok(md.includes("- P0.4 — Tests with ≥ 90% coverage — Drive that file to > 90 % line and branch coverage. Use jest."));
  assert.ok(!md.includes("Third line") && !md.includes("not P0"));
  assert.ok(md.indexOf("## Project P0") < md.indexOf("## lorc rules"));
  assert.ok(r.core_bytes <= rules.CARD_CORE_MAX);
  console.log("card bytes:", r.bytes, "p0 bytes:", Buffer.byteLength(rules.projectP0(e.root)));
  const many = ["# P0", ...Array.from({ length: 80 }, (_, i) => `- rule ${i} ${"x".repeat(30)}`)].join("\n");
  fs.writeFileSync(path.join(e.root, "CLAUDE.md"), many);
  const p0 = rules.projectP0(e.root);
  assert.ok(Buffer.byteLength(p0) <= rules.P0_MAX);
  assert.match(p0, /\(\+\d+ more in CLAUDE\.md\)$/);
});
