"use strict";
// lorc owns this file since 0.4.0 (forked from ORC 2.3.0 @ ae47a4a, vendor/graph). Change it here, not in ORC.
// ── orc graph (v1.8.0) — the code graph STORE ───────────────────────────────
//
// A small, local, git-ignored map of how this repository is connected. This
// file owns the store and change detection. Extraction is `graph-extract.js`;
// resolution and the read commands are `graph-query.js`. `bin/cli.js` routes
// `orc graph …` and resolves the config — no module here reads
// `.claude/orc.config.yaml`.
//
// THE RULES THIS FILE HOLDS
//
//   1. A change is found from git's OWN blob SHAs. `git ls-files -s` hashes
//      every tracked file in one call; `git status` names the dirty and
//      untracked ones, and `git hash-object` hashes only those. Nothing is
//      parsed to find out whether it changed. (W0: 42 ms for 7,091 files.)
//   2. The index is 64 CONTENT-ADDRESSED buckets (`index/<bb>-<sha8>.json`,
//      lorc 0.4.0 format 2). A 1-file update writes one bucket.
//   3. Writes are atomic (temp file + rename) and serialized by `.lock`.
//      Readers never take the lock: they see the old index or the new one.
//   4. The write ORDER is buckets → files.json → meta.json. A crash
//      between any two leaves files.json OLD, so the next status reads DRIFTED
//      and the next update redoes the work. Idempotent, never half-applied.
//   5. No background process and no timer, ever — a continuous rebuild is how
//      the graph tools in the research froze machines. EW3 adds two ONE-SHOT
//      triggers (a read that finds its own target stale, and an executor
//      finishing). Both take the lock below, and the loser SKIPS rather than
//      queues, so nothing can ever pile up.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const os = require("os");
const X = require("./graph-extract.js");

// lorc 0.4.0 (W19b): store FORMAT 2. The index is 64 content-addressed
// buckets, so a 1-file update writes one bucket, not the whole index. A format-1
// store (lorc <= 0.3.x, engine `graph@7`) stays readable, and the next update
// converts it in place.
const SCHEMA = 2;
const FORMAT = 2;
// The extractor version per language. A record keeps it as `xv` (no `xv` = 1).
// A record with another `xv` than this table is parsed again on the next update.
const EXTRACTORS = { js: 2, ts: 2, vue: 2, svelte: 2, i18n: 1, py: 1, go: 1, java: 1, cs: 1, php: 1, rb: 1, rs: 1, kt: 1, c: 1 };
const BUCKETS = 64;
// A file that no meta or derived file lists is deleted only when it is older
// than this. A reader that started before the update still finds its files.
const GRACE_MS = 10 * 60 * 1000;
const I18N = /(^|\/)(i18n|l10n|locales?|lang|langs|translations?)\/[^/]+\.json$/i;
// Bumped whenever the record shape or extraction changes. A record made by an
// older engine is re-extracted, and status reads DRIFTED until it is.
// @3 (W9): route symbols + `ref` edges — an older index re-extracts once.
// @4 (EW1): per-file COVERAGE and a GENERATION on the index.
// @5 (v1.8.2): `urls`, `mounts`, decorator routes with `handler`, `bases`,
//     aliases, re-exports. A 1.8.1 store reads DRIFTED with `engine_stale` and
//     the next preflight (`status --heal`) re-extracts every file once.
// @6 (v1.9.1 W5b, DE-15): an Options API object is a `class` with `method`
//     members (`mixins`/`extends` → `bases`), exported constants are `const`
//     symbols, and a `<script setup>` component is one `class`. No record FIELD
//     changed: a 1.9.0 store reads DRIFTED and the next `status --heal`
//     re-extracts once, the same path 1.8.1 → 1.8.2 took.
const ENGINE = "lgraph@1";
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const MAX_BYTES = 512 * 1024;
const LOCK_STALE_MS = 10 * 60 * 1000;
// Measured on this machine class: nestjs/nest 1.3 ms per file (heuristic),
// django/django 3.5 ms per file on 1.8.1 and 5.6 ms on 1.8.2 (Python ast +
// masking + the W1/W2 alias, decorator and re-export passes). The estimate
// uses the slower one — a first build that finishes early is fine, one that
// overruns its own estimate teaches people to ignore it.
const EST_MS_PER_FILE = 5.6;
const ESTIMATE_ABOVE = 2000;
// lorc 0.4.0 (W19c): parallel extraction. A batch of at least PARALLEL_MIN
// items is split over at most MAX_WORKERS worker threads. Env
// `LORC_GRAPH_WORKERS` (0 = off, n = max) and `LORC_GRAPH_PARALLEL_MIN`
// override both. `graphUpdate` stays synchronous.
const PARALLEL_MIN = 200;
const MAX_WORKERS = 4;
const WORKER_TIMEOUT_MS = 120 * 1000;

const LANG_BY_EXT = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js",
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".py": "py",
  ".go": "go",
  ".java": "java",
  ".cs": "cs",
  ".php": "php",
  // v1.8.2 W5 (G6) — the heuristic rung gains Ruby, Rust, Kotlin, the two
  // single-file component formats, and C/C++.
  ".rb": "rb", ".rake": "rb",
  ".rs": "rs",
  ".kt": "kt", ".kts": "kt",
  // A single-file component is its `<script>` block, parsed as js or ts. The
  // rest of the file is blanked, so every line number is the file's own.
  ".vue": "vue",
  ".svelte": "svelte",
  ".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".cxx": "c", ".hpp": "c", ".hh": "c",
};

// Never part of the map, whatever git says: ORC's own tree, installed or
// vendored dependencies (sometimes committed), build output, caches, minified
// or bundled JS, generated files, and `.d.ts` declarations (v1.8.2 W2 — a
// declaration file duplicates every symbol of its module and made each one
// AMBIGUOUS). `dist/` and `build/` are skipped at the ROOT only: `pkg/build/`
// is a package name in more than one real repository. A skipped path has no
// record, so `coverage` reports it `excluded`, never silently.
const ALWAYS_SKIP = /^(\.claude\/|dist\/|build\/|out\/|target\/(debug|release)\/)|(^|\/)(node_modules|vendor|__pycache__|\.next|\.nuxt|\.venv|venv|target\/classes)\/|\.(min|bundle|chunk)\.js$|\.d\.ts$|\.generated\.[A-Za-z]+$|\.pb\.go$|_pb2\.py$/;

