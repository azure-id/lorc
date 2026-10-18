"use strict";
// lorc owns this file since 0.4.0 (forked from ORC 2.3.0 @ ae47a4a, vendor/graph). Change it here, not in ORC.
// ── orc graph — the RESOLUTION CACHE (v1.8.0 EW2) ───────────────────────────
//
// W3 decided "resolution is computed on read, never stored". That was right for
// correctness and wrong for cost: on django/django ONE file card spent 437 ms
// working out who calls what, and `impact` up to 520 ms — every single time.
//
// EW2 measured what is worth storing, and the answer is narrower than the plan
// assumed. Two things were built, measured, and thrown away:
//
//   · the resolver's whole MEMO — 21.7 MB, ~120 ms to read and parse, to save
//     less than that. A net loss. Not stored.
//   · CLOSURE REPAIR (re-resolve only the changed file and its dependents) —
//     measured 2,669 ms against 2,695 ms for a plain full re-resolve on the
//     same one-line edit. **One percent.** On a JSON store the fixed costs
//     (change detection, loading the index, and rewriting the whole file) drown
//     the resolve, so an incremental resolve cannot pay. It was three
//     correctness bugs deep by the time the numbers came in, so it is gone.
//
// What IS stored is the REVERSE direction — who calls this symbol — which is
// the half the 437 ms walk was computing. 13 MB on django/django, and it turns
// a file card into 458 ms from 727 ms, and `impact` into 397 ms from 631 ms.
//
// The rules that keep W3's correctness:
//
//   1. `index.json` is still the only SOURCE. `resolved.json` is DERIVED, and
//      throwing it away costs speed and nothing else.
//   2. Only `update` writes it, inside the same lock. A reader never writes, so
//      readers stay lock-free.
//   3. A reader uses it ONLY when `resolved.generation === meta.generation`.
//      Any other answer — a crash between two writes, an older engine, a hand
//      deletion — falls back to computing on read. Stale is impossible: it is
//      not "probably fine", it is not used at all.
//   4. A cached answer must be BYTE-IDENTICAL to a computed one, order
//      included. `test/cli/graph-resolve.test.js` drives a seeded random edit
//      script and compares the two after every step.
//
// WHAT IS STORED
//
//   callers target symbol id → the confident callers of it, as
//           `[caller symbol id, line, state, kind, extra]`, where `kind` is
//           0 a call · 1 a function passed by name · 2 a URL · 3 an inherited
//           member (v1.8.2, schema 3) · 4 a store link (lorc 0.5.0, schema
//           5). `extra` is the URL text for 2, the alias name (`store` in
//           `store.list()`) for a call through an instance alias, and the
//           store role of the call for 4; absent otherwise.
//   maybe   target symbol id → how many AMBIGUOUS calls list this target, by
//           CALLER FILE. Per file, not per call site: 5 MB on django/django
//           instead of 45 MB, and the card only ever shows the total.
//
// FORMAT 2 (lorc 0.4.0, W19b): the cache is split in content-addressed
// buckets. `resolved/<bb>-<sha8>.json` holds the rows whose CALLER file is in
// bucket bb; `names/<bb>-<sha8>.json` holds the names in bucket bb; the map is
// `map-<sha8>.json`. `derived.json` lists them and is the commit point. A
// bucket with the same content keeps its name, so an update writes only the
// buckets that changed.

const fs = require("fs");
const path = require("path");
const G = require("./graph.js");

// 3 (v1.8.2 W1): ROUTE rows. A 1.8.1 cache is refused by the schema check and
// recomputed on read until the next `update` rewrites it — no answer changes.
// 5 (lorc 0.5.0 W29a): store rows (kind 4), and one row per target of a
// result with `targets`.
// 6 (lorc 0.5.0 W34c): impl rows (kind 8).
const RESOLVE_SCHEMA = 6;
const DERIVED_SCHEMA = 2;
const { CONFIDENT } = require("./graph-states.js");
const NAMES_PER_KEY = 5;

// Format 1 only (read for backward compatibility).
function resolvedPath(claudeDir) {
  return path.join(G.graphPaths(claudeDir).dir, "resolved.json");
}
function namesPath(claudeDir) {
  return path.join(G.graphPaths(claudeDir).dir, "names.json");
}

// Every map here is keyed by data from the repository — a bare symbol name can
// be `constructor`, `toString` or `__proto__`. A plain object would hand back
// `Object.prototype`'s member instead of "nothing here", so maps are built with
// a null prototype and read through this.
function own(o, k) {
  return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}
const bare = () => Object.create(null);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

// The caller FILE of a row: the file of the caller symbol.
function callerFile(model, id) {
  const s = model.symbols.get(id);
  if (s && s.file) return s.file;
  const i = String(id).indexOf("#");
  return i < 0 ? String(id) : String(id).slice(0, i);
}

