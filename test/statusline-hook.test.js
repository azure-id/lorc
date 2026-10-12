"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOK = path.join(__dirname, "..", "templates", "hooks", "lorc-statusline.js");
const NOW = 1_800_000_000_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lorc-hook-"));

function hook(input, home) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: Object.assign({}, process.env, { LORC_NOW: String(NOW), LORC_HOME: home || tmp() }),
  });
  return r;
}
const full = (dir) => ({
  session_id: "s1",
  model: { id: "claude-opus-5-5" },
  effort: { level: "High" },
  workspace: { project_dir: dir },
  context_window: { used_percentage: 41.6 },
  rate_limits: {
    five_hour: { used_percentage: 63.2, resets_at: (NOW + 134 * 60_000) / 1000 },
    seven_day: { used_percentage: 30.7, resets_at: NOW + 5 * 86400_000 },
  },
});

test("full input prints the exact line and writes the lorc bridge", () => {
  const dir = tmp();
  const r = hook(full(dir));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, "");
  assert.strictEqual(r.stdout, "ctx 42% · 5h 63% · reset 134m · wk 31%\n");
  const u = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "lorc", "usage.json"), "utf8"));
  assert.strictEqual(u.five_hour.used_percentage, 63.2);
  assert.strictEqual(u.context_used_percentage, 41.6);
  assert.strictEqual(u.session_id, "s1");
  assert.strictEqual(u.written_at, NOW);
  assert.ok(!fs.existsSync(path.join(dir, ".claude", "orc")));
});

test("missing fields print --", () => {
  const dir = tmp();
  const r = hook({ cwd: dir });
  assert.strictEqual(r.stdout, "ctx -- · 5h -- · reset -- · wk --\n");
});

test("identical input does not rewrite usage.json", () => {
  const dir = tmp();
  hook(full(dir));
  const f = path.join(dir, ".claude", "lorc", "usage.json");
  const before = fs.readFileSync(f, "utf8");
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(full(dir)), encoding: "utf8",
    env: Object.assign({}, process.env, { LORC_NOW: String(NOW + 60_000), LORC_HOME: tmp() }),
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(f, "utf8"), before);
});

test("ORC bridges are written only when .claude/orc exists and the setting allows it", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".claude", "orc"), { recursive: true });
  hook(full(dir));
  const ou = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "orc", "usage.json"), "utf8"));
  assert.deepStrictEqual(Object.keys(ou).sort(), ["context_used_percentage", "five_hour", "seven_day", "written_at"]);
  const sm = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "orc", "session-model.json"), "utf8"));
  assert.deepStrictEqual(sm, { model_id: "claude-opus-5-5", effort: "high", session_id: "s1", written_at: NOW });

  const off = tmp();
  fs.mkdirSync(path.join(off, ".claude", "orc"), { recursive: true });
  fs.mkdirSync(path.join(off, ".claude", "lorc"), { recursive: true });
  fs.writeFileSync(path.join(off, ".claude", "lorc", "settings.json"), JSON.stringify({ statusline_writes_orc: false }));
  hook(full(off));
  assert.ok(!fs.existsSync(path.join(off, ".claude", "orc", "usage.json")));
  assert.ok(!fs.existsSync(path.join(off, ".claude", "orc", "session-model.json")));

  const glob = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(glob, ".claude", "orc"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "lorc"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "lorc", "settings.json"), JSON.stringify({ statusline_writes_orc: false }));
  hook(full(glob), home);
  assert.ok(!fs.existsSync(path.join(glob, ".claude", "orc", "usage.json")));
});

test("garbage stdin prints the fallback line and exits 0", () => {
  const r = hook("not json {");
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, "");
  assert.strictEqual(r.stdout, "ctx -- · 5h -- · reset -- · wk --\n");
});
