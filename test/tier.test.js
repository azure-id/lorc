"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const T = require("../bin/lib/tier.js");
const { repo } = require("./prep-fixture.js");

// A temp dir that is NOT a git repo: no git history, no runs.jsonl.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lorc-tier-"));
const run = (request, graph, opts = {}) => T.compute(tmp(), request, Object.assign({ history: false, graph }, opts));
const has = (r, re) => r.why.some((w) => re.test(w));

test("fileScore / tierOf / sizeTier: the table edges", () => {
  const t = (n) => T.tierOf(T.fileScore(n));
  assert.deepStrictEqual([2, 3, 5, 6, 20, 21].map(t), ["low", "mid", "mid", "high", "high", "complex"]);
  assert.deepStrictEqual([2, 3, 5, 6, 20, 21].map(T.sizeTier), ["low", "mid", "mid", "high", "high", "complex"]);
});

test("layerOf", () => {
  assert.strictEqual(T.layerOf("src/components/A.vue"), "ui");
  assert.strictEqual(T.layerOf("server/controllers/x.js"), "api");
  assert.strictEqual(T.layerOf("db/migrations/1.sql"), "data");
  assert.strictEqual(T.layerOf("src/utils/x.js"), "logic");
  assert.strictEqual(T.layerOf("test/x.test.js"), "test");
  assert.strictEqual(T.layerOf("static/i18n/en.json"), "locale");
});

test("2+ new components → high, cap 3, 3 groups, the page first", () => {
  const r = run("add a new settings page with a profile form and a password modal", { ok: true, core: ["src/views/Settings.vue"], layers: ["ui"], projects: ["."] });
  assert.strictEqual(r.tier, "high");
  assert.strictEqual(r.cap, 3);
  assert.strictEqual(r.split.length, 3);
  assert.match(r.split[0].units.join(" "), /page/);
  assert.match(r.why[0], /new components/);
});

test("mechanical guard: a rename is mid, one executor", () => {
  const blast = Array.from({ length: 9 }, (_, i) => `src/c${i}.js`);
  const r = run("rename getUser to fetchUser across the codebase", { ok: true, named: { getUser: ["src/u.js"] }, blast });
  assert.strictEqual(r.tier, "mid");
  assert.strictEqual(r.score, 45);
  assert.ok(r.why.includes("mechanical change: one executor"), JSON.stringify(r.why));
  assert.ok(r.est_files >= 10, String(r.est_files));
});

test("migration: data layer → complex; no data words → high", () => {
  const a = run("migrate the settings to the new format", { ok: true, layers: ["data"] });
  assert.deepStrictEqual([a.tier, a.score], ["complex", 85]);
  assert.ok(has(a, /a data migration/));
  const b = run("migrate the settings to the new format", { ok: true });
  assert.deepStrictEqual([b.tier, b.score], ["high", 60]);
});

test("two areas → high, split by layer", () => {
  const r = run("add a stats endpoint on the server and a stats page", { ok: true });
  assert.strictEqual(r.tier, "high");
  assert.deepStrictEqual(r.split.map((x) => x.layer).sort(), ["api", "ui"]);
});

test("reuse: a generic component that exists is not new", () => {
  const req = "build the route shell with the 4-step stepper and step 1";
  const a = run(req, { ok: true, reuse: { 1: "src/components/Stepper.vue" } });
  const b = run(req, { ok: true });
  assert.strictEqual(a.detail.estimate.added, b.detail.estimate.added - 1);
  assert.ok(has(a, /reuse: Stepper\.vue/), JSON.stringify(a.why));
});

test("hosts: a new piece wires into the feature; a page holds it", () => {
  const g = { ok: true, core: ["src/f/Shell.vue", "src/f/Sib.vue"], hosts: ["src/f/Shell.vue", "src/f/keys.js", "src/f/Sib.vue"], feature: "src/f" };
  assert.strictEqual(run("add a recipient card component", g).detail.estimate.hosts, 2);
  assert.strictEqual(run("add a recipient card component and a recipient page", g).detail.estimate.hosts, 0);
});

