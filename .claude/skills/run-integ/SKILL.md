---
name: run-integ
description: Run integration tests (deploy + destroy) against real AWS. Use when you need to verify cdkd works end-to-end with actual AWS resources.
argument-hint: "<test-name|all> [--synth-only] [--no-destroy]"
---

# Integration Test Runner

Run integration tests against a real AWS account: deploy actual resources,
verify, clean up.

## Arguments

- `test-name`: which test (see `ls tests/integration/`). If unspecified, ask
  via `AskUserQuestion` showing the options.
- `all`: run all tests
- `--synth-only`: synthesis only, skip deploy/destroy
- `--no-destroy`: deploy but don't destroy (debugging)
- `--deploy-args "<args>"`: forward extra args to the `cdkd deploy` invocation
  verbatim (opt-in deploy flags; destroy is unaffected).

## Steps

1. **Build first**: `vp run build` so `dist/` is current.

2. **List available tests**: `ls tests/integration/` — never a hardcoded list.

3. **Determine state bucket**: account via
   `aws sts get-caller-identity --query Account --output text`, then
   `cdkd-state-{accountId}` (region-free default since PR #62). If absent,
   fall back to legacy `cdkd-state-{accountId}-us-east-1` and note the
   deprecation in the report.

4. **Pre-flight orphan scan** (mandatory — fail fast on prior-run leftovers
   instead of going through CREATE + rollback): a prior run killed mid-deploy
   leaves orphans whose names match the stack about to deploy; cdkd's diff
   does not see them (not in state), so the deploy attempts CREATE and
   collides. Synth first (to learn stack name + resource types), then scan:

   ```bash
   # Always (cheap, broadly applicable):
   aws s3 ls s3://<bucket>/cdkd/<StackName>/ --region us-east-1
   aws iam list-roles --query 'Roles[?contains(RoleName, `<StackName>`)].RoleName' --output text
   aws lambda list-functions --region us-east-1 \
     --query 'Functions[?contains(FunctionName, `<StackName>`)].FunctionName' --output text

   # When the template uses Lambda EventSourceMapping (orphan ESM = AlreadyExists + rollback):
   aws lambda list-event-source-mappings --region us-east-1 \
     --query 'EventSourceMappings[?contains(FunctionArn, `<StackName>`)].[UUID,FunctionArn]' --output text

   # When the template uses VPC + Lambda VpcConfig (hyperplane ENIs outlive the function):
   aws ec2 describe-network-interfaces --region us-east-1 \
     --filters "Name=description,Values=AWS Lambda VPC ENI-<StackName>*" \
     --query 'NetworkInterfaces[].[NetworkInterfaceId,Status]' --output text
   ```

   **Anything found → abort** with the orphan list and cleanup commands; do
   NOT deploy on top of orphans. Nothing found → proceed.

5. **Run the test(s)**:

   **Dispatch**: a `verify.sh` in `tests/integration/<test-name>/` owns its
   own deploy + verify + destroy cycle; the standard flow below is for plain
   smoke tests. Pre-flight (step 4) and post-run verification (steps 6 + 7)
   apply to BOTH paths.

   **CHECK FOR `verify.sh` BEFORE PICKING THE FIXTURE — the standard-flow
   branch is effectively unreachable from an agent session**: the harness's
   auto-approval classifier refuses a direct `cdkd deploy`, so a fixture
   WITHOUT a `verify.sh` dead-ends after dispatch. (rc=127 from
   `bash verify.sh` means the file does not exist, and bash says so on
   STDERR — if that line is missing you redirected stderr; read the log, not
   the exit code alone.) When the goal is a marker, pick a fixture that HAS a
   `verify.sh` (`ls tests/integration/<name>/verify.sh` before committing to
   the name). Run the standard flow only when a human drives the shell.

   - `cd tests/integration/<test-name>/`; `npm install` if no `node_modules`.
   - **If `verify.sh` exists**:
     `AWS_REGION=us-east-1 STATE_BUCKET=<bucket> bash verify.sh` — the script
     does its own deploy + destroy; steps 6/7 STILL run after. Propagate its
     exit code (a non-zero exit must drive the failure path so step 7 fires);
     never swallow failures. Skip the commands below.
   - **Otherwise** (standard flow):
     - `node ../../../dist/cli.js synth --region us-east-1`
     - **Multi-stack apps**: if synth lists more than one stack, pass `--all`
       to deploy and destroy (otherwise they fail with `Multiple stacks
       found`).
     - `node ../../../dist/cli.js deploy [--all] [<extra-deploy-args>] --region us-east-1 --state-bucket <bucket> --verbose`
     - `node ../../../dist/cli.js destroy [--all] --region us-east-1 --state-bucket <bucket> --force`

6. **Verify cleanup**:
   - `aws s3 ls s3://<bucket>/cdkd/ --region us-east-1` — no leftover state.
   - **The state bucket is VERSIONED**, so that listing shows nothing while
     every prior version stays readable (`aws s3 rm` writes a delete marker).
     For any fixture that WRITES a secret into state (redaction / scrub /
     drift fixtures do, deliberately), "the object is gone" is not "the
     content is gone" — the difference is a disclosure. Check versions:
     ```bash
     # Per state/lock key the fixture touched. Non-empty = content still readable.
     aws s3api list-object-versions --bucket <bucket> --prefix "cdkd/<Stack>/<region>/state.json" \
       --query "([Versions, DeleteMarkers][])[?Key=='cdkd/<Stack>/<region>/state.json'].VersionId" \
       --output text
     ```
     (Two green-run bugs of this shape shipped 2026-08-19: a version sweep
     living only in the trap the success path disarms, and a
     `printf '%s' | tr | while read` loop dropping the last field. Neither is
     visible from the script; both are obvious the moment you COUNT what S3
     holds. If a fixture seeded a secret, grep the surviving versions for
     it.)
   - Verify actual AWS resources are gone, per stack name from synth output
     (only the types relevant to the test):
     - `aws iam list-roles --query 'Roles[?contains(RoleName, \`{StackName}\`)].RoleName'`
     - `aws lambda list-functions --region us-east-1 --query 'Functions[?contains(FunctionName, \`{StackName}\`)].FunctionName'`
     - `aws s3api list-buckets --query 'Buckets[?contains(Name, \`{stackName-lowercase}\`)].Name'`
     - `aws ecr describe-repositories --region us-east-1 --query 'repositories[?contains(repositoryName, \`{stackName-lowercase}\`)].repositoryName'`
     - `aws dynamodb list-tables --region us-east-1 --query 'TableNames[?contains(@, \`{StackName}\`)]'`
     - VPC tests: `aws ec2 describe-vpcs --filters "Name=tag:Name,Values={StackName}/Vpc" ...`
     - FSx tests: **final backups** (issue #1113) — destroy keeps CFn parity,
       so `DeleteFileSystem` takes a chargeable final backup by default, and
       it usually carries NO tags, so a name scan reports clean over a live
       billing backup. Attribute by the persisted file-system id:
       `aws fsx describe-backups --region us-east-1 --query 'Backups[?FileSystem.FileSystemId==\`{fs-id}\`].[BackupId,Lifecycle]'`;
       if the run's fs ids are unknown, list ALL backups and flag any
       unattributed entry for manual review (do NOT assume clean). Delete a
       confirmed leftover with `aws fsx delete-backup --backup-id {id}`.

7. **Auto-cleanup orphans (mandatory when destroy didn't fully succeed)** —
   trigger when the destroy step reported errors, OR step 6 found leftover
   state or any resource matching the stack prefix:
   - VPC-attached Lambda failures (commonest), **in delete order**: (1)
     hyperplane ENIs (`describe-network-interfaces --filters
     "Name=vpc-id,Values=<vpc>"` → `delete-network-interface`; re-poll
     `in-use` until `available`), (2) SecurityGroups, (3) Subnets, (4) VPC.
   - S3 state orphans: `aws s3 rm s3://<bucket>/cdkd/<StackName>/ --recursive`
     (or `cdkd state orphan <StackName>`, which also handles the lock key).
   - Other types: infer delete order from CFn dependency rules (children
     before parents). Always pass `--region`. Re-run step 6 after cleanup.

   **Never** end the run with orphans present (NAT GW alone is ~$1/hr). If a
   resource genuinely cannot be deleted after reasonable retries, surface it
   with the exact ID, region, and what was tried — but only after the
   auto-cleanup pass.

8. **Report results**: pass/fail per test, resource counts, timing. Always
   state "destroy completed: 0 errors, 0 orphans" or itemize what remained.

9. **Set the `integ-destroy` markgate marker (only on full clean success)** —
   when the destroy step finished with **0 errors**, step 6 found **0
   leftovers**, and step 7 was skipped or re-checked clean:

   ```bash
   mise exec -- markgate set integ-destroy || {
     echo "markgate set integ-destroy FAILED — the marker was NOT recorded." >&2
     exit 1
   }
   ```

   **Check the exit code; do not fire and forget.** The gate runs markgate
   0.4's `hash: diff` mode, where `set` exits **2** if `origin/main` is
   unresolvable in this worktree or the branch has no delta against the merge
   base — silent-looking on stdout. Missing it means a burned real-AWS run
   and a still-blocked merge; the remedy is `git fetch origin`, never
   re-running the integ. Run from the PR's own worktree on the PR branch. If
   any success condition failed, do NOT set the marker — the
   `integ-destroy-gate.sh` hook blocking `gh pr merge` is the point.

10. **Set the `integ-local` markgate marker (only for `local-*` tests, on
    full clean success)** — for any test name starting `local-`. Required
    cleanup verification BEFORE setting it (in addition to step 9's
    conditions):

    ```bash
    # All three MUST return empty, else show the orphan IDs and do not set.
    # `-a`, not bare `docker ps`: a print-and-exit task container is already
    # `Exited` when this runs, so a running-only sweep reports clean over a
    # real orphan (caught twice in a row while gating #2183).
    docker ps -a --filter name=cdkd-local- --format '{{.ID}}'
    docker network ls --filter name=cdkd-local-task- --format '{{.ID}}'
    docker network ls --filter name=cdkd-local-svc- --format '{{.ID}}'
    ```

    Subnet-overlap gotcha: `cdkd local start-service` uses the FIXED subnet
    `169.254.171.0/24`, so a `local-start-*` test can fail with `Pool
    overlaps` even when all three are empty — a foreign leftover network
    (e.g. cdk-local's `cdkl-svc-*`) may own the subnet. Diagnose with
    `docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}} {{len .Containers}}'`
    and remove the holder ONLY at 0 attached containers.

    When clean: `mise exec -- markgate set integ-local`. Same 14d TTL and
    same no-bypass rule as `integ-destroy`. The two are independent: a
    `lambda` run does not refresh `integ-local`, and a `local-invoke` run
    does not refresh `integ-destroy` — except `local-invoke-from-state`,
    which exercises a real deploy + destroy and can set BOTH.

11. **Set the `integ-broad` markgate marker (only for BROAD integ tests, on
    full clean success)**: A test is "broad"
    iff its name is one of:

    ```text
    bench-cdk-sample
    lambda
    microservices
    drift-revert
    drift-revert-vpc
    multi-stack-deps
    multi-resource
    remove-protection
    export
    ```

    **Only FIVE of the nine carry a `verify.sh`; from an agent session the
    other four cannot be run at all** (step 5's dispatch note). Runnable from
    a session: **`lambda`**, `drift-revert`, `drift-revert-vpc`,
    `remove-protection`, `export`. Human-driven shell only:
    `bench-cdk-sample`, `microservices`, `multi-stack-deps`,
    `multi-resource`. `lambda` is the cheap default — ~100 s, 9-resource DAG
    across SQS / IAM / Lambda / LayerVersion / DynamoDB Table + GlobalTable.
    Re-derive the split with `ls tests/integration/<name>/verify.sh` if a
    fixture has since gained one. (All seven copies of this list are compared
    by `tests/unit/scripts/cross-cutting-list-sync.test.ts`.)

    When the test name is in the broad set AND the destroy finished cleanly
    (same conditions as `integ-destroy`), ALSO record the sentinel and flip
    the marker:

    ```bash
    # Sentinel content is informational; the integ-broad gate's include scope
    # is just this file, so writing the test name flips its digest naturally.
    printf '%s ran at %s\n' "<test-name>" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > .markgate-broad-integ-test
    mise exec -- markgate set integ-broad
    ```

    `integ-broad-gate.sh` blocks `gh pr merge` for PRs touching
    cross-cutting deploy/destroy code (the hook's `CROSS_CUTTING_REGEX`).
    Same 14d TTL, same no-bypass rule. **Narrow feature integs do NOT set
    this marker** — a 2-stack feature fixture flips `integ-destroy` but a
    cross-cutting change needs the broad VPC / Lambda / multi-resource
    coverage (the PR #348 incident's structural fix).

12. **Set the `integ-schema-migration` markgate marker (only for
    `schema-v*-to-v*-migration` tests, on full clean success)**: a schema
    version bump MUST be transparently auto-migrated and verified by a
    real-AWS round-trip (deploy under vN → swap binary → read works → next
    write upgrades silently → destroy clean). A test qualifies iff its name
    matches `schema-v<N>-to-v<N+1>-migration`. When it does AND the destroy
    finished cleanly:

    ```bash
    mise exec -- markgate set integ-schema-migration
    ```

    `integ-schema-migration-gate.sh` blocks `gh pr merge` for any PR bumping
    the `StackState.version` literal in `src/types/state.ts` (precise
    `gh pr diff` grep — non-bump edits pass). Same 14d TTL, same no-bypass
    rule. Non-migration tests do NOT set it. See
    `feedback_schema_version_migration_integ_required.md` for the checklist +
    the absolute transparent-auto-migration requirement.

13. **Record the run in the integ ledger (MANDATORY — every run, pass OR
    fail)**: `docs/_generated/integ-last-run.tsv` is a COMMITTED update-type
    ledger (one row per test) feeding `/pick-integ`. Write it on EVERY
    invocation, right after the marker steps (or right after a failure).

    Columns (TAB): `test  last_run_iso  result  duration_s  flow  note`.
    `result` is `PASS` only at the same bar as the markers (destroy 0
    errors / 0 orphans; verify.sh exit 0), else `FAIL`. `last_run_iso` is
    UTC; `flow` is `verify.sh` or `standard`.

    **Use an ABSOLUTE path into the feature worktree for `LEDGER`** — the
    session's Bash cwd can silently reset to the MAIN worktree (observed
    right after a background integ completes), and a relative write then
    dirties the main tree on `main`. Verify with `pwd` or hardcode the path.

    ```bash
    LEDGER="/path/to/repo/.claude/worktrees/<branch>/docs/_generated/integ-last-run.tsv"
    # Bootstrap the header if absent — `>>` alone would create it headerless
    # and the normalizer preserves whatever header it finds (none).
    [ -f "$LEDGER" ] || printf '%b\n' \
      '# integ-last-run ledger (update-type: one row per test). cols: test\tlast_run_iso\tresult\tduration_s\tflow\tnote' \
      '# INVARIANT: exactly one row per test, rows sorted by test name. Duplicates break' \
      '# /pick-integ staleness ranking; the sort is what makes a rebased commit reproduce this' \
      '# file byte-for-byte instead of appending a duplicate row (issue #1112).' \
      '# GENERATED SHAPE - do not hand-edit. After recording a run, run:' \
      '#   vp run integ-ledger-normalize' \
      '# CI enforces this; a non-normalized file fails check-build-test.' > "$LEDGER"
    TEST="<test-name>"; TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    RESULT="PASS"; DUR="<seconds>"; FLOW="verify.sh"; NOTE="rc ok, orph clean"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$TEST" "$TS" "$RESULT" "$DUR" "$FLOW" "$NOTE" >> "$LEDGER"
    vp run integ-ledger-normalize
    ```

    Commit the ledger update with the branch's changes. The one-row-per-test
    invariant is CI-enforced (issue #1112). When two lanes recorded the SAME
    test, the rebase conflicts and keep-both leaves two rows: re-run
    `vp run integ-ledger-normalize` after any rebase touching this file
    **and commit the rewrite before pushing** (measured: normalizer run after
    the push, output never committed, PR red). Confirm with
    `git status --porcelain -- docs/_generated/`, never the normalizer's own
    output.

## Important

- **Run `/review-pr` (and apply its fixes) BEFORE this skill when both are
  planned for the same PR** — the integ markers are digest-bound to their src
  scopes, so a post-integ review fix stales the marker and forces a full
  real-AWS re-run (recurred on the #1282 PR).
- Always `--region us-east-1`; always destroy after deploy; if deploy fails,
  still attempt destroy to clean up partial state.
- **A run blocked BEFORE its assertions is not a test failure — say which it
  was.** (`cdkd gc` refuses while ANY stack holds a lock — account-wide, by
  design — so a parallel session's lock can stop a gc fixture before its
  first assertion; happened twice on 2026-08-19 from foreign stacks.) Record
  it as `FAIL` (the bar is exit-code-based) with a note naming the blocker,
  clean up what the aborted run leaked, and WAIT for the blocker to clear.
  Never `cdkd force-unlock` a lock you did not take — it belongs to another
  session's in-flight deploy.
- **Never report success on a successful deploy alone** — destroy must
  complete and the orphan check must pass.
- **Never bypass this skill** with direct `cdkd deploy` / `cdkd destroy` —
  the orphan-cleanup contract is part of the test, not optional.
