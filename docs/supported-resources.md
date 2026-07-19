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
(e.g. `RecursiveLoop` on `AWS::Lambda::Function`), and a provider that does
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
| **Database** | AWS::DynamoDB::Table | SDK Provider | ✅ |
| **Database** | AWS::DynamoDB::GlobalTable | SDK Provider | ✅ |
| **Monitoring** | AWS::Logs::LogGroup | SDK Provider | ✅ |
| **Monitoring** | AWS::CloudWatch::Alarm | SDK Provider | ✅ |
| **Secrets** | AWS::SecretsManager::Secret | SDK Provider | ✅ |
| **Config** | AWS::SSM::Parameter | SDK Provider | ✅ |
| **Events** | AWS::Events::Rule | SDK Provider | ✅ |
| **Events** | AWS::Events::EventBus | SDK Provider | ✅ |
| **Networking** | AWS::EC2::VPC | SDK Provider | ✅ |
| **Networking** | AWS::EC2::Subnet | SDK Provider | ✅ |
| **Networking** | AWS::EC2::InternetGateway | SDK Provider | ✅ |
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
| **Analytics** | AWS::Glue::Table | SDK Provider | ✅ |
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
| **Storage** | AWS::FSx::FileSystem (all four variants — Lustre / Windows / ONTAP / OpenZFS; `NON_PROVISIONABLE` in the CFn registry so no Cloud Control fallback exists; per-variant create/update property mapping against the `UpdateFileSystem` mutable surface — a change to an immutable sub-property is rejected with a `--replace` pointer; async create/delete polled to `AVAILABLE`/gone with a self-reported 1h resource timeout. Variant-config drift is computed for all four config blocks; only the inputs AWS never returns stay drift-unknown — the two write-only credentials (`WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.Password`, `OntapConfiguration.FsxAdminPassword`) and `OpenZFSConfiguration.RootVolumeConfiguration`, which lives on the root volume rather than the file system) | SDK Provider | ✅ |
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
