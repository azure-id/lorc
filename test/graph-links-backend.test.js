"use strict";
// lorc 0.5.0 (W28e): adapter `events`, adapter `config` and the file lang `env`.
const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const X = require("../bin/lib/graph/graph-extract.js");
const G = require("../bin/lib/graph/graph.js");

const one = (src, lang = "js", rel = "a.js") => X.extractOne({ rel, lang, src });
const eventCalls = (r) => r.symbols.flatMap((s) => (s.calls || []).filter((c) => c.event).map((c) => [c.event, c.name]));
const envKeys = (r) => r.symbols.flatMap((s) => (s.effects || []).filter((e) => e.type === "env").map((e) => e.text));

test("events: bus emit and on by name; own, dynamic and runtime events give nothing", () => {
  const src = [
    "const TOAST = 'show-toast';",
    "export function run(o, f, id) {",
    "  this.$eventHub.$emit(TOAST, 1);",
    "  this.$eventHub.$on('show-toast', this.onToast);",
    "  bus.emit(prefix + id);",
    "  stream.on('data', f);",
    "  this.$emit('close');",
    "  socket.emit('order.created', o);",
    "}",
  ].join("\n") + "\n";
  const r = one(src, "js", "src/a.js");
  assert.deepStrictEqual(eventCalls(r), [
    ["emit", "show-toast"],
    ["on", "show-toast"],
    ["emit", "order.created"],
  ]);
});

test("events: NestJS @OnEvent gives an `on` call on the decorated method", () => {
  const r = one(["class L {", "  @OnEvent('order.created')", "  handle(e) { return e; }", "}"].join("\n") + "\n", "ts", "src/l.ts");
  const m = r.symbols.find((s) => s.qname === "L.handle");
  assert.ok(m, "method L.handle");
  assert.ok((m.calls || []).some((c) => c.name === "order.created" && c.event === "on"));
});

test("config: more env read forms in each language; a comment gives none", () => {
  const js = one(["export function f() {", "  const u = import.meta.env.VITE_URL;", "  const d = Env.get('DB_URL').required().asString();", "  // Env.get('IN_COMMENT')", "  return [u, d];", "}"].join("\n") + "\n");
  assert.ok(envKeys(js).includes("VITE_URL"));
  assert.ok(envKeys(js).includes("DB_URL"));
  assert.ok(!envKeys(js).includes("IN_COMMENT"));
  const go = one(["package m", "", "func F() {", '\tv, ok := os.LookupEnv("PORT")', "\t_ = v", "\t_ = ok", "}"].join("\n") + "\n", "go", "m.go");
  assert.ok(envKeys(go).includes("PORT"));
  const py = one(["def f():", "    return env('SECRET_KEY')", ""].join("\n"), "py", "s.py");
  assert.ok(envKeys(py).includes("SECRET_KEY"));
  const rb = one(["def f", "  ENV.fetch('REDIS_URL')", "end", ""].join("\n"), "rb", "x.rb");
  assert.ok(envKeys(rb).includes("REDIS_URL"));
  const rs = one(["fn f() {", '    let l = std::env::var("RUST_LOG");', "}", ""].join("\n"), "rs", "x.rs");
  assert.ok(envKeys(rs).includes("RUST_LOG"));
});

test("env file: keys and lines only, never a value", () => {
  const src = "# c\nAPI_URL=https://x\nexport TOKEN=abc\n\nBAD LINE\n";
  const out = X.extractBatch([{ rel: "client/.env", lang: "env", src }], { root: os.tmpdir() });
  const rec = out instanceof Map ? out.get("client/.env") : out[0];
  assert.deepStrictEqual(rec.keys, [
    ["API_URL", 2],
    ["TOKEN", 3],
  ]);
  const text = JSON.stringify(rec);
  assert.ok(!text.includes("https://x"));
  assert.ok(!text.includes("abc"));
});

test("makeFilter: .env files are lang env", () => {
  const f = G._makeFilter([]);
  assert.strictEqual(f(".env"), "env");
  assert.strictEqual(f("client/.env"), "env");
  assert.strictEqual(f(".env.example"), "env");
  assert.strictEqual(f("env.js"), "js");
});

// ── W28f: adapter `data` ─────────────────────────────────────────────────────
const D = require("../bin/lib/graph/graph-links-data.js");
const effs = (r, type) => r.symbols.flatMap((s) => (s.effects || []).filter((e) => e.type === type));

test("W28f data: tablesOf reads the table names of SQL text", () => {
  assert.deepStrictEqual(D.tablesOf('SELECT u.id FROM public.users u JOIN "orders" o ON o.u = u.id WHERE x IN (SELECT id FROM accounts)'), ["public.users", "orders", "accounts"]);
  assert.deepStrictEqual(D.tablesOf("INSERT INTO audit_log (a) VALUES ($1)"), ["audit_log"]);
  assert.deepStrictEqual(D.tablesOf("UPDATE users SET a = 1"), ["users"]);
  assert.deepStrictEqual(D.tablesOf("DELETE FROM sessions WHERE id = $1"), ["sessions"]);
  assert.deepStrictEqual(D.tablesOf("CREATE TABLE IF NOT EXISTS jobs (id int)"), ["jobs"]);
});

