"use strict";
// `lorc graph` — the code graph router (plan §7).
// It selects ONE store (delegate to ORC, or lorc's own store; since 0.4.0 lorc
// never reads ORC's store and never copies it),
// then delegates to `orc graph … --json` or calls the vendored engine the way
// ORC's bin/cli.js `graphCmd` does (C:/dev/orc/bin/cli.js lines 9759-10750),
// and prints the SAME --json shape. Dropped from ORC: gain rows, trace lines,
// config gates (lorc is always on; `--if-enabled` is accepted and ignored).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const paths = require("./paths.js");
const { emit } = require("./json.js");
const { briefOf, plural } = require("./graph-shape.js");

const VENDOR = path.join(__dirname, "graph");
const G = () => require(path.join(VENDOR, "graph.js"));

const USAGE =
  "Usage: lorc graph where | status [--heal] | update [--if-exists] | scan | upgrade | gc\n" +
  "       lorc graph ctx <symbol…> [--anchors] [--focus=<w>] | ctx --for-slice <a,b> [--focus=<w>] [--anchors]\n" +
  "       lorc graph map --focus=<words> [--budget N] | changes [--files=<a,b>] [--base <ref>]\n" +
  "       [--json] [--brief] [--dir <path>]";

// ORC's own defaults (C:/dev/orc/bin/cli.js CONFIG_META): card budget 1200, heal cap 1500 ms.
const CARD_BUDGET = 1200;
const HEAL_MS = 1500;
// ORC's graph exit codes that are DATA, not failure (cli.js graphCmd usage text).
const DATA_EXITS = new Set([0, 1, 2, 3, 4, 5, 6]);

// ── ORC config: ONE key, plain line parse ──────────────────────────────────
// ORC's `orc graph` reads `readOverride(claudeDir)` with claudeDir = <project>/.claude
// only (cli.js resolveClaudeDir + overridePath). There is no merge with the home
// file for a project command, so lorc reads the project file only, as ORC does.
function orcConfig(root, key) {
  try {
    const text = fs.readFileSync(path.join(root, ".claude", "orc.config.yaml"), "utf8");
    const m = new RegExp("^" + key + ":\\s*(.*?)\\s*(?:#.*)?$", "m").exec(text);
    if (!m) return null;
    return m[1].replace(/^['"]|['"]$/g, "").trim();
  } catch (_) {
    return null;
  }
}

function readMeta(claudeDir) {
  return paths.readJson(path.join(claudeDir, "orc", "graph", "meta.json"), null);
}

// ── 1.1 store selection ────────────────────────────────────────────────────
function selectStore(root, { home } = {}) {
  const E = G();
  const engine = { engine: E.ENGINE, schema: E.SCHEMA };
  const orc = paths.findOrc(root, home);
  const codeGraph = String(orcConfig(root, "code_graph") || "off").toLowerCase();
  const projectClaude = path.join(root, ".claude");
  const orcMeta = readMeta(projectClaude);
  const base = { engine, orc, orc_engine: orcMeta ? { engine: orcMeta.engine || null, schema: orcMeta.schema ?? null } : null, orc_code_graph: codeGraph };
  const own = { mode: "own", claudeDir: path.join(root, ".claude", "lorc") };

  if (orc.delegate && (codeGraph === "on" || codeGraph === "semi")) {
    return { ...base, mode: "delegate", claudeDir: projectClaude, reason: `orc ${orc.version} installed, code_graph ${codeGraph} → orc graph` };
  }
  const why = orc.delegate ? `orc ${orc.version} has code_graph ${codeGraph}` : orc.installed ? (orc.reason || "orc cannot delegate") : "no orc";
  return { ...base, ...own, reason: `${why} → own store .claude/lorc/orc/graph` };
}

// ── argv helpers ───────────────────────────────────────────────────────────
function parse(argv) {
  const VALUE = new Set(["--dir", "--budget", "--depth", "--format", "--offset", "--base", "--if-older", "--focus"]);
  const srcAt = argv.indexOf("--source");
  const srcTakes = srcAt !== -1 && /^\d+$/.test(String(argv[srcAt + 1] || ""));
  const plain = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE.has(argv[i]) || (i === srcAt && srcTakes)) { i++; continue; }
    if (!String(argv[i]).startsWith("--")) plain.push(argv[i]);
  }
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length && !String(argv[i + 1]).startsWith("--") ? argv[i + 1] : undefined; };
  const eq = (f) => { const h = argv.find((a) => a.startsWith(f + "=")); return h === undefined ? undefined : h.slice(f.length + 1); };
  return {
    sub: plain[0], plain, val, eq,
    has: (f) => argv.includes(f),
    json: argv.includes("--json"),
    brief: argv.includes("--brief"),
    source: srcAt === -1 ? undefined : srcTakes ? Number(argv[srcAt + 1]) : null,
  };
}

