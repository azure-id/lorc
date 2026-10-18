"use strict";
// lorc 0.5.0 (W28g): class-based Express routes, `x.getRouter()` mounts, and two
// alias fixes (an external alias type, a TS parameter alias only from a parameter list).
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

// A temporary git repository with `files`, indexed with the heuristic rung.
function build(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-routes-"));
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
  rung(false, () => G.graphUpdate(claudeDir, root, { enabled: true }));
  return Q.loadModel(claudeDir, root, { noCache: true });
}
const symOf = (model, rel, qname) => (model.byFile[rel].symbols || []).find((s) => s.qname === qname);
const targetOf = (model, r) => (r.target ? model.symbols.get(r.target) : null);

const ACCOUNT = [
  "import { Router } from 'express';",
  "export class AccountController {",
  "  private router: Router;",
  "  private bankRouter: Router;",
  "  constructor(private svc: Svc) {",
  "    this.router = Router();",
  '    this.router.get("/", this.inquiry.bind(this));',
  '    this.router.post("/balance", (req, res) => this.balance(req, res));',
  "    this.bankRouter = Router();",
  '    this.bankRouter.post("/", validateSchema(s), this.bank.bind(this));',
  '    this.router.use("/statements", this.bankRouter);',
  "    this.router.post('/pin', validateSchema(x), this.change.bind(this));",
  "  }",
  "  getRouter(): Router { return this.router; }",
  "  inquiry(req, res) {}",
  "  balance(req, res) {}",
  "  bank(req, res) {}",
  "  change(req, res) {}",
  "}",
  "function validateSchema(s) { return s; }",
  "",
].join("\n");
const APP = [
  "import express from 'express';",
  "import { AccountController } from './controllers/account';",
  "const app = express();",
  "const accountController = new AccountController(svc);",
  "app.use('/account', accountController.getRouter());",
  "",
].join("\n");

test("class controller: routes, the handler ref, middleware and the mount prefix", () => {
  const model = build({ "src/controllers/account.ts": ACCOUNT, "src/app.ts": APP });
  const rel = "src/controllers/account.ts";
  for (const q of ["GET /", "POST /balance", "POST /", "POST /pin"]) assert.ok(symOf(model, rel, q), `route ${q} exists`);
  const get = symOf(model, rel, "GET /");
  const ref = get.calls.find((c) => c.ref && c.name === "inquiry");
  assert.ok(ref, "GET / has a ref inquiry");
  const r = Q.resolveCall(model, rel, get, ref);
  assert.strictEqual(r.state, "LOCAL");
  assert.strictEqual(targetOf(model, r).qname, "AccountController.inquiry");

  const pin = symOf(model, rel, "POST /pin");
  assert.ok(pin.calls.some((c) => !c.ref && c.name === "validateSchema"), "validateSchema is a call of the route");

  const full = Q.routeTable(model).filter((row) => row.sym.file === rel).map((row) => `${row.method} ${row.full}`);
  for (const want of ["GET /account", "POST /account/balance", "POST /account/statements", "POST /account/pin"]) assert.ok(full.includes(want), `${want} in ${full.join(", ")}`);
});

test("a mount through a getter reaches only the routes on the router it returns", () => {
  const ctl = [
    "import { Router } from 'express';",
    "export class StatementController {",
    "  private router = Router();",
    "  private listRouter = Router();",
    "  constructor() {",
    "    this.router.post('/', this.one.bind(this));",
    "    this.listRouter.post('/', this.list.bind(this));",
    "  }",
    "  getRouter(): Router { return this.router; }",
    "  getListRouter(): Router { return this.listRouter; }",
    "  one(req, res) {}",
    "  list(req, res) {}",
    "}",
    "",
  ].join("\n");
  const app = [
    "import express from 'express';",
    "import { StatementController } from './statement';",
    "const app = express();",
    "const statementController = new StatementController();",
    "app.use('/bank-statement', statementController.getRouter());",
    "app.use('/history', statementController.getListRouter());",
    "",
  ].join("\n");
  const model = build({ "src/statement.ts": ctl, "src/app.ts": app });
  const full = Q.routeTable(model).map((row) => `${row.method} ${row.full}`).sort();
  assert.deepStrictEqual(full, ["POST /bank-statement", "POST /history"]);
});

