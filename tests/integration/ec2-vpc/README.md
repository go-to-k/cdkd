# EC2/VPC Example

Minimal VPC and Security Group deployment example for cdkd.

## Resources Created

- **VPC** - Single AZ, no NAT gateways (cost saving)
- **Public Subnet** - One public subnet with /24 CIDR
- **Internet Gateway** - For public subnet internet access
- **Route Table** - Public route table with internet gateway route
- **Security Group** - Allows inbound HTTP (port 80) from anywhere
- **Second VPC** - A bare VPC with DNS support off, for the removal phase
- **Private hosted zone** - Associated with the main VPC, for the removal phase
- **Two tenancy VPCs** - Bare VPCs (dedicated, default) whose `InstanceTenancy` the removal phase changes

No EC2 instances are created to avoid costs.

## Demonstrates

- VPC creation with subnet configuration
- Security Group with ingress rules
- Resource dependencies (Security Group depends on VPC)
- `Fn::GetAtt` for outputs (VPC ID, Security Group ID, Subnet IDs)
- Removing `EnableDnsHostnames` / `EnableDnsSupport` resets them to the VPC
  default, as CloudFormation does (`verify.sh`, `CDKD_TEST_REMOVAL=true`, issue #1160)
- Removing a private hosted zone's `VPCs` keeps every association, as
  CloudFormation does, and warns once (same phase, issue #1160)
- Changing and removing a tag on the Internet Gateway, the public Route Table
  and the custom Network ACL updates each in place (same phase, issue #5448)
- Removing `InstanceTenancy` from a dedicated VPC changes it to `default` in
  place, and `default` -> `dedicated` replaces the VPC, as CloudFormation does
  (same phase, issue #5449)

## Deploy

```bash
cdkd deploy Ec2VpcStack
```

## Destroy

```bash
cdkd destroy Ec2VpcStack
```
