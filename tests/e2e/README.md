# cdkd E2E Tests

End-to-end test scripts that run a full deploy/diff/update/destroy lifecycle against a real AWS account.

## Prerequisites

- AWS credentials configured (via environment variables, profile, or IAM role)
- cdkd built (`npm run build` from project root)
- `cdkd bootstrap` run at least once for the target region

## Scripts

### `test-matrix.sh` — Run all tests

Runs all integration tests in parallel (default 4 concurrent) with per-test configuration defined in the matrix.

```bash
# Run all tests (4 parallel by default)
./tests/e2e/test-matrix.sh

# Run with 8 parallel jobs
./tests/e2e/test-matrix.sh -j 8

# Run sequentially
./tests/e2e/test-matrix.sh -j 1

# Run specific tests
./tests/e2e/test-matrix.sh basic lambda context-test

# Specific tests with custom parallelism
./tests/e2e/test-matrix.sh -j 2 alb route53 wafv2 cognito
```

### `run-e2e.sh` — Run a single test

Runs one integration test through the full lifecycle.

```bash
# Run with defaults (STATE_BUCKET auto-resolved, region=us-east-1)
./tests/e2e/run-e2e.sh ../integration/basic

# With explicit state bucket
STATE_BUCKET=my-bucket ./tests/e2e/run-e2e.sh ../integration/lambda
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `STATE_BUCKET` | No | `cdkd-state-{accountId}` (auto-resolved via STS; legacy `cdkd-state-{accountId}-{region}` still falls through with a deprecation warning) | S3 bucket for cdkd state |
| `AWS_REGION` | No | `us-east-1` | AWS region |
| `CDKD_PATH` | No | `../../dist/cli.js` | Path to cdkd CLI |
| `CDKD_UPDATE_CONTEXT` | No | - | Context args for UPDATE step (e.g., `-c env=staging`) |

## Test Steps

Each test executes 5 steps, failing fast on any error:

1. **Deploy (CREATE)** — Deploy the stack
2. **Diff after CREATE** — Verify no changes detected
3. **Deploy (UPDATE)** — Re-deploy with changes (`CDKD_TEST_UPDATE=true` or `CDKD_UPDATE_CONTEXT`)
4. **Diff after UPDATE** — Verify no changes detected
5. **Destroy** — Destroy all resources

If interrupted (Ctrl+C), cleanup destroy runs automatically.

## Test Matrix

Tests with special configuration are defined in `test-matrix.sh`:

| Test | Update Method |
|---|---|
| `context-test` | `-c env=from-cli -c featureFlag=true` |
| All others | `CDKD_TEST_UPDATE=true` (adds UpdateTest tag) |

## Troubleshooting

### "cdkd CLI not found"

```bash
npm run build
```

### "Diff unexpectedly shows changes"

Check the diff output. Some resources have non-deterministic properties.

### AWS permission errors

Ensure credentials have permissions for S3, IAM, and the resource types used in each test.
