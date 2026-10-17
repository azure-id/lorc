"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const h = require("../bin/lib/tier-history.js");

const c = (files, a = 0, m = 0, s = "x") => ({ h: "h", s, files, a, m });

test("kindOf and isSrc", () => {
  assert.strictEqual(h.kindOf("src/a.js"), "src");
  assert.ok(h.isSrc("src/a.js"));
  for (const f of ["test/a.test.js", "src/a.spec.ts"]) assert.strictEqual(h.kindOf(f), "test", f);
  for (const f of ["static/i18n/en.json", "src/locales/id.json"]) assert.strictEqual(h.kindOf(f), "locale", f);
  assert.strictEqual(h.kindOf("README.md"), "doc");
  for (const f of ["package-lock.json", "dist/x.js", "vendor/x.js"]) assert.strictEqual(h.kindOf(f), "noise", f);
  assert.ok(!h.isSrc("README.md"));
});

test("bag and overlap", () => {
  const b = h.bag("Add the RecipientDetails step, updating fields");
  for (const w of ["recipient", "detail", "step", "field"]) assert.ok(b.has(w), w);
  assert.ok(!b.has("add") && !b.has("the"));
  assert.strictEqual(h.overlap(new Set(["a1", "b1"]), new Set(["a1", "c1"])).score, 0);
  const o = h.overlap(new Set(["a1", "b1", "c1"]), new Set(["a1", "b1", "d1", "e1"]));
  assert.strictEqual(o.shared, 2);
  assert.strictEqual(o.score, 2 / Math.sqrt(12));
});

test("parseLog", () => {
  const log = "\x1eabc123\x1fsubject one\nA\tsrc/new.js\nM\tsrc/old.js\nM\ttest/old.test.js\nD\tsrc/gone.js\nM\tpackage-lock.json\n" +
    "\x1edef456\x1fsubject two\nsrc/plain.js\n";
  const [x, y] = h.parseLog(log);
  assert.strictEqual(x.h, "abc123");
  assert.strictEqual(x.s, "subject one");
  assert.deepStrictEqual(x.files, ["src/new.js", "src/old.js", "test/old.test.js"]);
  assert.strictEqual(x.a, 1);
  assert.strictEqual(x.m, 1);
  assert.deepStrictEqual(y.files, ["src/plain.js"]);
  assert.strictEqual(y.m, 1);
  assert.strictEqual(y.a, 0);
});

test("coChange", () => {
  const big = ["src/a.js"];
  for (let i = 0; i < 61; i++) big.push(`src/big${i}.js`);
  const list = [
    c(["src/a.js", "src/b.js", "src/c.js", "test/a.test.js"]),
    c(["src/a.js", "src/b.js", "src/c.js", "test/a.test.js"]),
    c(["src/a.js", "src/b.js", "test/a.test.js"]),
    c(["src/a.js", "src/b.js", "test/a.test.js"]),
    c(["src/a.js"]),
    c(big), c(big), c(big),
  ];
  const r = h.coChange(list, ["src/a.js"]);
  assert.deepStrictEqual(r, [{ file: "src/b.js", with: "src/a.js", support: 4, conf: 0.8 }]);
});

test("similarCommits", () => {
  const list = [
    c(["src/r1.js", "src/r2.js"], 0, 2, "refund button on payments page"),
    c(["src/r3.js"], 0, 1, "payments refund flow"),
    c(["src/r4.js", "src/r5.js", "src/r6.js"], 0, 3, "refund payments endpoint"),
    c(["src/r7.js"], 0, 1, "payments refund again"),
    c(["src/z.js"], 0, 1, "unrelated thing entirely"),
    c(["README.md"], 0, 0, "refund payments docs only"),
  ];
  const r = h.similarCommits(list, "add a refund button to payments", { k: 7 });
  assert.strictEqual(r.n, 4);
  assert.strictEqual(r.median_src, 1.5);
  assert.strictEqual(r.samples.length, 3);
  assert.strictEqual(h.similarCommits(list, "refund").n, 0);
});

