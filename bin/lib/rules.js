"use strict";
// lorc rules — HOUSE-RULES.md, the lorc rules card, and the zero-token lint on
// changed lines. The rule packs and the lint come from the vendored rules core.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths.js");
const core = require("./core.js");
const settings = require("./settings.js");
const { wantsJson, emit } = require("./json.js");

const HOUSE_FILE = "HOUSE-RULES.md";
const TEMPLATE = path.join(__dirname, "..", "..", "templates", "HOUSE-RULES.template.md");
const LEVELS = ["P0", "P1", "P2", "P3"];
const CARD_CORE_MAX = 2560;
const UI_EXT = new Set([".vue", ".jsx", ".tsx", ".html", ".css", ".scss", ".svelte"]);
const WRITING_IDS = ["OSW-01", "OSW-10", "OSW-11", "OSW-23"];
const claudeOf = (root) => path.join(root, ".claude");

function parseHouse(text) {
  const blocks = { P0: "", P1: "", P2: "", P3: "" };
  let cur = null;
  const acc = { P0: [], P1: [], P2: [], P3: [] };
  const clean = String(text).replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  for (const line of clean.split("\n")) {
    const m = /^#{1,6}\s*(P[0-3])\b\s*[:.)-]?\s*$/.exec(line.trim());
    if (m) { cur = m[1]; continue; }
    if (cur) acc[cur].push(line);
  }
  for (const k of LEVELS) blocks[k] = acc[k].join("\n").trim();
  return blocks;
}

function house(root, { home } = {}) {
  const file = path.join(root, HOUSE_FILE);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return null; }
  const blocks = parseHouse(text);
  const rc = core.rulesCore({ home });
  const packs = rc.rulesReadPacks(claudeOf(root));
  // The core reads P0–P2 only; P3 joins P2 so an id named at P3 still counts.
  const asCore = { P0: blocks.P0, P1: blocks.P1, P2: [blocks.P2, blocks.P3].filter(Boolean).join("\n") };
  const overrides = rc.rulesOverrides(asCore, packs).map((o) => o.id);
  const bytes = Buffer.byteLength(text, "utf8");
  const kb = settings.load(root, { home }).values.house_rules_warn_kb;
  return { path: file, bytes, warn: bytes > kb * 1024, blocks, overrides };
}

function houseCard() {
  const f = path.join(core.SRC_SKILLS, "_shared", "phases", "house-rules.md");
  const text = fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const m = /<!-- card-start -->\n([\s\S]*?)\n<!-- card-end -->/.exec(text);
  return m ? m[1].trim() : "";
}

function isUi(files) {
  return (files || []).some((f) => UI_EXT.has(path.extname(String(f)).toLowerCase()));
}

function ruleLines(rules, oneLine, max) {
  return rules.map((r) => {
    const s = max > 0 ? oneLine(r.body, max) : "";
    return s ? `${r.id} · ${r.title} — ${s}` : `${r.id} · ${r.title}`;
  });
}

// Parts 2–4 of the card, cut to CARD_CORE_MAX by shortening each rule's sentence.
function coreParts(root, files, drop, home) {
  const rc = core.rulesCore({ home });
  const packs = rc.rulesReadPacks(claudeOf(root));
  const pick = (id, pred) => {
    const p = packs.packs.find((x) => x.id === id);
    return p ? p.rules.filter((r) => pred(r) && !drop.has(r.id)) : [];
  };
  const groups = [
    ["[Code]", pick("code", (r) => r.tier === "HARD")],
    ["[Delivery]", pick("delivery", (r) => r.tier === "HARD")],
    ["[Writing]", pick("writing", (r) => WRITING_IDS.includes(r.id))],
  ];
  const ui = isUi(files);
  if (ui) groups.push(["[UI]", pick("ui", () => true)]);
  const card = houseCard();
  // A sentence cut under 40 chars is noise: below that the line keeps id + title only.
  for (const max of [90, 80, 70, 60, 50, 40, 0]) {
    const L = [card, ""];
    for (const [title, rules] of groups) if (rules.length) L.push(title, ...ruleLines(rules, rc.rulesOneLine, max));
    const text = L.join("\n").trim();
    if (Buffer.byteLength(text, "utf8") <= CARD_CORE_MAX || max === 0) return { text, ui };
  }
  return { text: card, ui };
}

const P0_MAX = 1800;
// 0.1.5: layer 1 of ORC's house rules = the project's CLAUDE.md P0. Each heading that
// starts with "P0" (any # level) + its first 2 non-empty lines; a "# P0" section's bullets.
function projectP0(root) {
  let src;
  try { src = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"); } catch (_) { return ""; }
  const lines = src.split(/\r?\n/);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#+)\s+(P0\b.*)$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    const bullets = /^P0(\s+[A-Za-z][^—:]*)?$/.test(m[2].trim()); // "# P0", "# P0 NPM update"
    for (let j = i + 1; j < lines.length && !/^#+\s/.test(lines[j]); j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (bullets && /^[-*]\s/.test(t)) items.push(`- ${m[2].trim()}: ${t.replace(/^[-*]\s+/, "")}`);
      else if (!bullets && body.length < 2) body.push(t);
    }
    if (!bullets) items.push(`- ${m[2].trim()}${body.length ? " — " + body.join(" ") : ""}`);
  }
  if (!items.length) return "";
  const head = "## Project P0 rules (CLAUDE.md)";
  let kept = items.length;
  const make = (n) => [head, ...items.slice(0, n), ...(n < items.length ? [`(+${items.length - n} more in CLAUDE.md)`] : [])].join("\n");
  while (kept > 0 && Buffer.byteLength(make(kept), "utf8") > P0_MAX) kept--;
  return make(kept);
}

