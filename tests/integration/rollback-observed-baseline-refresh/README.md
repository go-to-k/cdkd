# rollback-observed-baseline-refresh

Integration test for [#6526](https://github.com/go-to-k/cdkd/issues/6526): when a
failed deploy's automatic rollback restores an UPDATED resource in place, the
restored state record's drift baseline (`observedProperties`) is re-read from
AWS, as an ordinary update re-captures it.

## Fixture

`CdkdRollbackObservedBaseline` (`lib/rollback-observed-baseline-stack.ts`):

- v1 (default): an `s3.Bucket` named `cdkd-rb-baseline-<account>-<region>` with
  one lifecycle rule declared without an `id`
  (`lifecycleRules: [{ expiration: Duration.days(30), prefix: 'tmp/' }]`). S3
  generates the rule `ID` on every `PutBucketLifecycleConfiguration`.
- v2 (`ROLLBACK_BASELINE_FAIL=true`): the rule is removed, and an
  `AWS::SQS::Queue` with `MessageRetentionPeriod: 10` (valid range
  `[60, 1209600]`) is added with a dependency on the bucket, so the bucket
  update completes before the queue's create fails.

## Automated run (`verify.sh`)

Env: `AWS_REGION` (default `us-east-1`), `STATE_BUCKET` (required).

1. Deploy v1. Assert the live rule has a generated id and the state baseline
   records it; `cdkd drift` is clean.
2. Deploy v2 and assert it fails. Assert the rollback put the rule back with a
   NEW generated id (the premise; an unchanged id fails the run), no queue
   record or queue is left, and the restored record's baseline holds the new
   id.
3. `cdkd drift` must exit 0. Before the fix it reported
   `LifecycleConfiguration.Rules` on the rule `Id`.
4. `cdkd destroy --force`; assert the bucket and state are gone, then sweep the
   state prefix's object versions.

Run it via `/run-integ rollback-observed-baseline-refresh`.
