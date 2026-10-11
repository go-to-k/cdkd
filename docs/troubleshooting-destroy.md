---
title: Problems destroying a stack
description: "Fix a cdkd destroy that refuses to delete a resource, skips one, or leaves a billed backup behind."
---

# Problems destroying a stack

These entries are for a `cdkd destroy` that stops on one resource, skips one, or finishes and still leaves something billed in the account.

On this page:

- ["bucket is not empty" / "still contains images" on destroy](#bucket-is-not-empty-still-contains-images-on-destroy)
- ["has DeletionPolicy: Snapshot, but ..." refusal on delete](#has-deletionpolicy-snapshot-but-refusal-on-delete)
- ["Backing Lambda for custom resource X no longer exists" on destroy](#backing-lambda-for-custom-resource-x-no-longer-exists-on-destroy)
- [destroy reports `N skipped` and exits 2](#destroy-reports-n-skipped-and-exits-2)
- [Known Leftover: EFS Automatic Backups](#known-leftover-efs-automatic-backups)
- [Known Leftover: FSx Final Backups](#known-leftover-fsx-final-backups)

## "bucket is not empty" / "still contains images" on destroy

```text
Failed to delete S3 bucket MyBucket: bucket my-bucket is not empty. Matching
CloudFormation, cdkd does not delete a non-empty bucket unless it opted into
automatic emptying (CDK's autoDeleteObjects: true, i.e. the
'aws-cdk:auto-delete-objects' tag).
```

```text
Failed to delete S3 Express Directory Bucket my-bucket--use1-az4--x-s3: bucket
my-bucket--use1-az4--x-s3 is not empty. Matching CloudFormation, cdkd does not
delete a non-empty directory bucket without an explicit opt-in.
```

```text
Failed to delete ECR Repository MyRepo: repository my-repo still contains
images. Matching CloudFormation, cdkd does not force-delete an image-carrying
repository unless it opted in via EmptyOnDelete: true (CDK's emptyOnDelete) or
the 'aws-cdk:auto-delete-images' tag (CDK's autoDeleteImages).
```

Like CloudFormation, `cdkd destroy` does not delete a bucket that still holds
objects or a repository that still holds images, unless the resource opted in
to being emptied. You have two ways forward.

The first is to opt in from the CDK app, redeploy, and then destroy:

| Resource | Opt-in |
| --- | --- |
| S3 bucket | `autoDeleteObjects: true` with `removalPolicy: RemovalPolicy.DESTROY` |
| S3 Express directory bucket | The tag on the L1: `tags: [{ key: 'aws-cdk:auto-delete-objects', value: 'true' }]` |
| ECR repository | `emptyOnDelete: true`, or the older `autoDeleteImages: true` |

The second is to empty the bucket or repository by hand and re-run the
destroy:

```bash
# a versioned bucket also needs its versions and delete markers removed
aws s3 rm s3://my-bucket --recursive
aws ecr batch-delete-image --repository-name my-repo \
  --image-ids "$(aws ecr list-images --repository-name my-repo \
    --query 'imageIds' --output json)"
```

[Destroy flags & guards](cli-destroy.md) has the full rules.

## "has DeletionPolicy: Snapshot, but ..." refusal on delete

```text
MyDb (AWS::RDS::DBInstance) has DeletionPolicy: Snapshot, but the resource is
managed via the Cloud Control API route (provisionedBy: cc-api), which has no
final-snapshot delete parameter — deleting it now would destroy its data WITHOUT
the final snapshot the policy promises.
```

Before cdkd deletes a resource with `DeletionPolicy: Snapshot`, it takes a
final snapshot, as CloudFormation does. It refuses the delete only when it
cannot take one. That happens in two cases:

- cdkd manages the resource through the Cloud Control API, whose delete has
  no final-snapshot parameter.
- The template puts `Snapshot` on a type that does not support it.

Take the snapshot yourself, then do one of:

- Re-run with `--skip-final-snapshot`, which deletes without a snapshot.

  ```bash
  aws rds create-db-snapshot --db-instance-identifier mydb \
    --db-snapshot-identifier mydb-final
  cdkd destroy MyStack --skip-final-snapshot
  ```

- Change the policy to `Retain` and delete the resource by hand afterwards.

[Destroy flags & guards](cli-destroy.md) has the per-type behaviour.

## "Backing Lambda for custom resource X no longer exists" on destroy

```
Backing Lambda for custom resource X no longer exists (arn:aws:lambda:...), so its Delete handler cannot be invoked and cdkd cannot confirm the resource was deleted; skipping deletion — anything this custom resource manages may still be LIVE.
```

The resource's row in the destroy output reads `skipped (backing Lambda
function is gone — Delete handler not invoked)`. cdkd keeps the state record,
and `cdkd destroy` exits `2`.

A custom resource is deleted by invoking its handler, the Lambda function
named by its `ServiceToken`. That function is gone, so the handler cannot run,
and cdkd cannot tell whether the things the custom resource manages still
exist. There are two usual ways to get here:

- A shared provider stack was destroyed before the stacks that use it.
- An earlier destroy skipped this resource and then deleted the function in
  the same run.

What to do depends on whether the function can be restored:

- **The function can come back at the same ARN** (redeploy the shared provider
  stack): do that, then re-run `cdkd destroy`.
- **It cannot**: confirm by hand that what the handler manages is gone, or
  tear it down. Then drop the stack's records:

  ```bash
  cdkd state orphan MyStack --stack-region us-east-1
  ```

  This drops every record for the stack in that region, not only this one.

### The same situation during a deploy

When a `cdkd deploy` removes such a custom resource, cdkd only warns and
drops the record. CloudFormation also ignores delete failures in the cleanup
phase of an update.

## destroy reports `N skipped` and exits 2

```text
⚠ MyGlueTable (AWS::Glue::Table) skipped (malformed physicalId in state — no delete issued)
⚠ Stack MyStack partially destroyed (4 deleted, 1 skipped, 0 errors). cdkd did not confirm the skipped resource(s) were deleted, so they may still exist in AWS.
```

cdkd could not work out which AWS resource the state record points at, so it
did not try to delete it.

A state record holds the resource's physical id. Some types need more than
one value to find a resource, so cdkd stores them joined with `|`:
`<databaseName>|<tableName>` for `AWS::Glue::Table`, and
`<apiId>|<typeName>|<fieldName>` for `AWS::AppSync::Resolver`. A `state.json`
edited by hand, or a record written by an older cdkd, can have the wrong
number of parts.

cdkd made no AWS call for that resource, so the resource may still exist.
cdkd keeps the state record, because it holds the only id you could delete
the resource with. The warning for each resource names the form cdkd
expected.

Inspect the record, then fix it one of two ways:

```bash
cdkd state show MyStack
```

- **Repair the id and re-run.**

  ```bash
  aws s3 cp s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json .
  # edit the record: "physicalId": "mydb|mytable"
  aws s3 cp state.json \
    s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json
  cdkd destroy MyStack
  ```

- **Delete the resource by hand and drop the record.**

  ```bash
  aws glue delete-table --database-name mydb --name mytable
  cdkd state orphan MyStack   # removes state only, never AWS resources
  ```

Do not remove the record while the resource is still in AWS. Nothing would
track the resource any more.

## Known Leftover: EFS Automatic Backups

A successful `cdkd destroy` of an `AWS::EFS::FileSystem` deletes the file
system, but it does not delete the AWS Backup recovery points that were taken
while the file system existed. If automatic backups were on
(`BackupPolicy: { Status: ENABLED }`), the recovery points stay in the vault
`aws/efs/automatic-backup-vault` for the default retention of 35 days. You
can still restore from them, and you are billed for them.

List and delete them with `aws backup list-recovery-points-by-backup-vault`
and `aws backup delete-recovery-point`. "EFS automatic backups survive
destroy" in [Supported Resources](supported-resources.md) has the full
commands.

## Known Leftover: FSx Final Backups

A successful `cdkd destroy` of an `AWS::FSx::FileSystem` can leave a final
backup that you are billed for. cdkd calls `DeleteFileSystem` with the API's
defaults, as CloudFormation does. Those defaults take a final backup for
Windows and ONTAP file systems, and this has been observed on OpenZFS too.

The backup is usually untagged, so find it by its `FileSystem.FileSystemId`
with `aws fsx describe-backups`, and remove it with `aws fsx delete-backup`.
"FSx final backup on destroy" in [Supported Resources](supported-resources.md)
has the full commands.

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
