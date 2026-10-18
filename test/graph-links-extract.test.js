"use strict";
// lorc 0.5.0 (W28a): the link core and the store definitions of adapter `vue`.
const test = require("node:test");
const assert = require("node:assert");
const X = require("../bin/lib/graph/graph-extract.js");
const LINKS = require("../bin/lib/graph/graph-links.js");

const one = (src, lang = "js", rel = "a.js") => X.extractOne({ rel, lang, src });
const sym = (r, kind, qname) => r.symbols.find((s) => s.kind === kind && s.qname === qname);

test("const value: string, folded template, dynamic template", () => {
  const r = one(["export const setToken = \"setToken\";", "export const NS = 'tnc';", "export const FETCH = `${NS}/fetch`;", "export const DYN = `${x}/y`;"].join("\n") + "\n");
  assert.strictEqual(sym(r, "const", "setToken").value, "setToken");
  assert.strictEqual(sym(r, "const", "NS").value, "tnc");
  assert.strictEqual(sym(r, "const", "FETCH").value, "tnc/fetch");
  assert.ok(sym(r, "const", "DYN"));
  assert.strictEqual(sym(r, "const", "DYN").value, undefined);
});

test("store module: members, keys and state fields", () => {
  const r = one(
    [
      "import * as types from '../mutation-types';",
      "const state = { token: null, name: '' };",
      "const mutations = {",
      "  [types.setToken](state, t) { state.token = t; },",
      "  setName(state, n) { state.name = n; },",
      "};",
      "const getters = { getToken: (state) => state.token };",
      "const actions = { async login({ commit }) { commit(types.setToken, 'x'); } };",
      "export default { state, mutations, getters, actions };",
    ].join("\n") + "\n",
    "js",
    "store/modules/login.js"
  );
  const cls = sym(r, "class", "login");
  assert.strictEqual(cls.store_module, true);
  assert.strictEqual(cls.namespaced, undefined);
  const st = sym(r, "method", "login.setToken");
  assert.strictEqual(st.store, "mutation");
  assert.strictEqual(st.key_via, "types.setToken");
  assert.strictEqual(st.key, undefined);
  assert.strictEqual(sym(r, "method", "login.setName").store, "mutation");
  assert.strictEqual(sym(r, "method", "login.setName").key, "setName");
  assert.strictEqual(sym(r, "method", "login.getToken").store, "getter");
  assert.strictEqual(sym(r, "method", "login.getToken").key, "getToken");
  assert.strictEqual(sym(r, "method", "login.login").store, "action");
  assert.strictEqual(sym(r, "method", "login.login").key, "login");
  assert.deepStrictEqual(sym(r, "state", "login.token").lines, [2, 2]);
  assert.deepStrictEqual(sym(r, "state", "login.name").lines, [2, 2]);
});

test("namespaced module, factory state and a same-file key", () => {
  const r = one(
    [
      "const SET_STATUS = 'SET_STATUS';",
      "function initialState() {",
      "  return { status: null, items: [] };",
      "}",
      "export default {",
      "  namespaced: true,",
      "  state: initialState,",
      "  mutations: {",
      "    [SET_STATUS](state, s) { state.status = s; },",
      "  },",
      "};",
    ].join("\n") + "\n",
    "js",
    "store/modules/tnc.js"
  );
  const cls = sym(r, "class", "tnc");
  assert.strictEqual(cls.namespaced, true);
  assert.strictEqual(cls.store_module, true);
  const m = sym(r, "method", "tnc.SET_STATUS");
  assert.strictEqual(m.store, "mutation");
  assert.strictEqual(m.key, "SET_STATUS");
  assert.ok(sym(r, "state", "tnc.status"));
  assert.ok(sym(r, "state", "tnc.items"));
});

test("arrow factory state through a const call", () => {
  const r = one(
    ["const defaultState = () => ({ a: 1, b: 2 });", "const state = defaultState();", "export default { state, mutations: { setA(s, v) { s.a = v; } } };"].join("\n") + "\n",
    "js",
    "store/modules/x.js"
  );
  assert.ok(sym(r, "state", "x.a"));
  assert.ok(sym(r, "state", "x.b"));
});

