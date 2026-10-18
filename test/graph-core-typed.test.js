"use strict";
// lorc 0.5.0 (W32d): typed receivers. Struct and class field types, parameter
// types as local aliases, 3-part member chains, and hand-written `.d.ts` files.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const X = require("../bin/lib/graph/graph-extract.js");
const G = require("../bin/lib/graph/graph.js");
const Q = require("../bin/lib/graph/graph-query.js");

const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function rung(borrow, fn) {
  const was = process.env.ORC_GRAPH_NO_BORROW;
  if (borrow) delete process.env.ORC_GRAPH_NO_BORROW;
  else process.env.ORC_GRAPH_NO_BORROW = "1";
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.ORC_GRAPH_NO_BORROW;
    else process.env.ORC_GRAPH_NO_BORROW = was;
  }
}
const hasGo = () => rung(true, () => !!X._findGo());

// A temporary git repository with `files`, indexed with one rung.
function build(files, borrow) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-typed-"));
  temps.push(d);
  const root = path.join(d, "proj");
  fs.mkdirSync(root, { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), src);
  }
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const claudeDir = path.join(root, ".claude", "lorc");
  rung(borrow, () => G.graphUpdate(claudeDir, root, { enabled: true }));
  return Q.loadModel(claudeDir, root, { noCache: true });
}
const symOf = (model, rel, qname) => (model.byFile[rel].symbols || []).find((s) => s.qname === qname);
const targetOf = (model, r) => (r.target ? model.symbols.get(r.target) : null);

const GO = {
  "go.mod": "module example.com/app\n\ngo 1.21\n",
  "internal/routes/routes.go": [
    "package routes",
    "",
    "import (",
    '\t"github.com/gofiber/fiber/v2"',
    '\t"example.com/app/internal/handlers"',
    ")",
    "",
    "func Setup(app *fiber.App, h *handlers.Handlers) {",
    '\tapp.Get("/jobs", h.Discovery.List)',
    '\tapp.Get("/", handlers.HomeHandler)',
    "}",
    "",
  ].join("\n"),
  "internal/handlers/handlers.go": ["package handlers", "", "type Handlers struct {", "\tDiscovery *DiscoveryHandler", "\tAuth      AuthHandler", "\tNames     []string", "\tCount     int", "}", "", "type AuthHandler struct{}", ""].join("\n"),
  "internal/handlers/discovery.go": [
    "package handlers",
    "",
    'import "github.com/gofiber/fiber/v2"',
    "",
    "type DiscoveryHandler struct{}",
    "",
    "func (h *DiscoveryHandler) List(c *fiber.Ctx) error { return nil }",
    "",
  ].join("\n"),
  "internal/handlers/home.go": ['package handlers', "", 'import "github.com/gofiber/fiber/v2"', "", "func HomeHandler(c *fiber.Ctx) error { return nil }", ""].join("\n"),
  "store/store.go": ["package store", "", "type Store struct{}", "", "func (s *Store) Save() {}", ""].join("\n"),
  "use/use.go": ['package use', "", 'import "example.com/app/store"', "", "func Use(s *store.Store) {", "\ts.Save()", "}", ""].join("\n"),
};

