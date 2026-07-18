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
   (`ModifyCluster`), `VisibleToAllUsers` `true -> false`
   (`SetVisibleToAllUsers`), tag value change AND tag removal (`AddTags` /
   `RemoveTags`). Asserts the `ClusterId` is unchanged (in-place, no
   replacement).
3. **Destroy** and assert the cluster is `TERMINATED` and the VPC / state
   are gone. A leftover running EMR cluster is never acceptable (per
   instance-hour billing) — the cleanup trap disables termination
   protection and terminates any active cluster carrying the fixture's
   constant tag (`cdkd-integ=emr-cluster`).

## Timing

EMR cluster creation to `WAITING` takes ~5-15 minutes and termination a
few more; expect a total wall clock of 20-40 minutes.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
