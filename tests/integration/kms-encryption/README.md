# KMS Encryption Example

KMS key, alias and a KMS-encrypted S3 bucket for cdkd.

## Resources Created

- **EncKey** - KMS key with rotation on (90-day period) and a declared key policy
- **DisabledKey** - a disabled KMS key with rotation on (90-day period), for the removal phase
- **Alias** - `alias/cdkd-kms-test` pointing at EncKey
- **EncBucket** - S3 bucket encrypted with EncKey

Both keys use a 7-day pending-deletion window.

## Demonstrates

- KMS key rotation, alias and SSE-KMS bucket encryption
- Removing a property resets it as CloudFormation does (`verify.sh`,
  `CDKD_TEST_REMOVAL=true`, issue #1160):
  - EncKey drops `RotationPeriodInDays` and `KeyPolicy` beside a `Description`
    change: the period resets to 365 and the policy to the KMS default key policy
  - DisabledKey drops `Enabled` and `RotationPeriodInDays` together: the key is
    enabled first, then the period resets to 365

## Deploy

```bash
cdkd deploy KmsEncryptionStack
```

## Destroy

```bash
cdkd destroy KmsEncryptionStack
```
