"use strict";
// lorc wiki — status, pick, commands, sync. ORC delegate first, else the vendored wiki core.

const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");
const core = require("./core.js");
const { wantsJson, emit } = require("./json.js");

const claudeOf = (root) => path.join(root, ".claude");
const TIERS = new Set(["FRESH", "AGING", "STALE"]);
const PICK_MIN_SCORE = 3; // under this, the top match is weak: one title or area hit at most

function mapStatus(obj, source) {
  // ORC's state word, verbatim: none · unregistered · drifted · corrupt · registered.
  // A state other than none/registered needs only the free repair (wiki sync).
  const registered = obj && obj.state === "registered";
  return {
    state: obj && typeof obj.state === "string" && obj.state ? obj.state : "none",
    tier: registered && TIERS.has(obj.tier) ? obj.tier : null,
    docs: obj && Number.isInteger(obj.docs) ? obj.docs : 0,
    source,
  };
}

function ownStatus(root, home) {
  const w = core.wikiCore({ home });
  const cd = claudeOf(root);
  const s = w.wikiState(cd);
  return mapStatus(w.wikiStatusJson(cd, s, w.wikiPaths(cd)), "own");
}

function status(root, { home } = {}) {
  const orc = paths.findOrc(root, home);
  if (orc.delegate) {
    const r = core.orcRun(orc.cli, ["wiki", "status", "--json"], root);
    if (r.status === 0 && r.json && typeof r.json === "object") return mapStatus(r.json, "orc");
    return Object.assign(ownStatus(root, home), { fallback: `orc wiki status failed (exit ${r.status})` });
  }
  return ownStatus(root, home);
}

const wikiRel = (file) => ("wiki/" + String(file).replace(/\\/g, "/")).replace(/^wiki\/wiki\//, "wiki/");

function pickFrom(rows, max) {
  if (!rows.length || !(rows[0].score >= PICK_MIN_SCORE)) return [];
  return rows.slice(0, max).filter((r) => r.score >= PICK_MIN_SCORE).map((r) => wikiRel(r.file));
}

function pick(root, request, { max = 3, home } = {}) {
  const words = String(request || "").trim();
  if (!words) return [];
  max = Math.min(3, Math.max(1, max));
  const orc = paths.findOrc(root, home);
  if (orc.delegate) {
    const r = core.orcRun(orc.cli, ["wiki", "resolve", words, "--json"], root);
    if (r.json && Array.isArray(r.json.candidates)) return pickFrom(r.json.candidates, max);
  }
  const res = core.wikiCore({ home }).wikiResolve(claudeOf(root), words);
  return pickFrom(res.scored || [], max);
}

function commands(root) {
  const out = { build: null, test: null, lint: null, typecheck: null };
  const meta = paths.readJson(path.join(claudeOf(root), "orc", "wiki-meta.json"), null);
  const c = meta && meta.commands && typeof meta.commands === "object" ? meta.commands : null;
  if (c && Object.keys(c).length) {
    out.build = c.build || null;
    out.test = c.test || c.test_fast || null;
    out.lint = c.lint || null;
    out.typecheck = c.typecheck || c.type_check || null;
    return out;
  }
  const pkg = paths.readJson(path.join(root, "package.json"), null);
  const s = (pkg && pkg.scripts) || {};
  const run = (name) => (name === "test" ? "npm test" : `npm run ${name}`);
  const first = (...names) => { const n = names.find((x) => s[x]); return n ? run(n) : null; };
  out.build = first("build");
  out.test = first("test", "test:unit");
  out.lint = first("lint");
  out.typecheck = first("typecheck", "type-check");
  return out;
}

function sync(root, { home } = {}) {
  const orc = paths.findOrc(root, home);
  if (orc.delegate) {
    const r = core.orcRun(orc.cli, ["wiki", "sync"], root);
    if (r.status === 0) return { ok: true, source: "orc", changed: null };
  }
  const w = core.wikiCore({ home });
  const cd = claudeOf(root);
  const reg = w.buildRegistration(cd);
  if (!reg.docs.length) return { ok: true, source: "own", changed: false, docs: 0 };
  const plan = w.wikiSyncPlan(cd, reg);
  if (plan.changed) w.wikiSyncWrite(reg, plan.nextMeta);
  return { ok: true, source: "own", changed: plan.changed, docs: reg.docs.length };
}

function cmd(argv = []) {
  const json = wantsJson(argv);
  const root = core.argRoot(argv);
  const pos = core.positionals(argv);
  const sub = pos[0] || "status";
  let out;
  if (sub === "status") out = status(root);
  else if (sub === "sync") out = sync(root);
  else if (sub === "pick") out = { paths: pick(root, pos.slice(1).join(" ")) };
  else if (sub === "commands") out = commands(root);
  else {
    process.stderr.write(`lorc wiki: unknown action "${sub}" — use: status | sync | pick "<words>" | commands\n`);
    return 2;
  }
  if (json) emit(out);
  else if (sub === "pick") process.stdout.write(out.paths.length ? out.paths.join("\n") + "\n" : "no wiki page matches\n");
  else process.stdout.write(Object.entries(out).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n");
  return 0;
}

module.exports = { status, pick, commands, sync, cmd };
