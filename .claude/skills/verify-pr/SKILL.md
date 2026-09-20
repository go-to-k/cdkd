---
name: verify-pr
description: Comprehensive PR readiness check before merge. Run quality checks, tests, CI, documentation, AWS resource cleanup, and code review.
argument-hint: "[PR-number]"
---

# PR Readiness Verification

Heavy pre-merge check, before creating or merging a PR — NOT before every commit
(that is `/check`). No hook or marker enforces it; the checklist still applies in
full and is the recommended procedure before `gh pr create` / `gh pr merge`.

Steps 6, 8 and 10-12 live in `references/*.md`, read at the step that uses them.

## Checklist

Run each check and report pass/fail:

0. **Worktree pre-flight**: `mise trust`, then `[ -d node_modules ] || pnpm install`.
   `mise trust` is unconditional — an untrusted `.mise.toml` makes every
   `mise exec` in this run die with a config-parse error naming no cause. A fresh
   worktree has no `node_modules`, so typecheck / lint / build / test all fail
   with `tsc: command not found`, easy to miss when output is piped to `tail`
   (the exit code is `tail`'s). Do not start step 1 until this passes.

1. **Code quality** — `/check` steps 1-3, which this skill supersedes.
   - `vp run check` (CI's exact command: typecheck + lint + Prettier; `lint`
     alone skips Prettier), `vp run typecheck:test` (the only gate covering
     `tests/**`), `vp run build` — all pass.
   - When piping to `tail` / `head` / `grep`, check the output CONTENT for
     `Error` / `Command failed`: `$?` after a pipeline reflects the last stage.
     When in doubt: `vp run X > /tmp/out 2>&1; rc=$?; tail -3 /tmp/out; echo "[rc=$rc]"`.

2. **Tests**
   - `vp test run` — all unit tests pass (preferred over `vp run test`; `/check`
     step 4 has the rationale). Report the test count.
   - Every scope / diff check in this skill uses `origin/main...HEAD`, never
     `main...HEAD` — the `integ-destroy` gate derives its scope from
     `origin/main`, so an unfetched local `main` makes this skill and the
     merge-blocking gate disagree about what the branch touched.
   - **Test coverage check**: compare the diff's `src/` changes against its
     `tests/` changes; new or modified logic with no test update is a FAIL.

3. **CI status**
   - PR number: argument, else `gh pr view --json number -q .number`, else ask
     via `AskUserQuestion`.
   - FIRST: `gh pr view <PR> --json mergeStateStatus,mergeable`. At
     `mergeable=CONFLICTING state=DIRTY` the CI workflow NEVER fires, however
     long you wait, and neither close+reopen nor a force-push of unchanged
     content re-triggers it. Resolution:
     `git fetch origin main && git rebase origin/main`, resolve, force-push.
   - Only once the state is `CLEAN` / `UNSTABLE` / `BLOCKED` / `BEHIND`:
     `gh pr checks <PR>` — all pass; if pending, wait and recheck.

4. **Working tree**: `git status` clean; branch up to date with remote.

5. **Documentation consistency**
   - Invoke `/check-docs` logic: docs match code changes; no stale references.
     Run it ONCE per PR, at the FINAL sha — not per commit. It is the required
     step for SEMANTIC docs consistency: CI only covers the STRUCTURAL checks
     (links, nav, tables, error strings, coverage matrices), so whether a
     surviving sentence is still TRUE is checked here or nowhere.
   - **Generated-artifact freshness**: CI carries a staleness guard per generated
     artifact. Do not hand-list them — regenerate everything, then check nothing
     is dirty:
     ```bash
     # `format` is in the chain, not a tidy-up: CI's guard formats before
     # diffing, so skipping it renders a formatting-only diff as real drift.
     vp run gen:all-matrices && vp run format
     vp run audit:coverage:check          # offline critic, not part of the aggregate
     git status --short docs/ src/provisioning/property-coverage.generated.ts \
                        src/provisioning/unsupported-types.generated.ts
     ```
     Anything dirty was stale before you ran the above: stage it into the PR and
     re-run `/check-docs`. If `audit:coverage:check` fails, run
     `vp run audit:coverage:regenerate` (heavy, needs AWS credentials with
     `cloudformation:ListTypes` + `DescribeType`) and commit the cache. A new
     `registry.register(...)` also needs an integ fixture covering it; nothing
     blocks on that, so check it here.

6. **Leftover resources + the integ runs** — read
   [references/leftover-and-integ-gates.md](references/leftover-and-integ-gates.md).
   Always do the baseline state-bucket check; the deletion / cross-cutting /
   local-execution / schema-bump integ runs apply only when the diff touches
   their scope.

7. **No stale references**: grep for removed imports / old module names;
   `src/index.ts` exports consistent.

8. **Code review** — read [references/code-review.md](references/code-review.md).
   `/review-pr <N>` picks the reviewers: one by default, `pr-security-reviewer`
   additive whenever a security surface is touched, 3-axis for a state-schema
   bump or a security fix. Every fix round gets re-reviewed.

9. **Live-test changed behavior**
   - Unit tests verify code correctness; this verifies FEATURE correctness
     against the runtime the user sees. `vp run build` first.
   - For each user-visible change (CLI command, output format, flag, error
     message), run the actual command path: CLI change →
     `node dist/cli.js <subcommand> <args>` against
     `tests/integration/<example>/cdk.out` or a real state bucket, in each output
     mode; state-touching change → a real or test bucket; library change → a
     minimal repro importing the new path.
   - "Tests passed" is not "feature works." If you cannot live-test, report it as
     a FAILED row rather than skipping silently, and do not open or merge the PR
     on it quietly.

10. **Retrospective, residual-nit sweep, PR title + body freshness (steps
    10-12)** — read [references/wrap-up.md](references/wrap-up.md). All three run
    once, at the end. The nit sweep is where a deferral gets CLASSIFIED: do not
    report the PR ready with a reviewer-flagged item that is neither fixed, filed,
    nor recorded as won't-do.

## Output

Present results as a table:

| Check | Result |
|-------|--------|
| `vp run check` (typecheck + lint + format) | pass/fail |
| `vp run typecheck:test` | pass/fail |
| build | pass/fail |
| tests (N files, M tests) | pass/fail |
| test coverage for changes | pass/fail |
| CI | pass/fail |
| working tree | clean/dirty |
| docs consistency | pass/fail |
| leftover resources | none/found |
| integ-destroy marker (deletion-touching PRs only) | fresh/stale/n-a |
| broad / local / schema-migration integ run (when in scope) | run/n-a |
| code review (incl. shared-utility callers) | pass/issues found |
| live-test changed behavior | pass/skipped/issues found |
| retrospective + rule proposals | done/skipped |
| residual review-nit sweep (fixed / TODO-issue / won't-do) | N items / 0 unhandled |
| every TODO carries `Session-fit` / `Severity` / `Effort` / `Estimate` | N classified / 0 open `now` |
| auto-close audit (no `Closes (#N)` in body) | clean / N traps fixed |
| PR title + body freshness | up-to-date/stale (updated)/n-a (no PR yet) |

If all pass, confirm "PR is ready to merge." If any fail, list the issues.

Read [../../rules/session-report.md](../../rules/session-report.md) before
writing the report — its `paths:` glob matches only `AGENTS.md`, which the
harness injects rather than reads, so it never auto-loads.

Then add the **State** line the wrap-report rule requires. Specific to THIS
skill: "ready to merge" is rarely the end of the turn. A merely PENDING check
(CI, an integ, a reviewer not back) is WAITING and you merge on green; a check
that legitimately cannot pass is not WAITING at all; STOPPED is only for a PR
already merged, or one whose next step the user explicitly owns.

## Final Step

After all checks pass, land the work:

```bash
git add -A
git diff --cached --quiet || git commit -m "..."
git push        # after a rebase: --force-with-lease
```

No marker is recorded — nothing mechanical consults this run, which makes the
report the only record that it happened. Two merge conditions remain, and this
skill sets neither: the `main` ruleset's required checks, which GitHub
enforces — wait with `gh pr checks <N> --watch` — and, for a deletion-touching
diff, the `integ-destroy` gate `/run-integ` sets after a clean real-AWS
destroy.

Skip the commit/push if any check failed.
