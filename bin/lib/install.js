"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const PKG_ROOT = path.join(__dirname, "..", "..");
const TREES = ["skills", "commands", "agents", "hooks"];
const HOOKS = [
  { event: "PreToolUse", matcher: "Grep|Glob", file: "lorc-graph-hook.js" },
  { event: "SubagentStop", file: "lorc-graph-hook.js" },
];

function pkgVersion(pkgRoot = PKG_ROOT) {
  return (paths.readJson(path.join(pkgRoot, "package.json"), {}) || {}).version || "0.0.0";
}

function walk(dir, base, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    const abs = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(abs, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

// Relative paths (forward slashes) of every payload file, e.g. "skills/lorc/SKILL.md".
function payload(pkgRoot = PKG_ROOT) {
  const files = [];
  for (const t of TREES) {
    for (const rel of walk(path.join(pkgRoot, "templates", t), "", [])) files.push(`${t}/${rel}`);
  }
  return files.sort();
}

// templates/agents-all/* installs into agents/ only when the lorc setting
// `executors` is `all`. Returns [rel-in-claudeDir, src-abs] pairs.
function extraAgents(pkgRoot, claudeDir, home) {
  let mode = "core";
  try { mode = require("./settings.js").load(path.dirname(claudeDir), { home }).values.executors; } catch (_) { /* default core */ }
  if (mode !== "all") return [];
  const dir = path.join(pkgRoot, "templates", "agents-all");
  return walk(dir, "", []).sort().map((rel) => [`agents/${rel}`, path.join(dir, ...rel.split("/"))]);
}

function manifestPath(claudeDir) {
  return path.join(claudeDir, "lorc", "install-manifest.json");
}

function readManifest(claudeDir) {
  const m = paths.readJson(manifestPath(claudeDir), null);
  return m && Array.isArray(m.files) ? m : null;
}

function safeToPrune(rel) {
  if (typeof rel !== "string" || rel.includes("..") || path.isAbsolute(rel)) return false;
  const top = rel.split("/")[0];
  return TREES.includes(top) && rel.split("/").length > 1;
}

function removeEmptyParents(claudeDir, rel) {
  const parts = rel.split("/");
  for (let n = parts.length - 1; n >= 2; n--) {
    const dir = path.join(claudeDir, ...parts.slice(0, n));
    try {
      if (fs.readdirSync(dir).length) return;
      fs.rmdirSync(dir);
    } catch (_) { return; }
  }
}

function hookCommand(claudeDir, file) {
  return `node "${path.join(claudeDir, "hooks", file).replace(/\\/g, "/")}"`;
}

function wireHooks(claudeDir, pkgRoot, warnings) {
  const wanted = HOOKS.filter((h) => fs.existsSync(path.join(pkgRoot, "templates", "hooks", h.file)));
  if (!wanted.length) return 0;
  const file = path.join(claudeDir, "settings.json");
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("not an object");
    } catch (_) {
      const lines = wanted.map((h) => JSON.stringify({
        [h.event]: [{ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: hookCommand(claudeDir, h.file) }] }],
      }));
      warnings.push(`settings.json does not parse — not changed; add these under "hooks": ${lines.join(" ")}`);
      return 0;
    }
  }
  if (!cfg.hooks || typeof cfg.hooks !== "object") cfg.hooks = {};
  let added = 0;
  for (const h of wanted) {
    const list = Array.isArray(cfg.hooks[h.event]) ? cfg.hooks[h.event] : (cfg.hooks[h.event] = []);
    const has = list.some((ent) => ent && Array.isArray(ent.hooks) && (h.matcher === undefined || ent.matcher === h.matcher)
      && ent.hooks.some((x) => x && typeof x.command === "string" && x.command.includes(h.file)));
    if (has) continue;
    const ent = {};
    if (h.matcher) ent.matcher = h.matcher;
    ent.hooks = [{ type: "command", command: hookCommand(claudeDir, h.file) }];
    list.push(ent);
    added++;
  }
  // 0.1.3: the PostToolUse changes card is gone — remove an old lorc entry (only lorc-graph-hook).
  let removed = 0;
  if (Array.isArray(cfg.hooks.PostToolUse)) {
    const keep = [];
    for (const ent of cfg.hooks.PostToolUse) {
      if (ent && Array.isArray(ent.hooks)) {
        const rest = ent.hooks.filter((x) => !(x && typeof x.command === "string" && x.command.includes("lorc-graph-hook")));
        if (rest.length !== ent.hooks.length) { removed++; if (!rest.length) continue; keep.push({ ...ent, hooks: rest }); continue; }
      }
      keep.push(ent);
    }
    if (removed) { if (keep.length) cfg.hooks.PostToolUse = keep; else delete cfg.hooks.PostToolUse; }
  }
  if (added || removed) paths.atomicWrite(file, JSON.stringify(cfg, null, 2) + "\n");
  return added;
}

