# emr-cluster

Integration test for the `AWS::EMR::Cluster` SDK provider (issue #1043).
The type is `ProvisioningType: NON_PROVISIONABLE`, so no Cloud Control
fallback exists — this fixture is the end-to-end proof of the SDK
provider, built on the L1 `emr.CfnCluster` (aws-cdk-lib ships no L2 for
EMR clusters).

## Resources

- `AWS::EMR::Cluster` — smallest / cheapest legal shape: a single master
  node (1x `m5.xlarge`, no core/task), `emr-7.9.0`, in a public subnet.
  Billed per instance-hour — the fixture bounds wall clock to one
  create/update/destroy cycle, sets an `AutoTerminationPolicy` idle-timeout
  of 1 hour as a worst-case orphan cap, and `verify.sh` asserts the cluster
  is `TERMINATED` afterwards (by id AND with no active cluster carrying the
  fixture tag).
- `AWS::EC2::VPC` — minimal network (1 AZ, public subnet only, no NAT).
- `AWS::IAM::Role` + `AWS::IAM::InstanceProfile` — the EMR service role and
  the EC2 (JobFlow) instance profile the cluster runs under.

## Phases (verify.sh)

1. **Deploy** the baseline cluster and assert via
   `aws emr describe-cluster` that it is `WAITING`/`RUNNING` with the
   templated config (`StepConcurrencyLevel: 1`, `VisibleToAllUsers: true`),
   that the `MasterPublicDNS` output (`Fn::GetAtt`) matches the AWS-side
   value, and that state routes the resource via the SDK provider
   (`provisionedBy=sdk`).
2. **Update** (`CDKD_TEST_UPDATE=true`): `StepConcurrencyLevel` `1 -> 5`
   (`ModifyCluster`), `AutoTerminationPolicy.IdleTimeout` `3600 -> 7200`
   (`PutAutoTerminationPolicy`), tag value change AND tag removal (`AddTags`
   / `RemoveTags`). Asserts the `ClusterId` is unchanged (in-place, no
   replacement). (`VisibleToAllUsers` is deliberately not exercised — AWS
   deprecated it, so `SetVisibleToAllUsers(false)` is a no-op; the provider
   still issues the call and its unit tests cover the mapping.)
3. **Import round-trip** (issue #1090, follow-up to PR #1080 which added
   the provider's `import()` / `readCurrentState()`). `cdkd orphan
   CdkdEmrClusterExample/Cluster` drops ONLY the cluster row from cdkd
   state — AWS is untouched, and the phase asserts the cluster is still
   `WAITING`/`RUNNING` afterwards. `cdkd import CdkdEmrClusterExample
   --resource <logicalId>=<clusterId>` then re-adopts it. Asserts:
   - the re-adopted row carries the same `physicalId`, `resourceType`
     (`AWS::EMR::Cluster`) and `provisionedBy` (`sdk`);
   - `attributes` were persisted from the provider's `import()` return
     value (`Id` and `MasterPublicDNS`, both read from `DescribeCluster`)
     and match the live cluster. This became assertable only with PR
     #1099 / issue #1098 — before that, `import` discarded every
     provider's `attributes`, a gap this fixture's first draft surfaced;
   - the selective-mode merge preserved the unlisted sibling rows. The
     row count returning to its pre-orphan value is necessary but **not
     sufficient** — `buildStackState` merges by shallow spread, so a bug
     that corrupts a surviving row keeps the count intact. The phase also
     pins one witness sibling (the VPC row) and asserts its `physicalId`
     and full `properties` are byte-identical across the round-trip;
   - `observedProperties` was seeded from the **live** cluster by
     `readCurrentState`.

   **How the `observedProperties` check is made discriminating.** The
   phase-3 synth deliberately runs **without** `CDKD_TEST_UPDATE`, so the
   template says `StepConcurrencyLevel: 1` / `env=test` / `dropme=yes`
   while the live cluster is at `5` / `changed` / no-`dropme` after phase
   2. A bug that seeded `observedProperties` from the template rather
   than from AWS therefore **fails**. Under `CDKD_TEST_UPDATE=true` the
   two are byte-identical and the same assertions would pass either way,
   testing nothing — an earlier revision of this fixture had exactly that
   hole. The phase pins the divergence explicitly by *also* asserting
   `properties.StepConcurrencyLevel == 1`, so re-adding
   `CDKD_TEST_UPDATE` here breaks loudly instead of silently hollowing
   out the phase. `VisibleToAllUsers` is asserted as a structurally
   AWS-only field: it appears in neither synth mode (verified against
   `cdk.out`) but `DescribeCluster` always reports it.

   `ReleaseLabel` and `Instances.MasterInstanceGroup.InstanceType` are
   identical in template and AWS, so they are *shape* assertions, not
   discriminating ones — they check the `ListInstanceGroups` → role-keyed
   CFn reverse mapping, which is the bulk of `readCurrentState`'s work.

   **Why this extends `emr-cluster` rather than a dedicated `emr-import`
   fixture**: the round-trip needs a live cluster, and a separate fixture
   would launch a second one (another 5-15 min and another block of
   `m5.xlarge` instance-hours) plus duplicate the VPC / IAM / managed-SG
   scaffolding. Reusing the cluster this fixture already has running costs
   ~1 extra minute and zero extra instance-hours.

   **Why per-resource `cdkd orphan` and not whole-stack `cdkd state
   orphan`**: `cdkd deploy` does not propagate `aws:cdk:path` as an AWS
   tag (AWS reserves the `aws:` prefix), so whole-stack **auto** import
   cannot re-adopt the VPC / IAM / SG rows — they would stay out of state
   and leak on destroy. Dropping only the cluster keeps the destroy path
   complete and additionally exercises the selective merge.

   **What this phase does and does not cover.** It covers the
   explicit-`--resource` half of `EMRClusterProvider.import()`, the
   `attributes` persistence, and all of `readCurrentState` (including the
   instance-group reverse mapping). The `aws:cdk:path` tag-walk half that
   used to sit alongside it was **deleted** in issue #1134 — that path
   keyed on a tag `cdkd deploy` never emits (AWS reserves the `aws:`
   prefix), so it could never match and was structurally unreachable from
   any cdkd integ. `import()` now resolves only from `--resource` or a
   same-named CloudFormation stack (issue #1128 / #1130). Also uncovered:
   `buildAttributes` for clusters that report no DNS, CORE/TASK instance
   group bucketing, and the `INSTANCE_FLEET` branch of
   `reverseInstancesToCfn` — this fixture is master-only, on purpose, for
   cost.
4. **Destroy** — runs **through the re-adopted state record**, so a broken
   import surfaces here as a cluster that never terminates. Asserts the
   cluster is `TERMINATED` and the VPC / state are gone. A leftover
   running EMR cluster is never acceptable (per instance-hour billing) —
   the phase asserts `aws emr list-clusters --active` reports no cluster
   carrying the fixture's constant tag (`cdkd-integ=emr-cluster`; scoped
   by tag rather than a bare "no active clusters at all" so an unrelated
   cluster in a shared account cannot false-fail the run), and the cleanup
   trap disables termination protection and terminates any that remain.

## Cleanup invariants

Two properties of `verify.sh` are load-bearing and easy to break by
"tidying":

- **The tag-scoped cluster sweep in `cleanup()` must run BEFORE `cdkd
  state destroy`.** Phase 3 deliberately opens a window (between `cdkd
  orphan` and `cdkd import`) where the cluster is live in AWS but absent
  from cdkd state. Nothing state-driven can clean it up there — only the
  sweep, which finds the cluster by name + tag. With `state destroy`
  first, an interrupted run leaves it to skip the untracked cluster and
  then block indefinitely on `delete-vpc`, because the running cluster's
  EC2 instances / ENIs hold the subnets, while the cluster keeps billing.
  (Observed live: an interrupted run wedged there for 18+ minutes.)
- **`INT` / `TERM` have their own handlers that exit explicitly**
  (`trap 'cleanup; exit 130' INT`). A bare `trap cleanup INT` would run
  cleanup and then *return to the interrupted point*, letting the script
  resume and potentially exit 0 — reporting PASS for a killed run.

- **An AWS API failure is never read as a definitive answer.** This bit
  the fixture repeatedly, in several shapes: a throttled `emr
  list-clusters` printing nothing and reading as "nothing leaked"; `if
  aws s3api head-object ... >/dev/null 2>&1` reading any error as "state
  file removed"; `wait_cluster_terminated` treating an unreadable state
  as `TERMINATED`. Every probe now distinguishes *gone* from *could not
  tell* and hard-fails as undetermined. There is deliberately no
  best-effort `cluster_state` helper any more — in assertion position
  `X="$(probe ...)"` aborts at the assignment under `set -e`, so the
  `FAIL` branch never prints; callers use `&& rc=0 || rc=$?` instead.
- **Teardown failures preserve evidence.** If `state destroy` fails or a
  cluster's termination cannot be confirmed, cleanup skips the VPC sweep
  (its deletes would fail against live ENIs anyway) and **keeps**
  `state.json` — there is no IAM-role sweep here, so that file is the
  only record of what leaked. Both paths print a loud warning.

## Timing

EMR cluster creation to `WAITING` takes ~5-15 minutes and termination a
few more; expect a total wall clock of 20-40 minutes. The import
round-trip (phase 3) adds only a handful of API calls against the
already-running cluster — about a minute, no extra instance-hours.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
