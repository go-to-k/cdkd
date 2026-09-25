---
name: cleanup
description: Detect and delete leftover AWS resources from cdkd integration tests. Only targets resources matching known cdkd stack name patterns.
argument-hint: "[stack-name-prefix] [--detect-only]"
---

# Leftover Resource Cleanup

Detect and optionally delete AWS resources left behind by cdkd integration tests.

## Safety

- ONLY targets resources whose names match a cdkd integ stack prefix; NEVER one
  that does not match a known cdkd naming pattern.
- Always show what will be deleted and confirm via `AskUserQuestion` first.
- Detect-only is the DEFAULT.

## Arguments

- `stack-name-prefix`: one prefix (e.g. `EcrStack`); absent, scan all known cdkd test stack prefixes.
- `--detect-only`: list only, the default.

## Steps

1. **Determine stack name prefixes to scan**: the given prefix, else discover every integ stack name by synthesizing or reading `bin/app.ts` in each `tests/integration/*/` — the construct ID is the second argument to `new *Stack(app, '<id>')`.

2. **Resolve region and account**: scan `us-east-1`, `ap-northeast-1` AND `us-west-2` — the benchmark suite runs its variant stacks in the third, and its leftovers (billed PROVISIONED Kinesis streams, Lambda log groups) are invisible to a two-region scan. Derive any further regions from the state-bucket key layout (`aws s3 ls` recursively, collect the distinct `{region}` segments) so a fixture pinned elsewhere is not missed. Account id via `aws sts get-caller-identity`; IAM is global, so one query.

3. **Check S3 state**: `aws s3 ls s3://cdkd-state-{accountId}/cdkd/ --recursive --region us-east-1 | grep state.json` (also the legacy `cdkd-state-{accountId}-{region}` bucket if it exists)

3.5. **Bulk-sweep orphaned deployment-event stores**: `cdkd destroy` / `cdkd state destroy` removes
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
   knows the stack name) is `cdkd events prune '<stack>' --all`; this skill step is the
   bucket-wide bulk sweep for integ-test hygiene.

