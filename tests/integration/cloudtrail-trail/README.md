# cloudtrail-trail

CloudTrail Trail removal-semantics fixture for cdkd (issue
[#1160](https://github.com/go-to-k/cdkd/issues/1160) cloudtrail batch).

## Resources

- **AWS::CloudTrail::Trail** (L1 `CfnTrail`) — created with `IsLogging: false`,
  so it never delivers a log file; the fixture exercises the control plane only.
- **AWS::S3::Bucket** + bucket policy — the trail's log destination. The policy
  grants `s3:PutObject` on the whole bucket so BOTH phases work (phase 1 writes
  under the key prefix, phase 2 has the prefix reset to the root).
- **AWS::SNS::Topic** + topic policy — the trail's notification target.
- **AWS::Logs::LogGroup** + **AWS::IAM::Role** — the CloudWatch Logs delivery
  pair.

## What it verifies

A live CloudFormation A/B (2026-08-10) established that `UpdateTrail` has MERGE
semantics — an absent field is a no-op — and split the umbrella's SUSPECT row
in two:

| Field | CFn on removal | cdkd |
|---|---|---|
| `S3KeyPrefix` | **reset** | sends `''` |
| `SnsTopicName` | **reset** | sends `''` |
| `KMSKeyId` | **reset** | sends `''` |
| `IsMultiRegionTrail` | **reset** | sends `false` |
| `EnableLogFileValidation` | **reset** | sends `false` |
| `IncludeGlobalServiceEvents` | **reset** | sends `false` |
| `CloudWatchLogsLogGroupArn` | retained | pass-through (parity) |
| `CloudWatchLogsRoleArn` | retained | pass-through (parity) |

Phase 1 deploys with every optional field set. Phase 2
(`CDKD_TEST_REMOVAL=true`) drops them all and asserts BOTH halves: the six
clear, the CloudWatch Logs pair still carries its phase-1 values. It also
fails if any removal warning names the trail
([#5541](https://github.com/go-to-k/cdkd/issues/5541)): every phase-2 removal
is reset or a measured keep, so a hit means a property fell out of the
`removalHandledInUpdate` audit.

Asserting the retention is deliberate — a fixture that only checked the resets
would pass just as happily against an over-eager provider that cleared the
CloudWatch pair too, which would be a NEW divergence from CloudFormation
rather than a fix.

`KMSKeyId` joined the table in
[#1533](https://github.com/go-to-k/cdkd/issues/1533) from its own live CFn A/B
(2026-08-11). It had been deferred on the belief that its customer-managed key
would leave a `PendingDeletion` orphan behind every run — that premise was
wrong. A KMS key cannot be deleted synchronously at all (7 days is the minimum
pending window), so `PendingDeletion` IS the terminal state of a deleted key,
which the `loggroup-kms-associate` / `propagation-races-2` / `s3-vectors`
fixtures already assert as their expected post-destroy outcome. Phase 3 asserts
it here too. The A/B measured both halves separately, because "CFn resets it"
does not tell you the wire shape: CFn's removal UPDATE read back
`KmsKeyId: null`, `UpdateTrail` with the field ABSENT left the live key
attached, and `KmsKeyId: ''` was accepted and cleared it.

`IsOrganizationTrail` remains absent, and is unmeasurable here rather than
merely unmeasured: flipping it needs an Organizations management (or delegated
administrator) account, and the integ account is not in an organization at all
(`AWSOrganizationsNotInUseException`, probed 2026-08-11). It stays pass-through,
named in a deploy warning (#5541) and pinned by unit tests. Closing it needs a
different AWS account, not more fixture work.

Phases 2c-2e cover `AdvancedEventSelectors` and `AggregationConfigurations`
([#2762](https://github.com/go-to-k/cdkd/issues/2762)). Phase 2c
(`CDKD_TEST_ADVANCED=true`) adds an S3 data-event advanced selector and an
aggregation of those events, asserts the trail's state record is still
`provisionedBy: sdk` (before the fix these properties routed the trail through
Cloud Control), and runs `cdkd drift` against the templated `properties` (the
record's `observedProperties` dropped first). Phase 2d switches the trail to
basic selectors out of band, asserts `cdkd drift` reports it, and asserts
`cdkd drift --revert` restores the declared advanced selector. Phase 2e drops
both properties and asserts the trail is back on the default selector set with
no aggregation.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```

Or via the skill: `/run-integ cloudtrail-trail`.
