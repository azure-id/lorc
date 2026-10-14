"use strict";
// lorc jev — the jev judges. With a TypeSafe API key, jev (a System One model,
// https://docs.typesafe.ai) picks the L2 tier of the request (`tier`) and rates each
// option of the L3 questions (`ask`). With no key, with the setting off, or on any
// failure, the answer is { by: "table" } (tier) or { by: "self" } (ask), and the skill
// decides as before. Fail-soft: `lorc jev tier` and `lorc jev ask` always exit 0.
// The key is sent only in the Authorization header, and only over https (or http on
// this machine, for tests). lorc sends the request text and file paths, never code.
const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const ENV = { key: "TYPESAFE_API_KEY", base: "TYPESAFE_BASE_URL", model: "TYPESAFE_DEFAULT_MODEL" };
const DEFAULT_BASE = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const TIMEOUT_MS = 5000;
const DEFAULT_MIN_CONF = 60;
const TIERS = ["low", "mid", "high", "complex"];
// The same rows as the SKILL.md L2 table. jev reads literally: each row says its exact condition.
// "files" are source files: tests, translation files and docs do not count.
const CRITERIA = {
  low: "A small change: at most 2 source files in 1 area. No new module, component, page or endpoint.",
  mid: "3 to 5 source files, or exactly 1 new component, page or endpoint, in 1 area.",
  high: "6 to 20 source files, 2 or more new components, or 2 to 3 independent areas such as front end and back end.",
  complex: "More than 20 source files, more than 3 areas, steps that must run in a fixed order, or a data or schema migration.",
};
const SIGNALS = {
  new_component: "Does `request` ask to create a new module, component, page, endpoint or service?",
  migration: "Does `request` need a data, schema, framework or API version migration?",
  ordered_steps: "Does `request` need steps in a fixed order, where a later step needs the result of an earlier step?",
  multi_area: "Does `request` change two or more independent parts of the code base, such as front end and back end?",
};
// jev is weak with numbers: counts go in as words.
const FILE_ROWS = [[0, "none found"], [2, "1 to 2 files"], [5, "3 to 5 files"], [20, "6 to 20 files"], [Infinity, "more than 20 files"]];
const AREA_ROWS = [[0, "none found"], [1, "1 area"], [3, "2 to 3 areas"], [Infinity, "more than 3 areas"]];
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);
// L3 option judge: jev rates each option on its own (a Noul). The top option is the
// recommendation only when it is >= 50 % and >= 10 points over the next one.
const ASK = { maxQuestions: 10, maxOptions: 8, recMin: 50, recGap: 10 };

function keyFile(home) { return path.join(paths.globalLorcDir(home), "jev.json"); }

// The env key wins over the saved key. The base URL and the model come from the env only.
function resolve({ env = process.env, home } = {}) {
  const base = String(env[ENV.base] || DEFAULT_BASE).trim().replace(/\/+$/, "");
  const model = String(env[ENV.model] || DEFAULT_MODEL).trim();
  const fromEnv = String(env[ENV.key] || "").trim();
  if (fromEnv) return { key: fromEnv, source: "env", base, model };
  const f = paths.readJson(keyFile(home), null);
  const fromFile = f && typeof f.api_key === "string" ? f.api_key.trim() : "";
  return { key: fromFile || null, source: fromFile ? "file" : null, base, model };
}

function checkBase(base) {
  let u;
  try { u = new URL(base); } catch (_) { return "bad base URL"; }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOCAL.has(u.hostname)) return null;
  return "base URL must use https";
}

function bucket(n, rows) {
  const v = Number(n) || 0;
  for (const [max, word] of rows) if (v <= max) return word;
  return rows[rows.length - 1][1];
}

const CALLER_ROWS = [[0, "none"], [3, "1 to 3 files"], [10, "4 to 10 files"], [Infinity, "more than 10 files"]];

