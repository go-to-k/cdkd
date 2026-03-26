# ALB Example

Application Load Balancer deployment example for cdkd.

## Resources Created

- **VPC** - Two AZs, no NAT gateways (cost saving)
- **Public Subnets** - Two public subnets with /24 CIDR (one per AZ)
- **Internet Gateway** - For public subnet internet access
- **Route Tables** - Public route tables with internet gateway routes
- **Security Group** - Allows inbound HTTP (port 80) from anywhere
- **Application Load Balancer** - Internet-facing ALB
- **Target Group** - IP-based target group with HTTP health check
- **Listener** - HTTP listener on port 80 forwarding to target group

No EC2 instances or containers are created to avoid costs.

## Demonstrates

- ELBv2 SDK Provider (ALB, Target Group, Listener)
- VPC networking with multiple AZs
- Security Group with ingress rules
- HTTP listener with target group forwarding
- `Fn::GetAtt` for outputs (ALB DNS name, ALB ARN)

## Deploy

```bash
cdkd deploy AlbStack
```

## Destroy

```bash
cdkd destroy AlbStack
```
