# state info Command

Integration test for the `cdkd state info` subcommand.

This stack creates a single SSM Parameter and exists only so the state bucket
has at least one state file to inspect — the test target is `cdkd state info`
itself (bucket name, region, source label, schema version, stack count).

Note two `state info` quirks this fixture deliberately encodes (issue #1335):

- `state info` has **no `--region` flag** — the bucket's region is
  auto-detected via `GetBucketLocation`. Passing `--region` fails with
  commander's `unknown option` error.
- The bucket comes from `--state-bucket` or the `CDKD_STATE_BUCKET` env var
  (or cdk.json context). The `STATE_BUCKET` env name used across the integ
  suite is a test-suite convention only — the CLI does not read it. This
  fixture's `cdk.json` pins `context.cdkd.stateBucket = "cdkd-state-test"`
  so the test proves both real sources override it.

## Resources

- **AWS::SSM::Parameter**: A single string parameter under `/cdkd-integ/state-info/`

## Run

```bash
# From this directory — deploys, runs `state info` (human + --json, flag +
# env bucket sources), destroys, and asserts state + parameter cleanup:
AWS_REGION=us-east-1 STATE_BUCKET="your-cdkd-state-bucket" bash verify.sh
```

## Manual commands

```bash
export STATE_BUCKET="your-cdkd-state-bucket"
export AWS_REGION="us-east-1"

# Deploy the marker stack
node ../../../dist/cli.js deploy \
  --app "node bin/app.ts" \
  --state-bucket ${STATE_BUCKET}

# Default-output banner should NOT appear (PR 7 hides it).
# To see the bucket info on demand (NO --region flag — see note above):
node ../../../dist/cli.js state info --state-bucket ${STATE_BUCKET}

# Machine-readable JSON form, bucket via env instead of the flag:
CDKD_STATE_BUCKET=${STATE_BUCKET} node ../../../dist/cli.js state info --json

# Source label should reflect the bucket source (cli-flag / env).
```

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --state-bucket ${STATE_BUCKET} \
  --force \
  CdkdStateInfoExample
```
