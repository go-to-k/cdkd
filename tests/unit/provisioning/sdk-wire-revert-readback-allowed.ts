/**
 * The read-back revert check's data (`sdk-wire-revert-readback.ts`, #7025).
 */

/** Why a type is left out of a part of the check, and a needle its outcome must match. */
export interface Reason {
  why: string;
  says: RegExp;
}

const CREATE_ONLY: Reason = {
  why: 'every property is create-only: a drift on one replaces',
  says: /no updatable member to revert/,
};
const NO_READ: Reason = {
  why: 'no readCurrentState: drift reports the resource unknown',
  says: /^no readCurrentState$/,
};

/** Resource type -> why no revert of its read-back can be checked on the fakes. */
export const REVERT_READBACK_EXEMPT: Record<string, Reason> = {
  'AWS::ApiGateway::Resource': CREATE_ONLY,
  'AWS::AppConfig::Environment': NO_READ,
  'AWS::CloudFormation::Stack': NO_READ,
  'AWS::CloudFormation::WaitCondition': {
    why: 'its read-back holds no property, so there is nothing to revert',
    says: /read: \{\}/,
  },
  'AWS::EC2::InternetGateway': {
    why: 'its only property is Tags: an untagged gateway reads back nothing',
    says: /readback-arm read: \{\}/,
  },
  'AWS::EC2::SubnetNetworkAclAssociation': CREATE_ONLY,
  'AWS::EC2::SubnetRouteTableAssociation': CREATE_ONLY,
  'AWS::Glue::SecurityConfiguration': {
    why: 'update() refuses every change: Glue has no update call for it',
    says: /no updatable member to revert/,
  },
  'AWS::Kinesis::StreamConsumer': CREATE_ONLY,
  'AWS::Lambda::LayerVersion': CREATE_ONLY,
  'AWS::Lambda::Permission': CREATE_ONLY,
  'AWS::Lambda::WebFunctionRevision': CREATE_ONLY,
  'AWS::S3Tables::Namespace': CREATE_ONLY,
};

const ONLY_REPORTED =
  'its read-back of an unconfigured resource holds only members AWS reports: no placeholder';

/** Resource type -> why its read-back holds no placeholder for a revert to probe. */
export const REVERT_NO_PLACEHOLDERS: Record<string, string> = {
  'AWS::ApiGateway::Account': ONLY_REPORTED,
  'AWS::ApiGateway::Deployment': ONLY_REPORTED,
  'AWS::AppSync::DataSource': ONLY_REPORTED,
  'AWS::AppSync::GraphQLSchema': ONLY_REPORTED,
  'AWS::AppSync::Resolver': ONLY_REPORTED,
  'AWS::CloudFront::CloudFrontOriginAccessIdentity': ONLY_REPORTED,
  'AWS::CloudFront::OriginAccessControl': ONLY_REPORTED,
  'AWS::CloudWatch::AnomalyDetector': ONLY_REPORTED,
  'AWS::EC2::EIP': ONLY_REPORTED,
  'AWS::EC2::NetworkAcl': ONLY_REPORTED,
  'AWS::EC2::NetworkAclEntry': ONLY_REPORTED,
  'AWS::EC2::Route': ONLY_REPORTED,
  'AWS::EC2::RouteTable': ONLY_REPORTED,
  'AWS::EC2::SecurityGroupIngress': ONLY_REPORTED,
  'AWS::EC2::Subnet': ONLY_REPORTED,
  'AWS::EC2::VPC': ONLY_REPORTED,
  'AWS::EC2::VPCGatewayAttachment': ONLY_REPORTED,
  'AWS::EFS::AccessPoint': ONLY_REPORTED,
  'AWS::EFS::MountTarget': ONLY_REPORTED,
  'AWS::EMR::InstanceFleetConfig': ONLY_REPORTED,
  'AWS::EMR::InstanceGroupConfig': ONLY_REPORTED,
  'AWS::ElastiCache::SubnetGroup': ONLY_REPORTED,
  'AWS::IAM::AccessKey': ONLY_REPORTED,
  'AWS::IAM::InstanceProfile': ONLY_REPORTED,
  'AWS::IAM::Policy': ONLY_REPORTED,
  'AWS::KMS::Alias': ONLY_REPORTED,
  'AWS::Lambda::EventInvokeConfig': ONLY_REPORTED,
  'AWS::Lambda::MicrovmImage': ONLY_REPORTED,
  'AWS::Lightsail::Alarm': ONLY_REPORTED,
  'AWS::Logs::DeliverySource': ONLY_REPORTED,
  'AWS::Route53::RecordSet': ONLY_REPORTED,
  'AWS::Route53::RecordSetGroup': ONLY_REPORTED,
  'AWS::S3::BucketPolicy': ONLY_REPORTED,
  'AWS::S3Vectors::VectorBucket': ONLY_REPORTED,
  'AWS::SNS::Subscription': ONLY_REPORTED,
  'AWS::SNS::TopicPolicy': ONLY_REPORTED,
  'AWS::SQS::QueuePolicy': ONLY_REPORTED,
  'AWS::Scheduler::Schedule': ONLY_REPORTED,
};

