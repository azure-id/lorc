#!/usr/bin/env node
"use strict";
// Usage:
//   node scripts/vendor.js --from <orc root> [--root <lorc root>]
//   node scripts/vendor.js --check [--root <lorc root>] [--diff <orc root>]

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10000, windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

function loadList(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "scripts", "vendor-list.json"), "utf8"));
}

function copy(root, orc) {
  const list = loadList(root);
  const files = {};
  const missing = list.copy.filter((r) => !fs.existsSync(path.join(orc, r.from)));
  if (missing.length) {
    for (const r of missing) process.stderr.write(`vendor: missing in orc: ${r.from}\n`);
    return 1;
  }
  for (const r of list.copy) {
    const dst = path.join(root, r.to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(orc, r.from), dst);
    files[r.to] = { from: r.from, sha256: sha256(dst) };
  }
  const commit = (git(orc, ["rev-parse", "HEAD"]) || "").trim() || null;
  const status = git(orc, ["status", "--porcelain", "--", ...list.copy.map((r) => r.from)]) || "";
  const dirty = status.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).trim());
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(orc, "package.json"), "utf8")).version; } catch (_) { /* none */ }
  const out = {
    orc_commit: commit,
    orc_version: version,
    orc_dirty: list.copy.map((r) => r.from).filter((f) => dirty.includes(f)),
    copied_at: new Date().toISOString(),
    files,
    local: list.local || [],
  };
  fs.writeFileSync(path.join(root, "vendor", "VENDOR.json"), JSON.stringify(out, null, 2) + "\n");
  process.stdout.write(`vendored ${list.copy.length} files from orc ${version} @ ${(commit || "unknown").slice(0, 7)}\n`);
  return 0;
}

function check(root) {
  const problems = [];
  let v;
  try {
    v = JSON.parse(fs.readFileSync(path.join(root, "vendor", "VENDOR.json"), "utf8"));
  } catch (_) {
    process.stderr.write("vendor: vendor/VENDOR.json missing or bad\n");
    return { code: 1, v: null };
  }
  const entries = Object.entries(v.files || {});
  for (const [to, info] of entries) {
    const f = path.join(root, to);
    if (!fs.existsSync(f)) problems.push(`missing: ${to}`);
    else if (sha256(f) !== info.sha256) problems.push(`hash mismatch: ${to}`);
  }
  for (const l of v.local || []) {
    if (!fs.existsSync(path.join(root, l))) problems.push(`missing local: ${l}`);
  }
  if (problems.length) {
    for (const p of problems) process.stderr.write(`vendor: ${p}\n`);
    return { code: 1, v };
  }
  process.stdout.write(`vendor OK (${entries.length} files)\n`);
  return { code: 0, v };
}

function diff(root, orc, v) {
  const drift = [];
  for (const [to, info] of Object.entries(v.files || {})) {
    const src = path.join(orc, info.from);
    if (!fs.existsSync(src) || sha256(src) !== info.sha256) drift.push(`${to} <- ${info.from}`);
  }
  if (drift.length) {
    for (const d of drift) process.stdout.write(`drift: ${d}\n`);
    return 3;
  }
  process.stdout.write("in sync\n");
  return 0;
}

function main(argv) {
  const root = path.resolve(arg(argv, "--root") || path.join(__dirname, ".."));
  if (argv.includes("--check")) {
    const { code, v } = check(root);
    if (code !== 0) return code;
    const orc = arg(argv, "--diff");
    return orc ? diff(root, path.resolve(orc), v) : 0;
  }
  const from = arg(argv, "--from");
  if (from) return copy(root, path.resolve(from));
  process.stderr.write("usage: vendor.js --from <orc root> [--root <dir>] | --check [--root <dir>] [--diff <orc root>]\n");
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`vendor: ${err && err.message ? err.message : err}\n`);
  if (process.env.LORC_DEBUG === "1") process.stderr.write(String(err && err.stack) + "\n");
  process.exitCode = 1;
}
