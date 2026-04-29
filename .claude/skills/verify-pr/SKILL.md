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
   - **Shared-utility regression check**: if any file under `src/utils/**` (or another widely-imported module) changed, list every importer (`grep -rl "from '\.\./.*utils/<file>'" src tests`) and walk through each one to confirm the new behavior is correct for them. A change to a shared helper is only "done" when every caller has been considered.

9. **Live-test changed behavior**
   - Unit tests verify code correctness; this step verifies *feature* correctness against the runtime the user actually sees.
   - Build the latest source: `pnpm run build`
   - For each user-visible change in the diff (CLI command, output format, flag, error message), run the actual command path against a real or fixture input and confirm the output matches the spec / CDK CLI parity claim:
     - CLI surface change → run `node dist/cli.js <subcommand> <args>` against `tests/integration/<example>/cdk.out` or a real state bucket; verify each output mode (`--long` / `--json` / patterns / etc.).
     - State-touching change → exercise it against a real / test state bucket (e.g. `cdkd-state-test`).
     - Non-CLI library change → run a minimal repro that imports the new code path.
   - "Tests passed" is not "feature works." Always run the actual command before declaring done. If you cannot live-test (no real-AWS credentials, no fixture available), say so explicitly rather than skip silently — the gate exits non-zero in that case so a reviewer can decide whether to accept the trade-off.

10. **Retrospective + rules update**
    - Walk back over the session that produced this PR. For each surprise, friction, or correction the user had to make, ask: "is this a one-off, or a pattern that will recur?"
    - For each pattern, propose where it should be reflected so it doesn't recur:
      - **Hook** — pattern can be detected mechanically (e.g. fragile shell pattern, deprecated tool, marker-gated step). Strongest enforcement.
      - **Skill / marker** — pattern is a checklist that must be done before some action. Use the `/check`+`check-gate` / `/check-docs`+`check-gate` / `/verify-pr`+`verify-pr-gate` / `/run-integ`+`integ-destroy-gate` template.
      - **Memory** — pattern is judgmental ("prefer X when Y") and not mechanically detectable. Weakest enforcement; honest about its limits.
    - Surface the proposals out loud (in chat, or in this PR's body) before merging. If the user agrees, write them in the same PR for code/skill/hook artifacts; memory entries are local to `~/.claude/projects/.../memory/` so they land regardless of PR boundaries.
    - The retrospective is itself one of the items the `verify-pr` marker covers — skipping this step means the marker is set on incomplete work.

11. **PR title + body freshness** (skip if no PR exists yet — `/create-pr` will write them from scratch)
    - When a PR has follow-up commits after creation, both the title and body authored at PR-create time often go stale: the title was scoped to the first commit's intent only, and the body may mention reverted features, removed checks, or wrong rationale. Detect and fix both.
    - **Title check**: read `gh pr view <PR> --json title -q .title` and confirm it still describes the union of commits on the branch. If a later commit added a separate concern (e.g. an unrelated fix, an opportunistic refactor), broaden the title. Update via `gh api -X PATCH repos/{owner}/{repo}/pulls/{number} -f title="..."` (NOT `gh pr edit --title`, which currently fails silently due to GraphQL Projects-classic deprecation — see hook `gh-pr-edit-deprecation-gate.sh`).
    - **Body freshness commands**:
      - `gh pr view <PR> --json commits -q '.commits | length'` — commit count on the PR
      - `git log main..HEAD --oneline | wc -l` — commit count locally
      - If they match and >1, the PR has been iterated on; the initial body is almost certainly stale
    - Read the current body (`gh pr view <PR> --json body -q .body`) and compare against the actual final diff (`git diff main...HEAD`). Flag any of:
      - Bullets describing behavior that was reverted in a later commit
      - Bullets describing checks/validations the code no longer performs
      - File:line citations that no longer exist
      - Wording that contradicts the current README.md / CLAUDE.md
      - Stale numeric claims ("N tests pass" when the count has since changed)
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
| code review (incl. shared-utility callers) | pass/issues found |
| live-test changed behavior | pass/skipped/issues found |
| retrospective + rule proposals | done/skipped |
| PR title + body freshness | up-to-date/stale (updated)/n-a (no PR yet) |

If all pass, confirm "PR is ready to merge."
If any fail, list the issues to fix.

## Final Step

After all checks pass, record THREE markers via [markgate](https://github.com/go-to-k/markgate) so the gate hooks allow the next `git commit`, `gh pr create`, and `gh pr merge`. `/verify-pr` is a superset of `/check` (code correctness) and `/check-docs` (docs consistency), and adds live-test + retrospective + scope-match on top — so its success implies all three. cdkd pins markgate via mise, so use `mise exec` to avoid PATH issues when shims aren't active:

```bash
mise exec -- markgate set check
mise exec -- markgate set docs
mise exec -- markgate set verify-pr
```

The `verify-pr` marker is the one consulted by `.claude/hooks/verify-pr-gate.sh` to allow `gh pr create` and `gh pr merge`. It is intentionally settable ONLY by this skill — running it by hand from a shell to bypass the gate defeats the whole point. If a check legitimately cannot pass right now (e.g. the live-test cannot run because the user lacks AWS credentials), say so explicitly in the report and DO NOT set the marker — the gate exits non-zero so the human can decide whether to override.

Then, if there are uncommitted changes (e.g., lint fixes, doc updates made during this run), commit them and push to the remote. This ensures the remote branch is always up to date when reporting "PR is ready to merge."

Skip the marker + commit step if any check failed.
