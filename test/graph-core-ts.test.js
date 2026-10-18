"use strict";
// lorc 0.5.0 (W32c): TypeScript declarations (interface, type, enum), abstract
// and arrow members, DI fields, member refs `X.k`, and test → component
// instance calls (`wrapper.vm.m()`). Each record check runs on BOTH rungs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const X = require("../bin/lib/graph/graph-extract.js");
const G = require("../bin/lib/graph/graph.js");
const Q = require("../bin/lib/graph/graph-query.js");

// A sandbox with node_modules/typescript (the borrowed walker rung).
const SBX = "C:/Users/joshu/AppData/Local/Temp/claude/C--dev-lorc/b99c0c9b-45a4-4c99-b678-8cb4794baad8/scratchpad/be-ts-ekyc";
const HAS_TS = fs.existsSync(SBX) && !!X._findTypeScript(SBX);
const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function noBorrow(fn) {
  const was = process.env.ORC_GRAPH_NO_BORROW;
  process.env.ORC_GRAPH_NO_BORROW = "1";
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.ORC_GRAPH_NO_BORROW;
    else process.env.ORC_GRAPH_NO_BORROW = was;
  }
}
const heuristic = (src) => noBorrow(() => X.extractOne({ rel: "a.ts", lang: "ts", src }));
function withBorrow(fn) {
  const was = process.env.ORC_GRAPH_NO_BORROW;
  delete process.env.ORC_GRAPH_NO_BORROW;
  try {
    return fn();
  } finally {
    if (was !== undefined) process.env.ORC_GRAPH_NO_BORROW = was;
  }
}
function walker(src) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-ts-w-"));
  temps.push(d);
  const abs = path.join(d, "a.ts");
  fs.writeFileSync(abs, src);
  const rec = withBorrow(() => X.extractBatch([{ rel: "a.ts", abs, lang: "ts", src }], { root: SBX }).get("a.ts"));
  assert.ok(/^typescript@/.test(rec.extractor), `borrowed rung: ${rec.extractor}`);
  return rec;
}
function both(name, src, check) {
  test(`${name} (heuristic)`, () => check(heuristic(src)));
  test(`${name} (borrowed)`, { skip: !HAS_TS && "no typescript in the sandbox" }, () => check(walker(src)));
}
const sym = (rec, qname) => rec.symbols.find((s) => s.qname === qname);

both("1. interface with bases and method members", "export interface Repo<T> extends Base {\n  find(id: string): T;\n  save?(x: T): void;\n  name: string;\n}\n", (rec) => {
  const i = sym(rec, "Repo");
  assert.ok(i && i.kind === "interface", JSON.stringify(rec.symbols));
  assert.deepStrictEqual(i.bases, ["Base"]);
  assert.deepStrictEqual(i.lines, [1, 5]);
  assert.strictEqual(sym(rec, "Repo.find").kind, "method");
  assert.strictEqual(sym(rec, "Repo.save").kind, "method");
  assert.strictEqual(sym(rec, "Repo.name"), undefined);
});

both("2. type aliases keep their lines", "export type Handler = (r: Req) => Promise<void>;\nexport type Opts = {\n  a: number;\n};\nconst z = 1;\n", (rec) => {
  const h = sym(rec, "Handler");
  assert.ok(h && h.kind === "type", JSON.stringify(rec.symbols));
  assert.deepStrictEqual(h.lines, [1, 1]);
  const o = sym(rec, "Opts");
  assert.ok(o && o.kind === "type");
  assert.deepStrictEqual(o.lines, [2, 4]);
});

both("3. enum, const enum, declare enum", "export enum DisputeType { A = 'a', B = 'b' }\nconst enum D { R }\ndeclare enum E { S }\n", (rec) => {
  for (const n of ["DisputeType", "D", "E"]) assert.strictEqual((sym(rec, n) || {}).kind, "enum", n);
  assert.strictEqual(sym(rec, "DisputeType.A"), undefined);
});

