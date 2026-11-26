/**
 * The read-back revert check's data (`sdk-wire-revert-readback.ts`, #7025).
 */

/** Resource type -> why no revert of its read-back can be checked on the fakes. */
export const REVERT_READBACK_EXEMPT: Record<string, string> = {
  'AWS::ApiGateway::Resource': 'every property is create-only: a drift on one replaces',
  'AWS::AppConfig::Environment': 'no readCurrentState: drift reports the resource unknown',
  'AWS::CloudFormation::Stack': 'no readCurrentState: drift reports the resource unknown',
  'AWS::CloudFormation::WaitCondition': 'its read-back holds no property, so there is nothing to revert',
  'AWS::EC2::InternetGateway': 'its only property is Tags: an untagged gateway reads back nothing',
  'AWS::EC2::SubnetNetworkAclAssociation': 'every property is create-only: a drift on one replaces',
  'AWS::EC2::SubnetRouteTableAssociation': 'every property is create-only: a drift on one replaces',
  'AWS::Lambda::Permission': 'every property is create-only: a drift on one replaces',
  'AWS::Glue::SecurityConfiguration': 'update() refuses every change: Glue has no update call for it',
  'AWS::Kinesis::StreamConsumer': 'every property is create-only: a drift on one replaces',
  'AWS::Lambda::LayerVersion': 'every property is create-only: a layer version is immutable',
  'AWS::Lambda::WebFunctionRevision': 'every property is create-only: a revision is immutable',
  'AWS::S3Tables::Namespace': 'every property is create-only: a drift on one replaces',
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
  'AWS::ApiGatewayV2::Integration#RequestParameters':
    'UNMEASURED: `RequestParameters: {}` on UpdateIntegration, expected to read as none',
  'AWS::AppSync::ApiKey#Description':
    'UNMEASURED: `description: ""` on UpdateApiKey, expected to clear',
  'AWS::AppSync::GraphQLApi#AdditionalAuthenticationProviders':
    'UNMEASURED: `[]` is the documented clear of the additional providers',
  'AWS::AutoScaling::AutoScalingGroup#AvailabilityZoneIds':
    'UNMEASURED: an empty AvailabilityZoneIds beside the reported AvailabilityZones',
  'AWS::AutoScaling::AutoScalingGroup#AvailabilityZones':
    'unreachable: a live group always reports at least one availability zone',
  'AWS::AutoScaling::AutoScalingGroup#MaxSize':
    'unreachable: DescribeAutoScalingGroups always reports MaxSize (required at create)',
  'AWS::AutoScaling::AutoScalingGroup#MinSize':
    'unreachable: DescribeAutoScalingGroups always reports MinSize (required at create)',
  'AWS::AutoScaling::AutoScalingGroup#TerminationPolicies':
    'unreachable: an unset policy list reads as `["Default"]`',
  'AWS::BedrockAgentCore::Runtime#EnvironmentVariables':
    'UNMEASURED: `environmentVariables: {}` on UpdateAgentRuntime, expected to read as none',
  'AWS::CloudWatch::Alarm#AlarmActions':
    'UNMEASURED: PutMetricAlarm replaces the alarm; `[]` means no action',
  'AWS::CloudWatch::Alarm#Dimensions':
    'UNMEASURED: PutMetricAlarm replaces the alarm; `[]` means no dimension',
  'AWS::CloudWatch::Alarm#InsufficientDataActions':
    'UNMEASURED: PutMetricAlarm replaces the alarm; `[]` means no action',
  'AWS::CloudWatch::Alarm#OKActions':
    'UNMEASURED: PutMetricAlarm replaces the alarm; `[]` means no action',
  'AWS::CodeBuild::Project#BuildBatchConfig':
    'UNMEASURED: `buildBatchConfig: {}` is the clear update() itself sends',
  'AWS::CodeBuild::Project#Description':
    'UNMEASURED: `description: ""` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#Environment.EnvironmentVariables':
    'UNMEASURED: `environmentVariables: []` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#FileSystemLocations':
    'UNMEASURED: `[]` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#SecondaryArtifacts':
    'UNMEASURED: `[]` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#SecondarySourceVersions':
    'UNMEASURED: `[]` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#SecondarySources':
    'UNMEASURED: `[]` on UpdateProject, expected to clear',
  'AWS::CodeBuild::Project#Tags':
    'UNMEASURED: `tags: []` on UpdateProject beside the tag diff, expected to keep none',
  'AWS::CodeBuild::Project#VpcConfig':
    'UNMEASURED — see report: `vpcConfig: {}` (no vpcId) on UpdateProject',
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
  'AWS::ECS::Service#CapacityProviderStrategy':
    'UNMEASURED — see report: `capacityProviderStrategy: []` on a service with no launch type',
  'AWS::ECS::Service#PlacementConstraints': REVERT_OK('ECS service'),
  'AWS::Events::Archive#KmsKeyIdentifier': REVERT_OK('event archive'),
  'AWS::Events::Archive#RetentionDays': REVERT_OK('event archive'),
  'AWS::Events::EventBus#KmsKeyIdentifier': REVERT_OK('event bus'),
  'AWS::Glue::Connection#ConnectionInput.AthenaProperties': REVERT_OK('Glue connection'),
  'AWS::Glue::Connection#ConnectionInput.Description': REVERT_OK('Glue connection'),
  'AWS::Glue::Connection#ConnectionInput.MatchCriteria': REVERT_OK('Glue connection'),
  'AWS::Glue::Connection#ConnectionInput.PhysicalConnectionRequirements':
    REVERT_OK('Glue connection'),
  'AWS::Glue::Connection#ConnectionInput.PythonProperties': REVERT_OK('Glue connection'),
  'AWS::Glue::Connection#ConnectionInput.SparkProperties': REVERT_OK('Glue connection'),
  'AWS::Glue::Crawler#Classifiers': REVERT_OK('Glue crawler'),
  'AWS::Glue::Crawler#LakeFormationConfiguration': REVERT_OK('Glue crawler'),
  'AWS::Glue::Crawler#LineageConfiguration': REVERT_OK('Glue crawler'),
  'AWS::Glue::Crawler#RecrawlPolicy': REVERT_OK('Glue crawler'),
  'AWS::Glue::Crawler#SchemaChangePolicy': REVERT_OK('Glue crawler'),
  'AWS::Glue::Crawler#Targets':
    'unreachable: GetCrawler always reports Targets (required at create)',
  'AWS::Glue::Database#DatabaseInput.Description': REVERT_OK('Glue database'),
  'AWS::Glue::Job#Command': 'unreachable: GetJob always reports Command (required at create)',
  'AWS::Glue::Table#TableInput.Description': REVERT_OK('Glue table'),
  'AWS::Glue::Table#TableInput.Parameters': REVERT_OK('Glue table'),
  'AWS::Glue::Table#TableInput.PartitionKeys': REVERT_OK('Glue table'),
  'AWS::Glue::Table#TableInput.StorageDescriptor.SortColumns.1.SortOrder':
    'unreachable: a declared sort column; `SortOrder: 0` is descending, a value AWS reports',
  'AWS::Glue::Trigger#Actions': 'unreachable: a trigger always has at least one action',
  'AWS::Glue::Workflow#DefaultRunProperties':
    'UNMEASURED: `DefaultRunProperties: {}` on UpdateWorkflow, expected to clear',
  'AWS::KinesisFirehose::DeliveryStream#ExtendedS3DestinationConfiguration.CloudWatchLoggingOptions':
    'UNMEASURED — see report: `CloudWatchLoggingOptions: {}` on UpdateDestination',
  'AWS::Lambda::EventSourceMapping#FilterCriteria.Filters':
    'UNMEASURED: `FilterCriteria: { Filters: [] }` is the documented clear',
  'AWS::Lambda::EventSourceMapping#FunctionResponseTypes':
    'UNMEASURED: `[]` is the documented clear',
  'AWS::Lambda::EventSourceMapping#MetricsConfig.Metrics':
    'UNMEASURED: `MetricsConfig: { Metrics: [] }` is the documented clear',
  'AWS::Lambda::EventSourceMapping#SourceAccessConfigurations':
    'UNMEASURED: `[]` is the documented clear',
  'AWS::Lambda::Function#CapacityProviderConfig':
    'unreachable: AWS reports the block only on a capacity-provider function, never empty',
  'AWS::Lambda::Function#Description': REVERT_OK('Lambda function'),
  'AWS::Lambda::Function#Environment.Variables': REVERT_OK('Lambda function'),
  'AWS::Lambda::Function#Layers': REVERT_OK('Lambda function'),
  'AWS::Lambda::Function#VpcConfig.SecurityGroupIds': REVERT_OK('Lambda function'),
  'AWS::Lambda::Function#VpcConfig.SubnetIds': REVERT_OK('Lambda function'),
  'AWS::Lambda::WebFunctionEndpoint#RevisionWeights':
    'unreachable: a live endpoint always has revision weights (AWS refuses one without)',
  'AWS::Pipes::Pipe#Description': REVERT_OK('pipe'),
  'AWS::Pipes::Pipe#Enrichment': REVERT_OK('pipe'),
  'AWS::Pipes::Pipe#EnrichmentParameters': REVERT_OK('pipe'),
  'AWS::Pipes::Pipe#KmsKeyIdentifier': REVERT_OK('pipe'),
  'AWS::Pipes::Pipe#LogConfiguration':
    'UNMEASURED: an empty log configuration sent as `Level: OFF`, expected to read as none',
  'AWS::Pipes::Pipe#LogConfiguration.IncludeExecutionData':
    'UNMEASURED: `IncludeExecutionData: []` on UpdatePipe, expected to read as none',
  'AWS::SQS::Queue#KmsMasterKeyId': 'UNMEASURED: an empty attribute is the documented clear',
  'AWS::SQS::Queue#RedrivePolicy': 'UNMEASURED: an empty attribute is the documented clear',
  'AWS::SSM::Parameter#AllowedPattern':
    'UNMEASURED: `AllowedPattern: ""` on PutParameter (Overwrite), length 0 is in the model',
  'AWS::SSM::Parameter#Description':
    'UNMEASURED: `Description: ""` on PutParameter (Overwrite), length 0 is in the model',
  'AWS::StepFunctions::StateMachine#LoggingConfiguration.Destinations':
    'UNMEASURED: `destinations: []` beside the reported level, the shape AWS itself reports',
  'AWS::WAFv2::WebACL#TokenDomains': 'measured: `TokenDomains: []` accepted (#6986)',
};
