---
name: verify-pr
description: Comprehensive PR readiness check before merge. Run quality checks, tests, CI, documentation, AWS resource cleanup, and code review.
argument-hint: "[PR-number]"
---

# PR Readiness Verification

Heavy pre-merge gate. Run before creating or merging a pull request — NOT
before every commit (per-commit verification is `/check`, enforced by the
`check-gate` hook).

## Checklist

Run each check and report pass/fail:

0. **Worktree pre-flight**: `[ -d node_modules ] || pnpm install`.
   `git worktree add` does NOT copy `node_modules`, so a fresh worktree's
   typecheck/lint/build/test all fail with `tsc: command not found` etc. — and
   the failure is easy to miss when output is piped to `tail` (the exit code
   reflects `tail`). If skipping via an existing `node_modules`, spot-check
   `pnpm-lock.yaml` mtime ≤ `node_modules/.modules.yaml` mtime. Do not start
   step 1 until this passes, or every check below silently no-ops.

1. **Code quality**
   - `vp run typecheck`, `vp run lint` (`lint:fix` first if needed),
     `vp run build` all pass.
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
     PRs #548, #1104, #1231, #1416 — so do NOT re-list). Regenerate everything:
     ```bash
     # Regenerates every artifact CI guards (offline static analysis).
     vp run gen:all-matrices

     # Offline CRITIC (~0.5s), not part of the aggregate. If it fails, run
     # `vp run audit:coverage:regenerate` (heavy ~15 min, needs AWS creds with
     # cloudformation:ListTypes + DescribeType) and commit the cache —
     # /verify-pr does not auto-run :regenerate.
     vp run audit:coverage:check

     # Anything dirty here was stale before you ran the above.
     git status --short docs/ src/provisioning/property-coverage.generated.ts \
                        src/provisioning/unsupported-types.generated.ts
     ```
     Anything dirty: stage it into the PR and re-run `/check-docs`.
     `tests/unit/scripts/matrix-regen-coverage.test.ts` pins
     `gen:all-matrices` against `ci.yml`'s guards in both directions — keep
     pointing at the aggregate. (The `provider-integ-gate.sh` hook blocks a
     new `registry.register(...)` without integ coverage but does not enforce
     matrix regeneration; this step closes that gap.)

