"use strict";
// lorc 0.5.0 (W29a): store links resolve to the store member on read, and the
// derived cache keeps them as kind 4 rows.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const G = require("../bin/lib/graph/graph.js");
const Q = require("../bin/lib/graph/graph-query.js");

const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const FILES = {
  "src/store/mutation-types.js": "export const setToken = \"setToken\";\n",
  "src/store/getter-types.js": "export const isX = \"getIsX\";\n",
  "src/store/modules/login.js": [
    "import * as types from '../mutation-types';",
    "const state = { token: null };",
    "const mutations = {",
    "  [types.setToken](s, t) { s.token = t; },",
    "  toggle(s) { s.token = null; },",
    "};",
    "const getters = {",
    "  getIsX: (s) => !!s.token,",
    "};",
    "export default { state, mutations, getters };",
    "",
  ].join("\n"),
  "src/store/modules/tnc.js": [
    "export const NS = 'digital';",
    "export const FETCH = `${NS}/fetch`;",
    "export default { namespaced: true, state: { status: 1 }, actions: { fetch() {} } };",
    "",
  ].join("\n"),
  "src/store/index.js": [
    "import Vue from 'vue';",
    "import Vuex from 'vuex';",
    "import login from './modules/login';",
    "import tnc from './modules/tnc';",
    "import ui from './modules/ui';",
    "Vue.use(Vuex);",
    "export default new Vuex.Store({ modules: { login, digital: tnc, ui } });",
    "",
  ].join("\n"),
  "src/A.vue": [
    "<template>",
    "  <div>{{ status }}</div>",
    "</template>",
    "<script>",
    "import { mapState } from 'vuex';",
    "import * as types from './store/mutation-types';",
    "import * as getterTypes from './store/getter-types';",
    "import { FETCH } from './store/modules/tnc';",
    "export default {",
    "  name: 'A',",
    "  computed: {",
    "    ...mapState('digital', ['status']),",
    "    ...mapState({ tok: (state) => state.login.token }),",
    "  },",
    "  methods: {",
    "    save() {",
    "      this.$store.commit(types.setToken, 1);",
    "    },",
    "    load() {",
    "      this.$store.dispatch(FETCH);",
    "    },",
    "    isX() {",
    "      return this.$store.getters[getterTypes.isX];",
    "    },",
    "    flip() {",
    "      this.$store.commit('toggle');",
    "    },",
    "    missing() {",
    "      return this.$store.getters.missingOne;",
    "    },",
    "  },",
    "};",
    "</script>",
    "",
  ].join("\n"),
  "src/store/modules/ui.js": "export default { state: { on: 1 }, mutations: { toggle(s) { s.on = 0; } } };\n",
  "src/Child.vue": [
    "<template>",
    "  <div>{{ amount }}</div>",
    "</template>",
    "<script>",
    "export default {",
    "  name: 'Child',",
    "  props: ['amount'],",
    "  methods: {",
    "    done() { this.$emit('close'); },",
    "  },",
    "};",
    "</script>",
    "",
  ].join("\n"),
  "src/Parent.vue": [
    "<template>",
    "  <div>",
    "    <Child :amount=\"a\" @close=\"onClose\" />",
    "    {{ $t('A.B') }} {{ $t('A.C') }}",
    "    {{ formatAmount(a) }}",
    "  </div>",
    "</template>",
    "<script>",
    "import Child from './Child.vue';",
    "export default {",
    "  name: 'Parent',",
    "  components: { Child },",
    "  data() { return { a: 1 }; },",
    "  methods: {",
    "    onClose() {},",
    "    go() {",
    "      this.$router.push('/settings/webhooks');",
    "      this.$router.push('/nope');",
    "    },",
    "  },",
    "};",
    "</script>",
    "",
  ].join("\n"),
  "src/i18n/en.json": "{ \"A\": { \"B\": \"x\" } }\n",
  "src/i18n/id.json": "{ \"A\": { \"B\": \"y\" } }\n",
  "src/methods/vueMixins.js": "const mixin = { methods: { formatAmount(v) { return v; } } };\nexport { mixin };\n",
  "src/main.js": "import Vue from 'vue';\nimport { mixin } from './methods/vueMixins.js';\nVue.mixin({ mixins: [mixin] });\n",
  "src/S.vue": "<template><div><router-view /></div></template>\n<script>\nexport default { name: 'S' };\n</script>\n",
  "src/W.vue": "<template><div>w</div></template>\n<script>\nexport default { name: 'W' };\n</script>\n",
  "src/router/index.js": [
    "import S from '../S.vue';",
    "import W from '../W.vue';",
    "export const routes = [{ path: '/settings', component: S, children: [{ path: 'webhooks', component: W }] }];",
    "",
  ].join("\n"),
};

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function repo(files = FILES) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-glres-"));
  temps.push(d);
  const root = path.join(d, "proj");
  fs.mkdirSync(root, { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  for (const [rel, text] of Object.entries(files)) write(path.join(root, rel), text);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { root, git, claudeDir: path.join(root, ".claude", "lorc") };
}

const update = (r) => G.graphUpdate(r.claudeDir, r.root, { enabled: true });

// Every store call of A.vue → its resolution, keyed by "<role> <name>".
function storeResults(model) {
  const out = new Map();
  for (const s of model.byFile["src/A.vue"].symbols || []) {
    for (const c of s.calls || []) {
      if (!c.store) continue;
      out.set(`${c.store} ${c.name}`, Q.resolveCall(model, "src/A.vue", s, c));
    }
  }
  return out;
}
const qnameOf = (model, r) => (r && r.target ? model.symbols.get(r.target).qname : null);
const find = (model, rel, pred) => (model.byFile[rel].symbols || []).find(pred);

let shared = null;
function built() {
  if (shared) return shared;
  const r = repo();
  update(r);
  shared = { r, model: Q.loadModel(r.claudeDir, r.root) };
  return shared;
}

test("each store call of A.vue resolves to its store member", () => {
  const { model } = built();
  const res = storeResults(model);
  const pick = (role, name) => res.get(`${role} ${name}`);
  const commit = pick("mutation", "types.setToken");
  assert.strictEqual(commit && commit.state, "STORE", JSON.stringify([...res]));
  assert.strictEqual(qnameOf(model, commit), find(model, "src/store/modules/login.js", (s) => s.store === "mutation").qname);
  assert.match(qnameOf(model, commit), /setToken$/);
  const fetch = pick("action", "FETCH");
  assert.strictEqual(fetch && fetch.state, "STORE");
  assert.strictEqual(model.symbols.get(fetch.target).file, "src/store/modules/tnc.js");
  assert.match(qnameOf(model, fetch), /\.fetch$/);
  const getter = pick("getter", "getterTypes.isX");
  assert.strictEqual(getter && getter.state, "STORE");
  assert.strictEqual(model.symbols.get(getter.target).file, "src/store/modules/login.js");
  assert.match(qnameOf(model, getter), /\.getIsX$/);
  const status = pick("state", "digital.status");
  assert.strictEqual(status && status.state, "STORE");
  const st = model.symbols.get(status.target);
  assert.strictEqual(st.kind, "state");
  assert.strictEqual(st.file, "src/store/modules/tnc.js");
  assert.match(st.qname, /\.status$/);
  const token = pick("state", "login.token");
  assert.strictEqual(token && token.state, "STORE");
  const tk = model.symbols.get(token.target);
  assert.strictEqual(tk.kind, "state");
  assert.strictEqual(tk.file, "src/store/modules/login.js");
  assert.match(tk.qname, /\.token$/);
  const miss = pick("getter", "missingOne");
  assert.strictEqual(miss && miss.state, "UNRESOLVED");
  assert.strictEqual(miss.missing_store, "getter missingOne");
});

test("callersOf a store member lists the store call (derived cache)", () => {
  const { model } = built();
  assert.ok(model.callersCache, "the derived cache is loaded");
  const target = find(model, "src/store/modules/login.js", (s) => s.store === "mutation");
  const { confident } = Q.callersOf(model, target);
  const row = confident.find((c) => c.sym.file === "src/A.vue");
  assert.ok(row, JSON.stringify(confident.map((c) => c.sym.id)));
  assert.strictEqual(row.store, "mutation");
});

test("incremental: a changed key constant re-resolves an unchanged caller", () => {
  const r = repo();
  update(r);
  write(path.join(r.root, "src/store/getter-types.js"), "export const isX = \"getIsY\";\n");
  r.git("add", ".");
  r.git("commit", "-q", "-m", "edit");
  update(r);
  const model = Q.loadModel(r.claudeDir, r.root);
  const res = storeResults(model).get("getter getterTypes.isX");
  assert.strictEqual(res && res.state, "UNRESOLVED");
  assert.strictEqual(res.missing_store, "getter getIsY");
});

test("a commit of a key that two non-namespaced modules define reaches both", () => {
  const { model } = built();
  const res = storeResults(model).get("mutation toggle");
  assert.strictEqual(res && res.state, "STORE", JSON.stringify(res));
  assert.strictEqual(res.targets.length, 2);
  for (const file of ["src/store/modules/login.js", "src/store/modules/ui.js"]) {
    const target = find(model, file, (s) => s.store === "mutation" && s.name === "toggle");
    assert.ok(target, file);
    assert.ok(Q.callersOf(model, target).confident.some((c) => c.sym.file === "src/A.vue"), file);
  }
});

// Every call of Parent.vue that matches pred, with its resolution.
function parentCalls(model, pred) {
  const out = [];
  for (const s of model.byFile["src/Parent.vue"].symbols || []) for (const c of s.calls || []) if (pred(c)) out.push({ s, c, r: Q.resolveCall(model, "src/Parent.vue", s, c) });
  return out;
}

test("listen and prop resolve to the child's emit and prop", () => {
  const { model } = built();
  const listen = parentCalls(model, (c) => c.listen && c.name === "Child.close")[0];
  assert.ok(listen, "listen call");
  assert.strictEqual(listen.r.state, "IMPORT");
  const em = model.symbols.get(listen.r.target);
  assert.strictEqual(em.kind, "emit");
  assert.strictEqual(em.file, "src/Child.vue");
  assert.strictEqual(em.qname, "Child.close");
  const prop = parentCalls(model, (c) => c.prop && c.name === "Child.amount")[0];
  assert.ok(prop, "prop call");
  assert.strictEqual(prop.r.state, "IMPORT");
  assert.strictEqual(model.symbols.get(prop.r.target).kind, "prop");
  const rows = Q.callersOf(model, em).confident;
  assert.ok(rows.some((c) => c.sym.file === "src/Parent.vue" && c.listen), JSON.stringify(rows));
});

test("i18n keys resolve to the locale file", () => {
  const { model } = built();
  const ab = parentCalls(model, (c) => c.i18n && c.name === "A.B")[0];
  assert.ok(ab, "A.B call");
  assert.strictEqual(ab.r.state, "I18N");
  assert.strictEqual(ab.r.file, "src/i18n/en.json");
  assert.strictEqual(ab.r.also, 1);
  const ac = parentCalls(model, (c) => c.i18n && c.name === "A.C")[0];
  assert.strictEqual(ac.r.state, "UNRESOLVED");
  assert.strictEqual(ac.r.missing_i18n, "A.C");
  const users = Q.i18nUsers(model, "A.B");
  assert.ok(users.some((u) => u.sym.file === "src/Parent.vue" && u.sym.kind === "template"), JSON.stringify(users.map((u) => u.sym.id)));
});

test("a global mixin member resolves from a template", () => {
  const { model } = built();
  const fa = parentCalls(model, (c) => c.tpl && c.name === "formatAmount")[0];
  assert.ok(fa, "formatAmount ref");
  assert.strictEqual(fa.r.state, "IMPORT", JSON.stringify(fa.r));
  assert.strictEqual(fa.r.inherited, true);
  assert.strictEqual(model.symbols.get(fa.r.target).qname, "mixin.formatAmount");
});

test("route paths resolve to the route, a child route by its end", () => {
  const { model } = built();
  const wh = parentCalls(model, (c) => c.route && c.path && c.name === "/settings/webhooks")[0];
  assert.ok(wh, "route path call");
  assert.strictEqual(wh.r.state, "ROUTE", JSON.stringify(wh.r));
  assert.strictEqual(model.symbols.get(wh.r.target).name, "VIEW /settings/webhooks");
  const nope = parentCalls(model, (c) => c.route && c.path && c.name === "/nope")[0];
  assert.strictEqual(nope.r.state, "UNRESOLVED");
  assert.strictEqual(nope.r.missing_route, "/nope");
});

test("linksOf gives the emits with listeners and the parents", () => {
  const { model } = built();
  const L = Q.linksOf(model, "src/Child.vue");
  const close = L.emits.find((e) => e.name === "close");
  assert.ok(close, JSON.stringify(L));
  assert.strictEqual(close.listeners.length, 1);
  assert.strictEqual(close.listeners[0].file, "src/Parent.vue");
  assert.ok(L.parents.some((p) => p.file === "src/Parent.vue"), JSON.stringify(L.parents));
  assert.deepStrictEqual(Q.linksOf(model, "src/Parent.vue").fields, ["a"]);
});

// lorc 0.5.0 (W29c): a Node back end. Global events, config keys and tables.
const BACK = {
  "src/bus.js": "const EventEmitter = require('events');\nmodule.exports = new EventEmitter();\n",
  "src/order.js": "const bus = require('./bus');\nfunction create() {\n  bus.emit('order.created', 1);\n  bus.emit('nobody');\n}\nmodule.exports = { create };\n",
  "src/mail.js": "const bus = require('./bus');\nfunction setup() {\n  bus.on('order.created', () => 1);\n}\nmodule.exports = { setup };\n",
  "src/audit.js": "const bus = require('./bus');\nfunction setup() {\n  bus.on('order.created', () => 1);\n}\nmodule.exports = { setup };\n",
  ".env.example": "DB_URL=\nSECRET=abc123\n",
  "src/db.js": "function conn() {\n  return [process.env.DB_URL, process.env.NOPE];\n}\nfunction q() {\n  return \"SELECT id FROM users\";\n}\nmodule.exports = { conn, q };\n",
  "migrations/001.sql": "CREATE TABLE users (\n id int\n);\n",
  "src/ent.ts": "@Entity('accounts') export class Account {}\n",
};

let back = null;
function builtBack() {
  if (back) return back;
  const r = repo(BACK);
  update(r);
  back = { r, model: Q.loadModel(r.claudeDir, r.root) };
  return back;
}

function eventCalls(model, rel) {
  const out = [];
  for (const s of model.byFile[rel].symbols || []) for (const c of s.calls || []) if (c.event) out.push({ s, c, r: Q.resolveCall(model, rel, s, c) });
  return out;
}

test("a global emit resolves to every listener; an emit with no listener is missing", () => {
  const { model } = builtBack();
  const calls = eventCalls(model, "src/order.js");
  const oc = calls.find((x) => x.c.name === "order.created");
  assert.ok(oc, JSON.stringify(calls.map((x) => x.c)));
  assert.strictEqual(oc.r.state, "EVENT", JSON.stringify(oc.r));
  assert.strictEqual(oc.r.targets.length, 2);
  const files = oc.r.targets.map((t) => model.symbols.get(t)).map((s) => `${s.file}#${s.name}`).sort();
  assert.deepStrictEqual(files, ["src/audit.js#setup", "src/mail.js#setup"]);
  const nobody = calls.find((x) => x.c.name === "nobody");
  assert.strictEqual(nobody.r.missing_event, "nobody");
});

test("callersOf a listener gives the emitter with the event name", () => {
  const { model } = builtBack();
  const setup = find(model, "src/mail.js", (s) => s.name === "setup");
  const rows = Q.callersOf(model, setup).confident;
  const row = rows.find((x) => x.sym.name === "create");
  assert.ok(row, JSON.stringify(rows.map((x) => x.sym.id)));
  assert.strictEqual(row.event, "order.created");
});

test("config keys resolve to the env file; no env value is kept", () => {
  const { model } = builtBack();
  const db = Q.resolveConfig(model, "DB_URL");
  assert.strictEqual(db.state, "CONFIG");
  assert.strictEqual(db.file, ".env.example");
  assert.strictEqual(db.line, 1);
  assert.strictEqual(Q.resolveConfig(model, "NOPE").missing_config, "NOPE");
  assert.ok(Q.configUsers(model, "DB_URL").some((u) => u.sym.name === "conn"));
  const env = JSON.stringify(Object.values(model.byFile).filter((f) => f.lang === "env"));
  assert.ok(env.includes("DB_URL"), env);
  assert.ok(!/=/.test(env), env);
});

test("tables resolve to the sql definition and to the entity", () => {
  const { model } = builtBack();
  assert.ok(Q.tableUsers(model, "users").some((u) => u.sym.name === "q"));
  const users = Q.resolveTable(model, "users");
  assert.strictEqual(users.state, "TABLE");
  assert.strictEqual(users.file, "migrations/001.sql");
  assert.strictEqual(users.line, 1);
  assert.strictEqual(Q.resolveTable(model, "accounts").entity, "src/ent.ts#Account");
});

test("linksOf gives the config keys and the tables of a file", () => {
  const { model } = builtBack();
  const L = Q.linksOf(model, "src/db.js");
  const dbUrl = L.config.find((c) => c.key === "DB_URL");
  assert.ok(dbUrl && dbUrl.file === ".env.example" && dbUrl.defLine === 1, JSON.stringify(L.config));
  const nope = L.config.find((c) => c.key === "NOPE");
  assert.ok(nope && !nope.file, JSON.stringify(L.config));
  assert.ok(L.tables.some((t) => t.table === "users" && t.file === "migrations/001.sql"), JSON.stringify(L.tables));
  const ev = Q.linksOf(model, "src/order.js").events.find((e) => e.name === "order.created");
  assert.strictEqual(ev.peers, 2);
});

// lorc 0.5.0 (W28h): cross-file child routes and `Vue.prototype` globals.
test("a cross-file child route resolves by its full path; a Vue.prototype global is external", () => {
  const r = repo({
    "src/main.js": "import Vue from 'vue';\nimport moment from 'moment';\nVue.prototype.moment = moment;\n",
    "src/L.vue": "<template><div><router-view /></div></template>\n<script>\nexport default { name: 'L' };\n</script>\n",
    "src/OL.vue": "<template><div /></template>\n<script>\nexport default { name: 'OL' };\n</script>\n",
    "src/router/index.js": [
      "import L from '../L.vue';",
      "import ordersRoutes from './orders';",
      "export const routes = [{ path: '/orders', component: L, children: ordersRoutes }];",
      "",
    ].join("\n"),
    "src/router/orders.js": "import OL from '../OL.vue';\nexport default [{ path: 'list', component: OL }];\n",
    "src/P.vue": [
      "<template><div>{{ moment(x) }}</div></template>",
      "<script>",
      "export default {",
      "  name: 'P',",
      "  data() { return { x: 1 }; },",
      "  methods: { open() { this.$router.push('/orders/list'); } },",
      "};",
      "</script>",
      "",
    ].join("\n"),
  });
  update(r);
  const model = Q.loadModel(r.claudeDir, r.root);
  const calls = [];
  for (const s of model.byFile["src/P.vue"].symbols || []) for (const c of s.calls || []) calls.push({ c, r: Q.resolveCall(model, "src/P.vue", s, c) });
  const nav = calls.find((x) => x.c.route && x.c.path && x.c.name === "/orders/list");
  assert.ok(nav, JSON.stringify(calls.map((x) => x.c)));
  assert.strictEqual(nav.r.state, "ROUTE", JSON.stringify(nav.r));
  assert.strictEqual(model.symbols.get(nav.r.target).file, "src/router/orders.js");
  const mo = calls.find((x) => x.c.tpl && x.c.name === "moment");
  assert.ok(mo, JSON.stringify(calls.map((x) => x.c)));
  assert.strictEqual(mo.r.external, "Vue.prototype", JSON.stringify(mo.r));
});

// lorc 0.5.0 (W30a): the cards show the links.
const card = (model, q) => Q.ctx(model, q, { budget: 8000 });

test("ctx: a store call row and a missing store key row", () => {
  const { model } = built();
  const save = card(model, "A.save");
  assert.ok(save.card.includes("→ mutation setToken"), save.card);
  const miss = card(model, "A.missing");
  assert.ok(miss.card.includes("NO STORE KEY"), miss.card);
});

test("ctx: a store member lists its store callers; the header has the key", () => {
  const { model } = built();
  const c = card(model, "login.setToken");
  assert.ok(c.ok, JSON.stringify(c));
  assert.ok(c.card.includes("← mutation by"), c.card);
  assert.ok(/A\.save\s+src\/A\.vue:/.test(c.card), c.card);
  assert.ok(c.card.split("\n")[0].endsWith("[store mutation setToken]"), c.card);
});

test("file card: links rows for emits and parents", () => {
  const { model } = built();
  const c = card(model, "src/Child.vue");
  assert.ok(c.card.includes("links  emits: close"), c.card);
  assert.ok(c.card.includes("links  parents: src/Parent.vue"), c.card);
  assert.ok(c.links && c.links.emits.length, JSON.stringify(c.links));
});

test("ctx: an emit row with listeners and a missing listener row", () => {
  const { model } = builtBack();
  const c = card(model, "create");
  assert.ok(c.card.includes("→ emits order.created  2 listener(s)"), c.card);
  assert.ok(c.card.includes("NO LISTENER"), c.card);
});

test("file card: config and table links", () => {
  const { model } = builtBack();
  const c = card(model, "src/db.js");
  assert.ok(c.card.includes("links  config: DB_URL → .env.example:1"), c.card);
  assert.ok(c.card.includes("NOPE (no def)"), c.card);
  assert.ok(c.card.includes("links  tables: users → migrations/001.sql:1"), c.card);
});

test("no card shows an env value", () => {
  const { model } = builtBack();
  for (const q of ["src/db.js", "conn", "q", "create", "src/order.js", ".env.example"]) {
    const c = card(model, q);
    assert.ok(!JSON.stringify(c).includes("abc123"), q);
  }
});

test("--json output never has an env value", () => {
  const { r } = builtBack();
  for (const q of ["src/db.js", "conn"]) {
    const out = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "lorc.js"), "graph", "ctx", q, "--dir", r.root, "--json"], { encoding: "utf8" });
    assert.ok(!String(out.stdout + out.stderr).includes("abc123"), q);
  }
});

