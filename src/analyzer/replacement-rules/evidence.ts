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
 *  - every property, on ANY type, the spec calls a replacement while the
 *    registry schema leaves it mutable (go-to-k/cdkd#7070,
 *    `scripts/spec-replacement-candidates.ts`), keyed `<Type>#<A>.<B>` when
 *    nested, unless a hand rule decides it or it sits in the unmeasured
 *    baseline (`./evidence-baseline.ts`). Its `replace` rows are the ONLY
 *    ones that reach the deploy path, through
 *    `spec-replacement-properties.generated.ts`;
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
  /**
   * A Cloud Control update of only this property, recorded on `refs`: it
   * applied in place under the same identifier (`update`), or Cloud Control
   * refused it (`replace`). Cloud Control runs the registry handler
   * CloudFormation runs for the type.
   */
  | 'cc-measured'
  /**
   * Cloud Control refused a change of this array or map member, recorded on
   * `refs` (go-to-k/cdkd#7083). A member cannot be compared per element, so
   * the verdict stays `update`: the deploy fails loudly and loses no data.
   */
  | 'element-refused'
  /**
   * No Cloud Control probe can reach the change, for the reason in
   * `unmeasurable` (go-to-k/cdkd#7083). The verdict stays today's `update`.
   */
  | 'cannot-probe'
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
   * Why a `cfn-docs` or `cannot-probe` row was not measured
   * (go-to-k/cdkd#7048, #7083). Only a `cfn-docs` row may rest on the
   * CloudFormation reference; every other verdict cites an execution, the
   * handler, the AWS API or the schema.
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
/** A candidate no probe can reach (go-to-k/cdkd#7083): today's update stays. */
const cannotProbe = (why: string, ...refs: number[]): ReplacementEvidence => ({
  verdict: 'update',
  kind: 'cannot-probe',
  refs: [...refs, 7083],
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
  // Measured through Cloud Control on #7083: in place with
  // `ReplaceComputeEnvironment: false`, `NotUpdatable` without it; Batch
  // refuses a Fargate or BEST_FIT environment either way (#7098).
  ['AWS::Batch::ComputeEnvironment#ComputeResources', conditional('cc-measured', 7083, 7098)],
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
  // --- spec-replacement candidates (go-to-k/cdkd#7070): the spec calls a
  // replacement, the registry schema leaves the path mutable.
  ['AWS::Route53Resolver::ResolverRule#DomainName', replace('cfn-measured', 7069, 7070)],
  // CloudFormation does not replace on it either: the update fails (#3750),
  // and the provider refuses the rename before any call (`refuseNestedRename`).
  ['AWS::Glue::Database#DatabaseInput.Name', update('refused', 3750, 7070)],
  ['AWS::Batch::SchedulingPolicy#Tags', update('cc-measured', 7070)],
  ['AWS::DataBrew::Recipe#Tags', update('cc-measured', 7070)],
  ['AWS::ElastiCache::User#Engine', update('cc-measured', 7070)],
  ['AWS::EntityResolution::SchemaMapping#Description', update('cc-measured', 7070)],
  ['AWS::ImageBuilder::Component#Tags', update('cc-measured', 7070)],
  ['AWS::IoTWireless::NetworkAnalyzerConfiguration#Tags', update('cc-measured', 7070)],
  ['AWS::Location::GeofenceCollection#Description', update('cc-measured', 7070)],
  ['AWS::Location::Map#Description', update('cc-measured', 7070)],
  ['AWS::Location::RouteCalculator#Description', update('cc-measured', 7070)],
  ['AWS::Location::Tracker#PositionFiltering', update('cc-measured', 7070)],
  ['AWS::RedshiftServerless::Namespace#Tags', update('cc-measured', 7070)],
  ['AWS::SageMaker::AppImageConfig#Tags', update('cc-measured', 7070)],
  // The baseline measured on #7083 (Cloud Control, us-east-1). `replace` only
  // where the service API itself refuses the change, so CloudFormation cannot
  // apply it in place either; a Cloud Control-only refusal stays in the
  // baseline with its measurement noted there.
  // AppConfig: "This Type change is not supported".
  ['AWS::AppConfig::ConfigurationProfile#Type', replace('aws-api', 7083)],
  ['AWS::AppConfig::Extension#Tags', update('cc-measured', 7083)],
  ['AWS::AppConfig::ExtensionAssociation#Tags', update('cc-measured', 7083)],
  // A new revision under the same name: CloudFormation's update, too.
  ['AWS::Batch::JobDefinition#Tags', update('cc-measured', 7083)],
  ['AWS::Batch::JobQueue#Tags', update('cc-measured', 7083)],
  ['AWS::Cassandra::Keyspace#ReplicationSpecification', update('cc-measured', 7083)],
  // Keyspaces cannot drop a column; adding one applies in place.
  ['AWS::Cassandra::Table#RegularColumns.*.ColumnName', update('element-refused', 7083)],
  ['AWS::Cassandra::Table#RegularColumns.*.ColumnType', update('element-refused', 7083)],
  ['AWS::DataSync::LocationS3#S3Config', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationS3#S3StorageClass', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationS3#Subdirectory', update('cc-measured', 7083)],
  // "Cannot update a GSI's KeySchema or Projection": a new index name is the
  // way, as under CloudFormation.
  [
    'AWS::DynamoDB::GlobalTable#GlobalSecondaryIndexes.*.KeySchema.*.AttributeName',
    update('element-refused', 7083),
  ],
  [
    'AWS::DynamoDB::GlobalTable#GlobalSecondaryIndexes.*.KeySchema.*.KeyType',
    update('element-refused', 7083),
  ],
  [
    'AWS::DynamoDB::GlobalTable#GlobalSecondaryIndexes.*.Projection.NonKeyAttributes',
    update('element-refused', 7083),
  ],
  [
    'AWS::DynamoDB::GlobalTable#GlobalSecondaryIndexes.*.Projection.ProjectionType',
    update('element-refused', 7083),
  ],
  ['AWS::EKS::Cluster#ResourcesVpcConfig.SecurityGroupIds', update('cc-measured', 7083)],
  // EKS takes new subnets in the cluster's original Availability Zones only.
  ['AWS::EKS::Cluster#ResourcesVpcConfig.SubnetIds', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#Architecture', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#AutoStartConfiguration', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#AutoStartConfiguration.Enabled', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#AutoStopConfiguration', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#AutoStopConfiguration.Enabled', update('cc-measured', 7083)],
  [
    'AWS::EMRServerless::Application#AutoStopConfiguration.IdleTimeoutMinutes',
    update('cc-measured', 7083),
  ],
  ['AWS::EMRServerless::Application#InitialCapacity', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#InitialCapacity.*.Key', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#InitialCapacity.*.Value', update('cc-measured', 7083)],
  [
    'AWS::EMRServerless::Application#InitialCapacity.*.Value.WorkerConfiguration',
    update('cc-measured', 7083),
  ],
  [
    'AWS::EMRServerless::Application#InitialCapacity.*.Value.WorkerConfiguration.Cpu',
    update('cc-measured', 7083),
  ],
  [
    'AWS::EMRServerless::Application#InitialCapacity.*.Value.WorkerConfiguration.Disk',
    update('cc-measured', 7083),
  ],
  [
    'AWS::EMRServerless::Application#InitialCapacity.*.Value.WorkerConfiguration.Memory',
    update('cc-measured', 7083),
  ],
  [
    'AWS::EMRServerless::Application#InitialCapacity.*.Value.WorkerCount',
    update('cc-measured', 7083),
  ],
  ['AWS::EMRServerless::Application#MaximumCapacity', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#MaximumCapacity.Cpu', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#MaximumCapacity.Disk', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#MaximumCapacity.Memory', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#NetworkConfiguration', update('cc-measured', 7083)],
  [
    'AWS::EMRServerless::Application#NetworkConfiguration.SecurityGroupIds',
    update('cc-measured', 7083),
  ],
  ['AWS::EMRServerless::Application#NetworkConfiguration.SubnetIds', update('cc-measured', 7083)],
  ['AWS::EMRServerless::Application#ReleaseLabel', update('cc-measured', 7083)],
  // Write-only: read back as AuthTokenLastModifiedDate moving.
  ['AWS::ElastiCache::ReplicationGroup#AuthToken', update('cc-measured', 7083)],
  // Redis to Valkey applies with the EngineVersion and parameter group AWS requires.
  ['AWS::ElastiCache::ReplicationGroup#Engine', update('cc-measured', 7083)],
  ['AWS::ElastiCache::ReplicationGroup#ReplicasPerNodeGroup', update('cc-measured', 7083)],
  // Measured against CloudFormation on a cluster-mode-enabled group (#7100):
  // without `UseOnlineResharding`, NumNodeGroups 1 -> 2 and a
  // NodeGroupConfiguration ReplicaCount change each REPLACED it (new physical
  // id), though the change sets read `Replacement: False` / `Conditional`.
  // Under the policy, NumNodeGroups resharded in place and the ReplicaCount
  // change failed, so the diff keeps both in place there
  // (`elasticache-online-resharding.ts`). Stateful: a replacement stays behind
  // --force-stateful-recreation.
  [
    'AWS::ElastiCache::ReplicationGroup#NodeGroupConfiguration',
    replace('cfn-measured', 7083, 7100),
  ],
  ['AWS::ElastiCache::ReplicationGroup#NumNodeGroups', replace('cfn-measured', 7083, 7100)],
  // Valkey refuses a password-less user; with a password user it applies.
  ['AWS::ElastiCache::UserGroup#Engine', update('cc-measured', 7083)],
  ['AWS::ElasticLoadBalancing::LoadBalancer#AvailabilityZones', update('cc-measured', 7083)],
  ['AWS::ElasticLoadBalancing::LoadBalancer#HealthCheck', update('cc-measured', 7083)],
  ['AWS::ElasticLoadBalancing::LoadBalancer#Subnets', update('cc-measured', 7083)],
  [
    'AWS::KinesisAnalytics::ApplicationOutput#Output.Name',
    cannotProbe('SQL applications can no longer be created (UnsupportedOperationException)'),
  ],
  ['AWS::KinesisAnalyticsV2::Application#RuntimeEnvironment', update('cc-measured', 7083)],
  [
    'AWS::KinesisAnalyticsV2::ApplicationOutput#Output.Name',
    cannotProbe('SQL applications can no longer be created (UnsupportedOperationException)'),
  ],
  [
    'AWS::KinesisAnalyticsV2::ApplicationReferenceDataSource#ReferenceDataSource.TableName',
    cannotProbe('SQL applications can no longer be created (UnsupportedOperationException)'),
  ],
  // The registry schema allows only RequestBasedUsage.
  ['AWS::Location::Map#PricingPlan', update('single-value', 7083)],
  ['AWS::Location::PlaceIndex#DataSourceConfiguration', update('cc-measured', 7083)],
  ['AWS::Location::PlaceIndex#Description', update('cc-measured', 7083)],
  ['AWS::Location::PlaceIndex#PricingPlan', update('single-value', 7083)],
  ['AWS::Location::RouteCalculator#PricingPlan', update('single-value', 7083)],
  ['AWS::Location::Tracker#Description', update('cc-measured', 7083)],
  // Cloud Control and CloudFormation (#5373) both report success and leave the
  // service in its namespace; the SDK provider names the member in a warning.
  ['AWS::ServiceDiscovery::Service#DnsConfig.NamespaceId', update('cfn-measured', 5373, 7083)],
  ['AWS::Transfer::Server#EndpointDetails.AddressAllocationIds', update('cc-measured', 7083)],
  // Applied with the IdentityProviderDetails the new type needs.
  ['AWS::Transfer::Server#IdentityProviderType', update('cc-measured', 7083)],
  // X-Ray answers "Sampling rule version must be 1".
  ['AWS::XRay::SamplingRule#SamplingRuleRecord.SamplingRule.Version', update('single-value', 7083)],
  // --- updateableProperties beyond the fixture or the spec
  ['AWS::Budgets::Budget#NotificationsWithSubscribers', update('deviation', 7038)],
  ['AWS::EC2::Subnet#Ipv6CidrBlock', update('cfn-measured', 5632)],
  ['AWS::EC2::Instance#EbsOptimized', update('cfn-measured', 7023)],
]);
