"use strict";

const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const CORE_EXECUTORS = ["ask", "haiku-5-high", "sonnet-5-med", "opus-5-low", "opus-5-med"];
const ALL_EXECUTORS = CORE_EXECUTORS.concat([
  "haiku-4-5", "sonnet-4-6-med", "sonnet-4-6-high", "sonnet-5-high",
  "opus-4-7-med", "opus-4-7-high", "opus-4-8-high", "opus-5-high",
]);

const int = (min, max) => ({ type: "int", min, max });
const KEYS = {
  dispatch: { def: "auto", allowed: ["auto", "manual"], help: "auto = lorc starts executors; manual = lorc asks first" },
  dispatch_max: { def: 5, allowed: ["off", 1, 2, 3, 4, 5], help: "most executors at the same time (off = no executors)" },
  limit_pct: { def: 90, ...int(50, 99), help: "stop at this USED % of the 5-hour window" },
  limit_weekly_pct: { def: 98, ...int(50, 100), help: "stop at this USED % of the weekly window" },
  executor: { def: "ask", allowed: CORE_EXECUTORS, help: "the executor model (ask = lorc asks)" },
  executors: { def: "core", allowed: ["core", "all"], help: "core = 5 executor choices; all = every model" },
  review: { def: "auto", allowed: ["auto", "inline", "agent"], help: "how lorc reviews the change" },
  review_agent_min_lines: { def: 400, ...int(50, 5000), help: "auto review uses an agent from this many changed lines" },
  pattern_miss: { def: "ask", allowed: ["ask", "on", "off"], help: "what to do when no code pattern matches" },
  extra: { def: "auto", allowed: ["auto", "off"], help: "use ORC extra providers when ORC has them" },
  habits: { def: "observe", allowed: ["off", "observe", "propose"], help: "habit capture level" },
  house_rules_warn_kb: { def: 4, ...int(1, 64), help: "warn when house rules are bigger than this (KB)" },
  review_mute: { def: "", type: "pattern", re: /^[a-z,-]*$/, help: "finding categories lorc does not list at P2/P3 (comma list)" },
  statusline_writes_orc: { def: true, allowed: [true, false], help: "the status line also writes the ORC usage file" },
  tier_judge: { def: "auto", allowed: ["auto", "off"], help: "auto = TypeSafe jev picks the tier when a key is connected; off = the built-in table only" },
  tier_judge_min_conf: { def: 60, ...int(0, 99), help: "the lowest jev confidence (%) lorc accepts; below it the built-in table decides" },
  tier_engine: { def: "auto", allowed: ["auto", "off"], help: "auto = lorc's tier engine decides when jev does not; off = the model reads the tier table" },
  ask_judge: { def: "auto", allowed: ["auto", "off"], help: "auto = TypeSafe jev rates each L3 option (%) when a key is connected; off = lorc recommends alone" },
};
for (const k of Object.keys(KEYS)) KEYS[k].key = k;

const DEFAULTS = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, v.def]));

function files(root, home) {
  return {
    project: path.join(paths.projectLorcDir(root), "settings.json"),
    global: path.join(paths.globalLorcDir(home), "settings.json"),
  };
}

function readObj(file) {
  const o = paths.readJson(file, {});
  return o && typeof o === "object" && !Array.isArray(o) ? o : {};
}

function allowedFor(key, values) {
  const k = KEYS[key];
  if (key === "executor") return (values && values.executors === "all") ? ALL_EXECUTORS : CORE_EXECUTORS;
  if (k.type === "int") return [`integer ${k.min}-${k.max}`];
  if (k.type === "pattern") return [`text matching ${k.re}`];
  return k.allowed;
}

function validate(key, raw, values = {}) {
  const k = KEYS[key];
  if (!k) return { ok: false, error: `unknown key "${key}"` };
  let v = raw;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "true") v = true;
    else if (t === "false") v = false;
    else if (/^-?\d+$/.test(t)) v = Number(t);
    else v = t;
  }
  const bad = () => ({ ok: false, error: `bad value for ${key}: ${JSON.stringify(raw)} (allowed: ${allowedFor(key, values).join(", ")})` });
  if (k.type === "int") {
    if (!Number.isInteger(v) || v < k.min || v > k.max) return bad();
    return { ok: true, value: v };
  }
  if (k.type === "pattern") {
    const s = raw == null ? "" : String(raw).trim();
    return k.re.test(s) ? { ok: true, value: s } : bad();
  }
  if (!allowedFor(key, values).includes(v)) return bad();
  return { ok: true, value: v };
}

