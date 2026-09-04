---
title: Supported Resources
description: "Every AWS resource type cdkd can deploy and manage, grouped by category — SDK Provider vs Cloud Control API coverage per type."
---

# Supported Resources

This document lists every AWS resource type cdkd can deploy and manage,
grouped by category. Use it to confirm whether your CDK stack will work
with cdkd before installing.

For the import-side view of these providers (which can be auto-discovered
by `aws:cdk:path` tag vs which require `--resource` overrides), see
[Importing Existing Resources](import.md).

## Provider strategy

cdkd uses a hybrid approach:

- **SDK Provider** — direct AWS SDK calls with no polling overhead.
  Preferred for performance.
- **Cloud Control API** — fallback for any resource type without a
  dedicated SDK Provider. Requires async polling.

If a resource type has no SDK Provider AND AWS reports it as
`ProvisioningType: NON_PROVISIONABLE` (Tier 3 — Cloud Control API cannot
manage it), cdkd **rejects it at pre-flight** before any resource is touched,
with a clear per-type error naming the type, the reason, and a 1-click
pre-filled GitHub issue link to request support. The Tier 3 set is generated
from the provider-coverage audit into the runtime.

To attempt deployment anyway (Cloud Control will likely still fail for a
genuinely NON_PROVISIONABLE type, but this is the escape hatch for a type the
cached audit marks Tier 3 that AWS has since made provisionable), re-run with
`--allow-unsupported-types <Type,...>` — a per-type, comma-separated list on
both `cdkd deploy` and `cdkd destroy`.

## Property-level coverage (Tier 1 SDK providers)

A type being on this list means cdkd's SDK provider can create / update /
delete the resource — it does NOT guarantee every CFn property is written
to AWS. AWS adds new properties to existing resource types regularly
(e.g. `CapacityProviderConfig` on `AWS::Lambda::Function`), and a provider that does
not yet read the new property would silently drop it on write — your
deployed resource would be missing the field with no error surfaced.

