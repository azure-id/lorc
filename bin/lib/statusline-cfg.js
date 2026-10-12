"use strict";

const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const PKG_ROOT = path.join(__dirname, "..", "..");
const HOOK = "lorc-statusline.js";

function readSettings(file) {
  if (!fs.existsSync(file)) return { ok: true, data: {}, exists: false };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "not a JSON object" };
    return { ok: true, data, exists: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function kindOf(statusLine) {
  if (statusLine == null) return "none";
  const c = typeof statusLine === "object" && typeof statusLine.command === "string" ? statusLine.command : "";
  if (c.includes("lorc-statusline")) return "lorc";
  if (c.includes("orc-statusline")) return "orc";
  return "other";
}

function scopeInfo(file) {
  const r = readSettings(file);
  if (!r.ok) return { path: file, kind: "unreadable", sets: false };
  const has = Object.prototype.hasOwnProperty.call(r.data, "statusLine") && r.data.statusLine != null;
  return { path: file, kind: has ? kindOf(r.data.statusLine) : "none", sets: has };
}

function backupPath(claudeDir) {
  return path.join(claudeDir, "lorc", "statusline-backup.json");
}

function lineStatus({ home, root } = {}) {
  const userClaude = paths.homeClaude(home);
  const u = scopeInfo(path.join(userClaude, "settings.json"));
  const p = scopeInfo(path.join(root || paths.repoRoot(), ".claude", "settings.json"));
  const bp = backupPath(userClaude);
  return {
    user: { path: u.path, kind: u.kind },
    project: { path: p.path, kind: p.kind },
    winner: p.sets ? "project" : u.sets ? "user" : null,
    backup: { path: bp, exists: fs.existsSync(bp) },
  };
}

function writeSettings(file, data) {
  paths.atomicWrite(file, JSON.stringify(data, null, 2) + "\n");
}

function bypass({ settingsPath, claudeDir, pkgRoot = PKG_ROOT } = {}) {
  const r = readSettings(settingsPath);
  if (!r.ok) return { code: 1, message: `cannot read ${settingsPath} (${r.error}) — changed nothing` };
  const data = r.data;
  const old = Object.prototype.hasOwnProperty.call(data, "statusLine") ? data.statusLine : null;
  if (kindOf(old) === "lorc") return { code: 0, message: `lorc status line already active (${settingsPath})`, already: true };
  const hookDst = path.join(claudeDir, "hooks", HOOK);
  fs.mkdirSync(path.dirname(hookDst), { recursive: true });
  fs.copyFileSync(path.join(pkgRoot, "templates", "hooks", HOOK), hookDst);
  const bp = backupPath(claudeDir);
  const prev = paths.readJson(bp, null);
  const keep = prev && typeof prev === "object" && kindOf(prev.statusLine) !== "lorc";
  if (!keep) {
    paths.atomicWrite(bp, JSON.stringify({ settings_path: settingsPath, saved_at: new Date().toISOString(), statusLine: old == null ? null : old }, null, 2) + "\n");
  }
  const line = { type: "command", command: `node "${hookDst.replace(/\\/g, "/")}"` };
  if (old && typeof old === "object" && old.refreshInterval !== undefined) line.refreshInterval = old.refreshInterval;
  data.statusLine = line;
  writeSettings(settingsPath, data);
  const replaced = kindOf(old) === "orc" ? "orc status line" : kindOf(old) === "none" ? "none" : "other";
  return {
    code: 0,
    replaced,
    message: `lorc status line set in ${settingsPath}\nreplaced: ${replaced}\nto undo: lorc cli restore`,
  };
}

function restore({ settingsPath, claudeDir } = {}) {
  const r = readSettings(settingsPath);
  if (!r.ok) return { code: 1, message: `cannot read ${settingsPath} (${r.error}) — changed nothing` };
  const data = r.data;
  const bp = backupPath(claudeDir);
  const b = paths.readJson(bp, null);
  if (b && typeof b === "object") {
    if (b.statusLine == null) delete data.statusLine;
    else data.statusLine = b.statusLine;
    writeSettings(settingsPath, data);
    fs.rmSync(bp, { force: true });
    return { code: 0, message: `restored: ${kindOf(b.statusLine)}` };
  }
  if (kindOf(data.statusLine) === "lorc") {
    delete data.statusLine;
    writeSettings(settingsPath, data);
  }
  return { code: 0, message: 'no backup — removed the lorc line; run "orc update" to get ORC\'s line back' };
}

function cmd(argv = [], opts = {}) {
  const sub = argv[0];
  const home = opts.home || process.env.LORC_HOME || undefined;
  const root = opts.root || paths.repoRoot();
  const dirI = argv.indexOf("--dir");
  const claudeDir = dirI >= 0 && argv[dirI + 1] ? path.resolve(argv[dirI + 1], ".claude") : paths.homeClaude(home);
  const userScope = dirI < 0;
  const settingsPath = path.join(claudeDir, "settings.json");
  if (sub === "status") {
    const s = lineStatus({ home, root });
    if (wantsJson(argv)) emit(s);
    else {
      process.stdout.write(`user: ${s.user.kind} (${s.user.path})\nproject: ${s.project.kind} (${s.project.path})\n` +
        `winner: ${s.winner || "none"}\nbackup: ${s.backup.exists ? s.backup.path : "none"}\n`);
    }
    return 0;
  }
  if (sub === "bypass" || sub === "restore") {
    const res = sub === "bypass" ? bypass({ settingsPath, claudeDir, home }) : restore({ settingsPath, claudeDir });
    if (wantsJson(argv)) emit(Object.assign({ settings_path: settingsPath }, res));
    else if (res.code) process.stderr.write(res.message.split("\n")[0] + "\n");
    else {
      process.stdout.write(res.message + "\n");
      if (sub === "bypass" && userScope) {
        const p = scopeInfo(path.join(root, ".claude", "settings.json"));
        if (p.sets) process.stdout.write("note: the project settings also set a status line, and it wins in this project\n");
      }
    }
    return res.code;
  }
  process.stderr.write("usage: lorc cli bypass | restore | status [--dir <path>] [--global] [--json]\n");
  return 2;
}

module.exports = { lineStatus, bypass, restore, cmd, kindOf };
