"use strict";
// lorc owns this file since 0.4.0 (forked from ORC 2.3.0 @ ae47a4a, vendor/graph). Change it here, not in ORC.
// ── orc graph — RESOLUTION and the READ commands (v1.8.0 W3) ────────────────
//
// `ctx`, `impact` and `path` answer from the stored records. Resolution is
// COMPUTED ON READ, never stored — a deliberate change from plan §3 step 5.
// W0 measured the whole resolve pass at 175 ms on Django (7K files); storing
// edges would add ~12 MB to every parse AND an invalidation path that can go
// stale in silence. The standing rule wins: a state is computed, not kept.
//
// THE STATES — never a fuzzy guess
//   LOCAL       defined in the same file (a `this.`/`self.` call prefers the caller's class)
//   IMPORT      the name, or its receiver, is bound by an import whose path resolves here
//   UNIQUE      exactly one symbol in the repo has that name (and the receiver agrees)
//   AMBIGUOUS   two or more candidates, OR a receiver that no candidate confirms — all listed
//   UNRESOLVED  nothing in this repo (a builtin, an external package, dynamic dispatch)
//   ROUTE       (v1.8.2 W1) a URL literal reaches exactly one route symbol — the
//               mount chain is known and the full path matches, or the path's tail
//               matches one route and no other
//   (EXACT is reserved for a type-checker-backed resolution; nothing emits it yet.)
//
// Every read is BUDGETED. A card never exceeds its budget and always says what
// it hid — a graph tool that returned 33K tokens is the failure this prevents.
//
// v1.8.2 W1 — URLS ARE EDGES. R3-C measured the defect: a card listed every
// caller that NAMED a symbol and declared eleven route-level tests absent. They
// reached it through `request(app).get("/orders/search")`. The extractor now
// records every URL literal a symbol sends (`urls[]`) and every mount
// (`mounts[]`); this file resolves a URL to a route symbol on read:
//   full path = the mount chain's prefix (followed across files, depth ≤ 4,
//   exactly one chain) + the route's own path, with `:id` `{id}` `<id>` `[id]`
//   as one segment and `*` as anything; trailing slash optional; query stripped.
//   A URL whose prefix is unknown (`BASE + "/p"`) matches by its tail.

const fs = require("fs");
const path = require("path");
const posix = path.posix;
const { spawnSync } = require("child_process");
const G = require("./graph.js");
const N = require("./graph-notes.js");

const { CONFIDENT, STATE_SHORT } = require("./graph-states.js");
const MOUNT_DEPTH = 4;
// W5 (G6) adds the five new languages' own conventions: RSpec and minitest
// (`_spec.rb`, `_test.rb`), Rust (`*_test.rs`, and `mod tests` lives inside
// the file it tests, which no path pattern can see), Kotlin (`*Test.kt`,
// `*Spec.kt`) and a `*_test.cpp` beside its unit.
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs|c|cc|cpp)$|(^|\/)test_[^/]*\.py$|Tests?\.(java|cs)$|Test\.php$|_(spec|test)\.rb$|(Test|Spec)\.kts?$/;
const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];
const tok = (s) => Math.ceil(String(s).length / 4);
const norm = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

// EW2: `opts.noCache` is for the WRITER — `graph-resolve.build` must compute,
// never read back the cache it is about to replace.
function loadModel(claudeDir, root, opts) {
  const p = G.graphPaths(claudeDir);
  const meta = readJson(p.meta);
  // S2: the writer hands over the index it holds; a reader reads the store.
  // W19b: format 2 reads every listed index bucket, format 1 reads index.json.
  const index = (opts && opts.index) || G.readIndex(claudeDir, meta);
  if (!meta || !index || !index.by_file) return null;
  // The stored resolution, and ONLY when it names this exact generation.
  // Anything else — a crash between two writes, an older engine, a hand
  // deletion — leaves `cached` null and every answer is computed as before.
  const cached = opts && opts.noCache ? null : require("./graph-resolve.js").load(claudeDir, meta);
  const byFile = index.by_file;
  const symbols = new Map();
  const byName = new Map();
  for (const [rel, f] of Object.entries(byFile)) {
    for (const s of f.symbols || []) {
      s.file = rel;
      symbols.set(s.id, s);
      if (s.kind === "module") continue;
      const a = byName.get(s.name);
      if (a) a.push(s);
      else byName.set(s.name, [s]);
    }
  }
  return {
    root,
    meta,
    notes: N.noteIndex(claudeDir),
    byFile,
    fileSet: new Set(Object.keys(byFile)),
    symbols,
    byName,
    bindings: new Map(),
    resolved: new Map(),
    // The REVERSE direction only. EW2 measured storing the whole memo as a net
    // loss (21.7 MB to parse, to save less than that), while this half is the
    // one the 437 ms walk was computing.
    callersCache: cached ? cached.callers || {} : null,
    maybeCache: cached ? cached.maybe || {} : null,
    generation: meta.generation || 0,
    suffix: new Map(),
    dirs: null,
    goModule: undefined,
    callIndex: null,
    // W1: the route table and the URL memo, both built on first use.
    routes: null,
    urlIndex: null,
    urlMemo: new Map(),
    // S3: blob freshness, batched by `warmBlobs` (one git call per read).
    blobStates: new Map(),
  };
}

// ── import targets ──────────────────────────────────────────────────────────
function bySuffix(model, suffix) {
  if (model.suffix.has(suffix)) return model.suffix.get(suffix);
  const out = [];
  for (const f of model.fileSet) if (f === suffix || f.endsWith("/" + suffix)) out.push(f);
  model.suffix.set(suffix, out);
  return out;
}

function filesInDir(model, dir, ext) {
  if (!model.dirs) {
    model.dirs = new Map();
    for (const f of model.fileSet) {
      const d = posix.dirname(f);
      const a = model.dirs.get(d);
      if (a) a.push(f);
      else model.dirs.set(d, [f]);
    }
  }
  return (model.dirs.get(dir) || []).filter((f) => f.endsWith(ext));
}

// v2.2.0 (D1): the `@/` alias. A SPA whose code lives under `client/src/`
// is not served by "`@/` means `src/`". The aliases a project DECLARES win —
// jsconfig/tsconfig `paths`, a bundler `alias`, a jest `moduleNameMapper` —
// read from disk once per directory per process (never evaluated). Then the
// nearest package `src/`, then the old root `src/`.
const ALIAS_JSON = ["jsconfig.json", "tsconfig.json"];
const ALIAS_BUNDLER = ["vue.config.js", "webpack.config.js", "vite.config.js", "vite.config.ts", "vite.config.mjs"];
const ALIAS_RX_RESOLVE = /['"]?(@[\w-]*|~)['"]?\s*:\s*(?:path\.)?(?:resolve|join)\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)/g;
const ALIAS_RX_URL = /['"]?(@[\w-]*|~)['"]?\s*:\s*fileURLToPath\(\s*new\s+URL\(\s*['"]([^'"]+)['"]/g;
const ALIAS_RX_JEST = /['"]\^(@[\w-]*|~)\/\(\.\*\)\$['"]\s*:\s*['"]<rootDir>\/([^'"]*?)\/?\$1['"]/g;

const cleanRel = (p) => {
  const n = posix.normalize(p).replace(/^\.\//, "");
  return n === "." ? "" : n;
};

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return null;
  }
}

function stripJsonc(t) {
  return t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

// One table per directory: [{ prefix, target, exact }]. Built once per
// directory per process; a cache hit makes no fs call.
function aliasTable(model, dir) {
  if (!model.aliasTables) model.aliasTables = new Map();
  if (model.aliasTables.has(dir)) return model.aliasTables.get(dir);
  const out = [];
  const at = (name) => path.join(model.root || "", dir, name);
  // W19c: ONE directory listing, then read only the names that are there. A
  // failed read per config name per directory cost ~130 ms on each resolve.
  let present = null;
  try {
    present = new Set(fs.readdirSync(path.join(model.root || "", dir)).map((n) => n.toLowerCase()));
  } catch (_) {
    present = new Set();
  }
  const readAt = (name) => (present.has(name) ? readText(at(name)) : null);
  for (const name of ALIAS_JSON) {
    const t = readAt(name);
    if (t === null) continue;
    let j = null;
    try {
      j = JSON.parse(stripJsonc(t));
    } catch (_) {
      j = null;
    }
    const co = (j && j.compilerOptions) || {};
    const baseUrl = typeof co.baseUrl === "string" ? co.baseUrl : ".";
    for (const [k, v] of Object.entries(co.paths || {})) {
      const first = Array.isArray(v) ? v[0] : v;
      if (typeof first !== "string") continue;
      const target = cleanRel(posix.join(dir, baseUrl, first.replace(/\*$/, "")));
      if (k.endsWith("*")) out.push({ prefix: k.slice(0, -1), target, exact: false });
      else out.push({ prefix: k, target, exact: true });
    }
  }
  const scan = (t, rx) => {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(t))) out.push({ prefix: m[1] + "/", target: cleanRel(posix.join(dir, m[2])), exact: false });
  };
  for (const name of ALIAS_BUNDLER) {
    const t = readAt(name);
    if (t === null) continue;
    scan(t, ALIAS_RX_RESOLVE);
    scan(t, ALIAS_RX_URL);
  }
  const jt = readAt("jest.config.js");
  if (jt !== null) scan(jt, ALIAS_RX_JEST);
  model.aliasTables.set(dir, out);
  return out;
}

// Nearest ancestor first, the repository root ("") last.
function ancestorDirs(from) {
  const out = [];
  let d = posix.dirname(from);
  for (;;) {
    if (d === "." || d === "/" || d === "") {
      out.push("");
      break;
    }
    out.push(d);
    d = posix.dirname(d);
  }
  return out;
}

// Every directory D for which the index holds a file under `D/src/`.
function srcRoots(model) {
  if (model.srcRoots) return model.srcRoots;
  const out = new Set();
  for (const f of model.fileSet) {
    const parts = f.split("/");
    for (let i = 0; i < parts.length - 1; i++) if (parts[i] === "src") out.add(parts.slice(0, i).join("/"));
  }
  model.srcRoots = out;
  return out;
}

function aliasBase(model, from, spec) {
  const dirs = ancestorDirs(from);
  for (const d of dirs) {
    let best = null;
    for (const e of aliasTable(model, d)) {
      const ok = e.exact ? spec === e.prefix : spec.startsWith(e.prefix);
      if (ok && (!best || e.prefix.length > best.prefix.length)) best = e;
    }
    if (best) return cleanRel(best.exact ? best.target : posix.join(best.target, spec.slice(best.prefix.length)));
  }
  if (/^[@~]\//.test(spec)) {
    const roots = srcRoots(model);
    for (const d of dirs) if (roots.has(d)) return cleanRel(posix.join(d, "src", spec.slice(2)));
    return "src/" + spec.slice(2);
  }
  return null;
}

function resolveJs(model, from, spec) {
  let base;
  if (spec.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else if (spec.startsWith("/")) base = spec.slice(1);
  else {
    base = aliasBase(model, from, spec);
    if (base === null) return [];
  }
  const cands = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => `${base}/index${e}`)];
  // TS ESM writes `./x.js` for a file that is `x.ts` on disk.
  if (/\.(js|jsx|mjs|cjs)$/.test(base)) {
    const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
    cands.push(...JS_EXT.map((e) => stem + e));
  }
  for (const c of cands) if (model.fileSet.has(c)) return [c];
  return [];
}

function resolvePy(model, from, spec) {
  const lvl = /^\.*/.exec(spec)[0].length;
  const parts = spec.slice(lvl).split(".").filter(Boolean);
  let dir = "";
  if (lvl) {
    dir = posix.dirname(from);
    for (let i = 1; i < lvl; i++) dir = posix.dirname(dir);
    if (dir === ".") dir = "";
  }
  const p = [dir, ...parts].filter(Boolean).join("/");
  for (const c of p ? [`${p}.py`, `${p}/__init__.py`] : [`${dir ? dir + "/" : ""}__init__.py`]) if (model.fileSet.has(c)) return [c];
  if (!lvl && parts.length) {
    const a = bySuffix(model, `${parts.join("/")}.py`);
    if (a.length) return a;
    return bySuffix(model, `${parts.join("/")}/__init__.py`);
  }
  return [];
}

function resolveGo(model, spec) {
  if (model.goModule === undefined) {
    model.goModule = null;
    try {
      const mm = /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(model.root, "go.mod"), "utf8"));
      if (mm) model.goModule = mm[1];
    } catch (_) {}
  }
  if (!model.goModule || !spec.startsWith(model.goModule + "/")) return [];
  return filesInDir(model, spec.slice(model.goModule.length + 1), ".go").filter((f) => !f.endsWith("_test.go"));
}

// W5 (G6). Every file whose DIRECTORY ends with this package path — Kotlin
// names a package, not a file, and a Kotlin file name need not match its class.
function filesInPackage(model, pkg, ext) {
  if (!pkg) return [];
  const key = `pkg\0${pkg}\0${ext}`;
  if (model.suffix.has(key)) return model.suffix.get(key);
  const out = [];
  for (const f of model.fileSet) {
    if (!f.endsWith(ext)) continue;
    const d = posix.dirname(f);
    if (d === pkg || d.endsWith("/" + pkg)) out.push(f);
  }
  model.suffix.set(key, out);
  return out;
}

// W5 (G6). `mod store;` is a sibling file or a folder with `mod.rs`;
// `use crate::store::OrderStore` names a path from the crate root.
function resolveRs(model, from, imp) {
  const dir = posix.dirname(from);
  const spec = imp.from || "";
  if (imp.mod) {
    for (const c of [`${dir}/${spec}.rs`, `${dir}/${spec}/mod.rs`]) if (model.fileSet.has(c)) return [c];
    return [];
  }
  const parts = spec.split("::").filter(Boolean);
  if (!parts.length) return [];
  // An integration test under `tests/` names the crate by its PACKAGE name,
  // not by `crate` — the same fact `go.mod` carries for Go.
  if (model.rustCrate === undefined) {
    model.rustCrate = null;
    try {
      const mm = /^\s*name\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(model.root, "Cargo.toml"), "utf8"));
      if (mm) model.rustCrate = mm[1].replace(/-/g, "_");
    } catch (_) {}
  }
  let base = parts;
  if (parts[0] === "crate" || parts[0] === "self" || (model.rustCrate && parts[0] === model.rustCrate)) base = parts.slice(1);
  else if (parts[0] === "super") {
    const up = posix.dirname(dir);
    base = parts.slice(1);
    const p = [up === "." ? "" : up, ...base].filter(Boolean).join("/");
    for (const c of [`${p}.rs`, `${p}/mod.rs`]) if (model.fileSet.has(c)) return [c];
    return [];
  } else return []; // an external crate
  const p = base.join("/");
  for (const c of [`${p}.rs`, `${p}/mod.rs`, `src/${p}.rs`, `src/${p}/mod.rs`]) if (model.fileSet.has(c)) return [c];
  const a = bySuffix(model, `${p}.rs`);
  return a.length ? a : bySuffix(model, `${p}/mod.rs`);
}

function importTargets(model, from, lang, imp) {
  const spec = imp.from || "";
  if (lang === "js" || lang === "ts" || lang === "vue" || lang === "svelte") return resolveJs(model, from, spec);
  if (lang === "rb") {
    if (imp.include) {
      const rel = posix.normalize(posix.join(posix.dirname(from), spec));
      const hit = [rel, `${rel}.rb`].find((c) => model.fileSet.has(c));
      if (hit) return [hit];
    }
    return bySuffix(model, /\.rb$/.test(spec) ? spec : `${spec}.rb`);
  }
  if (lang === "rs") return resolveRs(model, from, imp);
  if (lang === "kt") {
    const parts = spec.split(".");
    const last = parts[parts.length - 1];
    const pkg = parts.slice(0, -1).join("/");
    // `import a.b.OrderStore` — the file is usually `OrderStore.kt`, but a
    // Kotlin file may hold several classes, so the package folder is the
    // fallback, never a guess at a same-named file anywhere in the tree.
    if (imp.star) return filesInPackage(model, spec.replace(/\./g, "/"), ".kt");
    const byFile = bySuffix(model, `${pkg ? pkg + "/" : ""}${last}.kt`);
    return byFile.length ? byFile : filesInPackage(model, pkg, ".kt");
  }
  if (lang === "c") {
    const rel = posix.normalize(posix.join(posix.dirname(from), spec));
    return model.fileSet.has(rel) ? [rel] : bySuffix(model, spec.replace(/^(\.\.?\/)+/, ""));
  }
  if (lang === "py") return resolvePy(model, from, spec);
  if (lang === "go") return resolveGo(model, spec);
  if (lang === "java") {
    // A wildcard import names a package, not a file; the UNIQUE rung covers it.
    if (imp.star) return [];
    return bySuffix(model, `${spec.replace(/\./g, "/")}.java`);
  }
  if (lang === "php") {
    if (imp.include) {
      const rel = posix.normalize(posix.join(posix.dirname(from), spec));
      return model.fileSet.has(rel) ? [rel] : bySuffix(model, spec.replace(/^(\.\.?\/)+/, ""));
    }
    return bySuffix(model, `${spec.replace(/\\/g, "/")}.php`);
  }
  return [];
}

function fileBindings(model, rel) {
  if (model.bindings.has(rel)) return model.bindings.get(rel);
  const b = new Map();
  const includes = [];
  const f = model.byFile[rel] || {};
  for (const imp of f.imports || []) {
    const files = importTargets(model, rel, f.lang, imp);
    if (imp.include) includes.push(...files);
    for (const bd of imp.bindings || []) b.set(bd.local, { ...bd, from: imp.from, files });
  }
  const out = { map: b, includes };
  model.bindings.set(rel, out);
  return out;
}

// ── resolution ──────────────────────────────────────────────────────────────
// W19c: memoised per symbol object (pure on `qname`).
const CLASS_OF = new WeakMap();
function classOf(sym) {
  const hit = CLASS_OF.get(sym);
  if (hit !== undefined && hit.q === sym.qname) return hit.c;
  const q = sym.qname.split(".");
  const c = q.length > 1 ? q.slice(0, -1).join(".") : null;
  CLASS_OF.set(sym, { q: sym.qname, c });
  return c;
}

// W19c: per-model tables that `resolveCall` used to rebuild on every call.
// Built once per model; the same arrays, in the same order, as the filters.
function memoOf(model) {
  return model._memo || (model._memo = { locals: new Map(), cands: new Map() });
}
// The non-module symbols of `rel` named `name`, in symbol order.
function localsNamed(model, rel, name) {
  const m = memoOf(model).locals;
  let byName = m.get(rel);
  if (!byName) {
    byName = new Map();
    for (const s of (model.byFile[rel] || {}).symbols || []) {
      if (s.kind === "module") continue;
      const a = byName.get(s.name);
      if (a) a.push(s);
      else byName.set(s.name, [s]);
    }
    m.set(rel, byName);
  }
  return byName.get(name) || [];
}
// The repository-wide candidates for a bare name (the last rung).
function candsNamed(model, name, testCaller, member) {
  const m = memoOf(model).cands;
  const key = `${name}\0${testCaller ? 1 : 0}\0${member ? 1 : 0}`;
  let v = m.get(key);
  if (!v) {
    const named = model.byName.get(name) || [];
    const all = testCaller ? named : named.filter((s) => !TEST_FILE.test(s.file));
    v = member ? all : all.filter((s) => !classOf(s));
    m.set(key, v);
  }
  return v;
}

