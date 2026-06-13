# UPDATE / Replacement Breadth Example

Broadens cdkd's real-AWS UPDATE coverage. Before this fixture only `basic`,
`dynamodb-globaltable`, and `ecs-fargate` exercised `CDKD_TEST_UPDATE`; this
stack covers BOTH cdkd update paths across several common resource types in a
single cheap deploy (no VPC / NAT / RDS).

## What it tests

The stack's `lib/` reads `CDKD_TEST_UPDATE` at synth time, so a second deploy
with the env var set synthesizes a mutated template with no code change.

### In-place `update()` (physical id unchanged)

| Resource | Type | Property changed | Path |
| --- | --- | --- | --- |
| `InPlaceBucket` | `AWS::S3::Bucket` | `VersioningConfiguration` off -> Enabled | in-place |
| `WorkerFn` | `AWS::Lambda::Function` | `Environment.STAGE` dev->prod, `MemorySize` 128->256 | in-place |
| `WorkerRole` | `AWS::IAM::Role` | inline `Policies` document gains `s3:PutObject` | in-place |
| `WorkerSg` | `AWS::EC2::SecurityGroup` | ingress rule tcp/443 from `0.0.0.0/0` added | in-place |

### Replacement (new physical id)

| Resource | Type | Property changed | Path |
| --- | --- | --- | --- |
| `ReplaceBucket` | `AWS::S3::Bucket` | `BucketName` suffix `-v1` -> `-v2` | replacement |

`BucketName` is in the S3 entry of cdkd's replacement-rules registry
(`src/analyzer/replacement-rules.ts`), so changing it forces delete + recreate
and yields a new physical id.

The `WorkerSg` uses the account's **default VPC** via `ec2.Vpc.fromLookup`, so
the stack provisions no VPC of its own.

## Verify

```bash
export STATE_BUCKET="cdkd-state-<accountId>"
export AWS_REGION="us-east-1"
bash verify.sh
```

`verify.sh`:

1. installs fixture deps + expects the cdkd binary built at `../../../dist/cli.js`.
2. **Phase 1** deploys with `CDKD_TEST_UPDATE` unset and captures each
   resource's physical id + the to-be-changed property value from AWS
   (baseline assertions confirm the pre-update state).
3. **Phase 1b** redeploys with `CDKD_TEST_UPDATE=true` and asserts, per
   resource: in-place resources keep the SAME physical id with the NEW value
   reaching AWS (`get-bucket-versioning`, `get-function-configuration`,
   `get-role-policy`, `describe-security-groups`); the replaced bucket has a
   CHANGED physical id with the old bucket gone and the new bucket present.
4. **Phase 2** destroys and asserts the state file and both buckets are gone.
5. prints `[verify] PASS` on success.
