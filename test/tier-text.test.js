"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parse, readDoc, namesOf, stripNegated } = require("../bin/lib/tier-text.js");

const nouns = (r) => r.creates.map((c) => c.noun);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lorc-tt-"));

test("refunds endpoint and a button", () => {
  const r = parse("add a refunds endpoint to the payments API and a refund button on the order page");
  assert.deepStrictEqual(nouns(r), ["endpoint"]);
  assert.strictEqual(r.creates[0].layer, "api");
  assert.strictEqual(r.elements, 1);
  assert.ok(r.layers.includes("ui") && r.layers.includes("api"));
  assert.strictEqual(r.server, true);
  assert.deepStrictEqual(r.risk, ["money"]);
});

test("list of new files in order", () => {
  const r = parse("create a new settings page with a profile form, a password modal and an avatar uploader component, then add translations");
  assert.deepStrictEqual(nouns(r), ["page", "form", "modal", "component"]);
});

test("'with' inside a parenthesis resumes the list; step 1 once", () => {
  const r = parse("Build step 1 (Amount & Method) of the flow. The flow does not exist yet: build its route shell (with the 4-step stepper), and step 1 only.");
  assert.deepStrictEqual(nouns(r), ["step", "shell", "stepper"]);
});

test("colon list", () => {
  const r = parse("Build step 1 Amount & Method: route shell, 4-step stepper, Transfer Fund button");
  assert.deepStrictEqual(nouns(r), ["step", "shell", "stepper"]);
  assert.strictEqual(r.elements, 1);
});

test("behaviour is not an order", () => {
  const r = parse('add a "Change" button. When the user then changes the destination country, reset it.');
  assert.deepStrictEqual(r.creates, []);
  assert.strictEqual(r.elements, 1);
  assert.deepStrictEqual(r.modifies, []);
});

test("hyphen compound is not a verb", () => {
  const r = parse("On the create-transaction flow, add a button to the summary box");
  assert.deepStrictEqual(r.creates, []);
  assert.strictEqual(r.elements, 1);
});

test("rename across the codebase", () => {
  const r = parse("rename getUser to fetchUser across the codebase");
  assert.strictEqual(r.cues.mechanical, true);
  assert.strictEqual(r.cues.scope, true);
  assert.strictEqual(r.modifies.length, 1);
  assert.strictEqual(r.modifies[0].target, "getUser");
  assert.ok(r.names.includes("getUser") && r.names.includes("fetchUser"));
});

test("signature change", () => {
  const r = parse("Change `localizeLabelSlot` so it takes ONE options object instead of positional arguments, and update every caller");
  assert.strictEqual(r.cues.signature, true);
  assert.ok(r.names.includes("localizeLabelSlot"));
  assert.strictEqual(r.modifies[0].target, "localizeLabelSlot");
});

test("migration and data evidence", () => {
  const r = parse("migrate the orders table to split first and last name, then backfill the data");
  assert.strictEqual(r.cues.migration, true);
  assert.strictEqual(r.data, true);
  assert.strictEqual(r.data_strong, true);
  assert.ok(r.layers.includes("data"));
  assert.ok(r.risk.includes("migration"));
  const s = parse("migrate the settings to the new format");
  assert.strictEqual(s.cues.migration, true);
  assert.strictEqual(s.data_strong, false);
});

test("fix a typo", () => {
  const r = parse("fix the typo in the login button label");
  assert.strictEqual(r.cues.fix, true);
  assert.strictEqual(r.cues.mechanical, true);
  assert.deepStrictEqual(r.risk, ["auth"]);
});

test("state cues", () => {
  assert.strictEqual(parse("keep the values filled in when the user goes back").cues.state, true);
  assert.strictEqual(parse("continuing from step 1").cues.state, true);
});

