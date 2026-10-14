"use strict";
// lorc cov — coverage per changed source file, with SOURCE branches apart from
// GENERATED ones. A transform (Babel async/regenerator, interop helpers) adds
// branches that the source map puts on an import line or a helper line. Those
// arms are not in the code that was written, so the bar is judged on source branches.
// Input: lcov.info (+ coverage-summary.json) in lorc's coverage dir. No test run here.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const COV_DIR = ".claude/lorc/coverage";
const SRC_RE = /\.(m?[jt]sx?|cjs|vue|svelte)$/i;
// Babel / TS runtime helpers. A function with one of these names is generated code.
const HELPER_RE = /^_*(interopRequire(Default|Wildcard)?|regenerator\w*|asyncToGenerator|asyncGeneratorStep|asyncIterator|awaitAsyncGenerator|wrapAsyncGenerator|defineProperty|objectSpread2?|ownKeys|typeof|toPropertyKey|toPrimitive|classCallCheck|createClass|defineProperties|slicedToArray|toConsumableArray|arrayLikeToArray|unsupportedIterableToArray|iterableToArray(Limit)?|nonIterable(Rest|Spread)|arrayWith(Holes|outHoles)|objectWithoutProperties(Loose)?|extends|inherits|getPrototypeOf|setPrototypeOf|createSuper|possibleConstructorReturn|assertThisInitialized|isNativeReflectConstruct|wrapNativeSuper|taggedTemplateLiteral|createForOfIteratorHelper(Loose)?|tslib\w*|__awaiter|__generator|__assign|__rest|__spreadArray|__importDefault|__importStar)$/i;
const TOP = 10;

// Repo root → coverage dir of one project dir (same place lorc check writes to).
function covDir(root, d) {
  return path.join(root, ...COV_DIR.split("/"), !d || d === "." ? "root" : d.replace(/[\\/]/g, "_"));
}

// lcov text → Map(path as written → { lf, lh, fns: [{ line, name }], brda: [{ line, hits }] }).
function parseLcov(text) {
  const out = new Map();
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith("SF:")) { cur = { lf: 0, lh: 0, fns: [], brda: [], da: new Map() }; out.set(l.slice(3), cur); continue; }
    if (!cur) continue;
    if (l === "end_of_record") { cur = null; continue; }
    let m;
    if ((m = /^DA:(\d+),(\d+)/.exec(l))) cur.da.set(Number(m[1]), Number(m[2]));
    else if ((m = /^FN:(\d+),(.+)$/.exec(l))) cur.fns.push({ line: Number(m[1]), name: m[2] });
    else if ((m = /^BRDA:(\d+),[^,]*,[^,]*,(\S+)$/.exec(l))) cur.brda.push({ line: Number(m[1]), hits: m[2] === "-" ? 0 : Number(m[2]) || 0 });
    else if ((m = /^LF:(\d+)$/.exec(l))) cur.lf = Number(m[1]);
    else if ((m = /^LH:(\d+)$/.exec(l))) cur.lh = Number(m[1]);
  }
  return out;
}

// Lines of the source text that hold no branch of their own: import / export-from
// statements (also multi-line), blank and comment-only lines, SFC block tags.
// Returns Map(line → kind).
function quietLines(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*$/.test(l)) { out.set(i + 1, "blank"); continue; }
    if (/^\s*(\/\/|\/\*|\*\/?(\s|$))/.test(l)) { out.set(i + 1, "comment"); continue; }
    if (/^\s*<\/?(script|template|style)\b[^>]*>\s*$/i.test(l)) { out.set(i + 1, "tag"); continue; }
    const imp = /^\s*import\b(?!\s*\()/.test(l);
    const exp = /^\s*export\s*(\*|\{)/.test(l);
    if (!imp && !exp) continue;
    // One statement: up to the line with `from '…'` (or a side-effect import), max 40 lines.
    let end = i;
    const done = (s) => /\bfrom\s*['"][^'"]*['"]/.test(s) || /^\s*import\s*['"][^'"]*['"]/.test(s) || (exp && /\}\s*;?\s*$/.test(s) && !/\bfrom\b/.test(s) && end > i);
    while (end < lines.length - 1 && end - i < 40 && !done(lines[end])) end++;
    if (!done(lines[end])) continue;
    for (let k = i; k <= end; k++) out.set(k + 1, "import");
    i = end;
  }
  return { quiet: out, count: lines.length };
}

