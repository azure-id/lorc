# Wait on the usage limit

1. Never wait between a dispatch and its return. Finish the step first.
2. Save the place:
   ```
   lorc run checkpoint --run <slug> --resume - <<'EOF'
   {"step":"L4","done":["…"],"next":"<the exact next action>","decisions":["…"]}
   EOF
   ```
3. `weekly` → do not wait. Tell the user the RESUME path and the reset time. Stop.
4. `limit` → run `lorc wait --until-reset` with Bash `run_in_background: true`. When it ends:
   exit 10 → run it again (one hop ≤ 30 min; each wake-up refreshes the status line) · exit 0 →
   `lorc usage --json` → `ok` or `unknown` → continue at `next`. Still `limit` → run it again.
5. Context above 60 % after a long wait → tell the user to start a fresh session and type
   `/lorc continue`.
