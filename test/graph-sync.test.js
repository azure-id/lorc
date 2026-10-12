"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sync } = require("../bin/lib/graph-router.js");

test("sync copies the ORC store without .lock and gain.jsonl; --if-older skips a fresh copy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-gsync-"));
  const g = path.join(root, ".claude", "orc", "graph");
  fs.mkdirSync(path.join(g, "blobs", "ab"), { recursive: true });
  fs.writeFileSync(path.join(g, "meta.json"), JSON.stringify({ engine: "graph@7", schema: 1 }));
  fs.writeFileSync(path.join(g, "blobs", "ab", "abc.json"), "{}");
  fs.writeFileSync(path.join(g, ".lock"), "x");
  fs.writeFileSync(path.join(g, "gain.jsonl"), "x");
  fs.writeFileSync(path.join(g, "index.json.tmp-1"), "x");

  const r = sync(root);
  assert.strictEqual(r.synced, true);
  const to = path.join(root, ".claude", "lorc", "copy", "orc", "graph");
  assert.ok(fs.existsSync(path.join(to, "meta.json")));
  assert.ok(fs.existsSync(path.join(to, "blobs", "ab", "abc.json")));
  assert.ok(!fs.existsSync(path.join(to, ".lock")));
  assert.ok(!fs.existsSync(path.join(to, "gain.jsonl")));
  assert.ok(!fs.existsSync(path.join(to, "index.json.tmp-1")));
  assert.ok(fs.existsSync(path.join(root, ".claude", "lorc", "copy", "synced_at")));

  const again = sync(root, { ifOlder: 24 });
  assert.strictEqual(again.synced, false);
  assert.strictEqual(again.reason, "fresh");
});

test("sync without an ORC store says so", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-gsync-"));
  const r = sync(root);
  assert.strictEqual(r.synced, false);
  assert.strictEqual(r.reason, "no orc store");
});