const pct = (h, t) => (t ? Math.round((h / t) * 10000) / 100 : null);

// One file: lcov record + source text → the split. `summary` = json-summary entry (optional).
// `added` = the changed lines of a file that exists at HEAD (null = a new file): then the
// bar is on those lines only (`changed`); the old code's gaps are not this change's.
function analyze(rec, text, summary, added = null) {
  const { quiet, count } = quietLines(text);
  const helperAt = new Set(rec.fns.filter((f) => HELPER_RE.test(f.name)).map((f) => f.line));
  let srcT = 0, srcH = 0, genU = 0, chT = 0, chH = 0;
  const genAt = new Map();
  const unc = new Set();
  const chUnc = new Set();
  for (const b of rec.brda) {
    const kind = b.line > count ? "past end" : helperAt.has(b.line) ? (quiet.get(b.line) || "helper") : quiet.get(b.line);
    if (kind) {
      if (!b.hits) { genU++; genAt.set(b.line, kind); }
      continue;
    }
    srcT++;
    if (b.hits) srcH++; else unc.add(b.line);
    if (added && added.has(b.line)) { chT++; if (b.hits) chH++; else chUnc.add(b.line); }
  }
  const allT = rec.brda.length;
  const allH = rec.brda.filter((b) => b.hits).length;
  const out = {
    lines: summary && summary.lines ? summary.lines.pct : pct(rec.lh, rec.lf),
    branches: summary && summary.branches ? summary.branches.pct : (allT ? pct(allH, allT) : 100),
    src_branches: srcT ? pct(srcH, srcT) : 100,
  };
  if (genU) out.generated = `${genU} uncovered at ${[...genAt].slice(0, 3).map(([l, k]) => `${l} (${k})`).join(", ")}`;
  const lineUnc = new Set();
  if (added) {
    let lT = 0, lH = 0;
    for (const [ln, hits] of rec.da) if (added.has(ln)) { lT++; if (hits) lH++; else lineUnc.add(ln); }
    out.changed = { lines: lT ? pct(lH, lT) : 100, src_branches: chT ? pct(chH, chT) : 100 };
  }
  const show = added ? new Set([...chUnc, ...lineUnc]) : unc;
  if (show.size) out.uncovered = [...show].sort((a, b) => a - b).slice(0, TOP);
  // SFC: the transform maps only a few lines of a big <script>. A TOOL limit, not a gap in the
  // change (0.3.1 called it a note; a reviewer read it as "coverage not proven" and the lane chased it).
  const code = scriptLines(text, quiet);
  if (rec.lf && code > 60 && rec.lf < code * 0.2) out.tool_limit = `source map has ${rec.lf} of ~${code} script lines; not a gap in the change`;
  return out;
}

// Non-quiet lines inside the <script> block of an SFC (0 for a plain file).
function scriptLines(text, quiet) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let n = 0, inside = false, sfc = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*<script\b/i.test(lines[i])) { inside = sfc = true; continue; }
    if (/^\s*<\/script>/i.test(lines[i])) { inside = false; continue; }
    if (inside && !quiet.has(i + 1)) n++;
  }
  return sfc ? n : 0;
}

function readText(f) { try { return fs.readFileSync(f, "utf8"); } catch (_) { return null; } }

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// Changed (added) lines of a file that exists at HEAD; null for a new or untracked file.
function addedLines(root, file) {
  if (git(root, ["cat-file", "-e", `HEAD:${file}`]) == null) return null;
  const diff = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", "HEAD", "--", file]);
  if (diff == null) return null;
  const out = new Set();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    for (let k = 0; k < n; k++) out.add(start + k);
  }
  return out;
}

