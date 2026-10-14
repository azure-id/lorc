"use strict";
// lorc tier — history signals. The repo's git log gives co-change partners (files
// that changed together before; Zimmermann et al., "Mining version histories", 2004)
// and similar past commits (median size). lorc's own finished runs give the tiers and
// sizes of similar requests. The git part is cached by HEAD in .claude/lorc/tier/.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths.js");

const MAX_COMMITS = 1500;
const CACHE_V = 3;
// A commit with more files is a mass change (format, rename, vendor drop): left out.
const BIG = 60;
// Every language lorc's graph reads (JS/TS, Python, Go, Java, Kotlin, C#, PHP, Ruby, Rust, C)
// plus Swift, Dart, Scala and Elixir: lock files, generated code, tests and string tables.
const NOISE = new RegExp([
  "(^|/)(package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb|Cargo\\.lock|poetry\\.lock|Pipfile\\.lock|uv\\.lock|go\\.sum|composer\\.lock|Gemfile\\.lock|mix\\.lock|pubspec\\.lock|Podfile\\.lock|Package\\.resolved|packages\\.lock\\.json|gradle\\.lockfile|flake\\.lock)$",
  "(^|/)(dist|build|coverage|node_modules|\\.next|out|target|vendor|\\.claude|Pods|\\.gradle|obj|__pycache__)/|(^|/)bin/(Debug|Release)/",
  "\\.min\\.(js|css)$|\\.map$|__snapshots__/|\\.pb\\.go$|_pb2(_grpc)?\\.pyi?$|\\.g\\.dart$|\\.freezed\\.dart$|\\.generated\\.\\w+$|\\.[Dd]esigner\\.cs$",
].join("|"), "i");
const TEST = new RegExp([
  "(^|/)(tests?|__tests__|specs?|e2e|cypress|androidTest|testing)/|(^|/)[^/]+\\.Tests?/",
  "\\.(test|spec|e2e)\\.[cm]?[jt]sx?$|_test\\.(go|py|rs|c|cc|cpp|dart|exs|lua)$|(^|/)test_[^/]*\\.(py|c|cc|cpp)$",
  "(Tests?|Spec)\\.(java|cs|kt|kts|swift|scala|groovy|php)$|_(spec|test)\\.rb$|_spec\\.lua$",
].join("|"));
const LOCALE = new RegExp([
  "(^|/)(i18n|l10n|locales?|lang|langs|translations?)/.*\\.(json|ya?ml|po|properties|xlf|xliff|arb|js|ts|ftl)$",
  "\\.(po|xlf|xliff|arb|resx|ftl|stringsdict)$|\\.lproj/[^/]+\\.strings$|(^|/)res/values(-[\\w-]+)?/strings\\.xml$|(^|/)messages(_[\\w-]+)?\\.properties$",
].join("|"), "i");
const DOC = /\.(md|mdx|rst|txt|adoc)$|(^|\/)(LICENSE|CHANGELOG|AUTHORS|NOTICE)[^/]*$/i;
const STOP = new Set(("the and for with from into onto this that these those are was were has have had not but can should " +
  "would could will please make when then than also just all any some our your their its out off one two use using via " +
  "feat fix fixes fixed chore docs doc refactor test tests style perf build merge wip update updates updated add adds added " +
  "change changes changed new remove removed lorc " +
  // Indonesian function words and request verbs.
  "yang dan atau di ke dari untuk dengan pada ini itu akan tidak juga dalam adalah sebagai oleh agar supaya bisa dapat " +
  "harus perlu saat ketika jika kalau setelah sebelum sudah belum ada nya pun lah serta tanpa hanya masih lagi " +
  "tambah tambahkan menambah menambahkan buat buatkan membuat bikin ubah mengubah ganti mengganti perbaiki memperbaiki " +
  "hapus menghapus baru semua setiap seluruh tolong mohon").split(" "));

const kindOf = (f) => (NOISE.test(f) ? "noise" : TEST.test(f) ? "test" : LOCALE.test(f) ? "locale" : DOC.test(f) ? "doc" : "src");
const isSrc = (f) => kindOf(f) === "src";

function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("es") && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}

// Content words, stemmed. CamelCase and snake_case are split into their parts.
function bag(text) {
  const out = new Set();
  const s = String(text || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  for (const w of s.split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(stem(w));
  }
  return out;
}

// Set cosine: shared / sqrt(|a| · |b|). Both sides must match, so a long request does
// not pair with every short subject that shares two words. Two shared words at least.
function overlap(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  if (shared < 2) return { shared, score: 0 };
  return { shared, score: shared / Math.sqrt(a.size * b.size) };
}

function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function git(root, args, timeout = 20000) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? String(r.stdout || "") : null;
}

function cacheFile(root) { return path.join(paths.projectLorcDir(root), "tier", "git.json"); }