function graphPaths(claudeDir) {
  const dir = path.join(claudeDir, "orc", "graph");
  return {
    dir,
    meta: path.join(dir, "meta.json"),
    files: path.join(dir, "files.json"),
    // format 1 only (read for backward compatibility, deleted on upgrade)
    index: path.join(dir, "index.json"),
    blobs: path.join(dir, "blobs"),
    // format 2
    indexDir: path.join(dir, "index"),
    resolvedDir: path.join(dir, "resolved"),
    namesDir: path.join(dir, "names"),
    derived: path.join(dir, "derived.json"),
    notes: path.join(dir, "notes.jsonl"),
    lock: path.join(dir, ".lock"),
  };
}

function globRe(g) {
  const raw = String(g).replace(/^\.\//, "");
  const esc = raw
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__GLOBSTAR__/g, ".*");
  // gitignore's rule (W2): a pattern with no slash matches at ANY depth
  // (`*.gen.ts`, `__snapshots__`); one with a slash is anchored at the root.
  const anchored = raw.replace(/\/$/, "").includes("/");
  return new RegExp("^" + (anchored ? "" : "(?:.*/)?") + esc + "(/|$)");
}

function makeFilter(ignore) {
  const res = (Array.isArray(ignore) ? ignore : []).filter(Boolean).map(globRe);
  return (rel) => {
    if (ALWAYS_SKIP.test(rel)) return null;
    if (res.some((re) => re.test(rel))) return null;
    if (I18N.test(rel)) return "i18n";
    return LANG_BY_EXT[path.extname(rel).toLowerCase()] || null;
  };
}

function git(root, args, input) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, input });
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

// W19c: memoised (pure on the string). The derived build asks once per row.
const BUCKET_OF = new Map();
function bucketOf(s) {
  const k = String(s);
  let bb = BUCKET_OF.get(k);
  if (bb === undefined) {
    bb = String(parseInt(sha1(k).slice(0, 4), 16) % BUCKETS).padStart(2, "0");
    if (BUCKET_OF.size > 200000) BUCKET_OF.clear();
    BUCKET_OF.set(k, bb);
  }
  return bb;
}

function xvOf(lang) {
  return EXTRACTORS[lang] || 1;
}

// A format-1 store: lorc <= 0.3.x or ORC (engine `graph@N`).
function isFormat1(meta) {
  return !!meta && (!meta.format || String(meta.engine || "").startsWith("graph@"));
}

// The file names in `dir` (an empty set when it does not exist). One listing
// replaces one `existsSync` per bucket (W19c).
function namesIn(dir) {
  try {
    return new Set(fs.readdirSync(dir));
  } catch (_) {
    return new Set();
  }
}

// Write one content-addressed file: `<prefix><sha8>.json` in `dir`. The name
// comes from the text, so a file with this name never changes. Write it only
// when it does not exist yet (`have`: the names in `dir`, from `namesIn`).
// Returns the file name.
function writeAddressed(dir, prefix, obj, have) {
  const text = JSON.stringify(obj);
  const name = `${prefix}${sha1(text).slice(0, 8)}.json`;
  const file = path.join(dir, name);
  if (have ? !have.has(name) : !fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(file, text);
  }
  return name;
}

// The SAME `{ schema, engine, by_file }` object for both formats. Format 2 reads
// every bucket that meta lists. A listed bucket that is missing returns null
// (the caller reads "no index"), after one retry with a new meta: an update
// that was committed while this read ran can have removed an old bucket.
function readIndex(claudeDir, meta) {
  const p = graphPaths(claudeDir);
  let m = meta || readJson(p.meta);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!m) return null;
    if (isFormat1(m)) return readJson(p.index);
    const byFile = {};
    let ok = true;
    for (const name of Object.values(m.index || {})) {
      const b = readJson(path.join(p.indexDir, name));
      if (!b || !b.files) { ok = false; break; }
      Object.assign(byFile, b.files);
    }
    if (ok) return { schema: m.schema, engine: m.engine, by_file: byFile };
    const again = readJson(p.meta);
    if (!again || again.generation === m.generation) return null;
    m = again;
  }
  return null;
}

// Windows can refuse a rename for a moment while another process has the
// target open (a reader mid-parse). A short retry is the whole remedy.
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 5 || (e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "EACCES")) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        throw e;
      }
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) {} // eslint-disable-line no-empty
    }
  }
}

// ── the lock ────────────────────────────────────────────────────────────────
function acquireLock(p) {
  fs.mkdirSync(p.dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p.lock, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: stamp(new Date()) }));
      fs.closeSync(fd);
      return { ok: true };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(p.lock).mtimeMs;
      } catch (_) {
        continue; // released between the open and the stat
      }
      // A writer that died leaves its lock behind. Ten minutes is far past any
      // real update (W0: 1.7 s for Django), so an older lock is a dead one.
      if (age > LOCK_STALE_MS) {
        try { fs.rmSync(p.lock, { force: true }); } catch (_) {}
        continue;
      }
      return { ok: false, holder: readJson(p.lock), age_ms: Math.round(age) };
    }
  }
  return { ok: false, holder: readJson(p.lock), age_ms: null };
}

function releaseLock(p) {
  try { fs.rmSync(p.lock, { force: true }); } catch (_) {}
}

