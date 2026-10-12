"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const PKG_ROOT = path.join(__dirname, "..", "..");
const DEFAULT_URL = "https://raw.githubusercontent.com/azure-id/lorc/main/CHANGELOG.md";
const TIMEOUT_MS = 4000;

function fetchText(url, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (url.startsWith("file://")) {
      try { resolve(fs.readFileSync(fileURLToPath(url), "utf8")); } catch (e) { reject(e); }
      return;
    }
    const mod = url.startsWith("http://") ? require("http") : require("https");
    const req = mod.get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      res.setEncoding("utf8");
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// "## x.y.z — DD-MM-YYYY" headings, newest first, with their bullet lines.
function parse(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:[—–-]\s*(\S+))?/.exec(line);
    if (m) { cur = { version: m[1], date: m[2] || null, lines: [] }; out.push(cur); continue; }
    if (cur && /^\s*[-*]\s+/.test(line)) cur.lines.push(line.trim());
  }
  return out;
}

async function gather({ url = process.env.LORC_CHANGELOG_URL || DEFAULT_URL, pkgRoot = PKG_ROOT } = {}) {
  const installed = paths.readJson(path.join(pkgRoot, "package.json"), {}).version || "0.0.0";
  try {
    const all = parse(await fetchText(url));
    if (!all.length) throw new Error("no versions");
    const newer = all.filter((e) => e.version !== installed && paths.semverGte(e.version, installed));
    return { installed, latest: all[0].version, newer, source: "remote" };
  } catch (_) {
    let local = [];
    try { local = parse(fs.readFileSync(path.join(pkgRoot, "CHANGELOG.md"), "utf8")); } catch (_) { /* none */ }
    return { installed, latest: local[0] ? local[0].version : installed, newer: local.slice(0, 1), source: "local" };
  }
}

function print(res) {
  const lines = [];
  if (res.source === "local") lines.push("offline — showing the local CHANGELOG.md");
  else if (!res.newer.length) lines.push(`lorc ${res.installed} is the latest`);
  for (const e of res.newer) {
    lines.push(`## ${e.version}${e.date ? " — " + e.date : ""}`, ...e.lines, "");
  }
  process.stdout.write(lines.join("\n").replace(/\n*$/, "\n"));
}

// The fetch is async; the exit code is always 0, so the router gets 0 now.
function cmd(argv = []) {
  const json = wantsJson(argv);
  gather().then((res) => { if (json) emit(res); else print(res); }, (err) => {
    process.stderr.write(`lorc changelog: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
  return 0;
}

module.exports = { parse, gather, fetchText, cmd };