// ev: the evidence of lorc's tier engine (never its tier), as words.
function state(request, hint = {}, files = [], ev = null) {
  const out = {
    request: String(request || "").slice(0, 600),
    code_search: {
      note: "A code graph search found these. It can miss files.",
      files_found: bucket(hint.files_likely, FILE_ROWS),
      areas_found: bucket(hint.areas, AREA_ROWS),
      new_files_likely: hint.new_files_likely ? "yes" : "no",
      risky_paths: (Array.isArray(hint.risky_paths) ? hint.risky_paths : []).slice(0, 8),
      files: (Array.isArray(files) ? files : []).slice(0, 8),
    },
  };
  if (ev && typeof ev === "object") {
    out.estimate = {
      note: "lorc's estimate from the request, the code graph and the git history. It can be wrong.",
      source_files_to_change: bucket(ev.est_files, FILE_ROWS),
      new_components: (Array.isArray(ev.creates) ? ev.creates : []).slice(0, 6).map((x) => String(x).slice(0, 40)),
      areas: bucket(ev.areas, AREA_ROWS),
      callers_that_must_change: bucket(ev.blast, CALLER_ROWS),
      similar_past_commits: ev.similar && ev.similar.n ? `${ev.similar.n} found; a typical one changed ${bucket(ev.similar.median, FILE_ROWS)}` : "none found",
      mechanical_change: ev.mechanical ? "yes" : "no",
    };
  }
  return out;
}

// Two orders of the same Choice: jev leans to the first option, so combine() averages both.
function questions() {
  const choice = (order) => ({
    type: "choice",
    instructions: "Pick the size tier of the coding work that `request` asks for. Use `code_search` and `estimate` (when present) as evidence; both can be incomplete.",
    criteria: Object.fromEntries(order.map((t) => [t, CRITERIA[t]])),
  });
  const out = { tier: choice(TIERS), tier_rev: choice(TIERS.slice().reverse()) };
  for (const [id, text] of Object.entries(SIGNALS)) out[id] = { type: "noul", instructions: text };
  return out;
}

const r2 = (n) => Math.round(n * 100) / 100;

// Average the two orders, take the peak (a tie goes to the higher tier), and compute
// TypeSafe's Choice confidence from the averaged distribution: (n * peak - 1) / (n - 1).
function combine(answers) {
  const has = (x) => x && x.probabilities && typeof x.probabilities === "object";
  const a = answers && answers.tier;
  const b = answers && answers.tier_rev;
  if (!has(a)) return null;
  const sets = has(b) ? [a, b] : [a];
  const p = {};
  for (const t of TIERS) p[t] = sets.reduce((s, x) => s + (Number(x.probabilities[t]) || 0), 0) / sets.length;
  const sum = TIERS.reduce((s, t) => s + p[t], 0);
  if (!(sum > 0)) return null;
  for (const t of TIERS) p[t] /= sum;
  const tier = TIERS.reduce((best, t) => (p[t] >= p[best] ? t : best), TIERS[0]);
  const n = TIERS.length;
  const conf = Math.max(0, Math.min(1, (n * p[tier] - 1) / (n - 1)));
  const signals = {};
  for (const id of Object.keys(SIGNALS)) {
    const v = answers[id] && Number(answers[id].noul);
    if (Number.isFinite(v)) signals[id] = r2(v);
  }
  return {
    tier, conf: r2(conf), consistent: sets.length === 2 ? a.choice === b.choice : null,
    p: Object.fromEntries(TIERS.map((t) => [t, r2(p[t])])), signals,
  };
}

function failure(reason) { const e = new Error(reason); e.reason = reason; return e; }

function retryMs(res) {
  const s = Number(res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : NaN);
  return Number.isFinite(s) && s >= 0 ? Math.min(1000, s * 1000) : 300;
}

