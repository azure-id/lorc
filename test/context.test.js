"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const C = require("../bin/lib/context.js");

const LORC = path.join(__dirname, "..", "bin", "lorc.js");
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function put(root, rel, text) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

function fixture(withGraph) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-ctx-"));
  dirs.push(base);
  const root = path.join(base, "proj");
  put(root, "package.json", JSON.stringify({ name: "fx", version: "1.0.0" }));
  put(root, "src/router/index.js", [
    "import PayList from '../views/pay/PayList.vue';",
    "import CreateOrderFlow from '../views/shop/CreateOrderFlow.vue';",
    "import Home from '../views/Home.vue';",
    "",
    "export const routes = [",
    "  {",
    "    path: '/home',",
    "    name: 'Home',",
    "    component: Home,",
    "  },",
    "  {",
    "    path: '/pay',",
    "    component: PayList,",
    "    children: [",
    "      {",
    "        path: 'list',",
    "        name: 'PayList',",
    "        component: PayList,",
    "      },",
    "      {",
    "        path: 'order',",
    "        name: 'CreateOrder',",
    "        component: CreateOrderFlow,",
    "      },",
    "    ],",
    "  },",
    "];",
    "",
  ].join("\n"));
  put(root, "src/views/Home.vue", "<template><div>home</div></template>\n<script>\nexport default { name: 'Home' };\n</script>\n");
  put(root, "src/api/pay.api.js", [
    "import http from './http.js';",
    "",
    "const PAY_LIST_URL = '/api/pay/list';",
    "const PAY_SEND_URL = '/api/pay/send';",
    "",
    "export function getPayList() {",
    "  return http.get(PAY_LIST_URL);",
    "}",
    "",
    "export function sendPay(body) {",
    "  return http.post(PAY_SEND_URL, body);",
    "}",
    "",
  ].join("\n"));
  put(root, "src/api/http.js", "export default { get() {}, post() {} };\n");
  put(root, "src/views/pay/constants/payRoutes.js", "export const PAY_ROUTES = {\n  LIST: 'PayList',\n  CREATE: 'TransferFund',\n};\n");
  put(root, "src/views/pay/PayList.vue", [
    "<template>",
    "  <button @click=\"onTransferFund\">Transfer Fund</button>",
    "</template>",
    "<script>",
    "import { PAY_ROUTES } from './constants/payRoutes.js';",
    "export default {",
    "  name: 'PayList',",
    "  methods: {",
    "    onTransferFund() {",
    "      this.$router.push({ name: PAY_ROUTES.CREATE });",
    "    },",
    "  },",
    "};",
    "</script>",
    "",
  ].join("\n"));
  put(root, "src/views/shop/CreateOrder.vue", [
    "<template>",
    "  <div class=\"swap-modal__amount-box\">",
    "    <button @click=\"submit\">Go</button>",
    "  </div>",
    "</template>",
    "<script>",
    "import { getPayList } from '../../api/pay.api.js';",
    "export default {",
    "  name: 'CreateOrder',",
    "  props: {",
    "    amount: { type: Number, default: 0 },",
    "  },",
    "  methods: {",
    "    submit() {",
    "      this.$emit('done', this.amount);",
    "    },",
    "    load() {",
    "      return getPayList();",
    "    },",
    "  },",
    "};",
    "</script>",
    "",
  ].join("\n"));
  put(root, "src/views/shop/CreateOrderFlow.vue", [
    "<template>",
    "  <CreateOrder @done=\"next\" />",
    "</template>",
    "<script>",
    "import CreateOrder from './CreateOrder.vue';",
    "export default {",
    "  name: 'CreateOrderFlow',",
    "  components: { CreateOrder },",
    "  methods: {",
    "    next() {},",
    "  },",
    "};",
    "</script>",
    "",
  ].join("\n"));
  put(root, "tests/unit/CreateOrderJourney.spec.js", [
    "import { mount } from '@vue/test-utils';",
    "import CreateOrder from '../../src/views/shop/CreateOrder.vue';",
    "",
    "const render = () => mount(CreateOrder);",
    "",
    "describe('CreateOrder journey', () => {",
    "  it('emits done', () => {",
    "    render();",
    "  });",
    "});",
    "",
  ].join("\n"));
  put(root, "static/i18n/en.json", [
    "{",
    "  \"HOME\": {",
    "    \"TITLE\": \"Home\"",
    "  },",
    "  \"PAY\": {",
    "    \"TITLE\": \"Transfer Fund\",",
    "    \"SEND\": \"Send\"",
    "  }",
    "}",
    "",
  ].join("\n"));
  put(root, "src/styles/_swap.scss", [
    ".swap-modal {",
    "  display: flex;",
    "  &__amount-box {",
    "    color: red;",
    "  }",
    "  &__divider {",
    "    margin: 0;",
    "    &--active {",
    "      color: blue;",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n"));
  put(root, "req.md", [
    "# Pay rate",
    "",
    "Register the rate call in pay.api.js: POST /api/pay/rate.",
    "The box uses the swap-modal__amount-box style and the swap-modal__divider--active line.",
    "Copy the create order component for the form.",
    "",
  ].join("\n"));
  const git = (...a) => cp.execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  if (withGraph) {
    cp.execFileSync(process.execPath, [LORC, "graph", "update", "--dir", root], { cwd: root, stdio: "ignore", env: Object.assign({}, process.env, { HOME: base, USERPROFILE: base }) });
  }
  return root;
}

const REQ = "Add the pay transfer fund step with a rate call";

test("context pack: targets, exemplars, tests, style, size", () => {
  const root = fixture(true);
  const pack = C.build(root, REQ, { doc: "req.md" });
  assert.strictEqual(pack.v, 1);
  const T = pack.targets;
  const route = T.find((t) => t.kind === "route" && /^\/pay ·/.test(t.what));
  assert.ok(route, "router row for the parent with children: " + JSON.stringify(T));
  assert.strictEqual(route.file, "src/router/index.js");
  assert.ok(T.some((t) => t.kind === "insert" && /new child route goes near src\/router\/index\.js:\d+ \(siblings of \/pay\)/.test(t.what)));
  const api = T.find((t) => t.kind === "insert" && t.file === "src/api/pay.api.js");
  assert.ok(api && /append after line 12 \(after sendPay\)/.test(api.what), JSON.stringify(api));
  const i18n = T.find((t) => t.kind === "i18n" && t.file === "static/i18n/en.json");
  assert.ok(i18n && i18n.start === 5 && /^PAY keys: TITLE · 6/.test(i18n.what), JSON.stringify(i18n));
  const cta = T.find((t) => t.kind === "entry" && t.file === "src/views/pay/PayList.vue");
  assert.ok(cta && /line 10/.test(cta.what), JSON.stringify(T));
  const ex = pack.exemplars.find((e) => e.file === "src/views/shop/CreateOrder.vue");
  assert.ok(ex, "exemplar CreateOrder.vue: " + JSON.stringify(pack.exemplars));
  assert.match(ex.what, /props: amount 11/);
  assert.match(ex.what, /emits: done 15/);
  const t = pack.tests.find((x) => x.file === "tests/unit/CreateOrderJourney.spec.js");
  assert.ok(t && t.start === 1 && t.end === 5 && /first describe 6/.test(t.what), JSON.stringify(pack.tests));
  const cls = pack.entities.find((e) => e.name === "swap-modal__amount-box");
  assert.ok(cls && cls.at.includes("src/styles/_swap.scss:3-5"), JSON.stringify(cls));
  const merged = pack.text.split(/\n/).find((l) => l.startsWith("- src/styles/_swap.scss:"));
  assert.strictEqual(merged, "- src/styles/_swap.scss:3-10 — style rules for 2 doc classes: __amount-box 3-5, __divider--active 8-10 (doc classes)");
  assert.ok(pack.bytes <= 8192 && Buffer.byteLength(pack.text) === pack.bytes);
  assert.match(pack.text, /^# Context — /);
  assert.match(pack.text, /Read only these ranges \(Read offset\/limit\)\. Do not cat whole files\.\n$/);
  const small = C.build(root, REQ, { doc: "req.md", maxBytes: 1200 });
  assert.ok(small.bytes <= 1200, String(small.bytes));
  const out = path.join(root, ".claude", "lorc", "runs", "r1");
  const w = C.write(out, pack);
  assert.ok(fs.existsSync(w.md) && fs.existsSync(w.json));
  assert.strictEqual(fs.readFileSync(w.md, "utf8"), pack.text);
  assert.strictEqual(JSON.parse(fs.readFileSync(w.json, "utf8")).text, undefined);
});

test("context pack without a graph store: entities from git grep, no throw", () => {
  const root = fixture(false);
  let pack;
  assert.doesNotThrow(() => { pack = C.build(root, REQ, { doc: "req.md", loaded: null, engine: null }); });
  assert.ok(pack.entities.some((e) => e.name === "pay.api.js" && e.at.length) || pack.targets.some((t) => t.file === "src/api/pay.api.js"));
  const cls = pack.entities.find((e) => e.name === "swap-modal__amount-box");
  assert.ok(cls && cls.at.includes("src/styles/_swap.scss:3-5"), JSON.stringify(cls));
  assert.strictEqual(pack.graph, false);
});

test("entities: identifiers, classes, urls, files, phrases, noun phrases", () => {
  const e = C.entitiesOf("Use CreateOrder and TRANSFER_FUND with `fooBar` on \"Transfer Fund\"", "Call POST /api/pay/rate in pay.api.js; style swap-modal__amount-box. Copy the create order component.");
  const has = (n, t) => e.some((x) => x.name === n && x.type === t);
  assert.ok(has("CreateOrder", "symbol"));
  assert.ok(has("TRANSFER_FUND", "symbol"));
  assert.ok(has("fooBar", "symbol"));
  assert.ok(has("Transfer Fund", "phrase"));
  assert.ok(has("/api/pay/rate", "url"));
  assert.ok(has("pay.api.js", "file"));
  assert.ok(has("swap-modal__amount-box", "class"));
  assert.ok(e.some((x) => x.name === "create order" && x.type === "noun" && x.cue));
});

// lorc 0.5.0 (W30b): framework links in the cards; no env value in the pack.
function linksFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-ctxl-"));
  dirs.push(base);
  const root = path.join(base, "proj");
  put(root, "package.json", JSON.stringify({ name: "fx", version: "1.0.0" }));
  put(root, "src/store/modules/login.js", [
    "export default {",
    "  namespaced: false,",
    "  state: { token: '' },",
    "  mutations: {",
    "    setToken(state, t) {",
    "      state.token = t;",
    "    },",
    "  },",
    "};",
    "",
  ].join("\n"));
  put(root, "src/A.vue", [
    "<template>",
    "  <div @click=\"save\">a</div>",
    "</template>",
    "<script>",
    "export default {",
    "  name: 'A',",
    "  methods: {",
    "    save() {",
    "      this.$store.commit('setToken', 'x');",
    "    },",
    "  },",
    "};",
    "</script>",
    "",
  ].join("\n"));
  put(root, "src/B.vue", [
    "<template>",
    "  <A />",
    "</template>",
    "<script>",
    "import A from './A.vue';",
    "export default {",
    "  name: 'B',",
    "  components: { A },",
    "};",
    "</script>",
    "",
  ].join("\n"));
  put(root, ".env", "TOKEN=supersecret\n");
  put(root, "src/api/client.js", [
    "export function token() {",
    "  return process.env.TOKEN;",
    "}",
    "",
  ].join("\n"));
  const git = (...a) => cp.execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  cp.execFileSync(process.execPath, [LORC, "graph", "update", "--dir", root], { cwd: root, stdio: "ignore", env: Object.assign({}, process.env, { HOME: base, USERPROFILE: base }) });
  return root;
}

test("W30b: the card of a component has store and parents links", () => {
  const root = linksFixture();
  const ctx = C.makeCtx(root, C.loadGraph(root));
  assert.ok(ctx.model, "graph model loads");
  const card = C.cardOf(ctx, "src/A.vue").text;
  assert.match(card, /store: mutation setToken→/);
  assert.match(card, /parents: src\/B\.vue/);
});

test("W30b: no .env value in the pack; the reading file shows the config KEY", () => {
  const root = linksFixture();
  const pack = C.build(root, "show the token client and the env TOKEN setting", {});
  assert.ok(!JSON.stringify(pack).includes("supersecret"));
  const ctx = C.makeCtx(root, C.loadGraph(root));
  assert.ok(!ctx.files.includes(".env"));
  assert.strictEqual(ctx.read(".env"), null);
  const card = C.exportsCard(ctx, "src/api/client.js").text;
  assert.match(card, /config: TOKEN/);
  assert.ok(!card.includes("supersecret"));
});

// lorc 0.5.0 (W34a): a hyphen word and a joined pair match the words of a file name.
function topupFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-ctxh-"));
  dirs.push(base);
  const root = path.join(base, "proj");
  put(root, "package.json", JSON.stringify({ name: "fx", version: "1.0.0" }));
  put(root, "src/views/disbursements/TopupDisbursements.vue", "<template><div>top up</div></template>\n<script>\nexport default { name: 'TopupDisbursements' };\n</script>\n");
  put(root, "src/views/other/Foo.vue", "<template><div>foo</div></template>\n<script>\nexport default { name: 'Foo' };\n</script>\n");
  put(root, "src/views/disbursements/components/TopUpBankDetailModal.vue", "<template><div>bank</div></template>\n<script>\nexport default { name: 'TopUpBankDetailModal' };\n</script>\n");
  const git = (...a) => cp.execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  return root;
}
const exFiles = (pack) => pack.exemplars.map((e) => e.file);

