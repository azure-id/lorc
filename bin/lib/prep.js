"use strict";
// lorc prep — the ONE L0 call of /lorc. Each part is fail-soft: a part that
// fails gives { error } and the other parts go on. Output ≤ 4,096 bytes.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const MAX_BYTES = 4096;
const FOCUS_MAX = 8;
const RISKY = /auth|secur|payment|migrat|secret|token|crypto|permission/i;
const NEW_WORDS = /\b(new|create|creates|creating|add|adds|adding|introduce|scaffold)\b/i;
const STOP = new Set(("the and for with from into onto this that these those are was were has have had " +
  "not but can should would could will please make fix update change use add new create when then than " +
  "also just all any some our your their its out off one two lorc").split(" "));
const LORC = path.join(__dirname, "..", "lorc.js");

// Run `lorc <args> --json --dir <root>` in a child and parse its JSON.
function lorcJson(root, args, timeout = 60000, input) {
  const r = spawnSync(process.execPath, [LORC, ...args, "--json", "--dir", root], {
    cwd: root, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, input,
  });
  if (r.error) return { error: r.error.code === "ETIMEDOUT" ? "timeout" : r.error.message };
  try { return JSON.parse(String(r.stdout || "").trim().split(/\r?\n/).pop()); } catch (_) {
    return { error: `exit ${r.status}, no JSON` };
  }
}

function keywords(request) {
  const out = [];
  for (const w of String(request || "").toLowerCase().split(/[^a-z0-9_]+/)) {
    if (w.length < 3 || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

// Words for the graph map (no pack): every content word, verbs dropped, ≤ 12.
const VERBS = new Set("build create add wire make implement update fix change use show fetch open new".split(" "));
function mapWords(request) {
  const out = [];
  for (const w of String(request || "").toLowerCase().split(/[^a-z0-9_]+/)) {
    if (w.length < 3 || STOP.has(w) || VERBS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 12) break;
  }
  return out;
}

// Focus rows from the context pack: targets first, then exemplars; ≤ 6.
function packRows(pack) {
  if (!pack) return [];
  return [...(pack.targets || []), ...(pack.exemplars || [])].slice(0, 6)
    .map((i) => ({ sym: String(i.what || "").slice(0, 40), file: i.file, line: i.start }));
}

function part(fn) {
  try { return fn(); } catch (e) { return { error: String((e && e.message) || e).slice(0, 120) }; }
}

const r1 = (n) => (typeof n === "number" ? Math.round(n) : n == null ? null : n);

function usagePart(root, s) {
  const c = require("./usage.js").check(root, s);
  return {
    gate: c.state,
    five_hour: c.five_hour ? r1(c.five_hour.used) : null,
    resets_in_min: c.five_hour ? c.five_hour.resets_in_min : null,
    weekly: c.seven_day ? r1(c.seven_day.used) : null,
    context: r1(c.context),
  };
}

function focusRows(map) {
  const rows = [];
  const files = Array.isArray(map && map.files) ? map.files : [];
  // Round one: the best symbol of each file (exported first); round two: the next.
  for (let round = 0; round < 3 && rows.length < FOCUS_MAX; round++) {
    for (const f of files) {
      if (rows.length >= FOCUS_MAX) break;
      const syms = (f.symbols || []).slice().sort((a, b) => (b.exported ? 1 : 0) - (a.exported ? 1 : 0));
      const s = syms[round];
      if (!s) continue;
      const row = { sym: s.qname, file: f.file, line: s.lines ? s.lines[0] : null };
      if (s.kind) row.kind = s.kind;
      const doc = s.doc || s.role;
      if (doc) row.role = String(doc).split(/\r?\n/)[0].slice(0, 100);
      rows.push(row);
    }
  }
  return rows;
}

// Update the changed files. No graph → build nothing; `suggest` tells the user
// to run `lorc graph scan`. In process
// (no child). `lorc tier` calls this too.
function healGraph(root) {
  try { return require("./graph-router.js").heal(root); } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 120) };
  }
}

