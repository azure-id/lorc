"use strict";
// lorc owns this file since 0.4.0 (forked from ORC 2.3.0 @ ae47a4a, vendor/graph). Change it here, not in ORC.
// lorc: the gain meter is not part of lorc; this stub keeps graph.js unchanged.
// ORC's graph.js `gc` calls require("./graph-gain.js").compact(p, atomicWrite).

module.exports = { compact() { return { ok: true, skipped: "lorc" }; } };
