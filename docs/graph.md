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

0.5.0 makes the back ends stronger. lorc builds the Go parser once, outside the repo, and caches it, so Go never downloads a toolchain. A chained call never resolves by a bare name, and TS `enum`s, interfaces, types and `export const` members are symbols. Typed receivers, class controllers, typed Fastify routes, Go route groups and Fastify autoload prefixes give more routes with a handler. A call through an interface or an abstract member reaches the class that implements it.

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

0.5.0, sandbox clones, one cold build each (the update: median of 3):

| Repo | Measure | 0.4.3 | 0.5.0 |
|---|---|---|---|
| Vue 2 SPA (819 files) | Cold build (lorc time, median of 3) | 1,980 ms | 2,161 ms |
| Vue 2 SPA | Index | 5.48 MB | 7.37 MB |
| Vue 2 SPA | Symbols | 10,399 | 13,364 |
| Vue 2 SPA | Partial files | 18 | 4 |
| Vue 2 SPA | 1-file update (wall) | 876 ms | 1,091 ms |
| Vue 2 SPA | Store / listen / prop / i18n resolved | — | 99.1 % / 85.5 % / 85.3 % / 94.6 % |
| Go Fiber API (228 files) | Cold build (lorc time, median of 3) | 15,735 ms | 817 ms |
| Go Fiber API | Routes; route → handler | 164; 3 | 164; 78 of 80 non-test |
| TypeScript Express + TypeORM API (200 files) | Routes; route → handler | 2 | 33; 33 |
| TypeScript Express + TypeORM API | Env keys resolved | not found | 43 of 49 |
| TypeScript Fastify + knex API (359 files) | Routes; route → handler | 35 | 150; 77 of 126 non-test |

The 1-file update is slower because the derived cache also resolves the link calls (about 28 % more calls).

## Links (0.5.0)

A link joins a use to its definition across a framework or a language border: a store key, a component event, an i18n key, a config key or a table. Adapters record links when lorc extracts a file. They use zero tokens. lorc resolves the names when it reads the graph.

| Adapter | Languages | What it records |
|---|---|---|
| `vue` | Vue, JS, TS | Vuex store modules (mutation, action, getter, state), `mapState` / `mapGetters` / `mapActions` / `mapMutations`, `$emit` → `@event` listeners, props, `$t` i18n keys, template bindings, `Vue.mixin` global mixins, `router.push` / `<router-link>` paths |
| `events` | JS, TS | a global event bus by name: `emit('x')` → `on('x')`, `@OnEvent('x')` |
| `config` | JS, TS, Go, env | env reads (`process.env.X`, `import.meta.env.X`, `Env.get('X')`, `os.LookupEnv`, and more), keys in `.env` / `.env.*` files |
| `data` | JS, TS, Go, SQL | tables in SQL text, `.sql` files (`CREATE TABLE` / `VIEW`), ORM entities (`@Entity`, `tableName`), knex `createTable` |

Record shapes in short:

- Call flags: `store` (the role), `listen`, `prop`, `i18n`, `route` + `path`, `event` (`emit` or `on`). Each call keeps a name. lorc resolves the name on read.
- Symbol kinds: `state` (a store state field), `field` (a component data field), mapped members (`method` with `mapped`).
- File records: an `env` file and a `sql` file have `keys` (`[name, line]`) and no symbols.

| State | Meaning | Example card row |
|---|---|---|
| STORE | a store call reaches a store member | `links  store: mutation setToken → store/login.js:40` |
| EVENT | an emit reaches each `on` site of that event | `links  events: emits user.created (2 listeners)` |
| I18N | an i18n key has a line in a locale file | `links  i18n: 12 keys → locales/en.json · missing: topup.note` |
| CONFIG | a config key has a line in an env file | `links  config: DB_HOST → .env.example:3` |
| TABLE | a table name has a definition (SQL or ORM) | `links  tables: users → migrations/001.sql:5` |

A miss is `UNRESOLVED` with a reason: `missing_store`, `missing_i18n`, `missing_route`, `missing_event` or `missing_config`. lorc gives `missing_config` only when the repo has at least one env file.

**Secrets rule.** For a `.env` file, lorc records the key and the line number only. It never reads a value into the graph.

## Graph lifecycle (0.5.0)

- lorc never builds the first graph by itself. A person runs `lorc graph scan` once. Prep suggests it when no graph exists.
- When a graph exists, prep heals the changed files at the start of a run.
- `lorc run end` updates the graph once at the end of a run.
- The hook runs `lorc graph update --if-exists`. When no graph exists, this command does nothing.
- In delegate mode (ORC ≥ 2.2.0), lorc handles `--if-exists` itself before it calls ORC.

## Context pack

The graph feeds the context pack (`lorc context`, `<run>/context.md`). More: [how-it-works.md](how-it-works.md).

## Research

- Agentless (arXiv 2407.01489): hierarchical localization, file → element → line ranges.
- LocAgent (arXiv 2503.09089): a graph of the code for localization with few tool calls.
- RepoGraph (arXiv 2410.14684): a repo-level graph of lines and their 1-hop context.
- sqry-db: 64-shard caches; lorc uses content-addressed buckets with a manifest instead, so an update writes only what changed.
