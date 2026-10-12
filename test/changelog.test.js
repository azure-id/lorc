"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

const CLI = path.join(__dirname, "..", "bin", "lorc.js");
const run = (url, ...a) => spawnSync(process.execPath, [CLI, "changelog", ...a], {
  encoding: "utf8", env: { ...process.env, LORC_CHANGELOG_URL: url },
});

test("remote file:// lists a newer version", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lorc-cl-")), "CHANGELOG.md");
  fs.writeFileSync(f, "# Changelog\n\n## 99.0.0 — 01-01-2030\n- Big thing.\n\n## 0.0.1 — 01-01-2020\n- Old.\n");
  const r = run(pathToFileURL(f).href, "--json");
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.source, "remote");
  assert.strictEqual(j.latest, "99.0.0");
  assert.deepStrictEqual(j.newer.map((e) => e.version), ["99.0.0"]);
  assert.deepStrictEqual(j.newer[0].lines, ["- Big thing."]);
});

test("unreachable URL falls back to local, exit 0", () => {
  const r = run("http://127.0.0.1:9/x");
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /offline — showing the local CHANGELOG\.md/);
});
