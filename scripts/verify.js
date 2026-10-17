#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

// Later waves add checks here (byte caps, agent files). Each returns a list of problems.
const CHECKS = [
  function vendorPins() {
    const r = spawnSync(process.execPath, [path.join(__dirname, "vendor.js"), "--check", "--root", ROOT], {
      encoding: "utf8", windowsHide: true,
    });
    return r.status === 0 ? [] : [(r.stderr || r.stdout || "vendor check failed").trim()];
  },
  function coreFiles() {
    const need = ["bin/lorc.js", "bin/lib/paths.js", "bin/lib/json.js",
      "bin/lib/settings.js", "bin/lib/install.js", "bin/lib/doctor.js", "bin/lib/changelog.js", "bin/lib/graph-router.js", "bin/lib/graph-shape.js", "bin/lib/graph/graph.js", "bin/lib/graph/graph-query.js", "bin/lib/graph/graph-extract.js",
      "bin/lib/core.js", "bin/lib/wiki.js", "bin/lib/pattern.js", "bin/lib/rules.js", "bin/lib/extra.js", "bin/lib/prep.js", "bin/lib/context.js", "bin/lib/jev.js", "bin/lib/tier.js", "bin/lib/tier-text.js", "bin/lib/tier-history.js", "bin/lib/slice.js", "bin/lib/read.js", "bin/lib/check.js", "bin/lib/coverage.js", "bin/lib/ask-facts.js", "bin/lib/review.js", "templates/HOUSE-RULES.template.md",
      "vendor/core/wiki-core.js", "vendor/core/pattern-core.js", "vendor/core/rules-core.js",
      "templates/hooks/lorc-graph-hook.js", "package.json", "README.md", "CHANGELOG.md"];
    return need.filter((f) => !fs.existsSync(path.join(ROOT, f))).map((f) => `missing: ${f}`);
  },
  function graphHook() {
    const f = path.join(ROOT, "templates", "hooks", "lorc-graph-hook.js");
    if (!fs.existsSync(f)) return [];
    const text = fs.readFileSync(f, "utf8");
    const out = [];
    const lines = text.split(/\r?\n/).length;
    if (lines > 350) out.push(`lorc-graph-hook.js has ${lines} lines (cap 350)`);
    if (/require\(\s*["']\.{1,2}\//.test(text)) out.push("lorc-graph-hook.js requires a package file (it must be standalone)");
    return out;
  },
];

const problems = [];
for (const c of CHECKS) problems.push(...c());
if (problems.length) {
  for (const p of problems) process.stderr.write(`❌ ${p}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("✅ lorc package OK\n");
}