cdkd rejects this at **pre-flight**. For every Tier 1 type, the runtime
compares each top-level template property against the provider's declared
`handledProperties` (= written to AWS) / `unhandledByDesign` (= not written,
with a rationale) sets. Any unhandled top-level property in the CFn schema
triggers a fast-fail with the silently-dropped property name, the
rationale, a 1-click GitHub issue link to request support, and the exact
`--allow-unsupported-properties <ResourceType>:<PropertyName>` re-run
command. The escape hatch itself is documented under
[`--allow-unsupported-properties`](cli-deploy-safety.md#allow-unsupported-properties-deploy).

Coverage data is generated from the CFn schema fixtures + each SDK
provider's declarations into the runtime, and CI fails if it drifts. Tier 2 (Cloud Control) types are NOT in the map:
Cloud Control forwards the full property map to AWS, so there is no
write-side silent drop at cdkd for those.

Properties not in the CFn schema (likely `addPropertyOverride` escape
hatches or typos) pass through silently — CFn itself tolerates them.
Read-only properties (AWS-managed Arns, Ids, etc.) also pass through
silently; they cannot be set from the template side.

## Three-tier coverage report

For a full machine-checked view of every public AWS CFn resource type
partitioned into Tier 1 (SDK Provider) / Tier 2 (CC API fallback) / Tier 3
(unsupported), see the auto-generated
[provider coverage matrix](_generated/provider-coverage.md). Its
[JSON counterpart](_generated/provider-coverage.json)
is the machine-readable source of truth.

The list below is the per-category breakdown of the SDK Provider tier; the
generated report is the complete catalog, Tier 2 and Tier 3 included.

## Resource types

Every type below has a dedicated **SDK Provider**, so cdkd creates,
updates and deletes it through the service API directly. Anything not
listed falls back to the Cloud Control API, except the types AWS reports
as `NON_PROVISIONABLE`, which cdkd refuses at pre-flight.

Categories are alphabetical.

### AI/ML

- `AWS::BedrockAgentCore::Runtime`
- `AWS::BedrockAgentCore::Browser` — [notes](#aws-bedrockagentcore-browser)
- `AWS::BedrockAgentCore::CodeInterpreter` — adopt-only singleton for the AWS-managed default `aws.codeinterpreter.v1`, same semantics as Browser; custom interpreters are `AWS::BedrockAgentCore::CodeInterpreterCustom`, served by Cloud Control
- `AWS::BedrockAgentCore::Evaluator` — LLM-as-a-Judge / code-based agent-quality evaluators; `EvaluatorName` is createOnly → replacement, tags reconciled via `TagResource`/`UntagResource`

#### `AWS::BedrockAgentCore::Browser`

adopt-only singleton — the CFn registry declares the type a read-only representation of the AWS-managed default browser `aws.browser.v1` with `NON_PROVISIONABLE` provisioning, so cdkd adopts the default via `GetBrowser` on create and no-ops delete; custom browsers are the separate `AWS::BedrockAgentCore::BrowserCustom` type, served by Cloud Control

### Analytics

- `AWS::Glue::Database` — [AWS-managed `Parameters` survive an update](#glue-table-database-aws-managed-parameters-survive-an-update)
- `AWS::Glue::Table` — [Iceberg caveat](#glue-table-iceberg-support-icebergtableinput-is-refused), [AWS-managed `Parameters` survive an update](#glue-table-database-aws-managed-parameters-survive-an-update)
- `AWS::Glue::Job`
- `AWS::Glue::Crawler`
- `AWS::Glue::Connection`
- `AWS::Glue::Trigger`
- `AWS::Glue::Workflow`
- `AWS::Glue::SecurityConfiguration`
- `AWS::EMR::Cluster` — [notes](#aws-emr-cluster)
- `AWS::EMR::InstanceGroupConfig` — [notes](#aws-emr-instancegroupconfig)
- `AWS::EMR::InstanceFleetConfig` — [notes](#aws-emr-instancefleetconfig)

#### `AWS::EMR::Cluster`

EMR on EC2; `NON_PROVISIONABLE` in the CFn registry so no Cloud Control fallback exists; `RunJobFlow`-backed create polled to `WAITING`/`RUNNING`, `TerminateJobFlows`-backed delete polled to `TERMINATED` — both with a self-reported 1h resource timeout; mutable surface is termination protection / visibility / step concurrency / managed-scaling / auto-termination / tags, everything else is createOnly → replacement; `--remove-protection` flips `SetTerminationProtection(false)` before terminating

#### `AWS::EMR::InstanceGroupConfig`

adds a standalone instance group to an existing cluster referenced by `JobFlowId`; `NON_PROVISIONABLE` in the CFn registry so no Cloud Control fallback exists; `AddInstanceGroups`-backed create polled to `RUNNING`, `ModifyInstanceGroups`/`PutAutoScalingPolicy` mutable surface (`InstanceCount` resize + `AutoScalingPolicy`), everything else createOnly → replacement; **delete has no standalone AWS API** — a group is released when the parent cluster terminates, so delete is a no-op that drops cdkd state (best-effort scale-to-0 for a `TASK` group); self-reported 1h resource timeout

#### `AWS::EMR::InstanceFleetConfig`

adds a standalone instance fleet to an existing cluster referenced by `ClusterId`; `NON_PROVISIONABLE` in the CFn registry so no Cloud Control fallback exists; `AddInstanceFleet`-backed create polled to `RUNNING`, `ModifyInstanceFleet` mutable surface (`TargetOnDemandCapacity`/`TargetSpotCapacity`/`ResizeSpecifications`/`InstanceTypeConfigs`), everything else createOnly → replacement; **delete has no standalone AWS API** — a fleet is released when the parent cluster terminates, so delete is a no-op that drops cdkd state (best-effort scale-to-0 for a `TASK` fleet); self-reported 1h resource timeout

### API Gateway

- `AWS::ApiGateway::Account`
- `AWS::ApiGateway::Resource`
- `AWS::ApiGateway::Deployment`
- `AWS::ApiGateway::Stage`
- `AWS::ApiGateway::Method`
- `AWS::ApiGateway::Authorizer`
- `AWS::ApiGatewayV2::Api`
- `AWS::ApiGatewayV2::Stage`
- `AWS::ApiGatewayV2::Integration`
- `AWS::ApiGatewayV2::Route`
- `AWS::ApiGatewayV2::Authorizer`

### Audit

- `AWS::CloudTrail::Trail`

### Auth

- `AWS::Cognito::UserPool`

### Backup

- `AWS::DLM::LifecyclePolicy`

### Cache

- `AWS::ElastiCache::CacheCluster`
- `AWS::ElastiCache::SubnetGroup`

### CDN

- `AWS::CloudFront::CloudFrontOriginAccessIdentity`
- `AWS::CloudFront::OriginAccessControl`
- `AWS::CloudFront::Distribution`

### CI/CD

- `AWS::CodeBuild::Project`
- `AWS::CodeCommit::Repository` — `Code` create-only S3-zip seed content unpacked into the initial commit via `CreateCommit`; `Triggers` reconciled on create + update via `PutRepositoryTriggers`

### CloudFormation

- `AWS::CloudFormation::Stack` — [notes](#aws-cloudformation-stack)
- `AWS::CloudFormation::WaitConditionHandle` — [notes](#aws-cloudformation-waitconditionhandle)

#### `AWS::CloudFormation::Stack`

nested stacks, in three directions: a fresh `cdkd deploy`, a recursive
`cdkd import --migrate-from-cloudformation` adoption, and a recursive
`cdkd export`. On export, each cdkd-managed stack becomes its own
CloudFormation stack through a separate IMPORT changeset, submitted leaf-first;
a non-leaf parent then adopts its just-imported children with AWS's documented
"nest an existing stack" pattern. CloudFormation rejects
`--include-nested-stacks` on an IMPORT changeset, so there is no single-changeset
form of this

#### `AWS::CloudFormation::WaitConditionHandle`

no-op placeholder — outside CloudFormation the real pre-signed signal URL cannot exist, so cdkd synthesizes an opaque placeholder physical id and calls no AWS API; sufficient for the empty-template-placeholder usage e.g. `cdk-multi-region-stack`. `AWS::CloudFormation::WaitCondition` — the blocking signal-wait — remains unsupported

### Compute

- `AWS::Lambda::Function`
- `AWS::Lambda::Permission`
- `AWS::Lambda::Url`
- `AWS::Lambda::EventSourceMapping`
- `AWS::Lambda::LayerVersion`
- `AWS::Lambda::EventInvokeConfig`
- `AWS::Lambda::MicrovmImage`
- `AWS::EC2::Instance`
- `AWS::AutoScaling::AutoScalingGroup`

### Container

- `AWS::ECS::Cluster`
- `AWS::ECS::TaskDefinition`
- `AWS::ECS::Service`
- `AWS::ECR::Repository`

### Cost Management

- `AWS::Budgets::Budget` — global API served from us-east-1; `update` reconciles `NotificationsWithSubscribers` in place instead of CloudFormation's whole-budget replacement

### Database

- `AWS::DynamoDB::Table`
- `AWS::DynamoDB::GlobalTable`
- `AWS::RDS::DBSubnetGroup`
- `AWS::RDS::DBCluster`
- `AWS::RDS::DBInstance`
- `AWS::RDS::DBProxy`
- `AWS::RDS::DBProxyEndpoint`
- `AWS::RDS::DBProxyTargetGroup`
- `AWS::DocDB::DBSubnetGroup`
- `AWS::DocDB::DBCluster`
- `AWS::DocDB::DBInstance`
- `AWS::Neptune::DBSubnetGroup`
- `AWS::Neptune::DBCluster`
- `AWS::Neptune::DBInstance`

### Discovery

- `AWS::ServiceDiscovery::PrivateDnsNamespace`
- `AWS::ServiceDiscovery::HttpNamespace`
- `AWS::ServiceDiscovery::PublicDnsNamespace`
- `AWS::ServiceDiscovery::Service`

### DNS

- `AWS::Route53::HostedZone`
- `AWS::Route53::RecordSet`

### Encryption

- `AWS::KMS::Key`
- `AWS::KMS::Alias`

### Events

- `AWS::Events::Rule`
- `AWS::Events::EventBus`
- `AWS::Scheduler::Schedule`

### GraphQL

- `AWS::AppSync::GraphQLApi`
- `AWS::AppSync::GraphQLSchema`
- `AWS::AppSync::DataSource`
- `AWS::AppSync::Resolver`
- `AWS::AppSync::ApiKey`

### IAM

- `AWS::IAM::Role`
- `AWS::IAM::Policy`
- `AWS::IAM::ManagedPolicy`
- `AWS::IAM::InstanceProfile`
- `AWS::IAM::User`
- `AWS::IAM::Group`
- `AWS::IAM::UserToGroupAddition`
- `AWS::IAM::AccessKey`

### Load Balancing

- `AWS::ElasticLoadBalancingV2::LoadBalancer`
- `AWS::ElasticLoadBalancingV2::TargetGroup`
- `AWS::ElasticLoadBalancingV2::Listener`

### Messaging

- `AWS::SQS::Queue`
- `AWS::SQS::QueuePolicy`
- `AWS::SNS::Topic`
- `AWS::SNS::Subscription`
- `AWS::SNS::TopicPolicy`

### Monitoring

- `AWS::Logs::LogGroup`
- `AWS::CloudWatch::Alarm`
- `AWS::CloudWatch::AnomalyDetector`

### Networking

- `AWS::EC2::VPC`
- `AWS::EC2::Subnet`
- `AWS::EC2::InternetGateway`
- `AWS::EC2::EIP`
- `AWS::EC2::VPCGatewayAttachment`
- `AWS::EC2::NatGateway`
- `AWS::EC2::RouteTable`
- `AWS::EC2::Route`
- `AWS::EC2::SubnetRouteTableAssociation`
- `AWS::EC2::SecurityGroup`
- `AWS::EC2::SecurityGroupIngress`
- `AWS::EC2::NetworkAcl`
- `AWS::EC2::NetworkAclEntry`
- `AWS::EC2::SubnetNetworkAclAssociation`

### Orchestration

- `AWS::StepFunctions::StateMachine`

### Parameters

- `AWS::SSM::Parameter`

### Secrets

- `AWS::SecretsManager::Secret`

### Security

- `AWS::WAFv2::WebACL`
- `AWS::CertificateManager::Certificate`

### Storage

- `AWS::S3::Bucket`
- `AWS::S3::BucketPolicy`
- `AWS::EFS::FileSystem`
- `AWS::EFS::MountTarget`
- `AWS::EFS::AccessPoint`
- `AWS::S3Express::DirectoryBucket`
- `AWS::S3Tables::TableBucket`
- `AWS::S3Tables::Namespace`
- `AWS::S3Tables::Table`
- `AWS::S3Vectors::VectorBucket`
- `AWS::FSx::FileSystem` — [notes](#aws-fsx-filesystem)

#### `AWS::FSx::FileSystem`

all four variants — Lustre / Windows / ONTAP / OpenZFS; `NON_PROVISIONABLE` in the CFn registry so no Cloud Control fallback exists; per-variant create/update property mapping against the `UpdateFileSystem` mutable surface — a change to an immutable sub-property is rejected with a `--replace` pointer; async create/delete polled to `AVAILABLE`/gone with a self-reported 1h resource timeout. Variant-config drift is computed for all four config blocks; only the inputs AWS never returns stay drift-unknown — the two write-only credentials (`WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.Password`, `OntapConfiguration.FsxAdminPassword`) and `OpenZFSConfiguration.RootVolumeConfiguration`, which lives on the root volume rather than the file system. **Destroy caveat**: delete keeps CloudFormation parity and may leave a chargeable final backup, see [FSx final backup on destroy](#fsx-final-backup-on-destroy) below

### Streaming

- `AWS::Kinesis::Stream`
- `AWS::Kinesis::StreamConsumer`
- `AWS::KinesisFirehose::DeliveryStream`

Two entries are not types: `Custom::*` resources (Lambda- or SNS-backed) have
their own SDK Provider, and every type absent from this page goes through the
Cloud Control API fallback.

## Per-type behaviour notes

### FSx final backup on destroy

Destroying an `AWS::FSx::FileSystem` keeps CloudFormation parity: cdkd calls
`DeleteFileSystem` with API defaults, exactly as CloudFormation does. For
Windows and ONTAP file systems the API default is to TAKE a final backup on
delete (observed on OpenZFS as well; SCRATCH Lustre deployments take none), so
a destroy that reports 0 errors can still leave a **chargeable backup** that
outlives the stack. Two traps to know about:

- `AutomaticBackupRetentionDays: 0` does NOT prevent the final backup. That
  setting only disables *scheduled* backups.
- The final backup is typically **untagged**: `CopyTagsToBackups` defaults to
  false, so the backup's persisted file-system metadata does not reliably
  carry the file system's tags, and tag-based sweeps will not find it. Select
  by the backup's persisted `FileSystem.FileSystemId` instead.

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

### Glue table Iceberg support (`IcebergTableInput` is refused)

`AWS::Glue::Table` can create Apache Iceberg tables, but only in one shape.
On **create**, cdkd **refuses** a template whose
`OpenTableFormatInput.IcebergInput` carries the nested table spec
`IcebergTableInput` (or its SDK spelling `CreateIcebergTableInput`), failing at
pre-flight before any AWS call with an error naming the working shape.

**A `cdkd rollback` never hits that refusal.** A rollback replays from cdkd
state rather than from your template, so refusing would leave you with no
remedy at all — you cannot edit a state record from your CDK code, only by hand
in `state.json`. Both rollback paths therefore WARN and continue:

- **Update** — the rollback replays the previous state's properties through the
  provider's update path. cdkd does not wire Glue's update-only
  `UpdateOpenTableFormatInput` shape, so nothing is forwarded and no bad value
  can reach AWS from that path.
- **Reverse-replacement create** — the arm that revives the OLD table after a
  failed replacement calls `provider.create(...)` with the previous state's
  properties, flagged as a state replay. Here the value IS
  forwarded, so the restored table is degraded exactly as the original was:
  under the CFn spelling the AWS SDK drops the unknown member (the same silent
  drop that produced these state records) and the table comes back without its
  Iceberg metadata; under the SDK spelling Glue rejects the call and that one
  rollback operation fails. Either way the warning names `cdkd deploy` with the
  working shape as the fix-forward — strictly better than a refusal, which
  guaranteed the table was not restored at all.

This is a deliberate **parity divergence**: CloudFormation does not validate the
property, it forwards it and then rolls the stack back. No working deployment is
lost by refusing it, because the spec is undeployable on **both** paths:

- the raw `glue:CreateTable` API — the call cdkd itself makes — rejects every
  spec shape (`Location information cannot be null while creating an iceberg
  table` without a `TableInput.StorageDescriptor`, `Table metadata information
  present at multiple parts of input request` with one; the spec's own
  `Location` is never read);
- CloudFormation rolls every variant back with `Table metadata is expected only
  via TableInput or via IcebergTableInputProperties inside
  OpenTableFormatInput` — naming a property that exists in neither the CFn
  registry schema (`IcebergInput.IcebergTableInput`) nor `@aws-sdk/client-glue`
  (`IcebergInput.CreateIcebergTableInput`). That three-way contract mismatch is
  an AWS-side bug.

One route is not covered: a table whose cdkd state records
`provisionedBy: 'cc-api'` (reachable only via `--recreate-via-cc-api` or a
legacy state record) is routed to the Cloud Control provider, which forwards
the property and gets CloudFormation's rollback instead of the message above.
The deploy still fails; it just fails later and less helpfully.

**Where the property can even come from.** `aws-cdk-lib`'s L1
`CfnTable.IcebergInputProperty` declares only `metadataOperation` and
`version` — it does NOT declare `icebergTableInput`, and the L1 renderer drops
undeclared members silently. So an ordinary CDK app cannot emit this property
at all — synthesize the stack and read the template to confirm it for your CDK version. It
reaches a deploy only from a hand-written CloudFormation template, a
`cdkd import --migrate-from-cloudformation` of one, or an explicit
`addPropertyOverride('OpenTableFormatInput.IcebergInput.IcebergTableInput', …)`.
That is why the refusal is safe to make unconditional: no CDK user can trip it
by accident.

Use the shape that deploys — table metadata in `TableInput`, and `IcebergInput`
carrying only the create-time directive:

```ts
new glue.CfnTable(this, 'IcebergTable', {
  catalogId: this.account,
  databaseName: database.ref,
  openTableFormatInput: {
    icebergInput: { metadataOperation: 'CREATE' }, // version: '2' is also accepted
  },
  tableInput: {
    name: 'events_iceberg',
    tableType: 'EXTERNAL_TABLE', // required — Iceberg tables must be EXTERNAL_TABLE
    storageDescriptor: {
      location: 's3://your-bucket/iceberg/events/',
      columns: [{ name: 'event_id', type: 'string' }],
    },
  },
});
```

Glue then writes the Iceberg metadata itself: the created table comes back with
`Parameters.table_type = ICEBERG` and a populated `Parameters.metadata_location`.
That shape has real-AWS coverage in the
[`data-analytics`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/data-analytics/) integ fixture.

### Glue table / database: AWS-managed `Parameters` survive an update

Glue's `UpdateTable` / `UpdateDatabase` replace `TableInput` / `DatabaseInput`
**wholesale** — whatever the payload omits is erased. `Parameters` is a
general-purpose bag that AWS itself writes into, so entries with no template
representation used to disappear on the first unrelated edit. For an Iceberg
table
that was not cosmetic: a deploy changing only `TableInput.Description` cleared
`table_type` and `metadata_location`, silently degrading the table to a plain
external table pointing at Iceberg data files, with the deploy reporting
success. The same exposure covered a crawler's `classification`, `EXTERNAL`,
`comment`, and Lake Formation markers.

The same exposure is also closed one level down, for the
`StorageDescriptor` subtree: a Glue
crawler authors `Columns`, `InputFormat` / `OutputFormat`, `SerdeInfo` (and
its `Parameters` bag) and `StorageDescriptor.Parameters`, and Glue re-derives
an Iceberg table's catalog `Columns` from table metadata — all of which an
unrelated update used to wipe (`Columns` -> `[]`, `SerdeInfo` gone; probed
live 2026-08-10). The preservation rule is the same
"present in neither template side" test, applied per SD *member* (with the
two nested `Parameters` bags merged per key — including when a whole bag is
removed from the template, which keeps the top-level `Parameters` semantics:
your keys are removed, AWS-authored keys survive). `SerdeInfo` is structural, not
a bag: removing the whole block from the template removes it on AWS, since a
partial serde carrying only crawler-authored entries would be incoherent. A
template that never declared `StorageDescriptor` at all carries the whole
live block forward. Scope is
deliberately the `StorageDescriptor` subtree only — the crawler also authors
`PartitionKeys` / `Owner`, which remain template-authoritative for now.

cdkd now reads the live table / database (`glue:GetTable` /
`glue:GetDatabase`) immediately before the update and merges those
AWS-authored entries back into the payload. Four consequences worth knowing
(they apply to the `StorageDescriptor` members the same way):

- **Your removals still work.** A parameter you delete from your template is
  still deleted on AWS. The merge only restores keys present in *neither* the
  new template nor the last-deployed one — i.e. keys you never authored.
  A key present in the previously deployed template and absent now is read as
  a deliberate removal, exactly as before.
- **A parameter added OUTSIDE your template is now permanent and invisible.**
  This is the deliberate price of the fix, and it is worth stating plainly.
  cdkd cannot tell an entry AWS wrote from one a human added in the console or
  via `aws glue update-table` — neither appears on either template side, so
  both are preserved on every subsequent deploy. It will also not be reported:
  `cdkd drift` compares against the state baseline, and after a deploy the
  merged value is captured into that baseline, so the key stops looking like
  drift. To remove such an entry, delete it directly
  (`aws glue update-table` / the console) — or declare it in your template
  first, deploy, then delete it from the template, which makes it a normal
  user-authored removal the merge will honor.
  `cdkd drift --revert` is unaffected and still clears console-side additions:
  that path passes the AWS-current snapshot as the previous side, so every
  live key counts as previously-known and none is added back.
- **The deploy identity needs `glue:GetTable` / `glue:GetDatabase`.** If the
  read fails for any reason other than "not found", the update is refused with
  an error naming the missing action rather than proceeding — silently
  skipping the merge would reinstate the erasure this read exists to prevent.
- **Concurrent writers are detected on tables, not on databases.** Reading the
  parameters and writing them back opens a window: an Apache Iceberg commit
  from Spark / Athena / EMR landing in between would be undone by writing back
  the `metadata_location` cdkd read, pinning the table to an older snapshot.
  cdkd therefore sends `UpdateTable`'s `VersionId` precondition on **every**
  table update, so a concurrent commit fails the deploy loudly (with an error
  naming the cause) instead of silently rolling the table back. Re-running the
  deploy picks up the current values. It cannot fail spuriously: the version is
  read milliseconds before the write, so it is stale only when somebody else
  genuinely wrote in between — including under `cdkd drift --revert`, where
  stopping is the right outcome rather than clobbering a change the revert
  never saw. `UpdateDatabase` has no `VersionId` equivalent in the AWS API, so
  the database merge keeps this exposure; in practice nothing commits to a Glue
  *database* out of band the way an engine commits to a table.

Real-AWS coverage: the [`data-analytics`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/data-analytics/)
fixture's UPDATE phase re-asserts both Iceberg markers after an unrelated
`Description` edit (having first pinned that the update was in-place, via an
unchanged `Table.CreateTime`), asserts a user-removed parameter on the sibling
plain table is still gone, and runs the same removal-plus-preservation pair
against the database. For the `StorageDescriptor` subtree it injects crawler-equivalent
out-of-band members (`StorageDescriptor.Parameters` and
`SerdeInfo.Parameters` entries) via a raw `UpdateTable`, asserts they survive
the unrelated Phase-2 deploy, and that template-declared SD members
(`SerializationLibrary`, `Columns`) stay template-authored. It also pins the concurrency guard's *premise*: AWS
documents `VersionId` only as "the version ID at which to update the table
contents", so the fixture advances a table's version out of band and requires
AWS to refuse a replay of the stale one. If AWS ever starts ignoring it, that
assertion fails and the guard is removed rather than left in place as a
placebo.

## Not planned (deprecated services)

Some Tier 3 (`NON_PROVISIONABLE`) types belong to AWS services or platforms
that are deprecated or retired. cdkd will **not** add SDK Providers for
these — please do not file support requests for them. Use the listed
successor instead.

| Resource Type | Reason |
|---------------|--------|
| `AWS::WAF::*` (WAF Classic) | Support ended 2025-09-30; superseded by `AWS::WAFv2::*`, which cdkd already supports (SDK Provider for `WebACL`, Cloud Control for the rest). |
| `AWS::WAFRegional::*` | Same WAF Classic family, same end of support (2025-09-30). |
| `AWS::CodeStar::GitHubRepository` | AWS CodeStar was discontinued 2024-07-31. |
| `AWS::AppMesh::*` | App Mesh EOL announced for 2026-09-30; superseded by ECS Service Connect / VPC Lattice. |
| `AWS::Elasticsearch::Domain` | Legacy namespace superseded by `AWS::OpenSearchService::Domain` (supported via Cloud Control). |
| `AWS::RDS::DBSecurityGroup` / `AWS::RDS::DBSecurityGroupIngress` | EC2-Classic-only constructs; EC2-Classic retired 2022-08-15 — use VPC security groups. |
| `AWS::ElastiCache::SecurityGroup` / `AWS::ElastiCache::SecurityGroupIngress` | Same EC2-Classic-only family, unusable since the EC2-Classic retirement. |
| `AWS::Redshift::ClusterSecurityGroup` / `AWS::Redshift::ClusterSecurityGroupIngress` | Same EC2-Classic-only family, unusable since the EC2-Classic retirement. |

All other Tier 3 types remain in the "no provider yet" bucket — the
pre-flight error's 1-click GitHub issue link is the right way to request
support for those.

## Related

- [Importing Existing Resources](import.md) — the import-side view of these
  providers: which are auto-discovered and which need a `--resource` override
- [Feature Parity](supported-features.md) — intrinsic functions, pseudo
  parameters, and the rest of the CloudFormation surface
- [Deploy: safety & compatibility flags](cli-deploy-safety.md) — the escape
  hatches for an unsupported type or property
