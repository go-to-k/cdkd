---
name: run-integ
description: Run integration tests (deploy + destroy) against real AWS. Use when you need to verify cdkd works end-to-end with actual AWS resources.
argument-hint: "<test-name|all> [--synth-only] [--no-destroy]"
---

# Integration Test Runner

Run integration tests against a real AWS account: deploy actual resources,
verify, clean up.

## Arguments

- `test-name`: which test (see `ls tests/integration/`). If unspecified, ask via
  `AskUserQuestion` showing the options.
- `all`: run all tests
- `--synth-only`: synthesis only, skip deploy/destroy
- `--no-destroy`: deploy but don't destroy (debugging)
- `--deploy-args "<args>"`: forward extra args to the `cdkd deploy` invocation
  verbatim (destroy is unaffected).

## Steps

1. **Rebase, then build**: `git fetch origin` and rebase onto current
   `origin/main` (merge it when a force push is denied) BEFORE the run — a
   stale base verifies code that is not what will merge, and nothing warns you.
   Then `vp run build` so `dist/` is current.

2. **List available tests**: `ls tests/integration/` — never a hardcoded list.

3. **Determine state bucket**: account via
   `aws sts get-caller-identity --query Account --output text`, then
   `cdkd-state-{accountId}` (region-free default). If absent, fall back to the
   legacy `cdkd-state-{accountId}-us-east-1` and note the deprecation.

4. **Pre-flight orphan scan** (mandatory): a prior run killed mid-deploy leaves
   orphans matching the stack about to deploy, and cdkd's diff does not see them
   (not in state), so the deploy attempts CREATE and collides. Synth first (for
   the stack name and resource types), then scan:

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

   **Anything found → abort** with the orphan list and cleanup commands; do NOT
   deploy on top of orphans. **Except a `lock.json` whose `expiresAt` is in the
   future: a LIVE peer on the same fixture** — wait, then re-scan. Expired: a
   killed run's orphan.

5. **Run the test(s)**

   **Dispatch**: a `verify.sh` in `tests/integration/<test-name>/` owns its own
   deploy + verify + destroy cycle; the standard flow below is for plain smoke
   tests. Pre-flight (step 4) and post-run verification (steps 6 + 7) apply to
   BOTH paths.

   **CHECK FOR `verify.sh` BEFORE PICKING THE FIXTURE — the standard-flow branch
   is unreachable from an agent session**: the harness's
   auto-approval classifier refuses a direct `cdkd deploy`, so a fixture WITHOUT
   a `verify.sh` dead-ends after dispatch. (rc=127 from `bash verify.sh` means
   no such file, said on STDERR — read the log, not the rc alone.) Run the
   standard flow only when a human drives the shell.

   - `cd tests/integration/<test-name>/`; `npm install` if no `node_modules`.
   - **If `verify.sh` exists**:
     `AWS_REGION=us-east-1 STATE_BUCKET=<bucket> bash verify.sh` — the script does
     its own deploy + destroy; steps 6/7 STILL run after. Propagate its exit code
     so a non-zero exit drives the failure path; never swallow failures.
   - **Otherwise** (standard flow):
     - `node ../../../dist/cli.js synth --region us-east-1`
     - **Multi-stack apps**: if synth lists more than one stack, pass `--all` to
       deploy and destroy (otherwise they fail with `Multiple stacks found`).
     - `node ../../../dist/cli.js deploy [--all] [<extra-deploy-args>] --region us-east-1 --state-bucket <bucket> --verbose`
     - `node ../../../dist/cli.js destroy [--all] --region us-east-1 --state-bucket <bucket> --force`

   **Never run it unwatched, and do not reach for `timeout`** — it is not in
   stock macOS (its absence is exit 127 in 0s, which reads as instant
   completion), and a hung run is indistinguishable from a slow one. Shell
   watchdog, firing made visible:

   ```bash
   LOG=$(mktemp)   # assign HERE: a separate block is a separate shell, and
                   # `> ""` is a loud failure that costs you the whole run
   # Budget: 2x the ledger's last duration, floor 1500s — a fixed 1500s killed
   # dynamodb-gsi-update (normal ~1300s) mid index-busy wait.
   LAST=$(awk -F'\t' -v t="<test-name>" '$1==t{print $4}' ../../../docs/_generated/integ-last-run.tsv)
   case "$LAST" in ''|*[!0-9]*) LAST=750;; esac
   POLLS=$(( LAST * 2 / 5 )); [ "$POLLS" -lt 300 ] && POLLS=300
   # Own process group, so a FIRE kills verify's `node` deploy/destroy child too
   # (`kill -9 $VPID` alone reparents it to PID 1, still calling AWS). `perl`,
   # since zsh — the agent's shell — refuses `set -m` outside a terminal.
   perl -e 'setpgrp(0,0); exec @ARGV or die' bash verify.sh > "$LOG" 2>&1 &
   VPID=$!
   # 5s polls that end on their own: NEVER kill the watchdog — a kill orphans
   # its `sleep` to PID 1, or races it into a false WATCHDOG_FIRED.
   ( i=0; while [ $i -lt $POLLS ]; do sleep 5; kill -0 $VPID 2>/dev/null || exit 0; i=$((i+1)); done
     kill -0 $VPID 2>/dev/null && { echo "WATCHDOG_FIRED" >> "$LOG"; kill -9 -- -$VPID; } ) &
   WPID=$!
   wait "$VPID"; RC=$?
   wait "$WPID"   # at most 5s more
   grep -c WATCHDOG_FIRED "$LOG" || echo "watchdog did not fire"
   echo "verify.sh rc=$RC"   # the verdict steps 6-11 read; nothing else carries it out
   ```

   The `grep` and the `rc` line are load-bearing (`kill -9` surfaces as rc=137,
   otherwise just a crash). **Steps 6-11 are LATER calls that read this output**
   — a marker or a `PASS` ledger row chained into this same call is written
   before any verdict exists.

