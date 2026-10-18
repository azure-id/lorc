"use strict";
// lorc slice — writes .claude/lorc/run/<slug>/slice-<n>.md (≤ 32,768 B). The
// executor reads this ONE file; the main session holds only its path.
const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");
const { emit } = require("./json.js");

const MAX_BYTES = 32768;
const REFCODE_MAX = 16384;
const ANCHORS_MAX = 1500;
const CONTEXT_MAX = 7000;
const CONTEXT_CODE_MAX = 2500;
const DOC_INLINE_MAX = 8192;
const PLAN_MAX = 20480;
const CONTEXT_TITLE = "## Context (request, doc and graph) — read these ranges with offset/limit, never whole files";
// Copied from agents-src/executor.template.md (the return block). Keep the two equal.
const RETURN_SHAPE = [
  "```json",
  '{"status":"done|partial|blocked",',
  ' "files_changed":[{"path":"…","why":"…"}],',
  ' "tests":{"run":"<command or \'not run\'>","passed":true,"note":"…"},',
  ' "coverage":{"<file>":{"lines":n,"branches":n,"src_branches":n,"uncovered":[<source lines>]}},',
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

// No input.focus: task title words + task file basenames + the run request's words (≤ 8, no verbs).
function deriveFocus(title, files, request) {
  const { mapWords } = require("./prep.js");
  const names = files.map((f) => base(f).replace(/\.[^.]+$/, "")).filter(Boolean);
  const out = [];
  for (const w of [...mapWords(title), ...names, ...mapWords(request)]) {
    if (!out.some((x) => x.toLowerCase() === w.toLowerCase())) out.push(w);
    if (out.length >= 8) break;
  }
  return out.join(",");
}

const fence = (body) => { let f = "```"; while (body.includes(f)) f += "`"; return f; };

// Pick the run's context items for this task (<runDir>/context.json). Each entry is
// { line, code } — code is optional; the section keeps ≤ CONTEXT_MAX B, code ≤ CONTEXT_CODE_MAX B.
function contextPart(runDir, input, files, refFiles) {
  const pack = paths.readJson(path.join(runDir, "context.json"), null);
  if (!pack) return [];
  const fileSet = new Set(files);
  const refSet = new Set(refFiles);
  const creates = Boolean(input.creates);
  const all = { targets: pack.targets || [], mirror: pack.mirror || [], exemplars: pack.exemplars || [], tests: pack.tests || [], reuse: pack.reuse || [] };
  const seen = new Set();
  const picked = [];
  const add = (it) => {
    const k = `${it.file}:${it.start}-${it.end}`;
    if (seen.has(k)) return;
    seen.add(k);
    picked.push(it);
  };
  // 1. Items in the task's files (targets first), 2. in its refs, 3. exemplars, tests, reuse when the task creates a file.
  for (const k of ["targets", "mirror", "exemplars", "tests", "reuse"]) for (const it of all[k]) if (fileSet.has(it.file)) add(it);
  // 0.5.2: a mirror row whose counterpart the task writes.
  for (const it of all.mirror) {
    const cp = it.counterpart || ((/ → (\S+) \(not in the doc\)$/.exec(String(it.what || "")) || [])[1]);
    if (cp && fileSet.has(cp)) add(it);
  }
  for (const k of ["targets", "mirror", "exemplars", "tests", "reuse"]) for (const it of all[k]) if (refSet.has(it.file)) add(it);
  if (creates) for (const k of ["mirror", "exemplars", "tests", "reuse"]) for (const it of all[k]) add(it);
  const out = picked.map((it) => ({
    file: it.file, line: `- ${it.file}:${it.start}${it.end !== it.start ? "-" + it.end : ""} — ${it.what}${it.why ? ` (${it.why})` : ""}`,
    code: it.code ? it.code : "",
  }));
  const text = [input.title, input.notes, ...(input.accept || []), ...(input.facts || [])].map((x) => String(x || "")).join("\n").toLowerCase();
  for (const e of pack.entities || []) {
    const name = String(e.name || "").toLowerCase();
    if (!name || name.length < 3 || !text.includes(name)) continue;
    for (const a of (e.at || []).slice(0, 3)) {
      if (seen.has(a)) continue;
      seen.add(a);
      out.push({ file: String(a).split(":")[0], line: `- ${a} — ${e.name} (${e.type || "name"})`, code: "" });
    }
  }
  // Budget: whole lines ≤ CONTEXT_MAX; inline code ≤ CONTEXT_CODE_MAX in total.
  let used = bytes(CONTEXT_TITLE) + 1;
  let codeUsed = 0;
  const kept = [];
  for (const c of out) {
    let code = "";
    if (c.code) {
      const blk = `${fence(c.code)}\n${c.code}\n${fence(c.code)}`;
      if (codeUsed + bytes(blk) + 1 <= CONTEXT_CODE_MAX) code = blk;
    }
    const b = bytes(c.line) + 1 + (code ? bytes(code) + 1 : 0);
    if (used + b > CONTEXT_MAX) {
      if (!code || used + bytes(c.line) + 1 > CONTEXT_MAX) continue;
      code = "";
    }
    used += bytes(c.line) + 1 + (code ? bytes(code) + 1 : 0);
    if (code) codeUsed += bytes(code) + 1;
    kept.push({ file: c.file, line: c.line, code });
  }
  return kept;
}

// run.json `doc`: ≤ DOC_INLINE_MAX B → the text; bigger → its path and headings.
function requirementPart(root, run) {
  if (!run || !run.doc) return null;
  const p = path.isAbsolute(run.doc) ? run.doc : path.join(root, run.doc);
  let t;
  try { t = fs.readFileSync(p, "utf8"); } catch (_) { return null; }
  const rel = path.relative(root, p).replace(/\\/g, "/");
  const lines = t.replace(/\r\n/g, "\n").split("\n");
  const heads = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    else if (!inFence && /^#{1,6}\s/.test(l)) heads.push(`- ${i + 1}: ${l.trim()}`);
  });
  return { rel, text: lines.join("\n").trimEnd(), heads, inline: bytes(t) <= DOC_INLINE_MAX };
}