// target → rows and target → [[file, n]], computed from the model. The SAME
// walk the reader does when no cache is there.
function computeCallers(model) {
  const Q = require("./graph-query.js");
  const callers = bare();
  const maybe = bare();
  const ambiguous = (r, rel) => {
    for (const cand of r.candidates || []) {
      const m = own(maybe, cand) || (maybe[cand] = bare());
      m[rel] = (own(m, rel) || 0) + 1;
    }
  };
  for (const [rel, f] of Object.entries(model.byFile)) {
    for (const s of f.symbols || []) {
      s.file = rel;
      for (const c of s.calls || []) {
        // lorc 0.5.0 (W34e): an i18n call resolves only to I18N (not CONFIDENT,
        // no `target`) or UNRESOLVED. It never makes a row, so do not resolve it.
        if (c.i18n) continue;
        const r = Q.resolveCall(model, rel, s, c);
        if (r.target && CONFIDENT.has(r.state)) {
          const kind = r.state === "EVENT" ? 7 : c.store ? 4 : c.listen ? 5 : c.prop ? 6 : c.ref ? 1 : r.inherited ? 3 : 0;
          for (const t of r.targets || [r.target]) {
            // lorc 0.5.0 (W34c): a row for a class that implements the target
            // interface member. Its state comes from the file of the impl.
            if (r.impl && t !== r.target) {
              (own(callers, t) || (callers[t] = [])).push([s.id, c.line, callerFile(model, t) === rel ? "LOCAL" : "IMPORT", 8, r.impl]);
              continue;
            }
            const row = [s.id, c.line, r.state, kind];
            if (kind === 0 && c.alias) row.push(c.alias);
            if (kind === 4) row.push(c.store);
            if (kind === 7) row.push(c.via ? Q.constValue(model, rel, c.name) : c.name);
            (own(callers, t) || (callers[t] = [])).push(row);
          }
        } else if (r.state === "AMBIGUOUS") ambiguous(r, rel);
      }
      // W1: the URLs this symbol sends, resolved to route symbols.
      for (const u of s.urls || []) {
        const r = Q.resolveUrl(model, u);
        if (r.state === "ROUTE") (own(callers, r.target) || (callers[r.target] = [])).push([s.id, u.line, "ROUTE", 2, `${u.method} ${u.url}`]);
        else if (r.state === "AMBIGUOUS") ambiguous(r, rel);
      }
    }
  }
  // One stable order, so the same tree always produces the same bytes.
  return { callers: sortedRows(callers), maybe: sortedCounts(maybe) };
}

// ── build ───────────────────────────────────────────────────────────────────
// Called by `graphUpdate` INSIDE the lock, after meta.json is on disk. It
// never throws into the update: a cache that cannot be written is a slower
// graph, not a broken one.
function build(claudeDir, root, index) {
  const t0 = Date.now();
  const p = G.graphPaths(claudeDir);
  const Q = require("./graph-query.js");
  try {
    // `noCache` matters: the writer must COMPUTE, never read back the cache it
    // is about to replace. `index` (S2) is the in-memory index of the update.
    const ph = G.phaser();
    const model = Q.loadModel(claudeDir, root, { noCache: true, index });
    if (!model) return { route: "skipped", reason: "no-index", ms: Date.now() - t0 };
    ph("d_model");
    const { callers, maybe } = computeCallers(model);
    ph("d_callers");

    // Resolved buckets, by the bucket of the CALLER file.
    const rb = bare();
    const slot = (bb) => rb[bb] || (rb[bb] = { callers: bare(), maybe: bare() });
    for (const [target, rows] of Object.entries(callers)) {
      for (const row of rows) {
        const o = slot(G.bucketOf(callerFile(model, row[0]))).callers;
        (own(o, target) || (o[target] = [])).push(row);
      }
    }
    for (const [target, pairs] of Object.entries(maybe)) {
      for (const [file, n] of pairs) {
        const o = slot(G.bucketOf(file)).maybe;
        (own(o, target) || (o[target] = bare()))[file] = n;
      }
    }
    const resolved = {};
    const haveResolved = G.namesIn(p.resolvedDir);
    for (const bb of Object.keys(rb).sort()) resolved[bb] = G.writeAddressed(p.resolvedDir, `${bb}-`, rb[bb], haveResolved);

    ph("d_resolved");
    const names = writeNames(p, model, callers);
    ph("d_names");
    // D4 (v1.8.2 W7): the ranked map is built HERE, from the callers object
    // this pass already holds.
    const map = require("./graph-map.js").build(claudeDir, model, callers);
    ph("d_map");

    // W19c: the previous lists. GC keeps their files for a reader that holds
    // the previous derived.json.
    const old = readJson(p.derived);
    const prev = old && old.generation !== model.meta.generation ? { resolved: old.resolved || {}, names: old.names || {}, map: old.map || null } : old && old.prev ? old.prev : null;
    const derived = {
      schema: DERIVED_SCHEMA,
      generation: model.meta.generation,
      gen_id: model.meta.gen_id,
      route: "full",
      resolved,
      names,
      map: map.name || null,
      ...(prev ? { prev } : {}),
    };
    G.atomicWrite(p.derived, JSON.stringify(derived, null, 2) + "\n");
    ph("d_write");
    return { route: "full", map, ms: Date.now() - t0, phases: ph.all };
  } catch (e) {
    // A cache is an optimisation. Losing it must never lose the update — and a
    // HALF-written one must never be read, so its commit point goes.
    try { fs.rmSync(p.derived, { force: true }); } catch (_) {}
    return { route: "failed", reason: String((e && e.message) || e), ms: Date.now() - t0 };
  }
}