test("similarCommits: IDF weights a rare shared word over a common one", () => {
  const idf = h.idfOf([new Set(["page", "refund"]), new Set(["page", "x1"]), new Set(["page", "y1"]), new Set(["page", "z1"])]);
  assert.ok(idf("refund") > idf("page"));
  const a = new Set(["page", "refund", "button"]);
  const rare = h.weightedOverlap(a, new Set(["refund", "button", "page"]), idf);
  assert.ok(Math.abs(rare.score - 1) < 1e-9);
  // Same shared count (2): the pair with the rare word scores higher.
  const withRare = h.weightedOverlap(a, new Set(["refund", "page", "z1"]), idf).score;
  const common = h.weightedOverlap(new Set(["page", "z1", "q1"]), new Set(["page", "z1", "refund"]), idf).score;
  assert.ok(withRare > 0 && common > 0);
  // Plain overlap ties A and B (2 of 3 words each); IDF ranks B (the rare word "payout") first.
  const subjects = [
    c(["src/a.js"], 0, 1, "page summary tidy"),
    c(["src/b.js"], 0, 1, "payout page tidy"),
    ...Array.from({ length: 15 }, (_, i) => c(["src/x.js"], 0, 1, `page w${i}`)),
    ...Array.from({ length: 15 }, (_, i) => c(["src/x.js"], 0, 1, `summary q${i}`)),
  ];
  const r = h.similarCommits(subjects, "payout summary page", { k: 2 });
  assert.strictEqual(r.samples[0].s, "payout page tidy");
});

test("similarCommits: dynamic k picks the smallest spread of 3, 5, 7", () => {
  assert.strictEqual(h.spread([2, 2, 2]), 0);
  const mk = (n, s) => c(Array.from({ length: n }, (_, i) => `src/f${i}.js`), 0, n, s);
  // The top 3 agree (2 files); hits 4–7 are wide: k = 3.
  const list = [mk(2, "payout refund page a1"), mk(2, "payout refund page a2"), mk(2, "payout refund page a3"),
    mk(9, "payout refund b1"), mk(1, "payout refund b2"), mk(14, "payout refund b3"), mk(1, "payout refund b4")];
  const r = h.similarCommits(list, "payout refund page");
  assert.strictEqual(r.k, 3);
  assert.strictEqual(r.n, 3);
  assert.strictEqual(r.median_src, 2);
  // All 7 agree after a wide top 3: k = 7.
  const l2 = [mk(1, "payout refund page a1"), mk(9, "payout refund page a2"), mk(2, "payout refund page a3"),
    mk(4, "payout refund b1"), mk(4, "payout refund b2"), mk(4, "payout refund b3"), mk(4, "payout refund b4")];
  assert.strictEqual(h.similarCommits(l2, "payout refund page").k, 7);
  // Fewer than 3 hits: no estimate as before (the caller needs n ≥ 3).
  assert.ok(h.similarCommits(list.slice(0, 2), "payout refund page").n < 3);
});

test("cuePrior: the median size of the same leading cue", () => {
  const list = [
    ...Array.from({ length: 6 }, (_, i) => c(["src/a.js"], 0, 1, `fix: bug ${i}`)),
    ...Array.from({ length: 6 }, (_, i) => c(["src/a.js", "src/b.js", "src/c.js", "src/d.js"], 4, 0, `feat: add thing ${i}`)),
    c(["src/a.js"], 0, 1, "chore(deps): bump x"),
  ];
  assert.deepStrictEqual(h.cuePrior(list, "fix the header crash"), { cue: "fix", median: 1, k: 6 });
  assert.deepStrictEqual(h.cuePrior(list, "add a settings page"), { cue: "add", median: 4, k: 6 });
  assert.strictEqual(h.cuePrior(list, "bump lodash").median, null);
  assert.strictEqual(h.cuePrior(null, "fix x").median, null);
});

test("wiringRatio", () => {
  assert.deepStrictEqual(h.wiringRatio(null), { ratio: 2, n: 0, learned: false });
  const many = (a, m) => Array.from({ length: 5 }, () => c(["src/x.js"], a, m));
  const r = h.wiringRatio(many(1, 3));
  assert.strictEqual(r.ratio, 3);
  assert.strictEqual(r.learned, true);
  assert.strictEqual(h.wiringRatio(many(1, 10)).ratio, 3);
  assert.strictEqual(h.wiringRatio(many(2, 0)).ratio, 1);
});