/**
 * `<Type>#<top-level member>` -> why a revert setting it whole to the case's
 * declared value is not tried: it starts a transition the fake never ends.
 */
export const REVERT_DECLARED_SKIPPED: Record<string, string> = {
  'AWS::KinesisFirehose::DeliveryStream#DeliveryStreamEncryptionConfigurationInput':
    'enabling encryption waits until the stream reports it enabled, which the fake never does',
};

/** Resource type -> why one of its read-back shapes reverts through no member. */
export const REVERT_FAILED_READBACKS: Record<string, Reason> = {
  'AWS::Glue::Connection': {
    why: 'the shallow read without the arm reports another connection name, which update() refuses as a rename',
    says: /^shallow: .*cannot rename a Glue connection in place/,
  },
};

// A placeholder the revert sends whose AWS behavior is the one measured.
const REVERT_OK = (type: string) =>
  `measured: a ${type} revert after an unrelated drift, with this member unset, succeeded (#7025)`;

/**
 * `<Type>#<read-back path>` -> what AWS does with that placeholder as the
 * revert sends it. Each reason opens with its evidence:
 * - `measured:` the AWS behavior was observed on a live resource;
 * - `UNMEASURED:` traced from the code or the API docs only;
 * - `unreachable:` AWS always reports a value there, so only the fake reads
 *   it empty.
 * Every entry not `measured:` is listed as a todo by the check.
 */