function checkGo(model) {
  const hs = symOf(model, "internal/handlers/handlers.go", "Handlers");
  assert.deepStrictEqual(hs.fields, { Discovery: "DiscoveryHandler", Auth: "AuthHandler" });
  const routes = [...model.symbols.values()].filter((s) => s.kind === "route");
  const resolved = (name) => {
    const r = routes.find((s) => s.name === name);
    assert.ok(r, `routes: ${routes.map((s) => s.name).join(", ")}`);
    return (r.calls || []).filter((c) => c.ref).map((c) => ({ c, res: Q.resolveCall(model, r.file, r, c) }));
  };
  const jobs = resolved("GET /jobs").find((x) => x.res.state === "IMPORT");
  assert.ok(jobs, `GET /jobs refs: ${JSON.stringify(resolved("GET /jobs"))}`);
  assert.strictEqual(targetOf(model, jobs.res).qname, "DiscoveryHandler.List");
  assert.strictEqual(jobs.res.via_field, "Discovery");
  const home = resolved("GET /").find((x) => x.res.state === "IMPORT" || x.res.state === "LOCAL");
  assert.ok(home, `GET / refs: ${JSON.stringify(resolved("GET /"))}`);
  assert.strictEqual(targetOf(model, home.res).qname, "HomeHandler");
  // A parameter type is a local alias: `s.Save` → `Store.Save`.
  const use = symOf(model, "use/use.go", "Use");
  const save = use.calls.find((c) => c.name === "Store.Save");
  assert.ok(save && save.alias === "s" && !save.lv, `Use calls: ${JSON.stringify(use.calls)}`);
  const rs = Q.resolveCall(model, "use/use.go", use, save);
  assert.strictEqual(rs.state, "IMPORT");
  assert.strictEqual(targetOf(model, rs).qname, "Store.Save");
}

test("Go (heuristic): struct fields, a parameter alias and a 3-part route handler resolve", () => {
  checkGo(build(GO, false));
});

test("Go (borrowed AST): struct fields, a parameter alias and a 3-part route handler resolve", { skip: !hasGo() && "no Go toolchain" }, () => {
  const model = build(GO, true);
  assert.ok(/^go-ast@/.test(model.byFile["store/store.go"].extractor || "go-ast@"), "the borrowed rung ran");
  checkGo(model);
});

const TS = {
  "src/repo.ts": "export class UserRepo { find(id: string) { return id; } }\n",
  "src/svc.ts": "import { UserRepo } from './repo';\nexport class Svc {\n  constructor(private readonly repo: UserRepo) {}\n  get(id) { return this.repo.find(id); }\n}\n",
  "src/ctl.ts": "import { Svc } from './svc';\nexport class Ctl {\n  constructor(private svc: Svc) {}\n  run() { return this.svc.repo.find('1'); }\n}\n",
  "src/fn.ts": "import { UserRepo } from './repo';\nexport function load(repo: UserRepo, n: number) {\n  return repo.find('2');\n}\n",
};

function checkTs(model) {
  assert.deepStrictEqual(symOf(model, "src/svc.ts", "Svc").fields, { repo: "UserRepo" });
  assert.deepStrictEqual(symOf(model, "src/ctl.ts", "Ctl").fields, { svc: "Svc" });
  const get = symOf(model, "src/svc.ts", "Svc.get");
  const c1 = get.calls.find((c) => c.name === "UserRepo.find");
  assert.ok(c1, `Svc.get calls: ${JSON.stringify(get.calls)}`);
  const r1 = Q.resolveCall(model, "src/svc.ts", get, c1);
  assert.strictEqual(r1.state, "IMPORT");
  assert.strictEqual(targetOf(model, r1).qname, "UserRepo.find");
  const run = symOf(model, "src/ctl.ts", "Ctl.run");
  const c2 = run.calls.find((c) => c.name === "Svc.repo.find");
  assert.ok(c2 && c2.alias === "svc", `Ctl.run calls: ${JSON.stringify(run.calls)}`);
  const r2 = Q.resolveCall(model, "src/ctl.ts", run, c2);
  assert.strictEqual(r2.state, "IMPORT");
  assert.strictEqual(targetOf(model, r2).qname, "UserRepo.find");
  assert.strictEqual(r2.via_field, "repo");
  // A typed function parameter is a local alias.
  const load = symOf(model, "src/fn.ts", "load");
  const c3 = load.calls.find((c) => c.name === "UserRepo.find");
  assert.ok(c3 && c3.alias === "repo" && !c3.lv, `load calls: ${JSON.stringify(load.calls)}`);
  assert.strictEqual(Q.resolveCall(model, "src/fn.ts", load, c3).state, "IMPORT");
}

test("TS (heuristic): class fields, this.svc.repo.find and a parameter alias resolve", () => {
  checkTs(build(TS, false));
});