test("W34a: the hyphen word top-up finds TopupDisbursements.vue", () => {
  const root = topupFixture();
  const pack = C.build(root, "change the disbursement top-up page: show a toast", {});
  assert.ok(exFiles(pack).includes("src/views/disbursements/TopupDisbursements.vue"), JSON.stringify(exFiles(pack)));
});

test("W34a: the joined pair top up finds TopupDisbursements.vue", () => {
  const root = topupFixture();
  const pack = C.build(root, "change the disbursement top up page", {});
  assert.ok(exFiles(pack).includes("src/views/disbursements/TopupDisbursements.vue"), JSON.stringify(exFiles(pack)));
});

test("W34a: the hyphen parts top and up match the camel parts of TopUpBankDetailModal.vue", () => {
  const root = topupFixture();
  const pack = C.build(root, "add the top-up bank detail modal", {});
  assert.ok(exFiles(pack).includes("src/views/disbursements/components/TopUpBankDetailModal.vue"), JSON.stringify(exFiles(pack)));
});

// lorc 0.5.1 (W38a): the context pack for back-end repos.
function repo(prefix, files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(base);
  const root = path.join(base, "proj");
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  const git = (...a) => cp.execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  cp.execFileSync(process.execPath, [LORC, "graph", "update", "--dir", root], { cwd: root, stdio: "ignore", env: Object.assign({}, process.env, { HOME: base, USERPROFILE: base }) });
  return root;
}
const MOD = "example.com/hub";
function goFixture() {
  const repoLines = ["package applicationrepository", "", "import \"database/sql\"", "", "type ApplicationRepository struct {", "\tdb *sql.DB", "}", "",
    "func New(db *sql.DB) *ApplicationRepository {", "\treturn &ApplicationRepository{db: db}", "}", "",
    "func (r *ApplicationRepository) ListBySeeker(id string) ([]string, error) {", "\treturn nil, nil", "}", ""];
  while (repoLines.length < 500) repoLines.push("// filler line " + repoLines.length);
  return repo("lorc-ctxgo-", {
    "go.mod": `module ${MOD}\n\ngo 1.22\n`,
    "internal/core/application/handlers/application-handler.go": [
      "package applicationhandlers", "", "import \"github.com/gofiber/fiber/v2\"", "",
      "type ApplicationServicer interface {", "\tListMine(id string) ([]string, error)", "\tWithdraw(id string) error", "}", "",
      "type ApplicationHandler struct {", "\tsvc ApplicationServicer", "}", "",
      "func New(s ApplicationServicer) *ApplicationHandler {", "\treturn &ApplicationHandler{svc: s}", "}", "",
      "func (h *ApplicationHandler) ListMine(c *fiber.Ctx) error {", "\t_, err := h.svc.ListMine(\"x\")", "\treturn err", "}", "",
      "func (h *ApplicationHandler) Withdraw(c *fiber.Ctx) error {", "\treturn h.svc.Withdraw(\"x\")", "}", ""].join("\n"),
    "internal/core/application/handlers/application-handler_test.go": [
      "package applicationhandlers", "", "import \"testing\"", "", "type mockSvc struct{}", "",
      "func TestListMine(t *testing.T) {", "\t_ = New(nil)", "}", ""].join("\n"),
    "internal/core/application/service/application-service.go": [
      "package applicationservice", "", "type ApplicationService struct {", "\trepo interface{}", "}", "",
      "func New(r interface{}) *ApplicationService {", "\treturn &ApplicationService{repo: r}", "}", "",
      "func (s *ApplicationService) ListMine(id string) ([]string, error) {", "\treturn nil, nil", "}", "",
      "func (s *ApplicationService) Withdraw(id string) error {", "\treturn nil", "}", ""].join("\n"),
    "internal/core/application/service/application-service_test.go": [
      "package applicationservice", "", "import \"testing\"", "", "func TestWithdraw(t *testing.T) {", "\t_ = New(nil)", "}", ""].join("\n"),
    "internal/core/application/repository/application-repository.go": repoLines.join("\n") + "\n",
    "internal/core/job/handlers/job-handler_test.go": [
      "package jobhandlers", "", "import (", "\t\"net/http/httptest\"", "\t\"testing\"", ")", "",
      "func TestJobGet(t *testing.T) {", "\treq := httptest.NewRequest(\"GET\", \"/users/me/jobs/1\", nil)", "\t_ = req", "}", ""].join("\n"),
    "internal/routes/routes.go": [
      "package routes", "", "import (", "\t\"github.com/gofiber/fiber/v2\"", "", `\tapplicationhandlers "${MOD}/internal/core/application/handlers"`, ")", "",
      "type Handlers struct {", "\tApplication *applicationhandlers.ApplicationHandler", "}", "",
      "func Setup(app *fiber.App, h *Handlers) {", "\tseekerApps := app.Group(\"/users/me/applications\")", "\tseekerApps.Get(\"/\", h.Application.ListMine)",
      "\tseekerApps.Delete(\"/:id\", h.Application.Withdraw)", "", "\t// Recruiter job postings", "\trecJobs := app.Group(\"/users/me/jobs\")",
      "\trecJobs.Get(\"/\", h.Application.ListMine)", "\trecJobs.Get(\"/:id\", h.Application.ListMine)", "\trecJobs.Put(\"/:id/status\", h.Application.Withdraw)", "}", ""].join("\n"),
    "internal/app/wiring.go": [
      "package app", "", "import (", `\tapplicationhandlers "${MOD}/internal/core/application/handlers"`, `\tapplicationservice "${MOD}/internal/core/application/service"`, ")", "",
      "func Wire() {", "\tsvc := applicationservice.New(nil)", "\th := applicationhandlers.New(svc)", "\t_ = h", "}", ""].join("\n"),
    "TICKET.md": [
      "# Recruiter applicants", "", "Add `GET /users/me/jobs/:id/applicants`.",
      "Extend `ApplicationServicer`, `ApplicationService` and `ApplicationRepository`.",
      "The repository is in `application-repository.go`.", ""].join("\n"),
  });
}