test("store registrations go to the symbol that owns the line", () => {
  const r = one(
    [
      "import Vue from 'vue';",
      "import Vuex from 'vuex';",
      "import login from './modules/login';",
      "import tnc from './modules/tnc';",
      "Vue.use(Vuex);",
      "export const store = new Vuex.Store({ modules: { login, digital: tnc } });",
    ].join("\n") + "\n",
    "js",
    "store/index.js"
  );
  const owners = r.symbols.filter((s) => s.store_modules);
  assert.strictEqual(owners.length, 1);
  assert.deepStrictEqual(owners[0].store_modules, [
    { name: "login", ref: "login", line: 6 },
    { name: "digital", ref: "tnc", line: 6 },
  ]);
});

test("a component is not a store module", () => {
  const r = one(
    "<template><div/></template>\n<script>\nexport default { name: 'A', data() { return { x: 1 }; }, methods: { go() {} } };\n</script>\n",
    "vue",
    "src/A.vue"
  );
  const cls = sym(r, "class", "A");
  assert.ok(cls);
  assert.strictEqual(cls.store_module, undefined);
  assert.ok(!r.symbols.some((s) => s.store));
});

test("a plain Node file is not a store module", () => {
  const r = one("const actions = { run() {} };\nmodule.exports = { actions };\n", "js", "lib/x.js");
  assert.ok(!r.symbols.some((s) => s.store || s.store_module));
});

test("an adapter error is isolated", () => {
  const bad = {
    id: "bad",
    langs: ["js"],
    applies: () => true,
    object() {
      throw new Error("x");
    },
  };
  LINKS.ADAPTERS.push(bad);
  try {
    const r = one("export function f() { return 1; }\n");
    assert.ok(r.symbols.some((s) => s.name === "f"));
  } finally {
    LINKS.ADAPTERS.splice(LINKS.ADAPTERS.indexOf(bad), 1);
  }
});

// W28b: store calls, map helpers, component fields.
const pick = (call, keys) => Object.fromEntries(keys.map((k) => [k, call[k]]).filter(([, v]) => v !== undefined));
const hasCall = (s, want) => assert.ok(s.calls.some((cc) => JSON.stringify(pick(cc, ["name", "store", "via", "ns_via"])) === JSON.stringify(want)), JSON.stringify(want) + " in " + JSON.stringify(s.calls));
const vue = (lines, rel = "src/A.vue") => one("<template><div/></template>\n<script>\n" + lines.join("\n") + "\n</script>\n", "vue", rel);

test("store calls in a component", () => {
  const r = vue([
    "import * as types from '@/store/mutation-types';",
    "import * as getterTypes from '@/store/getter-types';",
    "export default {",
    "  name: 'A',",
    "  methods: {",
    "    save() {",
    "      this.$store.commit(types.setToken, 1);",
    "      this.$store.dispatch('tnc/fetch');",
    "      return this.$store.getters[getterTypes.isX] || this.$store.getters.isY || this.$store.state.login.token;",
    "    },",
    "  },",
    "};",
  ]);
  const s = sym(r, "method", "A.save");
  hasCall(s, { name: "types.setToken", store: "mutation", via: true });
  hasCall(s, { name: "tnc/fetch", store: "action" });
  hasCall(s, { name: "getterTypes.isX", store: "getter", via: true });
  hasCall(s, { name: "isY", store: "getter" });
  hasCall(s, { name: "login.token", store: "state" });
});

