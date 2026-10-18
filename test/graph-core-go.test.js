"use strict";
// lorc 0.5.0 (W32a): Go core fixes. The Go parser builds once, a local value is
// not a ref, test helpers are noise, and a call on a local or a chain does not fan out.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const X = require("../bin/lib/graph/graph-extract.js");
const G = require("../bin/lib/graph/graph.js");
const Q = require("../bin/lib/graph/graph-query.js");

const EXTRACT = path.join(__dirname, "..", "bin", "lib", "graph", "graph-extract.js");
const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function heuristic(rel, src) {
  const was = process.env.ORC_GRAPH_NO_BORROW;
  process.env.ORC_GRAPH_NO_BORROW = "1";
  try {
    return X.extractOne({ rel, lang: "go", src }, null);
  } finally {
    if (was === undefined) delete process.env.ORC_GRAPH_NO_BORROW;
    else process.env.ORC_GRAPH_NO_BORROW = was;
  }
}
function borrowed(rel, src) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-go-"));
  temps.push(d);
  const abs = path.join(d, rel);
  fs.writeFileSync(abs, src);
  const was = process.env.ORC_GRAPH_NO_BORROW;
  delete process.env.ORC_GRAPH_NO_BORROW;
  try {
    return X.extractBatch([{ rel, abs, lang: "go", src }], { root: d }).get(rel);
  } finally {
    if (was !== undefined) process.env.ORC_GRAPH_NO_BORROW = was;
  }
}
const sym = (rec, qname) => rec.symbols.find((s) => s.qname === qname);
const hasGo = () => {
  const was = process.env.ORC_GRAPH_NO_BORROW;
  delete process.env.ORC_GRAPH_NO_BORROW;
  try {
    return !!X._findGo();
  } finally {
    if (was !== undefined) process.env.ORC_GRAPH_NO_BORROW = was;
  }
};

const SVC = [
  "package h",
  "func (s *Svc) Get(id int) error {",
  "  row, err := s.db.Query(id)",
  '  if err != nil { return fmt.Errorf("x: %w", err) }',
  "  defer row.Close()",
  "  s.log(err)",
  "  return nil",
  "}",
  "",
].join("\n");

function checkSvc(rec) {
  const s = sym(rec, "Svc.Get");
  assert.ok(s, "Svc.Get is a symbol");
  for (const n of ["err", "id", "row"]) assert.ok(!s.calls.some((c) => c.ref && c.name === n), `no ref named ${n}`);
  const close = s.calls.find((c) => c.name === "row.Close");
  assert.ok(close, "row.Close is a call");
  assert.strictEqual(close.lv, true);
  const log = s.calls.find((c) => c.name === "s.log" || c.name === "Svc.log");
  assert.ok(log, "s.log is a call");
  assert.ok(!log.lv, "a call on the receiver has no lv");
}

test("heuristic: Go locals are not refs; a call on a local has lv", () => {
  checkSvc(heuristic("h.go", SVC));
});

test("borrowed: Go locals are not refs; a call on a local has lv", (t) => {
  if (!hasGo()) return t.skip("no Go toolchain");
  const rec = borrowed("h.go", SVC);
  assert.match(rec.extractor, /^go-ast@/);
  checkSvc(rec);
});

const TESTSRC = [
  "package h",
  "func TestGet(t *testing.T) {",
  "  db, mock, _ := sqlmock.New()",
  '  mock.ExpectQuery("SELECT").WithArgs(1).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(1))',
  '  t.Run("a", func(t *testing.T) { Get(1) })',
  "}",
  "",
].join("\n");

function checkTest(rec) {
  const s = rec.symbols.find((x) => x.name === "TestGet");
  assert.ok(s, "TestGet is a symbol");
  const names = s.calls.filter((c) => !c.ref).map((c) => c.name);
  assert.ok(names.includes("Get"), `Get is kept: ${names.join(", ")}`);
  for (const n of ["t.Run", "mock.ExpectQuery", "WithArgs", "WillReturnRows", "AddRow", "NewRows", "sqlmock.NewRows"]) assert.ok(!names.includes(n), `${n} is dropped`);
}

