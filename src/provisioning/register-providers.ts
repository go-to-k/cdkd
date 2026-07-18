import { ProviderRegistry } from './provider-registry.js';
import { IAMRoleProvider } from './providers/iam-role-provider.js';
import { IAMPolicyProvider } from './providers/iam-policy-provider.js';
import { IAMManagedPolicyProvider } from './providers/iam-managed-policy-provider.js';
import { IAMInstanceProfileProvider } from './providers/iam-instance-profile-provider.js';
import { IAMUserGroupProvider } from './providers/iam-user-group-provider.js';
import { S3BucketProvider } from './providers/s3-bucket-provider.js';
import { S3BucketPolicyProvider } from './providers/s3-bucket-policy-provider.js';
import { SQSQueueProvider } from './providers/sqs-queue-provider.js';
import { SQSQueuePolicyProvider } from './providers/sqs-queue-policy-provider.js';
import { SNSTopicProvider } from './providers/sns-topic-provider.js';
import { SNSSubscriptionProvider } from './providers/sns-subscription-provider.js';
import { SNSTopicPolicyProvider } from './providers/sns-topic-policy-provider.js';
import { LambdaFunctionProvider } from './providers/lambda-function-provider.js';
import { LambdaPermissionProvider } from './providers/lambda-permission-provider.js';
import { LambdaUrlProvider } from './providers/lambda-url-provider.js';
import { LambdaEventSourceMappingProvider } from './providers/lambda-eventsource-provider.js';
import { LambdaLayerVersionProvider } from './providers/lambda-layer-provider.js';
import { LambdaEventInvokeConfigProvider } from './providers/lambda-event-invoke-config-provider.js';
import { DynamoDBTableProvider } from './providers/dynamodb-table-provider.js';
import { DynamoDBGlobalTableProvider } from './providers/dynamodb-globaltable-provider.js';
import { LogsLogGroupProvider } from './providers/logs-loggroup-provider.js';
import { CloudWatchAlarmProvider } from './providers/cloudwatch-alarm-provider.js';
import { SecretsManagerSecretProvider } from './providers/secretsmanager-secret-provider.js';
import { SSMParameterProvider } from './providers/ssm-parameter-provider.js';
import { EventBridgeRuleProvider } from './providers/eventbridge-rule-provider.js';
import { EventBridgeBusProvider } from './providers/eventbridge-bus-provider.js';
import { EC2Provider } from './providers/ec2-provider.js';
import { ApiGatewayProvider } from './providers/apigateway-provider.js';
import { ApiGatewayV2Provider } from './providers/apigatewayv2-provider.js';
import { CloudFrontOAIProvider } from './providers/cloudfront-oai-provider.js';
import { CloudFrontDistributionProvider } from './providers/cloudfront-distribution-provider.js';
import { AgentCoreRuntimeProvider } from './providers/agentcore-runtime-provider.js';
import { AgentCoreBrowserProvider } from './providers/agentcore-browser-provider.js';
import { AgentCoreCodeInterpreterProvider } from './providers/agentcore-code-interpreter-provider.js';
import { AgentCoreEvaluatorProvider } from './providers/agentcore-evaluator-provider.js';
import { StepFunctionsProvider } from './providers/stepfunctions-provider.js';
import { ECSProvider } from './providers/ecs-provider.js';
import { ELBv2Provider } from './providers/elbv2-provider.js';
import { RDSProvider } from './providers/rds-provider.js';
import { RDSDBProxyProvider } from './providers/rds-dbproxy-provider.js';
import { RDSDBProxyEndpointProvider } from './providers/rds-dbproxy-endpoint-provider.js';
import { RDSDBProxyTargetGroupProvider } from './providers/rds-dbproxy-targetgroup-provider.js';
import { DocDBProvider } from './providers/docdb-provider.js';
import { NeptuneProvider } from './providers/neptune-provider.js';
import { Route53Provider } from './providers/route53-provider.js';
import { WAFv2WebACLProvider } from './providers/wafv2-provider.js';
import { CognitoUserPoolProvider } from './providers/cognito-provider.js';
import { ElastiCacheProvider } from './providers/elasticache-provider.js';
import { ServiceDiscoveryProvider } from './providers/servicediscovery-provider.js';
import { AppSyncProvider } from './providers/appsync-provider.js';
import {
  GlueProvider,
  GlueWorkflowProvider,
  GlueSecurityConfigurationProvider,
  GlueJobProvider,
  GlueCrawlerProvider,
  GlueConnectionProvider,
  GlueTriggerProvider,
} from './providers/glue-provider.js';
import { KMSProvider } from './providers/kms-provider.js';
import { BudgetsBudgetProvider } from './providers/budgets-budget-provider.js';
import { KinesisStreamProvider } from './providers/kinesis-provider.js';
import { KinesisStreamConsumerProvider } from './providers/kinesis-streamconsumer-provider.js';
import { SchedulerScheduleProvider } from './providers/scheduler-schedule-provider.js';
import { EFSProvider } from './providers/efs-provider.js';
import { FSxFileSystemProvider } from './providers/fsx-filesystem-provider.js';
import { EMRClusterProvider } from './providers/emr-cluster-provider.js';
import { FirehoseProvider } from './providers/firehose-provider.js';
import { CloudTrailProvider } from './providers/cloudtrail-provider.js';
import { CodeBuildProvider } from './providers/codebuild-provider.js';
import { CodeCommitRepositoryProvider } from './providers/codecommit-repository-provider.js';
import { DLMLifecyclePolicyProvider } from './providers/dlm-lifecycle-policy-provider.js';
import { S3VectorsProvider } from './providers/s3-vectors-provider.js';
import { S3DirectoryBucketProvider } from './providers/s3-directory-bucket-provider.js';
import { S3TablesProvider } from './providers/s3-tables-provider.js';
import { ECRProvider } from './providers/ecr-provider.js';
import { ASGProvider } from './providers/asg-provider.js';
import { NestedStackProvider } from './providers/nested-stack-provider.js';
import { WaitConditionHandleProvider } from './providers/wait-condition-handle-provider.js';
import { ACMCertificateProvider } from './providers/acm-certificate-provider.js';

