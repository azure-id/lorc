"use strict";
// lorc: the gain meter is not part of lorc; this stub keeps graph.js unchanged.
// ORC's graph.js `gc` calls require("./graph-gain.js").compact(p, atomicWrite).

module.exports = { compact() { return { ok: true, skipped: "lorc" }; } };
