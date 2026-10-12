"use strict";
// Loads the three vendored ORC cores (wiki, pattern, rules) and gives them
// lorc's deps. Each core is configured once, on first use.

const fs = require("fs");
const path = require("path");
const paths = require("./paths.js");

const PKG = path.join(__dirname, "..", "..");
const VENDOR = path.join(PKG, "vendor");
const SRC_SKILLS = path.join(VENDOR, "skills");

// ORC defaults for the config keys the cores read. The cores apply the same
// numbers when a key is absent, so the table only makes the value visible.
const ORC_DEFAULTS = {
  wiki_fresh_max: 10,
  wiki_aging_max: 30,
  rules_card_compact: "on",
};

// The lane → packs table. The lorc card uses code + delivery; ui is added per file.
const LANE_PACKS = { lorc: ["code", "delivery"] };

function parseYamlLines(file) {
  const map = {};
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (_) { return null; }
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+):\s*(.+)$/.exec(raw);
    if (!m) continue;
    let v = m[2].trim();
    const quoted = /^(["']).*\1$/.test(v);
    if (quoted) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    map[m[1]] = v;
  }
  return map;
}

// Same return shape as ORC's readOverride: { path, map }.
// Order: project .claude/orc.config.yaml, then ~/.claude/orc.config.yaml, then ORC's default.
function makeReadOverride(home) {
  return function readOverride(claudeDir) {
    const projFile = path.join(claudeDir, "orc.config.yaml");
    const globFile = path.join(paths.homeClaude(home), "orc.config.yaml");
    const proj = parseYamlLines(projFile) || {};
    const glob = path.resolve(globFile) === path.resolve(projFile) ? {} : (parseYamlLines(globFile) || {});
    const map = Object.assign({}, ORC_DEFAULTS, glob, proj);
    return { path: projFile, map };
  };
}

function repoRootOf(claudeDir) {
  return paths.repoRoot(path.dirname(claudeDir));
}

let state = { home: undefined, wiki: null, pattern: null, rules: null };

function setHome(home) {
  if (home !== state.home) state = { home, wiki: null, pattern: null, rules: null };
}

function wikiCore({ home } = {}) {
  setHome(home);
  if (!state.wiki) {
    const m = require(path.join(VENDOR, "core", "wiki-core.js"));
    m.configure({ repoRootOf, readOverride: makeReadOverride(state.home) });
    state.wiki = m;
  }
  return state.wiki;
}

function patternCore({ home } = {}) {
  setHome(home);
  if (!state.pattern) {
    const m = require(path.join(VENDOR, "core", "pattern-core.js"));
    m.configure({
      srcSkills: () => SRC_SKILLS,
      parseDocHeader: (t) => wikiCore({ home: state.home }).parseDocHeader(t),
    });
    state.pattern = m;
  }
  return state.pattern;
}

function rulesCore({ home } = {}) {
  setHome(home);
  if (!state.rules) {
    const m = require(path.join(VENDOR, "core", "rules-core.js"));
    m.configure({
      srcSkills: () => SRC_SKILLS,
      readOverride: makeReadOverride(state.home),
      repoRootOf,
      lanePacks: () => LANE_PACKS,
      habitsMode: () => "off",
      learnedRules: () => null,
    });
    state.rules = m;
  }
  return state.rules;
}

// Run the ORC cli of a delegate stamp. Returns { ok, status, json, stdout, stderr }.
function orcRun(cli, args, cwd) {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: "utf8", timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(String(r.stdout || "").trim()); } catch (_) { /* not JSON */ }
  return { ok: !r.error && r.status !== null, status: r.status, json, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function argRoot(argv) {
  const i = argv.indexOf("--dir");
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : paths.repoRoot();
}

function positionals(argv, valueFlags = []) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" || valueFlags.includes(argv[i])) { i++; continue; }
    if (argv[i].startsWith("--")) continue;
    out.push(argv[i]);
  }
  return out;
}

module.exports = { orcRun, argRoot, positionals, SRC_SKILLS, VENDOR, ORC_DEFAULTS, LANE_PACKS, makeReadOverride, wikiCore, patternCore, rulesCore };