6. **Leftover resources**
   - Account: `aws sts get-caller-identity --query Account --output text`;
     `aws s3 ls s3://cdkd-state-{accountId}-us-east-1/stacks/ --region us-east-1`
     — no leftover state.
   - **For deletion-touching PRs** (changes under
     `src/provisioning/providers/**`, `src/cli/commands/destroy.ts`,
     `src/analyzer/dag-builder.ts`, etc.): the `integ-destroy` gate physically
     blocks `gh pr merge` on a stale marker. Verify it here so failures
     surface early:
     ```bash
     mise exec -- markgate verify integ-destroy
     ```
     **Read the exit code — two non-zero outcomes have opposite remedies**:
     - **exit 1** — genuinely stale (in-scope change on this branch, or the
       14d TTL expired). Run `/run-integ <relevant-test>` and confirm 0
       errors / 0 orphans; the skill sets the marker itself.
     - **exit 2** — markgate could not EVALUATE the gate (`origin/main`
       unresolvable, or no delta against the merge base). `/run-integ`
       cannot fix this — `markgate set` fails on the identical condition, so
       running one burns a real-AWS run and leaves the gate blocked. Remedy:
       `git fetch origin` (or `--unshallow`, or commit the branch's work).
     CI is necessary but not sufficient — it does not exercise real-AWS
     destroy; the gate is the structural enforcement of that fact.
   - **CROSS-CUTTING CHECK (load-bearing)**: the `integ-destroy` marker
     accepts ANY clean real-AWS destroy — a narrow feature integ flips it
     without exercising the broad deploy/destroy paths a cross-cutting change
     touches. When the PR diff touches ANY of:
     - `src/deployment/deploy-engine.ts`
     - `src/deployment/intrinsic-function-resolver.ts`
     - `src/cli/commands/destroy-runner.ts`
     - `src/cli/commands/destroy.ts`
     - `src/cli/commands/deploy.ts`
     - `src/analyzer/dag-builder.ts`
     - `src/analyzer/template-parser.ts`
     - `src/provisioning/register-providers.ts`
     - `src/deployment/retry.ts`
     - `src/deployment/retryable-errors.ts`
     - `src/deployment/rollback-executor.ts`

     ...you MUST run a **broad integ** in addition to the feature integ.
     (Both lists in this step are duplicated across several files and fenced
     against the hook by `tests/unit/scripts/cross-cutting-list-sync.test.ts`,
     so editing one copy alone fails CI.) The canonical broad set (keep in sync
     with `.claude/hooks/integ-broad-gate.sh`,
     `.claude/skills/run-integ/SKILL.md` step 11, `.markgate.yml` integ-broad
     gate, CLAUDE.md "integ-broad" entry):
     - `bench-cdk-sample` (39-resource VPC+NAT+CF+Lambda+SQS)
     - `lambda`
     - `microservices`
     - `drift-revert`
     - `drift-revert-vpc`
     - `multi-stack-deps`
     - `multi-resource`
     - `remove-protection`
     - `export`

     Cross-cutting code affects EVERY user's deploy/destroy; the broad integ
     is the only structural defense against a regression that surfaces on
     stacks unlike your fixture (the PR #348 / issue #343 incident).
     ```bash
     # Detection: only fires when the diff actually touches cross-cutting code.
     if git diff origin/main...HEAD --name-only | grep -qE '^src/deployment/(deploy-engine|intrinsic-function-resolver|retry|retryable-errors|rollback-executor)\.ts$|^src/cli/commands/(destroy-runner|destroy|deploy)\.ts$|^src/analyzer/(dag-builder|template-parser)\.ts$|^src/provisioning/register-providers\.ts$'; then
       echo "Cross-cutting code touched — broad integ required (bench-cdk-sample / lambda / microservices / drift-revert)."
       # Then run the broad integ via /run-integ and confirm 0 errors / 0 orphans.
     fi
     ```
     Both integs must pass; both refresh the same `integ-destroy` marker.
   - **For local-execution-touching PRs** (`src/local/**`,
     `src/cli/commands/local-*.ts`, `tests/integration/local-*/**`): the
     `integ-local` gate blocks the merge on a stale marker, but reads the
     LOCAL working-tree digest — merged from a parent worktree still on
     pre-PR `main`, it passes silently. `/verify-pr` runs in the PR's own
     worktree, closing that gap:
     ```bash
     if git diff origin/main...HEAD --name-only | grep -qE '^src/local/|^src/cli/commands/local-|^tests/integration/local-'; then
       mise exec -- markgate verify integ-local
     fi
     ```
     Non-zero → run `/run-integ local-<test>` matching the changed surface
     (`local-start-api` for HTTP-server / authorizer / container-pool,
     `local-invoke` for Lambda-runtime / ZIP-asset, `local-run-task` for ECS,
     `local-invoke-container` for container-Lambda, `local-invoke-layers` for
     Layers). The integ skill sets `integ-local` itself.
   - Spot-check the failure-prone types per region the PR touched (typically
     `us-east-1`): VPCs
     (`describe-vpcs --filters "Name=tag:Name,Values=Cdkd*/Vpc"`), Lambda
     hyperplane ENIs
     (`describe-network-interfaces --filters "Name=description,Values=AWS Lambda VPC ENI-*"`),
     CloudFront Distributions, NAT Gateways. Any match against a stack name in
     the diff = orphan; clean up before merge.

7. **No stale references**: grep for removed imports / old module names;
   `src/index.ts` exports consistent.

8. **Code review**
   - **First, run `/review-pr <N>`** for the size-appropriate plan: inline
     spot-check (< 300 LOC or < 5 files), 1 reviewer (300–1000 LOC), 3-axis
     parallel (≥ 1000 LOC or ≥ 10 files), plus the ADDITIVE
     `pr-security-reviewer` at ANY tier when a security surface or fix is
     involved. Trust the recommendation; override only with a concrete reason,
     noted here.
   - Synthesize the reports into a verdict; any blocker → fix-back loop.
   - **Then re-review the FIX DELTA, not just re-run the tier heuristic.**
     Fixes are code no reviewer has seen, written under the momentum of
     agreeing with a finding, landing exactly where a reviewer just proved is
     subtle (PR #2044: round 2 found round 1's fix reintroduced the first
     bug one line away, plus eight surviving mutants in branches round 1's
     fixes introduced). Scope round 2 to the delta and say the original
     design is accepted.
   - **The rule RECURSES — "review every fix round", not "the second round".**
     Keep going while the round just applied contains anything beyond prose;
     a TEST rewrite counts (PR #2420: a round-2 fix replacing a crude
     assertion with a derived one dropped a wire fact the crude form had been
     pinning by accident — only a third round found it). When a round
     REPLACES an assertion rather than adding one, KEEP BOTH unless you can
     NAME, in the commit message, the mutation the old one could not catch.
     "More precise" is not that name: precision is not a superset of what it
     replaces, and if you cannot name the mutation the replacement is a
     deletion (issue #2606: four rounds on one PR, each fix blind on a
     different axis than the assertion it dropped, every one measured green).
   - Corollary for mutation probes: **enumerate the branches the diff ADDS
     and probe each one** — a new `if`, a new token in a rendered string, a
     new early return and a new gate condition are four probes, not one.
   - `git diff origin/main...HEAD` — confirm the diff is what you reviewed.
   - For each change: correct? complete? necessary? Logic errors, dead code,
     inconsistencies between files; all callers of changed functions handle
     the new behavior; types consistent with implementation.
   - **Shared-utility regression check**: if `src/utils/**` (or another
     widely-imported module) changed, list every importer
     (`grep -rl "from '\.\./.*utils/<file>'" src tests`) and walk each one.
   - **Internal-interface contract change check**: if the diff changes the
     SEMANTICS of arguments an interface receives — even with the type
     signature unchanged — list every implementer and walk each one for
     load-bearing assumptions about the old shape (truthy gates, "absent =
     remove" semantics, JSON.parse on stringly input). PR #161's
     "drifted-only partial newProperties" design had to be reworked after
     audit found two implementers would silently clear non-drifted attrs.
     **Audit BEFORE writing tests against the new design** — discovering the
     breaks tests-after-design forces a rework and invalidates the tests.
     ```bash
     grep -rln "implements ResourceProvider" src/provisioning/providers/
     ```

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

10. **Retrospective + rules update**
    - Walk the session that produced this PR. For each surprise, friction, or
      user correction: one-off, or recurring pattern? For each pattern,
      propose where it lands: **hook** (mechanically detectable — strongest),
      **skill / marker** (a pre-action checklist), **memory** (judgmental —
      weakest). Surface the proposals before merging; write agreed
      code/skill/hook artifacts in the same PR.
    - The retrospective is itself covered by the `verify-pr` marker —
      skipping it sets the marker on incomplete work.

11. **Residual review-nit sweep** (mandatory — a multi-PR session once left
    ~9 reviewer-flagged nits unfiled at "session complete")
    - For every reviewer output this session (including re-reviews), walk the
      "Minor / Nit / Informational" section. For EACH item, confirm ONE of
      these BEFORE setting the `verify-pr` marker (same buckets as CLAUDE.md's
      Remaining-work taxonomy):
      - (a) **Fixed in this PR** — point at the fix commit / file:line.
      - (b) **TODO (issue #N)** — an issue exists AND the PR body references
        it. The issue body MUST carry the four classification lines, one
        field per line (CLAUDE.md → "The four TODO fields"), plus the
        `Dup-check:` line `/work-issues` §5-f requires:

        ```text
        Session-fit: now (do it in this session) | next (not this session) — <reason>
        Severity: high | medium | low — <what stays broken while it is undone>
        Effort: small (S) | medium (M) | large (L) — <which verification cycle it drags>
        Estimate: <duration, e.g. ~1-3 h -- never a bare letter> — <what eats the time>
        ```

        **Reviewers grade on a DIFFERENT scale — translate, do not copy**:
        `nit` → `low`, `minor` → `medium`. There is deliberately no `blocker`
        arm — a blocker is resolved by step 8's fix-back loop; one reaching
        this step means the steps ran out of order. Re-read the mapped value
        against the Severity scale: reviewer severity grades the FINDING,
        `Severity` grades what stays broken for a USER.
        **This step is the deferral moment** — the call gets made here, not
        at wrap time when the evidence is gone. A `now` item must be fixed
        before the marker is set, or re-classified with the reason recorded.
      - (c) **Won't-do (decided + recorded)** — the PR body or a comment
        names the nit and why shipping as-is is right.
    - If none holds for any nit, file a bundled follow-up issue NOW and
      reference it from the PR body. Do not set `verify-pr` until every
      reviewer-flagged item is on one of the three paths.
    - Also walk the transcript for memory-rule candidates — each written as a
      memory file (with MEMORY.md index entry) or explicitly de-prioritized.
    - **Auto-close audit**: read the PR body; for every `(#N)` parens-form
      reference adjacent to a close keyword, the merge will NOT auto-close —
      rewrite to parens-free `Closes #N` or add a manual `gh issue close <N>`
      step. (`closes-paren-form-gate.sh` already blocks the merge; this
      catches it before the attempt.)

11. **PR title + body freshness** (skip if no PR exists yet — `/create-pr`
    writes them from scratch)
    - Follow-up commits routinely stale both. **Title**: confirm it describes
      the union of commits; update via
      `gh api -X PATCH repos/{owner}/{repo}/pulls/{number} -f title="..."`
      (NOT `gh pr edit --title`, which fails silently — see
      `gh-pr-edit-deprecation-gate.sh`).
    - **Body**: if the PR has >1 commit, the initial body is almost certainly
      stale. Compare `gh pr view <PR> --json body -q .body` against the final
      diff; flag bullets describing reverted behavior or removed checks,
      dead file:line citations, wording contradicting current docs, stale
      numeric claims. If stale, rewrite and patch:
     ```bash
     cat > /tmp/pr-body.md <<'EOF'
     ## Summary
     ...
     ## Test plan
     ...
     EOF
     gh api repos/{owner}/{repo}/pulls/{number} -X PATCH --field "body=@/tmp/pr-body.md" -q '.html_url'
     ```
     (`gh pr edit --body` may fail with the Projects-classic deprecation —
     use the `gh api PATCH` form.) Verify with
     `gh pr view <PR> --json body -q .body | head -5`.

## Output

Present results as a table:

| Check | Result |
|-------|--------|
| typecheck | pass/fail |
| lint | pass/fail |
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

Then add the **State** line CLAUDE.md's wrap-report rule requires — this
report is the commonest place it is needed, because "ready to merge" is
almost never the end of the turn:

- A check merely *pending* (CI running, an integ in flight, a reviewer not
  back) is **WAITING**, not a failure and not a stop — say what you are
  waiting on, the signal that re-invokes you, and that you will merge on
  green. Do not hand over "ready to merge" and go quiet.
- A check that legitimately **cannot** pass (no AWS credentials, a
  maintainer-only decision) is not WAITING — no signal is coming. Resolve
  it, or ask through `AskUserQuestion`; never end the turn with the question
  in prose.
- Report **STOPPED** only when the PR is merged (or the user explicitly owns
  the next step) and nothing is pending.

## Final Step

After all checks pass, record THREE markers via
[markgate](https://github.com/go-to-k/markgate) — `/verify-pr` is a superset
of `/check` and `/check-docs`, so its success implies all three. Use
`mise exec` (cdkd pins markgate via mise):

```bash
mise exec -- markgate set check
mise exec -- markgate set docs
mise exec -- markgate set verify-pr
```

The `verify-pr` marker is what `.claude/hooks/verify-pr-gate.sh` consults for
`gh pr create` / `gh pr merge`. It is settable ONLY by this skill — setting it
by hand to bypass the gate defeats the point. If a check legitimately cannot
pass right now, say so in the report and DO NOT set the marker — the gate
exits non-zero so the human can decide.

Then, if there are uncommitted changes from this run (lint fixes, doc
updates), commit and push so the remote branch matches the "ready to merge"
report. Skip the marker + commit step if any check failed.