test("low: a typo is inline, cap 0, no groups", () => {
  const r = run("fix the typo in the header title", { ok: true });
  assert.deepStrictEqual([r.tier, r.cap, r.groups], ["low", 0, 0]);
  assert.strictEqual(r.detail.executor.inline, true);
});

test("executor: risk floor on a risky path", () => {
  const r = run("fix the typo in the header title", { ok: true, risky: ["src/payments/charge.js"] });
  assert.ok(r.detail.executor.score >= 70);
  assert.strictEqual(r.executor, "opus-5-low");
});

test("executor: history picks a cheaper one with a clean record", () => {
  const req = "add a new settings page with a profile form and a password modal";
  const g = { ok: true, core: ["src/views/Settings.vue"], layers: ["ui"], projects: ["."] };
  const base = run(req, g);
  assert.notStrictEqual(base.executor, "haiku-5-high");
  // 5 runs: the Wilson lower bound of 3 of 3 is 0.44, under the 0.55 bar.
  const runs = Array.from({ length: 5 }, (_, i) => ({ request: `unrelated words ${i}`, tier: base.tier, executor: "haiku-5-high", outcome: "done", findings: {} }));
  const r = T.compute(tmp(), req, { history: true, runs, graph: g });
  assert.strictEqual(r.executor, "haiku-5-high");
  assert.ok(r.detail.executor.record);
});

test("history shift: similar runs one band up → moved", () => {
  const req = "fix the typo in the header title";
  assert.strictEqual(run(req, { ok: true }).tier, "low");
  const runs = Array.from({ length: 5 }, () => ({ request: req, tier: "mid", src_files: 1 }));
  const r = T.compute(tmp(), req, { history: true, runs, graph: { ok: true } });
  assert.strictEqual(r.detail.history_shift, "moved");
  assert.strictEqual(r.tier, "mid");
});

test("confidence in 0.1–0.95; no graph in why", () => {
  for (const req of ["fix the typo", "add a stats endpoint on the server and a stats page", "migrate the settings to the new format"]) {
    for (const g of [{ ok: true }, { ok: false, reason: "x" }]) {
      const r = run(req, g);
      assert.ok(r.conf >= 0.1 && r.conf <= 0.95, String(r.conf));
    }
  }
  assert.ok(run("fix the typo", { ok: false, reason: "x" }).why.includes("no graph: x"));
});

test("brief: the compact keys only", () => {
  const hi = T.brief(run("add a stats endpoint on the server and a stats page", { ok: true }));
  assert.deepStrictEqual(Object.keys(hi).sort(), ["cap", "conf", "est_files", "executor", "groups", "score", "split", "tier", "why"]);
  assert.ok(hi.why.length <= 3);
  const lo = T.brief(run("fix the typo in the header title", { ok: true }));
  assert.ok(!("split" in lo) && !("detail" in lo));
});

test("CLI: lorc tier --json, --brief, text, no request", () => {
  const e = repo();
  const req = "add a settings page with a profile form";
  let r = e.lorc(["tier", req, "--json"]);
  assert.strictEqual(r.status, 0, r.stderr);
  let o = JSON.parse(r.stdout);
  for (const k of ["tier", "why", "detail"]) assert.ok(k in o, k);
  r = e.lorc(["tier", req, "--json", "--brief"]);
  assert.strictEqual(r.status, 0, r.stderr);
  o = JSON.parse(r.stdout);
  assert.ok(o.tier && !("detail" in o));
  r = e.lorc(["tier", req]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith("Tier: "), r.stdout);
  assert.strictEqual(e.lorc(["tier"]).status, 2);
});

