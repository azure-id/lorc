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
function lorcJson(root, args, timeout = 60000) {
  const r = spawnSync(process.execPath, [LORC, ...args, "--json", "--dir", root], {
    cwd: root, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
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

function graphPart(root, words) {
  const sel = require("./graph-router.js").selectStore(root);
  const out = { mode: sel.mode, reason: sel.reason, state: null, focus: [] };
  if (fs.existsSync(path.join(root, ".claude", "orc", "graph", "meta.json"))) {
    lorcJson(root, ["graph", "sync", "--if-older", "24"], 60000);
  }
  const st = lorcJson(root, ["graph", "status", "--heal"], 120000);
  out.state = st.error ? "unknown" : st.state || null;
  if (st.error) out.error = st.error;
  if (words.length) {
    const m = lorcJson(root, ["graph", "map", `--focus=${words.join(",")}`, "--budget", "600"], 60000);
    if (m.error) out.error = m.error;
    else out.focus = focusRows(m);
  }
  out.store_dir = path.join(sel.claudeDir, "orc", "graph");
  return out;
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
  return out;
}

function prep(root, request, { start = true } = {}) {
  const s = part(() => require("./settings.js").load(root).values);
  const sv = s && !s.error ? s : require("./settings.js").DEFAULTS;
  const words = keywords(request);
  const out = {};
  out.usage = part(() => usagePart(root, sv));
  const g = part(() => graphPart(root, words));
  const storeDir = g.store_dir;
  delete g.store_dir;
  out.graph = g;
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
  out.tier_hint = tierHint(request, g.focus);
  out.resume = part(() => require("./runs.js").latestResume(root));
  let runDir = null;
  if (start) {
    const r = part(() => require("./runs.js").startRun(root, {
      request, store: { mode: g.mode || null, dir: storeDir || null }, settings: sv,
    }));
    if (r.error) out.slug = r;
    else { out.slug = r.slug; out.run_dir = r.dir; runDir = r.dir; }
  }
  if (!out.rules.error) {
    const card = part(() => require("./rules.js").buildCard(root, {
      files: focusFiles, out: runDir ? path.join(runDir, "rules-card.md") : undefined,
    }));
    if (card.error) out.rules.error = card.error;
    else out.rules.card = card.path;
  }
  if (runDir) {
    const pages = out.wiki && Array.isArray(out.wiki.pages) ? out.wiki.pages : [];
    part(() => paths.atomicWrite(path.join(runDir, "prep.json"), JSON.stringify({ wiki_pages: pages, focus_files: focusFiles }) + "\n"));
  }
  return fit(out);
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
    `tier hint: ${o.tier_hint.files_likely} files · ${o.tier_hint.areas} areas${o.tier_hint.risky_paths.length ? " · risky" : ""}${o.resume ? ` · resume ${o.resume.slug}` : ""}`,
  ];
  return L.join("\n") + "\n";
}

function cmd(argv = []) {
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") { i++; continue; }
    if (argv[i].startsWith("--")) continue;
    pos.push(argv[i]);
  }
  const di = argv.indexOf("--dir");
  const root = di >= 0 && argv[di + 1] ? path.resolve(argv[di + 1]) : paths.repoRoot();
  const o = prep(root, pos.join(" "), { start: !argv.includes("--no-start") });
  if (wantsJson(argv)) emit(o);
  else process.stdout.write(summary(o));
  return 0;
}

module.exports = { prep, fit, keywords, focusRows, tierHint, lorcJson, RISKY, MAX_BYTES, cmd };
