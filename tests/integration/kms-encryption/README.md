# KMS Encryption Example

KMS key, alias and a KMS-encrypted S3 bucket for cdkd.

## Resources Created

- **EncKey** - KMS key with rotation on (90-day period) and a declared key policy
- **DisabledKey** - a disabled KMS key with rotation on (90-day period), for the removal phase
- **SpecKey** - an RSA_2048 `ENCRYPT_DECRYPT` key, for the immutable-property phase
- **LockKey** - a key with a declared policy, for the lockout-bypass phase
- **Alias** - `alias/cdkd-kms-test` pointing at EncKey
- **EncBucket** - S3 bucket encrypted with EncKey

Every key uses a 7-day pending-deletion window.

## Demonstrates

- KMS key rotation, alias and SSE-KMS bucket encryption
- Removing a property resets it as CloudFormation does (`verify.sh`,
  `CDKD_TEST_REMOVAL=true`, issue #1160):
  - EncKey drops `RotationPeriodInDays` and `KeyPolicy` beside a `Description`
    change: the period resets to 365 and the policy to the KMS default key policy
  - DisabledKey drops `Enabled` and `RotationPeriodInDays` together: the key is
    enabled first, then the period resets to 365
- Issue #5299 (`verify.sh`):
  - `CDKD_TEST_IMMUTABLE=true` changes SpecKey's `KeyUsage` beside its
    `Description`: the deploy fails with nothing applied, as CloudFormation
    fails it (KMS cannot change a key's spec, usage, region scope or origin)
  - `CDKD_TEST_BYPASS=true` gives LockKey a policy without `kms:PutKeyPolicy`
    and `BypassPolicyLockoutSafetyCheck: true`: the policy put lands

## Deploy

```bash
cdkd deploy KmsEncryptionStack
```

## Destroy

```bash
cdkd destroy KmsEncryptionStack
```
