"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const af = require("../bin/lib/ask-facts.js");

const HAS_GIT = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

function gitRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-ask-"));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  }
  const g = (...a) => spawnSync("git", a, { cwd: root, windowsHide: true });
  g("init", "-q"); g("add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return root;
}

const FILES = {
  "src/router/index.js": "export default [\n  { path: 'outwards/:id', component: X },\n  // Declared after 'outwards/create' so the id route does not catch it\n];\n",
  "tests/unit/Layout.spec.js": "it('opens', () => { push('/remittances/outwards/create'); });\n",
  "wiki/routing.md": "The remittance page is at '/remittance/outward/transfer-fund'.\n",
  "src/api/remittance.api.js": "export const list = () => get('/dashboard/remittance/outward');\n",
  "src/views/Home.js": "import X from '@/views/outward/X.vue';\n",
};

test("stems: stop words dropped, 6-letter stems, max 12", () => {
  assert.deepStrictEqual(af.stems("Create the outwards remittance button"), ["outwar", "remitt"]);
  const many = af.stems(Array.from({ length: 20 }, (_, i) => "word" + String.fromCharCode(97 + i) + "zzzz").join(" "));
  assert.strictEqual(many.length, 12);
  assert.ok(many.every((s) => s.length === 6));
});

test("addsRoute: route words, engine creates a UI unit, or neither", () => {
  assert.strictEqual(af.addsRoute("add a new page for transfers", null), true);
  assert.strictEqual(af.addsRoute("add transfers", { detail: { text: { creates: [{ noun: "page" }] } } }), true);
  assert.strictEqual(af.addsRoute("fix the typo in the tooltip", { detail: { text: { creates: [] } } }), false);
});

test("definedPaths: vue, django and rails forms, with the 2-segment tail", () => {
  const d = af.definedPaths("{ path: 'outwards/:id' }\npath(\"users/new\", v)\nget '/a/b/c'\n");
  for (const p of ["outwards/:id", "users/new", "a/b/c", "b/c"]) assert.ok(d.has(p), p);
});

test("routeHints: ranks router + test first, drops api, imports and defined paths", (t) => {
  if (!HAS_GIT) return t.skip("git is missing");
  const root = gitRepo(FILES);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = af.routeHints(root, "src/router/index.js", ["outwar", "remitt"]);
  assert.strictEqual(h[0].path, "/remittances/outwards/create", JSON.stringify(h));
  assert.ok(h[0].at.some((a) => a.startsWith("src/router/index.js:")));
  assert.ok(h[0].at.some((a) => a.startsWith("tests/unit/Layout.spec.js:")));
  const paths = h.map((e) => e.path);
  const wiki = paths.indexOf("/remittance/outward/transfer-fund");
  assert.ok(wiki > 0, JSON.stringify(paths));
  assert.ok(!paths.includes("/dashboard/remittance/outward"));
  assert.ok(!paths.some((p) => p.includes("views/outward") || p.includes("outwards/:id")));
});

test("mustAsk: no router, a typo request, a route request", (t) => {
  if (!HAS_GIT) return t.skip("git is missing");
  const root = gitRepo(FILES);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = { detail: { graph: { router: "src/router/index.js" }, text: { creates: [] } } };
  assert.deepStrictEqual(af.mustAsk(root, "Add the outwards remittance page", { engine: { detail: { graph: {}, text: { creates: [] } } } }), []);
  assert.deepStrictEqual(af.mustAsk(root, "Fix the typo in the balance tooltip text", { engine }), []);
  const m = af.mustAsk(root, "Add the outwards remittance create page", { engine });
  assert.strictEqual(m.length, 1);
  assert.ok(m[0].q.includes("src/router/index.js"));
  assert.strictEqual(m[0].seen[0].path, "/remittances/outwards/create");
});
