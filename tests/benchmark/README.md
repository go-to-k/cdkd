# cdkd Benchmark

Scripts for comparing deploy speed between cdkd and AWS CDK (CloudFormation).

## Scenarios

| Scenario | Resources | Purpose |
| --- | --- | --- |
| `bench-sdk` | S3 / DynamoDB / SQS / SNS / SSM Parameter (5, independent) | All resources are served by cdkd's native SDK providers. Pure SDK vs CloudFormation comparison. |
| `bench-ccapi` | SSM Document × 3 + Athena WorkGroup × 2 (5, independent) | No SDK provider registered — all resources fall through to Cloud Control API. Exercises the fallback path. |
| `basic` | S3 Bucket + SSM Document (legacy) | Kept for backward compatibility. |

All resources are independent within each scenario, so cdkd's DAG scheduler can provision them fully in parallel.

## Measured phases

- **Synthesis** — CDK app → template (`cdkd synth` / `cdk synth`)
- **Deploy** — end-to-end deploy time (synthesis + asset publishing + resource provisioning)
- **Total** — sum of the above

## Prerequisites

- AWS credentials configured
- Node.js >= 20.0.0
- cdkd built (`pnpm run build`)
- `cdk` CLI installed for the CloudFormation side (`npm install -g aws-cdk`)

## Usage

```bash
# bench-sdk scenario (default)
./tests/benchmark/run-benchmark.sh

# bench-ccapi scenario
./tests/benchmark/run-benchmark.sh bench-ccapi

# Run both sequentially
./tests/benchmark/run-benchmark.sh all

# Legacy scenario
./tests/benchmark/run-benchmark.sh basic
```

### Run only one side

```bash
SKIP_CFN=true  ./tests/benchmark/run-benchmark.sh bench-sdk
SKIP_CDKD=true ./tests/benchmark/run-benchmark.sh bench-sdk
```

### Override the region

```bash
AWS_REGION=ap-northeast-1 ./tests/benchmark/run-benchmark.sh bench-sdk
```

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `STATE_BUCKET` | S3 bucket for cdkd state | auto-resolved (`cdkd-state-{accountId}-{region}`) |
| `AWS_REGION` | AWS region | `us-east-1` |
| `CDKD_BIN` | Path to the cdkd binary | `./dist/cli.js` |
| `SKIP_CFN` | Set to `true` to skip the CloudFormation benchmark | `false` |
| `SKIP_CDKD` | Set to `true` to skip the cdkd benchmark | `false` |
| `RUNS` | Number of runs (last result is used) | `1` |

## Example output

```text
## Benchmark Results: bench-sdk (5 resources, SDK providers only)

| Phase          | cdkd    | CloudFormation | Speedup |
|----------------|---------|----------------|---------|
| Synthesis      | 4.2s    | 4.2s           | 1.0x    |
| Deploy (total) | 8.5s    | 62.3s          | 7.3x    |
| Total          | 12.7s   | 66.5s          | 5.2x    |
```

Each run also writes `tests/benchmark/results-YYYYMMDD-HHMMSS.md` (with `all`, both scenarios are appended to the same file).

## Why cdkd is faster

cdkd bypasses CloudFormation and provisions directly via the AWS SDK (or Cloud Control API as a fallback), eliminating:

1. **Change set creation and execution** — a two-step roundtrip
2. **Stack status polling** — waiting for `CREATE_IN_PROGRESS` → `CREATE_COMPLETE`
3. **Drift detection and template validation**

DAG-based parallel execution also lets cdkd provision resources with no dependencies concurrently.

## Notes

- Results vary with network conditions and AWS API latency.
- `bench-ccapi` includes Cloud Control API polling (1s→2s→4s→8s→10s), so cdkd's lead is smaller than on `bench-sdk`.
- `results-*.md` files are intentionally not committed.