// One call with one retry on 429 / 529, all inside one deadline.
async function call(c, { method = "POST", route = "/v1/systemone", body, timeoutMs = TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw failure("no fetch (node < 18)");
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) throw failure("timeout");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), left);
    try {
      let res;
      try {
        res = await fetchImpl(c.base + route, {
          method,
          headers: { authorization: `Bearer ${c.key}`, "content-type": "application/json", accept: "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (_) {
        throw failure(ac.signal.aborted ? "timeout" : "network");
      }
      if ((res.status === 429 || res.status === 529) && attempt === 0) {
        const ms = retryMs(res);
        if (deadline - Date.now() > ms + 200) { clearTimeout(timer); await new Promise((r) => setTimeout(r, ms)); continue; }
      }
      if (!res.ok) throw failure(`http ${res.status}`);
      try { return await res.json(); } catch (_) { throw failure(ac.signal.aborted ? "timeout" : "bad response"); }
    } finally {
      clearTimeout(timer);
    }
  }
}

function loadSettings(root, home, settings) {
  if (settings) return settings;
  try { return require("./settings.js").load(root || paths.repoRoot(), { home }).values; } catch (_) { return {}; }
}

// { c } → call jev; { reason } → fall back.
function gate(on, env, home) {
  if (!on) return { reason: "off" };
  const c = resolve({ env, home });
  if (!c.key) return { reason: "no key" };
  const bad = checkBase(c.base);
  return bad ? { reason: bad } : { c };
}

function meta(res, c, t0) {
  const m = { model: String((res && res.model) || c.model).slice(0, 40), ms: Date.now() - t0 };
  const tokens = res && res.usage && Number(res.usage.input_tokens);
  if (Number.isFinite(tokens)) m.tokens = tokens;
  return m;
}

function minConf(s) {
  const v = s && s.tier_judge_min_conf;
  return (Number.isInteger(v) ? v : DEFAULT_MIN_CONF) / 100;
}

// input: { request, tier_hint, files }. Returns { by: "jev", tier, … } or { by: "table", reason }.
async function judge(input = {}, { root, env = process.env, home, settings, fetchImpl, timeoutMs } = {}) {
  const t0 = Date.now();
  const s = loadSettings(root, home, settings);
  const g = gate(s.tier_judge !== "off", env, home);
  if (!g.c) return { by: "table", reason: g.reason };
  const c = g.c;
  let res;
  try {
    res = await call(c, {
      body: { state: state(input.request, input.tier_hint, input.files, input.engine), model: c.model, questions: questions() },
      timeoutMs, fetchImpl,
    });
  } catch (e) {
    return { by: "table", reason: e.reason || "network" };
  }
  const v = combine(res && res.answers);
  if (!v) return { by: "table", reason: "bad response" };
  const m = meta(res, c, t0);
  if (v.conf < minConf(s)) {
    return { by: "table", reason: "low confidence", jev: { tier: v.tier, conf: v.conf }, p: v.p, signals: v.signals, ...m };
  }
  return { by: "jev", tier: v.tier, conf: v.conf, consistent: v.consistent, p: v.p, signals: v.signals, ...m };
}

function cut(v, n) {
  if (v == null) return "";
  return (typeof v === "string" ? v : JSON.stringify(v)).slice(0, n);
}

// The session's L3 questions → clean items. A question needs an options object with >= 2 keys.
function askItems(input) {
  const qs = Array.isArray(input && input.questions) ? input.questions : [];
  const out = [];
  const ids = new Set();
  qs.forEach((q, i) => {
    if (out.length >= ASK.maxQuestions || !q || typeof q !== "object") return;
    if (!q.options || typeof q.options !== "object" || Array.isArray(q.options)) return;
    const opts = Object.entries(q.options).filter(([k]) => /^[a-z0-9]{1,8}$/i.test(k)).slice(0, ASK.maxOptions);
    if (opts.length < 2) return;
    let id = /^[A-Za-z0-9-]{1,24}$/.test(String(q.id || "")) ? String(q.id) : `q${i + 1}`;
    if (ids.has(id)) id = `q${i + 1}x`;
    ids.add(id);
    out.push({ id, q: cut(q.q, 400), facts: cut(q.facts, 600), options: Object.fromEntries(opts.map(([k, v]) => [k, cut(v, 300)])) });
  });
  return out;
}

// One Noul per option. Each sees all the options, so it rates the option against the others.
function askQuestions(items) {
  const out = {};
  for (const it of items) {
    for (const k of Object.keys(it.options)) {
      out[`${it.id}__${k}`] = {
        type: "noul",
        instructions: {
          question: it.q, facts: it.facts || "none", options: it.options,
          ask: `Is option \`${k}\` the right answer to \`question\` for \`request\`? Use \`facts\`.`,
        },
        criteria: {
          true: `Option \`${k}\` fits \`request\`, \`intent\` and \`facts\` as well as or better than every other option.`,
          false: `Another option fits better, or option \`${k}\` conflicts with \`request\`, \`intent\` or \`facts\`.`,
        },
      };
    }
  }
  return out;
}

// p: option → 0-100 (%). rec: the top option, or null when jev is unsure or an answer is missing.
function askVerdict(items, answers) {
  const out = {};
  for (const it of items) {
    const p = {};
    for (const k of Object.keys(it.options)) {
      const a = answers && answers[`${it.id}__${k}`];
      const v = a ? Number(a.noul) : NaN;
      if (Number.isFinite(v)) p[k] = Math.round(Math.max(0, Math.min(1, v)) * 100);
    }
    const ranked = Object.entries(p).sort((x, y) => y[1] - x[1]);
    const full = ranked.length === Object.keys(it.options).length;
    const [top, next] = ranked;
    const rec = full && top && top[1] >= ASK.recMin && (!next || top[1] - next[1] >= ASK.recGap) ? top[0] : null;
    out[it.id] = { p, rec };
  }
  return out;
}

// input: { request, intent, questions: [{ id, q, facts, options: { a, b, … } }] }.
// Returns { by: "jev", questions: { <id>: { p, rec } }, … } or { by: "self", reason }.
async function judgeAsk(input = {}, { root, env = process.env, home, settings, fetchImpl, timeoutMs } = {}) {
  const t0 = Date.now();
  const s = loadSettings(root, home, settings);
  const g = gate(s.ask_judge !== "off", env, home);
  if (!g.c) return { by: "self", reason: g.reason };
  const items = askItems(input);
  if (!items.length) return { by: "self", reason: "no questions" };
  let res;
  try {
    res = await call(g.c, {
      body: { state: { request: cut(input.request, 600), intent: cut(input.intent, 600) }, model: g.c.model, questions: askQuestions(items) },
      timeoutMs, fetchImpl,
    });
  } catch (e) {
    return { by: "self", reason: e.reason || "network" };
  }
  const v = askVerdict(items, res && res.answers);
  if (!Object.values(v).some((x) => Object.keys(x.p).length)) return { by: "self", reason: "bad response" };
  return { by: "jev", questions: v, ...meta(res, g.c, t0) };
}

function keyHint(key) { return key && key.length >= 12 ? `…${key.slice(-4)}` : key ? "set" : null; }

function status(root, { env = process.env, home } = {}) {
  let s = {};
  try { s = require("./settings.js").load(root, { home }).values; } catch (_) { /* defaults */ }
  const c = resolve({ env, home });
  return {
    connected: Boolean(c.key), source: c.source, key: keyHint(c.key), base: c.base, model: c.model,
    base_ok: !checkBase(c.base), tier_judge: s.tier_judge || "auto", min_conf: Math.round(minConf(s) * 100),
    ask_judge: s.ask_judge || "auto", key_file: keyFile(home),
  };
}

async function ping(c, opts = {}) {
  const bad = checkBase(c.base);
  if (bad) return { ok: false, reason: bad };
  try {
    const r = await call(c, { method: "GET", route: "/v1/models", ...opts });
    const names = Array.isArray(r && r.models) ? r.models.map((m) => m && m.name).filter(Boolean) : [];
    return { ok: true, models: names.slice(0, 8) };
  } catch (e) {
    return { ok: false, reason: e.reason || "network" };
  }
}

function saveKey(key, { home } = {}) {
  const file = keyFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ api_key: key, saved_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows: ACLs, not modes */ }
  return file;
}

