---
name: cleanup
description: Detect and delete leftover AWS resources from cdkd integration tests. Only targets resources matching known cdkd stack name patterns.
argument-hint: "[stack-name-prefix] [--detect-only]"
---

# Leftover Resource Cleanup

Detect and optionally delete AWS resources left behind by cdkd integration tests.

## Safety

- ONLY targets resources whose names match cdkd integration test stack name prefixes
- NEVER deletes resources that don't match a known cdkd naming pattern
- Always shows what will be deleted and uses `AskUserQuestion` for confirmation before deleting anything
- Default mode is detect-only (no deletion)

## Arguments

- `stack-name-prefix`: Filter by specific stack name prefix (e.g., `EcrStack`, `LambdaStack`). If not specified, scan all known cdkd test stack prefixes.
- `--detect-only`: Only list leftover resources, don't delete (this is the default)

## Steps

1. **Determine stack name prefixes to scan**:
   - If a prefix is given, use that
   - Otherwise, discover all integration test stack names by running synth or reading `bin/app.ts` in each `tests/integration/*/` directory. Look for the CDK construct ID (second argument to `new *Stack(app, '<id>')`)

2. **Resolve region and account**: Scan both `us-east-1` and `ap-northeast-1`. Resolve account ID via `aws sts get-caller-identity`. IAM is global so only needs one query.

3. **Check S3 state**: `aws s3 ls s3://cdkd-state-{accountId}-us-east-1/stacks/ --region us-east-1`

3.5. **Bulk-sweep orphaned deployment-event stores** (issue #885 follow-up): since the
   deployment-events feature (#820), `cdkd destroy` / `cdkd state destroy` removes
   `state.json` but, unless `--purge-events` was passed, INTENTIONALLY leaves the
   `cdkd/{stack}/{region}/deployments/` event store behind (post-mortem history). After
   a long integ campaign those orphaned event stores accumulate across dozens of
   already-destroyed stacks, so `aws s3 ls .../cdkd/` is never empty even when there are
   no real state / resource leaks. This step bulk-removes them. **Safety: only a prefix
   that has a `deployments/` child AND NO `state.json` under any region is an orphan** —
   a prefix that still has a `state.json` is an ACTIVE (deployed, not destroyed) stack
   and MUST be left untouched (its `deployments/` is live history).

   Resolve the state bucket(s) (`cdkd-state-{accountId}` current default; also the legacy
   `cdkd-state-{accountId}-{region}` if present), then per bucket:

   ```bash
   BUCKET="cdkd-state-{accountId}"
   # List each top-level prefix under cdkd/ (one per stack), skip the exports index.
   for p in $(aws s3 ls "s3://${BUCKET}/cdkd/" --region us-east-1 | awk '{print $2}' | grep '/$' | grep -v '^_index/'); do
     listing=$(aws s3 ls "s3://${BUCKET}/cdkd/${p}" --recursive --region us-east-1 2>/dev/null)
     has_state=$(echo "$listing" | grep -c 'state.json')
     has_dep=$(echo "$listing" | grep -c 'deployments/')
     # An ACTIVE stack still has a state.json somewhere under the prefix.
     if [ "$has_state" -eq 0 ] && [ "$has_dep" -gt 0 ]; then
       echo "ORPHAN event store (no state.json): cdkd/${p}"
     fi
   done
   ```

   Report the orphan list, confirm via `AskUserQuestion` (unless `--detect-only`), then
   delete each confirmed orphan prefix with
   `aws s3 rm "s3://${BUCKET}/cdkd/${p}" --recursive --region us-east-1`. Re-run the
   `has_state` check immediately before each delete to guard against a concurrent deploy
   that re-created the stack. The per-stack product-level equivalent (for a user who
   knows the stack name) is `cdkd events prune <stack> --all`; this skill step is the
   bucket-wide bulk sweep for integ-test hygiene.

4. **Scan AWS resources** for each stack name prefix. Use both exact case and lowercase variants since some AWS services lowercase names:
   - IAM Roles: `aws iam list-roles --query 'Roles[?contains(RoleName, \`{Prefix}\`)].{Name:RoleName,Arn:Arn}'`
   - IAM Policies: `aws iam list-policies --scope Local --query 'Policies[?contains(PolicyName, \`{Prefix}\`)].{Name:PolicyName,Arn:Arn}'`
   - Lambda Functions: `aws lambda list-functions --region us-east-1 --query 'Functions[?contains(FunctionName, \`{Prefix}\`)].FunctionName'`
   - S3 Buckets: `aws s3api list-buckets --query 'Buckets[?contains(Name, \`{prefix}\`)].Name'`
   - DynamoDB Tables: `aws dynamodb list-tables --region us-east-1 --query 'TableNames[?contains(@, \`{Prefix}\`)]'`
   - ECR Repositories: `aws ecr describe-repositories --region us-east-1 --query 'repositories[?contains(repositoryName, \`{prefix}\`)].repositoryName'`
   - SQS Queues: `aws sqs list-queues --region us-east-1 --queue-name-prefix {Prefix}` (if supported)
   - SNS Topics: `aws sns list-topics --region us-east-1` then filter by prefix
   - CloudWatch Log Groups: `aws logs describe-log-groups --region us-east-1 --log-group-name-prefix /aws/lambda/{Prefix}`
   - Security Groups: `aws ec2 describe-security-groups --region us-east-1 --filters "Name=group-name,Values=*{Prefix}*" --query 'SecurityGroups[].{Id:GroupId,Name:GroupName}'`
   - VPCs: `aws ec2 describe-vpcs --region us-east-1 --filters "Name=tag:Name,Values=*{Prefix}*" --query 'Vpcs[].{Id:VpcId,Name:Tags[?Key==\`Name\`].Value|[0]}'`

5. **Report findings**: Show a table of detected resources grouped by type

6. **If deletion requested** (not `--detect-only`):
   - Use `AskUserQuestion` to show the full list and confirm deletion
   - Delete in reverse dependency order (e.g., Lambda before IAM Role, Subnet before VPC)
   - For IAM Roles: detach all policies first, then delete
   - For S3 Buckets: empty the bucket first (only if bucket name matches cdkd pattern), then delete
   - For ECR Repositories: use `--force` flag
   - Report each deletion result

## Important

- This skill is for cleaning up INTEGRATION TEST resources only
- Never delete resources that could belong to other projects
- When in doubt, ask the user via `AskUserQuestion`
- Log Groups under `/aws/lambda/` are created automatically by Lambda and are safe to clean up if the function name matches
