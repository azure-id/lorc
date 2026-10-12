"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const wait = require("../bin/lib/wait.js");

const MIN = 60_000;

test("planHop: remaining below the hop, above the hop, already past", () => {
  assert.deepStrictEqual(wait.planHop({ now: 0, resetsAtMs: 10 * MIN, hopMaxMin: 30 }), { sleepMs: 10 * MIN, final: true });
  assert.deepStrictEqual(wait.planHop({ now: 0, resetsAtMs: 50 * MIN, hopMaxMin: 30 }), { sleepMs: 30 * MIN, final: false });
  assert.deepStrictEqual(wait.planHop({ now: 5, resetsAtMs: 1, hopMaxMin: 30 }), { sleepMs: 0, final: true });
});

async function run(argv, root, now) {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = function (s, ...rest) { if (/^(wait:|\{)/.test(String(s))) { out += s; return true; } return orig.call(this, s, ...rest); };
  const saved = { s: process.env.LORC_WAIT_SCALE, n: process.env.LORC_NOW };
  process.env.LORC_WAIT_SCALE = "0.0001";
  process.env.LORC_NOW = String(now);
  try {
    return { code: await wait.cmd(argv, { root, home: root }), out };
  } finally {
    process.stdout.write = orig;
    process.exitCode = 0;
    for (const [k, v] of [["LORC_WAIT_SCALE", saved.s], ["LORC_NOW", saved.n]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("--until-reset: exit 10 on the first hop, exit 0 on the second", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-wait-"));
  const t0 = 1_800_000_000_000;
  const f = path.join(root, ".claude", "lorc", "usage.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const put = (at) => fs.writeFileSync(f, JSON.stringify({
    five_hour: { used_percentage: 95, resets_at: t0 + 45 * MIN }, seven_day: null,
    context_used_percentage: 10, written_at: at,
  }));
  put(t0 - MIN);
  const a = await run(["--until-reset"], root, t0);
  assert.strictEqual(a.code, 10, a.out);
  assert.match(a.out, /left to reset/);
  assert.match(a.out, /hop done — run again/);
  put(t0 + 29 * MIN); // the wake-up is session activity: the status line writes again
  const b = await run(["--until-reset"], root, t0 + 30 * MIN);
  assert.strictEqual(b.code, 0, b.out);
  assert.match(b.out, /window reset by the clock/);
});

test("--until-reset with no reading: exit 2", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-wait-"));
  const r = await run(["--until-reset"], root, Date.now());
  assert.strictEqual(r.code, 2);
});

test("minutes: hops, and more than 360 is refused", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lorc-wait-"));
  assert.strictEqual((await run(["45"], root, 0)).code, 10);
  assert.strictEqual((await run(["15"], root, 0)).code, 0);
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.strictEqual((await run(["361"], root, 0)).code, 2);
  } finally {
    process.stderr.write = orig;
  }
});
