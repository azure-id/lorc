# Code graph

[← README](../README.md)

Since 0.4.0, lorc owns its code graph engine: `bin/lib/graph/`, engine id `lgraph@1`. It started as a fork of the ORC 2.3.0 engine.

## Store layout (format 2)

The store is in `.claude/lorc/orc/graph/`.

| Path | What |
|---|---|
| `meta.json` | the manifest: engine, format, the list of `index/` buckets (`index`) and the previous list (`prev_index`) |
| `derived.json` | the manifest of the derived data: `resolved/` and `names/` buckets, the map, and the previous lists (`prev`) |
| `index/` | content-addressed buckets of the extracted files (symbols, imports, calls) |
| `resolved/` | content-addressed buckets of the resolved edges |
| `names/` | content-addressed buckets of the name lookup |

There are no `blobs/`, no shards and no `wide.json`.

## Write path

1. lorc reads `.git/index` directly to find the changed files. It uses git for conflicts, skip-worktree, intent-to-add and unknown extensions.
2. lorc extracts the changed files. With 200 files or more, it uses worker_threads in parallel.
3. lorc resolves the edges. It caches the reads of the alias config.
4. lorc writes only the buckets that changed (a new name for new content), then writes the manifest.
5. The files of the previous manifest stay until the next update. Then the GC deletes the files that neither the current nor the previous manifest lists.

`lorc graph gc` does the same GC on demand. It deletes a stray temp file only when it is older than 10 minutes.

## Read path

Readers do not lock. A reader reads the manifest, then the buckets it lists. The buckets never change in place, and the previous manifest's files stay, so a reader with an older manifest still finds its files. An older reader reads the manifest again once.

## Upgrade

- lorc still reads a format-1 store (lorc ≤ 0.3.x, `graph@7`) as is.
- `lorc graph upgrade` converts it in place. A language parses again only when its extractor version changed.
- `lorc graph status --heal` (prep) and any update also upgrade it.
- `lorc graph sync` is a no-op. The `orc-store` and `copy` store modes are removed. Delegate mode (ORC ≥ 2.2.0 with `code_graph` on/semi) stays. More: [orc.md](orc.md).

## Robustness

The extractor reads `export default ({…})`, local consts exported by `export {}` / `export default NAME`, multi-declarator `const a = …, b = …`, name-only Vue SFCs, `describe(...)` blocks as `test` symbols, `module.exports.x = function`, import-then-export barrels, a URL through a file constant, and locale JSON keys (`i18n` files: key → line). It does not store test-helper calls (`expect`, `wrapper.*`, Testing Library …).

## Numbers

Eval repo, 801 files, median of 3, 0.3.3 → 0.4.0:

| Measure | 0.3.3 | 0.4.0 |
|---|---|---|
| Cold build (wall) | 3,710 ms | 2,024 ms |
| Store after a cold build | 16.1 MB in 1,051 files | 9.8 MB in 196 files |
| 1-file update (wall) | 1,274 ms | 834 ms |
| 1-file update, written | 11.5 MB in 253 files | 254 KB in 4 files |
| No-op update (wall) | 488 ms | 392 ms |
| Upgrade of a format-1 store | — | 2.5 s |
| Zero-symbol files | 60 | 8 |
| Partial files | 72 | 17 |
| Symbols | 8,531 | 9,611 |
| API functions with a URL | 43 of 255 | 248 of 268 |

lorc's own repo: a 1-file update writes 46 KB (was 867 KB).

## Context pack

The graph feeds the context pack (`lorc context`, `<run>/context.md`). More: [how-it-works.md](how-it-works.md).

## Research

- Agentless (arXiv 2407.01489): hierarchical localization, file → element → line ranges.
- LocAgent (arXiv 2503.09089): a graph of the code for localization with few tool calls.
- RepoGraph (arXiv 2410.14684): a repo-level graph of lines and their 1-hop context.
- sqry-db: 64-shard caches; lorc uses content-addressed buckets with a manifest instead, so an update writes only what changed.