test("map helpers: mapped members and calls", () => {
  const r = vue([
    "import * as types from '@/store/mutation-types';",
    "import * as getterTypes from '@/store/getter-types';",
    "export default {",
    "  name: 'A',",
    "  computed: {",
    "    ...mapGetters(['userName', getterTypes.isZ]),",
    "    ...mapState('tnc', ['status']),",
    "    ...mapState({ tok: (state) => state.login.token }),",
    "    ...mapGetters({ alias2: 'other' }),",
    "  },",
    "  methods: {",
    "    ...mapActions('tnc', ['fetch']),",
    "    ...mapMutations([types.setToken]),",
    "  },",
    "};",
  ]);
  const mapped = (q) => r.symbols.find((s) => s.qname === q && s.kind === "method" && s.mapped);
  assert.strictEqual(mapped("A.userName").mapped, "getter");
  assert.strictEqual(mapped("A.status").mapped, "state");
  assert.strictEqual(mapped("A.tok").mapped, "state");
  assert.strictEqual(mapped("A.alias2").mapped, "getter");
  assert.strictEqual(mapped("A.fetch").mapped, "action");
  assert.ok(!r.symbols.some((s) => /isZ|setToken/.test(s.qname)));
  const a = sym(r, "class", "A");
  hasCall(a, { name: "userName", store: "getter" });
  hasCall(a, { name: "getterTypes.isZ", store: "getter", via: true });
  hasCall(a, { name: "tnc.status", store: "state" });
  hasCall(a, { name: "login.token", store: "state" });
  hasCall(a, { name: "other", store: "getter" });
  hasCall(a, { name: "tnc/fetch", store: "action" });
  hasCall(a, { name: "types.setToken", store: "mutation", via: true });
});

test("map helper with a namespace that does not fold", () => {
  const r = vue(["import { DA_NS } from '@/store/modules/tnc';", "export default {", "  name: 'A',", "  computed: {", "    ...mapGetters(DA_NS, ['isTncApproved']),", "  },", "};"]);
  hasCall(sym(r, "class", "A"), { name: "isTncApproved", store: "getter", ns_via: "DA_NS" });
  assert.strictEqual(r.symbols.find((s) => s.qname === "A.isTncApproved").mapped, "getter");
});

test("component fields from data", () => {
  const r = vue(["export default {", "  name: 'A',", "  data() {", "    return {", "      isLoading: false,", "      title: 'x',", "    };", "  },", "};"]);
  assert.deepStrictEqual(sym(r, "field", "A.isLoading").lines, [7, 7]);
  assert.deepStrictEqual(sym(r, "field", "A.title").lines, [8, 8]);
  const b = vue(["export default {", "  name: 'B',", "  data: () => ({ a: 1 }),", "};"], "src/B.vue");
  assert.ok(sym(b, "field", "B.a"));
});

test("action context: bare commit and dispatch in a store module", () => {
  const r = one(
    ["import * as types from '../mutation-types';", "export default {", "  state: { x: 1 },", "  actions: { async load({ commit, dispatch }) { commit(types.setToken, 1); dispatch('other'); } },", "};"].join("\n") + "\n",
    "js",
    "store/modules/m.js"
  );
  const s = sym(r, "method", "m.load");
  hasCall(s, { name: "types.setToken", store: "mutation", via: true });
  hasCall(s, { name: "other", store: "action" });
});

test("no store link from a comment or a string", () => {
  const r = vue(["export default {", "  name: 'A',", "  methods: {", "    go() {", "      // this.$store.commit('x')", "      const s = \"this.$store.dispatch('y')\";", "      return s;", "    },", "  },", "};"]);
  assert.ok(!r.symbols.some((s) => s.calls.some((cc) => cc.store)));
});

test("no store link in a plain Node file", () => {
  const r = one("store.dispatch({ type: 'ADD' });\ngit.commit('msg');\nfunction commit(m) {}\ncommit('local');\n", "js", "lib/r.js");
  assert.ok(!r.symbols.some((s) => s.calls.some((cc) => cc.store)));
});

// ── W28c: listen, prop, emits, i18n, template refs ──
const sfc = (tpl, lines, rel) => one("<template>\n" + tpl + "\n</template>\n<script>\n" + lines.join("\n") + "\n</script>\n", "vue", rel);
const allCalls = (r) => r.symbols.flatMap((s) => s.calls || []);