test("similarRuns", () => {
  const runs = [
    { request: "add refund button payments page", tier: "high", src_files: 4 },
    { request: "add refund button payments page", tier: "high", src_files: 6 },
    { request: "refund button payments page fix", tier: "high", src_files: 5 },
    { request: "refund button payments page", tier: "mid", src_files: 2 },
    { request: "totally different words here", tier: "low", src_files: 1 },
  ];
  const r = h.similarRuns(os.tmpdir(), "refund button on the payments page", { runs });
  assert.strictEqual(r.majority, "high");
  assert.strictEqual(r.n, 4);
  assert.ok(r.lb > 0);
  assert.strictEqual(r.median_src, 4.5);
});

test("executorRecord", () => {
  const ok = { tier: "mid", executor: "sonnet-5-med", outcome: "done" };
  const runs = [ok, ok, { ...ok, findings: { P2: 3 } }];
  const r = h.executorRecord(os.tmpdir(), "mid", { runs });
  assert.strictEqual(r["sonnet-5-med"].n, 3);
  assert.strictEqual(r["sonnet-5-med"].ok, 3);
  const r2 = h.executorRecord(os.tmpdir(), "mid", { runs: [...runs, { ...ok, findings: { P1: 1 } }, { ...ok, executor: "a,b" }] });
  assert.strictEqual(r2["sonnet-5-med"].n, 4);
  assert.strictEqual(r2["sonnet-5-med"].ok, 3);
  assert.strictEqual(Object.keys(r2).length, 1);
});

test("commits on a real git repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-th-"));
  const g = (...a) => { const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" }); assert.strictEqual(r.status, 0, r.stderr); };
  g("init", "-q");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  g("config", "core.autocrlf", "false");
  const commit = (n) => {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", `f${n}.js`), `${n}\n`);
    if (n > 1) fs.appendFileSync(path.join(dir, "src", "f1.js"), `${n}\n`);
    g("add", "src");
    g("commit", "-q", "-m", `commit ${n}`);
  };
  for (const n of [1, 2, 3]) commit(n);
  const first = h.commits(dir);
  assert.strictEqual(first.length, 3);
  assert.deepStrictEqual(first.map((x) => x.s), ["commit 3", "commit 2", "commit 1"]);
  assert.strictEqual(first[0].a, 1);
  assert.strictEqual(first[0].m, 1);
  assert.strictEqual(first[2].a, 1);
  assert.strictEqual(first[2].m, 0);
  const file = path.join(dir, ".claude", "lorc", "tier", "git.json");
  assert.strictEqual(h.cacheFile(dir), file);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).v, h.CACHE_V);
  assert.deepStrictEqual(h.commits(dir), first);
  commit(4);
  assert.strictEqual(h.commits(dir).length, 4);
  assert.strictEqual(h.commits(fs.mkdtempSync(path.join(os.tmpdir(), "lorc-nogit-"))), null);
});

test("kindOf: every graph language, plus Swift and Dart", () => {
  const k = {
    "shop/models.py": "src", "shop/tests/test_views.py": "test", "shop/test_models.py": "test", "uv.lock": "noise", "shop/api_pb2.py": "noise",
    "internal/order/service_test.go": "test", "api/order.pb.go": "noise", "go.sum": "noise",
    "src/test/java/com/x/OrderControllerTest.java": "test", "app/src/main/res/values-id/strings.xml": "locale", "src/main/resources/messages_id.properties": "locale",
    "Orders.Tests/OrdersControllerTests.cs": "test", "Orders.Api/Resources/Strings.resx": "locale", "obj/Debug/x.cs": "noise",
    "spec/models/order_spec.rb": "test", "config/locales/id.yml": "locale", "tests/Feature/OrderTest.php": "test",
    "Cargo.lock": "noise", "AppTests/OrderTests.swift": "test", "App/id.lproj/Localizable.strings": "locale",
    "lib/models/order.g.dart": "noise", "test/order_test.dart": "test", "pubspec.lock": "noise", "bin/lorc.js": "src",
  };
  for (const [f, want] of Object.entries(k)) assert.strictEqual(h.kindOf(f), want, f);
});

