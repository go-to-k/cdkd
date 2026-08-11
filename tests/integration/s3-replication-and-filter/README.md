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
- `AWS::KMS::Key` (issue #1523 — the replica-side SSE-KMS key)

## Phases

1. **Deploy** the source + destination buckets (both versioning-enabled) and a
   replication role. The source rule uses `Filter.And { Prefix: 'logs/', TagFilters:
   [replicate=yes] }`. Assert `GetBucketReplication` returns the rule with
   `Filter.And.Prefix='logs/'` **and** `Filter.And.Tags` carrying `replicate=yes`
   (NOT an empty filter / replicate-all), plus the five issue #1495 read-backs
   (`TargetObjectKeyFormat`, `Destination.ReplicationTime` + `Metrics`,
   `SourceSelectionCriteria.ReplicaModifications`,
   `TransitionDefaultMinimumObjectSize`), plus the two SSE-KMS members issue
   #1523 added (`Destination.EncryptionConfiguration.ReplicaKmsKeyID` and its
   AWS-required partner `SourceSelectionCriteria.SseKmsEncryptedObjects`),
   plus a `cdkd drift` clean assertion
   (issue #1530) — the READ side of those blocks must reassemble what AWS
   returns without phantom drift, and the source bucket must be reported
   **checked + clean** by name (exit 0 alone would also pass on a
   skipped/unsupported resource).
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` — changes the `And` prefix
   `logs/` → `data/` (tag unchanged). Assert the new prefix reached AWS via an
   in-place `PutBucketReplication` (the source bucket was **not** replaced — same
   `CreationDate`) and the tag filter is still present, then `cdkd drift` clean
   again on the updated state (issue #1530).
3. **Destroy** — assert both buckets are gone, the replica KMS key is
   `PendingDeletion` (a KMS key cannot be deleted synchronously, so that IS the
   terminal state of a deleted key — not an orphan), and the cdkd state file is
   removed.

`Destination.AccessControlTranslation.Owner` stays unit-test-only and is not a
follow-up: `Owner: Destination` is an ownership **override** that only means
anything when the destination bucket is in a different account, so a
same-account fixture could not assert anything real however it were written.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 bash verify.sh
```
