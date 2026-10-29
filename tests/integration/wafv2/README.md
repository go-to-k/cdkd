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
- Issue #2762: `DataProtectionConfig` and `OnSourceDDoSProtectionConfig` on the
  SDK route, read back from `GetWebACL` on create, update
  (`CDKD_TEST_WAF_UPDATE=true`) and removal (`CDKD_TEST_WAF_REMOVAL=true`).
  Two members are unit-tested only. `MonetizationConfig` needs account-level
  payment setup. For `ApplicationConfig`, AWS refuses arbitrary attribute names
  and publishes no allowed set. Measured 2026-10-30: the create was refused with
  a 400 `WAFInvalidParameterException` naming `ApplicationAttribute` on both the
  Cloud Control and SDK routes, and on three shapes sent directly with the AWS
  CLI.

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=<bucket> bash verify.sh
```

`verify.sh` deploys, asserts every phase against AWS, and destroys.
