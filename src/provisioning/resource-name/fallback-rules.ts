import type { ResourceNameOptions } from './generate.js';

/**
 * How cdkd names one type's resource when the template does not.
 *
 * The ONE generator per type (go-to-k/cdkd#5095): the SDK provider calls
 * {@link generatedNameFor} and a Cloud Control create fills the same name
 * through {@link applyDefaultNameForFallback}, so a resource gets the same
 * name on either route. The only differences are `legacy`'s, each kept so
 * that no stack without an instance id changes a name it already generates.
 */
export interface GeneratedNameRule {
  nameProperty: string;
  options: ResourceNameOptions;
  /** Put before the generated name: a log group's `/cdkd/`, an SSM parameter's `/`. */
  prefix?: string;
  /**
   * A directory bucket: the name ends with the required `--<zone id>--x-s3`,
   * and `options.maxLength` bounds the whole name.
   */
  zoneSuffix?: true;
  /**
   * A prefix the service refuses a name to start with (a security group's
   * `sg-`): a generated name starting with it, case-insensitively, drops the
   * prefix's last character (`sg-app-...` becomes `sgapp-...`).
   */
  refusedPrefix?: string;
  /**
   * `nameProperty` is a key of this object property, not of the resource's
   * top level (a Glue connection's `ConnectionInput.Name`).
   */
  nestedIn?: string;
  /**
   * A stack WITHOUT an instance id (a legacy stack) keeps what each route
   * generated before go-to-k/cdkd#5095. A stack with one always uses the rule.
   */
  legacy?: {
    /**
     * The SDK provider sent the bare logical id (`AWS::CodeBuild::Project`,
     * the security group, trail, Glue and Firehose types).
     */
    sdk?: 'logicalId';
    /**
     * The Cloud Control create filled nothing (`'none'`: the handler named the
     * resource), or a name under these options.
     */
    cloudControl?: 'none' | ResourceNameOptions;
  };
  /**
   * The entry does not admit its type to orphan adoption
   * ({@link explicitNamePropertyFor}): a type added for its generated name
   * alone, never checked against `ADOPTION_REFUSED_TYPES`' three tests.
   */
  notAdopted?: true;
}

/**
 * The generated-name rule of every type cdkd names (see
 * {@link GeneratedNameRule}).
 *
 * A Cloud Control create fills the name from here, for a type with an SDK
 * provider (its provider names the resource with the same rule) and for one
 * without: `AWS::Lambda::CapacityProvider`'s Cloud Control create handler fails
 * without a name its schema leaves optional (issue #3174). The name is filled
 * on a create only; the update path takes it back out
 * (`withoutGeneratedFallbackName`).
 *
 * `AWS::Events::EventBus` has no entry: its CloudFormation schema requires
 * `Name`, so neither route generates one (the SDK provider refuses a missing
 * name, and Cloud Control refuses it as CloudFormation does).
 */
