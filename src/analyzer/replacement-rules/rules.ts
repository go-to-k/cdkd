import type { ReplacementRulesRegistry } from '../replacement-rules.js';
import type { ConditionalReplacement } from './types.js';
import {
  vpcInstanceTenancyChangeReplaces,
  instanceSecurityGroupIdsChangeReplaces,
  instanceTenancyChangeReplaces,
  instancePrivateDnsNameOptionsChangeReplaces,
  instanceBlockDeviceMappingsChangeReplaces,
  durableConfigPresenceToggled,
  eventInvokeConfigFunctionChanged,
  attributeTypeChangedForSharedAttribute,
  globalTableLocalSecondaryIndexesRemoved,
  budgetNameChanged,
  iamRolePathChanged,
  glueTableNameChanged,
  natZoneAddressesAddedToAutomaticGateway,
  ecsServiceLaunchTypeSetOrChanged,
  elastiCacheAzModeRemovedFromSingleAz,
  emrClusterInstancesReplaced,
  dbClusterEngineChangeReplaces,
  dbInstanceEngineChangeReplaces,
  elastiCachePreferredAvailabilityZonesReplaced,
} from './predicates.js';

/**
 * Initialize replacement rules for common AWS resource types
 */
export function initializeRules(this: ReplacementRulesRegistry): void {
  // S3 Bucket
  this.rules.set('AWS::S3::Bucket', {
    replacementProperties: new Set([
      'BucketName', // Changing bucket name requires replacement
      // Create-only in the CFn registry schema: S3 fixes a bucket's name and
      // namespace at CreateBucket (go-to-k/cdkd#2762).
      'BucketNamePrefix',
      'BucketNamespace',
    ]),
    updateableProperties: new Set([
      'AbacStatus',
      'MetadataConfiguration',
      'Tags',
      'VersioningConfiguration',
      'LifecycleConfiguration',
      'PublicAccessBlockConfiguration',
      'BucketEncryption',
      'LoggingConfiguration',
      'WebsiteConfiguration',
      'CorsConfiguration',
      'NotificationConfiguration',
    ]),
  });

  // Lambda Function
  this.rules.set('AWS::Lambda::Function', {
    replacementProperties: new Set([
      'FunctionName', // Changing function name requires replacement
      // Create-only in the CFn registry schema AND in the SDK: the member
      // exists on CreateFunctionRequest and NOT on
      // UpdateFunctionConfigurationRequest, so there is no in-place path
      // (issue #609).
      'TenancyConfig',
    ]),
    updateableProperties: new Set([
      'Code',
      'Handler',
      'Runtime',
      'Description',
      'Timeout',
      'MemorySize',
      'Role',
      'Environment',
      'Tags',
      'VpcConfig',
      'DeadLetterConfig',
      'TracingConfig',
      'Layers',
      'FileSystemConfigs',
      // Architectures is mutable in place (CFn "Update requires: No
      // interruption") — the provider re-sends the code with the new
      // instruction set via UpdateFunctionCode. Classified explicitly
      // (rather than relying on the DescribeType createOnly fallback) so
      // the intent is pinned and the classification is free of a network
      // round-trip.
      'Architectures',
      // Both are mutable in place, each via its own control-plane API
      // (PutFunctionCodeSigningConfig / DeleteFunctionCodeSigningConfig and
      // PutRuntimeManagementConfig) rather than
      // UpdateFunctionConfiguration — issue #609.
      'CodeSigningConfigArn',
      'RuntimeManagementConfig',
    ]),
    conditionalReplacements: new Map([['DurableConfig', durableConfigPresenceToggled]]),
  });

  // Lambda LayerVersion — fully immutable on AWS. There is no
  // UpdateLayerVersion API; every property change requires a fresh
  // PublishLayerVersion (a new version with a new LayerVersionArn). In
  // CloudFormation EVERY property of AWS::Lambda::LayerVersion is
  // "Update requires: Replacement", so a content/runtime/name change
  // must drive a replacement (and `promoteReplacementDependents` then
  // re-points any consuming function at the new version ARN), matching
  // `cdk deploy`'s transparent layer-version bump. Without this rule the
  // change is misclassified as an in-place update and the provider's
  // update() hard-fails with an "immutable" error (issue surfaced by a
  // LayerVersion content change being undeployable).
  this.rules.set('AWS::Lambda::LayerVersion', {
    replacementProperties: new Set([
      'Content',
      'LayerName',
      'Description',
      'CompatibleRuntimes',
      'CompatibleArchitectures',
      'LicenseInfo',
    ]),
  });

  // Lambda Version — a published version is a point-in-time snapshot, so
  // all five of its CREATE-ONLY properties (`FunctionName` / `Description` /
  // `CodeSha256` / `ProvisionedConcurrencyConfig` / `RuntimePolicy`) are
  // "Update requires: Replacement" in CloudFormation; a change to any of
  // them publishes a new version. (The registry schema also exposes one
  // in-place-mutable property, `FunctionScalingConfig` — deliberately left
  // OUT of this set so a change to it is NOT misclassified as a
  // replacement.) CDK normally bumps the Version's logical id on code change
  // (create-new + delete-old) so this rule rarely fires, but a hand-authored
  // template that edits a create-only Version property in place would
  // otherwise be misclassified as an updateable change.
  this.rules.set('AWS::Lambda::Version', {
    replacementProperties: new Set([
      'CodeSha256',
      'Description',
      'FunctionName',
      'ProvisionedConcurrencyConfig',
      'RuntimePolicy',
    ]),
  });

  // Lambda EventInvokeConfig — the async-invoke configuration is keyed by
  // (FunctionName, Qualifier), both CREATE-ONLY in CloudFormation ("Update
  // requires: Replacement"): a change to either targets a different
  // function/alias, so it must DELETE the old config + CREATE the new one
  // rather than an in-place Put (which would attach a config to the new
  // target while orphaning the old function's config). The remaining three
  // properties (`MaximumEventAgeInSeconds` / `MaximumRetryAttempts` /
  // `DestinationConfig`) are updated in place via PutFunctionEventInvokeConfig
  // (a full-replace write). Without this rule the registry defaults the type
  // to fully-updateable, which is correct for the three mutable props but
  // would silently in-place-update an immutable FunctionName/Qualifier change.
  // FunctionName replaces only when the function NAME changes: a re-spelling
  // (name <-> ARN) is the same function, and a replacement there would Put
  // the config and then delete it again (issue #4118).
  this.rules.set('AWS::Lambda::EventInvokeConfig', {
    replacementProperties: new Set(['Qualifier']),
    conditionalReplacements: new Map([['FunctionName', eventInvokeConfigFunctionChanged]]),
    updateableProperties: new Set([
      'MaximumEventAgeInSeconds',
      'MaximumRetryAttempts',
      'DestinationConfig',
    ]),
  });

  // DynamoDB GlobalTable (go-to-k/cdkd#5489). No property is listed outright:
  // the schema's `createOnlyProperties` fallback still covers `TableName`,
  // since it applies to every property this rule leaves unclassified. The
  // type is stateful, so the replacement still needs
  // `--force-stateful-recreation`.
  this.rules.set('AWS::DynamoDB::GlobalTable', {
    replacementProperties: new Set(),
    conditionalReplacements: new Map([
      ['LocalSecondaryIndexes', globalTableLocalSecondaryIndexesRemoved],
    ]),
  });

  // DynamoDB Table
  this.rules.set('AWS::DynamoDB::Table', {
    replacementProperties: new Set([
      'TableName', // Changing table name requires replacement
      'KeySchema', // Changing the table's primary key requires replacement
    ]),
    updateableProperties: new Set([
      'BillingMode',
      'ProvisionedThroughput',
      // Adding / removing a Global Secondary Index is an in-place UpdateTable
      // (one GSI per call, async) — NOT a replacement. The provider's update()
      // applies these via GlobalSecondaryIndexUpdates.
      'GlobalSecondaryIndexes',
      // NOT a replacement, matching CloudFormation (go-to-k/cdkd#5354): its
      // change set reports `RequiresRecreation: Never` for an LSI change and
      // the update then FAILS. So the diff routes it to the provider's
      // update(), which refuses it the same way, before any call.
      'LocalSecondaryIndexes',
      'StreamSpecification',
      'SSESpecification',
      'Tags',
      'TimeToLiveSpecification',
      'PointInTimeRecoverySpecification',
    ]),
    conditionalReplacements: new Map([
      // AttributeDefinitions is NOT a blanket replacement trigger. CloudFormation's
      // update behavior for it is "No interruption": adding an attribute (to back a
      // new GSI) or removing one (when a GSI is dropped) is an in-place update. The
      // ONLY case needing replacement is changing the TYPE of an attribute that
      // exists on both sides — DynamoDB rejects an in-place type change on an
      // attribute that participates in the table key or an index. A key attribute
      // NAME change instead surfaces as a KeySchema diff (handled above).
      ['AttributeDefinitions', attributeTypeChangedForSharedAttribute],
    ]),
  });

  // SQS Queue
  this.rules.set('AWS::SQS::Queue', {
    replacementProperties: new Set([
      'QueueName', // Changing queue name requires replacement
      'FifoQueue', // Changing FIFO attribute requires replacement
    ]),
    updateableProperties: new Set([
      'DelaySeconds',
      'MaximumMessageSize',
      'MessageRetentionPeriod',
      'ReceiveMessageWaitTimeSeconds',
      'VisibilityTimeout',
      'RedrivePolicy',
      'Tags',
      // FIFO-only, but mutable in place: CFn documents it as "Update
      // requires: No interruption" and the registry schema's
      // createOnlyProperties is only [FifoQueue, QueueName].
      // SetQueueAttributes flips it on a live FIFO queue (live-verified
      // 2026-07-27, issue #1237). Classifying it as replacement would
      // DELETE the queue (message loss) on a toggle, and made the
      // provider's #1160 removal reset unreachable via a plain deploy.
      'ContentBasedDeduplication',
    ]),
  });

  // IAM Role
  this.rules.set('AWS::IAM::Role', {
    replacementProperties: new Set([
      'RoleName', // Changing role name requires replacement
    ]),
    updateableProperties: new Set([
      'AssumeRolePolicyDocument',
      'Description',
      'ManagedPolicyArns',
      'MaxSessionDuration',
      'PermissionsBoundary',
      'Policies',
      'Tags',
    ]),
    conditionalReplacements: new Map([['Path', iamRolePathChanged]]),
  });

  // SNS Topic
  this.rules.set('AWS::SNS::Topic', {
    replacementProperties: new Set([
      'TopicName', // Changing topic name requires replacement
    ]),
    updateableProperties: new Set(['DisplayName', 'Subscription', 'KmsMasterKeyId', 'Tags']),
  });

  // CodeCommit Repository
  this.rules.set('AWS::CodeCommit::Repository', {
    replacementProperties: new Set([]),
    updateableProperties: new Set([
      // CFn docs: every property is "Update requires: No interruption" and
      // the registry schema's createOnlyProperties is EMPTY — including
      // RepositoryName (CFn renames in place via UpdateRepositoryName;
      // classifying a rename as replacement would DELETE the repository
      // and its entire git history). Docs-verified 2026-07-17 (issue #1045).
      'RepositoryName',
      'RepositoryDescription',
      'KmsKeyId',
      'Tags',
    ]),
  });

  // ECR Repository
  this.rules.set('AWS::ECR::Repository', {
    replacementProperties: new Set([
      'RepositoryName', // Changing repository name requires replacement
    ]),
    updateableProperties: new Set([
      'ImageScanningConfiguration',
      'ImageTagMutability',
      'LifecyclePolicy',
      'RepositoryPolicyText',
      'Tags',
    ]),
  });

  // CloudWatch Log Group
  this.rules.set('AWS::Logs::LogGroup', {
    replacementProperties: new Set([
      'LogGroupName', // Changing log group name requires replacement
    ]),
    updateableProperties: new Set(['RetentionInDays', 'KmsKeyId']),
  });

  // Kinesis Stream — Name is immutable (CFn "Update requires: Replacement").
  // Without this rule the registry defaulted the type to updateable, so a
  // stream rename was attempted as an in-place update: AWS has no rename API,
  // so the change was silently dropped and cdkd's state diverged (state recorded
  // the new name while the stream kept the old one). All other Kinesis stream
  // properties are in-place updatable.
  this.rules.set('AWS::Kinesis::Stream', {
    replacementProperties: new Set([
      'Name', // Renaming a stream requires replacement
    ]),
    updateableProperties: new Set([
      'RetentionPeriodHours',
      'ShardCount',
      'StreamModeDetails',
      'StreamEncryption',
      'Tags',
    ]),
  });

  // SecretsManager Secret — Name is immutable (CFn "Update requires:
  // Replacement"). Same silent-divergence class as Kinesis::Stream above: a
  // rename was attempted in-place (no AWS rename API) and dropped. The secret
  // value / description / replica / KMS key are all in-place updatable.
  this.rules.set('AWS::SecretsManager::Secret', {
    replacementProperties: new Set([
      'Name', // Renaming a secret requires replacement
    ]),
    updateableProperties: new Set([
      'Description',
      'KmsKeyId',
      'SecretString',
      'GenerateSecretString',
      'ReplicaRegions',
      'Tags',
    ]),
  });

  // Step Functions State Machine — StateMachineName + StateMachineType are
  // immutable (CFn "Update requires: Replacement"). Same silent-divergence
  // class as Kinesis/Secret above: a rename was attempted as an in-place
  // UpdateStateMachine (which has no Name parameter) and dropped. The
  // definition / role / logging / tracing are all in-place updatable.
  this.rules.set('AWS::StepFunctions::StateMachine', {
    replacementProperties: new Set([
      'StateMachineName', // Renaming requires replacement
      'StateMachineType', // STANDARD <-> EXPRESS requires replacement
    ]),
    updateableProperties: new Set([
      'DefinitionString',
      'DefinitionS3Location',
      'Definition',
      'DefinitionSubstitutions',
      'RoleArn',
      'LoggingConfiguration',
      'TracingConfiguration',
      'Tags',
      'EncryptionConfiguration',
    ]),
  });

  // EventBridge Rule — Name + EventBusName are immutable (CFn "Update
  // requires: Replacement"). A rename was attempted as an in-place PutRule
  // with the NEW name, which CREATES a second rule and orphans the old one.
  // Schedule / pattern / targets / state are in-place updatable.
  this.rules.set('AWS::Events::Rule', {
    replacementProperties: new Set([
      'Name', // Renaming requires replacement
      'EventBusName', // Moving to a different bus requires replacement
    ]),
    updateableProperties: new Set([
      'ScheduleExpression',
      'EventPattern',
      'State',
      'Description',
      'Targets',
      'RoleArn',
    ]),
  });

  // SSM Parameter — Name is immutable (CFn "Update requires: Replacement").
  // A rename was attempted in-place and the new-named parameter was never
  // created (or the old one left untouched), diverging state from AWS.
  this.rules.set('AWS::SSM::Parameter', {
    replacementProperties: new Set([
      'Name', // Renaming requires replacement
    ]),
    updateableProperties: new Set([
      'Value',
      'Description',
      'Type',
      'Tier',
      'AllowedPattern',
      'Policies',
      'DataType',
      'Tags',
    ]),
  });

  // Budgets Budget — the budget NAME is the physical id and is createOnly
  // (a rename must be delete + recreate: UpdateBudget addresses the budget
  // BY name, so an in-place rename would silently create nothing and
  // diverge state from AWS). The name lives NESTED at Budget.BudgetName, so
  // a conditional rule inspects the top-level `Budget` value: only a
  // BudgetName change forces replacement — limit / period / type edits are
  // in-place `UpdateBudget` calls. NotificationsWithSubscribers is
  // createOnly for CloudFormation, but cdkd's provider reconciles it
  // in place (CreateNotification / DeleteNotification / CreateSubscriber /
  // DeleteSubscriber), hence updateable here.
  this.rules.set('AWS::Budgets::Budget', {
    replacementProperties: new Set<string>(),
    updateableProperties: new Set(['NotificationsWithSubscribers', 'ResourceTags']),
    conditionalReplacements: new Map([['Budget', budgetNameChanged]]),
  });

  // Glue Table — the name is NESTED at `TableInput.Name` and the registry
  // schema's createOnly `Name` is the top-level one CDK does not emit, so a
  // rename needs this conditional rule to replace (issue #3750, measured
  // against CloudFormation). Only `TableInput` is classified here; the
  // schema fallback still decides `CatalogId` / `DatabaseName` / `Name`.
  // `AWS::Glue::Connection` needs no entry: its schema lists the nested
  // `ConnectionInput/Name` createOnly path, which the fallback compares at
  // path granularity. `AWS::Glue::Database` deliberately has none either:
  // CloudFormation does NOT replace on `DatabaseInput.Name` (the update
  // fails), so cdkd's provider refuses it instead.
  this.rules.set('AWS::Glue::Table', {
    replacementProperties: new Set<string>(),
    conditionalReplacements: new Map([['TableInput', glueTableNameChanged]]),
  });

  // CloudWatch Alarm — AlarmName is immutable (CFn "Update requires:
  // Replacement"). A rename was attempted as an in-place PutMetricAlarm with
  // the NEW name, which CREATES a second alarm and orphans the old one.
  // Everything else about an alarm is in-place updatable.
  this.rules.set('AWS::CloudWatch::Alarm', {
    replacementProperties: new Set([
      'AlarmName', // Renaming requires replacement
    ]),
    updateableProperties: new Set([
      'ComparisonOperator',
      'EvaluationPeriods',
      'DatapointsToAlarm',
      'Threshold',
      'TreatMissingData',
      'MetricName',
      'Namespace',
      'Period',
      'Statistic',
      'ExtendedStatistic',
      'Dimensions',
      'Metrics',
      'AlarmDescription',
      'ActionsEnabled',
      'AlarmActions',
      'OKActions',
      'InsufficientDataActions',
      'Unit',
      'EvaluateLowSampleCountPercentile',
      'ThresholdMetricId',
      'Tags',
    ]),
  });

  // API Gateway RestApi
  this.rules.set('AWS::ApiGateway::RestApi', {
    replacementProperties: new Set([
      'Name', // Changing API name can require replacement in some cases
    ]),
    updateableProperties: new Set([
      'Description',
      'Policy',
      'EndpointConfiguration',
      'BinaryMediaTypes',
      'MinimumCompressionSize',
      'Tags',
    ]),
  });

  // AppSync GraphQLApi — `ApiType` and `Visibility` are fixed at creation
  // (AWS documents both as "cannot be changed once the API has been
  // created", and `UpdateGraphqlApi` has no member for either). The
  // create-only FALLBACK in `create-only-properties.ts` cannot cover this:
  // the registry schema for this type ships an EMPTY `createOnlyProperties`
  // list, so an unclassified change would be routed to an in-place UPDATE
  // that silently drops the new value. `Name` is deliberately left
  // unclassified: it renames the API in place via `UpdateGraphqlApi`,
  // keeping the API id, as CloudFormation does (go-to-k/cdkd#5359).
  this.rules.set('AWS::AppSync::GraphQLApi', {
    replacementProperties: new Set(['ApiType', 'Visibility']),
    updateableProperties: new Set([
      'AuthenticationType',
      'LogConfig',
      'XrayEnabled',
      'Tags',
      'UserPoolConfig',
      'OpenIDConnectConfig',
      'LambdaAuthorizerConfig',
      'AdditionalAuthenticationProviders',
      'EnhancedMetricsConfig',
      'EnvironmentVariables',
      'IntrospectionConfig',
      'QueryDepthLimit',
      'ResolverCountLimit',
      'OwnerContact',
      'MergedApiExecutionRoleArn',
    ]),
  });

  // RDS DBProxy — EngineFamily + VpcSubnetIds + DBProxyName +
  // EndpointNetworkType + TargetConnectionNetworkType are immutable on AWS.
  // ModifyDBProxy only accepts Auth / DefaultAuthScheme / RequireTLS /
  // IdleClientTimeout / DebugLogging / RoleArn / SecurityGroups (+
  // NewDBProxyName rename, which cdkd does not implement). A diff in any other
  // field needs replacement.
  this.rules.set('AWS::RDS::DBProxy', {
    // EndpointNetworkType / TargetConnectionNetworkType are create-only in the
    // CFn schema and ModifyDBProxy has no such member; named here, not left to
    // the create-only fallback, so the replacement does not hinge on a
    // DescribeType answer (go-to-k/cdkd#2762).
    replacementProperties: new Set([
      'DBProxyName',
      'EngineFamily',
      'VpcSubnetIds',
      'EndpointNetworkType',
      'TargetConnectionNetworkType',
    ]),
  });

  // RDS DBProxyEndpoint — DBProxyName + DBProxyEndpointName + VpcSubnetIds +
  // TargetRole + EndpointNetworkType are immutable. ModifyDBProxyEndpoint only
  // accepts VpcSecurityGroupIds (+ rename, not implemented). EndpointNetworkType
  // is named here, not left to the create-only fallback, so the replacement
  // does not hinge on a DescribeType answer (go-to-k/cdkd#2762).
  this.rules.set('AWS::RDS::DBProxyEndpoint', {
    replacementProperties: new Set([
      'DBProxyName',
      'DBProxyEndpointName',
      'VpcSubnetIds',
      'TargetRole',
      'EndpointNetworkType',
    ]),
  });

  // S3 Tables Table — the registry schema's createOnly list (TableName and
  // Namespace are renamed in place). Named here so a change to IcebergMetadata /
  // StorageClassConfiguration / WithoutMetadata (sent only on CreateTable)
  // still replaces when DescribeType cannot answer (go-to-k/cdkd#2762).
  this.rules.set('AWS::S3Tables::Table', {
    replacementProperties: new Set([
      'TableBucketARN',
      'OpenTableFormat',
      'IcebergMetadata',
      'StorageClassConfiguration',
      'WithoutMetadata',
    ]),
  });

  // RDS DBProxyTargetGroup — DBProxyName + TargetGroupName are identity
  // fields. AWS rejects modifications to them; only ConnectionPoolConfig +
  // registered targets (Cluster/Instance Identifiers) are mutable.
  this.rules.set('AWS::RDS::DBProxyTargetGroup', {
    replacementProperties: new Set(['DBProxyName', 'TargetGroupName']),
  });

  // EC2 VPC (issue #5449) — InstanceTenancy is not createOnly in the registry
  // schema, but only a change TO `default` is in place; see the predicate.
  // The registry schema's createOnly list is named here too, so the
  // classification survives a DescribeType failure (as for the Subnet).
  this.rules.set('AWS::EC2::VPC', {
    replacementProperties: new Set([
      'CidrBlock',
      'Ipv4IpamPoolId',
      'Ipv4NetmaskLength',
      'VpcEncryptionControl',
    ]),
    conditionalReplacements: new Map([['InstanceTenancy', vpcInstanceTenancyChangeReplaces]]),
  });

  // RDS DBCluster / DBInstance `Engine` (issue #5467): not createOnly in the
  // CFn schema, but CloudFormation replaces a change its handlers call
  // immutable (measured, and transcribed from the handlers; see the
  // predicates). Every other property keeps the schema createOnly fallback,
  // since these rules name only `Engine`. Both types are stateful, so the
  // replacement still needs `--force-stateful-recreation`.
  this.rules.set('AWS::RDS::DBCluster', {
    replacementProperties: new Set(),
    conditionalReplacements: new Map<string, ConditionalReplacement>([
      ['Engine', dbClusterEngineChangeReplaces],
    ]),
  });
  this.rules.set('AWS::RDS::DBInstance', {
    replacementProperties: new Set(),
    conditionalReplacements: new Map<string, ConditionalReplacement>([
      ['Engine', dbInstanceEngineChangeReplaces],
    ]),
  });

  // EC2 Subnet — VpcId / CidrBlock / AvailabilityZone are createOnly per
  // the CFn registry schema (the DescribeType fallback already classifies
  // them); named here so the classification survives a DescribeType
  // failure. MapPublicIpOnLaunch and EnableDns64 use ModifySubnetAttribute;
  // Ipv6CidrBlock uses disassociate/associate, and Tags use CreateTags/DeleteTags.
  // These are wired through EC2Provider.updateSubnet; declaring them
  // updateable pins that routing against future createOnly-fallback drift.
  // go-to-k/cdkd#5632: the zone id, IPAM inputs and Ipv6Native are
  // create-only in the registry schema; named here so a DescribeType
  // failure keeps them so. A `"true"` / `true` spelling of Ipv6Native is
  // folded by canonicalizeDesiredProperties before any comparison.
  this.rules.set('AWS::EC2::Subnet', {
    replacementProperties: new Set([
      'VpcId',
      'CidrBlock',
      'AvailabilityZone',
      'AvailabilityZoneId',
      'Ipv4IpamPoolId',
      'Ipv4NetmaskLength',
      'Ipv6IpamPoolId',
      'Ipv6NetmaskLength',
      'Ipv6Native',
    ]),
    updateableProperties: new Set(['MapPublicIpOnLaunch', 'EnableDns64', 'Ipv6CidrBlock', 'Tags']),
  });

  // EC2 Instance — EbsOptimized can only be changed on a STOPPED instance
  // (a running instance returns IncorrectInstanceState). `updateInstance`
  // stops an instance only for an InstanceType / UserData change (issue
  // #5446, measured) or a PrivateDnsNameOptions.HostnameType change
  // (go-to-k/cdkd#5630, measured), and an EbsOptimized change was not measured against
  // CloudFormation, so it stays routed to replacement
  // (the create path sets it on the new instance). The other four #609
  // security-backfill props (DisableApiTermination / Monitoring /
  // MetadataOptions / CreditSpecification) ARE mutable in-place on a running
  // instance and are handled by EC2Provider.updateInstanceSecurityProps.
  //
  // AvailabilityZone / ImageId / SubnetId / KeyName are immutable: the CFn
  // registry schema lists all four under `createOnlyProperties`, so the
  // `create-only-properties.ts` DescribeType fallback already classifies
  // them as replacements. They are ALSO named here so the classification
  // survives a DescribeType failure (missing `cloudformation:DescribeType`
  // permission, or a throttle that outlasts the retry) — the fallback
  // degrades to an empty create-only list, and without a hand rule the
  // change would be classified in-place, where `updateInstance` silently
  // ignores it: state records the new value while AWS keeps the old one.
  this.rules.set('AWS::EC2::Instance', {
    replacementProperties: new Set([
      'EbsOptimized',
      'AvailabilityZone',
      'ImageId',
      'SubnetId',
      'KeyName',
      // Issue #1281: createOnly per the CFn schema, and updateInstance has
      // no ENI-modification path -- an in-place classification would leave
      // state recording the new value while AWS keeps the old one.
      'NetworkInterfaces',
      // go-to-k/cdkd#5630: createOnly per the CFn schema, listed here too so
      // a failed DescribeType still classifies them.
      'CpuOptions',
      'HibernationOptions',
      'PlacementGroupName',
      'PrivateIpAddress',
      'Ipv6AddressCount',
      'Ipv6Addresses',
    ]),
    // Issue #5446: InstanceType / UserData (a stop-modify-start),
    // IamInstanceProfile and, with a SubnetId, SecurityGroupIds update in
    // place in `updateInstance`; see the two predicates for what replaces.
    conditionalReplacements: new Map<string, ConditionalReplacement>([
      ['SecurityGroupIds', instanceSecurityGroupIdsChangeReplaces],
      ['BlockDeviceMappings', instanceBlockDeviceMappingsChangeReplaces],
      // go-to-k/cdkd#5630: the schema leaves Tenancy mutable; see the
      // predicate for which changes replace.
      ['Tenancy', instanceTenancyChangeReplaces],
      // go-to-k/cdkd#5630: only a removal of the whole block replaces.
      ['PrivateDnsNameOptions', instancePrivateDnsNameOptionsChangeReplaces],
    ]),
  });

  // EC2 NatGateway (go-to-k/cdkd#2762) — the registry schema leaves
  // `AvailabilityZoneAddresses` mutable, and on a gateway created with it
  // CloudFormation associates / releases zone addresses in place. ADDING it
  // to a regional gateway created without it (automatic zone expansion)
  // makes CloudFormation create a new gateway instead (real CloudFormation
  // A/B on #2762): no API switches a gateway out of automatic mode.
  // Removing it is left in place, where `EC2Provider` refuses it as
  // CloudFormation fails it.
  this.rules.set('AWS::EC2::NatGateway', {
    replacementProperties: new Set(),
    conditionalReplacements: new Map([
      ['AvailabilityZoneAddresses', natZoneAddressesAddedToAutomaticGateway],
    ]),
  });

  // EC2 Volume — the CFn registry schema for this type declares NO
  // `createOnlyProperties` at all (live-verified 2026-08-03 via
  // `describe-type --type-name AWS::EC2::Volume`, which returns
  // `createOnlyProperties: null`), so the `create-only-properties.ts`
  // DescribeType fallback has nothing to classify and every change looked
  // in-place-updatable. An immutable-property change therefore reached the
  // update handler and AWS rejected the deploy with "Volume properties
  // other than AutoEnableIO, type, size, and IOPS cannot be updated" —
  // where CloudFormation REPLACES the volume for the same edit (issue
  // #1356). The six properties below are the ones CFn documents as
  // "Update requires: Replacement"; they are identity / encryption /
  // seed-data fields no `ModifyVolume` call can change.
  //
  // Deliberately conservative: the remaining schema properties
  // (`MultiAttachEnabled`, `SourceVolumeId`, `VolumeInitializationRate`)
  // are left UNCLASSIFIED rather than guessed at. Misclassifying a mutable
  // property as a replacement would DELETE a data-bearing volume, whereas
  // leaving one unclassified keeps today's graceful degradation (attempt
  // the update, surface AWS's error) and still lets the schema fallback
  // pick it up if AWS ever populates `createOnlyProperties`.
  //
  // A volume replacement is real data loss, so `AWS::EC2::Volume` is also
  // in `STATEFUL_TYPES` — the deploy engine's property-driven replacement
  // path requires `--force-stateful-recreation` to confirm it.
  this.rules.set('AWS::EC2::Volume', {
    replacementProperties: new Set([
      'AvailabilityZone',
      'AvailabilityZoneId',
      'Encrypted',
      'KmsKeyId',
      'OutpostArn',
      'SnapshotId',
    ]),
    updateableProperties: new Set([
      // ModifyVolume's mutable set (the AWS rejection message names four of
      // these five: AutoEnableIO / type / size / IOPS) plus tags via
      // CreateTags / DeleteTags. Pinning them here permanently bypasses the
      // schema fallback for these names — acceptable because AWS documents
      // every one as "Update requires: No interruption", and the opposite
      // error (a mutable property classified as a replacement) destroys data.
      'AutoEnableIO',
      'Iops',
      'Size',
      'Throughput',
      'VolumeType',
      'Tags',
    ]),
  });

  // ECS Task Definition
  this.rules.set('AWS::ECS::TaskDefinition', {
    replacementProperties: new Set([
      // Task definitions are immutable - any change requires replacement
      'Family',
      'ContainerDefinitions',
      'Cpu',
      'Memory',
      'NetworkMode',
      'RequiresCompatibilities',
      'ExecutionRoleArn',
      'TaskRoleArn',
      'Volumes',
    ]),
  });

  // ECS Service — `LaunchType` replaces when set or changed, and stays in
  // place when removed (issue #5392; see the predicate). Every other
  // property stays with the schema fallback.
  this.rules.set('AWS::ECS::Service', {
    replacementProperties: new Set(),
    conditionalReplacements: new Map([['LaunchType', ecsServiceLaunchTypeSetOrChanged]]),
  });

  // ElastiCache CacheCluster — a `PreferredAvailabilityZones` move to zones
  // the previous list does not name replaces the cluster (issue #5458), and
  // so does removing `AZMode` or `PreferredAvailabilityZones` from a
  // `single-az` cluster left with no zone list (issue #5558; see the
  // predicates). Every other
  // property stays with the schema fallback.
  this.rules.set('AWS::ElastiCache::CacheCluster', {
    replacementProperties: new Set(),
    conditionalReplacements: new Map<string, ConditionalReplacement>([
      ['AZMode', elastiCacheAzModeRemovedFromSingleAz],
      ['PreferredAvailabilityZones', elastiCachePreferredAvailabilityZonesReplaced],
    ]),
  });

  // EMR Cluster — an `Instances` change replaces unless only members
  // CloudFormation updates in place moved (issue #5418; see the predicate).
  // Every other property stays with the schema fallback.
  this.rules.set('AWS::EMR::Cluster', {
    replacementProperties: new Set(),
    conditionalReplacements: new Map([['Instances', emrClusterInstancesReplaced]]),
  });

  // ELBv2 ListenerRule — `ListenerArn` is create-only (and write-only). The
  // schema fallback replaces on it as a plain reference (go-to-k/cdkd#4701),
  // but the committed create-only snapshot has no ListenerRule, so with
  // `DescribeType` denied only this entry does. When the listener is replaced (a
  // `--recreate-via-*` target, or a `LoadBalancerArn` change), AWS deletes
  // its rules with the old one, so the rule must be re-created on the new
  // listener — an in-place update of the deleted rule fails `NotFound`
  // (go-to-k/cdkd#4689). Only `ListenerArn` is named: the other properties
  // stay with the schema fallback.
  this.rules.set('AWS::ElasticLoadBalancingV2::ListenerRule', {
    replacementProperties: new Set(['ListenerArn']),
  });

  // Add more resource types as needed
  this.logger.debug(`Initialized replacement rules for ${this.rules.size} resource types`);
}