test("W38a: Go back end: backend cards, route group, insert hint, wiring, Go tests, no test API module", () => {
  const root = goFixture();
  const pack = C.build(root, "list the applicants of a recruiter job", { doc: "TICKET.md", engine: null });
  const exFiles = pack.exemplars.map((e) => e.file);
  assert.ok(exFiles.includes("internal/core/application/handlers/application-handler.go"), JSON.stringify(exFiles));
  assert.ok(exFiles.includes("internal/core/application/service/application-service.go"), JSON.stringify(exFiles));
  const h = pack.exemplars.find((e) => e.file.endsWith("application-handler.go"));
  assert.match(h.what, /^symbols: .*ListMine \d+-\d+/);
  const route = pack.targets.find((t) => t.kind === "route");
  assert.ok(route && route.file === "internal/routes/routes.go" && /route group recJobs/.test(route.what), JSON.stringify(pack.targets));
  assert.match(route.code, /recJobs := app\.Group/);
  assert.ok(!/seekerApps/.test(route.code));
  const ins = pack.targets.find((t) => t.kind === "insert" && t.file === "internal/routes/routes.go");
  assert.ok(ins && /new route goes near internal\/routes\/routes\.go:\d+ \(group recJobs\)/.test(ins.what), JSON.stringify(ins));
  const wire = pack.targets.find((t) => t.kind === "wire" && t.file === "internal/app/wiring.go");
  assert.ok(wire && /applicationservice\.New/.test(wire.code), JSON.stringify(pack.targets));
  assert.ok(pack.tests.some((t) => /_test\.go$/.test(t.file) && /first test \d+/.test(t.what)), JSON.stringify(pack.tests));
  assert.ok(!pack.targets.some((t) => /_test\.go$/.test(t.file)), "no test file as a target");
  assert.ok(!/\(API module\)/.test(pack.text));
  assert.ok(!/application-repository\.go:1-500 — file/.test(pack.text), "no whole-file item for a 500-line file");
  const named = pack.entities.find((e) => e.name === "application-repository.go");
  assert.ok(named && !named.at.some((a) => /:1-500$/.test(a)), JSON.stringify(named));
});

