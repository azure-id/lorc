"use strict";
// W19b: graph store format 2 (content-addressed buckets) and the format-1 upgrade.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const G = require("../bin/lib/graph/graph.js");
const Q = require("../bin/lib/graph/graph-query.js");
const R = require("../bin/lib/graph/graph-resolve.js");
const router = require("../bin/lib/graph-router.js");

const CLI = path.join(__dirname, "..", "bin", "lorc.js");
const HOOK = path.join(__dirname, "..", "templates", "hooks", "lorc-graph-hook.js");
const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const FILES = {
  "src/api/client.js": "function request(url) {\n  return fetch(url);\n}\nmodule.exports = { request };\n",
  "src/api/orders.js": "const { request } = require('./client');\nfunction loadOrders() {\n  return request('/orders');\n}\nmodule.exports = { loadOrders };\n",
  "src/api/users.js": "const { request } = require('./client');\nfunction loadUsers() {\n  return request('/users');\n}\nmodule.exports = { loadUsers };\n",
  "src/util/format.js": "function formatMoney(n) {\n  return n.toFixed(2);\n}\nfunction formatDate(d) {\n  return String(d);\n}\nmodule.exports = { formatMoney, formatDate };\n",
  "src/util/math.js": "function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { sum };\n",
  "src/service/report.js": "const { loadOrders } = require('../api/orders');\nconst { sum } = require('../util/math');\nconst { formatMoney } = require('../util/format');\nfunction totalReport() {\n  return formatMoney(sum(loadOrders()));\n}\nmodule.exports = { totalReport };\n",
  "src/service/people.js": "const { loadUsers } = require('../api/users');\nfunction peopleCount() {\n  return loadUsers().length;\n}\nmodule.exports = { peopleCount };\n",
  "src/index.js": "const { totalReport } = require('./service/report');\nconst { peopleCount } = require('./service/people');\nfunction main() {\n  return [totalReport(), peopleCount()];\n}\nmodule.exports = { main };\n",
  "src/components/OrderList.vue": "<template>\n  <div>{{ total }}</div>\n</template>\n<script>\nimport { totalReport } from '../service/report';\nexport default {\n  name: 'OrderList',\n  methods: {\n    refresh() {\n      return totalReport();\n    },\n  },\n};\n</script>\n",
  "src/i18n/en.json": "{\n  \"orders\": { \"title\": \"Orders\" }\n}\n",
};

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-gstore-"));
  temps.push(d);
  const root = path.join(d, "proj");
  const home = path.join(d, "home");
  fs.mkdirSync(root, { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  for (const [rel, text] of Object.entries(FILES)) write(path.join(root, rel), text);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { d, root, home, claudeDir: path.join(root, ".claude", "lorc") };
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const update = (claudeDir, root) => G.graphUpdate(claudeDir, root, { enabled: true });
const gdir = (claudeDir) => G.graphPaths(claudeDir).dir;
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// The cold build of the same tree in a second claudeDir.
function coldByFile(env) {
  const dir = path.join(env.d, "cold");
  fs.rmSync(dir, { recursive: true, force: true });
  const u = update(dir, env.root);
  assert.strictEqual(u.state, "built");
  return Q.loadModel(dir, env.root).byFile;
}

test("1. cold build writes format 2 buckets and no format-1 files", () => {
  const env = repo();
  const u = update(env.claudeDir, env.root);
  assert.strictEqual(u.state, "built", JSON.stringify(u));
  const g = gdir(env.claudeDir);
  const meta = readJson(path.join(g, "meta.json"));
  assert.strictEqual(meta.format, 2);
  assert.strictEqual(meta.engine, "lgraph@1");
  assert.deepStrictEqual(meta.extractors, G.EXTRACTORS);
  assert.ok(Object.keys(meta.index).length > 0);
  for (const name of Object.values(meta.index)) assert.ok(fs.existsSync(path.join(g, "index", name)), name);
  const derived = readJson(path.join(g, "derived.json"));
  assert.strictEqual(derived.generation, meta.generation);
  for (const name of Object.values(derived.resolved)) assert.ok(fs.existsSync(path.join(g, "resolved", name)));
  for (const name of Object.values(derived.names)) assert.ok(fs.existsSync(path.join(g, "names", name)));
  assert.ok(fs.existsSync(path.join(g, derived.map)));
  for (const gone of ["index.json", "blobs", "wide.json", "resolved.json", "names.json", "map.json"]) assert.ok(!fs.existsSync(path.join(g, gone)), gone);
  if (fs.existsSync(path.join(g, "resolved"))) assert.ok(!fs.readdirSync(path.join(g, "resolved")).some((n) => /^[0-9a-f]{2}\.json$/.test(n)));
  const model = Q.loadModel(env.claudeDir, env.root);
  assert.deepStrictEqual(Object.keys(model.byFile).sort(), Object.keys(FILES).sort());
  assert.strictEqual(model.byFile["src/i18n/en.json"].lang, "i18n");
  const files = readJson(path.join(g, "files.json"));
  assert.strictEqual(files["src/api/client.js"].xv, 3);
});

test("2. a 1-file edit changes one index bucket; a no-op update writes no file", () => {
  const env = repo();
  update(env.claudeDir, env.root);
  const g = gdir(env.claudeDir);
  const before = readJson(path.join(g, "meta.json")).index;
  fs.appendFileSync(path.join(env.root, "src/util/math.js"), "// a comment\n");
  const u = update(env.claudeDir, env.root);
  assert.strictEqual(u.state, "updated");
  assert.strictEqual(u.parsed, 1);
  const after = readJson(path.join(g, "meta.json")).index;
  assert.deepStrictEqual(Object.keys(after).sort(), Object.keys(before).sort());
  const moved = Object.keys(after).filter((bb) => after[bb] !== before[bb]);
  assert.deepStrictEqual(moved, [G.bucketOf("src/util/math.js")]);

  const stamp = () => new Map(walk(g).map((f) => [f, fs.statSync(f).mtimeMs]));
  const s0 = stamp();
  const n = update(env.claudeDir, env.root);
  assert.strictEqual(n.state, "unchanged");
  assert.strictEqual(n.parsed, 0);
  assert.deepStrictEqual(stamp(), s0);
});

test("3. update == rebuild after each of 6 edits, and the merged callers == computed", () => {
  const env = repo();
  update(env.claudeDir, env.root);
  const at = (rel) => path.join(env.root, rel);
  const steps = [
    () => write(at("src/util/extra.js"), "const { sum } = require('./math');\nfunction double(xs) {\n  return sum(xs) * 2;\n}\nmodule.exports = { double };\n"),
    () => write(at("src/util/math.js"), "function sum(xs) {\n  let t = 0;\n  for (const x of xs) t += x;\n  return t;\n}\nmodule.exports = { sum };\n"),
    () => write(at("src/api/users.js"), "const { request } = require('./client');\nfunction fetchUsers() {\n  return request('/users');\n}\nmodule.exports = { fetchUsers };\n"),
    () => fs.rmSync(at("src/service/people.js")),
    () => write(at("src/index.js"), "const { totalReport } = require('./service/report');\nconst { double } = require('./util/extra');\nfunction main() {\n  return [totalReport(), double([1])];\n}\nmodule.exports = { main };\n"),
    () => fs.appendFileSync(at("src/api/client.js"), "// keep this short\n"),
  ];
  for (const [i, step] of steps.entries()) {
    step();
    const u = update(env.claudeDir, env.root);
    assert.strictEqual(u.state, "updated", `step ${i}: ${JSON.stringify(u)}`);
    const model = Q.loadModel(env.claudeDir, env.root);
    assert.deepStrictEqual(model.byFile, coldByFile(env), `step ${i}`);
    const meta = readJson(path.join(gdir(env.claudeDir), "meta.json"));
    const cached = R.load(env.claudeDir, meta);
    assert.ok(cached, `step ${i}: no cache`);
    const computed = R.computeCallers(Q.loadModel(env.claudeDir, env.root, { noCache: true }));
    assert.strictEqual(JSON.stringify(cached.callers), JSON.stringify(computed.callers), `step ${i}`);
    assert.strictEqual(JSON.stringify(cached.maybe), JSON.stringify(computed.maybe), `step ${i}`);
  }
});

test("4. a format-1 store is readable, and `lorc graph upgrade` converts it", () => {
  const env = repo();
  // The records of a format-2 build of the same files, without `xv`.
  const tmpDir = path.join(env.d, "src2");
  update(tmpDir, env.root);
  const byFile = G.readIndex(tmpDir).by_file;
  const files2 = readJson(path.join(gdir(tmpDir), "files.json"));
  const strip = (o) => { const { xv: _x, ...rest } = o; return rest; };
  const g = gdir(env.claudeDir);
  const oldBy = {};
  const oldFiles = {};
  for (const rel of Object.keys(byFile)) { oldBy[rel] = strip(byFile[rel]); oldFiles[rel] = strip(files2[rel]); }
  write(path.join(g, "meta.json"), JSON.stringify({ schema: 1, engine: "graph@7", generation: 3, files: Object.keys(oldBy).length, symbols: 0, updated_at: "x" }));
  write(path.join(g, "files.json"), JSON.stringify(oldFiles));
  write(path.join(g, "index.json"), JSON.stringify({ schema: 1, engine: "graph@7", by_file: oldBy }));
  write(path.join(g, "wide.json"), "{}");
  write(path.join(g, "names.json"), "{}");
  write(path.join(g, "resolved.json"), "{}");
  write(path.join(g, "map.json"), "{}");
  write(path.join(g, "blobs", "ab", "abc.json"), "{}");
  write(path.join(g, "resolved", "ab.json"), "{}");

  const old = Q.loadModel(env.claudeDir, env.root);
  assert.ok(old, "format 1 must be readable");
  assert.deepStrictEqual(Object.keys(old.byFile).sort(), Object.keys(FILES).sort());
  const st = G.graphStatus(env.claudeDir, env.root, { enabled: true });
  assert.strictEqual(st.state, "drifted");
  assert.deepStrictEqual(st.upgrade, { from: "graph@7", to: "lgraph@1" });

  const r = spawnSync(process.execPath, [CLI, "graph", "upgrade", "--json", "--dir", env.root], { encoding: "utf8", env: { ...process.env, LORC_HOME: env.home } });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.state, "upgraded", r.stdout);
  assert.strictEqual(out.from, "graph@7");
  assert.strictEqual(out.parsed, Object.keys(FILES).length - 1); // js/vue parsed; i18n (xv 1) reused
  assert.strictEqual(out.reused, 1);
  assert.match(out.line, /^graph: upgraded graph@7 → lgraph@1 \(1 reused, 9 parsed, \d+ ms\)$/);
  assert.strictEqual(readJson(path.join(g, "meta.json")).format, 2);
  for (const gone of ["index.json", "wide.json", "names.json", "resolved.json", "map.json", "blobs", path.join("resolved", "ab.json")]) {
    assert.ok(!fs.existsSync(path.join(g, gone)), gone);
  }
  assert.deepStrictEqual(Q.loadModel(env.claudeDir, env.root).byFile, coldByFile(env));

  const again = spawnSync(process.execPath, [CLI, "graph", "upgrade", "--dir", env.root], { encoding: "utf8", env: { ...process.env, LORC_HOME: env.home } });
  assert.match(again.stdout, /graph: already lgraph@1 \(format 2\) — nothing to do/);
});

test("5. gc with graceMs 0 removes unlisted bucket files and keeps listed ones", () => {
  const env = repo();
  update(env.claudeDir, env.root);
  const g = gdir(env.claudeDir);
  const junk = [path.join(g, "index", "99-deadbeef.json"), path.join(g, "resolved", "98-00000000.json"), path.join(g, "names", "97-11111111.json"), path.join(g, "map-22222222.json")];
  for (const f of junk) write(f, "{}");
  const r = G.graphGc(env.claudeDir, { graceMs: 0 });
  assert.strictEqual(r.exit, 0);
  assert.ok(r.removed >= junk.length);
  for (const f of junk) assert.ok(!fs.existsSync(f), f);
  const meta = readJson(path.join(g, "meta.json"));
  const derived = readJson(path.join(g, "derived.json"));
  for (const n of Object.values(meta.index)) assert.ok(fs.existsSync(path.join(g, "index", n)));
  for (const n of Object.values(derived.resolved)) assert.ok(fs.existsSync(path.join(g, "resolved", n)));
  for (const n of Object.values(derived.names)) assert.ok(fs.existsSync(path.join(g, "names", n)));
  assert.ok(fs.existsSync(path.join(g, derived.map)));
  assert.ok(Q.loadModel(env.claudeDir, env.root));
});

test("5b. gc keeps the current and the previous manifest, and deletes older files at once", () => {
  const env = repo();
  update(env.claudeDir, env.root);
  const g = gdir(env.claudeDir);
  const bb = G.bucketOf("src/util/math.js");
  const gen = [];
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(path.join(env.root, "src/util/math.js"), `// edit ${i}\n`);
    const u = update(env.claudeDir, env.root);
    assert.strictEqual(u.state, "updated");
    gen.push({ meta: readJson(path.join(g, "meta.json")), derived: readJson(path.join(g, "derived.json")) });
  }
  const [older, prev, cur] = gen;
  assert.deepStrictEqual(cur.meta.prev_index, prev.meta.index);
  assert.deepStrictEqual(cur.derived.prev.resolved, prev.derived.resolved);
  assert.ok(fs.existsSync(path.join(g, "index", cur.meta.index[bb])));
  assert.ok(fs.existsSync(path.join(g, "index", prev.meta.index[bb])), "previous manifest kept");
  // Written seconds ago, but listed by neither manifest: deleted.
  assert.notStrictEqual(older.meta.index[bb], prev.meta.index[bb]);
  assert.ok(!fs.existsSync(path.join(g, "index", older.meta.index[bb])), "two manifests back is deleted");
  for (const n of Object.values(prev.derived.resolved)) assert.ok(fs.existsSync(path.join(g, "resolved", n)), n);
  // A stray temp file is deleted only after the grace.
  const young = path.join(g, "index", "00-aaaaaaaa.json.1.tmp");
  const old = path.join(g, "index", "01-bbbbbbbb.json.2.tmp");
  write(young, "{}");
  write(old, "{}");
  const past = new Date(Date.now() - G.GRACE_MS - 60 * 1000);
  fs.utimesSync(old, past, past);
  G.graphGc(env.claudeDir, { graceMs: G.GRACE_MS });
  assert.ok(fs.existsSync(young));
  assert.ok(!fs.existsSync(old));
  assert.ok(Q.loadModel(env.claudeDir, env.root));
});

