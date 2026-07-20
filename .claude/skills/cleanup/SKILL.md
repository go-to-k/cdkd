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
   - Kinesis Data Streams: `aws kinesis list-streams --region us-east-1 --query 'StreamNames[?contains(@, \`{Prefix}\`)]'`. **Provisioned streams bill continuously**, so surface these first. Delete with `aws kinesis delete-stream --stream-name {name} --region us-east-1`.
   - Kinesis Firehose delivery streams: `aws firehose list-delivery-streams --region us-east-1 --query 'DeliveryStreamNames[?contains(@, \`{Prefix}\`)]'`. Delete with `aws firehose delete-delivery-stream --delivery-stream-name {name} --region us-east-1`.
   - EventBridge Pipes: `aws pipes list-pipes --region us-east-1 --query 'Pipes[?contains(Name, \`{Prefix}\`)].Name'`. Delete with `aws pipes delete-pipe --name {name} --region us-east-1`.
   - EventBridge Scheduler schedules: `aws scheduler list-schedules --region us-east-1 --query 'Schedules[?contains(Name, \`{Prefix}\`)].Name'`. Delete with `aws scheduler delete-schedule --name {name} --region us-east-1`.
   - Synthetics canaries: `aws synthetics describe-canaries --region us-east-1 --query 'Canaries[?contains(Name, \`{prefix}\`)].{Name:Name,Id:Id}'` (canary names are lowercased). Stop if running, then delete with `aws synthetics delete-canary --name {name} --region us-east-1`.
   - Cognito User Pools: `aws cognito-idp list-user-pools --max-results 60 --region us-east-1 --query 'UserPools[?contains(Name, \`{Prefix}\`)].{Name:Name,Id:Id}'`. Delete with `aws cognito-idp delete-user-pool --user-pool-id {id} --region us-east-1`.
   - Secrets Manager secrets: `aws secretsmanager list-secrets --region us-east-1 --query 'SecretList[?contains(Name, \`{Prefix}\`)].{Name:Name,Arn:ARN}'`. Delete with `aws secretsmanager delete-secret --secret-id {arn} --force-delete-without-recovery --region us-east-1`.
   - Step Functions state machines: `aws stepfunctions list-state-machines --region us-east-1 --query 'stateMachines[?contains(name, \`{Prefix}\`)].{Name:name,Arn:stateMachineArn}'`. Delete with `aws stepfunctions delete-state-machine --state-machine-arn {arn} --region us-east-1`.
   - FSx final backups (issue #1113): a destroyed `AWS::FSx::FileSystem` may leave a chargeable final backup behind. cdkd's destroy keeps CFn parity (`DeleteFileSystem` with API defaults, which TAKE a final backup for Windows/ONTAP; observed on OpenZFS too), and `AutomaticBackupRetentionDays: 0` does NOT prevent it. These backups usually carry NO tags (`CopyTagsToBackups` defaults to false), so the prefix scans above miss them. List ALL backups, not just prefix matches:
     ```bash
     aws fsx describe-backups --region us-east-1 \
       --query 'Backups[].{Id:BackupId,FsId:FileSystem.FileSystemId,Type:FileSystem.FileSystemType,Cap:FileSystem.StorageCapacity,Created:CreationTime,BackupTags:Tags,FsTags:FileSystem.Tags}'
     ```
     **Safety (FSx-specific):** a backup is delete-eligible ONLY when its own `Tags` or the persisted `FileSystem.Tags` match a known cdkd fixture pattern (e.g. `aws:cdk:path`, a `Cdkd*` stack name). Untagged/unattributed backups must be SURFACED in the report (BackupId, FileSystemId, type, storage capacity, creation time) for the maintainer to decide; never auto-delete them, since tags are unreliable here by design and the backup could be someone's intentional safety net. Delete a confirmed leftover with `aws fsx delete-backup --backup-id {id} --region us-east-1`.
   - Backup vaults: `aws backup list-backup-vaults --region us-east-1 --query 'BackupVaultList[?contains(BackupVaultName, \`{Prefix}\`)].BackupVaultName'`. A vault with recovery points cannot be deleted until they are removed (`list-recovery-points-by-backup-vault` → `delete-recovery-point`), then `aws backup delete-backup-vault --backup-vault-name {name} --region us-east-1`.
   - KMS customer keys: enumerate then filter — these are **never auto-deleted** and each enabled key bills ~$1/mo:
     ```bash
     for id in $(aws kms list-keys --region us-east-1 --query 'Keys[].KeyId' --output text); do
       meta=$(aws kms describe-key --key-id "$id" --region us-east-1 \
         --query 'KeyMetadata.{Mgr:KeyManager,State:KeyState,Desc:Description}' --output json)
       # Keep only CUSTOMER-managed, Enabled keys whose Description matches a cdkd pattern
       echo "$meta" | grep -q '"Mgr": "CUSTOMER"' || continue
       echo "$meta" | grep -q '"State": "Enabled"' || continue
       echo "$meta" | grep -qi 'cdkd\|bughunt' || continue
       echo "KMS candidate: $id -> $meta"
     done
     ```
     **Safety (KMS-specific, MUST hold):** only `KeyManager==CUSTOMER` AND `KeyState==Enabled` keys (never touch `AWS`-managed keys, and skip anything already `PendingDeletion`); match cdkd origin via the key **Description** (integ keys carry descriptions like `... cdkd #609 integ` / `bughunt sweep11 key A`) or tags (`aws kms list-resource-tags`). **Skip any key that is the active API Gateway account CloudWatch role key, or that has active grants (`aws kms list-grants --key-id {id}`) or aliases (`aws kms list-aliases --key-id {id}`).** KMS keys cannot be deleted immediately — schedule deletion with `aws kms schedule-key-deletion --key-id {id} --pending-window-in-days 7 --region us-east-1` (7 is the minimum window) and **surface the returned `DeletionDate`** in the report.
   - IAM Roles — API Gateway account-level CloudWatch roles: these are a recurring leftover class because they **survive stack destroy** — they are referenced by the account-level `apigateway` CloudWatch-role-ARN setting, not the stack, so nothing deletes them on teardown. They match the general IAM-role scan above (e.g. `CdkdApigwUsagePlanKeyExample-...`, `ApiCognitoStack-...`), but before deleting one confirm it is not the ARN currently set on the account via `aws apigateway get-account`; if it is, unset it there first.

5. **Report findings**: Show a table of detected resources grouped by type

6. **If deletion requested** (not `--detect-only`):
   - Use `AskUserQuestion` to show the full list and confirm deletion
   - Delete in reverse dependency order (e.g., Lambda before IAM Role, Subnet before VPC)
   - For IAM Roles: detach all policies first, then delete. For API Gateway account CloudWatch roles, confirm via `aws apigateway get-account` that the role is not the active account-level ARN before deleting.
   - For S3 Buckets: empty the bucket first (only if bucket name matches cdkd pattern), then delete
   - For ECR Repositories: use `--force` flag
   - For KMS keys: deletion is **scheduled, not immediate** — `schedule-key-deletion --pending-window-in-days 7` returns a `DeletionDate`; report it so the user knows the key bills until then. Never delete `AWS`-managed keys or keys with grants/aliases.
   - For Backup vaults: delete all recovery points first, then the vault.
   - For Synthetics canaries: stop a running canary before deleting.
   - Report each deletion result (for KMS, include the scheduled `DeletionDate`)

## Important

- This skill is for cleaning up INTEGRATION TEST resources only
- Never delete resources that could belong to other projects
- When in doubt, ask the user via `AskUserQuestion`
- Log Groups under `/aws/lambda/` are created automatically by Lambda and are safe to clean up if the function name matches
- **Cost-bearing leftovers to prioritize**: Kinesis provisioned streams, enabled KMS customer keys, and FSx final backups bill continuously and are *not* auto-deleted on stack destroy, so they accumulate silently across integ/bug-hunt campaigns. Surface these three types first in the report. (FSx final backups are the sneakiest: usually untagged and invisible to prefix scans; three 64 GiB OpenZFS backups billed unnoticed until 2026-07-19, issue #1113.)
- **KMS is scheduled-deletion only**: a key never leaves your account instantly — the minimum pending window is 7 days, during which it keeps billing. Always report the `DeletionDate`. Only ever touch `CUSTOMER`-managed + `Enabled` keys matched to a cdkd description/tag, and never one with active grants, aliases, or the apigateway account CloudWatch role binding.
