#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { wantsJson, emit } = require("./lib/json.js");

function pkg() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
}

// One entry per command. When a command grows, move its code to bin/lib/<name>.js.
const COMMANDS = {
  help: {
    help: "print this usage",
    run() {
      const lines = ["usage: lorc <command> [options]", ""];
      const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
      for (const [name, cmd] of Object.entries(COMMANDS)) {
        lines.push(`  ${name.padEnd(width)}  ${cmd.help}`);
      }
      process.stdout.write(lines.join("\n") + "\n");
      return 0;
    },
  },
  version: {
    help: "print the lorc version (--json for one JSON object)",
    run(argv) {
      const p = pkg();
      if (wantsJson(argv)) emit({ name: p.name, version: p.version });
      else process.stdout.write(`lorc ${p.version}\n`);
      return 0;
    },
  },
};

// W2 commands. Each require is lazy: the router works before a module exists.
function lazy(mod, help) {
  return { help, run(argv, name) { return require("./lib/" + mod).cmd(argv, name); } };
}
Object.assign(COMMANDS, {
  settings: lazy("settings.js", "show / set / reset lorc settings"),
  setting: lazy("settings.js", "alias of settings"),
  init: lazy("install.js", "install lorc into .claude (no overwrite)"),
  update: lazy("install.js", "reinstall lorc files (overwrite); --prune removes orphans"),
  prune: lazy("install.js", "same as update --prune"),
  where: lazy("install.js", "print install and data paths"),
  doctor: lazy("doctor.js", "check the install; --fix repairs"),
  upgrade: lazy("install.js", "npm i -g @azure-id/lorc@latest, then update"),
  changelog: lazy("changelog.js", "versions newer than the installed one"),
  usage: lazy("usage.js", "5h / weekly / context usage and the limit gate (exit 0 ok or unknown · 1 limit · 3 weekly)"),
  wait: lazy("wait.js", "wait for the 5h window reset (zero tokens)"),
  cli: lazy("statusline-cfg.js", "cli bypass / cli restore / cli status"),
  run: lazy("runs.js", "run record: checkpoint, end, resume, list, show"),
  habits: lazy("habits.js", "habit proposals; habits accept|decline <id>"),
  stats: lazy("stats.js", "tokens and cost per finished run"),
  graph: lazy("graph-router.js", "code graph: where, status, update, scan, ctx, map, changes, sync"),
  wiki: lazy("wiki.js", "wiki status | sync | pick \"<words>\" | commands"),
  pattern: lazy("pattern.js", "code pattern status [<lang>] | show <lang>"),
  rules: lazy("rules.js", "house rules: init | show | card | lint [--diff]"),
  extra: lazy("extra.js", "extra executors: status | list | dispatch --slot <s> --slice <path>"),
  prep: lazy("prep.js", "prep \"<request>\" [--json] [--no-start]: the one L0 call of /lorc"),
  slice: lazy("slice.js", "slice --run <slug> --task <n> - : write an executor slice (JSON on stdin)"),
  read: lazy("read.js", "read --run <slug> [--task <n>] [--json]: print the read plan (the ranges to read) in ONE call"),
  check: lazy("check.js", "check --run <slug> [--lint-only] [--build] [--full]: affected tests, lint, typecheck"),
  cov: lazy("coverage.js", "cov [--bar <n>] [--json]: coverage of the changed source files, source branches apart from generated ones (no test run)"),
  review: lazy("review.js", "review prep --run <slug> [--tier <t>]: write the review packet"),
  tier: lazy("tier.js", "tier \"<request>\" [--doc <path>] [--json] [--brief] [--no-heal]: lorc's tier engine · tier eval [--recompute]"),
  context: lazy("context.js", "context \"<request>\" [--doc <path>] [--run <slug>] [--json]: anchored line ranges for the request"),
  jev: lazy("jev.js", "TypeSafe jev tier judge: status [--ping] | connect - | disconnect | tier"),
});

function main(argv) {
  const name = argv[0] || "help";
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(`lorc: unknown command "${name}" — run "lorc help"\n`);
    return 2;
  }
  return cmd.run(argv.slice(1), name);
}

function fail(err) {
  if (process.env.LORC_DEBUG === "1") process.stderr.write((err && err.stack) + "\n");
  else process.stderr.write(`lorc: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
}

try {
  const out = main(process.argv.slice(2));
  // An async command (wait, changelog) returns a Promise and sets its own exit code.
  if (out && typeof out.then === "function") {
    out.then((code) => { if (Number.isInteger(code)) process.exitCode = code; }, fail);
  } else {
    process.exitCode = out || 0;
  }
} catch (err) {
  fail(err);
}
