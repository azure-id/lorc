"use strict";
// lorc slice — writes .claude/lorc/run/<slug>/slice-<n>.md (≤ 24,576 B). The
// executor reads this ONE file; the main session holds only its path.
const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");
const { emit } = require("./json.js");

const MAX_BYTES = 24576;
const REFCODE_MAX = 16384;
const ANCHORS_MAX = 2500;
// Copied from agents-src/executor.template.md (the return block). Keep the two equal.
const RETURN_SHAPE = [
  "```json",
  '{"status":"done|partial|blocked",',
  ' "files_changed":[{"path":"…","why":"…"}],',
  ' "tests":{"run":"<command or \'not run\'>","passed":true,"note":"…"},',
  ' "coverage":{"<file>":{"lines":n,"branches":n}},',
  ' "self_check":{"acceptance":[{"item":"…","met":true}],"house_rules_p0p1":"ok|<rule broken>","coverage_bar_met":true|false},',
  ' "needs":"<what blocks you, only when blocked>"}',
  "```",
].join("\n");

const bytes = (s) => Buffer.byteLength(s, "utf8");
const base = (f) => String(f).split("/").pop();

function cutLines(text, max) {
  if (bytes(text) <= max) return text;
  const lines = text.split("\n");
  while (lines.length && bytes(lines.join("\n")) > max) lines.pop();
  return lines.join("\n");
}

// One line per anchored symbol: `sym · file:start-end · callers: a, b · callees: c`.
function anchors(root, files, focus) {
  const args = ["graph", "ctx", files.join(","), "--for-slice", "--anchors"];
  if (focus) args.push(`--focus=${String(focus).split(/[\s,]+/).filter(Boolean).join(",")}`);
  const r = require("./prep.js").lorcJson(root, args, 60000);
  if (!r || r.error || !r.anchors) return { text: "", tests: [] };
  const callersOf = new Map();
  const tests = new Set();
  for (const b of r.blocks || []) {
    callersOf.set(b.file, [...new Set((b.callers || []).map((c) => base(c.file)))]);
    for (const x of b.tests || []) tests.add(x);
  }
  const out = [];
  for (const l of r.anchors.lines || []) {
    const m = /^(\S+?):(\d+)-(\d+)\s+(\S+)/.exec(l);
    if (!m) { out.push(l); continue; }
    const callers = (callersOf.get(m[1]) || []).slice(0, 3);
    out.push(`${m[4]} · ${m[1]}:${m[2]}-${m[3]}${callers.length ? ` · callers: ${callers.join(", ")}` : ""}`);
  }
  return { text: cutLines(out.join("\n"), ANCHORS_MAX), tests: [...tests] };
}

