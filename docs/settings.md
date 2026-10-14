# Settings

[← README](../README.md)

Set a value with `lorc settings set <key> <value> [--global]`. Show all with `lorc settings`.
A project value beats a global value.

| Key | Default | Allowed values | What it does |
|---|---|---|---|
| `dispatch` | `auto` | `auto`, `manual` | auto = lorc starts executors; manual = lorc asks first |
| `dispatch_max` | `5` | `off`, `1`–`5` | most executors at the same time |
| `limit_pct` | `90` | integer 50–99 | stop at this used % of the 5-hour window |
| `limit_weekly_pct` | `98` | integer 50–100 | stop at this used % of the weekly window |
| `executor` | `ask` | `ask`, `haiku-5-high`, `sonnet-5-med`, `opus-5-low`, `opus-5-med` (+ the others with `executors: all`) | the executor model |
| `executors` | `core` | `core`, `all` | core = 5 executor choices; all = every model |
| `tier_judge` | `auto` | `auto`, `off` | auto = jev picks the tier when a key is connected; off = the built-in table only |
| `tier_engine` | `auto` | `auto`, `off` | auto = lorc's tier engine decides when jev does not; off = the model reads the tier table |
| `tier_judge_min_conf` | `60` | integer 0–99 | the lowest jev confidence (%) lorc accepts |
| `ask_judge` | `auto` | `auto`, `off` | auto = jev rates each L3 option when a key is connected; off = lorc recommends alone |
| `review` | `auto` | `auto`, `inline`, `agent` | how lorc reviews the change |
| `review_agent_min_lines` | `400` | integer 50–5000 | auto review uses an agent from this many changed lines |
| `pattern_miss` | `ask` | `ask`, `on`, `off` | what to do when no code pattern matches |
| `extra` | `auto` | `auto`, `off` | use ORC extra providers when ORC has them |
| `habits` | `observe` | `off`, `observe`, `propose` | habit capture level |
| `house_rules_warn_kb` | `4` | integer 1–64 | warn when house rules are bigger than this (KB) |
| `review_mute` | `""` | comma list of `a-z` and `-` | finding categories lorc does not list at P2/P3 |
| `statusline_writes_orc` | `true` | `true`, `false` | the status line also writes the ORC usage file |

