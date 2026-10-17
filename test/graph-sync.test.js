"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { sync } = require("../bin/lib/graph-router.js");

const CLI = path.join(__dirname, "..", "bin", "lorc.js");

test("0.4.0: sync copies nothing and says it is not needed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-gsync-"));
  const g = path.join(root, ".claude", "orc", "graph");
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, "meta.json"), JSON.stringify({ engine: "graph@7", schema: 1 }));
  assert.deepStrictEqual(sync(root), { ok: true, synced: false, reason: "not needed since lorc 0.4.0" });
  assert.ok(!fs.existsSync(path.join(root, ".claude", "lorc", "copy")));
  const r = spawnSync(process.execPath, [CLI, "graph", "sync", "--if-older", "24", "--json", "--dir", root], { encoding: "utf8" });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).reason, "not needed since lorc 0.4.0");
  fs.rmSync(root, { recursive: true, force: true });
});
