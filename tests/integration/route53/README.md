# Route53 Example

HostedZone and DNS record deployment example for cdkd.

## Resources Created

- **HostedZone** - Public hosted zone for `cdkd-integ-test.example.com`
- **A Record** - Points `test.cdkd-integ-test.example.com` to `192.0.2.1` (TEST-NET-1)

Note: Creates a real hosted zone ($0.50/month if left running). Always destroy after testing.

## Demonstrates

- Route53 HostedZone creation via Cloud Control API
- DNS A record management (RecordSet)
- Resource dependencies (RecordSet depends on HostedZone)
- `Fn::GetAtt` for outputs (HostedZoneId)

## Deploy

```bash
cdkd deploy Route53Stack
```

## Destroy

```bash
cdkd destroy Route53Stack
```
