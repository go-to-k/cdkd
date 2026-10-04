import type { ProviderRegistry } from './provider-registry.js';

export type ProviderClasses = typeof import('./provider-classes.js');

let providerClasses: Promise<ProviderClasses> | undefined;

/**
 * Load every SDK provider class, once per process.
 *
 * The classes are NOT imported at module scope: each provider module evaluates
 * its `@aws-sdk/client-*` package, and every command module that registers
 * providers is reached statically from the command tree, so a static import
 * made every `cdkd` invocation (`--help`, `synth`, `list`) pay for all of them
 * (issue #4521). Await this first, before the synchronous section that sets a
 * stack's AWS client scope / globals and calls `registerAllProviders`, so no
 * await separates the two.
 */
export function loadProviderClasses(): Promise<ProviderClasses> {
  providerClasses ??= import('./provider-classes.js');
  return providerClasses;
}

/**
 * Register all SDK providers with the given registry. Called by every command
 * that provisions, reads or deletes resources, with the classes from
 * {@link loadProviderClasses}. Every type is registered.
 */
export function registerAllProviders(registry: ProviderRegistry, classes: ProviderClasses): void {
  const {
    IAMRoleProvider,
    IAMPolicyProvider,
    IAMManagedPolicyProvider,
    IAMInstanceProfileProvider,
    IAMAccessKeyProvider,
    IAMUserGroupProvider,
    S3BucketProvider,
    S3BucketPolicyProvider,
    SQSQueueProvider,
    SQSQueuePolicyProvider,
    SNSTopicProvider,
    SNSSubscriptionProvider,
    SNSTopicPolicyProvider,
    LambdaFunctionProvider,
    LambdaPermissionProvider,
    LambdaUrlProvider,
    LambdaEventSourceMappingProvider,
    LambdaLayerVersionProvider,
    LambdaEventInvokeConfigProvider,
    LambdaMicrovmImageProvider,
    DynamoDBTableProvider,
    DynamoDBGlobalTableProvider,
    LogsLogGroupProvider,
    CloudWatchAlarmProvider,
    CloudWatchAnomalyDetectorProvider,
    SecretsManagerSecretProvider,
    SSMParameterProvider,
    EventBridgeRuleProvider,
    EventBridgeBusProvider,
    EC2Provider,
    ApiGatewayProvider,
    ApiGatewayV2Provider,
    CloudFrontOAIProvider,
    CloudFrontOACProvider,
    CloudFrontDistributionProvider,
    AgentCoreRuntimeProvider,
    AgentCoreBrowserProvider,
    AgentCoreCodeInterpreterProvider,
    AgentCoreEvaluatorProvider,
    StepFunctionsProvider,
    ECSProvider,
    ELBv2Provider,
    RDSProvider,
    RDSDBProxyProvider,
    RDSDBProxyEndpointProvider,
    RDSDBProxyTargetGroupProvider,
    DocDBProvider,
    DocDBSubnetGroupProvider,
    NeptuneProvider,
    Route53Provider,
    WAFv2WebACLProvider,
    CognitoUserPoolProvider,
    ElastiCacheProvider,
    ServiceDiscoveryProvider,
    AppSyncProvider,
    GlueProvider,
    GlueWorkflowProvider,
    GlueSecurityConfigurationProvider,
    GlueJobProvider,
    GlueCrawlerProvider,
    GlueConnectionProvider,
    GlueTriggerProvider,
    KMSProvider,
    BudgetsBudgetProvider,
    KinesisStreamProvider,
    KinesisStreamConsumerProvider,
    SchedulerScheduleProvider,
    PipesPipeProvider,
    EFSProvider,
    FSxFileSystemProvider,
    EMRClusterProvider,
    EMRInstanceGroupConfigProvider,
    EMRInstanceFleetConfigProvider,
    FirehoseProvider,
    CloudTrailProvider,
    CodeBuildProvider,
    CodeCommitRepositoryProvider,
    DLMLifecyclePolicyProvider,
    S3VectorsProvider,
    S3DirectoryBucketProvider,
    S3TablesProvider,
    ECRProvider,
    ASGProvider,
    NestedStackProvider,
    WaitConditionHandleProvider,
    ACMCertificateProvider,
  } = classes;

  // IAM
  registry.register('AWS::IAM::Role', new IAMRoleProvider());
  registry.register('AWS::IAM::Policy', new IAMPolicyProvider());
  registry.register('AWS::IAM::ManagedPolicy', new IAMManagedPolicyProvider());
  registry.register('AWS::IAM::InstanceProfile', new IAMInstanceProfileProvider());
  registry.register('AWS::IAM::AccessKey', new IAMAccessKeyProvider());
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
  registry.register('AWS::Lambda::MicrovmImage', new LambdaMicrovmImageProvider());

  // DynamoDB
  registry.register('AWS::DynamoDB::Table', new DynamoDBTableProvider());
  registry.register('AWS::DynamoDB::GlobalTable', new DynamoDBGlobalTableProvider());

  // Monitoring
  registry.register('AWS::Logs::LogGroup', new LogsLogGroupProvider());
  registry.register('AWS::CloudWatch::Alarm', new CloudWatchAlarmProvider());
  registry.register('AWS::CloudWatch::AnomalyDetector', new CloudWatchAnomalyDetectorProvider());

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
  registry.register('AWS::EC2::EIP', ec2Provider);
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
  registry.register('AWS::CloudFront::OriginAccessControl', new CloudFrontOACProvider());
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

  // DocumentDB (RDS-shaped API). The subnet group has a provider of its own:
  // the cluster and instance are NON_PROVISIONABLE and their provider opts out
  // of the Cloud Control fallback, which the subnet group must keep (#3866).
  registry.register('AWS::DocDB::DBSubnetGroup', new DocDBSubnetGroupProvider());
  const docdbProvider = new DocDBProvider();
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
  // Cloud Control cannot change a stream source's SourceParameters (issue
  // #4423); UpdatePipe takes a shape without the create-only members.
  registry.register('AWS::Pipes::Pipe', new PipesPipeProvider());

  // EFS
  const efsProvider = new EFSProvider();
  registry.register('AWS::EFS::FileSystem', efsProvider);
  registry.register('AWS::EFS::MountTarget', efsProvider);
  registry.register('AWS::EFS::AccessPoint', efsProvider);

  // FSx — NON_PROVISIONABLE in the CFn registry, so no Cloud Control
  // fallback exists (issue #1042). All four variants are handled by the SDK
  // provider: Lustre (issue #1042) plus Windows / ONTAP / OpenZFS (issue
  // #1068). `disableCcApiFallback` still guards against CC-routing any
  // future unhandled property.
  registry.register('AWS::FSx::FileSystem', new FSxFileSystemProvider());

  // EMR — NON_PROVISIONABLE in the CFn registry, so no Cloud Control
  // fallback exists (issue #1043). RunJobFlow-backed create + limited
  // mutable update surface (termination protection / visibility /
  // step concurrency / managed-scaling / auto-termination / tags);
  // everything else is createOnly → replacement.
  registry.register('AWS::EMR::Cluster', new EMRClusterProvider());

  // EMR InstanceGroupConfig / InstanceFleetConfig — also NON_PROVISIONABLE
  // (issue #1070). These add a standalone instance group / fleet to an
  // EXISTING cluster (referenced by JobFlowId / ClusterId) via
  // AddInstanceGroups / AddInstanceFleet, with a limited mutable update
  // surface (resize + config); delete has no standalone AWS API, so it is a
  // no-op that relies on the parent cluster's TerminateJobFlows (best-effort
  // scale-to-0 for TASK groups/fleets).
  registry.register('AWS::EMR::InstanceGroupConfig', new EMRInstanceGroupConfigProvider());
  registry.register('AWS::EMR::InstanceFleetConfig', new EMRInstanceFleetConfigProvider());

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