function load(root, { home } = {}) {
  const f = files(root, home);
  const proj = readObj(f.project);
  const glob = readObj(f.global);
  const values = {};
  const sources = {};
  // Resolve executors first: executor validity depends on it.
  const order = ["executors"].concat(Object.keys(KEYS).filter((k) => k !== "executors"));
  for (const key of order) {
    let picked = false;
    for (const [src, obj] of [["project", proj], ["global", glob]]) {
      if (!(key in obj)) continue;
      const r = validate(key, obj[key], values);
      if (r.ok) { values[key] = r.value; sources[key] = src; picked = true; break; }
    }
    if (!picked) { values[key] = DEFAULTS[key]; sources[key] = "default"; }
  }
  const ordered = {};
  for (const k of Object.keys(KEYS)) ordered[k] = values[k];
  return { values: ordered, sources, files: f };
}

function scopeFile(scope, root, home) {
  const f = files(root, home);
  return scope === "global" ? f.global : f.project;
}

function set(scope, root, key, raw, { home } = {}) {
  const r = validate(key, raw, load(root, { home }).values);
  if (!r.ok) return r;
  const file = scopeFile(scope, root, home);
  const obj = readObj(file);
  obj[key] = r.value;
  paths.atomicWrite(file, JSON.stringify(obj, null, 2) + "\n");
  return { ok: true, value: r.value, file };
}

function reset(scope, root, key, { home } = {}) {
  if (!KEYS[key]) return { ok: false, error: `unknown key "${key}"` };
  const file = scopeFile(scope, root, home);
  if (!fs.existsSync(file)) return { ok: true, file, removed: false };
  const obj = readObj(file);
  const removed = key in obj;
  delete obj[key];
  paths.atomicWrite(file, JSON.stringify(obj, null, 2) + "\n");
  return { ok: true, file, removed };
}

function rootOf(argv) {
  const dir = argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : null;
  return dir ? path.resolve(dir) : paths.repoRoot();
}

function cmd(argv = []) {
  const json = wantsJson(argv);
  const scope = argv.includes("--global") ? "global" : "project";
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") { i++; continue; }
    if (argv[i].startsWith("--")) continue;
    pos.push(argv[i]);
  }
  const root = rootOf(argv);
  const sub = pos[0] || "load";

  if (sub === "load") {
    const s = load(root);
    if (json) { emit(s); return 0; }
    const w = Math.max(...Object.keys(KEYS).map((k) => k.length));
    const lines = Object.keys(KEYS).map((k) => `  ${k.padEnd(w)}  ${String(s.values[k]).padEnd(12)}  ${s.sources[k]}`);
    lines.push("", `project: ${s.files.project}`, `global:  ${s.files.global}`);
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  }

  if (sub === "set" || sub === "reset") {
    const key = pos[1];
    if (!key || !KEYS[key]) {
      process.stderr.write(`lorc settings: unknown key "${key || ""}" — keys: ${Object.keys(KEYS).join(", ")}\n`);
      return 2;
    }
    if (sub === "set") {
      if (pos[2] === undefined) {
        process.stderr.write(`lorc settings: no value for ${key} (allowed: ${allowedFor(key, load(root).values).join(", ")})\n`);
        return 2;
      }
      const r = set(scope, root, key, pos[2]);
      if (!r.ok) { process.stderr.write(`lorc settings: ${r.error}\n`); return 2; }
      if (json) emit({ ok: true, key, value: r.value, scope, file: r.file });
      else process.stdout.write(`set ${key} = ${r.value} (${scope})\n`);
      return 0;
    }
    const r = reset(scope, root, key);
    if (json) emit({ ok: true, key, scope, removed: r.removed, file: r.file });
    else process.stdout.write(`reset ${key} (${scope})\n`);
    return 0;
  }

  process.stderr.write(`lorc settings: unknown action "${sub}" — use: settings | settings set <key> <value> | settings reset <key>\n`);
  return 2;
}

module.exports = { DEFAULTS, KEYS, CORE_EXECUTORS, ALL_EXECUTORS, load, validate, set, reset, cmd };
