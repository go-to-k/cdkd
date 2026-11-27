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

import { FSX_FILE_SYSTEM_EVIDENCE } from './evidence-fsx.ts';
import {
  type ReplacementEvidence,
  cannotProbe,
  conditional,
  nested,
  replace,
  unmeasurable,
  update,
} from './evidence-rows.ts';

export type {
  ReplacementEvidence,
  ReplacementEvidenceKind,
  ReplacementVerdict,
} from './evidence-rows.ts';

/** Account-level service roles a probe may not create (go-to-k/cdkd#7083). */
const APPSTREAM_ROLE = cannotProbe(
  'AppStream refuses a fleet create unless the account-level service role AmazonAppStreamServiceAccess exists ("your service role ... is invalid"), and creating that role is an account-level change'
);
const WORKSPACES_ROLE = cannotProbe(
  'WorkSpaces refuses to register a directory unless the account-level role workspaces_DefaultRole exists, and creating that role is an account-level change'
);

/** `<Type>#<Property>` -> its evidence. */
export const REPLACEMENT_EVIDENCE: ReadonlyMap<string, ReplacementEvidence> = new Map([
  // --- conditionalReplacements predicates
  ['AWS::Lambda::Function#DurableConfig', conditional('cfn-measured', 7038)],
  ['AWS::Lambda::EventInvokeConfig#FunctionName', conditional('deviation', 4118, 7038)],
  ['AWS::DynamoDB::GlobalTable#LocalSecondaryIndexes', conditional('cfn-measured', 5489)],
  ['AWS::DynamoDB::Table#AttributeDefinitions', conditional('cfn-measured', 7038)],
  ['AWS::IAM::Role#Path', conditional('cfn-measured', 4739)],
  ['AWS::IoT::ThingType#ThingTypeProperties', conditional('cfn-measured', 7083)],
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
  // Slice 2 of the #7083 baseline (Cloud Control, us-east-1, 2026-11-27).
  ['AWS::AmplifyUIBuilder::Component#Tags', update('cc-measured', 7083)],
  ['AWS::AmplifyUIBuilder::Form#Tags', update('cc-measured', 7083)],
  ['AWS::AmplifyUIBuilder::Theme#Tags', update('cc-measured', 7083)],
  // Write-only, and deprecated in the registry schema (ignored by the service): the update applies under the same id.
  ['AWS::BedrockAgentCore::Dataset#SchemaType', update('cc-measured', 7083)],
  ['AWS::CleanRooms::ConfiguredTable#AllowedColumns', update('cc-measured', 7083)],
  // Applied with the SelectedAnalysisMethods that MULTIPLE requires.
  ['AWS::CleanRooms::ConfiguredTable#AnalysisMethod', update('cc-measured', 7083)],
  ['AWS::CleanRooms::ConfiguredTable#TableReference', update('cc-measured', 7083)],
  ['AWS::DataBrew::Dataset#Tags', update('cc-measured', 7083)],
  ['AWS::DataBrew::Job#Tags', update('cc-measured', 7083)],
  ['AWS::DataBrew::Project#Tags', update('cc-measured', 7083)],
  ['AWS::DataBrew::Schedule#Tags', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationEFS#AccessPointArn', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationEFS#FileSystemAccessRoleArn', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationEFS#InTransitEncryption', update('cc-measured', 7083)],
  // Write-only: read back as the LocationUri's path.
  ['AWS::DataSync::LocationEFS#Subdirectory', update('cc-measured', 7083)],
  // "Cannot update VI's properties. You can create a new VI with a different
  // name": as for a GSI's projection.
  [
    'AWS::DynamoDB::GlobalTable#VectorIndexes.*.Projection.NonKeyAttributes',
    update('element-refused', 7083),
  ],
  [
    'AWS::DynamoDB::GlobalTable#VectorIndexes.*.Projection.ProjectionType',
    update('element-refused', 7083),
  ],
  ['AWS::EC2::CapacityReservation#InstanceMatchCriteria', update('cc-measured', 7083)],
  ['AWS::EC2::CapacityReservation#TagSpecifications', update('cc-measured', 7083)],
  ['AWS::EC2::CapacityReservationFleet#TagSpecifications', update('cc-measured', 7083)],
  ['AWS::EC2::TransitGatewayRouteTable#Tags', update('cc-measured', 7083)],
  ['AWS::EntityResolution::SchemaMapping#MappedInputFields', update('cc-measured', 7083)],
  ['AWS::FIS::ExperimentTemplate#Tags', update('cc-measured', 7083)],
  ['AWS::ImageBuilder::ContainerRecipe#Tags', update('cc-measured', 7083)],
  ['AWS::ImageBuilder::ImageRecipe#Tags', update('cc-measured', 7083)],
  [
    'AWS::MediaStore::Container#CorsPolicy.*.AllowedMethods',
    cannotProbe('Cloud Control refuses CREATE for the type (UnsupportedActionException)'),
  ],
  ['AWS::Omics::SequenceStore#Description', update('cc-measured', 7083)],
  // Applied once the bucket policy lets Omics write there.
  ['AWS::Omics::SequenceStore#FallbackLocation', update('cc-measured', 7083)],
  ['AWS::Omics::SequenceStore#Name', update('cc-measured', 7083)],
  ['AWS::Omics::SequenceStore#Tags', update('cc-measured', 7083)],
  ['AWS::OpenSearchServerless::Collection#Tags', update('cc-measured', 7083)],
  [
    'AWS::WorkSpacesWeb::UserSettings#AdditionalEncryptionContext',
    cannotProbe(
      'WorkSpaces Secure Browser is in maintenance mode: new resources cannot be created (AccessDeniedException)'
    ),
  ],
  [
    'AWS::WorkSpacesWeb::UserSettings#CustomerManagedKey',
    cannotProbe(
      'WorkSpaces Secure Browser is in maintenance mode: new resources cannot be created (AccessDeniedException)'
    ),
  ],
  // Audit Manager.
  [
    'AWS::AuditManager::Assessment#Scope.AwsAccounts.*.EmailAddress',
    cannotProbe(
      'Audit Manager is not enabled for the account (INACTIVE); enabling it is an account-level change'
    ),
  ],
  [
    'AWS::AuditManager::Assessment#Scope.AwsAccounts.*.Id',
    cannotProbe(
      'Audit Manager is not enabled for the account (INACTIVE); enabling it is an account-level change'
    ),
  ],
  [
    'AWS::AuditManager::Assessment#Scope.AwsAccounts.*.Name',
    cannotProbe(
      'Audit Manager is not enabled for the account (INACTIVE); enabling it is an account-level change'
    ),
  ],
  // Measured against CloudFormation (#7083, #7099): a secondary-address
  // change applied in place under the same interface id; a primary change was
  // attempted in place and failed ("is already assigned"), with no
  // replacement. Cloud Control reports the secondary change success and
  // applies nothing; cdkd applies it through EC2 (#7099).
  ['AWS::EC2::NetworkInterface#PrivateIpAddresses', update('cfn-measured', 7083, 7099)],
  ['AWS::EC2::NetworkInterface#PrivateIpAddresses.*.Primary', update('cfn-measured', 7083)],
  [
    'AWS::EC2::NetworkInterface#PrivateIpAddresses.*.PrivateIpAddress',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::EC2::VPCPeeringConnection#PeerRoleArn',
    cannotProbe('A peer role is for a peer in another account; this account has no second one'),
  ],
  [
    'AWS::GuardDuty::Member#Email',
    cannotProbe('A member is another account; this account has no second one, nor a detector'),
  ],
  [
    'AWS::RDS::DBSecurityGroup#DBSecurityGroupIngress.*.EC2SecurityGroupId',
    cannotProbe('Cloud Control refuses CREATE for the type (UnsupportedActionException)'),
  ],
  [
    'AWS::RDS::DBSecurityGroup#DBSecurityGroupIngress.*.EC2SecurityGroupName',
    cannotProbe('Cloud Control refuses CREATE for the type (UnsupportedActionException)'),
  ],
  [
    'AWS::RDS::DBSecurityGroup#DBSecurityGroupIngress.*.EC2SecurityGroupOwnerId',
    cannotProbe('Cloud Control refuses CREATE for the type (UnsupportedActionException)'),
  ],
  [
    'AWS::SES::DedicatedIpPool#ScalingMode',
    cannotProbe(
      'A MANAGED pool subscribes the account to managed dedicated IPs, a billed account-level change'
    ),
  ],
  [
    'AWS::ServiceCatalog::PortfolioShare#AcceptLanguage',
    cannotProbe('A share targets another account; this account has no second one'),
  ],
  [
    'AWS::Timestream::ScheduledQuery#ClientToken',
    cannotProbe('Only existing Timestream for LiveAnalytics customers can use the service'),
  ],
  // CloudFormation switched the registration between the service-linked role
  // and its own role in place, both ways (same ARN, new role read back).
  // Cloud Control refuses the switch to its own role, so cdkd deregisters and
  // registers the location, as CloudFormation does (#7121).
  ['AWS::LakeFormation::Resource#UseServiceLinkedRole', update('cfn-measured', 7083, 7121)],
  // CloudFormation reported UPDATE_COMPLETE under the same session id, with
  // no replacement; its live interface was not read. Cloud Control reported
  // the same update a success while the live session kept its source
  // interface: EC2's ModifyTrafficMirrorSession has no member for it.
  ['AWS::EC2::TrafficMirrorSession#NetworkInterfaceId', update('cfn-measured', 7083)],
  // ModifyVpnConnection / ModifyVpnTunnelOptions: each applied under the same
  // VPN connection id, the gateway moves read back live.
  ['AWS::EC2::VPNConnection#CustomerGatewayId', update('cc-measured', 7083)],
  ['AWS::EC2::VPNConnection#TransitGatewayId', update('cc-measured', 7083)],
  ['AWS::EC2::VPNConnection#VpnGatewayId', update('cc-measured', 7083)],
  ['AWS::EC2::VPNConnection#VpnTunnelOptionsSpecifications', update('cc-measured', 7083)],
  // Slice 3 of the #7083 baseline (us-east-1, 2026-11-28).
  ['AWS::Connect::PhoneNumber#Description', update('cfn-measured', 7083)],
  // CloudFormation's handler refuses it in place ("Attempt to modify
  // AWS::Connect::ViewVersion"), with no replacement. Cloud Control runs the
  // same handler (not measured).
  ['AWS::Connect::ViewVersion#VersionDescription', update('cfn-measured', 7083)],
  // ModifySpotFleetRequest: each applied under the same request id, read back.
  [
    'AWS::EC2::SpotFleet#SpotFleetRequestConfigData.LaunchTemplateConfigs',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::EC2::SpotFleet#SpotFleetRequestConfigData.OnDemandTargetCapacity',
    update('cfn-measured', 7083),
  ],
  // CloudFormation A/B, each enabled (false -> true) in place under the same
  // domain, AdvancedSecurityOptions with an internal master user; the
  // disable direction was not measured.
  ['AWS::Elasticsearch::Domain#AdvancedSecurityOptions', update('cfn-measured', 7083)],
  ['AWS::Elasticsearch::Domain#AdvancedSecurityOptions.Enabled', update('cfn-measured', 7083)],
  ['AWS::Elasticsearch::Domain#EncryptionAtRestOptions.Enabled', update('cfn-measured', 7083)],
  ['AWS::Elasticsearch::Domain#NodeToNodeEncryptionOptions', update('cfn-measured', 7083)],
  ['AWS::Elasticsearch::Domain#NodeToNodeEncryptionOptions.Enabled', update('cfn-measured', 7083)],
  // CloudFormation A/B on #7083: ElasticsearchVersion 7.9 -> 7.10 with no
  // UpdatePolicy, and KmsKeyId from the AWS-managed key to a customer key,
  // each failed "cannot update a stack when a custom-named resource requires
  // replacing", so CloudFormation replaces on both (#7130). Under
  // `UpdatePolicy: EnableVersionUpgrade` it was measured upgrading 7.9 -> 7.10
  // in place (UPDATE_COMPLETE, same physical id), so the diff keeps that
  // change in place there (`version-upgrade-policy.ts`).
  // Stateful: a replacement stays behind --force-stateful-recreation.
  ['AWS::Elasticsearch::Domain#ElasticsearchVersion', replace('cfn-measured', 7083, 7130)],
  [
    'AWS::Elasticsearch::Domain#EncryptionAtRestOptions.KmsKeyId',
    replace('cfn-measured', 7083, 7130),
  ],
  // Recovery Control: a CloudFormation A/B in us-west-2, its home Region.
  ['AWS::Route53RecoveryControl::SafetyRule#Tags', update('cfn-measured', 7083)],
  // UpdateDomain: each applied under the same domain id and read back (Tags by
  // the domain ARN). The image ARNs are AWS-owned SageMaker images.
  ['AWS::SageMaker::Domain#AppNetworkAccessType', update('cc-measured', 7083)],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.JupyterLabAppSettings.DefaultResourceSpec.InstanceType',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.JupyterLabAppSettings.DefaultResourceSpec.LifecycleConfigArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.JupyterLabAppSettings.DefaultResourceSpec.SageMakerImageArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.JupyterLabAppSettings.DefaultResourceSpec.SageMakerImageVersionArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.JupyterServerAppSettings.DefaultResourceSpec.InstanceType',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.JupyterServerAppSettings.DefaultResourceSpec.LifecycleConfigArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.JupyterServerAppSettings.DefaultResourceSpec.SageMakerImageArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.JupyterServerAppSettings.DefaultResourceSpec.SageMakerImageVersionArn',
    cannotProbe('SageMaker refuses any image version for a JupyterServer app (InvalidRequest)'),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.KernelGatewayAppSettings.DefaultResourceSpec.InstanceType',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.KernelGatewayAppSettings.DefaultResourceSpec.LifecycleConfigArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.KernelGatewayAppSettings.DefaultResourceSpec.SageMakerImageArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultSpaceSettings.KernelGatewayAppSettings.DefaultResourceSpec.SageMakerImageVersionArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.CodeEditorAppSettings.DefaultResourceSpec.InstanceType',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.CodeEditorAppSettings.DefaultResourceSpec.LifecycleConfigArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.CodeEditorAppSettings.DefaultResourceSpec.SageMakerImageArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.CodeEditorAppSettings.DefaultResourceSpec.SageMakerImageVersionArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.JupyterLabAppSettings.DefaultResourceSpec.InstanceType',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.JupyterLabAppSettings.DefaultResourceSpec.LifecycleConfigArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.JupyterLabAppSettings.DefaultResourceSpec.SageMakerImageArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.JupyterLabAppSettings.DefaultResourceSpec.SageMakerImageVersionArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.JupyterServerAppSettings.DefaultResourceSpec.InstanceType',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.JupyterServerAppSettings.DefaultResourceSpec.LifecycleConfigArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.JupyterServerAppSettings.DefaultResourceSpec.SageMakerImageArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.JupyterServerAppSettings.DefaultResourceSpec.SageMakerImageVersionArn',
    cannotProbe('SageMaker refuses any image version for a JupyterServer app (InvalidRequest)'),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.KernelGatewayAppSettings.DefaultResourceSpec.InstanceType',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.KernelGatewayAppSettings.DefaultResourceSpec.LifecycleConfigArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.KernelGatewayAppSettings.DefaultResourceSpec.SageMakerImageArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.KernelGatewayAppSettings.DefaultResourceSpec.SageMakerImageVersionArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.RSessionAppSettings.DefaultResourceSpec.InstanceType',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.RSessionAppSettings.DefaultResourceSpec.LifecycleConfigArn',
    cannotProbe('Studio lifecycle configurations have no RSession app type'),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.RSessionAppSettings.DefaultResourceSpec.SageMakerImageArn',
    update('cc-measured', 7083),
  ],
  [
    'AWS::SageMaker::Domain#DefaultUserSettings.RSessionAppSettings.DefaultResourceSpec.SageMakerImageVersionArn',
    update('cc-measured', 7083),
  ],
  ['AWS::SageMaker::Domain#SubnetIds', update('cc-measured', 7083)],
  ['AWS::SageMaker::Domain#Tags', update('cc-measured', 7083)],
  // Measured on #7083 (us-east-1): Cloud Control refuses a VpcId change
  // (NotUpdatable, "VpcId change requires replacement"), and a CloudFormation
  // execution of a VpcId-only change went to the handler's create path: the
  // new domain failed AlreadyExists on the DomainName it keeps, and the stack
  // rolled back. So CloudFormation replaces on it (#7126), and succeeds only
  // when DomainName changes too. Only a value -> value change was measured;
  // adding or removing VpcId was not. Stateful: a replacement stays behind
  // --force-stateful-recreation, and with it cdkd's create-first replacement
  // meets the same collision (probed: a second Cloud Control create under the
  // same name fails AlreadyExists) and refuses it, deleting nothing even
  // under --replace: cdkd has no name key for the type, so it cannot prove the
  // old domain holds the colliding name.
  [
    'AWS::SageMaker::Domain#VpcId',
    { ...replace('cfn-measured', 7083, 7126), cfnKeepsName: 'DomainName' },
  ],
  // CloudFormation reports UPDATE_COMPLETE under the same version ARN and
  // leaves the specifications as created: no replacement either way.
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.ContainerHostname',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.Environment',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.FrameworkVersion',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.Image',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.ModelDataUrl',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.ModelInput',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.ModelInput.DataInputConfig',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.NearestModelName',
    update('cfn-measured', 7083),
  ],
  // Appended in place on update (UpdateModelPackage), same version ARN.
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.ContainerHostname',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.Environment',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.FrameworkVersion',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.Image',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.ModelDataUrl',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.ModelInput',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.ModelInput.DataInputConfig',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.NearestModelName',
    update('cfn-measured', 7083),
  ],
  ['AWS::SageMaker::UserProfile#Tags', update('cc-measured', 7083)],
  [
    'AWS::SageMaker::Workteam#MemberDefinitions.*.CognitoMemberDefinition.CognitoUserPool',
    cannotProbe(
      "A Cognito work team's pool is the private workforce's, one per account and Region, and UpdateWorkforce cannot change its Cognito pool: no second pool can be named"
    ),
  ],
  // FSx file systems: `./evidence-fsx.ts`.
  ...FSX_FILE_SYSTEM_EVIDENCE,
  // DataSync FSx locations: Cloud Control updates read back in place under the
  // same location ARN (the write-only Subdirectory and Password through an
  // `add` patch).
  ['AWS::DataSync::LocationFSxLustre#Subdirectory', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationFSxONTAP#Subdirectory', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationFSxOpenZFS#Protocol', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationFSxOpenZFS#Subdirectory', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationFSxWindows#Domain', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationFSxWindows#Password', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationFSxWindows#Subdirectory', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationFSxWindows#User', update('cc-measured', 7083)],
  // Agent-based and agentless locations: Cloud Control updates (an `add`
  // patch, the hostname being write-only) read back the new hostname under the
  // same location ARN, the NFS and SMB ones through a throwaway activated agent.
  ['AWS::DataSync::LocationNFS#ServerHostname', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationObjectStorage#ServerHostname', update('cc-measured', 7083)],
  ['AWS::DataSync::LocationSMB#ServerHostname', update('cc-measured', 7083)],
  ['AWS::WorkSpaces::Workspace#BundleId', WORKSPACES_ROLE],
  ['AWS::WorkSpaces::Workspace#RootVolumeEncryptionEnabled', WORKSPACES_ROLE],
  ['AWS::WorkSpaces::Workspace#UserVolumeEncryptionEnabled', WORKSPACES_ROLE],
  ['AWS::WorkSpaces::Workspace#VolumeEncryptionKey', WORKSPACES_ROLE],
  // CloudFormation A/B: UPDATE_COMPLETE under the same datastore id, reading
  // back the new name, then SMART_ON_FHIR_V1.
  ['AWS::HealthLake::FHIRDatastore#DatastoreName', update('cfn-measured', 7083)],
  ['AWS::HealthLake::FHIRDatastore#IdentityProviderConfiguration', update('cfn-measured', 7083)],
  // CloudFormation A/B: UPDATE_COMPLETE under the same image ARN / app id.
  ['AWS::ImageBuilder::Image#Tags', update('cfn-measured', 7083)],
  ['AWS::SageMaker::App#Tags', update('cfn-measured', 7083)],
  // CloudFormation A/B, as for the other container members: UPDATE_COMPLETE
  // under the same ARN (Framework XGBOOST -> PYTORCH; ImageDigest with its
  // Image tag, 1.7-1 -> 1.5-1).
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.Framework',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.ImageDigest',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.Framework',
    update('cfn-measured', 7083),
  ],
  [
    'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.ImageDigest',
    update('cfn-measured', 7083),
  ],
  ['AWS::AppStream::StackFleetAssociation#FleetName', APPSTREAM_ROLE],
  ['AWS::AppStream::StackFleetAssociation#StackName', APPSTREAM_ROLE],
  // --- updateableProperties beyond the fixture or the spec
  ['AWS::Budgets::Budget#NotificationsWithSubscribers', update('deviation', 7038)],
  ['AWS::EC2::Subnet#Ipv6CidrBlock', update('cfn-measured', 5632)],
  ['AWS::EC2::Instance#EbsOptimized', update('cfn-measured', 7023)],
]);
