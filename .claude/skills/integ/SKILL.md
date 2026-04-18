---
name: integ
description: Run integration tests (deploy + destroy) against real AWS. Use when you need to verify cdkd works end-to-end with actual AWS resources.
argument-hint: "[basic|lambda|ecr|cross-stack|vpc-lookup|all]"
---

# Integration Test Runner

Run integration tests against a real AWS account. These tests deploy actual AWS resources, verify them, and clean up.

## Arguments

- `test-name`: Which test to run. Options: `basic`, `lambda`, `ecr`, `cross-stack`, `vpc-lookup`, `all`. Default: ask the user which test to run if not specified.
- `--synth-only`: Only run synthesis, skip deploy/destroy
- `--no-destroy`: Deploy but don't destroy (for debugging)

## Steps

1. **Build first**: Run `pnpm run build` to ensure dist/ is up to date.

2. **Determine state bucket**: Resolve dynamically via `aws sts get-caller-identity --query Account --output text` to get the account ID, then construct `cdkd-state-{accountId}-us-east-1`.

3. **Run the test(s)**:
   - Navigate to `tests/integration/<test-name>/`
   - Ensure dependencies: `npm install` if node_modules doesn't exist
   - Run synth: `node ../../../dist/cli.js synth --region us-east-1`
   - Run deploy: `node ../../../dist/cli.js deploy --region us-east-1 --state-bucket <bucket> --verbose`
   - Run destroy: `node ../../../dist/cli.js destroy --region us-east-1 --state-bucket <bucket> --force`

4. **Verify cleanup**: Check `aws s3 ls s3://<bucket>/stacks/ --region us-east-1` to confirm no leftover state.

5. **Report results**: Show pass/fail for each test, including resource counts and timing.

## Test directories

| Test | What it covers |
|------|---------------|
| `basic` | S3 bucket + IAM role, basic CRUD |
| `lambda` | Lambda + Layer + DynamoDB, file assets |
| `ecr` | Docker image build + ECR push |
| `cross-stack` | Cross-stack references (Fn::ImportValue) |
| `vpc-lookup` | Context provider loop (Vpc.fromLookup) |

## Important

- Always use `--region us-east-1` for integration tests
- Always destroy after deploy to avoid leftover resources
- If deploy fails, still attempt destroy to clean up partial state
- Check for leftover state in S3 after destroy