6. **Verify cleanup**
   - `aws s3 ls s3://<bucket>/cdkd/ --region us-east-1` — no leftover state.
   - **The state bucket is VERSIONED**, so that listing shows nothing while every
     prior version stays readable (`aws s3 rm` writes a delete marker). For a
     fixture that WRITES a secret into state (redaction / scrub / drift ones do,
     deliberately), "the object is gone" is not "the content is gone" — the
     difference is a disclosure. Check versions:
     ```bash
     # Per state/lock key the fixture touched. Non-empty = content still readable.
     aws s3api list-object-versions --bucket <bucket> --prefix "cdkd/<Stack>/<region>/state.json" \
       --query "([Versions, DeleteMarkers][])[?Key=='cdkd/<Stack>/<region>/state.json'].VersionId" \
       --output text
     ```
     If a fixture seeded a secret, grep the surviving versions for it.
   - Verify the AWS resources are gone, per stack name from synth output, for
     the types the test actually created — the per-service listing commands are
     in `/cleanup` step 4; use the same ones with this run's stack prefix.
   - FSx tests take an extra check: destroy keeps CFn parity, so
     `DeleteFileSystem` takes a chargeable FINAL BACKUP by default, and it
     usually carries NO tags, so a name scan reports clean over a live billing
     backup. Attribute by the persisted file-system id
     (`aws fsx describe-backups --region us-east-1 --query 'Backups[?FileSystem.FileSystemId==\`{fs-id}\`].[BackupId,Lifecycle]'`);
     if the run's fs ids are unknown, list ALL backups and flag any unattributed
     entry for manual review.