function removeKey({ home } = {}) {
  const file = keyFile(home);
  if (!fs.existsSync(file)) return { file, removed: false };
  fs.rmSync(file, { force: true });
  return { file, removed: true };
}

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch (_) { return ""; }
}

function out(json, obj, text) {
  if (json) emit(obj);
  else process.stdout.write(text + "\n");
}

function statusText(st, p) {
  const L = [
    st.connected ? `jev: connected (${st.source}, key ${st.key})` : "jev: not connected — the built-in tier table decides",
    `model ${st.model} · base ${st.base}${st.base_ok ? "" : " (refused: not https)"} · tier_judge ${st.tier_judge} · min confidence ${st.min_conf} % · ask_judge ${st.ask_judge}`,
  ];
  if (p) L.push(p.ok ? `ping: ok${p.models.length ? " · " + p.models.join(", ") : ""}` : `ping: failed (${p.reason})`);
  if (!st.connected) L.push(`connect: set ${ENV.key}, or pipe the key into "lorc jev connect -"`);
  return L.join("\n");
}

function askLine(r) {
  if (r.by !== "jev") return `ask judge: self (${r.reason})`;
  return Object.entries(r.questions).map(([id, q]) =>
    `${id}: ` + Object.entries(q.p).map(([k, v]) => `${k} ${v} %${q.rec === k ? " ➡️" : ""}`).join(" · ")).join("\n");
}