// ── detection ───────────────────────────────────────────────────────────────
// W19c: each git process costs ~30-40 ms on Windows. When `root` is the top of
// a plain repository (or a worktree), the index entries and HEAD are read from
// the git files directly. Anything this reader does not know (split index,
// sparse index, reftable, GIT_DIR/GIT_INDEX_FILE in the environment, a bad
// checksum) returns null, and the caller asks git as before.
function gitDirOf(root) {
  if (process.env.GIT_DIR || process.env.GIT_INDEX_FILE || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return null;
  const dotGit = path.join(root, ".git");
  let st;
  try { st = fs.statSync(dotGit); } catch (_) { return null; }
  let dir = dotGit;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!m) return null;
    dir = path.resolve(root, m[1]);
  }
  let common = dir;
  try { common = path.resolve(dir, fs.readFileSync(path.join(dir, "commondir"), "utf8").trim()); } catch (_) {}
  return { dir, common };
}

// The entries of `.git/index` (versions 2-4) as "mode blob stage\tpath" fields.
function readGitIndex(g) {
  let buf;
  try { buf = fs.readFileSync(path.join(g.dir, "index")); } catch (_) { return null; }
  if (buf.length < 32 || buf.toString("latin1", 0, 4) !== "DIRC") return null;
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return null;
  const end = buf.length - 20;
  const sum = crypto.createHash("sha1").update(buf.subarray(0, end)).digest();
  if (!sum.equals(buf.subarray(end))) return null;
  const count = buf.readUInt32BE(8);
  const out = [];
  let p = 12;
  let prev = Buffer.alloc(0);
  for (let i = 0; i < count; i++) {
    if (p + 62 > end) return null;
    const mode = buf.readUInt32BE(p + 24);
    const blob = buf.toString("hex", p + 40, p + 60);
    const flags = buf.readUInt16BE(p + 60);
    // Fall back to git on a conflict stage, assume-valid, or any extended flag
    // (skip-worktree, intent-to-add): ls-files has its own rules for them.
    if (flags & 0x8000 || flags & 0x4000 || (flags >> 12) & 3) return null;
    let q = p + 62;
    let name;
    if (version === 4) {
      let c = buf[q++];
      let strip = c & 127;
      while (c & 128) {
        c = buf[q++];
        strip = ((strip + 1) << 7) | (c & 127);
      }
      const z = buf.indexOf(0, q);
      if (z < 0 || strip > prev.length) return null;
      name = Buffer.concat([prev.subarray(0, prev.length - strip), buf.subarray(q, z)]);
      p = z + 1;
    } else {
      const z = buf.indexOf(0, q);
      if (z < 0) return null;
      name = buf.subarray(q, z);
      p = p + (((q - p) + name.length + 8) & ~7);
    }
    prev = name;
    out.push({ mode: mode.toString(8).padStart(6, "0"), blob, stage: 0, rel: name.toString("utf8") });
  }
  if (out.length !== count) return null;
  // A split index or a sparse index holds entries elsewhere: ask git.
  while (p + 8 <= end) {
    const sig = buf.toString("latin1", p, p + 4);
    if (!INDEX_EXT_OK.has(sig)) return null;
    p += 8 + buf.readUInt32BE(p + 4);
  }
  if (p !== end) return null;
  return out;
}

// Index extensions that hold no entries: safe to skip.
const INDEX_EXT_OK = new Set(["TREE", "REUC", "UNTR", "FSMN", "EOIE", "IEOT"]);

