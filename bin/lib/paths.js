"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const MIN_ORC_DELEGATE = "2.2.0";

function repoRoot(cwd = process.cwd()) {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, encoding: "utf8", timeout: 3000, windowsHide: true,
    });
    const out = r.status === 0 && r.stdout ? r.stdout.trim() : "";
    if (out) return path.resolve(out);
  } catch (_) { /* fall through */ }
  return path.resolve(cwd);
}

function homeDir(home) {
  return home || process.env.LORC_HOME || os.homedir();
}

function homeClaude(home) {
  return path.join(homeDir(home), ".claude");
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function resolveClaudeDir(argv = [], cwd = process.cwd(), home) {
  if (argv.includes("--global")) return homeClaude(home);
  const dir = argValue(argv, "--dir");
  if (dir) return path.resolve(dir, ".claude");
  return path.join(repoRoot(cwd), ".claude");
}

function projectLorcDir(root) {
  return path.join(root, ".claude", "lorc");
}

function globalLorcDir(home) {
  return path.join(homeClaude(home), "lorc");
}

function parseVer(v) {
  if (typeof v !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function semverGte(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return true;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function findOrc(root, home) {
  const candidates = [
    { scope: "project", file: path.join(root || process.cwd(), ".claude", "hooks", "orc-version.json") },
    { scope: "global", file: path.join(homeClaude(home), "hooks", "orc-version.json") },
  ];
  let first = null;
  for (const c of candidates) {
    const stamp = readJson(c.file, null);
    if (!stamp || typeof stamp !== "object") continue;
    const version = typeof stamp.version === "string" ? stamp.version : null;
    const cli = typeof stamp.cli === "string" ? stamp.cli : null;
    const installed = !!cli && fs.existsSync(cli);
    const delegate = installed && semverGte(version, MIN_ORC_DELEGATE);
    let reason = null;
    if (!installed) reason = "cli missing";
    else if (!delegate) reason = `orc ${version} < ${MIN_ORC_DELEGATE}`;
    const res = { installed, scope: c.scope, version, cli, delegate, reason };
    // A project stamp whose cli is missing does not stop the global check.
    if (!installed) { if (!first) first = res; continue; }
    return res;
  }
  if (first) return first;
  return { installed: false, delegate: false, scope: null, version: null, cli: null, reason: "no stamp" };
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
    throw err;
  }
}

module.exports = {
  MIN_ORC_DELEGATE, repoRoot, homeClaude, resolveClaudeDir, projectLorcDir, globalLorcDir,
  semverGte, findOrc, readJson, atomicWrite,
};
