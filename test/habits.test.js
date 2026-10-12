"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const behaviour = require("../bin/lib/behaviour.js");
const habits = require("../bin/lib/habits.js");
const settings = require("../bin/lib/settings.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lorc-habits-"));
const PROPOSE = { habits: "propose", executor: "ask", review_mute: "" };

function execs(root, list, tier = "mid") {
  list.forEach((ex, i) => behaviour.record(root, `r${i}`, { tier, executor: ex }, PROPOSE));
}

test("6 picks at mid → executor proposal", () => {
  const root = tmp();
  execs(root, Array(6).fill("sonnet-5-med"));
  const p = habits.proposeOne(root, PROPOSE);
  assert.strictEqual(p.id, "executor:mid:sonnet-5-med");
  assert.match(p.text, /6 of 6 times at tier mid/);
});

test("4 picks → none (n < 5)", () => {
  const root = tmp();
  execs(root, Array(4).fill("sonnet-5-med"));
  assert.strictEqual(habits.proposeOne(root, PROPOSE), null);
});

test("last 3 disagree → none", () => {
  const root = tmp();
  execs(root, ["sonnet-5-med", "sonnet-5-med", "sonnet-5-med", "sonnet-5-med", "sonnet-5-med", "opus-5-low", "sonnet-5-med"]);
  assert.strictEqual(habits.proposeOne(root, PROPOSE), null);
});

test("decline → not proposed again", () => {
  const root = tmp();
  execs(root, Array(6).fill("sonnet-5-med"));
  assert.ok(habits.decline(root, "executor:mid:sonnet-5-med").ok);
  assert.strictEqual(habits.proposeOne(root, PROPOSE), null);
});

test("accept → settings value set", () => {
  const root = tmp();
  const home = tmp();
  execs(root, Array(6).fill("sonnet-5-med"));
  assert.ok(habits.accept(root, "executor:mid:sonnet-5-med", { home }).ok);
  assert.strictEqual(settings.load(root, { home }).values.executor, "sonnet-5-med");
});

test("observe → null", () => {
  const root = tmp();
  execs(root, Array(6).fill("sonnet-5-med"));
  assert.strictEqual(habits.proposeOne(root, Object.assign({}, PROPOSE, { habits: "observe" })), null);
});

test("habits off → nothing recorded", () => {
  const root = tmp();
  behaviour.record(root, "r", { tier: "mid", executor: "x" }, { habits: "off" });
  assert.deepStrictEqual(behaviour.read(root), []);
});

test("mute:<cat> adds to review_mute", () => {
  const root = tmp();
  const home = tmp();
  for (let i = 0; i < 6; i++) behaviour.record(root, `r${i}`, { findings: [{ sev: "P3", cat: "naming", outcome: "rejected" }] }, PROPOSE);
  const p = habits.proposeOne(root, PROPOSE);
  assert.strictEqual(p.id, "mute:naming");
  settings.set("project", root, "review_mute", "style", { home });
  assert.ok(habits.accept(root, "mute:naming", { home }).ok);
  assert.strictEqual(settings.load(root, { home }).values.review_mute, "style,naming");
  assert.strictEqual(settings.validate("review_mute", "Bad Value").ok, false);
});
