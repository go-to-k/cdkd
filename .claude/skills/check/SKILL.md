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

1. `vp check --fix` — typecheck + lint + Prettier formatting, with auto-fix. Then `vp run check` — the EXACT command CI's `check-build-test` job runs. The two are NOT equivalent: `vp check --fix` has passed 0-errors while `vp run check` failed with a TS7053 error on the same tree (observed 2026-08-09 on PR #1372 — an implicit-any union index the --fix invocation never surfaced, plus a `no-base-to-string` that --fix reported as a warning but CI failed as an error). Run both; CI parity comes from the second. **Use this, not `vp run lint:fix`**: the CI workflow runs `vp check` (which includes Prettier), and `lint:fix` does NOT touch Prettier formatting — so a `lint:fix`-only run passes locally but CI fails with `Formatting issues found` on the same branch. See memory rule `feedback_vp_check_vs_lint_fix.md` for the underlying gotcha and PR #363 for a concrete trap.
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

**Merely CREATING a file inside a gate's scope stales that gate — no edit to an existing file, and no commit.** An untracked file counts: the digest covers the scope's file SET, so a new path appearing in it changes the digest the moment the file exists. Measured 2026-08-20 in a feature worktree, markers otherwise fresh: creating an untracked `tests/_probe.ts` flipped `markgate verify check` from rc=0 to rc=1, and deleting it flipped it back to rc=0. `git commit` is **not** the trigger — the staleness is already there before you commit.

It is scope-dependent, which is what makes it confusing rather than merely surprising: in the same measurement `docs` stayed rc=0 throughout, because `tests/**` is not in its scope. So the same action stales one gate, both, or neither depending only on where the file landed — a new file under `tests/**` stales `check` alone, one under `.github/workflows/release.yml` or `CONTRIBUTING.md` stales neither. The measurement's third case is now stale rather than wrong: it recorded three untracked files under `.claude/hooks/` leaving BOTH gates at rc=0, and `.claude/hooks/**` joined the `check` scope in issue #2381, so that path now stales `check`. (Derived from the include list, not re-measured.)

This is correct behaviour, not a defect — a new test file genuinely means the recorded run no longer covers the tree. But the symptom is a `check-gate` refusal that reads as "my markers randomly expired", so it gets debugged instead of re-run. **Re-run the skill; do not investigate.** `/verify-pr` re-sets both markers in one shot.

Run this from the repo root (cdkd pins markgate via mise, so use `mise exec` to avoid PATH issues when shims aren't active):

```bash
mise exec -- markgate set check
```

Skip this step if any check failed — a stale or missing marker correctly forces the user (or Claude) to re-run `/check` after fixing the failure.
