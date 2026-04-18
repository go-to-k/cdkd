---
name: check
description: Run local quality checks (typecheck, lint, build, tests). Lightweight alternative to /verify-pr that skips CI, docs, code review, and AWS resource checks.
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
If any fail, show the error output.
