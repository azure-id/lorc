"use strict";
// lorc read — prints a read plan in ONE call: the line ranges a task (or the main session) needs.
// No --task → the main plan (doc, targets, must_ask evidence, context.md); --task n → <run>/plan-<n>.json.
const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");

const posix = (p) => String(p || "").replace(/\\/g, "/");

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// The main plan: built from the run's context pack, its doc and must_ask (budget 20 KB).
function mainPlan(root, runDir) {
  const pack = paths.readJson(path.join(runDir, "context.json"), null) || {};
  const run = paths.readJson(path.join(runDir, "run.json"), null) || {};
  const prep = paths.readJson(path.join(runDir, "prep.json"), null) || {};
  let mustAsk = [];
  try { mustAsk = require("./ask-facts.js").mustAsk(root, run.request || "", { doc: run.doc, engine: prep.tier_engine || null }) || []; } catch (_) { mustAsk = []; }
  const md = path.join(runDir, "context.md");
  const doc = run.doc ? posix(path.relative(root, path.resolve(root, run.doc))) : null;
  const plan = require("./context.js").readPlan(root, pack, {
    forMain: true, budget: 20480, doc, mustAsk, words: `${run.request || ""}`,
    contextMd: fs.existsSync(md) ? posix(path.relative(root, md)) : null,
  });
  return { budget: 20480, plan };
}

// Text: per range a `== file:a-b — why ==` head, then `<line>│<text>` rows; never more than the budget.
function render(root, plan, budget) {
  const out = [];
  let used = 0;
  let n = 0;
  const cache = new Map();
  for (const p of plan) {
    if (!cache.has(p.file)) {
      let t = null;
      try { t = fs.readFileSync(path.join(root, p.file), "utf8").split(/\r?\n/); } catch (_) { t = null; }
      cache.set(p.file, t);
    }
    const ls = cache.get(p.file);
    if (!ls) { const l = `(missing ${p.file})\n`; out.push(l); used += Buffer.byteLength(l); continue; }
    p.ranges.forEach(([a, b], k) => {
      const why = (p.whys && p.whys[k]) || p.why || "";
      const head = `== ${p.file}:${a}-${b}${why ? ` — ${why}` : ""} ==\n`;
      const rows = [];
      for (let i = a; i <= Math.min(b, ls.length); i++) rows.push(`${i}│${ls[i - 1]}\n`);
      let block = head + rows.join("");
      while (budget && used + Buffer.byteLength(block) > budget - 96 && rows.length) { rows.pop(); block = head + rows.join(""); }
      if (!rows.length) return;
      out.push(block);
      used += Buffer.byteLength(block);
      n++;
    });
  }
  const text = out.join("");
  const bytes = Buffer.byteLength(text);
  return { text: text + `(${n} ranges, ${bytes} B — read more only for what is missing)\n`, ranges: n, bytes };
}

function cmd(argv = []) {
  const err = (m) => { process.stderr.write(`lorc read: ${m}\n`); return 2; };
  const dir = valueOf(argv, "--dir");
  let root;
  try { root = dir ? path.resolve(dir) : paths.repoRoot(); } catch (_) { root = process.cwd(); }
  const slug = valueOf(argv, "--run");
  if (!slug) return err("use: read --run <slug> [--task <n>] [--json] [--dir <root>]");
  const runDir = require("./runs.js").runDir(root, slug);
  if (!fs.existsSync(path.join(runDir, "run.json"))) return err(`no run "${slug}"`);
  const task = valueOf(argv, "--task");
  let p;
  if (task) {
    if (!/^[\w-]+$/.test(task)) return err(`bad task number "${task}"`);
    p = paths.readJson(path.join(runDir, `plan-${task}.json`), null);
    if (!p) return err(`no plan for task ${task} — run lorc slice first`);
  } else p = mainPlan(root, runDir);
  const r = render(root, p.plan || [], p.budget || 0);
  if (argv.includes("--json")) process.stdout.write(JSON.stringify({ plan: p.plan, ranges: r.ranges, bytes: r.bytes, budget: p.budget }, null, 2) + "\n");
  else process.stdout.write(r.text);
  return 0;
}

module.exports = { cmd, render, mainPlan };
