import { ProviderRegistry } from './provider-registry.js';
import { IAMRoleProvider } from './providers/iam-role-provider.js';
import { IAMPolicyProvider } from './providers/iam-policy-provider.js';
import { IAMInstanceProfileProvider } from './providers/iam-instance-profile-provider.js';
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
import { DynamoDBTableProvider } from './providers/dynamodb-table-provider.js';
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
import { StepFunctionsProvider } from './providers/stepfunctions-provider.js';
import { ECSProvider } from './providers/ecs-provider.js';
import { ELBv2Provider } from './providers/elbv2-provider.js';
import { RDSProvider } from './providers/rds-provider.js';
import { Route53Provider } from './providers/route53-provider.js';
import { WAFv2WebACLProvider } from './providers/wafv2-provider.js';
import { CognitoUserPoolProvider } from './providers/cognito-provider.js';
import { ElastiCacheProvider } from './providers/elasticache-provider.js';
import { ServiceDiscoveryProvider } from './providers/servicediscovery-provider.js';

/**
 * Register all SDK providers with the given registry.
 * Called from both deploy and destroy commands.
 */
export function registerAllProviders(registry: ProviderRegistry): void {
  // IAM
  registry.register('AWS::IAM::Role', new IAMRoleProvider());
  registry.register('AWS::IAM::Policy', new IAMPolicyProvider());
  registry.register('AWS::IAM::InstanceProfile', new IAMInstanceProfileProvider());

  // S3
  registry.register('AWS::S3::Bucket', new S3BucketProvider());
  registry.register('AWS::S3::BucketPolicy', new S3BucketPolicyProvider());

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

  // DynamoDB
  registry.register('AWS::DynamoDB::Table', new DynamoDBTableProvider());

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
  registry.register('AWS::EC2::RouteTable', ec2Provider);
  registry.register('AWS::EC2::Route', ec2Provider);
  registry.register('AWS::EC2::SubnetRouteTableAssociation', ec2Provider);
  registry.register('AWS::EC2::SecurityGroup', ec2Provider);
  registry.register('AWS::EC2::SecurityGroupIngress', ec2Provider);
  registry.register('AWS::EC2::Instance', ec2Provider);

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

  // Route53
  const route53Provider = new Route53Provider();
  registry.register('AWS::Route53::HostedZone', route53Provider);
  registry.register('AWS::Route53::RecordSet', route53Provider);

  // WAFv2
  registry.register('AWS::WAFv2::WebACL', new WAFv2WebACLProvider());

  // Cognito
  registry.register('AWS::Cognito::UserPool', new CognitoUserPoolProvider());

  // ElastiCache
  const elasticacheProvider = new ElastiCacheProvider();
  registry.register('AWS::ElastiCache::SubnetGroup', elasticacheProvider);
  registry.register('AWS::ElastiCache::CacheCluster', elasticacheProvider);

  // Service Discovery
  const serviceDiscoveryProvider = new ServiceDiscoveryProvider();
  registry.register('AWS::ServiceDiscovery::PrivateDnsNamespace', serviceDiscoveryProvider);
  registry.register('AWS::ServiceDiscovery::Service', serviceDiscoveryProvider);

  // Bedrock
  registry.register('AWS::BedrockAgentCore::Runtime', new AgentCoreRuntimeProvider());
}
