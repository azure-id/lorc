#!/usr/bin/env node
"use strict";
// lorc status line. Standalone: Node built-ins only. Prints one line, writes the
// usage bridge, and (when ORC is here) keeps ORC's usage and effort bridges alive.
const fs = require("fs");
const os = require("os");
const path = require("path");

const FALLBACK = "ctx -- · 5h -- · reset -- · wk --";

function nowMs() {
  const n = Number(process.env.LORC_NOW);
  return process.env.LORC_NOW && Number.isFinite(n) ? n : Date.now();
}

function toMs(v) {
  if (v == null || v === "") return null;
  let t = NaN;
  if (typeof v === "number") t = v < 1e12 ? v * 1000 : v;
  else if (typeof v === "string") {
    const n = Number(v);
    t = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(v);
  }
  return Number.isFinite(t) ? t : null;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return null; } };

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function win(o) {
  return o && num(o.used_percentage) != null
    ? { used_percentage: o.used_percentage, resets_at: o.resets_at == null ? null : o.resets_at }
    : null;
}

// Write only when the numbers changed (compare everything except written_at).
function writeIfChanged(file, reading) {
  const prev = readJson(file);
  if (prev && prev.written_at) {
    const a = Object.assign({}, prev); delete a.written_at;
    if (JSON.stringify(a) === JSON.stringify(reading)) return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Object.assign({}, reading, { written_at: nowMs() })) + "\n");
}

function writesOrc(projectDir) {
  const home = process.env.LORC_HOME || os.homedir();
  for (const f of [path.join(projectDir, ".claude", "lorc", "settings.json"), path.join(home, ".claude", "lorc", "settings.json")]) {
    const s = readJson(f);
    if (s && typeof s === "object" && "statusline_writes_orc" in s) return s.statusline_writes_orc !== false;
  }
  return true;
}

function render(d) {
  const t = nowMs();
  const rl = d.rate_limits || {};
  const cw = d.context_window || {};
  const pct = (v) => (num(v) == null ? "--" : `${Math.round(v)}%`);
  const ctx = pct(cw.used_percentage);
  const fh = pct(rl.five_hour && rl.five_hour.used_percentage);
  const wk = pct(rl.seven_day && rl.seven_day.used_percentage);
  const rMs = rl.five_hour ? toMs(rl.five_hour.resets_at) : null;
  const reset = rMs == null ? "--" : `${Math.max(0, Math.ceil((rMs - t) / 60000))}m`;
  return `ctx ${ctx} · 5h ${fh} · reset ${reset} · wk ${wk}`;
}

function bridge(d) {
  const projectDir = (d.workspace && d.workspace.project_dir) || d.cwd || process.cwd();
  const rl = d.rate_limits || {};
  const cw = d.context_window || {};
  const ctxPct = num(cw.used_percentage);
  const lorcReading = { five_hour: win(rl.five_hour), seven_day: win(rl.seven_day),
    context_used_percentage: ctxPct, session_id: String(d.session_id || "") };
  try { writeIfChanged(path.join(projectDir, ".claude", "lorc", "usage.json"), lorcReading); } catch (_) {}
  const orcDir = path.join(projectDir, ".claude", "orc");
  let orcHere = false;
  try { orcHere = fs.statSync(orcDir).isDirectory(); } catch (_) {}
  if (!orcHere || !writesOrc(projectDir)) return;
  try {
    if (d.rate_limits || d.context_window) {
      writeIfChanged(path.join(orcDir, "usage.json"), { five_hour: lorcReading.five_hour,
        seven_day: lorcReading.seven_day, context_used_percentage: ctxPct });
    }
  } catch (_) {}
  try {
    // Exact shape of orc-statusline.js's session-model bridge.
    const model = (d.model && d.model.id) || "";
    const effort = String((d.effort && d.effort.level) || "").toLowerCase();
    if (model || effort) {
      fs.writeFileSync(
        path.join(orcDir, "session-model.json"),
        JSON.stringify({ model_id: model, effort, session_id: String(d.session_id || ""), written_at: nowMs() }) + "\n"
      );
    }
  } catch (_) {}
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("error", () => {});
process.stdin.on("end", () => {
  let line = FALLBACK;
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object") throw new Error("bad input");
    line = render(d);
    try { bridge(d); } catch (_) {}
  } catch (_) { line = FALLBACK; }
  try { process.stdout.write(line + "\n"); } catch (_) {}
  process.exitCode = 0;
});
