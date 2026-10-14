"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { install } = require("../bin/lib/install.js");
const doctor = require("../bin/lib/doctor.js");

test("healthy → ok; missing file → ✗; --fix restores", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-doc-"));
  const pkgRoot = path.join(base, "pkg");
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  const files = [
    ["package.json", JSON.stringify({ version: "1.2.3" })],
    ["templates/skills/lorc/SKILL.md", "s"],
    ["templates/hooks/lorc-graph-hook.js", "h"],
  ];
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(pkgRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, rel), text);
  }
  const claudeDir = path.join(base, "proj", ".claude");
  install({ claudeDir, pkgRoot });
  let r = doctor.run({ claudeDir, pkgRoot, home });
  assert.ok(r.ok, doctor.format(r.checks));
  const j = r.checks.find((c) => c.id === "jev");
  assert.ok(j && j.ok === true, JSON.stringify(r.checks));
  const te = r.checks.find((c) => c.id === "tier-engine");
  assert.ok(te && te.ok === true, JSON.stringify(r.checks));
  fs.unlinkSync(path.join(claudeDir, "skills", "lorc", "SKILL.md"));
  r = doctor.run({ claudeDir, pkgRoot, home });
  assert.strictEqual(r.ok, false);
  assert.match(doctor.format(r.checks), /✗ files — 1 missing/);
  r = doctor.run({ claudeDir, pkgRoot, home, fix: true });
  assert.ok(r.ok, doctor.format(r.checks));
  assert.ok(fs.existsSync(path.join(claudeDir, "skills", "lorc", "SKILL.md")));
});
