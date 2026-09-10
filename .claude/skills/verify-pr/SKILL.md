---
name: verify-pr
description: Comprehensive PR readiness check before merge. Run quality checks, tests, CI, documentation, AWS resource cleanup, and code review.
argument-hint: "[PR-number]"
---

# PR Readiness Verification

Heavy pre-merge gate. Run before creating or merging a pull request — NOT
before every commit (per-commit verification is `/check`, enforced by the
`check-gate` hook).

Steps 6, 8 and 10-12 live in `references/*.md`, read at the step that uses
them, so the always-loaded payload stays small — and having them caps THIS
file at 12,000 B rather than 23,000, so new material usually belongs in a
stage file. Each is bulky for a different reason:
step 6 is almost entirely conditional on what the diff touches, step 8 is long
because it RECURSES (every fix round is re-reviewed), and 10-12 run once at the
very end. Everything kept below is read on every invocation.

## Checklist

Run each check and report pass/fail:

0. **Worktree pre-flight**: `[ -d node_modules ] || pnpm install`.
   `git worktree add` does NOT copy `node_modules`, so a fresh worktree's
   typecheck/lint/build/test all fail with `tsc: command not found` etc. — and
   the failure is easy to miss when output is piped to `tail` (the exit code
   reflects `tail`). If skipping via an existing `node_modules`, spot-check
   `pnpm-lock.yaml` mtime ≤ `node_modules/.modules.yaml` mtime. Do not start
   step 1 until this passes, or every check below silently no-ops.

