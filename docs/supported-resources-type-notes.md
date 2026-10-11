---
title: Per-Type Behaviour Notes
description: "Resource types whose behaviour under cdkd differs from CloudFormation or leaves something behind on destroy: EFS, FSx, EMR, Bedrock AgentCore, nested stacks, wait condition handles and Glue."
---

# Per-Type Behaviour Notes

Most resource types behave under cdkd as they do under CloudFormation. This
page covers the ones that differ, and the ones where a successful destroy can
leave something behind. Search it for your type.

For the list of types cdkd deploys, see
[Supported Resources](supported-resources.md).

## EFS automatic backups survive destroy

Destroying an `AWS::EFS::FileSystem` removes the file system and its data. It
does not remove the AWS Backup recovery points taken while the file system
existed. A destroy that reports 0 errors can therefore leave a restorable
copy of the data behind, and AWS charges for it.

This applies when the file system had automatic backups on. A template turns
them on with `BackupPolicy: { Status: ENABLED }`, which the AWS CDK emits for
`enableAutomaticBackups: true`, and cdkd applies that policy on create and
update. AWS also turns them on by default for some configurations, so check:

```bash
aws efs describe-backup-policy --file-system-id fs-XXXXXXXX --region <region>
```

AWS Backup stores the recovery points in the vault
`aws/efs/automatic-backup-vault`, which the service manages, and keeps them
for 35 days by default. To find and delete them, take the file system id from
the deploy output or from cdkd state, and run:

```bash
aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name aws/efs/automatic-backup-vault --region <region> \
  --query "RecoveryPoints[?contains(ResourceArn, 'fs-XXXXXXXX')].{
    Arn:RecoveryPointArn,Created:CreationDate,Status:Status}" \
  --output table

aws backup delete-recovery-point --region <region> \
  --backup-vault-name aws/efs/automatic-backup-vault \
  --recovery-point-arn <RecoveryPointArn>
```

> [!CAUTION]
> The recovery points are the only remaining copy of the file system's data.
> Leave them if the destroy was a mistake. Delete them when the data must not
> outlive the stack.

## FSx final backup on destroy

Destroying an `AWS::FSx::FileSystem` can leave a backup behind, and AWS
charges for it. cdkd calls `DeleteFileSystem` with the API's defaults, as
CloudFormation does, and for Windows and ONTAP file systems the default is to
take a final backup. The same was observed on OpenZFS. A SCRATCH Lustre
deployment takes none.

Two things make the backup easy to miss:

- `AutomaticBackupRetentionDays: 0` does not prevent it. That setting turns
  off scheduled backups only.
- The final backup usually has no tags, because `CopyTagsToBackups` defaults
  to false. A search by tag does not find it. Select by the backup's
  `FileSystem.FileSystemId` instead.

To find and delete a leftover final backup, take the file system id from the
deploy output or from cdkd state, and run:

```bash
aws fsx describe-backups --region <region> \
  --query 'Backups[?FileSystem.FileSystemId==`fs-XXXXXXXX`].{
    Id:BackupId,Lifecycle:Lifecycle,
    Type:FileSystem.FileSystemType,Created:CreationTime}' \
  --output table
aws fsx delete-backup --backup-id backup-XXXXXXXX --region <region>
```

If you no longer know the file system id, list all backups with
`aws fsx describe-backups` and review the untagged ones by creation time and
storage capacity.

## FSx file systems

`AWS::FSx::FileSystem` covers all four variants: Lustre, Windows, ONTAP and
OpenZFS. AWS marks the type `NON_PROVISIONABLE`, which means Cloud Control
cannot manage it, so cdkd's SDK provider is the only path for it.

- **Update.** A property that `UpdateFileSystem` accepts changes in place. A
  change to a property that cannot change is rejected, and the error points
  to `--replace`.
- **Create and delete.** cdkd waits until the file system is `AVAILABLE`, and
  on delete until it is gone. The timeout for one resource of this type is
  one hour.
- **Drift.** `cdkd drift` compares the configuration blocks of all four
  variants. It cannot compare three values that AWS never returns:
  `WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.Password`,
  `OntapConfiguration.FsxAdminPassword` and
  `OpenZFSConfiguration.RootVolumeConfiguration`.