test("parseLog: the new format with a body; a merge becomes its PR title", () => {
  const log = "\x1eaaa111\x1fMerge pull request #12 from org/fix-payout\x1fFix the payout rounding\n\nmore text\n\x1d\n" +
    "M\tsrc/payout.js\nM\tsrc/round.js\nA\tsrc/fmt.js\n" +
    "\x1ebbb222\x1fplain subject\x1f\x1d\nM\tsrc/x.js\n";
  const [x, y] = h.parseLog(log);
  assert.strictEqual(x.s, "Fix the payout rounding · fix payout");
  assert.strictEqual(x.files.length, 3);
  assert.strictEqual(x.a, 1);
  assert.strictEqual(x.m, 2);
  assert.strictEqual(y.s, "plain subject");
  assert.deepStrictEqual(y.files, ["src/x.js"]);
});

test("unitSubject", () => {
  assert.ok(h.unitSubject("Merge branch 'feature/refund-flow'", "").includes("feature refund flow"));
  assert.strictEqual(h.unitSubject("add a refund button", "body"), "add a refund button");
});

test("commits: a merged PR is one unit with all its files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-pr-"));
  const g = (...a) => { const r = spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...a], { cwd: dir, encoding: "utf8" }); assert.strictEqual(r.status, 0, r.stderr); return r.stdout; };
  g("init", "-q");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  g("add", ".");
  g("commit", "-q", "-m", "main start");
  const main = g("rev-parse", "--abbrev-ref", "HEAD").trim();
  g("checkout", "-q", "-b", "add-ab");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "a\n");
  g("add", ".");
  g("commit", "-q", "-m", "branch one");
  fs.writeFileSync(path.join(dir, "src", "b.js"), "b\n");
  g("add", ".");
  g("commit", "-q", "-m", "branch two");
  g("checkout", "-q", main);
  g("merge", "--no-ff", "-q", "-m", "Merge pull request #1 from x/add-ab", "-m", "Add a and b", "add-ab");
  const list = h.commits(dir, { cache: false });
  assert.strictEqual(list.length, 2, JSON.stringify(list));
  const pr = list[0];
  assert.deepStrictEqual([...pr.files].sort(), ["src/a.js", "src/b.js"]);
  assert.ok(pr.s.startsWith("Add a and b"), pr.s);
  assert.ok(!list.some((c) => c.s === "branch one" || c.s === "branch two"));
});

test("calibration", () => {
  const r = (src, est) => ({ src_files: src, est_raw: est });
  assert.deepStrictEqual(h.calibration(os.tmpdir(), { runs: [r(2, 1), r(2, 1), r(2, 1), r(2, 1)] }), { factor: 1, n: 4, learned: false });
  const five = [r(4, 2), r(6, 3), r(2, 1), r(3, 3), r(9, 3)];
  assert.deepStrictEqual(h.calibration(os.tmpdir(), { runs: five }), { factor: 2, n: 5, learned: true });
  assert.strictEqual(h.calibration(os.tmpdir(), { runs: Array.from({ length: 5 }, () => r(10, 1)) }).factor, 2);
  assert.strictEqual(h.calibration(os.tmpdir(), { runs: Array.from({ length: 5 }, () => r(1, 10)) }).factor, 0.5);
  const c = h.calibration(os.tmpdir(), { runs: [...five, { src_files: 50 }, { src_files: 50, est_raw: null }] });
  assert.strictEqual(c.n, 5);
  assert.strictEqual(c.factor, 2);
});

test("bag drops Indonesian stop words", () => {
  const b = h.bag("tolong tambahkan halaman detail pesanan");
  assert.ok(!b.has("tolong") && !b.has("tambahkan"), [...b].join(","));
  for (const w of ["halaman", "detail", "pesanan"]) assert.ok(b.has(w), w);
});
