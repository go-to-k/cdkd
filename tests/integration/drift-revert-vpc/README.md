# Drift Revert (VPC) E2E Test

Real-AWS end-to-end test for `cdkd drift` + `cdkd drift --revert`
against the VPC-requiring resource types whose update +
`readCurrentState` round-trips landed in the recent PR series.

Companion to `tests/integration/drift-revert/` (which covers the
no-VPC types — S3 / SNS / IAM / KMS). The mocked round-trip unit
tests catch logic bugs; this fixture catches AWS-shape divergences and
real-AWS timing flakiness that mocks miss — the comparator, the
AWS-current snapshot read, and the revert update are all exercised
against live AWS.

## What it does

1. `cdkd deploy CdkdDriftRevertVpcExample` — provisions a small
   2-AZ public-only VPC, two SGs, an EFS FileSystem + MountTarget, a
   ServiceDiscovery PrivateDnsNamespace, and an internet-facing
   Application LoadBalancer.
2. Mutate them out-of-band via direct AWS SDK calls:
   - `UpdateFileSystem` flips EFS `ThroughputMode` from `elastic` to
     `bursting`.
   - `ModifyMountTargetSecurityGroups` swaps the EFS MountTarget's
     `SecurityGroups` from `[Sg1]` to `[Sg2]`.
   - `UpdatePrivateDnsNamespace` flips the namespace's `Description`
     from `integ-original` to `integ-DRIFTED` and
     `Properties.DnsProperties.SOA.TTL` from `60` to `30`.
   - `SetSecurityGroups` swaps the ALB's `SecurityGroups` from `[Sg1]`
     to `[Sg2]`.
   - `CreateOrUpdateTags` adds an extra `Component=drift-revert-vpc-ADDED`
     tag onto the ASG (templated `Tags` carry only `Owner=cdkd-integ`).
   - `DetachLoadBalancerTargetGroups` + `AttachLoadBalancerTargetGroups`
     swap the ASG's attached target group from `tg1` to `tg2`.
3. `cdkd drift CdkdDriftRevertVpcExample` — assert exit code **1**
   (drift detected on every mutated resource).
4. `cdkd drift CdkdDriftRevertVpcExample --revert -y` — assert exit
   code **0** (revert succeeds for every drifted resource).
5. `cdkd drift CdkdDriftRevertVpcExample` again — assert exit code
   **0** (state and AWS are back in sync).
6. `cdkd destroy CdkdDriftRevertVpcExample --force` — clean up.

## Run

```bash
bash tests/integration/drift-revert-vpc/verify.sh
```

The script:

- Resolves the AWS account ID via `aws sts get-caller-identity`.
- Picks the cdkd state bucket as `cdkd-state-${accountId}` (override
  with the `STATE_BUCKET` env var).
- Builds cdkd from the repo root.
- Hard-fails with exit 1 if any assertion fails. On failure it still
  attempts a final `cdkd destroy --force` so a botched run does not
  leave AWS resources behind — VPC integ tests can otherwise leak
  hyperplane ENIs / NAT gateways.

## Resources

- `AWS::EC2::VPC` (Vpc) — 2 AZs, public-only, no NAT.
- `AWS::EC2::SecurityGroup` × 2 (Sg1 / Sg2) — Sg1 is the templated
  initial value for EFS MT and ALB; Sg2 is the swap target for
  `inject-drift.ts`.
- `AWS::EFS::FileSystem` (DriftFileSystem) — `ThroughputMode: elastic`.
  `removalPolicy: DESTROY`.
- `AWS::EFS::MountTarget` (DriftMountTarget) — `SecurityGroups: [Sg1]`.
- `AWS::ServiceDiscovery::PrivateDnsNamespace` (DriftNamespace) —
  `Description: integ-original`, `Properties.DnsProperties.SOA.TTL: 60`.
- `AWS::ElasticLoadBalancingV2::LoadBalancer` (DriftLoadBalancer) —
  Application, internet-facing, IPv4, `SecurityGroups: [Sg1]`.
- `AWS::ElasticLoadBalancingV2::TargetGroup` × 2 (DriftAsgTg1 /
  DriftAsgTg2) — port 80, `targetType: instance`. No listener
  attached; tg1 is the ASG's templated initial value and tg2 is the
  swap target for `inject-drift.ts`.
- `AWS::EC2::LaunchTemplate` (DriftAsgLt) — t3.nano + Amazon Linux
  2023. Never instantiates an instance because the ASG's capacity is 0.
- `AWS::AutoScaling::AutoScalingGroup` (DriftAsg) — `MinSize` /
  `MaxSize` / `DesiredCapacity` all `0` (zero EC2 instances ever
  launch). Templated `Tags: [{Owner=cdkd-integ}]` and
  `TargetGroupARNs: [tg1.arn]`.

The exercised provider extensions (`UpdateFileSystem` /
`ModifyMountTargetSecurityGroups` / `UpdatePrivateDnsNamespace` /
`SetSecurityGroups` / `CreateOrUpdateTags` / `DeleteTags` /
`AttachLoadBalancerTargetGroups` / `DetachLoadBalancerTargetGroups`)
are first-class via the SDK provider — `cdkd drift --revert`
exercises real AWS update calls, not the CC API fallback.

## Why subnet / IpAddressType mutations are not exercised

The ALB's `SetSubnets` and `SetIpAddressType` paths are wired in
cdkd's provider but require additional infra to exercise meaningfully:

- `SetSubnets` requires 2+ AZs with subnet swaps in different AZs (an
  ALB cannot drop below 2 subnets).
- `SetIpAddressType` to `dualstack` requires the VPC to have an IPv6
  CIDR block associated and the subnets to have IPv6 CIDRs.

Both add substantial VPC infra unrelated to the drift round-trip
under test. The unit-test coverage for those code paths is in
`tests/unit/provisioning/elbv2-roundtrip.test.ts`.
