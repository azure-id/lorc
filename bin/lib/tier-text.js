"use strict";
// lorc tier — text signals. It reads the request (and an optional requirement doc)
// and returns FACTS, never a tier: new-file units, edits in existing files, named
// targets, layers, risk classes and cues. tier.js turns the facts into a tier.
const fs = require("fs");
const path = require("path");

const words = (s) => new Set(s.split(" "));
const CREATE = words("add adds adding create creates creating new introduce introduces build builds building implement implements scaffold scaffolds make makes generate generates");
const MODIFY = words("change changes update updates modify modifies fix fixes refactor refactors rename renames move moves remove removes delete deletes replace replaces extend extends rework reworks convert converts migrate migrates split splits merge merges show shows hide hides disable disables enable enables support supports allow allows handle handles validate validates improve improves adjust adjusts restyle restyles");
const WIRE = words("wire wires connect connects hook integrate integrates register registers mount mounts plug plugs");
// A verb after one of these is a behaviour description ("when the user changes …"), not an order.
const ACTORS = words("user users they it he she customer customers someone admin client");
// The object of a verb ends at one of these. "with" and "and" stay inside: they list parts.
const STOP = words("to into onto in inside on under for from of at that which so when where if after before below above next by via");
const SPLIT = words("and or plus with , ; :");
// After a place ("to the order page"), the list goes on at one of these.
const RESUME = words("and with , ) dan serta dengan");

// FILE nouns: a new one is a new file. ELEMENT nouns: a new one is an edit in an existing file.
const FILE_NOUNS = {
  page: "ui", screen: "ui", view: "ui", flow: "ui", wizard: "ui", shell: "ui", layout: "ui", component: "ui",
  modal: "ui", dialog: "ui", drawer: "ui", stepper: "ui", step: "ui", widget: "ui", form: "ui", panel: "ui",
  tab: "ui", card: "ui", chart: "ui", dashboard: "ui", sidebar: "ui", navbar: "ui", popup: "ui",
  activity: "ui", fragment: "ui", viewcontroller: "ui", template: "ui",
  endpoint: "api", controller: "api", handler: "api", resolver: "api", webhook: "api", serializer: "api",
  viewset: "api", proto: "api",
  service: "logic", module: "logic", helper: "logic", util: "logic", utility: "logic", hook: "logic",
  composable: "logic", store: "logic", reducer: "logic", mixin: "logic", job: "logic", worker: "logic",
  queue: "logic", command: "logic", subcommand: "logic", middleware: "logic", plugin: "logic", adapter: "logic",
  client: "logic", class: "logic", struct: "logic", interface: "logic", trait: "logic", enum: "logic",
  protocol: "logic", package: "logic", crate: "logic", library: "logic", script: "logic", consumer: "logic",
  producer: "logic", subscriber: "logic", listener: "logic", viewmodel: "logic", lambda: "logic", cron: "logic",
  model: "data", entity: "data", migration: "data", schema: "data", repository: "data", collection: "data",
  dto: "data", dao: "data",
};
// A new function, method or flag is an edit in an existing file in any language.
const ELEMENT_NOUNS = words("button buttons field fields column columns input inputs label labels link links icon icons tooltip tooltips text message messages option options badge badges toggle checkbox dropdown select filter filters sort validation row rows box section header footer banner menu item items placeholder title function functions method methods property properties flag flags parameter parameters param params argument arguments attribute attributes constant constants variable variables");
// "table" and "route" depend on the context.
const DATA_CUES = /\b(database|db|sql|schema|column|columns|migrat\w*|backfill\w*|orm|prisma|sequelize|typeorm|mongo\w*|postgres\w*|mysql|sqlite|redis)\b/i;
// Data-layer EVIDENCE: a data word other than the migration verb itself.
const DATA_STRONG = /\b(database|db|sql|schema|column|columns|tables?|orm|prisma|sequelize|typeorm|mongo\w*|postgres\w*|mysql|sqlite|redis)\b/i;
const SERVER_CUES = /\b(backend|back-end|server|endpoint|endpoints|controller|controllers|route handler|rest api|graphql|grpc|rpc|microservice|serverless|lambda|serializers?|viewsets?)\b/i;
const LAYER_CUES = {
  ui: /\b(ui|page|pages|screen|screens|view|component|button|form|modal|css|scss|style|styles|layout|frontend|front-end|vue|react|angular|svelte|tooltip|stepper|wizard|widgets?|activity|fragment|swiftui|compose|flutter|xaml|razor|storyboard)\b/i,
  api: SERVER_CUES,
  data: DATA_CUES,
  infra: /\b(docker\w*|ci|pipeline|deploy\w*|terraform|k8s|kubernetes|helm|nginx|github actions)\b/i,
  i18n: /\b(i18n|translations?|locales?|wording|localiz\w*)\b/i,
};

