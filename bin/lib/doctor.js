"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths.js");
const inst = require("./install.js");
const { wantsJson, emit } = require("./json.js");

function tryReq(name) {
  try { return require(`./${name}`); } catch (_) { return null; }
}

function checks({ claudeDir, pkgRoot = inst.PKG_ROOT, home } = {}) {
  const out = [];
  const root = path.dirname(claudeDir);
  const pkgV = inst.pkgVersion(pkgRoot);
  const m = inst.readManifest(claudeDir);
  const FIX = "lorc doctor --fix";

  out.push(m
    ? { id: "version", ok: m.version === pkgV, detail: `installed ${m.version}, package ${pkgV}`, fix: "lorc update" }
    : { id: "version", ok: false, detail: "no install manifest", fix: "lorc init" });

  const missing = m ? m.files.filter((f) => !fs.existsSync(path.join(claudeDir, ...f.split("/")))) : [];
  out.push({ id: "files", ok: missing.length === 0, detail: missing.length ? `${missing.length} missing: ${missing.slice(0, 5).join(", ")}` : "all manifest files present", fix: FIX });

  const listed = new Set(m ? m.files : []);
  const orphans = [];
  for (const t of inst.TREES) {
    const dir = path.join(claudeDir, t);
    let ents = [];
    try { ents = fs.readdirSync(dir, { recursive: true }); } catch (_) { /* no tree */ }
    for (const e of ents) {
      const rel = `${t}/${String(e).replace(/\\/g, "/")}`;
      if (!/(^|\/)lorc-[^/]*$/.test(rel) && !rel.split("/").some((p) => p.startsWith("lorc-") || p === "lorc")) continue;
      try { if (!fs.statSync(path.join(claudeDir, ...rel.split("/"))).isFile()) continue; } catch (_) { continue; }
      if (!listed.has(rel)) orphans.push(rel);
    }
  }
  out.push({ id: "orphans", ok: orphans.length === 0, detail: orphans.length ? `${orphans.length} not in manifest: ${orphans.slice(0, 5).join(", ")}` : "none", fix: "lorc prune" });

  const sFile = path.join(claudeDir, "settings.json");
  let cfg = null;
  let parses = true;
  if (fs.existsSync(sFile)) {
    try { cfg = JSON.parse(fs.readFileSync(sFile, "utf8")); } catch (_) { parses = false; }
  }
  out.push({ id: "settings-json", ok: parses, detail: parses ? (cfg ? "parses" : "no settings.json") : "settings.json does not parse", fix: "repair the JSON by hand" });

  const wanted = inst.HOOKS.filter((h) => fs.existsSync(path.join(pkgRoot, "templates", "hooks", h.file)));
  if (wanted.length) {
    const miss = wanted.filter((h) => {
      const list = cfg && cfg.hooks && Array.isArray(cfg.hooks[h.event]) ? cfg.hooks[h.event] : [];
      return !list.some((ent) => ent && Array.isArray(ent.hooks) && ent.hooks.some((x) => x && typeof x.command === "string" && x.command.includes(h.file)));
    });
    out.push({ id: "hooks", ok: miss.length === 0, detail: miss.length ? `not wired: ${miss.map((h) => h.event).join(", ")}` : `${wanted.length} wired`, fix: FIX });
  } else {
    out.push({ id: "hooks", ok: true, detail: "no hook in the payload" });
  }

  try {
    const sl = require("./statusline-cfg.js").lineStatus({ home, root });
    const w = sl.winner ? sl[sl.winner] : null;
    out.push({ id: "statusline", ok: true, detail: w ? `${sl.winner}: ${w.kind}` : "none set" });
  } catch (_) {
    out.push({ id: "statusline", ok: true, detail: "not checked" });
  }

  try {
    const u = require("./usage.js").readUsage(root, { home });
    out.push({ id: "usage", ok: true, detail: u ? `reading ${u.age_s}s old (${u.source})` : "no reading — unknown never stops a run" });
  } catch (_) {
    out.push({ id: "usage", ok: true, detail: "not checked" });
  }

  try {
    const j = require("./jev.js").status(root, { home });
    out.push({ id: "jev", ok: true, detail: j.tier_judge === "off" ? "tier_judge off — the built-in tier table decides"
      : j.connected ? `connected (${j.source}) · ${j.model} · ask_judge ${j.ask_judge}${j.base_ok ? "" : " · base URL refused (not https)"}` : "not connected — the built-in tier table decides" });
  } catch (_) {
    out.push({ id: "jev", ok: true, detail: "not checked" });
  }

  try {
    const sv = require("./settings.js").load(root, { home }).values;
    const c = paths.readJson(require("./tier-history.js").cacheFile(root), null);
    out.push({ id: "tier-engine", ok: true, detail: sv.tier_engine === "off" ? "off — the model reads the tier table"
      : `on · git history ${c ? `${c.commits.length} commits cached at ${String(c.head).slice(0, 7)}` : "not cached yet (the first lorc tier builds it)"}` });
  } catch (_) {
    out.push({ id: "tier-engine", ok: true, detail: "not checked" });
  }

  const orc = paths.findOrc(root, home);
  out.push({ id: "orc", ok: true, detail: `delegate ${orc.delegate ? "yes" : "no"}${orc.reason ? " (" + orc.reason + ")" : ""}` });

  const vendor = path.join(pkgRoot, "scripts", "vendor.js");
  if (fs.existsSync(vendor)) {
    const r = spawnSync(process.execPath, [vendor, "--check", "--root", pkgRoot], { encoding: "utf8", windowsHide: true, cwd: pkgRoot });
    out.push({ id: "vendor", ok: r.status === 0, detail: r.status === 0 ? "pins match" : (r.stderr || r.stdout || "check failed").trim().split("\n")[0], fix: "npm run vendor" });
  } else {
    out.push({ id: "vendor", ok: true, detail: "vendor: shipped copy" });
  }
  return out;
}

function run({ claudeDir, pkgRoot = inst.PKG_ROOT, home, fix = false } = {}) {
  let list = checks({ claudeDir, pkgRoot, home });
  let fixed = null;
  if (fix && list.some((c) => !c.ok)) {
    fixed = inst.install({ claudeDir, overwrite: true, prune: true, pkgRoot });
    list = checks({ claudeDir, pkgRoot, home });
  }
  return { ok: list.every((c) => c.ok), checks: list, fixed };
}

function format(list) {
  return list.map((c) => c.ok ? `✓ ${c.id} — ${c.detail}` : `✗ ${c.id} — ${c.detail}${c.fix ? ` (fix: ${c.fix})` : ""}`).join("\n") + "\n";
}

function cmd(argv = []) {
  const claudeDir = paths.resolveClaudeDir(argv);
  const res = run({ claudeDir, fix: argv.includes("--fix") });
  if (wantsJson(argv)) emit(res);
  else process.stdout.write(format(res.checks));
  return res.ok ? 0 : 1;
}

module.exports = { checks, run, format, cmd };