1. **Code quality** — `/check` steps 1-3, which this skill supersedes.
   - `vp run check` (CI's exact command: typecheck + lint + Prettier; `lint`
     alone skips Prettier, PR #363), `vp run typecheck:test` (the ONLY gate
     covering `tests/**` — `tsconfig.json` excludes `**/*.test.ts` and
     `vp test run`'s `Type Errors` line covers only `*.test-d.ts`; issue
     #1133, go-to-k/cdkd#2929), `vp run build` — all pass.
   - When piping to `tail` / `head` / `grep`, **check the output content** for
     `Error` / `Command failed` — `$?` after a pipeline reflects the LAST
     stage, and a background-task notification's `exit code 0` is the chained
     command's exit. When in doubt:
     `vp run X > /tmp/out 2>&1; rc=$?; tail -3 /tmp/out; echo "[rc=$rc]"`.

2. **Tests**
   - `vp test run` — all unit tests pass. Preferred over `vp run test`:
     nothing sits between the caller and the verdict (`/check` step 4 has the
     full rationale). Report test count.
   - Every scope / diff check in this skill uses `origin/main...HEAD`, never
     `main...HEAD` — the gate hooks derive scope from `origin/main`, so an
     unfetched local `main` makes this skill and the merge-blocking hook
     disagree about what the branch touched.
   - **Test coverage check**: compare the diff's `src/` changes vs `tests/`
     changes; new/modified logic with no corresponding test update = **fail**
     — add the missing tests before proceeding.

3. **CI status**
   - PR number: argument, else `gh pr view --json number -q .number`, else ask
     via `AskUserQuestion`.
   - **FIRST**: `gh pr view <PR> --json mergeStateStatus,mergeable -q
     '"mergeable=\(.mergeable) state=\(.mergeStateStatus)"'` — at
     `mergeable=CONFLICTING state=DIRTY` the CI workflow NEVER fires, however
     long you wait (PR #404: ~70 min lost; close+reopen and force-pushing
     unchanged content do not re-trigger). Resolution:
     `git fetch origin main && git rebase origin/main`, resolve, force-push —
     CI fires within ~30s.
   - Only after the state is `CLEAN` / `UNSTABLE` / `BLOCKED` / `BEHIND`:
     `gh pr checks <PR>` — all pass; if pending, wait and recheck.

4. **Working tree**: `git status` clean; branch up to date with remote.

5. **Documentation consistency**
   - Invoke `/check-docs` logic: docs match code changes; no stale references.
   - **Generated-artifact freshness**: CI carries a staleness guard per
     generated artifact (nine of them; a hand-list here drifted four times —
     PRs #548, #1104, #1231, #1416 — so do NOT re-list). Regenerate
     everything, then check nothing is dirty:
     ```bash
     # Regenerates every artifact CI guards (offline static analysis).
     # `format` is in the chain, not a tidy-up: CI's guard formats before
     # diffing, so skipping it renders a formatting-only diff as real drift.
     vp run gen:all-matrices && vp run format
     # Offline CRITIC (~0.5s), not part of the aggregate.
     vp run audit:coverage:check
     git status --short docs/ src/provisioning/property-coverage.generated.ts \
                        src/provisioning/unsupported-types.generated.ts
     ```
     Anything dirty was stale before you ran the above: stage it into the PR
     and re-run `/check-docs`. If `audit:coverage:check` fails, run
     `vp run audit:coverage:regenerate` (heavy ~15 min, needs AWS creds with
     `cloudformation:ListTypes` + `DescribeType`) and commit the cache —
     `/verify-pr` does not auto-run `:regenerate`.
     `tests/unit/scripts/matrix-regen-coverage.test.ts` pins
     `gen:all-matrices` against `ci.yml`'s guards in both directions — keep
     pointing at the aggregate. (The `provider-integ-gate.sh` hook blocks a
     new `registry.register(...)` without integ coverage but does not enforce
     matrix regeneration; this step closes that gap.)

6. **Leftover resources + the integ gates** — read
   [references/leftover-and-integ-gates.md](references/leftover-and-integ-gates.md).
   Always do the baseline state-bucket check; the `integ-destroy` /
   `integ-broad` / `integ-local` blocks fire only when the diff touches their
   scope, and that file carries the scope lists, the exit-code remedies and
   the orphan spot-check.

7. **No stale references**: grep for removed imports / old module names;
   `src/index.ts` exports consistent.

8. **Code review** — read [references/code-review.md](references/code-review.md).
   `/review-pr <N>` picks the tier, `pr-security-reviewer` is additive at any
   tier, and every fix round gets re-reviewed — that file carries the rules and
   the incidents behind them.

9. **Live-test changed behavior**
   - Unit tests verify code correctness; this verifies *feature* correctness
     against the runtime the user sees. `vp run build` first.
   - For each user-visible change (CLI command, output format, flag, error
     message), run the actual command path against a real or fixture input:
     CLI change → `node dist/cli.js <subcommand> <args>` against
     `tests/integration/<example>/cdk.out` or a real state bucket, each
     output mode; state-touching change → a real / test bucket; library
     change → a minimal repro importing the new path.
   - "Tests passed" is not "feature works." If you cannot live-test, say so
     explicitly rather than skip silently — the gate exits non-zero so a
     reviewer can decide.

10. **Retrospective, residual-nit sweep, PR title + body freshness (steps
    10-12)** — read [references/wrap-up.md](references/wrap-up.md). All three
    run once, at the end. The nit sweep is where a deferral gets CLASSIFIED, so
    it gates the marker below: do not set `verify-pr` with a reviewer-flagged
    item that is neither fixed, filed, nor recorded as won't-do.

## Output

Present results as a table:

| Check | Result |
|-------|--------|
| check — typecheck + lint + format (`vp run check`) | pass/fail |
| test-project typecheck (`vp run typecheck:test`) | pass/fail |
| build | pass/fail |
| tests (N files, M tests) (`vp test run`) | pass/fail |
| test coverage for changes | pass/fail |
| CI | pass/fail |
| working tree | clean/dirty |
| docs consistency | pass/fail |
| leftover resources | none/found |
| integ-destroy marker (deletion-touching PRs only) | fresh/stale/n-a |
| integ-broad marker (cross-cutting deploy/destroy PRs only) | fresh/stale/n-a |
| integ-local marker (local-execution-touching PRs only) | fresh/stale/n-a |
| code review (incl. shared-utility callers) | pass/issues found |
| live-test changed behavior | pass/skipped/issues found |
| retrospective + rule proposals | done/skipped |
| residual review-nit sweep (fixed / TODO-issue / won't-do) | N items / 0 unhandled |
| every TODO carries `Session-fit` / `Severity` / `Effort` / `Estimate` | N classified / 0 open `now` |
| auto-close audit (no `Closes (#N)` in body) | clean / N traps fixed |
| PR title + body freshness | up-to-date/stale (updated)/n-a (no PR yet) |

If all pass, confirm "PR is ready to merge." If any fail, list the issues.

**Read `.claude/rules/session-report.md` first** — its `paths:` glob matches
only `CLAUDE.md`, which the harness injects rather than reads, so it never
auto-loads in an ordinary session.

Then add the **State** line CLAUDE.md's wrap-report rule requires. That file
gives the field semantics and is not restated here; what is specific to THIS
skill is that "ready to merge" is rarely the end of the turn. A merely
*pending* check (CI, an integ, a reviewer not back) is **WAITING** and you
merge on green — never go quiet on it; a check that legitimately cannot pass
is not WAITING at all; and **STOPPED** is only for a PR already merged, or one
whose next step the user explicitly owns.

## Final Step

After all checks pass, record THREE markers via
[markgate](https://github.com/go-to-k/markgate) — `/verify-pr` supersets
`/check` and `/check-docs`. Use `mise exec` (cdkd pins markgate via mise):

```bash
# 1. Children FIRST: `check-gate` blocks the commit below unless both are
#    fresh, and step 2 exists for runs that changed files in their scope.
mise exec -- markgate set check
mise exec -- markgate set docs

# 2. Land the changes, then 3. BIND. Every `&&`, the `||`, `--verify` and
#    `--show-toplevel` are load-bearing; hooks.md says why. Do not unchain
#    this. After a rebase the push needs `--force-with-lease`.
git add -A \
  && { git diff --cached --quiet || git commit -m "..."; } \
  && git push \
  && git rev-parse --verify HEAD \
       > "$(git rev-parse --show-toplevel)/.markgate-verify-pr-sha" \
  && mise exec -- markgate set verify-pr
```

**Anything that moves HEAD afterwards invalidates the binding, by design.**
After a rebase or force-push (which `ship.md` prescribes), repeat the BIND once
the tree is final -- still chained: the last two lines of the chain above when
the tree is UNCHANGED, the whole chain with `--force-with-lease` when there is
anything to commit. hooks.md: why it is named, not counted.

**The sentinel is the binding, `markgate verify` does not enforce it, and the
ORDER above is forced from two directions** — the marker is bound to a COMMIT,
and `check-gate` guards that commit. All of it, including why the binding is to
the local HEAD rather than the PR's, is in
[.claude/rules/hooks.md](../../rules/hooks.md) → "Two gates bind their marker to
a COMMIT" (issue [#2686](https://github.com/go-to-k/cdkd/issues/2686)). Read it
before touching either half.

The `verify-pr` marker is what `.claude/hooks/verify-pr-gate.sh` consults for
`gh pr create` / `gh pr merge`. It is settable ONLY by this skill — setting it
by hand to bypass the gate defeats the point. If a check legitimately cannot
pass right now, say so in the report and DO NOT set the marker — the gate
exits non-zero so the human can decide.

Skip the whole sequence if any check failed. (The commit/push that used to be
described here is now inside the chain above — doing it after the markers is
what invalidated the binding.)
