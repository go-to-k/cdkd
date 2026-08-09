# emr-instance-fleets

Integration test for the `AWS::EMR::InstanceFleetConfig` SDK provider and for
every `InstanceTypeConfigs` CFn -> SDK conversion site (issue #1400,
closing the coverage gap #1383 left behind).

`AWS::EMR::InstanceGroupConfig` and `AWS::EMR::InstanceFleetConfig` are both
`ProvisioningType: NON_PROVISIONABLE`, so no Cloud Control fallback exists.
A cluster's instance-collection type is fixed at create (groups XOR fleets),
so ONE cluster can exercise only ONE of the two. The sibling
`emr-instance-configs` fixture covers the GROUP half; this one covers the
FLEET half. Built on the L1 `emr.CfnInstanceFleetConfig` (aws-cdk-lib ships
no L2).

## Why a second EMR cluster is worth it

Issue #1383 was a send-side-looks-fine / AWS-silently-discards bug: CFn spells
the nested property bag `ConfigurationProperties` while the SDK member is
`Properties`, and the AWS SDK v3 serializer drops unknown members. A unit test
can prove cdkd *sends* the block; only a real cluster proves EMR *accepted* it.
After #1383 the fleet paths carry the same conversion the group path does, and
none of them had real-AWS proof:

- `EMRClusterProvider.toInstanceFleetConfig` — per-fleet `InstanceTypeConfigs`
  on the INLINE `Cluster.Instances.{Master,Core}InstanceFleet`
- `EMRInstanceFleetConfigProvider.create` — the STANDALONE
  `AWS::EMR::InstanceFleetConfig` (`AddInstanceFleet`)
- the same provider's `ModifyInstanceFleet` update path

All three are asserted here against AWS.

## Resources

- `AWS::EMR::Cluster` — a fleet-based cluster: a master fleet + a core fleet,
  target On-Demand capacity `1` each, `1x m5.xlarge`, `emr-7.9.0`, in a public
  subnet. Fleet clusters take `Ec2SubnetIds` (plural) — `Ec2SubnetId` is the
  instance-group form. The core fleet is required: `AddInstanceFleet` only
  accepts a TASK fleet, and EMR rejects it on a master-only job flow.
- `AWS::EMR::InstanceFleetConfig` — the resource under test: a standalone
  `TASK` fleet (target On-Demand capacity `1`, `1x m5.xlarge`) added to the
  cluster via `AddInstanceFleet`, polled until its provisioned capacity meets
  the target.
- `AWS::EC2::VPC` — minimal network (1 AZ, public subnet only, no NAT).
- `AWS::IAM::Role` + `AWS::IAM::InstanceProfile` — the EMR service role and
  the EC2 (JobFlow) instance profile the cluster runs under.

Every fleet carries a per-`InstanceTypeConfig` `Configurations` block with a
`core-site` / `cdkd.integ.marker` marker that `verify.sh` reads back.

## Phases (verify.sh)

1. **Deploy** the cluster + standalone `TASK` fleet. Asserts the cluster is
   `WAITING`/`RUNNING`, the fleet's `Ref` / `Fn::GetAtt Id` outputs both equal
   the AWS fleet id (`if-XXXX`), state routes the fleet via the SDK provider
   (`provisionedBy=sdk`), the fleet's `ProvisionedOnDemandCapacity` is `1`, and
   all three fleets' `Configurations` markers reached AWS. (The
   AWS-CLI-customized `aws emr list-instance-fleets` is deliberately avoided —
   like `list-instance-groups` it fails with `[Errno 22]` in a non-interactive
   shell; the fleets are read through `@aws-sdk/client-emr` instead, following
   `Marker` for full pagination.)
2. **Update** (`CDKD_TEST_UPDATE=true`): resize the `TASK` fleet's
   `TargetOnDemandCapacity` `1 -> 2` (`ModifyInstanceFleet`, polled until the
   provisioned capacity settles). Asserts the fleet Id is unchanged (in-place,
   no replacement) and `ProvisionedOnDemandCapacity` is `2`.
   `InstanceTypeConfigs` is deliberately identical across both phases: it IS
   mutable, but changing it here would make a failed capacity assertion
   ambiguous between the resize and the config conversion.
3. **Destroy** and assert the cluster is `TERMINATED` and the VPC / state
   are gone. There is no standalone "delete instance fleet" API — the fleet
   is released when the parent cluster terminates (the provider's delete
   additionally best-effort scales a `TASK` fleet to 0 first). A leftover
   running EMR cluster is never acceptable (per instance-hour billing) — the
   cleanup trap disables termination protection and terminates any active
   cluster carrying the fixture's constant tag
   (`cdkd-integ=emr-instance-fleets`).

## Timing

EMR cluster creation to `WAITING` takes ~5-15 minutes, adding the fleet a
few more, the resize a few more, and termination a few more; expect a total
wall clock of 25-45 minutes.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
