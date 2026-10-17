"use strict";
// lorc 0.4.0 (W19c): one extraction worker. It runs `extractBatch` on its chunk,
// posts the entries on its port, then sets the shared flag and wakes the main
// thread, which waits with `Atomics.wait` (the synckit pattern).
const path = require("path");
const { workerData } = require("worker_threads");

const { port, flag, items, root } = workerData;
let msg;
try {
  // Test only: make the worker fail, so the main thread must take the chunk.
  if (process.env.LORC_GRAPH_WORKER_FAIL === "1") throw new Error("worker-fail");
  const X = require(path.join(__dirname, "graph-extract.js"));
  const t0 = Date.now();
  const entries = [...X.extractBatch(items, { root }).entries()];
  msg = { ok: true, entries, ms: Date.now() - t0 };
} catch (e) {
  msg = { ok: false, error: String((e && e.message) || e) };
}
try {
  port.postMessage(msg);
} catch (e) {
  port.postMessage({ ok: false, error: String((e && e.message) || e) });
}
const f = new Int32Array(flag);
Atomics.store(f, 0, 1);
Atomics.notify(f, 0);
