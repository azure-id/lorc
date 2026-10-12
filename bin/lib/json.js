"use strict";

function wantsJson(argv) {
  return Array.isArray(argv) && argv.includes("--json");
}

// Compact JSON, one object per call: the skill reads it and bytes cost tokens.
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

module.exports = { wantsJson, emit };
