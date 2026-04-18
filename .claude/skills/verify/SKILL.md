---
name: verify
description: Run local quality checks (typecheck, lint, build, tests). Lightweight alternative to /verify-pr that skips CI, docs, and AWS resource checks.
---

# Local Verification

Run all local quality checks. Use when you want to verify the current state without committing or checking CI.

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
If any fail, show the error output.
