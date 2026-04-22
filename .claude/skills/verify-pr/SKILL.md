---
name: verify-pr
description: Comprehensive PR readiness check before merge. Run quality checks, tests, CI, documentation, AWS resource cleanup, and code review.
argument-hint: "[PR-number]"
---

# PR Readiness Verification

Heavy pre-merge gate. Run this before creating or merging a pull request — NOT before every commit. Per-commit verification is handled by `/check` (enforced by a PreToolUse hook that blocks `git commit` without a fresh marker).

## Checklist

Run each check and report pass/fail:

1. **Code quality**
   - `pnpm run typecheck` passes
   - `pnpm run lint` passes (run `lint:fix` first if needed)
   - `pnpm run build` succeeds

2. **Tests**
   - `npx vitest --run` - all unit tests pass
   - Report test count (files and tests)
   - **Test coverage check**: compare `git diff main...HEAD` for `src/` changes vs `tests/` changes. If new logic was added or modified in `src/` but no corresponding test files were added or updated, flag as **fail** and add the missing tests before proceeding

3. **CI status**
   - If PR number is not provided as argument, auto-detect via `gh pr view --json number -q .number`
   - If no PR exists for current branch, use the `AskUserQuestion` tool to ask for the PR number
   - `gh pr checks <PR-number>` - all checks pass
   - If checks are pending, wait and recheck

4. **Working tree**
   - `git status` - clean (no uncommitted changes)
   - Branch is up to date with remote

5. **Documentation consistency**
   - Invoke `/check-docs` skill logic: verify docs match code changes
   - Check for stale references to removed code

6. **Leftover resources**
   - Resolve account ID via `aws sts get-caller-identity --query Account --output text`
   - `aws s3 ls s3://cdkd-state-{accountId}-us-east-1/stacks/ --region us-east-1` - no leftover state

7. **No stale references**
   - Grep for removed imports, old module names, or deprecated references in source files
   - Check `src/index.ts` exports are consistent

8. **Code review**
   - `git diff main...HEAD` — review the actual diff
   - For each change: is it correct? complete? necessary?
   - Check for:
     - Logic errors or unhandled edge cases
     - Unnecessary changes (reverted code still in diff, dead code, unrelated changes)
     - Inconsistencies between changed files
   - Verify PR title/body accurately reflect the actual diff (not stale commit messages)
   - Verify all callers of changed functions handle the new behavior
   - Verify type definitions are consistent with implementation

## Output

Present results as a table:

| Check | Result |
|-------|--------|
| typecheck | pass/fail |
| lint | pass/fail |
| build | pass/fail |
| tests (N files, M tests) | pass/fail |
| test coverage for changes | pass/fail |
| CI | pass/fail |
| working tree | clean/dirty |
| docs consistency | pass/fail |
| leftover resources | none/found |
| code review | pass/issues found |

If all pass, confirm "PR is ready to merge."
If any fail, list the issues to fix.

## Final Step

After all checks pass, record the commit-gate marker via [markgate](https://github.com/go-to-k/markgate) so the PreToolUse `check-gate` hook allows the next `git commit` — `/verify-pr` is a superset of `/check`, so its success implies `/check` success:

```bash
markgate set check
```

Then, if there are uncommitted changes (e.g., lint fixes, doc updates made during this run), commit them and push to the remote. This ensures the remote branch is always up to date when reporting "PR is ready to merge."

Skip the marker + commit step if any check failed.
