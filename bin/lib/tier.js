"use strict";
// lorc tier — lorc's own tier engine (DE-T5). Facts from the request text, the code
// graph, the git history and lorc's past runs → tier, score, confidence, cap, split,
// executor, and the evidence lines. Deterministic: one repo state and one request
// give one answer. It reads; it never writes code. The only file it writes is the
// git-history cache under .claude/lorc/tier/.
//
// The contract is the SKILL.md L2 table, measured in SOURCE files (tests, locale files,
// docs and lock files do not count): low ≤ 2 files, 1 area, no new module · mid 3–5
// files or 1 new component · high 6–20 files, ≥ 2 new components or 2–3 areas ·
// complex > 20 files, > 3 areas, ordered steps, a migration. Each signal places a
// score in a 25-point band; the highest wins (the table's "or").
const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");
const TT = require("./tier-text.js");
const TH = require("./tier-history.js");

const VENDOR = path.join(__dirname, "graph");
const TIERS = ["low", "mid", "high", "complex"];
const CAP = { low: 0, mid: 1, high: 3, complex: 5 };
const RISKY = /auth|secur|payment|billing|refund|migrat|secret|token|crypto|permission|wallet|ledger/i;
// The file that registers a new page or endpoint: JS/TS routers, Angular, Django urls.py,
// Rails routes.rb, Laravel routes/*.php, Go / Rust / Elixir / Python / JVM router files.
const ROUTER = /(^|\/)(router|routes)(\/index)?\.[cm]?[jt]sx?$|(^|\/)router\/[^/]+\.[cm]?[jt]sx?$|(^|\/)app-routing\.module\.ts$|(^|\/)urls\.py$|(^|\/)config\/routes\.rb$|(^|\/)routes\/(web|api)\.php$|(^|\/)(router|routes?)\.(go|rs|ex|py|kt|java|cs)$|(^|\/)routers?\/[^/]+\.(py|go|rs|ex)$/i;
const API_CLIENT = /(^|\/)(api|apis|services?|network|clients?)\/[^/]+\.(?:[cm]?[jt]sx?|dart|kt|swift|java|cs|py|go)$/i;
// A new project root: the nearest folder with one of these (any language).
const PROJECT_MARKS = ["package.json", "pyproject.toml", "setup.py", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml",
  "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "mix.exs", "pubspec.yaml", "Package.swift", "CMakeLists.txt", "build.sbt"];
const EXECUTORS = ["haiku-5-high", "sonnet-5-med", "opus-5-low", "opus-5-med"];
const TYPE_NOUNS = new Set(["class", "struct", "interface", "trait", "enum", "protocol"]);

const tierOf = (s) => (s < 25 ? "low" : s < 50 ? "mid" : s < 75 ? "high" : "complex");
const center = (t) => ({ low: 12, mid: 37, high: 62, complex: 87 }[t]);
const r2 = (n) => Math.round(n * 100) / 100;

// A file count as a score inside its band. The table edges are 2|3, 5|6 and 20|21.
function fileScore(n) {
  if (n <= 2) return Math.max(0, n) * 10;
  if (n <= 5) return 25 + (n - 3) * 8;
  if (n <= 20) return 50 + (n - 6) * 1.7;
  return Math.min(99, 75 + (n - 21) * 0.6);
}

// Layers by path, for every language: Django (models.py, views.py), Rails (app/controllers,
// db/migrate), Spring (controller/, entity/, repository/), Go / Rust handlers, Android and iOS UI.
// A JS / TS router file: a client router (vue-router, react-router) or an express router.
const JS_ROUTER = /(^|\/)(router|routes)(\/index)?\.[cm]?[jt]sx?$|(^|\/)(routers?|routes)\/[^/]+\.[cm]?[jt]sx?$|(^|\/)app-routing\.module\.ts$/i;
const UI_FILE = /\.(vue|jsx|tsx|svelte)$/i;

// ctx (optional): { root, rels, model }. With it, a JS / TS router decides by its project: a
// router in a project with UI files, or one that imports a views / pages / screens / components
// path, is "ui". A router under server/ or backend/ stays "api" (also urls.py, routes.rb).
function routerLayer(f, ctx) {
  if (!ctx || !JS_ROUTER.test(f)) return null;
  if (/(^|\/)(server|backend)\//i.test(f)) return "api";
  const fb = ctx.model && ctx.model.byFile && ctx.model.byFile[f];
  if (fb && (fb.imports || []).some((i) => /(^|\/)(views|pages|screens|components)(\/|$)/i.test(String(i.from || "")))) return "ui";
  if (!ctx.rels || !ctx.rels.length) return null;
  const proj = projectOf(ctx.root || ".", f);
  const memo = ctx.uiProjects || (ctx.uiProjects = new Map());
  if (!memo.has(proj)) memo.set(proj, ctx.rels.some((r) => UI_FILE.test(r) && (proj === "." || r.startsWith(proj + "/")) && !/(^|\/)(server|backend)\//i.test(r)));
  return memo.get(proj) ? "ui" : null;
}

function layerOf(f, ctx) {
  const k = TH.kindOf(f);
  if (k !== "src") return k;
  const r = routerLayer(f, ctx);
  if (r) return r;
  if (/(^|\/)(migrations?|migrate|models?|entit(y|ies)|schemas?|repositor(y|ies)|dao|persistence|db|database|prisma)\/|(^|\/)models\.py$|\.(sql|prisma)$|(^|\/)schema\.(rb|graphql|gql)$/i.test(f)) return "data";
  if (/\.(vue|[jt]sx|svelte|css|scss|sass|less|html|erb|haml|slim|cshtml|razor|xaml|storyboard|xib)$/i.test(f)
    || /(^|\/)(components?|views?|pages?|screens?|layouts?|styles?|templates?|widgets?|ui)\//i.test(f)
    || /(Activity|Fragment|ViewController|Screen|Widget|Page)\.(kt|java|swift|dart)$/.test(f)) {
    if (!/(^|\/)views\.py$/i.test(f)) return "ui";
  }
  if (/(^|\/)(server|backend|controllers?|handlers?|resolvers?|endpoints?|routers?|grpc|rpc|serializers?)\//i.test(f)
    || /(^|\/)(urls\.py|routes\.rb)$|(^|\/)routes\/(web|api)\.php$|(^|\/)(router|routes?)\.(go|rs|ex|py|kt|java|cs)$/i.test(f)
    || /(^|\/)(views|urls|serializers|viewsets|routes)\.py$|\.proto$|(Controller|Handler|Resource|Endpoint)\.(java|kt|cs|go|php|rb)$|_controller\.rb$|_handler\.(go|rs|py)$/i.test(f)) return "api";
  if (/(^|\/)(\.github|docker|deploy|infra|terraform|k8s|helm|ansible|\.circleci)\/|Dockerfile|docker-compose|Jenkinsfile|\.gitlab-ci\.yml$|\.tf$/i.test(f)) return "infra";
  return "logic";
}

// The nearest folder (up to the repo root) with a project file of any language.
const projectCache = new Map();
function projectOf(root, file) {
  let d = path.posix.dirname(String(file).replace(/\\/g, "/"));
  while (d && d !== "." && d !== "/") {
    const key = root + "|" + d;
    if (!projectCache.has(key)) {
      let names = [];
      try { names = fs.readdirSync(path.join(root, d)); } catch (_) { /* not there */ }
      projectCache.set(key, names.some((n) => PROJECT_MARKS.includes(n) || /\.(csproj|fsproj|sln)$/i.test(n)));
    }
    if (projectCache.get(key)) return d;
    d = path.posix.dirname(d);
  }
  return ".";
}

// The graph store lorc can read with its own engine (delegate mode can hold a newer engine).
function loadGraph(root) {
  const R = require("./graph-router.js");
  const Q = require(path.join(VENDOR, "graph-query.js"));
  const sel = R.selectStore(root);
  const dirs = [];
  const same = !sel.orc_engine || (sel.orc_engine.engine === sel.engine.engine && sel.orc_engine.schema === sel.engine.schema);
  if (sel.mode !== "delegate" || same) dirs.push(sel.claudeDir);
  dirs.push(path.join(root, ".claude", "lorc", "copy"), path.join(root, ".claude", "lorc"));
  // Last: ORC's store with another engine. The index is plain JSON and reads well enough
  // for a size estimate; `older` marks it in the evidence.
  dirs.push(path.join(root, ".claude"));
  for (const d of [...new Set(dirs)]) {
    let m = null;
    try { m = Q.loadModel(d, root); } catch (_) { m = null; }
    if (m) return { Q, model: m, claudeDir: d, older: d === path.join(root, ".claude") && !same };
  }
  return null;
}

// "the 4-step stepper" names a GENERIC component (no specific word). When a source file of
// that name exists ("Stepper.vue"), the request reuses it: it is not a new file.
const GENERIC = new Set("stepper modal dialog drawer tab tabs card chart form table sidebar navbar widget popup tooltip pagination".split(" "));
const FILLER = new Set("a an the new one two three four five its their this that our shared common reusable generic".split(" "));
function reuseOf(text, rels) {
  const out = {};
  text.creates.forEach((c, i) => {
    if (!GENERIC.has(c.noun)) return;
    const words = String(c.text || "").toLowerCase().split(/\s+/).filter((w) => w && !FILLER.has(w) && !/^\d+(-\w+)?$/.test(w));
    if (words.some((w) => w !== c.noun && w !== c.noun + "s")) return;
    const hit = rels.find((f) => TH.isSrc(f) && path.posix.basename(f).replace(/\.[^.]+$/, "").toLowerCase() === c.noun);
    if (hit) out[i] = hit;
  });
  return out;
}

// The create units that are new files (not a reused generic component).
function newOnes(text, g) {
  const reused = new Set(Object.keys((g && g.reuse) || {}).map(Number));
  return text.creates.filter((_, i) => !reused.has(i));
}

// The words of a RESOLVED name ("OrderService" → order, service) find its files by name;
// they must not also rank files by path ("service" would reach PaymentService).
function nameParts(named) {
  const out = new Set();
  for (const n of Object.keys(named || {})) for (const w of TH.bag(n.split(/[\\/]/).pop().replace(/\.[^.]+$/, ""))) out.add(w);
  return out;
}

function featureOf(core) {
  const src = core.filter(TH.isSrc);
  if (src.length < 2) return null;
  const count = new Map();
  for (const f of src) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join("/"); count.set(d, (count.get(d) || 0) + 1); }
  }
  const need = Math.max(2, Math.ceil(src.length / 2));
  let best = null;
  for (const [d, n] of count) if (n >= need && (!best || d.split("/").length > best.split("/").length)) best = d;
  return best;
}

function focusTokens(request, text) {
  const out = [];
  for (const w of TH.bag(request)) if (out.length < 12) out.push(w);
  for (const n of text.names) if (!/\.(md|txt|rst)$/i.test(n) && out.length < 16) out.push(n);
  return out;
}

// Graph facts: core files (where the work is), named targets and their callers, the
// router and API-client files for wiring, locale and test files, layers and projects.
// The layer of a file with the graph's context (the router rule needs the project's files).
function layerAt(g, f) {
  if (!g._lctx) g._lctx = { root: g.root || ".", rels: g.rels || null, model: g.model || null };
  return layerOf(f, g._lctx);
}

// The graph once per compute: opts.loaded (the caller's graph), else loadGraph. { error } on a throw.
function getLoaded(root, opts) {
  if (opts.loaded) return opts.loaded;
  try { return module.exports.loadGraph(root); } catch (e) { return { error: String(e.message || e).slice(0, 80) }; }
}

function graphPart(root, request, text, loaded) {
  const out = { ok: false, core: [], named: {}, blast: [], hosts: [], feature: null, tests: 0, locales: 0, router: null, api: null, layers: [], projects: [], risky: [] };
  const g = loaded === undefined ? getLoaded(root, {}) : loaded;
  if (g && g.error) { out.reason = g.error; return out; }
  if (!g || !g.model) { out.reason = "no graph index"; return out; }
  const { Q, model, claudeDir } = g;
  out.ok = true;
  out.files = model.fileSet.size;
  if (g.older) out.store = "orc store, older engine";
  const rels = [...model.fileSet];
  out.rels = rels;
  out.model = model;
  out.Q = Q;
  // Named targets: a path in the graph, or a symbol name with ≤ 3 definitions.
  for (const n of text.names) {
    if (/\.(md|txt|rst)$/i.test(n)) continue;
    const p = n.replace(/\\/g, "/").replace(/^\.\//, "");
    if (model.fileSet.has(p)) { out.named[n] = [p]; continue; }
    const defs = (model.byName.get(n.split(/[.#/]/).pop()) || []).filter((s) => s.kind !== "module");
    if (defs.length && defs.length <= 3) out.named[n] = [...new Set(defs.map((s) => s.file))];
  }
  const namedFiles = [...new Set(Object.values(out.named).flat())];
  // Callers of named symbols: who must change when a signature or a name changes.
  const callers = new Set();
  for (const n of Object.keys(out.named)) {
    for (const s of (model.byName.get(n.split(/[.#/]/).pop()) || []).filter((x) => x.kind !== "module").slice(0, 3)) {
      let c = { confident: [] };
      try { c = Q.callersOf(model, s); } catch (_) { /* no callers */ }
      for (const row of c.confident || []) if (row.sym && row.sym.file !== s.file && TH.isSrc(row.sym.file)) callers.add(row.sym.file);
    }
  }
  // Importers that bind the name: a rename or a signature change edits them too, also for a
  // reference that is not a call (`serializer_class = OrderSerializer`). Name first, then resolve.
  const wanted = new Map();
  for (const [n, files] of Object.entries(out.named)) wanted.set(n.split(/[.#/]/).pop(), new Set(files));
  if (wanted.size) {
    for (const f of rels) {
      if (!TH.isSrc(f)) continue;
      const binds = (model.byFile[f].imports || []).flatMap((imp) => imp.bindings || []);
      const names = [...wanted.keys()].filter((nm) => binds.some((b) => b.orig === nm || b.local === nm));
      if (!names.length) continue;
      let targets = [];
      try { targets = Q.importsOf(model, f).files; } catch (_) { continue; }
      for (const nm of names) if (!wanted.get(nm).has(f) && targets.some((t) => wanted.get(nm).has(t))) callers.add(f);
    }
  }
  out.blast = [...callers].sort();
  // Ranked focus: the files the request words reach, best first. Core = the ones whose
  // PATH holds a specific word (a word few files use), plus the named files.
  let ranked = [];
  let specific = [];
  try {
    const m = Q.graphMap(claudeDir, model, { focus: focusTokens(request, text), budget: 2500 });
    const focus = new Set(m.focus || []);
    ranked = (m.files || []).map((f) => f.file).filter((f) => focus.has(f));
    const parts = nameParts(out.named);
    specific = (m.focus_words || []).filter((w) => w.used && w.weight >= 0.45 && !parts.has(TH.stem(w.word))).map((w) => w.word);
  } catch (_) { /* map failed: named files only */ }
  const hasWord = (f) => specific.some((w) => f.toLowerCase().includes(w));
  out.specific = specific.slice(0, 6);
  return fillCommon(out, root, text, rels, ranked, namedFiles, hasWord);
}

// The facts the graph part and the git part share, from the ranked files and the named files:
// core, reused components, the feature folder and its host files, router, API client, locale
// and test files, layers, project folders, risky paths.
function fillCommon(out, root, text, rels, ranked, namedFiles, hasWord) {
  out.root = root;
  out.rels = rels;
  const core = [...namedFiles];
  for (const f of ranked.slice(0, 15)) if (core.length < 8 && !core.includes(f) && TH.isSrc(f) && hasWord(f)) core.push(f);
  out.core = core;
  out.reuse = reuseOf(text, rels);
  // The feature folder. Its files host a new piece (the entry that renders it, a sibling, its constants).
  out.feature = featureFolder(core, text.raw || "");
  if (out.feature) {
    const inDir = (f) => f.startsWith(out.feature + "/") && TH.isSrc(f);
    const constants = rels.filter((f) => inDir(f) && CONSTANTS.test(f));
    out.hosts = [...new Set([...core.filter(inDir), ...constants])].slice(0, 5);
    // The feature constants a new UI piece registers in: most request words first, keys / constants files first.
    const want = TH.bag(text.raw || "");
    const wordsIn = (f) => { let n = 0; for (const w of TH.bag(path.posix.basename(f).replace(/\.[^.]+$/, ""))) if (want.has(w)) n++; return n; };
    const keyish = (f) => (/(keys?|constants?)\.\w+$/i.test(f) ? 1 : 0);
    out.constants = constants.filter((f) => /(^|\/)(constants?|keys)\//i.test(f) || /(constants?|keys)\.\w+$/i.test(f))
      .map((f) => ({ f, n: wordsIn(f), k: keyish(f) })).filter((x) => x.n || x.k)
      .sort((a, b) => b.k - a.k || b.n - a.n || a.f.localeCompare(b.f)).slice(0, 1).map((x) => x.f);
  } else { out.hosts = []; out.constants = []; }
  const uiWork = text.layers.includes("ui") || core.some((f) => layerAt(out, f) === "ui");
  if (uiWork) out.router = rels.find((f) => ROUTER.test(f) && TH.isSrc(f)) || null;
  out.api = apiModule(root, out, text, namedFiles, ranked, hasWord);
  out.apiRef = out.api ? endpointIn(root, out, out.api, (text.doc && text.doc.endpoints) || []) : null;
  const localeFiles = rels.filter((f) => TH.kindOf(f) === "locale" && !/\/(en|id)?[^/]*\.(js|ts)$/.test(f));
  out.locales = localeFiles.length;
  out.localeFiles = localeFiles.slice(0, 4);
  // Tests by name: a test file whose name holds a core file's name (any language).
  const stems = core.slice(0, 5).map((f) => path.posix.basename(f).replace(/\.[^.]+$/, "").toLowerCase()).filter((s) => s.length >= 3);
  out.tests = stems.length ? rels.filter((f) => TH.kindOf(f) === "test" && stems.some((s) => path.posix.basename(f).toLowerCase().includes(s))).length : 0;
  out.layers = [...new Set(core.map((f) => layerAt(out, f)).filter((l) => !["test", "locale", "doc", "noise"].includes(l)))];
  out.projects = [...new Set(core.map((f) => projectOf(root, f)))];
  out.risky = [...new Set([...core, ...out.blast].filter((f) => RISKY.test(f)))].slice(0, 4);
  out.analog = structuralAnalog(text, out);
  return out;
}

const CONSTANTS = /(^|\/)(constants?|keys|routes?|config|types?|enums?|settings)(\/|[^/]*\.\w+$)/i;

// The feature folder: (1) the parent of a constants / keys / routes folder that holds a core
// file; (2) the folder of the core file with the most request words; (3) the deepest folder
// that holds most core files.
function featureFolder(core, request) {
  const src = core.filter(TH.isSrc);
  if (src.length < 2) return null;
  for (const f of src) { const m = /^(.+)\/(constants?|keys|routes)\/[^/]+$/i.exec(f); if (m) return m[1]; }
  const want = TH.bag(request);
  let best = null;
  let bestN = 0;
  for (const f of src) {
    const d = path.posix.dirname(f);
    if (d === ".") continue;
    let n = 0;
    for (const w of TH.bag(d)) if (want.has(w)) n++;
    if (n > bestN) { best = d; bestN = n; }
  }
  return best || featureOf(core);
}

const urlPath = (u) => String((u && typeof u === "object" ? u.url || u.path : u) || "").replace(/^\w+:\/\/[^/]+/, "").split("?")[0];
const segs = (p) => String(p || "").split("/").filter(Boolean);

// The API module the work changes: (a) a named file that is an API client; (b) the API file
// whose URLs share ≥ 2 leading path segments with a doc endpoint (graph `urls`, else
// `git grep` of the endpoint's last 2 segments, then of its parent path); (c) a ranked API
// file with a request word.
function apiModule(root, out, text, namedFiles, ranked, hasWord) {
  const named = namedFiles.find((f) => API_CLIENT.test(f));
  if (named) return named;
  const eps = ((text.doc && text.doc.endpoints) || []).map((e) => segs(e.replace(/^\w+\s+/, ""))).filter((s) => s.length >= 2);
  if (eps.length) {
    const apiFiles = (out.rels || []).filter((f) => API_CLIENT.test(f) && TH.isSrc(f));
    const model = out.model;
    if (model && model.byFile) {
      let best = null;
      let bestN = 1;
      for (const f of apiFiles) {
        const fb = model.byFile[f] || {};
        const urls = [...(fb.urls || []), ...(fb.symbols || []).flatMap((s) => s.urls || [])].filter((u) => !(u && u.suffix));
        for (const u of urls) {
          const us = segs(urlPath(u));
          for (const ep of eps) {
            let n = 0;
            while (n < us.length && n < ep.length && us[n] === ep[n]) n++;
            if (n > bestN) { best = f; bestN = n; }
          }
        }
      }
      if (best) return best;
    }
    const isApi = new Set(apiFiles);
    const grep = (needle) => {
      const o = gitOut(root, ["grep", "-c", "-F", needle]);
      const hits = (o || "").split(/\r?\n/).map((l) => /^(.*):(\d+)$/.exec(l)).filter((m) => m && (isApi.has(m[1]) || (!isApi.size && API_CLIENT.test(m[1]))));
      hits.sort((a, b) => Number(b[2]) - Number(a[2]) || a[1].localeCompare(b[1]));
      return hits.length ? hits[0][1] : null;
    };
    for (const ep of eps) { const f = grep(ep.slice(-2).join("/")); if (f) return f; }
    for (const ep of eps) if (ep.length >= 3) { const f = grep("/" + ep.slice(0, -1).join("/")); if (f) return f; }
  }
  return out.core.find((f) => API_CLIENT.test(f)) || ranked.slice(0, 30).find((f) => API_CLIENT.test(f) && hasWord(f)) || null;
}

// Rule: the API module is CHANGED only when a doc endpoint is NEW. A function of the module that
// already calls the endpoint (method + path; {p} / :p / ${…} segments match anything) makes it a
// reference: { fn }. Fallback: `git grep -n -F` of the path in the module ({ fn: "?" }).
const isParam = (x) => /^(\{.*\}|:.+|\$\{.*\}|\*)$/.test(x);
function endpointIn(root, g, file, endpoints) {
  if (!endpoints.length) return null;
  const eps = endpoints.map((e) => { const m = /^(\w+)\s+(.*)$/.exec(e); return { method: m ? m[1].toUpperCase() : "ANY", segs: segs(m ? m[2] : e) }; });
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i] || isParam(x) || isParam(b[i]));
  const fb = g.model && g.model.byFile && g.model.byFile[file];
  const all = [];
  for (const ep of eps) {
    let hit = null;
    if (fb) {
      for (const sym of fb.symbols || []) {
        for (const u of sym.urls || []) {
          const us = segs(urlPath(u));
          const um = String((u && u.method) || "ANY").toUpperCase();
          if (um !== "ANY" && ep.method !== "ANY" && um !== ep.method) continue;
          const ok = u && u.suffix ? us.length && us.length <= ep.segs.length && same(us, ep.segs.slice(-us.length)) : same(us, ep.segs);
          if (ok) { hit = sym.name || "?"; break; }
        }
        if (hit) break;
      }
    }
    if (!hit) {
      const o = gitOut(root, ["grep", "-n", "-F", "/" + ep.segs.join("/"), "--", file]);
      if (o && o.trim()) hit = "?";
    }
    if (!hit) return null;
    all.push(hit);
  }
  return { fn: all[0] };
}

const CONTAINER = /^(page|screen|view|flow|wizard|shell|layout|dashboard)$/;

// Structural analog (no git history needed): when the request creates a container or ≥ 2 new
// components, the closest existing flow in the same top area (the first 3 parts of the
// feature folder): a file whose name ends with the container noun or Flow / Wizard / Step(s),
// ranked by shared request words, then by imports of the reused components. Its footprint =
// itself + the source files it imports from its own folder subtree (1 hop).
function structuralAnalog(text, g) {
  if (!g.feature || !g.rels) return null;
  const fresh = newOnes(text, g);
  const containers = fresh.filter((c) => CONTAINER.test(c.noun)).map((c) => c.noun);
  if (!containers.length && fresh.length < 2) return null;
  const top = g.feature.split("/").slice(0, 3).join("/");
  const ends = new RegExp(`(${[...new Set(containers)].join("|")}${containers.length ? "|" : ""}flow|wizard|steps?)$`, "i");
  const want = TH.bag(text.raw || "");
  const reused = new Set(Object.values(g.reuse || {}));
  const imports = (f) => {
    if (!g.Q || !g.model) return [];
    try { return g.Q.importsOf(g.model, f).files; } catch (_) { return []; }
  };
  const cands = [];
  for (const f of g.rels) {
    if (!f.startsWith(top + "/") || !TH.isSrc(f)) continue;
    const stem = path.posix.basename(f).replace(/\.[^.]+$/, "");
    if (!ends.test(stem)) continue;
    let words = 0;
    for (const w of TH.bag(f.replace(/\.[^.]+$/, ""))) if (want.has(w)) words++;
    cands.push({ f, words });
  }
  if (!cands.length) return null;
  // Ties on words: nearer the feature folder (shared leading path parts), then the reused components.
  const fparts = g.feature.split("/");
  const near = (f) => { const p = f.split("/"); let n = 0; while (n < p.length && n < fparts.length && p[n] === fparts[n]) n++; return n; };
  cands.sort((a, b) => b.words - a.words || near(b.f) - near(a.f) || a.f.localeCompare(b.f));
  const best = cands.filter((c) => c.words === cands[0].words && near(c.f) === near(cands[0].f)).slice(0, 20)
    .map((c) => ({ ...c, imp: imports(c.f) }))
    .map((c) => ({ ...c, reuse: c.imp.filter((x) => reused.has(x)).length }))
    .sort((a, b) => b.reuse - a.reuse || a.f.localeCompare(b.f))[0];
  if (!best.words && !best.reuse) return null;
  const dir = path.posix.dirname(best.f) + "/";
  const own = best.imp.filter((x) => x !== best.f && x.startsWith(dir) && TH.isSrc(x));
  return { file: best.f, files: 1 + own.length };
}

function gitOut(root, args, timeout = 20000) {
  const r = require("child_process").spawnSync("git", args, { cwd: root, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? String(r.stdout || "") : r.status === 1 && args[0] === "grep" ? "" : null;
}

const DEF_WORDS = "class|def|function|func|interface|struct|type|trait|enum|fn|const|let|var|val|object|record|module|protocol|typealias";

// No graph (a language the graph does not read, or no index yet): the same facts from git
// alone. Related files = tracked source files whose PATH holds a specific request word
// (a word few paths use), ranked by that weight, then by how often git changed them.
// A named symbol: its definition and its users from `git grep -w`.
function gitPart(root, request, text, list) {
  const out = { ok: false, source: "git", core: [], named: {}, blast: [], hosts: [], reuse: {}, feature: null, tests: 0, locales: 0, router: null, api: null, layers: [], projects: [], risky: [] };
  const ls = gitOut(root, ["ls-files", "-z"]);
  if (ls === null) { out.reason = "no graph, not a git repo"; return out; }
  const rels = ls.split("\0").filter(Boolean).map((f) => f.replace(/\\/g, "/"));
  const src = rels.filter(TH.isSrc);
  if (!src.length) { out.reason = "no graph, no tracked source files"; return out; }
  out.ok = true;
  out.files = rels.length;
  out.store = "git paths (no graph)";
  // Named targets: a tracked path, or a symbol with 1–3 definition files.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const users = new Set();
  for (const n of text.names) {
    if (/\.(md|txt|rst)$/i.test(n)) continue;
    const p = n.replace(/\\/g, "/").replace(/^\.\//, "");
    if (rels.includes(p)) { out.named[n] = [p]; continue; }
    const name = n.split(/[.#/]/).pop();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    const defs = (gitOut(root, ["grep", "-l", "-E", `\\b(${DEF_WORDS})\\s+${esc(name)}\\b`]) || "").split(/\r?\n/).filter((f) => f && TH.isSrc(f));
    if (!defs.length || defs.length > 3) continue;
    out.named[n] = defs;
    for (const f of (gitOut(root, ["grep", "-l", "-w", name]) || "").split(/\r?\n/)) if (f && TH.isSrc(f) && !defs.includes(f)) users.add(f);
  }
  out.blast = [...users].sort().slice(0, 200);
  // Path words, weighted like the graph's focus words: log(1 + N/df) / log(1 + N).
  const want = TH.bag(request);
  const bags = new Map(src.map((f) => [f, TH.bag(f.replace(/\.[^./]+$/, ""))]));
  const df = new Map();
  for (const b of bags.values()) for (const w of b) if (want.has(w)) df.set(w, (df.get(w) || 0) + 1);
  const N = src.length;
  const weight = (w) => (df.get(w) ? Math.log(1 + N / df.get(w)) / Math.log(1 + N) : 0);
  const parts = nameParts(out.named);
  const specific = [...want].filter((w) => weight(w) >= 0.45 && !parts.has(w));
  const activity = new Map();
  for (const c of list || []) for (const f of c.files) activity.set(f, (activity.get(f) || 0) + 1);
  const score = (f) => specific.reduce((s, w) => s + (bags.get(f).has(w) ? weight(w) : 0), 0);
  const ranked = src.map((f) => ({ f, s: score(f) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (activity.get(b.f) || 0) - (activity.get(a.f) || 0) || a.f.localeCompare(b.f)).map((x) => x.f);
  out.specific = specific.slice(0, 6);
  const namedFiles = [...new Set(Object.values(out.named).flat())];
  return fillCommon(out, root, text, rels, ranked, namedFiles, (f) => specific.some((w) => bags.has(f) && bags.get(f).has(w)));
}

function historyPart(root, request, anchors, opts) {
  const out = { commits: 0, cochange: [], similar: { n: 0, median_src: null, samples: [] }, runs: { n: 0 }, wiring: TH.wiringRatio(null) };
  const list = opts.list !== undefined ? opts.list : TH.commits(root, { cache: opts.cache !== false });
  if (list) {
    out.commits = list.length;
    out.cochange = TH.coChange(list, anchors);
    out.similar = TH.similarCommits(list, request);
    out.wiring = TH.wiringRatio(list);
    out.prior = TH.cuePrior(list, request);
  }
  out.runs = TH.similarRuns(root, request, { runs: opts.runs });
  out.calibration = TH.calibration(root, { runs: opts.runs });
  return out;
}

// The files of the named targets that count. A name only the requirement doc gives ("the
// DownArrow icon") counts when its file is the API module or in the feature folder: a doc
// names many things it only reuses.
function countedNamed(text, g) {
  const fromReq = new Set(TT.namesOf(text.raw || ""));
  const changes = new Set((text.doc && text.doc.changes) || []);
  const docOnly = new Set(((text.doc && text.doc.names) || []).filter((n) => !fromReq.has(n)));
  const out = [];
  for (const [n, files] of Object.entries(g.named || {})) {
    // A doc-only name counts only with a change verb before it; the API module also needs a new endpoint.
    if (docOnly.has(n) && !changes.has(n)) continue;
    if (g.apiRef && files.includes(g.api)) continue;
    out.push(...files);
  }
  return [...new Set(out)];
}

// Back ends: the layer of a path by its folders and its name (api · data · worker · wiring · logic).
const WIRE_STEMS = /^(init|app|main|server|wiring|container|bootstrap|module|di|routes|router)$/i;
const WORKER_NOUN = /^(jobs?|workers?|consumers?|queues?|schedulers?|crons?)$/i;
const stemOf = (f) => path.posix.basename(String(f)).replace(/\.[^.]+$/, "");
function beKey(f) {
  const parts = String(f).replace(/\\/g, "/").split("/");
  const dirs = parts.slice(0, -1);
  const stem = stemOf(f);
  if (dirs.some((x) => /^(workers?|jobs?|queues?|consumers?|processors?|schedulers?|crons?)$/i.test(x)) || /(worker|processor|consumer|job|queue|scheduler)s?$/i.test(stem)) return "worker";
  if (dirs.some((x) => /^(controllers?|handlers?|routes?|routers?|middlewares?|validators?|endpoints?|resolvers?)$/i.test(x)) || /(controller|handler|router|routes?)$/i.test(stem)) return "api";
  if (dirs.some((x) => /^(repositor(y|ies)|models?|entit(y|ies)|migrations?|dao|db|database|persistence)$/i.test(x))) return "data";
  if (WIRE_STEMS.test(stem) || dirs.some((x) => /^(container|app|di)$/i.test(x))) return "wiring";
  return "logic";
}

// The repo paths the doc names: new files (not in the repo) and existing wiring / worker files.
// Tests, docs, .sql and .proto files do not count. A short path ("schemas/common.ts") that ends
// a repo path is an existing file.
function docFiles(root, text, g) {
  const out = { newPaths: [], wirePaths: [] };
  const rels = g.rels || [];
  const relSet = new Set(rels);
  for (const p of (text.doc && text.doc.paths) || []) {
    if (TEST_PATH.test(p) || TH.kindOf(p) === "doc" || /\.(sql|proto|md|txt|rst)$/i.test(p)) continue;
    let exists = relSet.has(p) || rels.some((r) => r.endsWith("/" + p));
    if (!exists) { try { exists = fs.existsSync(path.join(root || ".", p)); } catch (_) { exists = false; } }
    if (!exists) out.newPaths.push(p);
    else if (WIRE_STEMS.test(stemOf(p)) || beKey(p) === "worker") out.wirePaths.push(p);
  }
  return out;
}

// Weighted geometric mean: counts are skewed, so blend them on a log scale.
function blend(a, b, w) { return Math.exp((1 - w) * Math.log(Math.max(1, a)) + w * Math.log(Math.max(1, b))); }

function estimate(text, g, h) {
  const reused = Object.keys(g.reuse || {}).map(Number);
  const newUnits = text.creates.filter((_, i) => !reused.includes(i)).map((c) => c.text || c.noun);
  let added = newUnits.length;
  const changed = new Set();
  const why = [];
  const ui = text.creates.filter((c) => c.layer === "ui");
  const pages = ui.filter((c) => /^(page|screen|view|flow|wizard|shell|layout|dashboard)$/.test(c.noun));
  if (pages.length) changed.add(g.router || "router");
  const server = text.creates.filter((c) => c.layer === "api");
  if (server.length) changed.add("route registration");
  if (text.creates.some((c) => c.layer === "data") && !text.creates.some((c) => c.noun === "migration")) added++;
  const clientApi = (text.doc && text.doc.apis > 0) || (/\bapi\b/i.test(text.raw || "") && !text.server);
  if (clientApi && ui.length + text.elements > 0 && !(g.api && g.apiRef)) changed.add(g.api || "api client");
  if (g.api && g.apiRef) why.push(`api: ${path.posix.basename(g.api)} (endpoint exists: ${g.apiRef.fn})`);
  // A signature or a rename changes every caller; a refactor about half of them.
  let blast = 0;
  if (g.blast.length && (text.cues.signature || text.cues.mechanical)) blast = g.blast.length;
  else if (g.blast.length && text.cues.refactor) blast = Math.ceil(g.blast.length / 2);
  for (const m of text.modifies) {
    const files = m.target && g.named[m.target];
    if (files && files.length) for (const f of files) changed.add(f);
    else if (blast && /\b(callers?|usages?|call sites?|tests?|specs?|pemanggil|penggunaan|tes|pengujian)\b/i.test(m.text || "")) continue;
    else changed.add(`edit: ${m.text || "?"}`);
  }
  for (let i = 0; i < Math.min(text.elements, 2); i++) changed.add(`element ${i + 1}`);
  for (let i = 0; i < Math.min(text.wires, 2); i++) changed.add(`wiring ${i + 1}`);
  if (text.cues.state && !text.creates.some((c) => c.noun === "store")) changed.add("state holder");
  for (const f of countedNamed(text, g)) changed.add(f);
  for (const f of g.blast.slice(0, blast)) changed.add(f);
  // A new piece of an EXISTING feature (no new page or shell to hold it) is wired into the
  // feature's files: about `wiring ratio` existing files per new file (learned from git).
  const container = text.creates.some((c) => /^(page|screen|view|flow|wizard|shell|layout|dashboard)$/.test(c.noun));
  const pieces = text.creates.filter((c) => c.layer === "ui" || c.layer === "logic").length;
  let hosts = 0;
  const hostAdded = [];
  // The request extends an EXISTING container ("step 2 of the flow; step 1 already exists").
  const extendsExisting = !container && /\b(flow|shell|page|wizard|stepper|screen|view)\b/i.test(text.raw || "")
    && /\b(already exists?|already built|existing|sudah ada)\b/i.test(text.raw || "");
  if (pieces && !container && g.hosts.length) {
    const ratio = (h.wiring && h.wiring.ratio) || 2;
    const want = Math.min(extendsExisting ? 1 : 3, g.hosts.length, Math.max(1, Math.round(pieces * ratio)));
    for (const f of g.hosts) { if (hosts >= want) break; if (!changed.has(f)) { changed.add(f); hostAdded.push(f); hosts++; } }
  }
  // Placeholders (an unresolved edit, the state holder, elements) are absorbed by a real file of
  // the feature, or by the existing container the request extends: they add 0 files.
  const featureFile = g.feature ? [...changed].find((f) => f.startsWith(g.feature + "/")) : null;
  let absorbed = 0;
  if (featureFile || extendsExisting) {
    for (const f of [...changed]) if (/^(edit: |element \d|state holder$)/.test(f)) { changed.delete(f); absorbed++; }
  }
  if (absorbed) why.push(`absorbed: ${absorbed} placeholder(s) into ${featureFile ? path.posix.basename(featureFile) : "the existing container"}`);
  // A long requirement doc splits a new component into parts (requirement length predicts
  // effort in the story-point studies): +1 sub-component per 40 lines after the first 40.
  let docUnits = 0;
  if (text.doc && text.creates.length) docUnits = Math.max(0, Math.min(3, Math.floor(text.doc.lines / 40) - 1));
  added += docUnits;
  // Co-change: what the history changed together with the files we expect to change.
  let ripple = 0;
  for (const p of h.cochange) if (ripple < 3 && !changed.has(p.file)) { changed.add(p.file); ripple++; }
  // Nothing in the text says what to build or change: the graph's core is the best guess.
  if (!added && !changed.size) for (const f of g.core.slice(0, 2)) changed.add(f);
  if (!added && !changed.size) changed.add("one edit");
  let est = added + changed.size;
  const parts = [`${added} new`, `${changed.size} changed`];
  const structural = est;
  // The closest existing flow in the same area (works with no git history).
  const an = g.analog && g.analog.files ? g.analog : null;
  if (an) { est = blend(est, an.files, 0.3); parts.push(`analog ${an.files}`); }
  if (h.similar.n >= 3 && h.similar.median_src) { est = blend(est, h.similar.median_src, 0.3); parts.push(`git analog ${h.similar.median_src}`); }
  // The repo's own size prior for this kind of request (same leading cue). A short request
  // with no create / modify unit leans on it more.
  const pr = h.prior && h.prior.median ? h.prior : null;
  // A unit = a create unit or an edit whose target resolved to a file; "fix the payout
  // adjustment" (an edit with no known target) is a commit-like request.
  const units = text.creates.length + text.modifies.filter((m) => m.target && (g.named[m.target] || []).length).length;
  if (pr) est = blend(est, pr.median, units ? 0.1 : 0.25);
  if (h.runs.n >= 3 && h.runs.median_src) { est = blend(est, h.runs.median_src, 0.5); parts.push(`run analog ${h.runs.median_src}`); }
  // Self-calibration: this repo's finished runs say how far the RAW estimate was off.
  // `raw` is kept (run end copies it) so the factor never learns from its own output.
  const raw = Math.round(Math.max(1, est) * 100) / 100;
  const cal = h.calibration || { factor: 1, learned: false };
  if (cal.learned && Math.abs(cal.factor - 1) >= 0.1) { est *= cal.factor; parts.push(`calibrated ×${cal.factor} from ${cal.n} runs`); }
  est = Math.max(1, Math.round(est));
  // Back end with a doc: the new files and the wiring / worker files the doc names are a floor.
  let df = null;
  let docLine = null;
  if (g.uiRepo === false) {
    df = docFiles(g.root, text, g);
    const n = df.newPaths.length + df.wirePaths.length;
    if (n > 0) {
      const floor = Math.min(12, n);
      est = Math.max(est, floor);
      docLine = `doc: ${df.newPaths.length} new file(s), ${df.wirePaths.length} wiring / worker file(s) named → ≥ ${floor} files`;
    }
  }
  why.push(`~${est} source files (${parts.join(", ")})${newUnits.length ? `: ${newUnits.slice(0, 3).join(", ")}` : ""}`);
  if (docLine) why.push(docLine);
  if (an) why.push(`analog: ${an.file} (${an.files} files)`);
  if (pr) why.push(`history prior: ${pr.cue} median ${pr.median} (${pr.k} commits)`);
  if (blast) why.push(`${blast} caller file(s) must change (${text.cues.signature ? "signature" : text.cues.mechanical ? "rename" : "refactor"})`);
  if (reused.length) why.push(`reuse: ${reused.map((i) => path.posix.basename(g.reuse[i])).join(", ")} (exists; not new)`);
  if (docUnits) why.push(`requirement doc ${text.doc.lines} lines → +${docUnits} sub-component(s)`);
  if (hosts) why.push(`+${hosts} feature file(s) wire the new piece in (${path.posix.basename(g.feature)}/, ratio ${h.wiring.ratio}${h.wiring.learned ? " from git" : ""})`);
  if (ripple) why.push(`co-change: +${ripple} file(s) that changed together before`);
  return { est, raw, structural, added, changed: [...changed], blast, ripple, hosts, calibration: cal.learned ? cal : null, why,
    ...(df ? { newPaths: df.newPaths, wirePaths: df.wirePaths, hostAdded } : {}) };
}

// Independent areas: project folders (a monorepo's client and server), or the server-side
// layers (ui · api · data) the work reaches. Client-side API calls are not an area.
function areasOf(text, g, e) {
  const layers = new Set();
  for (const l of [...text.layers, ...g.layers]) if (l === "ui" || l === "data" || (l === "api" && (text.server || g.layers.includes("api")))) layers.add(l);
  // Back end: a worker / job / queue entry point is an area too.
  if (g.uiRepo === false) {
    const ps = [...((e && e.newPaths) || []), ...((e && e.wirePaths) || []), ...text.names.filter((n) => n.includes("/"))];
    if (ps.some((p) => beKey(p) === "worker") || text.creates.some((c) => WORKER_NOUN.test(c.noun))) layers.add("worker");
  }
  const projects = g.projects.filter((p) => p !== ".").length || 1;
  return { n: Math.max(projects, layers.size || 1), layers: [...layers], projects: g.projects };
}

function decide(text, g, h, e) {
  const rows = [];
  rows.push({ s: fileScore(e.est), why: null });
  const fresh = newOnes(text, g);
  // Types (class, struct, interface …) often share one file: two count as one component.
  const types = fresh.filter((c) => TYPE_NOUNS.has(c.noun)).length;
  const nc = fresh.length - types + Math.ceil(types / 2);
  if (nc === 1) rows.push({ s: 37, why: `1 new component (${fresh[0].noun})` });
  if (nc >= 2) rows.push({ s: Math.min(70, 50 + nc * 4), why: `${nc} new components` });
  const a = areasOf(text, g, e);
  if (a.n > 3) rows.push({ s: 80, why: `${a.n} independent areas` });
  else if (a.n >= 2) rows.push({ s: 52 + a.n * 3, why: `${a.n} independent areas (${(a.projects.length > 1 ? a.projects : a.layers).join(", ")})` });
  // Migration and ordered steps: complex only with evidence beyond a word in the text.
  // A small additive schema change (add a column, an index) is routine: high. A DATA migration
  // (backfill, split, merge, rename, drop, move data) or a big one is complex.
  const dataEvidence = text.data_strong || g.layers.includes("data");
  const heavy = /\b(backfill\w*|data migration|migrat\w* (the )?data|split\w*|merg\w*|renam\w*|drop\w*|mov\w* (the )?data|format|convert\w*|transform\w*|pisah\w*|memisahkan|gabung\w*|menggabungkan|ganti nama|ubah nama|hapus|menghapus|pindah\w* data|isi ulang|konversi|mengonversi)\b/i.test(text.raw || "") || e.est > 5 || text.cues.ordered;
  if (text.cues.migration) {
    rows.push(!dataEvidence ? { s: 60, why: "migration named, no data layer found" }
      : heavy ? { s: 85, why: "a data migration" } : { s: 58, why: "a small schema migration" });
  }
  if (text.cues.ordered) rows.push(e.est > 5 ? { s: 80, why: "steps in a fixed order" } : { s: 58, why: "steps in a fixed order (small)" });
  let best = rows.reduce((x, y) => (y.s > x.s ? y : x));
  let s = best.s;
  const why = [];
  if (best.why) why.push(best.why);
  // Mechanical work with no new file: one executor does it best.
  const mechanical = (text.cues.mechanical || text.cues.signature) && nc === 0 && !text.cues.migration;
  if (mechanical && s >= 50) { s = 45; why.push("mechanical change: one executor"); }
  // lorc's own history: similar requests ended one band away → follow them.
  const R = h.runs;
  let history = null;
  if (R.n >= 3 && R.majority && R.lb >= 0.55) {
    const d = TIERS.indexOf(R.majority) - TIERS.indexOf(tierOf(s));
    if (Math.abs(d) === 1) { s = center(R.majority); history = "moved"; }
    else history = d === 0 ? "agrees" : "disagrees";
    why.push(`history: ${R.tiers[R.majority]} of ${R.n} similar runs ended ${R.majority}${history === "moved" ? " (followed)" : ""}`);
  }
  s = Math.max(0, Math.min(99, s));
  return { score: Math.round(s), tier: tierOf(s), why, areas: a, history, mechanical };
}

function confidence(score, text, g, h, d, e) {
  const t = tierOf(score);
  const lo = { low: 0, mid: 25, high: 50, complex: 75 }[t];
  const margin = Math.max(0, Math.min(1, Math.min(score - lo, lo + 24 - score) / 12.5));
  let c = 0.35 + 0.25 * margin;
  // Related files from the graph are good evidence; from file paths alone, weaker.
  if (g.ok && g.core.length) c += g.source === "git" ? 0.08 : 0.15;
  if (!g.ok) c -= 0.1;
  if (!text.creates.length && !text.modifies.length && !text.elements) c -= 0.15;
  if (h.similar.n >= 3 && h.similar.median_src) {
    const diff = Math.abs(TIERS.indexOf(tierOf(fileScore(h.similar.median_src))) - TIERS.indexOf(t));
    c += diff === 0 ? 0.1 : diff >= 2 ? -0.1 : 0;
  }
  // The structural estimate, the analog and the git estimate: agree within ×1.5 → +0.1;
  // spread more than ×3 → −0.1.
  const ests = [e && e.structural, g.analog && g.analog.files, h.similar.n >= 3 ? h.similar.median_src : null].filter((x) => Number.isFinite(x) && x > 0);
  if (ests.length >= 2) {
    const ratio = Math.max(...ests) / Math.min(...ests);
    c += ratio <= 1.5 ? 0.1 : ratio > 3 ? -0.1 : 0;
  }
  if (d.history === "agrees" || d.history === "moved") c += 0.15;
  if (d.history === "disagrees") c -= 0.1;
  return r2(Math.max(0.1, Math.min(0.95, c)));
}

// Disjoint groups for high / complex: by project, then by layer; a one-layer job is
// split by its new components (the page with its wiring first). Advice for L2, not a plan.
// A placeholder in `changed` (no real file): not a split unit.
const PLACEHOLDER = /^(edit: |element \d|wiring \d|state holder$|route registration$|api client$|router$|one edit$)/;

// The test files that import a file (the graph), else whose name holds the file's name.
function testsOf(g, files) {
  if (!g.rels) return [];
  if (!g._tests) {
    const idx = new Map();
    const tests = g.rels.filter((f) => TH.kindOf(f) === "test");
    if (g.Q && g.model) {
      for (const t of tests) {
        let fs2 = [];
        try { fs2 = g.Q.importsOf(g.model, t).files; } catch (_) { /* none */ }
        for (const x of fs2) (idx.get(x) || idx.set(x, []).get(x)).push(t);
      }
    }
    g._tests = { idx, tests };
  }
  const out = new Set();
  for (const f of files) {
    if (ROUTER.test(f)) continue;
    // By name first (remittance.api.js → remittance.api.spec.js), else the importer tests.
    const base = path.posix.basename(f).replace(/\.[^.]+$/, "").toLowerCase();
    const byName = base.length >= 4 ? g._tests.tests.filter((t) => path.posix.basename(t).toLowerCase().startsWith(base + ".")) : [];
    if (byName.length) { for (const t of byName.slice(0, 2)) out.add(t); continue; }
    const hit = g._tests.idx.get(f);
    // A shared module that many tests import names no test of its own.
    if (hit && hit.length && hit.length <= 3) for (const t of hit.slice(0, 2)) out.add(t);
  }
  return [...out].slice(0, 3);
}

// Back-end split: units keyed api · logic · data · worker · wiring. A group with no substantive
// unit (only DI, app mount or route registration) merges into the smallest group that has one.
function splitBe(text, g, e, max) {
  const items = [];
  const seen = new Set();
  const add = (unit, key, sub) => { if (seen.has(unit)) return; seen.add(unit); items.push({ unit, key, sub }); };
  const newPaths = e.newPaths || [];
  const wirePaths = e.wirePaths || [];
  const hostAdded = new Set(e.hostAdded || []);
  const docN = newPaths.length + wirePaths.length;
  for (const p of newPaths) add(p, beKey(p), true);
  for (const p of wirePaths) { const k = beKey(p); add(p, k, k === "worker"); }
  for (const f of e.changed) {
    if (PLACEHOLDER.test(f) || !f.includes("/")) continue;
    if (docN && hostAdded.has(f)) continue;
    add(f, beKey(f), !hostAdded.has(f));
  }
  for (const c of newOnes(text, g)) add(c.text || c.noun, WORKER_NOUN.test(c.noun) ? "worker" : c.layer === "api" ? "api" : c.layer === "data" ? "data" : "logic", true);
  const groups = new Map();
  for (const it of items) (groups.get(it.key) || groups.set(it.key, []).get(it.key)).push(it);
  const all = [...groups.entries()].map(([key, its]) => ({ key, its }));
  const list = all.filter((x) => x.its.some((it) => it.sub));
  if (list.length < 2) return [];
  for (const x of all.filter((y) => !list.includes(y))) {
    const small = list.reduce((a, b) => (b.its.length < a.its.length ? b : a));
    small.its.push(...x.its);
  }
  list.sort((a, b) => b.its.length - a.its.length);
  while (list.length > max) {
    const last = list.pop();
    list[list.length - 1].its.push(...last.its);
  }
  if (list.length < 2) return [];
  return list.map((x, i) => {
    const units = x.its.map((it) => it.unit).slice(0, 8);
    const files = units.filter((u) => u.includes("/") && TH.isSrc(u));
    const tests = testsOf(g, files).filter((t) => !units.includes(t));
    return { g: `G${i + 1}`, layer: x.key, units, ...(tests.length ? { tests } : {}) };
  });
}

function split(text, g, e, tier) {
  if (tier !== "high" && tier !== "complex") return [];
  const max = Math.min(3, CAP[tier]);
  if (g.uiRepo === false) return splitBe(text, g, e, max);
  const items = [];
  const fresh = newOnes(text, g);
  for (const c of fresh) items.push({ unit: c.text || c.noun, key: c.layer === "logic" ? "ui" : c.layer, page: CONTAINER.test(c.noun) && c.noun !== "dashboard", fresh: true });
  const multi = g.projects.length > 1;
  const keyOf = (f) => { const l = layerAt(g, f); return multi ? projectOf(g.root || ".", f) : l === "logic" ? "ui" : l; };
  // The real API module (a client file, not a server route) is placed below.
  const apiFile = g.api && e.changed.includes(g.api) && layerAt(g, g.api) !== "api" ? g.api : null;
  const seen = new Set();
  const add = (f, key) => { if (seen.has(f)) return; seen.add(f); items.push({ unit: f, key }); };
  for (const f of e.changed) {
    if (PLACEHOLDER.test(f) || !f.includes("/") || f === apiFile) continue;
    add(f, keyOf(f));
  }
  // New UI work: its feature constants and the locale files go with the UI group.
  const uiKey = multi ? (items.find((x) => x.key !== "api" && !x.fresh && layerAt(g, x.unit) === "ui") || {}).key || "ui" : "ui";
  if (fresh.some((c) => c.layer === "ui")) {
    for (const f of g.constants || []) add(f, uiKey);
    for (const f of (g.localeFiles || []).slice(0, 4)) add(f, uiKey);
  }
  if (apiFile) {
    const uiUnits = items.filter((x) => x.key === uiKey).length;
    const own = max >= 2 && uiUnits >= 3;
    add(apiFile, own ? "api" : uiKey);
    if (own) for (const t of testsOf(g, [apiFile])) add(t, "api");
  }
  const groups = new Map();
  for (const it of items) (groups.get(it.key) || groups.set(it.key, []).get(it.key)).push(it);
  let list = [...groups.entries()].map(([key, its]) => ({ key, its }));
  if (list.length === 1 && fresh.length >= 2) {
    const its = list[0].its;
    const first = its.find((x) => x.page) || its.find((x) => !x.unit.includes("/"));
    const rest = its.filter((x) => x !== first && !x.unit.includes("/"));
    const wiring = its.filter((x) => x !== first && x.unit.includes("/"));
    list = [{ key: list[0].key, its: [first, ...wiring] }, ...rest.map((x) => ({ key: list[0].key, its: [x] }))];
  }
  list.sort((a, b) => b.its.length - a.its.length);
  while (list.length > max) {
    const last = list.pop();
    list[list.length - 1].its.push(...last.its);
  }
  if (list.length < 2) return [];
  return list.map((x, i) => {
    const units = x.its.map((it) => it.unit).slice(0, 8);
    const files = units.filter((u) => u.includes("/") && TH.isSrc(u));
    const tests = testsOf(g, files).filter((t) => !units.includes(t));
    return { g: `G${i + 1}`, layer: x.key, units, ...(tests.length ? { tests } : {}) };
  });
}

function coverageBar(root) {
  let t = "";
  try { t = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"); } catch (_) { return false; }
  return /coverage[^\n]{0,60}?\b\d{2,3}\s?%/i.test(t);
}

// The executor: ORC's facet formula (B + N + L + T + fan + U, risk floor 70) on the
// estimated facets, then lorc's core bands. History can pick a cheaper one that did well.
function executor(root, text, g, e, d, conf, groups, opts) {
  const per = Math.max(1, Math.round(e.est / Math.max(1, groups)));
  const B = per <= 1 ? 2 : per <= 3 ? 6 : per <= 5 ? 10 : 15;
  const fresh = newOnes(text, g);
  const nc = fresh.length;
  const N = d.mechanical ? 0 : text.cues.algorithm ? 30 : nc ? 18 : 8;
  const L = text.cues.algorithm ? 24 : text.cues.state ? 16 : d.mechanical ? 0 : 8;
  const T = nc || coverageBar(root) ? 8 : g.tests ? 4 : 0;
  const fan = 5 * Math.min(Math.ceil(e.blast / 4), 3);
  const U = conf >= 0.7 ? 0 : conf >= 0.45 ? 6 : 12;
  let raw = B + N + L + T + fan + U;
  // A risky file counts only when the work changes it (an existing table definition the work
  // only reads is not a risk): a changed file, a counted named file or a new doc path.
  const touched = new Set([...e.changed, ...countedNamed(text, g)]);
  const riskFile = g.risky.find((f) => touched.has(f)) || (e.newPaths || []).find((f) => RISKY.test(f)) || null;
  const risk = riskFile ? text.risk.concat(["path"]) : (text.risk.length && (text.server || text.data) ? text.risk : []);
  const floor = risk.length ? 70 : 0;
  // High work is never haiku.
  const tierFloor = (d.tier === "high" || d.tier === "complex") && !d.mechanical ? 30 : 0;
  const score = Math.max(raw, floor, tierFloor);
  let pick = score < 30 ? "haiku-5-high" : score < 65 ? "sonnet-5-med" : score < 90 ? "opus-5-low" : "opus-5-med";
  const note = floor && raw < floor ? " → risk floor 70" : tierFloor && raw < tierFloor ? " → tier floor 30" : "";
  const out = { pick, score, formula: `${B}+${N}+${L}+${T}+${fan}+${U} = ${raw}${note}`, risk, ...(riskFile ? { riskFile } : {}) };
  if (opts.history !== false) {
    const rec = TH.executorRecord(root, d.tier, { runs: opts.runs });
    const cheaper = EXECUTORS.slice(0, EXECUTORS.indexOf(pick)).find((x) => rec[x] && rec[x].n >= 3 && rec[x].lb >= 0.55);
    if (cheaper && !floor && !(tierFloor && cheaper === "haiku-5-high")) { out.pick = cheaper; out.record = `${cheaper}: ${rec[cheaper].ok} of ${rec[cheaper].n} clean at ${d.tier}`; }
  }
  if (d.tier === "low") out.inline = true;
  return out;
}

// The engine. opts: { doc, history (false = no git, no runs), cache, runs, graph }.
// The repo has UI files: >= 3 tracked UI files (not tests), or a source folder for views
// (views, pages, screens, components, templates) with >= 3 files or with a UI file. The graph file set is used
// when it is there, else `git ls-files`. No file list gives null (unknown: change nothing).
const UI_EXT = /\.(vue|jsx|tsx|svelte|html|erb|cshtml|razor|xaml|storyboard|xib)$/i;
const UI_DIR = /(^|\/)(views|pages|screens|components|templates)\//;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.[a-z]+$/i;
function uiRepoOf(root, model) {
  let files = model && model.fileSet && model.fileSet.size ? [...model.fileSet] : null;
  if (!files) {
    const ls = gitOut(root, ["ls-files", "-z"]);
    if (ls === null) return null;
    files = ls.split("\0").filter(Boolean);
    if (!files.length) return null;
  }
  files = files.map((f) => f.replace(/\\/g, "/")).filter((f) => !TEST_PATH.test(f));
  if (files.filter((f) => UI_EXT.test(f)).length >= 3) return true;
  const dirs = new Map();
  for (const f of files) {
    const m = UI_DIR.exec(f);
    if (!m) continue;
    const k = f.slice(0, m.index + m[0].length);
    dirs.set(k, (dirs.get(k) || 0) + 1);
    if (UI_EXT.test(f)) return true;
  }
  return [...dirs.values()].some((n) => n >= 3);
}

function compute(root, request, opts = {}) {
  const t0 = Date.now();
  // The graph is loaded once: opts.loaded (prep's graph), else loadGraph. An injected graph part
  // (opts.graph) loads nothing.
  const loaded = opts.graph ? null : getLoaded(root, opts);
  const model = loaded && loaded.model;
  const gitKnown = TT.knownFromGit(root);
  const known = (n) => {
    if (model) {
      if (model.fileSet.has(n) || (model.byName.get(n) || []).length) return true;
    }
    return gitKnown ? gitKnown(n) : false;
  };
  const text = TT.parse(request, { root, doc: opts.doc, known });
  text.raw = String(request || "");
  // No UI files in the repo: UI nouns (such as "card") count as logic, before areas, score, cap and split.
  const uiRepo = uiRepoOf(root, model);
  if (uiRepo === false) {
    for (const c of text.creates) if (c.layer === "ui") c.layer = "logic";
    text.layers = text.layers.filter((l) => l !== "ui");
  }
  // The git log is read once (cached by HEAD) and shared by the git part and the history part.
  let list;
  const commits = () => (list !== undefined ? list : (list = opts.history === false ? null : TH.commits(root, { cache: opts.cache !== false })));
  // opts.graph: an injected graph part (tests); missing fields get their empty defaults.
  // No graph → the git part (unless the graph was injected; opts.gitFallback forces it).
  let part = opts.graph || graphPart(root, request, text, loaded);
  // A graph that found NO related file (a language it does not read, such as Swift or Dart,
  // gives an index with none of those files) also asks git; git wins only when it finds some.
  const empty = part.ok && !(part.core || []).length && !Object.keys(part.named || {}).length;
  if ((!part.ok || empty) && (!opts.graph || opts.gitFallback)) {
    const gp = gitPart(root, request, text, commits());
    if (gp.ok && (!part.ok || gp.core.length || Object.keys(gp.named).length)) {
      gp.graph_reason = part.ok ? "the graph found no related file" : part.reason;
      part = gp;
    }
  }
  const g = Object.assign({ ok: false, source: "graph", core: [], named: {}, blast: [], hosts: [], reuse: {}, feature: null, tests: 0, locales: 0, router: null, api: null, layers: [], projects: [], risky: [] }, part);
  g.root = root;
  g.uiRepo = uiRepo;
  const anchors = [...new Set([...countedNamed(text, g), ...(g.router ? [g.router] : []), ...(g.api ? [g.api] : []), ...g.core.slice(0, 2)])];
  const h = opts.history === false
    ? { commits: 0, cochange: [], similar: { n: 0, median_src: null, samples: [] }, runs: { n: 0 }, wiring: TH.wiringRatio(null), calibration: { factor: 1, n: 0, learned: false } }
    : historyPart(root, request, anchors, { ...opts, list: commits() });
  const e = estimate(text, g, h);
  const d = decide(text, g, h, e);
  const conf = confidence(d.score, text, g, h, d, e);
  const sp = split(text, g, e, d.tier);
  const ex = executor(root, text, g, e, d, conf, sp.length || 1, opts);
  const why = [...d.why, ...e.why];
  if (d.areas.n >= 2 && !why.some((w) => /areas/.test(w))) why.push(`${d.areas.n} areas`);
  if (g.locales && text.layers.includes("ui")) why.push(`+ tests and up to ${Math.min(g.locales, 6)} locale file(s), not counted`);
  if (ex.risk.length) why.push(`risk: ${ex.risk.filter((r) => r !== "path").join(", ") || "path"}${ex.riskFile ? ` (${ex.riskFile})` : ""}`);
  if (uiRepo === false) why.push("no UI files: UI nouns count as logic");
  if (!g.ok) why.push(`no graph: ${g.reason || "?"}`);
  else if (g.source === "git") why.push(`no graph (${g.graph_reason || "?"}): related files from git paths`);
  return {
    tier: d.tier, score: d.score, conf, cap: CAP[d.tier], groups: sp.length || (d.tier === "low" ? 0 : 1),
    est_files: e.est, executor: ex.pick, why: why.slice(0, 6), split: sp,
    detail: {
      text: { words: text.words, creates: text.creates, elements: text.elements, modifies: text.modifies, wires: text.wires, names: text.names, layers: text.layers, cues: Object.keys(text.cues).filter((k) => text.cues[k]), risk: text.risk, ui_states: text.ui_states, doc: docOut(text.doc, uiRepo) },
      graph: { ok: g.ok, source: g.source, reason: g.reason, store: g.store, files: g.files, core: g.core, feature: g.feature, hosts: g.hosts, named: g.named, blast: g.blast, router: g.router, api: g.api, layers: g.layers, projects: g.projects, tests: g.tests, locales: g.locales, risky: g.risky, specific: g.specific, analog: g.analog || null },
      history: { commits: h.commits, cochange: h.cochange, similar: h.similar, prior: h.prior, runs: h.runs, wiring: h.wiring, calibration: h.calibration },
      estimate: { raw: e.raw, structural: e.structural, added: e.added, changed: e.changed, blast: e.blast, ripple: e.ripple, hosts: e.hosts, calibration: e.calibration, ...(e.newPaths ? { newPaths: e.newPaths, wirePaths: e.wirePaths, hostAdded: e.hostAdded } : {}) },
      ui_repo: uiRepo, areas: d.areas, history_shift: d.history, mechanical: d.mechanical, executor: ex,
    },
    ms: Date.now() - t0,
  };
}

// The doc facts in the JSON. `paths` is a back-end fact: a repo with UI files does not show it.
function docOut(doc, uiRepo) {
  if (!doc || uiRepo === false) return doc;
  const { paths: _p, ...rest } = doc;
  return rest;
}

// The compact form prep puts in its JSON (the full answer goes to prep.json).
function brief(r) {
  const gr = (r.detail && r.detail.graph) || {};
  return { tier: r.tier, score: r.score, conf: r.conf, cap: r.cap, groups: r.groups, est_files: r.est_files, executor: r.executor, why: r.why.slice(0, 3).map((w) => w.slice(0, 80)),
    ...(gr.api ? { api: path.posix.basename(gr.api) } : {}), ...(gr.feature ? { feature: path.posix.basename(gr.feature) } : {}), ...(r.split.length ? { split: r.split.map((x) => `${x.g} ${x.layer}: ${x.units.map((u) => path.posix.basename(u)).join(", ")}`.slice(0, 90)) } : {}) };
}

// ── eval: the engine and jev against the runs this repo finished ─────────────
const sizeTier = (n) => (n <= 2 ? "low" : n <= 5 ? "mid" : n <= 20 ? "high" : "complex");

function evaluate(root, { recompute = false, history = false } = {}) {
  const runs = TH.readRuns(root);
  const rows = [];
  for (const r of runs) {
    if (!r || !r.slug || !TIERS.includes(r.tier)) continue;
    const p = paths.readJson(path.join(paths.projectLorcDir(root), "run", r.slug, "prep.json"), {}) || {};
    let engine = p.tier_engine && p.tier_engine.tier ? p.tier_engine : r.engine_tier ? { tier: r.engine_tier, est_files: r.est_files ?? null } : null;
    let recomputed = false;
    if (!engine && recompute && r.request) {
      try { engine = compute(root, r.request, { history, runs: runs.filter((x) => x !== r) }); recomputed = true; } catch (_) { engine = null; }
    }
    const jev = p.tier_judge && p.tier_judge.by === "jev" ? p.tier_judge : r.jev_tier ? { tier: r.jev_tier } : null;
    rows.push({
      slug: r.slug, final: r.tier, by: r.tier_by || null, src: Number.isFinite(r.src_files) ? r.src_files : null,
      engine: engine ? engine.tier : null, est: engine ? engine.est_files : null, jev: jev ? jev.tier : null, recomputed,
    });
  }
  const score = (key, truth) => {
    const xs = rows.filter((x) => x[key] && x[truth]);
    if (!xs.length) return { n: 0 };
    const exact = xs.filter((x) => x[key] === x[truth]).length;
    const near = xs.filter((x) => Math.abs(TIERS.indexOf(x[key]) - TIERS.indexOf(x[truth])) <= 1).length;
    const confusion = {};
    for (const x of xs) { const k = `${x[truth]}→${x[key]}`; confusion[k] = (confusion[k] || 0) + 1; }
    return { n: xs.length, exact: r2(exact / xs.length), within_one: r2(near / xs.length), confusion };
  };
  for (const x of rows) x.size = x.src === null ? null : sizeTier(x.src);
  const sized = rows.filter((x) => x.est !== null && x.src !== null);
  const mae = sized.length ? r2(sized.reduce((a, x) => a + Math.abs(x.est - x.src), 0) / sized.length) : null;
  return {
    runs: rows.length,
    engine_vs_final: score("engine", "final"), engine_vs_size: score("engine", "size"),
    jev_vs_final: score("jev", "final"), jev_vs_size: score("jev", "size"),
    est_files_mae: mae, calibration: TH.calibration(root, { runs }), rows: rows.slice(-20),
  };
}

function text(r) {
  const L = [`Tier: ${r.tier} — engine ${Math.round(r.conf * 100)} % · score ${r.score} · cap ${r.cap} · groups ${r.groups} · executor ${r.detail.executor.inline ? "inline" : r.executor}`];
  for (const w of r.why) L.push(`  ${w}`);
  for (const s of r.split) L.push(`  ${s.g} ${s.layer}: ${s.units.join(", ")}`);
  L.push(`  executor formula ${r.detail.executor.formula}${r.detail.executor.record ? ` · ${r.detail.executor.record}` : ""}`);
  return L.join("\n");
}

function evalText(o) {
  const f = (s) => (s.n ? `${Math.round(s.exact * 100)} % exact, ${Math.round(s.within_one * 100)} % within one (n ${s.n})` : "no data");
  return [
    `tier eval — ${o.runs} finished run(s)`,
    `  engine vs final tier: ${f(o.engine_vs_final)}`,
    `  engine vs size tier:  ${f(o.engine_vs_size)}`,
    `  jev vs final tier:    ${f(o.jev_vs_final)}`,
    `  jev vs size tier:     ${f(o.jev_vs_size)}`,
    `  est_files error:      ${o.est_files_mae === null ? "no data" : `${o.est_files_mae} files (mean absolute)`}`,
    `  calibration:          ${o.calibration.learned ? `×${o.calibration.factor} from ${o.calibration.n} runs` : `not yet (${o.calibration.n} of 5 runs with a size)`}`,
  ].join("\n");
}

function cmd(argv = []) {
  const { argRoot, positionals } = require("./core.js");
  const root = argRoot(argv);
  const pos = positionals(argv, ["--doc"]);
  const json = wantsJson(argv);
  // Build or update the graph first, as `lorc prep` does (prep passes --no-heal: it healed
  // already). A failure is fine: the git part takes over.
  const heal = () => { if (!argv.includes("--no-heal")) { try { require("./prep.js").healGraph(root); } catch (_) { /* git part */ } } };
  if (pos[0] === "eval") {
    if (argv.includes("--recompute")) heal();
    const o = evaluate(root, { recompute: argv.includes("--recompute"), history: !argv.includes("--no-history") });
    if (json) emit(o); else process.stdout.write(evalText(o) + "\n");
    return 0;
  }
  const request = pos.join(" ").trim();
  if (!request) {
    process.stderr.write('use: lorc tier "<request>" [--doc <path>] [--json] [--brief] [--no-history] [--no-heal] | lorc tier eval [--recompute] [--json]\n');
    return 2;
  }
  heal();
  const di = argv.indexOf("--doc");
  const r = compute(root, request, { doc: di >= 0 ? argv[di + 1] : undefined, history: !argv.includes("--no-history") });
  if (json) emit(argv.includes("--brief") ? brief(r) : r);
  else process.stdout.write(text(r) + "\n");
  return 0;
}

module.exports = { TIERS, CAP, fileScore, tierOf, sizeTier, layerOf, loadGraph, featureFolder, structuralAnalog, beKey, docFiles, graphPart, historyPart, estimate, decide, confidence, split, executor, compute, brief, evaluate, cmd };