test("requirement doc", () => {
  const dir = tmp();
  const lines = ["- item a", "- item b", "- item c", "- item d", "- item e", "POST /api/rates", "GET /api/recipients", "Details:", "Destination Country*"];
  while (lines.length < 60) lines.push("This is filler text about a two column layout for the page.");
  fs.writeFileSync(path.join(dir, "req.md"), lines.join("\n"));
  const check = (d) => {
    assert.strictEqual(d.path, "req.md");
    assert.strictEqual(d.apis, 2);
    assert.ok(d.items >= 7, `items ${d.items}`);
    assert.ok(d.lines >= 60);
  };
  const r = parse("build the rates step as req.md describes", { root: dir });
  check(r.doc);
  assert.strictEqual(r.data, false);
  const e = parse("build the rates step", { root: dir, doc: "req.md" });
  check(e.doc);
  assert.deepStrictEqual(e.doc, r.doc);
});

test("CLAUDE.md is not a doc", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# rules\n");
  assert.strictEqual(parse("follow CLAUDE.md and add a page", { root: dir }).doc, null);
});

test("readDoc missing and namesOf", () => {
  assert.strictEqual(readDoc(tmp(), "missing.md"), null);
  const n = namesOf("see `a/b.js` and fooBar and x_y");
  for (const x of ["a/b.js", "fooBar", "x_y"]) assert.ok(n.includes(x), x);
});

test("other languages: type names and type nouns", () => {
  const a = parse("add a new OrderSerializer and a viewset for refunds in the Django API");
  assert.deepStrictEqual(a.creates.map((c) => c.noun), ["serializer", "viewset"]);
  assert.strictEqual(a.server, true);
  const b = parse("add a struct and an interface for the payment gateway client");
  assert.deepStrictEqual(b.creates.map((c) => c.noun), ["struct", "interface"]);
  const c = parse("add a function to parse the config file and a flag --strict");
  assert.deepStrictEqual([c.creates.length, c.elements], [0, 2]);
});

test("Indonesian: a new page with a button", () => {
  const r = parse("tambah halaman detail pesanan dengan tombol batal");
  assert.deepStrictEqual(nouns(r), ["page"]);
  assert.strictEqual(r.elements, 1);
  assert.ok(r.layers.includes("ui"));
});

test("Indonesian: a list with dan", () => {
  assert.deepStrictEqual(nouns(parse("buat komponen kartu penerima dan modal konfirmasi")), ["card", "modal"]);
});

test("Indonesian: an endpoint and a button, money risk", () => {
  const r = parse("tambahkan endpoint pengembalian dana di backend dan tombol refund di halaman pesanan");
  assert.deepStrictEqual(nouns(r), ["endpoint"]);
  assert.strictEqual(r.elements, 1);
  assert.ok(r.risk.includes("money"));
  assert.strictEqual(r.server, true);
});

test("Indonesian: a migration", () => {
  const r = parse("migrasikan tabel orders untuk memisahkan nama depan dan belakang");
  assert.strictEqual(r.cues.migration, true);
  assert.strictEqual(r.data_strong, true);
  assert.ok(r.layers.includes("data"));
});

test("Indonesian: a typo fix on a login label", () => {
  const r = parse("perbaiki salah ketik di label tombol login");
  assert.strictEqual(r.cues.mechanical, true);
  assert.strictEqual(r.cues.fix, true);
  assert.ok(r.risk.includes("auth"));
});

test("Indonesian: an actor is not an order", () => {
  assert.deepStrictEqual(parse("ketika pengguna mengubah negara tujuan, reset metode").modifies, []);
});

test("Indonesian: step once, state cue", () => {
  const r = parse("buat langkah 2 Detail Penerima, lanjutkan dari langkah 1");
  assert.deepStrictEqual(nouns(r), ["step"]);
  assert.strictEqual(r.cues.state, true);
});

test("Indonesian: plural reduplication", () => {
  assert.deepStrictEqual(nouns(parse("tambah halaman-halaman laporan")), ["page"]);
});

