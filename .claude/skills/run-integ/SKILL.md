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

1. **Rebase, then build**: `git fetch origin` and rebase the branch onto
   current `origin/main` BEFORE the run — a real-AWS run against a stale base
   verifies code that is not what will merge, and nothing warns you about it.
   Then `vp run build` so `dist/` is current.

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

   **Never run it unwatched, and do not reach for `timeout`** — it is not in
   stock macOS (a Homebrew one may or may not be on PATH, and its absence is
   exit 127 in 0s, which reads as instant completion), and a hung run is
   indistinguishable from a slow one. Shell watchdog, firing made visible:

   ```bash
   LOG=$(mktemp)   # assign HERE: a separate block is a separate shell, and
                   # `> ""` is a loud failure that costs you the whole run
   bash verify.sh > "$LOG" 2>&1 &
   VPID=$!
   ( sleep 1500; kill -9 $VPID 2>/dev/null; echo "WATCHDOG_FIRED" >> "$LOG" ) &
   WPID=$!
   wait "$VPID"; RC=$?
   kill "$WPID" 2>/dev/null
   grep -c WATCHDOG_FIRED "$LOG" || echo "watchdog did not fire"
   echo "verify.sh rc=$RC"   # the verdict steps 6-11 read; nothing else carries it out
   ```

   The `grep` and the `rc` line are load-bearing (`kill -9` surfaces as
   rc=137, otherwise just a crash). **Steps 6-11 are LATER calls that read
   this output** — a marker or a `PASS` ledger row chained into this call was
   written before any verdict existed (2026-09-14, the go-to-k/cdkd#3118
   lane: a FAILED run had a marker set and `PASS` recorded in the same
   call, undone by a clean re-run).

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
   leftovers**, and step 7 was skipped or re-checked clean. `mise trust` is
   UNCONDITIONAL and is part of the pasted block rather than a caveat above
   it: an untrusted `.mise.toml` makes the `markgate set` below die
   with a config-parse error naming no cause, and here that discards a
   real-AWS run that cannot be cheaply repeated. (`/check` step 0 carries the
   full account; on an already-trusted config it is a no-op.)

   ```bash
   mise trust
   mise exec -- markgate set integ-destroy || {
     echo "markgate set integ-destroy FAILED — the marker was NOT recorded." >&2
     exit 1
   }
   # The marker, not the rc. `grep` exits 0 even for `no marker`, so it cannot
   # fail the block — ABSENCE of the line is the signal, which is what the
   # untrusted-config case produces (markgate status itself dies).
   mise exec -- markgate status | grep integ-destroy \
     || echo 'NO integ-destroy LINE — markgate status itself failed' >&2
   ```

   **Read BOTH the exit code and the status line; do not fire and forget** —
   they fail in different directions, which is why the block runs each. The
   gate runs markgate 0.4's `hash: diff` mode, where `set` exits **2** if
   `origin/main` is unresolvable in this worktree or the branch has no delta
   against the merge base — silent-looking on stdout, and caught by the `||`.
   An untrusted `.mise.toml` is the other direction: `mise` writes its error
   to stderr and the rc can still read as success, so only `markgate status`
   says whether a marker exists. Missing it means a burned real-AWS run
   and a still-blocked merge; the remedy is `git fetch origin`, never
   re-running the integ. Run from the PR's own worktree on the PR branch. If
   any success condition failed, do NOT set the marker — the
   `integ-destroy-gate.sh` hook blocking `gh pr merge` is the point.

