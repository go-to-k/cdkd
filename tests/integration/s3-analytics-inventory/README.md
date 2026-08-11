# s3-analytics-inventory

Live coverage for the `AWS::S3::Bucket` **analytics** and **inventory**
destination blocks (issue #1493 items 2/3).

Both appliers pick between the CFn FLATTENED destination shape and the SDK
NESTED one by probing member presence. A `Destination` that is a string /
array / unresolved intrinsic used to index every probe to `undefined` and the
whole block was omitted from the Put — the configuration deployed with no
destination and no error anywhere. Nothing in the integ tree exercised either
configuration before this fixture.

- **Phase 1** — deploy; assert both configurations reached AWS carrying the
  declared destination bucket, format and prefix.
- **Phase 2** — `CDKD_TEST_UPDATE=true`; changed prefixes and inventory format.
  Runs the per-id diff path where the update-path warn callback is wired and
  asserts the readback shows the new values (i.e. the destination was updated,
  not dropped).
- **Phase 3** — destroy; assert both buckets and the state file are gone.

Only the FLATTENED shape is covered live: it is the only one a CDK template can
express. `S3BucketDestination` is the SDK spelling cdkd additionally accepts for
state records and hand-written templates, and aws-cdk-lib's L1 renderer drops a
member it does not declare — that branch is unit-covered in
`tests/unit/provisioning/s3-bucket-provider-destination-shape.test.ts`.

The report bucket carries a bucket policy allowing `s3.amazonaws.com` to write:
S3 rejects `PutBucketAnalyticsConfiguration` / `PutBucketInventoryConfiguration`
outright when the destination policy is missing, so it is part of the fixture
rather than incidental setup.

## Run

```bash
STATE_BUCKET=cdkd-state-$(aws sts get-caller-identity --query Account --output text) ./verify.sh
```