test("W38a: TS back end: controller + service exemplars; a big YAML gives a section item", () => {
  const yaml = ["openapi: 3.0.0", "paths:"];
  while (yaml.length < 300) yaml.push(`  /other/path-${yaml.length}:`);
  yaml.push("  /card-management/issue:", "    post:", "      summary: Issue a card");
  while (yaml.length < 600) yaml.push(`  # line ${yaml.length}`);
  const root = repo("lorc-ctxts-", {
    "package.json": JSON.stringify({ name: "be", version: "1.0.0" }),
    "src/services/a.ts": ["export class CardService {", "  async issue(body: unknown) {", "    return body;", "  }", "}", ""].join("\n"),
    "src/controllers/a.ts": ["import { Router } from 'express';", "import { CardService } from '../services/a';", "",
      "export class CardController {", "  public router = Router();", "  constructor(private svc = new CardService()) {",
      "    this.router.post('/issue', (req, res) => res.json(this.svc.issue(req.body)));", "  }", "}", ""].join("\n"),
    "src/app.ts": ["import express from 'express';", "import { CardController } from './controllers/a';", "",
      "export const app = express();", "app.use('/cards', new CardController().router);", ""].join("\n"),
    "docs/openapi.yaml": yaml.join("\n") + "\n",
    "TICKET.md": "Add `POST /card-management/issue`. Copy `src/controllers/a.ts` and `src/services/a.ts`. The spec is `docs/openapi.yaml`.\n",
  });
  const pack = C.build(root, "add the card issue endpoint", { doc: "TICKET.md", engine: null });
  const exFiles = pack.exemplars.map((e) => e.file);
  assert.ok(exFiles.includes("src/controllers/a.ts") && exFiles.includes("src/services/a.ts"), JSON.stringify(exFiles));
  const y = pack.entities.find((e) => e.name === "docs/openapi.yaml");
  assert.ok(y && y.at.includes("docs/openapi.yaml:301-340"), JSON.stringify(y));
  assert.ok(!y.at.includes("docs/openapi.yaml:1-600"));
});

