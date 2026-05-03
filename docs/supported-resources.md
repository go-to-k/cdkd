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

If a resource type has no SDK Provider AND is not supported by Cloud
Control API, cdkd cannot deploy it. The deploy fails with a clear error
message naming the unsupported type.

## Resource types

| Category | Resource Type | Provider | Status |
|----------|--------------|----------|--------|
| **IAM** | AWS::IAM::Role | SDK Provider | ✅ |
| **IAM** | AWS::IAM::Policy | SDK Provider | ✅ |
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
| **Database** | AWS::DynamoDB::Table | SDK Provider | ✅ |
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
| **DNS** | AWS::Route53::HostedZone | SDK Provider | ✅ |
| **DNS** | AWS::Route53::RecordSet | SDK Provider | ✅ |
| **Security** | AWS::WAFv2::WebACL | SDK Provider | ✅ |
| **Auth** | AWS::Cognito::UserPool | SDK Provider | ✅ |
| **Cache** | AWS::ElastiCache::CacheCluster | SDK Provider | ✅ |
| **Cache** | AWS::ElastiCache::SubnetGroup | SDK Provider | ✅ |
| **Discovery** | AWS::ServiceDiscovery::PrivateDnsNamespace | SDK Provider | ✅ |
| **Discovery** | AWS::ServiceDiscovery::Service | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::GraphQLApi | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::GraphQLSchema | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::DataSource | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::Resolver | SDK Provider | ✅ |
| **GraphQL** | AWS::AppSync::ApiKey | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Database | SDK Provider | ✅ |
| **Analytics** | AWS::Glue::Table | SDK Provider | ✅ |
| **Encryption** | AWS::KMS::Key | SDK Provider | ✅ |
| **Encryption** | AWS::KMS::Alias | SDK Provider | ✅ |
| **Streaming** | AWS::Kinesis::Stream | SDK Provider | ✅ |
| **Streaming** | AWS::KinesisFirehose::DeliveryStream | SDK Provider | ✅ |
| **Storage** | AWS::EFS::FileSystem | SDK Provider | ✅ |
| **Storage** | AWS::EFS::MountTarget | SDK Provider | ✅ |
| **Storage** | AWS::EFS::AccessPoint | SDK Provider | ✅ |
| **Storage** | AWS::S3Express::DirectoryBucket | SDK Provider | ✅ |
| **Storage** | AWS::S3Tables::TableBucket | SDK Provider | ✅ |
| **Storage** | AWS::S3Tables::Namespace | SDK Provider | ✅ |
| **Storage** | AWS::S3Tables::Table | SDK Provider | ✅ |
| **Storage** | AWS::S3Vectors::VectorBucket | SDK Provider | ✅ |
| **Audit** | AWS::CloudTrail::Trail | SDK Provider | ✅ |
| **CI/CD** | AWS::CodeBuild::Project | SDK Provider | ✅ |
| **AI/ML** | AWS::BedrockAgentCore::Runtime | SDK Provider | ✅ |
| **Custom** | Custom::* (Lambda/SNS-backed) | SDK Provider | ✅ |
| **Other** | All other resource types | Cloud Control | ✅ |

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