test("R1: a Go parameter type from an external package is not the repo type", () => {
  const model = build({
    "go.mod": "module example.com/app\n\ngo 1.21\n",
    "ctx.go": "package app\n\ntype Ctx struct{}\n\nfunc (c *Ctx) JSON(v int) error { return nil }\n",
    "h.go": 'package app\n\nimport "github.com/gofiber/fiber/v2"\n\nfunc h(c *fiber.Ctx) error { return c.JSON(1) }\n',
  });
  const h = symOf(model, "h.go", "h");
  const call = h.calls.find((c) => /JSON$/.test(c.name));
  assert.ok(call, "c.JSON is a call");
  assert.strictEqual(call.ext, "github.com/gofiber/fiber/v2");
  const r = Q.resolveCall(model, "h.go", h, call);
  assert.strictEqual(r.state, "UNRESOLVED");
  assert.strictEqual(r.external, "github.com/gofiber/fiber/v2");
});

test("R2: an object literal pair is not a TS parameter alias", () => {
  const src = "function f() { const o = { a: 1, status: Status }; return status.go(); }\nfunction g(status: Status) { return status.go(); }\n";
  const rec = rung(false, () => X.extractOne({ rel: "a.ts", lang: "ts", src }, null));
  const f = rec.symbols.find((s) => s.qname === "f");
  assert.ok(f.calls.some((c) => c.name === "status.go" && !c.alias), "status.go stays as written in f");
  const g = rec.symbols.find((s) => s.qname === "g");
  assert.ok(g.calls.some((c) => c.name === "Status.go" && c.alias === "status"), "a parameter is still an alias");
});

// ── lorc 0.5.0 (W34b): typed registrations, Go route groups, autoload mounts ──
// A temporary git repository like `build`, indexed with the rung that `borrow` names.
function buildRung(files, borrow) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-core-routes-"));
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
const fullRoutes = (model) => Q.routeTable(model).map((row) => `${row.method} ${row.full}`);

for (const borrow of [false, true]) {
  for (const twoLines of [false, true]) {
    test(`W34b: a typed registration is a route, not a URL (borrow ${borrow}, two lines ${twoLines})`, () => {
      const typed = twoLines ? "fastify.get<{\n    Querystring: Param\n  }>('/schedule', async (_r, reply) => {" : "fastify.get<{ Querystring: Param }>('/schedule', async (_r, reply) => {";
      const model = buildRung({
        "src/routes/sdk/schedule.ts": "export default async function (fastify) {\n  fastify.get('/schedule', { preHandler: x }, async (_r, reply) => {\n    return reply.send(1);\n  });\n}\n",
        "src/routes/test/schedule.ts": `type Param = { a: string };\nexport default async function (fastify) {\n  ${typed}\n    return reply.send(2);\n  });\n}\n`,
      }, borrow);
      const sdk = symOf(model, "src/routes/sdk/schedule.ts", "GET /schedule");
      assert.ok(sdk, "sdk route exists");
      assert.ok(symOf(model, "src/routes/test/schedule.ts", "GET /schedule"), "typed route exists");
      for (const s of model.byFile["src/routes/test/schedule.ts"].symbols || []) assert.ok(!(s.urls && s.urls.length), `${s.qname} has no urls`);
      const rows = Q.callersOf(model, sdk).confident.filter((r) => r.state === "ROUTE" && r.sym.file === "src/routes/test/schedule.ts");
      assert.strictEqual(rows.length, 0);
    });
  }
  test(`W34b: nested type arguments (borrow ${borrow})`, () => {
    const model = buildRung({ "src/items.ts": "type Item = { a: number };\nexport default async function (fastify) {\n  fastify.post<{ Body: Array<Item>; Headers: H }>('/items', async () => {});\n}\n" }, borrow);
    assert.ok(symOf(model, "src/items.ts", "POST /items"), "POST /items exists");
  });
}

