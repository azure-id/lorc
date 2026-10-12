"use strict";
// lorc extra — non-Claude executors. ORC's extra ledger is READ ONLY here: when
// ORC has profiles and a delegate, lorc goes through `orc extra`. Else lorc's own
// lean file: { "profiles": [ { "name", "base_url", "model", "key_env" } ] }.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths.js");
const core = require("./core.js");
const settings = require("./settings.js");
const { wantsJson, emit } = require("./json.js");

const KEY_FIELDS = ["key", "api_key", "apiKey", "token", "auth_token", "secret"];

function hasProfiles(obj) {
  return !!(obj && Array.isArray(obj.profiles) && obj.profiles.length);
}

function orcLedger(root, home) {
  for (const f of [path.join(root, ".claude", "orc", "extra.json"), path.join(paths.homeClaude(home), "orc", "extra.json")]) {
    if (hasProfiles(paths.readJson(f, null))) return f;
  }
  return null;
}

// A profile with a key on disk is refused; key_env must name an env variable.
function checkProfile(p) {
  if (!p || typeof p !== "object") return "not an object";
  for (const k of KEY_FIELDS) if (k in p) return `profile "${p.name || "?"}" has a key on disk (field "${k}") — use key_env`;
  for (const k of ["name", "base_url", "model", "key_env"]) {
    if (typeof p[k] !== "string" || !p[k]) return `profile "${p.name || "?"}" has no ${k}`;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.key_env)) return `profile "${p.name}" key_env is not an environment variable name`;
  return null;
}

function ownProfiles(root, home) {
  for (const f of [path.join(paths.projectLorcDir(root), "extra.json"), path.join(paths.globalLorcDir(home), "extra.json")]) {
    const obj = paths.readJson(f, null);
    if (!hasProfiles(obj)) continue;
    const good = [];
    const refused = [];
    for (const p of obj.profiles) {
      const err = checkProfile(p);
      if (err) refused.push(err);
      else good.push(p);
    }
    return { file: f, profiles: good, refused };
  }
  return null;
}

function slotNames(json) {
  if (!json || typeof json !== "object") return [];
  if (Array.isArray(json.slots) && json.slots.length) {
    return json.slots.map((s) => (typeof s === "string" ? s : s && (s.slot || s.name))).filter(Boolean);
  }
  return (json.profiles || []).map((p) => p && (p.name || p.id)).filter(Boolean);
}

function detect(root, { home } = {}) {
  if (settings.load(root, { home }).values.extra === "off") return { source: "none", slots: [], reason: "settings.extra off" };
  const ledger = orcLedger(root, home);
  if (ledger) {
    const orc = paths.findOrc(root, home);
    if (orc.delegate) {
      const r = core.orcRun(orc.cli, ["extra", "list", "--json"], root);
      if (r.json) return { source: "orc", slots: slotNames(r.json), cli: orc.cli };
    }
  }
  const own = ownProfiles(root, home);
  if (own && own.profiles.length) {
    return { source: "lorc", slots: own.profiles.map((p) => p.name), file: own.file, refused: own.refused };
  }
  return { source: "none", slots: [], ...(own && own.refused.length ? { refused: own.refused } : {}) };
}

function tail(text, n = 2000) {
  const s = String(text || "");
  return s.length > n ? s.slice(-n) : s;
}

function redact(text, secret) {
  return secret ? String(text).split(secret).join("[key]") : String(text);
}

function dispatch(root, { slot, slicePath, home } = {}) {
  const d = detect(root, { home });
  if (d.source === "none") return { ok: false, exit: 3, tail: "no extra executor" };
  if (!d.slots.includes(slot)) return { ok: false, exit: 2, tail: `unknown slot "${slot}"` };
  const slice = path.resolve(root, slicePath);
  if (!fs.existsSync(slice)) return { ok: false, exit: 2, tail: `no slice file ${slice}` };

  if (d.source === "orc") {
    const sliceText = fs.readFileSync(slice, "utf8");
    const task = {
      task_id: `lorc-${Date.now()}`,
      slot,
      score: null,
      role: "executor",
      risk: [],
      cwd: root,
      prompt: sliceText,
    };
    const taskFile = path.join(paths.projectLorcDir(root), "extra-tasks", `${task.task_id}.json`);
    paths.atomicWrite(taskFile, JSON.stringify(task, null, 2) + "\n");
    const r = core.orcRun(d.cli, ["extra", "dispatch", "--task", taskFile, "--json"], root);
    return { ok: r.status === 0, exit: r.status, tail: tail(r.stdout + r.stderr), source: "orc" };
  }

  const own = ownProfiles(root, home);
  const p = own.profiles.find((x) => x.name === slot);
  const key = process.env[p.key_env];
  if (!key) return { ok: false, exit: 3, tail: `environment variable ${p.key_env} is not set` };
  const prompt = `Read ${slice}. Do exactly that task. Return the JSON at its end.`;
  const env = Object.assign({}, process.env, { ANTHROPIC_BASE_URL: p.base_url, ANTHROPIC_AUTH_TOKEN: key });
  const t0 = Date.now();
  const bin = process.env.LORC_CLAUDE_BIN || "claude";
  const r = spawnSync(bin, ["--bare", "-p", prompt, "--model", p.model], {
    cwd: root, env, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" && !process.env.LORC_CLAUDE_BIN,
  });
  const ms = Date.now() - t0;
  const exit = r.error ? 127 : r.status;
  const row = { at: new Date().toISOString(), slot, model: p.model, exit, ms };
  const log = path.join(paths.projectLorcDir(root), "extra-spend.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify(row) + "\n");
  const out = r.error ? r.error.message : (r.stdout || "") + (r.stderr || "");
  return { ok: exit === 0, exit, tail: redact(tail(out), key), source: "lorc" };
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function cmd(argv = []) {
  const json = wantsJson(argv);
  const root = core.argRoot(argv);
  const pos = core.positionals(argv, ["--slot", "--slice"]);
  const sub = pos[0] || "status";
  if (sub === "status" || sub === "list") {
    const d = detect(root);
    const out = sub === "list" ? { source: d.source, slots: d.slots } : d;
    if (json) emit(out);
    else process.stdout.write(`source: ${d.source}\nslots: ${d.slots.join(", ") || "none"}\n${(d.refused || []).map((x) => `refused: ${x}\n`).join("")}`);
    return 0;
  }
  if (sub === "dispatch") {
    const slot = valueOf(argv, "--slot");
    const slicePath = valueOf(argv, "--slice");
    if (!slot || !slicePath) { process.stderr.write("lorc extra dispatch: --slot <s> --slice <path>\n"); return 2; }
    const r = dispatch(root, { slot, slicePath });
    if (json) emit(r);
    else process.stdout.write(`exit ${r.exit}\n${r.tail}\n`);
    return r.ok ? 0 : (Number.isInteger(r.exit) && r.exit > 0 ? r.exit : 1);
  }
  process.stderr.write(`lorc extra: unknown action "${sub}" — use: status | list | dispatch --slot <s> --slice <path>\n`);
  return 2;
}

module.exports = { detect, dispatch, checkProfile, cmd };
