# Works with ORC

[← README](../README.md)

**The delegate rule.** When ORC 2.2.0 or newer is installed, lorc calls `orc graph`, `orc wiki`, `orc pattern` and `orc extra`.
lorc checks each result. When a call fails, lorc uses its own path.

**Shared files.** lorc and ORC use the same files:

| What | Path |
|---|---|
| Wiki | `wiki/` |
| Code patterns | `.claude/orc/patterns/` |

**Store modes.** Since 0.4.0, lorc owns its graph engine (`bin/lib/graph/`, engine `lgraph@1`) and its store `.claude/lorc/orc/graph/` (format 2, see [graph.md](graph.md)).
- Delegate mode stays: with ORC 2.2.0 or newer and `code_graph` on or semi, lorc calls `orc graph`.
- The `orc-store` and `copy` modes are removed: the engine id of ORC no longer matches the engine of lorc.
- `lorc graph sync` (the old daily copy) is now a no-op.

**ORC 2.3.0** shows lorc in `orc ui` (the Light ORC panel) and has the `orc lorc …` commands.

