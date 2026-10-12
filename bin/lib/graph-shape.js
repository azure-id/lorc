"use strict";
// The --json shaping helpers of `orc graph`, copied from ORC's bin/cli.js so a
// lorc answer has the same shape as an ORC answer (the /lorc skill reads one shape).
// Origin: C:/dev/orc/bin/cli.js — GRAPH_BRIEF_* constants and briefOf() at lines
// 9676-9733 (v2.2.0). plural() is a local equivalent of cli.js's helper.

const GRAPH_BRIEF_DROP = new Set(["callers", "calls", "effects", "symbols", "imports", "importers", "blocks", "names", "rows", "chain", "waiting"]);
const GRAPH_BRIEF_KEEP = new Set(["nearest", "candidates", "cards"]);
// V2/V3 answers that ARE the answer: `complexity` and `facts` are ten rows at
// most, and they are the whole reason the call was made. They pass through
// whole, never walked.
const GRAPH_BRIEF_WHOLE = new Set(["complexity", "facts"]);
const GRAPH_BRIEF_NO_COUNT = { impact: ["callers"], map: ["files"], changes: ["symbols"], ctx: ["tests_via"] };

// v2.2.0 (R7): a brief map answer keeps only these keys; every list is counted.
const GRAPH_BRIEF_MAP_KEEP = new Set(["ok", "state", "line", "trace", "generation", "card", "counts"]);

function briefOf(sub, obj) {
  if (sub === "map" && obj && typeof obj === "object") {
    const out = {};
    const counts = { ...((obj.counts && typeof obj.counts === "object") ? obj.counts : {}) };
    for (const [k, v] of Object.entries(obj)) {
      if (GRAPH_BRIEF_MAP_KEEP.has(k)) { if (k !== "counts") out[k] = v; continue; }
      if (Array.isArray(v)) counts[k] = v.length;
    }
    if (Object.keys(counts).length) out.counts = counts;
    return out;
  }
  const noCount = new Set(GRAPH_BRIEF_NO_COUNT[sub] || []);
  const walk = (o) => {
    const out = {};
    const counts = {};
    for (const [k, v] of Object.entries(o)) {
      // v2.2.0 (T6-b): a map's `focus` list (every focused file) was the bulk
      // of a 10 KB brief answer. It is counted, and any other string list in a
      // map answer is cut to 12 with its count.
      if (sub === "map" && o === obj && Array.isArray(v) && (k === "focus" || (v.length > 12 && typeof v[0] === "string"))) {
        counts[k] = v.length;
        if (k !== "focus") out[k] = v.slice(0, 12);
        continue;
      }
      if (Array.isArray(v)) {
        const rows = GRAPH_BRIEF_DROP.has(k) || (!GRAPH_BRIEF_KEEP.has(k) && v.length > 0 && v[0] !== null && typeof v[0] === "object");
        if (!rows) out[k] = v;
        else if (!noCount.has(k)) counts[k] = v.length;
        continue;
      }
      if (k === "source" && v && typeof v === "object") {
        const from = Number(v.from);
        const to = Number(v.to);
        counts.source_lines = Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from + 1) : 0;
        continue;
      }
      out[k] = v && typeof v === "object" && !GRAPH_BRIEF_WHOLE.has(k) ? walk(v) : v;
    }
    if (Object.keys(counts).length) out.counts = { ...(out.counts || {}), ...counts };
    return out;
  };
  const out = walk(obj);
  // R11: a FULL coverage verdict is one word in a brief answer — the card row
  // already says how many files. A partial one keeps its gap list.
  if (sub === "ctx" && out.coverage && out.coverage.verdict === "full") out.coverage = "full";
  return out;
}

function plural(n, word, many) {
  return `${n} ${n === 1 ? word : many || word + "s"}`;
}

module.exports = { briefOf, plural };