// `git log --name-status` blocks → [{ h, s, files, a, m }]: a / m = added / modified source files.
// A line without a tab (plain --name-only) counts as modified.
// A merge's own subject ("Merge pull request #12 from org/fix-payout") says little: the PR
// title is the body's first line. Keep the branch words too.
function unitSubject(s, body) {
  const m = /^Merge (pull request #\d+ from \S+|branch '([^']+)'|remote-tracking branch)/i.exec(s || "");
  if (!m) return s || "";
  const title = String(body || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  const branch = (/from \S+?\/(\S+)$/.exec(s) || [])[1] || m[2] || "";
  return [title, branch.replace(/[/_-]+/g, " ")].filter(Boolean).join(" · ");
}

// Blocks of `--format=%x1e%H%x1f%s%x1f%b%x1d` + `--name-status` (the %b part and \x1d are optional).
function parseLog(text) {
  const commits = [];
  for (const block of String(text || "").split("\x1e")) {
    if (!block.trim()) continue;
    const cut = block.indexOf("\x1d");
    const head = cut >= 0 ? block.slice(0, cut) : block.split(/\r?\n/)[0];
    const rest = cut >= 0 ? block.slice(cut + 1) : block.split(/\r?\n/).slice(1).join("\n");
    const [h, s0, body] = head.split("\x1f");
    const s = unitSubject(s0, body);
    const lines = [""].concat(rest.split(/\r?\n/));
    const files = [];
    let a = 0;
    let m = 0;
    for (const l of lines.slice(1)) {
      const t = l.trim();
      if (!t) continue;
      const parts = t.split("\t");
      const status = parts.length > 1 ? parts[0][0] : "M";
      const f = parts[parts.length - 1].replace(/\\/g, "/");
      if (!f || NOISE.test(f) || status === "D") continue;
      files.push(f);
      if (isSrc(f)) { if (status === "A" || status === "C") a++; else m++; }
    }
    commits.push({ h: String(h || "").slice(0, 10), s: String(s || ""), files, a, m });
  }
  return commits;
}

// The last MAX_COMMITS non-merge commits: [{ h, s, files }]. null when this is not a git repo.
// The cache stores each path once (a file table) and is rebuilt when HEAD moves.
function commits(root, { max = MAX_COMMITS, cache = true } = {}) {
  const head = (git(root, ["rev-parse", "HEAD"], 5000) || "").trim();
  if (!head) return null;
  const file = cacheFile(root);
  if (cache) {
    const c = paths.readJson(file, null);
    if (c && c.v === CACHE_V && c.head === head && c.max === max && Array.isArray(c.files) && Array.isArray(c.commits)) {
      return c.commits.map(([h, s, idx, a, m]) => ({ h, s, files: idx.map((i) => c.files[i]), a, m }));
    }
  }
  // The units that LANDED on the main line: a squash or direct commit, or a whole merged PR
  // (first parent, -m: the merge's diff against main = every file of the PR). Commits inside
  // a PR branch are not units: they would split one feature into pieces.
  const log = git(root, ["log", "--first-parent", "-m", "--name-status", "--no-renames", "-n", String(max), "--format=%x1e%H%x1f%s%x1f%b%x1d"]);
  if (log === null) return null;
  const list = parseLog(log);
  if (cache) {
    const table = [];
    const idOf = new Map();
    const id = (f) => { if (!idOf.has(f)) { idOf.set(f, table.length); table.push(f); } return idOf.get(f); };
    const rows = list.map((c) => [c.h, c.s.slice(0, 200), c.files.map(id), c.a, c.m]);
    try { paths.atomicWrite(file, JSON.stringify({ v: CACHE_V, head, max, at: new Date().toISOString(), files: table, commits: rows }) + "\n"); } catch (_) { /* a cache is optional */ }
  }
  return list;
}

// How many existing source files change for each new one, in this repo: the median of
// modified / added over commits that add source files. Default 2 (a parent and a registry);
// clamped to 1–3. Needs 5 such commits.
function wiringRatio(list) {
  const xs = (list || []).filter((c) => c.files.length <= BIG && c.a > 0).map((c) => c.m / c.a);
  if (xs.length < 5) return { ratio: 2, n: xs.length, learned: false };
  return { ratio: Math.max(1, Math.min(3, Math.round(median(xs) * 10) / 10)), n: xs.length, learned: true };
}

// Files that changed with the targets before: support = commits together, conf = support / commits
// of the target. Source files only; the best target wins for each partner.
function coChange(list, targets, { minSupport = 3, minConf = 0.6, max = 6 } = {}) {
  const want = new Set(targets);
  if (!want.size || !list) return [];
  const n = new Map();
  const pair = new Map();
  for (const c of list) {
    if (c.files.length > BIG) continue;
    const hit = c.files.filter((f) => want.has(f));
    if (!hit.length) continue;
    for (const t of hit) n.set(t, (n.get(t) || 0) + 1);
    for (const f of c.files) {
      if (want.has(f) || !isSrc(f)) continue;
      for (const t of hit) { const k = t + "\n" + f; pair.set(k, (pair.get(k) || 0) + 1); }
    }
  }
  const best = new Map();
  for (const [k, support] of pair) {
    const [t, f] = k.split("\n");
    const conf = support / n.get(t);
    if (support < minSupport || conf < minConf) continue;
    const prev = best.get(f);
    if (!prev || conf > prev.conf) best.set(f, { file: f, with: t, support, conf: Math.round(conf * 100) / 100 });
  }
  return [...best.values()].sort((a, b) => b.conf - a.conf || b.support - a.support || a.file.localeCompare(b.file)).slice(0, max);
}

// Past commits whose subject shares ≥ 2 content words with the request (cosine ≥ 0.3).
// The analogy estimate: the median count of their source files.
function similarCommits(list, request, { k = 7, min = 0.3 } = {}) {
  const want = bag(request);
  if (!list || want.size < 2) return { n: 0, median_src: null, samples: [] };
  const hits = [];
  list.forEach((c, i) => {
    if (c.files.length > BIG) return;
    const src = c.files.filter(isSrc).length;
    if (!src) return;
    const o = overlap(want, bag(c.s));
    if (o.score >= min) hits.push({ h: c.h, s: c.s.slice(0, 60), src, score: o.score, i });
  });
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  const top = hits.slice(0, k);
  return { n: top.length, median_src: median(top.map((x) => x.src)), samples: top.slice(0, 3).map(({ h, s, src }) => ({ h, s, src })) };
}

function readRuns(root) {
  const file = path.join(paths.projectLorcDir(root), "runs.jsonl");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return []; }
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch (_) { /* skip a bad line */ }
  }
  return out;
}