## EMR on EC2

cdkd deploys EMR clusters, instance groups and instance fleets with SDK
providers. AWS marks the three types `NON_PROVISIONABLE`, which means Cloud
Control cannot manage them, so there is no other path. Each has a one-hour
timeout per resource.

| Type | Updates in place | Delete |
| --- | --- | --- |
| `AWS::EMR::Cluster` | Termination protection, visibility, step concurrency, managed scaling, auto-termination, tags | Terminates the cluster and waits for `TERMINATED` |
| `AWS::EMR::InstanceGroupConfig` | `InstanceCount`, `AutoScalingPolicy` | Removes the cdkd state record only |
| `AWS::EMR::InstanceFleetConfig` | `TargetOnDemandCapacity`, `TargetSpotCapacity`, `ResizeSpecifications`, `InstanceTypeConfigs` | Removes the cdkd state record only |

Any other property change replaces the resource. A create waits until a
cluster is `WAITING` or `RUNNING`, and until a group or fleet is `RUNNING`.

Deleting an instance group or fleet does not remove it from AWS, because EMR
releases a group or fleet only when its cluster terminates. cdkd removes the
state record. For a `TASK` group or fleet it first tries to scale it to 0,
and continues if that fails.

`cdkd destroy --remove-protection` turns a cluster's termination protection
off before it terminates the cluster.

## Bedrock AgentCore browser and code interpreter

`AWS::BedrockAgentCore::Browser` and `AWS::BedrockAgentCore::CodeInterpreter`
stand for the defaults that AWS manages, `aws.browser.v1` and
`aws.codeinterpreter.v1`. cdkd does not create anything for them. On create
it looks the default up with `GetBrowser` or `GetCodeInterpreter` and records
it, and on delete it does nothing.

A custom browser or interpreter is a different type,
`AWS::BedrockAgentCore::BrowserCustom` or
`AWS::BedrockAgentCore::CodeInterpreterCustom`, and uses Cloud Control.

## Nested stacks

cdkd supports `AWS::CloudFormation::Stack` in three directions:

