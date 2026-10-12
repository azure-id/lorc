"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const extra = require("../bin/lib/extra.js");

function proj() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-extra-"));
  const root = path.join(d, "proj");
  const home = path.join(d, "home");
  fs.mkdirSync(path.join(root, ".claude", "lorc"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { d, root, home };
}
const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const own = (e, profiles) => write(path.join(e.root, ".claude", "lorc", "extra.json"), { profiles });
const P = { name: "ds", base_url: "https://x.example/anthropic", model: "m1", key_env: "DS_KEY" };

test("ORC extra ledger + delegate stamp → source orc, slots from orc extra list", () => {
  const e = proj();
  write(path.join(e.root, ".claude", "orc", "extra.json"), { version: 2, profiles: [{ name: "zai" }] });
  const cli = path.join(e.d, "fake-orc.js");
  fs.writeFileSync(cli, "process.stdout.write(JSON.stringify({ok:true,profiles:[{name:'zai'}],slots:[{slot:'reviewer'}]}));");
  write(path.join(e.root, ".claude", "hooks", "orc-version.json"), { version: "2.3.0", cli });
  const r = extra.detect(e.root, { home: e.home });
  assert.strictEqual(r.source, "orc");
  assert.deepStrictEqual(r.slots, ["reviewer"]);
});

test("no ORC → lorc's own file → source lorc", () => {
  const e = proj();
  own(e, [P]);
  const r = extra.detect(e.root, { home: e.home });
  assert.strictEqual(r.source, "lorc");
  assert.deepStrictEqual(r.slots, ["ds"]);
});

test("a profile with a literal key is refused", () => {
  const e = proj();
  own(e, [Object.assign({}, P, { key: "sk-secret" })]);
  const r = extra.detect(e.root, { home: e.home });
  assert.strictEqual(r.source, "none");
  assert.ok(r.refused[0].includes("key on disk"));
  assert.ok(!JSON.stringify(r).includes("sk-secret"));
});

test("nothing → none; settings.extra off → none", () => {
  const e = proj();
  assert.deepStrictEqual(extra.detect(e.root, { home: e.home }), { source: "none", slots: [] });
  own(e, [P]);
  write(path.join(e.root, ".claude", "lorc", "settings.json"), { extra: "off" });
  assert.strictEqual(extra.detect(e.root, { home: e.home }).source, "none");
});
