"use strict";

const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const STOP = new Set(("a an the and or but of to in on at for with from by is are be it this that " +
  "these those as into onto please make add fix update change use can should would could i we you " +
  "my our me do does not no so then than also just new").split(" "));

const lorcDir = (root) => paths.projectLorcDir(root);
const runBase = (root) => path.join(lorcDir(root), "run");
const runDir = (root, slug) => path.join(runBase(root), slug);
const runFile = (root, slug) => path.join(runDir(root, slug), "run.json");
const currentFile = (root) => path.join(runBase(root), ".current");
const runsLog = (root) => path.join(lorcDir(root), "runs.jsonl");

function nowMs(now) {
  if (Number.isFinite(now)) return now;
  const env = Number(process.env.LORC_NOW);
  return process.env.LORC_NOW && Number.isFinite(env) ? env : Date.now();
}
const iso = (t) => new Date(t).toISOString();
const pad = (n) => String(n).padStart(2, "0");

function makeSlug(request, now) {
  const d = new Date(nowMs(now));
  const stamp = `${pad(d.getFullYear() % 100)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const words = String(request || "").toLowerCase().normalize("NFKD").replace(/[^\x00-\x7f]/g, "")
    .split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).slice(0, 4);
  let tail = words.join("-") || "run";
  const room = 40 - stamp.length - 1;
  if (tail.length > room) tail = tail.slice(0, room).replace(/-+$/, "");
  return `${stamp}-${tail}`;
}

function writeJson(file, obj) { paths.atomicWrite(file, JSON.stringify(obj, null, 2) + "\n"); }

function usageNow(root) {
  for (const f of [path.join(root, ".claude", "lorc", "usage.json"), path.join(root, ".claude", "orc", "usage.json")]) {
    const j = paths.readJson(f, null);
    if (j && typeof j === "object") return j;
  }
  return null;
}
const pct = (o) => (o && typeof o.used_percentage === "number" ? o.used_percentage : null);
const sessionOf = (u) => (u && (u.session_id || u.sessionId)) || null;

// The files git sees as changed now (tracked + untracked), or null outside git.
function changedNow(root) {
  try { return require("./check.js").changedFiles(root); } catch (_) { return null; }
}

function startRun(root, { request, store, settings, now } = {}) {
  const t = nowMs(now);
  const base = makeSlug(request, t);
  let slug = base;
  for (let i = 2; fs.existsSync(runDir(root, slug)); i++) slug = `${base}-${i}`;
  const u = usageNow(root);
  const s = settings || {};
  const run = {
    slug, request: String(request || ""), started_at: iso(t),
    session_id: sessionOf(u),
    store: { mode: (store && store.mode) || null, dir: (store && store.dir) || null },
    settings: { dispatch: s.dispatch ?? null, dispatch_max: s.dispatch_max ?? null, executor: s.executor ?? null, review: s.review ?? null },
    tasks: [], checks: [],
    usage_start: { five_hour: pct(u && u.five_hour), seven_day: pct(u && u.seven_day) },
    // Files already changed before the run: run end does not count them (the tier eval's size).
    dirty_start: (changedNow(root) || []).slice(0, 500),
  };
  writeJson(runFile(root, slug), run);
  writeJson(currentFile(root), { slug, store_dir: run.store.dir, mode: run.store.mode, at: run.started_at });
  return { slug, dir: runDir(root, slug) };
}

function readRun(root, slug) {
  const r = paths.readJson(runFile(root, slug), null);
  if (!r) throw new Error(`no run "${slug}" (${runFile(root, slug)})`);
  return r;
}
function addTo(key) {
  return (root, slug, item) => {
    const r = readRun(root, slug);
    (r[key] = Array.isArray(r[key]) ? r[key] : []).push(item);
    writeJson(runFile(root, slug), r);
    return r;
  };
}
const addTask = addTo("tasks");
const addCheck = addTo("checks");

function resumeText(cp) {
  const fromSteps = (cp.steps || []).filter((s) => s && s.status === "done").map((s) => s.id || s.title);
  const done = fromSteps.concat(cp.done || []);
  return [
    `# RESUME — lorc run ${cp.slug}`,
    `Continue the Light ORC run \`${cp.slug}\`: type \`/lorc continue\` (prep finds this file).`,
    `Request: ${cp.request || "-"}`,
    `Read \`.claude/lorc/run/${cp.slug}/checkpoint.json\`.`,
    `Done: ${done.join(", ") || "-"}`,
    `Next: ${cp.next || "-"}`,
    `Decisions: ${(cp.decisions || []).join("; ") || "-"}`,
    "Do not redo done steps. Do not ask the answered questions again.",
  ].join("\n") + "\n";
}

