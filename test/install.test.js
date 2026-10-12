"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { install } = require("../bin/lib/install.js");

function fakePkg() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-inst-"));
  const pkgRoot = path.join(base, "pkg");
  const put = (rel, text) => {
    const f = path.join(pkgRoot, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  put("package.json", JSON.stringify({ version: "9.9.9" }));
  put("templates/skills/lorc/SKILL.md", "skill");
  put("templates/agents/lorc-exec.md", "agent");
  put("templates/hooks/lorc-graph-hook.js", "hook");
  put("templates/commands/lorc.md", "cmd");
  return { pkgRoot, claudeDir: path.join(base, "proj", ".claude"), put };
}
const hookCount = (cd) => {
  const h = JSON.parse(fs.readFileSync(path.join(cd, "settings.json"), "utf8")).hooks;
  return Object.values(h).reduce((n, l) => n + l.length, 0);
};

test("install copies, writes manifest + version, wires 2 hooks, dedupes", () => {
  const p = fakePkg();
  const r = install({ claudeDir: p.claudeDir, overwrite: false, pkgRoot: p.pkgRoot });
  assert.strictEqual(r.copied, 4);
  assert.strictEqual(r.hooks, 2);
  assert.ok(fs.existsSync(path.join(p.claudeDir, "skills", "lorc", "SKILL.md")));
  const m = JSON.parse(fs.readFileSync(path.join(p.claudeDir, "lorc", "install-manifest.json"), "utf8"));
  assert.deepStrictEqual(m, { version: "9.9.9", files: ["agents/lorc-exec.md", "commands/lorc.md", "hooks/lorc-graph-hook.js", "skills/lorc/SKILL.md"] });
  const v = JSON.parse(fs.readFileSync(path.join(p.claudeDir, "lorc", "version.json"), "utf8"));
  assert.strictEqual(v.version, "9.9.9");
  assert.ok(v.installed_at);
  const s = JSON.parse(fs.readFileSync(path.join(p.claudeDir, "settings.json"), "utf8"));
  assert.strictEqual(s.hooks.PreToolUse[0].matcher, "Grep|Glob");
  assert.match(s.hooks.SubagentStop[0].hooks[0].command, /^node ".*\/hooks\/lorc-graph-hook\.js"$/);
  assert.ok(!s.statusLine);
  assert.strictEqual(hookCount(p.claudeDir), 2);
  const r2 = install({ claudeDir: p.claudeDir, overwrite: true, pkgRoot: p.pkgRoot });
  assert.strictEqual(r2.hooks, 0);
  assert.strictEqual(hookCount(p.claudeDir), 2);
});

test("init keeps a changed file, update overwrites it", () => {
  const p = fakePkg();
  install({ claudeDir: p.claudeDir, pkgRoot: p.pkgRoot });
  const f = path.join(p.claudeDir, "commands", "lorc.md");
  fs.writeFileSync(f, "mine");
  const r = install({ claudeDir: p.claudeDir, overwrite: false, pkgRoot: p.pkgRoot });
  assert.strictEqual(r.kept, 4);
  assert.strictEqual(fs.readFileSync(f, "utf8"), "mine");
  install({ claudeDir: p.claudeDir, overwrite: true, pkgRoot: p.pkgRoot });
  assert.strictEqual(fs.readFileSync(f, "utf8"), "cmd");
});

test("prune removes a dropped payload file only", () => {
  const p = fakePkg();
  p.put("templates/skills/lorc-old/SKILL.md", "old");
  install({ claudeDir: p.claudeDir, pkgRoot: p.pkgRoot });
  fs.rmSync(path.join(p.pkgRoot, "templates", "skills", "lorc-old"), { recursive: true });
  const mine = path.join(p.claudeDir, "skills", "user-skill.md");
  fs.writeFileSync(mine, "user");
  const data = path.join(p.claudeDir, "lorc", "settings.json");
  fs.writeFileSync(data, "{}");
  const r = install({ claudeDir: p.claudeDir, overwrite: true, prune: true, pkgRoot: p.pkgRoot });
  assert.strictEqual(r.pruned, 1);
  assert.ok(!fs.existsSync(path.join(p.claudeDir, "skills", "lorc-old")));
  assert.ok(fs.existsSync(mine));
  assert.ok(fs.existsSync(data));
  assert.ok(fs.existsSync(path.join(p.claudeDir, "skills", "lorc", "SKILL.md")));
});

test("bad settings.json stays unchanged, with a warning", () => {
  const p = fakePkg();
  fs.mkdirSync(p.claudeDir, { recursive: true });
  const f = path.join(p.claudeDir, "settings.json");
  fs.writeFileSync(f, "{ not json");
  const r = install({ claudeDir: p.claudeDir, pkgRoot: p.pkgRoot });
  assert.strictEqual(fs.readFileSync(f, "utf8"), "{ not json");
  assert.strictEqual(r.hooks, 0);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.warnings[0], /PreToolUse/);
});

test("upgrade --dry-run prints both commands", () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "lorc.js"), "upgrade", "--dry-run", "--global"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /i -g @azure-id\/lorc@latest/);
  assert.match(r.stdout, /lorc\.js update --global/);
});

test("agents-all installs only under executors=all, prune removes it after core", () => {
  const p = fakePkg();
  p.put("templates/agents-all/lorc-executor-extra.md", "extra");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-home-"));
  const extra = path.join(p.claudeDir, "agents", "lorc-executor-extra.md");
  const setFile = path.join(p.claudeDir, "lorc", "settings.json");
  const man = () => JSON.parse(fs.readFileSync(path.join(p.claudeDir, "lorc", "install-manifest.json"), "utf8")).files;
  install({ claudeDir: p.claudeDir, pkgRoot: p.pkgRoot, home });
  assert.ok(!fs.existsSync(extra));
  assert.ok(!man().includes("agents/lorc-executor-extra.md"));
  fs.writeFileSync(setFile, JSON.stringify({ executors: "all" }));
  install({ claudeDir: p.claudeDir, overwrite: true, pkgRoot: p.pkgRoot, home });
  assert.strictEqual(fs.readFileSync(extra, "utf8"), "extra");
  assert.ok(man().includes("agents/lorc-executor-extra.md"));
  fs.writeFileSync(setFile, JSON.stringify({ executors: "core" }));
  const r = install({ claudeDir: p.claudeDir, overwrite: true, prune: true, pkgRoot: p.pkgRoot, home });
  assert.strictEqual(r.pruned, 1);
  assert.ok(!fs.existsSync(extra));
  assert.ok(fs.existsSync(path.join(p.claudeDir, "agents", "lorc-exec.md")));
});

test("update removes an old lorc PostToolUse entry and keeps a foreign one", () => {
  const p = fakePkg();
  fs.mkdirSync(p.claudeDir, { recursive: true });
  fs.writeFileSync(path.join(p.claudeDir, "settings.json"), JSON.stringify({ hooks: { PostToolUse: [
    { matcher: "Task|Agent", hooks: [{ type: "command", command: "node \"x/hooks/lorc-graph-hook.js\"" }] },
    { matcher: "Edit", hooks: [{ type: "command", command: "node other.js" }] },
  ] } }));
  install({ claudeDir: p.claudeDir, overwrite: true, pkgRoot: p.pkgRoot });
  const s = JSON.parse(fs.readFileSync(path.join(p.claudeDir, "settings.json"), "utf8"));
  assert.deepStrictEqual(s.hooks.PostToolUse, [{ matcher: "Edit", hooks: [{ type: "command", command: "node other.js" }] }]);
  assert.strictEqual(s.hooks.PreToolUse.length, 1);
});
