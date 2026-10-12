"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../bin/lib/core.js");

test("the three vendored cores load and configure", () => {
  const w = core.wikiCore();
  const p = core.patternCore();
  const r = core.rulesCore();
  assert.strictEqual(typeof w.wikiResolve, "function");
  assert.strictEqual(typeof p.patternStatusData, "function");
  assert.strictEqual(typeof r.rulesReadPacks, "function");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-"));
  const packs = r.rulesReadPacks(path.join(d, ".claude"));
  assert.strictEqual(packs.source, "package");
  assert.ok(packs.readable, "every vendored pack is readable");
  assert.ok(p.knownPatternLangs(path.join(d, ".claude")).includes("vue"));
});

test("readOverride: project beats global beats ORC default", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-"));
  const home = path.join(d, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(d, "p", ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "orc.config.yaml"), "wiki_fresh_max: 5\nwiki_aging_max: 7\n");
  fs.writeFileSync(path.join(d, "p", ".claude", "orc.config.yaml"), "wiki_fresh_max: 3  # mine\n");
  const ro = core.makeReadOverride(home)(path.join(d, "p", ".claude"));
  assert.strictEqual(ro.map.wiki_fresh_max, "3");
  assert.strictEqual(ro.map.wiki_aging_max, "7");
  assert.strictEqual(ro.map.rules_card_compact, "on");
  assert.ok(ro.path.endsWith("orc.config.yaml"));
});

test("a missing dep does not crash at load", () => {
  const m = require("../vendor/core/rules-core.js");
  m.configure({});
  assert.strictEqual(typeof m.rulesParsePack, "function");
  // Give the shared module its lorc deps back for the tests after this one.
  core.rulesCore({ home: "reset-" + Date.now() });
});