function sortedObject(o) {
  const out = bare();
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}
// lorc 0.5.0 (W34e): one shared collator. Its `compare` gives the same order
// as `localeCompare` with no arguments, and it is faster.
const collate = new Intl.Collator().compare;
function byRow(a, b) {
  return collate(String(a[0]), String(b[0])) || a[1] - b[1];
}
function sortedRows(o) {
  const out = bare();
  for (const k of Object.keys(o).sort()) out[k] = o[k].slice().sort(byRow);
  return out;
}
// target → [[caller file, count], …], both levels in a stable order.
function sortedCounts(o) {
  const out = bare();
  for (const k of Object.keys(o).sort()) out[k] = Object.keys(o[k]).sort().map((f) => [f, o[k][f]]);
  return out;
}

// ── names buckets ───────────────────────────────────────────────────────────
// A bare name → the few symbols worth showing for it. The delivery hook reads
// ONE bucket: a name lookup, no index parse, no resolve.
function writeNames(p, model, callers) {
  const nb = bare();
  for (const [name, syms] of model.byName) {
    const rows = syms
      .map((s) => ({ s, fan: (own(callers, s.id) || []).length }))
      .sort((a, b) => b.fan - a.fan || collate(a.s.file, b.s.file))
      .slice(0, NAMES_PER_KEY)
      .map(({ s, fan }) => [s.qname, s.kind, s.file, s.lines[0], s.lines[1], fan]);
    if (!rows.length) continue;
    const bb = G.bucketOf(name);
    (nb[bb] || (nb[bb] = bare()))[name] = rows;
  }
  const out = {};
  const have = G.namesIn(p.namesDir);
  for (const bb of Object.keys(nb).sort()) out[bb] = G.writeAddressed(p.namesDir, `${bb}-`, { names: sortedObject(nb[bb]) }, have);
  return out;
}

// ── read ────────────────────────────────────────────────────────────────────
// derived.json, ONLY when it names this generation of meta.json.
function loadDerived(claudeDir, meta) {
  if (!meta || !meta.generation) return null;
  const d = readJson(G.graphPaths(claudeDir).derived);
  if (!d || d.schema !== DERIVED_SCHEMA || d.generation !== meta.generation) return null;
  return d;
}

// Used ONLY when the generation matches. Anything else returns null and the
// reader computes, exactly as it did before this file existed. The merged
// answer is the same bytes as a computed one: every target's rows are sorted
// with the order `build` uses, and so are the keys.
function load(claudeDir, meta) {
  if (!meta || !meta.generation) return null;
  if (G.isFormat1(meta)) {
    const r = readJson(resolvedPath(claudeDir));
    if (!r || r.schema !== RESOLVE_SCHEMA || r.engine !== meta.engine) return null;
    if (r.generation !== meta.generation) return null;
    return r;
  }
  const d = loadDerived(claudeDir, meta);
  if (!d) return null;
  const dir = G.graphPaths(claudeDir).resolvedDir;
  const callers = bare();
  const maybe = bare();
  for (const name of Object.values(d.resolved || {})) {
    const b = readJson(path.join(dir, name));
    if (!b || !b.callers || !b.maybe) return null;
    for (const [t, rows] of Object.entries(b.callers)) {
      const a = own(callers, t);
      if (a) a.push(...rows);
      else callers[t] = rows.slice();
    }
    for (const [t, files] of Object.entries(b.maybe)) {
      const m = own(maybe, t) || (maybe[t] = bare());
      for (const [f, n] of Object.entries(files)) m[f] = n;
    }
  }
  return { generation: d.generation, gen_id: d.gen_id, callers: sortedRows(callers), maybe: sortedCounts(maybe) };
}

module.exports = { own, RESOLVE_SCHEMA, DERIVED_SCHEMA, resolvedPath, namesPath, computeCallers, build, load, loadDerived };
