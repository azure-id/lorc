# Works with ORC

[← README](../README.md)

**The delegate rule.** When ORC 2.2.0 or newer is installed, lorc calls `orc graph`, `orc wiki`, `orc pattern` and `orc extra`.
lorc checks each result. When a call fails, lorc uses its own path.

**Shared files.** lorc and ORC use the same files:

| What | Path |
|---|---|
| Code graph store | `.claude/orc/graph/` |
| Wiki | `wiki/` |
| Code patterns | `.claude/orc/patterns/` |

**The daily graph copy.** `lorc prep` runs `lorc graph sync --if-older 24`. This copies ORC's graph store to `.claude/lorc/copy/` when the copy is older than 24 hours.
lorc reads the copy when ORC's store has a different engine version.

**ORC 2.3.0** shows lorc in `orc ui` (the Light ORC panel) and has the `orc lorc …` commands.

