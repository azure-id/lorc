"use strict";
// W19d: the extractor fixes F1–F9 (R10 section 5), one fixture per fix, and a
// no-change check on six lorc source files against a snapshot.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const X = require("../bin/lib/graph/graph-extract.js");

const ROOT = path.join(__dirname, "..");
const one = (src, lang = "js", rel = "a.js") => X.extractOne({ rel, lang, src });
const sym = (r, kind, qname) => r.symbols.find((s) => s.kind === kind && s.qname === qname);

test("F1: a paren-wrapped default object is a class with methods", () => {
  const r = one(
    [
      "const state = { show: true };",
      "const mutations = {",
      "  [types.toggle](state) { state.show = !state.show; },",
      "};",
      "const getters = { getShow: (state) => state.show };",
      "export default ({ state, mutations, getters });",
    ].join("\n") + "\n",
    "js",
    "store/modules/sidebar.js"
  );
  assert.deepStrictEqual(sym(r, "class", "sidebar").lines, [6, 6]);
  assert.strictEqual(sym(r, "method", "sidebar.toggle").lines[0], 3);
  assert.strictEqual(sym(r, "method", "sidebar.getShow").lines[0], 5);
  // The wrapper paren is not a call to `default`.
  assert.ok(!r.symbols.some((s) => s.calls.some((c) => c.name === "default")));
});

test("F1: `export default ({ a }) => …` stays an arrow function", () => {
  const r = one("export default ({ a }) => { foo(a); };\n");
  assert.ok(!r.symbols.some((s) => s.kind === "class"));
});

test("F2: a local declaration exported by name", () => {
  const r = one(
    [
      "const INVOICE_STATUS = { PAID: 'paid', DRAFT: 'draft' };",
      'const ROLE_ADMIN = "Admin";',
      "const mixin = {",
      "  methods: { can(p) { return !!p; } },",
      "};",
      "const usersData = [{ name: 'a' }];",
      "export { INVOICE_STATUS, ROLE_ADMIN, mixin };",
      "export default usersData;",
    ].join("\n") + "\n"
  );
  assert.strictEqual(sym(r, "const", "INVOICE_STATUS").lines[0], 1);
  assert.strictEqual(sym(r, "const", "ROLE_ADMIN").lines[0], 2);
  assert.strictEqual(sym(r, "class", "mixin").lines[0], 3);
  assert.strictEqual(sym(r, "method", "mixin.can").lines[0], 4);
  assert.strictEqual(sym(r, "const", "usersData").lines[0], 6);
  assert.ok(r.symbols.filter((s) => s.kind !== "module").every((s) => s.kind === "method" || s.exported));
});

test("F3: a URL through a file constant", () => {
  const r = one(
    [
      "const BASE = '/dashboard/remittance';",
      "const LIST = `${BASE}/recipients`;",
      "export const getRecipients = (q) => httpClient.dashboardService.get(LIST, { params: q });",
      "export const getOne = (id) => httpClient.dashboardService.get(LIST + '/' + id);",
    ].join("\n") + "\n"
  );
  const a = sym(r, "function", "getRecipients");
  assert.deepStrictEqual(
    a.urls.map((u) => ({ method: u.method, url: u.url })),
    [{ method: "GET", url: "/dashboard/remittance/recipients" }]
  );
  const b = sym(r, "function", "getOne");
  assert.ok(b.urls[0].url.startsWith("/dashboard/remittance/recipients/"), b.urls[0].url);
});

test("F4: a multi-declarator list gives each function", () => {
  const r = one(
    [
      "const",
      "    LIST = '/dashboard/products/',",
      '    DEL = "dashboard/products/";',
      "const",
      "    listProduct = (q) => httpClient.dashboardService.get(LIST, { params: q }),",
      "    deleteProduct = (id) => httpClient.dashboardService.delete(DEL + id);",
      "export { listProduct, deleteProduct };",
    ].join("\n") + "\n"
  );
  const a = sym(r, "function", "listProduct");
  const b = sym(r, "function", "deleteProduct");
  assert.strictEqual(a.lines[0], 5);
  assert.strictEqual(b.lines[0], 6);
  assert.ok(a.exported && b.exported);
});

test("F5: a name-only SFC is a class, with no `const name`", () => {
  const r = one("<template><div>404</div></template>\n<script>\nexport default {\n  name: 'Page404'\n};\n</script>", "vue", "views/pages/Page404.vue");
  assert.strictEqual(sym(r, "class", "Page404").lines[0], 3);
  assert.ok(!r.symbols.some((s) => s.kind === "const" && s.name === "name"));
});

