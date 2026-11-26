/**
 * Why cdkd's replace-or-update verdict for a property is what CloudFormation
 * does, wherever that verdict is hand-made or disagrees with an oracle
 * (go-to-k/cdkd#7024, go-to-k/cdkd#7038).
 *
 * A wrong verdict is destructive either way: a replacement CloudFormation
 * would not make deletes the resource (#7023), and an update where
 * CloudFormation replaces hides the replacement from `cdkd diff`. So
 * `tests/unit/analyzer/replacement-evidence.test.ts` requires a row here for
 *
 *  - every `conditionalReplacements` predicate and provider-replacement
 *    planner property (hand-written logic, never self-evident);
 *  - every other verdict that disagrees with the committed schema fixture's
 *    create-only paths or with `@aws-cdk/aws-service-spec` (what `cdk diff`
 *    reads), or that neither of them covers;
 *
 * and fails on a row that no longer matches such a verdict. The spec is a
 * dev dependency updated weekly, so a CloudFormation change re-runs the check.
 *
 * Read by that test only: nothing on the deploy path imports this module.
 */

/** What kind of evidence a row records. */
export type ReplacementEvidenceKind =
  /** A CloudFormation A/B (change set + execution) recorded on `refs`. */
  | 'cfn-measured'
  /** Transcribed from CloudFormation's own resource handler, recorded on `refs`. */
  | 'cfn-handler'
  /** The CloudFormation template reference's "Update requires" line, quoted on `refs`. */
  | 'cfn-docs'
  /** The AWS API cannot apply the change in place (no update member, or it refuses). */
  | 'aws-api'
  /** A nested create-only path the committed fixture lists under the property. */
  | 'schema-nested'
  /** A deliberate, safer difference from CloudFormation, decided on `refs`. */
  | 'deviation'
  /** The property takes one valid value, so it cannot change. */
  | 'single-value'
  /**
   * cdkd's `update()` refuses the change before any AWS call, naming the
   * remedy, so the diff's "update" never applies a wrong result.
   */
  | 'refused'
  /**
   * A MEASURED difference from CloudFormation that the issue in `refs` fixes;
   * the row changes with that fix.
   */
  | 'open-divergence';

/** The verdict a row vouches for: always replace, never, by a predicate, or by a nested create-only path. */
export type ReplacementVerdict = 'replace' | 'update' | 'conditional' | 'nested';

export interface ReplacementEvidence {
  /**
   * Why a `cfn-docs` row was not measured (go-to-k/cdkd#7048). Only such a row
   * may rest on the CloudFormation reference; every other verdict cites an
   * execution, the handler, the AWS API or the schema.
   */
  readonly unmeasurable?: string;
  /**
   * The verdict the evidence supports. The check compares it with cdkd's
   * current verdict, so flipping a verdict (an entry moved between
   * `replacementProperties` and `updateableProperties`) needs new evidence.
   */
  readonly verdict: ReplacementVerdict;
  readonly kind: ReplacementEvidenceKind;
  /** Issues / PRs holding the measurement, quote or decision. */
  readonly refs: readonly number[];
}

const row =
  (verdict: ReplacementVerdict) =>
  (kind: ReplacementEvidenceKind, ...refs: number[]): ReplacementEvidence => ({
    verdict,
    kind,
    refs,
  });
/** An `update` verdict resting on the reference because no A/B is possible here. */
const unmeasurable = (why: string, ...refs: number[]): ReplacementEvidence => ({
  verdict: 'update',
  kind: 'cfn-docs',
  refs: [...refs, 7048],
  unmeasurable: why,
});
const replace = row('replace');
const update = row('update');
const conditional = row('conditional');
const nested = row('nested');

