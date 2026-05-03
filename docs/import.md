# `cdkd import` Provider Coverage

This document lists every resource type whose cdkd provider implements
`import()`, grouped by how the import is resolved. Use it to decide
whether your stack can be adopted with a bare `cdkd import MyStack` (all
resources auto-resolve) or whether you need `--resource <id>=<physical>`
overrides for some of them.

For the surrounding workflow (modes, flags, CloudFormation migration),
see the [Importing existing resources](../README.md#importing-existing-resources)
section of the README.

## Auto-lookup (tag-based, no flag needed)

Resources here are looked up by their `aws:cdk:path` tag — cdkd lists
the relevant AWS resources, finds the one whose tag matches the
template's logical id, and adopts it. Works under `auto` (default) and
`hybrid` modes.

- AWS::S3::Bucket
- AWS::Lambda::Function
- AWS::IAM::Role
- AWS::IAM::InstanceProfile
- AWS::IAM::User
- AWS::IAM::Group
- AWS::SNS::Topic
- AWS::SQS::Queue
- AWS::DynamoDB::Table
- AWS::Logs::LogGroup
- AWS::Events::EventBus
- AWS::Events::Rule
- AWS::KMS::Key
- AWS::KMS::Alias
- AWS::SecretsManager::Secret
- AWS::SSM::Parameter
- AWS::EC2::VPC
- AWS::EC2::Subnet
- AWS::EC2::SecurityGroup
- AWS::RDS::DBInstance
- AWS::RDS::DBCluster
- AWS::RDS::DBSubnetGroup
- AWS::ECS::Cluster
- AWS::ECS::Service
- AWS::ECS::TaskDefinition
- AWS::CloudFront::Distribution
- AWS::Cognito::UserPool
- AWS::ApiGatewayV2::Api
- AWS::AppSync::GraphQLApi
- AWS::CloudTrail::Trail
- AWS::CloudWatch::Alarm
- AWS::CodeBuild::Project
- AWS::ECR::Repository
- AWS::ElasticLoadBalancingV2::LoadBalancer
- AWS::ElasticLoadBalancingV2::TargetGroup
- AWS::Route53::HostedZone
- AWS::StepFunctions::StateMachine
- AWS::Glue::Database
- AWS::Glue::Table
- AWS::Kinesis::Stream
- AWS::KinesisFirehose::DeliveryStream
- AWS::WAFv2::WebACL
- AWS::EFS::FileSystem
- AWS::EFS::AccessPoint
- AWS::ElastiCache::CacheCluster
- AWS::ElastiCache::SubnetGroup
- AWS::Lambda::LayerVersion
- AWS::ServiceDiscovery::Service
- AWS::ServiceDiscovery::PrivateDnsNamespace
- AWS::S3Express::DirectoryBucket
- AWS::S3Tables::TableBucket
- AWS::S3Tables::Namespace
- AWS::S3Tables::Table
- AWS::S3Vectors::VectorBucket

## Override-only — no standalone identity / list API

These resource types have no AWS-side identity that cdkd can list and
match on. Use `--resource <logicalId>=<physicalId>` (or
`--resource-mapping <file>` / `--resource-mapping-inline '<json>'`) to
provide the physical id explicitly.

- AWS::IAM::Policy (inline)
- AWS::IAM::UserToGroupAddition

## Override-only — sub-resources without per-resource taggable identity

Sub-resources of a parent (an API Gateway Method belongs to a Resource
which belongs to a RestApi; a Route53 RecordSet belongs to a HostedZone)
are not independently taggable, so cdkd cannot find them by
`aws:cdk:path`. Provide the physical id via `--resource`.

- AWS::ApiGateway::Authorizer
- AWS::ApiGateway::Resource
- AWS::ApiGateway::Deployment
- AWS::ApiGateway::Stage
- AWS::ApiGateway::Method
- AWS::ApiGatewayV2::Stage
- AWS::ApiGatewayV2::Integration
- AWS::ApiGatewayV2::Route
- AWS::ApiGatewayV2::Authorizer
- AWS::AppSync::GraphQLSchema
- AWS::AppSync::DataSource
- AWS::AppSync::Resolver
- AWS::AppSync::ApiKey
- AWS::Route53::RecordSet
- AWS::ElasticLoadBalancingV2::Listener
- AWS::EFS::MountTarget

## Override-only — sub-resources / attachments

Attachment-style resources (a SNS Subscription pinning a Topic to an
endpoint, a Lambda Permission granting a principal access to a function)
have no taggable identity either. Provide the physical id via
`--resource`.

- AWS::SNS::Subscription
- AWS::SNS::TopicPolicy
- AWS::SQS::QueuePolicy
- AWS::S3::BucketPolicy
- AWS::Lambda::Permission
- AWS::Lambda::EventSourceMapping
- AWS::Lambda::Url
- AWS::CloudFormation::CustomResource
- AWS::CloudFront::CloudFrontOriginAccessIdentity
- AWS::BedrockAgentCore::Runtime (has `ListTagsForResource`; could grow auto-lookup later)

## Cloud Control API fallback

Any other CC-API-supported resource type can be imported via the same
`--resource <logicalId>=<physicalId>` override. cdkd does not run
auto-lookup over Cloud Control API by default — it would issue an
`aws-cloudcontrol:ListResources` call per type, which is too expensive
for whole-stack adoption.

## Unsupported

Resource types whose cdkd provider does not implement `import()` (or
which have no provider at all) are reported as `unsupported` in the
import summary and skipped. The most notable case is
`AWS::CloudFormation::Stack` (nested stacks): cdkd does not deploy
nested CloudFormation stacks, so importing one is also unsupported.
CDK Stages — separate top-level stacks under one app — are fine; pass
the stack's display path or physical name as the positional argument.

## Adding a new entry

When adding `import()` support to a provider, add the resource type to
the appropriate section above. Keep entries one-per-line so parallel
PRs don't conflict on rebase.