// Heal, then load the own store ONCE (`loaded`). Delegate mode or a load failure → null.
function graphPart(root) {
  const R = require("./graph-router.js");
  const sel = R.selectStore(root);
  const out = { mode: sel.mode, reason: sel.reason, state: null, focus: [] };
  const st = healGraph(root);
  out.state = st.error ? "unknown" : st.state || null;
  if (st.error) out.error = st.error;
  if (st.suggest) out.suggest = st.suggest;
  out.loaded = null;
  if (sel.mode === "own") {
    try {
      const Q = require("./graph/graph-query.js");
      const model = Q.loadModel(sel.claudeDir, root);
      if (model) out.loaded = { Q, model, claudeDir: sel.claudeDir };
    } catch (_) { out.loaded = null; }
  }
  out.store_dir = path.join(sel.claudeDir, "orc", "graph");
  return out;
}

// No pack: the graph map rows (a child), with the better words.
function mapFocus(root, g, request) {
  const words = mapWords(request);
  if (!words.length) return [];
  const m = lorcJson(root, ["graph", "map", `--focus=${words.join(",")}`, "--budget", "600"], 60000);
  if (m.error) { g.error = m.error; return []; }
  return focusRows(m);
}

function wikiPart(root, request) {
  const wiki = require("./wiki.js");
  let st = wiki.status(root);
  let repaired = false;
  if (st.state !== "none" && st.state !== "registered") {
    try { wiki.sync(root); repaired = true; st = wiki.status(root); } catch (_) { /* keep the first */ }
  }
  const out = { state: st.state, tier: st.tier, pages: wiki.pick(root, request), commands: wiki.commands(root) };
  if (repaired) out.repaired = true;
  return out;
}

function tierHint(request, focus) {
  const files = [...new Set((focus || []).map((r) => r.file).filter(Boolean))];
  const areas = new Set(files.map((f) => String(f).split("/").slice(0, 2).join("/")));
  return {
    files_likely: files.length,
    areas: areas.size,
    new_files_likely: NEW_WORDS.test(String(request || "")),
    risky_paths: files.filter((f) => RISKY.test(f)),
  };
}

// lorc's own tier engine: in process with the loaded graph; delegate mode or no
// graph → `lorc tier` (a child). `tier_engine: off` → null.
function enginePart(root, request, sv, doc, loaded) {
  if (sv.tier_engine === "off") return null;
  if (loaded) {
    const r = require("./tier.js").compute(root, request, { doc, loaded });
    if (r && r.tier && r.detail) return r;
    return { error: (r && r.error) || "no answer" };
  }
  // prep healed the graph already: the engine child must not do it again.
  const r = lorcJson(root, ["tier", request, "--no-heal", ...(doc ? ["--doc", doc] : [])], 30000);
  if (r && r.tier && r.detail) return r;
  return { error: (r && r.error) || "no answer" };
}

// What jev may see from the engine: its evidence, never its tier.
function evidenceOf(e) {
  if (!e || !e.detail) return null;
  const d = e.detail;
  return {
    est_files: e.est_files, creates: (d.text.creates || []).map((c) => c.text || c.noun).slice(0, 6),
    areas: d.areas ? d.areas.n : null, blast: d.estimate ? d.estimate.blast : 0,
    similar: d.history && d.history.similar && d.history.similar.n ? { n: d.history.similar.n, median: d.history.similar.median_src } : null,
    mechanical: Boolean(d.mechanical),
  };
}

// L2 tier judge: jev when a TypeSafe key is connected, else the engine (or the table).
// No key or `tier_judge: off` → no child, no network. The full answer goes to prep.json.
function judgePart(root, request, hint, files, sv, engine) {
  if (sv.tier_judge === "off") return { by: "table", reason: "off" };
  const jev = require("./jev.js");
  if (!jev.resolve().key) return { by: "table", reason: "no key" };
  const input = { request, tier_hint: hint, files, engine: evidenceOf(engine) };
  const r = lorcJson(root, ["jev", "tier"], jev.TIMEOUT_MS + 4000, JSON.stringify(input));
  if (r.error) return { by: "table", reason: r.error === "timeout" ? "timeout" : "judge failed" };
  return r && (r.by === "jev" || r.by === "table") ? r : { by: "table", reason: "judge failed" };
}

