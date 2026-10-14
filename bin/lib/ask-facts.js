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

// prep's `must_ask[]`: [{ q, seen: [{ path, at[] }] }] or [].
function mustAsk(root, request, { doc, engine } = {}) {
  let docText = "";
  if (doc) { try { docText = fs.readFileSync(path.resolve(root, doc), "utf8"); } catch (_) { docText = ""; } }
  const router = engine && engine.detail && engine.detail.graph ? engine.detail.graph.router : null;
  if (!router || !addsRoute(`${request}\n${docText}`, engine)) return [];
  // Stems from the request; the doc only when the request has fewer than 2 (doc words are broad).
  let words = stems(request);
  if (words.length < 2) words = stems(`${request} ${docText.slice(0, 4000)}`);
  return [{ q: `route path of the new page (router ${router})`, seen: routeHints(root, router, words) }];
}

module.exports = { mustAsk, routeHints, definedPaths, stems, addsRoute, weightOf };
