import { describe, it, expect } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../src/provisioning/register-providers.js';
import { EQUAL_ID_HOOK_TYPES } from '../../../src/deployment/type-change-guard.js';

/**
 * go-to-k/cdkd#7072: the replacement and rollback paths read "the new resource
 * has the old one's physical id" as "the create returned the old resource".
 * That holds only where the id names the resource uniquely. Every registered
 * SDK type is classified here, reviewed against its provider's create:
 *
 * - `minted`: an AWS-assigned (or per-resource generated) id;
 * - `name`: a name AWS keys uniquely in a scope the id fully determines;
 * - `composite`: every create-only property that selects the object is a
 *   segment of the id;
 * - `no-create-only`: no create-only property, so it never replaces;
 * - `hook`: one id can name two resources, so `equalIdNamesDifferentResources`
 *   decides (#3892, #5137, #7071, #7072).
 *
 * A new provider type fails here until it is classified, and a `hook` row
 * fails until the hook decides it.
 */
type IdClass = 'minted' | 'name' | 'composite' | 'no-create-only' | 'hook';
const ROWS: ReadonlyArray<readonly [string, IdClass, string]> = [
  ['AWS::ApiGateway::Account', 'no-create-only', 'fixed id ApiGatewayAccount; type has no create-only properties so never replaces'],
  ['AWS::ApiGateway::Authorizer', 'minted', 'AWS-assigned authorizer id'],
  ['AWS::ApiGateway::Deployment', 'minted', 'AWS-assigned deployment id'],
  ['AWS::ApiGateway::Method', 'composite', 'restApiId|resourceId|httpMethod covers all three create-only properties'],
  ['AWS::ApiGateway::Resource', 'minted', 'AWS-assigned resource id'],
  ['AWS::ApiGateway::RestApi', 'minted', 'AWS-assigned REST API id'],
  ['AWS::ApiGateway::Stage', 'hook', 'bare stageName; RestApiId create-only not in id, so new API gives same id'],
  ['AWS::ApiGatewayV2::Api', 'minted', 'AWS-assigned API id'],
  ['AWS::ApiGatewayV2::Authorizer', 'minted', 'AWS-assigned authorizer id'],
  ['AWS::ApiGatewayV2::Integration', 'minted', 'AWS-assigned integration id'],
  ['AWS::ApiGatewayV2::Route', 'minted', 'AWS-assigned route id'],
  ['AWS::ApiGatewayV2::Stage', 'hook', 'bare stageName; ApiId create-only not in id (confirmed live: $default collides)'],
  ['AWS::AppConfig::Environment', 'minted', 'applicationId|environmentId, environment id AWS-assigned'],
  ['AWS::AppSync::ApiKey', 'minted', 'apiId|apiKeyId, key id AWS-assigned'],
  ['AWS::AppSync::DataSource', 'composite', 'apiId|name covers both create-only properties ApiId and Name'],
  ['AWS::AppSync::GraphQLApi', 'minted', 'AWS-assigned API id'],
  ['AWS::AppSync::GraphQLSchema', 'no-create-only', 'api-scoped schema; type has no create-only properties so never replaces'],
  ['AWS::AppSync::Resolver', 'composite', 'apiId|typeName|fieldName covers all three create-only properties'],
  ['AWS::AutoScaling::AutoScalingGroup', 'name', 'group name, unique per account and region, which the id fully names'],
  ['AWS::BedrockAgentCore::Browser', 'minted', 'AWS-assigned browser ARN'],
  ['AWS::BedrockAgentCore::CodeInterpreter', 'minted', 'AWS-assigned code interpreter ARN'],
  ['AWS::BedrockAgentCore::Evaluator', 'minted', 'AWS-assigned evaluator ARN'],
  ['AWS::BedrockAgentCore::Runtime', 'minted', 'AWS-assigned runtime id'],
  ['AWS::Budgets::Budget', 'name', 'budget name, unique per account (global scope), fully named by id'],
  ['AWS::CertificateManager::Certificate', 'minted', 'AWS-assigned certificate ARN'],
  ['AWS::CloudFormation::Stack', 'name', 'cdkd-derived <parent>~<logicalId>; StackName is not sent, so an equal id is the same child'],
  ['AWS::CloudFormation::WaitCondition', 'minted', 'cdkd-generated id with random UUID per create'],
  ['AWS::CloudFormation::WaitConditionHandle', 'minted', 'pre-signed URL with per-create random signal key'],
  ['AWS::CloudFront::CloudFrontOriginAccessIdentity', 'minted', 'AWS-assigned OAI id'],
  ['AWS::CloudFront::Distribution', 'minted', 'AWS-assigned distribution id'],
  ['AWS::CloudFront::OriginAccessControl', 'minted', 'AWS-assigned OAC id'],
  ['AWS::CloudTrail::Trail', 'name', 'trail ARN carries account, region and name; TrailName only create-only'],
  ['AWS::CloudWatch::Alarm', 'name', 'alarm name, unique per account and region, fully named by id'],
  ['AWS::CloudWatch::AnomalyDetector', 'composite', 'account:namespace:metric:stat:dimensions, the full AWS detector identity'],
  ['AWS::CodeBuild::Project', 'name', 'project name, unique per account and region, fully named by id'],
  ['AWS::CodeCommit::Repository', 'no-create-only', 'repository name id; snapshot lists no create-only properties'],
  ['AWS::Cognito::UserPool', 'minted', 'AWS-assigned user pool id'],
  ['AWS::Connect::Instance', 'minted', 'AWS-assigned instance ARN'],
  ['AWS::DLM::LifecyclePolicy', 'minted', 'AWS-assigned policy id'],
  ['AWS::DocDB::DBCluster', 'name', 'cluster identifier, unique per account and region'],
  ['AWS::DocDB::DBInstance', 'name', 'instance identifier, unique per account and region'],
  ['AWS::DocDB::DBSubnetGroup', 'name', 'subnet group name, unique per account and region'],
  ['AWS::DynamoDB::GlobalTable', 'name', 'table name, unique per account and region'],
  ['AWS::DynamoDB::Table', 'name', 'table name, unique per account and region'],
  ['AWS::EC2::EIP', 'minted', 'publicIp|allocationId, both AWS-assigned'],
  ['AWS::EC2::Instance', 'minted', 'AWS-assigned instance id'],
  ['AWS::EC2::InternetGateway', 'minted', 'AWS-assigned igw id'],
  ['AWS::EC2::NatGateway', 'minted', 'AWS-assigned nat gateway id'],
  ['AWS::EC2::NetworkAcl', 'minted', 'AWS-assigned ACL id'],
  ['AWS::EC2::NetworkAclEntry', 'composite', 'networkAclId|ruleNumber|egress covers all three create-only properties'],
  ['AWS::EC2::Route', 'composite', 'routeTableId|destination covers RouteTableId and every destination property'],
  ['AWS::EC2::RouteTable', 'minted', 'AWS-assigned route table id'],
  ['AWS::EC2::SecurityGroup', 'minted', 'AWS-assigned sg- id'],
  ['AWS::EC2::SecurityGroupIngress', 'hook', 'GroupId|protocol|from|to with no source; source create-only not in id'],
  ['AWS::EC2::Subnet', 'minted', 'AWS-assigned subnet id'],
  ['AWS::EC2::SubnetNetworkAclAssociation', 'minted', 'AWS-assigned new association id per create'],
  ['AWS::EC2::SubnetRouteTableAssociation', 'minted', 'AWS-assigned association id'],
  ['AWS::EC2::VPC', 'minted', 'AWS-assigned vpc id'],
  ['AWS::EC2::VPCEndpoint', 'minted', 'AWS-assigned vpce id'],
  ['AWS::EC2::VPCGatewayAttachment', 'composite', 'gatewayId|vpcId includes VpcId, the only create-only property'],
  ['AWS::ECR::Repository', 'name', 'repository name, unique per account and region'],
  ['AWS::ECS::Cluster', 'name', 'cluster name, unique per account and region'],
  ['AWS::ECS::Service', 'composite', 'service ARN carries cluster and service name, the create-only selectors'],
  ['AWS::ECS::TaskDefinition', 'minted', 'ARN with AWS-assigned revision number'],
  ['AWS::EFS::AccessPoint', 'minted', 'AWS-assigned access point id'],
  ['AWS::EFS::FileSystem', 'minted', 'AWS-assigned file system id'],
  ['AWS::EFS::MountTarget', 'minted', 'AWS-assigned mount target id'],
  ['AWS::ElastiCache::CacheCluster', 'name', 'cache cluster id, unique per account and region'],
  ['AWS::ElastiCache::SubnetGroup', 'name', 'subnet group name, unique per account and region'],
  ['AWS::ElasticLoadBalancingV2::Listener', 'minted', 'AWS-assigned listener ARN'],
  ['AWS::ElasticLoadBalancingV2::LoadBalancer', 'minted', 'ARN with AWS-assigned random suffix'],
  ['AWS::ElasticLoadBalancingV2::TargetGroup', 'minted', 'ARN with AWS-assigned random suffix'],
  ['AWS::EMR::Cluster', 'minted', 'AWS-assigned j- cluster id'],
  ['AWS::EMR::InstanceFleetConfig', 'minted', 'AWS-assigned fleet id'],
  ['AWS::EMR::InstanceGroupConfig', 'minted', 'AWS-assigned group id'],
  ['AWS::Events::Archive', 'name', 'archive name, unique per account and region'],
  ['AWS::Events::EventBus', 'name', 'bus name, unique per account and region'],
  ['AWS::Events::Rule', 'composite', 'rule ARN carries bus and rule name; Name is the only create-only'],
  ['AWS::FSx::FileSystem', 'minted', 'AWS-assigned fs- id'],
  ['AWS::Glue::Connection', 'name', 'connection name, unique per account and region'],
  ['AWS::Glue::Crawler', 'name', 'crawler name, unique per account and region'],
  ['AWS::Glue::Database', 'name', 'database name, unique per catalog (account and region)'],
  ['AWS::Glue::Job', 'name', 'job name, unique per account and region'],
  ['AWS::Glue::SecurityConfiguration', 'name', 'configuration name, unique per account and region'],
  ['AWS::Glue::Table', 'hook', 'db|table where both names may contain a pipe, so ids can be shared'],
  ['AWS::Glue::Trigger', 'name', 'trigger name, unique per account and region'],
  ['AWS::Glue::Workflow', 'name', 'workflow name, unique per account and region'],
  ['AWS::IAM::AccessKey', 'minted', 'AWS-assigned access key id'],
  ['AWS::IAM::Group', 'name', 'group name, unique per account'],
  ['AWS::IAM::InstanceProfile', 'name', 'profile name, unique per account'],
  ['AWS::IAM::ManagedPolicy', 'name', 'policy ARN with account, path and name, unique per account'],
  ['AWS::IAM::Policy', 'no-create-only', 'policy name; snapshot lists no create-only properties'],
  ['AWS::IAM::Role', 'name', 'role name, unique per account'],
  ['AWS::IAM::User', 'name', 'user name, unique per account'],
  ['AWS::IAM::UserToGroupAddition', 'no-create-only', 'logicalId id; snapshot lists no create-only properties'],
  ['AWS::Kinesis::Stream', 'name', 'stream name, unique per account and region'],
  ['AWS::Kinesis::StreamConsumer', 'minted', 'consumer ARN with AWS-assigned creation timestamp suffix'],
  ['AWS::KinesisFirehose::DeliveryStream', 'name', 'stream name, unique per account and region'],
  ['AWS::KMS::Alias', 'name', 'alias name, unique per account and region'],
  ['AWS::KMS::Key', 'minted', 'AWS-assigned key id'],
  ['AWS::Lambda::EventInvokeConfig', 'composite', 'function|qualifier covers both create-only properties'],
  ['AWS::Lambda::EventSourceMapping', 'minted', 'AWS-assigned mapping UUID'],
  ['AWS::Lambda::Function', 'name', 'function name, unique per account and region'],
  ['AWS::Lambda::LayerVersion', 'minted', 'layer version ARN with AWS-assigned version number'],
  ['AWS::Lambda::MicrovmImage', 'minted', 'AWS-assigned image ARN'],
  ['AWS::Lambda::NetworkConnector', 'minted', 'AWS-assigned connector ARN'],
  ['AWS::Lambda::Permission', 'hook', 'statement id scoped to function; function not in id'],
  ['AWS::Lambda::Url', 'composite', 'ARN from CreateFunctionUrlConfig, qualified for alias (live-probed), so qualifier is in id'],
  ['AWS::Lambda::WebFunctionEndpoint', 'minted', 'AWS-assigned endpoint ARN'],
  ['AWS::Lambda::WebFunctionRevision', 'minted', 'AWS-assigned revision ARN'],
  ['AWS::Lightsail::Alarm', 'name', 'alarm name, unique per account and region'],
  ['AWS::Logs::Delivery', 'minted', 'AWS-assigned delivery id'],
  ['AWS::Logs::DeliveryDestination', 'name', 'destination name, unique per account and region'],
  ['AWS::Logs::DeliverySource', 'name', 'source name, unique per account and region'],
  ['AWS::Logs::LogGroup', 'name', 'log group name, unique per account and region'],
  ['AWS::Neptune::DBCluster', 'name', 'cluster identifier, unique per account and region'],
  ['AWS::Neptune::DBInstance', 'name', 'instance identifier, unique per account and region'],
  ['AWS::Neptune::DBSubnetGroup', 'name', 'subnet group name, unique per account and region'],
  ['AWS::Pipes::Pipe', 'name', 'pipe name, unique per account and region'],
  ['AWS::RDS::DBCluster', 'name', 'cluster identifier, unique per account and region'],
  ['AWS::RDS::DBInstance', 'name', 'instance identifier, unique per account and region'],
  ['AWS::RDS::DBProxy', 'name', 'proxy name, unique per account and region'],
  ['AWS::RDS::DBProxyEndpoint', 'name', 'endpoint name, unique per account and region'],
  ['AWS::RDS::DBProxyTargetGroup', 'minted', 'AWS-assigned target group ARN'],
  ['AWS::RDS::DBSubnetGroup', 'name', 'subnet group name, unique per account and region'],
  ['AWS::Route53::HostedZone', 'minted', 'AWS-assigned hosted zone id'],
  ['AWS::Route53::RecordSet', 'composite', 'zoneId|name|type, the AWS record identity; zone create-only is in id'],
  ['AWS::Route53::RecordSetGroup', 'composite', 'composite of zone and record identities; zone create-only is in id'],
  ['AWS::S3::Bucket', 'name', 'bucket name, globally unique'],
  ['AWS::S3::BucketPolicy', 'name', 'bucket name; Bucket is the only create-only and is the id'],
  ['AWS::S3Express::DirectoryBucket', 'name', 'bucket name, unique in its zone-qualified namespace'],
  ['AWS::S3Tables::Namespace', 'composite', 'tableBucketARN|namespace covers both create-only properties'],
  ['AWS::S3Tables::Table', 'minted', 'table ARN with AWS-assigned table identifier'],
  ['AWS::S3Tables::TableBucket', 'name', 'table bucket ARN with account, region and name'],
  ['AWS::S3Vectors::VectorBucket', 'name', 'vector bucket name, unique per account and region'],
  ['AWS::Scheduler::Schedule', 'name', 'schedule name; GroupName is updatable not create-only'],
  ['AWS::SecretsManager::Secret', 'minted', 'ARN with AWS-assigned random suffix'],
  ['AWS::ServiceDiscovery::HttpNamespace', 'minted', 'AWS-assigned namespace id'],
  ['AWS::ServiceDiscovery::PrivateDnsNamespace', 'minted', 'AWS-assigned namespace id'],
  ['AWS::ServiceDiscovery::PublicDnsNamespace', 'minted', 'AWS-assigned namespace id'],
  ['AWS::ServiceDiscovery::Service', 'minted', 'AWS-assigned service id'],
  ['AWS::SNS::Subscription', 'minted', 'AWS-assigned subscription ARN with UUID'],
  ['AWS::SNS::Topic', 'name', 'topic ARN with account, region and name; unique'],
  ['AWS::SNS::TopicPolicy', 'no-create-only', 'joined topic ARNs; snapshot lists no create-only properties'],
  ['AWS::SQS::Queue', 'name', 'queue URL with account, region and name; unique'],
  ['AWS::SQS::QueuePolicy', 'no-create-only', 'first queue URL; snapshot lists no create-only properties'],
  ['AWS::SSM::Parameter', 'name', 'parameter name, unique per account and region'],
  ['AWS::StepFunctions::StateMachine', 'name', 'state machine ARN with account, region and name; unique'],
  ['AWS::WAFv2::WebACL', 'minted', 'ARN with AWS-assigned web ACL UUID'],
];

const registry = new ProviderRegistry();
registerAllProviders(registry, await loadProviderClasses());
const registered = registry.getRegisteredTypes().slice().sort();

describe('equal physical ids across a replacement: every SDK type classified (go-to-k/cdkd#7072)', () => {
  it('classifies every registered SDK type exactly once', () => {
    const types = ROWS.map(([type]) => type);
    expect(new Set(types).size).toBe(types.length);
    expect(types.slice().sort()).toEqual(registered);
    // A literal, so a dropped registration cannot pass as a smaller table.
    expect(registered.length).toBeGreaterThanOrEqual(149);
  });

  it('lets the hook decide exactly the types whose id can name two resources', () => {
    const hookRows = ROWS.filter(([, cls]) => cls === 'hook').map(([type]) => type).sort();
    expect(hookRows).toEqual([...EQUAL_ID_HOOK_TYPES].sort());
  });

  it('gives every row a reason', () => {
    for (const [type, , reason] of ROWS) expect(reason.trim().length, type).toBeGreaterThan(10);
  });
});
