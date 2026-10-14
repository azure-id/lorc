"use strict";
// lorc review prep — writes .claude/lorc/run/<slug>/review-packet.md and says
// whether the review needs an agent (dispatch) and why.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const HUNKS_MAX = 24 * 1024;
const GOTCHAS_MAX = 2400;

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : "";
}

// file → hunks [{ head, text, start, end, add, del }].
function parseDiff(text) {
  const files = new Map();
  let cur = null;
  let h = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) { cur = null; h = null; continue; }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") { cur = p.replace(/^b\//, ""); if (!files.has(cur)) files.set(cur, []); }
      continue;
    }
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") { cur = p.replace(/^a\//, ""); if (!files.has(cur)) files.set(cur, []); }
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && cur) {
      const start = Number(m[1]);
      const n = m[2] === undefined ? 1 : Number(m[2]);
      h = { head: line, lines: [line], start, end: start + Math.max(n, 1) - 1, add: 0, del: 0 };
      files.get(cur).push(h);
      continue;
    }
    if (h && cur && /^[ +\-\\]/.test(line)) {
      h.lines.push(line);
      if (line.startsWith("+")) h.add++;
      else if (line.startsWith("-")) h.del++;
    }
  }
  for (const hs of files.values()) for (const x of hs) x.text = x.lines.join("\n");
  return files;
}

function untrackedHunks(root, files) {
  const out = new Map();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, f), "utf8"); } catch (_) { continue; }
    const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    const head = `@@ -0,0 +1,${lines.length} @@ (new file)`;
    out.set(f, [{ head, text: [head, ...lines.map((l) => "+" + l)].join("\n"), start: 1, end: lines.length, add: lines.length, del: 0 }]);
  }
  return out;
}

