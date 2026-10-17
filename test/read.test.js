"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { repo } = require("./prep-fixture.js");
const runs = require("../bin/lib/runs.js");
const C = require("../bin/lib/context.js");

const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

function fixture() {
  const e = repo({
    "src/router/index.js": lines(80, (i) => `// router line ${i}`),
    "src/api/pay.api.js": "const a = 1;\nexport function getPay() {\n  return a;\n}\nexport function getRate() {\n  return 2;\n}\nexport {\n  a,\n};\n",
    "src/i18n/en.json": lines(30, (i) => `"K${i}": "v${i}",`),
    "src/keys.js": "export const A = 1;\nexport const B = 2;\n",
    "src/Swap.vue": "<template>\n  <div class=\"swap\"></div>\n</template>\n<script>\nexport default {\n  methods: {\n    onAmountChange() {\n      return 1;\n    },\n    unrelated() {\n      return 2;\n    },\n  },\n};\n</script>\n<style>\n.swap__box {\n  color: red;\n}\n</style>\n",
    "test/Swap.spec.js": "const x = 1;\nconst renderSwap = () => {\n  return x;\n};\ndescribe('swap amount', () => {\n  it('changes the amount', () => {\n    expect(1).toBe(1);\n  });\n});\n",
    "doc.md": "# Pay\nShow the amount.\n",
  });
  const slug = runs.startRun(e.root, { request: "pay amount rate", doc: "doc.md", now: Date.UTC(2026, 9, 17, 9, 0) }).slug;
  const pack = {
    targets: [
      { kind: "route", file: "src/router/index.js", start: 10, end: 40, what: "/pay", why: "parent route with children" },
      { kind: "insert", file: "src/router/index.js", start: 60, end: 60, what: "", why: "insertion point" },
      { kind: "api", file: "src/api/pay.api.js", start: 2, end: 7, what: "exports: getPay · 2; getRate · 5", why: "API module" },
      { kind: "i18n", file: "src/i18n/en.json", start: 5, end: 12, what: "PAY keys", why: "locale block of the feature" },
      { kind: "constants", file: "src/keys.js", start: 1, end: 2, what: "feature constants", why: "feature constants" },
    ],
    exemplars: [{ kind: "exemplar", file: "src/Swap.vue", start: 5, end: 14, what: "class 5-14 · methods: onAmountChange 7, unrelated 10" }],
    tests: [{ kind: "test", file: "test/Swap.spec.js", start: 1, end: 4, what: "setup" }],
    reuse: [],
    entities: [{ name: "swap__box", type: "class", at: ["src/Swap.vue:17-19"] }],
  };
  fs.writeFileSync(path.join(runs.runDir(e.root, slug), "context.json"), JSON.stringify(pack));
  fs.writeFileSync(path.join(runs.runDir(e.root, slug), "context.md"), "# Context\n- src/api/pay.api.js:2-7\n");
  return { e, slug, pack };
}

test("readPlan: targets, matching methods, CSS, test setup + helper + first it; merged ranges", () => {
  const { e, pack } = fixture();
  const plan = C.readPlan(e.root, pack, { files: ["src/router/index.js", "src/api/pay.api.js", "src/i18n/en.json", "src/keys.js", "src/New.vue"], refs: ["src/Swap.vue:5-14"], words: "pay amount", loaded: null });
  const of = (f) => (plan.find((p) => p.file === f) || { ranges: [] }).ranges;
  assert.deepStrictEqual(of("src/router/index.js"), [[10, 21], [48, 72]]);
  assert.deepStrictEqual(of("src/api/pay.api.js"), [[5, 10]]);
  assert.deepStrictEqual(of("src/i18n/en.json"), [[5, 12]]);
  assert.deepStrictEqual(of("src/keys.js"), [[1, 2]]);
  const swap = of("src/Swap.vue");
  assert.ok(swap.some(([a, b]) => a <= 7 && b >= 9), JSON.stringify(swap));
  assert.ok(swap.some(([a, b]) => a <= 17 && b >= 19), "CSS range");
  assert.ok(!swap.some(([a]) => a === 1), "no template dump");
  assert.deepStrictEqual(of("test/Swap.spec.js"), [[1, 4]]);
});

test("readPlan: never more than the budget; refs with several ranges", () => {
  const { e, pack } = fixture();
  const small = C.readPlan(e.root, pack, { files: ["src/router/index.js"], words: "pay", budget: 600, loaded: null });
  const cost = small.reduce((n, p) => n + p.ranges.reduce((m, [a, b]) => m + (b - a + 1), 0), 0);
  assert.ok(cost > 0 && cost < 20, String(cost));
  assert.deepStrictEqual(C.parsePlanRefs(["a.js:1-5,9-12 — why", "b.vue"]), [
    { file: "a.js", ranges: [[1, 5], [9, 12]], why: "why" }, { file: "b.vue", ranges: [], why: "" }]);
});

test("lorc slice writes plan-<n>.json + a Read first line; lorc read prints it; main plan holds the doc", () => {
  const { e, slug } = fixture();
  const input = JSON.stringify({ title: "Pay amount page", files: ["src/router/index.js", "src/api/pay.api.js", "src/New.vue"], accept: ["amount shows"] });
  const r = e.lorc(["slice", "--run", slug, "--task", "1", "-"], input);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.ok(o.read && o.read.ranges > 0);
  const md = fs.readFileSync(o.path, "utf8");
  assert.ok(md.indexOf("## Read first — ONE call") > md.indexOf("## Task"));
  const rf = path.join(runs.runDir(e.root, slug), "read-1.md");
  assert.ok(md.includes(`Read ${rf} (ONE Read call, ${fs.statSync(rf).size} B)`), md);
  assert.ok(fs.readFileSync(rf, "utf8").includes("10│// router line 10"));
  assert.ok(fs.existsSync(path.join(runs.runDir(e.root, slug), "plan-1.json")));
  const t = e.lorc(["read", "--run", slug, "--task", "1"]);
  assert.strictEqual(t.status, 0, t.stderr);
  assert.ok(/^== src\/router\/index\.js:10-21 — parent route ==$/m.test(t.stdout), t.stdout);
  assert.ok(t.stdout.includes("10│// router line 10"));
  assert.ok(/\(\d+ ranges, \d+ B — read more only for what is missing\)\n$/.test(t.stdout));
  const m = e.lorc(["read", "--run", slug]);
  assert.strictEqual(m.status, 0, m.stderr);
  assert.ok(m.stdout.includes("== doc.md:1-2 — requirement doc =="), m.stdout);
  assert.ok(Buffer.byteLength(m.stdout) <= 20480 + 200);
  // A missing file: one line, no error.
  fs.rmSync(path.join(e.root, "src/api/pay.api.js"));
  const x = e.lorc(["read", "--run", slug, "--task", "1"]);
  assert.strictEqual(x.status, 0);
  assert.ok(x.stdout.includes("(missing src/api/pay.api.js)"));
  assert.strictEqual(e.lorc(["read", "--run", slug, "--task", "9"]).status, 2);
});
