# iam-access-key

Integration test for the `AWS::IAM::AccessKey` SDK provider (issue #1323).

The type is NON_PROVISIONABLE in the CloudFormation registry (Cloud Control
has no handlers), so it needs a dedicated SDK provider. The fixture is the
documented CDK pattern for CI credentials: an `iam.User`, an `iam.AccessKey`,
and the key's `secretAccessKey` piped into a Secrets Manager secret.

The interesting part is `SecretAccessKey`: IAM returns it ONLY from
`CreateAccessKey` (no read-back API), so the provider caches it in the state
attributes at create time and `Fn::GetAtt` resolves from that cache — and the
provider's `update()` must omit attributes so the cached value survives.

## Phases

1. **create** — deploy user + Active key + secret; assert the key is Active on
   AWS and the secret holds a resolved 40-char secret access key (no
   unresolved intrinsic).
2. **update** (`CDKD_TEST_UPDATE=true`) — flip `Status` to `Inactive` (the
   only in-place-mutable property; `UserName` / `Serial` are createOnly).
   Assert the flip landed, the physical id survived, and BOTH the Secrets
   Manager value and the state-cached `SecretAccessKey` are unchanged.
3. **destroy** — assert the user (with its key), the secret, and the state
   file are gone.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