/**
 * Register all SDK providers with the given registry.
 * Called from both deploy and destroy commands.
 */
export function registerAllProviders(registry: ProviderRegistry): void {
  // IAM
  registry.register('AWS::IAM::Role', new IAMRoleProvider());
  registry.register('AWS::IAM::Policy', new IAMPolicyProvider());
  registry.register('AWS::IAM::ManagedPolicy', new IAMManagedPolicyProvider());
  registry.register('AWS::IAM::InstanceProfile', new IAMInstanceProfileProvider());
  const iamUserGroupProvider = new IAMUserGroupProvider();
  registry.register('AWS::IAM::User', iamUserGroupProvider);
  registry.register('AWS::IAM::Group', iamUserGroupProvider);
  registry.register('AWS::IAM::UserToGroupAddition', iamUserGroupProvider);

  // S3
  registry.register('AWS::S3::Bucket', new S3BucketProvider());
  registry.register('AWS::S3::BucketPolicy', new S3BucketPolicyProvider());
  registry.register('AWS::S3Express::DirectoryBucket', new S3DirectoryBucketProvider());

  // SQS
  registry.register('AWS::SQS::Queue', new SQSQueueProvider());
  registry.register('AWS::SQS::QueuePolicy', new SQSQueuePolicyProvider());

  // SNS
  registry.register('AWS::SNS::Topic', new SNSTopicProvider());
  registry.register('AWS::SNS::Subscription', new SNSSubscriptionProvider());
  registry.register('AWS::SNS::TopicPolicy', new SNSTopicPolicyProvider());

  // Lambda
  registry.register('AWS::Lambda::Function', new LambdaFunctionProvider());
  registry.register('AWS::Lambda::Permission', new LambdaPermissionProvider());
  registry.register('AWS::Lambda::Url', new LambdaUrlProvider());
  registry.register('AWS::Lambda::EventSourceMapping', new LambdaEventSourceMappingProvider());
  registry.register('AWS::Lambda::LayerVersion', new LambdaLayerVersionProvider());
  registry.register('AWS::Lambda::EventInvokeConfig', new LambdaEventInvokeConfigProvider());

  // DynamoDB
  registry.register('AWS::DynamoDB::Table', new DynamoDBTableProvider());
  registry.register('AWS::DynamoDB::GlobalTable', new DynamoDBGlobalTableProvider());

  // Monitoring
  registry.register('AWS::Logs::LogGroup', new LogsLogGroupProvider());
  registry.register('AWS::CloudWatch::Alarm', new CloudWatchAlarmProvider());

  // Secrets / Config
  registry.register('AWS::SecretsManager::Secret', new SecretsManagerSecretProvider());
  registry.register('AWS::SSM::Parameter', new SSMParameterProvider());

  // EventBridge
  registry.register('AWS::Events::Rule', new EventBridgeRuleProvider());
  registry.register('AWS::Events::EventBus', new EventBridgeBusProvider());

  // EC2 / Networking
  const ec2Provider = new EC2Provider();
  registry.register('AWS::EC2::VPC', ec2Provider);
  registry.register('AWS::EC2::Subnet', ec2Provider);
  registry.register('AWS::EC2::InternetGateway', ec2Provider);
  registry.register('AWS::EC2::VPCGatewayAttachment', ec2Provider);
  registry.register('AWS::EC2::NatGateway', ec2Provider);
  registry.register('AWS::EC2::RouteTable', ec2Provider);
  registry.register('AWS::EC2::Route', ec2Provider);
  registry.register('AWS::EC2::SubnetRouteTableAssociation', ec2Provider);
  registry.register('AWS::EC2::SecurityGroup', ec2Provider);
  registry.register('AWS::EC2::SecurityGroupIngress', ec2Provider);
  registry.register('AWS::EC2::Instance', ec2Provider);
  registry.register('AWS::EC2::NetworkAcl', ec2Provider);
  registry.register('AWS::EC2::NetworkAclEntry', ec2Provider);
  registry.register('AWS::EC2::SubnetNetworkAclAssociation', ec2Provider);

  // API Gateway
  const apigwProvider = new ApiGatewayProvider();
  registry.register('AWS::ApiGateway::Account', apigwProvider);
  registry.register('AWS::ApiGateway::Authorizer', apigwProvider);
  registry.register('AWS::ApiGateway::Resource', apigwProvider);
  registry.register('AWS::ApiGateway::Deployment', apigwProvider);
  registry.register('AWS::ApiGateway::Stage', apigwProvider);
  registry.register('AWS::ApiGateway::Method', apigwProvider);

  // API Gateway V2 (HTTP API)
  const apigwV2Provider = new ApiGatewayV2Provider();
  registry.register('AWS::ApiGatewayV2::Api', apigwV2Provider);
  registry.register('AWS::ApiGatewayV2::Stage', apigwV2Provider);
  registry.register('AWS::ApiGatewayV2::Integration', apigwV2Provider);
  registry.register('AWS::ApiGatewayV2::Route', apigwV2Provider);
  registry.register('AWS::ApiGatewayV2::Authorizer', apigwV2Provider);

  // CloudFront
  registry.register('AWS::CloudFront::CloudFrontOriginAccessIdentity', new CloudFrontOAIProvider());
  registry.register('AWS::CloudFront::Distribution', new CloudFrontDistributionProvider());

  // StepFunctions
  registry.register('AWS::StepFunctions::StateMachine', new StepFunctionsProvider());

  // ECS
  const ecsProvider = new ECSProvider();
  registry.register('AWS::ECS::Cluster', ecsProvider);
  registry.register('AWS::ECS::TaskDefinition', ecsProvider);
  registry.register('AWS::ECS::Service', ecsProvider);

  // ELBv2
  const elbv2Provider = new ELBv2Provider();
  registry.register('AWS::ElasticLoadBalancingV2::LoadBalancer', elbv2Provider);
  registry.register('AWS::ElasticLoadBalancingV2::TargetGroup', elbv2Provider);
  registry.register('AWS::ElasticLoadBalancingV2::Listener', elbv2Provider);

  // RDS
  const rdsProvider = new RDSProvider();
  registry.register('AWS::RDS::DBSubnetGroup', rdsProvider);
  registry.register('AWS::RDS::DBCluster', rdsProvider);
  registry.register('AWS::RDS::DBInstance', rdsProvider);
  registry.register('AWS::RDS::DBProxy', new RDSDBProxyProvider());
  registry.register('AWS::RDS::DBProxyEndpoint', new RDSDBProxyEndpointProvider());
  registry.register('AWS::RDS::DBProxyTargetGroup', new RDSDBProxyTargetGroupProvider());

  // DocumentDB (RDS-shaped API)
  const docdbProvider = new DocDBProvider();
  registry.register('AWS::DocDB::DBSubnetGroup', docdbProvider);
  registry.register('AWS::DocDB::DBCluster', docdbProvider);
  registry.register('AWS::DocDB::DBInstance', docdbProvider);

  // Neptune (RDS-shaped API)
  const neptuneProvider = new NeptuneProvider();
  registry.register('AWS::Neptune::DBSubnetGroup', neptuneProvider);
  registry.register('AWS::Neptune::DBCluster', neptuneProvider);
  registry.register('AWS::Neptune::DBInstance', neptuneProvider);

  // Route53
  const route53Provider = new Route53Provider();
  registry.register('AWS::Route53::HostedZone', route53Provider);
  registry.register('AWS::Route53::RecordSet', route53Provider);

  // WAFv2
  registry.register('AWS::WAFv2::WebACL', new WAFv2WebACLProvider());

  // Cognito
  registry.register('AWS::Cognito::UserPool', new CognitoUserPoolProvider());

  // ACM (Certificate Manager)
  registry.register('AWS::CertificateManager::Certificate', new ACMCertificateProvider());

  // ElastiCache
  const elasticacheProvider = new ElastiCacheProvider();
  registry.register('AWS::ElastiCache::SubnetGroup', elasticacheProvider);
  registry.register('AWS::ElastiCache::CacheCluster', elasticacheProvider);

  // Service Discovery
  const serviceDiscoveryProvider = new ServiceDiscoveryProvider();
  registry.register('AWS::ServiceDiscovery::PrivateDnsNamespace', serviceDiscoveryProvider);
  registry.register('AWS::ServiceDiscovery::HttpNamespace', serviceDiscoveryProvider);
  registry.register('AWS::ServiceDiscovery::PublicDnsNamespace', serviceDiscoveryProvider);
  registry.register('AWS::ServiceDiscovery::Service', serviceDiscoveryProvider);

  // Bedrock
  registry.register('AWS::BedrockAgentCore::Runtime', new AgentCoreRuntimeProvider());
  registry.register('AWS::BedrockAgentCore::Browser', new AgentCoreBrowserProvider());
  registry.register(
    'AWS::BedrockAgentCore::CodeInterpreter',
    new AgentCoreCodeInterpreterProvider()
  );
  registry.register('AWS::BedrockAgentCore::Evaluator', new AgentCoreEvaluatorProvider());

  // AppSync
  const appSyncProvider = new AppSyncProvider();
  registry.register('AWS::AppSync::GraphQLApi', appSyncProvider);
  registry.register('AWS::AppSync::GraphQLSchema', appSyncProvider);
  registry.register('AWS::AppSync::DataSource', appSyncProvider);
  registry.register('AWS::AppSync::Resolver', appSyncProvider);
  registry.register('AWS::AppSync::ApiKey', appSyncProvider);

  // Glue
  const glueProvider = new GlueProvider();
  registry.register('AWS::Glue::Database', glueProvider);
  registry.register('AWS::Glue::Table', glueProvider);
  registry.register('AWS::Glue::Workflow', new GlueWorkflowProvider());
  registry.register('AWS::Glue::SecurityConfiguration', new GlueSecurityConfigurationProvider());
  registry.register('AWS::Glue::Job', new GlueJobProvider());
  registry.register('AWS::Glue::Crawler', new GlueCrawlerProvider());
  registry.register('AWS::Glue::Connection', new GlueConnectionProvider());
  registry.register('AWS::Glue::Trigger', new GlueTriggerProvider());

  // KMS
  const kmsProvider = new KMSProvider();
  registry.register('AWS::KMS::Key', kmsProvider);
  registry.register('AWS::KMS::Alias', kmsProvider);

  // Kinesis
  registry.register('AWS::Kinesis::Stream', new KinesisStreamProvider());
  registry.register('AWS::Kinesis::StreamConsumer', new KinesisStreamConsumerProvider());
  // Custom-group schedules are unaddressable via Cloud Control (issue #961) —
  // the SDK provider threads GroupName from the resource properties.
  registry.register('AWS::Scheduler::Schedule', new SchedulerScheduleProvider());

  // EFS
  const efsProvider = new EFSProvider();
  registry.register('AWS::EFS::FileSystem', efsProvider);
  registry.register('AWS::EFS::MountTarget', efsProvider);
  registry.register('AWS::EFS::AccessPoint', efsProvider);

  // FSx — NON_PROVISIONABLE in the CFn registry, so no Cloud Control
  // fallback exists (issue #1042). Lustre variant only in v1; the
  // Windows / ONTAP / OpenZFS config blocks are unhandledByDesign and
  // rejected by the property-coverage pre-flight.
  registry.register('AWS::FSx::FileSystem', new FSxFileSystemProvider());

  // EMR — NON_PROVISIONABLE in the CFn registry, so no Cloud Control
  // fallback exists (issue #1043). RunJobFlow-backed create + limited
  // mutable update surface (termination protection / visibility /
  // step concurrency / managed-scaling / auto-termination / tags);
  // everything else is createOnly → replacement.
  registry.register('AWS::EMR::Cluster', new EMRClusterProvider());

  // Firehose
  registry.register('AWS::KinesisFirehose::DeliveryStream', new FirehoseProvider());

  // CloudTrail
  registry.register('AWS::CloudTrail::Trail', new CloudTrailProvider());

  // CodeBuild
  registry.register('AWS::CodeBuild::Project', new CodeBuildProvider());

  // CodeCommit
  registry.register('AWS::CodeCommit::Repository', new CodeCommitRepositoryProvider());

  // DLM (Data Lifecycle Manager) — NON_PROVISIONABLE in the CFn registry, so
  // no Cloud Control fallback exists (issue #1040).
  registry.register('AWS::DLM::LifecyclePolicy', new DLMLifecyclePolicyProvider());

  // S3 Vectors
  registry.register('AWS::S3Vectors::VectorBucket', new S3VectorsProvider());

  // ECR
  registry.register('AWS::ECR::Repository', new ECRProvider());

  // Auto Scaling
  registry.register('AWS::AutoScaling::AutoScalingGroup', new ASGProvider());

  // S3 Tables
  const s3TablesProvider = new S3TablesProvider();
  registry.register('AWS::S3Tables::TableBucket', s3TablesProvider);
  registry.register('AWS::S3Tables::Namespace', s3TablesProvider);
  registry.register('AWS::S3Tables::Table', s3TablesProvider);

  // Budgets (global API served from us-east-1; the SDK endpoint ruleset
  // routes any configured region to the global endpoint — issue #1041)
  registry.register('AWS::Budgets::Budget', new BudgetsBudgetProvider());

  // Nested stacks (recursive deploy via NestedStackProvider — issue #459).
  // The provider is state-less; per-invocation parent identity + asset paths
  // are propagated through the `NestedStackProviderContext` AsyncLocalStorage
  // (see src/provisioning/nested-stack-context.ts) that deploy.ts / destroy.ts
  // set around their DeployEngine.deploy / runDestroyForStack call.
  registry.register('AWS::CloudFormation::Stack', new NestedStackProvider());

  // WaitConditionHandle is a no-op placeholder outside CloudFormation (its
  // real physical id is a CloudFormation-internal pre-signed URL). Registered
  // so stacks that carry one — e.g. cdk-multi-region-stack's empty-twin
  // placeholder — pass pre-flight and deploy (issue #1020). Note:
  // AWS::CloudFormation::WaitCondition (the blocking signal-wait) remains
  // unsupported.
  registry.register('AWS::CloudFormation::WaitConditionHandle', new WaitConditionHandleProvider());
}