// --run <slug>: the request comes from the run record, and the answer is logged in the run folder.
function askRun(root, slug) {
  if (!slug) return null;
  if (!/^[A-Za-z0-9][\w-]*$/.test(slug)) return { error: `bad run slug "${slug}"` };
  const dir = require("./runs.js").runDir(root, slug);
  const run = paths.readJson(path.join(dir, "run.json"), null);
  return run ? { dir, request: run.request || "" } : { error: `no run "${slug}"` };
}

async function cmd(argv = []) {
  const { argRoot, positionals } = require("./core.js");
  const json = wantsJson(argv);
  const root = argRoot(argv);
  const pos = positionals(argv, ["--run"]);
  const sub = pos[0] || "status";

  if (sub === "status") {
    const st = status(root);
    let p = null;
    if (argv.includes("--ping") && st.connected) p = await ping(resolve());
    out(json, p ? { ...st, ping: p } : st, statusText(st, p));
    return 0;
  }

  if (sub === "connect") {
    if (pos[1] !== "-") {
      process.stderr.write(`lorc jev connect: pipe the key on stdin: lorc jev connect - < key.txt (or set ${ENV.key})\n`);
      return 2;
    }
    const key = readStdin().trim();
    if (!key || key.length > 512 || /\s/.test(key)) {
      process.stderr.write("lorc jev connect: no key on stdin, or the key has spaces\n");
      return 2;
    }
    if (!argv.includes("--no-check")) {
      const p = await ping({ ...resolve(), key });
      if (!p.ok) {
        process.stderr.write(`lorc jev connect: the key check failed (${p.reason}); not saved. --no-check saves it anyway\n`);
        return 1;
      }
    }
    const file = saveKey(key);
    out(json, { ok: true, file, key: keyHint(key) }, `jev: key ${keyHint(key)} saved in ${file} (user folder, never the project)`);
    return 0;
  }

  if (sub === "disconnect") {
    const r = removeKey();
    const envNote = process.env[ENV.key] ? ` ${ENV.key} is still set in the environment.` : "";
    out(json, { ok: true, ...r, env_key: Boolean(process.env[ENV.key]) }, `jev: ${r.removed ? "key removed" : "no saved key"} (${r.file}).${envNote}`);
    return 0;
  }

  if (sub === "tier") {
    let input = {};
    try { input = JSON.parse(readStdin() || "{}"); } catch (_) { input = {}; }
    const r = await judge(input, { root });
    out(json, r, r.by === "jev" ? `tier ${r.tier} · jev ${Math.round(r.conf * 100)} %` : `tier: table (${r.reason})`);
    return 0;
  }

  if (sub === "ask") {
    const ri = argv.indexOf("--run");
    const run = askRun(root, ri >= 0 ? argv[ri + 1] : null);
    if (run && run.error) { process.stderr.write(`lorc jev ask: ${run.error}\n`); return 2; }
    let input = {};
    try { input = JSON.parse(readStdin() || "{}"); } catch (_) { input = {}; }
    if (run && !input.request) input.request = run.request;
    const r = await judgeAsk(input, { root });
    if (run) {
      try {
        fs.appendFileSync(path.join(run.dir, "asks-jev.jsonl"), JSON.stringify({ at: new Date().toISOString(), items: askItems(input), ...r }) + "\n");
      } catch (_) { /* the log is optional */ }
    }
    out(json, r, askLine(r));
    return 0;
  }

  process.stderr.write(`lorc jev: unknown action "${sub}" — use: jev status [--ping] | jev connect - | jev disconnect | jev tier | jev ask [--run <slug>] -\n`);
  return 2;
}

module.exports = {
  ENV, DEFAULT_BASE, DEFAULT_MODEL, TIERS, CRITERIA, SIGNALS, TIMEOUT_MS,
  ASK, keyFile, resolve, checkBase, bucket, state, questions, combine, call, judge,
  askItems, askQuestions, askVerdict, judgeAsk, status, ping, saveKey, removeKey, cmd,
};