function install({ claudeDir, overwrite = false, prune = false, pkgRoot = PKG_ROOT, home } = {}) {
  const version = pkgVersion(pkgRoot);
  const base = payload(pkgRoot);
  const src = new Map(base.map((rel) => [rel, path.join(pkgRoot, "templates", ...rel.split("/"))]));
  for (const [rel, abs] of extraAgents(pkgRoot, claudeDir, home)) if (!src.has(rel)) src.set(rel, abs);
  const files = [...src.keys()].sort();
  const warnings = [];
  let copied = 0, kept = 0, pruned = 0;
  const prev = readManifest(claudeDir);
  for (const rel of files) {
    const dst = path.join(claudeDir, ...rel.split("/"));
    if (!overwrite && fs.existsSync(dst)) { kept++; continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src.get(rel), dst);
    copied++;
  }
  if (prune && prev) {
    const now = new Set(files);
    for (const rel of prev.files) {
      if (now.has(rel) || !safeToPrune(rel)) continue;
      const abs = path.join(claudeDir, ...rel.split("/"));
      try {
        if (fs.statSync(abs).isFile()) { fs.unlinkSync(abs); pruned++; removeEmptyParents(claudeDir, rel); }
      } catch (_) { /* gone already */ }
    }
  }
  paths.atomicWrite(manifestPath(claudeDir), JSON.stringify({ version, files }, null, 2) + "\n");
  paths.atomicWrite(path.join(claudeDir, "lorc", "version.json"), JSON.stringify({
    version, cli: path.join(pkgRoot, "bin", "lorc.js"), installed_at: new Date().toISOString(),
  }, null, 2) + "\n");
  const hooks = wireHooks(claudeDir, pkgRoot, warnings);
  return { version, claudeDir, copied, kept, pruned, hooks, warnings };
}

function scopeFlags(argv) {
  const out = [];
  if (argv.includes("--global")) out.push("--global");
  const i = argv.indexOf("--dir");
  if (i >= 0 && argv[i + 1]) out.push("--dir", argv[i + 1]);
  return out;
}

function where(argv) {
  const claudeDir = paths.resolveClaudeDir(argv);
  const root = path.dirname(claudeDir);
  const m = readManifest(claudeDir);
  let settingsFiles = null;
  try { settingsFiles = require("./settings.js").load(root).files; } catch (_) { /* optional */ }
  const orc = paths.findOrc(root);
  const res = {
    claudeDir,
    projectData: paths.projectLorcDir(root),
    globalData: paths.globalLorcDir(),
    manifest: manifestPath(claudeDir),
    installedVersion: m ? m.version : null,
    settings: settingsFiles,
    orc: { installed: orc.installed, version: orc.version, delegate: orc.delegate, reason: orc.reason },
  };
  if (wantsJson(argv)) { emit(res); return 0; }
  const lines = [
    `claude dir:   ${res.claudeDir}`,
    `project data: ${res.projectData}`,
    `global data:  ${res.globalData}`,
    `manifest:     ${res.manifest} (${res.installedVersion ? "v" + res.installedVersion : "not installed"})`,
  ];
  if (settingsFiles) lines.push(`settings:     ${settingsFiles.project} | ${settingsFiles.global}`);
  lines.push(`orc:          ${orc.installed ? "installed " + orc.version : "not installed"}; delegate ${orc.delegate ? "yes" : "no"}${orc.reason ? " (" + orc.reason + ")" : ""}`);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function upgrade(argv) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const flags = scopeFlags(argv);
  const install1 = [npm, "i", "-g", "@azure-id/lorc@latest"];
  if (argv.includes("--dry-run")) {
    process.stdout.write(`${install1.join(" ")}\nnode <npm root -g>/@azure-id/lorc/bin/lorc.js update ${flags.join(" ")}`.trimEnd() + "\n");
    return 0;
  }
  // npm.cmd on win32 needs a shell to start; the arguments are fixed, not user input.
  const opts = { stdio: "inherit", shell: process.platform === "win32", windowsHide: true };
  const r = spawnSync(install1[0], install1.slice(1), opts);
  if (r.status !== 0) { process.stderr.write("lorc upgrade: npm install failed\n"); return 1; }
  const g = spawnSync(npm, ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32", windowsHide: true });
  const groot = (g.stdout || "").trim();
  if (!groot) { process.stderr.write("lorc upgrade: npm root -g gave no path\n"); return 1; }
  const cli = path.join(groot, "@azure-id", "lorc", "bin", "lorc.js");
  const u = spawnSync(process.execPath, [cli, "update", ...flags], { stdio: "inherit", windowsHide: true });
  return u.status === null ? 1 : u.status;
}

function cmd(argv = [], name = "update") {
  if (name === "where") return where(argv);
  if (name === "upgrade") return upgrade(argv);
  const claudeDir = paths.resolveClaudeDir(argv);
  const res = install({
    claudeDir,
    overwrite: name !== "init",
    prune: name === "prune" || (name === "update" && argv.includes("--prune")),
  });
  if (wantsJson(argv)) { emit(res); return 0; }
  for (const w of res.warnings) process.stderr.write(`lorc: warning: ${w}\n`);
  process.stdout.write(`lorc ${res.version} → ${res.claudeDir}: ${res.copied} copied, ${res.kept} kept, ${res.pruned} pruned, ${res.hooks} hooks wired\n`);
  return 0;
}

module.exports = { PKG_ROOT, TREES, HOOKS, payload, readManifest, manifestPath, pkgVersion, install, hookCommand, cmd };