4. **Scan AWS resources** for each stack name prefix, in both exact case and
   lowercase (some services lowercase names). **Every command below takes
   `--region <region>` for each region from step 2** — it is omitted from the
   rows to keep them readable, and IAM is global.
   - IAM Roles: `aws iam list-roles --query 'Roles[?contains(RoleName, \`{Prefix}\`)].{Name:RoleName,Arn:Arn}'`
   - IAM Policies: `aws iam list-policies --scope Local --query 'Policies[?contains(PolicyName, \`{Prefix}\`)].{Name:PolicyName,Arn:Arn}'`
   - Lambda Functions: `aws lambda list-functions --query 'Functions[?contains(FunctionName, \`{Prefix}\`)].FunctionName'`
   - S3 Buckets: `aws s3api list-buckets --query 'Buckets[?contains(Name, \`{prefix}\`)].Name'`
   - DynamoDB Tables: `aws dynamodb list-tables --query 'TableNames[?contains(@, \`{Prefix}\`)]'`
   - ECR Repositories: `aws ecr describe-repositories --query 'repositories[?contains(repositoryName, \`{prefix}\`)].repositoryName'`
   - SQS Queues: `aws sqs list-queues --queue-name-prefix {Prefix}` (if supported)
   - SNS Topics: `aws sns list-topics` then filter by prefix
   - CloudWatch Log Groups: `aws logs describe-log-groups --log-group-name-prefix /aws/lambda/{Prefix}`, **and also** `--log-group-name-prefix /cdkd-integ/` — a fixture needing a sweepable, fixture-owned name puts its log groups there rather than under cdkd's generated `/cdkd/`, which is shared with every fixture and cannot be swept safely. One under `/cdkd-integ/` whose fixture is not running is a leftover.
     **Check `deletionProtectionEnabled` first**: `aws logs delete-log-group` on a protected group fails with `InvalidParameterException ... LogGroup has delete protection enabled`, so clear it —
     ```bash
     aws logs put-log-group-deletion-protection \
       --log-group-identifier {name} --no-deletion-protection-enabled
     aws logs delete-log-group --region us-east-1 --log-group-name {name}
     ```
     A run killed between a fixture's protect and destroy phases leaves exactly that shape, and without the flip-off it is unreachable by every other step here.
   - Security Groups: `aws ec2 describe-security-groups --filters "Name=group-name,Values=*{Prefix}*" --query 'SecurityGroups[].{Id:GroupId,Name:GroupName}'`
   - VPCs: `aws ec2 describe-vpcs --filters "Name=tag:Name,Values=*{Prefix}*" --query 'Vpcs[].{Id:VpcId,Name:Tags[?Key==\`Name\`].Value|[0]}'`
   - Kinesis Data Streams: `aws kinesis list-streams --query 'StreamNames[?contains(@, \`{Prefix}\`)]'`. **Provisioned streams bill continuously**, so surface these first. Delete: `aws kinesis delete-stream --stream-name {name}`.
   - Kinesis Firehose delivery streams: `aws firehose list-delivery-streams --query 'DeliveryStreamNames[?contains(@, \`{Prefix}\`)]'`. Delete: `aws firehose delete-delivery-stream --delivery-stream-name {name}`.
   - EventBridge Pipes: `aws pipes list-pipes --query 'Pipes[?contains(Name, \`{Prefix}\`)].Name'`. Delete: `aws pipes delete-pipe --name {name}`.
   - EventBridge Scheduler schedules: `aws scheduler list-schedules --query 'Schedules[?contains(Name, \`{Prefix}\`)].Name'`. Delete: `aws scheduler delete-schedule --name {name}`.
   - Synthetics canaries: `aws synthetics describe-canaries --query 'Canaries[?contains(Name, \`{prefix}\`)].{Name:Name,Id:Id}'` (canary names are lowercased). Stop if running, then delete with `aws synthetics delete-canary --name {name}`.
   - Cognito User Pools: `aws cognito-idp list-user-pools --max-results 60 --query 'UserPools[?contains(Name, \`{Prefix}\`)].{Name:Name,Id:Id}'`. Delete: `aws cognito-idp delete-user-pool --user-pool-id {id}`.
   - Secrets Manager secrets: `aws secretsmanager list-secrets --query 'SecretList[?contains(Name, \`{Prefix}\`)].{Name:Name,Arn:ARN}'`. Delete: `aws secretsmanager delete-secret --secret-id {arn} --force-delete-without-recovery`.
   - Step Functions state machines: `aws stepfunctions list-state-machines --query 'stateMachines[?contains(name, \`{Prefix}\`)].{Name:name,Arn:stateMachineArn}'`. Delete: `aws stepfunctions delete-state-machine --state-machine-arn {arn}`.
   - FSx final backups: a destroyed `AWS::FSx::FileSystem` may leave a chargeable final backup behind — cdkd's destroy keeps CFn parity (`DeleteFileSystem` with API defaults, which TAKE one), and `AutomaticBackupRetentionDays: 0` does NOT prevent it. They usually carry NO tags, so the prefix scans miss them. List ALL backups:
     ```bash
     aws fsx describe-backups \
       --query 'Backups[].{Id:BackupId,FsId:FileSystem.FileSystemId,Type:FileSystem.FileSystemType,Cap:FileSystem.StorageCapacity,Created:CreationTime,BackupTags:Tags,FsTags:FileSystem.Tags}'
     ```
     **Safety (FSx-specific):** a backup is delete-eligible ONLY when its own `Tags` or the persisted `FileSystem.Tags` match a cdkd fixture pattern (`aws:cdk:path`, a `Cdkd*` stack name). Never auto-delete an untagged one — tags are unreliable here by design and the backup may be an intentional safety net; SURFACE it in the report (BackupId, FileSystemId, type, capacity, creation time) for the maintainer to decide. Delete a confirmed leftover: `aws fsx delete-backup --backup-id {id}`.
   - Backup vaults: `aws backup list-backup-vaults --query 'BackupVaultList[?contains(BackupVaultName, \`{Prefix}\`)].BackupVaultName'`. A vault with recovery points cannot be deleted until they are removed (`list-recovery-points-by-backup-vault` → `delete-recovery-point`), then `aws backup delete-backup-vault --backup-vault-name {name}`.
   - KMS customer keys: enumerate then filter — these are **never auto-deleted** and each enabled key bills ~$1/mo:
     ```bash
     for id in $(aws kms list-keys --query 'Keys[].KeyId' --output text); do
       meta=$(aws kms describe-key --key-id "$id" \
         --query 'KeyMetadata.{Mgr:KeyManager,State:KeyState,Desc:Description}' --output json)
       # Keep only CUSTOMER-managed, Enabled keys whose Description matches a cdkd pattern
       echo "$meta" | grep -q '"Mgr": "CUSTOMER"' || continue
       echo "$meta" | grep -q '"State": "Enabled"' || continue
       echo "$meta" | grep -qi 'cdkd\|bughunt' || continue
       echo "KMS candidate: $id -> $meta"
     done
     ```
     **Safety (KMS-specific, MUST hold):** only `KeyManager==CUSTOMER` AND `KeyState==Enabled` keys (never touch `AWS`-managed keys, and skip anything already `PendingDeletion`); match cdkd origin via the key **Description** (integ keys carry descriptions like `... cdkd #609 integ` / `bughunt sweep11 key A`) or tags (`aws kms list-resource-tags`). **Skip any key that is the active API Gateway account CloudWatch role key, or that has active grants (`aws kms list-grants --key-id {id}`) or aliases (`aws kms list-aliases --key-id {id}`).** KMS keys cannot be deleted immediately — schedule deletion with `aws kms schedule-key-deletion --key-id {id} --pending-window-in-days 7` (7 is the minimum window) and **surface the returned `DeletionDate`** in the report.
   - IAM Roles — API Gateway account-level CloudWatch roles **survive stack destroy**: they are referenced by the account-level `apigateway` CloudWatch-role-ARN setting, not the stack. They match the general IAM-role scan, but before deleting one confirm via `aws apigateway get-account` that it is not the ARN currently set on the account; if it is, unset it there first.