// jev decides when it answered with confidence; else the engine; else the table.
function decideTier(judge, engine) {
  const e = engine && engine.tier ? engine : null;
  if (!judge.error && judge.by === "jev") return { ...judgeOut(judge), ...(e ? { engine: e.tier } : {}) };
  const reason = judge.error ? "judge failed" : judge.reason;
  if (e) return { by: "engine", tier: e.tier, conf: e.conf, reason, ...(judge.jev ? { jev: judge.jev } : {}) };
  return judge.error ? { by: "table", reason } : judgeOut(judge);
}

// True when the skill should send its L3 options to `lorc jev ask`.
function askHow(slug) {
  return `Before the L3 message: lorc jev ask --run ${slug} --json - <<'EOF'\n` +
    '{"intent":"…","questions":[{"id":"q1","q":"…","facts":"<file:line — fact>","options":{"a":"…","b":"…"}}]}\nEOF';
}

function askOn(sv) {
  if (sv.ask_judge === "off") return false;
  const jev = require("./jev.js");
  const c = jev.resolve();
  return Boolean(c.key) && !jev.checkBase(c.base);
}

// The skill needs the verdict, not the distribution.
function judgeOut(j) {
  const o = { by: j.by };
  for (const k of ["tier", "conf", "consistent", "reason", "jev", "signals", "model"]) if (j[k] !== undefined && j[k] !== null) o[k] = j[k];
  return o;
}

function bytes(o) { return Buffer.byteLength(JSON.stringify(o), "utf8"); }

// Drop `role`, then focus rows, then wiki pages, until the JSON fits.
function fit(out) {
  if (bytes(out) <= MAX_BYTES) return out;
  out.trimmed = true;
  const focus = out.graph && Array.isArray(out.graph.focus) ? out.graph.focus : null;
  if (focus) for (const r of focus) delete r.role;
  while (bytes(out) > MAX_BYTES && focus && focus.length) focus.pop();
  const pages = out.wiki && Array.isArray(out.wiki.pages) ? out.wiki.pages : null;
  while (bytes(out) > MAX_BYTES && pages && pages.length) pages.pop();
  if (bytes(out) > MAX_BYTES && out.graph) delete out.graph.reason;
  if (bytes(out) > MAX_BYTES && out.extra && Array.isArray(out.extra.slots)) out.extra.slots = out.extra.slots.slice(0, 3);
  if (bytes(out) > MAX_BYTES && out.tier_judge) delete out.tier_judge.signals;
  if (bytes(out) > MAX_BYTES && out.tier_engine) delete out.tier_engine.split;
  if (bytes(out) > MAX_BYTES && out.tier_engine && out.tier_engine.why) out.tier_engine.why = out.tier_engine.why.slice(0, 1);
  // must_ask stays (it is a gate); only its evidence lists get shorter.
  if (bytes(out) > MAX_BYTES && Array.isArray(out.must_ask)) for (const m of out.must_ask) for (const s of m.seen || []) if (Array.isArray(s.at)) s.at = s.at.slice(0, 1);
  // context stays; at the end it keeps only its path.
  if (bytes(out) > MAX_BYTES && out.context && out.context.path) out.context = { path: out.context.path };
  return out;
}

