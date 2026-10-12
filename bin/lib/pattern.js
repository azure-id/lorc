"use strict";
// lorc pattern — which pattern keys a change needs, are they cached, and the
// Conventions + Invariants text of a cached pattern. Keys follow ORC's
// orc-pattern/references/INDEX.md table (vue, react, nextjs, angular, ...).

const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");
const core = require("./core.js");
const { wantsJson, emit } = require("./json.js");

const SECTIONS_MAX = 2500;
const claudeOf = (root) => path.join(root, ".claude");

function deps(root) {
  if (!root) return {};
  const p = paths.readJson(path.join(root, "package.json"), null) || {};
  return Object.assign({}, p.dependencies, p.devDependencies);
}

function pyDeps(root) {
  if (!root) return "";
  let t = "";
  for (const f of ["pyproject.toml", "requirements.txt"]) {
    try { t += fs.readFileSync(path.join(root, f), "utf8").toLowerCase(); } catch (_) { /* none */ }
  }
  return t;
}

// The INDEX "Detect from" column, as code: extension first, then the
// package.json / pyproject dependency check for the framework.
function langsForFiles(files, root) {
  const d = deps(root);
  const out = new Set();
  let py = null;
  for (const f of files || []) {
    const ext = path.extname(String(f)).toLowerCase();
    if (ext === ".vue") out.add("vue");
    else if (ext === ".jsx" || ext === ".tsx") out.add(d.next ? "nextjs" : "react");
    else if (ext === ".go") out.add("go");
    else if (ext === ".py") {
      if (py === null) py = pyDeps(root);
      if (/\bfastapi\b/.test(py)) out.add("fastapi");
      if (/\bdjango\b/.test(py) || (root && fs.existsSync(path.join(root, "manage.py")))) out.add("django");
    } else if ([".js", ".ts", ".mjs", ".cjs"].includes(ext)) {
      if (d["@nestjs/core"]) out.add("nestjs");
      else if (d["@angular/core"] && ext === ".ts") out.add("angular");
      else if (d.express) out.add("express");
      else if (d.next) out.add("nextjs");
      else if (d.vue) out.add("vue");
      else if (d.react) out.add("react");
    }
  }
  return [...out];
}

function ownStatus(root, lang, home) {
  const p = core.patternCore({ home });
  const cd = claudeOf(root);
  const { obj } = p.patternStatusData(cd, lang);
  return { lang, cached: obj.cached, path: path.join(p.patternsDir(cd), `${lang}-pattern.md`) };
}

function status(root, langs, { home } = {}) {
  const p = core.patternCore({ home });
  const cd = claudeOf(root);
  const list = langs && langs.length ? langs : p.listPatternLangs(cd);
  const orc = paths.findOrc(root, home);
  return list.map((lang) => {
    if (orc.delegate) {
      const r = core.orcRun(orc.cli, ["pattern", "status", lang], root);
      if (r.status === 0 || r.status === 1 || r.status === 2) {
        return { lang, cached: r.status === 0, path: path.join(p.patternsDir(cd), `${lang}-pattern.md`), source: "orc" };
      }
    }
    return Object.assign(ownStatus(root, lang, home), { source: "own" });
  });
}

function section(text, name) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\b`, "i").test(l));
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join("\n").trim();
}

function cutBytes(text, max) {
  if (max <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  const lines = text.split("\n");
  while (lines.length && Buffer.byteLength(lines.join("\n"), "utf8") > max) lines.pop();
  return lines.join("\n");
}

// ≤ 2,500 bytes total. Conventions are cut first; invariants are never cut.
function sections(root, lang, { home } = {}) {
  const file = path.join(core.patternCore({ home }).patternsDir(claudeOf(root)), `${lang}-pattern.md`);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return null; }
  const invariants = section(text, "Invariants");
  const room = SECTIONS_MAX - Buffer.byteLength(invariants, "utf8") - 1;
  const conventions = cutBytes(section(text, "Conventions"), room);
  return { conventions, invariants };
}

function cmd(argv = []) {
  const json = wantsJson(argv);
  const root = core.argRoot(argv);
  const pos = core.positionals(argv);
  const sub = pos[0] || "status";
  if (sub === "status") {
    const rows = status(root, pos[1] ? [pos[1]] : []);
    if (json) emit({ patterns: rows });
    else process.stdout.write(rows.length ? rows.map((r) => `${r.lang}  ${r.cached ? "cached" : "missing"}  ${r.path}`).join("\n") + "\n" : "no cached pattern\n");
    return pos[1] ? (rows[0] && rows[0].cached ? 0 : 1) : 0;
  }
  if (sub === "show") {
    if (!pos[1]) { process.stderr.write("lorc pattern show: name a language key\n"); return 2; }
    const s = sections(root, pos[1]);
    if (!s) { if (json) emit({ lang: pos[1], cached: false }); else process.stderr.write(`no cached pattern for ${pos[1]}\n`); return 1; }
    if (json) emit(Object.assign({ lang: pos[1], cached: true }, s));
    else process.stdout.write(`${s.conventions}\n\n${s.invariants}\n`);
    return 0;
  }
  process.stderr.write(`lorc pattern: unknown action "${sub}" — use: status [<lang>] | show <lang>\n`);
  return 2;
}

module.exports = { SECTIONS_MAX, langsForFiles, status, sections, cmd };