function checkpoint(root, slug, body, { resume, now } = {}) {
  const r = readRun(root, slug);
  const b = body || {};
  const tier = b.tier || r.tier;
  const cp = {
    slug, request: r.request,
    ...(tier ? { tier } : {}),
    steps: Array.isArray(b.steps) ? b.steps : [],
    decisions: Array.isArray(b.decisions) ? b.decisions.map(String) : [],
    next: b.next || null,
    ...(b.step ? { step: b.step } : {}),
    ...(Array.isArray(b.done) ? { done: b.done.map(String) } : {}),
    reason: resume ? "wait" : "wave",
    updated_at: iso(nowMs(now)),
  };
  const dir = runDir(root, slug);
  writeJson(path.join(dir, "checkpoint.json"), cp);
  paths.atomicWrite(path.join(dir, "RESUME.md"), resumeText(cp));
  return { ok: true, checkpoint: path.join(dir, "checkpoint.json"), resume: path.join(dir, "RESUME.md") };
}

// The graph update runs DETACHED: the user does not wait for it. The next
// `lorc prep` heals the graph anyway (`graph status --heal`).
function graphUpdate(root) {
  const t = Date.now();
  try {
    const { spawn } = require("child_process");
    const child = spawn(process.execPath, [path.join(__dirname, "..", "lorc.js"), "graph", "update", "--json", "--dir", root], {
      cwd: root, detached: true, stdio: "ignore", windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    return { ok: true, mode: "detached", ms: Date.now() - t };
  } catch (e) {
    return { ok: false, mode: "detached", ms: Date.now() - t, error: e.message };
  }
}
function endRun(root, slug, body, { now, home, graph } = {}) {
  const b = body || {};
  const g = graph === false ? { ok: false, ms: 0, skipped: true } : graphUpdate(root);
  const r = readRun(root, slug);
  const t = nowMs(now);
  const findings = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of Array.isArray(b.findings) ? b.findings : []) if (f && f.sev in findings) findings[f.sev]++;
  const asks = Array.isArray(b.asks) ? b.asks : [];
  const tasks = Array.isArray(r.tasks) ? r.tasks : [];
  // The size of the change: files changed during the run; source files = not tests, locale
  // files, docs or lock files (the tier table counts these).
  // The engine's answer at prep time (prep.json): its tier, its estimate and the RAW estimate
  // (before self-calibration), so `lorc tier` can learn its size error from finished runs.
  const pj = paths.readJson(path.join(runDir(root, slug), "prep.json"), {}) || {};
  const te = pj.tier_engine && pj.tier_engine.tier ? pj.tier_engine : null;
  const tj = pj.tier_judge || {};
  const after = changedNow(root);
  const before = new Set(Array.isArray(r.dirty_start) ? r.dirty_start : []);
  const mine = after ? after.filter((f) => !before.has(f)) : null;
  Object.assign(r, {
    ended_at: iso(t), duration_s: Math.max(0, Math.round((t - Date.parse(r.started_at)) / 1000)),
    outcome: b.outcome || null, tier: b.tier || null, tier_by: b.tier_by || null, executor: b.executor || null,
    counts: { dispatches: tasks.length, checks: (r.checks || []).length, asks: asks.length, findings },
    files_changed: mine ? mine.length : null,
    src_files: mine ? mine.filter(require("./tier-history.js").isSrc).length : null,
    engine_tier: te ? te.tier : null,
    est_files: te ? te.est_files : null,
    est_raw: te && te.detail && te.detail.estimate && Number.isFinite(te.detail.estimate.raw) ? te.detail.estimate.raw : null,
    jev_tier: tj.by === "jev" ? tj.tier : null,
    graph: g,
  });
  writeJson(runFile(root, slug), r);
  const u = usageNow(root);
  const record = {
    slug, request: String(r.request || "").slice(0, 120), started_at: r.started_at, ended_at: r.ended_at,
    duration_s: r.duration_s, outcome: r.outcome, tier: r.tier, tier_by: r.tier_by, executor: r.executor,
    files_changed: r.files_changed, src_files: r.src_files,
    engine_tier: r.engine_tier, est_files: r.est_files, est_raw: r.est_raw, jev_tier: r.jev_tier,
    dispatches: tasks.length, asks: asks.length, findings, store_mode: (r.store && r.store.mode) || null,
    session_id: r.session_id || sessionOf(u),
    usage_start: r.usage_start || null,
    usage_end: { five_hour: pct(u && u.five_hour), seven_day: pct(u && u.seven_day) },
  };
  fs.mkdirSync(lorcDir(root), { recursive: true });
  fs.appendFileSync(runsLog(root), JSON.stringify(record) + "\n");
  let settings = {};
  try { settings = require("./settings.js").load(root, { home }).values; } catch (_) { /* defaults */ }
  require("./behaviour.js").record(root, slug, b, settings, { now: t });
  let habit = null;
  if (settings.habits && settings.habits !== "off") {
    try { habit = require("./habits.js").proposeOne(root, settings); } catch (_) { habit = null; }
  }
  for (const f of [currentFile(root), path.join(runDir(root, slug), "checkpoint.json"), path.join(runDir(root, slug), "RESUME.md")]) {
    try { fs.rmSync(f, { force: true }); } catch (_) { /* ignore */ }
  }
  return { ok: true, record, habit, graph: { ok: g.ok, ms: g.ms, ...(g.mode ? { mode: g.mode } : {}) } };
}

function latestResume(root) {
  let names = [];
  try { names = fs.readdirSync(runBase(root)); } catch (_) { return null; }
  let best = null;
  for (const n of names) {
    const p = path.join(runBase(root), n, "RESUME.md");
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (!best || st.mtimeMs > best.ms) best = { slug: n, path: p, ms: st.mtimeMs };
  }
  return best && { slug: best.slug, path: best.path, updated_at: iso(best.ms) };
}

function readRuns(root) {
  let text = "";
  try { text = fs.readFileSync(runsLog(root), "utf8"); } catch (_) { return []; }
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch (_) { /* skip */ }
  }
  return out;
}