function prep(root, request, { start = true, doc } = {}) {
  const s = part(() => require("./settings.js").load(root).values);
  const sv = s && !s.error ? s : require("./settings.js").DEFAULTS;
  const out = {};
  out.usage = part(() => usagePart(root, sv));
  const g = part(() => graphPart(root));
  const storeDir = g.store_dir;
  const loaded = g.loaded || null;
  delete g.store_dir;
  delete g.loaded;
  out.graph = g;
  const engine = part(() => enginePart(root, request, sv, doc, loaded));
  const eng = engine && engine.tier ? engine : null;
  // The context pack: request/doc names, change targets, exemplars, tests.
  const pack = part(() => require("./context.js").build(root, request, { doc, loaded, engine: eng }));
  const packOk = Boolean(pack && !pack.error);
  const nItems = packOk ? ["targets", "exemplars", "tests", "reuse"].reduce((n, k) => n + (pack[k] || []).length, 0) +
    (pack.entities || []).reduce((n, e) => n + (e.at || []).length, 0) : 0;
  const rows = packOk ? packRows(pack) : [];
  if (!g.error) g.focus = rows.length ? rows : part(() => mapFocus(root, g, request));
  if (!Array.isArray(g.focus)) g.focus = [];
  const focusFiles = [...new Set((g.focus || []).map((r) => r.file))];
  out.rules = part(() => {
    const rules = require("./rules.js");
    const h = rules.house(root);
    return { house: h ? h.path : null, bytes: h ? h.bytes : 0, warn: h ? h.warn : false, card: null };
  });
  out.wiki = part(() => wikiPart(root, request));
  out.pattern = part(() => {
    const pattern = require("./pattern.js");
    const langs = pattern.langsForFiles(focusFiles, root);
    return langs.length ? pattern.status(root, langs).map((p) => ({ lang: p.lang, cached: p.cached, path: p.path })) : [];
  });
  out.extra = part(() => { const d = require("./extra.js").detect(root); return { source: d.source, slots: d.slots }; });
  out.settings = s && s.error ? s : {
    dispatch: sv.dispatch, dispatch_max: sv.dispatch_max, executor: sv.executor,
    review: sv.review, pattern_miss: sv.pattern_miss, limit_pct: sv.limit_pct,
  };
  const hint = tierHint(request, g.focus);
  if (engine) out.tier_engine = engine.tier ? require("./tier.js").brief(engine) : { error: String(engine.error).slice(0, 80) };
  const judge = part(() => judgePart(root, request, hint, focusFiles, sv, engine));
  out.tier_judge = decideTier(judge, engine);
  // The old hint is for the table only (engine off or failed): the engine replaces it.
  if (out.tier_judge.by === "table") out.tier_hint = hint;
  // 0.3.3: facts the lane must ask (a new page's route path), with the repo's own hints.
  const must = part(() => require("./ask-facts.js").mustAsk(root, request, { doc, engine: engine && engine.tier ? engine : null }));
  if (Array.isArray(must) && must.length) out.must_ask = must;
  const ask = part(() => askOn(sv)) === true;
  out.resume = part(() => require("./runs.js").latestResume(root));
  let runDir = null;
  if (start) {
    const r = part(() => require("./runs.js").startRun(root, {
      request, doc, store: { mode: g.mode || null, dir: storeDir || null }, settings: sv,
    }));
    if (r.error) out.slug = r;
    else { out.slug = r.slug; out.run_dir = r.dir; runDir = r.dir; }
  }
  if (packOk) {
    out.context = { items: nItems, bytes: pack.bytes };
    if (runDir) {
      const w = part(() => require("./context.js").write(runDir, pack));
      if (w && !w.error) out.context = { path: w.md, items: nItems, bytes: pack.bytes };
    }
  } else if (pack && pack.error) out.context = { error: String(pack.error).slice(0, 80) };
  // jev rates the L3 options: prep says HOW, so the skill does not carry the format.
  out.ask_judge = ask ? { how: askHow(typeof out.slug === "string" ? out.slug : "<slug>") } : false;
  if (!out.rules.error) {
    const card = part(() => require("./rules.js").buildCard(root, {
      files: focusFiles, out: runDir ? path.join(runDir, "rules-card.md") : undefined,
    }));
    if (card.error) out.rules.error = card.error;
    else out.rules.card = card.path;
  }
  if (runDir) {
    const pages = out.wiki && Array.isArray(out.wiki.pages) ? out.wiki.pages : [];
    part(() => paths.atomicWrite(path.join(runDir, "prep.json"), JSON.stringify({ wiki_pages: pages, focus_files: focusFiles, tier_judge: judge, tier_engine: engine && engine.tier ? engine : null }) + "\n"));
  }
  return fit(out);
}

