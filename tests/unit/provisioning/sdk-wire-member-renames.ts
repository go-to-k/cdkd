/**
 * Where a varied CFn leaf may land under ANOTHER member or parent (#3723).
 *
 * Each vary probe in `sdk-wire-harness.ts` diffs the two runs' command inputs
 * and requires the varied leaf to land in a member of its own name (compared
 * case- and punctuation-blind, wrappers such as `Items` / `member` / `Value`
 * skipped), with every CFn ancestor right above the level below it, or as the
 * map entry it keys. This replaced `gen-nested-key-coverage.ts`'s retired
 * write pass: a provider writing a value into a SIBLING member changes the wire
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
 *   `Destination.S3BucketDestination`), or the command whose input carries
 *   them at its top level (`PutMethodResponseCommand`; `<command>:<root>`
 *   where the case's `roots` tell several calls of it apart).
 * - `transformed`: the value is not sent as-is (fetched from S3, generated,
 *   re-keyed), so no member can be traced; the reason says what happens.
 *
 * Shrink-only in spirit: every entry must still be needed (the per-type
 * `uses every accepted rename` case fails on one that no probe needed), and a
 * new entry is a claim that the provider's mapping is RIGHT.
 */
export interface TypeRenames {
  /** Bag path (indices dropped) -> the SDK members its value may land in. */
  members?: Record<string, readonly string[]>;
  /**
   * Bag path of a parent -> the SDK members its children may sit under
   * (dotted for an extra SDK level), or the command carrying them at its top.
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
      Integration: ['PutIntegrationCommand'],
      'Integration.IntegrationResponses': ['PutIntegrationResponseCommand'],
      MethodResponses: ['PutMethodResponseCommand'],
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
      CanarySetting: ['UpdateStageCommand', 'canarySettings', 'patchOperations'],
      'CanarySetting.StageVariableOverrides': ['patchOperations'],
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
      LifecycleHookSpecificationList: ['PutLifecycleHookCommand'],
      MetricsCollection: ['EnableMetricsCollectionCommand'],
      NotificationConfigurations: ['PutNotificationConfigurationCommand'],
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
      DomainValidationOptions: ['ChangeResourceRecordSetsCommand'],
    },
  },
  'AWS::CloudFormation::Stack': {
    transformed: {
      'Parameters.Display':
        'a nested-stack parameter is substituted into the child template, so it reaches the child resource\'s own calls (its SNS topic\'s DisplayName / tag Value), not a member of this one',
      'Parameters.TagValue':
        'a nested-stack parameter is substituted into the child template, so it reaches the child resource\'s own calls (its SNS topic\'s DisplayName / tag Value), not a member of this one',
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
      Code: ['CreateCommitCommand'],
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
      GlobalSecondaryIndexes: ['GlobalSecondaryIndexUpdates.Create', 'GlobalSecondaryIndexUpdates.Update'],
      'GlobalSecondaryIndexes.WriteOnDemandThroughputSettings': ['OnDemandThroughput'],
      'GlobalSecondaryIndexes.WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': ['PutScalingPolicyCommand:index-index-write', 'RegisterScalableTargetCommand:index-index-write'],
      ReadOnDemandThroughputSettings: ['OnDemandThroughput'],
      ReadProvisionedThroughputSettings: ['ProvisionedThroughput'],
      Replicas: ['Create', 'CreateTableCommand', 'EnableKinesisStreamingDestinationCommand', 'GlobalSecondaryIndexUpdates', 'ReplicaUpdates', 'TagResourceCommand', 'Update', 'UpdateContinuousBackupsCommand', 'UpdateTableCommand'],
      'Replicas.ContributorInsightsSpecification': ['UpdateContributorInsightsCommand:table'],
      'Replicas.GlobalSecondaryIndexes': ['Update'],
      'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification': ['UpdateContributorInsightsCommand:index'],
      'Replicas.GlobalSecondaryIndexes.ReadOnDemandThroughputSettings': ['OnDemandThroughput'],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings': ['ProvisionedThroughputOverride'],
      'Replicas.GlobalSecondaryIndexes.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': ['PutScalingPolicyCommand:index-index-read', 'RegisterScalableTargetCommand:index-index-read'],
      'Replicas.KinesisStreamSpecification': ['EnableKinesisStreamingConfiguration', 'EnableKinesisStreamingDestinationCommand'],
      'Replicas.ReadOnDemandThroughputSettings': ['OnDemandThroughput'],
      'Replicas.ReadProvisionedThroughputSettings': ['ProvisionedThroughputOverride'],
      'Replicas.ReadProvisionedThroughputSettings.ReadCapacityAutoScalingSettings': ['PutScalingPolicyCommand:table-table-read', 'RegisterScalableTargetCommand:table-table-read'],
      'Replicas.ReplicaStreamSpecification': ['TagResourceCommand'],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy': ['PutResourcePolicyCommand:stream'],
      'Replicas.ReplicaStreamSpecification.ResourcePolicy.PolicyDocument': ['Policy'],
      'Replicas.ResourcePolicy': ['PutResourcePolicyCommand:table'],
      'Replicas.ResourcePolicy.PolicyDocument': ['Policy'],
      'Replicas.SSESpecification': ['Create', 'Update'],
      SSESpecification: ['Update'],
      VectorIndexes: ['VectorIndexUpdates.Create'],
      WriteOnDemandThroughputSettings: ['OnDemandThroughput'],
      WriteProvisionedThroughputSettings: ['ProvisionedThroughput'],
      'WriteProvisionedThroughputSettings.WriteCapacityAutoScalingSettings': ['PutScalingPolicyCommand:table-table-write', 'RegisterScalableTargetCommand:table-table-write'],
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
      ContributorInsightsSpecification: ['UpdateContributorInsightsCommand:table'],
      GlobalSecondaryIndexes: ['GlobalSecondaryIndexUpdates.Create', 'GlobalSecondaryIndexUpdates.Update'],
      'GlobalSecondaryIndexes.ContributorInsightsSpecification': ['UpdateContributorInsightsCommand:index'],
      KinesisStreamSpecification: ['EnableKinesisStreamingConfiguration', 'EnableKinesisStreamingDestinationCommand'],
      ResourcePolicy: ['CreateTableCommand', 'PutResourcePolicyCommand:table'],
      'ResourcePolicy.PolicyDocument': ['Policy', 'ResourcePolicy'],
      StreamSpecification: ['TagResourceCommand:stream'],
      'StreamSpecification.ResourcePolicy': ['PutResourcePolicyCommand:stream'],
      'StreamSpecification.ResourcePolicy.PolicyDocument': ['Policy'],
      VectorIndexes: ['VectorIndexUpdates.Create'],
    },
  },
  'AWS::EC2::Instance': {
    members: {
      IamInstanceProfile: ['Name'],
      'NetworkInterfaces.GroupSet': ['Groups'],
      SecurityGroupIds: ['Groups'],
    },
    containers: {
      CreditSpecification: ['InstanceCreditSpecifications'],
      MetadataOptions: ['ModifyInstanceMetadataOptionsCommand'],
    },
    transformed: {
      Monitoring:
        'MonitorInstances versus UnmonitorInstances: the value picks the command, which carries only `InstanceIds`',
    },
  },
  'AWS::EC2::NatGateway': {
    containers: {
      AvailabilityZoneAddresses: ['AssociateNatGatewayAddressCommand'],
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
      LifecyclePolicy: ['PutLifecyclePolicyCommand'],
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
      ForceNewDeployment: ['UpdateServiceCommand'],
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
      FileSystemProtection: ['UpdateFileSystemProtectionCommand'],
      FileSystemTags: ['Tags'],
    },
  },
  'AWS::EMR::Cluster': {
    containers: {
      'Configurations.ConfigurationProperties': ['Properties'],
      'Configurations.Configurations.ConfigurationProperties': ['Properties'],
      Instances: ['SetTerminationProtectionCommand', 'SetUnhealthyNodeReplacementCommand'],
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
      WindowsConfiguration: ['AssociateFileSystemAliasesCommand'],
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
      Schedule: ['CreateCrawlerCommand', 'UpdateCrawlerCommand'],
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
      Policies: ['PutGroupPolicyCommand'],
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
      Policies: ['PutRolePolicyCommand'],
    },
  },
  'AWS::IAM::User': {
    members: {
      Groups: ['GroupName'],
      ManagedPolicyArns: ['PolicyArn'],
      Path: ['NewPath'],
    },
    containers: {
      LoginProfile: ['CreateLoginProfileCommand'],
      Policies: ['PutUserPolicyCommand'],
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
      StreamEncryption: ['StartStreamEncryptionCommand'],
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
      Code: ['UpdateFunctionCodeCommand'],
      RuntimeManagementConfig: ['PutRuntimeManagementConfigCommand'],
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
      // ModifyDBCluster takes the delta, not the list.
      EnableCloudwatchLogsExports: ['CloudwatchLogsExportConfiguration.EnableLogTypes'],
    },
    containers: {
      AssociatedRoles: ['AddRoleToDBClusterCommand'],
      ServerlessScalingConfiguration: ['ServerlessV2ScalingConfiguration'],
    },
  },
  'AWS::RDS::DBCluster': {
    members: {
      'MasterUserSecret.KmsKeyId': ['MasterUserSecretKmsKeyId'],
    },
    containers: {
      MasterUserSecret: ['CreateDBClusterCommand', 'ModifyDBClusterCommand'],
    },
  },
  'AWS::RDS::DBInstance': {
    members: {
      'MasterUserSecret.KmsKeyId': ['MasterUserSecretKmsKeyId'],
      Port: ['DBPortNumber'],
      VPCSecurityGroups: ['VpcSecurityGroupIds'],
    },
    containers: {
      MasterUserSecret: ['CreateDBInstanceCommand', 'ModifyDBInstanceCommand'],
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
      HostedZoneConfig: ['UpdateHostedZoneCommentCommand'],
      HostedZoneFeatures: ['UpdateHostedZoneFeaturesCommand'],
      HostedZoneTags: ['AddTags'],
      QueryLoggingConfig: ['CreateQueryLoggingConfigCommand'],
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
      AbacStatus: ['AbacStatus.Status'],
      'AccelerateConfiguration.AccelerationStatus': ['Status'],
      'AnalyticsConfigurations.StorageClassAnalysis.DataExport.Destination.BucketArn': ['Bucket'],
      BucketName: ['Bucket'],
      BucketNamePrefix: ['Bucket'],
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
      MetadataConfiguration: [
        'UpdateBucketMetadataAnnotationTableConfigurationCommand',
        'UpdateBucketMetadataInventoryTableConfigurationCommand',
        'UpdateBucketMetadataJournalTableConfigurationCommand',
      ],
      AnalyticsConfigurations: ['AnalyticsConfiguration', 'And'],
      'AnalyticsConfigurations.StorageClassAnalysis.DataExport.Destination': ['Destination.S3BucketDestination'],
      'AnalyticsConfigurations.TagFilters': ['Tags'],
      BucketEncryption: ['PutBucketEncryptionCommand'],
      'BucketEncryption.ServerSideEncryptionConfiguration': ['ServerSideEncryptionConfiguration.Rules'],
      'BucketEncryption.ServerSideEncryptionConfiguration.ServerSideEncryptionByDefault': ['ApplyServerSideEncryptionByDefault'],
      IntelligentTieringConfigurations: ['And', 'IntelligentTieringConfiguration'],
      'IntelligentTieringConfigurations.TagFilters': ['Tags'],
      InventoryConfigurations: ['Filter', 'InventoryConfiguration'],
      'InventoryConfigurations.Destination': ['Destination.S3BucketDestination'],
      LifecycleConfiguration: ['PutBucketLifecycleConfigurationCommand'],
      'LifecycleConfiguration.Rules.NoncurrentVersionTransition': ['NoncurrentVersionTransitions'],
      'LifecycleConfiguration.Rules.TagFilters': ['Filter.Tag'],
      'LifecycleConfiguration.Rules.Transition': ['Transitions'],
      LoggingConfiguration: ['LoggingEnabled'],
      MetricsConfigurations: ['And', 'Filter', 'MetricsConfiguration'],
      'MetricsConfigurations.TagFilters': ['Tags'],
      NotificationConfiguration: ['PutBucketNotificationConfigurationCommand'],
      'NotificationConfiguration.EventBridgeConfiguration': ['NotificationConfiguration'],
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
      'InventoryConfigurations.Destination.BucketAccountId': ['AccountId'],
      'InventoryConfigurations.Destination.BucketArn': ['Bucket'],
      'InventoryConfigurations.Enabled': ['IsEnabled'],
      'InventoryConfigurations.ScheduleFrequency': ['Schedule.Frequency'],
      'LifecycleConfiguration.Rules.ExpirationInDays': ['Expiration.Days'],
      'LifecycleConfiguration.Rules.ObjectSizeGreaterThan': ['Filter.And.ObjectSizeGreaterThan'],
      'LifecycleConfiguration.Rules.ObjectSizeLessThan': ['Filter.And.ObjectSizeLessThan'],
      'LifecycleConfiguration.Rules.Prefix': ['Filter.And.Prefix'],
      LocationName: ['Name'],
    },
    containers: {
      BucketEncryption: ['PutBucketEncryptionCommand'],
      'BucketEncryption.ServerSideEncryptionConfiguration': ['ServerSideEncryptionConfiguration.Rules'],
      'BucketEncryption.ServerSideEncryptionConfiguration.ServerSideEncryptionByDefault': ['ApplyServerSideEncryptionByDefault'],
      InventoryConfigurations: ['Filter', 'InventoryConfiguration'],
      'InventoryConfigurations.Destination': ['Destination.S3BucketDestination'],
      MetricsConfigurations: ['And', 'Filter', 'MetricsConfiguration'],
    },
  },
  'AWS::S3Tables::Table': {
    members: {
      Name: ['newName'],
      Namespace: ['newNamespaceName'],
      OpenTableFormat: ['format'],
      TableName: ['name', 'newName'],
      'IcebergMetadata.IcebergSchemaV2.SchemaV2FieldType': ['type'],
    },
    containers: {
      // A maintenance property is one PutTableMaintenanceConfiguration's
      // `value`: its status there, its settings under the kind's own member.
      Compaction: ['value', 'value.settings.icebergCompaction'],
      SnapshotManagement: ['value', 'value.settings.icebergSnapshotManagement'],
      IcebergMetadata: ['metadata.iceberg'],
      'IcebergMetadata.IcebergPartitionSpec': ['partitionSpec'],
      'IcebergMetadata.IcebergSchema': ['schema'],
      'IcebergMetadata.IcebergSchema.SchemaFieldList': ['fields'],
      'IcebergMetadata.IcebergSchemaV2': ['schemaV2'],
      'IcebergMetadata.IcebergSchemaV2.SchemaV2FieldList': ['fields'],
      'IcebergMetadata.IcebergSortOrder': ['writeOrder'],
      'IcebergMetadata.TableProperties': ['properties'],
    },
  },
  'AWS::S3Tables::TableBucket': {
    members: {
      TableBucketName: ['name'],
    },
    containers: {
      ReplicationConfiguration: ['configuration'],
      UnreferencedFileRemoval: ['value', 'value.settings.icebergUnreferencedFileRemoval'],
    },
    transformed: {
      'MetricsConfiguration.Status':
        'Enabled sends PutTableBucketMetricsConfiguration and Disabled its Delete, each with only the bucket ARN: no member carries the status',
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
      DeliveryStatusLogging: ['SetTopicAttributesCommand'],
      Subscription: ['SubscribeCommand'],
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