// lorc 0.5.2 (W40b): back-end mirror, reuse rows, narrow ranges, unit-test exemplars.
function tsMirrorFixture() {
  const big = ["import { Repo } from './base';", "", "export class ReportRepository {", "  constructor(private db: unknown) {}"];
  for (let i = 0; i < 140; i++) big.push(i === 70 ? "  msg = 'Report period is not valid';" : `  m${i}() { return ${i}; }`);
  big.push("}", "");
  return repo("lorc-ctxmir-", {
    "package.json": JSON.stringify({ name: "be", version: "1.0.0" }),
    "src/config.ts": ["export const XENDIT_CALLBACK_TOKEN = process.env.X || '';", ""].join("\n"),
    "src/controllers/report.ts": ["import { Router } from 'express';", "", "export class ReportController {", "  public router = Router();",
      "  constructor() {", "    this.router.post('/v1.0/reports', (req, res) => res.json({}));", "  }", "}", ""].join("\n"),
    "src/services/report.ts": ["export class ReportService {", "  async run() {", "    return 'Report was missing';", "  }", "}", ""].join("\n"),
    "src/container/report.ts": ["import { ReportService } from '../services/report';", "", "export interface ReportContainer {", "  reportService: ReportService;", "}", "",
      "export function initReportContainer(): ReportContainer {", "  return { reportService: new ReportService() };", "}", ""].join("\n"),
    "src/repositories/report.ts": big.join("\n"),
    "src/repositories/va.ts": ["export class VARepository {", "  find() {", "    return null;", "  }", "}", ""].join("\n"),
    "src/controllers/middlewares/token.ts": ["import { XENDIT_CALLBACK_TOKEN } from '../../config';", "",
      "export function xenditCallbackTokenValidation() {", "  return (req: any, _: any, next: any) => {",
      "    if (req.headers['x-callback-token'] !== XENDIT_CALLBACK_TOKEN) {", "      throw new Error('Unauthorized. Invalid X-Callback-Token Header');", "    }", "    next();", "  };", "}", ""].join("\n"),
    "tests/unit/services/report.test.ts": ["import { ReportService } from '../../../src/services/report';", "", "describe('ReportService', () => {", "  it('runs', () => {});", "});", ""].join("\n"),
    "tests/integration/repositories/va.test.ts": ["import { VARepository } from '../../../src/repositories/va';", "", "describe('VARepository', () => {", "  it('finds', () => {});", "});", ""].join("\n"),
    "TICKET.md": ["# Virtual accounts", "", "Add `POST /v1.0/reports/va` for the VA feature.", "",
      "- `src/controllers/va.ts`: the VA controller. Use the `VARepository` and `ReportRepository`.", "- `src/services/va.ts`: the VA service.",
      "- The callback checks `XENDIT_CALLBACK_TOKEN`; else it returns `Unauthorized. Invalid X-Callback-Token Header`.", "- A bad period gives `Report period is not valid`.", "- A gap gives `Report was missing`.", ""].join("\n"),
  });
}

