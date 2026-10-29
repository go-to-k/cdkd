/**
 * Where a varied CFn leaf may land under ANOTHER member or parent (#3723).
 *
 * Each vary probe in `sdk-wire-harness.ts` diffs the two runs' command inputs
 * and requires the varied leaf to land in a member of its own name (compared
 * case- and punctuation-blind, wrappers such as `Items` / `member` / `Value`
 * skipped), with every CFn ancestor right above the level below it, or as the
 * map entry it keys. This stands in for `gen-nested-key-coverage.ts`'s write
 * pass: a provider writing a value into a SIBLING member changes the wire
 * exactly as the right mapping does, so wire comparison alone cannot see it.
 *
 * Per type, keyed by bag path (member names joined by `.`, list indices
 * dropped):
 *
 * - `members`: the leaf's SDK member has another name (`TopicName` is `Name`),
 *   dotted when the SDK nests it (`Expiration.Days`).
 * - `containers`: the children of that CFn parent sit under another SDK
 *   member (an update's `ExtendedS3DestinationUpdate`, a patch operation's
 *   `patchOperations`, a dotted extra level such as
 *   `Destination.S3BucketDestination`). Keyed `<leaf path>@<parent path>`,
 *   `[FLATTENED]` says the SDK input has no member for that parent on that
 *   leaf's way, so that one level is skipped for that one leaf.
 * - `transformed`: the value is not sent as-is (fetched from S3, generated,
 *   re-keyed), so no member can be traced; the reason says what happens.
 *
 * Shrink-only in spirit: every entry must still be needed (the per-type
 * `uses every accepted rename` case fails on one that no probe needed), and a
 * new entry is a claim that the provider's mapping is RIGHT.
 */
/** `containers` value: the SDK input has no member for that CFn parent. */
export const FLATTENED = '(flattened)';

export interface TypeRenames {
  /** Bag path (indices dropped) -> the SDK members its value may land in. */
  members?: Record<string, readonly string[]>;
  /**
   * Bag path of a parent -> the SDK members its children may sit under
   * (dotted for an extra SDK level). `<leaf path>@<parent path>` ->
   * `[FLATTENED]` lets that one leaf skip that parent: scoped to the leaf, as
   * a parent-wide skip would let every child skip it.
   */
  containers?: Record<string, readonly string[]>;
  /** Bag path -> why its value is not sent as-is, so no member can be traced. */
  transformed?: Record<string, string>;
}