export const FALLBACK_NAME_RULES: Record<string, GeneratedNameRule> = {
  // The SDK provider's pattern keeps `.`. A logical id or stack name never
  // holds one, so the Cloud Control fill names nothing differently.
  'AWS::S3::Bucket': {
    nameProperty: 'BucketName',
    options: { maxLength: 63, lowercase: true, allowedPattern: /[^a-z0-9.-]/g },
  },
  'AWS::SQS::Queue': { nameProperty: 'QueueName', options: { maxLength: 80 } },
  'AWS::SNS::Topic': { nameProperty: 'TopicName', options: { maxLength: 256 } },
  'AWS::Lambda::Function': { nameProperty: 'FunctionName', options: { maxLength: 64 } },
  'AWS::Lambda::LayerVersion': { nameProperty: 'LayerName', options: { maxLength: 64 } },
  // No SDK provider — Cloud Control only. The schema does not require the
  // name, yet a create without one fails with `Resource Handler Internal
  // Failure` (issue #3174). The schema's maxLength 140 is the ARN form's; the
  // service refuses a NAME over 64 (measured, go-to-k/cdkd#5064). The default
  // `allowedPattern` emits a subset of `[a-zA-Z0-9-_]+`.
  'AWS::Lambda::CapacityProvider': {
    nameProperty: 'CapacityProviderName',
    options: { maxLength: 64 },
  },

  'AWS::IAM::Role': { nameProperty: 'RoleName', options: { maxLength: 64 } },
  'AWS::IAM::Policy': { nameProperty: 'PolicyName', options: { maxLength: 64 } },
  'AWS::IAM::ManagedPolicy': {
    nameProperty: 'ManagedPolicyName',
    options: { maxLength: 128 },
  },
  'AWS::IAM::User': { nameProperty: 'UserName', options: { maxLength: 64 } },
  'AWS::IAM::Group': { nameProperty: 'GroupName', options: { maxLength: 128 } },
  'AWS::IAM::InstanceProfile': {
    nameProperty: 'InstanceProfileName',
    options: { maxLength: 128 },
  },
  'AWS::DynamoDB::Table': { nameProperty: 'TableName', options: { maxLength: 255 } },
  'AWS::ECR::Repository': {
    nameProperty: 'RepositoryName',
    options: { maxLength: 256, lowercase: true },
  },
  'AWS::ECS::Cluster': { nameProperty: 'ClusterName', options: { maxLength: 255 } },
  'AWS::ECS::Service': { nameProperty: 'ServiceName', options: { maxLength: 255 } },
  // `/cdkd/` + 506 = 512. A legacy stack's Cloud Control fill had no prefix.
  'AWS::Logs::LogGroup': {
    nameProperty: 'LogGroupName',
    options: { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g },
    prefix: '/cdkd/',
    legacy: { cloudControl: { maxLength: 512 } },
  },
  // PutMetricAlarm: 1-255 characters.
  'AWS::CloudWatch::Alarm': { nameProperty: 'AlarmName', options: { maxLength: 255 } },
  'AWS::Events::Rule': { nameProperty: 'Name', options: { maxLength: 64 } },
  'AWS::Kinesis::Stream': { nameProperty: 'Name', options: { maxLength: 128 } },
  'AWS::StepFunctions::StateMachine': {
    nameProperty: 'StateMachineName',
    options: { maxLength: 80 },
  },
  'AWS::SecretsManager::Secret': {
    nameProperty: 'Name',
    options: { maxLength: 512, allowedPattern: /[^a-zA-Z0-9-/_]/g },
  },
  // A legacy stack's Cloud Control fill had no leading `/` (a valid name too).
  'AWS::SSM::Parameter': {
    nameProperty: 'Name',
    options: { maxLength: 1023, allowedPattern: /[^a-zA-Z0-9-/_]/g },
    prefix: '/',
    legacy: { cloudControl: { maxLength: 2048 } },
  },
  'AWS::Cognito::UserPool': { nameProperty: 'UserPoolName', options: { maxLength: 128 } },
  'AWS::ElastiCache::SubnetGroup': {
    nameProperty: 'CacheSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::ElastiCache::CacheCluster': {
    nameProperty: 'ClusterName',
    options: { maxLength: 40, lowercase: true },
  },
  'AWS::RDS::DBSubnetGroup': {
    nameProperty: 'DBSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::RDS::DBCluster': {
    nameProperty: 'DBClusterIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::RDS::DBInstance': {
    nameProperty: 'DBInstanceIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  // DocumentDB — RDS-shaped API; same name constraints.
  'AWS::DocDB::DBSubnetGroup': {
    nameProperty: 'DBSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::DocDB::DBCluster': {
    nameProperty: 'DBClusterIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::DocDB::DBInstance': {
    nameProperty: 'DBInstanceIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  // Neptune — RDS-shaped API; same name constraints.
  'AWS::Neptune::DBSubnetGroup': {
    nameProperty: 'DBSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::Neptune::DBCluster': {
    nameProperty: 'DBClusterIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::Neptune::DBInstance': {
    nameProperty: 'DBInstanceIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    nameProperty: 'Name',
    options: { maxLength: 32 },
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    nameProperty: 'Name',
    options: { maxLength: 32 },
  },
  'AWS::WAFv2::WebACL': { nameProperty: 'Name', options: { maxLength: 128 } },
  // CreateProject: 2-150 characters. A legacy stack's SDK provider named the
  // project after the bare logical id; Cloud Control has no handlers for it.
  'AWS::CodeBuild::Project': {
    nameProperty: 'Name',
    options: { maxLength: 150 },
    legacy: { sdk: 'logicalId' },
  },
  // The whole name, zone suffix included, is at most 63 characters. The Cloud
  // Control create reads the zone id from `LocationName`; without one it is
  // refused rather than sent a name AWS rejects.
  'AWS::S3Express::DirectoryBucket': {
    nameProperty: 'BucketName',
    options: { maxLength: 63, lowercase: true },
    zoneSuffix: true,
  },
  // go-to-k/cdkd#5095: the SDK provider generated these names and Cloud
  // Control had no rule. The schema REQUIRES the name of these three, so their
  // Cloud Control create failed on every stack.
  'AWS::CodeCommit::Repository': { nameProperty: 'RepositoryName', options: { maxLength: 100 } },
  'AWS::RDS::DBProxy': { nameProperty: 'DBProxyName', options: { maxLength: 64 } },
  'AWS::RDS::DBProxyEndpoint': {
    nameProperty: 'DBProxyEndpointName',
    options: { maxLength: 64 },
  },
  // go-to-k/cdkd#5309: the SDK provider refused a missing name, which the
  // schema leaves optional (CloudFormation generates one). 3-63 characters of
  // lowercase letters, digits and `-`: the generator emits that, a stack name
  // starts with a letter, and the suffix is hex. A legacy stack's Cloud
  // Control create still leaves the name to the handler.
  'AWS::S3Vectors::VectorBucket': {
    nameProperty: 'VectorBucketName',
    options: { maxLength: 63, lowercase: true },
    legacy: { cloudControl: 'none' },
    notAdopted: true,
  },
  // go-to-k/cdkd#5348: the same, for a Cloud Map service. CreateService takes
  // DNS labels of `[a-zA-Z0-9_-]`, each at most 63 characters, starting and
  // ending with a letter, digit or `_`: the generator emits one label of
  // letters, digits and `-` that starts with a stack name and ends with the
  // hex suffix or the logical id. The schema sets no limit.
  'AWS::ServiceDiscovery::Service': {
    nameProperty: 'Name',
    options: { maxLength: 63 },
    legacy: { cloudControl: 'none' },
    notAdopted: true,
  },
  // ...and the handler named these, which a legacy stack keeps.
  'AWS::Scheduler::Schedule': {
    nameProperty: 'Name',
    options: { maxLength: 64 },
    legacy: { cloudControl: 'none' },
  },
  'AWS::AutoScaling::AutoScalingGroup': {
    nameProperty: 'AutoScalingGroupName',
    options: { maxLength: 255 },
    legacy: { cloudControl: 'none' },
  },
  'AWS::DynamoDB::GlobalTable': {
    nameProperty: 'TableName',
    options: { maxLength: 255 },
    legacy: { cloudControl: 'none' },
  },
  'AWS::ECS::TaskDefinition': {
    nameProperty: 'Family',
    options: { maxLength: 255 },
    legacy: { cloudControl: 'none' },
    notAdopted: true,
  },
  'AWS::Lambda::NetworkConnector': {
    nameProperty: 'Name',
    options: { maxLength: 64 },
    legacy: { cloudControl: 'none' },
    notAdopted: true,
  },
  'AWS::Pipes::Pipe': {
    nameProperty: 'Name',
    options: { maxLength: 64 },
    legacy: { cloudControl: 'none' },
    notAdopted: true,
  },
  // go-to-k/cdkd#5095: the SDK provider sent the bare logical id, unique per
  // VPC / account and region only, so two stacks with one logical id, or a
  // replacement, collided. A legacy stack keeps it; its Cloud Control create
  // still leaves the name to the handler. None was ever admitted to adoption.
  // CreateSecurityGroup: up to 255 characters, not starting with `sg-`.
  'AWS::EC2::SecurityGroup': {
    nameProperty: 'GroupName',
    options: { maxLength: 255 },
    refusedPrefix: 'sg-',
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  // 3-128 characters, letters, digits, `.`, `_`, `-`, starting and ending with
  // a letter or digit: the generator emits `[a-zA-Z0-9-]`, a stack name starts
  // with a letter, and the suffix is hex.
  'AWS::CloudTrail::Trail': {
    nameProperty: 'TrailName',
    options: { maxLength: 128 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  // Glue names: 1-255 characters (CreateJob / CreateCrawler / CreateTrigger /
  // CreateConnection `Name`).
  'AWS::Glue::Job': {
    nameProperty: 'Name',
    options: { maxLength: 255 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  'AWS::Glue::Crawler': {
    nameProperty: 'Name',
    options: { maxLength: 255 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  'AWS::Glue::Connection': {
    nameProperty: 'Name',
    nestedIn: 'ConnectionInput',
    options: { maxLength: 255 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  'AWS::Glue::Trigger': {
    nameProperty: 'Name',
    options: { maxLength: 255 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  // 1-64 characters of `[a-zA-Z0-9._-]`.
  'AWS::KinesisFirehose::DeliveryStream': {
    nameProperty: 'DeliveryStreamName',
    options: { maxLength: 64 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
};