both("4. abstract class: abstract, arrow and static arrow members", "export abstract class F {\n  abstract g(): void;\n  h = () => 1;\n  static i = async (z) => {\n    return work(z);\n  };\n}\n", (rec) => {
  for (const q of ["F.g", "F.h", "F.i"]) assert.strictEqual((sym(rec, q) || {}).kind, "method", `${q}: ${JSON.stringify(rec.symbols.map((s) => s.qname))}`);
  assert.ok(sym(rec, "F.i").calls.some((c) => c.name === "work"), JSON.stringify(sym(rec, "F.i").calls));
});

both("5. DI: a constructor parameter property is a field alias", "class S {\n  constructor(private readonly svc: UserService) {}\n  run() {\n    return this.svc.find(1);\n  }\n}\n", (rec) => {
  const run = sym(rec, "S.run");
  const c = run.calls.find((x) => x.name === "UserService.find");
  assert.ok(c, JSON.stringify(run.calls));
  assert.strictEqual(c.alias, "svc");
});

function tempRepo(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-ts-"));
  temps.push(d);
  const root = path.join(d, "proj");
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  fs.mkdirSync(root, { recursive: true });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const claudeDir = path.join(root, ".claude", "lorc");
  noBorrow(() => G.graphUpdate(claudeDir, root, { enabled: true }));
  return Q.loadModel(claudeDir, root, { noCache: true });
}

test("6. resolver: ErrorCodes.A and Kind.X resolve IMPORT to the const / enum with member", () => {
  const model = tempRepo({
    "src/errors.ts": "export const ErrorCodes = { A: 'A' };\nexport enum Kind { X = 'x' }\n",
    "src/use.ts": "import { ErrorCodes, Kind } from './errors';\nexport function g() {\n  return f(ErrorCodes.A, Kind.X);\n}\n",
  });
  const g = model.byFile["src/use.ts"].symbols.find((s) => s.name === "g");
  for (const [name, target, member] of [["ErrorCodes.A", "ErrorCodes", "A"], ["Kind.X", "Kind", "X"]]) {
    const c = g.calls.find((x) => x.name === name && x.ref);
    assert.ok(c, `${name}: ${JSON.stringify(g.calls)}`);
    const r = Q.resolveCall(model, "src/use.ts", g, c);
    assert.strictEqual(r.state, "IMPORT", JSON.stringify(r));
    assert.strictEqual(r.target, `src/errors.ts#${target}`);
    assert.strictEqual(r.member, member);
  }
});

test("7. C12: test → component instance calls resolve IMPORT to the component member", () => {
  const model = tempRepo({
    "src/C.vue": "<template><div/></template>\n<script>\nexport default {\n  name: 'C',\n  methods: {\n    formatX(v) {\n      return v;\n    },\n    go() {\n      return 1;\n    },\n  },\n};\n</script>\n",
    "src/other.js": "export function go() {\n  return 2;\n}\n",
    "test/x.spec.js": "import C from '../src/C.vue';\nit('a', () => {\n  expect(createWrapper().vm.formatX('')).toBe('');\n  wrapper.vm.go();\n});\n",
  });
  const rec = model.byFile["test/x.spec.js"];
  const owner = rec.symbols.find((s) => s.calls.some((c) => c.inst));
  assert.ok(owner, JSON.stringify(rec.symbols));
  for (const m of ["formatX", "go"]) {
    const c = owner.calls.find((x) => x.name === m && x.inst);
    assert.ok(c && !c.chain && !c.lv, `${m}: ${JSON.stringify(owner.calls)}`);
    const r = Q.resolveCall(model, "test/x.spec.js", owner, c);
    assert.strictEqual(r.state, "IMPORT", JSON.stringify(r));
    assert.strictEqual(r.target, `src/C.vue#C.${m}`);
  }
});