function buildCard(root, { files = [], out, home } = {}) {
  const h = house(root, { home });
  const drop = new Set(h ? h.overrides : []);
  const L = [];
  if (h && LEVELS.some((k) => h.blocks[k])) {
    L.push("## House rules (read first)", "");
    for (const k of LEVELS) if (h.blocks[k]) L.push(`### ${k}`, h.blocks[k], "");
  }
  const p0 = projectP0(root);
  if (p0) L.push(p0, "");
  const partsCore = coreParts(root, files, drop, home);
  L.push("## lorc rules", "", partsCore.text, "");
  const text = L.join("\n").replace(/\n{3,}/g, "\n\n");
  const file = out || path.join(paths.projectLorcDir(root), "rules-card.md");
  paths.atomicWrite(file, text);
  return { path: file, bytes: Buffer.byteLength(text, "utf8"), ui: partsCore.ui, core_bytes: Buffer.byteLength(partsCore.text, "utf8") };
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// file → Set of changed line numbers (null = every line: an untracked file).
function changedLines(root) {
  const map = new Map();
  const diff = git(root, ["diff", "HEAD", "-U0", "--no-color", "--no-ext-diff"]) || "";
  let file = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (file && !map.has(file)) map.set(file, new Set());
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const n = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = 0; i < n; i++) map.get(file).add(start + i);
    }
  }
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]) || "";
  for (const f of untracked.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) map.set(f, null);
  return map;
}

function lint(root, { diff = true, home } = {}) {
  const rc = core.rulesCore({ home });
  const packs = rc.rulesReadPacks(claudeOf(root));
  const h = house(root, { home });
  const drop = new Set(h ? h.overrides : []);
  const opts = {
    active: new Set(rc.RULE_LINT_IDS.filter((id) => !drop.has(id))),
    byId: new Map(packs.rules.map((r) => [r.id, r])),
    exempt: { packs: [], files: [] },
  };
  let targets;
  if (diff) {
    targets = [...changedLines(root).entries()].map(([rel, lines]) => ({ rel, lines }));
  } else {
    const acc = [];
    rc.lintWalk(root, "", acc, 0);
    targets = acc.map((a) => ({ rel: a.rel, lines: null }));
  }
  const out = [];
  for (const t of targets) {
    const abs = path.join(root, t.rel);
    if (!fs.existsSync(abs)) continue;
    for (const f of rc.lintScanFile(abs, t.rel, opts)) {
      if (drop.has(f.rule)) continue;
      if (t.lines && !t.lines.has(f.line)) continue;
      out.push({ id: f.rule, file: t.rel, line: f.line, text: f.evidence });
    }
  }
  return out;
}

function init(root) {
  const file = path.join(root, HOUSE_FILE);
  if (fs.existsSync(file)) return { ok: false, path: file, error: `${HOUSE_FILE} exists — lorc does not overwrite it` };
  fs.copyFileSync(TEMPLATE, file);
  return { ok: true, path: file };
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function cmd(argv = []) {
  const json = wantsJson(argv);
  const root = core.argRoot(argv);
  const pos = core.positionals(argv, ["--files", "--out"]);
  const sub = pos[0] || "show";
  if (sub === "init") {
    const r = init(root);
    if (json) emit(r);
    else if (r.ok) process.stdout.write(`wrote ${r.path}\n`);
    else process.stderr.write(`lorc rules: ${r.error}\n`);
    return r.ok ? 0 : 1;
  }
  if (sub === "show") {
    const h = house(root);
    if (json) emit(h || { path: path.join(root, HOUSE_FILE), exists: false });
    else if (!h) process.stdout.write(`no ${HOUSE_FILE} — run "lorc rules init"\n`);
    else process.stdout.write(LEVELS.map((k) => `## ${k}\n${h.blocks[k] || "(empty)"}`).join("\n\n") + `\n\noverrides: ${h.overrides.join(", ") || "none"}${h.warn ? `\nwarning: ${h.bytes} bytes` : ""}\n`);
    return 0;
  }
  if (sub === "card") {
    const files = (valueOf(argv, "--files") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const r = buildCard(root, { files, out: valueOf(argv, "--out") || undefined });
    if (json) emit(r);
    else process.stdout.write(`${r.path} (${r.bytes} bytes${r.ui ? ", ui" : ""})\n`);
    return 0;
  }
  if (sub === "lint") {
    const rows = lint(root, { diff: argv.includes("--diff") || !argv.includes("--all") });
    if (json) emit({ findings: rows });
    else process.stdout.write(rows.length ? rows.map((r) => `${r.file}:${r.line}  ${r.id}  ${r.text}`).join("\n") + "\n" : "no findings\n");
    return rows.length ? 1 : 0;
  }
  process.stderr.write(`lorc rules: unknown action "${sub}" — use: init | show | card [--files a,b] | lint [--diff]\n`);
  return 2;
}

module.exports = { HOUSE_FILE, CARD_CORE_MAX, P0_MAX, projectP0, parseHouse, house, buildCard, lint, init, cmd };