function judgeLine(j) {
  if (!j) return "?";
  if (j.by === "jev") return `jev ${j.tier} ${Math.round(j.conf * 100)} %${j.engine ? ` (engine ${j.engine})` : ""}`;
  const hint = j.jev ? `; jev ${j.jev.tier} ${Math.round(j.jev.conf * 100)} %` : "";
  if (j.by === "engine") return `engine ${j.tier} ${Math.round(j.conf * 100)} % (jev: ${j.reason || "?"}${hint})`;
  return `table (${j.reason || "?"}${hint})`;
}

function engineLine(e) {
  if (!e) return "off";
  if (e.error) return `failed (${e.error})`;
  return `${e.tier} ${Math.round(e.conf * 100)} % · ~${e.est_files} files · cap ${e.cap} · groups ${e.groups} · ${e.cap === 0 ? "inline" : e.executor}`;
}

function summary(o) {
  const g = o.graph || {};
  const L = [
    `lorc prep${o.slug && typeof o.slug === "string" ? ` — run ${o.slug}` : " (no run started)"}`,
    `usage: gate ${o.usage && o.usage.gate || "?"} · 5h ${o.usage && o.usage.five_hour != null ? o.usage.five_hour + "%" : "--"} · wk ${o.usage && o.usage.weekly != null ? o.usage.weekly + "%" : "--"}`,
    `graph: ${g.mode || "?"} · ${g.state || g.error || "?"} · ${(g.focus || []).length} focus rows`,
    ...(g.focus || []).slice(0, 3).map((r) => `  ${r.sym}  ${r.file}:${r.line}`),
    `rules: house ${o.rules && o.rules.house ? "yes" : "no"} · card ${o.rules && o.rules.card || "-"}`,
    `wiki: ${o.wiki && (o.wiki.state || o.wiki.error) || "?"} · ${(o.wiki && o.wiki.pages || []).length} pages`,
    `pattern: ${Array.isArray(o.pattern) ? o.pattern.map((p) => `${p.lang} ${p.cached ? "cached" : "missing"}`).join(", ") || "none" : "?"} · extra: ${o.extra && o.extra.source || "?"}`,
    ...(o.tier_hint ? [`tier hint: ${o.tier_hint.files_likely} files · ${o.tier_hint.areas} areas${o.tier_hint.risky_paths.length ? " · risky" : ""}`] : []),
    ...(o.resume ? [`resume: ${o.resume.slug}`] : []),
    `tier engine: ${engineLine(o.tier_engine)}`,
    `tier judge: ${judgeLine(o.tier_judge)} · ask judge ${o.ask_judge ? "on" : "off"}`,
  ];
  return L.join("\n") + "\n";
}

function cmd(argv = []) {
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" || argv[i] === "--doc") { i++; continue; }
    if (argv[i].startsWith("--")) continue;
    pos.push(argv[i]);
  }
  const di = argv.indexOf("--dir");
  const root = di >= 0 && argv[di + 1] ? path.resolve(argv[di + 1]) : paths.repoRoot();
  const ci = argv.indexOf("--doc");
  const o = prep(root, pos.join(" "), { start: !argv.includes("--no-start"), doc: ci >= 0 ? argv[ci + 1] : undefined });
  if (wantsJson(argv)) emit(o);
  else process.stdout.write(summary(o));
  return 0;
}

module.exports = { prep, fit, keywords, mapWords, packRows, focusRows, tierHint, healGraph, enginePart, evidenceOf, judgePart, decideTier, judgeOut, askOn, askHow, lorcJson, RISKY, MAX_BYTES, cmd };
