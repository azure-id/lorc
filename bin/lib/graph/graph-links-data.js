"use strict";
// lorc 0.5.0: link adapter `data` — table names in every language.
// A `sql` effect gains `tables` (graph-extract.js `effectsOf` calls tablesOf).
// Stage "object": an ORM model class gains `table`.
// Stage "code": a query builder call (knex, objection) gives a `db` effect
// with `tables`. A dynamic name makes no record.

const MAX_TABLES = 8;
const SQL_WORDS = new Set(["select", "lateral", "only", "set", "values"]);
const TABLE_AFTER =
  /\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF(?:\s+NOT)?\s+EXISTS)?)\s+(?:ONLY\s+)?([`"\[]?[A-Za-z_][\w$]*[`"\]]?(?:\.[`"\[]?[A-Za-z_][\w$]*[`"\]]?)*)/gi;
const NAME_RE = /^[A-Za-z_][\w.]*$/;

// The table names of one SQL text: distinct, in order, max 8.
function tablesOf(sqlText) {
  const out = [];
  const text = String(sqlText == null ? "" : sqlText);
  TABLE_AFTER.lastIndex = 0;
  let x;
  while ((x = TABLE_AFTER.exec(text)) && out.length < MAX_TABLES) {
    const name = x[1].replace(/[`"\[\]]/g, "").toLowerCase();
    if (!name || SQL_WORDS.has(name) || name.startsWith("$")) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

const JS_LANGS = new Set(["js", "ts", "vue", "svelte"]);

// The text of a quoted literal at `p` in `s`: one line, no escapes.
function quotedAt(s, p) {
  const x = /^(['"`])([^'"`\n\\$]*)\1/.exec(s.slice(p, p + 200));
  return x ? x[2] : null;
}

// Stage "object": a class gets `table` from @Entity('t') / @Entity({ name: 't' })
// above the class line, or from `static tableName = 't'` /
// `static get tableName() { return 't'; }` in the class body.
function object(ctx) {
  const { c } = ctx;
  if (!c || !c.src) return;
  const src = c.src;
  for (const d of ctx.defs || []) {
    if (d.kind !== "class" || d.table) continue;
    const from = d.from != null ? d.from : c.starts[(d.s || 1) - 1] || 0;
    // The decorators: the last @Entity( before the `class` word of this def.
    // Only other decorators and `export default abstract` may stand between.
    const cm = /\bclass\b/.exec(c.m.slice(from, from + 400));
    const classPos = cm ? from + cm.index : from;
    const base = Math.max(0, classPos - 400);
    const win = src.slice(base, classPos);
    const i = win.lastIndexOf("@Entity(");
    let x = null;
    if (i >= 0 && c.m[base + i] === "@") {
      x = /^@Entity\(([^()]*)\)(?:\s|export\b|default\b|abstract\b|@[\w.]+(?:\([^()]*\))?)*$/.exec(win.slice(i));
      if (x) {
        const arg = x[1].trim();
        const y = /^(['"`])([^'"`\n]+)\1$/.exec(arg) || /^\{[^}]*\bname\s*:\s*(['"`])([^'"`\n]+)\1/.exec(arg);
        if (y && NAME_RE.test(y[2])) {
          d.table = y[2];
          continue;
        }
      }
    }
    // The class body.
    const to = d.to != null ? d.to : c.starts[d.e] || src.length;
    const body = src.slice(from, Math.min(to + 1, src.length));
    x =
      /\bstatic\s+(?:readonly\s+)?tableName\s*(?::\s*string\s*)?=\s*(['"`])([^'"`\n]+)\1/.exec(body) ||
      /\bstatic\s+get\s+tableName\s*\(\s*\)\s*(?::\s*string\s*)?\{\s*return\s+(['"`])([^'"`\n]+)\1/.exec(body);
    if (x && NAME_RE.test(x[2])) d.table = x[2];
  }
}

const BUILDER =
  /(?<![\w$.])(?:(?:this\.)?(?:knex|db)|trx)\(\s*(?=['"`])|\.(?:from|into|table|join|leftJoin|innerJoin|createTableIfNotExists|createTable|alterTable)\(\s*(?=['"`])/g;

// Stage "code": query builder calls give `db` effects with `tables`.
function code(ctx) {
  const { c } = ctx;
  if (!c || !c.src || !c.m || !Array.isArray(ctx.effects)) return;
  const src = c.src;
  const m = c.m;
  BUILDER.lastIndex = 0;
  let x;
  while ((x = BUILDER.exec(src))) {
    if (m[x.index] !== src[x.index]) continue;
    const t = quotedAt(src, x.index + x[0].length);
    if (!t || !NAME_RE.test(t)) continue;
    const line = ctx.h.lineOf(c.starts, x.index);
    // lorc 0.5.0 (W34d): `createTable` and `createTableIfNotExists` define the
    // table. `createTableLike` and `alterTable` stay uses.
    const def = /\.createTable(?:IfNotExists)?\($/.test(x[0].replace(/\s+$/, ""));
    ctx.effects.push({ type: "db", text: "knex " + t, line, tables: [t], ...(def ? { def: true } : {}) });
  }
  // lorc 0.5.0 (W34d): `createTable(name, …)` with a plain identifier. The
  // name must fold to a same-file string constant, else no record (no guess).
  const consts = ctx.consts instanceof Map ? ctx.consts : null;
  if (!consts) return;
  const IDENT = /\.createTable(?:IfNotExists)?\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
  while ((x = IDENT.exec(src))) {
    if (m[x.index] !== src[x.index]) continue;
    const t = consts.get(x[1]);
    if (typeof t !== "string" || !NAME_RE.test(t)) continue;
    const line = ctx.h.lineOf(c.starts, x.index);
    ctx.effects.push({ type: "db", text: "knex " + t, line, tables: [t], def: true });
  }
}

module.exports = {
  id: "data",
  langs: ["js", "ts", "vue", "svelte", "py", "go", "java", "cs", "php", "rb", "rs", "kt", "c"],
  applies: (ctx) => JS_LANGS.has(ctx.lang),
  object,
  code: (ctx) => {
    if (/\b(?:knex|objection)\b/.test(String(ctx.raw || ""))) code(ctx);
  },
  tablesOf,
};