// Repo-relative changed source files → { file: analysis } from lorc's coverage dirs.
// `groups` = { projectDir: [path relative to it] } (check.groupByProject).
function collect(root, groups) {
  const out = {};
  for (const [d, rel] of Object.entries(groups)) {
    const dir = covDir(root, d);
    const lcov = readText(path.join(dir, "lcov.info"));
    if (lcov == null) continue;
    const proj = d === "." ? root : path.join(root, d);
    const recs = new Map();
    for (const [sf, rec] of parseLcov(lcov)) {
      const abs = path.isAbsolute(sf) ? sf : path.join(proj, sf);
      recs.set(path.relative(proj, abs).replace(/\\/g, "/"), rec);
    }
    const sum = paths.readJson(path.join(dir, "coverage-summary.json"), null) || {};
    const sumBy = new Map(Object.entries(sum).filter(([k]) => k !== "total")
      .map(([k, v]) => [path.relative(proj, path.isAbsolute(k) ? k : path.join(proj, k)).replace(/\\/g, "/"), v]));
    for (const f of rel) {
      if (!SRC_RE.test(f)) continue;
      const rec = recs.get(f);
      if (!rec) continue;
      const text = readText(path.join(proj, f));
      if (text == null) continue;
      const repoRel = d === "." ? f : `${d}/${f}`;
      out[repoRel] = analyze(rec, text, sumBy.get(f), addedLines(root, repoRel));
    }
  }
  return out;
}

// When the coverage data was written (newest file), or null.
function measuredAt(root, groups) {
  let t = 0;
  for (const d of Object.keys(groups)) {
    try { t = Math.max(t, fs.statSync(path.join(covDir(root, d), "lcov.info")).mtimeMs); } catch (_) { /* none */ }
  }
  return t ? new Date(t).toISOString() : null;
}

// The bar on lines and SOURCE branches (≥ bar) — of the changed lines for a file that
// exists at HEAD, of the whole file for a new one. Sets bar_met on each file; returns all met.
function judge(cov, bar) {
  let all = true;
  for (const v of Object.values(cov)) {
    const s = v.changed || v;
    v.bar_met = (s.lines == null || s.lines >= bar) && s.src_branches >= bar;
    all = all && v.bar_met;
  }
  return all;
}

// One text line per file.
function line(f, v) {
  return `${f}: lines ${v.lines ?? "-"} · branches ${v.branches ?? "-"} · source branches ${v.src_branches}`
    + (v.changed ? ` · changed lines: lines ${v.changed.lines} · source branches ${v.changed.src_branches}` : "")
    + (v.generated ? ` · generated ${v.generated}` : "")
    + (v.uncovered ? ` · uncovered source lines ${v.uncovered.join(",")}` : "")
    + (v.tool_limit ? ` · tool limit: ${v.tool_limit}` : "")
    + (v.bar_met == null ? "" : v.bar_met ? " · bar met" : " · BAR NOT MET");
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function cmd(argv = []) {
  const dir = valueOf(argv, "--dir");
  const root = dir ? path.resolve(dir) : paths.repoRoot();
  const check = require("./check.js");
  const files = check.changedFiles(root).filter((f) => !check.isTest(f) && SRC_RE.test(f));
  const groups = check.groupByProject(root, files);
  const coverage = collect(root, groups);
  const out = { files: files.length, measured_at: measuredAt(root, groups), coverage };
  const barArg = valueOf(argv, "--bar");
  if (barArg != null) { out.bar = Number(barArg); out.bar_met = judge(coverage, out.bar); }
  if (!Object.keys(coverage).length) out.note = "no coverage data: run the slice's coverage command (or lorc check) first";
  if (wantsJson(argv)) emit(out);
  else {
    const L = Object.entries(coverage).map(([f, v]) => line(f, v));
    if (out.note) L.push(out.note);
    if (out.bar != null) L.push(`bar ${out.bar}: ${out.bar_met ? "met" : "NOT met"} (lines and source branches)`);
    process.stdout.write(L.join("\n") + "\n");
  }
  return out.bar_met === false ? 1 : 0;
}

module.exports = { COV_DIR, covDir, parseLcov, quietLines, analyze, addedLines, collect, measuredAt, judge, line, HELPER_RE, cmd };
