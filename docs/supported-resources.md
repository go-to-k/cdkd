---
title: Supported Resources
description: "Which AWS resource types cdkd can deploy, which of them have a fast SDK provider, and the per-type behaviour to know before you deploy or destroy."
---

# Supported Resources

cdkd can deploy a resource type in one of two ways. The types listed on this
page have an **SDK provider**: cdkd calls the service API directly, which is
the fast path. Almost every other type goes through the **Cloud Control API**,
which is slower but needs no code in cdkd. A small set of types AWS marks as
not provisionable is refused.

## Is my resource type supported?

Search this page for the type, for example `AWS::Lambda::Function`.

| Your type is | What cdkd does | Where to look |
| --- | --- | --- |
| In the [table below](#resource-types) | Creates, updates and deletes it with an SDK provider | [Per-type behaviour notes](#per-type-behaviour-notes) for caveats |
| Not on this page | Uses the Cloud Control API | [Provisioning Layers](provisioning-layers.md) |
| `NON_PROVISIONABLE` in AWS, with no SDK provider | Refuses the deploy before touching any resource | [Types cdkd refuses](#types-cdkd-refuses) |
| A `Custom::*` resource | Invokes its Lambda or SNS backing with cdkd's own provider | |

The [provider coverage matrix](_generated/provider-coverage.md) lists every
public CloudFormation resource type with its tier: Tier 1 (SDK provider),
Tier 2 (Cloud Control) or Tier 3 (unsupported). It is generated, and its
[JSON form](_generated/provider-coverage.json) is machine-readable.

Whether `cdkd import` can adopt a type is a separate question, answered in
[Importing Existing Resources](import.md#provider-coverage).

## Resource types

Every type in this table has an SDK provider. Rows are sorted by the service
part of the type name.

| Service | Resource types |
| --- | --- |
| ApiGateway | `AWS::ApiGateway::Account`, `AWS::ApiGateway::Authorizer`, `AWS::ApiGateway::Deployment`, `AWS::ApiGateway::Method`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Stage` |
| ApiGatewayV2 | `AWS::ApiGatewayV2::Api`, `AWS::ApiGatewayV2::Authorizer`, `AWS::ApiGatewayV2::Integration`, `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Stage` |
| AppSync | `AWS::AppSync::ApiKey`, `AWS::AppSync::DataSource`, `AWS::AppSync::GraphQLApi`, `AWS::AppSync::GraphQLSchema`, `AWS::AppSync::Resolver` |
| AutoScaling | `AWS::AutoScaling::AutoScalingGroup` |
| BedrockAgentCore | `AWS::BedrockAgentCore::Browser`, `AWS::BedrockAgentCore::CodeInterpreter`, `AWS::BedrockAgentCore::Evaluator`, `AWS::BedrockAgentCore::Runtime` |
| Budgets | `AWS::Budgets::Budget` |
| CertificateManager | `AWS::CertificateManager::Certificate` |
| CloudFormation | `AWS::CloudFormation::Stack`, `AWS::CloudFormation::WaitConditionHandle` |
| CloudFront | `AWS::CloudFront::CloudFrontOriginAccessIdentity`, `AWS::CloudFront::Distribution`, `AWS::CloudFront::OriginAccessControl` |
| CloudTrail | `AWS::CloudTrail::Trail` |
| CloudWatch | `AWS::CloudWatch::Alarm`, `AWS::CloudWatch::AnomalyDetector` |
| CodeBuild | `AWS::CodeBuild::Project` |
| CodeCommit | `AWS::CodeCommit::Repository` |
| Cognito | `AWS::Cognito::UserPool` |
| DLM | `AWS::DLM::LifecyclePolicy` |
| DocDB | `AWS::DocDB::DBCluster`, `AWS::DocDB::DBInstance`, `AWS::DocDB::DBSubnetGroup` |
| DynamoDB | `AWS::DynamoDB::GlobalTable`, `AWS::DynamoDB::Table` |
| EC2 | `AWS::EC2::EIP`, `AWS::EC2::Instance`, `AWS::EC2::InternetGateway`, `AWS::EC2::NatGateway`, `AWS::EC2::NetworkAcl`, `AWS::EC2::NetworkAclEntry`, `AWS::EC2::Route`, `AWS::EC2::RouteTable`, `AWS::EC2::SecurityGroup`, `AWS::EC2::SecurityGroupIngress`, `AWS::EC2::Subnet`, `AWS::EC2::SubnetNetworkAclAssociation`, `AWS::EC2::SubnetRouteTableAssociation`, `AWS::EC2::VPC`, `AWS::EC2::VPCGatewayAttachment` |
| ECR | `AWS::ECR::Repository` |
| ECS | `AWS::ECS::Cluster`, `AWS::ECS::Service`, `AWS::ECS::TaskDefinition` |
| EFS | `AWS::EFS::AccessPoint`, `AWS::EFS::FileSystem`, `AWS::EFS::MountTarget` |
| ElastiCache | `AWS::ElastiCache::CacheCluster`, `AWS::ElastiCache::SubnetGroup` |
| ElasticLoadBalancingV2 | `AWS::ElasticLoadBalancingV2::Listener`, `AWS::ElasticLoadBalancingV2::LoadBalancer`, `AWS::ElasticLoadBalancingV2::TargetGroup` |
| EMR | `AWS::EMR::Cluster`, `AWS::EMR::InstanceFleetConfig`, `AWS::EMR::InstanceGroupConfig` |
| Events | `AWS::Events::EventBus`, `AWS::Events::Rule` |
| FSx | `AWS::FSx::FileSystem` |
| Glue | `AWS::Glue::Connection`, `AWS::Glue::Crawler`, `AWS::Glue::Database`, `AWS::Glue::Job`, `AWS::Glue::SecurityConfiguration`, `AWS::Glue::Table`, `AWS::Glue::Trigger`, `AWS::Glue::Workflow` |
| IAM | `AWS::IAM::AccessKey`, `AWS::IAM::Group`, `AWS::IAM::InstanceProfile`, `AWS::IAM::ManagedPolicy`, `AWS::IAM::Policy`, `AWS::IAM::Role`, `AWS::IAM::User`, `AWS::IAM::UserToGroupAddition` |
| Kinesis | `AWS::Kinesis::Stream`, `AWS::Kinesis::StreamConsumer` |
| KinesisFirehose | `AWS::KinesisFirehose::DeliveryStream` |
| KMS | `AWS::KMS::Alias`, `AWS::KMS::Key` |
| Lambda | `AWS::Lambda::EventInvokeConfig`, `AWS::Lambda::EventSourceMapping`, `AWS::Lambda::Function`, `AWS::Lambda::LayerVersion`, `AWS::Lambda::MicrovmImage`, `AWS::Lambda::Permission`, `AWS::Lambda::Url` |
| Logs | `AWS::Logs::LogGroup` |
| Neptune | `AWS::Neptune::DBCluster`, `AWS::Neptune::DBInstance`, `AWS::Neptune::DBSubnetGroup` |
| Pipes | `AWS::Pipes::Pipe` |
| RDS | `AWS::RDS::DBCluster`, `AWS::RDS::DBInstance`, `AWS::RDS::DBProxy`, `AWS::RDS::DBProxyEndpoint`, `AWS::RDS::DBProxyTargetGroup`, `AWS::RDS::DBSubnetGroup` |
| Route53 | `AWS::Route53::HostedZone`, `AWS::Route53::RecordSet` |
| S3 | `AWS::S3::Bucket`, `AWS::S3::BucketPolicy` |
| S3Express | `AWS::S3Express::DirectoryBucket` |
| S3Tables | `AWS::S3Tables::Namespace`, `AWS::S3Tables::Table`, `AWS::S3Tables::TableBucket` |
| S3Vectors | `AWS::S3Vectors::VectorBucket` |
| Scheduler | `AWS::Scheduler::Schedule` |
| SecretsManager | `AWS::SecretsManager::Secret` |
| ServiceDiscovery | `AWS::ServiceDiscovery::HttpNamespace`, `AWS::ServiceDiscovery::PrivateDnsNamespace`, `AWS::ServiceDiscovery::PublicDnsNamespace`, `AWS::ServiceDiscovery::Service` |
| SNS | `AWS::SNS::Subscription`, `AWS::SNS::Topic`, `AWS::SNS::TopicPolicy` |
| SQS | `AWS::SQS::Queue`, `AWS::SQS::QueuePolicy` |
| SSM | `AWS::SSM::Parameter` |
| StepFunctions | `AWS::StepFunctions::StateMachine` |
| WAFv2 | `AWS::WAFv2::WebACL` |

The layer is chosen per resource on each deploy, not fixed by the type. A
resource of a listed type still goes through Cloud Control when its template
sets a property the SDK provider does not write.

## Properties an SDK provider does not write

AWS adds properties to existing resource types regularly, and an SDK provider
writes only the properties it was built for. cdkd checks every top-level
property of a listed type against what its provider writes, before the deploy
starts:

| The template sets | What happens |
| --- | --- |
| Only properties the provider writes | The resource uses the SDK provider. |
| A property the provider does not write | That one resource is routed through Cloud Control, so the property reaches AWS. |
| A property missing from cdkd's copy of the CloudFormation schema (new, misspelled, or an `addPropertyOverride` key) | Also routed through Cloud Control, which applies a real property and rejects a misspelled one. |
| A read-only property (an AWS-managed ARN or id) | Stays on the SDK provider, with a warning. It cannot be set from a template. |

To keep such a resource on the SDK provider anyway, name the property:

```bash
cdkd deploy MyStack --prefer-sdk-route AWS::ApiGatewayV2::Api:Body
```

The named property is then not written to AWS. See
[Deploy: safety & compatibility flags](cli-deploy-safety.md) for this flag and
the exceptions, and [Provisioning Layers](provisioning-layers.md) for how a
resource moves between the two layers.

Cloud Control types need no such check: Cloud Control forwards the whole
property map to AWS.

## Types cdkd refuses

When a type has no SDK provider and AWS reports it as
`ProvisioningType: NON_PROVISIONABLE`, Cloud Control cannot manage it either.
cdkd stops at pre-flight, before any resource is touched. The error names the
type and the reason and carries a pre-filled GitHub issue link to request
support.

If AWS has since made the type provisionable, try it through Cloud Control:

```bash
cdkd deploy MyStack --allow-unsupported-types AWS::Foo::Bar,AWS::Baz::Qux
cdkd destroy MyStack --allow-unsupported-types AWS::Foo::Bar,AWS::Baz::Qux
```

The flag takes a comma-separated list of types. For a type that really is not
provisionable, Cloud Control will still fail.

### Not planned (deprecated services)

Some refused types belong to AWS services that are deprecated or retired.
cdkd will not add SDK providers for these; use the successor.

| Resource type | Reason |
| --- | --- |
| `AWS::WAF::*` (WAF Classic) | Support ended 2025-09-30. Use `AWS::WAFv2::*`: `WebACL` has an SDK provider, the rest use Cloud Control. |
| `AWS::WAFRegional::*` | Same WAF Classic family and end of support. |
| `AWS::CodeStar::GitHubRepository` | AWS CodeStar was discontinued 2024-07-31. |
| `AWS::AppMesh::*` | End of life announced for 2026-09-30. Use ECS Service Connect or VPC Lattice. |
| `AWS::Elasticsearch::Domain` | Superseded by `AWS::OpenSearchService::Domain`, which uses Cloud Control. |
| `AWS::RDS::DBSecurityGroup`, `AWS::RDS::DBSecurityGroupIngress` | EC2-Classic only; EC2-Classic retired 2022-08-15. Use VPC security groups. |
| `AWS::ElastiCache::SecurityGroup`, `AWS::ElastiCache::SecurityGroupIngress` | Same EC2-Classic family. |
| `AWS::Redshift::ClusterSecurityGroup`, `AWS::Redshift::ClusterSecurityGroupIngress` | Same EC2-Classic family. |

For any other refused type, use the issue link in the pre-flight error.

## Per-type behaviour notes

Most listed types behave as CloudFormation does. These differ, or have a
caveat on destroy:

| Type | What to know |
| --- | --- |
| `AWS::EFS::FileSystem` | [Automatic backups survive destroy](#efs-automatic-backups-survive-destroy). |
| `AWS::FSx::FileSystem` | [A final backup can outlive the stack](#fsx-final-backup-on-destroy); see also [FSx file systems](#fsx-file-systems). |
| `AWS::Glue::Table` | [`IcebergTableInput` is refused](#glue-table-iceberg-support-icebergtableinput-is-refused); [AWS-managed `Parameters` survive an update](#glue-table-database-aws-managed-parameters-survive-an-update). |
| `AWS::Glue::Database` | [AWS-managed `Parameters` survive an update](#glue-table-database-aws-managed-parameters-survive-an-update). |
| `AWS::EMR::Cluster`, `AWS::EMR::InstanceGroupConfig`, `AWS::EMR::InstanceFleetConfig` | [EMR on EC2](#emr-on-ec2): what updates in place, and delete that is a no-op for groups and fleets. |
| `AWS::BedrockAgentCore::Browser`, `AWS::BedrockAgentCore::CodeInterpreter` | [Adopt-only singletons](#bedrock-agentcore-browser-and-code-interpreter). |
| `AWS::BedrockAgentCore::Evaluator` | Changing `EvaluatorName` replaces the evaluator. Tags are updated in place. |
| `AWS::CloudFormation::Stack` | [Nested stacks](#nested-stacks) deploy, import and export. |
| `AWS::CloudFormation::WaitConditionHandle` | [A placeholder that calls no AWS API](#wait-condition-handles). |
| `AWS::Budgets::Budget` | A global API served from `us-east-1`. Changing `NotificationsWithSubscribers` updates in place; CloudFormation replaces the budget. |
| `AWS::CodeCommit::Repository` | `Code` seeds the initial commit from an S3 zip on create only. `Triggers` are applied on create and update. |

### EFS automatic backups survive destroy

Destroying an `AWS::EFS::FileSystem` calls `DeleteFileSystem`, which removes
the file system and its data. It does not touch the AWS Backup recovery points
taken while the file system existed. A destroy that reports 0 errors can
therefore leave a restorable, chargeable copy of the data behind.

This applies when the file system had automatic backups on. A template asks
for them with `BackupPolicy: { Status: ENABLED }`, which the AWS CDK emits for
`enableAutomaticBackups: true`, and cdkd applies that policy on create and
update. AWS also enables automatic backups by default for some
configurations, so check:

```bash
aws efs describe-backup-policy --file-system-id fs-XXXXXXXX --region <region>
```

AWS Backup stores the recovery points in the service-managed vault
`aws/efs/automatic-backup-vault` with a 35-day default retention. To find and
delete them, note the file system id (from deploy output or cdkd state) and
run:

```bash
aws backup list-recovery-points-by-backup-vault \
  --backup-vault-name aws/efs/automatic-backup-vault --region <region> \
  --query "RecoveryPoints[?contains(ResourceArn, 'fs-XXXXXXXX')].{Arn:RecoveryPointArn,Created:CreationDate,Status:Status}" \
  --output table

aws backup delete-recovery-point --region <region> \
  --backup-vault-name aws/efs/automatic-backup-vault \
  --recovery-point-arn <RecoveryPointArn>
```

> [!CAUTION]
> The recovery points are the only remaining copy of the file system's data.
> Leave them if the destroy was a mistake. Delete them when the data must not
> outlive the stack.

### FSx final backup on destroy

Destroying an `AWS::FSx::FileSystem` calls `DeleteFileSystem` with API
defaults, as CloudFormation does. For Windows and ONTAP file systems the
default is to take a final backup on delete (observed on OpenZFS as well;
SCRATCH Lustre deployments take none). A destroy that reports 0 errors can
therefore leave a chargeable backup behind.

- `AutomaticBackupRetentionDays: 0` does not prevent the final backup. It
  disables only scheduled backups.
- The final backup is typically untagged, because `CopyTagsToBackups` defaults
  to false. A tag-based sweep will not find it. Select by the backup's
  `FileSystem.FileSystemId`.

To find and delete a leftover final backup, note the file system id (from
deploy output or cdkd state) and run:

```bash
aws fsx describe-backups --region <region> \
  --query 'Backups[?FileSystem.FileSystemId==`fs-XXXXXXXX`].{Id:BackupId,Lifecycle:Lifecycle,Type:FileSystem.FileSystemType,Created:CreationTime}' \
  --output table
aws fsx delete-backup --backup-id backup-XXXXXXXX --region <region>
```

If the file system id is no longer known, list all backups
(`aws fsx describe-backups`) and review untagged entries by creation time and
storage capacity.

### FSx file systems

`AWS::FSx::FileSystem` covers all four variants: Lustre, Windows, ONTAP and
OpenZFS. AWS marks the type `NON_PROVISIONABLE`, so there is no Cloud Control
fallback for it.

| Aspect | Behaviour |
| --- | --- |
| Update | Properties `UpdateFileSystem` accepts change in place. A change to an immutable sub-property is rejected with a pointer to `--replace`. |
| Create and delete | cdkd waits for `AVAILABLE` and for the file system to be gone; the per-resource timeout for this type is one hour. |
| Drift | All four variant config blocks are compared. Not compared: `WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.Password`, `OntapConfiguration.FsxAdminPassword` and `OpenZFSConfiguration.RootVolumeConfiguration`, which AWS never returns. |

### EMR on EC2

The three EMR types are `NON_PROVISIONABLE` in AWS, so there is no Cloud
Control fallback for them. Each has a one-hour per-resource timeout.

| Type | Updates in place | Delete |
| --- | --- | --- |
| `AWS::EMR::Cluster` | Termination protection, visibility, step concurrency, managed scaling, auto-termination, tags | Terminates the cluster and waits for `TERMINATED` |
| `AWS::EMR::InstanceGroupConfig` | `InstanceCount`, `AutoScalingPolicy` | No AWS API: drops cdkd state only |
| `AWS::EMR::InstanceFleetConfig` | `TargetOnDemandCapacity`, `TargetSpotCapacity`, `ResizeSpecifications`, `InstanceTypeConfigs` | No AWS API: drops cdkd state only |

Any other property change replaces the resource. A create waits for
`WAITING` or `RUNNING` (cluster) or `RUNNING` (group, fleet).

An instance group or fleet is released only when its parent cluster
terminates. On delete cdkd makes a best-effort scale to 0 for a `TASK` group
or fleet and drops the state record.

`cdkd destroy --remove-protection` turns a cluster's termination protection
off before terminating it.

### Bedrock AgentCore browser and code interpreter

`AWS::BedrockAgentCore::Browser` and `AWS::BedrockAgentCore::CodeInterpreter`
represent the AWS-managed defaults `aws.browser.v1` and
`aws.codeinterpreter.v1`. cdkd adopts the default on create (`GetBrowser`,
`GetCodeInterpreter`), and delete is a no-op.

A custom browser or interpreter is a different type,
`AWS::BedrockAgentCore::BrowserCustom` or
`AWS::BedrockAgentCore::CodeInterpreterCustom`, and uses Cloud Control.

### Nested stacks

`AWS::CloudFormation::Stack` is supported in three directions: a
`cdkd deploy`, a recursive
[`cdkd import --migrate-from-cloudformation`](import.md#migrating-from-cdk-deploy-cloudformation-to-cdkd),
and a recursive [`cdkd export`](export.md).

On export, each cdkd-managed stack becomes its own CloudFormation stack
through a separate IMPORT changeset, submitted leaf-first. CloudFormation
rejects `--include-nested-stacks` on an IMPORT changeset, so there is no
single-changeset form.

### Wait condition handles

`AWS::CloudFormation::WaitConditionHandle` is a placeholder. The real
pre-signed signal URL cannot exist outside CloudFormation, so cdkd records an
opaque placeholder id and calls no AWS API. That is enough for templates that
use a handle as an empty placeholder resource.

`AWS::CloudFormation::WaitCondition`, which blocks until a signal arrives, is
not supported.

### Glue table Iceberg support (`IcebergTableInput` is refused)

`AWS::Glue::Table` can create Apache Iceberg tables in one shape only: table
metadata in `TableInput`, and `IcebergInput` carrying just the create-time
directive.

```ts
new glue.CfnTable(this, 'IcebergTable', {
  catalogId: this.account,
  databaseName: database.ref,
  openTableFormatInput: {
    icebergInput: { metadataOperation: 'CREATE' }, // version: '2' is also accepted
  },
  tableInput: {
    name: 'events_iceberg',
    tableType: 'EXTERNAL_TABLE', // required: Iceberg tables must be EXTERNAL_TABLE
    storageDescriptor: {
      location: 's3://your-bucket/iceberg/events/',
      columns: [{ name: 'event_id', type: 'string' }],
    },
  },
});
```

Glue then writes the Iceberg metadata itself: the table comes back with
`Parameters.table_type = ICEBERG` and a populated
`Parameters.metadata_location`.

On create, cdkd refuses a template whose `OpenTableFormatInput.IcebergInput`
carries the nested table spec `IcebergTableInput` (or its SDK spelling
`CreateIcebergTableInput`). It fails at pre-flight, before any AWS call, with
an error naming the working shape. CloudFormation instead forwards the
property and rolls the stack back, because AWS accepts that spec on neither
path.

An ordinary CDK app cannot emit the property. The L1
`CfnTable.IcebergInputProperty` declares only `metadataOperation` and
`version`, and undeclared members are dropped at synthesis. It reaches a
deploy only from a hand-written CloudFormation template, a
`cdkd import --migrate-from-cloudformation` of one, or an explicit
`addPropertyOverride('OpenTableFormatInput.IcebergInput.IcebergTableInput', …)`.

Two cases do not get the refusal:

| Case | What happens |
| --- | --- |
| `cdkd rollback` | It replays from state, not your template, so it warns and continues. A table revived by the rollback of a failed replacement comes back without its Iceberg metadata, or that one operation fails. Fix forward with `cdkd deploy` and the working shape. |
| A table recorded `provisionedBy: cc-api` | Cloud Control forwards the property and the deploy fails later, with CloudFormation's rollback message. |

The AWS-side errors and the rollback paths are detailed in
[Supported Resources internals](supported-resources-internals.md#glue-iceberg-refusal).

### Glue table / database: AWS-managed `Parameters` survive an update

Glue's `UpdateTable` and `UpdateDatabase` replace `TableInput` and
`DatabaseInput` wholesale: whatever the request omits is erased. AWS itself
writes into `Parameters` (an Iceberg table's `table_type` and
`metadata_location`, a crawler's `classification`), and a crawler writes into
`StorageDescriptor`. An update that sent only your template's values would
erase those.

cdkd therefore reads the live table or database just before an update and
merges back the entries that appear in neither your new template nor the last
deployed one. The same rule applies to each member of `StorageDescriptor`,
with its two nested `Parameters` bags merged per key.

| Consequence | Detail |
| --- | --- |
| Your removals still work | A parameter you delete from your template is deleted on AWS. Only keys you never authored are restored. |
| An entry added outside your template stays | cdkd cannot tell an entry AWS wrote from one added in the console, so both are preserved. `cdkd drift` stops reporting it after the next deploy. |
| The deploy identity needs `glue:GetTable` / `glue:GetDatabase` | If the read fails for any reason other than "not found", the update is refused, naming the missing action. |
| A concurrent table write fails the deploy | cdkd sends `UpdateTable`'s `VersionId` precondition, so an Iceberg commit landing in between is not overwritten. Run the deploy again. |
| Databases have no such guard | `UpdateDatabase` has no `VersionId`, so a concurrent database write can be overwritten. |

To remove an entry that was added outside your template, delete it directly
(`aws glue update-table` or the console). Or declare it in your template,
deploy, then remove it from the template, which makes it an ordinary removal.
`cdkd drift --revert` still clears console-side additions.

Two limits of the `StorageDescriptor` merge:

- `SerdeInfo` is treated as one block. Removing it from the template removes
  it on AWS.
- Only the `StorageDescriptor` subtree is merged. A crawler also writes
  `PartitionKeys` and `Owner`, and for those the template wins.

A template that never declared `StorageDescriptor` carries the whole live
block forward. More detail is in
[Supported Resources internals](supported-resources-internals.md#glue-parameter-preservation).

## Related

- [Provisioning Layers](provisioning-layers.md): how cdkd chooses between an
  SDK provider and Cloud Control for one resource
- [Importing Existing Resources](import.md): which types `cdkd import` can
  adopt, and what to pass for each
- [Feature Parity](supported-features.md): intrinsic functions, pseudo
  parameters and the rest of the CloudFormation surface
- [Deploy: safety & compatibility flags](cli-deploy-safety.md): the flags for
  an unsupported type or property
