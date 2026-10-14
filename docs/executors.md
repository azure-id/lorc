# Executors

[← README](../README.md)

| Agent | Model id | Effort | Use it for |
|---|---|---|---|
| `lorc-executor-haiku-5-high` | `claude-haiku-5-5` | high | mechanical work |
| `lorc-executor-sonnet-5-med` | `claude-sonnet-5-5` | medium | normal feature work |
| `lorc-executor-opus-5-low` | `claude-opus-5-5` | low | cross-module work, tricky state |
| `lorc-executor-opus-5-med` | `claude-opus-5-5` | medium | hard logic, security |
| `lorc-reviewer-opus-5-low` | `claude-opus-5-5` | low | the review of large or risky diffs |

- lorc recommends the cheapest executor that can do the task. It asks you only when it dispatches and `executor` is `ask`.
- An `extra:<slot>` choice shows for each ORC extra slot.
- `executors: all` installs the other models too: `haiku-4-5`, `sonnet-4-6-med`, `sonnet-4-6-high`, `sonnet-5-high`, `opus-4-7-med`, `opus-4-7-high`, `opus-4-8-high`, `opus-5-high`.
- `/lorc-wiki` uses `lorc-wiki-scanner-opus-5-low` and `lorc-wiki-scanner-sonnet-5-high`. `/lorc-pattern` uses `lorc-pattern-codifier-sonnet-5-high`.