- `cdkd deploy` deploys a nested stack.
- [`cdkd import --migrate-from-cloudformation`](import.md#migrating-from-cdk-deploy-cloudformation-to-cdkd)
  adopts a stack together with its nested stacks.
- [`cdkd export`](export.md) hands a stack and its nested stacks back to
  CloudFormation.

On export, each cdkd stack becomes its own CloudFormation stack. cdkd submits
a separate IMPORT changeset for each one, starting with the innermost. There
is no single-changeset form, because CloudFormation rejects
`--include-nested-stacks` on an IMPORT changeset.

## Wait condition handles

`AWS::CloudFormation::WaitConditionHandle` works as a placeholder only. Its
real value, a pre-signed URL that receives signals, cannot exist outside
CloudFormation. cdkd records a placeholder id and calls no AWS API. That is
enough for a template that uses a handle as an empty placeholder resource.

`AWS::CloudFormation::WaitCondition`, which blocks until a signal arrives, is
not supported.

## Glue table Iceberg support (`IcebergTableInput` is refused)

cdkd can create an Apache Iceberg table with `AWS::Glue::Table` in one shape
only. The table metadata goes in `TableInput`, and `IcebergInput` carries
nothing but the instruction to create:

```ts
new glue.CfnTable(this, 'IcebergTable', {
  catalogId: this.account,
  databaseName: database.ref,
  openTableFormatInput: {
    // version: '2' is also accepted
    icebergInput: { metadataOperation: 'CREATE' },
  },
  tableInput: {
    name: 'events_iceberg',
    // required: Iceberg tables must be EXTERNAL_TABLE
    tableType: 'EXTERNAL_TABLE',
    storageDescriptor: {
      location: 's3://your-bucket/iceberg/events/',
      columns: [{ name: 'event_id', type: 'string' }],
    },
  },
});
```

Glue then writes the Iceberg metadata itself. The table comes back with
`Parameters.table_type = ICEBERG` and a populated
`Parameters.metadata_location`.

### What cdkd refuses

The other shape puts a nested table specification, `IcebergTableInput`,
inside `OpenTableFormatInput.IcebergInput`. Its SDK spelling is
`CreateIcebergTableInput`. On create, cdkd refuses a template that carries
it. The deploy fails before any AWS call, and the error names the working
shape above.

AWS accepts that specification on neither path, so nothing that works is
lost. CloudFormation forwards the property and then rolls the stack back.

An ordinary CDK app cannot produce the property. The L1
`CfnTable.IcebergInputProperty` declares only `metadataOperation` and
`version`, and synthesis drops members it does not declare. The property
reaches a deploy only from:

- a hand-written CloudFormation template,
- a `cdkd import --migrate-from-cloudformation` of such a template,
- an explicit
  `addPropertyOverride('OpenTableFormatInput.IcebergInput.IcebergTableInput', …)`.

### Edge cases

- **`cdkd rollback`** does not refuse. A rollback works from cdkd state and
  not from your template, so it warns and continues. A table that the
  rollback of a failed replacement brings back either comes back without its
  Iceberg metadata, or that one operation fails. Fix it by deploying the
  working shape with `cdkd deploy`.
- **A table recorded `provisionedBy: cc-api`** in state is deployed through
  Cloud Control, which forwards the property. The deploy fails later, with
  CloudFormation's rollback message.

The AWS errors and the rollback paths are described in
[Supported Resources internals](supported-resources-internals.md#glue-iceberg-refusal).

## Glue table / database: AWS-managed `Parameters` survive an update

When you change a Glue table or database, cdkd keeps the entries that AWS
wrote into it and that your template never mentioned. Without that, an
unrelated edit would erase them.

The reason is how Glue updates work. `UpdateTable` and `UpdateDatabase`
replace `TableInput` and `DatabaseInput` as a whole, so anything the request
leaves out is erased. AWS writes into `Parameters` itself: an Iceberg table's
`table_type` and `metadata_location`, or a crawler's `classification`. A
crawler also writes into `StorageDescriptor`.

So, immediately before an update, cdkd reads the table or database from AWS.
It adds back every entry that appears in neither your new template nor the
template you deployed last. It applies the same rule to each member of
`StorageDescriptor`, and merges the two `Parameters` maps inside it key by
key.

### What this means for you

- **Your removals still work.** A parameter you delete from your template is
  deleted in AWS. Only keys you never wrote are restored.
- **An entry added outside your template stays.** cdkd cannot tell an entry
  AWS wrote from one someone added in the console, so it keeps both.
  `cdkd drift` stops reporting such an entry after the next deploy.
- **The deploy needs `glue:GetTable` or `glue:GetDatabase`.** If the read
  fails for any reason other than "not found", cdkd refuses the update and
  names the missing action.
- **A concurrent write to a table fails the deploy.** cdkd sends the table's
  `VersionId` with `UpdateTable`, so an Iceberg commit that lands in between
  is not overwritten. Run the deploy again.
- **A concurrent write to a database is not detected.** `UpdateDatabase` has
  no `VersionId`, so such a write can be overwritten.

### Remove an entry that was added outside your template

Delete it directly, with `aws glue update-table` or in the console. Or
declare it in your template, deploy, and then remove it from the template,
which makes it an ordinary removal. `cdkd drift --revert` also still clears
entries added in the console.

### Limits of the `StorageDescriptor` merge

- cdkd treats `SerdeInfo` as one block. Removing it from the template removes
  it in AWS.
- Only `StorageDescriptor` is merged. A crawler also writes `PartitionKeys`
  and `Owner`, and for those your template wins.
- A template that never declared `StorageDescriptor` keeps the whole block as
  AWS holds it.

More detail is in
[Supported Resources internals](supported-resources-internals.md#glue-parameter-preservation).

## Related

- [Supported Resources](supported-resources.md): the list of types
- [cdkd destroy](cli-destroy.md): `--remove-protection` and the
  other destroy flags
- [Importing Existing Resources](import.md): adopting existing resources,
  nested stacks included
- [Exporting to CloudFormation](export.md): handing a stack back
