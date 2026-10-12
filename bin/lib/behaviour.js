"use strict";

const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");

const CAP = 2000;
const file = (root) => path.join(paths.projectLorcDir(root), "behaviour.jsonl");

// One line per event, only when habits is not "off".
function record(root, slug, body, settings, { now } = {}) {
  if (!settings || !settings.habits || settings.habits === "off") return 0;
  const b = body || {};
  const at = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  const rows = [];
  for (const a of Array.isArray(b.asks) ? b.asks : []) {
    if (!a) continue;
    rows.push({ t: "ask", at, slug, q: a.q ?? null, rec: a.rec ?? null, chosen: a.chosen ?? null, followed: a.rec === a.chosen });
  }
  if (b.executor) rows.push({ t: "executor", at, slug, tier: b.tier || null, executor: b.executor });
  for (const f of Array.isArray(b.findings) ? b.findings : []) {
    if (!f) continue;
    rows.push({ t: "finding", at, slug, sev: f.sev || null, cat: f.cat || null, outcome: f.outcome || null });
  }
  if (!rows.length) return 0;
  let lines = read(root).concat(rows).map((o) => JSON.stringify(o));
  if (lines.length > CAP) lines = lines.slice(lines.length - CAP);
  paths.atomicWrite(file(root), lines.join("\n") + "\n");
  return rows.length;
}

function read(root) {
  let text = "";
  try { text = fs.readFileSync(file(root), "utf8"); } catch (_) { return []; }
  const out = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch (_) { /* skip a bad line */ }
  }
  return out;
}

module.exports = { record, read, CAP, file };
