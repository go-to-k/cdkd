# cdkd E2E Tests

End-to-end test script that runs a full deploy/diff/update/destroy lifecycle against a real AWS account.

## Prerequisites

- AWS credentials configured (via environment variables, profile, or IAM role)
- An S3 bucket for cdkd state management (created via `cdkd bootstrap` or manually)
- Node.js >= 20.0.0
- cdkd built (`npm run build` from project root)

## Setup

Make the script executable:

```bash
chmod +x tests/e2e/run-e2e.sh
```

## Usage

```bash
# Run with basic example (default)
STATE_BUCKET=my-cdkd-state-bucket ./tests/e2e/run-e2e.sh

# Run with a specific example
STATE_BUCKET=my-cdkd-state-bucket ./tests/e2e/run-e2e.sh ../integration/lambda

# With custom region
STATE_BUCKET=my-cdkd-state-bucket AWS_REGION=ap-northeast-1 ./tests/e2e/run-e2e.sh

# With custom cdkd binary path
STATE_BUCKET=my-cdkd-state-bucket CDKD_PATH=/absolute/path/to/dist/cli.js ./tests/e2e/run-e2e.sh

# Run with absolute path to example
STATE_BUCKET=my-cdkd-state-bucket ./tests/e2e/run-e2e.sh /path/to/tests/integration/lambda
```

## Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `[example-dir]` | Argument | No | `basic` | Path to integration example directory |
| `STATE_BUCKET` | Env var | Yes | - | S3 bucket name for cdkd state storage |
| `AWS_REGION` | Env var | No | `us-east-1` | AWS region to deploy resources in |
| `CDKD_PATH` | Env var | No | `../../dist/cli.js` | Path to cdkd CLI entry point |

## Test Steps

The script executes the following steps in order, failing fast on any error:

1. **Deploy (CREATE)** -- Deploys the chosen example
2. **Diff after CREATE** -- Verifies no changes are detected after a clean deploy
3. **Deploy (UPDATE)** -- Re-deploys with `CDKD_TEST_UPDATE=true` to trigger an update
4. **Diff after UPDATE** -- Verifies no changes are detected after the update
5. **Destroy** -- Destroys all resources with `--force`

## Cleanup

If the script is interrupted with Ctrl+C or receives SIGTERM, it automatically runs `cdkd destroy --force` to clean up any deployed resources before exiting.

## Troubleshooting

### "cdkd CLI not found"

Build the project first:

```bash
npm run build
```

### "STATE_BUCKET environment variable is required"

Provide the S3 bucket name:

```bash
STATE_BUCKET=your-bucket-name ./tests/e2e/run-e2e.sh
```

### "Diff unexpectedly shows changes"

This can happen if the CDK synthesis produces non-deterministic output or if the diff calculator has a bug with certain property types. Check the diff output printed to the console for details.

### AWS permission errors

Ensure your AWS credentials have permissions for:

- S3 (state bucket read/write, object deletion)
- CloudFormation/Cloud Control API (resource create/update/delete)
