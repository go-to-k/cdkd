# Subnet DNS64 and IPv6 CIDR

Exercises `AWS::EC2::Subnet` on the SDK route (Refs #5632). Uses a `CfnSubnet`
depending on an Amazon-provided VPC IPv6 block. No instances, NAT gateways or
traffic are created; this checks configuration, not DNS64 packet delivery.

`verify.sh` asserts both live values and `provisionedBy=sdk`, changes the IPv6
CIDR in place, removes DNS64 while retaining its live true value, explicitly
disables DNS64, then removes IPv6 and asserts the subnet ID is unchanged and no
associated block remains. It restores both properties before destroy and checks
that the subnet, VPC and state are gone. Historical disassociated entries do not
count as live blocks. CIDRs are compared as IPv6 networks so expanded template
values and compressed EC2 readback compare equally. After initial creation and DNS64 property removal, the
fixture also runs `cdkd drift --json` and requires the Subnet to be fully compared
and clean.

Two more subnets cover the rest of the Subnet SDK backfill (#5632). `DnsSubnet`
changes `AssignIpv6AddressOnCreation` and the `PrivateDnsNameOptionsOnLaunch`
members across phases, and `verify.sh` reads each value back. The removal phase
drops both properties after they hold non-default values, and asserts the live
values stay. A `move-dns-block` phase moves `DnsSubnet`'s IPv6 block while
`AssignIpv6AddressOnCreation` stays true, with the AAAA record and DNS64 also
on; EC2 only allows the detach with all three turned off, and the phase asserts
the new block and the three values are live. `NativeSubnet` is an IPv6-only subnet (`Ipv6Native`, no IPv4
block) that must keep its ID through every phase. Every subnet must stay on the
SDK route and be drift-clean.

Three outputs read `Fn::GetAtt` on `Subnet` (#5944): `SubnetIpv6Blocks`
joins `Ipv6CidrBlocks` behind a `blocks:` prefix, and after every `check_live`
`verify.sh` requires it to name exactly the associated block (empty once IPv6
is removed), so the in-place CIDR change proves a live read. After the create
it also requires `SubnetVpcId` to be the VPC and `SubnetNaclAssociationId` to
be the subnet's live network ACL association. Before the fix each resolved to
the subnet ID.

`BlockSubnet` (#5843) never declares `Ipv6CidrBlock`. Its `cidr-block-on` phase
adds an `AWS::EC2::SubnetCidrBlock` in the same deploy that declares
auto-assign, DNS64 and the AAAA record `true`. The subnet update runs before the
block attaches, so the phase first requires cdkd's three "no IPv6 block"
warnings, then redeploys the same template and requires all three live `true`
and the subnet drift-clean. `cidr-block-off` turns them off again so the
destroy can detach the block.

Build the repository first. CIDR comparisons require `python3` and its standard
library `ipaddress` module. The maintainer runs this fixture via `/run-integ
ec2-subnet-dns64`, with `STATE_BUCKET` and `AWS_REGION` set. It deploys real AWS
resources and has not been run as part of the local unit checks.
