"use strict";
// lorc 0.5.0: the link layer of the code graph. This core is framework-neutral.
// Each ADAPTER reads one framework and adds its links to the record as NAMES
// (a store key, an event, a field). graph-query resolves the names on read.
// An adapter reads one file only. It never reads another file.
//
// The extractor calls two stages: "object" (after the object pass: annotate
// defs, add defs) and "code" (after the Vue pass: add calls, defs, extras).

const ADAPTERS = [
  require("./graph-links-vue.js"),
  require("./graph-links-events.js"),
  require("./graph-links-config.js"),
  require("./graph-links-data.js"),
];

const JS_GLOBALS = new Set(
  (
    "Boolean Number String Object Array Math Date JSON parseInt parseFloat isNaN isFinite " +
    "encodeURIComponent decodeURIComponent encodeURI window document console require event Promise Set Map RegExp Intl " +
    "navigator location alert setTimeout clearTimeout"
  ).split(" ")
);

const IDENT = /^[A-Za-z_$][\w$]*$/;
const MAX_VALUE = 200;
const DECL = /^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*/gm;

// Replace each `${IDENT}` of a back-tick text with its folded value. Returns
// null when one expression is not a known name.
function foldTemplate(text, map) {
  let ok = true;
  const out = text.replace(/\$\{([^}]*)\}/g, (all, e) => {
    const id = e.trim();
    if (!IDENT.test(id) || !map.has(id)) {
      ok = false;
      return all;
    }
    return map.get(id);
  });
  return ok ? out : null;
}

// The literal that starts at `v` in the raw source: { q, text, end } or null.
// A quoted string must stay on one line.
function literalAt(src, v) {
  const q = src[v];
  if (q !== "'" && q !== '"' && q !== "`") return null;
  for (let k = v + 1; k < src.length; k++) {
    const ch = src[k];
    if (ch === "\\") {
      k++;
      continue;
    }
    if (ch === q) return { q, text: src.slice(v + 1, k), end: k };
    if (ch === "\n" && q !== "`") return null;
  }
  return null;
}

// Same-file string constants, NAME → text. The declaration is found in the
// mask (so a comment or a string never counts). The value is read in the raw
// source. A back-tick literal with `${IDENT}` folds when every IDENT is known.
function foldConsts(c) {
  const T = new Map();
  const { m, src } = c;
  if (!m || !src) return T;
  const pending = [];
  DECL.lastIndex = 0;
  let x;
  while ((x = DECL.exec(m))) {
    const name = x[1];
    if (T.has(name)) continue;
    const lit = literalAt(src, x.index + x[0].length);
    if (!lit) continue;
    // The literal must be the whole value.
    const rest = m.slice(lit.end + 1, lit.end + 40);
    if (!/^[ \t]*(?:;|\r?\n|$)/.test(rest)) continue;
    if (lit.q === "`" && lit.text.includes("${")) pending.push([name, lit.text]);
    else if (lit.text.length <= MAX_VALUE) T.set(name, lit.text);
  }
  for (let pass = 0; pass < 3 && pending.length; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const v = foldTemplate(pending[i][1], T);
      if (v == null) continue;
      if (v.length <= MAX_VALUE && !T.has(pending[i][0])) T.set(pending[i][0], v);
      pending.splice(i, 1);
    }
  }
  return T;
}

// Classify one argument expression: a fixed name, a name path the reader
// resolves later (`via`), or null (dynamic: no record).
function keyArg(text, consts) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return null;
  let x = /^(['"])([^'"\n\\]*)\1$/.exec(t);
  if (x) return { name: x[2] };
  x = /^`([^`\\]*)`$/.exec(t);
  if (x) {
    if (!x[1].includes("${")) return { name: x[1] };
    const v = foldTemplate(x[1], consts || new Map());
    return v == null ? null : { name: v };
  }
  if (IDENT.test(t) && consts && consts.has(t)) return { name: consts.get(t) };
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,2}$/.test(t)) return { name: t, via: true };
  return null;
}

// Run one stage on every adapter that applies. An adapter error never breaks
// extraction: the error stops that adapter only.
function runStage(stage, ctx) {
  for (const a of ADAPTERS) {
    try {
      if (!a || !Array.isArray(a.langs) || !a.langs.includes(ctx.lang)) continue;
      if (typeof a[stage] !== "function") continue;
      if (typeof a.applies === "function" && !a.applies(ctx)) continue;
      a[stage](ctx);
    } catch {
      // Ignore: the adapter's partial changes may stay.
    }
  }
}

module.exports = { ADAPTERS, JS_GLOBALS, foldConsts, keyArg, runStage };
