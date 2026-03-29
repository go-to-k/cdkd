# WAFv2 Example

WebACL deployment example for cdkd with rate limiting rule.

## Resources Created

- **WebACL** - Regional WAFv2 Web ACL with default allow action
- **Rate Limit Rule** - IP-based rate limiting rule (2000 requests) with block action

No associated resources (ALB, API Gateway, etc.) are created to keep the example minimal.

## Demonstrates

- WAFv2 SDK Provider
- WebACL creation with visibility config
- Rate-based rules with IP aggregation
- `Fn::GetAtt` for outputs (WebACL ARN, WebACL ID)

## Deploy

```bash
cdkd deploy Wafv2Stack
```

## Destroy

```bash
cdkd destroy Wafv2Stack
```