export const REVERT_PLACEHOLDER_ALLOWED: Record<string, string> = {
  'AWS::ApiGateway::Method#MethodResponses': 'UNMEASURED: an empty MethodResponses changes which calls an Integration revert makes; no empty value is sent',
  'AWS::ApiGatewayV2::Integration#RequestParameters': 'measured: an HTTP API integration revert after an unrelated drift, with no request parameters, succeeded (#7025, issuecomment-7189290072)',
  'AWS::AppSync::ApiKey#Description': 'measured: an API key revert of its description to none succeeded (#7025, issuecomment-7189290072)',
  'AWS::AppSync::GraphQLApi#AdditionalAuthenticationProviders': 'measured: a GraphQL API revert after an unrelated drift, with no additional providers, succeeded after #7027 (#7025, issuecomment-7189290072)',
  'AWS::AutoScaling::AutoScalingGroup#AvailabilityZoneIds': 'UNMEASURED: an empty AvailabilityZoneIds beside the reported AvailabilityZones',
  'AWS::AutoScaling::AutoScalingGroup#AvailabilityZones': 'unreachable: a live group always reports at least one availability zone',
  'AWS::AutoScaling::AutoScalingGroup#MaxSize': 'unreachable: DescribeAutoScalingGroups always reports MaxSize (required at create)',
  'AWS::AutoScaling::AutoScalingGroup#MinSize': 'unreachable: DescribeAutoScalingGroups always reports MinSize (required at create)',
  'AWS::AutoScaling::AutoScalingGroup#TerminationPolicies': 'unreachable: an unset policy list reads as `["Default"]`',
  'AWS::BedrockAgentCore::Runtime#EnvironmentVariables': 'UNMEASURED: `environmentVariables: {}` on UpdateAgentRuntime, expected to read as none',
  'AWS::CloudWatch::Alarm#AlarmActions': 'UNMEASURED: PutMetricAlarm replaces the alarm; `[]` means no action',
  'AWS::CloudWatch::Alarm#Dimensions': 'UNMEASURED: PutMetricAlarm replaces the alarm; `[]` means no dimension',
  'AWS::CloudWatch::Alarm#InsufficientDataActions': 'UNMEASURED: PutMetricAlarm replaces the alarm; `[]` means no action',
  'AWS::CloudWatch::Alarm#OKActions': 'UNMEASURED: PutMetricAlarm replaces the alarm; `[]` means no action',
  'AWS::CodeBuild::Project#BuildBatchConfig': 'UNMEASURED: `buildBatchConfig: {}` is the clear update() itself sends',
  'AWS::CodeBuild::Project#Description': 'UNMEASURED: `description: ""` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#Environment.EnvironmentVariables': 'UNMEASURED: `environmentVariables: []` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#FileSystemLocations': 'UNMEASURED: `[]` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#SecondaryArtifacts': 'UNMEASURED: `[]` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#SecondarySourceVersions': 'UNMEASURED: `[]` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#SecondarySources': 'UNMEASURED: `[]` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#Tags': 'UNMEASURED: `tags: []` on UpdateProject beside the tag diff, expected to keep none',
  'AWS::CodeBuild::Project#VpcConfig': 'measured: a CodeBuild project revert after an unrelated drift succeeded (bug hunt r1939484)',
  'AWS::Cognito::UserPool#AccountRecoverySetting': REVERT_OK('user pool'),
  'AWS::Cognito::UserPool#AdminCreateUserConfig': REVERT_OK('user pool'),
  'AWS::Cognito::UserPool#AutoVerifiedAttributes': REVERT_OK('user pool'),
  'AWS::Cognito::UserPool#DeviceConfiguration': REVERT_OK('user pool'),
  'AWS::Cognito::UserPool#EmailConfiguration': REVERT_OK('user pool'),
  'AWS::Cognito::UserPool#LambdaConfig': REVERT_OK('user pool'),
  'AWS::Cognito::UserPool#SmsConfiguration': REVERT_OK('user pool'),
  'AWS::Cognito::UserPool#UserAttributeUpdateSettings': REVERT_OK('user pool'),
  'AWS::Cognito::UserPool#UserPoolTags': REVERT_OK('user pool'),
  'AWS::Cognito::UserPool#VerificationMessageTemplate': REVERT_OK('user pool'),
  'AWS::ECS::Service#CapacityProviderStrategy': 'measured: `UpdateService` with `capacityProviderStrategy: []` on a service with no launch type is accepted and keeps the cluster default strategy (#7025, issuecomment-7186461160)',
  'AWS::ECS::Service#PlacementConstraints': REVERT_OK('ECS service'),

  'AWS::ElasticLoadBalancingV2::LoadBalancer#Subnets':
    'unreachable: a live load balancer always reports its subnets',
  'AWS::Events::Archive#Description': REVERT_OK('event archive'),
  'AWS::Events::Archive#KmsKeyIdentifier': REVERT_OK('event archive'),
  'AWS::Events::Archive#RetentionDays': REVERT_OK('event archive'),
  'AWS::Events::EventBus#Description': REVERT_OK('event bus'),
  'AWS::Events::EventBus#KmsKeyIdentifier': REVERT_OK('event bus'),
  'AWS::Events::Rule#Description': 'UNMEASURED: PutRule replaces the rule; `Description: ""` means none',
  'AWS::Glue::Connection#ConnectionInput.AthenaProperties': REVERT_OK('Glue connection'),
  'AWS::Glue::Connection#ConnectionInput.Description': REVERT_OK('Glue connection'),
  'AWS::Glue::Connection#ConnectionInput.MatchCriteria': REVERT_OK('Glue connection'),
  'AWS::Glue::Connection#ConnectionInput.PhysicalConnectionRequirements': REVERT_OK('Glue connection'),
  'AWS::Glue::Connection#ConnectionInput.PythonProperties': REVERT_OK('Glue connection'),
  'AWS::Glue::Connection#ConnectionInput.SparkProperties': REVERT_OK('Glue connection'),
  'AWS::Glue::Crawler#Classifiers': REVERT_OK('Glue crawler'),
  'AWS::Glue::Crawler#LakeFormationConfiguration': REVERT_OK('Glue crawler'),
  'AWS::Glue::Crawler#LineageConfiguration': REVERT_OK('Glue crawler'),
  'AWS::Glue::Crawler#RecrawlPolicy': REVERT_OK('Glue crawler'),
  'AWS::Glue::Crawler#SchemaChangePolicy': REVERT_OK('Glue crawler'),
  'AWS::Glue::Crawler#Targets': 'unreachable: GetCrawler always reports Targets (required at create)',
  'AWS::Glue::Database#DatabaseInput.Description': REVERT_OK('Glue database'),
  'AWS::Glue::Job#Command': 'unreachable: GetJob always reports Command (required at create)',
  'AWS::Glue::Table#TableInput.Description': REVERT_OK('Glue table'),
  'AWS::Glue::Table#TableInput.Parameters': REVERT_OK('Glue table'),
  'AWS::Glue::Table#TableInput.PartitionKeys': REVERT_OK('Glue table'),
  'AWS::Glue::Table#TableInput.StorageDescriptor.SortColumns.1.SortOrder': 'unreachable: a declared sort column; `SortOrder: 0` is descending, a value AWS reports',
  'AWS::Glue::Trigger#Actions': 'unreachable: a trigger always has at least one action',
  'AWS::Glue::Workflow#DefaultRunProperties': 'measured: a workflow revert after an unrelated drift, with no run properties, succeeded (#7025, issuecomment-7189290072)',
  'AWS::KinesisFirehose::DeliveryStream#ExtendedS3DestinationConfiguration.CloudWatchLoggingOptions': 'unreachable: AWS reports `{Enabled: false}` for a stream without logging (measured, #7019)',
  'AWS::Lambda::EventSourceMapping#FilterCriteria.Filters': 'UNMEASURED: `FilterCriteria: { Filters: [] }` is the documented clear',
  'AWS::Lambda::EventSourceMapping#FunctionResponseTypes': 'UNMEASURED: `[]` is the documented clear',
  'AWS::Lambda::EventSourceMapping#MetricsConfig.Metrics': 'UNMEASURED: `MetricsConfig: { Metrics: [] }` is the documented clear',
  'AWS::Lambda::EventSourceMapping#SourceAccessConfigurations': 'UNMEASURED: `[]` is the documented clear',
  'AWS::Lambda::Function#CapacityProviderConfig': 'unreachable: AWS reports the block only on a capacity-provider function, never empty',
  'AWS::Lambda::Function#Description': REVERT_OK('Lambda function'),
  'AWS::Lambda::Function#Environment.Variables': REVERT_OK('Lambda function'),
  'AWS::Lambda::Function#Layers': REVERT_OK('Lambda function'),
  'AWS::Lambda::Function#VpcConfig.SecurityGroupIds': REVERT_OK('Lambda function'),
  'AWS::Lambda::Function#VpcConfig.SubnetIds': REVERT_OK('Lambda function'),
  'AWS::Lambda::WebFunctionEndpoint#RevisionWeights': 'unreachable: a live endpoint always has revision weights (AWS refuses one without)',
  'AWS::Pipes::Pipe#Description': REVERT_OK('pipe'),
  'AWS::Pipes::Pipe#Enrichment': REVERT_OK('pipe'),
  'AWS::Pipes::Pipe#EnrichmentParameters': REVERT_OK('pipe'),
  'AWS::Pipes::Pipe#KmsKeyIdentifier': REVERT_OK('pipe'),
  'AWS::Pipes::Pipe#LogConfiguration': 'measured: a pipe revert after an unrelated drift, with logging unset, succeeded (#7025, issuecomment-7189290072)',
  'AWS::Pipes::Pipe#LogConfiguration.IncludeExecutionData': 'measured: a pipe revert after an unrelated drift, with logging unset, succeeded (#7025, issuecomment-7189290072)',
  'AWS::S3Tables::TableBucket#ReplicationConfiguration.Rules': 'unreachable: a replication configuration always holds at least one rule',
  'AWS::SQS::Queue#KmsMasterKeyId': 'UNMEASURED: an empty attribute is the documented clear',
  'AWS::SQS::Queue#RedrivePolicy': 'UNMEASURED: an empty attribute is the documented clear',
  'AWS::SSM::Parameter#AllowedPattern': 'UNMEASURED: `AllowedPattern: ""` on PutParameter (Overwrite), length 0 is in the model',
  'AWS::SSM::Parameter#Description': 'UNMEASURED: `Description: ""` on PutParameter (Overwrite), length 0 is in the model',
  'AWS::SecretsManager::Secret#Description': 'UNMEASURED: `Description: ""` on UpdateSecret, documented to clear',
  'AWS::ServiceDiscovery::HttpNamespace#Description': 'measured: a namespace revert of its description to none succeeded (#7025, issuecomment-7189290072)',
  'AWS::ServiceDiscovery::PrivateDnsNamespace#Description': 'UNMEASURED: `Description: ""` is the documented clear',
  'AWS::ServiceDiscovery::PublicDnsNamespace#Description': 'measured: a namespace revert of its description to none succeeded (#7025, issuecomment-7189290072)',
  'AWS::ServiceDiscovery::Service#Description': 'UNMEASURED: `Description: ""` is the documented clear',
  'AWS::StepFunctions::StateMachine#LoggingConfiguration.Destinations': 'UNMEASURED: `destinations: []` beside the reported level, the shape AWS itself reports',
  'AWS::WAFv2::WebACL#TokenDomains': 'measured: `TokenDomains: []` accepted (#6986)',
};
