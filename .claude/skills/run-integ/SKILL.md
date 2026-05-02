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

3. **Determine state bucket**: Resolve dynamically via `aws sts get-caller-identity --query Account --output text` to get the account ID, then construct `cdkd-state-{accountId}` (region-free, the current default since PR #62 / v0.11.0). If that bucket doesn't exist, fall back to the legacy `cdkd-state-{accountId}-us-east-1` and note the deprecation in the report.

4. **Pre-flight orphan scan** (mandatory — fail fast on prior-run leftovers instead of going through CREATE + rollback):

   Before invoking deploy, scan AWS for resources matching the stack name from this test that have no business existing yet. The scenario this catches: a previous integration run was killed mid-deploy, leaving orphan Event Source Mappings / Lambda functions / ENIs / IAM roles whose names match the stack about to be deployed. cdkd's diff calculation does NOT see these (they're not in state), so the deploy attempts CREATE — which collides with the orphans, fails immediately with `ResourceAlreadyExists`, and forces a CREATE-then-rollback cycle. Failing at the start is much cheaper than partway through.

   Synth first (without deploy) to learn the stack name and the resource types in the template, then for each scenario in scope run a targeted scan:

   ```bash
   # Always run these (cheap, broadly applicable):
   aws s3 ls s3://<bucket>/cdkd/<StackName>/ --region us-east-1
   aws iam list-roles --query 'Roles[?contains(RoleName, `<StackName>`)].RoleName' --output text
   aws lambda list-functions --region us-east-1 \
     --query 'Functions[?contains(FunctionName, `<StackName>`)].FunctionName' --output text

   # Run when the template uses Lambda EventSourceMapping (the orphan ESM
   # case bit cdkd in 2026-05-02: AlreadyExists + rollback cycle on a fresh deploy):
   aws lambda list-event-source-mappings --region us-east-1 \
     --query 'EventSourceMappings[?contains(FunctionArn, `<StackName>`)].[UUID,FunctionArn]' --output text

   # Run when the template uses VPC + Lambda VpcConfig (hyperplane ENIs
   # outlive their function):
   aws ec2 describe-network-interfaces --region us-east-1 \
     --filters "Name=description,Values=AWS Lambda VPC ENI-<StackName>*" \
     --query 'NetworkInterfaces[].[NetworkInterfaceId,Status]' --output text
   ```

   **If anything is found**, abort the test run with a clear report listing the orphans and the cleanup commands the user should run (`aws lambda delete-event-source-mapping --uuid …`, `cdkd state destroy <StackName> --yes`, etc.) — do NOT proceed with deploy. Resuming on top of orphans is the failure mode this step exists to prevent.

   **If nothing is found**, the deploy can proceed cleanly.

5. **Run the test(s)**:
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

6. **Verify cleanup**:
   - Check `aws s3 ls s3://<bucket>/cdkd/ --region us-east-1` to confirm no leftover state
   - Also verify actual AWS resources are gone by checking with stack name prefix filters. Get stack names from the synth output, then for each stack name query AWS APIs filtered by that prefix:
     - `aws iam list-roles --query 'Roles[?contains(RoleName, \`{StackName}\`)].RoleName'`
     - `aws lambda list-functions --region us-east-1 --query 'Functions[?contains(FunctionName, \`{StackName}\`)].FunctionName'`
     - `aws s3api list-buckets --query 'Buckets[?contains(Name, \`{stackName-lowercase}\`)].Name'`
     - `aws ecr describe-repositories --region us-east-1 --query 'repositories[?contains(repositoryName, \`{stackName-lowercase}\`)].repositoryName'`
     - `aws dynamodb list-tables --region us-east-1 --query 'TableNames[?contains(@, \`{StackName}\`)]'`
     - For VPC-based tests also check: `aws ec2 describe-vpcs --filters "Name=tag:Name,Values={StackName}/Vpc" ...`
   - Only check resource types relevant to the test being run

7. **Auto-cleanup orphans (mandatory when destroy didn't fully succeed)**:

   **Trigger this step whenever any of the following is true:**
   - The `destroy` step in step 5 reported a non-zero error count (e.g. "X failed to delete")
   - Step 6 found a leftover S3 state file
   - Step 6 found any AWS resource matching the stack name prefix

   **What to do:**
   - For VPC-attached Lambda failures (the most common pattern), the typical orphan set is, **in delete order**:
     1. Lambda hyperplane ENIs (`aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=<vpc>"` → `aws ec2 delete-network-interface`). Some may be `in-use` initially — re-poll until they go `available`, then delete.
     2. SecurityGroups (`aws ec2 delete-security-group`) — must come after the ENIs that reference them are gone.
     3. Subnets (`aws ec2 delete-subnet`) — must come after every ENI in them is gone.
     4. VPC (`aws ec2 delete-vpc`) — last.
   - For S3 state orphans: `aws s3 rm s3://<bucket>/cdkd/<StackName>/ --recursive`. (`cdkd state orphan <StackName>` is the cdkd-native equivalent and also handles the lock key.)
   - For other resource types, infer the right delete order from CloudFormation dependency rules (children before parents).
   - Always specify the correct region (`--region`).
   - Re-run step 6 after cleanup to confirm zero orphans remain.

   **Never** end the run with orphan resources still present in AWS. Cost (NAT GW alone is ~$1/hr) and account hygiene make this non-negotiable. If a resource genuinely cannot be deleted after reasonable retries, surface it to the user with the exact ID, region, and what was tried — but only after the auto-cleanup pass.

8. **Report results**: Show pass/fail for each test, including resource counts and timing. Always state explicitly "destroy completed: 0 errors, 0 orphans" or itemize what remained / what was force-cleaned.

9. **Set the `integ-destroy` markgate marker (only on full clean success)**:

   When — and ONLY when — all of the following hold:
   - the destroy step finished with **0 errors**,
   - step 6 found **0 leftover resources**,
   - step 7 was either skipped (because nothing to clean up) or completed with the post-cleanup re-check showing 0 orphans,

   record the gate so subsequent `gh pr merge` calls are unblocked:

   ```bash
   mise exec -- markgate set integ-destroy
   ```

   If any of the above failed, do NOT set the marker — that is the
   whole point of the gate. The hook
   `.claude/hooks/integ-destroy-gate.sh` will block `gh pr merge` for
   any PR that touches deletion-related code (see `.markgate.yml`
   `integ-destroy.include`) until this marker is fresh, so a
   destroy-untested change physically cannot reach main.

## Important

- Always use `--region us-east-1` for integration tests
- Always destroy after deploy to avoid leftover resources
- If deploy fails, still attempt destroy to clean up partial state
- **Never report success based on a successful deploy alone** — destroy must complete and orphan check must pass
- **Never bypass this skill** by calling `cdkd deploy` / `cdkd destroy` directly from a shell — the orphan-cleanup contract above is part of the integration test, not optional