7. **Auto-cleanup orphans (mandatory when destroy didn't fully succeed)** —
   trigger when the destroy step reported errors, OR step 6 found leftover state
   or any resource matching the stack prefix. **Not while a PEER runs the
   fixture** (this run failed on its lock, or a `lock.json` under the prefix has
   a future `expiresAt`): the scan finds the peer's LIVE fixture, whose lock
   lapses between commands. Delete nothing until no live lock remains AND the
   prefix is unchanged for 10 minutes, then re-run step 6; what it still finds
   is an orphan, cleaned here (#3813):
   - VPC-attached Lambda failures (commonest), **in delete order**: (1)
     hyperplane ENIs (`describe-network-interfaces --filters
     "Name=vpc-id,Values=<vpc>"` → `delete-network-interface`; re-poll `in-use`
     until `available`), (2) SecurityGroups, (3) Subnets, (4) VPC.
   - S3 state orphans: `aws s3 rm s3://<bucket>/cdkd/<StackName>/ --recursive`
     (or `cdkd state orphan '<StackName>'`, which also handles the lock key).
   - Other types: infer delete order from CFn dependency rules (children before
     parents). Always pass `--region`. Re-run step 6 after cleanup.

   **Never** end the run with orphans present (a NAT GW alone is ~$1/hr). If a
   resource genuinely cannot be deleted after reasonable retries, surface it with
   the exact ID, region, and what was tried — but only after the auto-cleanup
   pass.

8. **Report results**: pass/fail per test, resource counts, timing. Always state
   "destroy completed: 0 errors, 0 orphans" or itemize what remained.

9. **Set the `integ-destroy` markgate marker (only on full clean success)** —
   destroy finished with **0 errors**, step 6 found **0 leftovers**, and step 7
   was skipped or re-checked clean. `mise trust` is UNCONDITIONAL and part of the
   pasted block: an untrusted `.mise.toml` makes `markgate set` die naming no
   cause, discarding a real-AWS run that cannot be cheaply repeated.

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

   **Read BOTH the exit code and the status line** — they fail in different
   directions. `set` exits **2** when `origin/main` is unresolvable in this
   worktree or the branch has no delta against the merge base; the remedy is
   `git fetch origin`, never re-running the integ. An untrusted `.mise.toml` is
   the other direction: `mise` writes to stderr and the rc can still read as
   success, so only `markgate status` says whether a marker exists. Run from the
   PR's own worktree on the PR branch, and if any success condition failed, do
   NOT set the marker.

   **Also set `integ-schema-migration`, and ONLY for a test named
   `schema-v<N>-to-v<N+1>-migration`**, under the same conditions. That test is
   the only proof a schema bump auto-migrates (deploy under vN, swap binary, read
   works, the next write persists vN+1, destroy clean), and
   `integ-schema-migration-gate.sh` blocks `gh pr merge` on a PR bumping the
   version constant in `src/types/state.ts` until it has run. Never set by hand.

   **The test-name condition is IN the block, not only in the sentence above
   it.** Step 9's block is unconditional, so pasting both after any clean run
   flips this marker too — the substitution the gate refuses, as one binary
   against its own schema proves no round trip. `mise trust` for step 9's reason.

   ```bash
   mise trust
   case "<test-name>" in
     schema-v*-to-v*-migration)
       mise exec -- markgate set integ-schema-migration || {
         echo "markgate set integ-schema-migration FAILED — the marker was NOT recorded." >&2
         exit 1
       }
       mise exec -- markgate status | grep integ-schema-migration \
         || echo 'NO integ-schema-migration LINE — markgate status itself failed' >&2
       ;;
     *)
       echo "not a schema-migration test — integ-schema-migration NOT set"
       ;;
   esac
   ```

10. **Post-run Docker sweep (mandatory for every `local-*` test)**, on top of
    step 6's AWS checks. A local run leaves containers and networks behind the
    way a deploy leaves AWS resources behind, and the run is not clean until all
    three listings come back empty:

    ```bash
    # All three MUST return empty, else show the orphan IDs and clean them up.
    # `-a`, not bare `docker ps`: a print-and-exit task container is already
    # `Exited` when this runs, so a running-only sweep reports clean over a
    # real orphan.
    docker ps -a --filter name=cdkd-local- --format '{{.ID}}'
    docker network ls --filter name=cdkd-local-task- --format '{{.ID}}'
    docker network ls --filter name=cdkd-local-svc- --format '{{.ID}}'
    ```

    Subnet-overlap gotcha: `cdkd local start-service` uses the FIXED subnet
    `169.254.171.0/24`, so a `local-start-*` test can fail with `Pool overlaps`
    even when all three are empty — a foreign leftover network (e.g. cdk-local's
    `cdkl-svc-*`) may own the subnet. Diagnose with
    `docker network inspect $(docker network ls -q) --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}} {{len .Containers}}'`
    and remove the holder ONLY at 0 attached containers.

    A purely local run never touches AWS, so it cannot satisfy step 9's destroy
    conditions and does not set the `integ-destroy` marker;
    `local-invoke-from-state` is the exception — it exercises a real deploy +
    destroy as well, so it both sweeps clean here AND qualifies for step 9.

11. **Record the run in the integ ledger (MANDATORY — every run, pass OR fail)**:
    `docs/_generated/integ-last-run.tsv` is a COMMITTED update-type ledger (one
    row per test) feeding `/pick-integ`. Write it on EVERY invocation, right
    after step 9 (or right after a failure).

    Columns (TAB): `test  last_run_iso  result  duration_s  flow  note`. `result`
    is `PASS` only at the same bar as step 9's marker (destroy 0 errors / 0
    orphans; verify.sh exit 0), else `FAIL`. `last_run_iso` is UTC; `flow` is
    `verify.sh` or `standard`.

    **Use an ABSOLUTE path into the feature worktree for `LEDGER`** — the
    session's Bash cwd can silently reset to the MAIN worktree, and a relative
    write then dirties the main tree on `main`. Verify with `pwd`.

    ```bash
    LEDGER="/path/to/repo/.claude/worktrees/<branch>/docs/_generated/integ-last-run.tsv"
    # The file already exists; if it does not, copy its header from git history
    # first — `>>` alone creates it headerless and the normalizer preserves
    # whatever header it finds (none).
    TEST="<test-name>"; TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    RESULT="PASS"; DUR="<seconds>"; FLOW="verify.sh"; NOTE="rc ok, orph clean"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$TEST" "$TS" "$RESULT" "$DUR" "$FLOW" "$NOTE" >> "$LEDGER"
    vp run integ-ledger-normalize
    ```

    Commit the ledger update with the branch's changes. The one-row-per-test
    invariant is CI-enforced. When two lanes recorded the SAME test, the rebase
    conflicts and keep-both leaves two rows: re-run `vp run integ-ledger-normalize`
    after any rebase touching this file **and commit the rewrite before pushing**.
    Confirm with `git status --porcelain -- docs/_generated/`, never the
    normalizer's own output.

## Choosing the fixture

Which fixture to run is a coverage judgement, not a marker lookup.

- **A cross-cutting deploy/destroy change → run a BROAD fixture.** A test is
  "broad" iff its name is one of:

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

  **Only five carry a `verify.sh`; from an agent session the other four cannot
  be run at all** (step 5's dispatch note). Runnable from a session: **`lambda`**
  (the cheap default — ~100 s over a 9-resource SQS / IAM / Lambda / LayerVersion
  / DynamoDB DAG), `drift-revert`, `drift-revert-vpc`, `remove-protection`,
  `export`. Re-derive the split with `ls tests/integration/<name>/verify.sh`;
  nothing compares the copies of this list, which `/pick-integ` and `/verify-pr`
  also carry.

  **A narrow feature fixture is NOT a substitute**: a 2-stack feature fixture
  destroys cleanly without ever reaching the broad VPC / Lambda / multi-resource
  / Custom-Resource paths a cross-cutting change can break.

- **A local-execution change → run a `local-*` fixture** and complete step 10's
  Docker sweep. A cross-cutting `src/local/` change wants at least `local-invoke`
  + `local-start-api`.

- **A state schema version bump → run the matching
  `schema-v<N>-to-v<N+1>-migration` fixture** (step 9 says what it proves).

## Important

- **Run `/review-pr` (and apply its fixes) BEFORE this skill when both are
  planned for the same PR** — the marker is digest-bound to its src scope, so a
  post-integ review fix stales it and forces a full real-AWS re-run.
- Always `--region us-east-1`; always destroy after deploy; if deploy fails,
  still attempt destroy to clean up partial state — unless it failed on a
  peer's lock (step 7).
- **A run blocked BEFORE its assertions is not a test failure — say which it
  was.** (A peer's lock — `cdkd gc` refuses on ANY stack's.) Record it as
  `FAIL` (the bar is exit-code-based) with a ledger note naming the blocker
  and any hand-removed resources, WAIT for the blocker to clear, then clean up
  what the aborted run leaked (step 7 says when). Never
  `cdkd force-unlock` a lock you did not take.
- **Never report success on a successful deploy alone** — destroy must complete
  and the orphan check must pass.
- **Do NOT restart Docker to fix a hung docker-dependent run (`local-*`, or an
  ECR asset push) — on Docker Desktop the restart IS the likelier cause**: a
  quit-and-reopen can leave the self-respawning backend up while the app serving
  the daemon's registry proxy never finishes launching. Host networking,
  container networking and the daemon's own pull path fail INDEPENDENTLY, so
  name which is down first: `curl` the registry from the HOST, `curl` it from
  inside an already-cached container (401 from both means networking is fine),
  then `docker pull hello-world`. **A pull that hangs while both curls return
  401 is NOT yet the daemon: retry it with `DOCKER_CONFIG` pointing at a
  `mktemp -d` scratch dir whose `config.json` is
  `{"auths":{"cdkd-verify.invalid":{}}}`** (never `{}`: with no auth, docker
  falls back to `osxkeychain` and a login's token outlives the dir,
  go-to-k/cdkd#3651). If that pulls, the `credsStore` helper is hung and waiting
  will not clear it — run with that override, then `rm -rf` the dir (an ECR
  login writes its token there in plaintext). Only a pull that ALSO hangs there
  is the daemon path alone: WAIT, it recovers on its own. Do not pipe the
  waiting probe through `tail`, which buffers away the progress lines. Never escalate to a factory reset or deleting Docker data
  (it destroys local images and volumes) — ask the maintainer. Clean up your own
  probes: `kill`ing a `docker pull` wrapper leaves the `com.docker.cli` child.

- **A fixture that discards the CLI's stderr cannot report its own failure.**
  `RESULT=$(${CDKD} ... 2>/dev/null | tail -1)` under `set -euo pipefail` prints
  the arm header and exits 1 with NO error text. The shape is banned and fenced
  ([../../rules/abort-capture.md](../../rules/abort-capture.md)): a failing
  invoke prints `[verify] command exited N` plus the stderr tail. A log that ends
  at an arm header with no error text means a fixture outside the fence — re-run
  that command with stderr attached BEFORE concluding anything.
- **Never bypass this skill** with direct `cdkd deploy` / `cdkd destroy` — the
  orphan-cleanup contract is part of the test, not optional.