test("F6: a describe block owns the calls inside it", () => {
  const r = one(
    [
      "import { logout } from '@/api/login.api.js';",
      "describe('login.api', () => {",
      "  it('logout posts', async () => {",
      "    await logout();",
      "    expect(ds.post).toHaveBeenCalled();",
      "  });",
      "});",
    ].join("\n") + "\n",
    "js",
    "tests/unit/api/login.api.spec.js"
  );
  const t = r.symbols.find((s) => s.kind === "test" && s.name === "login.api");
  assert.ok(t);
  assert.deepStrictEqual(t.lines, [2, 7]);
  assert.ok(t.calls.some((c) => c.name === "logout" && c.line === 4));
  assert.ok(!r.symbols.some((s) => s.kind === "test" && s.name === "logout posts"));
});

test("F6: describe.only / .each blocks are test blocks too", () => {
  const r = one("describe.only('a', () => { f(); });\ndescribe.each([[1], [2]])('b %i', (n) => { g(n); });\nit('c', () => { h(); });\n");
  assert.deepStrictEqual(r.symbols.filter((s) => s.kind === "test").map((s) => s.name), ["a", "b %i"]);
});

test("F7: functions assigned to module.exports", () => {
  const r = one("module.exports.assertion = function () {};\n");
  const a = sym(r, "function", "assertion");
  assert.strictEqual(a.lines[0], 1);
  assert.ok(a.exported);
  const r2 = one("module.exports = {\n  before: function (b) { b.go(); },\n  n: 1,\n};\n");
  assert.ok(sym(r2, "function", "before"));
  assert.ok(sym(r2, "const", "n"));
});

test("F8: an import-then-export barrel gives re-exports", () => {
  const r = one("import A from './A';\nexport { A };\n");
  assert.deepStrictEqual(r.reexports, [{ from: "./A", names: [{ local: "A", orig: "default" }] }]);
});

test("F9: a locale JSON file gives a key table", () => {
  const r = one('{\n  "A": {\n    "B": "x",\n    "C": {\n      "D": "y"\n    }\n  }\n}', "i18n", "static/i18n/en.json");
  assert.deepStrictEqual(r, { symbols: [], imports: [], keys: [["A", 2], ["A.B", 3], ["A.C", 4], ["A.C.D", 5]] });
});

test("F9: arrays are skipped, invalid JSON gives keys, extractBatch routes i18n", () => {
  const src = '{\n  "L": [\n    { "X": 1 }\n  ],\n  "M": "m",\n  "N": {\n    "O": "o"\n';
  const out = X.extractBatch([{ rel: "locales/id.json", lang: "i18n", src }], { root: ROOT });
  const r = out.get("locales/id.json");
  assert.deepStrictEqual(r.keys, [["L", 2], ["M", 5], ["N", 6], ["N.O", 7]]);
  assert.ok(!r.error);
});

test("no change: six lorc source files match the snapshot", () => {
  const files = ["bin/lib/paths.js", "bin/lib/json.js", "bin/lib/wait.js", "bin/lib/stats.js", "bin/lib/usage.js", "bin/lib/behaviour.js"];
  const snap = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "graph-extract-snapshot.json"), "utf8"));
  const out = X.extractBatch(
    files.map((rel) => ({ rel, lang: "js", src: fs.readFileSync(path.join(ROOT, rel), "utf8") })),
    { root: ROOT }
  );
  for (const rel of files) assert.deepStrictEqual(out.get(rel).symbols.map((s) => `${s.name}|${s.kind}|${s.lines.join("-")}`), snap[rel], rel);
});

test("F6b: test-framework helper calls are dropped before the cap", () => {
  const lines = ["import { a, b, c } from '../src/x.js';", "describe('big', () => {"];
  for (let i = 0; i < 50; i++) lines.push("  it('t', () => { expect(wrapper.vm.x).toBe(1); jest.fn(); });");
  lines.push(
    "  it('tl', async () => { container.querySelector('x'); getByText('a'); getAllByRole('b'); queryByText('c');",
    "    queryAllByRole('d'); await findByText('e'); await findAllByRole('f'); localVue.use(P); await this.$nextTick();",
    "    setTimeout(f, 1); setImmediate(f); jest.spyOn(o, 'm'); spy.mockClear(); spy.mockReset(); spy.mockRestore(); });"
  );
  lines.push("  it('src', () => { a(); b(); c(); });", "});");
  const r = one(lines.join("\n") + "\n", "js", "tests/unit/x.spec.js");
  assert.strictEqual(r.coverage, "full");
  const t = r.symbols.find((s) => s.kind === "test" && s.name === "big");
  assert.deepStrictEqual(t.calls.map((x) => x.name), ["a", "b", "c"]);
});