// lorc 0.5.0 (W34d): a knex migration defines the table.
test("W34d: knex createTable is a table definition; a knex use is not", () => {
  const r = repo({
    "migrations/001_users.ts": [
      "import { Knex } from 'knex';",
      "export async function up(knex: Knex) {",
      "  await knex.schema.createTable('users', (t) => { t.increments('id'); });",
      "}",
      "",
    ].join("\n"),
    "src/repo.ts": "import { Knex } from 'knex';\nexport function find(knex: Knex) {\n  return knex('users').where({ id: 1 });\n}\n",
  });
  update(r);
  const model = Q.loadModel(r.claudeDir, r.root);
  const t = Q.tableIndex(model).tables.get("users");
  assert.deepStrictEqual(t && t.defs, [{ file: "migrations/001_users.ts", line: 3 }]);
  const u = Q.resolveTable(model, "users");
  assert.strictEqual(u.state, "TABLE", JSON.stringify(u));
  assert.strictEqual(u.file, "migrations/001_users.ts");
  const uses = (model.byFile["src/repo.ts"].symbols || []).flatMap((s) => s.effects || []).filter((e) => e.tables);
  assert.ok(uses.length && uses.every((e) => !e.def), JSON.stringify(uses));
});

// lorc 0.5.0 (W34d): the file card keeps its links rows on a small budget.
test("W34d: a big file card keeps the links rows on a small budget", () => {
  const methods = Array.from({ length: 45 }, (_, i) => `    m${i}() { return ${i}; },`);
  const r = repo({
    "src/store/modules/login.js": "const mutations = { setToken(s, t) { s.token = t; } };\nexport default { state: { token: null }, mutations };\n",
    "src/store/index.js": "import Vue from 'vue';\nimport Vuex from 'vuex';\nimport login from './modules/login';\nVue.use(Vuex);\nexport default new Vuex.Store({ modules: { login } });\n",
    "src/i18n/en.json": "{ \"A\": { \"B\": \"x\" } }\n",
    "src/Big.vue": [
      "<template>",
      "  <div>{{ $t('A.B') }}</div>",
      "</template>",
      "<script>",
      "export default {",
      "  name: 'Big',",
      "  methods: {",
      "    save() { this.$store.commit('setToken', 1); },",
      ...methods,
      "  },",
      "};",
      "</script>",
      "",
    ].join("\n"),
  });
  update(r);
  const model = Q.loadModel(r.claudeDir, r.root);
  const c = Q.ctx(model, "src/Big.vue", { budget: 150 });
  assert.ok(/links\s+store:/.test(c.card), c.card);
  assert.ok(/hidden: .*sym/.test(c.card), c.card);
});
