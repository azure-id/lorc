"use strict";
// lorc 0.5.0: link adapter `config` — env keys in every language. An env read
// is an effect of type `env` (graph-extract.js `effectsOf`). ENV_READS are the
// read forms that the base scan does not find. Each regex has ONE capture
// group: the key. A record keeps the KEY and the line only, never a value.
// The adapter has no stage: `applies` is always false.

const ENV_READS = [
  // Vite
  /\bimport\.meta\.env\.([A-Za-z_]\w*)/g,
  // env-var: Env.get('X') / env.get('X') / envVar.get('X')
  /(?<![\w$.])(?:env|Env|envVar)\s*\.\s*get\(\s*['"]([^'"\n]+)['"]/g,
  // Go
  /\bos\.LookupEnv\(\s*"([^"\n]+)"/g,
  // Python
  /\bos\.environ\.setdefault\(\s*['"]([^'"\n]+)['"]/g,
  /(?<![\w$.])environ\.get\(\s*['"]([^'"\n]+)['"]/g,
  // django-environ, Laravel
  /(?<![\w$.>:])env\(\s*['"]([^'"\n]+)['"]/g,
  /(?<![\w$.])env\.(?:str|bool|int|list)\(\s*['"]([^'"\n]+)['"]/g,
  // Ruby
  /\bENV\[\s*['"]([^'"\n]+)['"]\s*\]/g,
  /\bENV\.fetch\(\s*['"]([^'"\n]+)['"]/g,
  // Rust
  /(?<![\w$])(?:std::)?env::var\(\s*"([^"\n]+)"/g,
  /(?<![\w$])env!\(\s*"([^"\n]+)"/g,
  // PHP
  /\$_SERVER\[\s*['"]([^'"\n]+)['"]/g,
];

module.exports = { id: "config", langs: [], applies: () => false, ENV_READS };
