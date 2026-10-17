# More features

[← README](../README.md)

## Code graph

- Store format 2: content-addressed buckets with a manifest. An update writes only the buckets that changed. More: [graph.md](graph.md).
- More robust extraction: `export default ({…})`, `export {}` / `export default NAME` of local consts, multi-declarator `const`, name-only Vue SFCs, `describe(...)` blocks as `test` symbols, `module.exports.x = function`, import-then-export barrels, a URL through a file constant. Test-helper calls (`expect`, `wrapper.*`, Testing Library …) are not stored.
- i18n keys: locale JSON files give each key with its line.
- Eval repo: zero-symbol files 60 → 8, partial files 72 → 17, API functions with a URL 43 of 255 → 248 of 268.

## House rules and anti-slop

- `lorc rules init` writes `HOUSE-RULES.md` in the repo root, with the levels P0, P1, P2 and P3.
- `HOUSE-RULES.md` beats every other rule.
- The rules card holds: your house rules, the P0 rules of the project `CLAUDE.md`, and ORC's code and delivery anti-slop rules. `lorc rules card` writes it to `.claude/lorc/rules-card.md`.
- `lorc rules show` prints the rules. `lorc rules lint [--diff]` checks the code with zero tokens.
- In the review, a broken house rule moves one level: rule P0 → P1, rule P1 → P2, rule P2/P3 → P3.

## Wiki and code pattern

- lorc reads at most 3 wiki page paths from prep, and the build, test and lint commands. L1 reads at most 1 page.
- lorc reads the code pattern file only when the work is in its language.
- `/lorc-wiki` builds the wiki. `/lorc-pattern` builds the code pattern. Both use ORC's file format.
- When no pattern matches and `pattern_miss` is `ask`, lorc asks one yes/no question: learn the pattern first?

## Usage limit and the status line

- `lorc usage` shows the 5-hour, weekly and context usage. Exit code: `0` ok or unknown · `1` limit · `3` weekly.
- At `limit_pct` (default 90 % of the 5-hour window), lorc waits for the reset. `lorc wait` waits with zero tokens.
- At `limit_weekly_pct` (default 98 % of the weekly window), lorc writes a RESUME file and stops.
- `lorc cli bypass` sets the lorc status line. `lorc cli restore` puts back the old one. `lorc cli status` shows which one is active.

The status line shows:

```
ctx <n>% · 5h <n>% · reset <n>m · wk <n>%
```

When ORC is installed and `statusline_writes_orc` is `true`, the status line also writes ORC's usage file.

## Behaviour learning

- lorc records your answers to its questions in `.claude/lorc/behaviour.jsonl`.
- From these records, lorc can make a habit proposal. It uses ORC's rule: at least 5 records, a Wilson lower bound of 0.55, and the last 3 records agree.
- lorc never applies a habit without your yes.
- `lorc habits` lists the proposals. `lorc habits accept <id>` and `lorc habits decline <id>` answer them.
- The `habits` setting: `off`, `observe` (default) or `propose`.

