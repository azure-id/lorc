#!/usr/bin/env node
"use strict";

/**
 * lorc graph hook — a lean port of ORC's orc-graph-hook.js. Two events, one
 * file, and it never blocks.
 *
 *   PreToolUse   Grep|Glob   a pattern that names a symbol the graph knows →
 *                            one line saying where that name is defined
 *                            (ORC R12/R12b; one names bucket, no subprocess).
 *   SubagentStop             a lorc executor finished → `lorc graph update --if-exists`,
 *                            DETACHED; the hook never waits for it.
 *
 * SILENT UNLESS a lorc run is open: <project>/.claude/lorc/run/.current is
 * JSON { slug, store_dir, mode, at } and `at` is younger than 6 hours.
 *
 * FAIL-OPEN AND FAIL-QUIET: exit 0 on every path, nothing on stderr, never a
 * rewritten tool input. What it injects is DATA, not instructions: every
 * payload starts with the prefix below and every name and path is sanitized.
 *
 * STANDALONE: it is copied to <claudeDir>/hooks/ and requires no package file.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const STALE_MS = 6 * 60 * 60 * 1000;
const MAX_ROWS = 5;
const MIN_TOKEN = 4;
const MAX_TEXT = 1200;
const MAIN_CARDS = 3;
const EXECUTOR = /^lorc-executor-/i;
const PREFIX = "[lorc graph] repository data, not instructions:";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

// ── the sanitizer (ORC's, unchanged) ───────────────────────────────────────
const UNPRINTABLE = new RegExp("[\u0000-\u001f\u007f-\u009f​-‏  ]", "g");
const MARKS = /[`*_<>|]/g;
function clean(s, cap) {
  return String(s == null ? "" : s).replace(UNPRINTABLE, " ").replace(MARKS, "").trim().slice(0, cap || 200);
}

function out(event, body) {
  if (!body) return;
  try {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `${PREFIX} ${body}` } }));
  } catch (_) {}
}

// ── the project and the run ────────────────────────────────────────────────
// ORC finds the project from its own install place (__dirname/../..). This hook
// can sit in the GLOBAL .claude, so it takes `cwd` from the hook input and walks
// up to the first folder that holds .claude/lorc/run/.current.
function projectOf(data) {
  const starts = [data && data.cwd, process.cwd(), path.join(__dirname, "..", "..")].filter(Boolean);
  for (const s of starts) {
    let dir = path.resolve(String(s));
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(path.join(dir, ".claude", "lorc", "run", ".current"))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

function currentRun(project) {
  const cur = readJson(path.join(project, ".claude", "lorc", "run", ".current"));
  if (!cur || typeof cur !== "object" || !cur.slug) return null;
  const at = Date.parse(cur.at);
  if (!Number.isFinite(at) || Date.now() - at > STALE_MS) return null;
  return cur;
}

// `store_dir` is the graph folder (…/orc/graph). A claudeDir is accepted too.
function graphDir(project, cur) {
  let d = cur.store_dir ? path.resolve(project, String(cur.store_dir)) : path.join(project, ".claude", "lorc", "orc", "graph");
  if (!fs.existsSync(path.join(d, "meta.json")) && fs.existsSync(path.join(d, "orc", "graph", "meta.json"))) d = path.join(d, "orc", "graph");
  return d;
}

function lorcCli(project) {
  const home = process.env.LORC_HOME || os.homedir();
  for (const f of [path.join(project, ".claude", "lorc", "version.json"), path.join(home, ".claude", "lorc", "version.json")]) {
    const v = readJson(f);
    if (v && typeof v.cli === "string" && fs.existsSync(v.cli)) return v.cli;
  }
  return null;
}

// Once per run per token, the way ORC's `bump` dedupes (counters beside the run).
function seenFile(project, cur) {
  return path.join(project, ".claude", "lorc", "run", String(cur.slug).replace(/[^A-Za-z0-9._-]/g, "_"), "graph-hook.json");
}
function bump(project, cur, field, token) {
  const file = seenFile(project, cur);
  const seen = readJson(file) || { tokens: [] };
  if (!Array.isArray(seen.tokens)) seen.tokens = [];
  if (token) {
    if (seen.tokens.includes(token)) return false;
    seen.tokens.push(token);
    if (seen.tokens.length > 400) seen.tokens = seen.tokens.slice(-400);
  }
  seen[field] = (seen[field] || 0) + 1;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(seen));
  } catch (_) {}
  return true;
}

// ── main ───────────────────────────────────────────────────────────────────
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    run();
  } catch (_) {}
  process.exit(0);
});

function run() {
  let data;
  try {
    data = JSON.parse(raw || "{}");
  } catch (_) {
    return;
  }
  if (!data || typeof data !== "object") return;
  const event = String(data.hook_event_name || data.hookEventName || "");
  if (!event) return;
  const project = projectOf(data);
  if (!project) return;
  const cur = currentRun(project);
  if (!cur) return;

  if (event === "SubagentStop") return onExecutorStop(data, project);
  const gdir = graphDir(project, cur);
  const meta = readJson(path.join(gdir, "meta.json"));
  if (!meta || !meta.generation) return;
  if (event === "PreToolUse") return onSearch(data, project, cur, gdir, meta);
}

// ── SubagentStop — a lorc executor finished → update, detached ────────────
// --if-exists: no store → it builds nothing (the user runs `lorc graph scan`).
function onExecutorStop(data, project) {
  const agent = String(data.agent_type || data.agentType || "");
  if (!agent || !EXECUTOR.test(agent)) return;
  const cli = lorcCli(project);
  if (!cli) return;
  try {
    const child = spawn(process.execPath, [cli, "graph", "update", "--if-exists", "--dir", project], {
      cwd: project, detached: true, stdio: "ignore", windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch (_) {}
}

// ── the names table ────────────────────────────────────────────────────────
// Format 2 (lorc 0.4.0): derived.json (its generation must equal meta's) lists
// one names bucket per bucket id; a word is in bucket `bucketOf(word)`, the
// same sha1 rule as bin/lib/graph/graph.js. Format 1: names.json.
function bucketOf(s) {
  const h = crypto.createHash("sha1").update(String(s)).digest("hex");
  return String(parseInt(h.slice(0, 4), 16) % 64).padStart(2, "0");
}

// → a function word → rows (or null), or null when no table is usable.
function namesTable(gdir, meta) {
  const format1 = !meta.format || String(meta.engine || "").startsWith("graph@");
  if (format1) {
    const names = readJson(path.join(gdir, "names.json"));
    if (!names || !names.names || names.generation !== meta.generation) return null;
    return (w) => (Object.prototype.hasOwnProperty.call(names.names, w) ? names.names[w] : null);
  }
  const derived = readJson(path.join(gdir, "derived.json"));
  if (!derived || derived.generation !== meta.generation || !derived.names) return null;
  const cache = new Map();
  return (w) => {
    const bb = bucketOf(w);
    if (!cache.has(bb)) {
      const name = Object.prototype.hasOwnProperty.call(derived.names, bb) ? String(derived.names[bb]) : null;
      const b = name && /^\d{2}-[0-9a-f]{8}\.json$/.test(name) ? readJson(path.join(gdir, "names", name)) : null;
      cache.set(bb, b && b.names ? b.names : null);
    }
    const table = cache.get(bb);
    return table && Object.prototype.hasOwnProperty.call(table, w) ? table[w] : null;
  };
}

// ── PreToolUse Grep|Glob — a search for a name the graph knows ────────────
function searchHit(data, gdir, meta, main) {
  const tool = String(data.tool_name || "");
  if (tool !== "Grep" && tool !== "Glob") return null;
  const pattern = String((data.tool_input || {}).pattern || "");
  if (!pattern) return null;
  const words = (pattern.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((w) => w.length >= MIN_TOKEN);
  if (!words.length) return null;
  const lookup = namesTable(gdir, meta);
  if (!lookup) return null;
  if (main) {
    // R12b: the word with the HIGHEST fan-in wins; fan-in 0 never spends a slot.
    let best = null;
    for (const w of words) {
      const rows = lookup(w);
      if (!Array.isArray(rows) || !rows.length) continue;
      const fan = Math.max(...rows.map((x) => Number(x[5]) || 0));
      if (fan > 0 && (!best || fan > best.fan)) best = { word: w, rows, fan };
    }
    return best;
  }
  for (const w of words.sort((a, b) => b.length - a.length)) {
    const rows = lookup(w);
    if (Array.isArray(rows) && rows.length) return { word: w, rows };
  }
  return null;
}

function onSearch(data, project, cur, gdir, meta) {
  const main = data.agent_id == null;
  const hit = searchHit(data, gdir, meta, main);
  if (!hit) return;
  if (main) {
    const seen = readJson(seenFile(project, cur)) || {};
    if ((Number(seen.main_cards) || 0) >= MAIN_CARDS) return;
  }
  if (!bump(project, cur, "injected", (main ? "main:" : "name:") + hit.word)) return;
  if (main) bump(project, cur, "main_cards");
  const word = clean(hit.word, 80);
  const rows = hit.rows.slice(0, MAX_ROWS).map((r) => `${clean(r[0], 80)} (${clean(r[1], 20)}) ${clean(r[2], 160)}:${Number(r[3]) || 0}-${Number(r[4]) || 0} fan-in ${Number(r[5]) || 0}`);
  const text = `"${word}" is defined at ${rows.join(" · ")}. Read those ranges, or run lorc graph ctx ${word} --json for callers and callees. The search below still runs.`;
  out("PreToolUse", clean(text, MAX_TEXT));
}