test("W40b: TS back end: mirror container row, token.ts reuse, unit test first, narrow range", () => {
  const root = tsMirrorFixture();
  const pack = C.build(root, "add the virtual account endpoints", { doc: "TICKET.md", engine: null });
  const m = (pack.mirror || []).find((r) => r.file === "src/container/report.ts");
  assert.ok(m && / → src\/container\/va\.ts \(not in the doc\)$/.test(m.what) && m.counterpart === "src/container/va.ts", JSON.stringify(pack.mirror));
  assert.ok(!pack.mirror.some((r) => r.file === "src/repositories/report.ts"), "the counterpart exists");
  assert.ok(/## Mirror \(closest feature: report\)/.test(pack.text), pack.text);
  assert.ok(pack.text.indexOf("## Where the change goes") < 0 || pack.text.indexOf("## Where the change goes") < pack.text.indexOf("## Mirror"));
  const tok = pack.reuse.find((r) => r.file === "src/controllers/middlewares/token.ts");
  assert.ok(tok && /xenditCallbackTokenValidation/.test(tok.what) && tok.start === 3, JSON.stringify(pack.reuse));
  const long = pack.reuse.find((r) => r.file === "src/repositories/report.ts");
  assert.ok(long && long.end - long.start + 1 <= 11 && /class ReportRepository 3-\d+ \(hit at line \d+\)/.test(long.what), JSON.stringify(pack.reuse));
  assert.ok(!("code" in long), "a capped row has no inline code");
  assert.ok(tok.code && /xenditCallbackTokenValidation/.test(tok.code), "a small symbol keeps its code");
  // A doc span of 3 words gives no row.
  assert.ok(!pack.reuse.some((r) => r.file === "src/services/report.ts"), JSON.stringify(pack.reuse));
  assert.strictEqual(pack.tests[0].file, "tests/unit/services/report.test.ts", JSON.stringify(pack.tests));
  // C3: a 150-line exemplar never gives 1-150.
  const rep = pack.exemplars.find((e) => e.file === "src/repositories/report.ts");
  assert.ok(rep, JSON.stringify(pack.exemplars.map((e) => e.file)));
  assert.ok(!(rep.start === 1 && rep.end >= 140) && rep.end - rep.start < 40, `${rep.start}-${rep.end}`);
  assert.ok(pack.bytes <= 8192);
  // C5: the read plan carries the mirror row when the task writes the counterpart.
  const plan = C.readPlan(root, JSON.parse(JSON.stringify(pack)), { files: ["src/container/va.ts"], words: "va", loaded: null });
  assert.ok(plan.some((p) => p.file === "src/container/report.ts" && /mirror of src\/container\/va\.ts/.test(p.why)), JSON.stringify(plan));
});

test("W40b: Go dir case: a new module mirrors the sibling module; hop files nobody uses drop", () => {
  const util = ["package logging", "", "type Config struct {", "\tLevel string", "}", "", "func LoadConfig() Config {", "\treturn Config{}", "}", ""].join("\n");
  const root = repo("lorc-ctxgodir-", {
    "go.mod": `module ${MOD}\n\ngo 1.22\n`,
    "internal/utils/logging/config.go": util,
    "internal/core/app1/handlers/app1-handler.go": ["package app1handlers", "", `import _ "${MOD}/internal/utils/logging"`, "", "type App1Handler struct{}", "", "func New() *App1Handler {", "\treturn &App1Handler{}", "}", ""].join("\n"),
    "internal/core/app1/service/app1-service.go": ["package app1service", "", "type App1Service struct{}", "", "func New() *App1Service {", "\treturn &App1Service{}", "}", ""].join("\n"),
    "internal/core/app1/repository/app1-repository.go": ["package app1repository", "", "type App1Repository struct{}", "", "func New() *App1Repository {", "\treturn &App1Repository{}", "}", ""].join("\n"),
    "TICKET.md": ["# New module", "", "A new module `internal/core/newmod`. Copy `App1Handler`, `App1Service` and `App1Repository`.", ""].join("\n"),
  });
  const pack = C.build(root, "add the newmod module", { doc: "TICKET.md", engine: null });
  const cps = (pack.mirror || []).map((r) => r.counterpart).sort();
  assert.deepStrictEqual(cps, ["internal/core/newmod/handlers/newmod-handler.go", "internal/core/newmod/repository/newmod-repository.go", "internal/core/newmod/service/newmod-service.go"], JSON.stringify(pack.mirror));
  assert.ok(!pack.reuse.some((r) => r.file === "internal/utils/logging/config.go"), JSON.stringify(pack.reuse));
});

test("W40b: a Vue repo gets no mirror key and the old sections", () => {
  const root = fixture(true);
  const pack = C.build(root, "add the pay order flow", { engine: null });
  assert.ok(!("mirror" in pack));
  assert.ok(!/## Mirror/.test(pack.text));
  assert.deepStrictEqual(Object.keys(pack).slice(0, 6), ["v", "entities", "targets", "exemplars", "tests", "reuse"]);
});

test("W40b: a back-end pack may hold more than 30 items when they fit the bytes", () => {
  const files = { "package.json": JSON.stringify({ name: "be", version: "1.0.0" }) };
  const names = [];
  for (let i = 0; i < 40; i++) { const n = "CONST_NAME_" + i; names.push(n); files["src/c" + i + ".ts"] = "export const " + n + " = " + i + ";\n"; }
  files["TICKET.md"] = names.map((n) => "- `" + n + "`").join("\n") + "\n";
  const root = repo("lorc-ctxcap-", files);
  const pack = C.build(root, "use the constants", { doc: "TICKET.md", engine: null, maxBytes: 1 << 20 });
  const rows = (pack.text.match(/^- /gm) || []).length;
  assert.ok(rows > 30 && rows <= 34, String(rows));
});

test("W40b: readPlan: a back-end pack adds the range of a doc-named error type", () => {
  const root = tsMirrorFixture();
  put(root, "src/domain/standard-error.ts", ["export class StandardError extends Error {", "  constructor(public error_code: string, message: string) {", "    super(message);", "  }", "}", ""].join("\n"));
  // R1 (0.5.2): the plan reads pack.errors, not pack.entities.
  const pack = { be: true, entities: [], errors: [{ name: "StandardError", file: "src/domain/standard-error.ts", start: 1, end: 5 }] };
  const plan = C.readPlan(root, pack, { files: ["src/services/va.ts"], words: "va", loaded: null });
  assert.ok(plan.some((p) => p.file === "src/domain/standard-error.ts" && /error type StandardError/.test(p.why)), JSON.stringify(plan));
  const fe = C.readPlan(root, { entities: pack.entities, errors: pack.errors }, { files: ["src/services/va.ts"], words: "va", loaded: null });
  assert.ok(!fe.some((p) => p.file === "src/domain/standard-error.ts"));
  const built = C.build(root, "add the virtual account endpoints", { doc: "TICKET.md", engine: null });
  assert.strictEqual(built.be, true);
});

test("W41 R1: the error class past entity 40 is in pack.errors and in the plan", () => {
  const files = { "package.json": JSON.stringify({ name: "be", version: "1.0.0" }) };
  const names = [];
  for (let i = 0; i < 45; i++) { const n = "CONST_NAME_" + i; names.push(n); files["src/c" + i + ".ts"] = "export const " + n + " = " + i + ";\n"; }
  names.push("StandardError");
  files["src/domain/standard-error.ts"] = ["export class StandardError extends Error {", "  constructor(public error_code: string, message: string) {", "    super(message);", "  }", "}", ""].join("\n");
  files["TICKET.md"] = names.map((n) => "- `" + n + "`").join("\n") + "\n";
  const root = repo("lorc-ctxerr-", files);
  const pack = C.build(root, "use the constants", { doc: "TICKET.md", engine: null });
  assert.ok(!pack.entities.some((e) => e.name === "StandardError"), "past the cap");
  assert.deepStrictEqual(pack.errors, [{ name: "StandardError", file: "src/domain/standard-error.ts", start: 1, end: 5 }]);
  const plan = C.readPlan(root, JSON.parse(JSON.stringify(pack)), { files: ["src/services/va.ts"], words: "va", loaded: null });
  assert.ok(plan.some((p) => p.file === "src/domain/standard-error.ts" && p.ranges[0][0] === 1 && /error type StandardError/.test(p.why)), JSON.stringify(plan));
});

test("W41 R2: the test setup comes from the test of the same layer", () => {
  const t = (n) => ["import { X } from 'x';", "", `describe('${n}', () => {`, "  it('a', () => {});", "});", ""].join("\n");
  const root = repo("lorc-ctxlayer-", { "tests/unit/controllers/report.test.ts": t("c"), "tests/unit/services/report.test.ts": t("s") });
  const pack = { be: true, tests: [{ file: "tests/unit/controllers/report.test.ts" }, { file: "tests/unit/services/report.test.ts" }] };
  const plan = C.readPlan(root, pack, { files: ["src/services/va.ts", "tests/unit/services/va.test.ts"], words: "va", loaded: null });
  const s = plan.filter((p) => p.why === "test setup").map((p) => p.file);
  assert.deepStrictEqual(s, ["tests/unit/services/report.test.ts"]);
  const old = C.readPlan(root, pack, { files: ["src/services/va.ts"], words: "va", loaded: null });
  assert.deepStrictEqual(old.filter((p) => p.why === "test setup").map((p) => p.file), ["tests/unit/controllers/report.test.ts"]);
});

test("W41 R3: an alias of components['schemas'] gives the generated schema block", () => {
  const root = repo("lorc-ctxschema-", {
    "package.json": JSON.stringify({ name: "be", version: "1.0.0" }),
    "src/schema/app.ts": ["export interface paths {}", "export interface components {", "  schemas: {", "    Foo: {", "      a: string;", "    };", "  };", "}", ""].join("\n"),
    "src/schema/types.ts": ["import { components } from './app';", "", "export type Foo = components['schemas']['Foo'];", ""].join("\n"),
    "src/services/x.ts": ["export class XService {", "  run() { return 1; }", "}", ""].join("\n"),
    "TICKET.md": "Return a `Foo` from the service.\n",
  });
  const pack = C.build(root, "return Foo", { doc: "TICKET.md", engine: null });
  assert.ok(/schema Foo \(generated\)/.test(pack.text), pack.text);
  assert.deepStrictEqual(pack.schemas, [{ name: "Foo", alias: "Foo", file: "src/schema/app.ts", start: 4, end: 6 }]);
  const plan = C.readPlan(root, JSON.parse(JSON.stringify(pack)), { files: ["src/services/x.ts"], words: "return a Foo", loaded: null });
  assert.ok(plan.some((p) => p.file === "src/schema/app.ts" && p.ranges[0][0] === 4 && p.ranges[0][1] === 6 && p.why === "schema Foo (generated)"), JSON.stringify(plan));
});