const TIERS = ["low", "mid", "high", "complex"];

// lorc's own past runs that look like this request: their final tiers (majority with a
// Wilson lower bound), their median source-file count, and executor track records.
function similarRuns(root, request, { k = 7, min = 0.35, runs } = {}) {
  const want = bag(request);
  const list = (runs || readRuns(root)).filter((r) => r && r.request && TIERS.includes(r.tier));
  const hits = [];
  for (const r of list) {
    const o = overlap(want, bag(r.request));
    if (o.score >= min) hits.push({ r, score: o.score });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, k).map((x) => x.r);
  const tiers = {};
  for (const r of top) tiers[r.tier] = (tiers[r.tier] || 0) + 1;
  let majority = null;
  for (const t of TIERS) if (tiers[t] && (!majority || tiers[t] > tiers[majority])) majority = t;
  const { wilsonLB } = require("./habits.js");
  const lb = majority ? Math.round(wilsonLB(tiers[majority] / top.length, top.length) * 100) / 100 : 0;
  return {
    n: top.length, tiers, majority, lb,
    median_src: median(top.map((r) => (Number.isFinite(r.src_files) ? r.src_files : NaN))),
  };
}

// lorc's own size error in this repo: the median of real / estimated source files over the
// last 30 finished runs that have both (`src_files` and the RAW estimate `est_raw`, taken
// before this factor). Needs 5 runs; clamped to 0.5–2.
function calibration(root, { runs } = {}) {
  const xs = (runs || readRuns(root))
    .filter((r) => r && Number.isFinite(r.src_files) && r.src_files > 0 && Number.isFinite(r.est_raw) && r.est_raw > 0)
    .slice(-30).map((r) => r.src_files / r.est_raw);
  if (xs.length < 5) return { factor: 1, n: xs.length, learned: false };
  return { factor: Math.max(0.5, Math.min(2, Math.round(median(xs) * 100) / 100)), n: xs.length, learned: true };
}

// Executors with a good record at a tier: done, and no P0/P1 finding. Wilson LB on that share.
function executorRecord(root, tier, { runs } = {}) {
  const { wilsonLB } = require("./habits.js");
  const by = {};
  for (const r of runs || readRuns(root)) {
    if (!r || r.tier !== tier || !r.executor || /,|\+|\(/.test(String(r.executor))) continue;
    const ex = String(r.executor).replace(/^lorc-executor-/, "");
    const f = r.findings || {};
    const ok = r.outcome === "done" && !(f.P0 || 0) && !(f.P1 || 0);
    const e = (by[ex] = by[ex] || { n: 0, ok: 0 });
    e.n++;
    if (ok) e.ok++;
  }
  for (const e of Object.values(by)) e.lb = Math.round(wilsonLB(e.ok / e.n, e.n) * 100) / 100;
  return by;
}

module.exports = {
  MAX_COMMITS, BIG, NOISE, TEST, LOCALE, kindOf, isSrc, bag, overlap, median, stem,
  parseLog, unitSubject, commits, wiringRatio, coChange, similarCommits, readRuns, similarRuns, calibration, executorRecord, cacheFile, CACHE_V,
};