test("6. the hook names hint works on a format-2 store", () => {
  const env = repo();
  update(env.claudeDir, env.root);
  const g = gdir(env.claudeDir);
  write(path.join(env.root, ".claude", "lorc", "run", ".current"), JSON.stringify({ slug: "s1", store_dir: g, mode: "own", at: new Date().toISOString() }));
  const input = JSON.stringify({ hook_event_name: "PreToolUse", cwd: env.root, tool_name: "Grep", tool_input: { pattern: "formatMoney\\(" }, agent_id: "a1" });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env: { ...process.env, LORC_HOME: env.home } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, "");
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /"formatMoney" is defined at formatMoney \(function\) src\/util\/format\.js:1-3/);
});

test("W33: heal() on a fresh repo builds nothing and suggests a scan", () => {
  const env = repo();
  const r = router.heal(env.root, { home: env.home });
  assert.strictEqual(r.state, "none", JSON.stringify(r));
  assert.strictEqual(r.suggest, "lorc graph scan");
  assert.ok(!r.healed);
  assert.strictEqual(r.store.mode, "own");
  assert.strictEqual(typeof r.line, "string");
});

// lorc 0.5.0 (W34e): `graph update --json` tells the bytes it wrote and the module count.
test("W34e. graph update --json: written_bytes and modules", () => {
  const env = repo();
  // A top-level call gives the file a `<module>` record.
  write(path.join(env.root, "src/boot.js"), "const { main } = require('./index');\nmain();\n");
  spawnSync("git", ["add", "."], { cwd: env.root });
  spawnSync("git", ["commit", "-q", "-m", "boot"], { cwd: env.root });
  const run = () => {
    const r = spawnSync(process.execPath, [CLI, "graph", "update", "--json", "--dir", env.root], { encoding: "utf8", env: { ...process.env, LORC_HOME: env.home } });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    return JSON.parse(r.stdout);
  };
  const first = run();
  assert.ok(first.written_bytes > 0, JSON.stringify(first));
  assert.ok(first.modules >= 1, JSON.stringify(first));
  assert.strictEqual(typeof first.symbols, "number");
  // A no-op update writes no file (not even meta.json), so it reports 0.
  const again = run();
  assert.strictEqual(again.state, "unchanged", JSON.stringify(again));
  assert.strictEqual(again.written_bytes, 0);
  assert.strictEqual(again.modules, first.modules);
});