function patternPart(root, files) {
  const pattern = require("./pattern.js");
  const langs = pattern.langsForFiles(files, root);
  for (const lang of langs) {
    const s = pattern.sections(root, lang);
    if (s) return { lang, conventions: s.conventions.replace(/^##\s+Conventions\s*\n?/i, "").trim(), invariants: s.invariants.replace(/^##\s+Invariants[^\n]*\n?/i, "").trim() };
  }
  return { lang: langs[0] || "none", conventions: "", invariants: "" };
}

function commandsPart(root, files, graphTests = []) {
  const check = require("./check.js");
  let c = {};
  try { c = require("./wiki.js").commands(root) || {}; } catch (_) { c = {}; }
  const tc = c.typecheck || c.build || "none";
  // 0.1.6: each file maps to its project dir; a line runs there (cd <dir> && ...).
  const cd = (d, x) => (d === "." ? x : `cd ${d} && ${x}`);
  const ad = (d) => (d === "." ? root : path.join(root, d));
  const testLines = [];
  try {
    // Before the edit, `graph changes` sees no hunk: the slice's ctx tests fill in.
    const t = [...new Set([...check.affectedTests(root, files), ...graphTests])]
      .filter((x) => fs.existsSync(path.join(root, x))).sort();
    for (const [d, tf] of Object.entries(check.groupByProject(root, t))) {
      const run = check.runner(ad(d));
      testLines.push(run ? cd(d, run.cmd(tf)) : `${tf.join(" ")} (no runner found${d === "." ? "" : " in " + d})`);
    }
  } catch (_) { /* none found */ }
  const lints = [];
  const covs = [];
  try {
    for (const [d, ff] of Object.entries(check.groupByProject(root, files))) {
      const l = check.lintCmd(ad(d), ff, d === "." ? c : null);
      if (l) lints.push(cd(d, l));
      // 0.1.5: the coverage bar is a project P0 rule: the executor meets it before it returns.
      const run = check.runner(ad(d));
      if (run && check.coverageOn(ad(d))) {
        covs.push(`- coverage: ${cd(d, run.cmd([]).trim())} --coverage ${ff.map((f) => `--collectCoverageFrom=${f}`).join(" ")} — reach the project bar (see Rules → Project P0) for EVERY new or changed source file BEFORE you return.`);
      }
    }
  } catch (_) { /* none */ }
  const out = [`- typecheck/build: ${tc}`, `- tests for this task: ${testLines.join(" ; ") || "none found"}`, `- lint: ${lints.join(" ; ") || "none"}`, ...covs];
  return out.join("\n");
}

function render(p) {
  const L = [`# Slice ${p.n} — ${p.title}   (lorc run ${p.slug})`, "## Task", p.title];
  if (p.notes) L.push(p.notes);
  if (p.facts.length) L.push("## Known facts (the orchestrator already read these — do not re-read to learn them)", ...p.facts.map((f) => `- ${f}`));
  L.push("## Acceptance", ...(p.accept.length ? p.accept.map((a) => `- ${a}`) : ["- (none given)"]));
  L.push("## Files", ...p.fileRows);
  if (p.refs.length) L.push("## Model on these (read them first — they are the closest existing code)", ...p.refs.map((r) => `- ${r}`));
  if (p.code.length || p.notInlined.length) {
    L.push("## Reference code (verbatim — model your code on it; do not re-read these ranges)");
    for (const b of p.code) L.push(b);
    for (const x of p.notInlined) L.push(`- ${x} (not inlined)`);
  }
  if (p.anchors) L.push("## Graph anchors", p.anchors);
  L.push(`## Code pattern (${p.pattern.lang})`);
  if (p.pattern.conventions) L.push("### Conventions", p.pattern.conventions);
  L.push("### Invariants (never break)", p.pattern.invariants || "none cached");
  L.push("## Rules", p.rules);
  if (p.wiki) L.push("## Wiki", p.wiki);
  L.push("## Commands", p.commands, "## Return", RETURN_SHAPE);
  return L.join("\n") + "\n";
}

const REFS_MAX = 6;
const FACTS_LINES = 40;
const FACTS_MAX = 3000;

// Optional facts[]: ≤ 40 short lines, ≤ 3,000 B in total.
function parseFacts(list) {
  const out = [];
  let used = 0;
  for (const raw of (Array.isArray(list) ? list : []).slice(0, FACTS_LINES)) {
    const s = String(raw).replace(/\s+/g, " ").trim();
    if (!s) continue;
    const b = bytes(s) + 3;
    if (used + b > FACTS_MAX) break;
    out.push(s);
    used += b;
  }
  return out;
}

// "path", "path:120-180" or "path:120-180 — why". Paths only: no file content.
// A ref whose file does not exist is dropped.
function parseRefs(root, list) {
  const kept = [];
  const dropped = [];
  const ranged = [];
  for (const raw of (Array.isArray(list) ? list : []).slice(0, REFS_MAX)) {
    const s = String(raw).trim();
    if (!s) continue;
    const m = /^(.+?)(?:\s+[—–-]+\s+(.+))?$/.exec(s);
    const loc = m[1].trim().replace(/\\/g, "/");
    const why = m[2] ? m[2].trim() : "";
    const lm = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(loc);
    const file = lm[1];
    if (!fs.existsSync(path.join(root, file))) { dropped.push(s); continue; }
    const range = lm[2] ? `:${lm[2]}${lm[3] ? `-${lm[3]}` : ""}` : "";
    kept.push(`${file}${range}${why ? ` — ${why}` : ""}`);
    if (lm[2]) ranged.push({ file, start: Number(lm[2]), end: Number(lm[3] || lm[2]) });
  }
  return { kept, dropped, ranged };
}

// One fenced block per ranged ref: "path:start-end" header, then the lines verbatim.
function refBlock(root, r) {
  let lines;
  try { lines = fs.readFileSync(path.join(root, r.file), "utf8").replace(/\r\n/g, "\n").split("\n"); } catch (_) { return null; }
  const a = Math.max(1, Math.min(r.start, r.end));
  const b = Math.min(lines.length, Math.max(r.start, r.end));
  if (a > b) return null;
  const body = lines.slice(a - 1, b).join("\n");
  let fence = "```";
  while (body.includes(fence)) fence += "`";
  const ext = path.extname(r.file).slice(1);
  return { head: `${r.file}:${a}-${b}`, text: `${r.file}:${a}-${b}\n${fence}${ext}\n${body}\n${fence}` };
}

function buildSlice(root, slug, n, input) {
  const runDir = require("./runs.js").runDir(root, slug);
  const files = input.files.map((f) => String(f).replace(/\\/g, "/"));
  const accept = Array.isArray(input.accept) ? input.accept.map(String) : [];
  const fileRows = files.map((f) => `- ${f} (${fs.existsSync(path.join(root, f)) ? "modify" : "create"})`);
  const existing = files.filter((f) => fs.existsSync(path.join(root, f)));
  let an = { text: "", tests: [] };
  try { if (existing.length) an = anchors(root, existing, input.focus); } catch (_) { /* no anchors */ }
  const anchorText = an.text;
  let pattern = { lang: "none", conventions: "", invariants: "" };
  try { pattern = patternPart(root, files); } catch (_) { /* none */ }
  let rules = "";
  try {
    const card = require("./rules.js").buildCard(root, { files, out: path.join(runDir, `rules-card-${n}.md`) });
    rules = fs.readFileSync(card.path, "utf8").trim();
  } catch (e) { rules = `(rules card failed: ${e.message})`; }
  let wiki = "";
  const pages = Array.isArray(input.wiki) ? input.wiki : input.wiki ? [input.wiki] : [];
  if (pages.length) wiki = `- ${pages[0]}`;
  else {
    // Only a page prep picked (prep writes its picks to <run dir>/prep.json).
    const picked = paths.readJson(path.join(runDir, "prep.json"), null);
    const pp = picked && picked.wiki_pages;
    if (Array.isArray(pp) && pp.length) wiki = `- ${pp[0]}`;
  }
  let commands = "- typecheck/build: none\n- tests for this task: none found\n- lint: none";
  try { commands = commandsPart(root, files, an.tests); } catch (_) { /* keep */ }
  const refs = parseRefs(root, input.refs);
  const code = [];
  const notInlined = [];
  let used = 0;
  for (const r of refs.ranged) {
    const blk = refBlock(root, r);
    if (!blk) continue;
    const b = bytes(blk.text) + 1;
    if (used + b > REFCODE_MAX) { notInlined.push(blk.head); continue; }
    used += b;
    code.push(blk);
  }
  const p = { code: code.map((c) => c.text), notInlined, refs: refs.kept, n, slug, title: String(input.title), notes: input.notes ? String(input.notes) : "", facts: parseFacts(input.facts), accept, fileRows, anchors: anchorText, pattern, rules, wiki, commands };
  let text = render(p);
  let trimmed = false;
  // Trim order: graph anchors, conventions, wiki, facts, then reference code (last block first, whole blocks only).
  const over = () => bytes(text) > MAX_BYTES;
  if (over() && p.anchors) {
    trimmed = true;
    const room = Math.max(0, bytes(p.anchors) - (bytes(text) - MAX_BYTES));
    p.anchors = cutLines(p.anchors, room);
    text = render(p);
  }
  if (over() && p.pattern.conventions) {
    trimmed = true;
    const room = Math.max(0, bytes(p.pattern.conventions) - (bytes(text) - MAX_BYTES));
    p.pattern.conventions = cutLines(p.pattern.conventions, room);
    text = render(p);
  }
  if (over() && p.wiki) { trimmed = true; p.wiki = ""; text = render(p); }
  while (over() && p.facts.length) { trimmed = true; p.facts.pop(); text = render(p); }
  while (over() && p.code.length) { trimmed = true; p.code.pop(); p.notInlined.unshift(code[p.code.length].head); text = render(p); }
  const file = path.join(runDir, `slice-${n}.md`);
  paths.atomicWrite(file, text);
  return { path: file, bytes: bytes(text), trimmed, files, accept, refs_dropped: refs.dropped };
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function cmd(argv = []) {
  const err = (m) => { process.stderr.write(`lorc slice: ${m}\n`); return 2; };
  const dir = valueOf(argv, "--dir");
  const root = dir ? path.resolve(dir) : paths.repoRoot();
  const slug = valueOf(argv, "--run");
  const n = valueOf(argv, "--task");
  if (!slug || !n) return err("use: slice --run <slug> --task <n> - (JSON on stdin)");
  if (!/^[\w-]+$/.test(n)) return err(`bad task number "${n}"`);
  let input;
  try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { return err(`bad stdin JSON: ${e.message}`); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return err("stdin JSON is not an object");
  if (!input.title || !Array.isArray(input.files) || !input.files.length) return err("stdin JSON needs title and files[]");
  const runs = require("./runs.js");
  if (!fs.existsSync(path.join(runs.runDir(root, slug), "run.json"))) return err(`no run "${slug}"`);
  const r = buildSlice(root, slug, n, input);
  runs.addTask(root, slug, { n: /^\d+$/.test(n) ? Number(n) : n, title: String(input.title), files: r.files, accept: r.accept, slice: r.path });
  const o = { path: r.path, bytes: r.bytes, trimmed: r.trimmed };
  if (r.refs_dropped.length) o.refs_dropped = r.refs_dropped;
  emit(o);
  return 0;
}

module.exports = { buildSlice, RETURN_SHAPE, commandsPart, MAX_BYTES, REFCODE_MAX, cmd };