const list = (x) => String(x || "").split(",").map((s) => s.trim()).filter(Boolean);
const asPaths = (l) => l.map((x) => String(x).split("\\").join("/").replace(/^\.\//, "").replace(/:\d+$/, ""));

// ── the output: ORC's finish() without the gain row and the trace ─────────
// The --json object, without the exit code.
function shape(r, line, store, jsonLine = true) {
  const { exit: _e, trace: _t, ...obj } = r;
  if (obj.generation === undefined) {
    const m = paths.readJson(path.join(store.dir, "meta.json"), null);
    if (m && m.generation) { obj.generation = m.generation; obj.gen_id = m.gen_id || null; }
  }
  return { ...obj, ...(line && jsonLine ? { line } : {}), store: { mode: store.mode, dir: store.dir } };
}

function finisher(a, store) {
  return (r, line, jsonLine = true) => {
    const { exit } = r;
    const full = shape(r, line, store, jsonLine);
    if (a.json) emit(a.brief ? briefOf(a.sub, full) : full);
    else if (line) process.stdout.write(String(line) + "\n");
    return exit || 0;
  };
}

// ── own: the engine in bin/lib/graph ──────────────────────────────────────
const NONE = "graph: none — no index yet (run: lorc graph update)";
const SUGGEST = "lorc graph scan";
const SUGGEST_LINE = "graph: none — run: lorc graph scan (builds the code graph once, zero tokens)";
const SKIPPED = "graph: none — skipped (run: lorc graph scan)";
const upgradedLine = (u) => `graph: upgraded ${u.from} → ${G().ENGINE} (${u.reused} reused, ${u.parsed} parsed, ${u.ms} ms)`;

// `status [--heal]` → { r, line }. ORC's heal rule: a NONE or DRIFTED store
// (a format-1 store too) is built, updated or upgraded first.
// buildNone false (lorc's own heal): a NONE store is not built; lorc suggests a scan.
function ownStatus(claudeDir, root, ignore, heal, buildNone = true) {
  const E = G();
  let r = E.graphStatus(claudeDir, root, { enabled: true, ignore });
  let healed = null;
  if (heal && ((buildNone && r.state === "none") || r.state === "drifted")) {
    const u = E.graphUpdate(claudeDir, root, { enabled: true, ifEnabled: true, ignore });
    healed = u.exit === 0
      ? { state: u.state, ...(u.from ? { from: u.from } : {}), added: u.added, changed: u.changed, deleted: u.deleted, parsed: u.parsed, reused: u.reused, engine_upgrade: u.engine_upgrade, ms: u.ms }
      : { state: u.state, reason: u.reason };
    if (u.exit === 0) r = E.graphStatus(claudeDir, root, { enabled: true, ignore });
  }
  r.auto_update = true;
  r.notes = "off";
  if (healed) r.healed = healed;
  const meta = paths.readJson(E.graphPaths(claudeDir).meta, null);
  if (meta && meta.density) {
    r.density = meta.density;
    try { r.thin = require(path.join(VENDOR, "graph-signals.js")).isThin(meta.density, r.files); } catch (_) {}
  }
  const b = r.behind || {};
  const lines = {
    off: "graph: off",
    none: NONE,
    unavailable: `graph: unavailable — ${r.reason}`,
    fresh: `graph: FRESH — ${plural(r.files, "file")} · ${plural(r.symbols, "symbol")} · gen ${r.generation} (updated ${r.updated_at})`,
    drifted: r.upgrade
      ? `graph: OLD FORMAT (${r.upgrade.from}) — run: lorc graph upgrade (any update upgrades it)`
      : `graph: DRIFTED — ${plural((b.added || 0) + (b.changed || 0) + (b.deleted || 0), "file")} behind ` +
        `(${b.added || 0} added · ${b.changed || 0} changed · ${b.deleted || 0} deleted); hints only, code wins (run: lorc graph update)`,
  };
  let line = lines[r.state];
  if (r.state === "none" && !buildNone) { r.suggest = SUGGEST; line = SUGGEST_LINE; }
  if (healed && healed.parsed !== undefined) {
    const moved = healed.added + healed.changed + healed.deleted;
    const size = `${plural(r.files, "file")} · ${plural(r.symbols, "symbol")}`;
    line = healed.state === "built" ? `graph: built first index — ${size} (${healed.ms} ms)`
      : healed.state === "upgraded" ? upgradedLine(healed)
        : healed.engine_upgrade && !moved ? `graph: index upgraded to the new engine → updated (${healed.ms} ms) — ${size}`
          : `graph: ${plural(moved, "file")} changed outside lorc → updated (${healed.ms} ms) — ${size}`;
  } else if (healed) line += ` · could not heal: ${healed.reason}`;
  if (r.density && line) line += ` · ${r.density.symbols_per_file} symbols/file`;
  return { r, line };
}

function updateLine(r) {
  if (r.state === "unavailable") return r.reason === "locked" ? `graph: another update holds the lock (pid ${(r.holder && r.holder.pid) || "?"}) — retry in a moment` : `graph: unavailable — ${r.reason}`;
  if (r.state === "unchanged") return `graph: FRESH — nothing changed · gen ${r.generation} · ${r.ms} ms`;
  if (r.state === "upgraded") return upgradedLine(r);
  return `graph: ${r.state === "built" ? "built first index" : "updated"} — ${plural(r.files, "file")} (${r.parsed} parsed, ${r.reused} reused, ${r.deleted} deleted${r.skipped ? `, ${r.skipped} skipped` : ""}) · ${r.ms} ms`;
}

function runOwn(argv, root, sel, extra = {}) {
  const a = parse(argv);
  const E = G();
  const claudeDir = sel.claudeDir;
  const store = { mode: sel.mode, dir: E.graphPaths(claudeDir).dir };
  const fin0 = finisher(a, store);
  const finish = (r, line, jl) => fin0(extra.fallback ? { ...r, fallback: extra.fallback } : r, line, jl);
  const ignore = list(orcConfig(root, "code_graph_ignore"));
  const metaNow = () => paths.readJson(E.graphPaths(claudeDir).meta, null);

  if (a.sub === "status") {
    const { r, line } = ownStatus(claudeDir, root, ignore, a.has("--heal"));
    return finish(r, line);
  }

  if (a.sub === "upgrade") {
    const meta = metaNow();
    if (meta && !E.isFormat1(meta)) {
      return finish({ ok: true, state: "current", format: meta.format, engine: meta.engine, exit: 0 }, `graph: already ${E.ENGINE} (format ${E.FORMAT}) — nothing to do`);
    }
    const r = E.graphUpdate(claudeDir, root, { enabled: true, ifEnabled: false, ignore, say: null });
    return finish(r, updateLine(r));
  }

  if (a.sub === "update") {
    // --if-exists (lorc's own automatic paths): no store → write nothing, exit 0.
    if (a.has("--if-exists") && !metaNow()) {
      return finish({ ok: true, state: "none", skipped: true, suggest: SUGGEST, exit: 0 }, SKIPPED);
    }
    const r = E.graphUpdate(claudeDir, root, { enabled: true, ifEnabled: false, ignore, say: null });
    return finish(r, updateLine(r));
  }

  if (a.sub === "gc") {
    const r = E.graphGc(claudeDir, { graceMs: E.GRACE_MS });
    const line = r.exit === 0
      ? `graph: gc — ${plural(r.removed, "file")} removed, ${r.kept} kept (${Math.round(r.bytes_freed / 1024)} KB freed)`
      : r.reason === "locked" ? "graph: another update holds the lock — retry in a moment" : "graph: none — nothing to collect";
    return finish(r, line);
  }

  // ORC's heal-on-read (cli.js `healOnRead`): HEAD moved or a named target moved,
  // and the last update was within the cap → one update before the read.
  const healOnRead = (targets) => {
    const meta = metaNow();
    if (!meta) return null;
    const last = Number(meta.update_ms) || 0;
    let moved = null;
    try {
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
      if (head.status === 0 && meta.head_commit && head.stdout.trim() !== meta.head_commit) moved = "head";
    } catch (_) {}
    if (!moved && targets && targets.length) {
      try {
        const files = JSON.parse(fs.readFileSync(E.graphPaths(claudeDir).files, "utf8"));
        const known = targets.filter((x) => files[x]);
        if (known.length) {
          const h = spawnSync("git", ["hash-object", "--stdin-paths"], { cwd: root, encoding: "utf8", input: known.join("\n") + "\n", windowsHide: true });
          if (h.status === 0) {
            const out = h.stdout.split(/\r?\n/).filter(Boolean);
            known.forEach((rel, i) => { if (!moved && out[i] && out[i] !== files[rel].blob) moved = "target"; });
          }
        }
        if (!moved && targets.some((x) => !files[x] && fs.existsSync(path.join(root, ...x.split("/"))))) moved = "new-path";
      } catch (_) {}
    }
    if (!moved) return null;
    if (last > HEAL_MS) return { state: "skipped", reason: "over-cap", trigger: moved, last_ms: last, cap_ms: HEAL_MS };
    const u = E.graphUpdate(claudeDir, root, { enabled: true, ifEnabled: true, ignore });
    if (u.exit !== 0) return { state: "skipped", reason: u.reason || u.state, trigger: moved };
    return { state: u.state, trigger: moved, added: u.added, changed: u.changed, deleted: u.deleted, generation: u.generation, ms: u.ms };
  };

  if (a.sub === "changes") {
    const SIG = require(path.join(VENDOR, "graph-signals.js"));
    const base = typeof a.val("--base") === "string" ? a.val("--base") : null;
    const onlyFiles = list(a.eq("--files"));
    const healed = healOnRead(SIG.changedPaths(root, base));
    const r = SIG.graphChanges(claudeDir, root, { base, files: onlyFiles });
    if (healed) r.healed = healed;
    if (r.exit !== 0) return finish(r, r.reason === "no-index" ? NONE : `graph: unavailable — ${r.reason}`);
    const c = r.counts;
    const line = r.symbols.length
      ? `graph changes vs ${r.base} — ${plural(r.symbols.length, "symbol")} in ${plural(r.files.length, "file")} · ${c.high} high · ${c.medium} medium · ${c.low} low\n` +
        r.symbols.map((x) => `  ${x.risk.padEnd(6)} ${x.qname}  ${x.file}:${x.lines[0]}-${x.lines[1]}  (${x.why.join(" · ")})`).join("\n") +
        (r.not_in_graph.length ? `\n  not in the graph: ${r.not_in_graph.join(", ")}` : "") +
        "\n  risk is a HINT with its reason attached — an empty impact is never proof nothing depends on the change"
      : `graph changes vs ${r.base} — no indexed symbol was touched${r.not_in_graph.length ? ` (changed, but not in the graph: ${r.not_in_graph.join(", ")})` : ""}`;
    return finish(r, line);
  }

  const Q = () => require(path.join(VENDOR, "graph-query.js"));

  if (a.sub === "map") {
    const focusRaw = a.eq("--focus") !== undefined ? a.eq("--focus") : a.val("--focus");
    const focus = [...list(focusRaw), ...a.plain.slice(1)];
    const model = Q().loadModel(claudeDir, root);
    if (!model) return finish({ ok: false, state: "none", reason: "no-index", exit: 1 }, NONE);
    const r = Q().graphMap(claudeDir, model, { focus, budget: a.val("--budget") === undefined ? CARD_BUDGET : a.val("--budget") });
    return finish(r, r.card, false);
  }

  if (a.sub === "ctx") {
    const operands = a.plain.slice(1).flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean);
    if (!operands[0]) return finish({ ok: false, reason: "missing-operand", usage: USAGE, exit: 1 }, USAGE);
    const forSlice = a.has("--for-slice");
    const callersSource = a.has("--callers-source");
    const healed = healOnRead(asPaths(operands));
    const QQ = Q();
    const model = QQ.loadModel(claudeDir, root);
    if (!model) return finish({ ok: false, state: "none", reason: "no-index", exit: 1 }, NONE);
    const budget = a.val("--budget") === undefined ? CARD_BUDGET : a.val("--budget");
    const opts = {
      depth: a.val("--depth"), budget,
      format: String(a.val("--format") || "prose") === "tree" ? "tree" : "prose",
      offset: a.val("--offset"),
      source: a.source === undefined ? undefined : a.source === null ? QQ.SOURCE_DEFAULT : a.source,
      callersSource, wikiDocsFor: () => [],
    };
    let r;
    QQ.warmBlobs(model, operands.slice(0, forSlice ? 10 : 5));
    if (forSlice) {
      r = QQ.forSlice(model, operands, opts);
      if (a.has("--anchors")) {
        if (!r.ok && r.state === "not-found")
          r = { ok: true, state: "found", view: "for-slice", format: "tree", files: [], missing: r.missing || operands, skipped: [], blocks: [], names: [], budget: { used: 0, max: Number(budget) || 0 }, card: "", exit: 0 };
        const an = QQ.buildAnchors(claudeDir, model, { declared: operands, refs: list(a.eq("--refs")), focus: list(a.eq("--focus")) });
        if (!an.ok) r = an;
        else {
          r.anchors = { lines: an.lines, read_cmd: an.read_cmd, code: an.code, tokens: an.tokens, read_tokens: an.read_tokens, ranges: an.ranges, files: an.files, refs: an.refs, refs_missing: an.refs_missing, missing: r.missing || [] };
          r.card = an.card;
          const miss = r.missing || [];
          const rmiss = an.refs_missing || [];
          r.anchors_line = `graph anchors: ${an.ranges} ranges in ${an.files} files · ~${an.read_tokens} tokens to read · gen ${an.gen}${an.code ? " · code inline" : ""}${miss.length ? ` · not found: ${miss[0]}${miss.length > 1 ? ` (+${miss.length - 1} more)` : ""}` : ""}${rmiss.length ? ` · ref not found: ${rmiss[0]}` : ""}`;
        }
      }
    } else if (operands.length === 1) {
      r = QQ.ctx(model, operands[0], opts);
      r.read = "full";
      if (r.ok && r.target && a.has("--anchors")) {
        const declared = [...new Set([r.target.file, ...(r.callers || []).map((c) => c.file).filter((f) => !QQ.TEST_FILE.test(f))])].slice(0, 10);
        const focus = list(a.eq("--focus"));
        const an = QQ.buildAnchors(claudeDir, model, { declared, refs: list(a.eq("--refs")), focus: focus.length ? focus : [r.target.name || String(r.target.qname || "").split(".").pop()] });
        if (an.ok) {
          r.anchors = { lines: an.lines, read_cmd: an.read_cmd, code: an.code, tokens: an.tokens, read_tokens: an.read_tokens, ranges: an.ranges, files: an.files, refs: an.refs, refs_missing: an.refs_missing, missing: [] };
          r.anchors_card = an.card;
          r.anchors_count = an.ranges;
        }
      }
    } else {
      const items = operands.slice(0, 5);
      const max = Math.max(100, Math.min(8000, Number(budget) || 1200));
      const each = Math.max(100, Math.floor(max / items.length));
      const parts = items.map((q) => ({ query: q, res: QQ.ctx(model, q, { ...opts, budget: each }) }));
      const found = parts.filter((p) => p.res.ok);
      r = {
        ok: found.length > 0, state: found.length ? "found" : "not-found", query: items.join(" "),
        cards: parts.map((p) => ({ query: p.query, state: p.res.state, used: p.res.budget ? p.res.budget.used : 0 })),
        card: found.map((p) => p.res.card).join("\n\n") || null,
        budget: { used: found.reduce((n, p) => n + p.res.budget.used, 0), max },
        exit: found.length ? 0 : 4,
      };
    }
    let line = r.anchors_line || r.card;
    if (r.anchors_line) delete r.anchors_line;
    if (r.anchors_count !== undefined) {
      const ls = String(line || "").split("\n");
      ls[0] = `${ls[0]} · anchors ${r.anchors_count} ranges`;
      line = ls.join("\n");
      delete r.anchors_count;
    }
    if (!line && r.state === "not-found") {
      const near = (r.nearest || []).map((s) => `${s.qname} (${s.file}:${s.lines[0]})`);
      line = r.missing ? `graph: not in the graph — ${r.missing.join(", ")}`
        : `graph: nothing named "${r.query || operands.join(" ")}"${near.length ? ` — nearest: ${near.join(", ")}` : ""}`;
    }
    if (!line && r.state === "ambiguous-target")
      line = `graph: "${r.query}" names ${r.candidates.length} ${r.candidates[0] && !r.candidates[0].id ? "files" : "symbols"} — pick one:\n` + r.candidates.map((s) => `  ${s.id || s.file}`).join("\n");
    if (healed) r.healed = healed;
    if (healed && healed.state && healed.state !== "skipped" && healed.state !== "unchanged") {
      const n = (healed.added || 0) + (healed.changed || 0) + (healed.deleted || 0);
      line = `graph: ${plural(n, "file")} changed outside lorc → healed on read (${healed.ms} ms) · gen ${healed.generation}\n${line || ""}`;
    } else if (healed && healed.state === "skipped") {
      line = `graph: not healed on read (${healed.reason === "over-cap" ? `the last update took ${healed.last_ms} ms, over the ${healed.cap_ms} ms cap` : healed.reason}) — cards are hints where they say CHANGED\n` + (line || "");
    }
    return finish(r, line, !r.card || !!r.anchors);
  }

  return finish({ ok: false, reason: "unknown-subcommand", usage: USAGE, exit: 1 }, USAGE);
}

// ── delegate: `node <orc cli> graph <args> --json` ─────────────────────────
// → { obj, status } or { obj: null, why }.
function spawnOrc(argv, root, sel) {
  const a = parse(argv);
  const args = ["graph", ...argv];
  if (!args.includes("--json")) args.push("--json");
  const r = spawnSync(process.execPath, [sel.orc.cli, ...args], {
    cwd: root, encoding: "utf8", windowsHide: true,
    timeout: a.sub === "update" ? 300000 : 60000, maxBuffer: 64 * 1024 * 1024,
  });
  let obj = null;
  let why = null;
  if (r.error) why = r.error.code === "ETIMEDOUT" ? "orc timeout" : `orc spawn error: ${r.error.code || r.error.message}`;
  else {
    try { obj = JSON.parse(String(r.stdout || "").trim()); } catch (_) { why = `orc exit ${r.status}, output not JSON`; }
    if (obj && (typeof obj !== "object" || !DATA_EXITS.has(r.status))) { why = `orc exit ${r.status}`; obj = null; }
  }
  if (obj) obj.store = { mode: "delegate", dir: path.join(root, ".claude", "orc", "graph") };
  return { obj, why, status: r.status };
}

function runDelegate(argv, root, sel, _home) {
  const a = parse(argv);
  // ORC does not know --if-exists. lorc handles it here: no ORC store → skip and
  // do not call ORC; else call `orc graph update` without the flag.
  if (a.sub === "update" && a.has("--if-exists")) {
    const dir = path.join(root, ".claude", "orc", "graph");
    if (!paths.readJson(path.join(dir, "meta.json"), null)) {
      return finisher(a, { mode: "delegate", dir })({ ok: true, state: "none", skipped: true, suggest: SUGGEST, exit: 0 }, SKIPPED);
    }
    argv = argv.filter((x) => x !== "--if-exists");
  }
  const { obj, why, status } = spawnOrc(argv, root, sel);
  if (!obj) {
    const own = { ...sel, mode: "own", claudeDir: path.join(root, ".claude", "lorc") };
    return runOwn(argv, root, own, { fallback: why || "orc failed" });
  }
  if (a.json) emit(obj);
  else if (obj.line || obj.card) process.stdout.write(String(obj.line || obj.card) + "\n");
  return status || 0;
}

// ── sync: kept for old callers. lorc 0.4.0 reads no ORC store, so there is
// nothing to copy.
function sync(_root, _opts) {
  return { ok: true, synced: false, reason: "not needed since lorc 0.4.0" };
}

// ── heal: `lorc graph status --heal --json`, in process ───────────────────
// It RETURNS the object that command prints, and prints nothing. A NONE store
// is not built: the result has `suggest: "lorc graph scan"` (the user runs it).
function heal(root, { home } = {}) {
  const sel = selectStore(root, { home });
  if (sel.mode === "delegate") {
    const d = spawnOrc(["status", "--heal", "--json"], root, sel);
    if (d.obj) return d.obj;
    sel.mode = "own";
    sel.claudeDir = path.join(root, ".claude", "lorc");
    sel.fallback = d.why || "orc failed";
  }
  const E = G();
  const ignore = list(orcConfig(root, "code_graph_ignore"));
  const { r, line } = ownStatus(sel.claudeDir, root, ignore, true, false);
  const out = shape(r, line, { mode: sel.mode, dir: E.graphPaths(sel.claudeDir).dir });
  return sel.fallback ? { ...out, fallback: sel.fallback } : out;
}

// ── entry ──────────────────────────────────────────────────────────────────
function cmd(argv = [], _name, { home } = {}) {
  const a = parse(argv);
  const dir = a.val("--dir");
  const root = dir ? path.resolve(dir) : paths.repoRoot();
  if (!a.sub || a.sub === "help") { process.stdout.write(USAGE + "\n"); return a.sub ? 0 : 1; }
  // `scan` = `update`: the same handler and the same output, in both modes.
  if (a.sub === "scan") return cmd(argv.map((x, i) => (i === argv.indexOf("scan") ? "update" : x)), _name, { home });

  if (a.sub === "where") {
    const sel = selectStore(root, { home });
    const out = { ok: true, ...sel, store: { mode: sel.mode, dir: path.join(sel.claudeDir, "orc", "graph") } };
    if (a.json) emit(out);
    else process.stdout.write(`graph store: ${sel.mode} — ${out.store.dir}\n  ${sel.reason}\n`);
    return 0;
  }
  if (a.sub === "sync") {
    const r = sync(root);
    if (a.json) emit(r);
    else process.stdout.write(`graph sync: skipped — ${r.reason}\n`);
    return 0;
  }
  const sel = selectStore(root, { home });
  if (sel.mode === "delegate") return runDelegate(argv, root, sel, home);
  return runOwn(argv, root, sel);
}

module.exports = { selectStore, sync, heal, cmd, USAGE };
