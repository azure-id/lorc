"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cfg = require("../bin/lib/statusline-cfg.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lorc-bypass-"));
const ORC_LINE = { type: "command", command: 'node "C:/x/.claude/hooks/orc-statusline.js"', refreshInterval: 5 };
const HOOKS = { PreToolUse: [{ matcher: "Skill", hooks: [{ type: "command", command: "node orc-effort-guard.js" }] }] };

function scope(settings) {
  const claudeDir = path.join(tmp(), ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  if (settings !== undefined) fs.writeFileSync(settingsPath, typeof settings === "string" ? settings : JSON.stringify(settings));
  return { claudeDir, settingsPath };
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

test("bypass over ORC's line, bypass again, restore", () => {
  const s = scope({ statusLine: ORC_LINE, hooks: HOOKS });
  const a = cfg.bypass(s);
  assert.strictEqual(a.code, 0);
  assert.strictEqual(a.replaced, "orc status line");
  const after = read(s.settingsPath);
  assert.match(after.statusLine.command, /lorc-statusline/);
  assert.strictEqual(after.statusLine.refreshInterval, 5);
  assert.deepStrictEqual(after.hooks, HOOKS);
  assert.ok(fs.existsSync(path.join(s.claudeDir, "hooks", "lorc-statusline.js")));
  const bp = path.join(s.claudeDir, "lorc", "statusline-backup.json");
  const backup = fs.readFileSync(bp, "utf8");
  assert.deepStrictEqual(JSON.parse(backup).statusLine, ORC_LINE);

  const b = cfg.bypass(s);
  assert.ok(b.already);
  assert.match(b.message, /already active/);
  assert.strictEqual(fs.readFileSync(bp, "utf8"), backup);

  const r = cfg.restore(s);
  assert.strictEqual(r.message, "restored: orc");
  assert.deepStrictEqual(read(s.settingsPath).statusLine, ORC_LINE);
  assert.ok(!fs.existsSync(bp));
});

test("no statusLine: bypass then restore deletes the key", () => {
  const s = scope(undefined);
  assert.strictEqual(cfg.bypass(s).replaced, "none");
  cfg.restore(s);
  assert.ok(!("statusLine" in read(s.settingsPath)));
});

test("unparsable settings: exit 1, file byte-identical", () => {
  const s = scope("{ not json");
  const r = cfg.bypass(s);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(fs.readFileSync(s.settingsPath, "utf8"), "{ not json");
});

test("status: kinds and winner", () => {
  const home = tmp();
  const root = tmp();
  const u = path.join(home, ".claude", "settings.json");
  const p = path.join(root, ".claude", "settings.json");
  let st = cfg.lineStatus({ home, root });
  assert.strictEqual(st.user.kind, "none");
  assert.strictEqual(st.winner, null);
  fs.mkdirSync(path.dirname(u), { recursive: true });
  fs.writeFileSync(u, JSON.stringify({ statusLine: ORC_LINE }));
  st = cfg.lineStatus({ home, root });
  assert.strictEqual(st.user.kind, "orc");
  assert.strictEqual(st.winner, "user");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ statusLine: { type: "command", command: "my-line" } }));
  st = cfg.lineStatus({ home, root });
  assert.strictEqual(st.project.kind, "other");
  assert.strictEqual(st.winner, "project");
  fs.writeFileSync(u, JSON.stringify({ statusLine: { type: "command", command: "node lorc-statusline.js" } }));
  assert.strictEqual(cfg.lineStatus({ home, root }).user.kind, "lorc");
  fs.writeFileSync(p, "{ bad");
  st = cfg.lineStatus({ home, root });
  assert.strictEqual(st.project.kind, "unreadable");
  assert.strictEqual(st.winner, "user");
});
