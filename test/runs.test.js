"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const runs = require("../bin/lib/runs.js");

const LORC = path.join(__dirname, "..", "bin", "lorc.js");
const NOW = Date.UTC(2026, 9, 11, 9, 30);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lorc-runs-"));

test("slug shape", () => {
  const s = runs.makeSlug("Please add the dark mode toggle to the settings page", NOW);
  assert.match(s, /^\d{6}-\d{4}-[a-z0-9-]+$/);
  assert.ok(s.endsWith("-dark-mode-toggle-settings"), s);
  assert.ok(s.length <= 40);
  assert.ok(runs.makeSlug("日本", NOW).endsWith("-run"));
});

test("startRun writes run.json and .current", () => {
  const root = tmp();
  const { slug, dir } = runs.startRun(root, { request: "fix login bug", store: { mode: "own", dir: "/s" }, settings: { executor: "ask" }, now: NOW });
  const r = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
  assert.strictEqual(r.slug, slug);
  assert.deepStrictEqual(r.tasks, []);
  assert.strictEqual(r.store.mode, "own");
  const cur = JSON.parse(fs.readFileSync(path.join(root, ".claude", "lorc", "run", ".current"), "utf8"));
  assert.strictEqual(cur.slug, slug);
  assert.strictEqual(cur.mode, "own");
});

test("checkpoint writes checkpoint.json and a paste-ready RESUME.md", () => {
  const root = tmp();
  const { slug, dir } = runs.startRun(root, { request: "migrate orders", now: NOW });
  runs.checkpoint(root, slug, { steps: [{ id: "T1", title: "a", status: "done" }, { id: "T2", title: "b", status: "todo" }], decisions: ["keep v1", "no flag"], next: "run T2" }, { resume: true });
  const cp = JSON.parse(fs.readFileSync(path.join(dir, "checkpoint.json"), "utf8"));
  assert.strictEqual(cp.reason, "wait");
  const md = fs.readFileSync(path.join(dir, "RESUME.md"), "utf8");
  const lines = md.trim().split("\n");
  assert.ok(lines.length >= 8 && lines.length <= 12);
  assert.strictEqual(lines[0], `# RESUME — lorc run ${slug}`);
  assert.ok(md.includes("Done: T1\n"));
  assert.ok(md.includes("Next: run T2"));
  assert.ok(md.includes("Decisions: keep v1; no flag"));
  runs.checkpoint(root, slug, { next: "x" });
  assert.strictEqual(fs.readFileSync(path.join(dir, "RESUME.md"), "utf8").split("# RESUME").length, 2);
});

test("endRun appends one runs.jsonl line and cleans up", () => {
  const root = tmp();
  const home = tmp();
  const { slug, dir } = runs.startRun(root, { request: "add export", now: NOW });
  runs.addTask(root, slug, { id: "T1" });
  runs.checkpoint(root, slug, { next: "x" });
  const r = runs.endRun(root, slug, { outcome: "done", tier: "mid", executor: "sonnet-5-med", asks: [{ q: "a", rec: "x", chosen: "x" }], findings: [{ sev: "P2", cat: "naming", outcome: "listed" }] }, { now: NOW + 60000, home, graph: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.record.dispatches, 1);
  assert.strictEqual(r.record.findings.P2, 1);
  assert.strictEqual(r.record.duration_s, 60);
  const log = fs.readFileSync(path.join(root, ".claude", "lorc", "runs.jsonl"), "utf8").trim().split("\n");
  assert.strictEqual(log.length, 1);
  assert.ok(fs.existsSync(path.join(dir, "run.json")));
  for (const f of ["checkpoint.json", "RESUME.md"]) assert.ok(!fs.existsSync(path.join(dir, f)));
  assert.ok(!fs.existsSync(path.join(root, ".claude", "lorc", "run", ".current")));
});

test("latestResume picks the newest", () => {
  const root = tmp();
  const a = runs.startRun(root, { request: "one", now: NOW });
  const b = runs.startRun(root, { request: "two", now: NOW });
  runs.checkpoint(root, a.slug, { next: "x" });
  runs.checkpoint(root, b.slug, { next: "y" });
  const old = new Date(NOW - 100000);
  fs.utimesSync(path.join(a.dir, "RESUME.md"), old, old);
  assert.strictEqual(runs.latestResume(root).slug, b.slug);
  assert.strictEqual(runs.latestResume(tmp()), null);
});

test("bad or missing stdin exits 2", () => {
  const root = tmp();
  const { slug } = runs.startRun(root, { request: "x", now: NOW });
  const go = (input) => spawnSync(process.execPath, [LORC, "run", "checkpoint", "--run", slug, "--dir", root, "-"], { input, encoding: "utf8" });
  let r = go("{not json");
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /bad stdin JSON/);
  r = go("");
  assert.strictEqual(r.status, 2);
  r = go('{"next":"go"}');
  assert.strictEqual(r.status, 0, r.stderr);
});

test("endRun starts the graph update detached and does not wait", () => {
  const root = tmp();
  const { slug } = runs.startRun(root, { request: "detached graph", now: NOW });
  const t = Date.now();
  const r = runs.endRun(root, slug, { outcome: "done" }, { now: NOW + 1000, home: tmp() });
  assert.deepStrictEqual([r.graph.ok, r.graph.mode], [true, "detached"]);
  assert.ok(Date.now() - t < 5000);
});
