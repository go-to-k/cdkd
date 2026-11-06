# EC2 Instance Example

Minimal EC2 Instance deployment example for cdkd.

## Resources Created

- **VPC** - Single AZ, no NAT gateways (cost saving)
- **Public Subnet** - One public subnet with /24 CIDR
- **Internet Gateway** - For public subnet internet access
- **Route Table** - Public route table with internet gateway route
- **Security Group** - Allows inbound SSH (port 22) from anywhere
- **EC2 Instance** - t3.micro with Amazon Linux 2023
- **KMS Key** - customer managed key for an EBS data volume (issue #5445)
- **IPv6 subnet** - an Amazon-provided IPv6 /56 on the VPC (`AWS::EC2::VPCCidrBlock`) and a subnet
  holding its first /64, with two t3.nano instances (issue #5630)
- **Launch template** - a t3.nano instance launched from an `AWS::EC2::LaunchTemplate`, with two
  1 GiB gp3 `AWS::EC2::Volume`s for its `Volumes` property (issue #5630)

## Demonstrates

- EC2 Instance creation with VPC networking
- Security Group association
- Amazon Linux 2023 AMI (resolved by CDK)
- Resource dependencies (Instance depends on VPC, Subnet, SecurityGroup)
- `Fn::GetAtt` for outputs (Instance ID, Public IP, Private IP)
- `EC2Provider.isSameResource` for instances (issue #4606): `verify.sh` Phase 1b runs
  `same-resource-probe.mjs` against the live instances, a terminated throwaway and
  an id that never existed
- The same read for VPC / Subnet / SecurityGroup (issue #4606): `verify.sh` Phase 1c runs
  `network-same-resource-probe.mjs` against the stack's resources, a throwaway VPC / subnet /
  security group it creates, the default VPC and never-existed ids, then the settle's delete
  of the throwaways and the reads once they are gone
- `BlockDeviceMappings` Ebs members (issue #5445): the NetworkInterfaces-shaped instance declares a
  gp3 data volume encrypted with a fixture-owned KMS key and 3500 IOPS; `verify.sh` reads the volume
  back with `DescribeVolumes` and asserts the key and the IOPS, then that destroy leaves the key
  pending deletion
- Updating an instance in place (issue #5446): `verify.sh` Phase 1h redeploys with
  `CDKD_TEST_UPDATE_5446=true`, which changes `InstanceType` (t3.micro to t3.small), moves the
  instance to a second security group and adds `UserData`. As in CloudFormation, the same instance
  is stopped, modified and started again. An SSM parameter reading `Fn::GetAtt Instance.PublicIp`
  (added in Phase 1g, `CDKD_TEST_IP_READER=true`) must follow the new public address.
- `AWS::EC2::Instance` launch options (issue #5630): `PrivateDnsNameOptions` on the main instance,
  which Phase 1h changes from `resource-name` hostnames with an A record to `ip-name` without one
  (as in CloudFormation, the same instance, with the stop the `InstanceType` change takes; an SSM
  parameter reading `Fn::GetAtt Instance.PrivateDnsName` must follow the new name). Phase 1i
  (`CDKD_TEST_DNS_5630=flag`) turns the A record on alone, in place with no stop, and Phase 1j
  (`=hostname`) changes only `HostnameType`, which stops and starts the instance on its own. And
  `Ipv6AddressCount` / `Ipv6Addresses` on the two instances in the IPv6 subnet.
- `LaunchTemplate` and `Volumes` (issue #5630): the launch-template instance declares no image or
  type of its own and must carry the template's instance tag. The `--no-wait` Phase 0 create attaches
  its volume at `/dev/sdf` (it waits for `running`, which attaching needs), and Phase 1h swaps the
  entry for the second volume at `/dev/sdg`, which, as in CloudFormation, detaches and attaches on
  the same instance. Phase 1i then moves that volume to `/dev/sdh` (a `Device` change: the same
  volume detached and re-attached). Phase 1k removes the `Volumes` property and the second volume in
  one deploy: that volume is detached from the same instance before it is deleted, and neither volume
  remains attached.
- Removing the in-place security properties (issue #1160). `verify.sh` Phase 1d redeploys with
  `CDKD_TEST_REMOVAL=true`, which drops `MetadataOptions`, `Monitoring` and `CreditSpecification`.
  As in CloudFormation, detailed monitoring is turned off and the other two keep their values.
  Phase 1e also drops `DisableApiTermination` (`CDKD_TEST_DAT=remove`). CloudFormation fails that
  update, so cdkd refuses it before any AWS call. Phase 1f declares `false` and Phase 1g declares `true` again; both are applied.

## Deploy

```bash
cdkd deploy Ec2InstanceStack
```

## Destroy

```bash
cdkd destroy Ec2InstanceStack
```
