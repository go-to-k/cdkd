# Supported AWS Resource Types

This document lists every AWS resource type cdkd can deploy and manage,
grouped by category. Use it to confirm whether your CDK stack will work
with cdkd before installing.

For the import-side view of these providers (which can be auto-discovered
by `aws:cdk:path` tag vs which require `--resource` overrides), see
[docs/import.md](import.md).

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
from the provider-coverage audit into the runtime
(`src/provisioning/unsupported-types.generated.ts`, regenerated via
`vp run gen:unsupported-types`).

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
command. See [docs/cli-reference.md `--allow-unsupported-properties`](cli-reference.md#--allow-unsupported-properties-deploy)
for the escape hatch.

Coverage data is generated from the CFn schema fixtures + each SDK
provider's declarations into the runtime at
`src/provisioning/property-coverage.generated.ts` (`vp run gen:property-coverage`;
CI fails if it drifts). Tier 2 (Cloud Control) types are NOT in the map:
Cloud Control forwards the full property map to AWS, so there is no
write-side silent drop at cdkd for those.

Properties not in the CFn schema (likely `addPropertyOverride` escape
hatches or typos) pass through silently — CFn itself tolerates them.
Read-only properties (AWS-managed Arns, Ids, etc.) also pass through
silently; they cannot be set from the template side.

## Three-tier coverage report

For a full machine-checked view of every public AWS CFn resource type
partitioned into Tier 1 (SDK Provider) / Tier 2 (CC API fallback) / Tier 3
(unsupported), see the auto-generated report at
[_generated/provider-coverage.md](_generated/provider-coverage.md). The
JSON counterpart at [_generated/provider-coverage.json](_generated/provider-coverage.json)
is the machine-readable source-of-truth. Regenerate with:

```bash
vp run audit:coverage:regenerate
```

The hand-maintained table below is the canonical per-category breakdown
for the SDK Provider tier; the auto-generated report is the complete
catalog with Tier 2 and Tier 3 entries included.

## Resource types

| Category | Resource Type | Provider | Status |
|----------|--------------|----------|--------|
| **IAM** | AWS::IAM::Role | SDK Provider | ✅ |
| **IAM** | AWS::IAM::Policy | SDK Provider | ✅ |
| **IAM** | AWS::IAM::ManagedPolicy | SDK Provider | ✅ |
| **IAM** | AWS::IAM::InstanceProfile | SDK Provider | ✅ |
| **IAM** | AWS::IAM::User | SDK Provider | ✅ |
| **IAM** | AWS::IAM::Group | SDK Provider | ✅ |
| **IAM** | AWS::IAM::UserToGroupAddition | SDK Provider | ✅ |
| **IAM** | AWS::IAM::AccessKey | SDK Provider | ✅ |
| **Storage** | AWS::S3::Bucket | SDK Provider | ✅ |
| **Storage** | AWS::S3::BucketPolicy | SDK Provider | ✅ |
| **Messaging** | AWS::SQS::Queue | SDK Provider | ✅ |
| **Messaging** | AWS::SQS::QueuePolicy | SDK Provider | ✅ |
| **Messaging** | AWS::SNS::Topic | SDK Provider | ✅ |
| **Messaging** | AWS::SNS::Subscription | SDK Provider | ✅ |
| **Messaging** | AWS::SNS::TopicPolicy | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::Function | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::Permission | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::Url | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::EventSourceMapping | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::LayerVersion | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::EventInvokeConfig | SDK Provider | ✅ |
| **Compute** | AWS::Lambda::MicrovmImage | SDK Provider | ✅ |
| **Database** | AWS::DynamoDB::Table | SDK Provider | ✅ |
| **Database** | AWS::DynamoDB::GlobalTable | SDK Provider | ✅ |
| **Monitoring** | AWS::Logs::LogGroup | SDK Provider | ✅ |
| **Monitoring** | AWS::CloudWatch::Alarm | SDK Provider | ✅ |
| **Monitoring** | AWS::CloudWatch::AnomalyDetector | SDK Provider | ✅ |
| **Secrets** | AWS::SecretsManager::Secret | SDK Provider | ✅ |
| **Config** | AWS::SSM::Parameter | SDK Provider | ✅ |
| **Events** | AWS::Events::Rule | SDK Provider | ✅ |
| **Events** | AWS::Events::EventBus | SDK Provider | ✅ |
| **Networking** | AWS::EC2::VPC | SDK Provider | ✅ |
| **Networking** | AWS::EC2::Subnet | SDK Provider | ✅ |
| **Networking** | AWS::EC2::InternetGateway | SDK Provider | ✅ |
| **Networking** | AWS::EC2::EIP | SDK Provider | ✅ |
| **Networking** | AWS::EC2::VPCGatewayAttachment | SDK Provider | ✅ |
| **Networking** | AWS::EC2::NatGateway | SDK Provider | ✅ |
| **Networking** | AWS::EC2::RouteTable | SDK Provider | ✅ |
| **Networking** | AWS::EC2::Route | SDK Provider | ✅ |
| **Networking** | AWS::EC2::SubnetRouteTableAssociation | SDK Provider | ✅ |
| **Networking** | AWS::EC2::SecurityGroup | SDK Provider | ✅ |
| **Networking** | AWS::EC2::SecurityGroupIngress | SDK Provider | ✅ |
| **Networking** | AWS::EC2::NetworkAcl | SDK Provider | ✅ |
| **Networking** | AWS::EC2::NetworkAclEntry | SDK Provider | ✅ |
| **Networking** | AWS::EC2::SubnetNetworkAclAssociation | SDK Provider | ✅ |
| **Compute** | AWS::EC2::Instance | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Account | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Resource | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Deployment | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Stage | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Method | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGateway::Authorizer | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGatewayV2::Api | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGatewayV2::Stage | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGatewayV2::Integration | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGatewayV2::Route | SDK Provider | ✅ |
| **API Gateway** | AWS::ApiGatewayV2::Authorizer | SDK Provider | ✅ |
| **CDN** | AWS::CloudFront::CloudFrontOriginAccessIdentity | SDK Provider | ✅ |
| **CDN** | AWS::CloudFront::OriginAccessControl | SDK Provider | ✅ |
| **CDN** | AWS::CloudFront::Distribution | SDK Provider | ✅ |
| **Orchestration** | AWS::StepFunctions::StateMachine | SDK Provider | ✅ |
| **Container** | AWS::ECS::Cluster | SDK Provider | ✅ |
| **Container** | AWS::ECS::TaskDefinition | SDK Provider | ✅ |
| **Container** | AWS::ECS::Service | SDK Provider | ✅ |
| **Load Balancing** | AWS::ElasticLoadBalancingV2::LoadBalancer | SDK Provider | ✅ |
| **Load Balancing** | AWS::ElasticLoadBalancingV2::TargetGroup | SDK Provider | ✅ |
| **Load Balancing** | AWS::ElasticLoadBalancingV2::Listener | SDK Provider | ✅ |
| **Database** | AWS::RDS::DBSubnetGroup | SDK Provider | ✅ |
| **Database** | AWS::RDS::DBCluster | SDK Provider | ✅ |
| **Database** | AWS::RDS::DBInstance | SDK Provider | ✅ |
| **Database** | AWS::RDS::DBProxy | SDK Provider | ✅ |
| **Database** | AWS::RDS::DBProxyEndpoint | SDK Provider | ✅ |
| **Database** | AWS::RDS::DBProxyTargetGroup | SDK Provider | ✅ |
| **Database** | AWS::DocDB::DBSubnetGroup | SDK Provider | ✅ |
| **Database** | AWS::DocDB::DBCluster | SDK Provider | ✅ |
| **Database** | AWS::DocDB::DBInstance | SDK Provider | ✅ |
| **Database** | AWS::Neptune::DBSubnetGroup | SDK Provider | ✅ |
| **Database** | AWS::Neptune::DBCluster | SDK Provider | ✅ |
| **Database** | AWS::Neptune::DBInstance | SDK Provider | ✅ |
| **DNS** | AWS::Route53::HostedZone | SDK Provider | ✅ |
| **DNS** | AWS::Route53::RecordSet | SDK Provider | ✅ |
| **Security** | AWS::WAFv2::WebACL | SDK Provider | ✅ |
| **Security** | AWS::CertificateManager::Certificate | SDK Provider | ✅ |
| **Auth** | AWS::Cognito::UserPool | SDK Provider | ✅ |
| **Cache** | AWS::ElastiCache::CacheCluster | SDK Provider | ✅ |
| **Cache** | AWS::ElastiCache::SubnetGroup | SDK Provider | ✅ |
| **Discovery** | AWS::ServiceDiscovery::PrivateDnsNamespace | SDK Provider | ✅ |
| **Discovery** | AWS::ServiceDiscovery::HttpNamespace | SDK Provider | ✅ |
| **Discovery** | AWS::ServiceDiscovery::PublicDnsNamespace | SDK Provider | ✅ |
| **Discovery** | AWS::ServiceDiscovery::Service | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::GraphQLApi | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::GraphQLSchema | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::DataSource | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::Resolver | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::ApiKey | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Database | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Table ([Iceberg caveat](#glue-table-iceberg-support-icebergtableinput-is-refused)) | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Job | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Crawler | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Connection | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Trigger | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Workflow | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::SecurityConfiguration | SDK Provider | ✅ |
| **Encryption** | AWS::KMS::Key | SDK Provider | ✅ |
| **Encryption** | AWS::KMS::Alias | SDK Provider | ✅ |
| **Streaming** | AWS::Kinesis::Stream | SDK Provider | ✅ |
| **Streaming** | AWS::Kinesis::StreamConsumer | SDK Provider | ✅ |
| **Streaming** | AWS::KinesisFirehose::DeliveryStream | SDK Provider | ✅ |
| **Integration** | AWS::Scheduler::Schedule | SDK Provider | ✅ |
| **Storage** | AWS::EFS::FileSystem | SDK Provider | ✅ |
| **Storage** | AWS::EFS::MountTarget | SDK Provider | ✅ |
| **Storage** | AWS::EFS::AccessPoint | SDK Provider | ✅ |
| **Storage** | AWS::S3Express::DirectoryBucket | SDK Provider | ✅ |
| **Storage** | AWS::S3Tables::TableBucket | SDK Provider | ✅ |
| **Storage** | AWS::S3Tables::Namespace | SDK Provider | ✅ |
| **Storage** | AWS::S3Tables::Table | SDK Provider | ✅ |
| **Storage** | AWS::S3Vectors::VectorBucket | SDK Provider | ✅ |
| **Storage** | AWS::FSx::FileSystem (all four variants — Lustre / Windows / ONTAP / OpenZFS; `NON_PROVISIONABLE` in the CFn registry so no Cloud Control fallback exists; per-variant create/update property mapping against the `UpdateFileSystem` mutable surface — a change to an immutable sub-property is rejected with a `--replace` pointer; async create/delete polled to `AVAILABLE`/gone with a self-reported 1h resource timeout. Variant-config drift is computed for all four config blocks; only the inputs AWS never returns stay drift-unknown — the two write-only credentials (`WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.Password`, `OntapConfiguration.FsxAdminPassword`) and `OpenZFSConfiguration.RootVolumeConfiguration`, which lives on the root volume rather than the file system. **Destroy caveat**: delete keeps CloudFormation parity and may leave a chargeable final backup, see [FSx final backup on destroy](#fsx-final-backup-on-destroy) below) | SDK Provider | ✅ |
| **Analytics** | AWS::EMR::Cluster (EMR on EC2; `NON_PROVISIONABLE` in the CFn registry so no Cloud Control fallback exists; `RunJobFlow`-backed create polled to `WAITING`/`RUNNING`, `TerminateJobFlows`-backed delete polled to `TERMINATED` — both with a self-reported 1h resource timeout; mutable surface is termination protection / visibility / step concurrency / managed-scaling / auto-termination / tags, everything else is createOnly → replacement; `--remove-protection` flips `SetTerminationProtection(false)` before terminating) | SDK Provider | ✅ |
| **Analytics** | AWS::EMR::InstanceGroupConfig (adds a standalone instance group to an existing cluster referenced by `JobFlowId`; `NON_PROVISIONABLE` in the CFn registry so no Cloud Control fallback exists; `AddInstanceGroups`-backed create polled to `RUNNING`, `ModifyInstanceGroups`/`PutAutoScalingPolicy` mutable surface (`InstanceCount` resize + `AutoScalingPolicy`), everything else createOnly → replacement; **delete has no standalone AWS API** — a group is released when the parent cluster terminates, so delete is a no-op that drops cdkd state (best-effort scale-to-0 for a `TASK` group); self-reported 1h resource timeout) | SDK Provider | ✅ |
| **Analytics** | AWS::EMR::InstanceFleetConfig (adds a standalone instance fleet to an existing cluster referenced by `ClusterId`; `NON_PROVISIONABLE` in the CFn registry so no Cloud Control fallback exists; `AddInstanceFleet`-backed create polled to `RUNNING`, `ModifyInstanceFleet` mutable surface (`TargetOnDemandCapacity`/`TargetSpotCapacity`/`ResizeSpecifications`/`InstanceTypeConfigs`), everything else createOnly → replacement; **delete has no standalone AWS API** — a fleet is released when the parent cluster terminates, so delete is a no-op that drops cdkd state (best-effort scale-to-0 for a `TASK` fleet); self-reported 1h resource timeout) | SDK Provider | ✅ |
| **Audit** | AWS::CloudTrail::Trail | SDK Provider | ✅ |
| **Backup** | AWS::DLM::LifecyclePolicy | SDK Provider | ✅ |
| **CI/CD** | AWS::CodeBuild::Project | SDK Provider | ✅ |
| **CI/CD** | AWS::CodeCommit::Repository (`Code` create-only S3-zip seed content unpacked into the initial commit via `CreateCommit`; `Triggers` reconciled on create + update via `PutRepositoryTriggers`) | SDK Provider | ✅ |
| **AI/ML** | AWS::BedrockAgentCore::Runtime | SDK Provider | ✅ |
| **AI/ML** | AWS::BedrockAgentCore::Browser (adopt-only singleton — the CFn registry declares the type a read-only representation of the AWS-managed default browser `aws.browser.v1` with `NON_PROVISIONABLE` provisioning, so cdkd adopts the default via `GetBrowser` on create and no-ops delete; custom browsers are the separate `AWS::BedrockAgentCore::BrowserCustom` type, served by Cloud Control) | SDK Provider | ✅ |
| **AI/ML** | AWS::BedrockAgentCore::CodeInterpreter (adopt-only singleton for the AWS-managed default `aws.codeinterpreter.v1`, same semantics as Browser; custom interpreters are `AWS::BedrockAgentCore::CodeInterpreterCustom`, served by Cloud Control) | SDK Provider | ✅ |
| **AI/ML** | AWS::BedrockAgentCore::Evaluator (LLM-as-a-Judge / code-based agent-quality evaluators; `EvaluatorName` is createOnly → replacement, tags reconciled via `TagResource`/`UntagResource`) | SDK Provider | ✅ |
| **Compute** | AWS::AutoScaling::AutoScalingGroup | SDK Provider | ✅ |
| **Cost Management** | AWS::Budgets::Budget (global API served from us-east-1; `update` reconciles `NotificationsWithSubscribers` in place instead of CloudFormation's whole-budget replacement) | SDK Provider | ✅ |
| **CloudFormation** | AWS::CloudFormation::Stack (nested stacks; fresh deploy + recursive `cdkd import --migrate-from-cloudformation` adoption + recursive `cdkd export` per-stack IMPORT loop via [#464](https://github.com/go-to-k/cdkd/issues/464) PR B2; the original "one atomic `--include-nested-stacks` IMPORT" design was found infeasible by 2026-05-24 AWS spike, redesigned per [design §4.0/§4.3](design/464-nested-stacks-export-import.md) — each cdkd-managed stack becomes its own CFn stack via a separate IMPORT changeset in leaf-first order; non-leaf parents adopt their just-imported children via the AWS-docs "Nest an existing stack" pattern) | SDK Provider | ✅ |
| **CloudFormation** | AWS::CloudFormation::WaitConditionHandle (no-op placeholder — outside CloudFormation the real pre-signed signal URL cannot exist, so cdkd synthesizes an opaque placeholder physical id and calls no AWS API; sufficient for the empty-template-placeholder usage e.g. `cdk-multi-region-stack`, issue [#1020](https://github.com/go-to-k/cdkd/issues/1020). `AWS::CloudFormation::WaitCondition` — the blocking signal-wait — remains unsupported) | SDK Provider | ✅ |
| **Custom** | Custom::* (Lambda/SNS-backed) | SDK Provider | ✅ |
| **Other** | All other resource types | Cloud Control | ✅ |

### FSx final backup on destroy

Destroying an `AWS::FSx::FileSystem` keeps CloudFormation parity: cdkd calls
`DeleteFileSystem` with API defaults, exactly as CloudFormation does. For
Windows and ONTAP file systems the API default is to TAKE a final backup on
delete (observed on OpenZFS as well; SCRATCH Lustre deployments take none), so
a destroy that reports 0 errors can still leave a **chargeable backup** that
outlives the stack (issue
[#1113](https://github.com/go-to-k/cdkd/issues/1113)). Two traps to know
about:

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
pre-flight before any AWS call with an error naming the working shape (issue
[#1454](https://github.com/go-to-k/cdkd/issues/1454)).

**A `cdkd rollback` never hits that refusal.** A rollback replays from cdkd
state rather than from your template, so refusing would leave you with no
remedy at all — you cannot edit a state record from your CDK code, only by hand
in `state.json`. Both rollback paths therefore WARN and continue:

- **Update** — `rollback-executor.ts` calls `provider.update(...)` with the
  previous state's properties. cdkd does not wire Glue's update-only
  `UpdateOpenTableFormatInput` shape, so nothing is forwarded and no bad value
  can reach AWS from that path.
- **Reverse-replacement create** — the arm that revives the OLD table after a
  failed replacement calls `provider.create(...)` with the previous state's
  properties, flagged as a state replay (issue
  [#1463](https://github.com/go-to-k/cdkd/issues/1463)). Here the value IS
  forwarded, so the restored table is degraded exactly as the original was:
  under the CFn spelling the AWS SDK drops the unknown member (the #1390 silent
  drop that produced these state records) and the table comes back without its
  Iceberg metadata; under the SDK spelling Glue rejects the call and that one
  rollback operation fails. Either way the warning names `cdkd deploy` with the
  working shape as the fix-forward — strictly better than a refusal, which
  guaranteed the table was not restored at all.

This is a deliberate **parity divergence**: CloudFormation does not validate the
property, it forwards it and then rolls the stack back. No working deployment is
lost by refusing it, because a live probe (issue
[#1408](https://github.com/go-to-k/cdkd/issues/1408), 2026-08-09, `us-east-1`,
5 raw `glue:CreateTable` shapes + 5 CloudFormation stacks) showed the spec is
undeployable on **both** paths:

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
at all; verified 2026-08-10 by synthesizing it and reading the template. It
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
[`data-analytics`](../tests/integration/data-analytics/) integ fixture.

### Glue table / database: AWS-managed `Parameters` survive an update

Glue's `UpdateTable` / `UpdateDatabase` replace `TableInput` / `DatabaseInput`
**wholesale** — whatever the payload omits is erased. `Parameters` is a
general-purpose bag that AWS itself writes into, so entries with no template
representation used to disappear on the first unrelated edit (issue
[#1461](https://github.com/go-to-k/cdkd/issues/1461)). For an Iceberg table
that was not cosmetic: a deploy changing only `TableInput.Description` cleared
`table_type` and `metadata_location`, silently degrading the table to a plain
external table pointing at Iceberg data files, with the deploy reporting
success. The same exposure covered a crawler's `classification`, `EXTERNAL`,
`comment`, and Lake Formation markers.

Since issue [#1479](https://github.com/go-to-k/cdkd/issues/1479) the same
exposure is closed one level down, for the `StorageDescriptor` subtree: a Glue
crawler authors `Columns`, `InputFormat` / `OutputFormat`, `SerdeInfo` (and
its `Parameters` bag) and `StorageDescriptor.Parameters`, and Glue re-derives
an Iceberg table's catalog `Columns` from table metadata — all of which an
unrelated update used to wipe (`Columns` -> `[]`, `SerdeInfo` gone; probed
live 2026-08-10, recorded on the issue). The preservation rule is the same
"present in neither template side" test, applied per SD *member* (with the
two nested `Parameters` bags merged per key — including when a whole bag is
removed from the template, which keeps the top-level #1461 semantics: your
keys are removed, AWS-authored keys survive). `SerdeInfo` is structural, not
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

Real-AWS coverage: the [`data-analytics`](../tests/integration/data-analytics/)
fixture's UPDATE phase re-asserts both Iceberg markers after an unrelated
`Description` edit (having first pinned that the update was in-place, via an
unchanged `Table.CreateTime`), asserts a user-removed parameter on the sibling
plain table is still gone, and runs the same removal-plus-preservation pair
against the database. For the #1479 subtree it injects crawler-equivalent
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

## Adding a new SDK Provider

When you add a new SDK Provider in `src/provisioning/providers/` and
register it in `src/provisioning/register-providers.ts`, also add the
resource type to:

1. The table above (this file).
2. The relevant section in [docs/import.md](import.md) (auto-lookup vs
   override-only vs sub-resource attachment).

Both lists derive from `register-providers.ts` but show different
columns; until they are auto-generated, keep them in sync by hand. Keep
table rows one-per-line so parallel PRs don't conflict on rebase.
