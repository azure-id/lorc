"use strict";
// W19c: `detect` reads `.git/index` directly. In every case its result must
// equal the git-based path (`viaGit`), and odd entries must fall back to git.
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

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-gdet-"));
  temps.push(d);
  const root = path.join(d, "proj");
  fs.mkdirSync(root, { recursive: true });
  const git = (...a) => {
    const r = spawnSync("git", a, { cwd: root, encoding: "utf8" });
    return r;
  };
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  write(path.join(root, "src/a.js"), "function a() {}\n");
  write(path.join(root, "src/b.js"), "function b() {}\n");
  write(path.join(root, "src/my file ü.js"), "function u() {}\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { root, git };
}

const plain = (d) => ({ ok: d.ok, files: [...d.files], langs: [...d.langs], head: d.head });
function same(root) {
  assert.deepStrictEqual(plain(G.detect(root, {})), plain(G.detect(root, { viaGit: true })));
}
const reader = (root) => G._readGitIndex(G._gitDirOf(root));

test("plain repo, unicode name: reader is used and equals git", () => {
  const { root } = repo();
  assert.ok(reader(root));
  same(root);
});

test("index version 4", () => {
  const { root, git } = repo();
  git("update-index", "--index-version", "4");
  assert.ok(reader(root));
  same(root);
});

test("staged new file, modified unstaged file, untracked file", () => {
  const { root, git } = repo();
  write(path.join(root, "src/new.js"), "function n() {}\n");
  git("add", "src/new.js");
  fs.appendFileSync(path.join(root, "src/a.js"), "// x\n");
  write(path.join(root, "src/untracked.js"), "function t() {}\n");
  assert.ok(reader(root));
  same(root);
});

test("skip-worktree falls back to git", () => {
  const { root, git } = repo();
  git("update-index", "--skip-worktree", "src/b.js");
  assert.strictEqual(reader(root), null);
  same(root);
});

test("intent-to-add falls back to git", () => {
  const { root, git } = repo();
  write(path.join(root, "src/ita.js"), "function i() {}\n");
  git("add", "-N", "src/ita.js");
  assert.strictEqual(reader(root), null);
  same(root);
});

test("merge conflict (stages 1-3) falls back to git", () => {
  const { root, git } = repo();
  const main = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  git("checkout", "-q", "-b", "other");
  write(path.join(root, "src/a.js"), "function a() { return 1; }\n");
  git("commit", "-q", "-am", "other");
  git("checkout", "-q", main);
  write(path.join(root, "src/a.js"), "function a() { return 2; }\n");
  git("commit", "-q", "-am", "main");
  git("merge", "-q", "other");
  assert.strictEqual(reader(root), null);
  same(root);
});
