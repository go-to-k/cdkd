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
   - the selective-mode merge preserved every unlisted sibling row (the
     state row count returns to its pre-orphan value);
   - `observedProperties` was seeded from the **live** cluster by
     `readCurrentState` — the values asserted (`StepConcurrencyLevel: 5`,
     tag `env=changed`) are the phase-2 UPDATE values, so they can only
     have come from AWS and not from the synthesized template. The
     reverse-mapped `Instances.MasterInstanceGroup.InstanceType`
     (`ListInstanceGroups` → role-keyed CFn shape) is asserted too, since
     that reverse mapping is the bulk of `readCurrentState`'s work.

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
4. **Destroy** — runs **through the re-adopted state record**, so a broken
   import surfaces here as a cluster that never terminates. Asserts the
   cluster is `TERMINATED` and the VPC / state are gone. A leftover
   running EMR cluster is never acceptable (per instance-hour billing) —
   the phase asserts `aws emr list-clusters --active` reports no cluster
   carrying the fixture's constant tag (`cdkd-integ=emr-cluster`; scoped
   by tag rather than a bare "no active clusters at all" so an unrelated
   cluster in a shared account cannot false-fail the run), and the cleanup
   trap disables termination protection and terminates any that remain.

## Timing

EMR cluster creation to `WAITING` takes ~5-15 minutes and termination a
few more; expect a total wall clock of 20-40 minutes. The import
round-trip (phase 3) adds only a handful of API calls against the
already-running cluster — about a minute, no extra instance-hours.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
