# EC2 Instance Example

Minimal EC2 Instance deployment example for cdkd.

## Resources Created

- **VPC** - Single AZ, no NAT gateways (cost saving)
- **Public Subnet** - One public subnet with /24 CIDR
- **Internet Gateway** - For public subnet internet access
- **Route Table** - Public route table with internet gateway route
- **Security Group** - Allows inbound SSH (port 22) from anywhere
- **EC2 Instance** - t3.micro with Amazon Linux 2023

## Demonstrates

- EC2 Instance creation with VPC networking
- Security Group association
- Amazon Linux 2023 AMI (resolved by CDK)
- Resource dependencies (Instance depends on VPC, Subnet, SecurityGroup)
- `Fn::GetAtt` for outputs (Instance ID, Public IP, Private IP)

## Deploy

```bash
cdkd deploy Ec2InstanceStack
```

## Destroy

```bash
cdkd destroy Ec2InstanceStack
```
