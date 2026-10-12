"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../bin/lib/paths.js");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "lorc-paths-")); }
function stamp(root, version, cli) {
  const f = path.join(root, ".claude", "hooks", "orc-version.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ version, cli }));
}

test("resolveClaudeDir", () => {
  const home = tmp();
  const cwd = tmp();
  try {
    assert.strictEqual(P.resolveClaudeDir(["--global", "--dir", "x"], cwd, home), path.join(home, ".claude"));
    assert.strictEqual(P.resolveClaudeDir(["--dir", cwd], cwd, home), path.resolve(cwd, ".claude"));
    assert.strictEqual(P.resolveClaudeDir([], cwd, home), path.join(path.resolve(cwd), ".claude"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("findOrc", () => {
  const home = tmp();
  const root = tmp();
  try {
    let r = P.findOrc(root, home);
    assert.strictEqual(r.installed, false);
    assert.strictEqual(r.delegate, false);
    assert.strictEqual(r.reason, "no stamp");

    const cli = path.join(root, "cli.js");
    fs.writeFileSync(cli, "");
    stamp(root, "2.2.0", cli);
    r = P.findOrc(root, home);
    assert.strictEqual(r.scope, "project");
    assert.strictEqual(r.delegate, true);

    stamp(root, "1.8.1", cli);
    r = P.findOrc(root, home);
    assert.strictEqual(r.installed, true);
    assert.strictEqual(r.delegate, false);
    assert.match(r.reason, /1\.8\.1/);

    stamp(root, "2.2.0", path.join(root, "gone.js"));
    r = P.findOrc(root, home);
    assert.strictEqual(r.installed, false);
    assert.strictEqual(r.reason, "cli missing");

    // A missing project cli does not stop the global check.
    stamp(home, "2.3.0", cli);
    r = P.findOrc(root, home);
    assert.strictEqual(r.scope, "global");
    assert.strictEqual(r.delegate, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("semverGte", () => {
  assert.strictEqual(P.semverGte("2.2.0", "2.2.0"), true);
  assert.strictEqual(P.semverGte("2.10.0", "2.2.0"), true);
  assert.strictEqual(P.semverGte("1.8.1", "2.2.0"), false);
  assert.strictEqual(P.semverGte(null, "2.2.0"), false);
  assert.strictEqual(P.semverGte("bad", "2.2.0"), false);
});

test("atomicWrite leaves no tmp file", () => {
  const d = tmp();
  try {
    const f = path.join(d, "a", "b.json");
    P.atomicWrite(f, "hi");
    assert.strictEqual(fs.readFileSync(f, "utf8"), "hi");
    assert.deepStrictEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.includes(".tmp-")), []);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