const CUES = {
  migration: /\bmigrat(e|es|ed|ing|ion|ions)\b|\bbackfill\w*|\balter table\b/i,
  ordered: /\b(in (?:a fixed |this |that )?order|step[- ]by[- ]step|phase \d|stage \d|one after the other|after that)\b/i,
  mechanical: /\b(rename\w*|typo\w*|bump\w*|lint\w*|reformat\w*|docstrings?|wording|copy change|log messages?|move \S+ to)\b/i,
  signature: /\b(signature|options object|positional|parameters?|arguments?|params|argument order|return type)\b/i,
  refactor: /\b(refactor\w*|restructur\w*|extract\w*|reorganiz\w*|clean ?up|decoupl\w*)\b/i,
  fix: /\b(fix|fixes|bug|bugs|crash\w*|broken|fails?|failing|regression)\b/i,
  scope: /\b(all|every|everywhere|across|whole|entire|globally|each)\b/i,
  algorithm: /\b(algorithm\w*|optimi[sz]\w*|performance|concurren\w*|parser|parsing|caching|race condition|scheduler|recursi\w*|dedup\w*|throttl\w*|debounc\w*)\b/i,
  state: /\b(state|store|session|persist\w*|preserv\w*|remember\w*|still filled|filled in|keeps? the values?|continu\w* from|carr(y|ies) over|websocket|real-?time|draft)\b/i,
  branch: /\b(validat\w*|conditions?|conditional|unless|edge cases?|error handling|disabled|greyed|grayed|permissions?|insufficient)\b/i,
};
const RISK = {
  auth: /\b(auth\w*|login|logout|password\w*|jwt|oauth|sso|rbac|acl|permissions?|roles?)\b/i,
  money: /\b(payments?|billing|invoices?|refunds?|charges?|pricing|wallet|payouts?|ledger)\b/i,
  migration: /\bmigrat(e|es|ion|ions)\b|\bbackfill\w*|\balter table\b/i,
  security: /\b(secur\w*|xss|csrf|injection|sanitiz\w*|encrypt\w*|crypto\w*|secrets?)\b/i,
  "data-integrity": /\b(data loss|idempoten\w*|consistency|integrity)\b/i,
  concurrency: /\b(concurren\w*|race condition|mutex|deadlock|locking)\b/i,
};
const UI_STATES = /\b(loading|empty state|error state|disabled|hover|shimmer|skeleton|spinner|responsive|mobile|dark mode|a11y|pagination|infinite scroll|memuat|kosong|responsif|seluler|mode gelap)\b/gi;

