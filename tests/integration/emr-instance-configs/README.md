# emr-instance-configs

Integration test for the `AWS::EMR::InstanceGroupConfig` SDK provider
(issue #1070). Both `AWS::EMR::InstanceGroupConfig` and
`AWS::EMR::InstanceFleetConfig` are `ProvisioningType: NON_PROVISIONABLE`,
so no Cloud Control fallback exists. These types add a standalone instance
group / fleet to an EXISTING cluster (referenced by `JobFlowId` /
`ClusterId`), rather than declaring it inline in `Cluster.Instances`. Built
on the L1 `emr.CfnInstanceGroupConfig` (aws-cdk-lib ships no L2).

A cluster's instance-collection type is fixed at create (groups XOR
fleets), so ONE cluster can exercise only ONE of the two new types. This
fixture covers `InstanceGroupConfig` (the CDK-default, group-based case);
the `InstanceFleetConfig` provider is structurally identical (same
create-poll / no-standalone-delete / best-effort-scale-to-0-for-TASK
design, different API) and is covered by unit tests. Keeping a single
cluster is a deliberate cost bound — an EMR cluster bills per
instance-hour.

## Resources

- `AWS::EMR::Cluster` — a master + one core node (1x `m5.xlarge` each),
  `emr-7.9.0`, in a public subnet, group-based so a standalone group can
  attach. The core node is required: EMR rejects `AddInstanceGroups` on a
  master-only job flow, so a standalone TASK group needs a cluster that already
  has a core group.
- `AWS::EMR::InstanceGroupConfig` — the resource under test: a standalone
  `TASK` group (1x `m5.xlarge`, `ON_DEMAND`) added to the cluster via
  `AddInstanceGroups`, polled to `RUNNING`.
- `AWS::EC2::VPC` — minimal network (1 AZ, public subnet only, no NAT).
- `AWS::IAM::Role` + `AWS::IAM::InstanceProfile` — the EMR service role and
  the EC2 (JobFlow) instance profile the cluster runs under.

## Phases (verify.sh)

1. **Deploy** the cluster + standalone `TASK` group. Asserts the cluster is
   `WAITING`/`RUNNING`, the group has `1` `RUNNING` instance
   (`aws emr list-instances --instance-group-id` — cdkd's provider polls the
   group to `RUNNING` before `deploy` returns), the group's `Ref` /
   `Fn::GetAtt Id` outputs both equal the AWS group id (`ig-XXXX`), and state
   routes the group via the SDK provider (`provisionedBy=sdk`). (The
   AWS-CLI-customized `aws emr list-instance-groups` is deliberately avoided —
   it fails with `[Errno 22]` in a non-interactive shell; `list-instances`
   works.)
2. **Update** (`CDKD_TEST_UPDATE=true`): resize the `TASK` group `1 -> 2`
   (`ModifyInstanceGroups`, polled to `RUNNING`). Asserts the group Id is
   unchanged (in-place, no replacement) and the group has `2` `RUNNING`
   instances.
3. **Destroy** and assert the cluster is `TERMINATED` and the VPC / state
   are gone. There is no standalone "delete instance group" API — the group
   is released when the parent cluster terminates (the provider's delete
   additionally best-effort scales a `TASK` group to 0 first). A leftover
   running EMR cluster is never acceptable (per instance-hour billing) — the
   cleanup trap disables termination protection and terminates any active
   cluster carrying the fixture's constant tag
   (`cdkd-integ=emr-instance-configs`).

## Timing

EMR cluster creation to `WAITING` takes ~5-15 minutes, adding the group a
few more, and termination a few more; expect a total wall clock of 25-45
minutes.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