test("heuristic: Go test helpers in _test.go are noise", () => {
  checkTest(heuristic("h_test.go", TESTSRC));
});

test("borrowed: Go test helpers in _test.go are noise", (t) => {
  if (!hasGo()) return t.skip("no Go toolchain");
  checkTest(borrowed("h_test.go", TESTSRC));
});

test("httptest.NewRequest in a Go test still gives its URL", () => {
  const src = ['package h', 'func TestList(t *testing.T) {', '  req := httptest.NewRequest("GET", "/orders", nil)', "  t.Log(req)", "}", ""].join("\n");
  const s = heuristic("h_test.go", src).symbols.find((x) => x.name === "TestList");
  assert.ok(s.calls.some((c) => c.name === "httptest.NewRequest"));
  assert.ok((s.urls || []).length >= 1, "the URL stays");
});

const CHAIN = ["package h", "func f() { NewThing().Do(); a.b().c() }", ""].join("\n");
function checkChain(rec) {
  const s = sym(rec, "f");
  for (const n of ["Do", "c"]) {
    const c = s.calls.find((x) => x.name === n || x.name.endsWith("." + n));
    assert.ok(c, `${n} is a call: ${JSON.stringify(s.calls)}`);
    assert.strictEqual(c.chain, true, `${n} is a chain`);
  }
}

test("heuristic: a Go call on a call result is a chain", () => {
  checkChain(heuristic("h.go", CHAIN));
});

test("borrowed: a Go call on a call result is a chain", (t) => {
  if (!hasGo()) return t.skip("no Go toolchain");
  checkChain(borrowed("h.go", CHAIN));
});

test("resolver: a method call on a local value is UNRESOLVED, not AMBIGUOUS", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-go-store-"));
  temps.push(d);
  const root = path.join(d, "proj");
  fs.mkdirSync(root, { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(root, "a.go"), 'package p\ntype A struct{}\nfunc (a *A) Error() string { return "" }\n');
  fs.writeFileSync(path.join(root, "b.go"), 'package p\ntype B struct{}\nfunc (b *B) Error() string { return "" }\nfunc use(x error) string { return x.Error() }\n');
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const claudeDir = path.join(root, ".claude", "lorc");
  G.graphUpdate(claudeDir, root, { enabled: true });
  const model = Q.loadModel(claudeDir, root, { noCache: true });
  const use = model.byFile["b.go"].symbols.find((s) => s.name === "use");
  const call = use.calls.find((c) => c.name === "x.Error");
  assert.ok(call, `x.Error is a call: ${JSON.stringify(use.calls)}`);
  assert.strictEqual(call.lv, true);
  assert.strictEqual(Q.resolveCall(model, "b.go", use, call).state, "UNRESOLVED");
});

test("C1: the Go parser binary is built once and found in the cache", (t) => {
  if (!hasGo()) return t.skip("no Go toolchain");
  const code = `const X = require(${JSON.stringify(EXTRACT)}); const g = X._findGo(); process.stdout.write(JSON.stringify(g));`;
  const env = { ...process.env };
  delete env.ORC_GRAPH_NO_BORROW;
  const r1 = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env, timeout: 180000 });
  const g1 = JSON.parse(r1.stdout);
  assert.ok(g1 && g1.bin, "the first run names a binary");
  assert.ok(fs.existsSync(g1.bin), "the binary exists after the first run");
  const r2 = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env, timeout: 180000 });
  const g2 = JSON.parse(r2.stdout);
  assert.strictEqual(g2.bin, g1.bin);
  assert.strictEqual(g2.dir, g1.dir);
  assert.ok(fs.existsSync(g2.bin));
});
