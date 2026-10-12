"use strict";

const paths = require("./paths.js");
const usage = require("./usage.js");
const { wantsJson, emit } = require("./json.js");

const MIN = 60000;
const BEAT_MS = 5 * MIN;
const RESET_PAD_MS = 90 * 1000;

function scale() {
  const n = Number(process.env.LORC_WAIT_SCALE);
  return process.env.LORC_WAIT_SCALE && Number.isFinite(n) && n > 0 ? n : 1;
}

function now() {
  const n = Number(process.env.LORC_NOW);
  return process.env.LORC_NOW && Number.isFinite(n) ? n : Date.now();
}

// Pure: how long this hop sleeps, and whether the hop reaches the target.
function planHop({ now: t, resetsAtMs, hopMaxMin = 30 }) {
  const remaining = resetsAtMs - t;
  if (remaining <= 0) return { sleepMs: 0, final: true };
  const hop = hopMaxMin * MIN;
  return remaining <= hop ? { sleepMs: remaining, final: true } : { sleepMs: hop, final: false };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, Math.max(0, ms)));

// Sleep `ms` of clock time (real ms = ms * LORC_WAIT_SCALE); a heartbeat every 5 minutes.
async function sleepWithBeats(ms, leftAfterMs, out) {
  const k = scale();
  let done = 0;
  while (done < ms) {
    const step = Math.min(BEAT_MS, ms - done);
    await sleep(step * k);
    done += step;
    if (done < ms) out(`wait: ${Math.ceil((ms - done + leftAfterMs) / MIN)}m left to reset`);
  }
}

async function run(argv, opts) {
  const json = wantsJson(argv);
  const lines = [];
  const out = (s) => { if (json) lines.push(s); else process.stdout.write(s + "\n"); };
  const finish = (code, extra) => {
    if (json) emit(Object.assign({ exit: code, lines }, extra || {}));
    return code;
  };
  let hopMax = 30;
  const hi = argv.indexOf("--hop-max");
  if (hi >= 0) {
    hopMax = Number(argv[hi + 1]);
    if (!Number.isInteger(hopMax) || hopMax < 1 || hopMax > 60) {
      process.stderr.write("wait: --hop-max must be a whole number from 1 to 60\n");
      return 2;
    }
  }
  if (argv.includes("--until-reset")) {
    const home = opts.home || process.env.LORC_HOME || undefined;
    const root = opts.root || paths.repoRoot();
    const t = now();
    const c = usage.check(root, usage.loadSettings(root, home), { now: t, home });
    const resetMs = c.five_hour && c.five_hour.resets_at_ms;
    if (resetMs == null) { out("wait: no reset time known — not waiting"); return finish(2); }
    const target = resetMs + RESET_PAD_MS;
    if (target - t <= 0) { out("wait: window already reset"); return finish(0, { target_ms: target }); }
    const plan = planHop({ now: t, resetsAtMs: target, hopMaxMin: hopMax });
    await sleepWithBeats(plan.sleepMs, target - t - plan.sleepMs, out);
    if (plan.final) { out("wait: window reset by the clock"); return finish(0, { target_ms: target }); }
    out("wait: hop done — run again");
    return finish(10, { target_ms: target });
  }
  const pos = argv.find((a, i) => /^\d+(\.\d+)?$/.test(a) && (hi < 0 || i !== hi + 1));
  const minutes = pos == null ? NaN : Number(pos);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 360) {
    process.stderr.write("wait: give --until-reset, or minutes from 1 to 360\n");
    return 2;
  }
  // One hop per run: after exit 10 the caller runs again with the minutes left.
  const total = minutes * MIN;
  const plan = planHop({ now: 0, resetsAtMs: total, hopMaxMin: hopMax });
  await sleepWithBeats(plan.sleepMs, total - plan.sleepMs, out);
  if (plan.final) { out("wait: done"); return finish(0); }
  const left = Math.ceil((total - plan.sleepMs) / MIN);
  out(`wait: hop done — run again (lorc wait ${left})`);
  return finish(10, { minutes_left: left });
}

// Returns a Promise of the exit code (the sleep is async). It also sets
// process.exitCode, so a router that does not await still exits correctly.
function cmd(argv = [], opts = {}) {
  return run(argv, opts).then((code) => { process.exitCode = code; return code; });
}

module.exports = { planHop, cmd };
