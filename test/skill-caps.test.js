"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { VARIANTS } = require("../scripts/build-agents.js");

const ROOT = path.join(__dirname, "..");
const T = (...p) => path.join(ROOT, "templates", ...p);
const SKILL = T("skills", "lorc", "SKILL.md");
const REFS = T("skills", "lorc", "references");
const REVIEWER = T("agents", "lorc-reviewer-opus-5-low.md");
const SKILL_COMMANDS = ["prep", "read", "graph", "slice", "check", "review", "run", "usage", "wait", "jev"];

const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const size = (f) => Buffer.byteLength(read(f));
const list = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((n) => re.test(n)).map((n) => path.join(dir, n));
function front(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  const o = {};
  if (m) for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return o;
}
const executors = () => list(T("agents"), /^lorc-executor-.*\.md$/).concat(list(T("agents-all"), /\.md$/));
const refs = () => list(REFS, /\.md$/);

test("SKILL.md fits 8,192 bytes and has name + description", () => {
  assert.ok(size(SKILL) <= 8192, `SKILL.md is ${size(SKILL)} B`);
  const f = front(read(SKILL));
  assert.strictEqual(f.name, "lorc");
  assert.ok(f.description);
});

test("W20b: SKILL.md reads context.path first; slice adds context + doc; must_ask options", () => {
  const s = read(SKILL);
  assert.ok(!s.includes("Start with ONE `lorc graph ctx`"));
  assert.ok(s.includes("options = its `seen[].v`"));
  assert.ok(s.includes("The slice adds the task's context items and the requirement doc by itself"));
  assert.ok(size(SKILL) <= 8192);
  for (const f of executors()) assert.ok(read(f).includes("Never open the requirement file again"), f);
});

test("each reference fits 4,096 bytes", () => {
  assert.ok(refs().length > 0);
  for (const f of refs()) assert.ok(size(f) <= 4096, `${f} is ${size(f)} B`);
});

test("executors fit 5,120 bytes, reviewer fits 4,096", () => {
  assert.ok(executors().length > 0);
  for (const f of executors()) assert.ok(size(f) <= 5120, `${f} is ${size(f)} B`);
  assert.ok(size(REVIEWER) <= 4096);
});

test("agent frontmatter: name, description, model, tools", () => {
  const ids = new Set(VARIANTS.map((v) => v.model));
  for (const f of executors().concat([REVIEWER])) {
    const fm = front(read(f));
    assert.strictEqual(fm.name, path.basename(f, ".md"), f);
    assert.ok(fm.description && fm.description.length <= 200, `${f} description`);
    if (f === REVIEWER) assert.strictEqual(fm.model, "claude-opus-5-5");
    else assert.ok(ids.has(fm.model), `${f} model ${fm.model}`);
    assert.ok(fm.tools, `${f} tools`);
  }
});

test("build-agents --check exits 0", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build-agents.js"), "--check"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
});

test("the skill names only lorc commands that exist", () => {
  for (const f of [SKILL].concat(refs())) {
    // "/lorc <arg>" is the slash command, not the CLI: skip it.
    for (const m of read(f).matchAll(/(?<![\w/-])lorc ([a-z][\w-]*)/g)) {
      assert.ok(SKILL_COMMANDS.includes(m[1]), `${path.basename(f)} names "lorc ${m[1]}"`);
    }
  }
});

test("every agent SKILL.md names exists", () => {
  const names = new Set(read(SKILL).match(/lorc-(?:executor-[a-z0-9-]*[a-z0-9]|reviewer-opus-5-low)/g) || []);
  assert.ok(names.size > 0);
  for (const n of names) assert.ok(fs.existsSync(T("agents", `${n}.md`)), `${n} missing`);
});

