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
| `IsMultiRegionTrail` | **reset** | sends `false` |
| `EnableLogFileValidation` | **reset** | sends `false` |
| `IncludeGlobalServiceEvents` | **reset** | sends `false` |
| `CloudWatchLogsLogGroupArn` | retained | pass-through (parity) |
| `CloudWatchLogsRoleArn` | retained | pass-through (parity) |

Phase 1 deploys with all seven set. Phase 2 (`CDKD_TEST_REMOVAL=true`) drops
all seven and asserts BOTH halves: the five clear, the CloudWatch Logs pair
still carries its phase-1 values.

Asserting the retention is deliberate — a fixture that only checked the resets
would pass just as happily against an over-eager provider that cleared the
CloudWatch pair too, which would be a NEW divergence from CloudFormation
rather than a fix.

Two fields on the umbrella's row are deliberately absent from this fixture:
`KMSKeyId` (needs a customer-managed KMS key, whose 7-day minimum deletion
window would leave a `PendingDeletion` orphan behind every run) and
`IsOrganizationTrail` (needs an Organizations management account). Both are
left as pass-through and tracked in
[#1533](https://github.com/go-to-k/cdkd/issues/1533).

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```

Or via the skill: `/run-integ cloudtrail-trail`.