test("doc names: known file names and code names join text.names; endpoints in text.doc", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "req.md"), "Fetch POST /dashboard/remittance/rate (register into remittance.api.js).\nThe GetRate() result fills the TransferFund view. Use the DownArrow icon. See notes.md.\n");
  const known = (n) => ["remittance.api.js", "TransferFund"].includes(n);
  const r = parse("build the rate step", { root: d, doc: "req.md", known });
  assert.ok(r.names.includes("remittance.api.js") && r.names.includes("TransferFund"), JSON.stringify(r.names));
  assert.ok(!r.names.includes("GetRate") && !r.names.includes("DownArrow") && !r.names.includes("notes.md"));
  assert.deepStrictEqual(r.doc.endpoints, ["POST /dashboard/remittance/rate"]);
  assert.deepStrictEqual(r.doc.names, ["remittance.api.js", "TransferFund"]);
  // No known-names check (not a git repo, no graph): no doc names.
  assert.deepStrictEqual(parse("build the rate step", { root: d, doc: "req.md" }).names, []);
});

test("docChanged: a change verb within 6 words in the same sentence", () => {
  const { docChanged } = require("../bin/lib/tier-text.js");
  assert.strictEqual(docChanged("fetch POST /x (register into remittance.api.js)", "remittance.api.js"), true);
  assert.strictEqual(docChanged("tambahkan ke keys.js", "keys.js"), true);
  assert.strictEqual(docChanged("the same as remittance.api.js", "remittance.api.js"), false);
  assert.strictEqual(docChanged("Update the box. It looks like Box.vue", "Box.vue"), false);
  assert.strictEqual(docChanged("update one two three four five six seven Box.vue", "Box.vue"), false);
});

test("docNames: at most 8; endpointsOf; leadCue", () => {
  const { docNames, endpointsOf, leadCue } = require("../bin/lib/tier-text.js");
  const many = Array.from({ length: 12 }, (_, i) => `fooBar${i}`).join(" ");
  assert.strictEqual(docNames(many, () => true).length, 8);
  assert.deepStrictEqual(endpointsOf("GET /a/b and DELETE /a/{id}."), ["GET /a/b", "DELETE /a/{id}"]);
  const cues = ["feat(pay): add payout card", "Fix crash on login", "chore(deps): bump lodash", "[PAY-12] Remove old banner",
    "PAY-3 update the copy", "refactor: extract hook", "Payout list sorting", "tambah halaman laporan"].map(leadCue);
  assert.deepStrictEqual(cues, ["add", "fix", "bump", "remove", "update", "refactor", "other", "add"]);
});

test("T5: a negated migration is not a migration cue", () => {
  assert.strictEqual(parse("Implement X. No DB migration.").cues.migration, false);
  assert.strictEqual(parse("Do not add a migration for this").cues.migration, false);
  assert.strictEqual(parse("Add a migration for the orders table").cues.migration, true);
  assert.ok(!/migration/.test(stripNegated("No DB migration.")));
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "T.md"), "Add the list endpoint.\nNo DB migration.\n");
  assert.strictEqual(parse("Implement the ticket", { root: dir, doc: "T.md", known: () => false }).cues.migration, false);
  fs.writeFileSync(path.join(dir, "M.md"), "Add a migration for the orders table.\n");
  assert.strictEqual(parse("Implement the ticket", { root: dir, doc: "M.md", known: () => false }).cues.migration, true);
});

test("doc.paths: repo paths in order, unique, not filtered by known names", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "T.md"), "1. src/services/va.ts - new.\n2. `src/init.ts` and src/services/va.ts again.\n3. Edit types.ts (no slash).\n4. internal/core/autoapply/handlers/autoapply-handler.go\n");
  const r = parse("Implement the ticket", { root: dir, doc: "T.md", known: () => false });
  assert.deepStrictEqual(r.doc.paths, ["src/services/va.ts", "src/init.ts", "internal/core/autoapply/handlers/autoapply-handler.go"]);
  assert.deepStrictEqual(r.doc.names, []);
});
