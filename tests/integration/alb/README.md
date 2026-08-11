# ALB Example

Application Load Balancer deployment example for cdkd.

## Resources Created

- **VPC** - Two AZs, no NAT gateways (cost saving)
- **Public Subnets** - Two public subnets with /24 CIDR (one per AZ)
- **Internet Gateway** - For public subnet internet access
- **Route Tables** - Public route tables with internet gateway routes
- **Security Group** - Allows inbound HTTP (port 80) from anywhere
- **Application Load Balancer** - Internet-facing ALB
- **Target Group** - IP-based target group with HTTP health check (baseline
  sets a custom `HealthCheckPort: 8080`; the `CDKD_TEST_REMOVAL=true` redeploy
  drops it and asserts the live TG resets to the CFn-parity default
  `traffic-port` — issue #1160 elbv2 batch). Also carries the #609 LB+TG
  silent-drop batch coverage: an explicit createOnly `IpAddressType: ipv4`, a
  `TargetGroupAttributes` list (`deregistration_delay` 45 → 60 on the
  `CDKD_TEST_UPDATE=true` redeploy, reset to the AWS default 300 when the
  removal phase drops the list), and registered IP `Targets` (10.0.0.100 →
  10.0.0.101 on update, exercising RegisterTargets + DeregisterTargets)
- **Listener** - HTTP listener on port 80 forwarding to target group

`MinimumLoadBalancerCapacity` / `EnableCapacityReservationProvisionStabilize`
are deliberately NOT exercised: the integ account lacks the LCU
capacity-reservation entitlement (`ModifyCapacityReservation` is rejected
account-wide — live-verified 2026-08-11), so those paths are unit-only.

No EC2 instances or containers are created to avoid costs. The registered IP
targets point at unused VPC addresses (registration is what is under test, not
target health).

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
