"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const usage = require("../bin/lib/usage.js");

const NOW = 1_800_000_000_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lorc-usage-"));
function put(root, who, obj) {
  const f = path.join(root, ".claude", who, "usage.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj));
}
const reading = (fh, wk, ago = 60_000, resets = NOW + 134 * 60_000) => ({
  five_hour: fh == null ? null : { used_percentage: fh, resets_at: resets },
  seven_day: wk == null ? null : { used_percentage: wk, resets_at: NOW + 3 * 86400_000 },
  context_used_percentage: 42,
  written_at: NOW - ago,
});
async function run(root, argv = []) {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = function (s, ...rest) { if (/^(5h |usage |\{)/.test(String(s))) { out += s; return true; } return orig.call(this, s, ...rest); };
  const prev = process.env.LORC_NOW;
  process.env.LORC_NOW = String(NOW);
  try {
    return { code: usage.cmd(argv, { root, home: root }), out };
  } finally {
    process.stdout.write = orig;
    if (prev === undefined) delete process.env.LORC_NOW; else process.env.LORC_NOW = prev;
  }
}

test("the fresher of two files wins", () => {
  const root = tmp();
  put(root, "lorc", reading(10, 5, 120_000));
  put(root, "orc", reading(70, 5, 30_000));
  const u = usage.readUsage(root, { now: NOW });
  assert.strictEqual(u.source, "orc");
  assert.strictEqual(u.five_hour.used_percentage, 70);
});

test("a reading older than 30 minutes is unknown", () => {
  const root = tmp();
  put(root, "lorc", reading(10, 5, 31 * 60_000));
  assert.strictEqual(usage.readUsage(root, { now: NOW }), null);
  assert.strictEqual(usage.check(root, {}, { now: NOW }).state, "unknown");
});

test("a reading from before a passed reset is unknown", () => {
  const root = tmp();
  put(root, "lorc", reading(95, 5, 10 * 60_000, NOW - 5 * 60_000));
  assert.strictEqual(usage.check(root, {}, { now: NOW }).state, "unknown");
});

test("resets_at as ISO, seconds and ms", () => {
  const ms = NOW + 60 * 60_000;
  for (const v of [new Date(ms).toISOString(), ms / 1000, ms]) {
    const root = tmp();
    put(root, "lorc", reading(10, 5, 1000, v));
    const c = usage.check(root, {}, { now: NOW });
    assert.strictEqual(c.five_hour.resets_at_ms, ms);
    assert.strictEqual(c.five_hour.resets_in_min, 60);
  }
});

test("exit codes 0 ok / 1 limit / 0 unknown / 3 weekly, weekly beats limit", async () => {
  const cases = [[reading(63, 31), 0], [reading(91, 31), 1], [null, 0], [reading(50, 99), 3], [reading(95, 99), 3]];
  for (const [r, want] of cases) {
    const root = tmp();
    if (r) put(root, "lorc", r);
    const { code, out } = await run(root);
    assert.strictEqual(code, want, out);
  }
  const root = tmp();
  put(root, "lorc", reading(63, 31, 120_000));
  const { out } = await run(root);
  assert.strictEqual(out.trim(), "5h 63% (limit 90%) · reset 134m · wk 31% (limit 98%) · ctx 42% · source lorc · 2m old");
  const j = await run(root, ["--json"]);
  const o = JSON.parse(j.out);
  assert.strictEqual(o.state, "ok");
  assert.strictEqual(o.limit_pct, 90);
  assert.strictEqual(o.limit_weekly_pct, 98);
});
