---
title: Per-Type Behaviour Notes
description: "Resource types whose behaviour under cdkd differs from CloudFormation or leaves something behind on destroy: EFS, FSx, EMR, Bedrock AgentCore, nested stacks, wait condition handles, Glue and CloudFront."
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
charges for it. cdkd calls `DeleteFileSystem` with the API's final-backup
defaults, as CloudFormation does (the only delete-time property it sends is a
declared OpenZFS `OpenZFSConfiguration.Options`), and for Windows and ONTAP
file systems the default is to take a final backup. The same was observed on
OpenZFS. A SCRATCH Lustre deployment takes none.

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

- **Update.** A property that `UpdateFileSystem` accepts changes in place.
  So does a Windows `Aliases` list, through `AssociateFileSystemAliases` and
  `DisassociateFileSystemAliases`. cdkd first waits until no other
  administrative action runs on the file system (a storage or IOPS
  optimization is not waited for; it can take hours), re-sends a call FSx
  refuses while an administrative action is in progress, and waits until the
  aliases read back as declared. A change to a property that cannot change is rejected, and the
  error points to `--replace`. That includes Windows `ActiveDirectoryId` and
  `PreferredSubnetId`, which no FSx API can change.
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
providers. `AWS::EMR::Cluster` has Cloud Control handlers (`FULLY_MUTABLE`)
since its registry version created on 2024-10-15, so a cluster whose template
sets a property the SDK provider does not know yet is deployed through Cloud
Control instead. `AWS::EMR::InstanceGroupConfig` and
`AWS::EMR::InstanceFleetConfig` have been `FULLY_MUTABLE`, with Cloud Control
handlers, since registry versions created on 2025-10-23 (`aws cloudformation
describe-type --type RESOURCE --type-name <type>`); cdkd still deploys them with
its SDK providers. Each has a one-hour timeout per resource.

| Type | Updates in place | Delete |
| --- | --- | --- |
| `AWS::EMR::Cluster` | Termination protection, visibility, step concurrency, managed scaling, auto-termination, tags; in `Instances`: a core or task group's `InstanceCount` and `AutoScalingPolicy`, a core or task fleet's target capacities, `UnhealthyNodeReplacement` | Terminates the cluster and waits for `TERMINATED` |
| `AWS::EMR::InstanceGroupConfig` | `InstanceCount`, `AutoScalingPolicy` | Removes the cdkd state record only |
| `AWS::EMR::InstanceFleetConfig` | `TargetOnDemandCapacity`, `TargetSpotCapacity`, `ResizeSpecifications`, `InstanceTypeConfigs` | Removes the cdkd state record only |

Any other property change replaces the resource, as CloudFormation does,
including most changes inside a cluster's `Instances` (measured: a security
group added, a task group added, `KeepJobFlowAliveWhenNoSteps` turned off).
CloudFormation applies the `Instances` changes in the table in place, and so
does cdkd: a resize waits until the group or fleet reaches its new size. A
task group or fleet is found by its `Name`, or a task group without one by its
instance type; cdkd refuses the update when that matches more or fewer than
one, or when the `Name` (or that instance type) is a `{{resolve:...}}`
reference. A fleet capacity the
template never declared is sent as 0, since `ModifyInstanceFleet` needs both.
Removing a fleet capacity, or `UnhealthyNodeReplacement`, is refused, because
CloudFormation fails that update too, and so is removing a group's
`InstanceCount`, which CloudFormation requires; so is a count or capacity that is not a
number. A create
waits until a cluster is `WAITING` or `RUNNING`, and until a group or fleet is
`RUNNING`.

Deleting an instance group or fleet does not remove it from AWS, because EMR
releases a group or fleet only when its cluster terminates. cdkd removes the
state record. For a `TASK` group or fleet it first tries to scale it to 0,
and continues if that fails. A `TASK` group that declares an `AutoScalingPolicy`
has the policy removed before that, as CloudFormation does, so the policy's
alarm and scaling target do not outlive the group.

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

