---
name: check
description: Run local quality checks (typecheck, lint, build, tests). Quick check during development.
---

# Local Quality Check

Run all local quality checks. Use during development to verify the current state quickly.

## Steps

Run these sequentially and report results:

0. **Worktree pre-flight**: confirm root `node_modules/` exists in the cwd:
   ```bash
   [ -d node_modules ] || pnpm install --frozen-lockfile
   ```
   `git worktree add` does NOT copy `node_modules`, and in a fresh worktree
   `vp check` fails with an UNNAMED `typescript(tsconfig-error): Invalid
   tsconfig — Cannot find type definition file for 'node'` (no file path in
   the message), which reads like a broken fixture tsconfig and sends you
   hunting in the wrong place. `/verify-pr` step 0 has the same pre-flight;
   this copy exists because `/check` is usually the FIRST skill run in a
   fresh worktree.

1. `vp check --fix` — typecheck + lint + Prettier formatting, with auto-fix. **Use this, not `vp run lint:fix`**: the CI workflow runs `vp check` (which includes Prettier), and `lint:fix` does NOT touch Prettier formatting — so a `lint:fix`-only run passes locally but CI fails with `Formatting issues found` on the same branch. See memory rule `feedback_vp_check_vs_lint_fix.md` for the underlying gotcha and PR #363 for a concrete trap.
2. `vp run typecheck:test` — type-checks `tsconfig.test.json` (the `tests/**` project). **`vp check` above only type-checks `tsconfig.json` (src/** + types/**), which excludes `**/*.test.ts`** — so a wrong `import type` or a stale mock shape in a test file would pass `vp check` AND `vp test` (whose "Type Errors" line only covers `*.test-d.ts`). This step is what makes test-file type errors fail locally the same way CI now fails them (issue #1133).
3. `vp run build`
4. `vp run test`

## Output

Report as a table:

| Check | Result |
|-------|--------|
| typecheck + lint + format (`vp check --fix`) | pass/fail |
| test-project typecheck (`vp run typecheck:test`) | pass/fail |
| build | pass/fail |
| tests (N files, M tests) | pass/fail |

If all pass, confirm "All checks passed."
If any fail, show the error output and STOP — do not write the commit-gate marker.

## Commit-gate marker (on success only)

After all four checks pass, record a marker so the PreToolUse `check-gate` hook (see `.claude/hooks/check-gate.sh`) allows the next `git commit`. The marker is managed by [markgate](https://github.com/go-to-k/markgate) and captures the current working tree state; any subsequent edits invalidate it and require re-running `/check`.

Run this from the repo root (cdkd pins markgate via mise, so use `mise exec` to avoid PATH issues when shims aren't active):

```bash
mise exec -- markgate set check
```

Skip this step if any check failed — a stale or missing marker correctly forces the user (or Claude) to re-run `/check` after fixing the failure.
