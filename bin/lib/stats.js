"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

// ORC rule (orc bin/cli.js transcriptDir): ~/.claude/projects/<root, every non
// [A-Za-z0-9] char → "-">/<session>.jsonl. Subagent files: <session>/subagents/*.jsonl.
function transcriptDir(root, home) {
  const h = home || process.env.LORC_HOME || os.homedir();
  return path.join(h, ".claude", "projects", String(root).replace(/[^A-Za-z0-9]/g, "-"));
}

function sessionFiles(root, session, home) {
  const dir = transcriptDir(root, home);
  const out = [];
  const main = path.join(dir, `${session}.jsonl`);
  if (fs.existsSync(main)) out.push(main);
  const sub = path.join(dir, session, "subagents");
  try { for (const f of fs.readdirSync(sub)) if (f.endsWith(".jsonl")) out.push(path.join(sub, f)); } catch (_) { /* none */ }
  return out;
}

function pricing() {
  return paths.readJson(path.join(__dirname, "..", "..", "vendor", "pricing.json"), {}) || {};
}

function rateFor(model, table) {
  if (!model) return null;
  const m = table.models || {};
  if (m[model]) return m[model];
  const bare = String(model).replace(/-\d{8}$/, "").replace(/\[.*\]$/, "");
  if (m[bare]) return m[bare];
  const fam = Object.keys(table.families || {}).find((f) => String(model).includes(f));
  return fam ? table.families[fam] : null;
}

const zero = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 });
function addVec(a, b) {
  for (const k of ["input", "output", "cache_read", "cache_write", "total"]) a[k] += b[k] || 0;
  return a;
}

function runStats(root, run, { home, table } = {}) {
  const t = table || pricing();
  const base = { slug: run.slug, tier: run.tier || null, executor: run.executor || null, duration_s: run.duration_s ?? null };
  if (!run.session_id) return { ...base, tokens: null, cost_usd: null, models: {}, note: "no session id" };
  const files = sessionFiles(root, run.session_id, home);
  if (!files.length) return { ...base, tokens: null, cost_usd: null, models: {}, note: "no transcript" };
  const from = Date.parse(run.started_at) || 0;
  const to = Date.parse(run.ended_at) || Infinity;
  const tokens = zero();
  const models = {};
  let cost = 0;
  let unpriced = false;
  for (const f of files) {
    let text = "";
    try { text = fs.readFileSync(f, "utf8"); } catch (_) { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line || line[0] !== "{") continue;
      let o;
      try { o = JSON.parse(line); } catch (_) { continue; }
      const msg = o.message || o;
      const u = msg && msg.usage;
      if (!u || typeof u.output_tokens !== "number") continue;
      const at = Date.parse(o.timestamp || "");
      if (!(at >= from && at <= to)) continue;
      const v = {
        input: u.input_tokens || 0, output: u.output_tokens || 0,
        cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0,
      };
      v.total = v.input + v.output + v.cache_read + v.cache_write;
      const model = msg.model || o.model || "unknown";
      addVec(tokens, v);
      addVec((models[model] = models[model] || zero()), v);
      const r = rateFor(model, t);
      if (r) cost += (v.input * r.input + v.output * r.output + v.cache_read * r.cache_read + v.cache_write * r.cache_write) / 1e6;
      else unpriced = true;
    }
  }
  const res = { ...base, tokens, cost_usd: Math.round(cost * 10000) / 10000, models };
  if (unpriced) res.note = "a model has no price — cost is partial";
  return res;
}

function collect(root, { limit = 20, home } = {}) {
  const table = pricing();
  const runs = require("./runs.js").readRuns(root).reverse().slice(0, limit).map((r) => runStats(root, r, { home, table }));
  const totals = { runs: runs.length, tokens: zero(), cost_usd: 0, no_transcript: 0 };
  for (const r of runs) {
    if (!r.tokens) { totals.no_transcript++; continue; }
    addVec(totals.tokens, r.tokens);
    totals.cost_usd += r.cost_usd || 0;
  }
  totals.cost_usd = Math.round(totals.cost_usd * 10000) / 10000;
  return { runs, totals, pricing_as_of: table.as_of || null };
}

function cmd(argv = []) {
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
  const root = val("--dir") ? path.resolve(val("--dir")) : paths.repoRoot();
  const out = collect(root, { limit: Number(val("--limit")) || 20 });
  if (wantsJson(argv)) { emit(out); return 0; }
  if (!out.runs.length) { process.stdout.write("no finished runs\n"); return 0; }
  const lines = out.runs.map((r) => r.tokens
    ? `${r.slug}  ${r.tier || "-"}  ${r.executor || "-"}  ${r.tokens.total} tok  $${r.cost_usd}`
    : `${r.slug}  ${r.tier || "-"}  ${r.executor || "-"}  ${r.note}`);
  lines.push(`total: ${out.totals.tokens.total} tok · $${out.totals.cost_usd} · ${out.totals.runs} runs (${out.totals.no_transcript} without transcript)`);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

module.exports = { transcriptDir, sessionFiles, rateFor, runStats, collect, cmd };
