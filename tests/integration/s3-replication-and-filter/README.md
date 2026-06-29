# s3-replication-and-filter

cdkd S3 replication combined-`And`-filter integration test.

An `AWS::S3::Bucket` whose `ReplicationConfiguration` rule uses a **combined
filter** — a prefix **AND** a tag. CloudFormation / CDK express this only via the
`Filter.And` operator:

```
Filter: { And: { Prefix: 'logs/', TagFilters: [{ Key: 'replicate', Value: 'yes' }] } }
```

cdkd's S3 provider previously read only top-level `Filter.Prefix` /
`Filter.TagFilter` and **never** `Filter.And`, so a combined filter silently
collapsed to an empty `Filter: {}` and replicated **every** object instead of the
prefix+tag subset — a silent scope-broadening divergence (the same class as the
lifecycle V1/V2 bug). Regression coverage for the bug found by the 2026-06-29
bug-hunt sweep.

## What it covers

- `AWS::S3::Bucket`
- `AWS::IAM::Role`

## Phases

1. **Deploy** the source + destination buckets (both versioning-enabled) and a
   replication role. The source rule uses `Filter.And { Prefix: 'logs/', TagFilters:
   [replicate=yes] }`. Assert `GetBucketReplication` returns the rule with
   `Filter.And.Prefix='logs/'` **and** `Filter.And.Tags` carrying `replicate=yes`
   (NOT an empty filter / replicate-all).
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` — changes the `And` prefix
   `logs/` → `data/` (tag unchanged). Assert the new prefix reached AWS via an
   in-place `PutBucketReplication` (the source bucket was **not** replaced — same
   `CreationDate`) and the tag filter is still present.
3. **Destroy** — assert both buckets are gone and the cdkd state file is removed.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 bash verify.sh
```
