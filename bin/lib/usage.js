"use strict";

const path = require("path");
const paths = require("./paths.js");
const { wantsJson, emit } = require("./json.js");

const FRESH_MS = 30 * 60 * 1000;
const DEFAULTS = { limit_pct: 90, limit_weekly_pct: 98, statusline_writes_orc: true };

// resets_at may be an ISO string, epoch seconds or epoch ms.
function toMs(v) {
  if (v == null || v === "") return null;
  let t = NaN;
  if (typeof v === "number") t = v < 1e12 ? v * 1000 : v;
  else if (typeof v === "string") {
    const n = Number(v);
    t = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(v);
  }
  return Number.isFinite(t) ? t : null;
}

function nowMs(now) {
  if (Number.isFinite(now)) return now;
  const env = Number(process.env.LORC_NOW);
  return process.env.LORC_NOW && Number.isFinite(env) ? env : Date.now();
}

function loadSettings(root, home) {
  try {
    const v = require("./settings.js").load(root, { home }).values || {};
    return Object.assign({}, DEFAULTS, v);
  } catch (_) {
    return Object.assign({}, DEFAULTS);
  }
}

function readOne(file) {
  const j = paths.readJson(file, null);
  if (!j || typeof j !== "object") return null;
  const w = toMs(j.written_at);
  return w == null ? null : { data: j, written: w };
}

function readUsage(root, { now } = {}) {
  const t = nowMs(now);
  const base = root || process.cwd();
  const cands = [
    { source: "lorc", r: readOne(path.join(base, ".claude", "lorc", "usage.json")) },
    { source: "orc", r: readOne(path.join(base, ".claude", "orc", "usage.json")) },
  ].filter((c) => c.r);
  if (!cands.length) return null;
  cands.sort((a, b) => b.r.written - a.r.written);
  const { source, r } = cands[0];
  if (t - r.written > FRESH_MS) return null;
  const d = r.data;
  const fhReset = d.five_hour ? toMs(d.five_hour.resets_at) : null;
  // A reading from before a reset that has passed belongs to the old window.
  if (fhReset != null && t > fhReset && r.written < fhReset) return null;
  return {
    five_hour: d.five_hour || null,
    seven_day: d.seven_day || null,
    context: typeof d.context_used_percentage === "number" ? d.context_used_percentage : null,
    source,
    written_at: r.written,
    age_s: Math.max(0, Math.round((t - r.written) / 1000)),
  };
}

function check(root, settings, { now, home } = {}) {
  const t = nowMs(now);
  const s = Object.assign({}, DEFAULTS, settings || {});
  const u = readUsage(root, { now: t, home });
  if (!u) return { state: "unknown", five_hour: null, seven_day: null, context: null, source: null, age_s: null };
  const num = (o) => (o && typeof o.used_percentage === "number" ? o.used_percentage : null);
  const fhUsed = num(u.five_hour);
  const fhReset = u.five_hour ? toMs(u.five_hour.resets_at) : null;
  const five_hour = fhUsed == null ? null : {
    used: fhUsed,
    resets_at_ms: fhReset,
    resets_in_min: fhReset == null ? null : Math.max(0, Math.ceil((fhReset - t) / 60000)),
  };
  const wkUsed = num(u.seven_day);
  const seven_day = wkUsed == null ? null : { used: wkUsed, resets_at_ms: toMs(u.seven_day.resets_at) };
  let state = five_hour || seven_day ? "ok" : "unknown";
  if (five_hour && five_hour.used >= s.limit_pct) state = "limit";
  if (seven_day && seven_day.used >= s.limit_weekly_pct) state = "weekly";
  return { state, five_hour, seven_day, context: u.context, source: u.source, age_s: u.age_s };
}

// unknown exits 0: it never stops a run (`lorc usage && lorc slice` must go on).
const EXIT = { ok: 0, limit: 1, unknown: 0, weekly: 3 };

function cmd(argv = [], opts = {}) {
  const home = opts.home || process.env.LORC_HOME || undefined;
  const root = opts.root || paths.repoRoot();
  const s = loadSettings(root, home);
  const c = check(root, s, { home });
  if (wantsJson(argv)) {
    emit(Object.assign({}, c, { limit_pct: s.limit_pct, limit_weekly_pct: s.limit_weekly_pct }));
    return EXIT[c.state];
  }
  if (c.state === "unknown") {
    process.stdout.write("usage unknown — no fresh reading (unknown never stops a run)\n");
    return EXIT.unknown;
  }
  const r = Math.round;
  const parts = [
    c.five_hour ? `5h ${r(c.five_hour.used)}% (limit ${s.limit_pct}%)` : "5h --",
    `reset ${c.five_hour && c.five_hour.resets_in_min != null ? c.five_hour.resets_in_min + "m" : "--"}`,
    c.seven_day ? `wk ${r(c.seven_day.used)}% (limit ${s.limit_weekly_pct}%)` : "wk --",
    c.context != null ? `ctx ${r(c.context)}%` : "ctx --",
    `source ${c.source}`,
    `${r(c.age_s / 60)}m old`,
  ];
  process.stdout.write(parts.join(" · ") + "\n");
  return EXIT[c.state];
}

module.exports = { readUsage, check, cmd, toMs, loadSettings, DEFAULTS };