// W9: /lorc-wiki + /lorc-pattern.
const W9_SKILLS = [
  { file: T("skills", "lorc-pattern", "SKILL.md"), name: "lorc-pattern", cap: 6144 },
  { file: T("skills", "lorc-wiki", "SKILL.md"), name: "lorc-wiki", cap: 8192 },
];
const W9_AGENTS = ["lorc-wiki-scanner-sonnet-5-high", "lorc-wiki-scanner-opus-5-low", "lorc-pattern-codifier-sonnet-5-high"];
const W9_COMMANDS = SKILL_COMMANDS.concat(["wiki", "pattern"]);

test("W9 skills fit their caps and have name + description", () => {
  for (const s of W9_SKILLS) {
    assert.ok(size(s.file) <= s.cap, `${s.name} is ${size(s.file)} B`);
    const f = front(read(s.file));
    assert.strictEqual(f.name, s.name);
    assert.ok(f.description && f.description.length <= 1024);
  }
});

test("W9 agents: name = file name, description <= 200, valid model", () => {
  const ids = new Set(VARIANTS.map((v) => v.model).concat(["claude-opus-5-5", "claude-sonnet-5-5"]));
  for (const n of W9_AGENTS) {
    const fm = front(read(T("agents", `${n}.md`)));
    assert.strictEqual(fm.name, n);
    assert.ok(fm.description && fm.description.length <= 200, `${n} description`);
    assert.ok(ids.has(fm.model), `${n} model ${fm.model}`);
  }
});

test("W9 skills name only lorc commands that exist, and agents that exist", () => {
  for (const s of W9_SKILLS) {
    const text = read(s.file);
    for (const m of text.matchAll(/(?<![\w/-])lorc ([a-z][\w-]*)/g)) {
      assert.ok(W9_COMMANDS.includes(m[1]), `${s.name} names "lorc ${m[1]}"`);
    }
    for (const n of new Set(text.match(/lorc-(?:wiki-scanner|pattern-codifier)-[a-z0-9-]*[a-z0-9]/g) || [])) {
      assert.ok(fs.existsSync(T("agents", `${n}.md`)), `${n} missing`);
    }
  }
});

test("0.3.2: executor, reviewer and SKILL texts", () => {
  const ex = read(path.join(ROOT, "agents-src", "executor.template.md")).replace(/\s+/g, " ");
  assert.ok(ex.includes("Never delete, skip or weaken a failing test"));
  assert.ok(ex.includes("tool_limit"));
  assert.ok(read(REVIEWER).replace(/\s+/g, " ").includes("acceptance item that the code does not meet is P1"));
  assert.ok(read(SKILL).includes('A later "fix it"'));
});

test("0.3.3: SKILL asks must_ask items", () => {
  const s = fs.readFileSync(SKILL, "utf8");
  assert.ok(s.includes("must_ask[]") && s.includes("never your own pick"));
});

test("0.4.1: executor batches calls, writes whole files, reads ranges", () => {
  const ex = read(path.join(ROOT, "agents-src", "executor.template.md")).replace(/\s+/g, " ");
  assert.ok(ex.includes("Every message re-reads your whole context"));
  assert.ok(ex.includes("Write a new file complete in ONE Write"));
  assert.ok(ex.includes("A file over 150 lines: read only the range"));
  assert.ok(ex.includes("Never open the requirement file again"));
});

test("0.4.2: SKILL L1 and the executor start with ONE lorc read call", () => {
  const s = read(SKILL).replace(/\s+/g, " ");
  assert.ok(s.includes("After prep: `lorc read --run <slug>` (ONE call"));
  assert.ok(s.includes("Then dig only what it lacks (≤ 2 calls)"));
  assert.ok(!s.includes("Read `context.path` FIRST"));
  assert.ok(size(SKILL) <= 8192);
  const ex = read(path.join(ROOT, "agents-src", "executor.template.md")).replace(/\s+/g, " ");
  assert.ok(ex.includes("Start with ONE Read of the slice's read file"));
  for (const f of executors()) assert.ok(read(f).includes("slice's read file"), f);
});
