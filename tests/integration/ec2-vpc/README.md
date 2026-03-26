# EC2/VPC Example

Minimal VPC and Security Group deployment example for cdkd.

## Resources Created

- **VPC** - Single AZ, no NAT gateways (cost saving)
- **Public Subnet** - One public subnet with /24 CIDR
- **Internet Gateway** - For public subnet internet access
- **Route Table** - Public route table with internet gateway route
- **Security Group** - Allows inbound HTTP (port 80) from anywhere

No EC2 instances are created to avoid costs.

## Demonstrates

- VPC creation with subnet configuration
- Security Group with ingress rules
- Resource dependencies (Security Group depends on VPC)
- `Fn::GetAtt` for outputs (VPC ID, Security Group ID, Subnet IDs)

## Deploy

```bash
cdkd deploy Ec2VpcStack
```

## Destroy

```bash
cdkd destroy Ec2VpcStack
```
