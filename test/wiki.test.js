"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const wiki = require("../bin/lib/wiki.js");

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-wiki-"));
  const root = path.join(d, "proj");
  const home = path.join(d, "home");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(root, "src", "a.js"), "module.exports = 1;\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "base"]);
  return { d, root, home, git };
}

function addWiki(e) {
  const head = e.git(["rev-parse", "HEAD"]).stdout.trim();
  fs.mkdirSync(path.join(e.root, "wiki"), { recursive: true });
  fs.writeFileSync(path.join(e.root, "wiki", "orc-feature-billing.md"), [
    "---", "wiki_schema: 2", "doc_type: feature", "area: billing", "covers: [src/a.js]",
    "keywords: [billing, invoice]", "scanned_at: 010126 00:00:00", `scanned_commit: ${head}`,
    "covered_files:", "  src/a.js: abc123", "status: fresh", "---", "", "# Billing Overview", "",
  ].join("\n"));
  fs.mkdirSync(path.join(e.root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(e.root, ".claude", "orc.config.yaml"), "wiki_fresh_max: 1\nwiki_aging_max: 2\n");
  assert.ok(wiki.sync(e.root, { home: e.home }).ok);
}

function touch(e, n) {
  fs.writeFileSync(path.join(e.root, "src", "a.js"), `module.exports = ${n};\n`);
  e.git(["add", "src/a.js"]); e.git(["commit", "-q", "-m", "c" + n]);
}

test("no wiki → state none", () => {
  const e = repo();
  const s = wiki.status(e.root, { home: e.home });
  assert.deepStrictEqual([s.state, s.tier, s.source], ["none", null, "own"]);
});

test("registered wiki: FRESH, then AGING and STALE on commits to a covered file", () => {
  const e = repo();
  addWiki(e);
  const s = wiki.status(e.root, { home: e.home });
  assert.strictEqual(s.state, "registered");
  assert.strictEqual(s.docs, 1);
  assert.strictEqual(s.tier, "FRESH");
  touch(e, 2);
  assert.strictEqual(wiki.status(e.root, { home: e.home }).tier, "AGING");
  touch(e, 3); touch(e, 4);
  assert.strictEqual(wiki.status(e.root, { home: e.home }).tier, "STALE");
});

test("pick: a path for a matching word, [] for a nonsense word", () => {
  const e = repo();
  addWiki(e);
  assert.deepStrictEqual(wiki.pick(e.root, "fix the billing invoice total", { home: e.home }), ["wiki/orc-feature-billing.md"]);
  assert.deepStrictEqual(wiki.pick(e.root, "zzqx frobnicate", { home: e.home }), []);
});

test("commands: from wiki-meta, else from package.json", () => {
  const e = repo();
  fs.writeFileSync(path.join(e.root, "package.json"), JSON.stringify({ scripts: { build: "x", "test:unit": "y", "type-check": "z" } }));
  assert.deepStrictEqual(wiki.commands(e.root), { build: "npm run build", test: "npm run test:unit", lint: null, typecheck: "npm run type-check" });
  fs.mkdirSync(path.join(e.root, ".claude", "orc"), { recursive: true });
  fs.writeFileSync(path.join(e.root, ".claude", "orc", "wiki-meta.json"), JSON.stringify({ commands: { build: "make", test_fast: "make test" } }));
  assert.deepStrictEqual(wiki.commands(e.root), { build: "make", test: "make test", lint: null, typecheck: null });
});

function fakeOrc(e, body) {
  const cli = path.join(e.d, "fake-orc.js");
  fs.writeFileSync(cli, body);
  fs.mkdirSync(path.join(e.root, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(e.root, ".claude", "hooks", "orc-version.json"), JSON.stringify({ version: "2.3.0", cli }));
}

test("delegate: status comes from the ORC cli", () => {
  const e = repo();
  fakeOrc(e, "process.stdout.write(JSON.stringify({state:'registered',tier:'AGING',docs:4}));");
  assert.deepStrictEqual(wiki.status(e.root, { home: e.home }), { state: "registered", tier: "AGING", docs: 4, source: "orc" });
});

test("delegate failure → own path + fallback", () => {
  const e = repo();
  fakeOrc(e, "process.exit(5);");
  const s = wiki.status(e.root, { home: e.home });
  assert.strictEqual(s.source, "own");
  assert.strictEqual(s.state, "none");
  assert.ok(s.fallback);
});

test("state words are ORC's, verbatim: unregistered, then registered after sync, drifted on a new page", () => {
  const e = repo();
  fs.mkdirSync(path.join(e.root, "wiki"), { recursive: true });
  const head = e.git(["rev-parse", "HEAD"]).stdout.trim();
  const page = (name, area) => fs.writeFileSync(path.join(e.root, "wiki", name), [
    "---", "wiki_schema: 2", "doc_type: feature", `area: ${area}`, "covers: [src/a.js]",
    `keywords: [${area}]`, "scanned_at: 010126 00:00:00", `scanned_commit: ${head}`,
    "covered_files:", "  src/a.js: abc123", "status: fresh", "---", "", `# ${area}`, "",
  ].join("\n"));
  page("orc-feature-billing.md", "billing");
  const s1 = wiki.status(e.root, { home: e.home });
  assert.strictEqual(s1.state, "unregistered");
  assert.strictEqual(s1.tier, null);
  assert.ok(wiki.sync(e.root, { home: e.home }).ok);
  assert.strictEqual(wiki.status(e.root, { home: e.home }).state, "registered");
  page("orc-feature-orders.md", "orders");
  assert.strictEqual(wiki.status(e.root, { home: e.home }).state, "drifted");
});

test("delegate state word passes through", () => {
  const e = repo();
  fakeOrc(e, "process.stdout.write(JSON.stringify({state:'drifted',tier:'FRESH',docs:2}));");
  const s = wiki.status(e.root, { home: e.home });
  assert.strictEqual(s.state, "drifted");
  assert.strictEqual(s.tier, null);
});
