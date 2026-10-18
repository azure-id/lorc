"use strict";
// lorc 0.5.0 (W29a): the resolution states. graph-query, graph-resolve and
// graph-map use this one set. Do not keep a local copy in a different file.
//
// A CONFIDENT state gives a caller row. The other states do not.

const CONFIDENT = new Set(["LOCAL", "IMPORT", "UNIQUE", "ROUTE", "STORE", "EVENT"]);

// The one-letter form of each state for compact output.
const STATE_SHORT = {
  LOCAL: "L",
  IMPORT: "I",
  UNIQUE: "U",
  ROUTE: "R",
  STORE: "S",
  EVENT: "E",
  AMBIGUOUS: "A",
  UNRESOLVED: "-",
  I18N: "T",
  CONFIG: "C",
  TABLE: "D",
};

module.exports = { CONFIDENT, STATE_SHORT };