test("CLI: lorc tier eval", () => {
  const e = repo();
  const runs = [
    { slug: "r1", request: "add a stats page", tier: "mid", src_files: 4 },
    { slug: "r2", request: "fix the typo in the header", tier: "low", src_files: 1 },
  ];
  e.write(".claude/lorc/runs.jsonl", runs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  let r = e.lorc(["tier", "eval", "--json", "--recompute", "--no-history"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).rows.length, 2);
  e.write(".claude/lorc/run/r1/prep.json", JSON.stringify({ tier_engine: { tier: "mid", est_files: 3 } }));
  e.write(".claude/lorc/run/r2/prep.json", JSON.stringify({ tier_engine: { tier: "low", est_files: 1 } }));
  r = e.lorc(["tier", "eval", "--json"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.runs, 2);
  assert.strictEqual(o.engine_vs_final.n, 2);
  assert.strictEqual(typeof o.est_files_mae, "number");
});

test("layerOf: other languages", () => {
  const k = {
    "shop/models.py": "data", "shop/views.py": "api", "shop/urls.py": "api", "app/routers/orders.py": "api",
    "internal/handlers/order_handler.go": "api", "internal/order/service.go": "logic", "internal/router.go": "api",
    "src/main/java/com/x/OrderController.java": "api", "src/main/java/com/x/entity/Order.java": "data",
    "app/src/main/java/com/x/ui/OrderActivity.kt": "ui", "app/controllers/orders_controller.rb": "api",
    "db/migrate/20260101_add_total.rb": "data", "config/routes.rb": "api", "routes/web.php": "api",
    "App/OrderViewController.swift": "ui", "lib/screens/order_screen.dart": "ui",
  };
  for (const [f, want] of Object.entries(k)) assert.strictEqual(T.layerOf(f), want, f);
});

test("type nouns count half; a small schema migration is high", () => {
  assert.strictEqual(run("add a struct and an interface for the payment gateway client", { ok: true }).tier, "mid");
  const m = run("add a column total to the orders table with a migration", { ok: true });
  assert.deepStrictEqual([m.tier, m.score], ["high", 58]);
  assert.ok(has(m, /small schema migration/));
  assert.strictEqual(run("migrate the orders table to split first and last name", { ok: true }).tier, "complex");
});

test("Python repo: a rename counts the files that import the name (graph built for real)", () => {
  const e = repo({
    "pyproject.toml": "[project]\nname = \"shop\"\n",
    "shop/serializers.py": "class OrderSerializer:\n    pass\n",
    "shop/views.py": "from .serializers import OrderSerializer\n\nclass OrderViewSet:\n    serializer_class = OrderSerializer\n",
  });
  assert.strictEqual(e.lorc(["graph", "update", "--json"]).status, 0);
  const r = e.lorc(["tier", "rename OrderSerializer to OrderReadSerializer everywhere", "--json", "--no-history"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepStrictEqual(o.detail.graph.blast, ["shop/views.py"]);
  assert.strictEqual(o.est_files, 2);
  assert.strictEqual(o.tier, "low");
});

const SHOP = {
  "pyproject.toml": "[project]\nname = \"shop\"\n",
  "shop/serializers.py": "class OrderSerializer:\n    pass\n",
  "shop/views.py": "from .serializers import OrderSerializer\n\nclass OrderViewSet:\n    serializer_class = OrderSerializer\n",
};
const RENAME = "rename OrderSerializer to OrderReadSerializer everywhere";

test("CLI heal: lorc tier builds the graph first", () => {
  const e = repo(SHOP);
  const r = e.lorc(["tier", RENAME, "--json", "--no-history"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(e.root, ".claude", "lorc", "orc", "graph", "meta.json")));
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.detail.graph.source, "graph");
  assert.strictEqual(o.est_files, 2);
});

test("CLI --no-heal: no graph is built, the git part gives the facts", () => {
  const e = repo(SHOP);
  const r = e.lorc(["tier", RENAME, "--json", "--no-history", "--no-heal"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(e.root, ".claude", "lorc", "orc", "graph", "meta.json")));
  const o = JSON.parse(r.stdout);
  assert.strictEqual(o.detail.graph.source, "git");
  assert.deepStrictEqual(o.detail.graph.blast, ["shop/views.py"]);
  assert.deepStrictEqual(o.detail.graph.named.OrderSerializer, ["shop/serializers.py"]);
  assert.strictEqual(o.est_files, 2);
  assert.ok(has(o, /related files from git paths/), JSON.stringify(o.why));
});

test("git part: path words rank the payout form over unrelated files", () => {
  const e = repo({
    "src/payouts/PayoutForm.vue": "<template><form></form></template>\n",
    "src/payouts/payoutApi.js": "module.exports = {};\n",
    "src/orders/OrderList.vue": "<template><ul></ul></template>\n",
    "src/shared/Button.vue": "<template><button></button></template>\n",
  });
  const r = T.compute(e.root, "add a payout summary card to the payout form", { graph: { ok: false, reason: "x" }, gitFallback: true, history: false });
  assert.strictEqual(r.detail.graph.source, "git");
  assert.ok(r.detail.graph.core.includes("src/payouts/PayoutForm.vue"), JSON.stringify(r.detail.graph.core));
  assert.ok(!r.detail.graph.core.includes("src/orders/OrderList.vue"));
});

test("injected failed graph without gitFallback: no git part", () => {
  const e = repo(SHOP);
  const r = T.compute(e.root, RENAME, { graph: { ok: false, reason: "x" }, history: false });
  assert.notStrictEqual(r.detail.graph.source, "git");
  assert.ok(r.why.includes("no graph: x"), JSON.stringify(r.why));
});

test("git part outside a git repo fails quietly", () => {
  const r = run(RENAME, { ok: false, reason: "x" }, { gitFallback: true });
  assert.ok(r.why.includes("no graph: x"), JSON.stringify(r.why));
});

test("confidence: core from the graph counts more than core from git", () => {
  const req = "change the label in the payout form";
  const g = run(req, { ok: true, core: ["src/a.js"] });
  const s = run(req, { ok: true, source: "git", core: ["src/a.js"] });
  assert.ok(Math.abs(g.conf - s.conf - 0.07) <= 0.001, `${g.conf} ${s.conf}`);
});

test("a graph that reads none of the files (Swift) → the git part; a resolved name does not rank paths", () => {
  const e = repo({
    "App/Orders/OrderListView.swift": "struct OrderListView {}\n",
    "App/Orders/OrderService.swift": "struct OrderService {\n  func fetchOrders() {}\n}\n",
    "App/Payments/PaymentService.swift": "struct PaymentService {}\n",
  });
  const a = JSON.parse(e.lorc(["tier", "add an order detail screen for orders", "--json", "--no-history"]).stdout);
  assert.strictEqual(a.detail.graph.source, "git");
  assert.ok(a.detail.graph.core.includes("App/Orders/OrderListView.swift"), JSON.stringify(a.detail.graph.core));
  assert.ok(a.why.some((w) => /the graph found no related file/.test(w)));
  const b = JSON.parse(e.lorc(["tier", "rename OrderService to OrderRepository everywhere", "--json", "--no-history"]).stdout);
  assert.deepStrictEqual(b.detail.graph.core, ["App/Orders/OrderService.swift"]);
  assert.ok(!b.why.some((w) => /^risk/.test(w)), b.why.join(" | "));
});

test("calibration through compute: learned factor scales the raw estimate", () => {
  const runs = [4, 5, 6, 5, 6].map((k, i) => ({ slug: "c" + i, request: "x", tier: "mid", src_files: 2 * k, est_raw: k }));
  const req = "add a new settings page with a profile form";
  const r = T.compute(tmp(), req, { graph: { ok: true }, runs });
  assert.strictEqual(r.detail.estimate.raw, 3, JSON.stringify(r.detail.estimate));
  assert.strictEqual(r.est_files, 6);
  assert.ok(has(r, /calibrated ×2 from 5 runs/), JSON.stringify(r.why));
  const off = T.compute(tmp(), req, { graph: { ok: true }, runs, history: false });
  assert.strictEqual(off.est_files, 3);
  assert.ok(!has(off, /calibrated/));
});

test("Indonesian end to end", () => {
  assert.strictEqual(run("migrasikan tabel orders untuk memisahkan nama depan dan belakang", { ok: true }).tier, "complex");
  assert.strictEqual(run("buat komponen kartu penerima dan modal konfirmasi", { ok: true }).tier, "high");
});

test("evaluate returns a calibration object", () => {
  const e = repo();
  const runs = [
    { slug: "r1", request: "add a stats page", tier: "mid", src_files: 4 },
    { slug: "r2", request: "fix the typo in the header", tier: "low", src_files: 1 },
  ];
  e.write(".claude/lorc/runs.jsonl", runs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const o = T.evaluate(e.root);
  assert.ok(o.calibration && typeof o.calibration === "object", JSON.stringify(o));
  assert.strictEqual(typeof o.calibration.factor, "number");
});
