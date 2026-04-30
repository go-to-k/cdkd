# cross-region-state-bucket

Integration test fixture that verifies cdkd works when the state bucket
lives in a different AWS region from the CLI's profile region.

## Background

Pre-PR-3 (`docs/plans/03-dynamic-region-resolution.md`), running
`cdkd state list --state-bucket <bucket-in-us-west-2>` from a
profile defaulting to `us-east-1` would fail with the AWS SDK v3
synthetic `UnknownError` — the SDK's region-redirect middleware does not
recover cleanly from the empty-body 301 HEAD response S3 returns when the
client's region does not match the bucket's region.

After PR 3, the state backend resolves the bucket region via
`GetBucketLocation` (a GET, not a HEAD — has a body and is not subject to
the SDK glitch) and rebuilds its S3 client for the bucket's actual region
before issuing any state operation. Provisioning clients are unaffected
and continue to use `env.region`.

## Manual run

Create a state bucket in a non-default region, then run cdkd commands
under a different default region:

```bash
# Bucket in us-west-2.
aws s3api create-bucket \
  --bucket cdkd-state-test-cross-region \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

# CLI defaults to us-east-1, but the state bucket lives in us-west-2.
AWS_REGION=us-east-1 cdkd deploy   --state-bucket cdkd-state-test-cross-region
AWS_REGION=us-east-1 cdkd state ls --state-bucket cdkd-state-test-cross-region
AWS_REGION=us-east-1 cdkd destroy  --state-bucket cdkd-state-test-cross-region

# Cleanup.
aws s3 rb s3://cdkd-state-test-cross-region --region us-west-2 --force
```

Expected: every command runs to completion. Pre-PR-3 the `state ls` /
`deploy` commands would surface `UnknownError` and abort.

## What this fixture does NOT cover

- The provisioning clients (CC API, Lambda, IAM, etc.) are still pointed
  at `env.region`. This test only exercises the state-bucket S3 client's
  region resolution.
- `/run-integ` does not invoke this fixture by default — it requires a
  pre-existing bucket in a non-default region and is therefore manual.
