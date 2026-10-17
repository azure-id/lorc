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
