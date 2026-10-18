"use strict";
// lorc check — affected tests, lint, typecheck (and build / full tests on a flag),
// each with a time box. The output reaches the model already trimmed (≤ 3,000 B).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const MAX_BYTES = 3000;
const TAIL_LINES = 30;
const TIMEOUT = { tests: 600000, lint: 120000, typecheck: 300000, build: 600000, full: 600000 };
const TEST_RE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/i;
const LOCK_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum)$/;

const isTest = (f) => TEST_RE.test(String(f).replace(/\\/g, "/"));

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : "";
}

// Changed + untracked files, minus .claude/**, lockfiles and node_modules.
function changedFiles(root) {
  const set = new Set();
  for (const l of git(root, ["diff", "--name-only", "HEAD"]).split(/\r?\n/)) if (l.trim()) set.add(l.trim());
  for (const l of git(root, ["status", "--porcelain", "--untracked-files=all"]).split(/\r?\n/)) {
    if (!l.startsWith("??")) continue;
    let f = l.slice(3).trim();
    if (f.startsWith('"') && f.endsWith('"')) f = f.slice(1, -1);
    if (f) set.add(f);
  }
  return [...set].map((f) => f.replace(/\\/g, "/"))
    .filter((f) => !f.startsWith(".claude/") && !LOCK_RE.test(f) && !/(^|\/)node_modules\//.test(f))
    .sort();
}

const q = (f) => (/^[\w./@:+-]+$/.test(f) ? f : JSON.stringify(f));

function pkgOf(root) {
  const p = paths.readJson(path.join(root, "package.json"), null);
  if (!p) return null;
  return { deps: Object.assign({}, p.dependencies, p.devDependencies), scripts: p.scripts || {} };
}

function readText(f) { try { return fs.readFileSync(f, "utf8"); } catch (_) { return ""; } }

// Runner for a list of test files. null = no runner known.
function runner(root) {
  const p = pkgOf(root);
  if (p) {
    const all = Object.values(p.scripts).join(" ");
    if (p.deps.jest || /\bjest\b/.test(all)) return { name: "jest", cmd: (fs) => `npx jest --silent ${fs.map(q).join(" ")}` };
    if (p.deps.vitest || /\bvitest\b/.test(all)) return { name: "vitest", cmd: (fs) => `npx vitest run ${fs.map(q).join(" ")}` };
    if (p.deps.mocha || /\bmocha\b/.test(all)) return { name: "mocha", cmd: (fs) => `npx mocha ${fs.map(q).join(" ")}` };
    if (/node\s+(--[\w-]+\s+)*--test\b/.test(all)) return { name: "node", cmd: (fs) => `node --test ${fs.map(q).join(" ")}` };
  }
  const py = readText(path.join(root, "pytest.ini")) + readText(path.join(root, "pyproject.toml"));
  if (fs.existsSync(path.join(root, "pytest.ini")) || /pytest/.test(py)) {
    return { name: "pytest", cmd: (fs) => `python -m pytest -q ${fs.map(q).join(" ")}` };
  }
  return null;
}

function fullTestCmd(root, commands) {
  if (commands && commands.test) return commands.test;
  const p = pkgOf(root);
  return p && p.scripts.test ? "npm test" : null;
}

// 0.5.2: opts.planned keeps the files that do not exist yet (the slice lists every declared task file).
function lintCmd(root, files, commands, opts = {}) {
  const p = pkgOf(root);
  const code = files.filter((f) => /\.(m?[jt]sx?|cjs|vue|svelte)$/i.test(f) && (opts.planned || fs.existsSync(path.join(root, f))));
  const hasEslint = (p && p.deps.eslint) || fs.existsSync(path.join(root, "node_modules", ".bin", "eslint"));
  // lorc 0.5.2: an eslint cache, so `lorc check` lints again only the files that changed after the executor's lint.
  if (hasEslint) {
    if (!code.length) return null;
    const nm = fs.existsSync(path.join(root, "node_modules"));
    const cache = path.join(root, nm ? "node_modules/.cache/lorc-eslint/" : ".claude/lorc/eslintcache/").replace(/\\/g, "/");
    return `npx eslint --cache --cache-location ${q(cache.endsWith("/") ? cache : cache + "/")} ${code.map(q).join(" ")}`;
  }
  return commands && commands.lint ? commands.lint : null;
}

function typecheckCmd(root) {
  const p = pkgOf(root);
  if (p && p.scripts.typecheck) return "npm run typecheck";
  if (p && p.scripts["type-check"]) return "npm run type-check";
  if (p && p.deps.typescript && fs.existsSync(path.join(root, "tsconfig.json"))) return "npx tsc --noEmit";
  return null;
}

function buildCmd(root, commands) {
  if (commands && commands.build) return commands.build;
  const p = pkgOf(root);
  return p && p.scripts.build ? "npm run build" : null;
}

// 0.1.3: coverage only when the project already turns it on for jest (test script
// --coverage, or collectCoverage: true in jest config / package.json). Then the check
// reports it, so nobody runs the tests again for coverage.
const COV_DIR = ".claude/lorc/coverage";
const COV_MAX = 1200;

function coverageOn(root) {
  const p = paths.readJson(path.join(root, "package.json"), null);
  if (!p) return false;
  if (/--coverage\b/.test(String((p.scripts || {}).test || ""))) return true;
  if (p.jest && p.jest.collectCoverage === true) return true;
  for (const n of ["jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs", "jest.config.json"]) {
    if (/collectCoverage["']?\s*:\s*true/.test(readText(path.join(root, n)))) return true;
  }
  return false;
}

// Coverage output always lives under the REPO root's .claude/lorc/ — never inside a
// sub-project folder (0.1.6 wrote client/.claude/lorc/coverage, which is the user's tree).
const covDir = (root, d) => require("./coverage.js").covDir(root, d);

// 0.3.1: lcovonly too — its branch lines let lorc cov tell source from generated branches.
function coverageArgs(src, dir) {
  return " --coverage --coverageReporters=json-summary --coverageReporters=lcovonly " + q("--coverageDirectory=" + (dir || COV_DIR).replace(/\\/g, "/"))
    + src.map((f) => " " + q("--collectCoverageFrom=" + f)).join("");
}

function clearCoverage(root, dir) {
  try { fs.rmSync(dir || path.join(root, ...COV_DIR.split("/")), { recursive: true, force: true }); } catch (_) { /* none */ }
}

// 0.3.1: per changed source file { lines, branches, src_branches, generated?, uncovered?, note? }
// from lorc's coverage dirs (written by lorc check or by the slice's coverage command).
// `groups` = { projectDir: [path relative to it] }.
function readCoverage(root, groups) {
  const all = require("./coverage.js").collect(root, groups);
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    out[k] = v;
    if (Buffer.byteLength(JSON.stringify(out), "utf8") > COV_MAX) { delete out[k]; out.more = Object.keys(all).length - Object.keys(out).length; break; }
  }
  return Object.keys(out).length ? out : null;
}

// 0.1.6: the PROJECT DIR of a file = the nearest ancestor folder (up to the repo root)
// with a package.json (or pytest.ini / pyproject.toml). Returns it relative to root ("." = root).
const PROJ_MARK = ["package.json", "pytest.ini", "pyproject.toml"];
function projectDir(root, file) {
  let d = path.posix.dirname(String(file).replace(/\\/g, "/"));
  while (d && d !== "." && d !== "/") {
    if (PROJ_MARK.some((m) => fs.existsSync(path.join(root, d, m)))) return d;
    d = path.posix.dirname(d);
  }
  return ".";
}
// Group files by project dir: { dir: [path relative to dir] }.
function groupByProject(root, files) {
  const g = {};
  for (const f of files) {
    const d = projectDir(root, f);
    (g[d] = g[d] || []).push(d === "." ? f : f.slice(d.length + 1));
  }
  return g;
}
const absDir = (root, d) => (d === "." ? root : path.join(root, d));

// Affected test files: the graph's tests for the changed symbols + changed test files.
function affectedTests(root, files) {
  const out = new Set(files.filter(isTest));
  const src = files.filter((f) => !isTest(f));
  if (src.length) {
    const r = require("./prep.js").lorcJson(root, ["graph", "changes", `--files=${src.join(",")}`], 120000);
    for (const s of (r && Array.isArray(r.symbols) ? r.symbols : [])) for (const t of s.tests || []) out.add(t);
  }
  return [...out].filter((f) => fs.existsSync(path.join(root, f))).sort();
}

function failedNames(text) {
  const out = [];
  const add = (s) => { s = String(s).trim(); if (s && !out.includes(s) && out.length < 10) out.push(s.slice(0, 160)); };
  for (const l of String(text).split(/\r?\n/)) {
    let m;
    if ((m = /^\s*not ok \d+ - (.+?)(\s+#.*)?$/.exec(l))) add(m[1]);
    else if ((m = /^\s*✖ (.+?)(\s+\(\d[\d.]*m?s\))?$/.exec(l))) add(m[1]);
    else if ((m = /^\s*●\s+(.+)$/.exec(l))) add(m[1]);
    else if ((m = /^\s*(?:×|✕)\s+(.+?)(\s+\d+m?s)?$/.exec(l))) add(m[1]);
    else if ((m = /^FAILED\s+(\S+)/.exec(l))) add(m[1]);
    else if ((m = /^\s*\d+\) (.+)$/.exec(l)) && /fail|error/i.test(text)) add(m[1]);
  }
  return out;
}

// A parent node --test run sets NODE_TEST_CONTEXT; a child run that sees it
// reports to that parent and exits 0. The step must see its own result.
function cleanEnv() {
  const env = Object.assign({}, process.env, { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" });
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runStep(root, step, command, dir = ".") {
  const t = Date.now();
  const r = spawnSync(command, {
    cwd: absDir(root, dir), shell: true, encoding: "utf8", timeout: TIMEOUT[step], windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env: cleanEnv(),
  });
  const exit = r.error ? (r.error.code === "ETIMEDOUT" ? 124 : 127) : r.status == null ? 1 : r.status;
  const text = String(r.stdout || "") + String(r.stderr || "") + (r.error ? `\n${r.error.message}` : "");
  const out = { step, dir, cmd: command, exit, ms: Date.now() - t, passed: exit === 0, failed: exit === 0 ? [] : failedNames(text) };
  if (exit !== 0) out.tail = text.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join("\n");
  return out;
}

function fit(out) {
  const size = () => Buffer.byteLength(JSON.stringify(out), "utf8");
  if (size() <= MAX_BYTES) return out;
  const withTail = out.steps.filter((s) => s.tail);
  for (const keep of [20, 10, 5, 2]) {
    for (const s of withTail) s.tail = s.tail.split("\n").slice(-keep).join("\n");
    if (size() <= MAX_BYTES) return out;
  }
  for (const s of withTail) s.tail = s.tail.split("\n").slice(-2).join("\n").slice(-200);
  // A skipped step has no failed[] and no cmd: it must not throw here (0.1.0 did, and printed nothing).
  if (size() > MAX_BYTES) {
    for (const s of out.steps) {
      if (Array.isArray(s.failed)) s.failed = s.failed.slice(0, 3);
      if (typeof s.cmd === "string" && s.cmd.length > 200) s.cmd = s.cmd.slice(0, 200) + "…";
      if (Array.isArray(s.files)) s.files = s.files.slice(0, 3);
    }
  }
  out.trimmed = true;
  return out;
}

function check(root, { build = false, full = false, lintOnly = false } = {}) {
  let commands = {};
  try { commands = require("./wiki.js").commands(root) || {}; } catch (_) { commands = {}; }
  const files = changedFiles(root);
  const steps = [];
  let coverage = null;
  if (!files.length && !build && !full) return { ok: true, changed: 0, steps: [], note: "no changed files" };
  if (!lintOnly) {
    const tests = files.length ? affectedTests(root, files) : [];
    if (!tests.length) steps.push({ step: "tests", skipped: files.length ? "no affected tests" : "no changes" });
    const srcG = groupByProject(root, files.filter((f) => !isTest(f) && /.(m?[jt]sx?|cjs|vue)$/i.test(f)));
    for (const [d, tf] of Object.entries(groupByProject(root, tests))) {
      const ad = absDir(root, d);
      const run = runner(ad);
      if (!run) { steps.push({ step: "tests", dir: d, skipped: "no test runner found", files: tf.slice(0, 10) }); continue; }
      const src = srcG[d] || [];
      const cov = run.name === "jest" && src.length && coverageOn(ad);
      const cd = covDir(root, d);
      if (cov) clearCoverage(ad, cd);
      steps.push(runStep(root, "tests", run.cmd(tf) + (cov ? coverageArgs(src, cd) : ""), d));
    }
  }
  // Tests ran here, or (--lint-only) the executor's coverage command wrote the data.
  const srcFiles = files.filter((f) => !isTest(f) && /\.(m?[jt]sx?|cjs|vue)$/i.test(f));
  if (srcFiles.length) coverage = readCoverage(root, groupByProject(root, srcFiles));
  const fileG = files.length ? groupByProject(root, files) : {};
  let anyLint = false;
  for (const [d, ff] of Object.entries(fileG)) {
    const lint = lintCmd(absDir(root, d), ff, d === "." ? commands : null);
    if (lint) { anyLint = true; steps.push(runStep(root, "lint", lint, d)); }
  }
  if (!anyLint && lintOnly) steps.push({ step: "lint", skipped: "no lint command" });
  if (!lintOnly) {
    for (const d of Object.keys(fileG)) {
      const tc = typecheckCmd(absDir(root, d));
      if (tc) steps.push(runStep(root, "typecheck", tc, d));
    }
  }
  if (build) {
    const b = buildCmd(root, commands);
    steps.push(b ? runStep(root, "build", b) : { step: "build", skipped: "no build command" });
  }
  if (full) {
    const f = fullTestCmd(root, commands);
    steps.push(f ? runStep(root, "full", f) : { step: "full", skipped: "no test command" });
  }
  const ran = steps.filter((s) => !s.skipped);
  const ok = ran.every((s) => s.passed);
  const out = { ok, changed: files.length, steps };
  if (coverage) out.coverage = coverage;
  if (!ran.length) out.note = "nothing to run";
  return fit(out);
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function cmd(argv = []) {
  try { return cmdInner(argv); } catch (e) {
    // Always one JSON object: an internal error must not leave stdout empty.
    emit({ error: String((e && e.message) || e).slice(0, 300) });
    return 2;
  }
}

function cmdInner(argv) {
  const dir = valueOf(argv, "--dir");
  const root = dir ? path.resolve(dir) : paths.repoRoot();
  const slug = valueOf(argv, "--run");
  const out = check(root, { build: argv.includes("--build"), full: argv.includes("--full"), lintOnly: argv.includes("--lint-only") });
  if (slug) {
    try {
      require("./runs.js").addCheck(root, slug, {
        at: new Date().toISOString(), ok: out.ok,
        steps: out.steps.map((s) => ({ step: s.step, exit: s.exit ?? null, passed: s.passed ?? null, skipped: s.skipped || null, failed: s.failed || [] })),
      });
    } catch (e) { out.record_error = String(e.message).slice(0, 120); }
  }
  // --review: write the review packet after the lint result is in run.json (one call, not two).
  if (argv.includes("--review") && slug) {
    if (argv.includes("--lint-only")) out.tests = "trusted: executor reported green";
    try {
      const r = require("./review.js").reviewPrep(root, slug, { tier: valueOf(argv, "--tier") });
      out.review = { path: r.path, bytes: r.bytes, dispatch: r.dispatch, reason: r.reason };
    } catch (e) { out.review = { error: String(e.message).slice(0, 200) }; }
  }
  if (wantsJson(argv)) emit(out);
  else {
    const L = out.steps.map((s) => s.skipped ? `${s.step}: skipped — ${s.skipped}` : `${s.step}: ${s.passed ? "pass" : `FAIL (exit ${s.exit})`} · ${s.ms} ms · ${s.cmd}${s.failed.length ? `\n  failed: ${s.failed.join(", ")}` : ""}${s.tail ? `\n${s.tail}` : ""}`);
    if (out.review) L.push(out.review.error ? `review: error — ${out.review.error}` : `review: ${out.review.path} (${out.review.bytes} bytes) · dispatch ${out.review.dispatch} — ${out.review.reason}`);
    process.stdout.write(L.join("\n") + "\n");
  }
  return out.ok ? 0 : 1;
}

module.exports = { covDir, projectDir, groupByProject, coverageOn, coverageArgs, readCoverage, changedFiles, runner, affectedTests, failedNames, lintCmd, typecheckCmd, isTest, check, cmd, fit, MAX_BYTES };