10. **Post-run Docker sweep (mandatory for every `local-*` test)** — for any
    test name starting `local-`, on top of step 6's AWS checks. A local run
    leaves containers and networks behind exactly the way a deploy leaves AWS
    resources behind, and the run is not clean until all three listings come
    back empty:

    ```bash
    # All three MUST return empty, else show the orphan IDs and clean them up.
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

    A purely local run never touches AWS, so it cannot satisfy step 9's
    destroy conditions and does not set the `integ-destroy` marker;
    `local-invoke-from-state` is the exception — it exercises a real deploy +
    destroy as well, so it both sweeps clean here AND qualifies for step 9.

11. **Record the run in the integ ledger (MANDATORY — every run, pass OR
    fail)**: `docs/_generated/integ-last-run.tsv` is a COMMITTED update-type
    ledger (one row per test) feeding `/pick-integ`. Write it on EVERY
    invocation, right after step 9 (or right after a failure).

    Columns (TAB): `test  last_run_iso  result  duration_s  flow  note`.
    `result` is `PASS` only at the same bar as step 9's marker (destroy 0
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

## Choosing the fixture

Which fixture to run is a coverage judgement, not a marker lookup. Three
recommendations, each about what the change actually exercises:

- **A cross-cutting deploy/destroy change → run a BROAD fixture.** A test is "broad"
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
  fixture has since gained one. (Nothing compares the copies of this list any
  more — the fence that did was scoped to the retired broad gate — so a copy
  edited alone drifts silently. `/pick-integ` and `/verify-pr` carry the others.)

  **A narrow feature fixture is NOT a substitute**: a 2-stack feature fixture
  destroys cleanly without ever reaching the broad VPC / Lambda /
  multi-resource / Custom-Resource paths a cross-cutting change can break
  (the PR #348 incident).

- **A local-execution change → run a `local-*` fixture** and complete step
  10's Docker sweep. A cross-cutting `src/local/` change wants at least
  `local-invoke` + `local-start-api`.

- **A state schema version bump → run the matching
  `schema-v<N>-to-v<N+1>-migration` fixture.** A bump MUST be transparently
  auto-migrated, and only a real-AWS round-trip proves it (deploy under vN →
  swap binary → read works → next write upgrades silently → destroy clean).
  See `feedback_schema_version_migration_integ_required.md` for the checklist
  + the absolute transparent-auto-migration requirement.

## Important

- **Run `/review-pr` (and apply its fixes) BEFORE this skill when both are
  planned for the same PR** — the `integ-destroy` marker is digest-bound to its
  src scope, so a post-integ review fix stales the marker and forces a full
  real-AWS re-run (recurred on the #1282 PR).
- Always `--region us-east-1`; always destroy after deploy; if deploy fails,
  still attempt destroy to clean up partial state.
- **A run blocked BEFORE its assertions is not a test failure — say which it
  was.** (`cdkd gc` refuses while ANY stack holds a lock — account-wide, by
  design — so a parallel session's lock can stop a gc fixture before its
  first assertion; happened twice on 2026-08-19 from foreign stacks.) Record
  it as `FAIL` (the bar is exit-code-based) with a ledger note naming the
  blocker and any hand-removed AWS resources — or the next reader reads the
  merged fix as broken — clean up what the aborted run leaked, and WAIT for
  the blocker to clear.
  Never `cdkd force-unlock` a lock you did not take — it belongs to another
  session's in-flight deploy.
- **Never report success on a successful deploy alone** — destroy must
  complete and the orphan check must pass.
- **Do NOT restart Docker to fix a hung docker-dependent run (`local-*`, or
  an ECR asset push) — on Docker Desktop the restart IS the likelier cause**:
  the daemon routes registry traffic through a proxy the Desktop APP serves,
  and a quit-and-reopen can leave the
  self-respawning backend up while the app never finishes launching (four
  consecutive hung pulls; only a manual app restart recovered). Three paths
  fail INDEPENDENTLY — host networking, container networking, and the daemon's
  own pull path, which egresses differently from container traffic — so name
  which one is down before touching anything:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 https://registry-1.docker.io/v2/  # 401 = HOST networking fine
  docker run --rm --entrypoint curl <an already-cached image> -s -o /dev/null \
    -w '%{http_code}\n' --max-time 15 https://registry-1.docker.io/v2/   # 401 = CONTAINER networking fine
  docker pull hello-world                         # hangs while both 401s return = DAEMON pull path only
  docker info 2>/dev/null | grep -i proxy         # the proxy the daemon depends on
  pgrep -f 'Docker Desktop' >/dev/null && echo app-running || echo APP-NOT-RUNNING
  ```

  **On that third signature, WAIT — it recovers on its own and a restart does
  not fix it.** Measured 2026-09-05: both curls returned 401 in 0.35 s while
  every `docker pull` hung indefinitely, including an 8 KB already-cached
  image, with nothing written to `dockerd.log`; killing both
  `com.docker.backend` processes and relaunching changed nothing, and the
  daemon came back ~40 min later untouched (second instance; the first cost
  ~2 h on 2026-09-03/04 with the same signature). Say so in the report rather
  than spending the run on restarts, and do not pipe the waiting probe through
  `tail` — that buffers away the progress lines that would show it advancing.

  Ask the maintainer rather than escalating — a factory reset or deleting
  Docker data destroys local images and volumes, never yours to spend. Clean
  up your own probes (`kill`ing a `docker pull` wrapper leaves the
  `com.docker.cli` child running).
- **A fixture that discards the CLI's stderr cannot report its own failure.**
  `RESULT=$(${CDKD} ... 2>/dev/null | tail -1)` under `set -euo pipefail`
  printed the arm header and exited 1 with NO error text (2026-09-05:
  `local-invoke-agentcore`'s `verify.sh:59` rendered a pre-existing synth
  break — go-to-k/cdkd#2191 — as "the PR under review is swallowing its own
  errors"). The shape is banned and fenced since go-to-k/cdkd#3126
  (`.claude/rules/abort-capture.md`): a failing invoke now prints
  `[verify] command exited N` plus the stderr tail. A log that still ends at
  an arm header with no error text means a fixture outside the fence — re-run
  that command with stderr attached BEFORE concluding anything.
- **Never bypass this skill** with direct `cdkd deploy` / `cdkd destroy` —
  the orphan-cleanup contract is part of the test, not optional.