export const MEMBER_RENAMES: Record<string, TypeRenames> = {
  'AWS::ApiGateway::Method': {
    members: {
      // A model map's media-type key is a JSON-pointer segment in the patch path.
      'RequestModels.application/json': ['application~1json'],
      'RequestModels.text/plain': ['text~1plain'],
    },
    containers: {
      'Integration.CacheKeyParameters@Integration': [FLATTENED],
      'Integration.CacheNamespace@Integration': [FLATTENED],
      'Integration.ConnectionId@Integration': [FLATTENED],
      'Integration.ConnectionType@Integration': [FLATTENED],
      'Integration.ContentHandling@Integration': [FLATTENED],
      'Integration.Credentials@Integration': [FLATTENED],
      'Integration.IntegrationHttpMethod@Integration': [FLATTENED],
      'Integration.IntegrationResponses.ContentHandling@Integration': [FLATTENED],
      'Integration.IntegrationResponses.ContentHandling@Integration.IntegrationResponses': [FLATTENED],
      'Integration.IntegrationResponses.ResponseParameters.method.response.header.X@Integration': [FLATTENED],
      'Integration.IntegrationResponses.ResponseParameters.method.response.header.X@Integration.IntegrationResponses': [FLATTENED],
      'Integration.IntegrationResponses.ResponseParameters.method.response.header.Y@Integration': [FLATTENED],
      'Integration.IntegrationResponses.ResponseParameters.method.response.header.Y@Integration.IntegrationResponses': [FLATTENED],
      'Integration.IntegrationResponses.ResponseTemplates.application/json@Integration': [FLATTENED],
      'Integration.IntegrationResponses.ResponseTemplates.application/json@Integration.IntegrationResponses': [FLATTENED],
      'Integration.IntegrationResponses.SelectionPattern@Integration': [FLATTENED],
      'Integration.IntegrationResponses.SelectionPattern@Integration.IntegrationResponses': [FLATTENED],
      'Integration.IntegrationResponses.StatusCode@Integration': [FLATTENED],
      'Integration.IntegrationResponses.StatusCode@Integration.IntegrationResponses': [FLATTENED],
      'Integration.IntegrationTarget@Integration': [FLATTENED],
      'Integration.PassthroughBehavior@Integration': [FLATTENED],
      'Integration.RequestParameters.integration.request.header.x@Integration': [FLATTENED],
      'Integration.RequestParameters.integration.request.header.y@Integration': [FLATTENED],
      'Integration.RequestTemplates.application/json@Integration': [FLATTENED],
      'Integration.RequestTemplates.text/plain@Integration': [FLATTENED],
      'Integration.ResponseTransferMode@Integration': [FLATTENED],
      'Integration.TimeoutInMillis@Integration': [FLATTENED],
      'Integration.Type@Integration': [FLATTENED],
      'Integration.Uri@Integration': [FLATTENED],
      'MethodResponses.ResponseModels.application/json@MethodResponses': [FLATTENED],
      'MethodResponses.ResponseParameters.method.response.header.X@MethodResponses': [FLATTENED],
      'MethodResponses.ResponseParameters.method.response.header.Y@MethodResponses': [FLATTENED],
      'MethodResponses.StatusCode@MethodResponses': [FLATTENED],
      RequestModels: ['patchOperations'],
      RequestParameters: ['patchOperations'],
    },
  },
  'AWS::ApiGateway::Stage': {
    members: {
      // A method setting is a patch operation: `/{resource}/{method}/caching/...`.
      'MethodSettings.CacheDataEncrypted': ['caching/dataEncrypted'],
      'MethodSettings.CacheTtlInSeconds': ['caching/ttlInSeconds'],
      'MethodSettings.DataTraceEnabled': ['logging/dataTrace'],
      'MethodSettings.HttpMethod': ['path'],
      'MethodSettings.LoggingLevel': ['logging/loglevel'],
      'MethodSettings.ResourcePath': ['path'],
    },
    containers: {
      AccessLogSetting: ['patchOperations'],
      CanarySetting: ['canarySettings', 'patchOperations'],
      'CanarySetting.StageVariableOverrides': ['patchOperations'],
      'CanarySetting.StageVariableOverrides.O1@CanarySetting': [FLATTENED],
      'CanarySetting.StageVariableOverrides.O2@CanarySetting': [FLATTENED],
      MethodSettings: ['patchOperations'],
      Variables: ['patchOperations'],
    },
  },
  'AWS::ApiGatewayV2::Integration': {
    transformed: {
      'ResponseParameters.200.ResponseParameters.Destination':
        'each mapping becomes one map entry, keyed by its Destination and valued by its Source',
      'ResponseParameters.200.ResponseParameters.Source':
        'each mapping becomes one map entry, keyed by its Destination and valued by its Source',
      'ResponseParameters.404.ResponseParameters.Destination':
        'each mapping becomes one map entry, keyed by its Destination and valued by its Source',
      'ResponseParameters.404.ResponseParameters.Source':
        'each mapping becomes one map entry, keyed by its Destination and valued by its Source',
    },
  },
  'AWS::AppSync::GraphQLSchema': {
    transformed: {
      DefinitionS3Location:
        'the S3 object is fetched and its content sent as `definition`',
    },
  },
  'AWS::AppSync::Resolver': {
    transformed: {
      CodeS3Location:
        'the S3 object is fetched and its content sent',
      RequestMappingTemplateS3Location:
        'the S3 object is fetched and its content sent',
      ResponseMappingTemplateS3Location:
        'the S3 object is fetched and its content sent',
    },
  },
  'AWS::AutoScaling::AutoScalingGroup': {
    members: {
      Cooldown: ['DefaultCooldown'],
    },
    containers: {
      'LifecycleHookSpecificationList.DefaultResult@LifecycleHookSpecificationList': [FLATTENED],
      'LifecycleHookSpecificationList.HeartbeatTimeout@LifecycleHookSpecificationList': [FLATTENED],
      'LifecycleHookSpecificationList.LifecycleHookName@LifecycleHookSpecificationList': [FLATTENED],
      'LifecycleHookSpecificationList.LifecycleTransition@LifecycleHookSpecificationList': [FLATTENED],
      'LifecycleHookSpecificationList.NotificationMetadata@LifecycleHookSpecificationList': [FLATTENED],
      'LifecycleHookSpecificationList.NotificationTargetARN@LifecycleHookSpecificationList': [FLATTENED],
      'LifecycleHookSpecificationList.RoleARN@LifecycleHookSpecificationList': [FLATTENED],
      'MetricsCollection.Granularity@MetricsCollection': [FLATTENED],
      'MetricsCollection.Metrics@MetricsCollection': [FLATTENED],
      'NotificationConfigurations.NotificationTypes@NotificationConfigurations': [FLATTENED],
      'NotificationConfigurations.TopicARN@NotificationConfigurations': [FLATTENED],
    },
  },
  'AWS::BedrockAgentCore::Runtime': {
    members: {
      ProtocolConfiguration: ['serverProtocol'],
    },
  },
  'AWS::Budgets::Budget': {
    containers: {
      Budget: ['NewBudget'],
    },
  },
  'AWS::CertificateManager::Certificate': {
    members: {
      CertificateExport: ['Export'],
    },
    containers: {
      'DomainValidationOptions.HostedZoneId@DomainValidationOptions': [FLATTENED],
    },
  },
  'AWS::CloudFormation::Stack': {
    members: {
      'Parameters.Display': ['DisplayName'],
      'Parameters.TagValue': ['Value'],
    },
    containers: {
      Parameters: ['Attributes', 'Tags'],
      'Parameters.Display@Parameters': [FLATTENED],
    },
  },
  'AWS::CloudFront::Distribution': {
    members: {
      'DistributionConfig.CacheBehaviors.CachedMethods': ['AllowedMethods.CachedMethods'],
      'DistributionConfig.DefaultCacheBehavior.CachedMethods': ['AllowedMethods.CachedMethods'],
      'DistributionConfig.IPV6Enabled': ['IsIPV6Enabled'],
      'DistributionConfig.Restrictions.GeoRestriction.Locations': ['Items'],
    },
    containers: {
      'DistributionConfig.Origins.OriginCustomHeaders': ['CustomHeaders'],
    },
  },
  'AWS::CloudTrail::Trail': {
    members: {
      // StartLogging versus StopLogging: the command changes, carrying `Name`.
      IsLogging: ['Name'],
      TrailName: ['Name'],
    },
    containers: {
      Tags: ['TagsList'],
    },
  },
  'AWS::CodeBuild::Project': {
    members: {
      Visibility: ['projectVisibility'],
    },
  },
  'AWS::CodeCommit::Repository': {
    members: {
      RepositoryName: ['newName'],
    },
    containers: {
      'Code.BranchName@Code': [FLATTENED],
    },
    transformed: {
      'Code.S3.Bucket':
        'the S3 object is fetched and committed as file content',
      'Code.S3.Key':
        'the S3 object is fetched and committed as file content',
      'Code.S3.ObjectVersion':
        'the S3 object is fetched and committed as file content',
    },
  },
  'AWS::Cognito::UserPool': {
    members: {
      EmailAuthenticationMessage: ['Message'],
      EmailAuthenticationSubject: ['Subject'],
      UserPoolName: ['PoolName'],
      WebAuthnFactorConfiguration: ['FactorConfiguration'],
      WebAuthnRelyingPartyID: ['RelyingPartyId'],
      WebAuthnUserVerification: ['UserVerification'],
    },
    containers: {
      Schema: ['CustomAttributes'],
    },
    transformed: {
      EnabledMfas:
        'each enabled factor is sent as its own configuration block (EmailMfaConfiguration, SmsMfaConfiguration, SoftwareTokenMfaConfiguration)',
    },
  },
  'AWS::DynamoDB::GlobalTable': {
    members: {
      'Replicas.ContributorInsightsSpecification.Enabled': ['ContributorInsightsAction'],
      'Replicas.ContributorInsightsSpecification.Mode': ['ContributorInsightsMode'],
      'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification.Enabled': ['ContributorInsightsAction'],
      'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification.Mode': ['ContributorInsightsMode'],
      'Replicas.Region': ['RegionName'],
      // Table-level SSE also re-keys each replica (`KMSMasterKeyId`).
      'SSESpecification.SSEEnabled': ['Enabled', 'KMSMasterKeyId'],
    },
    containers: {
      GlobalSecondaryIndexes: ['Create'],
      'GlobalSecondaryIndexes.WarmThroughput.ReadUnitsPerSecond@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.WarmThroughput.WriteUnitsPerSecond@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.WriteOnDemandThroughputSettings': ['OnDemandThroughput'],
      'GlobalSecondaryIndexes.WriteOnDemandThroughputSettings.MaxWriteRequestUnits@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MaxCapacity@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MaxCapacity@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MaxCapacity@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MinCapacity@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MinCapacity@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MinCapacity@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings': [FLATTENED],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.ContributorInsightsSpecification.Enabled@Replicas': [FLATTENED],
      'Replicas.ContributorInsightsSpecification.Enabled@Replicas.ContributorInsightsSpecification': [FLATTENED],
      'Replicas.ContributorInsightsSpecification.Mode@Replicas': [FLATTENED],
      'Replicas.ContributorInsightsSpecification.Mode@Replicas.ContributorInsightsSpecification': [FLATTENED],
      'Replicas.DeletionProtectionEnabled@Replicas': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification.Enabled@Replicas': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification.Enabled@Replicas.GlobalSecondaryIndexes': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification.Enabled@Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification.Mode@Replicas': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification.Mode@Replicas.GlobalSecondaryIndexes': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification.Mode@Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadOnDemandThroughputSettings': ['OnDemandThroughput'],
      'Replicas.GlobalSecondaryIndexes.ReadOnDemandThroughputSettings.MaxReadRequestUnits@Replicas': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadOnDemandThroughputSettings.MaxReadRequestUnits@Replicas.GlobalSecondaryIndexes': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings': ['ProvisionedThroughputOverride'],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MaxCapacity@Replicas': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MaxCapacity@Replicas.GlobalSecondaryIndexes': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MaxCapacity@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MaxCapacity@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MinCapacity@Replicas': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MinCapacity@Replicas.GlobalSecondaryIndexes': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MinCapacity@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MinCapacity@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@Replicas': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@Replicas.GlobalSecondaryIndexes': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@Replicas': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@Replicas.GlobalSecondaryIndexes': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@Replicas': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@Replicas.GlobalSecondaryIndexes': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@Replicas': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@Replicas.GlobalSecondaryIndexes': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityUnits@Replicas': [FLATTENED],
      'Replicas.GlobalTableSettingsReplicationMode@Replicas': [FLATTENED],
      'Replicas.KinesisStreamSpecification': ['EnableKinesisStreamingConfiguration'],
      'Replicas.KinesisStreamSpecification.ApproximateCreationDateTimePrecision@Replicas': [FLATTENED],
      'Replicas.KinesisStreamSpecification.StreamArn@Replicas': [FLATTENED],
      'Replicas.KinesisStreamSpecification.StreamArn@Replicas.KinesisStreamSpecification': [FLATTENED],
      'Replicas.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled@Replicas': [FLATTENED],
      'Replicas.PointInTimeRecoverySpecification.RecoveryPeriodInDays@Replicas': [FLATTENED],
      'Replicas.ReadOnDemandThroughputSettings': ['OnDemandThroughput'],
      'Replicas.ReadOnDemandThroughputSettings.MaxReadRequestUnits@Replicas': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings': ['ProvisionedThroughputOverride'],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MaxCapacity@Replicas': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MaxCapacity@Replicas.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MaxCapacity@Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MinCapacity@Replicas': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MinCapacity@Replicas.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.MinCapacity@Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@Replicas': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@Replicas.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@Replicas': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@Replicas.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@Replicas': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@Replicas.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@Replicas': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@Replicas.ReadProvisionedThroughputSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': [FLATTENED],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityUnits@Replicas': [FLATTENED],
      'Replicas.Region@Replicas': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument': ['Policy'],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Action@Replicas': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Action@Replicas.ReplicaStreamSpecification': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Action@Replicas.ReplicaStreamSpecification.ResourcePolicy': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Effect@Replicas': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Effect@Replicas.ReplicaStreamSpecification': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Effect@Replicas.ReplicaStreamSpecification.ResourcePolicy': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Principal.AWS@Replicas': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Principal.AWS@Replicas.ReplicaStreamSpecification': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Principal.AWS@Replicas.ReplicaStreamSpecification.ResourcePolicy': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Resource@Replicas': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Resource@Replicas.ReplicaStreamSpecification': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Resource@Replicas.ReplicaStreamSpecification.ResourcePolicy': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Sid@Replicas': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Sid@Replicas.ReplicaStreamSpecification': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Statement.Sid@Replicas.ReplicaStreamSpecification.ResourcePolicy': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Version@Replicas': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Version@Replicas.ReplicaStreamSpecification': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument.Version@Replicas.ReplicaStreamSpecification.ResourcePolicy': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.Tags.Key@Replicas': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.Tags.Key@Replicas.ReplicaStreamSpecification': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.Tags.Value@Replicas': [FLATTENED],
      'Replicas.ReplicaStreamSpecification.Tags.Value@Replicas.ReplicaStreamSpecification': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument': ['Policy'],
      'Replicas.ResourcePolicy.PolicyDocument.Statement.Action@Replicas': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Statement.Action@Replicas.ResourcePolicy': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Statement.Effect@Replicas': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Statement.Effect@Replicas.ResourcePolicy': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Statement.Principal.AWS@Replicas': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Statement.Principal.AWS@Replicas.ResourcePolicy': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Statement.Resource@Replicas': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Statement.Resource@Replicas.ResourcePolicy': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Statement.Sid@Replicas': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Statement.Sid@Replicas.ResourcePolicy': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Version@Replicas': [FLATTENED],
      'Replicas.ResourcePolicy.PolicyDocument.Version@Replicas.ResourcePolicy': [FLATTENED],
      'Replicas.SSESpecification': ['Create', 'Update'],
      'Replicas.SSESpecification.KMSMasterKeyId@Replicas': [FLATTENED],
      'Replicas.TableClass@Replicas': [FLATTENED],
      'Replicas.Tags.Key@Replicas': [FLATTENED],
      'Replicas.Tags.Value@Replicas': [FLATTENED],
      SSESpecification: ['Update'],
      WriteOnDemandThroughputSettings: ['OnDemandThroughput'],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MaxCapacity@WriteProvisionedThroughputSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MaxCapacity@WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MinCapacity@WriteProvisionedThroughputSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.MinCapacity@WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@WriteProvisionedThroughputSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.DisableScaleIn@WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@WriteProvisionedThroughputSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleInCooldown@WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@WriteProvisionedThroughputSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.ScaleOutCooldown@WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@WriteProvisionedThroughputSettings': [FLATTENED],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings.TargetTrackingScalingPolicyConfiguration.TargetValue@WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': [FLATTENED],
    },
    transformed: {
      'Replicas.GlobalSecondaryIndexes.IndexName':
        'a replica override names its index: renaming it to an index the table lacks drops the override',
    },
  },
  'AWS::DynamoDB::Table': {
    members: {
      'ContributorInsightsSpecification.Enabled': ['ContributorInsightsAction'],
      'ContributorInsightsSpecification.Mode': ['ContributorInsightsMode'],
      'GlobalSecondaryIndexes.ContributorInsightsSpecification.Enabled': ['ContributorInsightsAction'],
      'GlobalSecondaryIndexes.ContributorInsightsSpecification.Mode': ['ContributorInsightsMode'],
      'SSESpecification.SSEEnabled': ['Enabled'],
    },
    containers: {
      'ContributorInsightsSpecification.Enabled@ContributorInsightsSpecification': [FLATTENED],
      'ContributorInsightsSpecification.Mode@ContributorInsightsSpecification': [FLATTENED],
      GlobalSecondaryIndexes: ['Create', 'Update'],
      'GlobalSecondaryIndexes.ContributorInsightsSpecification.Enabled@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.ContributorInsightsSpecification.Enabled@GlobalSecondaryIndexes.ContributorInsightsSpecification': [FLATTENED],
      'GlobalSecondaryIndexes.ContributorInsightsSpecification.Mode@GlobalSecondaryIndexes': [FLATTENED],
      'GlobalSecondaryIndexes.ContributorInsightsSpecification.Mode@GlobalSecondaryIndexes.ContributorInsightsSpecification': [FLATTENED],
      KinesisStreamSpecification: ['EnableKinesisStreamingConfiguration'],
      'KinesisStreamSpecification.StreamArn@KinesisStreamSpecification': [FLATTENED],
      'ResourcePolicy.PolicyDocument': ['Policy', 'ResourcePolicy'],
      'ResourcePolicy.PolicyDocument.Statement.Action@ResourcePolicy': [FLATTENED],
      'ResourcePolicy.PolicyDocument.Statement.Effect@ResourcePolicy': [FLATTENED],
      'ResourcePolicy.PolicyDocument.Statement.Principal.AWS@ResourcePolicy': [FLATTENED],
      'ResourcePolicy.PolicyDocument.Statement.Resource@ResourcePolicy': [FLATTENED],
      'ResourcePolicy.PolicyDocument.Statement.Sid@ResourcePolicy': [FLATTENED],
      'ResourcePolicy.PolicyDocument.Version@ResourcePolicy': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument': ['Policy'],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Statement.Action@StreamSpecification': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Statement.Action@StreamSpecification.ResourcePolicy': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Statement.Effect@StreamSpecification': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Statement.Effect@StreamSpecification.ResourcePolicy': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Statement.Principal.AWS@StreamSpecification': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Statement.Principal.AWS@StreamSpecification.ResourcePolicy': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Statement.Resource@StreamSpecification': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Statement.Resource@StreamSpecification.ResourcePolicy': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Statement.Sid@StreamSpecification': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Statement.Sid@StreamSpecification.ResourcePolicy': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Version@StreamSpecification': [FLATTENED],
      'StreamSpecification.ResourcePolicy.PolicyDocument.Version@StreamSpecification.ResourcePolicy': [FLATTENED],
      'StreamSpecification.Tags.Key@StreamSpecification': [FLATTENED],
      'StreamSpecification.Tags.Value@StreamSpecification': [FLATTENED],
    },
  },
  'AWS::EC2::Instance': {
    members: {
      IamInstanceProfile: ['Name'],
      // MonitorInstances versus UnmonitorInstances.
      Monitoring: ['Enabled', 'InstanceIds'],
      'NetworkInterfaces.GroupSet': ['Groups'],
      SecurityGroupIds: ['Groups'],
    },
    containers: {
      CreditSpecification: ['InstanceCreditSpecifications'],
      'MetadataOptions.HttpEndpoint@MetadataOptions': [FLATTENED],
      'MetadataOptions.HttpProtocolIpv6@MetadataOptions': [FLATTENED],
      'MetadataOptions.HttpPutResponseHopLimit@MetadataOptions': [FLATTENED],
      'MetadataOptions.HttpTokens@MetadataOptions': [FLATTENED],
      'MetadataOptions.InstanceMetadataTags@MetadataOptions': [FLATTENED],
    },
  },
  'AWS::EC2::NatGateway': {
    containers: {
      'AvailabilityZoneAddresses.AllocationIds@AvailabilityZoneAddresses': [FLATTENED],
      'AvailabilityZoneAddresses.AvailabilityZone@AvailabilityZoneAddresses': [FLATTENED],
      'AvailabilityZoneAddresses.AvailabilityZoneId@AvailabilityZoneAddresses': [FLATTENED],
    },
  },
  'AWS::EC2::NetworkAclEntry': {
    containers: {
      Icmp: ['IcmpTypeCode'],
    },
  },
  'AWS::EC2::SecurityGroup': {
    members: {
      GroupDescription: ['Description'],
      'SecurityGroupEgress.DestinationPrefixListId': ['PrefixListId'],
      'SecurityGroupEgress.DestinationSecurityGroupId': ['GroupId'],
      'SecurityGroupIngress.SourcePrefixListId': ['PrefixListId'],
      'SecurityGroupIngress.SourceSecurityGroupId': ['GroupId'],
      'SecurityGroupIngress.SourceSecurityGroupName': ['GroupName'],
      'SecurityGroupIngress.SourceSecurityGroupOwnerId': ['UserId'],
    },
    containers: {
      SecurityGroupEgress: ['IpPermissions', 'IpRanges', 'Ipv6Ranges', 'PrefixListIds', 'UserIdGroupPairs'],
      SecurityGroupIngress: ['IpPermissions', 'IpRanges', 'Ipv6Ranges', 'PrefixListIds', 'UserIdGroupPairs'],
    },
  },
  'AWS::EC2::SecurityGroupIngress': {
    members: {
      SourcePrefixListId: ['PrefixListId'],
      SourceSecurityGroupId: ['GroupId'],
      SourceSecurityGroupOwnerId: ['UserId'],
    },
  },
  'AWS::EC2::SubnetNetworkAclAssociation': {
    members: {
      // The subnet's current association is read, then replaced by its id.
      SubnetId: ['AssociationId'],
    },
  },
  'AWS::ECR::Repository': {
    members: {
      'ImageTagMutabilityExclusionFilters.ImageTagMutabilityExclusionFilterType': ['filterType'],
      'ImageTagMutabilityExclusionFilters.ImageTagMutabilityExclusionFilterValue': ['filter'],
    },
    containers: {
      'LifecyclePolicy.LifecyclePolicyText@LifecyclePolicy': [FLATTENED],
      RepositoryPolicyText: ['policyText'],
    },
  },
  'AWS::ECS::Cluster': {
    containers: {
      ClusterSettings: ['settings'],
    },
  },
  'AWS::ECS::Service': {
    members: {
      'ForceNewDeployment.EnableForceNewDeployment': ['forceNewDeployment'],
    },
    containers: {
      'ForceNewDeployment.EnableForceNewDeployment@ForceNewDeployment': [FLATTENED],
      PlacementStrategies: ['placementStrategy'],
    },
  },
  'AWS::ECS::TaskDefinition': {
    containers: {
      'ProxyConfiguration.ProxyConfigurationProperties': ['properties'],
    },
  },
  'AWS::EFS::AccessPoint': {
    containers: {
      AccessPointTags: ['Tags'],
    },
  },
  'AWS::EFS::FileSystem': {
    containers: {
      FileSystemPolicy: ['Policy'],
      'FileSystemProtection.ReplicationOverwriteProtection@FileSystemProtection': [FLATTENED],
      FileSystemTags: ['Tags'],
    },
  },
  'AWS::EMR::Cluster': {
    containers: {
      'Configurations.ConfigurationProperties': ['Properties'],
      'Configurations.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.CoreInstanceFleet': ['InstanceFleets'],
      'Instances.CoreInstanceFleet.InstanceTypeConfigs.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.CoreInstanceFleet.InstanceTypeConfigs.Configurations.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.CoreInstanceGroup': ['InstanceGroups'],
      'Instances.CoreInstanceGroup.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.CoreInstanceGroup.Configurations.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.MasterInstanceFleet': ['InstanceFleets'],
      'Instances.MasterInstanceFleet.InstanceTypeConfigs.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.MasterInstanceFleet.InstanceTypeConfigs.Configurations.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.MasterInstanceGroup': ['InstanceGroups'],
      'Instances.MasterInstanceGroup.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.MasterInstanceGroup.Configurations.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.TaskInstanceFleets': ['InstanceFleets'],
      'Instances.TaskInstanceFleets.InstanceTypeConfigs.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.TaskInstanceFleets.InstanceTypeConfigs.Configurations.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.TaskInstanceGroups': ['InstanceGroups'],
      'Instances.TaskInstanceGroups.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.TaskInstanceGroups.Configurations.Configurations.ConfigurationProperties': ['Properties'],
      'Instances.TerminationProtected@Instances': [FLATTENED],
      'Instances.UnhealthyNodeReplacement@Instances': [FLATTENED],
      'Steps.HadoopJarStep.StepProperties': ['Properties'],
    },
  },
  'AWS::EMR::InstanceFleetConfig': {
    containers: {
      'InstanceTypeConfigs.Configurations.ConfigurationProperties': ['Properties'],
      'InstanceTypeConfigs.Configurations.Configurations.ConfigurationProperties': ['Properties'],
    },
  },
  'AWS::EMR::InstanceGroupConfig': {
    containers: {
      'Configurations.ConfigurationProperties': ['Properties'],
      'Configurations.Configurations.ConfigurationProperties': ['Properties'],
    },
  },
  'AWS::ElastiCache::CacheCluster': {
    members: {
      ClusterName: ['CacheClusterId'],
      PreferredAvailabilityZones: ['NewAvailabilityZones'],
      VpcSecurityGroupIds: ['SecurityGroupIds'],
    },
  },
  'AWS::ElastiCache::SubnetGroup': {
    members: {
      Description: ['CacheSubnetGroupDescription'],
    },
  },
  'AWS::ElasticLoadBalancingV2::Listener': {
    containers: {
      ListenerAttributes: ['Attributes'],
    },
  },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    containers: {
      LoadBalancerAttributes: ['Attributes'],
    },
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    containers: {
      TargetGroupAttributes: ['Attributes'],
    },
  },
  'AWS::Events::Rule': {
    containers: {
      'Targets.EcsParameters.PlacementStrategies': ['PlacementStrategy'],
      'Targets.EcsParameters.TagList': ['Tags'],
    },
  },
  'AWS::FSx::FileSystem': {
    members: {
      'OntapConfiguration.RouteTableIds': ['AddRouteTableIds'],
      'OpenZFSConfiguration.RouteTableIds': ['AddRouteTableIds'],
    },
    containers: {
      'WindowsConfiguration.Aliases@WindowsConfiguration': [FLATTENED],
    },
    transformed: {
      FileSystemType:
        'from a backup the type is the backup\'s, not a CreateFileSystemFromBackup parameter; it reaches only the idempotency token',
    },
  },
  'AWS::Glue::Connection': {
    containers: {
      Tags: ['TagsToAdd'],
    },
  },
  'AWS::Glue::Crawler': {
    members: {
      'Schedule.ScheduleExpression': ['Schedule'],
    },
    containers: {
      'Schedule.ScheduleExpression@Schedule': [FLATTENED],
      Tags: ['TagsToAdd'],
    },
  },
  'AWS::Glue::Database': {
    members: {
      DatabaseName: ['Name'],
    },
  },
  'AWS::Glue::Job': {
    containers: {
      Tags: ['TagsToAdd'],
    },
  },
  'AWS::Glue::SecurityConfiguration': {
    containers: {
      'EncryptionConfiguration.S3Encryptions': ['S3Encryption'],
    },
  },
  'AWS::Glue::Trigger': {
    containers: {
      Tags: ['TagsToAdd'],
    },
  },
  'AWS::Glue::Workflow': {
    containers: {
      Tags: ['TagsToAdd'],
    },
  },
  'AWS::IAM::Group': {
    members: {
      ManagedPolicyArns: ['PolicyArn'],
      Path: ['NewPath'],
    },
    containers: {
      'Policies.PolicyDocument.Statement.Action@Policies': [FLATTENED],
      'Policies.PolicyDocument.Statement.Effect@Policies': [FLATTENED],
      'Policies.PolicyDocument.Statement.Resource@Policies': [FLATTENED],
      'Policies.PolicyDocument.Version@Policies': [FLATTENED],
      'Policies.PolicyName@Policies': [FLATTENED],
    },
  },
  'AWS::IAM::InstanceProfile': {
    members: {
      Roles: ['RoleName'],
    },
  },
  'AWS::IAM::ManagedPolicy': {
    members: {
      Groups: ['GroupName'],
      ManagedPolicyName: ['PolicyName'],
      Roles: ['RoleName'],
      Users: ['UserName'],
    },
  },
  'AWS::IAM::Policy': {
    members: {
      Groups: ['GroupName'],
      Roles: ['RoleName'],
      Users: ['UserName'],
    },
  },
  'AWS::IAM::Role': {
    members: {
      ManagedPolicyArns: ['PolicyArn'],
    },
    containers: {
      AssumeRolePolicyDocument: ['PolicyDocument'],
      'Policies.PolicyDocument.Statement.Action@Policies': [FLATTENED],
      'Policies.PolicyDocument.Statement.Effect@Policies': [FLATTENED],
      'Policies.PolicyDocument.Statement.Resource@Policies': [FLATTENED],
      'Policies.PolicyDocument.Version@Policies': [FLATTENED],
      'Policies.PolicyName@Policies': [FLATTENED],
    },
  },
  'AWS::IAM::User': {
    members: {
      Groups: ['GroupName'],
      ManagedPolicyArns: ['PolicyArn'],
      Path: ['NewPath'],
    },
    containers: {
      'LoginProfile.Password@LoginProfile': [FLATTENED],
      'LoginProfile.PasswordResetRequired@LoginProfile': [FLATTENED],
      'Policies.PolicyDocument.Statement.Action@Policies': [FLATTENED],
      'Policies.PolicyDocument.Statement.Effect@Policies': [FLATTENED],
      'Policies.PolicyDocument.Statement.Resource@Policies': [FLATTENED],
      'Policies.PolicyDocument.Version@Policies': [FLATTENED],
      'Policies.PolicyName@Policies': [FLATTENED],
    },
  },
  'AWS::IAM::UserToGroupAddition': {
    members: {
      Users: ['UserName'],
    },
  },
  'AWS::KMS::Key': {
    members: {
      // EnableKeyRotation versus DisableKeyRotation, EnableKey versus DisableKey.
      EnableKeyRotation: ['KeyId'],
      Enabled: ['KeyId'],
      'Tags.Key': ['TagKey'],
    },
    containers: {
      KeyPolicy: ['Policy'],
    },
  },
  'AWS::Kinesis::Stream': {
    members: {
      DesiredShardLevelMetrics: ['ShardLevelMetrics'],
      Name: ['StreamName'],
      ShardCount: ['TargetShardCount'],
    },
    containers: {
      'StreamEncryption.EncryptionType@StreamEncryption': [FLATTENED],
      'StreamEncryption.KeyId@StreamEncryption': [FLATTENED],
    },
  },
  'AWS::KinesisFirehose::DeliveryStream': {
    containers: {
      AmazonOpenSearchServerlessDestinationConfiguration: ['AmazonOpenSearchServerlessDestinationUpdate'],
      'AmazonOpenSearchServerlessDestinationConfiguration.S3Configuration': ['S3Update'],
      AmazonopensearchserviceDestinationConfiguration: ['AmazonopensearchserviceDestinationUpdate'],
      'AmazonopensearchserviceDestinationConfiguration.S3Configuration': ['S3Update'],
      ElasticsearchDestinationConfiguration: ['ElasticsearchDestinationUpdate'],
      'ElasticsearchDestinationConfiguration.S3Configuration': ['S3Update'],
      ExtendedS3DestinationConfiguration: ['ExtendedS3DestinationUpdate'],
      'ExtendedS3DestinationConfiguration.S3BackupConfiguration': ['S3BackupUpdate'],
      HttpEndpointDestinationConfiguration: ['HttpEndpointDestinationUpdate'],
      'HttpEndpointDestinationConfiguration.S3Configuration': ['S3Update'],
      RedshiftDestinationConfiguration: ['RedshiftDestinationUpdate'],
      'RedshiftDestinationConfiguration.S3BackupConfiguration': ['S3BackupUpdate'],
      'RedshiftDestinationConfiguration.S3Configuration': ['S3Update'],
      S3DestinationConfiguration: ['S3DestinationUpdate'],
      SplunkDestinationConfiguration: ['SplunkDestinationUpdate'],
      'SplunkDestinationConfiguration.S3Configuration': ['S3Update'],
    },
  },
  'AWS::Lambda::Function': {
    containers: {
      'Code.ImageUri@Code': [FLATTENED],
      'Code.S3Bucket@Code': [FLATTENED],
      'Code.S3Key@Code': [FLATTENED],
      'Code.S3ObjectStorageMode@Code': [FLATTENED],
      'Code.S3ObjectVersion@Code': [FLATTENED],
      'Code.SourceKMSKeyArn@Code': [FLATTENED],
      'Code.ZipFile@Code': [FLATTENED],
      'RuntimeManagementConfig.RuntimeVersionArn@RuntimeManagementConfig': [FLATTENED],
      'RuntimeManagementConfig.UpdateRuntimeOn@RuntimeManagementConfig': [FLATTENED],
    },
  },
  'AWS::Lambda::Url': {
    members: {
      TargetFunctionArn: ['FunctionName'],
    },
  },
  'AWS::Logs::LogGroup': {
    containers: {
      DataProtectionPolicy: ['policyDocument'],
      FieldIndexPolicies: ['policyDocument'],
    },
  },
  'AWS::Neptune::DBCluster': {
    members: {
      DBPort: ['Port'],
      IamAuthEnabled: ['EnableIAMDatabaseAuthentication'],
    },
  },
  'AWS::RDS::DBCluster': {
    members: {
      'MasterUserSecret.KmsKeyId': ['MasterUserSecretKmsKeyId'],
    },
    containers: {
      'MasterUserSecret.KmsKeyId@MasterUserSecret': [FLATTENED],
    },
  },
  'AWS::RDS::DBInstance': {
    members: {
      'MasterUserSecret.KmsKeyId': ['MasterUserSecretKmsKeyId'],
      Port: ['DBPortNumber'],
      VPCSecurityGroups: ['VpcSecurityGroupIds'],
    },
    containers: {
      'MasterUserSecret.KmsKeyId@MasterUserSecret': [FLATTENED],
    },
  },
  'AWS::RDS::DBProxy': {
    members: {
      VpcSecurityGroupIds: ['SecurityGroups'],
    },
  },
  'AWS::RDS::DBProxyTargetGroup': {
    containers: {
      ConnectionPoolConfigurationInfo: ['ConnectionPoolConfig'],
    },
  },
  'AWS::Route53::HostedZone': {
    containers: {
      'HostedZoneConfig.Comment@HostedZoneConfig': [FLATTENED],
      'HostedZoneFeatures.EnableAcceleratedRecovery@HostedZoneFeatures': [FLATTENED],
      HostedZoneTags: ['AddTags'],
      'QueryLoggingConfig.CloudWatchLogsLogGroupArn@QueryLoggingConfig': [FLATTENED],
      VPCs: ['VPC'],
    },
  },
  'AWS::Route53::RecordSet': {
    members: {
      // The zone is looked up by name and addressed by id.
      HostedZoneName: ['HostedZoneId'],
    },
  },
  'AWS::S3::Bucket': {
    members: {
      'AccelerateConfiguration.AccelerationStatus': ['Status'],
      'AnalyticsConfigurations.StorageClassAnalysis.DataExport.Destination.BucketArn': ['Bucket'],
      BucketName: ['Bucket'],
      'CorsConfiguration.CorsRules.ExposedHeaders': ['ExposeHeaders'],
      'CorsConfiguration.CorsRules.MaxAge': ['MaxAgeSeconds'],
      'InventoryConfigurations.Destination.BucketAccountId': ['AccountId'],
      'InventoryConfigurations.Destination.BucketArn': ['Bucket'],
      'InventoryConfigurations.Enabled': ['IsEnabled'],
      'InventoryConfigurations.ScheduleFrequency': ['Schedule.Frequency'],
      'LifecycleConfiguration.Rules.ExpirationDate': ['Expiration.Date'],
      'LifecycleConfiguration.Rules.ExpirationInDays': ['Expiration.Days'],
      'LifecycleConfiguration.Rules.ExpiredObjectDeleteMarker': ['Expiration.ExpiredObjectDeleteMarker'],
      'LifecycleConfiguration.Rules.NoncurrentVersionExpirationInDays': ['NoncurrentVersionExpiration.NoncurrentDays'],
      'LifecycleConfiguration.Rules.NoncurrentVersionTransition.TransitionInDays': ['NoncurrentDays'],
      'LifecycleConfiguration.Rules.NoncurrentVersionTransitions.TransitionInDays': ['NoncurrentDays'],
      'LifecycleConfiguration.Rules.ObjectSizeGreaterThan': ['Filter.And.ObjectSizeGreaterThan'],
      'LifecycleConfiguration.Rules.ObjectSizeLessThan': ['Filter.And.ObjectSizeLessThan'],
      'LifecycleConfiguration.Rules.Prefix': ['Filter.And.Prefix'],
      'LifecycleConfiguration.Rules.Transition.TransitionDate': ['Date'],
      'LifecycleConfiguration.Rules.Transition.TransitionInDays': ['Days'],
      'LifecycleConfiguration.Rules.Transitions.TransitionDate': ['Date'],
      'LifecycleConfiguration.Rules.Transitions.TransitionInDays': ['Days'],
      'LoggingConfiguration.DestinationBucketName': ['TargetBucket'],
      'LoggingConfiguration.LogFilePrefix': ['TargetPrefix'],
      // `true` sends an empty `EventBridgeConfiguration: {}`.
      'NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled': ['EventBridgeConfiguration'],
      'NotificationConfiguration.LambdaConfigurations.Event': ['Events'],
      'NotificationConfiguration.LambdaConfigurations.Function': ['LambdaFunctionArn'],
      'NotificationConfiguration.QueueConfigurations.Event': ['Events'],
      'NotificationConfiguration.QueueConfigurations.Queue': ['QueueArn'],
      'NotificationConfiguration.TopicConfigurations.Event': ['Events'],
      'NotificationConfiguration.TopicConfigurations.Topic': ['TopicArn'],
      ObjectLockEnabled: ['ObjectLockEnabledForBucket'],
      'WebsiteConfiguration.ErrorDocument': ['ErrorDocument.Key'],
      'WebsiteConfiguration.IndexDocument': ['IndexDocument.Suffix'],
    },
    containers: {
      AnalyticsConfigurations: ['AnalyticsConfiguration', 'And'],
      'AnalyticsConfigurations.StorageClassAnalysis.DataExport.Destination': ['Destination.S3BucketDestination'],
      'AnalyticsConfigurations.TagFilters': ['Tags'],
      'BucketEncryption.ServerSideEncryptionConfiguration': ['ServerSideEncryptionConfiguration.Rules'],
      'BucketEncryption.ServerSideEncryptionConfiguration.BlockedEncryptionTypes.EncryptionType@BucketEncryption': [FLATTENED],
      'BucketEncryption.ServerSideEncryptionConfiguration.BucketKeyEnabled@BucketEncryption': [FLATTENED],
      'BucketEncryption.ServerSideEncryptionConfiguration.ServerSideEncryptionByDefault': ['ApplyServerSideEncryptionByDefault'],
      'BucketEncryption.ServerSideEncryptionConfiguration.ServerSideEncryptionByDefault.KMSMasterKeyID@BucketEncryption': [FLATTENED],
      'BucketEncryption.ServerSideEncryptionConfiguration.ServerSideEncryptionByDefault.SSEAlgorithm@BucketEncryption': [FLATTENED],
      IntelligentTieringConfigurations: ['And', 'IntelligentTieringConfiguration'],
      'IntelligentTieringConfigurations.TagFilters': ['Tags'],
      InventoryConfigurations: ['Filter', 'InventoryConfiguration'],
      'InventoryConfigurations.Destination': ['Destination.S3BucketDestination'],
      'LifecycleConfiguration.Rules.NoncurrentVersionTransition': ['NoncurrentVersionTransitions'],
      'LifecycleConfiguration.Rules.TagFilters': ['Filter.Tag'],
      'LifecycleConfiguration.Rules.Transition': ['Transitions'],
      'LifecycleConfiguration.TransitionDefaultMinimumObjectSize@LifecycleConfiguration': [FLATTENED],
      LoggingConfiguration: ['LoggingEnabled'],
      MetricsConfigurations: ['And', 'Filter', 'MetricsConfiguration'],
      'MetricsConfigurations.TagFilters': ['Tags'],
      'NotificationConfiguration.EventBridgeConfiguration': ['NotificationConfiguration'],
      'NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled@NotificationConfiguration': [FLATTENED],
      'NotificationConfiguration.LambdaConfigurations': ['LambdaFunctionConfigurations'],
      'NotificationConfiguration.LambdaConfigurations.Filter.S3Key': ['Key'],
      'NotificationConfiguration.LambdaConfigurations.Filter.S3Key.Rules': ['FilterRules'],
      'NotificationConfiguration.QueueConfigurations.Filter.S3Key': ['Key'],
      'NotificationConfiguration.QueueConfigurations.Filter.S3Key.Rules': ['FilterRules'],
      'NotificationConfiguration.TopicConfigurations.Filter.S3Key': ['Key'],
      'NotificationConfiguration.TopicConfigurations.Filter.S3Key.Rules': ['FilterRules'],
      'ReplicationConfiguration.Rules.Filter.And.TagFilters': ['Tags'],
      'ReplicationConfiguration.Rules.Filter.TagFilter': ['Tag'],
      Tags: ['TagSet'],
      'WebsiteConfiguration.RoutingRules.RedirectRule': ['Redirect'],
      'WebsiteConfiguration.RoutingRules.RoutingRuleCondition': ['Condition'],
    },
  },
  'AWS::S3::BucketPolicy': {
    containers: {
      PolicyDocument: ['Policy'],
    },
  },
  'AWS::S3Express::DirectoryBucket': {
    members: {
      BucketName: ['Bucket'],
      LocationName: ['Name'],
    },
  },
  'AWS::S3Tables::Table': {
    members: {
      Name: ['newName'],
      Namespace: ['newNamespaceName'],
      OpenTableFormat: ['format'],
      TableName: ['name', 'newName'],
    },
  },
  'AWS::S3Tables::TableBucket': {
    members: {
      TableBucketName: ['name'],
    },
  },
  'AWS::SNS::Subscription': {
    containers: {
      DeliveryPolicy: ['AttributeValue'],
      FilterPolicy: ['AttributeValue'],
      RedrivePolicy: ['AttributeValue'],
      ReplayPolicy: ['AttributeValue'],
    },
  },
  'AWS::SNS::Topic': {
    members: {
      // A delivery-status setting is a topic attribute named for its protocol.
      'DeliveryStatusLogging.FailureFeedbackRoleArn': ['LambdaFailureFeedbackRoleArn'],
      'DeliveryStatusLogging.Protocol': ['AttributeName'],
      'DeliveryStatusLogging.SuccessFeedbackRoleArn': ['LambdaSuccessFeedbackRoleArn'],
      'DeliveryStatusLogging.SuccessFeedbackSampleRate': ['LambdaSuccessFeedbackSampleRate'],
      TopicName: ['Name'],
    },
    containers: {
      ArchivePolicy: ['AttributeValue'],
      DataProtectionPolicy: ['AttributeValue'],
      'DeliveryStatusLogging.FailureFeedbackRoleArn@DeliveryStatusLogging': [FLATTENED],
      'DeliveryStatusLogging.Protocol@DeliveryStatusLogging': [FLATTENED],
      'DeliveryStatusLogging.SuccessFeedbackRoleArn@DeliveryStatusLogging': [FLATTENED],
      'DeliveryStatusLogging.SuccessFeedbackSampleRate@DeliveryStatusLogging': [FLATTENED],
      'Subscription.Endpoint@Subscription': [FLATTENED],
      'Subscription.Protocol@Subscription': [FLATTENED],
    },
  },
  'AWS::SNS::TopicPolicy': {
    members: {
      Topics: ['TopicArn'],
    },
    containers: {
      PolicyDocument: ['AttributeValue'],
    },
  },
  'AWS::SQS::QueuePolicy': {
    members: {
      Queues: ['QueueUrl'],
    },
    containers: {
      PolicyDocument: ['Policy'],
    },
  },
  'AWS::SecretsManager::Secret': {
    containers: {
      ReplicaRegions: ['AddReplicaRegions'],
    },
    transformed: {
      'GenerateSecretString.ExcludeCharacters':
        'the password is generated here and sent inside `SecretString`',
      'GenerateSecretString.ExcludeLowercase':
        'the password is generated here and sent inside `SecretString`',
      'GenerateSecretString.ExcludeNumbers':
        'the password is generated here and sent inside `SecretString`',
      'GenerateSecretString.ExcludePunctuation':
        'the password is generated here and sent inside `SecretString`',
      'GenerateSecretString.ExcludeUppercase':
        'the password is generated here and sent inside `SecretString`',
      'GenerateSecretString.GenerateStringKey':
        'the password is generated here and sent inside `SecretString`',
      'GenerateSecretString.IncludeSpace':
        'the password is generated here and sent inside `SecretString`',
      'GenerateSecretString.PasswordLength':
        'the password is generated here and sent inside `SecretString`',
      'GenerateSecretString.RequireEachIncludedType':
        'the password is generated here and sent inside `SecretString`',
      'GenerateSecretString.SecretStringTemplate':
        'the password is generated here and sent inside `SecretString`',
    },
  },
  'AWS::ServiceDiscovery::Service': {
    containers: {
      ServiceAttributes: ['Attributes'],
    },
  },
  'AWS::StepFunctions::StateMachine': {
    members: {
      DefinitionString: ['definition'],
      StateMachineName: ['name'],
      StateMachineType: ['type'],
    },
    containers: {
      'Definition.States.${s}': ['P'],
    },
    transformed: {
      'DefinitionS3Location.Bucket':
        'the S3 object is fetched and sent as `definition`',
      'DefinitionS3Location.Key':
        'the S3 object is fetched and sent as `definition`',
      'DefinitionS3Location.Version':
        'the S3 object is fetched and sent as `definition`',
      'DefinitionSubstitutions.s':
        'substituted into the definition document',
    },
  },
  'AWS::WAFv2::WebACL': {
    members: {
      // Decoded from base64 and sent as the bytes of `SearchString`.
      'Rules.Statement.ByteMatchStatement.SearchStringBase64': ['SearchString'],
      'Rules.Statement.OrStatement.Statements.ByteMatchStatement.SearchStringBase64': ['SearchString'],
    },
  },
};
