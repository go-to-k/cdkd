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
     - For VPC-based tests also check: `aws ec2 describe-vpcs --filters "Name=tag:Name,Values={StackName}/Vpc" ...`
   - Only check resource types relevant to the test being run

6. **Auto-cleanup orphans (mandatory when destroy didn't fully succeed)**:

   **Trigger this step whenever any of the following is true:**
   - The `destroy` step in step 4 reported a non-zero error count (e.g. "X failed to delete")
   - Step 5 found a leftover S3 state file
   - Step 5 found any AWS resource matching the stack name prefix

   **What to do:**
   - For VPC-attached Lambda failures (the most common pattern), the typical orphan set is, **in delete order**:
     1. Lambda hyperplane ENIs (`aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=<vpc>"` → `aws ec2 delete-network-interface`). Some may be `in-use` initially — re-poll until they go `available`, then delete.
     2. SecurityGroups (`aws ec2 delete-security-group`) — must come after the ENIs that reference them are gone.
     3. Subnets (`aws ec2 delete-subnet`) — must come after every ENI in them is gone.
     4. VPC (`aws ec2 delete-vpc`) — last.
   - For S3 state orphans: `aws s3 rm s3://<bucket>/stacks/<StackName>/ --recursive`.
   - For other resource types, infer the right delete order from CloudFormation dependency rules (children before parents).
   - Always specify the correct region (`--region`).
   - Re-run step 5 after cleanup to confirm zero orphans remain.

   **Never** end the run with orphan resources still present in AWS. Cost (NAT GW alone is ~$1/hr) and account hygiene make this non-negotiable. If a resource genuinely cannot be deleted after reasonable retries, surface it to the user with the exact ID, region, and what was tried — but only after the auto-cleanup pass.

7. **Report results**: Show pass/fail for each test, including resource counts and timing. Always state explicitly "destroy completed: 0 errors, 0 orphans" or itemize what remained / what was force-cleaned.

## Important

- Always use `--region us-east-1` for integration tests
- Always destroy after deploy to avoid leftover resources
- If deploy fails, still attempt destroy to clean up partial state
- **Never report success based on a successful deploy alone** — destroy must complete and orphan check must pass
- **Never bypass this skill** by calling `cdkd deploy` / `cdkd destroy` directly from a shell — the orphan-cleanup contract above is part of the integration test, not optional