// HEAD's commit, or undefined when the files do not say (the caller asks git).
function readGitHead(g) {
  try {
    const head = fs.readFileSync(path.join(g.dir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const m = /^ref:\s*(\S+)$/.exec(head);
    if (!m) return undefined;
    for (const d of [g.dir, g.common]) {
      try {
        const sha = fs.readFileSync(path.join(d, ...m[1].split("/")), "utf8").trim();
        if (/^[0-9a-f]{40}$/.test(sha)) return sha;
      } catch (_) {}
    }
    const packed = fs.readFileSync(path.join(g.common, "packed-refs"), "utf8");
    for (const line of packed.split(/\r?\n/)) {
      if (line.endsWith(" " + m[1]) && /^[0-9a-f]{40} /.test(line)) return line.slice(0, 40);
    }
  } catch (_) {}
  return undefined;
}

// Returns { ok, files: Map<rel, blob>, langs, head } or { ok:false, reason }.
function detect(root, opts) {
  const langOf = makeFilter(opts && opts.ignore);
  // `viaGit`: always ask git (the reference path; tests compare both).
  const g = opts && opts.viaGit ? null : gitDirOf(root);
  let entries = g ? readGitIndex(g) : null;
  if (!entries) {
    const ls = git(root, ["ls-files", "-s", "-z"]);
    if (ls.error || ls.status !== 0) return { ok: false, reason: "not-git" };
    entries = [];
    for (const rec of ls.stdout.split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const [mode, blob] = rec.slice(0, tab).split(" ");
      entries.push({ mode, blob, rel: rec.slice(tab + 1) });
    }
  }
  const files = new Map();
  const langs = new Map();
  for (const { mode, blob, rel } of entries) {
    if (mode === "160000") continue; // a submodule is another repository
    const lang = langOf(rel);
    if (!lang) continue;
    // A conflicted file lists up to three stages; the working tree decides
    // below, so the first stage seen is only a placeholder.
    if (!files.has(rel)) files.set(rel, blob);
    langs.set(rel, lang);
  }

  const st = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  if (st.error || st.status !== 0) return { ok: false, reason: "git-status-failed" };
  const hashMe = [];
  for (const rec of st.stdout.split("\0")) {
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const rel = rec.slice(3);
    const lang = langOf(rel);
    if (!lang) continue;
    if (y === "D") {
      files.delete(rel);
      langs.delete(rel);
      continue;
    }
    // `ls-files -s` already carries the STAGED content. Only a working-tree
    // difference (M, T, U, A with intent-to-add) or an untracked file needs its
    // own hash.
    if (x === "?" || x === "U" || y === "M" || y === "T" || y === "U" || y === "A") {
      hashMe.push(rel);
      langs.set(rel, lang);
    }
  }
  if (hashMe.length) {
    // No --no-filters on purpose: the clean filter (autocrlf on Windows) must
    // run, or every CRLF file would hash differently from its index blob and
    // read as changed forever.
    const h = git(root, ["hash-object", "--stdin-paths"], hashMe.join("\n") + "\n");
    if (h.error || h.status !== 0) return { ok: false, reason: "hash-object-failed" };
    const shas = h.stdout.split(/\r?\n/).filter(Boolean);
    hashMe.forEach((rel, i) => {
      if (shas[i]) files.set(rel, shas[i]);
    });
  }
  let headSha = g ? readGitHead(g) : undefined;
  if (headSha === undefined) {
    const head = git(root, ["rev-parse", "HEAD"]);
    headSha = head.status === 0 ? head.stdout.trim() : null;
  }
  return {
    ok: true,
    files,
    langs,
    head: headSha,
  };
}

function diffFiles(prev, cur) {
  const added = [];
  const changed = [];
  const deleted = [];
  for (const [rel, blob] of cur) {
    const was = prev[rel];
    if (!was) added.push(rel);
    else if (was.blob !== blob) changed.push(rel);
  }
  for (const rel of Object.keys(prev)) if (!cur.has(rel)) deleted.push(rel);
  return { added, changed, deleted };
}

// ── generation (EW1) ────────────────────────────────────────────────────────
// `generation` counts index-changing writes; `gen_id` names the CONTENT those
// writes produced. A reader compares the number (cheap) and a second store —
// the resolution cache — pins itself to it. Two machines that index the same
// tree get the same `gen_id` and different `generation` numbers, so the id is
// what a card may quote and the number is what a cache may compare.
function genId(filesOut) {
  const h = crypto.createHash("sha1");
  for (const rel of Object.keys(filesOut).sort()) h.update(`${rel}\u0000${(filesOut[rel] || {}).blob || ""}\u0000`);
  return h.digest("hex").slice(0, 8);
}

// What the extractor saw of ONE file, from the record it already wrote. A path
// with no record at all is `excluded` — git does not track it, an ignore glob
// dropped it, or the language has no extractor.
function coverageOf(entry) {
  if (!entry) return { coverage: "excluded" };
  if (entry.skipped) return { coverage: `skipped:${entry.skipped}` };
  if (entry.coverage === "partial") return { coverage: "partial", ranges: entry.partial || [] };
  return { coverage: "full" };
}

// ── density (v1.9.1 A1) ─────────────────────────────────────────────────────
// How many named symbols the parser found per file, and how many files it read
// as EMPTY. On the user's own project the graph held 1.9 symbols per file and
// most `ctx` calls answered exit 4 — and nothing said whether the code has no
// named functions or the parser did not read them. This field is what the
// status line and `orc graph audit` both answer from.
//
// `module` symbols are excluded, exactly as `meta.symbols` excludes them: a
// file's module record is not a thing anyone looks for.
function densityOf(index, files) {
  const byLang = Object.create(null);
  let symbols = 0;
  let zero = 0;
  let partial = 0;
  let skipped = 0;
  const entries = Object.entries((index && index.by_file) || {});
  for (const [rel, v] of entries) {
    const n = (v.symbols || []).filter((x) => x.kind !== "module").length;
    const lang = v.lang || LANG_BY_EXT[path.extname(rel).toLowerCase()] || "other";
    const l = byLang[lang] || (byLang[lang] = { files: 0, symbols: 0, zero: 0, partial: 0, skipped: 0 });
    l.files++;
    l.symbols += n;
    symbols += n;
    if (n === 0) {
      l.zero++;
      zero++;
    }
    if (v.coverage === "partial") {
      l.partial++;
      partial++;
    }
  }
  for (const [rel, v] of Object.entries(files || {})) {
    if (!v || !v.skipped) continue;
    skipped++;
    const lang = LANG_BY_EXT[path.extname(rel).toLowerCase()] || "other";
    const l = byLang[lang] || (byLang[lang] = { files: 0, symbols: 0, zero: 0, partial: 0, skipped: 0 });
    l.skipped++;
  }
  const n = entries.length;
  return {
    symbols_per_file: n ? Math.round((10 * symbols) / n) / 10 : 0,
    zero_files: zero,
    zero_share: n ? Math.round((100 * zero) / n) / 100 : 0,
    skipped,
    partial,
    by_lang: byLang,
  };
}

// ── status ──────────────────────────────────────────────────────────────────
// exit 0 FRESH · 1 NONE (or unavailable) · 2 DRIFTED · 3 OFF
function graphStatus(claudeDir, root, opts) {
  const p = graphPaths(claudeDir);
  const meta = readJson(p.meta);
  const prev = readJson(p.files);
  const base = {
    ok: true,
    enabled: !!opts.enabled,
    exists: !!(meta && prev),
    files: meta ? meta.files : 0,
    symbols: meta ? meta.symbols : 0,
    updated_at: meta ? meta.updated_at : null,
    head_commit: meta ? meta.head_commit : null,
    engine: meta ? meta.engine : null,
    format: meta ? (isFormat1(meta) ? 1 : meta.format) : null,
    generation: meta ? meta.generation || 0 : 0,
    gen_id: meta ? meta.gen_id || null : null,
  };
  if (!opts.enabled) return { ...base, state: "off", exit: 3 };
  if (!meta || !prev) return { ...base, state: "none", exit: 1 };
  const d = detect(root, opts);
  if (!d.ok) return { ...base, ok: false, state: "unavailable", reason: d.reason, exit: 1 };
  const diff = diffFiles(prev, d.files);
  const behind = { added: diff.added.length, changed: diff.changed.length, deleted: diff.deleted.length };
  // A format-1 store is READ as it is, but the next update converts it.
  if (isFormat1(meta)) {
    return { ...base, state: "drifted", behind, engine_stale: true, upgrade: { from: meta.engine || null, to: ENGINE }, exit: 2 };
  }
  // A record made by another extractor version is parsed again on the next update.
  let engineStale = meta.schema !== SCHEMA;
  for (const [rel, f] of Object.entries(prev)) {
    if (engineStale) break;
    if (f && d.files.has(rel) && (f.xv || 1) !== xvOf(d.langs.get(rel) || f.lang)) engineStale = true;
  }
  const n = behind.added + behind.changed + behind.deleted;
  if (n || engineStale) return { ...base, state: "drifted", behind, engine_stale: engineStale, exit: 2 };
  return { ...base, state: "fresh", behind, engine_stale: false, exit: 0 };
}

// The by_file entry of one record, as the index stores it.
function entryOf(record) {
  return {
    blob: record.blob,
    lang: record.lang,
    bytes: record.bytes || 0,
    lines: record.lines || 0,
    ...(record.skipped ? { skipped: record.skipped } : {}),
    ...(record.coverage && record.coverage !== "full" ? { coverage: record.coverage } : {}),
    ...(record.partial ? { partial: record.partial } : {}),
    imports: record.imports,
    symbols: record.symbols,
    ...(record.reexports ? { reexports: record.reexports } : {}),
    ...(record.keys ? { keys: record.keys } : {}),
    xv: record.xv,
  };
}

// Delete the format-1 files after the format-2 store is committed.
function dropFormat1(p) {
  for (const f of ["index.json", "resolved.json", "names.json", "wide.json", "map.json"]) {
    try { fs.rmSync(path.join(p.dir, f), { force: true }); } catch (_) {}
  }
  try { fs.rmSync(p.blobs, { recursive: true, force: true }); } catch (_) {}
  try {
    for (const name of fs.readdirSync(p.resolvedDir)) {
      if (/^[0-9a-f]{2}\.json$/.test(name)) fs.rmSync(path.join(p.resolvedDir, name), { force: true });
    }
  } catch (_) {}
}

// Phase timers (ms). The update result carries them when LORC_GRAPH_PHASES=1.
const PHASES = process.env.LORC_GRAPH_PHASES === "1";
function phaser() {
  let t = Date.now();
  const all = {};
  const mark = (k) => {
    const n = Date.now();
    all[k] = (all[k] || 0) + n - t;
    t = n;
    return all[k];
  };
  mark.all = all;
  return mark;
}

// ── parallel extraction (W19c) ──────────────────────────────────────────────
function envInt(name) {
  const v = process.env[name];
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// How many workers for `n` worker items. 0 = extract in this thread.
function workerCount(n) {
  const env = envInt("LORC_GRAPH_WORKERS");
  const min = envInt("LORC_GRAPH_PARALLEL_MIN");
  if (env === 0 || n < (min === null ? PARALLEL_MIN : Math.max(1, min))) return 0;
  if (env !== null) return Math.min(env, n);
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  const k = Math.min(MAX_WORKERS, cpus - 1, n);
  return k >= 2 ? k : 0;
}

// Split items in k chunks balanced by bytes: largest first, to the lightest chunk.
function chunksOf(items, k) {
  const chunks = Array.from({ length: k }, () => ({ bytes: 0, items: [] }));
  const sorted = items.slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0) || (a.rel < b.rel ? -1 : 1));
  for (const it of sorted) {
    let lo = chunks[0];
    for (const c of chunks) if (c.bytes < lo.bytes) lo = c;
    lo.items.push(it);
    lo.bytes += it.bytes || 0;
  }
  return chunks.filter((c) => c.items.length).map((c) => c.items);
}

// Start one worker on a chunk. The worker posts its result on `port`, then sets
// the flag and wakes this thread (the synckit pattern). null = no worker.
function startWorker(chunk, root) {
  try {
    const { Worker, MessageChannel } = require("worker_threads");
    const flag = new SharedArrayBuffer(4);
    const { port1, port2 } = new MessageChannel();
    const w = new Worker(path.join(__dirname, "extract-worker.js"), {
      workerData: { port: port2, flag, items: chunk, root },
      transferList: [port2],
    });
    w.on("error", () => {});
    w.unref();
    return { w, flag, port: port1 };
  } catch (_) {
    return null;
  }
}

// Wait for one worker. Its entries, or null on an error or a timeout.
function joinWorker(job) {
  if (!job) return null;
  const { receiveMessageOnPort } = require("worker_threads");
  try {
    const f = new Int32Array(job.flag);
    Atomics.wait(f, 0, 0, WORKER_TIMEOUT_MS);
    const m = receiveMessageOnPort(job.port);
    return m && m.message && m.message.ok ? m.message : null;
  } catch (_) {
    return null;
  } finally {
    try { job.port.close(); } catch (_) {}
    try { job.w.terminate(); } catch (_) {}
  }
}

// Extract every item. Returns { out: Map<rel, result>, workers, ms }. A worker
// that fails or times out has its chunk extracted here: never a failed update.
function extractAll(items, root) {
  const t0 = Date.now();
  const main = [];
  const rest = [];
  // i18n items take the fast key scan: cheap, but large in bytes, so they
  // would skew the byte balance. They stay here with py/go.
  for (const it of items) (it.lang === "py" || it.lang === "go" || it.lang === "i18n" ? main : rest).push(it);
  let k = workerCount(rest.length);
  if (k && X._findTypeScript(root) && !process.env.ORC_GRAPH_NO_BORROW) k = 0;
  if (!k) return { out: X.extractBatch(items, { root }), workers: 0, ms: Date.now() - t0 };
  const chunks = chunksOf(rest, k);
  const jobs = chunks.map((c) => startWorker(c, root));
  // This thread extracts py/go while the workers run.
  const out = main.length ? X.extractBatch(main, { root }) : new Map();
  const mainMs = Date.now() - t0;
  const each = [];
  chunks.forEach((c, i) => {
    const got = joinWorker(jobs[i]);
    if (got) for (const [rel, r] of got.entries) out.set(rel, r);
    else for (const [rel, r] of X.extractBatch(c, { root })) out.set(rel, r);
    each.push(got ? got.ms : -1);
  });
  return { out, workers: chunks.length, ms: Date.now() - t0, detail: `main ${mainMs} · workers ${each.join("/")}` };
}

// ── update ──────────────────────────────────────────────────────────────────
// exit 0 built/updated/upgraded/unchanged · 1 unavailable (not git, locked, io) · 3 off
//
// The write ORDER (format 2): index buckets → files.json → meta.json (the
// commit point) → derived buckets → derived.json (the commit point of the
// derived data) → GC. A bucket is content-addressed and never changes, so a
// reader that holds the old meta still reads the old buckets.
function graphUpdate(claudeDir, root, opts) {
  const t0 = Date.now();
  const ph = phaser();
  const say = opts.say || (() => {});
  if (!opts.enabled && opts.ifEnabled) return { ok: true, enabled: false, state: "off", exit: 3 };
  const p = graphPaths(claudeDir);
  const d = detect(root, opts);
  if (!d.ok) return { ok: false, enabled: !!opts.enabled, state: "unavailable", reason: d.reason, exit: 1 };
  ph("detect");

  const lock = acquireLock(p);
  if (!lock.ok) {
    return { ok: false, enabled: !!opts.enabled, state: "unavailable", reason: "locked", holder: lock.holder, age_ms: lock.age_ms, exit: 1 };
  }
  try {
    const prevMeta = readJson(p.meta);
    const prevFiles = readJson(p.files);
    const first = !prevMeta || !prevFiles;
    const migrate = !first && isFormat1(prevMeta);
    const prev = first ? {} : prevFiles;

    // The old records. A format-2 bucket that is missing leaves its files with
    // no record, and they are parsed again: that is how a crash heals.
    const oldNames = (!first && !migrate && prevMeta.index) || {};
    let oldBy = null;
    const readOld = () => {
      if (oldBy) return oldBy;
      oldBy = {};
      if (migrate) {
        const old = readJson(p.index);
        Object.assign(oldBy, (old && old.by_file) || {});
      } else if (!first) {
        for (const name of Object.values(oldNames)) {
          const b = readJson(path.join(p.indexDir, name));
          if (b && b.files) Object.assign(oldBy, b.files);
        }
      }
      return oldBy;
    };
    // The files to parse, from these records: a file with no record, another
    // blob or lang, or another extractor version.
    const workFrom = (recs, work) => {
      for (const [rel, blob] of d.files) {
        const rec = Object.prototype.hasOwnProperty.call(recs, rel) ? recs[rel] : null;
        const lang = d.langs.get(rel);
        if (!rec || rec.blob !== blob || rec.lang !== lang) work.add(rel);
        else if (migrate ? xvOf(lang) !== 1 : (rec.xv || 1) !== xvOf(lang)) work.add(rel);
      }
      return work;
    };
    const diff = diffFiles(prev, d.files);
    let work = new Set([...diff.added, ...diff.changed]);
    // W19c: a no-op update reads NO bucket. files.json carries blob, lang and
    // xv of every record, and each listed bucket must still be on disk. Any
    // other case reads the buckets and checks the records themselves.
    if (!first && !migrate && !work.size && !diff.deleted.length) {
      const have = namesIn(p.indexDir);
      if (Object.values(oldNames).every((n) => have.has(n))) workFrom(prev, work);
      else readOld();
    }
    if (oldBy || work.size || diff.deleted.length || first || migrate) work = workFrom(readOld(), work);
    ph("read_old");

    // Nothing to do: write NO file. Only a derived store that is not there
    // (a crash after meta.json) is written again.
    if (!first && !migrate && work.size === 0 && diff.deleted.length === 0) {
      const derived = readJson(p.derived);
      let route = { route: "unchanged", ms: 0 };
      if (!derived || derived.generation !== prevMeta.generation) {
        route = require("./graph-resolve.js").build(claudeDir, root, { schema: SCHEMA, engine: ENGINE, by_file: readOld() });
      }
      return {
        ok: true,
        enabled: !!opts.enabled,
        state: "unchanged",
        files: d.files.size,
        symbols: prevMeta.symbols || 0,
        generation: prevMeta.generation,
        gen_id: prevMeta.gen_id,
        route: route.route,
        ...(route.reason ? { route_reason: route.reason } : {}),
        added: 0,
        changed: 0,
        deleted: 0,
        parsed: 0,
        reused: 0,
        skipped: Object.values(prev).filter((f) => f && f.skipped).length,
        engine_upgrade: false,
        head_commit: d.head,
        ms: Date.now() - t0,
        ...(PHASES ? { phases: { ...ph.all, ...(route.phases || {}), noop: ph("noop") } } : {}),
        exit: 0,
      };
    }

    if (first && work.size > ESTIMATE_ABOVE) {
      say(`graph: building first index (~${work.size} files, est. ${Math.max(1, Math.round((work.size * EST_MS_PER_FILE) / 1000))} s)`);
    }

    // Phase 1 — read the files to parse.
    const records = new Map();
    const toExtract = [];
    for (const rel of work) {
      const blob = d.files.get(rel);
      const lang = d.langs.get(rel);
      const abs = path.join(root, ...rel.split("/"));
      try {
        const size = fs.statSync(abs).size;
        if (size > MAX_BYTES) records.set(rel, { blob, lang, bytes: size, skipped: "too-large", coverage: "skipped", imports: [], symbols: [], xv: xvOf(lang) });
        else toExtract.push({ rel, abs, lang, blob, bytes: size, src: fs.readFileSync(abs, "utf8") });
      } catch (_) {
        records.set(rel, { blob, lang, bytes: 0, skipped: "unreadable", coverage: "skipped", imports: [], symbols: [], xv: xvOf(lang) });
      }
    }

    ph("read_src");
    // Phase 2 — extract. py/go (borrowed child processes) and every item when
    // TypeScript is borrowed run here in ONE batch; the rest can go to workers.
    const ex = extractAll(toExtract, root);
    const out = ex.out;
    for (const it of toExtract) {
      const r = out.get(it.rel) || { extractor: X.HEURISTIC, imports: [], symbols: [] };
      records.set(it.rel, {
        blob: it.blob,
        lang: it.lang,
        bytes: it.bytes,
        lines: r.lines || 0,
        extractor: r.extractor,
        ...(r.error ? { skipped: r.error } : {}),
        coverage: r.error ? "skipped" : r.coverage || "full",
        ...(r.partial ? { partial: r.partial } : {}),
        imports: r.imports || [],
        symbols: r.symbols || [],
        ...(r.reexports ? { reexports: r.reexports } : {}),
        ...(r.keys ? { keys: r.keys } : {}),
        xv: xvOf(it.lang),
      });
    }

    ph("extract");
    // Phase 3 — the new by_file and files.json, in path order.
    const byFile = {};
    const filesOut = {};
    let skipped = 0;
    let reused = 0;
    for (const rel of [...d.files.keys()].sort()) {
      const record = records.get(rel);
      if (record) {
        byFile[rel] = entryOf(record);
        filesOut[rel] = {
          blob: record.blob,
          lang: record.lang,
          bytes: record.bytes,
          ...(record.lines ? { lines: record.lines } : {}),
          ...(record.extractor ? { extractor: record.extractor } : {}),
          ...(record.skipped ? { skipped: record.skipped } : {}),
          ...(record.coverage && record.coverage !== "full" ? { coverage: record.coverage } : {}),
          ...(record.partial ? { partial: record.partial } : {}),
          xv: record.xv,
        };
      } else {
        reused++;
        byFile[rel] = migrate ? { ...readOld()[rel], xv: 1 } : readOld()[rel];
        const was = prev[rel] || { blob: byFile[rel].blob, lang: byFile[rel].lang, bytes: byFile[rel].bytes };
        filesOut[rel] = { ...was, xv: byFile[rel].xv || 1 };
      }
      if (byFile[rel].skipped) skipped++;
    }

    ph("by_file");
    // Phase 4 — the index buckets. Only a bucket that holds a changed or a
    // deleted file is serialized again; the other buckets keep their names.
    const groups = {};
    for (const rel of Object.keys(byFile)) {
      const bb = bucketOf(rel);
      (groups[bb] || (groups[bb] = [])).push(rel);
    }
    const dirty = new Set();
    if (first || migrate) for (const bb of Object.keys(groups)) dirty.add(bb);
    for (const rel of work) dirty.add(bucketOf(rel));
    for (const rel of diff.deleted) dirty.add(bucketOf(rel));
    const indexNames = {};
    const haveIndex = namesIn(p.indexDir);
    for (const bb of Object.keys(groups).sort()) {
      if (!dirty.has(bb) && oldNames[bb]) {
        indexNames[bb] = oldNames[bb];
        continue;
      }
      const files = {};
      for (const rel of groups[bb].sort()) files[rel] = byFile[rel];
      indexNames[bb] = writeAddressed(p.indexDir, `${bb}-`, { schema: SCHEMA, files }, haveIndex);
    }
    const index = { schema: SCHEMA, engine: ENGINE, by_file: byFile };

    let symbols = 0;
    for (const v of Object.values(byFile)) symbols += (v.symbols || []).filter((s) => s.kind !== "module").length;

    ph("index_buckets");
    const meta = {
      schema: SCHEMA,
      format: FORMAT,
      engine: ENGINE,
      extractors: EXTRACTORS,
      head_commit: d.head,
      updated_at: stamp(new Date()),
      files: d.files.size,
      symbols,
      // The number goes up only when the index on disk changes, so a reader
      // that saw generation N is looking at exactly the index that wrote N.
      generation: ((prevMeta && prevMeta.generation) || 0) + 1,
      gen_id: genId(filesOut),
      // EW3: how long the last real update took, end to end. A COLD build
      // writes `build_ms` and leaves `update_ms` absent (G-13).
      ...(first ? {} : { update_ms: 0 }),
      ...(prevMeta && prevMeta.build_ms ? { build_ms: prevMeta.build_ms } : {}),
      density: densityOf(index, filesOut),
      index: indexNames,
      // W19c: the previous manifest. GC keeps its buckets, so a reader that
      // holds the previous meta still finds them.
      ...(!first && !migrate && prevMeta.index ? { prev_index: prevMeta.index } : {}),
    };
    atomicWrite(p.files, JSON.stringify(filesOut));
    atomicWrite(p.meta, JSON.stringify(meta, null, 2) + "\n");

    ph("meta");
    // Derived data, inside this same lock and AFTER meta.json. It is an
    // optimisation: a route of `failed` leaves the graph correct and slower.
    const resolveRoute = require("./graph-resolve.js").build(claudeDir, root, index);
    ph("derived");

    // EW3: stamp the duration (a second write of the same small file).
    if (first) meta.build_ms = Date.now() - t0;
    else meta.update_ms = Date.now() - t0;
    atomicWrite(p.meta, JSON.stringify(meta, null, 2) + "\n");

    if (migrate) dropFormat1(p);
    gcBuckets(p, GRACE_MS);
    ph("gc");

    return {
      ok: true,
      enabled: !!opts.enabled,
      state: first ? "built" : migrate ? "upgraded" : "updated",
      ...(migrate ? { from: prevMeta.engine || null } : {}),
      files: d.files.size,
      symbols,
      generation: meta.generation,
      gen_id: meta.gen_id,
      route: resolveRoute.route,
      ...(resolveRoute.reason ? { route_reason: resolveRoute.reason } : {}),
      added: diff.added.length,
      changed: diff.changed.length,
      deleted: diff.deleted.length,
      parsed: toExtract.length,
      workers: ex.workers,
      extract_ms: ex.ms,
      reused,
      skipped,
      engine_upgrade: migrate,
      head_commit: d.head,
      ms: Date.now() - t0,
      ...(PHASES ? { phases: { ...ph.all, ...(resolveRoute.phases || {}), ...(ex.detail ? { extract_detail: ex.detail } : {}) } } : {}),
      exit: 0,
    };
  } finally {
    releaseLock(p);
  }
}

// ── coverage ────────────────────────────────────────────────────────────────
// exit 0 always when a graph exists — a gap IS the answer, never an error.
// exit 1 no index · 3 off (with --if-enabled)
//
// It reads `files.json` (444 KB on django/django) and NEVER `index.json`
// (22 MB), because the only question is how much of each file was seen.
function graphCoverage(claudeDir, root, opts) {
  const p = graphPaths(claudeDir);
  const meta = readJson(p.meta);
  const files = readJson(p.files);
  if (!meta || !files) return { ok: false, state: "none", reason: "no-index", exit: 1 };
  const paths = (opts.paths || []).map((x) => String(x).split("\\").join("/").replace(/^\.\//, ""));
  // One `hash-object` for every path that is still on disk — the batch command
  // must not pay one git process per file.
  const onDisk = paths.filter((rel) => files[rel] && fs.existsSync(path.join(root, ...rel.split("/"))));
  const shas = new Map();
  if (onDisk.length) {
    const h = git(root, ["hash-object", "--stdin-paths"], onDisk.join("\n") + "\n");
    if (h.status === 0) {
      const out = h.stdout.split(/\r?\n/).filter(Boolean);
      onDisk.forEach((rel, i) => shas.set(rel, out[i]));
    }
  }
  const rows = [];
  for (const rel of paths) {
    const entry = files[rel];
    const c = coverageOf(entry);
    let changed = null;
    if (entry) {
      if (!fs.existsSync(path.join(root, ...rel.split("/")))) changed = "deleted";
      else if (!shas.has(rel)) changed = "unknown";
      else changed = shas.get(rel) === entry.blob ? "current" : "changed";
    }
    rows.push({ path: rel, ...c, changed_since_index: changed });
  }
  const gaps = rows.filter((r) => r.coverage !== "full").length;
  return {
    ok: true,
    state: "found",
    generation: meta.generation || 0,
    gen_id: meta.gen_id || null,
    rows,
    gaps,
    exit: 0,
  };
}

// ── gc ──────────────────────────────────────────────────────────────────────
// W19c: keep every bucket file and map file that the CURRENT or the PREVIOUS
// manifest lists (meta `index` + `prev_index`, derived.json lists + `prev`),
// and delete the rest at once, whatever its age. A reader that holds the
// previous meta still finds its files; an older reader re-reads meta once.
// A stray temp file is deleted only when it is older than `graceMs`. The
// caller holds the lock.
function gcBuckets(p, graceMs) {
  const meta = readJson(p.meta);
  const derived = readJson(p.derived);
  const listed = new Set();
  for (const idx of [meta && meta.index, meta && meta.prev_index]) {
    for (const n of Object.values(idx || {})) listed.add(path.join(p.indexDir, n));
  }
  for (const set of [derived, derived && derived.prev]) {
    if (!set) continue;
    for (const n of Object.values(set.resolved || {})) listed.add(path.join(p.resolvedDir, n));
    for (const n of Object.values(set.names || {})) listed.add(path.join(p.namesDir, n));
    if (set.map) listed.add(path.join(p.dir, set.map));
  }
  const now = Date.now();
  const tally = { removed: 0, kept: 0, bytes: 0 };
  const visit = (dir, match, grace) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (!match(name)) continue;
      const full = path.join(dir, name);
      if (listed.has(full)) { tally.kept++; continue; }
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || (grace && now - st.mtimeMs < graceMs)) { tally.kept++; continue; }
        fs.rmSync(full, { force: true });
        tally.bytes += st.size;
        tally.removed++;
      } catch (_) {}
    }
  };
  const bucket = (name) => /^\d{2}-[0-9a-f]{8}\.json$/.test(name);
  const tmp = (name) => name.endsWith(".tmp");
  for (const dir of [p.indexDir, p.resolvedDir, p.namesDir]) {
    visit(dir, bucket, false);
    visit(dir, tmp, true);
  }
  visit(p.dir, (name) => /^map-[0-9a-f]{8}\.json$/.test(name), false);
  visit(p.dir, tmp, true);
  return tally;
}