const USAGE = "use: run start <request> | checkpoint --run <slug> [--resume] - | end --run <slug> - | resume [--run <slug>] | list [--limit N] [--json] | show <slug> [--json]";
const VALUE = new Set(["--dir", "--run", "--limit"]);

function readStdin() {
  let text;
  try { text = fs.readFileSync(0, "utf8"); } catch (_) { return { error: "no stdin JSON (pipe a JSON object after -)" }; }
  if (!text.trim()) return { error: "no stdin JSON (stdin is empty)" };
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "stdin JSON is not an object" };
    return { body: o };
  } catch (e) { return { error: `bad stdin JSON: ${e.message}` }; }
}

function cmd(argv = []) {
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith("--") || argv[i] === "-") continue;
    pos.push(argv[i]);
  }
  const root = val("--dir") ? path.resolve(val("--dir")) : paths.repoRoot();
  const json = wantsJson(argv);
  const sub = pos[0];
  const err = (m) => { process.stderr.write(`lorc run: ${m}\n`); return 2; };

  if (sub === "start") {
    let s = {};
    try { s = require("./settings.js").load(root).values; } catch (_) { /* defaults */ }
    const r = startRun(root, { request: pos.slice(1).join(" "), settings: s });
    if (json) emit(r); else process.stdout.write(`${r.slug}\n`);
    return 0;
  }
  if (sub === "checkpoint" || sub === "end") {
    const slug = val("--run");
    if (!slug) return err(`${sub} needs --run <slug>`);
    if (!argv.includes("-")) return err(`${sub} reads JSON from stdin — add "-"`);
    const { body, error } = readStdin();
    if (error) return err(error);
    if (!fs.existsSync(runFile(root, slug))) return err(`no run "${slug}"`);
    const graph = process.env.LORC_RUN_NO_GRAPH === "1" ? false : undefined;
    emit(sub === "end" ? endRun(root, slug, body, { graph }) : checkpoint(root, slug, body, { resume: argv.includes("--resume") }));
    return 0;
  }
  if (sub === "resume") {
    const slug = val("--run");
    const p = slug ? path.join(runDir(root, slug), "RESUME.md") : (latestResume(root) || {}).path;
    if (!p || !fs.existsSync(p)) { process.stdout.write("no RESUME.md — nothing to continue\n"); return 1; }
    process.stdout.write(fs.readFileSync(p, "utf8"));
    return 0;
  }
  if (sub === "list") {
    const n = Number(val("--limit")) || 20;
    const runs = readRuns(root).reverse().slice(0, n);
    if (json) { emit({ runs }); return 0; }
    if (!runs.length) process.stdout.write("no finished runs\n");
    for (const r of runs) process.stdout.write(`${r.slug}  ${r.outcome || "-"}  ${r.tier || "-"}  ${r.executor || "-"}  ${r.duration_s ?? "-"}s\n`);
    return 0;
  }
  if (sub === "show") {
    const slug = pos[1] || val("--run");
    if (!slug) return err("show needs <slug>");
    const r = paths.readJson(runFile(root, slug), null);
    if (!r) return err(`no run "${slug}"`);
    if (json) emit(r); else process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return 0;
  }
  return err(USAGE);
}

module.exports = { makeSlug, startRun, addTask, addCheck, checkpoint, endRun, latestResume, readRuns, resumeText, runDir, cmd };
