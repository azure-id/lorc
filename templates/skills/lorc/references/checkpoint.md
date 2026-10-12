# Checkpoint (tier complex only)

After each wave, and before any wait:
```
lorc run checkpoint --run <slug> - <<'EOF'
{"steps":[{"id":"T1","title":"…","status":"done|todo"}],"decisions":["…"],"next":"<exact next action>"}
EOF
```
It writes `.claude/lorc/run/<slug>/checkpoint.json` and a paste-ready `RESUME.md`.
A fresh session: `/lorc continue` → prep returns `resume` → read RESUME.md → continue at
`next`. Never redo a `done` step. `lorc run end` deletes both files.
