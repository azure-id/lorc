"use strict";
// lorc 0.5.0: link adapter `events` — a global event bus by NAME, front end
// and Node back end. `bus.emit('e')` gives an `emit` call, `bus.on('e', h)`
// gives an `on` call. NestJS `@OnEvent('e')` gives an `on` call on the
// decorated method. A component's own event (`this.$emit`) is not a bus
// event: adapter `vue` owns it.

const APPLIES = /\.\$?(emit|on|once|addListener)\s*\(|@OnEvent\s*\(/;
// A receiver that is the component itself, not a bus.
const SELF = new Set(["this", "vm", "self"]);
// Runtime event names (streams, DOM, process, sockets). They are not bus events.
const RUNTIME = new Set(
  (
    "data end error close finish exit message connection open readable drain click change input submit load resize " +
    "scroll keydown keyup mousedown mouseup focus blur request response listening ready connect disconnect timeout " +
    "warning uncaughtException unhandledRejection SIGINT SIGTERM beforeExit"
  ).split(" ")
);
const CALL_RE = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*(\$?)(emit|on|once|addListener)\s*\(/g;
const ON_EVENT_RE = /@OnEvent\s*\(/g;

// Loaded late: graph-links.js loads this file first.
const core = () => require("./graph-links.js");

function applies(ctx) {
  return APPLIES.test(String(ctx.raw || ""));
}

// The first argument of the call whose `(` is at `open`: the raw text up to
// the first top-level `,` or the close. The mask finds the bounds, so a comma
// in a string does not count. Returns null when the call does not close.
function firstArg(c, open) {
  const { m, src } = c;
  let depth = 0;
  for (let k = open + 1; k < m.length; k++) {
    const ch = m[k];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return src.slice(open + 1, k);
      depth--;
    } else if (ch === "," && depth === 0) return src.slice(open + 1, k);
  }
  return null;
}

// The close `)` of the call whose `(` is at `open`, in the mask. -1 = none.
function closeOf(m, open) {
  let depth = 0;
  for (let k = open; k < m.length; k++) {
    if (m[k] === "(") depth++;
    else if (m[k] === ")" && --depth === 0) return k;
  }
  return -1;
}

// Stage "code": the bus calls and the `@OnEvent` handlers. A match must start
// at a CODE position.
function code(ctx) {
  const { c, h } = ctx;
  const { m, src, starts } = c;
  if (!m || !src) return;
  const L = core();
  const isCode = (p) => m[p] === src[p];
  const push = (k, p, event) => {
    if (!k || !k.name || RUNTIME.has(k.name)) return;
    ctx.calls.push({ name: k.name, line: h.lineOf(starts, p), event, ...(k.via ? { via: true } : {}) });
  };
  let x;
  CALL_RE.lastIndex = 0;
  while ((x = CALL_RE.exec(m))) {
    if (!isCode(x.index)) continue;
    if (x.index > 0 && /[\w$.]/.test(m[x.index - 1])) continue;
    const recv = x[1].replace(/\s+/g, "");
    if (SELF.has(recv)) continue;
    const verb = x[3];
    if (x[2] && verb === "addListener") continue;
    const open = x.index + x[0].length - 1;
    const a = firstArg(c, open);
    if (a == null) continue;
    push(L.keyArg(a, ctx.consts), x.index, verb === "emit" ? "emit" : "on");
  }
  ON_EVENT_RE.lastIndex = 0;
  while ((x = ON_EVENT_RE.exec(m))) {
    if (!isCode(x.index)) continue;
    const open = x.index + x[0].length - 1;
    const a = firstArg(c, open);
    const close = closeOf(m, open);
    if (a == null || close < 0) continue;
    // The decorated method: the first name followed by `(` after the
    // decorators and the modifiers.
    const rest = m.slice(close + 1, close + 2000);
    const mm = /^(?:\s*@[\w$.]+\s*(?:\([^)]*\))?)*\s*(?:(?:public|private|protected|static|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*[(<]/.exec(rest);
    if (!mm) continue;
    const at = close + 1 + mm[0].lastIndexOf(mm[1]);
    push(L.keyArg(a, ctx.consts), at, "on");
  }
}

module.exports = { id: "events", langs: ["js", "ts", "vue", "svelte"], applies, code, RUNTIME };