function renderRequirement(q) {
  if (q.inline) {
    const f = fence(q.text);
    return ["## Requirement (verbatim — do not open the file again)", `${q.rel}`, `${f}md`, q.text, f];
  }
  return ["## Requirement (too big to inline — read only the sections you need, with offset/limit)", q.rel, ...q.heads.slice(0, 60)];
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
  // 0.1.6: each file maps to its project dir; a line runs there (cd <dir> && ...).
  const cd = (d, x) => (d === "." ? x : `cd ${d} && ${x}`);
  const ad = (d) => (d === "." ? root : path.join(root, d));
  // 0.5.2: a typecheck first (no build: a build writes dist/ and parallel builds race); the build is the fallback.
  let tc = c.typecheck || null;
  if (!tc) {
    try {
      const d = Object.keys(check.groupByProject(root, files))[0] || ".";
      const t = check.typecheckCmd(ad(d));
      if (t) tc = cd(d, t);
    } catch (_) { tc = null; }
  }
  const tcLine = tc ? `- typecheck: ${tc}` : `- typecheck/build: ${c.build || "none"}`;
  const testLines = [];
  try {
    // Before the edit, `graph changes` sees no hunk: the slice's ctx tests fill in.
    const t = [...new Set([...check.affectedTests(root, files), ...graphTests])]
      .filter((x) => fs.existsSync(path.join(root, x)));
    // 0.5.2: the declared test files that do not exist yet run too.
    const fresh = files.filter((f) => (/(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i.test(f) || /_test\.go$/i.test(f)) && !fs.existsSync(path.join(root, f)));
    t.push(...fresh.filter((f) => !t.includes(f)));
    t.sort();
    for (const [d, tf] of Object.entries(check.groupByProject(root, t))) {
      const run = check.runner(ad(d));
      testLines.push(run ? cd(d, run.cmd(tf)) : `${tf.join(" ")} (no runner found${d === "." ? "" : " in " + d})`);
    }
  } catch (_) { /* none found */ }
  const lints = [];
  const covs = [];
  try {
    for (const [d, ff] of Object.entries(check.groupByProject(root, files))) {
      const l = check.lintCmd(ad(d), ff, d === "." ? c : null, { planned: true });
      if (l) lints.push(cd(d, l));
      // 0.1.5: the coverage bar is a project P0 rule: the executor meets it before it returns.
      const run = check.runner(ad(d));
      // 0.3.1: the data goes to lorc's coverage dir; `lorc cov` splits source from generated branches.
      if (run && check.coverageOn(ad(d))) {
        const rel = path.relative(ad(d), check.covDir(root, d)).replace(/\\/g, "/");
        covs.push(`- coverage: ${cd(d, run.cmd([]).trim())}${check.coverageArgs(ff, rel)} then \`lorc cov --bar <project bar> --json\` (not a test run) — reach the project bar (see Rules → Project P0) on lines and SOURCE branches for EVERY new or changed source file BEFORE you return.`);
      }
    }
  } catch (_) { /* none */ }
  const out = [tcLine,`- tests for this task: ${testLines.join(" ; ") || "none found"}`, `- lint: ${lints.join(" ; ") || "none"}`, ...covs];
  return out.join("\n");
}

function render(p) {
  const L = [`# Slice ${p.n} — ${p.title}   (lorc run ${p.slug})`, "## Task", p.title];
  if (p.notes) L.push(p.notes);
  if (p.read) L.push("## Read first — ONE call", `Read ${p.read.path} (ONE Read call, ${p.read.bytes} B): ${p.read.ranges} ranges — ${p.read.list}`);
  if (p.facts.length) L.push("## Known facts (the orchestrator already read these — do not re-read to learn them)", ...p.facts.map((f) => `- ${f}`));
  L.push("## Acceptance", ...(p.accept.length ? p.accept.map((a) => `- ${a}`) : ["- (none given)"]));
  L.push("## Files", ...p.fileRows);
  if (p.ctx.length) {
    L.push(CONTEXT_TITLE);
    for (const c of p.ctx) { L.push(c.line); if (c.code) L.push(c.code); }
  }
  if (p.req) L.push(...renderRequirement(p.req));
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

// A ref with no range on a file over REF_LONG lines: name a range. A context card for the
// file gives the range (its template first) and its ranges; else say how long the file is.
const REF_LONG = 150;
function rangeRefs(root, runDir, kept) {
  const pack = (() => { try { return paths.readJson(path.join(runDir, "context.json"), null); } catch (_) { return null; } })() || {};
  const items = ["targets", "mirror", "exemplars", "tests", "reuse"].flatMap((k) => pack[k] || []);
  return kept.map((s) => {
    const m = /^(.+?)(?:\s+[—–-]+\s+(.+))?$/.exec(s);
    const file = m[1];
    if (/:\d+(-\d+)?$/.test(file)) return s;
    let n = 0;
    try { n = fs.readFileSync(path.join(root, file), "utf8").replace(/\r?\n$/, "").split("\n").length; } catch (_) { return s; }
    if (n <= REF_LONG) return s;
    const why = m[2] ? ` — ${m[2]}` : "";
    const its = items.filter((it) => it.file === file);
    const it = its.find((x) => /(^|· )(template|methods:)/.test(String(x.what || ""))) || its[0];
    if (!it) return `${file}${why} (${n} lines — read a range, not the whole file)`;
    const tm = /template (\d+)-(\d+)/.exec(String(it.what || ""));
    const a = tm ? Number(tm[1]) : it.start;
    const b = tm ? Number(tm[2]) : it.end;
    return `${file}:${a}-${b}${why} (card: ${it.what})`;
  });
}

function buildSlice(root, slug, n, input) {
  const runDir = require("./runs.js").runDir(root, slug);
  const files = input.files.map((f) => String(f).replace(/\\/g, "/"));
  const accept = Array.isArray(input.accept) ? input.accept.map(String) : [];
  const fileRows = files.map((f) => `- ${f} (${fs.existsSync(path.join(root, f)) ? "modify" : "create"})`);
  const existing = files.filter((f) => fs.existsSync(path.join(root, f)));
  const run = paths.readJson(path.join(runDir, "run.json"), null);
  const req = (() => { try { return requirementPart(root, run); } catch (_) { return null; } })();
  let refs = parseRefs(root, input.refs);
  if (req && req.inline) {
    // The doc is in the slice: drop it from refs.
    const isDoc = (s) => String(s).split(/\s+[—–-]+\s+/)[0].replace(/:\d+(-\d+)?$/, "") === req.rel;
    refs = { kept: refs.kept.filter((s) => !isDoc(s)), dropped: refs.dropped, ranged: refs.ranged.filter((r) => r.file !== req.rel) };
  }
  const refFiles = refs.kept.map((s) => String(s).split(/\s+[—–-]+\s+/)[0].replace(/:\d+(-\d+)?$/, ""));
  const creates = files.some((f) => !fs.existsSync(path.join(root, f)));
  let ctx = [];
  try { ctx = contextPart(runDir, { ...input, creates }, files, refFiles); } catch (_) { ctx = []; }
  // 0.4.2: the read plan — the ranges ONE `lorc read --run <slug> --task <n>` call prints.
  let read = null;
  try {
    const pack = paths.readJson(path.join(runDir, "context.json"), null) || {};
    const planRefs = (Array.isArray(input.refs) ? input.refs : []).filter((s) => !(req && req.inline && String(s).split(/\s+[—–-]+\s+/)[0].replace(/:[\d,-]+$/, "") === req.rel));
    const words = [input.title, input.notes, ...accept].map((x) => String(x || "")).join(" ");
    const plan = require("./context.js").readPlan(root, pack, { files, refs: planRefs, words, creates, budget: PLAN_MAX, docText: req ? req.text : "" });
    if (plan.length) {
      const r = require("./read.js").render(root, plan, PLAN_MAX);
      paths.atomicWrite(path.join(runDir, `plan-${n}.json`), JSON.stringify({ v: 1, budget: PLAN_MAX, ranges: r.ranges, bytes: r.bytes, plan }, null, 1) + "\n");
      const list = plan.map((f) => `${base(f.file)}:${f.ranges.map(([a, b]) => `${a}-${b}`).join(",")}`).join("; ");
      // 0.4.3: the plan text goes to a file: one Read, never a persisted "output too large" result.
      const readFile = path.join(runDir, `read-${n}.md`);
      paths.atomicWrite(readFile, r.text);
      read = { ranges: r.ranges, bytes: Buffer.byteLength(r.text), list, plan, path: readFile };
      // Drop the context lines whose whole range the plan prints.
      const printed = (file, a, b) => plan.some((f) => f.file === file && f.ranges.some(([x, y]) => x <= a && y >= b));
      ctx = ctx.filter((c) => {
        const m = /^- (.+?):(\d+)(?:-(\d+))? — /.exec(c.line);
        return !m || !printed(m[1], +m[2], +(m[3] || m[2]));
      });
    }
  } catch (_) { read = null; }
  // A file the context section already covers gets no anchors.
  const ctxFiles = new Set(ctx.map((c) => c.file));
  const anchorFiles = existing.filter((f) => !ctxFiles.has(f));
  const focus = input.focus || deriveFocus(String(input.title || ""), files, run && run.request);
  let an = { text: "", tests: [] };
  try { if (anchorFiles.length) an = anchors(root, anchorFiles, focus); } catch (_) { /* no anchors */ }
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
  let refLines = refs.kept;
  try { refLines = rangeRefs(root, runDir, refs.kept); } catch (_) { /* keep */ }
  const p = { code: code.map((c) => c.text), notInlined, refs: refLines, n, slug, title: String(input.title), notes: input.notes ? String(input.notes) : "", facts: parseFacts(input.facts), accept, fileRows, anchors: anchorText, pattern, rules, wiki, commands, ctx, req, read };
  let text = render(p);
  let trimmed = false;
  // Trim order: graph anchors, conventions, wiki, context code, context lines (from the end), facts,
  // reference code (last block first, whole blocks only), then the requirement (to headings).
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
  for (let i = p.ctx.length - 1; i >= 0 && over(); i--) if (p.ctx[i].code) { trimmed = true; p.ctx[i].code = ""; text = render(p); }
  while (over() && p.ctx.length) { trimmed = true; p.ctx.pop(); text = render(p); }
  while (over() && p.facts.length) { trimmed = true; p.facts.pop(); text = render(p); }
  while (over() && p.code.length) { trimmed = true; p.code.pop(); p.notInlined.unshift(code[p.code.length].head); text = render(p); }
  if (over() && p.req && p.req.inline) { trimmed = true; p.req.inline = false; text = render(p); }
  const file = path.join(runDir, `slice-${n}.md`);
  paths.atomicWrite(file, text);
  return { path: file, bytes: bytes(text), trimmed, files, accept, refs_dropped: refs.dropped, read: read ? { path: read.path, ranges: read.ranges, bytes: read.bytes } : null };
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
  if (r.read) o.read = r.read;
  if (r.refs_dropped.length) o.refs_dropped = r.refs_dropped;
  emit(o);
  return 0;
}

module.exports = { PLAN_MAX, buildSlice, RETURN_SHAPE, commandsPart, contextPart, requirementPart, deriveFocus, CONTEXT_MAX, CONTEXT_CODE_MAX, DOC_INLINE_MAX, MAX_BYTES, REFCODE_MAX, cmd };