// ── W2 (G4): barrels ────────────────────────────────────────────────────────
// `import { OrderService } from "./orders"` reaches `orders/index.ts`, which
// defines nothing and re-exports. Follow its re-exports (depth ≤ 3, cycle-safe)
// to every file that may define `name`, remembering the name it is defined
// under there (`export { a as b }` renames). The head of the list is always
// the file the import named, so a barrel that DOES define the name still wins.
const BARREL_DEPTH = 3;
function barrelTargets(model, files, name, depth, seen) {
  const out = [];
  for (const file of files) {
    const k = `${file}\0${name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ file, name });
    if (depth >= BARREL_DEPTH) continue;
    const f = model.byFile[file] || {};
    for (const rx of f.reexports || []) {
      let orig = null;
      if (rx.names === "*") orig = name;
      else {
        const hitName = (rx.names || []).find((n) => n.local === name);
        if (hitName) orig = hitName.orig;
      }
      if (orig == null) continue;
      const targets = importTargets(model, file, f.lang, { from: rx.from });
      out.push(...barrelTargets(model, targets, orig, depth + 1, seen));
    }
  }
  return out;
}

// ── W2 (G3): inherited members ──────────────────────────────────────────────
// The class named `name` as seen from `rel`: in this file (LOCAL), through an
// import (IMPORT, barrels followed), or the only class of that name (UNIQUE).
function classSymbol(model, rel, name) {
  const f = model.byFile[rel] || {};
  const local = (f.symbols || []).find((s) => s.kind === "class" && s.name === name);
  if (local) return { sym: local, state: "LOCAL" };
  const bd = fileBindings(model, rel).map.get(name);
  if (bd && bd.files.length) {
    for (const t of barrelTargets(model, bd.files, bd.orig === "default" || bd.orig === "*" ? name : bd.orig, 0, new Set())) {
      const s = ((model.byFile[t.file] || {}).symbols || []).find((x) => x.kind === "class" && x.name === t.name);
      if (s) return { sym: s, state: "IMPORT" };
    }
    // W5b: a DEFAULT import names the file's default export, whatever the
    // importer calls it (`import FM from "./formMixin"`). When that file holds
    // exactly one exported class, it is the one.
    if (bd.orig === "default") {
      const only = ((model.byFile[bd.files[0]] || {}).symbols || []).filter((x) => x.kind === "class" && x.exported);
      if (only.length === 1) return { sym: only[0], state: "IMPORT" };
    }
  }
  if (f.lang === "go") {
    const s = filesInDir(model, posix.dirname(rel), ".go").flatMap((x) => ((model.byFile[x] || {}).symbols || []).filter((y) => y.kind === "class" && y.name === name));
    if (s.length === 1) return { sym: s[0], state: "LOCAL" };
  }
  const all = (model.byName.get(name) || []).filter((s) => s.kind === "class");
  if (all.length === 1) return { sym: all[0], state: "UNIQUE" };
  return null;
}

// lorc 0.5.0 (W34c): the interface named `name` as seen from `rel`: in this
// file, through an import (barrels followed), or the only interface of that
// name in the repository. Null when none of these finds one.
function interfaceSymbol(model, rel, name) {
  const isIf = (x) => x.kind === "interface" && x.name === name;
  const local = ((model.byFile[rel] || {}).symbols || []).find(isIf);
  if (local) return local;
  const bd = fileBindings(model, rel).map.get(name);
  if (bd && bd.files.length) {
    for (const t of barrelTargets(model, bd.files, bd.orig === "default" || bd.orig === "*" ? name : bd.orig, 0, new Set())) {
      const s = ((model.byFile[t.file] || {}).symbols || []).find((x) => x.kind === "interface" && x.name === t.name);
      if (s) return s;
    }
  }
  const all = (model.byName.get(name) || []).filter((x) => x.kind === "interface");
  return all.length === 1 ? all[0] : null;
}

// lorc 0.5.0 (W34c): owner symbol id → the classes that implement or extend
// it. Built once per model from the `bases` of each class (max 8 bases).
const IMPL_MAX = 8;
function implIndex(model) {
  if (model._implIndex) return model._implIndex;
  const idx = new Map();
  for (const [rel, f] of Object.entries(model.byFile)) {
    for (const c of f.symbols || []) {
      if (c.kind !== "class" || !Array.isArray(c.bases) || !c.bases.length) continue;
      for (const raw of c.bases.slice(0, IMPL_MAX)) {
        const name = String(raw).replace(/<[\s\S]*$/, "").trim().split(".").pop();
        if (!name) continue;
        let o = interfaceSymbol(model, rel, name);
        if (!o) {
          const cs = classSymbol(model, rel, name);
          o = cs ? cs.sym : null;
        }
        if (!o || o.id === c.id) continue;
        const a = idx.get(o.id);
        if (a) a.push(c);
        else idx.set(o.id, [c]);
      }
    }
  }
  model._implIndex = idx;
  return idx;
}

// lorc 0.5.0 (W34c): a confident result on an interface member, or on an
// abstract (name-only) member, also reaches the same member of each class that
// implements the owner (and of one more level of subclasses).
function withImpl(model, r) {
  if (!r || !r.target || r.targets || !CONFIDENT.has(r.state)) return r;
  const T = model.symbols.get(r.target);
  if (!T || T.kind === "module") return r;
  const owner = classOf(T);
  if (!owner) return r;
  const O = ((model.byFile[T.file] || {}).symbols || []).find((x) => x.qname === owner && x.kind !== "module");
  // The index does not store `nameOnly`. An abstract member is a one-line
  // member with no calls in a class that has subclasses.
  const abstractLike = T.nameOnly || (O && O.kind === "class" && T.lines && T.lines[0] === T.lines[1] && !(T.calls || []).length);
  if (!O || (O.kind !== "interface" && !abstractLike)) return r;
  const idx = implIndex(model);
  const classes = [];
  for (const c of (idx.get(O.id) || []).slice(0, IMPL_MAX)) {
    classes.push(c);
    for (const d of (idx.get(c.id) || []).slice(0, IMPL_MAX)) classes.push(d);
  }
  const ids = [];
  for (const c of classes) {
    const m = ((model.byFile[c.file] || {}).symbols || []).find((x) => x.kind !== "module" && x.qname === `${c.qname}.${T.name}`);
    if (m && m.id !== T.id && !ids.includes(m.id)) ids.push(m.id);
  }
  return ids.length ? { ...r, targets: [T.id, ...ids], impl: O.name } : r;
}

// lorc 0.5.0 (W32d, C11): the type `name` (a `class` symbol: a class or a
// struct) as seen from `rel`. The order: this file (LOCAL); then the files of
// the Go package directory and the files this file imports (IMPORT, when
// exactly one type has the name there); then the only type of that name in the
// repository (UNIQUE). Null when none of these finds one type.
function typeSymbol(model, rel, name) {
  const isType = (s) => s.kind === "class" && s.name === name;
  const f = model.byFile[rel] || {};
  const local = (f.symbols || []).find(isType);
  if (local) return { sym: local, state: "LOCAL" };
  const files = new Set();
  if (f.lang === "go") for (const x of filesInDir(model, posix.dirname(rel), ".go")) if (x !== rel) files.add(x);
  for (const bd of fileBindings(model, rel).map.values()) for (const x of bd.files || []) files.add(x);
  const near = [...files].flatMap((x) => ((model.byFile[x] || {}).symbols || []).filter(isType));
  if (near.length === 1) return { sym: near[0], state: "IMPORT" };
  if (near.length > 1) return null;
  const all = (model.byName.get(name) || []).filter(isType);
  if (all.length === 1) return { sym: all[0], state: "UNIQUE" };
  return null;
}

// The member `m` of the type symbol `t`: a symbol `T.m` in the file of `t`,
// for Go in any file of its package directory, then a member that `T`
// inherits. Null when there is none.
function memberOfType(model, t, m) {
  const q = `${t.name}.${m}`;
  const own = ((model.byFile[t.file] || {}).symbols || []).find((s) => s.kind !== "module" && s.qname === q);
  if (own) return own;
  if (/\.go$/.test(t.file)) {
    const s = filesInDir(model, posix.dirname(t.file), ".go")
      .filter((x) => !/_test\.go$/.test(x))
      .flatMap((x) => ((model.byFile[x] || {}).symbols || []).filter((y) => y.kind !== "module" && y.qname === q));
    if (s.length === 1) return s[0];
    if (s.length > 1) return null;
  }
  const inh = inheritedMember(model, t.file, t.name, m, 0, new Set());
  return inh ? inh.sym : null;
}

// `this.m()` in a class with no `m` of its own: walk the base chain (depth ≤
// 4, ≤ 8 bases per class, cycle-safe) and return the base member with the
// state the BASE CLASS resolved with from the subclass's file.
const INHERIT_DEPTH = 4;
function inheritedMember(model, rel, className, member, depth, seen) {
  if (depth > INHERIT_DEPTH) return null;
  const own = classSymbol(model, rel, className);
  if (!own) return null;
  for (const base of (own.sym.bases || []).slice(0, 8)) {
    if (seen.has(base)) continue;
    seen.add(base);
    const b = classSymbol(model, own.sym.file, base);
    if (!b) continue;
    const mem = ((model.byFile[b.sym.file] || {}).symbols || []).find((s) => s.kind !== "module" && s.name === member && classOf(s) && classOf(s).split(".").pop() === b.sym.name);
    if (mem) return { sym: mem, state: b.state };
    const deeper = inheritedMember(model, b.sym.file, b.sym.name, member, depth + 1, seen);
    if (deeper) return deeper;
  }
  return null;
}

// v2.2.0: SPA route navigation. `{ name: "<route name>", route: true }`, or
// `{ name: "IDENT.MEMBER", route: true, via: true }` where IDENT is a const
// object (this file's own, or imported) whose `values[MEMBER]` holds the
// route name. Never subject to the `call.ref` restriction.
function routeNameIndex(model) {
  if (model.routeNames) return model.routeNames;
  const idx = new Map();
  for (const s of model.symbols.values()) {
    if (s.kind !== "route" || typeof s.route_name !== "string") continue;
    if (!idx.has(s.route_name)) idx.set(s.route_name, []);
    idx.get(s.route_name).push(s);
  }
  model.routeNames = idx;
  return idx;
}

// lorc 0.5.0 (W29a): the string value of a constant expression, as seen
// from `rel`. Null when the expression has no known string value.
//   `NAME`  → this file's `const` NAME, or the const that the import NAME
//            names (barrels followed).
//   `A.B`   → A is a namespace import: the const B of the target file.
//            A is an object const (this file's own, or imported): `values[B]`.
function constValue(model, rel, expr) {
  if (typeof expr !== "string" || !expr) return null;
  const str = (v) => (typeof v === "string" ? v : null);
  const symIn = (file, q, pred) => ((model.byFile[file] || {}).symbols || []).find((x) => x.kind !== "module" && x.qname === q && (!pred || pred(x))) || null;
  const isConst = (x) => x.kind === "const";
  const parts = expr.split(".");
  const id = parts[0];
  const bd = fileBindings(model, rel).map.get(id);
  if (parts.length === 1) {
    const own = symIn(rel, id, isConst);
    if (own) return str(own.value);
    if (!bd || !bd.files.length || bd.kind !== "named") return null;
    for (const pair of barrelTargets(model, bd.files, bd.orig, 0, new Set())) {
      const t = symIn(pair.file, pair.name, isConst);
      if (t) return str(t.value);
    }
    return null;
  }
  const member = parts.slice(1).join(".");
  let s = symIn(rel, id);
  if (!s && bd && bd.files.length) {
    if (bd.kind === "namespace" && parts.length === 2) {
      for (const pair of barrelTargets(model, bd.files, member, 0, new Set())) {
        const t = symIn(pair.file, pair.name, isConst);
        if (t && typeof t.value === "string") return t.value;
      }
    }
    const wanted = bd.kind === "named" ? bd.orig : bd.local;
    for (const pair of barrelTargets(model, bd.files, wanted, 0, new Set())) {
      s = symIn(pair.file, pair.name);
      if (s) break;
    }
  }
  const values = s && s.values;
  return values && Object.prototype.hasOwnProperty.call(values, member) ? str(values[member]) : null;
}

// lorc 0.5.0 (W29b): the route paths of the SPA router. A route symbol with
// a name "VIEW <path>" gives one row. A `:param` segment matches any one
// segment. A path without a leading "/" is a child route: it matches the end
// of the call path.
// The extractor writes a nested child route with a leading "/" ("VIEW
// /webhooks" for `{ path: 'webhooks' }` under "/settings"). A route whose
// lines are inside the lines of a different route of the same file is a child
// of the smallest such route: its full path is the parent's full path and its
// own path, unless its own path already starts with the parent's full path.
function routePathIndex(model) {
  if (model._routePaths) return model._routePaths;
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const toRe = (p) => p.split("/").map((seg) => (/^:/.test(seg) ? "[^/]+" : esc(seg))).join("/");
  const routes = [];
  for (const s of model.symbols.values()) {
    if (s.kind !== "route" || typeof s.name !== "string" || !s.name.startsWith("VIEW ")) continue;
    let p = s.name.slice(5).trim();
    // lorc 0.5.0 (W28h): a file of child routes mounted by `children: xs` in
    // another file gets that mount's prefix (one known prefix only).
    const pre = prefixesOf(model, s.file, 0, new Set());
    if (pre.length === 1 && pre[0]) p = joinPrefix(pre[0], p) || p;
    if (p) routes.push({ sym: s, own: p });
  }
  const parentOf = (r) => {
    let best = null;
    const [a, b] = r.sym.lines || [0, 0];
    for (const o of routes) {
      if (o === r || o.sym.file !== r.sym.file || !o.sym.lines) continue;
      const [oa, ob] = o.sym.lines;
      if (oa > a || ob < b || (oa === a && ob === b)) continue;
      if (!best || ob - oa < best.sym.lines[1] - best.sym.lines[0]) best = o;
    }
    return best;
  };
  const fullOf = (r, depth) => {
    if (r.full !== undefined) return r.full;
    const par = depth < 8 ? parentOf(r) : null;
    let full = r.own;
    if (par) {
      const pf = fullOf(par, depth + 1);
      const rest = r.own.replace(/^\/+/, "");
      if (!(r.own.startsWith("/") && pf !== "/" && (r.own === pf || r.own.startsWith(pf + "/")))) full = rest ? `${pf.replace(/\/+$/, "")}/${rest}` : pf;
    }
    r.parent = par;
    r.full = full;
    return full;
  };
  const out = [];
  for (const r of routes) {
    const p = fullOf(r, 0);
    const child = !p.startsWith("/");
    const body = toRe(p);
    const lit = p.split("/").some((seg) => seg && !/^:/.test(seg));
    out.push({ sym: r.sym, path: p, re: new RegExp(child ? `(?:^|/)${body}$` : `^${body}$`), tail: lit ? new RegExp(`/${toRe(r.own.replace(/^\/+/, ""))}$`) : null, row: r });
  }
  model._routePaths = out;
  return out;
}

function resolveRoutePath(model, call) {
  const want = call.name;
  let rows = routePathIndex(model).filter((row) => row.path === want || row.re.test(want));
  // No full path matches: a route's own path (with one literal segment) that
  // is the END of the call path is a hit.
  if (!rows.length) rows = routePathIndex(model).filter((row) => row.tail && row.row.own.replace(/^\/+/, "").split("/").some((seg) => seg && !/^:/.test(seg)) && row.tail.test(want));
  // A parent route and its own "" child have the same full path: the child
  // (the page) wins. An exact path wins over a `:param` match.
  if (rows.length > 1) {
    const ancestors = new Set();
    for (const row of rows) for (let p = row.row.parent; p; p = p.parent) ancestors.add(p.sym.id);
    rows = rows.filter((row) => !ancestors.has(row.sym.id));
  }
  if (rows.length > 1 && rows.some((row) => row.path === want)) rows = rows.filter((row) => row.path === want);
  const hits = [...new Set(rows.map((row) => row.sym.id))];
  if (hits.length === 1) return { state: "ROUTE", target: hits[0] };
  if (hits.length > 1) return { state: "AMBIGUOUS", candidates: hits };
  return { state: "UNRESOLVED", missing_route: want };
}

function resolveRouteCall(model, rel, call) {
  if (call.path) return resolveRoutePath(model, call);
  let rname = call.name;
  if (call.via) {
    const v = constValue(model, rel, call.name);
    if (v == null) return { state: "UNRESOLVED" };
    rname = v;
  }
  const hits = routeNameIndex(model).get(rname) || [];
  if (hits.length === 1) return { state: "ROUTE", target: hits[0].id };
  if (hits.length > 1) return { state: "AMBIGUOUS", candidates: hits.map((s) => s.id) };
  return { state: "UNRESOLVED", missing_route: rname };
}

// ── lorc 0.5.0 (W29a): store links ──────────────────────────────────────────
// The store index: role → full key → [member symbol id]. A registration
// (`store_modules` on a symbol) names a module by its binding; the module
// file holds the `store_module` class. A namespaced module adds
// "<name>/" to the prefix of its members. A module that no registration names
// has the prefix "" and its class name as its module name.
const STORE_DEPTH = 4;
function storeIndex(model) {
  if (model._storeIndex) return model._storeIndex;
  const idx = { mutation: new Map(), action: new Map(), getter: new Map(), state: new Map(), modules: new Map() };
  // rel → [own prefix] of each namespaced module in that file.
  const own = new Map();
  const classes = [];
  for (const [rel, f] of Object.entries(model.byFile)) for (const s of f.symbols || []) if (s.kind === "class" && s.store_module) classes.push(s);
  const inClass = (c, s) => s.file === c.file && (s.qname === c.qname || s.qname.startsWith(c.qname + "."));
  const ownerClass = (s) => classes.find((c) => inClass(c, s)) || null;
  // The store_module class that `ref` names, as seen from `rel`.
  function moduleClass(rel, ref) {
    const local = classes.find((c) => c.file === rel && c.name === ref);
    if (local) return local;
    const bd = fileBindings(model, rel).map.get(ref);
    if (!bd || !bd.files.length) return null;
    const wanted = bd.kind === "named" ? bd.orig : null;
    for (const pair of barrelTargets(model, bd.files, wanted || ref, 0, new Set())) {
      const here = classes.filter((c) => c.file === pair.file);
      if (!here.length) continue;
      if (wanted) {
        const hit = here.find((c) => c.name === pair.name);
        if (hit) return hit;
        continue;
      }
      if (here.length === 1) return here[0];
      const ex = here.filter((c) => c.exported);
      if (ex.length === 1) return ex[0];
    }
    return null;
  }
  const add = (map, key, id) => {
    const a = map.get(key);
    if (!a) map.set(key, [id]);
    else if (!a.includes(id)) a.push(id);
  };
  const registered = new Set();
  function addModule(cls, name, prefix, depth, seen) {
    if (seen.has(cls.id)) return;
    seen.add(cls.id);
    registered.add(cls.id);
    if (cls.namespaced) {
      const a = own.get(cls.file) || [];
      if (!a.includes(prefix)) a.push(prefix);
      own.set(cls.file, a);
    }
    if (!idx.modules.has(name)) idx.modules.set(name, cls.id);
    for (const s of (model.byFile[cls.file] || {}).symbols || []) {
      if (!s.qname.startsWith(cls.qname + ".")) continue;
      if (s.kind === "state") add(idx.state, `${name}.${s.name}`, s.id);
      else if (s.store && idx[s.store] && s.store !== "state") {
        const key = typeof s.key === "string" ? s.key : s.key_via ? constValue(model, cls.file, s.key_via) : null;
        if (key != null) add(idx[s.store], prefix + key, s.id);
      }
    }
    if (depth >= STORE_DEPTH) return;
    for (const s of (model.byFile[cls.file] || {}).symbols || []) {
      if (!inClass(cls, s)) continue;
      for (const m of s.store_modules || []) {
        const child = moduleClass(cls.file, m.ref);
        if (child) addModule(child, m.name, prefix + (child.namespaced ? m.name + "/" : ""), depth + 1, new Set(seen));
      }
    }
  }
  for (const [rel, f] of Object.entries(model.byFile)) {
    for (const s of f.symbols || []) {
      if (!s.store_modules || ownerClass({ ...s, file: rel })) continue;
      for (const m of s.store_modules) {
        const cls = moduleClass(rel, m.ref);
        if (cls) addModule(cls, m.name, cls.namespaced ? m.name + "/" : "", 1, new Set());
      }
    }
  }
  for (const c of classes) if (!registered.has(c.id)) addModule(c, c.name, "", 1, new Set());
  idx.ownPrefix = own;
  model._storeIndex = idx;
  return idx;
}

// A store call → the store member. The key is a NAME; a key or namespace
// that has no known value is UNRESOLVED (no guess).
function resolveStoreCall(model, rel, call) {
  const role = call.store;
  let key = call.via ? constValue(model, rel, call.name) : call.name;
  if (key == null) return { state: "UNRESOLVED" };
  if (call.ns_via) {
    const ns = constValue(model, rel, call.ns_via);
    if (ns == null) return { state: "UNRESOLVED" };
    key = role === "state" ? `${ns}.${key}` : `${ns}/${key}`;
  }
  const idx = storeIndex(model);
  let ids = [];
  if (role === "state") {
    ids = idx.state.get(key) || [];
    if (!ids.length && !key.includes(".") && idx.modules.has(key)) ids = [idx.modules.get(key)];
  } else if (idx[role]) {
    if (!key.includes("/")) for (const p of idx.ownPrefix.get(rel) || []) if (!ids.length) ids = idx[role].get(p + key) || [];
    if (!ids.length) ids = idx[role].get(key) || [];
  }
  if (ids.length === 1) return { state: "STORE", target: ids[0] };
  // W29b: Vuex runs EVERY non-namespaced mutation or action with the key.
  if (ids.length > 1 && (role === "mutation" || role === "action")) return { state: "STORE", target: ids[0], targets: ids.slice() };
  if (ids.length > 1) return { state: "AMBIGUOUS", candidates: ids.slice() };
  return { state: "UNRESOLVED", missing_store: `${role} ${key}` };
}

// ── lorc 0.5.0 (W29b): listen, prop, i18n, global mixins ────────────────────
// `Local.member` → the `emit` (listen) or `prop` (prop) symbol `member` of the
// component that the binding `Local` names.
function resolveContractCall(model, rel, call) {
  const kind = call.listen ? "emit" : "prop";
  const dot = call.name.indexOf(".");
  if (dot <= 0) return { state: "UNRESOLVED" };
  const local = call.name.slice(0, dot);
  const member = call.name.slice(dot + 1);
  const bd = fileBindings(model, rel).map.get(local);
  if (!bd || !bd.files.length) return { state: "UNRESOLVED" };
  const wanted = bd.kind === "named" ? bd.orig : bd.local;
  for (const pair of barrelTargets(model, bd.files, wanted, 0, new Set())) {
    const s = ((model.byFile[pair.file] || {}).symbols || []).find((x) => x.kind === kind && x.name === member);
    if (s) return { state: pair.file === rel ? "LOCAL" : "IMPORT", target: s.id };
  }
  return { state: "UNRESOLVED" };
}

// The locale key index: key → [{file, line}]. The files are in this order: a
// file whose basename starts with "en" first, then by path. `prefixes` holds
// the same for each object key (a key that has child keys).
function i18nIndex(model) {
  if (model._i18nIndex) return model._i18nIndex;
  const base = (p) => p.split("/").pop();
  const files = Object.keys(model.byFile)
    .filter((rel) => (model.byFile[rel] || {}).lang === "i18n")
    .sort((a, b) => (base(a).startsWith("en") ? 0 : 1) - (base(b).startsWith("en") ? 0 : 1) || a.localeCompare(b));
  const keys = new Map();
  const prefixes = new Map();
  const add = (map, k, hit) => {
    const a = map.get(k);
    if (!a) map.set(k, [hit]);
    else if (!a.some((h) => h.file === hit.file)) a.push(hit);
  };
  for (const file of files) {
    for (const kl of model.byFile[file].keys || []) {
      if (!Array.isArray(kl) || typeof kl[0] !== "string") continue;
      const hit = { file, line: kl[1] };
      add(keys, kl[0], hit);
      const parts = kl[0].split(".");
      for (let i = 1; i < parts.length; i++) add(prefixes, parts.slice(0, i).join("."), hit);
    }
  }
  model._i18nIndex = { files, keys, prefixes };
  return model._i18nIndex;
}

// The key that an i18n call names, or null when it has no known value.
function i18nKey(model, rel, call) {
  return call.via ? constValue(model, rel, call.name) : call.name;
}

function resolveI18nCall(model, rel, call) {
  const key = i18nKey(model, rel, call);
  if (key == null) return { state: "UNRESOLVED" };
  const idx = i18nIndex(model);
  const hits = idx.keys.get(key) || (call.prefix ? idx.prefixes.get(key) : null) || [];
  if (hits.length) return { state: "I18N", file: hits[0].file, line: hits[0].line, also: hits.length - 1 };
  return idx.files.length ? { state: "UNRESOLVED", missing_i18n: key } : { state: "UNRESOLVED" };
}

// key → [{sym, line}] over every i18n call (keys resolved through `via`).
function i18nUsers(model, key) {
  if (!model._i18nUsers) {
    const m = new Map();
    for (const [rel, f] of Object.entries(model.byFile)) {
      for (const s of f.symbols || []) {
        for (const c of s.calls || []) {
          if (!c.i18n) continue;
          const k = i18nKey(model, rel, c);
          if (k == null) continue;
          if (!m.has(k)) m.set(k, []);
          m.get(k).push({ sym: s, line: c.line });
        }
      }
    }
    model._i18nUsers = m;
  }
  return model._i18nUsers.get(key) || [];
}

// lorc 0.5.0 (W29c): the global event index. name → [{symId, line}] for each
// side (`on`, `emit`). A `via` name is folded through constValue. `onSyms`
// holds every symbol id that registers a listener.
function eventIndex(model) {
  if (model._eventIndex) return model._eventIndex;
  const on = new Map();
  const emit = new Map();
  const onSyms = new Set();
  const calls = [];
  for (const [rel, f] of Object.entries(model.byFile)) {
    for (const s of f.symbols || []) {
      for (const c of s.calls || []) {
        if (c.event !== "emit" && c.event !== "on") continue;
        calls.push({ rel, sym: s, call: c });
        const name = c.via ? constValue(model, rel, c.name) : c.name;
        if (name == null) continue;
        const map = c.event === "on" ? on : emit;
        if (!map.has(name)) map.set(name, []);
        map.get(name).push({ symId: s.id, line: c.line });
        if (c.event === "on") onSyms.add(s.id);
      }
    }
  }
  model._eventIndex = { on, emit, onSyms, calls };
  return model._eventIndex;
}

function eventName(model, rel, call) {
  return call.via ? constValue(model, rel, call.name) : call.name;
}

function resolveEventCall(model, rel, call) {
  const name = eventName(model, rel, call);
  if (name == null) return { state: "UNRESOLVED" };
  const idx = eventIndex(model);
  if (call.event === "on") return { state: "UNRESOLVED", event_on: true, emitters: (idx.emit.get(name) || []).length };
  const targets = [...new Set((idx.on.get(name) || []).map((h) => h.symId))];
  if (!targets.length) return { state: "UNRESOLVED", missing_event: name };
  return { state: "EVENT", target: targets[0], targets };
}

// lorc 0.5.0 (W29c): config key index from `env` files. key → [{file, line}].
// A `.env.example` / `.env.sample` file comes first. KEYS ONLY: no value is
// read or kept.
function configIndex(model) {
  if (model._configIndex) return model._configIndex;
  const sample = (p) => (/(^|\/)\.env\.(example|sample)$/.test(p) ? 0 : 1);
  const files = Object.keys(model.byFile)
    .filter((rel) => (model.byFile[rel] || {}).lang === "env")
    .sort((a, b) => sample(a) - sample(b) || a.localeCompare(b));
  const keys = new Map();
  for (const file of files) {
    for (const kl of model.byFile[file].keys || []) {
      if (!Array.isArray(kl) || typeof kl[0] !== "string") continue;
      const a = keys.get(kl[0]);
      const hit = { file, line: kl[1] };
      if (!a) keys.set(kl[0], [hit]);
      else if (!a.some((h) => h.file === file)) a.push(hit);
    }
  }
  model._configIndex = { files, keys };
  return model._configIndex;
}

// key → [{sym, line}] from `env` effects.
function configUsers(model, key) {
  if (!model._configUsers) {
    const m = new Map();
    for (const f of Object.values(model.byFile)) {
      for (const s of f.symbols || []) {
        for (const e of s.effects || []) {
          if (!e || e.type !== "env" || typeof e.text !== "string") continue;
          if (!m.has(e.text)) m.set(e.text, []);
          m.get(e.text).push({ sym: s, line: e.line });
        }
      }
    }
    model._configUsers = m;
  }
  return model._configUsers.get(key) || [];
}

function resolveConfig(model, key) {
  const idx = configIndex(model);
  const hits = idx.keys.get(key) || [];
  if (hits.length) return { state: "CONFIG", file: hits[0].file, line: hits[0].line, also: hits.length - 1 };
  return idx.files.length ? { state: "UNRESOLVED", missing_config: key } : { state: "UNRESOLVED" };
}

// lorc 0.5.0 (W29c): table → {defs: [{file, line}] from `sql` files,
// entities: [class symbol id] from classes with `table`}.
function tableIndex(model) {
  if (model._tableIndex) return model._tableIndex;
  const m = new Map();
  const get = (t) => {
    if (!m.has(t)) m.set(t, { defs: [], entities: [] });
    return m.get(t);
  };
  let any = false;
  for (const rel of Object.keys(model.byFile).sort()) {
    const f = model.byFile[rel] || {};
    if (f.lang === "sql") {
      for (const kl of f.keys || []) {
        if (!Array.isArray(kl) || typeof kl[0] !== "string") continue;
        get(kl[0]).defs.push({ file: rel, line: kl[1] });
        any = true;
      }
    }
    // lorc 0.5.0 (W34d): an effect with `def` (knex `createTable`) defines its tables.
    for (const s of f.symbols || []) {
      for (const e of s.effects || []) {
        if (!e || !e.def || !Array.isArray(e.tables)) continue;
        for (const t of e.tables) {
          if (typeof t !== "string") continue;
          get(t.toLowerCase()).defs.push({ file: rel, line: e.line });
          any = true;
        }
      }
    }
    for (const s of f.symbols || []) {
      if (s.kind !== "class" || typeof s.table !== "string") continue;
      get(s.table.toLowerCase()).entities.push(s.id);
      any = true;
    }
  }
  model._tableIndex = { tables: m, any };
  return model._tableIndex;
}

// table → [{sym, line, type}] from effects with `tables`.
function tableUsers(model, table) {
  if (!model._tableUsers) {
    const m = new Map();
    for (const f of Object.values(model.byFile)) {
      for (const s of f.symbols || []) {
        for (const e of s.effects || []) {
          if (!e || !Array.isArray(e.tables)) continue;
          for (const t of e.tables) {
            if (!m.has(t)) m.set(t, []);
            m.get(t).push({ sym: s, line: e.line, type: e.type });
          }
        }
      }
    }
    model._tableUsers = m;
  }
  return model._tableUsers.get(table) || [];
}

function resolveTable(model, name) {
  const idx = tableIndex(model);
  const t = idx.tables.get(String(name).toLowerCase());
  if (t && (t.defs.length || t.entities.length)) {
    return { state: "TABLE", ...(t.defs.length ? { file: t.defs[0].file, line: t.defs[0].line } : {}), ...(t.entities.length ? { entity: t.entities[0] } : {}) };
  }
  return idx.any ? { state: "UNRESOLVED", missing_table: name } : { state: "UNRESOLVED" };
}

// lorc 0.5.0 (W28h): every name set by `Vue.prototype.X = …`.
function globalProps(model) {
  if (model._globalProps) return model._globalProps;
  const out = new Set();
  for (const f of Object.values(model.byFile)) for (const s of f.symbols || []) for (const n of s.global_props || []) if (typeof n === "string") out.add(n);
  model._globalProps = out;
  return out;
}

// name → member symbol of every global mixin (`Vue.mixin(X)`). The mixin
// classes and their bases (depth ≤ 4). The first member of a name wins.
function globalMembers(model) {
  if (model._globalMembers) return model._globalMembers;
  const out = new Map();
  const seen = new Set();
  const addClass = (cls, depth) => {
    if (!cls || seen.has(cls.id)) return;
    seen.add(cls.id);
    for (const s of (model.byFile[cls.file] || {}).symbols || []) {
      if (s.kind === "module" || s.kind === "class" || !s.qname.startsWith(cls.qname + ".")) continue;
      if (!out.has(s.name)) out.set(s.name, s);
    }
    if (depth >= INHERIT_DEPTH) return;
    for (const base of (cls.bases || []).slice(0, 8)) {
      const b = classSymbol(model, cls.file, base);
      if (b) addClass(b.sym, depth + 1);
    }
  };
  for (const [rel, f] of Object.entries(model.byFile)) {
    for (const s of f.symbols || []) {
      for (const name of s.global_mixins || []) {
        if (typeof name !== "string") continue;
        const local = (f.symbols || []).find((x) => x.kind === "class" && x.name === name);
        if (local) {
          addClass(local, 0);
          continue;
        }
        const bd = fileBindings(model, rel).map.get(name);
        if (!bd || !bd.files.length) continue;
        const wanted = bd.kind === "named" ? bd.orig : name;
        for (const pair of barrelTargets(model, bd.files, wanted, 0, new Set())) {
          const classes = ((model.byFile[pair.file] || {}).symbols || []).filter((x) => x.kind === "class");
          const named = classes.filter((x) => x.name === pair.name);
          const pick = named.length ? named : bd.kind === "named" ? [] : classes.filter((x) => x.exported).length === 1 ? classes.filter((x) => x.exported) : classes.length === 1 ? classes : [];
          for (const c of pick) addClass(c, 0);
          if (pick.length) break;
        }
      }
    }
  }
  model._globalMembers = out;
  return out;
}

// Every call with `store`, once per model (the walk for callers of a store
// member when no derived cache is there).
function storeCalls(model) {
  if (model._storeCalls) return model._storeCalls;
  const out = [];
  for (const [rel, f] of Object.entries(model.byFile)) for (const s of f.symbols || []) for (const c of s.calls || []) if (c.store) out.push({ rel, sym: s, call: c });
  model._storeCalls = out;
  return out;
}

// lorc 0.5.0 (W34c): the qname of the smallest class of `rel` whose lines hold
// `line`. Null when no class holds it.
function enclosingClass(model, rel, line) {
  let best = null;
  for (const s of (model.byFile[rel] || {}).symbols || []) {
    if (s.kind !== "class" || !s.lines || s.lines[0] > line || s.lines[1] < line) continue;
    if (!best || s.lines[1] - s.lines[0] < best.lines[1] - best.lines[0]) best = s;
  }
  return best ? best.qname : null;
}

// W29b: every call with `listen` or `prop`, once per model.
function contractCalls(model) {
  if (model._contractCalls) return model._contractCalls;
  const out = [];
  for (const [rel, f] of Object.entries(model.byFile)) for (const s of f.symbols || []) for (const c of s.calls || []) if (c.listen || c.prop) out.push({ rel, sym: s, call: c });
  model._contractCalls = out;
  return out;
}

function resolveCall(model, rel, caller, call) {
  let cls = caller ? classOf(caller) : null;
  // lorc 0.5.0 (W34c): a symbol with no class in its qname (a route in a
  // constructor) that makes a self call uses the smallest class that holds it.
  if (!cls && caller && caller.kind !== "module" && (call.self || call.sup) && caller.lines) cls = enclosingClass(model, rel, caller.lines[0]);
  // W19c: the memo is per file (`model.resolved`: rel → Map), so the key to
  // hash is short. The key parts are the same as before.
  const key = `${cls || ""}\0${call.name}\0${call.self ? 1 : 0}${call.ref ? 1 : 0}${call.sup ? 1 : 0}${call.alias ? 1 : 0}${call.route ? (call.via ? 2 : 1) : 0}${call.chain ? 1 : 0}${call.lv ? 1 : 0}${call.inst ? 1 : 0}\0${call.ext || ""}${call.store ? `\0${call.store}${call.via ? 1 : 0}\0${call.ns_via || ""}` : ""}${call.path ? "\0path" : ""}${call.listen ? "\0listen" : ""}${call.prop ? "\0prop" : ""}${call.i18n ? `\0i18n${call.via ? 1 : 0}${call.prefix ? 1 : 0}` : ""}`;
  let memo = model.resolved.get(rel);
  if (!memo) model.resolved.set(rel, (memo = new Map()));
  if (call.listen || call.prop || call.i18n) {
    const done = memo.get(key);
    if (done !== undefined) return done;
    const rl = call.i18n ? resolveI18nCall(model, rel, call) : resolveContractCall(model, rel, call);
    memo.set(key, rl);
    return rl;
  }
  if (call.event === "emit" || call.event === "on") {
    // W29c: a global event by name. The index is per model, so no memo here.
    return resolveEventCall(model, rel, call);
  }
  if (call.route) {
    const rr = resolveRouteCall(model, rel, call);
    memo.set(key, rr);
    return rr;
  }
  if (call.store) {
    const done = memo.get(key);
    if (done !== undefined) return done;
    const rs = resolveStoreCall(model, rel, call);
    memo.set(key, rs);
    return rs;
  }
  const known = memo.get(key);
  if (known !== undefined) return known;
  // lorc 0.5.0 (W32a): a call on a call result (`f().m()`) has no known
  // receiver type. It is not a guess over every `m` in the repository.
  if (call.chain) {
    const rc = { state: "UNRESOLVED" };
    memo.set(key, rc);
    return rc;
  }
  // lorc 0.5.0 (W28g, R1): the alias type comes from an import. When that
  // import is not a file of this repository, the call is external. It never
  // matches a repo type of the same name.
  if (call.ext) {
    const fe = model.byFile[rel] || {};
    const imp = (fe.imports || []).find((i) => i.from === call.ext);
    if (!imp || !importTargets(model, rel, fe.lang, imp).length) {
      const rx = { state: "UNRESOLVED", external: call.ext };
      memo.set(key, rx);
      return rx;
    }
  }
  const parts = call.name.split(".");
  // lorc 0.5.0 (W32d, C11): `T.f.m` — the head was typed at extraction
  // (`h.Discovery.List`, `this.svc.repo.find`). The field `f` of the type
  // `T` names the type `U`; the target is the member `U.m`. When one step
  // does not resolve, the result is UNRESOLVED: the name never makes a guess.
  if (call.alias && parts.length === 3) {
    let r3 = { state: "UNRESOLVED" };
    const t = typeSymbol(model, rel, parts[0]);
    const u = t && t.sym.fields && Object.prototype.hasOwnProperty.call(t.sym.fields, parts[1]) ? typeSymbol(model, t.sym.file, t.sym.fields[parts[1]]) : null;
    const s = u ? memberOfType(model, u.sym, parts[2]) : null;
    if (s) r3 = withImpl(model, { state: s.file === rel ? "LOCAL" : "IMPORT", target: s.id, via_field: parts[1] });
    memo.set(key, r3);
    return r3;
  }
  const last = parts[parts.length - 1];
  const head = parts.length > 1 ? parts[0] : null;
  const f = model.byFile[rel] || {};
  const locals = localsNamed(model, rel, last);
  const { map: binds, includes } = fileBindings(model, rel);
  const lang = f.lang;
  let r = null;
  const hit = (state, s) => ({ state, target: s.id });

  // lorc 0.5.0 (W32c, C12): `wrapper.vm.m()` in a test. The component is one
  // that this file imports: a `.vue .svelte .jsx .tsx` file, or a `.ts` / `.js`
  // file with a class. Exactly one member `m` there → IMPORT. Otherwise the
  // repository-wide name rung below runs.
  if (call.inst) {
    const seen = new Set();
    const found = [];
    for (const bd of binds.values()) {
      for (const file of bd.files || []) {
        if (seen.has(file)) continue;
        seen.add(file);
        const tsyms = (model.byFile[file] || {}).symbols || [];
        if (!/\.(vue|svelte|jsx|tsx)$/.test(file) && !(/\.[cm]?[jt]s$/.test(file) && tsyms.some((s) => s.kind === "class"))) continue;
        const classes = new Set(tsyms.filter((s) => s.kind === "class").map((s) => s.qname));
        for (const s of tsyms) if (s.kind !== "module" && s.name === last && classOf(s) && classes.has(classOf(s))) found.push(s);
      }
    }
    if (found.length === 1) r = hit("IMPORT", found[0]);
  }
  // `super.m()` never resolves to the class's own member.
  if (!call.sup && !head && locals.length) {
    const same = call.self && cls ? locals.find((s) => classOf(s) === cls) : null;
    // W2: a self call on a class that has no such member is not a local
    // function of the same name — it is inherited, or nothing.
    const pick = same || (call.self && cls ? null : locals.find((s) => !classOf(s) || !call.self) || locals[0]);
    if (pick) r = hit("LOCAL", pick);
  }
  if (!r && !call.sup && head) {
    const m2 = locals.filter((s) => s.qname === `${head}.${last}` || s.qname.endsWith(`.${head}.${last}`));
    if (m2.length) r = hit("LOCAL", m2[0]);
  }
  // W2 (G3): a self call with no own member walks the base chain.
  if (!r && call.self && !head && cls) {
    const inh = inheritedMember(model, rel, cls.split(".").pop(), last, 0, new Set());
    if (inh) r = { state: inh.state, target: inh.sym.id, inherited: true };
  }
  // lorc 0.5.0 (W29b): a member of a global mixin (`Vue.mixin(X)`) is in the
  // scope of every component.
  if (!r && call.self && !head && /\.(vue|svelte)$/.test(rel)) {
    const g = globalMembers(model).get(last);
    if (g) r = { state: "IMPORT", target: g.id, inherited: true };
  }
  if (!r) {
    const bd = binds.get(head || last);
    if (bd && !bd.files.length && lang !== "cs") {
      // Bound by an import that does not resolve to a file here — an external
      // package. Matching it against a same-named repo function would invent
      // an edge (axios.get → some repo `get`).
      if (!(lang === "py" && bd.kind === "named")) r = { state: "UNRESOLVED", external: bd.from };
    }
    if (!r && bd && bd.files.length) {
      // W2 (G4): the files the binding names, and every file a barrel among
      // them re-exports the name from — with the name it carries there.
      const wanted = bd.kind === "named" ? bd.orig : bd.local;
      const pairs = barrelTargets(model, bd.files, wanted, 0, new Set());
      let s = null;
      for (const pair of pairs) {
        const tsyms = ((model.byFile[pair.file] || {}).symbols || []).filter((x) => x.kind !== "module");
        const orig = bd.kind === "named" ? pair.name : bd.orig;
        const localName = bd.kind === "named" ? pair.name : pair.name;
        if (head) {
          s =
            tsyms.find((x) => x.qname === `${orig}.${last}` || x.qname === `${localName}.${last}`) ||
            (bd.kind === "namespace" || bd.kind === "default" ? tsyms.find((x) => x.name === last && !classOf(x)) : null) ||
            tsyms.find((x) => x.name === last && x.qname.startsWith(orig + "."));
        } else if (bd.kind === "named") {
          s = tsyms.find((x) => x.qname === orig) || tsyms.find((x) => x.name === orig && !classOf(x));
        } else {
          const exported = tsyms.filter((x) => x.exported && !classOf(x));
          s = tsyms.find((x) => x.qname === localName) || (exported.length === 1 ? exported[0] : null);
        }
        if (s) break;
      }
      // `from pkg import module` — the name is a module, not a symbol in pkg.
      if (!s && lang === "py" && bd.kind === "named") {
        const sub = resolvePy(model, rel, `${bd.from}.${bd.orig}`);
        const ss = sub.flatMap((t) => ((model.byFile[t] || {}).symbols || []).filter((x) => x.kind !== "module"));
        s = head ? ss.find((x) => x.name === last && !classOf(x)) : null;
      }
      if (s) r = hit("IMPORT", s);
    }
  }
  // lorc 0.5.0 (W32c, C9): `X.k` where no symbol `X.k` exists and `X` is a
  // `const` or `enum` (this file's → LOCAL, imported → IMPORT) is a use of
  // `X` itself; `member` names the key.
  if (!r && !call.sup && !call.self && head && parts.length === 2) {
    const own = (f.symbols || []).find((s) => (s.kind === "const" || s.kind === "enum") && s.qname === head);
    if (own) r = { ...hit("LOCAL", own), member: last };
    else {
      const bd = binds.get(head);
      if (bd && bd.files.length) {
        const wanted = bd.kind === "named" ? bd.orig : bd.local;
        for (const pair of barrelTargets(model, bd.files, wanted, 0, new Set())) {
          const s = ((model.byFile[pair.file] || {}).symbols || []).find((x) => (x.kind === "const" || x.kind === "enum") && x.qname === pair.name);
          if (s) {
            r = { ...hit("IMPORT", s), member: last };
            break;
          }
        }
      }
    }
  }
  // A file this one INCLUDES by path names its symbols directly — a bare name
  // (PHP, C) and, since W5, a member of a class declared in that header.
  if (!r && includes.length) {
    const s = includes.flatMap((t) => ((model.byFile[t] || {}).symbols || []).filter((x) => x.kind !== "module" && (head ? x.qname === `${head}.${last}` : x.name === last && !classOf(x))))[0];
    if (s) r = hit("IMPORT", s);
  }
  // W1: Go's package scope is the DIRECTORY. A bare name defined in a sibling
  // `.go` file is as local as one in this file — no import names it, and the
  // UNIQUE rung would call a second `New` elsewhere in the module ambiguous.
  // W5 (G6) gives Rust, Kotlin and C/C++ the same rung, for the same reason: a
  // `mod` sibling, a class in the same Kotlin package, and a translation unit
  // beside this one are all named without an import.
  const DIR_SCOPE = { go: ".go", rs: ".rs", kt: ".kt", c: ".cpp" };
  if (!r && DIR_SCOPE[lang] && (!head || call.alias)) {
    const isTest = /_test\.go$/.test(rel);
    const exts = lang === "c" ? [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh"] : [DIR_SCOPE[lang]];
    const s = exts
      .flatMap((e) => filesInDir(model, posix.dirname(rel), e))
      .filter((f) => f !== rel && (isTest || !/_test\.go$/.test(f)))
      .flatMap((f) => ((model.byFile[f] || {}).symbols || []).filter((x) => x.kind !== "module" && (head ? x.qname === `${head}.${last}` : x.name === last && !classOf(x))));
    if (s.length === 1) r = hit("LOCAL", s[0]);
  }
  // W5 (G6). C++ reaches a member — its own, or one it inherits — with no
  // `this->`. Every rung above has already run, so a free function of that
  // name still wins; this is the last step before the repository-wide guess.
  if (!r && !head && !call.self && lang === "c" && cls) {
    const own = (f.symbols || []).find((s) => s.name === last && classOf(s) === cls);
    if (own) r = hit("LOCAL", own);
    else {
      const inh = inheritedMember(model, rel, cls.split(".").pop(), last, 0, new Set());
      if (inh) r = { state: inh.state, target: inh.sym.id, inherited: true };
    }
  }
  // lorc 0.5.0 (W32d, C11): `T.m` where the head was typed at extraction (a
  // parameter `s *store.Store`). The type `T` from this file, its package or
  // its imports, then its member `m`.
  if (!r && call.alias && head && parts.length === 2) {
    const t = typeSymbol(model, rel, head);
    const s = t && t.state !== "UNIQUE" ? memberOfType(model, t.sym, last) : null;
    if (s) r = hit(s.file === rel ? "LOCAL" : "IMPORT", s);
  }
  // lorc 0.5.0 (W32a): a method call on a local value (`err.Error()`) has no
  // known type, so the repository-wide name rung does not run for it.
  if (!r && !call.lv) {
    // W1: a bare `get(…)` is never a class METHOD — a method is reached through
    // a receiver, `this`, or inheritance. Before this, `request(app).get("/p")`
    // resolved UNIQUE to the only method named `get` in the repository.
    // v2.2.0 (D5): a source file never resolves into a test helper. A test
    // caller keeps every candidate.
    const cands = candsNamed(model, last, TEST_FILE.test(rel), !!(head || call.self || call.inst));
    if (head) {
      const hl = head.toLowerCase();
      const byClass = cands.filter((s) => {
        const c = classOf(s);
        return c && c.split(".").pop().toLowerCase() === hl;
      });
      if (byClass.length === 1) r = hit("UNIQUE", byClass[0]);
      else if (byClass.length > 1) r = { state: "AMBIGUOUS", candidates: byClass.map((s) => s.id) };
      // W2 (G2): the head came from an alias, so it IS a class name. A class
      // named `Router` with no `get` is not "some `get` somewhere" — it is
      // outside this repository (an external package), and saying AMBIGUOUS
      // over every `get` in the tree was the nestjs/nest 118-maybe noise.
      else if (call.alias) r = { state: "UNRESOLVED", external: head };
      else if (cands.length) r = { state: "AMBIGUOUS", candidates: cands.map((s) => s.id) };
    } else if (cands.length === 1) r = hit("UNIQUE", cands[0]);
    else if (cands.length > 1) r = { state: "AMBIGUOUS", candidates: cands.map((s) => s.id) };
  }
  if (!r) r = { state: "UNRESOLVED" };
  // A name passed as an argument is only an edge when this file defines it or
  // imports it. `res.json(order)` must never find a repo function named `order`.
  if (call.ref && r.state !== "LOCAL" && r.state !== "IMPORT") r = { state: "UNRESOLVED" };
  // lorc 0.5.0 (W28h): a template / self ref named like a `Vue.prototype.X`
  // global that found nothing else is external, not a miss.
  if (r.state === "UNRESOLVED" && !r.external && (call.tpl || call.self) && !head && globalProps(model).has(last)) r = { state: "UNRESOLVED", external: "Vue.prototype" };
  r = withImpl(model, r);
  memo.set(key, r);
  return r;
}

function callIndex(model) {
  if (model.callIndex) return model.callIndex;
  const idx = new Map();
  for (const [rel, f] of Object.entries(model.byFile)) {
    for (const s of f.symbols || []) {
      for (const c of s.calls || []) {
        const last = c.name.split(".").pop();
        const a = idx.get(last);
        const row = { rel, sym: s, call: c };
        if (a) a.push(row);
        else idx.set(last, [row]);
      }
    }
  }
  model.callIndex = idx;
  return idx;
}

// ── W1: routes and URLs ─────────────────────────────────────────────────────
const PARAM_SEG = /:\w+\??|\{[^}]*\}|<[^>]*>|\[[^\]]*\]/g;
const isLiteralPath = (p) => !/[:{<\[*]/.test(p);

// A route path → a regular expression over a URL path. One segment per
// parameter, `*` is anything, the trailing slash is optional.
function pathSource(p) {
  const s = String(p).replace(/\/+$/, "");
  return s
    .split("/")
    .map((seg) => {
      if (seg === "*" || seg === "**") return ".*";
      let out = "";
      let last = 0;
      for (const mm of seg.matchAll(PARAM_SEG)) {
        out += seg.slice(last, mm.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (mm[0].endsWith("?") ? "[^/]*" : "[^/]+");
        last = mm.index + mm[0].length;
      }
      out += seg.slice(last).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
      return out;
    })
    .join("/");
}

const joinPrefix = (a, b) => (String(a || "") + "/" + String(b || "")).replace(/\/{2,}/g, "/").replace(/\/+$/, "");

// Which files a mount's TARGET names: an import binding (`ordersRouter`,
// `orders.router`), an inline `require("./x")`, a Django `include("a.urls")`.
function mountTargets(model, rel, mt) {
  const f = model.byFile[rel] || {};
  const lang = f.lang;
  const t = String(mt.target || "");
  if (!t) return [];
  // lorc 0.5.0 (W28g): `this.r` is a router of the same class. `routeTable`
  // gives its prefix to the routes registered on it.
  if (t.startsWith("this.")) return [];
  // lorc 0.5.0 (W28g): `x.getRouter` where `x = new X()` → the file of class `X`.
  if (mt.cls) {
    const cb = fileBindings(model, rel).map.get(mt.cls);
    if (cb && cb.files.length) return cb.files;
  }
  // An instance from another file (`const { accountController } = await init()`):
  // the class whose name is the head in any case (`AccountController`), in
  // the files this file imports or the files they import. One file only.
  const head0 = t.split(".")[0];
  if (!mt.cls && /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(t) && !fileBindings(model, rel).map.get(head0)) {
    const want = head0.toLowerCase();
    const seen = new Set([rel]);
    const hits = new Set();
    let frontier = [rel];
    for (let d = 0; d < 3 && !hits.size; d++) {
      const next = [];
      for (const f0 of frontier)
        for (const bd of fileBindings(model, f0).map.values())
          for (const file of bd.files || []) {
            if (seen.has(file)) continue;
            seen.add(file);
            next.push(file);
            if (((model.byFile[file] || {}).symbols || []).some((x) => x.kind === "class" && x.qname.toLowerCase() === want)) hits.add(file);
          }
      frontier = next;
    }
    if (hits.size === 1) return [...hits];
  }
  if (mt.module) return lang === "py" ? resolvePy(model, rel, t) : resolveJs(model, rel, t);
  if (/^[./]/.test(t)) return lang === "py" ? resolvePy(model, rel, t) : resolveJs(model, rel, t);
  const head = t.split(".")[0];
  const bd = fileBindings(model, rel).map.get(head);
  if (!bd) return [];
  // `from app.routers import orders` + `orders.router`: the binding names a
  // MODULE, and the package `__init__.py` it also resolves to is not the file
  // that holds the router.
  if (lang === "py" && bd.kind === "named" && t.includes(".")) {
    const sub = resolvePy(model, rel, `${bd.from}.${bd.orig}`);
    if (sub.length) return sub;
  }
  if (bd.files.length) return bd.files;
  if (lang === "py" && bd.kind === "named") return resolvePy(model, rel, `${bd.from}.${bd.orig}`);
  return [];
}

// file → the mounts that reach it, built once per model.
function mountsInto(model) {
  if (model.mountsInto) return model.mountsInto;
  const into = new Map();
  for (const [rel, f] of Object.entries(model.byFile)) {
    for (const s of f.symbols || []) {
      for (const mt of s.mounts || []) {
        // lorc 0.5.0 (W34b): an autoload mount reaches every file under its
        // folder. The prefix adds the sub-folders of the file (`_id` → `:id`),
        // or nothing more when the mount is `flat`.
        if (mt.dir) {
          const base = String(mt.dir).replace(/\/+$/, "") + "/";
          for (const f2 of model.fileSet || []) {
            if (!f2.startsWith(base) || f2 === rel) continue;
            const subs = f2.slice(base.length).split("/").slice(0, -1).map((d) => (d.startsWith("_") ? ":" + d.slice(1) : d));
            const prefix = mt.flat || !subs.length ? mt.prefix || "" : joinPrefix(mt.prefix, "/" + subs.join("/"));
            const a = into.get(f2) || [];
            a.push({ prefix, from: rel });
            into.set(f2, a);
          }
          continue;
        }
        for (const target of mountTargets(model, rel, mt)) {
          const a = into.get(target) || [];
          a.push({ prefix: mt.prefix || "", from: rel, ...(/\./.test(String(mt.target || "")) && !/^[./]/.test(String(mt.target)) ? { via: String(mt.target).split(".").pop() } : {}) });
          into.set(target, a);
        }
      }
    }
  }
  model.mountsInto = into;
  return into;
}

// Every full prefix under which `rel` is reachable, following mounts across
// files. Exactly one is a KNOWN mount; none means unmounted (the route's own
// path is the full path); several means the file is mounted more than once.
function prefixesOf(model, rel, depth, seen, on) {
  let ins = mountsInto(model).get(rel) || [];
  // lorc 0.5.0 (W28g): a mount through a getter that returns `this.r` reaches
  // only the routes on `this.r` (`on`).
  if (depth === 0 && on) {
    const getter = (via) => {
      const g = via ? ((model.byFile[rel] || {}).symbols || []).find((x) => x.kind === "method" && x.name === via && x.returns) : null;
      return g ? g.returns : null;
    };
    ins = ins.filter((m) => {
      const r = getter(m.via);
      return !r || r === on;
    });
  }
  // lorc 0.5.0 (W28g): a test that mounts a router is not where the app mounts it.
  if (ins.some((m) => !TEST_FILE.test(m.from))) ins = ins.filter((m) => !TEST_FILE.test(m.from));
  if (!ins.length || depth >= MOUNT_DEPTH) return [""];
  const out = new Set();
  for (const m of ins) {
    if (seen.has(m.from)) continue;
    for (const p of prefixesOf(model, m.from, depth + 1, new Set([...seen, rel]))) out.add(joinPrefix(p, m.prefix));
  }
  return out.size ? [...out] : [""];
}

// lorc 0.5.0 (W28g): `on` (`this.r`) mounted in `rel` on another router
// (`this.router.use("/p", this.r)`) → { prefix, on: the outer router }.
// Followed up to MOUNT_DEPTH; one mount per step, else the walk stops.
function innerPrefix(model, rel, on) {
  let prefix = "";
  const seen = new Set();
  for (let d = 0; d < MOUNT_DEPTH && on && !seen.has(on); d++) {
    seen.add(on);
    const hits = [];
    for (const sy of (model.byFile[rel] || {}).symbols || []) for (const mt of sy.mounts || []) if (mt.target === on) hits.push(mt);
    const ps = new Set(hits.map((mt) => `${mt.prefix || ""}\0${mt.on || ""}`));
    if (ps.size !== 1) break;
    prefix = joinPrefix(hits[0].prefix, prefix);
    on = hits[0].on || null;
  }
  return { prefix, on };
}

function routeTable(model) {
  if (model.routes) return model.routes;
  const rows = [];
  for (const s of model.symbols.values()) {
    if (s.kind !== "route") continue;
    const mm = /^([A-Z]+) (.+)$/.exec(s.name);
    if (!mm) continue;
    // lorc 0.5.0 (W28g): a route on `this.r`, and `this.r` mounted in the
    // same file → the mount prefix comes first.
    const inner = s.on ? innerPrefix(model, s.file, s.on) : { prefix: "", on: null };
    const own = inner.prefix ? joinPrefix(inner.prefix, mm[2]) || "/" : mm[2];
    const prefixes = prefixesOf(model, s.file, 0, new Set(), inner.on);
    const full = prefixes.length === 1 ? joinPrefix(prefixes[0], own) || "/" : null;
    rows.push({
      sym: s,
      method: mm[1],
      own,
      full,
      mounted: prefixes.length === 1 ? (prefixes[0] ? "known" : "none") : "ambiguous",
      literal: isLiteralPath(own) && (full == null || isLiteralPath(full)),
      reFull: full != null ? new RegExp("^" + pathSource(full) + "/?$") : null,
      reTail: new RegExp("(^|/)" + pathSource(own) + "/?$"),
    });
  }
  model.routes = rows;
  return rows;
}

const methodOk = (a, b) => a === "ANY" || b === "ANY" || a === b;

// A URL (with its method) → the route it reaches. Order: an exact literal full
// path; a full-path pattern; the path's TAIL against every route's own path
// (a suffix URL, or a route whose mount is unknown). One candidate → ROUTE;
// several → AMBIGUOUS with all of them; none → UNRESOLVED.
function resolveUrl(model, u) {
  const method = String(u.method || "ANY").toUpperCase();
  const url = String(u.url || "").split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  const key = `${method} ${url} ${u.suffix ? 1 : 0}`;
  if (model.urlMemo.has(key)) return model.urlMemo.get(key);
  const cands = routeTable(model).filter((r) => methodOk(r.method, method));
  const pick = (list) => {
    const lit = list.filter((r) => r.literal);
    return lit.length ? lit : list;
  };
  let found = [];
  let mount = "known";
  if (!u.suffix) found = pick(cands.filter((r) => r.reFull && r.reFull.test(url)));
  if (!found.length) {
    found = pick(cands.filter((r) => r.reTail.test(url)));
    mount = "unknown";
  }
  let r;
  if (found.length === 1) r = { state: "ROUTE", target: found[0].sym.id, ...(mount === "unknown" ? { mount } : {}) };
  else if (found.length > 1) r = { state: "AMBIGUOUS", candidates: found.map((x) => x.sym.id) };
  else r = { state: "UNRESOLVED" };
  model.urlMemo.set(key, r);
  return r;
}

// Every URL any symbol sends, once per model.
function urlIndex(model) {
  if (model.urlIndex) return model.urlIndex;
  const rows = [];
  for (const [rel, f] of Object.entries(model.byFile)) for (const s of f.symbols || []) for (const u of s.urls || []) rows.push({ rel, sym: s, u });
  model.urlIndex = rows;
  return rows;
}

// Who calls `target`: confident callers, and a count of AMBIGUOUS ones that
// list it among their candidates. A route symbol is also REACHED by URL (W1).
function callersOf(model, target) {
  const confident = [];
  const seen = new Set();
  let maybe = 0;
  // The stored reverse map. EW0 measured this walk at 437 ms for one file card
  // on django/django; the lookup is a property read.
  const cachedRows = model.callersCache && Object.prototype.hasOwnProperty.call(model.callersCache, target.id) ? model.callersCache[target.id] : model.callersCache ? [] : null;
  if (cachedRows) {
    for (const r of cachedRows) {
      const sym = model.symbols.get(r[0]);
      if (!sym) continue;
      const k = `${r[0]}\u0000${r[1]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      confident.push({
        sym,
        line: r[1],
        state: r[2],
        ...(r[3] === 1 ? { ref: true } : {}),
        ...(r[3] === 2 && r[4] ? { url: r[4] } : {}),
        ...(r[3] === 3 ? { inherited: true } : {}),
        ...(r[3] === 0 && r[4] ? { alias: r[4] } : {}),
        ...(r[3] === 4 && r[4] ? { store: r[4] } : {}),
        ...(r[3] === 5 ? { listen: true } : {}),
        ...(r[3] === 6 ? { prop: true } : {}),
        ...(r[3] === 7 && r[4] ? { event: r[4] } : {}),
        ...(r[3] === 8 && r[4] ? { impl: r[4] } : {}),
      });
    }
  }
  if (model.callersCache) {
    stableCallers(confident);
    const m = model.maybeCache;
    if (m && Object.prototype.hasOwnProperty.call(m, target.id)) for (const row of m[target.id]) maybe += row[1];
    return { confident, maybe };
  }
  // W29a: a store member is reached by its KEY, not by its name. Walk the
  // store calls too, so that the answer is the same as the derived cache.
  const rows = callIndex(model).get(target.name) || [];
  let walk = target.store || target.kind === "state" || target.store_module ? rows.concat(storeCalls(model)) : rows;
  // W29b: an event name may hold "." — walk every listen / prop call.
  if (target.kind === "emit" || target.kind === "prop") walk = walk.concat(contractCalls(model));
  // W29c: a symbol that registers a global listener is reached by event name.
  if (eventIndex(model).onSyms.has(target.id)) walk = walk.concat(eventIndex(model).calls.filter((x) => x.call.event === "emit"));
  for (const row of walk) {
    const r = resolveCall(model, row.rel, row.sym, row.call);
    if ((r.targets || [r.target]).includes(target.id) && CONFIDENT.has(r.state)) {
      const k = `${row.sym.id} ${row.call.line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // lorc 0.5.0 (W34c): the same row as the cache gives for an impl target.
      if (r.impl && target.id !== r.target) {
        confident.push({ sym: row.sym, line: row.call.line, state: target.file === row.rel ? "LOCAL" : "IMPORT", impl: r.impl });
        continue;
      }
      confident.push({
        sym: row.sym,
        line: row.call.line,
        state: r.state,
        ...(row.call.store ? { store: row.call.store } : {}),
        ...(row.call.listen ? { listen: true } : {}),
        ...(row.call.prop ? { prop: true } : {}),
        ...(row.call.event ? { event: eventName(model, row.rel, row.call) } : {}),
        ...(!row.call.store && row.call.ref ? { ref: true } : {}),
        ...(!row.call.store && !row.call.ref && r.inherited ? { inherited: true } : {}),
        ...(!row.call.store && !row.call.ref && !r.inherited && row.call.alias ? { alias: row.call.alias } : {}),
      });
    } else if (r.state === "AMBIGUOUS" && r.candidates.includes(target.id)) maybe++;
  }
  if (target.kind === "route") {
    for (const row of urlIndex(model)) {
      const r = resolveUrl(model, row.u);
      if (r.state === "ROUTE" && r.target === target.id) {
        const k = `${row.sym.id} ${row.u.line}`;
        if (seen.has(k)) continue;
        seen.add(k);
        confident.push({ sym: row.sym, line: row.u.line, state: "ROUTE", url: `${row.u.method} ${row.u.url}` });
      } else if (r.state === "AMBIGUOUS" && r.candidates.includes(target.id)) maybe++;
    }
  }
  stableCallers(confident);
  return { confident, maybe };
}

// EW2: the stored reverse map and the on-read walk visit callers in different
// orders. Same rows, and a card that reorders itself depending on whether a
// cache file happens to exist is a card nobody can diff. One total order, both
// ways.
function stableCallers(rows) {
  rows.sort((a, b) => a.sym.file.localeCompare(b.sym.file) || a.line - b.line || String(a.sym.id).localeCompare(String(b.sym.id)));
}

function calleesOf(model, sym) {
  const out = [];
  const seen = new Set();
  const calls = sym.calls || [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({ call: c, res: resolveCall(model, sym.file, sym, c) });
  }
  return out;
}

// ── targets ─────────────────────────────────────────────────────────────────
function findTarget(model, q) {
  const s = norm(q);
  const fl = /^(.+?):(\d+)$/.exec(s);
  if (fl && model.fileSet.has(fl[1])) {
    const line = Number(fl[2]);
    const inside = (model.byFile[fl[1]].symbols || [])
      .filter((x) => x.kind !== "module" && x.lines[0] <= line && line <= x.lines[1])
      .sort((a, b) => a.lines[1] - a.lines[0] - (b.lines[1] - b.lines[0]));
    return inside.length ? { kind: "symbol", sym: inside[0] } : { kind: "file", rel: fl[1] };
  }
  if (model.fileSet.has(s)) return { kind: "file", rel: s };
  if (model.symbols.has(s)) return { kind: "symbol", sym: model.symbols.get(s) };
  const exact = [];
  for (const x of model.symbols.values()) if (x.kind !== "module" && x.qname === s) exact.push(x);
  if (exact.length === 1) return { kind: "symbol", sym: exact[0] };
  // W1: `GET /orders/search` or `/orders/search` — a URL, resolved like one a
  // test would send, so a route is found by its FULL path, mounts included.
  const asUrl = /^(?:([A-Za-z]+) )?(\/\S*)$/.exec(s);
  if (!exact.length && asUrl) {
    const r = resolveUrl(model, { method: asUrl[1] ? asUrl[1].toUpperCase() : "ANY", url: asUrl[2] });
    if (r.state === "ROUTE") return { kind: "symbol", sym: model.symbols.get(r.target) };
    if (r.state === "AMBIGUOUS") return { kind: "ambiguous", candidates: r.candidates.map((id) => model.symbols.get(id)).filter(Boolean) };
  }
  // Same qname, same file: one symbol declared more than once (a Go build tag,
  // a Python redefinition). The widest one is the implementation.
  if (exact.length > 1 && exact.every((x) => x.file === exact[0].file)) {
    return { kind: "symbol", sym: exact.slice().sort((a, b) => b.lines[1] - b.lines[0] - (a.lines[1] - a.lines[0]))[0] };
  }
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };
  const named = model.byName.get(s) || [];
  if (named.length === 1) return { kind: "symbol", sym: named[0] };
  if (named.length > 1) return { kind: "ambiguous", candidates: named };
  // v2.2.0 (T6): lanes type SHORT file names — `OutwardRemittance.vue`, or a
  // path suffix. The ONE indexed file whose path ends with `/<it>` is the
  // target; several is an answer that lists them.
  if (/\.[A-Za-z0-9]+$/.test(s) || s.includes("/")) {
    const suf = bySuffix(model, s);
    if (suf.length === 1) return { kind: "file", rel: suf[0] };
    if (suf.length > 1) return { kind: "ambiguous-file", files: suf.slice().sort() };
  }
  const ql = s.toLowerCase();
  const nearest = [];
  for (const [n, arr] of model.byName) if (n.toLowerCase().includes(ql)) nearest.push(...arr);
  return { kind: "none", nearest: nearest.slice(0, 5) };
}

const where = (sym, line) => `${sym.file}:${line || sym.lines[0]}`;
const brief = (sym) => ({ id: sym.id, qname: sym.qname, kind: sym.kind, file: sym.file, lines: sym.lines });

function blobState(model, rel) {
  if (model.blobStates.has(rel)) return model.blobStates.get(rel);
  let state;
  if (!fs.existsSync(path.join(model.root, ...rel.split("/")))) state = "deleted";
  else {
    const r = spawnSync("git", ["hash-object", "--", rel], { cwd: model.root, encoding: "utf8" });
    state = r.status !== 0 ? "unknown" : r.stdout.trim() === (model.byFile[rel] || {}).blob ? "current" : "changed";
  }
  model.blobStates.set(rel, state);
  return state;
}

// S3 (v1.8.2 W2): one `git hash-object --stdin-paths` for every file the
// cards of this read will name. `ctx` on five targets spawned git five times,
// and a Windows process start is ~30 ms each.
function warmBlobs(model, queries) {
  const rels = new Set();
  for (const q of queries || []) {
    const t = findTarget(model, q);
    if (t.kind === "symbol") rels.add(t.sym.file);
    else if (t.kind === "file") rels.add(t.rel);
  }
  warmFiles(model, rels);
}

// The same batch, for files the caller already knows by path (R1: the caller
// files a `--callers-source` card reads).
function warmFiles(model, rels) {
  const onDisk = [...rels].filter((rel) => !model.blobStates.has(rel) && fs.existsSync(path.join(model.root, ...rel.split("/"))));
  for (const rel of rels) if (!fs.existsSync(path.join(model.root, ...rel.split("/")))) model.blobStates.set(rel, "deleted");
  if (!onDisk.length) return;
  const h = spawnSync("git", ["hash-object", "--stdin-paths"], { cwd: model.root, encoding: "utf8", input: onDisk.join("\n") + "\n" });
  if (h.status !== 0) return;
  const out = h.stdout.split(/\r?\n/).filter(Boolean);
  onDisk.forEach((rel, i) => {
    if (out[i]) model.blobStates.set(rel, out[i] === (model.byFile[rel] || {}).blob ? "current" : "changed");
  });
}

// EW1: what the extractor saw of this file, for the card header. A card that
// hides a gap is worse than no card — the reader takes silence for absence.
function coverageTag(model, rel) {
  const f = model.byFile[rel] || {};
  if (f.skipped) return ` · coverage skipped:${f.skipped}`;
  if (f.coverage !== "partial") return "";
  const r = (f.partial || []).map((g) => `${g[0]}-${g[1]}`).join(",");
  return ` · coverage partial ${r}`;
}

const BLOB_LABEL = {
  current: "current",
  changed: "CHANGED since index — hints only (run: orc graph update)",
  deleted: "DELETED since index (run: orc graph update)",
  unknown: "freshness unknown",
};

// Pick lines by priority until the budget is spent, then print them in display
// order. The footer always says what the card hid.
//
// v1.8.2 W3 — TWO changes, both about the tokens the card itself adds:
//   · the footer is printed ONLY when something was hidden, a call was
//     unresolved, or `--source` was cut. A card that hid nothing used to spend
//     a whole line saying so, on every card, on every later turn of the agent
//     that received it. `budget` stays in the JSON either way.
//   · `tail` is the `--source` block (D1). It is charged against the SAME
//     budget and it goes LAST, so the rows always win: source takes what the
//     card left, line by line, and the footer says how many lines it cut.
function fit(items, budget, footer, tail, blocks) {
  // The reserve is the LONGEST footer this card could print — one hidden
  // count per section present — so the final `used` can never pass the
  // budget, whatever ends up hidden. (W2: a card with five sections overran a
  // 100-token budget by five tokens on the footer alone.)
  const worst = {};
  for (const it of items) if (it.pri > 0) worst[it.section] = 99;
  const worstBlocks = blocks && blocks.length ? { shown: 0, want: blocks.length } : null;
  const reserve = tok(footer(0, worst, tail ? { kept: 0, want: tail.want, cut: tail.want } : null, worstBlocks)) + 2;
  let used = 0;
  const keep = new Set();
  const hidden = {};
  const order = items.map((it, i) => i).sort((a, b) => items[a].pri - items[b].pri || a - b);
  for (const i of order) {
    const t = tok(items[i].text) + 1;
    if (items[i].pri === 0 || used + t + reserve <= budget) {
      keep.add(i);
      used += t;
    } else hidden[items[i].section] = (hidden[items[i].section] || 0) + 1;
  }
  const lines = items.filter((_, i) => keep.has(i)).map((it) => it.text);
  let source = null;
  if (tail) {
    const open = "  ```" + (tail.fence || "");
    const close = "  ```";
    let left = budget - used - reserve - tok(tail.head) - tok(open) - tok(close) - 3;
    const body = [];
    for (const ln of tail.lines) {
      const t = tok(ln) + 1;
      if (t > left) break;
      left -= t;
      body.push(ln);
    }
    if (body.length) {
      const block = [tail.head, open, ...body, close];
      used += block.reduce((a, l) => a + tok(l) + 1, 0);
      lines.push(...block);
    }
    source = { kept: body.length, want: tail.want, cut: tail.want - body.length };
  }
  // R1 (v1.9.1): the callers' own lines. They go AFTER the target's source, and
  // each block is kept WHOLE or not at all — six lines cut to four is a call
  // site with its arguments missing, which is worse than no call site.
  let callersShown = null;
  if (blocks && blocks.length) {
    const headOf = (n) => `  callers source  ${n < blocks.length ? `${n} of ${blocks.length}` : n} shown (${CALLERS_SOURCE_LINES} lines each${n < blocks.length ? "; raise --budget" : ""})`;
    let left = budget - used - reserve - tok(headOf(0)) - 1;
    const out = [];
    for (const b of blocks) {
      const open = "  ```" + (b.fence || "");
      const block = [b.head, open, ...b.lines, "  ```"];
      const t = block.reduce((a, l) => a + tok(l) + 1, 0);
      if (t > left) break;
      left -= t;
      out.push({ b, block });
    }
    if (out.length) {
      const all = [headOf(out.length), ...out.flatMap((x) => x.block)];
      used += all.reduce((a, l) => a + tok(l) + 1, 0);
      lines.push(...all);
    }
    callersShown = { shown: out.length, want: blocks.length, kept: out.map((x) => x.b) };
  }
  const foot = footer(used, hidden, source, callersShown);
  if (foot) lines.push(foot);
  return { card: lines.join("\n"), kept: keep, hidden, source, callers: callersShown, used: used + tok(foot) };
}

// ── E6: the tree format ─────────────────────────────────────────────────────
// The prose card repeats a label on every row — `function`, `:12-40`,
// `exported`, `fan-in 3`, `(via X)`. A card is sent again on every later turn of
// the agent that received it, so a word repeated on forty rows is paid forty
// times, forty turns over. The tree format names each column ONCE in a header
// and then prints only values.
//
// It is a FORMAT, never a filter: the same rows, the same order, the same JSON.
// `--format prose` stays the default, because a shorter card that is read wrong
// costs more than it saves.
const KIND_SHORT = { prop: "p", emit: "e", inject: "i", template: "t", function: "fn", method: "me", class: "cl", route: "rt", module: "mo", const: "co", var: "va", type: "ty", interface: "in", enum: "en", struct: "st" };
const shortKind = (k) => KIND_SHORT[k] || String(k).slice(0, 2);

// The longest directory every path shares. A prefix line is only worth writing
// when it saves REAL bytes — CBM's rule, and the reason is that a header nobody
// needs is a header everybody still reads.
function dirPrefix(paths) {
  if (paths.length < 2) return "";
  const parts = paths.map((p) => p.split("/").slice(0, -1));
  let n = 0;
  outer: for (; n < parts[0].length; n++) {
    for (const q of parts) if (q[n] !== parts[0][n]) break outer;
  }
  if (!n) return "";
  const pre = parts[0].slice(0, n).join("/") + "/";
  const saved = pre.length * paths.length - (pre.length + 6); // "  dir " + the prefix
  const total = paths.reduce((a, p) => a + p.length, 0);
  return saved >= 64 && saved >= total * 0.15 ? pre : "";
}

function hiddenText(hidden) {
  const parts = Object.entries(hidden).map(([k, v]) => `${v} ${k}`);
  return parts.length ? ` · hidden: ${parts.join(", ")} (raise --budget)` : "";
}

// ── D1 (v1.8.2 W3): the card and the range in ONE call ──────────────────────
// A card is a LOCATOR: it names a range and the agent then reads it. That is
// two round trips for one question, and the second one is a `Read` the CLI
// could have answered. `--source` prints the range the card just named.
//
// It does NOT change the read ladder. A file you are about to EDIT is still
// read in full with `Read` first (exception 1) — an `old_string` rebuilt from
// a CLI print is the same corruption bug as one rebuilt from an outline.
// `--source` is for the CALLER'S range, the callee's, the neighbour you will
// not touch. The hook never prints source; this is a CLI answer to a CLI call.
const SOURCE_DEFAULT = 80;
const SOURCE_CAP = 200;
const FILE_HEAD_LINES = 40;
const FENCE_BY_EXT = {
  ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js", ".cjs": "js", ".mts": "ts", ".cts": "ts",
  ".py": "python", ".go": "go", ".rb": "ruby", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".cs": "csharp",
  ".php": "php", ".sh": "bash", ".sql": "sql", ".json": "json", ".yml": "yaml", ".yaml": "yaml", ".md": "md",
};

function sourceLimit(want) {
  const n = Number(want);
  if (!Number.isFinite(n) || n <= 0) return SOURCE_DEFAULT;
  return Math.min(SOURCE_CAP, Math.floor(n));
}

// The lines are read from the CURRENT bytes on disk, and the range comes from
// the index. When the two disagree the card header already says CHANGED, and
// the source head repeats it — a range that has moved is a wrong answer given
// confidently, which is the one thing this whole feature must never do.
function sourceTail(model, rel, from, to, want, fresh) {
  if (fresh === "deleted") return null;
  let text;
  try {
    text = fs.readFileSync(path.join(model.root, ...rel.split("/")), "utf8");
  } catch (_) {
    return null;
  }
  const all = text.split(/\r?\n/);
  const start = Math.max(1, Number(from) || 1);
  const end = Math.max(start, Math.min(all.length, Number(to) || all.length));
  const limit = sourceLimit(want);
  const stop = Math.min(end, start + limit - 1);
  const width = String(stop).length;
  const lines = [];
  for (let i = start; i <= stop; i++) lines.push(`  ${String(i).padStart(width)}  ${all[i - 1] === undefined ? "" : all[i - 1]}`);
  if (!lines.length) return null;
  const moved = fresh !== "current" ? "  — CHANGED since index, the range may have moved" : "";
  return {
    head: `  source  ${rel}:${start}-${stop}${moved}`,
    fence: FENCE_BY_EXT[posix.extname(rel)] || "",
    want: end - start + 1,
    lines,
    file: rel,
    from: start,
    to: stop,
  };
}

function sourceText(tail, kept) {
  return tail.lines.slice(0, kept).join("\n");
}

// ── R1 (v1.9.1): the call sites WITH the card ───────────────────────────────
// A recon agent asked "who calls this" and then opened every caller file to
// see HOW it was called. Six lines around each call site answer that in the
// same call. The limits, and the reason for each:
//   · CONFIDENT callers only. Source printed for an AMBIGUOUS guess reads as a
//     fact, and that is the false sentence the R3-C eval found.
//   · never the target's OWN file. The agent that asks is about to edit that
//     file, and a file you edit is read in full with `Read` first (the read
//     ladder's exception 1) — a CLI print of it would be read twice.
//   · ≤ 5 callers, 6 lines each, charged to the SAME budget, after everything
//     else. The rows always win.
const CALLERS_SOURCE_MAX = 5;
const CALLERS_SOURCE_LINES = 6;

function fileLines(model, rel) {
  model.textCache = model.textCache || new Map();
  if (model.textCache.has(rel)) return model.textCache.get(rel);
  let all = null;
  try {
    const text = fs.readFileSync(path.join(model.root, ...rel.split("/")), "utf8");
    all = text.split(/\r?\n/);
    if (all.length > 1 && all[all.length - 1] === "") all.pop();
  } catch (_) {
    all = null;
  }
  model.textCache.set(rel, all);
  return all;
}

function callerBlocks(model, sym, confident) {
  const others = confident.filter((c) => c.sym.file !== sym.file);
  // One git call for the files the blocks will most likely come from. A caller
  // past this slice (many call sites in one window) is still checked, one by one.
  warmFiles(model, new Set(others.slice(0, CALLERS_SOURCE_MAX * 4).map((c) => c.sym.file)));
  const out = [];
  for (const c of others) {
    if (out.length >= CALLERS_SOURCE_MAX) break;
    const rel = c.sym.file;
    // Two call sites a line apart are ONE window. Printing it twice is the
    // same six lines paid twice.
    if (out.some((b) => b.file === rel && b.from <= c.line && c.line <= b.to)) continue;
    const fresh = blobState(model, rel);
    if (fresh === "deleted") continue;
    const all = fileLines(model, rel);
    if (!all || !all.length) continue;
    const at = Math.max(1, Math.min(all.length, Number(c.line) || 1));
    // Two lines above, three below — shifted, not shortened, at either end of
    // the file, so every block is six lines when the file has six.
    const from = Math.max(1, Math.min(at - 2, all.length - CALLERS_SOURCE_LINES + 1));
    const to = Math.min(all.length, from + CALLERS_SOURCE_LINES - 1);
    const width = String(to).length;
    const lines = [];
    for (let i = from; i <= to; i++) lines.push(`  ${String(i).padStart(width)}  ${all[i - 1]}`);
    const caller = c.url || c.sym.qname;
    const changed = fresh !== "current";
    out.push({
      head: `  ${rel}:${from}-${to}  ← ${caller}${changed ? "  — CHANGED since index, the range may have moved" : ""}`,
      fence: FENCE_BY_EXT[posix.extname(rel)] || "",
      lines,
      file: rel,
      from,
      to,
      caller,
      changed,
    });
  }
  return out;
}

function callersSourceNote(cs) {
  if (!cs || cs.shown >= cs.want) return "";
  return cs.shown ? ` · callers source ${cs.want - cs.shown} cut (raise --budget)` : ` · callers source not shown (${cs.want} callers, raise --budget)`;
}

// ── R4 (v1.9.1): where a language server should be asked ───────────────────
// The LSP tool takes a file, a line and a 1-based character. The card knows the
// line; the character is where the NAME sits on it, read from the bytes on disk.
// `null` whenever that cannot be stated exactly — a guessed column sends the
// language server to the wrong token, and its answer is then confidently wrong.
function lspAt(model, sym, fresh) {
  if (fresh !== "current" || !sym || !sym.name) return null;
  const all = fileLines(model, sym.file);
  const line = sym.lines && sym.lines[0];
  if (!all || !line || line > all.length) return null;
  const text = all[line - 1];
  const esc = String(sym.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(^|[^A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`).exec(text);
  if (!m) return null;
  return { file: sym.file, line, character: m.index + m[1].length + 1 };
}

function sourceNote(source) {
  if (!source) return "";
  if (!source.kept) return ` · source not shown (${source.want} lines, raise --budget)`;
  return source.cut ? ` · source ${source.kept} lines · ${source.cut} cut (raise --budget)` : "";
}

// ── §6 (v1.8.2 W3): the state word, once ────────────────────────────────────
// `LOCAL` / `IMPORT` / `UNIQUE` is spelled on every row of every card, and a
// card is sent again on each later turn of the agent that received it. The
// one-letter form plus ONE legend line says the same thing — but only when the
// card has enough rows to pay for the legend. So both bodies are built and the
// SMALLER one is printed, the same rule `--format tree` already follows, and
// the answer says which one it used. It can never be worse than the long form.
const STATE_LEGEND = "  states: L local · I import · U unique · R route · S store · E event · A ambiguous";

// lorc 0.5.0 (W30a): the text after an effect row. An env key gets its line in
// an env file. An effect with tables gets the definition of each table (max 3).
// KEYS ONLY: no env value is read or shown.
function effectLinks(model, e) {
  const out = { text: "", data: {} };
  if (!e) return out;
  if (e.type === "env" && typeof e.text === "string") {
    const r = resolveConfig(model, e.text);
    if (r.state === "CONFIG") {
      out.text += ` → ${r.file}:${r.line}`;
      out.data.config = { file: r.file, line: r.line };
    } else if (r.missing_config) {
      out.text += "  NO KEY in env files";
      out.data.missing_config = r.missing_config;
    }
  }
  if (Array.isArray(e.tables) && e.tables.length) {
    if (e.def) out.text += " · defines";
    const rows = e.tables.slice(0, 3).map((t) => {
      const r = resolveTable(model, t);
      const ent = r.entity ? model.symbols.get(r.entity) : null;
      return { table: t, ...(r.file ? { file: r.file, line: r.line } : {}), ...(ent ? { entity: ent.qname } : {}) };
    });
    out.text += ` · tables: ${rows.map((x) => `${x.table}${x.file ? ` → ${x.file}:${x.line}` : ""}${x.entity ? ` | ${x.entity}` : ""}`).join(", ")}`;
    out.data.table_links = rows;
  }
  return out;
}

// lorc 0.5.0 (W30a): the row of a link call (store, listen, prop, i18n, event)
// at level 1. Returns null when the call is not a link call that has a row.
// Returns {skip:true} when the row is not shown (i18n over the limit).
const I18N_ROWS = 6;
function linkRow(model, s, call, res, indent, seen) {
  const name = String(call.name || "");
  const tail = name.slice(name.indexOf(".") + 1);
  if (call.store) {
    const k = call.via ? constValue(model, s.file, call.name) : call.name;
    const key = k == null ? call.name : k;
    const data = { item: "store", role: call.store, key, line: call.line, state: res.state };
    const t = res.state === "STORE" ? model.symbols.get(res.target) : null;
    if (t) {
      const row = (short) => `${indent}→ ${call.store} ${key}  ${t.qname}  ${where(t)}  ${stateWord(res.state, short)}`;
      return { text: row(false), short: row(true), data: { ...data, target: brief(t) } };
    }
    if (res.missing_store) {
      const row = `${indent}→ ${call.store} ${key}  NO STORE KEY — no module defines it`;
      return { text: row, short: row, data: { ...data, missing_store: res.missing_store } };
    }
    return null;
  }
  if (call.listen || call.prop) {
    const t = res.state === "IMPORT" ? model.symbols.get(res.target) : null;
    if (!t) return null;
    const verb = call.listen ? "listens" : "passes";
    const row = (short) => `${indent}→ ${verb} ${tail}  ${t.qname}  ${where(t)}  ${stateWord(res.state, short)}`;
    return { text: row(false), short: row(true), data: { item: call.listen ? "listen" : "prop", name: tail, line: call.line, state: res.state, target: brief(t) } };
  }
  if (call.i18n) {
    const k = call.via ? constValue(model, s.file, call.name) : call.name;
    const key = k == null ? call.name : k;
    if (res.state === "I18N") {
      seen.i18n++;
      if (seen.i18n > I18N_ROWS) return { skip: true };
      const row = (short) => `${indent}→ text ${key}  ${res.file}:${res.line}  ${stateWord("I18N", short)}`;
      return { text: row(false), short: row(true), data: { item: "i18n", key, line: call.line, state: "I18N", file: res.file, def_line: res.line } };
    }
    if (res.missing_i18n) {
      seen.i18nMissing++;
      if (seen.i18nMissing > I18N_ROWS) return { skip: true };
      const row = `${indent}→ text ${key}  NO KEY — no locale file has it`;
      return { text: row, short: row, data: { item: "i18n", key, line: call.line, state: "UNRESOLVED", missing_i18n: res.missing_i18n } };
    }
    return null;
  }
  if (call.event === "emit" || call.event === "on") {
    const ev = eventName(model, s.file, call);
    if (ev == null) return null;
    if (call.event === "on") {
      const row = `${indent}→ listens to ${ev}  ${res.emitters || 0} emitter(s)`;
      return { text: row, short: row, data: { item: "event", kind: "on", name: ev, line: call.line, state: res.state, emitters: res.emitters || 0 } };
    }
    if (res.state === "EVENT") {
      const ts = (res.targets || [res.target]).map((id) => model.symbols.get(id)).filter(Boolean);
      if (!ts.length) return null;
      const row = (short) => `${indent}→ emits ${ev}  ${ts.length} listener(s): ${ts[0].qname} ${where(ts[0])}  ${stateWord("EVENT", short)}`;
      return { text: row(false), short: row(true), data: { item: "event", kind: "emit", name: ev, line: call.line, state: "EVENT", targets: ts.map(brief) } };
    }
    if (res.missing_event) {
      const row = `${indent}→ emits ${ev}  NO LISTENER — no on() site has it`;
      return { text: row, short: row, data: { item: "event", kind: "emit", name: ev, line: call.line, state: "UNRESOLVED", missing_event: res.missing_event } };
    }
    return null;
  }
  return null;
}

// lorc 0.5.0 (W30a): the `links` rows of a file card. Each row is one line of
// 160 chars or less. An empty row is not shown.
const LINK_ROW_MAX = 160;
function linkList(head, parts, sep) {
  const uniq = [...new Set(parts)];
  const join = sep || ", ";
  let text = head;
  let n = 0;
  for (const p of uniq) {
    const more = uniq.length - n - 1;
    const next = `${text}${n ? join : ""}${p}`;
    if (n && (next + (more ? ` (+${more})` : "")).length > LINK_ROW_MAX) break;
    text = next;
    n++;
  }
  if (n < uniq.length) text += ` (+${uniq.length - n})`;
  return text.length > LINK_ROW_MAX ? `${text.slice(0, LINK_ROW_MAX - 1)}…` : text;
}

function linkRows(model, L) {
  const rows = [];
  const at = (f, l) => (l ? `${f}:${l}` : f);
  if (L.store.length) {
    const parts = L.store.map((x) => {
      const t = x.target ? model.symbols.get(x.target) : null;
      return t ? `${x.role} ${x.key} → ${where(t)}` : `${x.role} ${x.key} (missing)`;
    });
    rows.push(linkList("  links  store: ", parts));
  }
  if (L.emits.length) rows.push(linkList("  links  emits: ", L.emits.map((e) => `${e.name} ${e.line} (${e.listeners.length} listeners)`)));
  if (L.parents.length) rows.push(linkList("  links  parents: ", L.parents.map((p) => at(p.file, p.line))));
  if (L.i18n.count) {
    const files = L.i18n.files.length ? ` → ${L.i18n.files.join(", ")}` : "";
    const miss = L.i18n.missing.length ? ` · missing: ${L.i18n.missing.join(", ")}` : "";
    rows.push(linkList(`  links  i18n: ${L.i18n.count} keys${files}${miss}`, []));
  }
  if (L.events.length) {
    const parts = L.events.map((e) => (e.kind === "emit" ? `emits ${e.name} (${e.peers} listeners)` : `listens ${e.name} (${e.peers} emitters)`));
    rows.push(linkList("  links  events: ", parts, " · "));
  }
  if (L.config.length) rows.push(linkList("  links  config: ", L.config.map((c) => (c.file ? `${c.key} → ${c.file}:${c.defLine}` : `${c.key} (no def)`))));
  if (L.tables.length) {
    const parts = L.tables.map((t) => {
      const ent = t.entity ? model.symbols.get(t.entity) : null;
      return `${t.table}${t.file ? ` → ${t.file}:${t.defLine}` : ""}${ent ? ` | ${ent.qname}` : ""}`;
    });
    rows.push(linkList("  links  tables: ", parts));
  }
  if (L.fields.length) rows.push(linkList("  links  fields: ", L.fields));
  return rows.slice(0, 8);
}
const stateWord = (s, short) => (short ? STATE_SHORT[s] || s : s);

// Rewrites `items` in place to the short body and inserts the legend, but only
// when the short body PLUS the legend is smaller than the long one. Returns
// which body was chosen.
function pickShort(items) {
  let long = 0;
  let short = STATE_LEGEND.length;
  for (const it of items) {
    long += it.text.length;
    short += it.short.length;
  }
  if (short >= long) return false;
  for (const it of items) it.text = it.short;
  items.splice(1, 0, { pri: 0, section: "header", text: STATE_LEGEND, short: STATE_LEGEND, data: null });
  return true;
}

// ── ctx ─────────────────────────────────────────────────────────────────────
function ctx(model, query, opts) {
  const depth = Math.max(1, Math.min(4, Number(opts.depth) || 2));
  const budget = Math.max(100, Math.min(8000, Number(opts.budget) || 1200));
  const t = findTarget(model, query);
  if (t.kind === "none") return { ok: false, state: "not-found", query, nearest: t.nearest.map(brief), exit: 4 };
  if (t.kind === "ambiguous") return { ok: false, state: "ambiguous-target", query, candidates: t.candidates.map(brief), exit: 4 };
  if (t.kind === "ambiguous-file") return { ok: false, state: "ambiguous-target", query, candidates: t.files.map((file) => ({ file })), exit: 4 };
  if (t.kind === "file") return fileCard(model, t.rel, budget, opts);

  const sym = t.sym;
  const fresh = blobState(model, sym.file);
  const items = [];
  // `short` is the same row with the one-letter state word. Both bodies are
  // built; the smaller one is printed (§6).
  const push = (pri, section, text, data, short) => items.push({ pri, section, text, short: short == null ? text : short, data });
  const storeTag = sym.store ? ` [store ${sym.store} ${sym.key || (sym.key_via ? constValue(model, sym.file, sym.key_via) || sym.key_via : sym.name)}]` : "";
  push(0, "header", `${sym.qname}  ${sym.file}:${sym.lines[0]}-${sym.lines[1]}  [blob ${String((model.byFile[sym.file] || {}).blob || "").slice(0, 7)} · ${BLOB_LABEL[fresh]}${coverageTag(model, sym.file)}]${storeTag}`);
  // A note is shown ONLY while the body still hashes the same. An old
  // sentence about code that has since changed is never printed.
  const note = N.noteFor(model.notes, sym);
  if (note)
    push(
      1,
      "note",
      note.current ? `  ${note.source === "doc" ? "doc " : "note"}  ${note.text}  (${note.model} · current)` : "  note: stale (body changed) — it is re-noted at the next batch",
      { item: "note", ...note }
    );

  const callers = callersOf(model, sym);
  callers.confident.sort((a, b) => (a.sym.file + a.line).localeCompare(b.sym.file + b.line));
  for (const c of callers.confident) {
    const row = (short) =>
      c.url
        ? `  ← reached via  ${c.url}  ${where(c.sym, c.line)}  ${stateWord("ROUTE", short)}`
        : c.store
        ? `  ← ${c.store} by  ${c.sym.qname}  ${where(c.sym, c.line)}  ${stateWord(c.state, short)}`
        : c.listen
        ? `  ← listened by  ${c.sym.qname}  ${where(c.sym, c.line)}  ${stateWord(c.state, short)}`
        : c.prop
        ? `  ← passed by  ${c.sym.qname}  ${where(c.sym, c.line)}  ${stateWord(c.state, short)}`
        : c.event
        ? `  ← emitted by  ${c.sym.qname}  ${where(c.sym, c.line)}  ${stateWord(c.state, short)}  (${c.event})`
        : `  ← ${c.ref ? "used by  " : "called by"}  ${c.sym.qname}  ${where(c.sym, c.line)}  ${stateWord(c.state, short)}${c.impl ? ` (impl of ${c.impl})` : c.inherited ? " (inherited)" : c.alias ? ` (via ${c.alias})` : ""}`;
    push(
      2,
      "callers",
      row(false),
      {
        item: "caller",
        id: c.sym.id,
        qname: c.sym.qname,
        file: c.sym.file,
        line: c.line,
        state: c.state,
        ...(c.ref ? { ref: true } : {}),
        ...(c.url ? { url: c.url } : {}),
        ...(c.inherited ? { inherited: true } : {}),
        ...(c.alias ? { alias: c.alias } : {}),
        ...(c.store ? { store: c.store } : {}),
        ...(c.listen ? { listen: true } : {}),
        ...(c.prop ? { prop: true } : {}),
        ...(c.event ? { event: c.event } : {}),
        ...(c.impl ? { impl: c.impl } : {}),
      },
      row(true)
    );
  }
  if (callers.maybe) push(4, "callers", `  ← maybe      ${callers.maybe} more caller(s) name it among AMBIGUOUS candidates`, { item: "maybe_callers", n: callers.maybe });

  let unresolved = 0;
  const visited = new Set([sym.id]);
  const linkSeen = { i18n: 0, i18nMissing: 0 };
  const walk = (s, level, indent) => {
    for (const { call, res } of calleesOf(model, s)) {
      // lorc 0.5.0 (W30a): a link call at level 1 gets its own row.
      if (level === 1 && (call.store || call.listen || call.prop || call.i18n || call.event)) {
        const lr = linkRow(model, s, call, res, indent, linkSeen);
        if (lr && lr.skip) continue;
        if (lr) {
          push(2, "calls", lr.text, { ...lr.data, level }, lr.short);
          continue;
        }
      }
      if (res.state === "UNRESOLVED") {
        // v2.2.0: a route call whose name no route record carries is SAID,
        // one line, no guess — it is shown, so it is not counted as hidden.
        if (level === 1 && call.route && res.missing_route) {
          const miss = `${indent}→ route ${res.missing_route}  NO ROUTE — no record has this name`;
          push(2, "calls", miss, { item: "call", name: call.name, line: call.line, state: "UNRESOLVED", missing_route: res.missing_route, level }, miss);
          continue;
        }
        if (level === 1) unresolved++;
        continue;
      }
      if (res.state === "AMBIGUOUS") {
        if (level > 1) continue;
        const cs = res.candidates.map((id) => model.symbols.get(id)).filter(Boolean);
        const shown = cs.slice(0, 3).map((x) => where(x)).join(", ");
        const amb = (short) => `${indent}→ calls      ${call.name}  ${stateWord("AMBIGUOUS", short)} (${cs.length}): ${shown}${cs.length > 3 ? `, +${cs.length - 3}` : ""}`;
        push(4, "calls", amb(false), { item: "call", name: call.name, line: call.line, state: "AMBIGUOUS", candidates: cs.map((x) => x.id) }, amb(true));
        continue;
      }
      const target = model.symbols.get(res.target);
      if (!target) continue;
      const mark = res.inherited ? " (inherited)" : call.alias ? ` (via ${call.alias})` : "";
      const row = (short) =>
        call.route && res.state === "ROUTE"
          ? `${indent}→ route ${call.name}  ${target.qname}  ${where(target)}  ${stateWord(res.state, short)}`
          : `${indent}→ ${call.ref ? "uses " : "calls"}      ${target.qname}  ${where(target)}  ${stateWord(res.state, short)}${mark}`;
      push(level === 1 ? 2 : 3 + level, "calls", row(false), {
        item: "call",
        name: call.name,
        line: call.line,
        state: res.state,
        target: brief(target),
        level,
        ...(call.ref ? { ref: true } : {}),
        ...(res.inherited ? { inherited: true } : {}),
        ...(call.alias ? { alias: call.alias } : {}),
      }, row(true));
      // lorc 0.5.0 (W34c): one row per class that implements the target (max
      // 3). With exactly one impl, the walk goes into the impl body.
      let next = target;
      if (res.impl && res.targets) {
        const impls = res.targets.filter((id) => id !== target.id).map((id) => model.symbols.get(id)).filter(Boolean);
        for (const m of impls.slice(0, 3)) push(level === 1 ? 2 : 3 + level, "calls", `${indent}  ⇒ impl  ${m.qname}  ${where(m)}`, { item: "impl", of: target.id, target: brief(m) });
        if (impls.length > 3) push(level === 1 ? 2 : 3 + level, "calls", `${indent}  ⇒ impl  +${impls.length - 3} more`, { item: "impl", of: target.id, more: impls.length - 3 });
        if (impls.length === 1) next = impls[0];
      }
      if (level < depth && !visited.has(next.id)) {
        visited.add(next.id);
        const cn = N.noteFor(model.notes, next);
        if (cn && cn.current) push(2 + level, "notes", `${indent}    └ ${cn.source === "doc" ? "doc" : "note"} ${cn.text}`, { item: "callee_note", of: next.id, text: cn.text, source: cn.source });
        for (const e of next.effects || []) {
          const el = effectLinks(model, e);
          push(2 + level, "effects", `${indent}    └ effect ${e.type}  "${e.text}"  ${next.file}:${e.line}${el.text}`, { item: "effect", of: next.id, ...e, ...el.data });
        }
        walk(next, level + 1, indent + "    ");
      }
    }
  };
  walk(sym, 1, "  ");
  if (linkSeen.i18n > I18N_ROWS) push(3, "calls", `  → text +${linkSeen.i18n - I18N_ROWS} more keys`, { item: "i18n", more: linkSeen.i18n - I18N_ROWS });
  for (const e of sym.effects || []) {
    const el = effectLinks(model, e);
    push(1, "effects", `  effect ${e.type}  "${e.text}"  ${sym.file}:${e.line}${el.text}`, { item: "effect", of: sym.id, ...e, ...el.data });
  }

  const wiki = opts.wikiDocsFor ? opts.wikiDocsFor([sym.file]) : [];
  if (wiki.length) push(6, "wiki", `  wiki  ${wiki.join(", ")}`, { item: "wiki", docs: wiki });
  const tests = [...new Set(callers.confident.filter((c) => TEST_FILE.test(c.sym.file)).map((c) => c.sym.file))];
  if (tests.length) push(5, "tests", `  tests ${tests.join(", ")}`, { item: "tests", files: tests });
  // R11 (v2.2.0): a target no test calls DIRECTLY is often reached by a spec
  // THROUGH one of its callers. One hop, confident callers only, test files
  // only, max 6 — so the reader does not grep for the tests.
  const testsVia = [];
  const plainCallers = callers.confident.filter((c) => !TEST_FILE.test(c.sym.file));
  if (!tests.length && plainCallers.length) {
    // R11b: the SAME three rules the file card uses for its tests — a test
    // that CALLS a symbol of the caller's file, IMPORTS that file, or is
    // NAMED after it. Ranked call > import > name. Only TEST files are asked
    // who they import, so the fast model loads test blobs and nothing else.
    const SIG = require("./graph-signals.js");
    const seenVia = new Set();
    const add = (file, via) => {
      if (testsVia.length >= 6 || seenVia.has(file) || !TEST_FILE.test(file)) return;
      seenVia.add(file);
      testsVia.push({ file, via });
    };
    const callerFiles = [...new Set(plainCallers.map((c) => c.sym.file))];
    for (const c of plainCallers) for (const cc of callersOf(model, c.sym).confident) add(cc.sym.file, c.sym.qname);
    for (const rel of callerFiles)
      for (const s of ((model.byFile[rel] || {}).symbols || []).filter((x) => x.kind !== "module"))
        for (const cc of callersOf(model, s).confident) add(cc.sym.file, s.qname);
    for (const rel of callerFiles) for (const f of importersOf(model, rel, true).sort()) add(f, rel);
    for (const rel of callerFiles) for (const f of SIG.testsByName(model, rel)) add(f, rel);
    if (testsVia.length) push(5, "tests", `  tests (via callers) ${testsVia.map((x) => `${x.file} ← ${x.via}`).join(", ")}`, { item: "tests_via", rows: testsVia });
    for (const x of testsVia) if (!tests.includes(x.file)) tests.push(x.file);
  }
  // R11: the parse-coverage verdict of the target file + every caller file —
  // the same per-path reading `orc graph coverage` prints (G.coverageOf).
  const covFiles = [...new Set([sym.file, ...callers.confident.map((c) => c.sym.file)])];
  const covPartial = covFiles.filter((rel) => G.coverageOf(model.byFile[rel]).coverage !== "full");
  const coverage = { verdict: covPartial.length ? "partial" : "full", files: covFiles.length, gaps: covPartial };
  push(5, "coverage", `  coverage ${coverage.verdict} · ${covFiles.length} files${covPartial.length ? ` · ${covPartial.join(", ")}` : ""}`, { item: "coverage" });

  const short = pickShort(items);
  // The footer is printed ONLY when the card hid something, dropped an
  // unresolved call, or cut the source block (§6).
  const footer = (used, hidden, source, cs) => {
    const why = `${unresolved ? ` · ${unresolved} unresolved call(s) not shown` : ""}${hiddenText(hidden)}${sourceNote(source)}${callersSourceNote(cs)}`;
    return why ? `  budget ${used}/${budget} tokens${why}` : "";
  };
  const tail = opts.source === undefined ? null : sourceTail(model, sym.file, sym.lines[0], sym.lines[1], opts.source, fresh);
  const blocks = opts.callersSource ? callerBlocks(model, sym, callers.confident) : null;
  const f = fit(items, budget, footer, tail, blocks);
  const kept = items.filter((_, i) => f.kept.has(i)).map((it) => it.data).filter(Boolean);
  const callersSource = blocks
    ? {
        callers_source: (f.callers ? f.callers.kept : []).map((b) => ({ file: b.file, from: b.from, to: b.to, caller: b.caller, text: b.lines.join("\n"), changed: b.changed })),
        counts: { callers_source_cut: f.callers ? f.callers.want - f.callers.shown : 0 },
      }
    : {};
  return {
    ok: true,
    state: "found",
    target: brief(sym),
    blob: fresh,
    exported: sym.exported,
    lsp_at: lspAt(model, sym, fresh),
    states: short ? "short" : "long",
    note: note || null,
    callers: kept.filter((d) => d.item ==="caller"),
    maybe_callers: callers.maybe,
    calls: kept.filter((d) => d.item === "call" || d.item === "store" || d.item === "listen" || d.item === "prop" || d.item === "i18n" || d.item === "event"),
    effects: kept.filter((d) => d.item ==="effect"),
    wiki,
    tests,
    tests_via: testsVia,
    coverage,
    unresolved,
    source: tail && f.source && f.source.kept ? { file: tail.file, from: tail.from, to: tail.from + f.source.kept - 1, text: sourceText(tail, f.source.kept), cut: f.source.cut } : null,
    ...callersSource,
    hidden: f.hidden,
    budget: { used: f.used, max: budget },
    card: f.card,
    exit: 0,
  };
}

function importersOf(model, rel, testsOnly) {
  const out = [];
  for (const other of model.fileSet) {
    if (other === rel) continue;
    if (testsOnly && !TEST_FILE.test(other)) continue;
    const { map, includes } = fileBindings(model, other);
    let hit = includes.includes(rel);
    if (!hit) for (const bd of map.values()) if (bd.files.includes(rel)) { hit = true; break; }
    if (!hit) for (const imp of (model.byFile[other].imports || [])) if (!(imp.bindings || []).length && importTargets(model, other, model.byFile[other].lang, imp).includes(rel)) { hit = true; break; }
    if (hit) out.push(other);
  }
  return out;
}

function fileCard(model, rel, budget, opts) {
  const f = model.byFile[rel];
  const fresh = blobState(model, rel);
  const items = [];
  const push = (pri, section, text, data) => items.push({ pri, section, text, data });
  const tree = opts.format === "tree";
  const allSyms = (f.symbols || []).filter((s) => s.kind !== "module");
  push(0, "header", `${rel}  (${allSyms.length} symbols)  [blob ${String(f.blob).slice(0, 7)} · ${BLOB_LABEL[fresh]}${coverageTag(model, rel)}]`);
  // E7: ordered by IMPORTANCE, not by raw fan-in. A private helper called from
  // forty places is not more useful to a reader than the exported entry point
  // called from three, and a card that leads with the helper buries the answer.
  const SIG = require("./graph-signals.js");
  const allRows = allSyms.map((s) => {
    const fanIn = callersOf(model, s).confident.length;
    return { s, fanIn, imp: SIG.importance(model, s, fanIn) };
  });
  // v2.2.0: a component's interface leads — props, emits and injects in
  // source order, then its template, then the rest by importance.
  const GROUP = { prop: 0, emit: 0, inject: 0, template: 1 };
  const grp = (s) => (GROUP[s.kind] === undefined ? 2 : GROUP[s.kind]);
  allRows.sort((a, b) => {
    const ga = grp(a.s);
    const gb = grp(b.s);
    if (ga !== gb) return ga - gb;
    if (ga < 2) return a.s.lines[0] - b.s.lines[0];
    return b.imp - a.imp || b.fanIn - a.fanIn || a.s.lines[0] - b.s.lines[0];
  });
  // `--offset` pages the SYMBOL rows. Paging is not truncation: `has_more` says
  // there is a next page, and the budget footer still says what it hid.
  const offset = Math.max(0, Number(opts.offset) || 0);
  const rows = allRows.slice(offset);
  const syms = rows.map((r) => r.s);
  // Both bodies are built, and the SMALLER one is printed. A column header and
  // a directory line are FIXED costs: on a three-row card they cost more than
  // the columns save, which is exactly what the first measurement showed. So
  // `--format tree` means "use the tree WHEN it is smaller", and the answer says
  // which one it used. It can never be worse than the prose card.
  const symRows = rows.map(({ s, fanIn, imp }) => ({
    prose: `  ${s.kind.padEnd(8)} ${s.qname}  :${s.lines[0]}-${s.lines[1]}${s.exported ? "  exported" : ""}  fan-in ${fanIn}`,
    tree: `  ${shortKind(s.kind)} ${s.qname} ${s.lines[0]}-${s.lines[1]} ${s.exported ? "E" : "-"} ${fanIn}`,
    data: { item: "symbol", ...brief(s), fan_in: fanIn, importance: imp },
  }));
  const SYM_HEAD = "  kind name lines exp fan-in";
  const useTree =
    tree && symRows.length > 0 &&
    SYM_HEAD.length + symRows.reduce((a, r) => a + r.tree.length, 0) < symRows.reduce((a, r) => a + r.prose.length, 0);
  if (useTree) push(1, "symbols", SYM_HEAD);
  for (const r of symRows) push(2, "symbols", useTree ? r.tree : r.prose, r.data);
  const imports = [...new Set((f.imports || []).flatMap((imp) => importTargets(model, rel, f.lang, imp)))];
  const importers = importersOf(model, rel);
  if (useTree) {
    const pre = dirPrefix([...imports, ...importers]);
    const strip = (a) => a.map((x) => (pre && x.startsWith(pre) ? x.slice(pre.length) : x));
    if (pre) push(3, "imports", `  dir ${pre}`, null);
    if (imports.length) push(3, "imports", `  in  ${strip(imports).join(" ")}`, { item: "imports", files: imports });
    if (importers.length) push(3, "importers", `  out ${strip(importers).join(" ")}`, { item: "importers", files: importers });
  } else {
    if (imports.length) push(3, "imports", `  imports     ${imports.join(", ")}`, { item: "imports", files: imports });
    if (importers.length) push(3, "importers", `  imported by ${importers.join(", ")}`, { item: "importers", files: importers });
  }
  // E7: the tests that reach this file — by CALL (an edge into one of its
  // symbols from a test file) and by NAME (`x.test.js` beside `x.js`). Both,
  // because a test that imports a module without naming a symbol is still its
  // test, and the graph alone would never find it.
  const fileTests = [
    ...new Set([
      ...allSyms.flatMap((sym) => callersOf(model, sym).confident.map((c) => c.sym.file)).filter((x) => TEST_FILE.test(x)),
      ...importers.filter((x) => TEST_FILE.test(x)),
      ...SIG.testsByName(model, rel),
    ]),
  ].sort();
  if (fileTests.length) push(4, "tests", `  tests ${fileTests.join(useTree ? " " : ", ")}`, { item: "tests", files: fileTests });
  // lorc 0.5.0 (W30a): the links of the file (store, emits, parents, i18n,
  // events, config, tables, fields). One data object for all rows.
  const links = linksOf(model, rel);
  const lrows = linkRows(model, links);
  // lorc 0.5.0 (W34d): the first 4 link rows get priority 1. Without this, the
  // symbol rows of a big file fill the budget and cut all links. `fit` prints
  // the kept rows in item order, so the links stay after the symbols.
  lrows.forEach((text, i) => push(i < 4 ? 1 : 3, "links", text, i === 0 ? { item: "links", ...links } : null));
  const wiki = opts.wikiDocsFor ? opts.wikiDocsFor([rel]) : [];
  if (wiki.length) push(5, "wiki", `  wiki ${wiki.join(useTree ? " " : ", ")}`, { item: "wiki", docs: wiki });
  // R1: `--callers-source` is a SYMBOL card's option. A file card names who
  // imports the file, not a call line, so there is no six-line window to print.
  const ignored = opts.callersSource ? " · callers source: symbol cards only" : "";
  const footer = (used, hidden, source) => {
    const why = `${hiddenText(hidden)}${sourceNote(source)}${ignored}`;
    return why ? `  budget ${used}/${budget} tokens${why}` : "";
  };
  // D1 on a FILE card is the file's head — the imports, the exports and the
  // first declaration, which is what a reader opening an unknown file looks at.
  const tail = opts.source === undefined ? null : sourceTail(model, rel, 1, Math.min(FILE_HEAD_LINES, sourceLimit(opts.source)), opts.source, fresh);
  const fitted = fit(items, budget, footer, tail);
  const kept = items.filter((_, i) => fitted.kept.has(i)).map((it) => it.data).filter(Boolean);
  const keptSymbols = kept.filter((d) => d.item === "symbol");
  return {
    ok: true,
    state: "found",
    format: useTree ? "tree" : "prose",
    offset,
    has_more: offset + keptSymbols.length < allRows.length,
    total_symbols: allRows.length,
    file: rel,
    blob: fresh,
    symbols: kept.filter((d) => d.item ==="symbol"),
    tests: fileTests,
    imports,
    importers,
    links: lrows.length ? links : null,
    wiki,
    source: tail && fitted.source && fitted.source.kept ? { file: tail.file, from: tail.from, to: tail.from + fitted.source.kept - 1, text: sourceText(tail, fitted.source.kept), cut: fitted.source.cut } : null,
    hidden: fitted.hidden,
    budget: { used: fitted.used, max: budget },
    card: fitted.card,
    exit: 0,
  };
}

// ── D2 (v1.8.2 W3): `ctx --for-slice` — the OUTSIDE view ────────────────────
// An executor reads every declared file IN FULL before editing it (read-ladder
// exception 1). A file card for a declared file therefore repeats what the
// executor is about to read anyway — the symbol table, the line ranges, the
// fan-in — on every turn of that agent, for the whole run.
//
// What the executor CANNOT see from inside the file is the outside: who imports
// it, who calls its exported symbols from elsewhere, which route reaches it, and
// which tests cover it. `--for-slice` prints ONLY that. No symbol table, no
// callee tree, no notes.
//
// It is one block per declared file, always tree format, and the caller rows are
// sorted by the IMPORTANCE of the symbol they reach — the exported entry point
// before the private helper, the same rule the file card already follows.
const SLICE_MAX_TARGETS = 10;
const STATE_RANK = { LOCAL: 0, IMPORT: 1, ROUTE: 2, UNIQUE: 3 };

function sliceBlock(model, rel, budget, opts) {
  const f = model.byFile[rel];
  const fresh = blobState(model, rel);
  const items = [];
  const push = (pri, section, text, data) => items.push({ pri, section, text, short: text, data });
  push(0, "header", `${rel}  [blob ${String(f.blob).slice(0, 7)} · ${BLOB_LABEL[fresh]}${coverageTag(model, rel)}]`);

  const SIG = require("./graph-signals.js");
  const allSyms = (f.symbols || []).filter((s) => s.kind !== "module");
  // A route symbol is named by its own path; the MOUNTED path is the one a
  // reader outside the file recognises, and it is the one thing the file itself
  // cannot tell them.
  const fullRoute = new Map();
  for (const r of routeTable(model)) if (r.sym.file === rel) fullRoute.set(r.sym.id, `${r.method} ${r.full || r.own}`);
  // ONE ROW PER CALLING FILE, naming every symbol of this file it reaches. The
  // first measurement of this view listed one row per (symbol, caller) pair and
  // came out LARGER than the file card it replaces — six symbols and four
  // callers is twenty-four rows for four relationships. The outside question is
  // "who reaches this file, and through what", and that is one row per file.
  const OUT_NAMES = 8;
  const byFile = new Map();
  for (const s of allSyms) {
    const cs = callersOf(model, s).confident;
    const imp = SIG.importance(model, s, cs.length);
    const reaches = fullRoute.get(s.id) || s.name;
    for (const c of cs) {
      if (c.sym.file === rel) continue; // inside the file — the executor reads it
      let row = byFile.get(c.sym.file);
      if (!row) byFile.set(c.sym.file, (row = { file: c.sym.file, line: c.line, imp, state: c.state, names: new Map() }));
      if (c.line < row.line) row.line = c.line;
      if (imp > row.imp) row.imp = imp;
      // One state per row: the strongest one this file reached the target with.
      if (STATE_RANK[c.state] < STATE_RANK[row.state]) row.state = c.state;
      if (!row.names.has(reaches)) row.names.set(reaches, imp);
    }
  }
  const rows = [...byFile.values()]
    .map((r) => ({ ...r, names: [...r.names.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]) }))
    .sort((a, b) => b.imp - a.imp || a.file.localeCompare(b.file));
  for (const r of rows) {
    const shown = r.names.slice(0, OUT_NAMES);
    push(
      2,
      "callers",
      `  ${r.file}:${r.line} ${STATE_SHORT[r.state] || r.state}  ${shown.join(" ")}${r.names.length > OUT_NAMES ? ` +${r.names.length - OUT_NAMES}` : ""}`,
      { item: "caller", file: r.file, line: r.line, state: r.state, reaches: r.names }
    );
  }

  const importers = importersOf(model, rel);
  // Only the importers that call NOTHING — the ones the caller rows already
  // name are the same fact printed twice.
  // T6c: a test file is never on the `imp` line — it stays on `tst`.
  const quiet = importers.filter((x) => !byFile.has(x) && !TEST_FILE.test(x));
  if (quiet.length) {
    const pre = dirPrefix(quiet);
    if (pre) push(1, "importers", `  dir ${pre}`, null);
    push(1, "importers", `  imp ${quiet.map((x) => (pre && x.startsWith(pre) ? x.slice(pre.length) : x)).join(" ")}  (imports it, calls nothing)`, { item: "importers", files: quiet });
  }

  // The routes this file answers, with the mount chain already folded in — the
  // one fact a reader of the file itself cannot get without opening the mount.
  // A route a caller row already named is the same fact twice, so only the ones
  // NOTHING reaches are printed — which is also the more interesting half.
  const reached = new Set(rows.flatMap((r) => r.names));
  const routes = routeTable(model)
    .filter((r) => r.sym.file === rel)
    .map((r) => `${r.method} ${r.full || r.own}${r.mounted === "known" || r.mounted === "none" ? "" : " (mount ambiguous)"}`);
  const unreached = routes.filter((x) => !reached.has(x));
  // T6c: at most 8 routes on the line, then `+<n>` — a router answers 85.
  if (unreached.length) push(1, "routes", `  rt  ${unreached.slice(0, 8).join("  ")}${unreached.length > 8 ? `  +${unreached.length - 8}` : ""}  (no caller in the graph)`, { item: "routes", routes: unreached });

  const shownFiles = new Set(rows.map((r) => r.file));
  const allTests = [
    ...new Set([...rows.map((r) => r.file).filter((x) => TEST_FILE.test(x)), ...importers.filter((x) => TEST_FILE.test(x)), ...SIG.testsByName(model, rel)]),
  ].sort();
  const moreTests = allTests.filter((x) => !shownFiles.has(x));
  if (moreTests.length) push(1, "tests", `  tst ${moreTests.join(" ")}`, { item: "tests", files: moreTests });

  const footer = (used, hidden) => (hiddenText(hidden) ? `  budget ${used}/${budget} tokens${hiddenText(hidden)}` : "");
  const fitted = fit(items, budget, footer);
  const kept = items.filter((_, i) => fitted.kept.has(i)).map((it) => it.data).filter(Boolean);
  return {
    file: rel,
    blob: fresh,
    callers: kept.filter((d) => d.item === "caller"),
    total_callers: rows.length,
    importers,
    routes,
    tests: allTests,
    names: [...new Set([...rows.flatMap((r) => r.names), ...routes])],
    hidden: fitted.hidden,
    used: fitted.used,
    card: fitted.card,
  };
}

function forSlice(model, files, opts) {
  const budget = Math.max(100, Math.min(8000, Number(opts.budget) || 1200));
  const all = [...new Set(files.map(norm))];
  const known = all.filter((r) => model.fileSet.has(r)).slice(0, SLICE_MAX_TARGETS);
  const skipped = all.filter((r) => model.fileSet.has(r)).slice(SLICE_MAX_TARGETS);
  const missing = all.filter((r) => !model.fileSet.has(r));
  if (!known.length) return { ok: false, state: "not-found", missing, exit: 4 };
  const each = Math.max(100, Math.floor(budget / known.length));
  const blocks = known.map((rel) => sliceBlock(model, rel, each, opts));
  const body = blocks.map((b) => b.card).join("\n\n");
  // R1 / DE-7b: the executor reads its declared files whole, so the outside
  // view stays rows only — the flag is named as ignored, never silently dropped.
  const note = (missing.length ? `\n  not in the graph: ${missing.join(", ")}` : "") + (opts.callersSource ? "\n  callers source: symbol cards only" : "");
  // The column header is named ONCE for the whole answer, not once per block —
  // the tree format's own rule, applied one level up.
  return {
    ok: true,
    state: "found",
    view: "for-slice",
    format: "tree",
    files: known,
    missing,
    skipped,
    blocks: blocks.map((b) => ({ file: b.file, blob: b.blob, callers: b.callers, total_callers: b.total_callers, importers: b.importers, routes: b.routes, tests: b.tests, hidden: b.hidden })),
    names: [...new Set(blocks.flatMap((b) => b.names))],
    budget: { used: blocks.reduce((a, b) => a + b.used, 0), max: budget },
    card: `graph outside view — read each file itself before you edit it · rows are  from:line state  reaches\n${body}${note}`,
    exit: 0,
  };
}


// ── impact ──────────────────────────────────────────────────────────────────
function impact(model, files, opts) {
  const depth = Math.max(1, Math.min(6, Number(opts.depth) || 3));
  const budget = Math.max(100, Math.min(8000, Number(opts.budget) || 1500));
  const rels = [...new Set(files.map(norm))].filter((f) => model.fileSet.has(f));
  const missing = files.map(norm).filter((f) => !model.fileSet.has(f));
  if (!rels.length) return { ok: false, state: "not-found", missing, exit: 4 };
  const targets = rels.flatMap((r) => (model.byFile[r].symbols || []).filter((s) => s.kind !== "module"));
  const inTargets = new Set(targets.map((s) => s.id));
  const seen = new Map();
  let frontier = targets;
  let maybe = 0;
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const t of frontier) {
      const c = callersOf(model, t);
      if (d === 1) maybe += c.maybe;
      for (const row of c.confident) {
        if (inTargets.has(row.sym.id) || seen.has(row.sym.id)) continue;
        seen.set(row.sym.id, { sym: row.sym, depth: d, line: row.line, state: row.state, via: row.url ? `${t.qname} ← ${row.url}` : t.qname, ...(row.url ? { url: row.url } : {}) });
        if (row.sym.kind !== "module") next.push(row.sym);
      }
    }
    frontier = next;
  }
  const hits = [...seen.values()].sort(
    (a, b) => a.depth - b.depth || a.sym.file.localeCompare(b.sym.file) || a.line - b.line || String(a.sym.id).localeCompare(String(b.sym.id))
  );
  const importerTests = rels.flatMap((r) => importersOf(model, r)).filter((f) => TEST_FILE.test(f));
  const SIG = require("./graph-signals.js");
  const tests = [
    ...new Set([
      ...hits.filter((h) => TEST_FILE.test(h.sym.file)).map((h) => h.sym.file),
      ...importerTests,
      ...rels.flatMap((r) => SIG.testsByName(model, r)),
    ]),
  ].sort();
  const touched = [...new Set([...rels, ...hits.map((h) => h.sym.file)])];
  const wiki = opts.wikiDocsFor ? opts.wikiDocsFor(touched) : [];

  const tree = opts.format === "tree";
  const offset = Math.max(0, Number(opts.offset) || 0);
  // T6b: a caller in a TEST file is not a caller row — the budget shows the
  // CODE that depends on the change, and the tests get one line of their own.
  const codeHits = hits.filter((h) => !TEST_FILE.test(h.sym.file));
  const page = codeHits.slice(offset);
  const items = [];
  const push = (pri, section, text, data) => items.push({ pri, section, text, data });
  push(0, "header", `impact of ${rels.join(", ")} — ${targets.length} symbols · depth ${depth}`);
  // The same never-worse rule as the file card. The fixed cost here is a column
  // header PLUS a directory line, so a two-row impact card stays prose.
  const pre = dirPrefix(page.map((h) => h.sym.file));
  const CALL_HEAD = "  d qname file:line state via";
  const callRows = page.map((h) => {
    const file = pre && h.sym.file.startsWith(pre) ? h.sym.file.slice(pre.length) : h.sym.file;
    return {
      pri: h.depth,
      prose: `  d${h.depth}  ${h.sym.qname}  ${where(h.sym, h.line)}  ${h.state}  (via ${h.via})`,
      tree: `  ${h.depth} ${h.sym.qname} ${file}:${h.line || h.sym.lines[0]} ${STATE_SHORT[h.state] || h.state} ${h.via}`,
      data: { item: "caller", depth: h.depth, ...brief(h.sym), line: h.line, state: h.state, via: h.via, ...(h.url ? { url: h.url } : {}) },
    };
  });
  const fixed = CALL_HEAD.length + (pre ? pre.length + 6 : 0);
  const useTree =
    tree && callRows.length > 0 &&
    fixed + callRows.reduce((a, r) => a + r.tree.length, 0) < callRows.reduce((a, r) => a + r.prose.length, 0);
  if (useTree) {
    if (pre) push(1, "callers", `  dir ${pre}`, null);
    push(1, "callers", CALL_HEAD);
  }
  for (const r of callRows) push(r.pri, "callers", useTree ? r.tree : r.prose, r.data);
  const j = useTree ? " " : ", ";
  if (tests.length) push(1, "tests", `  tests  ${tests.length} files: ${tests.slice(0, 6).join(", ")}${tests.length > 6 ? `, +${tests.length - 6}` : ""}`, { item: "tests" });
  if (wiki.length) push(2, "wiki", `  wiki${useTree ? "" : "  "} ${wiki.join(j)}`, { item: "wiki" });
  if (maybe) push(2, "maybe", useTree ? `  maybe ${maybe} ambiguous, not followed` : `  maybe  ${maybe} AMBIGUOUS caller(s) not followed`, { item: "maybe" });
  if (missing.length) push(1, "missing", useTree ? `  absent ${missing.join(" ")}` : `  not in the graph: ${missing.join(", ")}`, { item: "missing" });
  const footer = (used, hidden) => (hiddenText(hidden) ? `  budget ${used}/${budget} tokens${hiddenText(hidden)}` : "");
  const f = fit(items, budget, footer);
  const kept = items.filter((_, i) => f.kept.has(i)).map((it) => it.data).filter(Boolean);
  const keptCallers = kept.filter((d) => d.item === "caller");
  return {
    ok: true,
    state: "found",
    format: useTree ? "tree" : "prose",
    offset,
    has_more: offset + keptCallers.length < codeHits.length,
    files: rels,
    missing,
    symbols: targets.length,
    callers: kept.filter((d) => d.item ==="caller"),
    total_callers: codeHits.length,
    maybe_callers: maybe,
    tests,
    wiki,
    hidden: f.hidden,
    budget: { used: f.used, max: budget },
    card: f.card,
    exit: 0,
  };
}

// ── path ────────────────────────────────────────────────────────────────────
// T6b: a FILE as an end means ANY symbol in that file — the shortest
// confident path to (or from) any of them.
function pathEnd(model, q) {
  const t = findTarget(model, q);
  if (t.kind === "symbol") return { t, syms: [t.sym], label: t.sym.qname };
  if (t.kind === "file") {
    const syms = ((model.byFile[t.rel] || {}).symbols || []).filter((s) => s.kind !== "module");
    if (syms.length) return { t, syms, label: t.rel, file: t.rel };
  }
  return { t, syms: null };
}

function pathBetween(model, fromQ, toQ) {
  const A = pathEnd(model, fromQ);
  const B = pathEnd(model, toQ);
  if (!A.syms || !B.syms) {
    const a = A.t;
    const b = B.t;
    return { ok: false, state: "not-found", from: a.kind, to: b.kind, candidates: [...(a.candidates || []), ...(b.candidates || [])].map(brief), exit: 4 };
  }
  const goals = new Set(B.syms.map((x) => x.id));
  const prev = new Map(A.syms.map((x) => [x.id, null]));
  let frontier = A.syms.slice();
  let reached = (A.syms.find((x) => goals.has(x.id)) || {}).id || null;
  for (let d = 0; d < 8 && frontier.length && !reached; d++) {
    const next = [];
    for (const s of frontier) {
      for (const { call, res } of calleesOf(model, s)) {
        if (!CONFIDENT.has(res.state) || prev.has(res.target)) continue;
        const t = model.symbols.get(res.target);
        if (!t) continue;
        prev.set(t.id, { from: s, line: call.line, state: res.state });
        next.push(t);
        if (!reached && goals.has(t.id)) reached = t.id;
      }
    }
    frontier = next;
  }
  if (!reached) {
    const end = (E) => (E.file ? { file: E.file, kind: "file" } : brief(E.syms[0]));
    return { ok: true, state: "none", from: end(A), to: end(B), exit: 4, card: `no confident call path from ${A.label} to ${B.label} (AMBIGUOUS edges are not followed)` };
  }
  const b = { sym: model.symbols.get(reached) };
  const chain = [];
  for (let id = b.sym.id; id; ) {
    const p = prev.get(id);
    chain.unshift({ sym: model.symbols.get(id), step: p });
    id = p ? p.from.id : null;
  }
  const lines = chain.map((c, i) => (i === 0 ? `${c.sym.qname}  ${where(c.sym)}` : `  → ${c.sym.qname}  ${where(c.sym)}  ${c.step.state}  (called at ${where(c.step.from, c.step.line)})`));
  return {
    ok: true,
    state: "found",
    hops: chain.length - 1,
    chain: chain.map((c) => ({ ...brief(c.sym), state: c.step ? c.step.state : null, called_at: c.step ? where(c.step.from, c.step.line) : null })),
    card: lines.join("\n"),
    exit: 0,
  };
}

// ── D4 (v1.8.2 W7): `orc graph map` — the ranked repository map ─────────────
// The planner's FIRST question, answered without a single Read: which files
// are the landmarks here, and — with `--focus` — which ones surround the thing
// the request already names.
//
// The rank comes from `bin/graph-map.js`. This half owns what a row says and
// how the list is cut, which is the same contract every other card keeps: rows
// in a fixed order, the budget cuts from the BOTTOM, and a card that hid
// something says so.
const MAP_FOCUS_MASS = 100;
const MAP_CAVEAT = "  rank is a HINT about where to look first — it is never proof a file matters to this change";

function mapRow(model, rel, fan, pre) {
  const SIG = require("./graph-signals.js");
  const syms = (model.byFile[rel].symbols || []).filter((s) => s.kind !== "module");
  const ranked = syms
    .map((s) => ({ s, imp: SIG.importance(model, s, fan.get(s.id) || 0) }))
    .sort((a, b) => b.imp - a.imp || a.s.lines[0] - b.s.lines[0]);
  // Chosen by importance, then PRINTED in line order: a file is read top to
  // bottom, and a list that jumps about costs the reader more than it saves.
  const M = require("./graph-map.js");
  const shown = ranked.slice(0, M.SYMS_PER_FILE).sort((a, b) => a.s.lines[0] - b.s.lines[0]);
  const rest = ranked.length - shown.length;
  const name = pre && rel.startsWith(pre) ? rel.slice(pre.length) : rel;
  const parts = shown.map(({ s }) => `${s.qname}:${s.lines[0]}-${s.lines[1]}${s.exported ? " E" : ""}`);
  if (rest > 0) parts.push(`+${rest}`);
  return {
    text: `  ${name}${parts.length ? "  " + parts.join(" · ") : ""}`,
    data: { item: "file", file: rel, symbols: shown.map(({ s }) => ({ qname: s.qname, kind: s.kind, lines: s.lines, exported: !!s.exported })), more: Math.max(0, rest) },
  };
}

// A focus token is a FILE when the graph holds that path, and a NAME otherwise.
// A name contributes every file that DEFINES it — which is how "focus on
// `createOrder`" reaches the file a request never spelled out.
//
// v2.1.2 (F05): a token that is neither is read as plain WORDS. Two lane spines
// pass "<3–6 words from the request>", and before this step every such map was
// the plain repository ranking with a trace that still said `focused`. A word
// reaches the files whose PATH or whose symbol NAMES hold it.
const FOCUS_STOP = new Set(
  "the and for with from into that this when where what which how why not all any add fix get set new use make src lib index test tests spec file files code".split(" ")
);

// Light on purpose: `rates` → `rate`, `taxes` → `tax`, `orders` → `order`,
// `address` stays. A real stemmer would join words a request keeps apart.
function focusStem(w) {
  if (w.length > 3 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length >= 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

// camelCase, `_`, `-`, `.`, `/` and whitespace all end a word.
function focusWords(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => focusStem(w.toLowerCase()));
}

// R4: a focus word matches a path/name segment when they are equal, or one is
// the other's simple plural (`+s`, `+es`), both ways. Both sides are already
// lower case and stemmed by focusWords, so this only adds what the light
// stemmer leaves apart.
function wordMatch(w, seg) {
  return seg === w || seg === w + "s" || seg === w + "es" || w === seg + "s";
}

// ONE index per call, built only when a token needs it: word → the files whose
// path (directories + basename without its extension) or symbol names hold it.
// v2.2.0 (D6): word → Map(file → 2 when the word is a PATH segment, 1 when
// only a symbol name holds it).
function focusWordIndex(model) {
  const index = new Map();
  for (const rel of model.fileSet) {
    const words = new Map();
    for (const w of focusWords(rel.replace(/\.[^./]+$/, ""))) words.set(w, { path: true, n: 0 });
    for (const s of (model.byFile[rel] && model.byFile[rel].symbols) || []) {
      if (s.kind === "module") continue;
      for (const w of new Set(focusWords(s.name || s.qname || ""))) {
        const e = words.get(w) || { path: false, n: 0 };
        e.n++;
        words.set(w, e);
      }
    }
    for (const [w, x] of words) {
      if (!index.has(w)) index.set(w, new Map());
      index.get(w).set(rel, x);
    }
  }
  return index;
}

// v2.2.0 (D6): a word is never dropped. It is WEIGHTED by how rare it is —
// log(1 + N/hits) / log(1 + N), so a rare word is near 1 and a word in every
// file is small but above 0. A file named directly is the strongest (3).
//
// v2.2.0 (T6b): a plain lower-case token is ALWAYS a word — `amount` used to
// be read as a NAME (only the files defining it) and vanished from the words
// line. A token with `/`, `.` or `#` is a file or a qname; a camelCase,
// PascalCase or `_` token is a NAME and a word. A PATH-segment hit is worth
// 2w; a symbol-only hit is worth w × min(1, matched / sqrt(total)), so a
// constants file with 177 symbols and 6 matches is not a strong hit.
// `strong` is every file reached by a path segment, a file token or a name —
// the files hub damping never touches.
const FOCUS_FILE_MASS = 3;
function focusFiles(model, tokens) {
  const mass = new Map();
  const strong = new Set();
  const add = (rel, m) => mass.set(rel, (mass.get(rel) || 0) + m);
  const missing = [];
  const common = [];
  const words = [];
  const seen = new Set();
  let index = null;
  const N = model.fileSet.size;
  const symCount = (rel) => ((model.byFile[rel] && model.byFile[rel].symbols) || []).filter((s) => s.kind !== "module").length;
  for (const t of tokens) {
    const raw = String(t);
    const rel = norm(raw).replace(/:\d+$/, "");
    if (model.fileSet.has(rel)) {
      add(rel, FOCUS_FILE_MASS);
      strong.add(rel);
      continue;
    }
    if (/[\/.#]/.test(raw)) {
      const defs = model.byName.get(raw.split(/[.#]/).pop()) || [];
      for (const s of defs) {
        add(s.file, 1);
        strong.add(s.file);
      }
      if (!defs.length) missing.push(raw);
      continue;
    }
    const isName = /[a-z0-9][A-Z]|^[A-Z]|_/.test(raw);
    let named = false;
    if (isName) {
      for (const s of model.byName.get(raw) || []) {
        add(s.file, 1);
        strong.add(s.file);
        named = true;
      }
    }
    index = index || focusWordIndex(model);
    const none = [];
    let held = false;
    for (const w of focusWords(raw)) {
      if (w.length < 3 || FOCUS_STOP.has(w) || seen.has(w)) continue;
      seen.add(w);
      const hit = index.get(w) || new Map();
      const weight = hit.size ? Math.log(1 + N / hit.size) / Math.log(1 + N) : 0;
      words.push({ word: w, files: hit.size, used: hit.size > 0, weight: Math.round(weight * 1000) / 1000, kind: isName ? "name" : "word" });
      if (!hit.size) none.push(w);
      else {
        held = true;
        for (const [f, x] of hit) {
          if (x.path) {
            add(f, weight * 2);
            strong.add(f);
          } else add(f, weight * Math.min(1, x.n / Math.sqrt(Math.max(1, symCount(f)))));
        }
      }
    }
    // A token with no word in the graph is reported WHOLE, as it was typed —
    // the answer a caller got before the word step, unchanged.
    if (held) missing.push(...none);
    else if (!named) missing.push(raw);
  }
  return { files: [...mass.keys()], mass, strong, missing, common, words };
}

function graphMap(claudeDir, model, opts) {
  const M = require("./graph-map.js");
  const budget = Math.max(100, Math.min(8000, Number(opts.budget) || 1200));
  const { files, edges, base, cached } = M.edgesFor(claudeDir, model);
  const idOf = new Map(files.map((f, i) => [f, i]));
  const tokens = (opts.focus || []).filter(Boolean);
  const foc = tokens.length ? focusFiles(model, tokens) : { files: [], mass: new Map(), strong: new Set(), missing: [], common: [], words: [] };

  let rank;
  if (foc.files.length) {
    // W7-focus-baseline: EVERY file keeps a baseline share of 1 and the focus
    // gets `MAP_FOCUS_MASS / n` ON TOP of it. Giving the focus the whole vector
    // — the literal reading of "focus files get 100/n" — leaves every file the
    // focus does not reach at exactly zero, and a hundred tied zeroes sort
    // alphabetically. That turns the rest of the map into a directory listing,
    // which is the one thing it must never be.
    //
    // The mass is FIXED, so a fifth focus file dilutes the other four rather
    // than making the focus louder overall. That is Aider's rule and the reason
    // is the same: a focus list is a hint about where to start, not a filter.
    //
    // v2.2.0 (D6): the fixed mass is shared by each file's focus MASS (its
    // weighted word hits), not in equal parts.
    const pers = new Float64Array(files.length).fill(1);
    let total = 0;
    for (const f of foc.files) total += foc.mass.get(f) || 0;
    for (const f of foc.files) {
      const i = idOf.get(f);
      if (i !== undefined && total > 0) pers[i] += (MAP_FOCUS_MASS * (foc.mass.get(f) || 0)) / total;
    }
    rank = M.pageRank(files.length, edges, pers);
  } else rank = base || M.pageRank(files.length, edges, null);

  // v2.2.0 (D6): hub damping, focus only. A file the focus never reached that
  // is a shared hub — by its path, or by an in-degree in the top 2 % — would
  // otherwise outrank the files the request names.
  // T6b: only a file the focus reached by a PATH, a file token or a name is
  // exempt — a file reached by symbol hits alone is damped when it is a hub.
  const damp = foc.files.length ? M.hubDamping(files, edges, foc.strong) : null;
  // Every indexed file is ranked — a file with no edge keeps its teleport share.
  let scored = files.map((rel, i) => ({ rel, score: (rank[i] || 0) * M.multiplier(model, rel) * (damp ? damp[i] : 1) }));
  // T6b: personalised PageRank sends rank from the focused files into what
  // they IMPORT — the hubs. With a focus, the final score is half the walk and
  // half the file's own focus mass, each normalised to [0, 1].
  if (foc.files.length) {
    const maxPr = Math.max(...scored.map((x) => x.score), 0) || 1;
    const maxMass = Math.max(...foc.files.map((f) => foc.mass.get(f) || 0), 0) || 1;
    scored = scored.map((x) => ({ rel: x.rel, score: 0.5 * (x.score / maxPr) + 0.5 * ((foc.mass.get(x.rel) || 0) / maxMass) }));
  }
  scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  const candidates = scored;
  const fan = M.fanCounts(model);
  const pre = dirPrefix(candidates.map((c) => c.rel));
  const rows = candidates.map((c, i) => {
    const row = mapRow(model, c.rel, fan, pre);
    return { text: row.text, data: { ...row.data, rank: i + 1 } };
  });

  const focusNote = foc.files.length ? ` · focus ${foc.files.length} file(s)` : "";
  const footer = (used, hidden) => (hiddenText(hidden) ? `  budget ${used}/${budget} tokens${hiddenText(hidden)}` : "");
  // W7-map-prefix: the map is cut to a PREFIX of the ranking, never to whatever
  // happens to fit. `fit()` is greedy — after skipping one long row it will
  // still take a shorter row further down — which is right for a card whose
  // sections are independent and wrong for a list whose whole meaning is the
  // ORDER. A reader who sees rank 10 present and rank 7 missing cannot use the
  // order for anything.
  //
  // So the row count is chosen by binary search, exactly as Aider chooses its
  // map size, and `fit` is then handed a list it can keep whole. Its budget
  // arithmetic and its footer reserve are unchanged and still do the accounting.
  const itemsFor = (k) => {
    const items = [];
    items.push({ pri: 0, section: "header", text: `graph map (gen ${model.meta.generation}) — ${files.length} file(s) by rank${focusNote}`, data: null });
    if (pre) items.push({ pri: 0, section: "header", text: `  dir ${pre}`, data: null });
    if (foc.missing.length) items.push({ pri: 0, section: "focus", text: `  focus not in the graph: ${foc.missing.join(", ")}`, data: { item: "focus-missing" } });
    // F05: what each plain word reached, so a reader can tell a focused map
    // from one whose words all missed.
    if (foc.words.length)
      items.push({
        pri: 0,
        section: "focus",
        text: `  focus words: ${foc.words.map((w) => (w.files ? `${w.word} ${w.files}×${w.weight.toFixed(2)}` : `${w.word} ${w.files}`)).join(" · ")}`,
        data: { item: "focus-words" },
      });
    for (let i = 0; i < k; i++) items.push({ pri: 1, section: "files", text: rows[i].text, data: rows[i].data });
    // pri 0: never cut, and CHARGED to the budget like everything else. It is
    // the map's whole equivalent of "the graph is a LOCATOR" — a card that
    // dropped it under budget pressure would be a ranking with no warning
    // label on it.
    items.push({ pri: 0, section: "caveat", text: MAP_CAVEAT, data: null });
    return items;
  };
  const fits = (k) => {
    const f = fit(itemsFor(k), budget, footer);
    return !f.hidden.files;
  };
  let lo = 0;
  let hi = rows.length;
  if (!fits(hi)) {
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
  } else lo = hi;

  const shownRows = rows.slice(0, lo);
  const items = itemsFor(lo);
  // The footer has to report what the PREFIX left out, which `fit` cannot know
  // once the rows are gone. A map that silently stops at rank 12 is a map that
  // claims the repository has twelve files.
  const cut = files.length - shownRows.length;
  const footerFinal = (used) => (cut > 0 ? `  budget ${used}/${budget} tokens · hidden: ${cut} files (raise --budget)` : "");
  const f = fit(items, budget, footerFinal);
  return {
    ok: true,
    state: "found",
    focus: foc.files,
    focus_missing: foc.missing,
    focus_common: foc.common,
    focus_words: foc.words,
    cached_map: !!cached,
    total_files: files.length,
    edges: edges.length,
    files: shownRows.map((r) => r.data),
    shown: shownRows.length,
    has_more: cut > 0,
    hidden: cut > 0 ? { files: cut } : {},
    budget: { used: f.used, max: budget },
    card: f.card,
    generation: model.meta.generation,
    exit: 0,
  };
}

// EW2, for the resolution cache only: which files this one's import specifiers
// actually reach, and whether any RELATIVE specifier reaches nothing. A file
// added later can only ever satisfy a relative specifier, so that flag is the
// complete set of files an addition can move.
function importsOf(model, rel) {
  const f = model.byFile[rel] || {};
  const files = new Set();
  let unresolvedRelative = false;
  for (const imp of f.imports || []) {
    const t = importTargets(model, rel, f.lang, imp);
    for (const x of t) files.add(x);
    if (!t.length && /^\.{1,2}\//.test(String(imp.from || ""))) unresolvedRelative = true;
  }
  return { files: [...files].sort(), unresolvedRelative };
}

// K2 (v1.8.2 W4b): how many lines in this repository NAME this symbol — the
// exact size of the Grep the card replaced. The graph knows it for free: every
// call site is already in the call index, and every definition in `byName`.
function nameHits(model, name) {
  const bare = String(name || "").split(".").pop();
  const calls = (callIndex(model).get(bare) || []).length;
  const defs = (model.byName.get(bare) || []).length;
  return calls + defs;
}

// ── v2.2.0 (T6-a): the executor PACK ────────────────────────────────────────
// On a real Vue repository the executor never used the graph: it read ~180 KB
// of REFERENCE code (the files it copies behaviour from) through `cat` and
// `sed`, in about 30 calls. An outside-view card did not change that. The pack
// is ONE file that holds the outline of each reference file and the exact
// lines of the ranges the executor was about to go looking for.
//
// It is a LOCATOR, not a copy of the repository: the quoted ranges are charged
// to a budget, a range is at most 80 lines, nothing is quoted twice, and a
// file whose blob moved since the index says so beside every quote from it.
const PACK_BIG_LINES = 150;
const PACK_RANGE_LINES = 80;
const PACK_MAX_REFS = 8;
const PACK_AUTO_REFS = 5;
const PACK_OUTLINE_BUDGET = 2200;
const PACK_TESTS_BUDGET = 700;
// R2 (lean pack v2): outline first. Only a short helper is quoted — whole.
const PACK_QUOTE_BUDGET = 600;
const PACK_QUOTE_MAX_LINES = 30;
const PACK_READ_RANGES_LINES = 300;
const PACK_PARENTS_PER_REF = 2;
const PACK_PARENTS_MAX = 3;
// R3: the component NEIGHBOURHOOD — outline-only refs around the given ones.
const PACK_CHILDREN_PER_REF = 3;
const PACK_NAME_REFS = 5;
const PACK_NEIGH_MAX = 12;
const PACK_SLICE_BUDGET = 600;
const PACK_QUOTE_KINDS = new Set(["function", "method", "computed", "route"]);
const PACK_CONTRACT = [["props", "prop"], ["emits", "emit"], ["inject", "inject"]];
const PACK_NEVER_QUOTE = new Set(["prop", "emit", "inject", "template", "module"]);
const LANG_FENCE = { vue: "vue", svelte: "svelte", js: "js", mjs: "js", cjs: "js", jsx: "jsx", ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", py: "python", go: "go", java: "java", cs: "csharp", php: "php", rb: "ruby", rs: "rust", kt: "kotlin", kts: "kotlin", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp" };

// A `--refs=` operand: a file, a path suffix, or a symbol (its file).
function resolveRef(model, q) {
  const s = norm(q).replace(/:\d+$/, "");
  if (model.fileSet.has(s)) return { file: s };
  const t = findTarget(model, s);
  if (t.kind === "file") return { file: t.rel };
  if (t.kind === "symbol") return { file: t.sym.file };
  if (t.kind === "ambiguous-file") return { candidates: t.files };
  if (t.kind === "ambiguous") {
    const files = [...new Set(t.candidates.map((c) => c.file))].sort();
    return files.length === 1 ? { file: files[0] } : { candidates: files };
  }
  return { missing: String(q) };
}

// The top-level blocks of a single-file component, read from the working tree.
// A block opens on a line that STARTS with `<template`, `<script` or `<style`
// and closes on the first line that starts with its closing tag.
function blockRanges(model, rel) {
  const lines = fileLines(model, rel) || [];
  const out = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!open) {
      const o = /^<(template|script|style)\b/.exec(l);
      if (!o) continue;
      open = { tag: o[1], from: i + 1 };
      if (new RegExp(`</${open.tag}>\\s*$`).test(l)) {
        out.push(`${open.tag} ${open.from}-${i + 1}`);
        open = null;
      }
      continue;
    }
    if (new RegExp(`^</${open.tag}>`).test(l)) {
      out.push(`${open.tag} ${open.from}-${i + 1}`);
      open = null;
    }
  }
  return out;
}

function packTestsOf(model, rel) {
  const SIG = require("./graph-signals.js");
  const syms = ((model.byFile[rel] || {}).symbols || []).filter((s) => s.kind !== "module");
  return [
    ...new Set([
      ...syms.flatMap((s) => callersOf(model, s).confident.map((c) => c.sym.file)).filter((x) => TEST_FILE.test(x)),
      ...importersOf(model, rel).filter((x) => TEST_FILE.test(x)),
      ...SIG.testsByName(model, rel),
    ]),
  ].sort();
}

const memberName = (s) => (s.qname.includes(".") ? s.qname.split(".").slice(1).join(".") : s.qname);

// The OUTLINE of one file: a header, then rows that each name the part they
// are, so the size rule can cut `members` first.
// T6c: `members` are kept as entries so the OUTLINE budget can drop the
// smallest first; `routes` (a router edit target) are their own rows.
const VUE_MEMBER_ORDER = { computed: 1, method: 2, watch: 3 };
const PACK_ROUTE_ROWS = 40;
function packOutline(model, rel, withRoutes, tag, focus) {
  const f = model.byFile[rel] || {};
  const syms = (f.symbols || []).filter((s) => s.kind !== "module");
  const sfc = /\.(vue|svelte)$/.test(rel);
  const blocks = sfc ? blockRanges(model, rel) : [];
  const nLines = Number(f.lines) || (fileLines(model, rel) || []).length;
  const head = `${rel} · ${nLines} lines${blocks.length ? " · " + blocks.join(" · ") : ""}${tag ? ` · ${tag}` : ""}${nLines > PACK_READ_RANGES_LINES ? " · read ranges, not the file" : ""}`;
  const rows = [];
  const contract = PACK_CONTRACT.map(([label, kind]) => {
    const n = syms.filter((s) => s.kind === kind).map((s) => s.name);
    return n.length ? `${label} ${n.join(", ")}` : null;
  }).filter(Boolean);
  if (contract.length) rows.push({ part: "contract", text: `  contract  ${contract.join(" · ")}` });
  const routes = withRoutes ? syms.filter((s) => s.kind === "route").sort((a, b) => a.lines[0] - b.lines[0]) : [];
  if (routes.length) {
    // R3: a router-like target (>= 10 routes) keeps the rows whose path or
    // name holds a focus word, plus 2 rows before and after each hit. No hit
    // -> the first 10.
    let keep = routes.slice(0, PACK_ROUTE_ROWS);
    if (routes.length >= 10) {
      const words = (focus || []).map((w) => String(w).toLowerCase()).filter((w) => w.length >= 2);
      const idx = new Set();
      routes.forEach((r, i) => {
        const hay = `${r.qname} ${r.route_name || ""}`.toLowerCase();
        if (words.some((w) => hay.includes(w))) for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < routes.length) idx.add(k);
      });
      keep = idx.size ? routes.filter((_, i) => idx.has(i)) : routes.slice(0, 10);
    }
    for (const s of keep) rows.push({ part: "routes", text: `  ${s.qname}${s.route_name ? ` ${s.route_name}` : ""} ${s.lines[0]}-${s.lines[1]}` });
    if (routes.length > keep.length) rows.push({ part: "routes", text: `  +${routes.length - keep.length} other routes` });
  }
  const contractKinds = new Set(PACK_CONTRACT.map((x) => x[1]));
  // A component's `data` leads, then computed, methods and watchers.
  const rank = (s) => (!sfc ? 0 : s.name === "data" ? 0 : VUE_MEMBER_ORDER[s.kind] || 4);
  const members = syms
    .filter((s) => !contractKinds.has(s.kind) && s.kind !== "template" && !(routes.length && s.kind === "route") && !(sfc && s.kind === "class" && !s.qname.includes(".")))
    .sort((a, b) => rank(a) - rank(b) || a.lines[0] - b.lines[0])
    .map((s) => ({ text: `${memberName(s)} ${s.lines[0]}-${s.lines[1]}`, span: s.lines[1] - s.lines[0], keep: true }));
  const membersRow = { part: "members", members, text: null };
  if (members.length) rows.push(membersRow);
  const firstUse = new Map();
  for (const s of syms.filter((x) => x.kind === "template"))
    for (const c of s.calls || []) if (c.ref && /^[A-Z][a-z0-9]/.test(c.name) && (!firstUse.has(c.name) || c.line < firstUse.get(c.name))) firstUse.set(c.name, c.line);
  if (firstUse.size) rows.push({ part: "uses", text: `  uses      ${[...firstUse].map(([n, l]) => `${n} ${l}`).join(", ")}` });
  const imports = [...new Set((f.imports || []).flatMap((imp) => importTargets(model, rel, f.lang, imp)))].slice(0, 8);
  if (imports.length) rows.push({ part: "imports", text: `  imports   ${imports.join(", ")}` });
  const used = [];
  for (const s of syms) for (const c of callersOf(model, s).confident) if (c.sym.file !== rel) used.push(`${c.sym.file}:${c.line}`);
  const usedBy = [...new Set(used)].sort();
  if (usedBy.length < 5) for (const imp of importersOf(model, rel).sort()) if (!usedBy.some((u) => u.startsWith(imp + ":"))) usedBy.push(imp);
  if (usedBy.length) rows.push({ part: "used", text: `  used by   ${usedBy.slice(0, 5).join(" ")}` });
  const tests = packTestsOf(model, rel).slice(0, 3);
  if (tests.length) rows.push({ part: "tests", text: `  tests     ${tests.join(" ")}` });
  return { head, rows };
}

function outlineText(ol) {
  return ol
    .map((x) =>
      [
        x.head,
        ...x.rows.map((r) => {
          if (r.part !== "members") return r.text;
          const kept = r.members.filter((m) => m.keep);
          const gone = r.members.length - kept.length;
          return `  members   ${kept.map((m) => m.text).join(", ")}${gone ? `${kept.length ? ", " : ""}+${gone} members` : ""}`;
        }),
      ].join("\n")
    )
    .join("\n");
}

// §4: the first test file's own rows — describe / it / test names, and its
// top-level helpers — read from the working tree.
function testRows(model, rel) {
  const lines = fileLines(model, rel) || [];
  const out = [];
  for (let i = 0; i < lines.length && out.length < 12; i++) {
    const l = lines[i];
    const t = /^\s*(describe|it|test)(?:\.\w+)?\s*\(\s*(['"`])(.*?)\2/.exec(l);
    if (t) {
      out.push(`${t[1]} "${t[3]}" ${i + 1}`);
      continue;
    }
    const h = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(l);
    if (h) out.push(`${h[1] || h[2]}() ${i + 1}`);
  }
  return out;
}

// R2: the files whose `template` uses a child component (the `<Tag>` users).
// R2b: through RESOLVED edges first — the `<Owner>.template` symbols with a
// confident edge to the child's component class. The tag-name match is the
// fallback for a ref with no class symbol.
function templateParents(model, child) {
  const cls = ((model.byFile[child] || {}).symbols || []).find((x) => x.kind === "class" && !x.qname.includes("."));
  if (cls) {
    const files = callersOf(model, cls).confident.filter((c) => c.sym.kind === "template" && c.sym.file !== child && !TEST_FILE.test(c.sym.file)).map((c) => c.sym.file);
    return [...new Set(files)].sort();
  }
  const base = child.split("/").pop().replace(/\.(vue|svelte)$/, "");
  const kebab = base.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const out = [];
  for (const rel of [...model.fileSet].sort()) {
    if (rel === child || TEST_FILE.test(rel) || !/\.(vue|svelte)$/.test(rel)) continue;
    const syms = ((model.byFile[rel] || {}).symbols || []).filter((x) => x.kind === "template");
    if (syms.some((t) => (t.calls || []).some((c) => c.name === base || c.name === kebab))) out.push(rel);
  }
  return out;
}

// R3: the in-repo components a file's `template` uses — the resolved `ref`
// edges from `<Owner>.template` to another file's component class.
function templateChildren(model, rel) {
  const out = [];
  for (const t of ((model.byFile[rel] || {}).symbols || []).filter((x) => x.kind === "template")) {
    for (const { res } of calleesOf(model, t)) {
      if (!CONFIDENT.has(res.state)) continue;
      const s = model.symbols.get(res.target);
      if (s && s.kind === "class" && s.file !== rel && !TEST_FILE.test(s.file) && !out.includes(s.file)) out.push(s.file);
    }
  }
  return out;
}

// R3b: the CHILDREN of a component — the in-repo `.vue`/`.svelte` files it
// IMPORTS (resolved import edges) plus its template-tag edges. A dynamic
// `<component :is>` has no tags, so the imports are the only signal there.
function componentChildren(model, rel) {
  const f = model.byFile[rel] || {};
  const out = [];
  for (const t of [...new Set((f.imports || []).flatMap((imp) => importTargets(model, rel, f.lang, imp)))])
    if (/\.(vue|svelte)$/.test(t) && t !== rel && !TEST_FILE.test(t) && !out.includes(t)) out.push(t);
  for (const t of templateChildren(model, rel)) if (!out.includes(t)) out.push(t);
  return out;
}

// lorc 0.5.0 (W29b): the framework links of one file.
function linksOf(model, rel) {
  const syms = (model.byFile[rel] || {}).symbols || [];
  const store = [];
  const i18n = { count: 0, files: [], missing: [] };
  for (const s of syms) {
    for (const c of s.calls || []) {
      if (c.store) {
        const r = resolveCall(model, rel, s, c);
        const k = c.via ? constValue(model, rel, c.name) : c.name;
        store.push({ role: c.store, key: k == null ? c.name : k, line: c.line, state: r.state, ...(r.target ? { target: r.target } : {}) });
      } else if (c.i18n) {
        const r = resolveCall(model, rel, s, c);
        i18n.count++;
        if (r.state === "I18N" && !i18n.files.includes(r.file)) i18n.files.push(r.file);
        if (r.missing_i18n && !i18n.missing.includes(r.missing_i18n)) i18n.missing.push(r.missing_i18n);
      }
    }
  }
  const emits = syms
    .filter((s) => s.kind === "emit")
    .map((s) => ({
      name: s.name,
      line: s.lines ? s.lines[0] : null,
      listeners: callersOf(model, s).confident.filter((c) => c.listen).map((c) => ({ file: c.sym.file, line: c.line })),
    }));
  const firstLine = new Map();
  const cls = syms.find((x) => x.kind === "class" && !x.qname.includes("."));
  if (cls) for (const c of callersOf(model, cls).confident) if (!firstLine.has(c.sym.file) || c.line < firstLine.get(c.sym.file)) firstLine.set(c.sym.file, c.line);
  const parents = templateParents(model, rel).map((file) => ({ file, line: firstLine.has(file) ? firstLine.get(file) : null }));
  const fields = syms.filter((s) => s.kind === "field").map((s) => s.name);
  // W29c: global events, config keys and tables of the file's symbols.
  const events = [];
  const config = [];
  const tables = [];
  const eidx = eventIndex(model);
  for (const s of syms) {
    for (const c of s.calls || []) {
      if (c.event !== "emit" && c.event !== "on") continue;
      const name = eventName(model, rel, c);
      if (name == null) continue;
      const r = resolveCall(model, rel, s, c);
      const peers = c.event === "emit" ? (r.targets || []).length : (eidx.emit.get(name) || []).length;
      events.push({ name, kind: c.event, line: c.line, state: r.state, peers });
    }
    for (const e of s.effects || []) {
      if (!e) continue;
      if (e.type === "env" && typeof e.text === "string") {
        const r = resolveConfig(model, e.text);
        config.push({ key: e.text, line: e.line, ...(r.state === "CONFIG" ? { file: r.file, defLine: r.line } : {}) });
      }
      if (Array.isArray(e.tables)) {
        for (const t of e.tables) {
          const r = resolveTable(model, t);
          tables.push({ table: t, line: e.line, type: e.type, ...(r.file ? { file: r.file, defLine: r.line } : {}), ...(r.entity ? { entity: r.entity } : {}) });
        }
      }
    }
  }
  return { store, i18n, emits, parents, fields, events, config, tables };
}

function packExcerpt(model, ex, fresh) {
  const lines = fileLines(model, ex.file) || [];
  const to = Math.min(ex.b, ex.a + PACK_RANGE_LINES - 1);
  const ext = (ex.file.split(".").pop() || "").toLowerCase();
  const body = lines.slice(ex.a - 1, to).join("\n");
  const more = ex.b > to ? `\n… ${ex.b - to} more lines, read ${to + 1}-${ex.b}` : "";
  const changed = fresh !== "current" ? "  (CHANGED since index — lines may have moved)" : "";
  return `### ${ex.file}:${ex.a}-${ex.b} · ${ex.names.join(", ")}${changed}\n\`\`\`${LANG_FENCE[ext] || ext}\n${body}\n\`\`\`${more}`;
}

// R4: the spec closest to a file. By NAME first (`<Name>*.spec.*` /
// `<Name>*.test.*` under a tests folder), then a test that reaches it.
const PACK_SPEC_FILES = 2;
const PACK_SPEC_SETUP_LINES = 45;
function closestSpec(model, rel) {
  const name = rel.split("/").pop().replace(/\.[^.]+$/, "");
  const byName = [...model.fileSet]
    .filter((f) => /(^|\/)(tests?|__tests__)\//.test(f))
    .filter((f) => {
      const b = f.split("/").pop();
      return b.startsWith(name) && /\.(spec|test)\.[^.]+$/.test(b);
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (byName.length) return byName[0];
  return packTestsOf(model, rel)[0] || null;
}

// The end line of a block that opens on line `i` (0-based): bracket balance,
// strings stripped.
function blockEnd(lines, i) {
  let depth = 0;
  let opened = false;
  for (let k = i; k < lines.length; k++) {
    for (const ch of lines[k].replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "")) {
      if (ch === "{" || ch === "(" || ch === "[") {
        depth++;
        opened = true;
      } else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
    if (opened && depth <= 0) return k;
  }
  return i;
}

// The spec's top-level outline (helpers and `describe` blocks with ranges)
// and its SETUP quoted: line 1 through the end of the last top-level
// jest.mock / import / const / let before the first `describe`.
function specSetup(model, spec, rel) {
  const lines = fileLines(model, spec) || [];
  if (!lines.length) return null;
  const outline = [];
  let firstDescribe = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const d = /^describe(?:\.\w+)?\s*\(\s*(['"`])(.*?)\1/.exec(l);
    const h = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(l);
    if (d) {
      if (firstDescribe < 0) firstDescribe = i;
      const e = blockEnd(lines, i);
      outline.push(`describe "${d[2]}" ${i + 1}-${e + 1}`);
      i = e;
    } else if (h) {
      const e = blockEnd(lines, i);
      outline.push(`${h[1] || h[2]}() ${i + 1}-${e + 1}`);
      i = e;
    }
  }
  const stop = firstDescribe < 0 ? lines.length : firstDescribe;
  let last = -1;
  for (let i = 0; i < stop; i++) {
    if (!/^(jest\.mock\s*\(|import\b|const\b|let\b)/.test(lines[i])) continue;
    let e = i;
    if (/^import\b/.test(lines[i])) {
      while (e < stop - 1 && !/\bfrom\b|^import\s+['"]|;\s*$/.test(lines[e])) e++;
    } else e = blockEnd(lines, i);
    last = Math.max(i, e);
    i = last;
  }
  const head = `closest spec for ${rel.split("/").pop()}: ${spec} · ${lines.length} lines${outline.length ? ` — ${outline.join("; ")}` : ""}`;
  if (last < 0) return head;
  const to = Math.min(last + 1, PACK_SPEC_SETUP_LINES);
  const ext = (spec.split(".").pop() || "").toLowerCase();
  const more = last + 1 > to ? `\n… setup goes on to line ${last + 1}` : "";
  return `${head}\nsetup 1-${to}:\n\`\`\`${LANG_FENCE[ext] || ext}\n${lines.slice(0, to).join("\n")}\n\`\`\`${more}`;
}

// `opts`: { declared, refs (null = pick from the map), focus, budget, sliceCard }
function buildPack(claudeDir, model, opts) {
  const SIG = require("./graph-signals.js");
  const o = opts || {};
  const budget = Math.max(500, Math.min(12000, Number(o.budget) || PACK_QUOTE_BUDGET));
  const declared = [...new Set((o.declared || []).map(norm))];
  const known = declared.filter((r) => model.fileSet.has(r));
  const fresh = declared.filter((r) => !model.fileSet.has(r));
  const declaredSet = new Set(known);
  const focusList = (o.focus || []).filter(Boolean);

  // ── refs ──
  let refs = [];
  const refMissing = [];
  if (o.refs && o.refs.length) {
    for (const q of o.refs) {
      const r = resolveRef(model, q);
      if (r.candidates) return { ok: false, state: "ambiguous-target", query: String(q), candidates: r.candidates.map((file) => ({ file })), exit: 4 };
      if (r.missing) refMissing.push(r.missing);
      else if (!refs.includes(r.file)) refs.push(r.file);
    }
  } else {
    const m = graphMap(claudeDir, model, { focus: [...known, ...focusList], budget: 8000 });
    refs = (m.files || []).map((x) => x.file).filter((f) => !declaredSet.has(f) && !TEST_FILE.test(f)).slice(0, PACK_AUTO_REFS);
  }
  refs = refs.slice(0, PACK_MAX_REFS);
  // R3: the NEIGHBOURHOOD — outline only, never quoted. Ranked: children of
  // the given refs (two hops), their parents, FILE-NAME focus matches, then
  // the children of a declared component. Tests and files already present
  // are skipped; cap 12.
  const parents = [];
  const isSfc = (f) => /\.(vue|svelte)$/.test(f);
  const base = (f) => f.split("/").pop();
  const addNeigh = (file, tag) => {
    if (parents.length >= PACK_NEIGH_MAX || TEST_FILE.test(file) || refs.includes(file) || declaredSet.has(file) || parents.some((x) => x.file === file)) return false;
    parents.push({ file, tag });
    return true;
  };
  const addChildren = (rel) => {
    const got = [];
    for (const c of componentChildren(model, rel)) {
      if (got.length >= PACK_CHILDREN_PER_REF) break;
      if (addNeigh(c, `child of ${base(rel)}`)) got.push(c);
    }
    return got;
  };
  const hop1 = refs.filter(isSfc).flatMap((rel) => addChildren(rel));
  for (const c of hop1) addChildren(c);
  for (const rel of refs.filter(isSfc)) {
    let n = 0;
    for (const p of templateParents(model, rel)) if (n < PACK_PARENTS_PER_REF && addNeigh(p, `parent of ${base(rel)}`)) n++;
  }
  // R3b: name matches — the focus words found in the file's OWN name (no
  // folder, no extension). Tie-break: the number of files that import it.
  let multiHits = [];
  let fw = [...new Set(focusList.flatMap((w) => focusWords(w)).filter((w) => w.length >= 2))];
  if (fw.length && parents.length < PACK_NEIGH_MAX) {
    // R3c: each word weighs IDF_name = log(1 + N / n_word) over the FILE
    // NAMES of the indexed non-test files, so a word in dozens of names
    // weighs little. Ties: the number of files that import it.
    const ownWords = new Map();
    for (const rel of model.fileSet) if (!TEST_FILE.test(rel)) ownWords.set(rel, new Set(focusWords(base(rel).replace(/\.[^.]+$/, ""))));
    // R3d: a word in a DECLARED file's own name describes the target — it
    // only finds siblings, so it does not count.
    const declWords = new Set(known.flatMap((rel) => focusWords(base(rel).replace(/\.[^.]+$/, ""))));
    fw = fw.filter((w) => !declWords.has(w));
    const N = ownWords.size;
    const idf = new Map(fw.map((w) => [w, Math.log(1 + N / Math.max(1, [...ownWords.values()].filter((o) => [...o].some((seg) => wordMatch(w, seg))).length))]));
    const hits = [];
    for (const [rel, own] of ownWords) {
      if (declaredSet.has(rel) || refs.includes(rel)) continue;
      const words = fw.filter((w) => [...own].some((seg) => wordMatch(w, seg)));
      // R4: a file whose name holds several focus words is the likely
      // copy-from file: (sum of IDF) x (1 + 0.5 x (k - 1)), and k >= 2 always
      // ranks before any single-word hit.
      if (words.length) hits.push({ rel, words, score: words.reduce((a, w) => a + idf.get(w), 0) * (1 + 0.5 * (words.length - 1)), imp: importersOf(model, rel).length });
    }
    hits.sort((a, b) => (b.words.length >= 2) - (a.words.length >= 2) || b.score - a.score || b.imp - a.imp || a.rel.localeCompare(b.rel));
    multiHits = hits.filter((h) => h.words.length >= 2).map((h) => h.rel);
    let n = 0;
    for (const h of hits) {
      if (n >= PACK_NAME_REFS) break;
      if (addNeigh(h.rel, `name match: ${h.words.join(", ")} (${h.score.toFixed(2)})`)) n++;
    }
  }
  for (const rel of known.filter(isSfc)) addChildren(rel);
  warmFiles(model, new Set([...known, ...refs, ...parents.map((x) => x.file)]));

  // ── §3: the candidates, scored ──
  const want = new Set(focusList.flatMap((w) => focusWords(w)).filter((w) => w.length >= 2));
  const cands = new Map();
  for (const rel of refs) for (const s of model.byFile[rel].symbols || []) if (PACK_QUOTE_KINDS.has(s.kind)) cands.set(s.id, s);
  for (const s of [...cands.values()]) {
    for (const { res } of calleesOf(model, s)) {
      if (!CONFIDENT.has(res.state)) continue;
      const t = model.symbols.get(res.target);
      if (t && declaredSet.has(t.file) && !PACK_NEVER_QUOTE.has(t.kind)) cands.set(t.id, t);
    }
  }
  const called = new Set();
  for (const s of cands.values()) {
    for (const { res } of calleesOf(model, s)) if (CONFIDENT.has(res.state) && res.target !== s.id && cands.has(res.target)) called.add(res.target);
  }
  // R2: only a short helper (<= 30 lines) is quoted, whole; a member of a
  // big edit target (outlined in §1, read in full anyway) is never quoted.
  const bigSet = new Set(known.filter((rel) => (Number((model.byFile[rel] || {}).lines) || 0) > PACK_BIG_LINES));
  for (const [id, s] of [...cands]) if (s.lines[1] - s.lines[0] + 1 > PACK_QUOTE_MAX_LINES || bigSet.has(s.file)) cands.delete(id);
  const scored = [...cands.values()].map((s) => {
    const words = new Set(focusWords(s.qname));
    let score = 0;
    for (const w of want) if (words.has(w)) score += 3;
    if (called.has(s.id)) score += 2;
    if (s.exported || !/^[_#]/.test(s.name)) score += 1;
    const imp = SIG.importance(model, s, callersOf(model, s).confident.length);
    const relevance = score - (s.exported || !/^[_#]/.test(s.name) ? 1 : 0);
    return { s, score, imp, relevance };
  });
  scored.sort((a, b) => b.score - a.score || b.imp - a.imp || a.s.file.localeCompare(b.s.file) || a.s.lines[0] - b.s.lines[0]);
  // T6c: the quotes are SPREAD — round 1 takes the best candidate of EACH ref
  // file (in ref order), round 2 the second best, and so on. A file whose best
  // candidate has no focus word and no caller among the candidates gets its
  // single most important one, in round 1 only.
  const groupOrder = [...refs, ...known];
  const groups = groupOrder.map((rel) => {
    const g = scored.filter((x) => x.s.file === rel);
    if (g.length && g[0].relevance <= 0) return g.slice().sort((a, b) => b.imp - a.imp || a.s.lines[0] - b.s.lines[0]).slice(0, 1);
    return g;
  });
  const spread = [];
  for (let round = 0; groups.some((g) => g.length > round); round++) for (const g of groups) if (g[round]) spread.push(g[round]);

  // In score order until the budget is used. A range that overlaps one
  // already taken is MERGED into it; one that sits inside it is skipped.
  const chosen = [];
  let used = 0;
  let overBudget = 0;
  const costOf = (ex) => tok(packExcerpt(model, ex, blobState(model, ex.file))) + 1;
  for (const { s } of spread) {
    const a = s.lines[0];
    const b = s.lines[1];
    const over = chosen.filter((x) => x.file === s.file && x.a <= b && a <= x.b);
    if (over.some((x) => x.a <= a && b <= x.b)) continue;
    const merged = {
      file: s.file,
      a: Math.min(a, ...over.map((x) => x.a)),
      b: Math.max(b, ...over.map((x) => x.b)),
      names: [...over.flatMap((x) => x.names), s.qname],
    };
    merged.tokens = costOf(merged);
    const was = over.reduce((n, x) => n + x.tokens, 0);
    if (used - was + merged.tokens > budget) {
      overBudget++;
      continue;
    }
    for (const x of over) chosen.splice(chosen.indexOf(x), 1);
    chosen.push(merged);
    used += merged.tokens - was;
  }
  const order = new Map([...refs, ...known].map((f, i) => [f, i]));
  chosen.sort((x, y) => (order.get(x.file) || 0) - (order.get(y.file) || 0) || x.a - y.a);

  // ── §1, §2, §4 ── (T6c: three budgets, never traded)
  const big = known.filter((rel) => (Number((model.byFile[rel] || {}).lines) || 0) > PACK_BIG_LINES);
  const outlines1 = big.map((rel) => packOutline(model, rel, true, null, focusList));
  const outlines2 = [...refs.map((rel) => packOutline(model, rel, false)), ...parents.map((p) => packOutline(model, p.file, false, p.tag))];
  const outlineBudget = Math.max(200, Math.min(12000, Number(o.outlineBudget) || PACK_OUTLINE_BUDGET));
  const cut = [];
  // The OUTLINE budget: outlines are never cut for quotes. Over their own
  // budget, the SMALLEST members go first, and each row says `+<n> members`.
  const all = [...outlines1, ...outlines2];
  let outlineTok = tok(outlineText(all));
  if (outlineTok > outlineBudget) {
    // The members get what the fixed rows leave — but never less than 40 % of
    // the outline budget — shared EQUALLY by the files that have members, so
    // one long router outline cannot empty every other file's row. Inside a
    // file the largest members are kept and the smallest go first.
    const rowsWith = all.flatMap((x) => x.rows.filter((r) => r.part === "members"));
    const memberTok = rowsWith.reduce((a, r) => a + r.members.reduce((n, m) => n + Math.ceil((m.text.length + 2) / 4), 0), 0);
    const fixed = outlineTok - memberTok;
    const share = Math.floor(Math.max(outlineBudget - fixed, Math.ceil(outlineBudget * 0.4)) / Math.max(1, rowsWith.length));
    let dropped = 0;
    for (const r of rowsWith) {
      let used = 0;
      for (const m of r.members.slice().sort((a, b) => b.span - a.span)) {
        const c = Math.ceil((m.text.length + 2) / 4);
        if (used + c <= share) used += c;
        else {
          m.keep = false;
          dropped++;
        }
      }
    }
    if (dropped) cut.push(`§1/§2 ${dropped} smallest member(s) over the ${outlineBudget}-token outline budget`);
    // R2b: §1 and §2 outlines share ONE hard budget. Still over → route rows
    // past the first 10, then the smallest kept members, then the
    // imports / used-by / tests rows (last file first).
    let hard = 0;
    const over = () => tok(outlineText(all)) > outlineBudget;
    while (over()) {
      const rt = all.find((x) => x.rows.filter((r) => r.part === "routes" && !/^ {2}\+\d+ (?:other )?routes$/.test(r.text)).length > 10);
      if (rt) {
        const rows = rt.rows.filter((r) => r.part === "routes" && !/^ {2}\+\d+ (?:other )?routes$/.test(r.text));
        rt.rows.splice(rt.rows.indexOf(rows[rows.length - 1]), 1);
        const more = rt.rows.find((r) => r.part === "routes" && /^ {2}\+\d+ (?:other )?routes$/.test(r.text));
        if (more) more.text = `  +${Number(/\d+/.exec(more.text)[0]) + 1} other routes`;
        else rt.rows.splice(rt.rows.indexOf(rows[rows.length - 2]) + 1, 0, { part: "routes", text: "  +1 other routes" });
        hard++;
        continue;
      }
      const kept = all.flatMap((x) => x.rows.filter((r) => r.part === "members").flatMap((r) => r.members.filter((m) => m.keep)));
      if (kept.length) {
        kept.sort((a, b) => a.span - b.span)[0].keep = false;
        hard++;
        continue;
      }
      const opt = [...all].reverse().find((x) => x.rows.some((r) => ["imports", "used", "tests"].includes(r.part)));
      if (!opt) break;
      const i = opt.rows.map((r) => ["imports", "used", "tests"].includes(r.part)).lastIndexOf(true);
      opt.rows.splice(i, 1);
      hard++;
    }
    if (hard) cut.push(`§1/§2 ${hard} more row(s) or member(s) to keep the ${outlineBudget}-token outline budget`);
  }
  const testFiles = [...new Set([...known, ...refs].flatMap((rel) => packTestsOf(model, rel)))].sort();
  const quoted = chosen.map((ex) => packExcerpt(model, ex, blobState(model, ex.file)));
  const gen = model.meta.generation || 0;
  const nFiles = new Set([...declared, ...refs]).size;

  // R4: the CLOSEST spec's setup. For each given ref and each name match of
  // >= 2 words (max 2 files): its spec's top-level outline and the setup lines
  // (top of file through the last top-level jest.mock / import / const before
  // the first describe), max 45 lines.
  const specFor = [...(o.refs && o.refs.length ? refs : []), ...multiHits.filter((f) => parents.some((p) => p.file === f))].slice(0, PACK_SPEC_FILES);
  const specBlocks = [];
  const specSeen = new Set();
  for (const rel of specFor) {
    const spec = closestSpec(model, rel);
    if (!spec || specSeen.has(spec)) continue;
    specSeen.add(spec);
    const b = specSetup(model, spec, rel);
    if (b) specBlocks.push(b);
  }

  // The TESTS budget (700 tokens): rows go from the end.
  let testLines = [];
  if (testFiles.length) {
    const rows = testRows(model, testFiles[0]);
    testLines = [`${testFiles[0]}${rows.length ? ` — ${rows.join("; ")}` : ""}`, ...testFiles.slice(1, 5)];
    let n = 0;
    while (testLines.length > 1 && tok([...specBlocks, ...testLines].join("\n")) > PACK_TESTS_BUDGET) {
      testLines.pop();
      n++;
    }
    if (tok(testLines.join("\n")) > PACK_TESTS_BUDGET) {
      testLines = [testFiles[0]];
      n++;
    }
    if (n) cut.push(`§4 ${n} row(s) over the ${PACK_TESTS_BUDGET}-token tests budget`);
  }
  while (specBlocks.length && tok([...specBlocks, ...testLines].join("\n")) > PACK_TESTS_BUDGET) {
    specBlocks.pop();
    cut.push(`§4 a spec setup over the ${PACK_TESTS_BUDGET}-token tests budget`);
  }

  const parts = [
    `# graph pack · gen ${gen} · ${nFiles} files`,
    "Read this pack ALONE, with the Read tool, before anything else. It is a map: file outlines with line",
    "ranges, plus a few short helpers quoted whole. Then read ONLY the ranges you need, with Read",
    "offset/limit or `sed -n a,bp` — one range per member you need, never a whole file over 300 lines",
    "that the outline covers. A file you will EDIT: read it in full first (read-ladder exception 1).",
    "",
    "## 1. Files to change — outside view",
  ];
  // R2b: inside a pack the outside view gets at most ${PACK_SLICE_BUDGET} tokens in total.
  if (o.sliceCard) {
    const sc = known.length ? forSlice(model, known, { budget: PACK_SLICE_BUDGET }) : null;
    parts.push(sc && sc.ok ? sc.card : o.sliceCard);
  }
  if (outlines1.length) parts.push(outlineText(outlines1));
  if (fresh.length) parts.push(`new (no record yet): ${fresh.join(", ")}`);
  if (!o.sliceCard && !outlines1.length && !fresh.length) parts.push("(no declared file)");
  parts.push("", "## 2. Reference files — outline");
  parts.push(outlines2.length ? outlineText(outlines2) : "(no reference file)");
  if (refMissing.length) parts.push(`not in the graph: ${refMissing.join(", ")}`);
  parts.push("", "## 3. Quoted ranges");
  parts.push(quoted.length ? quoted.join("\n\n") : "(nothing quoted)");
  parts.push("", "## 4. Tests that reach these files");
  parts.push(testLines.length ? testLines.join("\n") : "(no test reaches these files)");
  if (specBlocks.length) parts.push("", specBlocks.join("\n\n"));
  let text = parts.join("\n");
  // §3 keeps to its own budget; a range the budget left out is named.
  if (overBudget) cut.push(`§3 ${overBudget} range(s) over the ${budget}-token quote budget`);
  if (cut.length) text += `\n\ncut: ${cut.join(", ")}`;
  text += "\n";
  return {
    ok: true,
    files: nFiles,
    refs,
    parents: parents.map((p) => ({ file: p.file, tag: p.tag })),
    refs_missing: refMissing,
    excerpts: chosen.length,
    quoted: chosen.map((x) => ({ file: x.file, from: x.a, to: x.b, names: x.names })),
    tokens: tok(text),
    cut,
    big_declared: big,
    budget,
    text,
  };
}

// ── v2.2.0 (R6): the executor ANCHORS ───────────────────────────────────────
// The pack file was read first but did not shorten the search: it STEERED the
// first calls toward the files it outlined, and it rode along every later
// turn. Turns, not bytes, drive cost. The anchors are the opposite shape: at
// most 12 `path:a-b` ranges INLINE in the slice, and ONE shell command that
// prints them all — one call, then the executor reads on from there.
//
// Never a whole file, never a test helper, ranked by focus score, overlapping
// ranges in one file merged. No file is written.
const ANCHOR_MAX = 12;
const ANCHOR_REF_MEMBERS = 3;
const ANCHOR_DECL_MEMBERS = 2;
const ANCHOR_RANGE_LINES = 80;
// v2.2.0 (R8): the card carries the code inline, so its cap follows the read cap.
const ANCHOR_CARD_BYTES = 11264;
// v2.2.0 (R7): five-line ranges were not enough to copy from; executors
// `cat` the whole file. Each range is padded, and the read is capped.
const ANCHOR_PAD = 6;
const ANCHOR_READ_TOKENS = 2500;
const ANCHOR_CALLERS = 6;
const ANCHOR_CALLER_PAD = 4;
const ANCHOR_CALLER_SCORE = 10;
// v2.2.0 (R10): the caller cap when a focus word names a declared export.
const ANCHOR_FOCUS_CALLERS = 8;
const ANCHOR_NEVER = new Set(["module", "template", "prop", "emit", "inject"]);
const SAFE_PATH = /^[A-Za-z0-9._@+\/-]+$/;

// v2.2.0: a declared file with this many route records is a ROUTER.
const ANCHOR_ROUTER_MIN = 10;
const ANCHOR_COMMENT_REACH = 15;
const QUOTED_PATH_COMMENT = /(\/\/|\/\*|^\s*\*).*['"`][^'"`\s]*\/[^'"`\s]*['"`]/;

// The top feature folder: the first segment after `src/views/`, else after `src/`.
function featureOf(rel) {
  const m = rel.match(/(?:^|\/)src\/views\/([^/]+)\//) || rel.match(/(?:^|\/)src\/([^/]+)\//);
  return m ? m[1] : "";
}

function anchorHits(want, s) {
  const words = focusWords(`${s.qname} ${s.route_name || ""}`);
  return [...want].filter((w) => words.some((seg) => wordMatch(w, seg)));
}

function anchorMembers(model, rel) {
  const f = model.byFile[rel] || {};
  const nLines = Number(f.lines) || (fileLines(model, rel) || []).length;
  const sfc = /\.(vue|svelte)$/.test(rel);
  return (f.symbols || []).filter((s) => {
    if (ANCHOR_NEVER.has(s.kind)) return false;
    if (sfc && s.kind === "class" && !s.qname.includes(".")) return false;
    const span = s.lines[1] - s.lines[0] + 1;
    return !(nLines && span >= Math.max(10, nLines * 0.9));
  });
}

// `opts`: { declared, refs (null = name match), focus }
function buildAnchors(claudeDir, model, opts) {
  const SIG = require("./graph-signals.js");
  const o = opts || {};
  const declared = [...new Set((o.declared || []).map(norm))];
  const known = declared.filter((r) => model.fileSet.has(r) && !TEST_FILE.test(r));
  const declaredSet = new Set(known);
  const focusList = (o.focus || []).filter(Boolean);
  const want = new Set(focusList.flatMap((w) => focusWords(w)).filter((w) => w.length >= 2));
  const base = (f) => f.split("/").pop();
  const tokens = new Set(focusList.flatMap((w) => String(w).split(/[\s,]+/)).map((w) => w.toLowerCase()).filter(Boolean));
  const focusCallees = [];
  for (const rel of known) {
    for (const s of (model.byFile[rel] || {}).symbols || []) {
      // R10b: CALLABLE only — a function or method, or an exported const with a
      // confident caller (an arrow helper). Never a class (a Vue SFC component).
      if (!s.exported || !(s.kind === "function" || s.kind === "method" || (s.kind === "const" && callersOf(model, s).confident.length))) continue;
      const nm = s.name || String(s.qname || "").split(".").pop();
      const nw = focusWords(nm);
      if (tokens.has(String(nm).toLowerCase()) || (nw.length >= 2 && nw.every((w) => [...want].some((x) => wordMatch(x, w))))) focusCallees.push({ rel, s, nm });
    }
  }
  const focusMode = focusCallees.length > 0;

  // ── refs: given, else a name match of >= 2 focus words, else the best one ──
  let refs = [];
  const refMissing = [];
  if (o.refs && o.refs.length) {
    for (const q of o.refs) {
      const r = resolveRef(model, q);
      if (r.candidates) return { ok: false, state: "ambiguous-target", query: String(q), candidates: r.candidates.map((file) => ({ file })), exit: 4 };
      if (r.missing) refMissing.push(r.missing);
      else if (!refs.includes(r.file) && !TEST_FILE.test(r.file)) refs.push(r.file);
    }
  } else if (want.size && !focusMode) {
    // R10b: in focus mode the call sites are the work; no auto name-matched refs.
    const declWords = new Set(known.flatMap((rel) => focusWords(base(rel).replace(/\.[^.]+$/, ""))));
    const fw = [...want].filter((w) => !declWords.has(w));
    const hits = [];
    for (const rel of model.fileSet) {
      if (TEST_FILE.test(rel) || declaredSet.has(rel)) continue;
      const own = focusWords(base(rel).replace(/\.[^.]+$/, ""));
      const words = fw.filter((w) => own.some((seg) => wordMatch(w, seg)));
      if (words.length) hits.push({ rel, n: words.length, imp: importersOf(model, rel).length });
    }
    const featA = new Set(known.map(featureOf).filter(Boolean));
    const xf = (rel) => (featA.has(featureOf(rel)) ? 0 : 1);
    hits.sort((a, b) => xf(a.rel) - xf(b.rel) || b.n - a.n || b.imp - a.imp || a.rel.localeCompare(b.rel));
    const multi = hits.filter((h) => h.n >= 2).map((h) => h.rel);
    refs = multi.length ? multi.slice(0, PACK_AUTO_REFS) : hits.slice(0, 1).map((h) => h.rel);
  }
  refs = refs.slice(0, PACK_MAX_REFS);
  warmFiles(model, new Set([...known, ...refs]));

  // ── candidates ──
  const cands = [];
  const add = (s, score, why) => {
    const a = s.lines[0];
    const b = Math.min(s.lines[1], a + ANCHOR_RANGE_LINES - 1);
    cands.push({ file: s.file, a, b, names: [s.kind === "route" && !/^VIEW\b/.test(s.qname) ? `VIEW ${s.qname}` : s.qname], score, why: [why] });
  };
  // v2.2.0: a ROUTER edit target always gives the route record nearest the
  // change, plus any comment within reach that quotes a path.
  for (const rel of known) {
    const routes = ((model.byFile[rel] || {}).symbols || []).filter((x) => x.kind === "route");
    if (routes.length < ANCHOR_ROUTER_MIN) continue;
    const best = routes
      .map((r) => ({ r, n: anchorHits(want, r).length }))
      .sort((x, y) => y.n - x.n || x.r.lines[0] - y.r.lines[0])[0].r;
    const src = fileLines(model, rel) || [];
    let a = Math.max(1, best.lines[0] - ANCHOR_PAD);
    let b = Math.min(src.length || best.lines[1], best.lines[1] + ANCHOR_PAD);
    const lo = Math.max(1, best.lines[0] - ANCHOR_COMMENT_REACH);
    const hi = Math.min(src.length, best.lines[1] + ANCHOR_COMMENT_REACH);
    for (let i = lo; i <= hi; i++) {
      if (QUOTED_PATH_COMMENT.test(src[i - 1] || "")) { a = Math.min(a, i); b = Math.max(b, i); }
    }
    const hits = anchorHits(want, best);
    cands.push({ file: rel, a, b, names: [/^VIEW\b/.test(best.qname) ? best.qname : `VIEW ${best.qname}`], score: 1000, why: [`router: ${hits.length ? hits.join(", ") : "nearest route"}`], fixed: true });
  }
  for (const rel of focusMode ? [] : known) {
    // R10b: in focus mode the call sites ARE the edit targets — no generic member scan.
    if ((Number((model.byFile[rel] || {}).lines) || 0) <= PACK_BIG_LINES) continue;
    const scored = anchorMembers(model, rel)
      .map((s) => ({ s, hits: anchorHits(want, s) }))
      .filter((x) => x.hits.length)
      .sort((x, y) => y.hits.length - x.hits.length || (x.s.kind === "route") - (y.s.kind === "route") || x.s.lines[0] - y.s.lines[0]);
    for (const { s, hits } of scored.slice(0, ANCHOR_DECL_MEMBERS)) add(s, hits.length * 3 + 1, `edit target: ${hits.join(", ")}`);
  }
  // v2.2.0: a declared file's exported symbols called from OTHER files give up
  // to 6 CALLER anchors (the call line +-4, inside the caller's own symbol) —
  // the edit sites of a signature change. Ranked by focus words, then file.
  // v2.2.0 (R10): FOCUS CALLEES — an export of a declared file whose name IS a
  // focus token, or whose >= 2 name words are all focus words. When one exists,
  // only its callers count, declared files INCLUDED (those are the call sites a
  // signature change edits), up to 8, above every edit-target hit, and its own
  // definition comes first. With none, the rule above holds unchanged.
  for (const { rel, s, nm } of focusCallees) {
    const a = s.lines[0];
    cands.push({ file: rel, a, b: Math.min(s.lines[1], a + ANCHOR_RANGE_LINES - 1), names: [s.qname], score: ANCHOR_CALLER_SCORE + 30, why: [`edit target: ${nm}`], fixed: true });
  }
  const callerSrc = focusMode
    ? focusCallees.map((x) => ({ rel: x.rel, syms: [x.s] }))
    : known.map((rel) => ({ rel, syms: ((model.byFile[rel] || {}).symbols || []).filter((s) => s.exported && !ANCHOR_NEVER.has(s.kind) && s.kind !== "route") }));
  const callerC = [];
  for (const { rel, syms } of callerSrc) {
    for (const s of syms) {
      for (const c of callersOf(model, s).confident) {
        const cs = c.sym;
        if (!cs || !cs.file || cs.file === rel || (!focusMode && declaredSet.has(cs.file)) || TEST_FILE.test(cs.file) || !c.line) continue;
        const hits = anchorHits(want, cs).concat(focusWords(base(cs.file).replace(/\.[^.]+$/, "")).filter((w) => want.has(w)));
        const a = Math.max(1, cs.lines[0], c.line - ANCHOR_CALLER_PAD);
        const b = Math.min(cs.lines[1], c.line + ANCHOR_CALLER_PAD);
        callerC.push({ file: cs.file, a, b: Math.max(a, b), names: [cs.qname], score: ANCHOR_CALLER_SCORE + (focusMode ? 20 : 0) + new Set(hits).size, why: [`caller of ${s.qname}`], fixed: true });
      }
    }
  }
  callerC.sort((x, y) => y.score - x.score || x.file.localeCompare(y.file) || x.a - y.a);
  const callerSeen = new Set();
  for (const c of callerC) {
    const k = `${c.file}:${c.a}`;
    if (callerSeen.has(k) || callerSeen.size >= (focusMode ? ANCHOR_FOCUS_CALLERS : ANCHOR_CALLERS)) continue;
    callerSeen.add(k);
    cands.push(c);
  }
  const featD = new Set(known.map(featureOf).filter(Boolean));
  const given = new Set(o.refs && o.refs.length ? refs : []);
  for (const rel of refs) {
    // v2.2.0: a cross-feature copy-from ranks after a same-feature one, unless given.
    const pen = !given.has(rel) && featD.size && !featD.has(featureOf(rel)) ? 100 : 0;
    const scored = anchorMembers(model, rel)
      .map((s) => ({ s, hits: anchorHits(want, s), imp: SIG.importance(model, s, callersOf(model, s).confident.length) }))
      .sort((x, y) => y.hits.length - x.hits.length || y.imp - x.imp || x.s.lines[0] - y.s.lines[0]);
    for (const { s, hits } of scored.slice(0, ANCHOR_REF_MEMBERS)) add(s, hits.length * 3 - pen, hits.length ? `copy-from: ${hits.join(", ")}` : "copy-from");
    // v2.2.0 (R7): a .vue ref also gives its CONTRACT, the props/emits lines merged.
    if (/\.vue$/.test(rel)) {
      const con = ((model.byFile[rel] || {}).symbols || []).filter((x) => x.kind === "prop" || x.kind === "emit");
      if (con.length) {
        const a = Math.min(...con.map((x) => x.lines[0]));
        const b = Math.max(...con.map((x) => x.lines[1]));
        cands.push({ file: rel, a, b: Math.min(b, a + ANCHOR_RANGE_LINES - 1), names: ["props/emits"], score: 1 - pen, why: ["contract"] });
      }
    }
  }

  // v2.2.0 (R7): pad every range, clipped to the file and to its owner block.
  for (const c of cands) {
    if (c.fixed) continue;
    const f = model.byFile[c.file] || {};
    const n = Number(f.lines) || (fileLines(model, c.file) || []).length || c.b;
    let lo = 1;
    let hi = n;
    const owner = (f.symbols || [])
      .filter((x) => x.lines[0] <= c.a && x.lines[1] >= c.b && x.lines[1] - x.lines[0] > c.b - c.a)
      .sort((x, y) => (x.lines[1] - x.lines[0]) - (y.lines[1] - y.lines[0]))[0];
    if (owner) { lo = owner.lines[0]; hi = owner.lines[1]; }
    c.a = Math.max(1, lo, c.a - ANCHOR_PAD);
    c.b = Math.min(n, hi, c.b + ANCHOR_PAD);
    if (c.b < c.a) c.b = c.a;
  }

  // Rank, merge overlapping ranges in one file, then keep the best 12.
  cands.sort((x, y) => y.score - x.score || x.file.localeCompare(y.file) || x.a - y.a);
  let chosen = [];
  for (const c of cands) {
    if (!SAFE_PATH.test(c.file)) continue;
    const over = chosen.find((x) => x.file === c.file && x.a <= c.b && c.a <= x.b);
    if (over) {
      over.a = Math.min(over.a, c.a);
      over.b = Math.max(over.b, c.b);
      for (const n of c.names) if (!over.names.includes(n)) over.names.push(n);
      continue;
    }
    if (chosen.length < ANCHOR_MAX) chosen.push({ ...c });
  }
  const gen = model.meta.generation || 0;
  const inlineOf = (x) => /^(edit target|router|caller)/.test(x.why[0]);
  const render = (list) => {
    const lines = list.map((x) => {
      const changed = blobState(model, x.file) !== "current" ? ", CHANGED since index" : "";
      return `${x.file}:${x.a}-${x.b}  ${x.names.join(", ")}  (${x.why[0]}${changed})`;
    });
    const readCmd = list.length ? `for r in ${list.map((x) => `"${x.file} ${x.a} ${x.b}"`).join(" ")}; do set -- $r; echo "== $1:$2-$3"; sed -n "$2,$3p" "$1"; done` : "";
    // v2.2.0 (R8): the code of the EDIT-SITE ranges (edit target, router, caller)
    // INLINE — the same bytes `read all` prints. Copy-from and contract ranges stay
    // `path:a-b` lines: the executor reads those wider anyway.
    const code = list.filter(inlineOf).map((x) => `== ${x.file}:${x.a}-${x.b} · ${x.names[0]}\n${(fileLines(model, x.file) || []).slice(x.a - 1, x.b).join("\n")}`).join("\n");
    const ticks = Math.max(2, ...((code.match(/`+/g) || []).map((t) => t.length))) + 1;
    const fence = "`".repeat(ticks);
    const card = list.length ? `${lines.join("\n")}\nread all: ${readCmd}${code ? `\n${fence}\n${code}\n${fence}` : ""}` : "";
    return { lines, readCmd, code, card };
  };
  const readOf = (list) => list.filter(inlineOf).reduce((n, x) => n + tok((fileLines(model, x.file) || []).slice(x.a - 1, x.b).join("\n")), 0);
  while (chosen.length > 1 && readOf(chosen) > ANCHOR_READ_TOKENS) chosen = chosen.slice(0, -1);
  let out = render(chosen);
  while (chosen.length > 1 && Buffer.byteLength(out.card) > ANCHOR_CARD_BYTES) {
    chosen = chosen.slice(0, -1);
    out = render(chosen);
  }
  const files = new Set(chosen.map((x) => x.file)).size;
  const readTok = readOf(chosen);
  return {
    ok: true,
    refs,
    refs_missing: refMissing,
    ranges: chosen.length,
    files,
    lines: out.lines,
    read_cmd: out.readCmd,
    code: out.code,
    read_tokens: readTok,
    tokens: tok(out.card),
    card: out.card,
    gen,
  };
}

module.exports = { constValue, storeIndex, i18nIndex, i18nUsers, eventIndex, configIndex, configUsers, tableIndex, tableUsers, resolveConfig, resolveTable, linksOf, buildPack, buildAnchors, loadModel, resolveCall, resolveUrl, routeTable, urlIndex, findTarget, callersOf, nameHits, warmBlobs, ctx, forSlice, impact, graphMap, pathBetween, importsOf, TEST_FILE, SOURCE_DEFAULT, SOURCE_CAP, CALLERS_SOURCE_MAX, CALLERS_SOURCE_LINES };
