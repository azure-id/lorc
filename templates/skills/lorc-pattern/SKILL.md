---
name: lorc-pattern
description: Light ORC code pattern. Learns the project's real code conventions for ONE language and writes .claude/orc/patterns/<lang>-pattern.md in ORC's format. Use for "/lorc-pattern". Costs one subagent run per language.
---

# LORC-PATTERN

This skill writes ONE file per language: `.claude/orc/patterns/<lang>-pattern.md`. The format is
ORC's format (`references/pattern-doc.md`). ORC and LORC read the same file. Thus, when ORC is
installed, do the same steps: the file is shared.

## Rules

1. A manual `/lorc-pattern` is consent. Before the dispatch, tell the user: "This costs one
   subagent run per language."
2. You do not codify. You dispatch `lorc-pattern-codifier-sonnet-5-high`. It returns the pattern.
   YOU write the file.
3. The project CONVENTIONS win. The playbook INVARIANTS are always kept.
4. Do not change project code. Do not run tests. This skill writes only the pattern file.

## Steps

### 1 Detect the language key

Run `lorc pattern status` (no argument). It lists the cached keys and the known keys. The key is
a FRAMEWORK key from `references/INDEX.md` (for example `fe-vue`, `be-express`), never a file
extension. Use the detection map in `references/INDEX.md` (dependencies + file extensions).
`postgres` is a cross-cutting key: codify it as a separate key when a Postgres driver or ORM is
in the dependencies.

When the user names a key (`/lorc-pattern fe-vue`), use only that key. Else use each detected key.

Per key:
- No cached file → codify (step 2).
- Cached file, the user did not say `--refresh` → report "already learned (pattern_version …)"
  and stop for that key.
- `--refresh` → codify again.

### 2 Pick the playbook

Read `references/INDEX.md`. Pick the playbook file for the key:
`.claude/skills/lorc-pattern/references/<key>.md`. Read only that playbook. Do not read the other
playbooks.

### 3 Collect the sample files

Use the most recently modified files of that language. They show where the code goes. Run:

```
git log --name-only --format= -n 200 -- <globs for the language>
```

Keep the first unique paths that still exist. At most 12 files. Skip tests, generated files and
vendor folders. No files (greenfield) → still dispatch; the codifier returns the generic playbook
with `source: generic`.

### 4 Dispatch the codifier

Dispatch `lorc-pattern-codifier-sonnet-5-high` with:

- `lang` — the key; `domain` — FE or BE;
- `playbook_path` — `.claude/skills/lorc-pattern/references/<key>.md`;
- `schema_path` — `.claude/skills/lorc-pattern/references/pattern-doc.md`;
- `sample_files` — the list from step 3.

Validate the return: it has the header (`pattern_version`, `domain`, `source`, `fingerprint`)
and the sections Conventions, Invariants, Conflicts flagged, Ambiguities, and the optional
Validation gate. A return that is not in this shape → dispatch again one time with the error.
A second bad return → stop and tell the user. Do not write a bad file.

### 5 Write the file

Write the return EXACTLY to `.claude/orc/patterns/<key>-pattern.md`. Create the folder when it is
missing. Do not edit the content. Keep the Validation gate section when the return has it.

### 6 Check and report

Run `lorc pattern status <key>`. Exit 0 = cached. Report per key: written / skipped / refreshed,
the `pattern_version`, and each conflict or ambiguity the user must decide. Say each ambiguity
one time. Do not guess.