5. **Report findings**: a table of detected resources grouped by type.

6. **If deletion is requested** (not `--detect-only`): show the full list and
   confirm via `AskUserQuestion`, delete in reverse dependency order (Lambda
   before IAM Role, Subnet before VPC), and report each result.
   - IAM Roles: detach all policies first. For an API Gateway account CloudWatch
     role, confirm via `aws apigateway get-account` that it is not the active
     account-level ARN.
   - S3 Buckets: empty first, only when the name matches a cdkd pattern.
   - ECR Repositories: `--force`.
   - KMS keys: deletion is **scheduled, not immediate** —
     `schedule-key-deletion --pending-window-in-days 7` returns a `DeletionDate`;
     report it. Never touch `AWS`-managed keys or keys with grants / aliases.
   - Backup vaults: delete all recovery points first.
   - Synthetics canaries: stop a running canary first.

## Important

- INTEGRATION TEST resources only; never one that could belong to another
  project, and when in doubt ask via `AskUserQuestion`.
- A `/aws/lambda/` log group is created by Lambda itself and is safe to remove
  when the function name matches.
- **Cost-bearing leftovers come first in the report**: Kinesis provisioned
  streams, enabled KMS customer keys and FSx final backups all bill continuously
  and are *not* auto-deleted on stack destroy. The FSx ones are the sneakiest —
  usually untagged and invisible to a prefix scan.
- **KMS is scheduled-deletion only** — 7 days minimum, billing throughout, so
  always report the `DeletionDate`.
