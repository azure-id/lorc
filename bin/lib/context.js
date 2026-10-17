"use strict";
// lorc context: the context pack. It links the names in the request and the doc to anchored
// line ranges (Agentless: file → symbol → line; LocAgent: entity → graph node, then 1 hop).
// The main session and the executors read these ranges, not whole files.
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const COMP_EXT = /\.(vue|jsx|tsx|svelte)$/i;
const STYLE_EXT = /\.(scss|sass|css|less)$/i;
const CLASS_GLOBS = ["*.vue", "*.scss", "*.sass", "*.css", "*.less", "*.svelte", "*.jsx", "*.tsx"];
const LOCALE = /(^|\/)(i18n|l10n|locales?|lang|langs|translations?)\/[^/]+\.json$/i;
const TEST = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const SRC = /\.([cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|rb|php|cs)$/i;
const STOP = new Set(("a an the and or of to in on at by for with from into onto as is are be been it its this that these those " +
  "there here then than so if else not no only all any each every some same like similar e g eg ie etc via per " +
  "i we you he she they them us our your their my me his her which what when where who how why also but too very " +
  "below above under over after before inside outside left right one two three four five first second 1st 2nd " +
  "do does done can could should would will must may might need needs").split(" "));
const VERBS = new Set(("build add wire make use using used show fetch render display update implement register get set put " +
  "call move change hit input select selecting type typing finish represent reflect become fill").split(" "));
const GENERIC = new Set("component components file files field fields css style styles behaviour behavior details detail note notes".split(" "));
const CUES = new Set("component components file css style".split(" "));
const UNITS = new Set("page flow step modal form list card dialog drawer table view panel wizard sheet".split(" "));

// ---------- small helpers ----------
const posix = (p) => String(p || "").replace(/\\/g, "/");
function stem(w) {
  w = String(w || "").toLowerCase();
  if (w.length <= 4) return w.replace(/s$/, "");
  return w.replace(/(ations|ation|ions|ion|ings|ing|ies|es|s|ed)$/, "") || w;
}
function splitWords(name) {
  return String(name || "").replace(/\.[^.]+$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
}
function git(root, args) {
  try {
    return cp.execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { return (e && typeof e.stdout === "string") ? e.stdout : ""; }
}

function makeCtx(root, loaded) {
  const ctx = { root, Q: loaded && loaded.Q, model: loaded && loaded.model, lines: new Map(), locales: new Map(), classUse: new Map() };
  ctx.files = git(root, ["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);
  if (!ctx.files.length && ctx.model) ctx.files = [...ctx.model.fileSet];
  ctx.fileSet = new Set(ctx.files);
  ctx.read = (rel) => {
    if (!ctx.lines.has(rel)) {
      let t = null;
      try { t = fs.readFileSync(path.join(root, rel), "utf8"); } catch (_) { t = null; }
      ctx.lines.set(rel, t === null ? null : t.split(/\r?\n/));
    }
    return ctx.lines.get(rel);
  };
  ctx.rec = (rel) => (ctx.model && ctx.model.byFile && ctx.model.byFile[rel]) || null;
  ctx.syms = (rel) => ((ctx.rec(rel) || {}).symbols || []);
  return ctx;
}

function loadGraph(root) {
  const R = require("./graph-router.js");
  const Q = require("./graph/graph-query.js");
  let sel = null;
  try { sel = R.selectStore(root); } catch (_) { sel = null; }
  const dirs = [];
  if (sel && sel.claudeDir) dirs.push(sel.claudeDir);
  dirs.push(path.join(root, ".claude", "lorc", "copy"), path.join(root, ".claude", "lorc"), path.join(root, ".claude"));
  for (const d of [...new Set(dirs)]) {
    let m = null;
    try { m = Q.loadModel(d, root); } catch (_) { m = null; }
    if (m) return { Q, model: m, claudeDir: d };
  }
  return null;
}

// ---------- 1. entities ----------
function entitiesOf(request, docText) {
  const out = [];
  const seen = new Set();
  const byKey = new Map();
  const add = (name, type, from, cue) => {
    name = String(name || "").trim();
    if (!name || name.length < 3) return;
    const k = type + ":" + name.toLowerCase();
    if (seen.has(k)) { if (cue) byKey.get(k).cue = true; return; }
    seen.add(k);
    const e = { name, type, from };
    if (cue) e.cue = true;
    byKey.set(k, e);
    out.push(e);
  };
  const sources = [["request", String(request || "")], ["doc", String(docText || "")]];
  for (const [from, raw] of sources) {
    const t = raw.replace(/```[\s\S]*?```/g, " ");
    for (const m of t.matchAll(/`([^`\n]{2,80})`/g)) add(m[1], /\.\w{1,5}$/.test(m[1]) ? "file" : (/^\//.test(m[1]) ? "url" : "symbol"), from);
    for (const m of t.matchAll(/(?:^|[\s(:'"])((?:GET|POST|PUT|PATCH|DELETE)\s+)?(\/[\w{}:.-]+(?:\/[\w{}:.-]+)+)/g)) {
      if (/\.\w{1,5}$/.test(m[2])) continue;
      add(m[2], "url", from);
    }
    for (const m of t.matchAll(/(?:^|[^\w/.-])([\w.-]*[A-Za-z0-9_-]\.(?:js|mjs|cjs|ts|vue|jsx|tsx|svelte|json|scss|css|less|svg|png|py|go|rb|java|kt))\b/g)) add(m[1], "file", from);
    for (const m of t.matchAll(/(?:^|[^\w-])([a-z][a-z0-9]*(?:-[a-z0-9]+)*__[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9-]+)?)/g)) add(m[1], "class", from);
    for (const m of t.matchAll(/(?:^|[^\w-])([a-z][a-z0-9]*(?:-[a-z0-9]+){2,})(?![\w.-])/g)) if (!/\d-/.test(m[1])) add(m[1], "class", from);
    for (const m of t.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g)) add(m[1], "symbol", from);
    for (const m of t.matchAll(/(?:^|[^\w.-])([a-z]+(?:[A-Z][a-z0-9]*)+)\b(?![.\w-])/g)) add(m[1], "symbol", from);
    for (const m of t.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) add(m[1], "symbol", from);
    for (const m of t.matchAll(/(?:^|[^\w"])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b(?!")/g)) add(m[1], "symbol", from);
    for (const m of t.matchAll(/"([^"\n]{2,60})"/g)) {
      const p = m[1].trim();
      const words = p.split(/\s+/);
      if (words.length > 6 || !/[A-Za-z]/.test(p) || /^[\w./-]+$/.test(p) && !/^[A-Z][a-z]+$/.test(p)) continue;
      add(p, "phrase", from);
    }
    for (const ph of nounPhrases(t)) add(ph.text, "noun", from, ph.cue);
  }
  return out;
}

function nounPhrases(text) {
  const out = [];
  const chunks = String(text).replace(/`[^`]*`/g, " , ").split(/[.,;:!?()\[\]{}<>"'\n*^&|=+#/\\]+|\s-+\s|->/);
  for (const c of chunks) {
    const toks = c.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
    let run = [];
    // cue: the phrase ends right before "component" / "file" / "css": the doc names a pattern to copy.
    const flush = (cue) => {
      for (let n = Math.min(4, run.length); n >= 2; n--) {
        for (let i = 0; i + n <= run.length; i++) {
          const win = run.slice(i, i + n);
          if (win.every((w) => VERBS.has(w))) continue;
          if (VERBS.has(win[n - 1])) continue;
          out.push({ text: win.join(" "), cue: !!cue && i + n === run.length });
        }
      }
      run = [];
    };
    for (const w of toks) {
      if (!/^[a-z][a-z-]*$/.test(w) || STOP.has(w) || GENERIC.has(w) || w.length < 3) { flush(CUES.has(w)); continue; }
      run.push(w);
    }
    flush();
  }
  return out;
}

// ---------- item helpers ----------
function item(kind, file, start, end, what, why, ctx, rank) {
  const it = { kind, file, start, end, what: String(what || "").slice(0, 600), why: String(why || "") };
  if (ctx && end - start + 1 <= 15) {
    const ls = ctx.read(file);
    if (ls) it.code = ls.slice(start - 1, end).join("\n");
  }
  Object.defineProperty(it, "rank", { value: rank || 0, enumerable: false, writable: true });
  return it;
}
const at = (it) => `${it.file}:${it.start}${it.end !== it.start ? "-" + it.end : ""}`;

// The rule range: from the match line to its closing brace at the same depth (≤ 60 lines).
function ruleRange(lines, i0) {
  let depth = 0;
  let opened = false;
  for (let i = i0; i < lines.length && i < i0 + 60; i++) {
    for (const ch of lines[i].replace(/\/\/.*$/, "")) {
      if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return [i0 + 1, i + 1];
  }
  return [i0 + 1, Math.min(lines.length, i0 + 1)];
}

// ---------- 2. resolve ----------
function resolveSymbol(ctx, e) {
  if (!ctx.model) return [];
  const defs = (ctx.model.byName.get(e.name) || []).filter((s) => s.kind !== "module");
  if (!defs.length || defs.length > 6) return [];
  return defs.slice(0, 3).map((s) => item("symbol", s.file, s.lines[0], Math.min(s.lines[1], s.lines[0] + 79), `${s.kind} ${s.name}`, `named "${e.name}"`, ctx, 6));
}

function resolveFile(ctx, e) {
  const n = posix(e.name).replace(/^\.\//, "");
  const hits = ctx.files.filter((f) => f === n || f.endsWith("/" + n)).slice(0, 3);
  return hits.map((f) => {
    const ls = ctx.read(f) || [];
    return item("file", f, 1, Math.max(1, ls.length), `file ${path.posix.basename(f)} (${ls.length} lines)`, `named "${e.name}"`, null, 7);
  });
}

function resolveClasses(ctx, ents) {
  const classes = ents.filter((e) => e.type === "class");
  if (!classes.length) return;
  const args = ["grep", "-n", "-F"];
  const pats = new Set();
  for (const e of classes) {
    pats.add(e.name);
    const b = e.name.split("__")[0];
    if (e.name.includes("__")) pats.add("." + b);
  }
  for (const p of pats) args.push("-e", p);
  args.push("--", ...CLASS_GLOBS);
  const rows = [];
  for (const line of git(ctx.root, args).split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (m) rows.push({ file: m[1], line: +m[2], text: m[3] });
    if (rows.length > 400) break;
  }
  for (const e of classes) {
    const items = [];
    const block = e.name.split("__")[0];
    const elem = e.name.includes("__") ? e.name.slice(block.length) : null;
    const styleRow = (r) => STYLE_EXT.test(r.file) || (r.file.endsWith(".vue") && inStyle(ctx, r.file, r.line));
    // Style rule: the full selector, or `&__<element>` inside the file that holds `.<block>`.
    const direct = rows.filter((r) => r.text.includes("." + e.name) && styleRow(r));
    for (const r of direct.slice(0, 2)) {
      const ls = ctx.read(r.file);
      if (!ls) continue;
      const [s, en] = ruleRange(ls, r.line - 1);
      items.push(item("style", r.file, s, en, `style rule .${e.name}`, `class "${e.name}"`, ctx, 4));
    }
    if (elem && !items.length) {
      const holders = [...new Set(rows.filter((r) => styleRow(r) && new RegExp("\\." + esc(block) + "(?![\\w-])").test(r.text)).map((r) => r.file))];
      for (const f of holders) {
        const ls = ctx.read(f);
        if (!ls) continue;
        const base = elem.replace(/--.*$/, "");
        const mod = elem.slice(base.length);
        const amp = (x) => new RegExp("&" + esc(x) + "(?![\\w-])");
        // `&__elem--mod` as one selector, else `&__elem` and `&--mod` inside its rule.
        let i = mod ? ls.findIndex((l) => amp(elem).test(l)) : -1;
        let s, en;
        if (i >= 0) [s, en] = ruleRange(ls, i);
        else {
          i = ls.findIndex((l) => amp(base).test(l));
          if (i < 0) continue;
          [s, en] = ruleRange(ls, i);
          if (mod) {
            const j = ls.slice(s, en).findIndex((l) => amp(mod).test(l));
            if (j >= 0) [s, en] = ruleRange(ls, s + j);
          }
        }
        items.push(item("style", f, s, en, `style rule &${elem} in .${block}`, `class "${e.name}"`, ctx, 4));
        if (items.length >= 2) break;
      }
    }
    const usedFiles = new Set();
    // All template usages of the class, per file: the exemplar rank counts them.
    for (const r of rows) {
      if (styleRow(r) || !new RegExp("(^|[^\w-])" + esc(e.name) + "(?![\w-])").test(r.text)) continue;
      if (!ctx.classUse.has(r.file)) ctx.classUse.set(r.file, new Set());
      ctx.classUse.get(r.file).add(e.name);
    }
    for (const r of rows) {
      if (items.length >= 3) break;
      if (styleRow(r) || usedFiles.has(r.file)) continue;
      if (!new RegExp("(^|[^\\w-])" + esc(e.name) + "(?![\\w-])").test(r.text)) continue;
      usedFiles.add(r.file);
      items.push(item("usage", r.file, r.line, r.line, `template uses .${e.name}`, `class "${e.name}"`, null, 2));
    }
    e.items = items;
  }
}
function inStyle(ctx, rel, line) {
  const ls = ctx.read(rel);
  if (!ls) return false;
  for (let i = line - 1; i >= 0; i--) {
    if (/^\s*<style/.test(ls[i])) return true;
    if (/^\s*<\/(template|script)>/.test(ls[i]) || /^\s*<(template|script)/.test(ls[i])) return false;
  }
  return false;
}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function urlSegs(u) { return String(u || "").split("?")[0].split("/").filter(Boolean); }
function resolveUrl(ctx, e) {
  const want = urlSegs(e.name);
  const out = [];
  if (ctx.model) {
    for (const rel of Object.keys(ctx.model.byFile || {})) {
      for (const s of ctx.syms(rel)) {
        for (const u of s.urls || []) {
          const have = urlSegs(u.url);
          let k = 0;
          while (k < want.length && k < have.length && want[k] === have[k]) k++;
          if (k >= 2 && out.length < 3) out.push(item("api", rel, s.lines[0], s.lines[1], `${s.name} · ${u.method || ""} ${u.url}`, `URL "${e.name}"`, ctx, 6));
        }
      }
    }
  }
  if (out.length) return out;
  const tail = want.filter((w) => !/^[{:]/.test(w)).slice(-2).join("/");
  if (!tail.includes("/")) return out;
  const rows = git(ctx.root, ["grep", "-n", "-F", "-e", tail]).split("\n");
  for (const line of rows) {
    const m = /^(.+?):(\d+):/.exec(line);
    if (!m || !/(^|\/)(api|services?|mocks?|mockoon|fixtures?)\//i.test(m[1])) continue;
    out.push(item("api", m[1], +m[2], +m[2], `mentions ${tail}`, `URL "${e.name}"`, ctx, 5));
    if (out.length >= 3) break;
  }
  return out;
}

// Locale JSON: a line scan with a key stack. Each key → { path, line, end, value, depth }.
function localeKeys(ctx, rel) {
  if (ctx.locales.has(rel)) return ctx.locales.get(rel);
  const ls = ctx.read(rel) || [];
  const keys = [];
  const stack = [];
  ls.forEach((l, i) => {
    const m = /^\s*"((?:[^"\\]|\\.)*)"\s*:\s*(\{|"((?:[^"\\]|\\.)*)")?/.exec(l);
    if (m && m[2] === "{") {
      const k = { key: m[1], path: [...stack.map((s) => s.key), m[1]].join("."), line: i + 1, end: i + 1, depth: stack.length, children: [] };
      if (stack.length) stack[stack.length - 1].children.push(k);
      keys.push(k);
      stack.push(k);
      if (/\}\s*,?\s*$/.test(l.slice(m[0].length))) { stack.pop(); }
      return;
    }
    if (m && m[3] !== undefined) {
      const k = { key: m[1], path: [...stack.map((s) => s.key), m[1]].join("."), line: i + 1, end: i + 1, depth: stack.length, value: m[3] };
      if (stack.length) stack[stack.length - 1].children.push(k);
      keys.push(k);
    }
    if (/^\s*\}/.test(l) && stack.length) { stack[stack.length - 1].end = i + 1; stack.pop(); }
  });
  ctx.locales.set(rel, keys);
  return keys;
}
function localeFiles(ctx) { return ctx.files.filter((f) => LOCALE.test(f) && !TEST.test(f)).slice(0, 6); }

function resolvePhrase(ctx, e) {
  const want = e.name.toLowerCase();
  const out = [];
  for (const f of localeFiles(ctx)) {
    for (const k of localeKeys(ctx, f)) {
      if (k.value !== undefined && k.value.toLowerCase() === want) {
        out.push(item("i18n", f, k.line, k.line, `${k.path} = "${k.value}"`, `text "${e.name}"`, null, 4));
        break;
      }
    }
    if (out.length >= 3) break;
  }
  return out;
}

function fileWords(ctx) {
  if (!ctx.fw) {
    ctx.fw = ctx.files.filter((f) => SRC.test(f) && !TEST.test(f)).map((f) => ({ f, w: new Set(splitWords(path.posix.basename(f)).map(stem)) }));
  }
  return ctx.fw;
}
function resolveNoun(ctx, e) {
  const words = e.name.split(" ").filter((w) => !VERBS.has(w) || e.name.split(" ").length > 2 || true).map(stem);
  const hits = fileWords(ctx).filter((x) => words.every((w) => x.w.has(w)));
  if (!hits.length || hits.length > 8) return [];
  hits.sort((a, b) => (COMP_EXT.test(b.f) - COMP_EXT.test(a.f)) || (a.w.size - b.w.size) || a.f.localeCompare(b.f));
  const exact = (x) => x.w.size === new Set(words).size;
  const pick = exact(hits[0]) ? hits.filter(exact) : hits;
  return pick.slice(0, 2).map((x) => {
    const ls = ctx.read(x.f) || [];
    const cls = ctx.syms(x.f).find((s) => s.kind === "class");
    const it = item("component", x.f, cls ? cls.lines[0] : 1, cls ? cls.lines[1] : Math.max(1, ls.length), `${path.posix.basename(x.f)}`, `phrase "${e.name}"`, null, 3);
    // exact: the basename words are the phrase words. The exemplar rank uses it.
    Object.defineProperty(it, "weight", { value: (x.w.size === new Set(words).size ? 1 : 0.5) + (e.cue ? 3 : 0), enumerable: false });
    return it;
  });
}

function resolveAll(ctx, ents) {
  resolveClasses(ctx, ents);
  const doneNoun = [];
  for (const e of ents) {
    if (e.type === "class") continue;
    if (e.type === "symbol") e.items = resolveSymbol(ctx, e);
    else if (e.type === "file") e.items = resolveFile(ctx, e);
    else if (e.type === "url") e.items = resolveUrl(ctx, e);
    else if (e.type === "phrase") e.items = resolvePhrase(ctx, e);
    else if (e.type === "noun") {
      const ws = e.name.split(" ");
      // A shorter phrase inside a resolved longer phrase adds nothing.
      if (doneNoun.some((d) => ws.every((w) => d.includes(w)))) { e.items = []; continue; }
      e.items = resolveNoun(ctx, e);
      if (e.items.length) doneNoun.push(ws);
    }
  }
}

// ---------- 3. targets ----------
function wordStems(text) {
  return new Set(String(text || "").split(/[^A-Za-z0-9]+/).flatMap(splitWords).filter((w) => w.length > 2 && !STOP.has(w) && !VERBS.has(w)).map(stem));
}

function routeTargets(ctx, routerFile, reqStems) {
  const out = [];
  if (!routerFile) return out;
  const ls = ctx.read(routerFile);
  if (!ls) return out;
  let routes = ctx.syms(routerFile).filter((s) => s.kind === "route").map((s) => ({ s, path: s.name.replace(/^\w+\s+/, ""), start: s.lines[0], end: s.lines[1] }));
  if (!routes.length) routes = regexRoutes(ls);
  const text = (r) => ls.slice(r.start - 1, Math.min(r.end, r.start + 12)).join("\n");
  for (const r of routes) {
    const body = text(r);
    const nm = /\bname:\s*([^,\n}]+)/.exec(body);
    const co = /\bcomponent:\s*([^,\n}]+)/.exec(body);
    r.name = (r.s && r.s.route_name) || (nm ? nm[1].trim().replace(/^['"]|['"]$/g, "") : "");
    r.component = co ? co[1].trim().slice(0, 60) : "";
    const st = new Set([...splitWords(r.path), ...splitWords(r.name)].map(stem));
    r.score = [...st].filter((w) => reqStems.has(w)).length;
  }
  const parentOf = (r) => routes.filter((p) => p !== r && p.start <= r.start && p.end >= r.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0] || null;
  const groups = new Map();
  for (const r of routes) {
    const p = parentOf(r);
    if (!p) continue;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(r);
  }
  let best = null;
  for (const [p, kids] of groups) {
    const direct = kids.filter((k) => parentOf(k) === p);
    if (!direct.length) continue;
    const sc = p.score * 2 + Math.max(...direct.map((k) => k.score));
    if (!best || sc > best.sc) best = { p, kids: direct, sc };
  }
  if (!best || best.sc <= 0) return out;
  const { p, kids } = best;
  const firstKid = Math.min(...kids.map((k) => k.start));
  const lastKid = kids.reduce((a, b) => (b.end > a.end ? b : a));
  const row = (r, s, e, why, rank) => item("route", routerFile, s, e, `${r.path} · ${r.name || "-"} · ${r.component || "-"}`, why, ctx, rank);
  out.push(row(p, p.start, Math.min(firstKid - 1, p.start + 79), "parent route with children", 9));
  for (const k of kids.filter((k) => k.score > 0).sort((a, b) => b.score - a.score || a.start - b.start).slice(0, 2)) {
    const r = row(k, k.start, Math.min(k.end, k.start + 79), "route that shares words with the request", 8);
    delete r.code;
    out.push(r);
  }
  const hint = item("insert", routerFile, lastKid.end, lastKid.end, `new child route goes near ${routerFile}:${lastKid.end} (siblings of ${p.path})`, "insertion point", ctx, 10);
  hint.code = undefined;
  delete hint.code;
  out.push(hint);
  return out;
}
function regexRoutes(ls) {
  const out = [];
  ls.forEach((l, i) => {
    const m = /\bpath:\s*['"`]([^'"`]+)['"`]/.exec(l);
    if (!m) return;
    let j = i;
    while (j > 0 && !/\{\s*$/.test(ls[j]) && i - j < 3) j--;
    const [s, e] = ruleRange(ls, j);
    out.push({ s: null, path: m[1], start: s, end: Math.max(e, s) });
  });
  return out;
}

function apiTarget(ctx, ents, engine) {
  const named = ents.filter((e) => e.type === "file" && /(\.api\.[jt]s|(^|\/)api\/)/i.test(e.name)).flatMap((e) => (e.items || []).map((i) => i.file));
  const urlHit = ents.filter((e) => e.type === "url").flatMap((e) => (e.items || []).map((i) => i.file));
  const g = (engine && engine.detail && engine.detail.graph) || {};
  const file = named[0] || urlHit[0] || g.api || null;
  if (!file) return [];
  const ls = ctx.read(file) || [];
  let ex = ctx.syms(file).filter((s) => s.exported && s.kind !== "module").map((s) => ({ name: s.name, start: s.lines[0], end: s.lines[1], urls: s.urls || [] }));
  if (!ex.length) {
    ls.forEach((l, i) => {
      const m = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/.exec(l);
      if (m) ex.push({ name: m[1], start: i + 1, end: i + 1, urls: [] });
    });
    for (let k = 0; k < ex.length; k++) ex[k].end = Math.max(ex[k].start, (k + 1 < ex.length ? ex[k + 1].start - 1 : ls.length));
    for (const x of ex) while (x.end > x.start && !String(ls[x.end - 1]).trim()) x.end--;
  }
  if (!ex.length) return [];
  const last = ex.reduce((a, b) => (b.end > a.end ? b : a));
  const rows = ex.slice(-12).map((x) => {
    let url = (x.urls[0] && x.urls[0].url && x.urls[0].url !== "/{}") ? x.urls[0].url : "";
    if (!url) {
      const body = ls.slice(x.start - 1, x.end).join(" ");
      const m = /[`'"](\/[^`'"\s]*)[`'"]/.exec(body);
      if (m) url = m[1];
    }
    return `${x.name} · ${x.start}${url ? " · " + url : ""}`;
  });
  const it = item("api", file, ex[0].start, last.end, `exports: ${rows.join("; ")}`, "API module", null, 9);
  const hint = item("insert", file, last.end, last.end, `append after line ${last.end} (after ${last.name})`, "new API function", ctx, 10);
  delete hint.code;
  return [it, hint];
}

function featureDirs(engine) {
  const g = (engine && engine.detail && engine.detail.graph) || {};
  const dirs = [];
  if (g.feature) {
    dirs.push(g.feature);
    if (/\/components?$/.test(g.feature)) dirs.push(path.posix.dirname(g.feature));
  }
  for (const h of g.hosts || []) dirs.push(path.posix.dirname(h));
  for (const c of g.core || []) dirs.push(path.posix.dirname(c));
  return [...new Set(dirs)];
}

function constantTargets(ctx, engine, reqStems) {
  const g = (engine && engine.detail && engine.detail.graph) || {};
  const featStems = new Set(featureDirs(engine).flatMap((d) => d.split("/").flatMap(splitWords)).map(stem));
  const dirs = featureDirs(engine).map((d) => d.replace(/\/(constants?|components?)$/, ""));
  const named = /(^|\/)(constants?|keys?|routes?)(\/|\.[jt]s$)|(Keys|Routes|Constants)\.[jt]s$/;
  const cands = new Set((g.hosts || []).concat(g.core || []).filter((f) => named.test(f)));
  for (const f of ctx.files) {
    if (!/\.[jt]s$/.test(f) || TEST.test(f) || !named.test(f)) continue;
    if (dirs.some((d) => f.startsWith(d + "/") && f.slice(d.length + 1).split("/").length <= 2)) cands.add(f);
  }
  let scored = [...cands].map((f) => ({ f, sc: splitWords(path.posix.basename(f)).map(stem).filter((w) => reqStems.has(w)).length })).sort((a, b) => b.sc - a.sc || a.f.localeCompare(b.f));
  if (scored.some((x) => x.sc > 0)) scored = scored.filter((x) => x.sc > 0);
  scored = scored.slice(0, 3);
  const out = [];
  for (const { f } of scored) {
    const ls = ctx.read(f);
    if (!ls) continue;
    // A file whose name shares only feature-folder words (outwardDetails.js) ranks low.
    const specific = splitWords(path.posix.basename(f)).map(stem).some((w) => reqStems.has(w) && !featStems.has(w));
    const rank = specific ? 8 : 3;
    if (ls.length <= 15) { out.push(item("constants", f, 1, ls.length, "feature constants", "feature constants", ctx, rank)); continue; }
    const names = [];
    ls.forEach((l, i) => { const m = /^export\s+(?:const|let|function|class)\s+([\w$]+)/.exec(l); if (m) names.push(`${m[1]} · ${i + 1}`); });
    out.push(item("constants", f, 1, ls.length, `exports: ${names.slice(0, 10).join("; ")}`, "feature constants", null, rank));
  }
  return out;
}

function i18nTargets(ctx, request) {
  const req = String(request || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w) && !VERBS.has(w));
  const cands = new Set();
  for (let n = 3; n >= 1; n--) for (let i = 0; i + n <= req.length; i++) cands.add(req.slice(i, i + n).join("_").toUpperCase());
  const out = [];
  for (const f of localeFiles(ctx)) {
    const keys = localeKeys(ctx, f).filter((k) => k.children && k.depth <= 1);
    let best = null;
    for (const k of keys) {
      const K = k.key.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      if (!cands.has(K)) continue;
      const n = K.split("_").length;
      if (!best || n > best.n || (n === best.n && k.end - k.line < best.k.end - best.k.line)) best = { k, n };
    }
    if (!best || (best.n < 2 && best.k.end - best.k.line > 200)) continue;
    const kids = best.k.children.slice(0, 12).map((c) => `${c.key} · ${c.line}`);
    out.push(item("i18n", f, best.k.line, best.k.end, `${best.k.path} keys: ${kids.join("; ")}`, "locale block of the feature", ctx, 9));
  }
  return out;
}

function ctaTargets(ctx, consts, reqStems, routerFile) {
  const out = [];
  let best = null;
  for (const c of consts) {
    const ls = ctx.read(c.file) || [];
    let obj = null;
    ls.forEach((l) => {
      const o = /^export\s+const\s+(\w*ROUTE\w*)\s*=\s*\{/.exec(l);
      if (o) { obj = o[1]; return; }
      if (/^\s*\}/.test(l)) obj = null;
      const m = obj && /^\s*(\w+)\s*:\s*['"]([\w-]+)['"]/.exec(l);
      if (!m) return;
      const sc = splitWords(m[2]).map(stem).filter((w) => reqStems.has(w)).length + (/^(CREATE|NEW|ADD)$/.test(m[1]) ? 0.5 : 0);
      if (!best || sc > best.sc) best = { sc, ref: `${obj}.${m[1]}`, value: m[2], file: c.file };
    });
  }
  if (!best || best.sc < 1) return out;
  const rows = git(ctx.root, ["grep", "-n", "-F", "-e", best.ref, "-e", `'${best.value}'`, "-e", `"${best.value}"`]).split("\n");
  const seen = new Set();
  const pending = [];
  for (const line of rows) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m || m[1] === best.file || m[1] === routerFile || TEST.test(m[1]) || !SRC.test(m[1])) continue;
    if (!m[3].includes(best.ref) && !/name\s*:|\.push\(|\.replace\(|to=|:to=|^\s*(const|let|var)\s/.test(m[3])) continue;
    const alias = /^\s*(?:const|let|var)\s+(\w+)\s*=\s*['"]/.exec(m[3]);
    if (alias) {
      const ls = ctx.read(m[1]) || [];
      const i = ls.findIndex((l, k) => k > +m[2] - 1 && new RegExp("\\b" + alias[1] + "\\b").test(l));
      if (i >= 0) pending.push({ file: m[1], line: i + 1 });
      continue;
    }
    pending.push({ file: m[1], line: +m[2] });
  }
  for (const p of pending) {
    if (seen.has(p.file) || out.length >= 2) continue;
    seen.add(p.file);
    const enc = ctx.syms(p.file).filter((s) => s.lines[0] <= p.line && s.lines[1] >= p.line && /method|function/.test(s.kind)).sort((a, b) => (a.lines[1] - a.lines[0]) - (b.lines[1] - b.lines[0]))[0];
    const s = enc ? enc.lines[0] : p.line;
    const e = enc ? Math.min(enc.lines[1], enc.lines[0] + 40) : p.line;
    out.push(item("entry", p.file, s, e, `uses ${best.ref} / '${best.value}' at line ${p.line}${enc ? " in " + enc.name + "()" : ""}`, "entry / CTA", ctx, 8));
  }
  return out;
}

// ---------- 4. exemplars + 1 hop ----------
function cardOf(ctx, rel) {
  const ls = ctx.read(rel) || [];
  const syms = ctx.syms(rel);
  const cls = syms.find((s) => s.kind === "class");
  const tpl = syms.find((s) => s.kind === "template");
  const props = syms.filter((s) => s.kind === "prop").map((s) => `${s.name} ${s.lines[0]}`);
  const methods = syms.filter((s) => s.kind === "method").slice(0, 12).map((s) => `${s.name} ${s.lines[0]}`);
  const emits = [];
  ls.forEach((l, i) => { for (const m of l.matchAll(/\$emit\(\s*['"]([\w:-]+)/g)) if (!emits.some((x) => x.startsWith(m[1] + " "))) emits.push(`${m[1]} ${i + 1}`); });
  const kids = ((ctx.rec(rel) || {}).imports || []).filter((im) => COMP_EXT.test(im.from || "")).flatMap((im) => (im.bindings || []).map((b) => b.local));
  if (!ctx.rec(rel)) ls.forEach((l) => { const m = /^\s*import\s+(\w+)\s+from\s+['"][^'"]+\.(vue|jsx|tsx|svelte)['"]/.exec(l); if (m) kids.push(m[1]); });
  const parts = [];
  if (cls) parts.push(`class ${cls.lines[0]}-${cls.lines[1]}`);
  if (tpl) parts.push(`template ${tpl.lines[0]}-${tpl.lines[1]}`);
  if (props.length) parts.push(`props: ${props.slice(0, 10).join(", ")}`);
  if (emits.length) parts.push(`emits: ${emits.slice(0, 8).join(", ")}`);
  if (methods.length) parts.push(`methods: ${methods.join(", ")}`);
  if (kids.length) parts.push(`uses: ${[...new Set(kids)].slice(0, 8).join(", ")}`);
  let s = parts.join(" · ");
  if (s.length > 600) s = s.slice(0, 597) + "...";
  return { text: s, start: cls ? cls.lines[0] : 1, end: cls ? cls.lines[1] : Math.max(1, ls.length) };
}
function exportsCard(ctx, rel) {
  if (COMP_EXT.test(rel)) return cardOf(ctx, rel);
  const ls = ctx.read(rel) || [];
  let ex = ctx.syms(rel).filter((s) => s.exported && s.kind !== "module").map((s) => `${s.name} ${s.lines[0]}`);
  if (!ex.length) ls.forEach((l, i) => { const m = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/.exec(l); if (m) ex.push(`${m[1]} ${i + 1}`); });
  return { text: `exports: ${ex.slice(0, 8).join(", ") || "-"}`, start: 1, end: Math.max(1, ls.length) };
}
function importsOf(ctx, rel) {
  if (ctx.Q && ctx.model && ctx.rec(rel)) {
    try { return ctx.Q.importsOf(ctx.model, rel).files || []; } catch (_) { /* fall through */ }
  }
  const ls = ctx.read(rel) || [];
  const out = [];
  for (const l of ls) {
    const m = /^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/.exec(l);
    if (!m) continue;
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    for (const c of [p, p + ".js", p + ".ts", p + ".vue", p + "/index.js"]) if (ctx.fileSet.has(c)) { out.push(c); break; }
  }
  return out;
}

function exemplars(ctx, ents, engine) {
  const g = (engine && engine.detail && engine.detail.graph) || {};
  const score = new Map();
  const bump = (f, n) => { if (COMP_EXT.test(f) && !TEST.test(f)) score.set(f, (score.get(f) || 0) + n); };
  for (const e of ents) for (const it of e.items || []) {
    if (it.kind === "component") bump(it.file, it.weight || 1);
    else if (it.kind === "symbol" || it.kind === "file") bump(it.file, 1);
  }
  const uses = new Map([...ctx.classUse].map(([f, set]) => [f, set.size]));
  // Class usages count at most 2; the count of distinct classes breaks ties.
  // A file that shares words with a cue phrase ("swap modal selection" → SwapSelectStep) ranks first.
  const cueStems = new Set(ents.filter((e) => e.cue).flatMap((e) => e.name.split(" ").map(stem)));
  for (const [f, n] of uses) {
    const shared = splitWords(path.posix.basename(f)).map(stem).filter((w) => cueStems.has(w)).length;
    bump(f, Math.min(2, n) + n * 0.01 + shared * 0.25);
  }
  // The engine names the generic component to reuse (Stepper.vue): the new code renders it.
  for (const f of reuseFiles(ctx, engine)) bump(f, 3);
  const seeds = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((x) => x[0]);
  const top = seeds.slice(0, 3);
  // Create unit nouns: files whose basename ends with the noun, near the feature.
  const nouns = [...new Set((((engine || {}).detail || {}).text || {}).creates ? engine.detail.text.creates.map((c) => c.noun).filter((n) => UNITS.has(n)) : [])];
  const feature = g.feature || "";
  const seedImports = new Set(top.flatMap((f) => importsOf(ctx, f)));
  const area = (f) => f.split("/").slice(0, 3).join("/");
  const areas = new Set(top.map(area).concat(feature ? [area(feature)] : []));
  const dist = (a, b) => { const x = a.split("/"); const y = b.split("/"); let k = 0; while (k < x.length && k < y.length && x[k] === y[k]) k++; return x.length + y.length - 2 * k; };
  const cueShared = (f) => splitWords(path.posix.basename(f)).map(stem).filter((w) => cueStems.has(w)).length;
  const extra = [];
  for (const n of nouns) {
    const Cap = n[0].toUpperCase() + n.slice(1);
    const c = ctx.files.filter((f) => COMP_EXT.test(f) && !TEST.test(f) && areas.has(area(f)) && path.posix.basename(f).replace(/\.\w+$/, "").endsWith(Cap) && path.posix.basename(f).replace(/\.\w+$/, "") !== Cap);
    // Cheap rank first (a seed imports it, it uses the doc's classes, near the feature); then shared imports.
    const pre = c.map((f) => ({ f, by: seedImports.has(f) ? 1 : 0, cu: (ctx.classUse.get(f) || new Set()).size + 1.5 * cueShared(f), d: feature ? dist(f, feature) : 0 }))
      .sort((a, b) => b.by - a.by || b.cu - a.cu || a.d - b.d || a.f.localeCompare(b.f)).slice(0, 8);
    const ranked = pre.map((x) => Object.assign(x, { sh: importsOf(ctx, x.f).filter((y) => seedImports.has(y)).length }))
      .sort((a, b) => b.by - a.by || b.cu - a.cu || b.sh - a.sh || a.d - b.d || a.f.localeCompare(b.f));
    for (const r of ranked.slice(0, 2)) extra.push(r.f);
  }
  const list = [...new Set([...top, ...extra])].slice(0, 4);
  const items = list.map((f, i) => {
    const c = cardOf(ctx, f);
    return item("exemplar", f, c.start, c.end, c.text, top.includes(f) ? "named by the request or the doc" : "same unit kind near the feature", null, 7 - i * 0.5);
  });
  // 1 hop: imported components / utils / api modules, ranked by how many exemplars import them.
  const count = new Map();
  for (const f of list) {
    for (const t of importsOf(ctx, f)) {
      if (list.includes(t) || TEST.test(t) || STYLE_EXT.test(t) || !SRC.test(t)) continue;
      const own = t.startsWith(path.posix.dirname(f) + "/");
      // Child components first, then api / utils; a shared "constants.js" is too wide to help.
      const kindBonus = (COMP_EXT.test(t) ? 0.6 : (/(^|\/)(api|services?|utils?|helpers?)\//.test(t) || /\.api\.[jt]s$/.test(t) ? 0.3 : 0))
        - (/(^|\/)constants?\.[jt]s$/.test(t) ? 1 : 0);
      count.set(t, (count.get(t) || 0) + 1 + (own ? 0 : 0.5) + kindBonus);
    }
  }
  const hop = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([t, n], i) => {
    const c = exportsCard(ctx, t);
    return item("reuse", t, c.start, c.end, c.text, `imported by ${Math.floor(n)} exemplar(s)`, null, (Math.floor(n) >= 2 ? 5.5 : 3) - i * 0.2);
  });
  return { items, hop, list };
}

// Reused generic components: engine.detail.graph.reuse, else the "reuse: X.vue" line of engine.why.
function reuseFiles(ctx, engine) {
  const g = (engine && engine.detail && engine.detail.graph) || {};
  const out = Object.values(g.reuse || {});
  for (const w of (engine && engine.why) || []) {
    const m = /^reuse:\s*([\w.-]+\.\w+)/.exec(String(w));
    if (!m) continue;
    const hit = ctx.files.filter((f) => path.posix.basename(f) === m[1] && !TEST.test(f));
    const top = (f) => f.split("/").slice(0, 4).join("/");
    const near = g.feature ? hit.filter((f) => top(f) === top(g.feature)) : [];
    if (near.length || hit.length) out.push((near.length ? near : hit)[0]);
  }
  return [...new Set(out)];
}

// ---------- 5. tests ----------
function testExemplars(ctx, list, engine) {
  const g = (engine && engine.detail && engine.detail.graph) || {};
  const names = list.map((f) => path.posix.basename(f).replace(/\.\w+$/, ""));
  const feat = g.feature ? path.posix.basename(g.feature.replace(/\/components?$/, "")) : null;
  const cands = [];
  for (const f of ctx.files) {
    if (!TEST.test(f) || !/\.[cm]?[jt]sx?$/.test(f)) continue;
    const ls = ctx.read(f);
    if (!ls) continue;
    const imps = ls.slice(0, 80).filter((l) => /\bimport\b|require\(/.test(l)).join("\n");
    const hit = names.filter((n) => new RegExp("[/'\"]" + esc(n) + "\\w*(\\.\\w+)?['\"]").test(imps));
    const fhit = feat && imps.includes("/" + feat + "/");
    if (!hit.length && !fhit) continue;
    const base = path.posix.basename(f);
    const sc = hit.length * 2 + (fhit ? 1 : 0) + (/Journey/.test(base) ? 2 : 0) + (names.some((n) => base.startsWith(n)) ? 1 : 0);
    cands.push({ f, sc, ls });
  }
  cands.sort((a, b) => b.sc - a.sc || a.f.localeCompare(b.f));
  return cands.slice(0, 2).map(({ f, ls }) => {
    const d = ls.findIndex((l) => /^\s*describe(\.\w+)?\(/.test(l));
    const firstIt = ls.findIndex((l, i) => i > d && /^\s*(it|test)(\.\w+)?\(/.test(l));
    const end = d > 0 ? Math.min(d, 80) : Math.min(ls.length, 80);
    return item("test", f, 1, Math.max(1, end), `setup 1-${end}${d >= 0 ? `; first describe ${d + 1}` : ""}${firstIt >= 0 ? `; first it ${firstIt + 1}` : ""}`, "test exemplar", null, 6);
  });
}

// ---------- 6. text ----------
function render(request, sections) {
  const head = `# Context — ${String(request || "").replace(/\s+/g, " ").slice(0, 80)}\n`;
  const tail = "\nRead only these ranges (Read offset/limit). Do not cat whole files.\n";
  let body = "";
  for (const [title, items] of sections) {
    if (!items.length) continue;
    body += `\n## ${title}\n`;
    for (const it of items) {
      body += `- ${at(it)} — ${it.what} (${it.why})\n`;
      if (it.code) body += "```\n" + it.code + "\n```\n";
    }
  }
  return head + body + tail;
}

function build(root, request, opts = {}) {
  const t0 = Date.now();
  root = path.resolve(root || process.cwd());
  const maxBytes = opts.maxBytes || 8192;
  let docText = "";
  let docRel = null;
  if (opts.doc) {
    const p = path.isAbsolute(opts.doc) ? opts.doc : (fs.existsSync(path.join(root, opts.doc)) ? path.join(root, opts.doc) : path.resolve(opts.doc));
    try { docText = fs.readFileSync(p, "utf8"); docRel = posix(path.relative(root, p)); } catch (_) { docText = ""; }
  }
  let loaded = opts.loaded;
  if (loaded === undefined) { try { loaded = loadGraph(root); } catch (_) { loaded = null; } }
  let engine = opts.engine;
  if (engine === undefined) {
    try { engine = require("./tier.js").compute(root, request, { doc: opts.doc, history: false }); } catch (_) { engine = null; }
  }
  const ctx = makeCtx(root, loaded);
  const ents = entitiesOf(request, docText);
  resolveAll(ctx, ents);
  const g = (engine && engine.detail && engine.detail.graph) || {};
  const reqStems = wordStems(request);
  const allStems = new Set([...reqStems, ...wordStems(docText.slice(0, 600))]);
  const routerFile = g.router || ctx.files.find((f) => /(^|\/)router\/index\.[jt]s$/.test(f)) || null;
  const targets = [];
  targets.push(...routeTargets(ctx, routerFile, reqStems.size ? reqStems : allStems));
  targets.push(...apiTarget(ctx, ents, engine));
  const consts = constantTargets(ctx, engine, reqStems);
  targets.push(...consts);
  targets.push(...i18nTargets(ctx, request));
  targets.push(...ctaTargets(ctx, consts, reqStems, routerFile));
  const ex = exemplars(ctx, ents, engine);
  const tests = testExemplars(ctx, ex.list, engine);
  // Entity rows: drop rows that a target or an exemplar already covers.
  const covered = new Set([...targets, ...ex.items, ...tests].map((i) => i.file));
  const entItems = [];
  const styles = new Map();
  for (const e of ents) {
    e.items = (e.items || []).filter((i) => !(covered.has(i.file) && i.kind !== "style" && i.kind !== "usage"));
    for (const i of e.items.slice(0, 3)) {
      if (i.kind === "style") {
        if (!styles.has(i.file)) styles.set(i.file, new Map());
        styles.get(i.file).set(e.name, i);
        continue;
      }
      if (!entItems.some((x) => x.file === i.file && x.start === i.start)) entItems.push(i);
    }
  }
  // The style rules of one file: ONE line, no code, ranked like an exemplar.
  for (const [f, m] of styles) {
    const rows = [...m.entries()].sort((a, b) => a[1].start - b[1].start);
    const short = (n) => (n.includes("__") ? n.slice(n.indexOf("__")) : "." + n);
    entItems.unshift(item("style", f, Math.min(...rows.map((x) => x[1].start)), Math.max(...rows.map((x) => x[1].end)),
      `style rules for ${rows.length} doc classes: ${rows.map(([n, i]) => `${short(n)} ${i.start}-${i.end}`).join(", ")}`, "doc classes", null, 6.8));
  }
  // Max 30 items; drop the lowest-ranked first, also to fit maxBytes.
  const pools = { names: entItems, targets, exemplars: ex.items, tests, reuse: ex.hop };
  const all = Object.values(pools).flat();
  all.sort((a, b) => a.rank - b.rank);
  const drop = new Set();
  while (all.length - drop.size > 30) drop.add(all[drop.size]);
  const keep = (arr) => arr.filter((i) => !drop.has(i));
  let text = "";
  for (let k = drop.size; k <= all.length; k++) {
    text = render(request, [
      ["Request and doc names", keep(pools.names)],
      ["Where the change goes", keep(pools.targets)],
      ["Copy from", keep(pools.exemplars)],
      ["Tests to copy", keep(pools.tests)],
      ["Reuse", keep(pools.reuse)],
    ]);
    if (Buffer.byteLength(text) <= maxBytes || k === all.length) break;
    drop.add(all[k]);
  }
  if (Buffer.byteLength(text) > maxBytes) text = Buffer.from(text).subarray(0, maxBytes - 4).toString("utf8").replace(/�$/, "") + "\n";
  const entities = ents.filter((e) => e.type !== "noun" || (e.items || []).length).slice(0, 40).map((e) => ({ name: e.name, type: e.type, from: e.from, at: keep(e.items || []).map(at) }));
  return {
    v: 1, entities, targets: keep(targets), exemplars: keep(ex.items), tests: keep(tests), reuse: keep(ex.hop),
    doc: docRel, graph: !!(loaded && loaded.model), text, bytes: Buffer.byteLength(text), ms: Date.now() - t0,
  };
}

function write(runDir, pack) {
  fs.mkdirSync(runDir, { recursive: true });
  const md = path.join(runDir, "context.md");
  const js = path.join(runDir, "context.json");
  fs.writeFileSync(md, pack.text);
  const rest = Object.assign({}, pack);
  delete rest.text;
  fs.writeFileSync(js, JSON.stringify(rest, null, 2) + "\n");
  return { md, json: js };
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
function cmd(argv = []) {
  const pos = require("./core.js").positionals(argv, ["--doc", "--run"]);
  const request = pos.join(" ").trim();
  if (!request) { process.stderr.write("lorc context: use: context \"<request>\" [--doc <path>] [--run <slug>] [--json] [--dir <root>]\n"); return 2; }
  const dir = valueOf(argv, "--dir");
  let root;
  try { root = dir ? path.resolve(dir) : require("./paths.js").repoRoot(); } catch (_) { root = process.cwd(); }
  const pack = build(root, request, { doc: valueOf(argv, "--doc") || undefined });
  const slug = valueOf(argv, "--run");
  if (slug) pack.files = write(require("./runs.js").runDir(root, slug), pack);
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(pack, null, 2) + "\n");
  else process.stdout.write(pack.text);
  return 0;
}

// ---------- 7. read plan (0.4.2) ----------
// readPlan → [{ file, ranges: [[a,b],…], whys: [..], why }]: the ranges ONE `lorc read` call prints.
// Ranges ≤ 8 lines apart merge; candidates go in priority order until the byte budget is full.
const PLAN_GAP = 8;
const PLAN_TAIL = 96;
const lineCost = (n, l) => Buffer.byteLength(`${n}│${l}\n`);
const headCost = (file) => Buffer.byteLength(file) + 112;
const stem5 = (w) => String(w || "").toLowerCase().slice(0, 5);

function planWords(words) {
  const text = Array.isArray(words) ? words.join(" ") : String(words || "");
  const out = new Set();
  for (const w of text.split(/[^A-Za-z0-9]+/).flatMap(splitWords)) {
    if (w.length < 4 || STOP.has(w) || VERBS.has(w) || GENERIC.has(w) || /^\d/.test(w)) continue;
    out.add(stem5(w));
  }
  return out;
}

// The line after the block that opens at line i0 (0-based): counts ( { [ and their pairs.
function blockEnd(lines, i0, cap) {
  let depth = 0;
  let opened = false;
  for (let i = i0; i < lines.length && i < i0 + cap; i++) {
    const t = String(lines[i]).replace(/\/\/.*$/, "").replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''");
    for (const ch of t) {
      if (ch === "{" || ch === "(" || ch === "[") { depth++; opened = true; } else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
    if (opened && depth <= 0) return i + 1;
  }
  return Math.min(lines.length, i0 + cap);
}

// "file", "file:a-b", "file:a-b,c-d — why" → { file, ranges, why }.
function parsePlanRefs(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = /^(.+?)(?:\s+[—–-]+\s+(.+))?$/.exec(String(raw).trim());
    if (!m) continue;
    const loc = m[1].trim().replace(/\\/g, "/");
    const lm = /^(.+?)(?::(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*))?$/.exec(loc);
    const ranges = lm[2] ? lm[2].split(",").map((r) => { const [a, b] = r.split("-").map(Number); return [a, b || a]; }) : [];
    out.push({ file: lm[1], ranges, why: m[2] ? m[2].trim().slice(0, 60) : "" });
  }
  return out;
}

function readPlan(root, pack, opts = {}) {
  root = path.resolve(root || process.cwd());
  pack = pack || {};
  const forMain = !!opts.forMain;
  const budget = opts.budget || 20480;
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      let t = null;
      try { t = fs.readFileSync(path.join(root, rel), "utf8").split(/\r?\n/); } catch (_) { t = null; }
      if (t && t.length && t[t.length - 1] === "") t.pop();
      cache.set(rel, t);
    }
    return cache.get(rel);
  };
  let loaded = opts.loaded;
  if (loaded === undefined && !forMain) { try { loaded = loadGraph(root); } catch (_) { loaded = null; } }
  const model = loaded && loaded.model;
  const syms = (rel) => ((model && model.byFile && model.byFile[rel]) || {}).symbols || [];
  const files = (opts.files || []).map(posix);
  const refs = parsePlanRefs(opts.refs);
  const own = new Set([...files, ...refs.map((r) => r.file)]);
  const stems = planWords(opts.words);
  // How often each stem occurs in the task words: a method that shares a frequent stem ranks first.
  const freq = new Map();
  for (const w of String(Array.isArray(opts.words) ? opts.words.join(" ") : opts.words || "").split(/[^A-Za-z0-9]+/).flatMap(splitWords)) {
    const k = stem5(w);
    if (stems.has(k)) freq.set(k, (freq.get(k) || 0) + 1);
  }
  const creates = opts.creates !== undefined ? !!opts.creates : files.some((f) => COMP_EXT.test(f) && !read(f));
  const cands = [];
  const add = (file, a, b, why, prio) => {
    const ls = read(file);
    if (!ls || !ls.length) return;
    a = Math.max(1, Math.floor(a));
    b = Math.min(ls.length, Math.floor(b));
    if (a > b) return;
    cands.push({ file, a, b, why: String(why || "").slice(0, 80), prio, i: cands.length });
  };
  // A range cut so that its lines fit `max` bytes.
  const fit = (file, a, b, max) => {
    const ls = read(file) || [];
    let used = 0;
    let e = a - 1;
    while (e < b && e < ls.length && used + lineCost(e + 1, ls[e]) <= max) { used += lineCost(e + 1, ls[e]); e++; }
    return e;
  };

  // 1. targets
  const targets = (pack.targets || []).filter((t) => forMain || own.has(t.file));
  const apiDone = new Set();
  const T = 0;
  for (const t of targets) {
    const ls = read(t.file);
    if (!ls) continue;
    if (t.kind === "route" && /parent route/.test(t.why)) add(t.file, t.start, t.start + 11, "parent route", 1 + T);
    else if (t.kind === "insert" && /insertion/.test(t.why)) add(t.file, t.start - 12, t.start + 12, "insertion point", 1 + T);
    else if (t.kind === "api" && !apiDone.has(t.file)) {
      apiDone.add(t.file);
      const starts = [...String(t.what || "").matchAll(/([\w$]+) · (\d+)/g)].map((m) => +m[2]);
      if (starts.length) add(t.file, Math.max(...starts), t.end, "last exported function", 1 + T);
      else add(t.file, t.end - 15, t.end + 15, "append point", 1 + T);
      let ex = -1;
      ls.forEach((l, i) => { if (/^export\s*(default\s*)?\{/.test(l)) ex = i; });
      if (ex >= 0) add(t.file, ex + 1, blockEnd(ls, ex, 120), "export block", 1 + T);
    } else if (t.kind === "insert" && !apiDone.has(t.file)) add(t.file, t.start - 15, t.start + 15, "append point", 1 + T);
    else if (t.kind === "i18n") add(t.file, t.start, Math.min(t.end, t.start + 150), "feature locale block", 1 + T);
    else if (t.kind === "constants") {
      if (ls.length <= 60) add(t.file, 1, ls.length, "feature constants", 1 + T);
      else ls.forEach((l, i) => { if (/^export\s/.test(l)) add(t.file, i - 1, i + 3, "feature constants export", 1.5 + T); });
    } else if (t.kind === "entry") add(t.file, t.start, t.end, "entry / CTA", 1 + T);
  }

  if (forMain) {
    // 2m. the doc, the must_ask evidence, context.md
    if (opts.doc) {
      const ls = read(opts.doc);
      if (ls) add(opts.doc, 1, fit(opts.doc, 1, ls.length, 8192), "requirement doc", 0);
    }
    for (const m of opts.mustAsk || []) {
      for (const s of m.seen || []) {
        for (const at of s.at || []) {
          const mm = /^(.+):(\d+)$/.exec(String(at));
          if (mm) add(mm[1], +mm[2] - 6, +mm[2] + 6, `must_ask: ${s.v}`, s.at.indexOf(at) === 0 ? 0.5 : 2.5);
        }
      }
    }
    if (opts.contextMd) { const ls = read(opts.contextMd); if (ls) add(opts.contextMd, 1, ls.length, "context pack", 2); }
  } else {
    // 0.4.3 task plan: high-precision items only. Order: targets 1 · doc CSS 2 · style helpers 3 ·
    // test setup + top-level helpers 4 · matched methods inside ranged refs 5.
    const exFiles = new Set([...(pack.exemplars || []).map((x) => x.file), ...refs.filter((r) => r.ranges.length).map((r) => r.file)]);
    // d. doc CSS classes: the merged style range of each file.
    const style = new Map();
    for (const e of pack.entities || []) {
      if (e.type !== "class") continue;
      for (const at of e.at || []) {
        const mm = /^(.+):(\d+)(?:-(\d+))?$/.exec(String(at));
        if (!mm || !(STYLE_EXT.test(mm[1]) || COMP_EXT.test(mm[1]))) continue;
        const ls = read(mm[1]);
        if (!ls || (COMP_EXT.test(mm[1]) && !inStyleLines(ls, +mm[2]))) continue;
        const r = style.get(mm[1]) || [Infinity, 0];
        style.set(mm[1], [Math.min(r[0], +mm[2]), Math.max(r[1], +(mm[3] || mm[2]))]);
      }
    }
    for (const [f, [a, b]] of style) add(f, a, b, "doc CSS classes", 2);
    // Style helpers the DOC names: only in an exemplar's file or a shared style partial (_x.scss).
    const shared = (f) => STYLE_EXT.test(f) && /^_/.test(path.posix.basename(f));
    for (const h of styleHelpers(root, opts.docText || "")) if (exFiles.has(h.file) || shared(h.file)) add(h.file, h.a, h.b, `style helper ${h.word}`, 3);
    // Test exemplar: setup + top-level helpers (no it block).
    const t0 = (pack.tests || [])[0];
    const tls = t0 && read(t0.file);
    if (tls) {
      const d = tls.findIndex((l) => /^describe(\.\w+)?\(/.test(l));
      add(t0.file, 1, Math.min(100, d > 0 ? d : tls.length), "test setup", 4);
      tls.forEach((l, i) => {
        if (d >= 0 && i >= d) return;
        if (/^(?:async\s+)?function\s+(render|mount|build|make|setup)\w*/.test(l) || /^(?:const|let)\s+(render|mount|build|make|setup)\w*\s*=/.test(l)) {
          add(t0.file, i + 1, blockEnd(tls, i, 80), "test helper", 4);
        }
      });
    }
    // Matched methods inside the ranges of ranged refs (≤ 5 per ref, ≤ 8 KB).
    for (const r of refs) {
      const ls = read(r.file);
      if (!ls || !r.ranges.length) continue;
      const card = (pack.exemplars || []).concat(pack.reuse || []).find((x) => x.file === r.file);
      let ms = syms(r.file).filter((s) => s.kind === "method" || s.kind === "function").map((s) => ({ name: s.name, a: s.lines[0], b: s.lines[1] }));
      if (!ms.length && card) ms = [...String(card.what || "").matchAll(/(?:methods: |, )([\w$]+) (\d+)/g)].map((m) => ({ name: m[1], a: +m[2], b: blockEnd(ls, +m[2] - 1, 120) }));
      const inside = (m) => r.ranges.some(([a, b]) => m.a >= a && m.a <= b);
      const scored = ms.filter(inside).map((m) => ({ ...m, sc: [...new Set(splitWords(m.name).map(stem5).filter((w) => stems.has(w)))].reduce((a, w) => a + (freq.get(w) || 1), 0) }))
        .filter((m) => m.sc > 0).sort((x, y) => y.sc - x.sc || x.a - y.a);
      let used = 0;
      let n = 0;
      for (const m of scored) {
        if (n >= 5) break;
        const e = fit(r.file, m.a, m.b, 8192 - used);
        if (e < m.a) continue;
        for (let i = m.a; i <= e; i++) used += lineCost(i, ls[i - 1]);
        add(r.file, m.a, e, `method ${m.name}`, 5);
        n++;
      }
    }
  }

  // Select: priority order; each candidate costs the bytes its merged ranges add.
  cands.sort((x, y) => x.prio - y.prio || x.i - y.i);
  const per = new Map();
  const order = [];
  const merge = (rs) => {
    const s = rs.slice().sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const r of s) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + PLAN_GAP + 1) { last[1] = Math.max(last[1], r[1]); last.w.push(...r.w); } else out.push(Object.assign([r[0], r[1]], { w: [...r.w] }));
    }
    return out;
  };
  const costOf = (file, rs) => {
    const ls = read(file) || [];
    let c = 0;
    for (const r of rs) { c += headCost(file); for (let i = r[0]; i <= r[1]; i++) c += lineCost(i, ls[i - 1] || ""); }
    return c;
  };
  let used = PLAN_TAIL;
  for (const c of cands) {
    const cur = per.get(c.file) || [];
    // Too big: cut its end (≥ 10 lines stay), so the rest of the budget is not lost.
    let b = c.b;
    let next = merge(cur.concat([Object.assign([c.a, b], { w: [c.why] })]));
    let delta = costOf(c.file, next) - costOf(c.file, cur);
    while (used + delta > budget && b - c.a >= 20) {
      b -= 10;
      next = merge(cur.concat([Object.assign([c.a, b], { w: [c.why] })]));
      delta = costOf(c.file, next) - costOf(c.file, cur);
    }
    if (used + delta > budget) continue;
    used += delta;
    if (!per.has(c.file)) order.push(c.file);
    per.set(c.file, next);
  }
  return order.map((file) => {
    const rs = per.get(file);
    const whys = rs.map((r) => [...new Set(r.w)].join("; ").slice(0, 80));
    return { file, ranges: rs.map((r) => [r[0], r[1]]), whys, why: [...new Set(rs.flatMap((r) => r.w))].join("; ").slice(0, 120) };
  });
}
// Style helpers the words name: @mixin / @keyframes / %placeholder / .rule → ≤ 40 lines each.
const STYLE_HELPERS = ["shimmer", "skeleton", "spinner", "tooltip", "divider", "ellipsis", "truncate"];
function styleHelpers(root, words) {
  const text = String(Array.isArray(words) ? words.join(" ") : words || "").toLowerCase();
  const out = [];
  for (const w of STYLE_HELPERS.filter((x) => text.includes(x))) {
    const rows = git(root, ["grep", "-n", "-E", `@mixin ${w}|@keyframes ${w}|%${w}|\\.${w}[ {-]`, "--", "*.scss", "*.sass", "*.css", "*.less", "*.vue"]).split("\n");
    let n = 0;
    for (const line of rows) {
      const m = /^(.+?):(\d+):/.exec(line);
      if (!m || n >= 2) continue;
      let ls;
      try { ls = fs.readFileSync(path.join(root, m[1]), "utf8").split(/\r?\n/); } catch (_) { continue; }
      if (COMP_EXT.test(m[1]) && !inStyleLines(ls, +m[2])) continue;
      const [a, b] = ruleRange(ls, +m[2] - 1);
      out.push({ file: m[1], a, b: Math.min(b, a + 39), word: w });
      n++;
    }
  }
  return out;
}function inStyleLines(ls, line) {
  for (let i = line - 1; i >= 0; i--) {
    if (/^\s*<style/.test(ls[i])) return true;
    if (/^\s*<\/?(template|script)/.test(ls[i])) return false;
  }
  return false;
}

module.exports = { build, write, cmd, entitiesOf, nounPhrases, ruleRange, localeKeys, readPlan, parsePlanRefs, planWords };
