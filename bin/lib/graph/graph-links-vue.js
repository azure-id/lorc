"use strict";
// lorc 0.5.0: link adapter `vue` — Vue 2 Options API, Vuex 3 (and option
// objects with the same sections), vue-i18n and vue-router. It adds the links
// as NAMES. The framework words stay in this file; the record uses the
// neutral vocabulary (store module, store member, state field).

const APPLIES =
  /\b(Vuex|createStore|mapState|mapGetters|mapActions|mapMutations|rootGetters|rootState)\b|\$store\b|\b(?:store|context|ctx)\s*\.\s*(?:commit|dispatch|getters|state)\b|\$t\s*\(|\$emit\s*\(|\$router\b|\b(?:Vue|app)\s*\.\s*mixin\s*\(|\bVue\s*\.\s*prototype\s*\.|\brouter\s*\.\s*(?:push|replace)\s*\(|\b(mutations|actions|getters|namespaced)\s*[:,}]/;
const STORE_TOP = new Set(["state", "getters", "mutations", "actions", "modules"]);
const STORE_SEC = { mutations: "mutation", actions: "action", getters: "getter" };
const esc = (s) => s.replace(/\$/g, "\\$");

// Loaded late: graph-links.js loads this file first.
const core = () => require("./graph-links.js");

function applies(ctx) {
  return ctx.lang === "vue" || APPLIES.test(String(ctx.raw || ""));
}

// The object literal [open, close] that a function returns: an arrow
// `() => ({…})`, or a body with `return {…}`. `from`..`end` hold the function.
function returnedObject(m, h, from, end) {
  const seg = m.slice(from, end + 1);
  const pa = seg.indexOf("=>");
  const pb = seg.indexOf("{");
  let body = -1;
  if (pa >= 0 && (pb < 0 || pa < pb)) {
    let k = from + pa + 2;
    while (k < m.length && /\s/.test(m[k])) k++;
    if (m[k] === "(") {
      k++;
      while (k < m.length && /\s/.test(m[k])) k++;
      return m[k] === "{" ? objAt(m, h, k) : null;
    }
    if (m[k] !== "{") return null;
    body = k;
  } else if (pb >= 0) body = from + pb;
  if (body < 0) return null;
  const close = h.matchPairQuiet(m, body, "{", "}");
  if (close < 0) return null;
  const x = /\breturn[ \t\r\n]*\(?[ \t\r\n]*\{/.exec(m.slice(body, close));
  return x ? objAt(m, h, body + x.index + x[0].length - 1) : null;
}

function objAt(m, h, open) {
  const close = h.matchPairQuiet(m, open, "{", "}");
  return close > open ? [open, close] : null;
}

// A same-file `const NAME = …`: the value position, or -1.
function declValue(m, name) {
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:const|let|var)[ \\t]+${esc(name)}[ \\t]*(?::[^=\\n]+)?=[ \\t]*`, "m");
  const x = re.exec(m);
  return x ? x.index + x[0].length : -1;
}

// The state object of a value at `v`: an object literal, an identifier `f` or
// a call `f()`, where `f` is a same-file function, arrow or object const.
function valueObject(m, h, v, depth) {
  if (v < 0 || depth > 3) return null;
  if (m[v] === "{") return objAt(m, h, v);
  const x = /^([A-Za-z_$][\w$]*)[ \t]*(\([ \t]*\))?/.exec(m.slice(v, v + 120));
  if (!x) return null;
  const f = x[1];
  const fn = new RegExp(`^[ \\t]*(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]+${esc(f)}[ \\t]*\\(`, "m").exec(m);
  if (fn) {
    const p = fn.index + fn[0].length - 1;
    const pc = h.matchPairQuiet(m, p, "(", ")");
    if (pc < 0) return null;
    const b = m.indexOf("{", pc);
    const bc = b >= 0 ? h.matchPairQuiet(m, b, "{", "}") : -1;
    return bc > b ? returnedObject(m, h, b, bc) : null;
  }
  const d = declValue(m, f);
  if (d < 0) return null;
  if (m[d] === "{") return objAt(m, h, d);
  if (/^(?:async[ \t]+)?(?:function\b|\(|[A-Za-z_$][\w$]*[ \t]*=>)/.test(m.slice(d, d + 80))) {
    // The head of the function: its first `=>` or `{` decides the form.
    return returnedObject(m, h, d, Math.min(m.length - 1, d + 400));
  }
  // `const state = f()` / `= f`: one more step.
  return valueObject(m, h, d, depth + 1);
}

// The state object of a store module from its top member `state`.
function stateObject(m, h, top) {
  const x = top.find((t) => t.mem.name === "state");
  if (!x) return null;
  const mem = x.mem;
  if (mem.type === "obj") return mem.close > mem.open ? [mem.open, mem.close] : null;
  if (mem.type === "fn") return returnedObject(m, h, x.a, x.b - 1);
  if (mem.type === "short") return valueObject(m, h, declValue(m, "state"), 0);
  if (mem.type === "val") return valueObject(m, h, mem.v, 0);
  return null;
}

function object(ctx) {
  const { c, h, defs } = ctx;
  ctx.mapCalls = [];
  const { m, src, starts } = c;
  const L = core();
  const moduleOpens = new Set();
  for (const def of defs.slice()) {
    if (def.kind !== "class" || def.open == null) continue;
    const open = def.open;
    const top = h
      .objectMembers(m, open, def.to)
      .map(([a, b]) => ({ a, b, mem: h.memberOf(m, a, b) }))
      .filter((x) => x.mem);
    componentLinks(ctx, def, top);
    if (!top.some((x) => STORE_TOP.has(x.mem.name))) continue;
    def.store_module = true;
    const ns = top.find((x) => x.mem.name === "namespaced" && x.mem.type === "val");
    if (ns && /^true\b/.test(src.slice(ns.mem.v, ns.b).trim())) def.namespaced = true;
    const mods = top.find((x) => x.mem.name === "modules" && x.mem.type === "obj");
    if (mods) moduleOpens.add(mods.mem.open);

    // Store members: the methods of the mutations / actions / getters sections.
    const pre = def.name + ".";
    const own = new Set();
    for (const d of defs) {
      if (typeof d.qname === "string" && d.qname.startsWith(pre)) own.add(d.qname);
      if (!STORE_SEC[d.sec] || typeof d.qname !== "string" || !d.qname.startsWith(pre)) continue;
      d.store = STORE_SEC[d.sec];
      const rk = d.rawKey;
      if (rk && rk.startsWith("[")) {
        const k = L.keyArg(rk.replace(/^\[|\]$/g, ""), ctx.consts);
        if (k && k.via) d.key_via = k.name;
        else if (k) d.key = k.name;
      } else d.key = rk ? rk.replace(/^(['"`])(.*)\1$/, "$2") : d.name;
    }

    // State fields: one name-only def per top-level key of the state object.
    const so = stateObject(m, h, top);
    if (!so) continue;
    for (const [a, b] of h.objectMembers(m, so[0], so[1])) {
      const mem = h.memberOf(m, a, b);
      if (!mem || !mem.name || !h.IDENT_RE.test(mem.name)) continue;
      const qname = `${def.name}.${mem.name}`;
      if (own.has(qname)) continue;
      own.add(qname);
      let e = b - 1;
      while (e > a && /\s/.test(m[e])) e--;
      defs.push({ name: mem.name, qname, kind: "state", from: a, to: e, exported: false, nameOnly: true, s: h.lineOf(starts, a), e: h.lineOf(starts, e) });
    }
  }

  // Store registrations: `modules: {…}` in a store constructor call or in a
  // store module.
  const calls = [];
  const CTOR = /\bnew[ \t]+(?:Vuex[ \t]*\.[ \t]*)?Store[ \t]*\(|\bcreateStore[ \t]*\(/g;
  let x;
  while ((x = CTOR.exec(m))) {
    const p = x.index + x[0].length - 1;
    const pc = h.matchPairQuiet(m, p, "(", ")");
    if (pc > p) calls.push([p, pc]);
  }
  const MODS = /\bmodules[ \t]*:[ \t]*\{/g;
  while ((x = MODS.exec(m))) {
    const open = x.index + x[0].length - 1;
    if (!moduleOpens.has(open) && !calls.some(([p, pc]) => open > p && open < pc)) continue;
    const close = h.matchPairQuiet(m, open, "{", "}");
    if (close <= open) continue;
    for (const [a, b] of h.objectMembers(m, open, close)) {
      const mem = h.memberOf(m, a, b);
      if (!mem) continue;
      let ref = null;
      if (mem.type === "short") ref = mem.name;
      else if (mem.type === "val") {
        const v = m.slice(mem.v, b).trim();
        if (h.IDENT_RE.test(v)) ref = v;
      }
      if (!ref || !h.IDENT_RE.test(mem.name)) continue;
      const line = h.lineOf(starts, a);
      ctx.extras.push({ line, field: "store_modules", item: { name: mem.name, ref, line } });
    }
  }
}

const MAP_ROLE = { mapState: "state", mapGetters: "getter", mapActions: "action", mapMutations: "mutation" };
const PATH2 = "([A-Za-z_$][\\w$]*(?:[ \\t]*\\.[ \\t]*[A-Za-z_$][\\w$]*)?)";
const STATE_FN = [
  new RegExp(`^\\(?[ \\t]*([A-Za-z_$][\\w$]*)[ \\t]*\\)?[ \\t]*=>[ \\t\\r\\n]*\\1[ \\t]*\\.[ \\t]*${PATH2}[ \\t\\r\\n]*$`),
  new RegExp(`^function[ \\t]*\\([ \\t]*([A-Za-z_$][\\w$]*)[ \\t]*\\)[ \\t\\r\\n]*\\{[ \\t\\r\\n]*return[ \\t]+\\1[ \\t]*\\.[ \\t]*${PATH2}[ \\t]*;?[ \\t\\r\\n]*\\}$`),
];

// The text of a range in the raw source, trimmed.
const textOf = (src, a, b) => src.slice(a, b).trim();

// Component links of one object def (stage "object"): the fields that `data`
// returns, and the members that the map helpers add. The map helper calls
// wait in `ctx.mapCalls` for stage "code".
function componentLinks(ctx, def, top) {
  const { c, h, defs } = ctx;
  const { m, src, starts } = c;
  const L = core();
  const has = (q) => defs.some((d) => d.qname === q);
  const nameOnly = (name, kind, a, b, extra) => {
    const qname = `${def.name}.${name}`;
    if (has(qname)) return;
    let e = b - 1;
    while (e > a && /\s/.test(m[e])) e--;
    defs.push({ name, qname, kind, ...extra, from: a, to: e, s: h.lineOf(starts, a), e: h.lineOf(starts, e), exported: false, nameOnly: true });
  };

  // Fields: the top-level keys of the object that `data` returns.
  const data = top.find((x) => x.mem.name === "data" && x.mem.type === "fn");
  const obj = data ? returnedObject(m, h, data.a, data.b - 1) : null;
  if (obj) {
    for (const [a, b] of h.objectMembers(m, obj[0], obj[1])) {
      const mem = h.memberOf(m, a, b);
      if (mem && mem.name && h.IDENT_RE.test(mem.name)) nameOnly(mem.name, "field", a, b);
    }
  }

  // Map helpers: `...mapGetters([…])`, `...mapState('ns', {…})`.
  const MAP = /\.\.\.[ \t]*(mapState|mapGetters|mapActions|mapMutations)[ \t]*\(/g;
  const seg = m.slice(def.open, def.to + 1);
  let x;
  while ((x = MAP.exec(seg))) {
    const role = MAP_ROLE[x[1]];
    const p = def.open + x.index + x[0].length - 1;
    const pc = h.matchPairQuiet(m, p, "(", ")");
    if (pc <= p) continue;
    const args = h.objectMembers(m, p, pc);
    if (!args.length) continue;
    let ns = null;
    let nsVia = null;
    let list = args[0];
    if (args.length > 1) {
      const k = L.keyArg(textOf(src, args[0][0], args[0][1]), ctx.consts);
      if (!k) continue;
      if (k.via) nsVia = k.name;
      else ns = k.name;
      list = args[1];
    }
    const open = list[0];
    const close = m[open] === "[" || m[open] === "{" ? h.matchPairQuiet(m, open, m[open], m[open] === "[" ? "]" : "}") : -1;
    if (close <= open) continue;
    const join = (n) => (nsVia || !ns ? n : role === "state" ? `${ns}.${n}` : `${ns}/${n}`);
    const add = (name, via, local, a, b) => {
      ctx.mapCalls.push({ name, line: h.lineOf(starts, a), store: role, ...(via ? { via: true } : {}), ...(nsVia ? { ns_via: nsVia } : {}) });
      if (local && h.IDENT_RE.test(local)) nameOnly(local, "method", a, b, { mapped: role });
    };
    for (const [a, b] of h.objectMembers(m, open, close)) {
      if (m[open] === "[") {
        const k = L.keyArg(textOf(src, a, b), ctx.consts);
        if (!k) continue;
        if (k.via) add(k.name, true, null, a, b);
        else add(join(k.name), false, k.name, a, b);
        continue;
      }
      const mem = h.memberOf(m, a, b);
      if (!mem || !mem.name || mem.v == null) continue;
      const t = textOf(src, mem.v, b);
      if (mem.type === "fn") {
        // A state function: `(state) => state.A.B` gives "A.B".
        if (role !== "state") continue;
        const f = STATE_FN.map((re) => re.exec(t)).find(Boolean);
        if (!f) continue;
        const path = f[2].replace(/\s+/g, "");
        add(nsVia || !ns ? path : `${ns}.${path}`, false, mem.name, a, b);
        continue;
      }
      const k = L.keyArg(t, ctx.consts);
      if (!k) continue;
      if (k.via) add(k.name, true, mem.name, a, b);
      else add(join(k.name), false, mem.name, a, b);
    }
  }
}

// The first argument after the `(` at `p`: raw text to the first top-level
// `,` or `)`. The depth is read in the mask, the text in the raw source.
function firstArg(c, p) {
  const { m, src } = c;
  let d = 0;
  for (let k = p + 1; k < m.length; k++) {
    const ch = m[k];
    if (ch === "(" || ch === "[" || ch === "{") d++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (d === 0) return ch === ")" ? src.slice(p + 1, k) : null;
      d--;
    } else if (ch === "," && d === 0) return src.slice(p + 1, k);
  }
  return null;
}

const STORE_HEAD = "(?:(?<![\\w$])\\$store|(?<![\\w$.])store)[ \\t]*\\.[ \\t]*";
const COMMIT = /(?:(?<![\w$])\$store|(?<![\w$.])(?:store|context|ctx))[ \t]*\.[ \t]*(commit|dispatch)[ \t]*\(/g;
const BARE = /(?<![\w$.])(commit|dispatch)[ \t]*\(/g;
const GET_KEY = new RegExp(`(?:${STORE_HEAD}getters|(?<![\\w$.])(rootGetters))[ \\t]*\\[`, "g");
const GET_NAME = new RegExp(`(?:${STORE_HEAD}getters|(?<![\\w$.])rootGetters)[ \\t]*\\.[ \\t]*([A-Za-z_$][\\w$]*)`, "g");
const STATE = new RegExp(`(?:${STORE_HEAD}state|(?<![\\w$.])rootState)[ \\t]*\\.[ \\t]*([A-Za-z_$][\\w$]*)(?:[ \\t]*\\.[ \\t]*([A-Za-z_$][\\w$]*))?`, "g");
const ROLE = { commit: "mutation", dispatch: "action" };

// Stage "code": the store calls, and the map helper calls of stage "object".
// A match must start at a CODE position: text in a comment or a string never
// makes a link.
function code(ctx) {
  const { c, h } = ctx;
  const { m, src, starts } = c;
  const L = core();
  for (const r of ctx.mapCalls || []) ctx.calls.push(r);
  ctx.mapCalls = [];
  const isCode = (p) => m[p] === src[p];
  const push = (p, store, k) => {
    if (k) ctx.calls.push({ name: k.name, line: h.lineOf(starts, p), store, ...(k.via ? { via: true } : {}) });
  };
  // A bare `commit(` / `dispatch(` is an action context only in a store module file.
  const moduleFile = ctx.defs.some((d) => d.store_module);
  const scan = (re, fn) => {
    re.lastIndex = 0;
    let x;
    while ((x = re.exec(m))) if (isCode(x.index)) fn(x);
  };
  const callArg = (x) => {
    const a = firstArg(c, x.index + x[0].length - 1);
    if (a != null) push(x.index, ROLE[x[1]], L.keyArg(a, ctx.consts));
  };
  scan(COMMIT, callArg);
  if (moduleFile) {
    scan(BARE, (x) => {
      // A declaration `function commit(` is not a call.
      if (!/\bfunction[ \t]*$/.test(m.slice(Math.max(0, x.index - 20), x.index))) callArg(x);
    });
  }
  scan(GET_KEY, (x) => {
    if (x[1] && !moduleFile) return;
    const o = x.index + x[0].length - 1;
    const oc = h.matchPairQuiet(m, o, "[", "]");
    if (oc > o) push(x.index, "getter", L.keyArg(src.slice(o + 1, oc), ctx.consts));
  });
  scan(GET_NAME, (x) => push(x.index, "getter", { name: x[1] }));
  scan(STATE, (x) => push(x.index, "state", { name: x[2] ? `${x[1]}.${x[2]}` : x[1] }));
  templateLinks(ctx);
}

// ── lorc 0.5.0 (W28c): template links, emits and i18n keys ──

// The template text: the outer template with every `<!-- … -->` blanked. The
// length stays the same, so an offset plus `c.tpl.open` is a file position.
function tplText(ctx) {
  const t = ctx.c && ctx.c.tpl;
  if (!t || typeof ctx.raw !== "string") return null;
  return ctx.raw.slice(t.open, t.end + 1).replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\r\n]/g, " "));
}

// The first argument after the `(` at `p` in template text: the raw text to
// the first top-level `,` or `)`. This function tracks the quotes (no mask).
function tplArg(text, p) {
  let d = 0;
  let q = null;
  for (let k = p + 1; k < text.length; k++) {
    const ch = text[k];
    if (q) {
      if (ch === "\\") k++;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") q = ch;
    else if (ch === "(" || ch === "[" || ch === "{") d++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (d === 0) return ch === ")" ? text.slice(p + 1, k) : null;
      d--;
    } else if (ch === "," && d === 0) return text.slice(p + 1, k);
  }
  return null;
}

const TAG = /<([A-Za-z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /(^|\s)([@:#]?[\w.:\-[\]]+)(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;
const PROP_SKIP = new Set(["class", "style", "key", "ref", "slot", "slot-scope", "is"]);
const camel = (s) => s.replace(/-+([a-zA-Z0-9])/g, (a, ch) => ch.toUpperCase());
const pascal = (tag) =>
  tag
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

// Listen and prop calls: the attributes of each child tag in the template.
function tplChildLinks(ctx, text, base) {
  const { h, c } = ctx;
  const local = new Set();
  for (const imp of ctx.imports || []) for (const b of imp.bindings || []) local.add(b.local);
  if (!local.size) return;
  TAG.lastIndex = 0;
  let x;
  while ((x = TAG.exec(text))) {
    if (!/^[A-Z]/.test(x[1]) && !x[1].includes("-")) continue;
    const Local = pascal(x[1]);
    if (!local.has(Local)) continue;
    const at0 = base + x.index + 1 + x[1].length;
    const seen = new Set();
    const push = (name, flag, p) => {
      const k = `${flag}|${name}`;
      if (seen.has(k)) return;
      seen.add(k);
      ctx.calls.push({ name: `${Local}.${name}`, line: h.lineOf(c.starts, p), [flag]: true });
    };
    const prop = (n, p) => {
      if (!n || n.includes("[") || PROP_SKIP.has(n) || /^(?:v-|data-|aria-)/.test(n)) return;
      push(camel(n), "prop", p);
    };
    ATTR.lastIndex = 0;
    let a;
    while ((a = ATTR.exec(x[2]))) {
      const n = a[2];
      const p = at0 + a.index + a[1].length;
      if (n[0] === "@" || n.startsWith("v-on:")) {
        const parts = n.slice(n[0] === "@" ? 1 : 5).split(".");
        if (!parts[0] || parts[0].includes("[") || parts.includes("native")) continue;
        push(parts[0], "listen", p);
        continue;
      }
      if (n === "v-model" || n.startsWith("v-model.")) {
        push("input", "listen", p);
        continue;
      }
      if (n[0] === ":" || n.startsWith("v-bind:")) {
        const parts = n.slice(n[0] === ":" ? 1 : 7).split(".");
        if (parts.includes("sync") && parts[0] && !parts[0].includes("[")) push(`update:${parts[0]}`, "listen", p);
        prop(parts[0], p);
        continue;
      }
      // A static prop has a value: `a-b="…"`.
      if (n[0] === "#" || n.startsWith("v-") || !a[0].includes("=")) continue;
      prop(n, p);
    }
  }
}

// Emit symbols: each distinct literal event that the code sends with no
// declared emit of the same name. Script: `this.$emit('x'`. Template:
// `$emit('x'` with no receiver.
const EMIT_SCRIPT = /(?<![\w$.])this[ \t]*\.[ \t]*\$emit[ \t]*\(/g;
const EMIT_TPL = /(?<![\w$.])\$emit[ \t]*\(/g;
function emitDefs(ctx, text, base) {
  const { c, h, defs } = ctx;
  const { m, src, starts } = c;
  const L = core();
  const sites = [];
  EMIT_SCRIPT.lastIndex = 0;
  let x;
  while ((x = EMIT_SCRIPT.exec(m))) {
    if (m[x.index] !== src[x.index]) continue;
    const k = L.keyArg(firstArg(c, x.index + x[0].length - 1), ctx.consts);
    if (k && !k.via) sites.push([x.index, k.name]);
  }
  if (text != null) {
    EMIT_TPL.lastIndex = 0;
    while ((x = EMIT_TPL.exec(text))) {
      const k = L.keyArg(tplArg(text, x.index + x[0].length - 1), ctx.consts);
      if (k && !k.via) sites.push([base + x.index, k.name]);
    }
  }
  sites.sort((a, b) => a[0] - b[0]);
  for (const [p, name] of sites) {
    let owner = ctx.sfc ? ctx.ownerName : null;
    if (!ctx.sfc) {
      // A `.js` mixin: the smallest object def that holds the site.
      let best = null;
      for (const d of defs) {
        if (d.kind !== "class" || d.nameOnly || d.from == null || d.to == null) continue;
        if (p < d.from || p > d.to) continue;
        if (!best || d.to - d.from < best.to - best.from) best = d;
      }
      owner = best ? best.name : null;
    }
    if (!owner || !name) continue;
    const qname = `${owner}.${name}`;
    if (defs.some((d) => d.kind === "emit" && d.qname === qname)) continue;
    const line = h.lineOf(starts, p);
    defs.push({ name, qname, kind: "emit", from: p, to: p, s: line, e: line, exported: false, nameOnly: true });
  }
}

// i18n calls: the translation key of each call, in script code and in the
// template text.
const I18N = /(?<![\w$.])(?:(?:this[ \t]*\.[ \t]*)?\$(?:tc|te|t)|(?:this[ \t]*\.[ \t]*\$i18n|i18n)[ \t]*\.[ \t]*(?:tc|t))[ \t]*\(/g;
function i18nCall(ctx, arg, p) {
  if (arg == null) return;
  const { h, c } = ctx;
  const line = h.lineOf(c.starts, p);
  const k = core().keyArg(arg, ctx.consts);
  if (k) {
    ctx.calls.push({ name: k.name, line, i18n: true, ...(k.via ? { via: true } : {}) });
    return;
  }
  // A back-tick key with `${` that does not fold: the literal head only.
  const b = /^`([^`]*)`$/.exec(arg.trim());
  if (!b || !b[1].includes("${")) return;
  const head = b[1].slice(0, b[1].indexOf("${")).replace(/\.$/, "");
  if (head) ctx.calls.push({ name: head, line, i18n: true, prefix: true });
}
function i18nLinks(ctx, text, base) {
  const { c } = ctx;
  const { m, src } = c;
  I18N.lastIndex = 0;
  let x;
  while ((x = I18N.exec(m))) {
    if (m[x.index] !== src[x.index]) continue;
    i18nCall(ctx, firstArg(c, x.index + x[0].length - 1), x.index);
  }
  if (text == null) return;
  I18N.lastIndex = 0;
  while ((x = I18N.exec(text))) i18nCall(ctx, tplArg(text, x.index + x[0].length - 1), base + x.index);
}

// Store reads in the template: the same records as in script.
function tplStore(ctx, text, base) {
  const { h, c } = ctx;
  const L = core();
  const push = (p, store, k) => {
    if (k) ctx.calls.push({ name: k.name, line: h.lineOf(c.starts, base + p), store, ...(k.via ? { via: true } : {}) });
  };
  const scan = (re, fn) => {
    re.lastIndex = 0;
    let x;
    while ((x = re.exec(text))) fn(x);
  };
  scan(GET_KEY, (x) => {
    if (x[1]) return;
    const o = x.index + x[0].length - 1;
    const oc = h.matchPairQuiet(text, o, "[", "]");
    if (oc > o) push(x.index, "getter", L.keyArg(text.slice(o + 1, oc), ctx.consts));
  });
  scan(GET_NAME, (x) => push(x.index, "getter", { name: x[1] }));
  scan(STATE, (x) => push(x.index, "state", { name: x[2] ? `${x[1]}.${x[2]}` : x[1] }));
}

// Stage "code", part 2: the template links, the emit symbols and the i18n keys.
function templateLinks(ctx) {
  const text = tplText(ctx);
  const base = ctx.c.tpl ? ctx.c.tpl.open : 0;
  if (text != null) {
    tplChildLinks(ctx, text, base);
    tplStore(ctx, text, base);
  }
  emitDefs(ctx, text, base);
  i18nLinks(ctx, text, base);
  globalMixins(ctx);
  routePaths(ctx, text, base);
}

// ── lorc 0.5.0 (W28d): global mixins and route paths ──

// Global mixins: `Vue.mixin(X)` / `app.mixin(X)` gives X, and
// `Vue.mixin({ mixins: [A, B] })` gives A and B. Script code only.
const MIXIN = /(?<![\w$.])(?:Vue|app)[ \t]*\.[ \t]*mixin[ \t]*\(/g;
function globalMixins(ctx) {
  const { c, h } = ctx;
  const { m, src, starts } = c;
  MIXIN.lastIndex = 0;
  let x;
  while ((x = MIXIN.exec(m))) {
    if (m[x.index] !== src[x.index]) continue;
    const arg = firstArg(c, x.index + x[0].length - 1);
    if (arg == null) continue;
    const t = arg.trim();
    const line = h.lineOf(starts, x.index);
    let items = [];
    if (h.IDENT_RE.test(t)) items = [t];
    else if (t[0] === "{") {
      const l = /(?:^|[{,\s])mixins[ \t]*:[ \t]*\[([^\]]*)\]/.exec(t);
      if (l) items = l[1].split(",").map((s) => s.trim()).filter((s) => h.IDENT_RE.test(s));
    }
    for (const item of items) ctx.extras.push({ line, field: "global_mixins", item });
  }
  // lorc 0.5.0 (W28h): `Vue.prototype.X = …` gives every component a global `X`.
  const PROTO = /(?<![\w$.])Vue[ \t]*\.[ \t]*prototype[ \t]*\.[ \t]*([A-Za-z_$][\w$]*)[ \t]*=(?!=)/g;
  while ((x = PROTO.exec(m))) {
    if (m[x.index] !== src[x.index]) continue;
    ctx.extras.push({ line: h.lineOf(starts, x.index), field: "global_props", item: x[1] });
  }
}

// A route path from an argument: a literal or a folded same-file const that
// starts with `/`. The query and the hash are removed.
function pathOf(ctx, text) {
  const k = core().keyArg(text, ctx.consts);
  if (!k || k.via || !k.name.startsWith("/")) return null;
  return k.name.replace(/[?#].*$/, "") || null;
}

// Route path calls: `router.push('/p')` / `replace`, `$router.push('/p')`,
// `push({ path: '/p' })` in script code, and `<router-link to="/p">` /
// `:to="'/p'"` in the template. A `{ name: … }` object is a route-name call
// that the Vue pass records.
const NAV = /(?<![\w$.])(?:this[ \t]*\.[ \t]*\$router|\$router|router)[ \t]*\.[ \t]*(?:push|replace)[ \t]*\(/g;
const PATH_IN = /(?:^|[{,\s])path[ \t]*:[ \t]*(['"`][^'"`\n]*['"`]|[A-Za-z_$][\w$]*)/;
const TO = /(?:^|\s)(:to|v-bind:to|to)[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')/;
function routePaths(ctx, text, base) {
  const { c, h } = ctx;
  const { m, src, starts } = c;
  const push = (name, p) => {
    if (name) ctx.calls.push({ name, line: h.lineOf(starts, p), route: true, path: true });
  };
  NAV.lastIndex = 0;
  let x;
  while ((x = NAV.exec(m))) {
    if (m[x.index] !== src[x.index]) continue;
    const arg = firstArg(c, x.index + x[0].length - 1);
    if (arg == null) continue;
    const t = arg.trim();
    if (t[0] === "{") {
      const p = PATH_IN.exec(t);
      if (p) push(pathOf(ctx, p[1]), x.index);
    } else push(pathOf(ctx, t), x.index);
  }
  if (text == null) return;
  TAG.lastIndex = 0;
  while ((x = TAG.exec(text))) {
    if (x[1] !== "router-link" && x[1] !== "RouterLink") continue;
    const a = TO.exec(x[2]);
    if (!a) continue;
    const v = a[2] != null ? a[2] : a[3];
    // A static `to` is the path text itself.
    const name = a[1] === "to" ? (v.startsWith("/") ? v.replace(/[?#].*$/, "") || null : null) : pathOf(ctx, v);
    push(name, base + x.index);
  }
}

module.exports = { id: "vue", langs: ["vue", "js", "ts"], applies, object, code };
