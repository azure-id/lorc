"use strict";

const path = require("path");
const paths = require("./paths.js");
const behaviour = require("./behaviour.js");
const { wantsJson, emit } = require("./json.js");

// ORC's one threshold (orc bin/habit.js HABIT_RULE): propose only.
const RULE = { window: 30, min_n: 5, lb: 0.55, z: 1.96, last_agree: 3, follow_n: 10, follow_rate: 0.95 };

// Copied from ORC bin/habit.js wilsonLB.
function wilsonLB(p, n, z = RULE.z) {
  if (!(n > 0)) return 0;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

const stateFile = (root) => path.join(paths.projectLorcDir(root), "habits-state.json");
function readState(root) {
  const s = paths.readJson(stateFile(root), {});
  return { accepted: Array.isArray(s.accepted) ? s.accepted : [], declined: Array.isArray(s.declined) ? s.declined : [] };
}
function writeState(root, s) { paths.atomicWrite(stateFile(root), JSON.stringify(s, null, 2) + "\n"); }

// The window rule: the value fills >= lb (Wilson), n >= 5, the last 3 agree.
function passes(values, want) {
  const win = values.slice(-RULE.window);
  const n = win.length;
  if (n < RULE.min_n) return null;
  const k = win.filter((v) => v === want).length;
  const lb = wilsonLB(k / n, n);
  const tail = win.slice(-RULE.last_agree);
  if (lb < RULE.lb || tail.length < RULE.last_agree || !tail.every((v) => v === want)) return null;
  return { k, n, lb };
}

function muted(settings) {
  return String((settings && settings.review_mute) || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function compute(root, settings = {}) {
  const ev = behaviour.read(root);
  const out = [];
  const byTier = {};
  for (const e of ev) if (e.t === "executor" && e.executor) (byTier[e.tier || "-"] = byTier[e.tier || "-"] || []).push(e.executor);
  for (const [tier, list] of Object.entries(byTier)) {
    const last = list[list.length - 1];
    const r = passes(list, last);
    if (!r || settings.executor === last) continue;
    out.push({
      id: `executor:${tier}:${last}`, kind: "executor", strength: r.lb, n: r.k, m: r.n,
      text: `Set executor = ${last}? (you picked it ${r.k} of ${r.n} times at tier ${tier})`,
      apply: { key: "executor", value: last },
    });
  }
  const byCat = {};
  for (const e of ev) if (e.t === "finding" && e.cat && (e.sev === "P2" || e.sev === "P3")) (byCat[e.cat] = byCat[e.cat] || []).push(e.outcome);
  const mute = muted(settings);
  for (const [cat, list] of Object.entries(byCat)) {
    if (mute.includes(cat) || !/^[a-z-]+$/.test(cat)) continue;
    const r = passes(list, "rejected");
    if (!r) continue;
    out.push({
      id: `mute:${cat}`, kind: "mute", strength: r.lb, n: r.k, m: r.n,
      text: `Stop listing ${cat} findings at P2/P3? (you rejected ${r.k} of ${r.n})`,
      apply: { key: "review_mute", add: cat },
    });
  }
  const asks = ev.filter((e) => e.t === "ask").slice(-RULE.window);
  if (asks.length >= RULE.follow_n) {
    const k = asks.filter((e) => e.followed).length;
    const rate = k / asks.length;
    if (rate >= RULE.follow_rate) {
      out.push({ id: "follow-rec", kind: "info", strength: rate, n: k, m: asks.length, text: "lorc's recommendations match your choices", apply: null });
    }
  }
  out.sort((a, b) => b.strength - a.strength);
  return out;
}

function proposeOne(root, settings = {}) {
  if (!settings.habits || settings.habits === "off") return null;
  const list = compute(root, settings);
  if (settings.habits === "observe") return null;
  const st = readState(root);
  return list.find((p) => !st.accepted.includes(p.id) && !st.declined.includes(p.id)) || null;
}

function stats(root) {
  const ev = behaviour.read(root);
  const asks = ev.filter((e) => e.t === "ask");
  const executor_by_tier = {};
  const findings_by_cat = {};
  for (const e of ev) {
    if (e.t === "executor" && e.executor) {
      const t = (executor_by_tier[e.tier || "-"] = executor_by_tier[e.tier || "-"] || {});
      t[e.executor] = (t[e.executor] || 0) + 1;
    }
    if (e.t === "finding" && e.cat) {
      const c = (findings_by_cat[e.cat] = findings_by_cat[e.cat] || { fixed: 0, listed: 0, rejected: 0 });
      if (e.outcome in c) c[e.outcome]++;
    }
  }
  return {
    asks: asks.length,
    followed_rate: asks.length ? Math.round((asks.filter((e) => e.followed).length / asks.length) * 100) / 100 : null,
    executor_by_tier, findings_by_cat,
  };
}

function loadSettings(root, home) { return require("./settings.js").load(root, { home }).values; }

// Applies only on the user's explicit accept.
function accept(root, id, { home } = {}) {
  const S = require("./settings.js");
  const s = loadSettings(root, home);
  const p = compute(root, Object.assign({}, s, { executor: null, review_mute: "" })).find((x) => x.id === id) || parseId(id);
  if (!p) return { ok: false, error: `unknown habit "${id}"` };
  if (p.apply && p.apply.key === "executor") {
    const r = S.set("project", root, "executor", p.apply.value, { home });
    if (!r.ok) return r;
  } else if (p.apply && p.apply.key === "review_mute") {
    const list = muted(s);
    if (!list.includes(p.apply.add)) list.push(p.apply.add);
    const r = S.set("project", root, "review_mute", list.join(","), { home });
    if (!r.ok) return r;
  }
  const st = readState(root);
  if (!st.accepted.includes(id)) st.accepted.push(id);
  st.declined = st.declined.filter((x) => x !== id);
  writeState(root, st);
  return { ok: true, id, applied: p.apply || null };
}

function parseId(id) {
  let m = /^executor:([^:]+):(.+)$/.exec(id);
  if (m) return { id, apply: { key: "executor", value: m[2] } };
  m = /^mute:([a-z-]+)$/.exec(id);
  if (m) return { id, apply: { key: "review_mute", add: m[1] } };
  if (id === "follow-rec") return { id, apply: null };
  return null;
}

function decline(root, id) {
  if (!parseId(id)) return { ok: false, error: `unknown habit "${id}"` };
  const st = readState(root);
  if (!st.declined.includes(id)) st.declined.push(id);
  writeState(root, st);
  return { ok: true, id };
}

function cmd(argv = []) {
  const di = argv.indexOf("--dir");
  const root = di >= 0 && argv[di + 1] ? path.resolve(argv[di + 1]) : paths.repoRoot();
  const pos = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--dir"));
  const json = wantsJson(argv);
  const sub = pos[0];
  if (sub === "accept" || sub === "decline") {
    if (!pos[1]) { process.stderr.write(`lorc habits: ${sub} needs <id>\n`); return 2; }
    const r = sub === "accept" ? accept(root, pos[1]) : decline(root, pos[1]);
    if (!r.ok) { process.stderr.write(`lorc habits: ${r.error}\n`); return 2; }
    if (json) emit(r); else process.stdout.write(`${sub}ed ${pos[1]}\n`);
    return 0;
  }
  if (sub) { process.stderr.write("lorc habits: use: habits [--json] | habits accept <id> | habits decline <id>\n"); return 2; }
  const s = loadSettings(root);
  const st = readState(root);
  const proposals = compute(root, s).map((p) => Object.assign({}, p, {
    state: st.accepted.includes(p.id) ? "accepted" : st.declined.includes(p.id) ? "declined" : "open",
  }));
  const out = { mode: s.habits, proposals, stats: stats(root) };
  if (json) { emit(out); return 0; }
  const lines = [`habits: ${out.mode} · ${out.stats.asks} asks · followed ${out.stats.followed_rate == null ? "--" : Math.round(out.stats.followed_rate * 100) + "%"}`];
  for (const p of proposals) lines.push(`  [${p.state}] ${p.id} — ${p.text}`);
  if (!proposals.length) lines.push("  no proposals");
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

module.exports = { RULE, wilsonLB, compute, proposeOne, stats, accept, decline, cmd };
