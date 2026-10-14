---
title: Supported Resources
description: "Which AWS resource types cdkd can deploy, which of them have a fast SDK provider, and which types cdkd refuses."
---

# Supported Resources

cdkd can deploy almost every CloudFormation resource type. It does so in one
of two ways:

- For the types listed on this page, cdkd has an **SDK provider**: code that
  calls the service's own API directly. This is the fast path.
- For almost every other type, cdkd uses the AWS **Cloud Control API**, a
  generic API that can create, update and delete most resource types. It is
  slower, and it works without type-specific code in cdkd.

A small set of types that AWS marks as not provisionable is refused.

## Is my resource type supported?

Search this page for the type, for example `AWS::Lambda::Function`.

| Your type is | What cdkd does |
| --- | --- |
| In the [table below](#resource-types) | Deploys it with an SDK provider |
| Not on this page | Deploys it through the Cloud Control API |
| Not provisionable in AWS, with no SDK provider | [Refuses the deploy](#types-cdkd-refuses) before touching any resource |
| A `Custom::*` resource | Invokes its Lambda or SNS backing with cdkd's own provider |

Three related questions have their own pages:

- Some listed types behave differently from CloudFormation, or leave
  something behind on destroy. See
  [Per-Type Behaviour Notes](supported-resources-type-notes.md).
- Whether `cdkd import` can adopt a type is answered in
  [Import Existing Resources](import.md#which-resource-types-can-be-imported).
- The [provider coverage matrix](_generated/provider-coverage.md) lists every
  public CloudFormation resource type with its tier: Tier 1 (SDK provider),
  Tier 2 (Cloud Control) or Tier 3 (unsupported). It is generated, and it has
  a machine-readable [JSON form](_generated/provider-coverage.json).

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
| Lambda | `AWS::Lambda::EventInvokeConfig`, `AWS::Lambda::EventSourceMapping`, `AWS::Lambda::Function`, `AWS::Lambda::LayerVersion`, `AWS::Lambda::MicrovmImage`, `AWS::Lambda::Permission`, `AWS::Lambda::Url`, `AWS::Lambda::WebFunctionEndpoint`, `AWS::Lambda::WebFunctionRevision` |
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

Being in this table does not fix the path for every resource of the type.
cdkd chooses the path for each resource on each deploy, as the next section
explains.

## Properties an SDK provider does not write

An SDK provider writes the properties it was built for. AWS adds properties
to existing resource types regularly, so a template can set one that the
provider does not write yet. cdkd does not drop such a property. It deploys
that one resource through Cloud Control instead, which sends every property
to AWS.

cdkd makes this choice before the deploy starts, by checking every top-level
property of a listed type against what its provider writes:

- **Every property is one the provider writes.** The resource uses the SDK
  provider.
- **One property is not.** That resource is deployed through Cloud Control,
  so the property reaches AWS.
- **A property is missing from cdkd's copy of the CloudFormation schema.**
  This happens with a new property, a misspelled one, or a key added with
  `addPropertyOverride`. The resource also goes through Cloud Control, which
  applies a real property and rejects a misspelled one.
- **A property is read-only**, such as an ARN or id that AWS assigns. It
  cannot be set from a template, so the resource stays on the SDK provider
  and cdkd warns.

A type that always uses Cloud Control needs no such check, because Cloud
Control sends the whole property map to AWS.

### Keep a resource on the SDK provider

To keep the faster path and give up the property, name the type and the
property:

```bash
cdkd deploy MyStack --prefer-sdk-route AWS::ApiGatewayV2::Api:Body
```

The named property is then not written to AWS. See
[cdkd deploy: safety & compatibility flags](cli-deploy-safety.md) for this flag
and its exceptions, and [Provisioning Layers](provisioning-layers.md) for how
a resource moves between the two paths.

## Types cdkd refuses

cdkd refuses a type that has no SDK provider and that AWS reports as
`ProvisioningType: NON_PROVISIONABLE`, because Cloud Control cannot manage
such a type either. The deploy stops before any resource is touched. The
error names the type and the reason, and carries a pre-filled GitHub issue
link to request support.

If AWS has since made the type provisionable, tell cdkd to try it through
Cloud Control. The flag takes a comma-separated list of types:

```bash
cdkd deploy MyStack --allow-unsupported-types AWS::Foo::Bar,AWS::Baz::Qux
cdkd destroy MyStack --allow-unsupported-types AWS::Foo::Bar,AWS::Baz::Qux
```

For a type that really is not provisionable, Cloud Control still fails.

### Not planned (deprecated services)

Some refused types belong to AWS services that are deprecated or retired.
cdkd will not add SDK providers for these. Use the successor.

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

For any other refused type, use the issue link in the error.

## Types with behaviour to know

Most listed types behave as CloudFormation does. The types below differ, or
leave something behind on destroy. Each links to its note in
[Per-Type Behaviour Notes](supported-resources-type-notes.md).

| Type | What to know |
| --- | --- |
| `AWS::EFS::FileSystem` | [Automatic backups survive destroy](supported-resources-type-notes.md#efs-automatic-backups-survive-destroy). |
| `AWS::FSx::FileSystem` | [A final backup can outlive the stack](supported-resources-type-notes.md#fsx-final-backup-on-destroy). |
| `AWS::Glue::Table` | [`IcebergTableInput` is refused](supported-resources-type-notes.md#glue-table-iceberg-support-icebergtableinput-is-refused). |
| `AWS::Glue::Table`, `AWS::Glue::Database` | [`Parameters` that AWS writes survive an update](supported-resources-type-notes.md#glue-table-database-aws-managed-parameters-survive-an-update). A concurrent write to a database is not detected. |
| `AWS::EMR::Cluster`, `AWS::EMR::InstanceGroupConfig`, `AWS::EMR::InstanceFleetConfig` | [Deleting a group or fleet calls no AWS API](supported-resources-type-notes.md#emr-on-ec2). |
| `AWS::BedrockAgentCore::Browser`, `AWS::BedrockAgentCore::CodeInterpreter` | [They adopt the default AWS manages](supported-resources-type-notes.md#bedrock-agentcore-browser-and-code-interpreter). |
| `AWS::BedrockAgentCore::Evaluator` | Changing `EvaluatorName` replaces the evaluator. Tags are updated in place. |
| `AWS::CloudFormation::Stack` | [Nested stacks](supported-resources-type-notes.md#nested-stacks) deploy, import and export. |
| `AWS::CloudFormation::WaitConditionHandle` | [A placeholder that calls no AWS API](supported-resources-type-notes.md#wait-condition-handles). |
| `AWS::Budgets::Budget` | A global API served from `us-east-1`. Changing `NotificationsWithSubscribers` updates in place; CloudFormation replaces the budget. |
| `AWS::CodeCommit::Repository` | `Code` seeds the initial commit from an S3 zip on create only. `Triggers` are applied on create and update. |

## Related

- [Per-Type Behaviour Notes](supported-resources-type-notes.md): the caveats
  in full
- [Provisioning Layers](provisioning-layers.md): how cdkd chooses between an
  SDK provider and Cloud Control for one resource
- [Import Existing Resources](import.md): which types `cdkd import` can
  adopt
- [Feature Parity](supported-features.md): intrinsic functions, pseudo
  parameters and the rest of the CloudFormation surface
- [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): the flags for
  an unsupported type or property
