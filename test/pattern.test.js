"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const pattern = require("../bin/lib/pattern.js");

function proj() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-pat-"));
  const root = path.join(d, "proj");
  fs.mkdirSync(root, { recursive: true });
  return { root, home: path.join(d, "home") };
}

test(".vue maps to the vue key (ORC's INDEX key)", () => {
  assert.deepStrictEqual(pattern.langsForFiles(["src/App.vue"]), ["vue"]);
  assert.deepStrictEqual(pattern.langsForFiles(["a.md"]), []);
});

test("cached pattern: cached true, sections at most 2,500 B, invariants intact", () => {
  const e = proj();
  const dir = path.join(e.root, ".claude", "orc", "patterns");
  fs.mkdirSync(dir, { recursive: true });
  const inv = "## Invariants (ALWAYS — BLOCKING; from the generic playbook)\n- INVARIANT: props are typed\n- INVARIANT: no v-html";
  const conv = ["## Conventions (PROJECT WINS — match these exactly)"];
  for (let i = 0; i < 200; i++) conv.push(`- CONVENTION ${i}: components use script setup and a long line of text`);
  fs.writeFileSync(path.join(dir, "vue-pattern.md"), `# Vue pattern\n\n${conv.join("\n")}\n\n${inv}\n\n## Conflicts flagged\n- none\n`);
  const st = pattern.status(e.root, ["vue"], { home: e.home });
  assert.strictEqual(st[0].cached, true);
  const s = pattern.sections(e.root, "vue", { home: e.home });
  assert.strictEqual(s.invariants, inv);
  assert.ok(s.conventions.startsWith("## Conventions"));
  assert.ok(Buffer.byteLength(s.conventions + s.invariants, "utf8") <= 2500);
});

test("miss → cached false", () => {
  const e = proj();
  assert.strictEqual(pattern.status(e.root, ["react"], { home: e.home })[0].cached, false);
  assert.strictEqual(pattern.sections(e.root, "react", { home: e.home }), null);
});