// ── Indonesian. A request can come in Indonesian (the skill asks for English, but `lorc tier`
// takes what it gets). Verbs join the English sets; a noun maps to its English kind.
for (const w of "tambah tambahkan menambah menambahkan buat buatkan membuat bikin bikinkan implementasikan mengimplementasikan bangun membangun sediakan menyediakan siapkan".split(" ")) CREATE.add(w);
for (const w of "ubah ubahlah mengubah ganti gantikan mengganti perbaiki memperbaiki perbarui memperbarui hapus menghapus pindahkan memindahkan refaktor rapikan merapikan sesuaikan menyesuaikan tampilkan menampilkan sembunyikan menyembunyikan nonaktifkan menonaktifkan aktifkan mengaktifkan dukung mendukung tangani menangani memvalidasi konversi mengonversi migrasikan memigrasikan pisahkan memisahkan gabungkan menggabungkan perluas memperluas".split(" ")) MODIFY.add(w);
for (const w of "hubungkan menghubungkan sambungkan menyambungkan integrasikan mengintegrasikan daftarkan mendaftarkan pasang pasangkan memasang kaitkan mengaitkan".split(" ")) WIRE.add(w);
for (const w of "pengguna mereka dia nasabah pelanggan".split(" ")) ACTORS.add(w);
for (const w of "ke di pada dari untuk dalam yang agar supaya saat ketika jika kalau setelah sebelum oleh melalui lewat sehingga".split(" ")) STOP.add(w);
for (const w of "dan atau serta dengan".split(" ")) SPLIT.add(w);
const ID_NOUNS = {
  halaman: "page", layar: "screen", tampilan: "view", alur: "flow", komponen: "component", formulir: "form",
  langkah: "step", tahap: "step", tahapan: "step", kartu: "card", grafik: "chart", dasbor: "dashboard", jendela: "modal",
  pengontrol: "controller", penangan: "handler", layanan: "service", modul: "module", pembantu: "helper", utilitas: "util",
  kelas: "class", antarmuka: "interface", pekerjaan: "job", antrean: "queue", antrian: "queue", perintah: "command",
  skrip: "script", pustaka: "library", paket: "package", migrasi: "migration", skema: "schema", entitas: "entity",
  repositori: "repository", koleksi: "collection", tabel: "table", rute: "route",
};
const ID_ELEMENTS = {
  tombol: "button", kolom: "column", isian: "field", masukan: "input", tautan: "link", ikon: "icon", teks: "text",
  pesan: "message", pilihan: "option", opsi: "option", lencana: "badge", sakelar: "toggle", kotak: "box", bagian: "section",
  judul: "title", fungsi: "function", metode: "method", properti: "property", argumen: "argument", atribut: "attribute",
  konstanta: "constant", variabel: "variable", validasi: "validation", baris: "row",
};
const ID_DATA = /\b(basis data|tabel|kolom|skema|migrasi\w*|kueri)\b/i;
const ID_SERVER = /\b(pengontrol|penangan rute|layanan mikro)\b/i;
const ID_LAYERS = { ui: /\b(halaman|layar|tampilan|komponen|tombol|formulir|antarmuka pengguna)\b/i, api: ID_SERVER, data: ID_DATA, infra: /\b(penerapan|deploy\w*)\b/i, i18n: /\b(terjemahan|bahasa|lokalisasi)\b/i };
const ID_CUES = {
  migration: /\bmigrasi\w*|\bmemigrasikan\b|\bisi ulang data\b/i,
  ordered: /\b(berurutan|langkah demi langkah|tahap demi tahap|setelah itu)\b/i,
  mechanical: /\b(ganti nama|ubah nama|salah ketik|naikkan versi|format ulang|ubah teks|ganti teks|komentar)\b/i,
  signature: /\b(parameter|argumen|objek opsi|urutan argumen|tipe kembalian)\b/i,
  refactor: /\b(refaktor\w*|rapikan|merapikan|ekstrak\w*|restrukturisasi)\b/i,
  fix: /\b(perbaiki|memperbaiki|galat|eror|rusak|gagal|tidak berfungsi)\b/i,
  scope: /\b(semua|seluruh|setiap|di mana-mana)\b/i,
  algorithm: /\b(algoritma|optimasi|mengoptimalkan|performa|kinerja|konkurensi)\b/i,
  state: /\b(simpan nilai|tetap terisi|nilai tetap|lanjut dari|lanjutkan dari|melanjutkan dari|sesi|draf)\b/i,
  branch: /\b(validasi|kondisi|kecuali|kasus tepi|penanganan galat|nonaktif|abu-abu|izin|tidak cukup)\b/i,
};
const ID_RISK = {
  auth: /\b(login|kata sandi|otentikasi|autentikasi|otorisasi|hak akses|peran pengguna)\b/i,
  money: /\b(pembayaran|tagihan|faktur|pengembalian dana|penarikan dana|pencairan|dompet|transfer dana)\b/i,
  migration: /\bmigrasi\w*/i,
  security: /\b(keamanan|enkripsi|rahasia|kunci api)\b/i,
  "data-integrity": /\b(kehilangan data|integritas data|konsistensi data)\b/i,
};
const either = (a, b) => (s) => a.test(s) || Boolean(b && b.test(s));

