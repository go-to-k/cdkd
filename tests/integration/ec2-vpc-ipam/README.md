# EC2 VPC from an IPAM pool

A VPC whose primary CIDR is allocated from an IPAM pool (`Ipv4IpamPoolId` +
`Ipv4NetmaskLength`, no `CidrBlock`), on cdkd's SDK path (issue #5633), and
a subnet whose CIDR comes from a subnet pool planning a second VPC, placed by
`AvailabilityZoneId` (issue #5632), and an IPv6-only subnet whose block comes
from an IPv6 pool planning that VPC's IPv6 block (issue #5945).

## Resources Created

- **IPAM** - Advanced tier (the free tier refuses a private-scope pool), operating in the stack's region
- **IPAM pool** - IPv4, in the IPAM's private default scope
- **IPAM pool CIDR** - `10.240.0.0/16` provisioned into the pool
- **VPC** - A `/28` allocated from the pool
- **Subnet VPC** - A second VPC with a declared `10.241.0.0/20`. A VPC whose CIDR came from a pool cannot source a planning pool: its CIDR is already allocated space in the scope
- **Planning pool** - IPv4 pool whose source resource is the subnet VPC, holding its whole CIDR
- **Subnet pool** - Carved from the planning pool (same source resource), holding `10.241.0.0/24`
- **IPv6 pool** - IPv6, in the private scope, holding the ULA range `fd00:cd:5945::/48`
- **Subnet VPC IPv6 block** - `AWS::EC2::VPCCidrBlock` (Cloud Control) giving the subnet VPC `fd00:cd:5945:100::/56` from the IPv6 pool
- **IPv6 planning pool** - Sourced from the subnet VPC AND the IPv6 pool, holding the VPC's `/56`. Without the source pool, EC2 refuses the `/56` as overlapping space already in the scope

The planning pools, the subnet pool and both subnets are deployed in a second
step, once IPAM monitors the subnet VPC's IPv4 and IPv6 blocks: EC2 refuses a
planning pool before then. The sequence follows AWS's
[subnet planning tutorial](https://docs.aws.amazon.com/vpc/latest/ipam/tutorials-subnet-planning.html).
- **Subnet** - A `/28` allocated from the subnet pool, in the zone `AvailabilityZoneId` names
- **IPv6 subnet** - IPv6-only (`Ipv6Native`), a `/64` allocated from the IPv6 planning pool (`Ipv6IpamPoolId` + `Ipv6NetmaskLength`)

## Precondition

The region must hold no IPAM: an account has one IPAM per region. `verify.sh`
checks this first and refuses to run otherwise; it never adopts or deletes an
IPAM it did not create.

## Demonstrates

- The VPC stays on the SDK provider, and its CIDR is the pool's allocation
- `Fn::GetAtt Vpc.CidrBlock` resolves to the allocated CIDR after the create
  and after an in-place update (`CDKD_TEST_UPDATE=true` tags the VPC)
- The subnet stays on the SDK provider in the named zone, its CIDR is the
  subnet pool's allocation, and `Fn::GetAtt Subnet.CidrBlock` /
  `Subnet.AvailabilityZoneId` resolve to what EC2 reports, across the same
  update
- The IPv6 subnet stays on the SDK provider, holds exactly one associated
  `/64` inside the subnet VPC's `/56`, that block is the IPv6 planning pool's
  allocation for it, and `Fn::Select` over `Fn::GetAtt Ipv6Subnet.Ipv6CidrBlocks`
  resolves to it; the update keeps the block
- `cdkd drift` reads the VPC and both subnets back clean
- Destroy waits on each subnet's pool and removes both subnets, both VPCs, the
  five pools, the scope and the IPAM

## Runtime

About 22 minutes, plus two waits measured on 2026-11-07 (us-east-1): IPAM
took 556 seconds to monitor the new subnet VPC before the planning pool could be
created (the run polls for it for up to 30 minutes and prints the lag), and the
subnet pool released the deleted subnet's allocation about 19 minutes after
`DeleteSubnet`. The destroy waits for each release: the VPC's, which AWS gives
about 18 minutes after `DeleteVpc` (once more than 25), and the subnet's. Only
then can a pool CIDR be deprovisioned; a pool CIDR delete refused while a
deleted VPC's or subnet's allocation remains waits up to 25 more minutes and
is sent again.

The destroy passes `--resource-timeout AWS::EC2::VPC=10m` (per type only), which
stops the VPC's release wait after 300 seconds. Every measured release took 18
minutes or more, so the pool CIDR delete then always meets `The CIDR has one or
more allocations.` and has to wait out the rest itself (issue #5975). The run
fails if the VPC wait did not stop at 300 seconds (the arm would prove
nothing), if the pool CIDR delete printed no wait for the VPC's allocation, or
if the destroy did not finish. The destroy takes about as long as before, about
20 minutes: 5 minutes on the VPC, the remaining ~13 on the pool CIDR, beside the
subnet's ~19-minute release.

The IPv6 arm (issue #5945) lengthens the destroy, measured by hand on
2026-11-07 (us-east-1): the IPv6 planning pool released a deleted IPv6
subnet's allocation 1523 seconds after `DeleteSubnet`, past the subnet
delete's 25-minute wait, so the IPv6 planning pool CIDR's delete waits out
the rest. Only after that can the subnet VPC go, and the IPv6 pool CIDR is
deleted after it (its pool releases a deleted VPC's block about 1006 seconds
after `DeleteVpc`, and a disassociated one 1247 seconds after the
disassociation, so a pool CIDR deleted before the VPC would meet an
allocation of a LIVE VPC, which nothing waits out). That second wait runs
after the first, so the destroy takes about 45 to 50 minutes and the whole
run about 85. Give a watchdog at least 9000 seconds: the monitoring wait is
capped at 30 minutes, each release wait at 25 (three can run back to back on
the IPv6 path), and the gone-checks after the destroy wait up to 10 more.

## Run

```bash
/run-integ ec2-vpc-ipam
```
