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

Build the repository first. CIDR comparisons require `python3` and its standard
library `ipaddress` module. The maintainer runs this fixture via `/run-integ
ec2-subnet-dns64`, with `STATE_BUCKET` and `AWS_REGION` set. It deploys real AWS
resources and has not been run as part of the local unit checks.
