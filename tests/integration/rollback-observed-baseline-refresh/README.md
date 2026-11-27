# rollback-observed-baseline-refresh

Integration test for [#6526](https://github.com/go-to-k/cdkd/issues/6526): when a
failed deploy's automatic rollback restores an UPDATED resource in place, the
restored state record's drift baseline (`observedProperties`) is re-read from
AWS, as an ordinary update re-captures it; and for
[#7129](https://github.com/go-to-k/cdkd/issues/7129): a resource a rollback
RE-CREATES (a reversed replacement) gets a fresh baseline too, from the
automatic rollback and from `cdkd rollback`.

## Fixture

`CdkdRollbackObservedBaseline` (`lib/rollback-observed-baseline-stack.ts`):

- v1 (default): an `s3.Bucket` named `cdkd-rb-baseline-<account>-<region>` with
  one lifecycle rule declared without an `id`
  (`lifecycleRules: [{ expiration: Duration.days(30), prefix: 'tmp/' }]`). S3
  generates the rule `ID` on every `PutBucketLifecycleConfiguration`. Also a
  PUBLIC hosted zone `cdkd-rb-baseline-<account>-<region>.internal` (a fake domain,
  never delegated: a private zone would need a VPC, and the records only have
  to exist) and a CNAME `www` with a 300 s TTL, which CDK synthesizes as the
  string `"300"`.
- v2 (`ROLLBACK_BASELINE_FAIL=true`): the rule is removed, and an
  `AWS::SQS::Queue` with `MessageRetentionPeriod: 10` (valid range
  `[60, 1209600]`) is added with a dependency on the bucket, so the bucket
  update completes before the queue's create fails. The CNAME is renamed to
  `www2` (TTL 60), a replacement the Route 53 provider runs delete-first, and
  the queue depends on it too, so the rollback re-creates `www`.

## Automated run (`verify.sh`)

Env: `AWS_REGION` (default `us-east-1`), `STATE_BUCKET` (required).

1. Deploy v1. Assert the live rule has a generated id and the state baseline
   records it; `cdkd drift` is clean.
2. Deploy v2 and assert it fails. Assert the rollback put the rule back with a
   NEW generated id (the premise; an unchanged id fails the run), no queue
   record or queue is left, and the restored record's baseline holds the new
   id.
   Assert the rollback reversed the record's replacement (the premise), the
   zone holds `www` only, and the re-created record's baseline `TTL` is the
   number 300 (before #7129 it had no baseline).
3. `cdkd drift` must exit 0. Before the fix it reported
   `LifecycleConfiguration.Rules` on the rule `Id` (#6526), or `TTL: 300 ->
   300` on the record (#7129).
4. Deploy v2 again under `--no-rollback` (assert it fails and `www2` is live),
   run `cdkd rollback --force`, and repeat the record assertions and the
   clean `cdkd drift`.
5. `cdkd destroy --force`; assert the bucket, the hosted zone and state are
   gone, then sweep the state prefix's object versions.

Run it via `/run-integ rollback-observed-baseline-refresh`.
