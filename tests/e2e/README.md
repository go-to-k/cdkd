# cdkq E2E Tests

End-to-end test script that runs a full deploy/diff/update/destroy lifecycle against a real AWS account.

## Prerequisites

- AWS credentials configured (via environment variables, profile, or IAM role)
- An S3 bucket for cdkq state management (created via `cdkq bootstrap` or manually)
- Node.js >= 20.0.0
- cdkq built (`npm run build` from project root)

## Setup

Make the script executable:

```bash
chmod +x tests/e2e/run-e2e.sh
```

## Usage

```bash
# Minimal (required: STATE_BUCKET)
STATE_BUCKET=my-cdkq-state-bucket ./tests/e2e/run-e2e.sh

# With custom region
STATE_BUCKET=my-cdkq-state-bucket AWS_REGION=ap-northeast-1 ./tests/e2e/run-e2e.sh

# With custom cdkq binary path
STATE_BUCKET=my-cdkq-state-bucket CDKQ_PATH=/absolute/path/to/dist/cli.js ./tests/e2e/run-e2e.sh
```

## Parameters

| Environment Variable | Required | Default | Description |
|---|---|---|---|
| `STATE_BUCKET` | Yes | - | S3 bucket name for cdkq state storage |
| `AWS_REGION` | No | `us-east-1` | AWS region to deploy resources in |
| `CDKQ_PATH` | No | `../../dist/cli.js` | Path to cdkq CLI entry point (relative to script or absolute) |

## Test Steps

The script executes the following steps in order, failing fast on any error:

1. **Deploy (CREATE)** -- Deploys the basic example (S3 bucket with tags)
2. **Diff after CREATE** -- Verifies no changes are detected after a clean deploy
3. **Deploy (UPDATE)** -- Re-deploys with `CDKQ_TEST_UPDATE=true` to add an `UpdateTest` tag
4. **Diff after UPDATE** -- Verifies no changes are detected after the update
5. **Destroy** -- Destroys all resources with `--force`
6. **Verify clean state** -- Confirms the state file has been removed from S3

## What Gets Deployed

The test uses the `basic` integration example (`tests/integration/examples/basic/`), which creates:

- One S3 bucket with `RemovalPolicy.DESTROY`
- Tags: `Environment=Test`, `Project=cdkq` (and `UpdateTest=true` during the update step)
- Stack name: `CdkqBasicExample`

## Cleanup

If the script is interrupted with Ctrl+C or receives SIGTERM, it automatically runs `cdkq destroy --force` to clean up any deployed resources before exiting.

## Troubleshooting

### "cdkq CLI not found"

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
- CloudFormation/Cloud Control API (S3 bucket create/update/delete)