test("listen and prop calls on a child tag", () => {
  const r = sfc(
    '  <Child :merchant-id="id" title="t" class="x" @close="onClose" @save.native="s" :value.sync="v" v-model="m" />',
    ["import Child from './Child.vue';", "export default {", "  name: 'Parent',", "  components: { Child },", "  methods: { onClose() {}, s() {} },", "};"],
    "src/Parent.vue"
  );
  const cs = allCalls(r);
  const listen = cs.filter((cc) => cc.listen).map((cc) => cc.name);
  const prop = cs.filter((cc) => cc.prop).map((cc) => cc.name);
  for (const n of ["Child.close", "Child.update:value", "Child.input"]) assert.ok(listen.includes(n), n + " in " + listen);
  assert.ok(!listen.includes("Child.save"));
  for (const n of ["Child.merchantId", "Child.title", "Child.value"]) assert.ok(prop.includes(n), n + " in " + prop);
  assert.ok(!prop.includes("Child.class"));
  assert.ok(cs.filter((cc) => cc.listen || cc.prop).every((cc) => cc.line === 2));
});

test("emit symbols from script and template", () => {
  const r = sfc('  <button @click="$emit(\'save\')">x</button>', ["export default {", "  name: 'Child',", "  methods: { done() { this.$emit('close'); this.$eventHub.$emit('show-toast'); } },", "};"], "src/Child.vue");
  assert.ok(sym(r, "emit", "Child.close"));
  assert.ok(sym(r, "emit", "Child.save"));
  assert.ok(!r.symbols.some((s) => s.qname === "Child.show-toast"));
});

test("i18n calls in script and template", () => {
  const r = sfc(
    "  <div :label=\"$t('G.H')\">{{ $t('E.F') }} <!-- {{ $t('X.Y') }} --></div>",
    [
      "import types from './types';",
      "const KEY = 'C.D';",
      "export default {",
      "  name: 'I',",
      "  methods: { go(s) { this.$t('A.B'); this.$t(KEY); i18n.t(types.K); this.$t(`STATUS.${s}`); } },",
      "};",
    ],
    "src/I.vue"
  );
  const ks = allCalls(r).filter((cc) => cc.i18n);
  const has = (name, extra = {}) => assert.ok(ks.some((cc) => cc.name === name && Object.entries(extra).every(([k, v]) => cc[k] === v)), name + " in " + JSON.stringify(ks));
  has("A.B");
  has("C.D");
  has("types.K", { via: true });
  has("STATUS", { prefix: true });
  has("E.F");
  has("G.H");
  assert.ok(!ks.some((cc) => cc.name === "X.Y"));
});

test("template refs keep unknown heads but not JS globals", () => {
  const r = sfc("  <div>{{ title }} {{ formatAmount(x) }} {{ Boolean(y) }}</div>", ["export default {", "  name: 'R',", "  data() { return { title: '' }; },", "};"], "src/R.vue");
  const cs = allCalls(r);
  assert.ok(cs.some((cc) => cc.name === "title" && cc.tpl));
  assert.ok(cs.some((cc) => cc.name === "formatAmount" && cc.tpl));
  assert.ok(!cs.some((cc) => cc.name === "Boolean"));
});

test("template-only component", () => {
  const r = one("<template><div>{{ $t('A') }}</div></template>\n", "vue", "src/T.vue");
  const ks = allCalls(r).filter((cc) => cc.i18n);
  assert.deepStrictEqual(ks.map((cc) => cc.name), ["A"]);
});

test("store read in the template", () => {
  const r = sfc("  <div>{{ $store.getters.isY }}</div>", ["export default {", "  name: 'S',", "};"], "src/S.vue");
  assert.ok(allCalls(r).some((cc) => cc.name === "isY" && cc.store === "getter"));
});

// ── lorc 0.5.0 (W28d): global mixins, route paths, template order + cap ──

test("global mixins", () => {
  const r = one(
    ["import Vue from 'vue';", "import { mixin } from './methods/vueMixins.js';", "import other from './other';", "Vue.mixin({", "  mixins: [mixin],", "});", "Vue.mixin(other);"].join("\n") + "\n",
    "js",
    "src/main.js"
  );
  const all = r.symbols.flatMap((s) => s.global_mixins || []);
  assert.deepStrictEqual(all.sort(), ["mixin", "other"]);
});

