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
   - `aws s3 ls s3://cdkd-state-{accountId}-us-east-1/stacks/ --region us-east-1` — no leftover state
   - **For deletion-touching PRs** (any change under `src/provisioning/providers/**`, `src/cli/commands/destroy.ts`, `src/analyzer/dag-builder.ts`, `IMPLICIT_DELETE_DEPENDENCIES`, etc.): the `integ-destroy` markgate gate **physically blocks `gh pr merge`** when its marker is stale (see `.claude/hooks/integ-destroy-gate.sh`). This step verifies the gate state explicitly so failures surface here rather than at merge time:
     ```bash
     mise exec -- markgate verify integ-destroy
     ```
     If this exits non-zero, run `/run-integ <relevant-test>` (e.g. `bench-cdk-sample`) and confirm it reports 0 errors / 0 orphans — the skill itself will then call `markgate set integ-destroy`.
     CI is necessary but not sufficient — it does not exercise real-AWS destroy. The gate is the structural enforcement of that fact.
   - For each region this PR may have created resources in (typically `us-east-1`), spot-check the most failure-prone resource types — VPCs (`describe-vpcs --filters "Name=tag:Name,Values=Cdkd*/Vpc"`), Lambda hyperplane ENIs (`describe-network-interfaces --filters "Name=description,Values=AWS Lambda VPC ENI-*"`), CloudFront Distributions, NAT Gateways. Any match against a stack name in this PR's diff = orphan, must be cleaned up before merge.

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
   - Verify all callers of changed functions handle the new behavior
   - Verify type definitions are consistent with implementation

9. **PR body freshness** (skip if no PR exists yet — `/create-pr` will write it from scratch)
   - When a PR has follow-up commits after creation, the body authored at PR-create time often goes stale (mentions reverted features, removed checks, or wrong rationale). Detect and fix it.
   - Commands:
     - `gh pr view <PR> --json commits -q '.commits | length'` — commit count on the PR
     - `git log main..HEAD --oneline | wc -l` — commit count locally
     - If they match and >1, the PR has been iterated on; the initial body is almost certainly stale
   - Read the current body (`gh pr view <PR> --json body -q .body`) and compare against the actual final diff (`git diff main...HEAD`). Flag any of:
     - Bullets describing behavior that was reverted in a later commit
     - Bullets describing checks/validations the code no longer performs
     - File:line citations that no longer exist
     - Wording that contradicts the current README.md / CLAUDE.md
   - If stale, rewrite the body and patch via:
     ```bash
     # Write desired body to a file (avoids shell escaping issues with backticks)
     cat > /tmp/pr-body.md <<'EOF'
     ## Summary
     ...
     ## Test plan
     ...
     EOF
     gh api repos/{owner}/{repo}/pulls/{number} -X PATCH --field "body=@/tmp/pr-body.md" -q '.html_url'
     ```
     Note: `gh pr edit --body` may fail with "Projects (classic) is being deprecated" — fall back to the `gh api PATCH` form above.
   - Verify with `gh pr view <PR> --json body -q .body | head -5` that backticks and special chars rendered correctly.

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
| PR body freshness | up-to-date/stale (updated)/n-a (no PR yet) |

If all pass, confirm "PR is ready to merge."
If any fail, list the issues to fix.

## Final Step

After all checks pass, record BOTH commit-gate markers via [markgate](https://github.com/go-to-k/markgate) so the PreToolUse `check-gate` hook allows the next `git commit`. `/verify-pr` is a superset of both `/check` (code correctness) and `/check-docs` (docs consistency), so its success implies both. cdkd pins markgate via mise, so use `mise exec` to avoid PATH issues when shims aren't active:

```bash
mise exec -- markgate set check
mise exec -- markgate set docs
```

Then, if there are uncommitted changes (e.g., lint fixes, doc updates made during this run), commit them and push to the remote. This ensures the remote branch is always up to date when reporting "PR is ready to merge."

Skip the marker + commit step if any check failed.
