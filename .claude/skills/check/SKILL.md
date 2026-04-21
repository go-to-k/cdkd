---
name: check
description: Run local quality checks (typecheck, lint, build, tests). Quick check during development.
---

# Local Quality Check

Run all local quality checks. Use during development to verify the current state quickly.

## Steps

Run these sequentially and report results:

1. `pnpm run typecheck`
2. `pnpm run lint:fix`
3. `pnpm run build`
4. `npx vitest --run`

## Output

Report as a table:

| Check | Result |
|-------|--------|
| typecheck | pass/fail |
| lint | pass/fail |
| build | pass/fail |
| tests (N files, M tests) | pass/fail |

If all pass, confirm "All checks passed."
If any fail, show the error output and STOP — do not write the commit-gate marker.

## Commit-gate marker (on success only)

After all four checks pass, record a marker so the PreToolUse `check-gate` hook (see `.claude/hooks/check-gate.sh`) allows the next `git commit`. The marker records the HEAD SHA + content hash of the current working tree; any subsequent edits invalidate it and require re-running `/check`.

Run this exact command from the repo root:

```bash
head=$(git rev-parse HEAD)
content=$({
  git diff HEAD --name-only
  git ls-files --others --exclude-standard
} | sort -u | while IFS= read -r f; do
  if [ -f "$f" ]; then
    printf 'FILE:%s\n' "$f"
    cat "$f"
  else
    printf 'DEL:%s\n' "$f"
  fi
done | shasum -a 256 | cut -c1-16)
printf '{"head":"%s","content":"%s"}' "$head" "$content" > /tmp/cdkd-check-marker.json
```

Skip this step if any check failed — a stale or missing marker correctly forces the user (or Claude) to re-run `/check` after fixing the failure.
