# codebuild-project

CodeBuild Project removal-semantics fixture for cdkd (issue
[#1160](https://github.com/go-to-k/cdkd/issues/1160) codebuild batch).

## Resources

- **AWS::CodeBuild::Project** — a `NO_SOURCE` project with an inline buildspec
  (never built; the fixture only exercises the control plane).
- **AWS::IAM::Role** — the CDK L2's generated build service role, reused as the
  batch-build service role.

## What it verifies

A live CloudFormation A/B (2026-08-10) established that `UpdateProject` has
MERGE semantics — an absent field is a no-op — and that CloudFormation itself
resets exactly ONE of the eight optional fields this provider forwards:

| Field | CFn on removal | cdkd |
|---|---|---|
| `BuildBatchConfig` | **reset** (`null`) | sends the empty-object clear |
| `Description` | retained | pass-through (parity) |
| `TimeoutInMinutes` | retained | pass-through (parity) |
| `QueuedTimeoutInMinutes` | retained | pass-through (parity) |
| `ConcurrentBuildLimit` | retained | pass-through (parity) |
| `AutoRetryLimit` | retained | pass-through (parity) |
| `Cache` | retained | pass-through (parity) |
| `LogsConfig` | retained | pass-through (parity) |

Phase 1 deploys with all eight set. Phase 2 (`CDKD_TEST_REMOVAL=true`) drops
all eight from the template and asserts BOTH halves of that table: the batch
config is gone, and the other seven still carry their phase-1 values.

Asserting the retentions is deliberate — a fixture that only checked the reset
would pass just as happily against an over-eager provider that reset
everything, which would be a fresh divergence from CloudFormation rather than
a fix. A replacement guard (project ARN unchanged across the update) keeps the
reset assertion from passing for the wrong reason.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```

Or via the skill: `/run-integ codebuild-project`.