/** `<Type>#<Property>` -> its evidence. */
export const REPLACEMENT_EVIDENCE: ReadonlyMap<string, ReplacementEvidence> = new Map([
  // --- conditionalReplacements predicates
  ['AWS::Lambda::Function#DurableConfig', conditional('cfn-measured', 7038)],
  ['AWS::Lambda::EventInvokeConfig#FunctionName', conditional('deviation', 4118, 7038)],
  ['AWS::DynamoDB::GlobalTable#LocalSecondaryIndexes', conditional('cfn-measured', 5489)],
  ['AWS::DynamoDB::Table#AttributeDefinitions', conditional('cfn-measured', 7038)],
  ['AWS::IAM::Role#Path', conditional('cfn-measured', 4739)],
  ['AWS::SSM::Document#Content', conditional('cfn-measured', 6568)],
  ['AWS::SSM::Document#Attachments', conditional('cfn-measured', 6568)],
  ['AWS::SSM::Document#DocumentFormat', conditional('cfn-measured', 6568)],
  ['AWS::SSM::Document#Requires', conditional('cfn-measured', 6568)],
  ['AWS::SSM::Document#TargetType', conditional('cfn-measured', 6568)],
  ['AWS::SSM::Document#VersionName', conditional('cfn-measured', 6568)],
  ['AWS::Budgets::Budget#Budget', conditional('schema-nested')],
  ['AWS::Glue::Table#TableInput', conditional('cfn-measured', 3750)],
  ['AWS::Route53::RecordSet#HostedZoneId', conditional('cfn-measured', 6537)],
  ['AWS::Route53::RecordSet#HostedZoneName', conditional('cfn-measured', 6537)],
  ['AWS::Route53::RecordSetGroup#HostedZoneId', conditional('cfn-measured', 6537)],
  ['AWS::Route53::RecordSetGroup#HostedZoneName', conditional('cfn-measured', 6537)],
  ['AWS::Route53::RecordSetGroup#RecordSets', conditional('cfn-measured', 6530)],
  ['AWS::EC2::VPC#InstanceTenancy', conditional('cfn-measured', 5449)],
  ['AWS::RDS::DBCluster#Engine', conditional('cfn-handler', 5467)],
  ['AWS::RDS::DBInstance#Engine', conditional('cfn-handler', 5467)],
  // The handlers' other immutability checks (rds-immutability.ts).
  ['AWS::RDS::DBCluster#GlobalClusterIdentifier', conditional('cfn-handler', 7044)],
  ['AWS::RDS::DBInstance#AvailabilityZone', conditional('cfn-measured', 7038, 7044)],
  ['AWS::RDS::DBInstance#PerformanceInsightsKMSKeyId', conditional('cfn-measured', 7038, 7044)],
  ['AWS::RDS::DBInstance#DBSnapshotIdentifier', conditional('cfn-handler', 7044)],
  ['AWS::RDS::DBInstance#DBClusterSnapshotIdentifier', conditional('cfn-handler', 7044)],
  ['AWS::RDS::DBInstance#RestoreTime', conditional('cfn-handler', 7044)],
  ['AWS::RDS::DBInstance#UseLatestRestorableTime', conditional('cfn-handler', 7044)],
  ['AWS::RDS::DBInstance#SourceDBInstanceAutomatedBackupsArn', conditional('cfn-handler', 7044)],
  ['AWS::RDS::DBInstance#SourceDbiResourceId', conditional('cfn-handler', 7044)],
  ['AWS::RDS::DBInstance#SourceDBInstanceIdentifier', conditional('cfn-handler', 7044)],
  ['AWS::RDS::DBInstance#SourceDBClusterIdentifier', conditional('cfn-handler', 7044)],
  ['AWS::EC2::Instance#SecurityGroupIds', conditional('cfn-measured', 5446)],
  ['AWS::EC2::Instance#BlockDeviceMappings', conditional('cfn-measured', 5446)],
  ['AWS::EC2::Instance#Tenancy', conditional('cfn-measured', 5630)],
  ['AWS::EC2::Instance#PrivateDnsNameOptions', conditional('cfn-measured', 5630)],
  ['AWS::EC2::NatGateway#AvailabilityZoneAddresses', conditional('cfn-measured', 2762)],
  ['AWS::ECS::Service#LaunchType', conditional('cfn-measured', 5392)],
  ['AWS::ElastiCache::CacheCluster#AZMode', conditional('cfn-measured', 5558, 7038, 7045)],
  [
    'AWS::ElastiCache::CacheCluster#PreferredAvailabilityZones',
    conditional('cfn-measured', 5458, 5558, 7038, 7045),
  ],
  ['AWS::EMR::Cluster#Instances', conditional('cfn-measured', 5418)],
  // --- provider-replacement planners
  ['AWS::SNS::Subscription#DeliveryPolicy', conditional('cfn-measured', 6509)],
  ['AWS::SNS::Subscription#FilterPolicy', conditional('cfn-measured', 6509)],
  ['AWS::SNS::Subscription#FilterPolicyScope', conditional('cfn-measured', 6509)],
  ['AWS::SNS::Subscription#ReplayPolicy', conditional('cfn-measured', 6509)],
  ['AWS::SNS::Subscription#SubscriptionRoleArn', conditional('cfn-measured', 6509)],
  ['AWS::Route53::RecordSet#Name', conditional('cfn-measured', 6656)],
  // --- replacementProperties beyond the fixture or the spec
  ['AWS::AppSync::GraphQLApi#ApiType', replace('aws-api', 5359)],
  ['AWS::AppSync::GraphQLApi#Visibility', replace('aws-api', 5359)],
  ['AWS::CertificateManager::Certificate#ValidationMethod', replace('aws-api', 6513, 7038)],
  ['AWS::DynamoDB::Table#KeySchema', replace('cfn-measured', 7038)],
  ['AWS::Events::Rule#EventBusName', replace('cfn-measured', 7038)],
  ['AWS::RDS::DBProxyEndpoint#TargetRole', replace('aws-api', 7038)],
  ['AWS::EC2::Volume#AvailabilityZone', replace('aws-api', 1356)],
  ['AWS::EC2::Volume#AvailabilityZoneId', replace('aws-api', 1356)],
  ['AWS::EC2::Volume#Encrypted', replace('aws-api', 1356)],
  ['AWS::EC2::Volume#KmsKeyId', replace('aws-api', 1356)],
  ['AWS::EC2::Volume#OutpostArn', replace('aws-api', 1356)],
  ['AWS::EC2::Volume#SnapshotId', replace('aws-api', 1356)],
  // --- schema-driven verdicts the spec disagrees with. The registry schema
  // makes a nested path create-only and CloudFormation replaces on it, while
  // the reference page (which the spec reads) says "No interruption" for the
  // whole property.
  ['AWS::BedrockAgentCore::Evaluator#EvaluatorConfig', nested('schema-nested')],
  ['AWS::EC2::VPCEndpoint#DnsOptions', nested('schema-nested')],
  ['AWS::Glue::Connection#ConnectionInput', nested('schema-nested')],
  [
    'AWS::KinesisFirehose::DeliveryStream#AmazonOpenSearchServerlessDestinationConfiguration',
    nested('schema-nested'),
  ],
  [
    'AWS::KinesisFirehose::DeliveryStream#AmazonopensearchserviceDestinationConfiguration',
    nested('schema-nested'),
  ],
  [
    'AWS::KinesisFirehose::DeliveryStream#ElasticsearchDestinationConfiguration',
    nested('schema-nested'),
  ],
  ['AWS::KinesisFirehose::DeliveryStream#IcebergDestinationConfiguration', nested('schema-nested')],
  [
    'AWS::KinesisFirehose::DeliveryStream#SnowflakeDestinationConfiguration',
    nested('schema-nested'),
  ],
  ['AWS::Pipes::Pipe#SourceParameters', nested('schema-nested')],
  // --- schema-driven verdicts the spec calls a replacement. Each matches the
  // current CloudFormation reference (the spec reads an older one) or is
  // refused before any call; the per-property findings are on #7038.
  ['AWS::AppSync::GraphQLSchema#ApiId', update('refused', 5359, 7038)],
  ['AWS::DocDB::DBCluster#EngineVersion', update('cfn-measured', 7038, 7048)],
  ['AWS::DynamoDB::GlobalTable#KeySchema', update('refused', 7038)],
  ['AWS::EC2::EIP#Domain', update('single-value', 5449)],
  [
    'AWS::ECS::Service#DeploymentController',
    unmeasurable(
      'a change that succeeds needs a load-balanced service and a CodeDeploy deployment group; without them CloudFormation fails before showing whether it replaces',
      5634,
      7038
    ),
  ],
  ['AWS::EMR::InstanceFleetConfig#InstanceTypeConfigs', update('cfn-measured', 1160)],
  ['AWS::Events::EventBus#EventSourceName', update('aws-api', 7038)],
  ['AWS::FSx::FileSystem#FileSystemTypeVersion', update('cfn-measured', 7038, 7048)],
  ['AWS::Glue::Database#CatalogId', update('refused', 7038)],
  [
    'AWS::Lambda::EventSourceMapping#AmazonManagedKafkaEventSourceConfig',
    unmeasurable('needs an MSK cluster (cost)', 7038),
  ],
  [
    'AWS::Lambda::EventSourceMapping#SelfManagedKafkaEventSourceConfig',
    update('cfn-measured', 7038),
  ],
  ['AWS::RDS::DBCluster#AvailabilityZones', update('cfn-handler', 5639)],
  ['AWS::RDS::DBInstance#Port', update('cfn-measured', 7038, 7048)],
  ['AWS::S3::Bucket#ObjectLockEnabled', update('cfn-measured', 5395, 7038)],
  // --- properties the schema makes conditionally create-only, or the spec
  // calls "maybe", that cdkd updates in place or refuses. CloudFormation
  // documents each as "Some interruptions" or "No interruption", or replaces
  // only on a shape cdkd refuses before any call; findings on #7038.
  ['AWS::CodeCommit::Repository#Triggers', update('cfn-measured', 1066, 7038, 7048)],
  ['AWS::EC2::Instance#AdditionalInfo', update('cfn-measured', 5630)],
  ['AWS::EC2::Instance#Affinity', unmeasurable('needs a Dedicated Host', 5630)],
  ['AWS::EC2::Instance#HostId', unmeasurable('needs a Dedicated Host', 5630)],
  [
    'AWS::EC2::Instance#KernelId',
    unmeasurable('needs a paravirtual AMI no current instance type launches', 5630),
  ],
  [
    'AWS::EC2::Instance#RamdiskId',
    unmeasurable('needs a paravirtual AMI no current instance type launches', 5630),
  ],
  ['AWS::EC2::Instance#UserData', update('cfn-measured', 5446)],
  ['AWS::ElastiCache::CacheCluster#PreferredAvailabilityZone', update('cfn-measured', 5444)],
  ['AWS::RDS::DBCluster#MasterUsername', update('cfn-measured', 5467)],
  ['AWS::RDS::DBInstance#AutoMinorVersionUpgrade', update('cfn-handler', 7038)],
  ['AWS::RDS::DBInstance#BackupRetentionPeriod', update('cfn-handler', 7038)],
  ['AWS::RDS::DBInstance#MultiAZ', update('cfn-handler', 7038)],
  ['AWS::RDS::DBInstance#PreferredMaintenanceWindow', update('cfn-handler', 7038)],
  ['AWS::RDS::DBInstance#StorageType', update('cfn-handler', 7038)],
  ['AWS::RDS::DBInstance#DBParameterGroupName', update('cfn-measured', 7038, 7048)],
  ['AWS::AppSync::GraphQLApi#LambdaAuthorizerConfig', update('cfn-measured', 7038, 7048)],
  ['AWS::AppSync::GraphQLApi#OpenIDConnectConfig', update('cfn-measured', 7038, 7048)],
  ['AWS::AppSync::GraphQLApi#UserPoolConfig', update('cfn-measured', 7038, 7048)],
  // An AutoScalingReplacingUpdate replaces the group only under `--update-policy`.
  [
    'AWS::AutoScaling::AutoScalingGroup#LaunchConfigurationName',
    unmeasurable('launch configurations can no longer be created', 6437),
  ],
  ['AWS::AutoScaling::AutoScalingGroup#LaunchTemplate', update('cfn-measured', 6437, 7048)],
  ['AWS::AutoScaling::AutoScalingGroup#MixedInstancesPolicy', update('cfn-measured', 6437, 7048)],
  ['AWS::AutoScaling::AutoScalingGroup#VPCZoneIdentifier', update('cfn-measured', 6437, 7048)],
  // Cloud Control route: a NotUpdatable answer fails the deploy, never replaces.
  [
    'AWS::DynamoDB::GlobalTable#GlobalTableSourceArn',
    unmeasurable('needs a second AWS account', 7038),
  ],
  ['AWS::ElastiCache::CacheCluster#IpDiscovery', update('cfn-measured', 5545, 7038, 7048)],
  ['AWS::Lambda::Function#AcceleratorConfig', update('refused', 6352, 6789)],
  ['AWS::Neptune::DBInstance#AutoMinorVersionUpgrade', update('cfn-measured', 5544)],
  ['AWS::Neptune::DBInstance#DBParameterGroupName', update('cfn-measured', 5544, 7038, 7048)],
  ['AWS::Neptune::DBInstance#PreferredMaintenanceWindow', update('cfn-measured', 5544, 7038, 7048)],
  ['AWS::SNS::Subscription#Region', update('cfn-measured', 7038, 7048)],
  ['AWS::EC2::Instance#InstanceType', update('cfn-measured', 5446, 7038)],
  ['AWS::ElastiCache::CacheCluster#NumCacheNodes', update('cfn-measured', 7038)],
  // --- updateableProperties beyond the fixture or the spec
  ['AWS::Budgets::Budget#NotificationsWithSubscribers', update('deviation', 7038)],
  ['AWS::EC2::Subnet#Ipv6CidrBlock', update('cfn-measured', 5632)],
  ['AWS::EC2::Instance#EbsOptimized', update('cfn-measured', 7023)],
]);
