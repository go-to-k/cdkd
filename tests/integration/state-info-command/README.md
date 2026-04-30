# state info Command

Integration test for the `cdkd state info` subcommand.

This stack creates a single SSM Parameter and exists only so the state bucket
has at least one state file to inspect — the test target is `cdkd state info`
itself (bucket name, region, source label, schema version, stack count).

## Resources

- **AWS::SSM::Parameter**: A single string parameter under `/cdkd-integ/state-info/`

## Deploy + verify

```bash
# Set environment variables
export STATE_BUCKET="your-cdkd-state-bucket"
export AWS_REGION="us-east-1"

# Bootstrap (first time only)
node ../../../dist/cli.js bootstrap \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Deploy the marker stack
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Default-output banner should NOT appear (PR 7 hides it).
# To see the bucket info on demand:
node ../../../dist/cli.js state info \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Machine-readable JSON form:
node ../../../dist/cli.js state info \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --json

# Source label should reflect the explicit --state-bucket flag.
```

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --force \
  CdkdStateInfoExample
```
