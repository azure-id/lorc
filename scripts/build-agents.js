#!/usr/bin/env node
"use strict";
/**
 * Executor generator: agents-src/executor.template.md x VARIANTS.
 *   node scripts/build-agents.js          write the files (LF)
 *   node scripts/build-agents.js --check  exit 1 when a file differs or is missing
 * CORE goes to templates/agents/, ALL to templates/agents-all/ (installed only
 * when the lorc setting `executors` is `all`). effort null = the model has no
 * effort ladder: the `effort:` line is omitted.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TEMPLATE = path.join(ROOT, "agents-src", "executor.template.md");

const CORE = [
  { name: "haiku-5-high", model: "claude-haiku-5-5", effort: "high", label: "Haiku 5.5 high" },
  { name: "sonnet-5-med", model: "claude-sonnet-5-5", effort: "medium", label: "Sonnet 5.5 medium" },
  { name: "opus-5-low", model: "claude-opus-5-5", effort: "low", label: "Opus 5.5 low" },
  { name: "opus-5-med", model: "claude-opus-5-5", effort: "medium", label: "Opus 5.5 medium" },
];
// Model ids and effort copied from ORC bin/build-agents.js VARIANTS.
const ALL = [
  { name: "haiku-4-5", model: "claude-haiku-4-5", effort: null, label: "Haiku 4.5" },
  { name: "sonnet-4-6-med", model: "claude-sonnet-4-6", effort: "medium", label: "Sonnet 4.6 medium" },
  { name: "sonnet-4-6-high", model: "claude-sonnet-4-6", effort: "high", label: "Sonnet 4.6 high" },
  { name: "sonnet-5-high", model: "claude-sonnet-5-5", effort: "high", label: "Sonnet 5.5 high" },
  { name: "opus-4-7-med", model: "claude-opus-4-7", effort: "medium", label: "Opus 4.7 medium" },
  { name: "opus-4-7-high", model: "claude-opus-4-7", effort: "high", label: "Opus 4.7 high" },
  { name: "opus-4-8-high", model: "claude-opus-4-8", effort: "high", label: "Opus 4.8 high" },
  { name: "opus-5-high", model: "claude-opus-5-5", effort: "high", label: "Opus 5.5 high" },
];
const VARIANTS = [
  ...CORE.map((v) => ({ ...v, dir: "agents" })),
  ...ALL.map((v) => ({ ...v, dir: "agents-all" })),
];

function render(tpl, v) {
  let out = tpl.replace(/\r\n/g, "\n");
  if (v.effort === null) out = out.replace(/^effort: \{\{effort\}\}\n/m, "").replace(/, \{\{effort\}\}/g, "");
  return out.replace(/\{\{name\}\}/g, v.name).replace(/\{\{model\}\}/g, v.model)
    .replace(/\{\{effort\}\}/g, v.effort || "").replace(/\{\{label\}\}/g, v.label);
}

function build() {
  const tpl = fs.readFileSync(TEMPLATE, "utf8");
  return VARIANTS.map((v) => ({
    file: path.join(ROOT, "templates", v.dir, `lorc-executor-${v.name}.md`),
    text: render(tpl, v),
  }));
}

function main(argv) {
  const out = build();
  if (argv.includes("--check")) {
    const bad = [];
    for (const o of out) {
      let cur = null;
      try { cur = fs.readFileSync(o.file, "utf8"); } catch (_) { /* missing */ }
      if (cur === null) bad.push(`missing: ${path.relative(ROOT, o.file)}`);
      else if (cur !== o.text) bad.push(`differs: ${path.relative(ROOT, o.file)}`);
    }
    if (bad.length) { process.stderr.write(bad.join("\n") + "\nrun: npm run build:agents\n"); return 1; }
    process.stdout.write(`build-agents: ${out.length} files match\n`);
    return 0;
  }
  for (const o of out) {
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    fs.writeFileSync(o.file, o.text);
  }
  process.stdout.write(`build-agents: wrote ${out.length} files\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { VARIANTS, CORE, ALL, render, build };