test("W28f data: a Go sql effect gains tables", () => {
  const r = one(["package repo", "", "func Get(id int) {", "\tq := `SELECT id FROM users WHERE id = $1`", "\t_ = q", "}"].join("\n") + "\n", "go", "repo/user.go");
  const f = r.symbols.find((s) => s.name === "Get");
  const sql = f.effects.find((e) => e.type === "sql");
  assert.deepStrictEqual(sql.tables, ["users"]);
});

test("W28f data: knex builder calls give db effects with tables", () => {
  const body = ["function f(knex: Knex) {", "  return knex('users').where({});", "}", "function g(trx: any) {", "  return trx('orders').insert({});", "}"];
  const r = one(["import { Knex } from 'knex';", ...body].join("\n") + "\n", "ts", "src/r.ts");
  const t = effs(r, "db").filter((e) => e.tables).map((e) => e.tables);
  assert.deepStrictEqual(t, [["users"], ["orders"]]);
  const r2 = one(body.join("\n").replace(/Knex/g, "Q").replace(/knex/g, "q") + "\n", "ts", "src/r.ts");
  assert.strictEqual(effs(r2, "db").filter((e) => e.tables).length, 0);
});

test("W28f data: ORM model classes gain table", () => {
  const src = [
    "@Entity('va_transaction') export class VaTransaction {}",
    "@Entity({ name: 'report' }) export class Report {}",
    "@Entity() export class X {}",
    "class User extends Model { static tableName = 'users'; }",
    "class Acc extends Model { static get tableName() { return 'accounts'; } }",
  ].join("\n") + "\n";
  const r = one(src, "ts", "src/m.ts");
  const tab = (n) => r.symbols.find((s) => s.name === n && s.kind === "class").table;
  assert.strictEqual(tab("VaTransaction"), "va_transaction");
  assert.strictEqual(tab("Report"), "report");
  assert.strictEqual(tab("X"), undefined);
  assert.strictEqual(tab("User"), "users");
  assert.strictEqual(tab("Acc"), "accounts");
});

test("W28f data: a .sql file gives a key table of tables and views", () => {
  const src = "-- CREATE TABLE fake (\nCREATE TABLE users (\n id int\n);\nCREATE OR REPLACE VIEW active_users AS SELECT 1;\n";
  const out = X.extractBatch([{ rel: "migrations/001.up.sql", lang: "sql", src }], { root: os.tmpdir() });
  const rec = out instanceof Map ? out.get("migrations/001.up.sql") : out[0];
  assert.deepStrictEqual(rec.keys, [["users", 2], ["active_users", 5]]);
  assert.strictEqual(G.EXTRACTORS.sql, 1);
});

test("W28f caps: 30 env reads in one module keep 30 env effects", () => {
  const src = Array.from({ length: 30 }, (_, i) => `const v${i} = process.env.K${i};`).join("\n") + "\n";
  const out = X.extractBatch([{ rel: "src/config.ts", lang: "ts", src }], { root: os.tmpdir() });
  const r = out instanceof Map ? out.get("src/config.ts") : out[0];
  assert.strictEqual(effs(r, "env").length, 30);
  assert.ok(!r.partial || !r.partial.length);
});

// lorc 0.5.0 (W34d): knex `createTable` defines a table; `alterTable` is a use.
test("W34d data: knex createTable and createTableIfNotExists give def; alterTable does not", () => {
  const src = [
    "import { Knex } from 'knex';",
    "export async function up(knex: Knex) {",
    "  await knex.schema.createTable('users', (t) => {});",
    "  await knex.schema.createTableIfNotExists('logs', (t) => {});",
    "  await knex.schema.alterTable('accounts', (t) => {});",
    "  return knex('orders').where({});",
    "}",
  ].join("\n") + "\n";
  const r = one(src, "ts", "migrations/001_users.ts");
  const rows = effs(r, "db").filter((e) => e.tables).map((e) => [e.tables[0], e.line, !!e.def]);
  assert.deepStrictEqual(rows, [["users", 3, true], ["logs", 4, true], ["accounts", 5, false], ["orders", 6, false]]);
});

// lorc 0.5.0 (W34d): createTable with a folded const name is a def; a parameter is not.
test("W34d data: createTable(tableName) folds a same-file const; a parameter gives no def", () => {
  const src = [
    "import { Knex } from 'knex';",
    "const tableName = 'audit_logs';",
    "export async function up(knex: Knex) {",
    "  await knex.schema.createTable(tableName, (t) => {});",
    "}",
    "export async function mk(knex: Knex, name: string) {",
    "  await knex.schema.createTable(name, (t) => {});",
    "}",
  ].join("\n") + "\n";
  const r = one(src, "ts", "migrations/002_audit.ts");
  const rows = effs(r, "db").filter((e) => e.tables).map((e) => [e.tables[0], e.line, !!e.def]);
  assert.deepStrictEqual(rows, [["audit_logs", 4, true]]);
});