// A sandbox with node_modules/typescript (the borrowed walker rung).
const SBX = "C:/Users/joshu/AppData/Local/Temp/claude/C--dev-lorc/b99c0c9b-45a4-4c99-b678-8cb4794baad8/scratchpad/be-ts-ekyc";
const HAS_TS = fs.existsSync(SBX) && !!X._findTypeScript(SBX);
test("TS (walker): the same fields and renamed calls", { skip: !HAS_TS && "no typescript in the sandbox" }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-typed-w-"));
  temps.push(d);
  const items = Object.entries(TS).map(([rel, src]) => {
    const abs = path.join(d, path.basename(rel));
    fs.writeFileSync(abs, src);
    return { rel, abs, lang: "ts", src };
  });
  const out = rung(true, () => X.extractBatch(items, { root: SBX }));
  const rec = (rel) => out.get(rel);
  assert.ok(/^typescript@/.test(rec("src/ctl.ts").extractor), rec("src/ctl.ts").extractor);
  const s = (rel, q) => rec(rel).symbols.find((x) => x.qname === q);
  assert.deepStrictEqual(s("src/svc.ts", "Svc").fields, { repo: "UserRepo" });
  assert.ok(s("src/svc.ts", "Svc.get").calls.some((c) => c.name === "UserRepo.find"));
  assert.ok(s("src/ctl.ts", "Ctl.run").calls.some((c) => c.name === "Svc.repo.find" && c.alias === "svc"));
  assert.ok(s("src/fn.ts", "load").calls.some((c) => c.name === "UserRepo.find" && c.alias === "repo" && !c.lv));
});

test("extract: a 3-part name on an untyped head stays as is", () => {
  const rec = rung(false, () => X.extractOne({ rel: "a.go", lang: "go", src: "package a\n\nfunc F(x int) {\n\tq.A.B()\n}\n" }, null));
  const f = rec.symbols.find((s) => s.qname === "F");
  assert.ok(f.calls.some((c) => c.name === "q.A.B" && !c.alias), JSON.stringify(f.calls));
});

test("C13: a hand-written .d.ts is indexed; a .d.ts beside its module is not", () => {
  const model = build(
    {
      "src/types/api.d.ts": "export interface ApiUser { id: string }\nexport interface ApiJob { id: string }\n",
      "src/a.ts": "export function a() { return 1; }\n",
      "src/a.d.ts": "export declare function a(): number;\n",
      "lib/x.d.ts": "export interface Gen { id: string }\n",
    },
    false,
  );
  assert.ok(model.byFile["src/types/api.d.ts"], Object.keys(model.byFile).join(", "));
  assert.ok(model.byFile["src/types/api.d.ts"].symbols.some((s) => s.name === "ApiUser"));
  assert.ok(!model.byFile["src/a.d.ts"]);
  assert.ok(!model.byFile["lib/x.d.ts"]);
  assert.ok(model.byFile["src/a.ts"]);
});

