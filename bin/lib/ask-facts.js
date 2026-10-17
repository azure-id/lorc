"use strict";
// Facts the lane must ASK about, never pick (0.3.3). A new page or route needs a path. The
// lane once made one up (`outwards/transfer`) while a router comment and a test already named
// `outwards/create` → the e2e failed. Here: when the request adds a page/route and the repo has
// a router, prep returns a must-ask item with the path strings the repo already mentions for
// this feature but does not define yet (comments, tests, docs). Facts only; no decision.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROUTE_WORDS = /\b(route|routes|routing|router|page|pages|screen|url|path|flow|navigat\w*|wizard|stepper)\b/i;
const UI_UNITS = new Set(["page", "screen", "view", "route", "step", "flow", "wizard", "modal", "dialog"]);
const STOP = new Set(["build", "create", "update", "change", "remove", "delete", "added", "should", "which", "there", "their", "about", "after", "before", "where", "would", "could", "every", "other", "these", "those", "under", "using", "while", "first", "second", "third", "steps", "button", "field", "fields", "value", "values", "click", "opens", "shell", "route", "routes", "page", "pages", "screen", "flow", "method", "amount", "repo", "root", "requirement", "requirements"]);
const PATH_RE = /(['"`])(\/?[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)+)\1/g;
const SKIP_PATH = /^(\.{1,2}\/|@\/|~\/|https?:|\/\/)|\.(m?[jt]sx?|vue|svelte|css|s[ac]ss|less|json|png|jpe?g|svg|gif|ico|md|html?|py|go|rb|php)(:\d+)*$|(^|\/)src\//i;
const TEST_RE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const DOC_RE = /\.(md|mdx|txt|rst)$/i;
// A path that an API client, a mock or a fixture names is a backend URL, not a page route.
const API_RE = /(^|\/)(apis?|services?|mocks?|mockoon|fixtures?|__mocks__)(\/|\.)|\.api\.|\.json$/i;
const MAX_PATHS = 3;
const MAX_AT = 3;

// Code beats docs: a router comment or a test is stronger than a wiki page (a stale wiki
// page once named `outward/transfer-fund`).
const weightOf = (f, router) => (f === router ? 3 : TEST_RE.test(f) ? 2 : DOC_RE.test(f) ? 0.5 : 1);

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 || r.status === 1 ? String(r.stdout || "") : "";
}

// Feature stems: words of ≥ 5 letters, not generic; the first 6 letters.
function stems(text) {
  const out = new Set();
  for (const w of String(text).toLowerCase().match(/[a-z]{5,}/g) || []) {
    if (STOP.has(w)) continue;
    out.add(w.slice(0, 6));
    if (out.size >= 12) break;
  }
  return [...out];
}

// The request adds a page or a route: route words in the request/doc, or a UI unit that the engine found.
function addsRoute(text, engine) {
  if (ROUTE_WORDS.test(text)) return true;
  const creates = engine && engine.detail && engine.detail.text ? engine.detail.text.creates || [] : [];
  return creates.some((c) => UI_UNITS.has(String(c.noun || "").toLowerCase()));
}

const norm = (p) => String(p).replace(/^\/+|\/+$/g, "").toLowerCase();
const tail2 = (p) => norm(p).split("/").slice(-2).join("/");

// Path values the router defines now (`path: '…'`, `path="…"`, Django `path('…')`, Rails `get '…'`).
function definedPaths(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\bpath\s*[:=(]\s*['"`]([^'"`]+)['"`]|\b(?:get|post|put|patch|delete)\s+['"]([^'"]+)['"]/g)) {
    const p = norm(m[1] || m[2]);
    if (p) { out.add(p); if (p.includes("/")) out.add(tail2(p)); }
  }
  return out;
}

// Path strings near this feature that the router does not define: [{ path, at: [file:line] }],
// ranked by (stems in the path) × (evidence weight of the files that name it).
function routeHints(root, router, words) {
  if (!words.length) return [];
  let defined = new Set();
  try { defined = definedPaths(fs.readFileSync(path.join(root, router), "utf8")); } catch (_) { /* none */ }
  const args = ["grep", "-n", "-I", "-i", "--no-color"];
  for (const w of words) args.push("-e", w);
  args.push("--", ".", ":(exclude)**/node_modules/**", ":(exclude)**/dist/**", ":(exclude)**/*.lock", ":(exclude)**/package-lock.json", ":(exclude)**/i18n/**", ":(exclude)**/locales/**");
  const byPath = new Map();
  for (const line of git(root, args).split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const file = m[1].replace(/\\/g, "/");
    for (const pm of m[3].matchAll(PATH_RE)) {
      const p = pm[2];
      if (SKIP_PATH.test(p)) continue;
      const n = norm(p);
      const hit = words.filter((w) => n.includes(w)).length;
      if (!hit || defined.has(n) || defined.has(tail2(n))) continue;
      const key = tail2(n);
      const e = byPath.get(key) || { path: "/" + n, hit: 0, w: 0, api: false, at: [], files: new Set() };
      e.hit = Math.max(e.hit, hit);
      if (n.length > norm(e.path).length) e.path = "/" + n;
      if (!e.files.has(file)) {
        e.files.add(file);
        if (API_RE.test(file)) e.api = true;
        e.w += weightOf(file, router);
        if (e.at.length < MAX_AT) e.at.push(`${file}:${m[2]}`);
      }
      byPath.set(key, e);
    }
  }
  return [...byPath.values()].filter((e) => !e.api)
    .sort((a, b) => b.hit * b.w - a.hit * a.w || a.path.localeCompare(b.path))
    .slice(0, MAX_PATHS)
    .map((e) => ({ path: e.path, at: e.at }));
}

// ---- 0.4.0: more must-ask kinds (steps, field, name). Facts with evidence; the first option is the rec.

const STEP_WORDS = /\b(steps?|stepper|wizard|multi-step|\d+-step)\b/i;
const EXCL = [":(exclude)**/node_modules/**", ":(exclude)**/dist/**", ":(exclude)**/*.lock", ":(exclude)**/package-lock.json"];
const SHELL_V = "inside the shell (one route, step index)";
const ROUTES_V = "one route per step";
const lineOf = (text, idx) => String(text).slice(0, idx).split("\n").length;
const readLines = (root, f) => { try { return fs.readFileSync(path.join(root, f), "utf8").split(/\r?\n/); } catch (_) { return []; } };
const option = (v, at) => ({ v, at: at.slice(0, MAX_AT) });
const item = (q, kind, seen, why) => {
  const it = { q, kind, seen: seen.slice(0, MAX_PATHS) };
  if (it.seen.length) it.rec = it.seen[0].v;
  if (why) it.why = why;
  return it;
};

// The request, the doc or the engine names steps (step, stepper, wizard, multi-step, "N-step").
function namesSteps(text, engine) {
  if (STEP_WORDS.test(text)) return true;
  const creates = engine && engine.detail && engine.detail.text ? engine.detail.text.creates || [] : [];
  return creates.some((c) => ["step", "stepper", "wizard"].includes(String(c.noun || "").toLowerCase()));
}

// kind "steps": how the flow switches steps. One git grep for step constants, step-index use and
// step routes. A comment within ±3 lines of the constant says which side is true (strong evidence).
function stepsItem(root, words) {
  const out = git(root, ["grep", "-n", "-I", "-E", "--no-color",
    "-e", "\\b[A-Z][A-Z0-9_]*STEPS?\\b[[:space:]]*[=:]",
    "-e", "\\b(goToStep|stepIndex|currentStep|activeStep)\\b",
    "-e", "path[[:space:]]*:[[:space:]]*['\"`][^'\"`]*step",
    "--", ".", ...EXCL]);
  const consts = []; const idx = new Map(); const per = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const file = m[1].replace(/\\/g, "/");
    if (TEST_RE.test(file) || DOC_RE.test(file)) continue;
    if (/\b[A-Z][A-Z0-9_]*STEPS?\b\s*[=:]/.test(m[3])) consts.push({ file, n: +m[2] });
    if (/\b(goToStep|stepIndex|currentStep|activeStep)\b/.test(m[3]) && !idx.has(file)) idx.set(file, `${file}:${m[2]}`);
    if (/path\s*:\s*['"`][^'"`]*step/i.test(m[3]) && !per.has(file)) per.set(file, `${file}:${m[2]}`);
  }
  let best = null;
  for (const c of consts) {
    const lines = readLines(root, c.file);
    const win = [];
    for (let k = Math.max(1, c.n - 3); k <= Math.min(lines.length, c.n + 3); k++) win.push({ k, t: lines[k - 1] });
    const hay = `${c.file} ${win.map((w) => w.t).join(" ")}`.toLowerCase();
    const score = words.filter((w) => hay.includes(w)).length;
    if (score && (!best || score > best.score)) best = { ...c, win, score };
  }
  if (!best) return null;
  let shellW = 0; let routesW = 0; const shellAt = []; const routesAt = [];
  for (const w of best.win) {
    if (!/^\s*(\/\/|\/?\*|#|<!--)/.test(w.t || "")) continue;
    const t = w.t.toLowerCase();
    if (/(url|route|path)[^.;]{0,40}(stays|same|does not change|unchanged)|inside|same url|one route/.test(t)) { shellW += 3; shellAt.push(`${best.file}:${w.k}`); }
    else if (/(route|url|path) (per|for each|for every) step|own (route|url)/.test(t)) { routesW += 3; routesAt.push(`${best.file}:${w.k}`); }
  }
  const near = (x) => words.filter((w) => x.toLowerCase().includes(w)).length;
  for (const a of [...idx.values()].sort((x, y) => near(y) - near(x))) { shellW += 1; shellAt.push(a); }
  for (const a of per.values()) { routesW += 1; routesAt.push(a); }
  const shell = option(SHELL_V, shellAt); const routes = option(ROUTES_V, routesAt);
  return item(`How does the flow switch steps? (${best.file})`, "steps", routesW > shellW ? [routes, shell] : [shell, routes]);
}

// Doc payload keys: JSON objects after payload / request / body. [{ key, line }].
function payloadKeys(docText) {
  const out = [];
  const re = /\b(payload|request|body)\b/gi;
  let m;
  while ((m = re.exec(docText))) {
    const open = docText.indexOf("{", m.index);
    if (open < 0 || open - m.index > 200) continue;
    let d = 0; let end = -1;
    for (let k = open; k < docText.length && k < open + 4000; k++) {
      if (docText[k] === "{") d++;
      else if (docText[k] === "}" && --d === 0) { end = k; break; }
    }
    if (end < 0) continue;
    const block = docText.slice(open, end + 1);
    for (const km of block.matchAll(/["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/g)) {
      if (!out.some((o) => o.key === km[1])) out.push({ key: km[1], line: lineOf(docText, open + km.index) });
    }
    re.lastIndex = end;
  }
  return out;
}

// Keys of the first object in the first array of a JSON value.
function firstKeys(v, depth = 0) {
  if (depth > 6 || v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) return v.length && v[0] && typeof v[0] === "object" && !Array.isArray(v[0]) ? Object.keys(v[0]) : null;
  for (const x of Object.values(v)) { const k = firstKeys(x, depth + 1); if (k) return k; }
  return null;
}

// Object keys of the data near a mention (≤ 40 lines): a mockoon "body" string, or a line scan.
function dataKeys(lines, n) {
  const win = lines.slice(n - 1, n + 39);
  for (const l of win) {
    const b = /^\s*"body"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(l);
    if (b) { try { const k = firstKeys(JSON.parse(JSON.parse(b[1]))); if (k) return k; } catch (_) { /* not JSON */ } }
  }
  const text = win.join("\n");
  const a = text.search(/\[\s*\{/);
  const start = a >= 0 ? text.indexOf("{", a) : text.indexOf("{");
  if (start < 0) return null;
  const keys = []; let d = 0;
  for (let k = start; k < text.length; k++) {
    const ch = text[k];
    if (ch === "{" || ch === "[") d++;
    else if (ch === "}" || ch === "]") { if (--d === 0) break; }
    else if (d === 1 && /[\s{,]/.test(text[k - 1] || " ")) {
      const km = /^["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/.exec(text.slice(k, k + 80));
      if (km) { if (!keys.includes(km[1])) keys.push(km[1]); k += km[0].length - 1; }
    }
  }
  return keys.length ? keys : null;
}

const DATA_SPECS = [":(glob)**/mock*/**", ":(glob)**/mockoon/**", ":(glob)**/fixture*/**", ":(glob)**/__mocks__/**", ":(glob)**/*.api.js", ":(glob)**/*.api.ts"];

// kind "field": a doc key `X_id` / `XId` whose entity X has repo data with no `id` key.
function fieldItems(root, doc, docText) {
  for (const { key, line } of payloadKeys(docText)) {
    const em = /^([a-z][a-z0-9_]*?)_id$/.exec(key) || /^([a-z][A-Za-z0-9]*?)Id$/.exec(key);
    if (!em) continue;
    const parts = em[1].replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split("_").filter(Boolean);
    if (!parts.length) continue;
    const forms = new Set();
    for (const sep of ["_", "-", ""]) for (const pl of ["", "s"]) {
      const p = parts.slice(); p[p.length - 1] += pl;
      forms.add(sep ? p.join(sep) : p[0] + p.slice(1).map((x) => x[0].toUpperCase() + x.slice(1)).join(""));
    }
    const hits = [];
    const args = ["grep", "-n", "-I", "-i", "-F", "--no-color"];
    for (const f of forms) args.push("-e", f);
    for (const l of git(root, [...args, "--", ...DATA_SPECS, ...EXCL]).split(/\r?\n/)) {
      const m = /^(.+?):(\d+):/.exec(l);
      if (m && hits.length < 40) hits.push({ file: m[1].replace(/\\/g, "/"), n: +m[2] });
    }
    for (const f of git(root, ["ls-files", "--", ...DATA_SPECS]).split(/\r?\n/)) {
      const low = f.toLowerCase();
      if (f && [...forms].some((x) => low.includes(x.toLowerCase()))) hits.push({ file: f, n: 1 });
    }
    const cand = new Map(); let hasId = false; const cache = new Map();
    for (const h of hits) {
      if (!cache.has(h.file)) cache.set(h.file, readLines(root, h.file));
      const keys = dataKeys(cache.get(h.file), h.n);
      if (!keys) continue;
      if (keys.includes("id")) { hasId = true; break; }
      for (const k of keys) { const at = cand.get(k) || []; if (at.length < MAX_AT) at.push(`${h.file}:${h.n}`); cand.set(k, at); }
    }
    if (hasId || !cand.size) continue;
    const x = parts.join("_"); const lastW = parts[parts.length - 1];
    const pref = ["code", "uuid", `${x}_code`, `${lastW}_code`, "value", "key", "slug", lastW, "type", "name"];
    const order = [...pref.filter((k) => cand.has(k)), ...[...cand.keys()].filter((k) => !pref.includes(k))];
    return [item(`Which field of ${x} is sent as \`${key}\`? (${doc}:${line})`, "field",
      order.map((k) => option(k, cand.get(k))), "the repo data has no `id` key")];
  }
  return [];
}

// kind "name": the doc names a new spec in a casing that differs from its sibling specs.
function nameItem(root, doc, docText) {
  const lines = docText.split(/\r?\n/);
  let found = null;
  for (let i = 0; i < lines.length && !found; i++) {
    if (!/\b(spec|test)\b/i.test(lines[i])) continue;
    const m = /\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+)(\.(?:spec|test)\.[cm]?[jt]sx?)?\b/.exec(lines[i]);
    if (m) found = { name: m[1], ext: m[2], line: i + 1 };
  }
  if (!found) return null;
  const parts = found.name.split(/(?=[A-Z])/).map((p) => p.toLowerCase());
  const suffix = parts[parts.length - 1];
  const specs = git(root, ["ls-files", "--", ":(glob)**/*.spec.*", ":(glob)**/*.test.*"]).split(/\r?\n/).filter(Boolean);
  const byDir = new Map();
  for (const f of specs) {
    const base = path.posix.basename(f);
    if (!/^[A-Z]/.test(base)) continue;
    const dir = path.posix.dirname(f);
    const low = f.toLowerCase();
    const score = parts.filter((p) => p.length >= 4 && low.includes(p)).length + (base.toLowerCase().includes(suffix) ? 2 : 0);
    const e = byDir.get(dir) || { dir, score: 0, files: [] };
    e.score = Math.max(e.score, score);
    e.files.push(f);
    byDir.set(dir, e);
  }
  const best = [...byDir.values()].sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir))[0];
  if (!best || best.score < 2) return null;
  const has = (f) => Number(path.posix.basename(f).toLowerCase().includes(suffix));
  const sib = best.files.sort((a, b) => has(b) - has(a));
  const ext = found.ext || (/(\.(?:spec|test)\.[cm]?[jt]sx?)$/.exec(sib[0]) || [null, ".spec.js"])[1];
  const pascal = found.name[0].toUpperCase() + found.name.slice(1);
  return item("File name of the new spec?", "name", [
    option(`${best.dir}/${pascal}${ext}`, sib.slice(0, 2)),
    option(found.name + (found.ext || ""), [`${doc}:${found.line}`]),
  ], "sibling specs use PascalCase");
}

// prep's `must_ask[]`: [{ q, kind, seen: [{ v, path?, at[] }], rec?, why? }] or [] (max 4, route first).
function mustAsk(root, request, { doc, engine } = {}) {
  try {
    let docText = "";
    if (doc) { try { docText = fs.readFileSync(path.resolve(root, doc), "utf8"); } catch (_) { docText = ""; } }
    const all = `${request}\n${docText}`;
    // Stems from the request; the doc only when the request has fewer than 2 (doc words are broad).
    let words = stems(request);
    if (words.length < 2) words = stems(`${request} ${docText.slice(0, 4000)}`);
    const items = [];
    const router = engine && engine.detail && engine.detail.graph ? engine.detail.graph.router : null;
    if (router && addsRoute(all, engine)) {
      const seen = routeHints(root, router, words).map((h) => ({ v: h.path, path: h.path, at: h.at }));
      items.push(item(`route path of the new page (router ${router})`, "route", seen));
    }
    if (namesSteps(all, engine)) {
      try { const s = stepsItem(root, words); if (s) items.push(s); } catch (_) { /* no item */ }
    }
    if (docText) {
      try { items.push(...fieldItems(root, doc, docText)); } catch (_) { /* no item */ }
      try { const n = nameItem(root, doc, docText); if (n) items.push(n); } catch (_) { /* no item */ }
    }
    return items.slice(0, 4);
  } catch (_) { return []; }
}

module.exports = { mustAsk, routeHints, definedPaths, stems, addsRoute, weightOf, namesSteps, stepsItem, payloadKeys, dataKeys, fieldItems, nameItem };
