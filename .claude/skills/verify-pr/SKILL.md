---
name: verify-pr
description: Comprehensive PR readiness check before merge. Run all quality checks, tests, CI status, documentation consistency, and AWS resource cleanup verification.
argument-hint: "[PR-number]"
---

# PR Readiness Verification

Run all checks to verify a PR is ready to merge.

## Checklist

Run each check and report pass/fail:

1. **Code quality**
   - `pnpm run typecheck` passes
   - `pnpm run lint` passes (run `lint:fix` first if needed)
   - `pnpm run build` succeeds

2. **Tests**
   - `npx vitest --run` - all unit tests pass
   - Report test count (files and tests)

3. **CI status**
   - If PR number is not provided as argument, auto-detect via `gh pr view --json number -q .number`
   - If no PR exists for current branch, ask the user for the PR number
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

## Output

Present results as a table:

| Check | Result |
|-------|--------|
| typecheck | pass/fail |
| lint | pass/fail |
| build | pass/fail |
| tests (N files, M tests) | pass/fail |
| CI | pass/fail |
| working tree | clean/dirty |
| docs consistency | pass/fail |
| leftover resources | none/found |

If all pass, confirm "PR is ready to merge."
If any fail, list the issues to fix.

## Final Step

After all checks pass, if there are uncommitted changes (e.g., lint fixes, doc updates made during this run), commit them and push to the remote. This ensures the remote branch is always up to date when reporting "PR is ready to merge."