// lorc 0.5.0 (W34c): a call through an interface reaches the class that
// implements it. A self call in a route of a constructor uses its class.
const cardOf = (model, q) => Q.ctx(model, q, { budget: 8000 });
const ACC = {
  "src/controllers/account.ts": [
    "import { Router } from \"express\";",
    "export interface IAccountService {",
    "  inquiryAccount(req: any): Promise<any>;",
    "  closeAccount(req: any): Promise<any>;",
    "}",
    "export class AccountController {",
    "  private accountService: IAccountService;",
    "  router: Router;",
    "  constructor(accountService: IAccountService) {",
    "    this.accountService = accountService;",
    "    this.router = Router();",
    "    this.router.get(\"/\", this.inquiryAccount.bind(this));",
    "  }",
    "  async inquiryAccount(req: any, res: any) {",
    "    const out = await this.accountService.inquiryAccount(req);",
    "    res.json(out);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/services/account.ts": [
    "import { IAccountService } from \"../controllers/account\";",
    "export class AccountService implements IAccountService {",
    "  async inquiryAccount(req: any) {",
    "    return { id: req.id };",
    "  }",
    "  async closeAccount(req: any) {",
    "    return { id: req.id };",
    "  }",
    "}",
    "",
  ].join("\n"),
};

test("W34c: interface dispatch and a self call in a constructor route (bss-gate shape)", () => {
  const model = build(ACC, false);
  const ctl = cardOf(model, "AccountController.inquiryAccount");
  assert.ok(ctl.ok, JSON.stringify(ctl));
  assert.ok(/← used by\s+GET \//.test(ctl.card), ctl.card);
  assert.ok(/⇒ impl\s+AccountService\.inquiryAccount\s+src\/services\/account\.ts:3/.test(ctl.card), ctl.card);
  const svc = cardOf(model, "AccountService.inquiryAccount");
  assert.ok(/← called by\s+AccountController\.inquiryAccount .*IMPORT.*\(impl of IAccountService\)/.test(svc.card), svc.card);
});

test("W34c: two implementers both get a caller row; the callee shows two impl rows", () => {
  const files = {
    ...ACC,
    "src/services/mock.ts": [
      "import { IAccountService } from \"../controllers/account\";",
      "export class MockAccountService implements IAccountService {",
      "  async inquiryAccount(req: any) {",
      "    return null;",
      "  }",
      "  async closeAccount(req: any) {",
      "    return null;",
      "  }",
      "}",
      "",
    ].join("\n"),
  };
  const model = build(files, false);
  for (const q of ["AccountService.inquiryAccount", "MockAccountService.inquiryAccount"]) {
    const c = cardOf(model, q);
    assert.ok(/← called by\s+AccountController\.inquiryAccount .*\(impl of IAccountService\)/.test(c.card), c.card);
  }
  const ctl = cardOf(model, "AccountController.inquiryAccount");
  assert.strictEqual((ctl.card.match(/⇒ impl/g) || []).length, 2, ctl.card);
});

test("W34c: an abstract member reaches the subclass member", () => {
  const model = build(
    {
      "src/repo.ts": [
        "export abstract class Repo {",
        "  abstract find(id: string): any;",
        "}",
        "export class UserRepo extends Repo {",
        "  find(id: string) {",
        "    return { id };",
        "  }",
        "}",
        "",
      ].join("\n"),
      "src/svc.ts": [
        "import { Repo } from \"./repo\";",
        "export class Svc {",
        "  repo: Repo;",
        "  get(id: string) {",
        "    return this.repo.find(id);",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    false,
  );
  const c = cardOf(model, "UserRepo.find");
  assert.ok(/← called by\s+Svc\.get .*\(impl of Repo\)/.test(c.card), c.card);
});

test("W34c: a plain class call has no impl row; the cache gives the same rows as the walk", () => {
  const model = build(
    {
      ...ACC,
      "src/plain.ts": "export class Plain {\n  a() {\n    return this.b();\n  }\n  b() {\n    return 1;\n  }\n}\n",
    },
    false,
  );
  const b = symOf(model, "src/plain.ts", "Plain.b");
  const walk = Q.callersOf(model, b).confident.map((c) => [c.sym.qname, c.state, !!c.impl]);
  assert.deepStrictEqual(walk, [["Plain.a", "LOCAL", false]]);
  const R = require("../bin/lib/graph/graph-resolve.js");
  const { callers } = R.computeCallers(model);
  const impl = symOf(model, "src/services/account.ts", "AccountService.inquiryAccount");
  const rows = callers[impl.id] || [];
  assert.ok(rows.some((r) => r[3] === 8 && r[4] === "IAccountService" && r[2] === "IMPORT"), JSON.stringify(rows));
  const onRead = Q.callersOf(model, impl).confident.map((c) => [c.sym.id, c.line, c.state, c.impl]);
  const cached = rows.map((r) => [r[0], r[1], r[2], r[4]]);
  assert.deepStrictEqual(onRead.sort(), cached.sort());
});