// exit 0 done · 1 none or locked
function graphGc(claudeDir, opts) {
  const graceMs = opts && Number.isFinite(Number(opts.graceMs)) ? Number(opts.graceMs) : GRACE_MS;
  const p = graphPaths(claudeDir);
  const files = readJson(p.files);
  if (!files) return { ok: false, state: "none", reason: "no-index", exit: 1 };
  const lock = acquireLock(p);
  if (!lock.ok) return { ok: false, state: "unavailable", reason: "locked", holder: lock.holder, exit: 1 };
  try {
    const t = gcBuckets(p, graceMs);
    // A temp file left by a writer that died mid-write.
    for (const name of fs.readdirSync(p.dir)) {
      if (name.endsWith(".tmp")) {
        try { fs.rmSync(path.join(p.dir, name), { force: true }); } catch (_) {}
      }
    }
    // Compact the notes ledger in the same locked pass: the latest note per
    // symbol whose body still hashes the same, and nothing else.
    const notes = require("./graph-notes.js").compactNotes(p, readIndex(claudeDir), atomicWrite);
    // K1 (v1.8.2 W4b): the gain ledger is capped in the same locked pass.
    const gain = require("./graph-gain.js").compact(p, atomicWrite);
    return { ok: true, state: "done", removed: t.removed, kept: t.kept, bytes_freed: t.bytes, notes, gain, exit: 0 };
  } finally {
    releaseLock(p);
  }
}

module.exports = {
  SCHEMA,
  FORMAT,
  ENGINE,
  EXTRACTORS,
  BUCKETS,
  GRACE_MS,
  LANG_BY_EXT,
  graphPaths,
  bucketOf,
  xvOf,
  isFormat1,
  writeAddressed,
  namesIn,
  _gitDirOf: gitDirOf,
  _readGitIndex: readGitIndex,
  readIndex,
  readJson,
  detect,
  diffFiles,
  graphStatus,
  graphUpdate,
  graphCoverage,
  coverageOf,
  densityOf,
  genId,
  graphGc,
  // shared with graph-notes.js — one lock, one atomic writer, one date format
  acquireLock,
  releaseLock,
  atomicWrite,
  stamp,
  phaser,
};
