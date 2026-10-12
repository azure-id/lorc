"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { selectStore } = require("../bin/lib/graph-router.js");
const { ENGINE, SCHEMA } = require("../vendor/graph/graph.js");

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-gsel-"));
  return { root: path.join(d, "proj"), home: path.join(d, "home") };
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function fakeOrc(root, version) {
  const cli = path.join(root, "..", "fake-orc.js");
  write(cli, "process.stdout.write('{\"ok\":true}')\n");
  write(path.join(root, ".claude", "hooks", "orc-version.json"), JSON.stringify({ version, cli }));
}
const meta = (dir, engine, schema = SCHEMA) =>
  write(path.join(dir, "orc", "graph", "meta.json"), JSON.stringify({ engine, schema, generation: 1 }));

test("ORC 2.3.0 + code_graph on → delegate; off → not delegate", () => {
  const { root, home } = tmp();
  fakeOrc(root, "2.3.0");
  write(path.join(root, ".claude", "orc.config.yaml"), "code_graph: on\n");
  let s = selectStore(root, { home });
  assert.strictEqual(s.mode, "delegate");
  assert.strictEqual(s.claudeDir, path.join(root, ".claude"));
  assert.match(s.reason, /orc 2\.3\.0/);
  write(path.join(root, ".claude", "orc.config.yaml"), "code_graph: off\n");
  s = selectStore(root, { home });
  assert.strictEqual(s.mode, "own");
});

test("ORC 1.8.1 never delegates", () => {
  const { root, home } = tmp();
  fakeOrc(root, "1.8.1");
  write(path.join(root, ".claude", "orc.config.yaml"), "code_graph: on\n");
  assert.notStrictEqual(selectStore(root, { home }).mode, "delegate");
});

test("no ORC, ORC store with the lorc engine → orc-store", () => {
  const { root, home } = tmp();
  meta(path.join(root, ".claude"), ENGINE);
  const s = selectStore(root, { home });
  assert.strictEqual(s.mode, "orc-store");
  assert.strictEqual(s.claudeDir, path.join(root, ".claude"));
});

test("ORC store with another engine + matching copy → copy", () => {
  const { root, home } = tmp();
  meta(path.join(root, ".claude"), "graph@1");
  meta(path.join(root, ".claude", "lorc", "copy"), ENGINE);
  const s = selectStore(root, { home });
  assert.strictEqual(s.mode, "copy");
  assert.strictEqual(s.claudeDir, path.join(root, ".claude", "lorc", "copy"));
});

test("nothing → own", () => {
  const { root, home } = tmp();
  const s = selectStore(root, { home });
  assert.strictEqual(s.mode, "own");
  assert.strictEqual(s.claudeDir, path.join(root, ".claude", "lorc"));
  assert.deepStrictEqual(s.engine, { engine: ENGINE, schema: SCHEMA });
});