const GO_ROUTES = [
  "package routes",
  "",
  'import "github.com/gofiber/fiber/v2"',
  "",
  "func Setup(app *fiber.App, h *Handlers, mw fiber.Handler) {",
  '\tapp.Get("/home", h.Home)',
  '\tapi := app.Group("/api")',
  '\tv1 := api.Group("/v1", mw)',
  '\tv1.Get("/jobs", h.Jobs)',
  '\tauth := app.Group("/auth")',
  '\tauth.Post("/register", h.Register)',
  "}",
  "",
].join("\n");
for (const borrow of [false, true]) {
  test(`W34b: Go route groups carry their prefix (borrow ${borrow})`, () => {
    const model = buildRung({ "go.mod": "module example.com/app\n\ngo 1.21\n", "routes/routes.go": GO_ROUTES }, borrow);
    const names = (model.byFile["routes/routes.go"].symbols || []).map((s) => s.qname);
    for (const want of ["GET /api/v1/jobs", "GET /home", "POST /auth/register"]) assert.ok(names.includes(want), `${want} in ${names.join(", ")}`);
    for (const s of model.byFile["routes/routes.go"].symbols || []) for (const mt of s.mounts || []) assert.notStrictEqual(mt.target, "mw");
  });
}

function autoloadFiles(extra) {
  return {
    "src/server.ts": [
      "import Fastify from 'fastify';",
      "import path from 'path';",
      "import autoload from '@fastify/autoload';",
      "const fastify = Fastify();",
      `fastify.register(autoload, { dir: path.join(__dirname, 'routes'), ${extra}options: { prefix: '/api' } });`,
      "export default fastify;",
      "",
    ].join("\n"),
    "src/index.ts": "import Fastify from 'fastify';\nimport server from './server';\nconst fastify = Fastify();\nfastify.register(server);\n",
    "src/routes/health.ts": "export default async function (fastify) {\n  fastify.get('/health', async () => ({ ok: true }));\n}\n",
    "src/routes/sdk/bookings/reset.ts": "export default async function (fastify) {\n  fastify.post('/reset', async () => ({}));\n}\n",
    "src/routes/users/_id/get.ts": "export default async function (fastify) {\n  fastify.get('/', async () => ({}));\n}\n",
  };
}
for (const borrow of [false, true]) {
test(`W34b: an autoload mount gives every file under its folder a prefix (borrow ${borrow})`, () => {
  const model = buildRung(autoloadFiles(""), borrow);
  const rows = Q.routeTable(model);
  for (const want of ["GET /api/health", "POST /api/sdk/bookings/reset", "GET /api/users/:id"]) {
    const row = rows.find((r) => `${r.method} ${r.full}` === want);
    assert.ok(row, `${want} in ${fullRoutes(model).join(", ")}`);
    assert.strictEqual(row.mounted, "known");
  }
});
test(`W34b: an autoload mount with dirNameRoutePrefix false adds no folders (borrow ${borrow})`, () => {
  const model = buildRung(autoloadFiles("dirNameRoutePrefix: false, "), borrow);
  assert.ok(fullRoutes(model).includes("POST /api/reset"), fullRoutes(model).join(", "));
});
}
test("W34b: a plain register with a prefix mounts an imported plugin", () => {
  const plugin = "export default async function (app) {\n  app.get('/list', async () => []);\n}\n";
  const model = build({
    "src/routes/users.ts": plugin,
    "src/routes/orders.ts": plugin.replace("/list", "/all"),
    "src/app.ts": "import Fastify from 'fastify';\nimport usersRoutes from './routes/users';\nconst app = Fastify();\napp.register(usersRoutes, { prefix: '/users' });\napp.register(import('./routes/orders'), { prefix: '/orders' });\n",
  });
  const full = fullRoutes(model);
  assert.ok(full.includes("GET /users/list"), full.join(", "));
  assert.ok(full.includes("GET /orders/all"), full.join(", "));
});