An `AWS::CloudFormation::WaitConditionHandle`'s `Ref` is a pre-signed S3 URL,
as under CloudFormation. cdkd signs it for one key in its own state bucket, so
user data can signal it with `cfn-signal` or `curl -X PUT`.
`AWS::CloudFormation::WaitCondition` then waits for the signals:

| Behaviour | cdkd |
| --- | --- |
| Completes when | `Count` distinct `UniqueId`s have sent `"Status": "SUCCESS"` |
| Fails when | a `"Status": "FAILURE"` signal arrives, or `Timeout` seconds pass |
| `Fn::GetAtt <wait>.Data` | a JSON string: an object of each `UniqueId` to its `Data` |
| A signal sent before the wait starts | counts |
| Changing `Handle`, `Count` or `Timeout` | waits again, counting the signals the handle already holds |
| Destroying the handle | deletes the signals it received |

Changing a wait condition's properties is an update CloudFormation refuses;
cdkd waits again instead. To wait for fresh signals, give the handle a new
logical id as well, so the wait starts from an empty handle.

```ts
const handle = new CfnWaitConditionHandle(this, 'Handle');
instance.addUserData(
  `curl -X PUT -H 'Content-Type:' --data-binary '{"Status":"SUCCESS","UniqueId":"boot","Data":"ok","Reason":"done"}' "${handle.ref}"`
);
new CfnWaitCondition(this, 'Wait', { handle: handle.ref, timeout: '900' });
```

Limits:

- The URL is valid for 12 hours, as CloudFormation's is. It is signed with the
  deploying credentials, so temporary credentials (SSO, an assumed role) that
  expire sooner end it sooner; cdkd warns when they do.
- The instance must reach Amazon S3, as it must under CloudFormation.
- A wait condition without a `Handle` (the `CreationPolicy` form that
  `cfn-signal --resource` signals) waits through the deploy's signal receiver;
  see [`CreationPolicy` and `cfn-init`](supported-features.md#creationpolicy-and-cfn-init).
- A wait condition on a handle whose id is a URL cdkd did not issue (one
  imported from CloudFormation) is refused: give the handle a new logical id
  so cdkd issues one.
- A wait condition runs after every resource that references its handle,
  without a `DependsOn`, so it never holds a `--concurrency` slot while the
  instance that signals it waits for one.
- A handle that only serves as a placeholder resource still works: nothing
  needs to signal it.

Changed in v0.359.0: a handle's `Ref` is a signal URL. A handle deployed by an
earlier release keeps its placeholder id until a wait condition in the
template waits on it; that deploy issues its URL and updates the resources
embedding it (an EC2 instance's `UserData` change stops and starts it). An
instance that already booted does not run its user data again, so it signals
the new URL only once it is replaced, as under CloudFormation when a wait
condition is added to a running stack.

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

## CloudFront origin TLS protocols survive a removal

When an update leaves a custom origin's `OriginSSLProtocols` out of an
`AWS::CloudFront::Distribution` template, cdkd keeps the protocols the origin
already has. This includes removing it from a template that declared it.
CloudFormation instead resets it to its default, `SSLv3` and `TLSv1`, which
would turn SSLv3 back on. cdkd warns when it keeps a value the previous
template declared. A rollback that restores a template without
`OriginSSLProtocols` puts back the value the origin held before the failed
deploy, read from the snapshot cdkd recorded after the last successful deploy.
When that snapshot has no usable value for the origin, the rollback leaves the
value the failed deploy applied, and says so. To change the protocols, declare
`OriginSSLProtocols`. A
custom origin that is new in the update gets what CloudFront records at
create: `TLSv1`, `TLSv1.1` and `TLSv1.2`.

## Related

- [Supported Resources](supported-resources.md): the list of types
- [cdkd destroy](cli-destroy.md): `--remove-protection` and the
  other destroy flags
- [Import Existing Resources](import.md): adopting existing resources,
  nested stacks included
- [Hand a Stack to CloudFormation](export.md): handing a stack back
