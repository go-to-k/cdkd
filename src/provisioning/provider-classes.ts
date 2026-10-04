/**
 * Every SDK provider class, re-exported for `registerAllProviders()`, which
 * imports this module DYNAMICALLY. Provider modules statically import their
 * `@aws-sdk/client-*` packages, so a static path from the command tree to here
 * would make every `cdkd` invocation (`--help`, `synth`, `list`) evaluate all
 * of them (issue #4521). Import provider classes through
 * `registerAllProviders()`, never from here statically.
 */
export { IAMRoleProvider } from './providers/iam-role-provider.js';
export { IAMPolicyProvider } from './providers/iam-policy-provider.js';
export { IAMManagedPolicyProvider } from './providers/iam-managed-policy-provider.js';
export { IAMInstanceProfileProvider } from './providers/iam-instance-profile-provider.js';
export { IAMAccessKeyProvider } from './providers/iam-access-key-provider.js';
export { IAMUserGroupProvider } from './providers/iam-user-group-provider.js';
export { S3BucketProvider } from './providers/s3-bucket-provider.js';
export { S3BucketPolicyProvider } from './providers/s3-bucket-policy-provider.js';
export { SQSQueueProvider } from './providers/sqs-queue-provider.js';
export { SQSQueuePolicyProvider } from './providers/sqs-queue-policy-provider.js';
export { SNSTopicProvider } from './providers/sns-topic-provider.js';
export { SNSSubscriptionProvider } from './providers/sns-subscription-provider.js';
export { SNSTopicPolicyProvider } from './providers/sns-topic-policy-provider.js';
export { LambdaFunctionProvider } from './providers/lambda-function-provider.js';
export { LambdaPermissionProvider } from './providers/lambda-permission-provider.js';
export { LambdaUrlProvider } from './providers/lambda-url-provider.js';
export { LambdaEventSourceMappingProvider } from './providers/lambda-eventsource-provider.js';
export { LambdaLayerVersionProvider } from './providers/lambda-layer-provider.js';
export { LambdaEventInvokeConfigProvider } from './providers/lambda-event-invoke-config-provider.js';
export { LambdaMicrovmImageProvider } from './providers/lambda-microvm-image-provider.js';
export { DynamoDBTableProvider } from './providers/dynamodb-table-provider.js';
export { DynamoDBGlobalTableProvider } from './providers/dynamodb-globaltable-provider.js';
export { LogsLogGroupProvider } from './providers/logs-loggroup-provider.js';
export { CloudWatchAlarmProvider } from './providers/cloudwatch-alarm-provider.js';
export { CloudWatchAnomalyDetectorProvider } from './providers/cloudwatch-anomaly-detector-provider.js';
export { SecretsManagerSecretProvider } from './providers/secretsmanager-secret-provider.js';
export { SSMParameterProvider } from './providers/ssm-parameter-provider.js';
export { EventBridgeRuleProvider } from './providers/eventbridge-rule-provider.js';
export { EventBridgeBusProvider } from './providers/eventbridge-bus-provider.js';
export { EC2Provider } from './providers/ec2-provider.js';
export { ApiGatewayProvider } from './providers/apigateway-provider.js';
export { ApiGatewayV2Provider } from './providers/apigatewayv2-provider.js';
export { CloudFrontOAIProvider } from './providers/cloudfront-oai-provider.js';
export { CloudFrontOACProvider } from './providers/cloudfront-oac-provider.js';
export { CloudFrontDistributionProvider } from './providers/cloudfront-distribution-provider.js';
export { AgentCoreRuntimeProvider } from './providers/agentcore-runtime-provider.js';
export { AgentCoreBrowserProvider } from './providers/agentcore-browser-provider.js';
export { AgentCoreCodeInterpreterProvider } from './providers/agentcore-code-interpreter-provider.js';
export { AgentCoreEvaluatorProvider } from './providers/agentcore-evaluator-provider.js';
export { StepFunctionsProvider } from './providers/stepfunctions-provider.js';
export { ECSProvider } from './providers/ecs-provider.js';
export { ELBv2Provider } from './providers/elbv2-provider.js';
export { RDSProvider } from './providers/rds-provider.js';
export { RDSDBProxyProvider } from './providers/rds-dbproxy-provider.js';
export { RDSDBProxyEndpointProvider } from './providers/rds-dbproxy-endpoint-provider.js';
export { RDSDBProxyTargetGroupProvider } from './providers/rds-dbproxy-targetgroup-provider.js';
export { DocDBProvider } from './providers/docdb-provider.js';
export { DocDBSubnetGroupProvider } from './providers/docdb-subnet-group-provider.js';
export { NeptuneProvider } from './providers/neptune-provider.js';
export { Route53Provider } from './providers/route53-provider.js';
export { WAFv2WebACLProvider } from './providers/wafv2-provider.js';
export { CognitoUserPoolProvider } from './providers/cognito-provider.js';
export { ElastiCacheProvider } from './providers/elasticache-provider.js';
export { ServiceDiscoveryProvider } from './providers/servicediscovery-provider.js';
export { AppSyncProvider } from './providers/appsync-provider.js';
export {
  GlueProvider,
  GlueWorkflowProvider,
  GlueSecurityConfigurationProvider,
  GlueJobProvider,
  GlueCrawlerProvider,
  GlueConnectionProvider,
  GlueTriggerProvider,
} from './providers/glue-provider.js';
export { KMSProvider } from './providers/kms-provider.js';
export { BudgetsBudgetProvider } from './providers/budgets-budget-provider.js';
export { KinesisStreamProvider } from './providers/kinesis-provider.js';
export { KinesisStreamConsumerProvider } from './providers/kinesis-streamconsumer-provider.js';
export { SchedulerScheduleProvider } from './providers/scheduler-schedule-provider.js';
export { PipesPipeProvider } from './providers/pipes-provider.js';
export { EFSProvider } from './providers/efs-provider.js';
export { FSxFileSystemProvider } from './providers/fsx-filesystem-provider.js';
export { EMRClusterProvider } from './providers/emr-cluster-provider.js';
export { EMRInstanceGroupConfigProvider } from './providers/emr-instance-group-config-provider.js';
export { EMRInstanceFleetConfigProvider } from './providers/emr-instance-fleet-config-provider.js';
export { FirehoseProvider } from './providers/firehose-provider.js';
export { CloudTrailProvider } from './providers/cloudtrail-provider.js';
export { CodeBuildProvider } from './providers/codebuild-provider.js';
export { CodeCommitRepositoryProvider } from './providers/codecommit-repository-provider.js';
export { DLMLifecyclePolicyProvider } from './providers/dlm-lifecycle-policy-provider.js';
export { S3VectorsProvider } from './providers/s3-vectors-provider.js';
export { S3DirectoryBucketProvider } from './providers/s3-directory-bucket-provider.js';
export { S3TablesProvider } from './providers/s3-tables-provider.js';
export { ECRProvider } from './providers/ecr-provider.js';
export { ASGProvider } from './providers/asg-provider.js';
export { NestedStackProvider } from './providers/nested-stack-provider.js';
export { WaitConditionHandleProvider } from './providers/wait-condition-handle-provider.js';
export { ACMCertificateProvider } from './providers/acm-certificate-provider.js';