// Words, numbers, `code`, "strings" and boundary punctuation. A hyphen keeps a word whole:
// "create-transaction" and "4-step" are adjectives, not a verb or a noun.
const TOKEN = /`[^`]+`|"[^"]*"|'[^'\s][^']*'|[A-Za-z0-9_][A-Za-z0-9_./-]*|[,;:()]/g;

function tokens(text) {
  return (String(text || "").match(TOKEN) || []).map((raw) => {
    const t = raw.replace(/[./-]+$/, "");
    if (raw.startsWith("`")) return { raw, w: "`", code: raw.slice(1, -1) };
    if (raw.startsWith('"') || raw.startsWith("'")) return { raw, w: '"' };
    return { raw: t, w: t.toLowerCase() };
  });
}

function singular(w) {
  // Indonesian: "halaman-halaman" is a plural; a noun maps to its English kind.
  const dup = /^([a-z]+)-\1$/.exec(w);
  if (dup) w = dup[1];
  if (ID_NOUNS[w]) return ID_NOUNS[w];
  if (ID_ELEMENTS[w]) return ID_ELEMENTS[w];
  if (FILE_NOUNS[w] || ELEMENT_NOUNS.has(w)) return w;
  if (w.endsWith("ies") && FILE_NOUNS[w.slice(0, -3) + "y"]) return w.slice(0, -3) + "y";
  if (w.endsWith("es") && FILE_NOUNS[w.slice(0, -2)]) return w.slice(0, -2);
  if (w.endsWith("s") && FILE_NOUNS[w.slice(0, -1)]) return w.slice(0, -1);
  return w;
}

// Named targets: `code`, CamelCase, snake_case and paths.
function namesOf(text) {
  const out = new Set();
  const s = String(text || "");
  for (const m of s.matchAll(/`([^`]+)`/g)) {
    const v = m[1].trim();
    if (/^[\w$.\/-]+$/.test(v)) out.add(v);
  }
  for (const m of s.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z]+_[a-z0-9_]+)\b/g)) out.add(m[1]);
  for (const m of s.matchAll(/(?:^|[\s`(])((?:[\w.-]+\/)+[\w.-]+\.\w+|[\w-]+\.(?:js|jsx|ts|tsx|vue|svelte|py|go|rs|java|rb|php|cs|kt|kts|swift|dart|scala|ex|exs|c|h|cc|cpp|hpp|sql|proto|md|json|ya?ml|toml|scss|css))\b/g)) out.add(m[1]);
  return [...out].slice(0, 12);
}

// One verb's object: from the verb to the next verb or end (≤ 18 tokens), cut into
// phrases at "and", "with", commas. A stop word ("to the order page") starts a place,
// not a new thing: skip it up to the next "and" or comma. Each phrase gives ≤ 1 unit.
function phrases(toks, from) {
  const out = [];
  let cur = [];
  let skip = false;
  for (let i = from; i < toks.length && i < from + 18; i++) {
    const t = toks[i];
    if (CREATE.has(t.w) || MODIFY.has(t.w) || WIRE.has(t.w)) break;
    if (t.w === "(" || STOP.has(t.w)) { if (cur.length) out.push(cur); cur = []; skip = true; continue; }
    if (skip) { if (RESUME.has(t.w)) skip = false; continue; }
    if (SPLIT.has(t.w)) { if (cur.length) out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

function headOf(phrase, ctx) {
  let file = null;
  let element = null;
  for (const t of phrase) {
    const w = singular(t.w);
    if (w === "table") { if (ctx.data) file = { noun: "table", layer: "data" }; else element = "table"; continue; }
    if (w === "route") { if (ctx.server) file = { noun: "route", layer: "api" }; else element = element || "route"; continue; }
    if (w === "api") { if (ctx.server) file = { noun: "endpoint", layer: "api" }; continue; }
    if (FILE_NOUNS[w]) file = { noun: w, layer: FILE_NOUNS[w] };
    else if (ELEMENT_NOUNS.has(w)) element = w;
    else { const s = suffixNoun(t.raw); if (s) file = { noun: s, layer: FILE_NOUNS[s] }; }
  }
  return { file, element };
}

// A conventional type name ends in its kind in every language: OrderSerializer, PaymentService,
// OrderRepository, UserViewModel, OrderActivity, order_handler.
const SUFFIXES = Object.keys(FILE_NOUNS).filter((n) => n.length >= 4).sort((a, b) => b.length - a.length);
function suffixNoun(raw) {
  const s = String(raw || "");
  if (!/^[A-Z][a-z0-9]+[A-Z]|^[a-z0-9]+_[a-z]/.test(s)) return null;
  const low = s.toLowerCase().replace(/_/g, "");
  return SUFFIXES.find((n) => low.endsWith(n) && low.length > n.length + 1) || null;
}

// A colon does not end a clause: "step 1: route shell, stepper" lists what to build.
function clauses(text) {
  return String(text || "").split(/[.!?\n]+(?:\s|$)|;/).map((c) => c.trim()).filter(Boolean);
}

function cues(text) {
  const out = {};
  for (const [k, re] of Object.entries(CUES)) out[k] = either(re, ID_CUES[k])(text);
  return out;
}

function readDoc(root, rel) {
  if (!rel) return null;
  const file = path.resolve(root || process.cwd(), rel);
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 400 * 1024) return null;
    text = fs.readFileSync(file, "utf8");
  } catch (_) { return null; }
  const lines = text.split(/\r?\n/);
  let items = 0;
  for (const l of lines) {
    const s = l.trim();
    if (/^([-*+]|\d+[.)])\s+\S/.test(s)) items++;
    else if (/^(details|behaviou?r|acceptance|given|when|then)\b.*:?$/i.test(s)) items++;
    else if (s && s.split(/\s+/).length <= 6 && /[*^:]\s*(\(.*\))?$/.test(s)) items++;
  }
  const apis = new Set();
  for (const m of text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w\/{}:.-]+)/g)) apis.add(`${m[1]} ${m[2]}`);
  const states = new Set((text.match(UI_STATES) || []).map((s) => s.toLowerCase()));
  return { path: path.relative(root || process.cwd(), file).replace(/\\/g, "/"), lines: lines.length, items, apis: apis.size, ui_states: states.size, text };
}

// Project instruction files are not a requirement doc.
const NOT_DOC = /(^|\/)(CLAUDE|AGENTS|README|CHANGELOG|HOUSE-RULES|CONTRIBUTING|LICENSE|SECURITY|CODE_OF_CONDUCT|GEMINI)\.(md|txt)$/i;

// Find a requirement doc: --doc, else the first .md/.txt path in the request that exists.
function docPath(root, request, explicit) {
  if (explicit) return explicit;
  for (const n of namesOf(request)) {
    if (!/\.(md|txt|rst)$/i.test(n) || NOT_DOC.test(n)) continue;
    try { if (fs.statSync(path.resolve(root || process.cwd(), n)).isFile()) return n; } catch (_) { /* not here */ }
  }
  return null;
}

function parse(request, { root, doc } = {}) {
  const text = String(request || "");
  const d = readDoc(root, docPath(root, text, doc));
  // Layers, areas and the data / server context come from the REQUEST only: a doc uses
  // loose words ("a two-column layout"). The doc adds items, API calls and explicit cues.
  const all = text;
  const ctx = { data: either(DATA_CUES, ID_DATA)(all), server: either(SERVER_CUES, ID_SERVER)(all) };
  const creates = [];
  const modifies = [];
  let elements = 0;
  let wires = 0;
  const seen = new Set();
  for (const c of clauses(text)) {
    const toks = tokens(c);
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i].w;
      const isCreate = CREATE.has(w);
      const isModify = MODIFY.has(w);
      const isWire = WIRE.has(w);
      if (!isCreate && !isModify && !isWire) continue;
      // "the user changes the country" describes behaviour; "a new …" is an adjective use.
      if (i > 0 && ACTORS.has(toks[i - 1].w)) continue;
      if (i > 1 && ACTORS.has(toks[i - 2].w) && !isCreate) continue;
      const ph = phrases(toks, i + 1);
      if (isWire) { wires++; continue; }
      if (isCreate) {
        for (const p of ph) {
          const h = headOf(p, ctx);
          const label = p.map((t) => t.raw).join(" ").slice(0, 40);
          if (h.file) {
            const num = p.find((t) => /^\d+$/.test(t.w));
            const key = `${h.file.noun}:${num ? num.w : label.toLowerCase()}`;
            if (!seen.has(key)) { seen.add(key); creates.push({ noun: h.file.noun, layer: h.file.layer, text: label }); }
          } else if (h.element) elements++;
        }
        continue;
      }
      // A code name: camelCase (getUser), PascalCase with a second hump, snake_case or a path.
      const named = ph.flat().filter((t) => t.code || /^[a-z]+[A-Z]\w*$|^[A-Z][a-z0-9]+[A-Z]\w*$|_|\//.test(t.raw)).map((t) => t.code || t.raw);
      modifies.push({ target: named[0] || null, text: ph.map((p) => p.map((t) => t.raw).join(" ")).join(", ").slice(0, 40) });
    }
  }
  const layers = Object.keys(LAYER_CUES).filter((k) => either(LAYER_CUES[k], ID_LAYERS[k])(all));
  for (const u of creates) if (!layers.includes(u.layer) && u.layer !== "logic") layers.push(u.layer);
  const risk = Object.keys(RISK).filter((k) => either(RISK[k], ID_RISK[k])(text));
  const states = new Set((text.match(UI_STATES) || []).map((s) => s.toLowerCase()));
  const out = {
    words: (text.match(/[A-Za-z0-9]+/g) || []).length,
    clauses: clauses(text).length,
    creates, elements, modifies, wires,
    names: namesOf(text),
    layers, server: ctx.server, data: ctx.data, data_strong: either(DATA_STRONG, /\b(basis data|tabel|kolom|skema|kueri)\b/i)(text),
    cues: cues(text),
    risk,
    ui_states: states.size + (d ? d.ui_states : 0),
    doc: d ? { path: d.path, lines: d.lines, items: d.items, apis: d.apis } : null,
  };
  // A doc can name a migration or API calls the short request left out.
  if (d) {
    const dc = cues(d.text);
    out.cues.migration = out.cues.migration || /\b(migrations?|alter table|backfill)\b/i.test(d.text);
    out.cues.state = out.cues.state || dc.state;
    out.cues.branch = out.cues.branch || dc.branch;
  }
  return out;
}

module.exports = { parse, tokens, clauses, namesOf, readDoc, docPath, FILE_NOUNS, ELEMENT_NOUNS };
