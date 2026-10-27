# s3-object-lock

An S3 bucket with Object Lock enabled and a default GOVERNANCE retention rule —
a common compliance pattern with no prior integ coverage.

- `AWS::S3::Bucket` with `ObjectLockEnabled` + `ObjectLockConfiguration`
  (default retention GOVERNANCE)
- `AWS::S3::Bucket` (`LateFlagBucket`) whose top-level `ObjectLockEnabled` is
  turned on after creation

cdkd's S3 provider applies Object Lock via `PutObjectLockConfiguration` and
reads it back via `GetObjectLockConfiguration`.

## What it verifies

1. **Phase 1 (deploy)** — the bucket is created with Object Lock enabled and a
   GOVERNANCE default retention of 1 day.
2. **Phase 2 (UPDATE, `CDKD_TEST_UPDATE=true`)** — raising the default retention
   1 -> 5 days is an in-place `PutObjectLockConfiguration` UPDATE; the bucket is
   **not** replaced (CreationDate unchanged) and there is no phantom drift.
   Also in this phase, `LateFlagBucket` (versioned, no Object Lock in Phase 1)
   gains only the top-level `ObjectLockEnabled: true` (go-to-k/cdkd#5395). That
   flag reaches S3 only when a bucket is created, and CloudFormation finishes
   the update without enabling Object Lock. The deploy must warn about it, and
   the bucket must keep its CreationDate and still have no Object Lock.
   A second redeploy (`CDKD_TEST_SUSPEND=true`) suspends that bucket's
   versioning while the flag stays declared: the bucket has no Object Lock, so
   the suspend must reach S3.
3. **Phase 3 (destroy)** — the bucket is deleted and the cdkd state file is
   removed.

## Run

```bash
/run-integ s3-object-lock
```
