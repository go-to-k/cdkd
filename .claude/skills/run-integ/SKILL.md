---
name: run-integ
description: Run integration tests (deploy + destroy) against real AWS. Use when you need to verify cdkd works end-to-end with actual AWS resources.
argument-hint: "<test-name|all> [--synth-only] [--no-destroy]"
---

# Integration Test Runner

Run integration tests against a real AWS account. These tests deploy actual AWS resources, verify them, and clean up.

## Arguments

- `test-name`: Which test to run. Run `ls tests/integration/` to see all available tests. If not specified, use the `AskUserQuestion` tool to ask which test to run, showing the available options.
- `all`: Run all tests
- `--synth-only`: Only run synthesis, skip deploy/destroy
- `--no-destroy`: Deploy but don't destroy (for debugging)

## Steps

1. **Build first**: Run `pnpm run build` to ensure dist/ is up to date.

2. **List available tests**: Run `ls tests/integration/` to discover all test directories dynamically. Do NOT rely on a hardcoded list.

3. **Determine state bucket**: Resolve dynamically via `aws sts get-caller-identity --query Account --output text` to get the account ID, then construct `cdkd-state-{accountId}-us-east-1`.

4. **Run the test(s)**:
   - Navigate to `tests/integration/<test-name>/`
   - Ensure dependencies: `npm install` if node_modules doesn't exist
   - Run synth: `node ../../../dist/cli.js synth --region us-east-1`
   - **Detect multi-stack apps**: read the synth output. If it lists more
     than one stack (e.g. `multi-stack-deps`, `composite-stack`,
     `cross-stack-references`), pass `--all` to deploy and destroy.
     Without `--all`, deploy/destroy will fail with `Multiple stacks
     found: ... Specify stack name(s) or use --all`.
   - Run deploy: `node ../../../dist/cli.js deploy [--all] --region us-east-1 --state-bucket <bucket> --verbose`
   - Run destroy: `node ../../../dist/cli.js destroy [--all] --region us-east-1 --state-bucket <bucket> --force`

5. **Verify cleanup**:
   - Check `aws s3 ls s3://<bucket>/stacks/ --region us-east-1` to confirm no leftover state
   - Also verify actual AWS resources are gone by checking with stack name prefix filters. Get stack names from the synth output, then for each stack name query AWS APIs filtered by that prefix:
     - `aws iam list-roles --query 'Roles[?contains(RoleName, \`{StackName}\`)].RoleName'`
     - `aws lambda list-functions --region us-east-1 --query 'Functions[?contains(FunctionName, \`{StackName}\`)].FunctionName'`
     - `aws s3api list-buckets --query 'Buckets[?contains(Name, \`{stackName-lowercase}\`)].Name'`
     - `aws ecr describe-repositories --region us-east-1 --query 'repositories[?contains(repositoryName, \`{stackName-lowercase}\`)].repositoryName'`
     - `aws dynamodb list-tables --region us-east-1 --query 'TableNames[?contains(@, \`{StackName}\`)]'`
   - Only check resource types relevant to the test being run
   - NEVER delete resources in this step — only report findings. Use `/cleanup` skill to delete if needed.

6. **Report results**: Show pass/fail for each test, including resource counts and timing.

## Important

- Always use `--region us-east-1` for integration tests
- Always destroy after deploy to avoid leftover resources
- If deploy fails, still attempt destroy to clean up partial state
- Check for leftover state in S3 after destroy