function globRe(glob) {
  let re = "";
  const g = String(glob).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === "," ) re += "|";
    else re += c.replace(/[.+^$()|[\]]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// Entries of .claude/orc/gotchas.md (READ ONLY) whose scope matches a changed file.
function gotchas(root, files) {
  let text;
  try { text = fs.readFileSync(path.join(root, ".claude", "orc", "gotchas.md"), "utf8"); } catch (_) { return ""; }
  const blocks = text.replace(/\r\n/g, "\n").split(/\n(?=## G-)/).filter((b) => /^## G-/.test(b.trim()));
  const out = [];
  let used = 0;
  for (const b of blocks) {
    const m = /^- scope:\s*(.+)$/m.exec(b);
    if (!m) continue;
    const scopes = m[1].split(/\s+|,(?![^{]*})/).filter(Boolean);
    const hit = files.some((f) => scopes.some((s) => { try { return globRe(s).test(f); } catch (_) { return false; } }));
    if (!hit) continue;
    const entry = b.trim();
    if (used + Buffer.byteLength(entry, "utf8") > GOTCHAS_MAX) break;
    out.push(entry);
    used += Buffer.byteLength(entry, "utf8") + 2;
  }
  return out.join("\n\n");
}

function lastLintLines(root, slug) {
  const r = paths.readJson(path.join(require("./runs.js").runDir(root, slug), "run.json"), null);
  const checks = r && Array.isArray(r.checks) ? r.checks : [];
  for (let i = checks.length - 1; i >= 0; i--) {
    const s = (checks[i].steps || []).find((x) => x.step === "lint");
    if (s) return (s.failed || []).map(String);
  }
  return [];
}

// From lorc's coverage dirs (lorc check or the executor's coverage command); no test run.
function coverageLines(root, files) {
  const check = require("./check.js");
  const cov = require("./coverage.js");
  const src = files.filter((f) => !check.isTest(f) && /\.(m?[jt]sx?|cjs|vue|svelte)$/i.test(f));
  const groups = check.groupByProject(root, src);
  let data = {};
  try { data = cov.collect(root, groups); } catch (_) { data = {}; }
  const rows = Object.entries(data);
  if (!rows.length) return [src.length ? "- not measured (no coverage data for the changed source files)" : "- no changed source files"];
  // 0.3.2: a tool limit is shown apart, as a fact, so it is not read as a gap in the change.
  const limits = rows.filter(([, v]) => v.tool_limit).map(([f, v]) => `${f} (${v.tool_limit})`);
  return [
    `Measured ${cov.measuredAt(root, groups) || "-"}. Judge a coverage rule on lines and source branches (a file that existed: its changed lines); \`generated\` arms come from a transform, not from the changed code.`,
    ...rows.slice(0, 20).map(([f, v]) => `- ${cov.line(f, Object.assign({}, v, { tool_limit: undefined }))}`),
    ...(limits.length ? [`Tool limit — NOT a finding (do not raise it, do not ask for a fix, do not measure again): ${limits.slice(0, 5).join("; ")}.`] : []),
  ];
}

function dispatchOf(mode, { changedLines, minLines, risky, tier }) {
  if (mode === "agent") return { dispatch: true, reason: "settings.review = agent" };
  if (mode === "inline") return { dispatch: false, reason: "settings.review = inline" };
  if (changedLines >= minLines) return { dispatch: true, reason: `${changedLines} changed lines ≥ review_agent_min_lines ${minLines}` };
  if (risky.length) return { dispatch: true, reason: `risky path changed: ${risky.slice(0, 3).join(", ")}` };
  if (tier === "complex") return { dispatch: true, reason: "tier complex" };
  return { dispatch: false, reason: `auto: ${changedLines} changed lines < ${minLines}, no risky path` };
}

function reviewPrep(root, slug, { tier } = {}) {
  const runs = require("./runs.js");
  const run = paths.readJson(path.join(runs.runDir(root, slug), "run.json"), null);
  if (!run) throw new Error(`no run "${slug}"`);
  const s = require("./settings.js").load(root).values;
  const files = require("./check.js").changedFiles(root);
  const fileSet = new Set(files);

  // Hunks: tracked diff + untracked files as added hunks.
  const diff = parseDiff(git(root, ["diff", "HEAD", "-U3", "--no-color", "--no-ext-diff"]));
  const tracked = new Set(diff.keys());
  for (const [f, hs] of untrackedHunks(root, files.filter((f) => !tracked.has(f)))) diff.set(f, hs);
  for (const k of [...diff.keys()]) if (!fileSet.has(k)) diff.delete(k);
  let changedLines = 0;
  for (const hs of diff.values()) for (const h of hs) changedLines += h.add + h.del;

  // Changed symbols with risk + reason.
  let symbols = [];
  if (files.length) {
    const r = require("./prep.js").lorcJson(root, ["graph", "changes", `--files=${files.join(",")}`], 120000);
    symbols = r && Array.isArray(r.symbols) ? r.symbols : [];
  }

  // Lint, with review_mute applied to P2/P3-only categories.
  const mute = new Set(String(s.review_mute || "").split(",").map((x) => x.trim()).filter(Boolean));
  let lint = [];
  try { lint = require("./rules.js").lint(root, { diff: true }); } catch (_) { lint = []; }
  let byId = new Map();
  try {
    const rc = require("./core.js").rulesCore();
    byId = new Map(rc.rulesReadPacks(path.join(root, ".claude")).rules.map((r) => [r.id, r]));
  } catch (_) { /* no metadata: nothing is muted */ }
  // A rule has no P level of its own: a HARD rule is a P0/P1 finding, every other
  // tier lands at P2/P3. The category is the rule's pack or its id prefix.
  const muted = (id) => {
    const r = byId.get(id);
    if (!r || r.tier === "HARD") return false;
    return mute.has(String(r.pack || "").toLowerCase()) || mute.has(String(r.prefix || "").toLowerCase());
  };
  if (mute.size) lint = lint.filter((f) => !muted(f.id));
  const lintLines = lint.map((f) => `- ${f.file}:${f.line} ${f.id} ${f.text}`);
  const checkLint = lastLintLines(root, slug);

  // House rules P0/P1, verbatim.
  let house = null;
  try { house = require("./rules.js").house(root); } catch (_) { house = null; }

  const risky = files.filter((f) => require("./prep.js").RISKY.test(f));
  const d = dispatchOf(s.review, { changedLines, minLines: s.review_agent_min_lines, risky, tier });

  // Hunk selection.
  const all = [];
  for (const [f, hs] of diff) for (const h of hs) all.push({ file: f, h });
  const total = all.reduce((n, x) => n + Buffer.byteLength(x.h.text, "utf8") + x.file.length + 8, 0);
  const shown = [];
  const notShown = [];
  if (total <= HUNKS_MAX) shown.push(...all);
  else {
    const hot = symbols.filter((x) => x.risk === "high" || x.risk === "medium");
    const lintAt = lint.map((f) => ({ file: f.file, line: f.line }));
    let used = 0;
    for (const x of all) {
      const flag = hot.some((y) => y.file === x.file && y.lines[0] <= x.h.end && x.h.start <= y.lines[1])
        || lintAt.some((l) => l.file === x.file && l.line >= x.h.start && l.line <= x.h.end);
      const b = Buffer.byteLength(x.h.text, "utf8") + x.file.length + 8;
      if (flag && used + b <= HUNKS_MAX) { shown.push(x); used += b; } else notShown.push(x);
    }
  }

  const L = [`# Review packet — lorc run ${slug}`, "", "## Acceptance"];
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const acc = tasks.flatMap((t) => (Array.isArray(t.accept) ? t.accept : []).map((a) => `- ${t.n != null ? `[${t.n}] ` : ""}${a}`));
  L.push(...(acc.length ? acc : [`- (no slice acceptance; request: ${run.request || "-"})`]), "");
  if (house && (house.blocks.P0 || house.blocks.P1)) {
    L.push("## House rules P0/P1");
    for (const k of ["P0", "P1"]) if (house.blocks[k]) L.push(`### ${k}`, house.blocks[k]);
    L.push("");
  }
  L.push("## Lint", ...(lintLines.length || checkLint.length ? [...lintLines, ...checkLint.map((x) => `- check lint: ${x}`)] : ["- none"]), "");
  // 0.3.1: coverage of the changed source files, so the reviewer can judge a coverage house rule.
  L.push("## Coverage", ...coverageLines(root, files), "");
  L.push("## Changed symbols", ...(symbols.length ? symbols.slice(0, 40).map((x) => `- ${x.risk} ${x.qname} ${x.file}:${x.lines[0]}-${x.lines[1]} (${(x.why || []).join(" · ")})`) : ["- none in the graph"]), "");
  const g = gotchas(root, files);
  if (g) L.push("## Gotchas", g, "");
  L.push("## Hunks");
  let lastFile = null;
  for (const x of shown) {
    if (x.file !== lastFile) { L.push(`### ${x.file}`); lastFile = x.file; }
    L.push("```diff", x.h.text, "```");
  }
  if (notShown.length) {
    const per = new Map();
    for (const x of notShown) { const p = per.get(x.file) || { a: 0, d: 0 }; p.a += x.h.add; p.d += x.h.del; per.set(x.file, p); }
    L.push("", "Not shown:", ...[...per].map(([f, p]) => `- ${f}: +${p.a} −${p.d} (not shown)`));
  }
  if (!all.length) L.push("- no changes");
  const text = L.join("\n") + "\n";
  const file = path.join(runs.runDir(root, slug), "review-packet.md");
  paths.atomicWrite(file, text);
  return { path: file, bytes: Buffer.byteLength(text, "utf8"), dispatch: d.dispatch, reason: d.reason, changed_lines: changedLines, files: files.length };
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function cmd(argv = []) {
  const err = (m) => { process.stderr.write(`lorc review: ${m}\n`); return 2; };
  const pos = require("./core.js").positionals(argv, ["--run", "--tier"]);
  if (pos[0] !== "prep") return err("use: review prep --run <slug> [--tier <t>] [--json]");
  const slug = valueOf(argv, "--run");
  if (!slug) return err("review prep needs --run <slug>");
  const dir = valueOf(argv, "--dir");
  const root = dir ? path.resolve(dir) : paths.repoRoot();
  let out;
  try { out = reviewPrep(root, slug, { tier: valueOf(argv, "--tier") }); } catch (e) { return err(e.message); }
  if (wantsJson(argv)) emit(out);
  else process.stdout.write(`${out.path} (${out.bytes} bytes) · dispatch ${out.dispatch} — ${out.reason}\n`);
  return 0;
}

module.exports = { reviewPrep, parseDiff, gotchas, globRe, dispatchOf, cmd };
