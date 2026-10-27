# Route53 Example

HostedZone and DNS record deployment example for cdkd.

## Resources Created

- **HostedZone** - Public hosted zone for `cdkd-test-<account>.internal`, on a reusable delegation set that `verify.sh` creates before the first deploy and deletes after destroy (`DelegationSetId`, issue #2762)
- **A Record** - Points `test.cdkd-test-<account>.internal` to `192.0.2.1` (TEST-NET-1)

Note: Creates a real hosted zone ($0.50/month if left running). Always destroy after testing.

## Demonstrates

- Route53 HostedZone creation through the SDK provider
- DNS A record management (RecordSet)
- Resource dependencies (RecordSet depends on HostedZone)
- RecordSet renames (`CDKD_TEST_RENAME`, issue #3741): a Name, a SetIdentifier and an A -> CNAME Type change each delete the old record
- `Fn::GetAtt` for outputs (HostedZoneId)
- `Fn::Join` over the list-valued HostedZone `NameServers` attribute

## Deploy

```bash
cdkd deploy Route53Stack
```

## Destroy

```bash
cdkd destroy Route53Stack
```