test("route path calls in script", () => {
  const r = one(
    [
      "export default {",
      "  methods: {",
      "    go(p) {",
      "      this.$router.push('/settings/webhooks?x=1');",
      "      router.replace({ path: '/a' });",
      "      this.$router.push(p);",
      "      this.$router.push('relative');",
      "    },",
      "  },",
      "};",
    ].join("\n") + "\n",
    "js",
    "src/nav.js"
  );
  const ps = allCalls(r).filter((cc) => cc.path).map((cc) => cc.name);
  assert.deepStrictEqual(ps.sort(), ["/a", "/settings/webhooks"]);
  assert.ok(allCalls(r).filter((cc) => cc.path).every((cc) => cc.route));
});

test("route path calls in the template", () => {
  const r = sfc("  <div><router-link to=\"/b\">b</router-link> <RouterLink :to=\"'/c'\">c</RouterLink></div>", ["export default {", "  name: 'L',", "};"], "src/L.vue");
  const ps = allCalls(r).filter((cc) => cc.path).map((cc) => cc.name);
  assert.deepStrictEqual(ps.sort(), ["/b", "/c"]);
});

test("template order and cap keep the structural links", () => {
  const lines = [];
  for (let n = 1; n <= 250; n++) lines.push(`  <p>{{ $t('K.${n}') }}</p>`);
  lines.push('  <Child @close="x" />');
  const r = sfc("<div>\n" + lines.join("\n") + "\n</div>", ["import Child from './Child.vue';", "export default {", "  name: 'Big',", "  components: { Child },", "  methods: { x() {} },", "};"], "src/Big.vue");
  const t = r.symbols.find((s) => s.kind === "template");
  assert.ok(t);
  assert.ok(t.calls.length <= 400, String(t.calls.length));
  assert.ok(t.calls.some((cc) => cc.name === "Child.close" && cc.listen));
  assert.ok(t.calls.some((cc) => cc.name === "Child" && cc.ref && !cc.tpl));
});

// lorc 0.5.0 (W28h): SPA route full paths, `export const` objects, template locals.
test("nested SPA routes get their full path", () => {
  const r = one(
    [
      "import S from './S.vue';",
      "export const routes = [{ path: '/settings', component: S, children: [{ path: 'webhooks', component: W },",
      "  { path: '', component: H }] }, { path: '/orders', children: [{ path: ':id', component: O }] }];",
      "",
    ].join("\n"),
    "js",
    "src/router/index.js"
  );
  const names = r.symbols.filter((s) => s.kind === "route").map((s) => s.name);
  for (const n of ["VIEW /settings/webhooks", "VIEW /settings", "VIEW /orders/:id"]) assert.ok(names.includes(n), JSON.stringify(names));
  assert.ok(!names.includes("VIEW /webhooks"), JSON.stringify(names));
});

test("export const with a mixin shape is a class with its methods", () => {
  const r = one("export const mixin = { methods: { formatAmount(v) { return v; } } };\n");
  assert.ok(sym(r, "class", "mixin"), JSON.stringify(r.symbols.map((s) => s.qname)));
  assert.ok(sym(r, "method", "mixin.formatAmount"));
  assert.ok(!sym(r, "const", "mixin"));
});

test("slot props and arrow parameters make no template ref", () => {
  const src = [
    "<template>",
    "  <b-table>",
    "    <template #cell(amount)=\"data\">{{ data.value }}</template>",
    "    <button @click=\"(e) => go(e)\" :title=\"list.map(x => x.id)\">{{ total }}</button>",
    "  </b-table>",
    "</template>",
    "<script>",
    "export default { name: 'T', data() { return { total: 0, list: [] }; }, methods: { go() {} } };",
    "</script>",
    "",
  ].join("\n");
  const r = one(src, "vue", "src/T.vue");
  const refs = r.symbols.flatMap((s) => (s.calls || []).filter((c) => c.tpl).map((c) => c.name));
  for (const n of ["data", "e", "x"]) assert.ok(!refs.includes(n), JSON.stringify(refs));
  assert.ok(refs.includes("total"), JSON.stringify(refs));
});
