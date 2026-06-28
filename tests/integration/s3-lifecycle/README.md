# s3-lifecycle

cdkd S3 lifecycle V1/V2 normalization integration test.

An `AWS::S3::Bucket` whose `LifecycleConfiguration` mixes a **prefix-scoped rule**
(CloudFormation emits a top-level `Prefix`, the deprecated "V1" form) with a rule
that has **no prefix and no filter** (an `AbortIncompleteMultipartUpload`-only
rule). S3 rejects a single `PutBucketLifecycleConfiguration` that mixes V1
(top-level `Prefix`) and V2 (`Filter`) rules with
`Filter element can only be used in Lifecycle V2`. CloudFormation normalizes
this transparently; cdkd must too. Regression coverage for the bug found by the
2026-06-29 bug-hunt sweep (cdkd produced a mixed payload — the prefix rule stayed
V1 while the scope-less rule got an empty `Filter` — so both CREATE and UPDATE
failed against real S3).

## What it covers

- `AWS::S3::Bucket`

## Phases

1. **Deploy** the bucket with a V1 prefix rule (`archive`, `logs/`) + a scope-less
   abort rule (`abort-mpu`). Assert both rules reached AWS, **none** carries a
   top-level `Prefix` (all normalized to V2 `Filter` form), and the `archive`
   rule's expiration is 730 days.
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` — shortens the GLACIER transition
   (90 → 60), lowers expiration (730 → 365), and adds a third **Filter-based**
   rule (`big-objects`, `ObjectSizeGreaterThan`). Assert the new values reached
   AWS, there are 3 rules, and the bucket was **not** replaced (same
   `CreationDate`).
3. **Destroy** and assert the bucket is gone and the cdkd state file is removed.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```
