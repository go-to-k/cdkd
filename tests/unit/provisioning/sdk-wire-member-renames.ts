/**
 * Where a varied CFn leaf may land under ANOTHER member name (#3723).
 *
 * Each vary probe in `sdk-wire-harness.ts` diffs the two runs' command inputs
 * and requires the varied leaf to land in a member of its own name (compared
 * case- and punctuation-blind), a map entry it keys, or a name listed here for
 * that type and bag path (member names joined by `.`, list indices dropped).
 * This is what stands in for `gen-nested-key-coverage.ts`'s write pass: a
 * provider writing a value into a SIBLING member changes the wire exactly as
 * the right mapping does, so wire comparison alone cannot see it.
 *
 * Shrink-only in spirit: every entry must still be needed (the per-type
 * `uses every accepted rename` case fails on one no probe reached), and a new
 * entry is a claim that the provider's mapping is RIGHT. An entry naming a
 * structural parent (`Groups`, `Items`) is weaker than one naming the member
 * itself; where the input carries the member's own name, that is the one used.
 */
export const MEMBER_RENAMES: Record<string, Record<string, readonly string[]>> = {
  'AWS::ApiGateway::Method': {
    // A model map's media-type key is a JSON-pointer segment in the patch path.
    'RequestModels.application/json': ['application~1json'],
    'RequestModels.text/plain': ['text~1plain'],
  },
  'AWS::ApiGateway::Stage': {
    // A method setting is a patch operation: `/{resource}/{method}/caching/...`.
    'MethodSettings.CacheDataEncrypted': ['caching/dataEncrypted'],
    'MethodSettings.CacheTtlInSeconds': ['caching/ttlInSeconds'],
    'MethodSettings.DataTraceEnabled': ['logging/dataTrace'],
    'MethodSettings.HttpMethod': ['path'],
    'MethodSettings.LoggingLevel': ['logging/loglevel'],
    'MethodSettings.ResourcePath': ['path'],
  },
  'AWS::ApiGatewayV2::Integration': {
    // Each mapping becomes a map entry keyed `<Destination>` -> `<Source>`
    // under the status code (the map keys, `200` / `404`, stay in the path).
    'ResponseParameters.200.ResponseParameters.Destination': ['ResponseParameters'],
    'ResponseParameters.200.ResponseParameters.Source': ['ResponseParameters'],
    'ResponseParameters.404.ResponseParameters.Destination': ['ResponseParameters'],
    'ResponseParameters.404.ResponseParameters.Source': ['ResponseParameters'],
  },
  'AWS::AppSync::GraphQLSchema': {
    // The S3 object is fetched and its content sent.
    DefinitionS3Location: ['definition'],
  },
  'AWS::AppSync::Resolver': {
    CodeS3Location: ['code'],
    RequestMappingTemplateS3Location: ['requestMappingTemplate'],
    ResponseMappingTemplateS3Location: ['responseMappingTemplate'],
  },
  'AWS::AutoScaling::AutoScalingGroup': {
    Cooldown: ['DefaultCooldown'],
  },
  'AWS::CertificateManager::Certificate': {
    CertificateExport: ['Export'],
  },
  'AWS::CloudFormation::Stack': {
    'Parameters.Display': ['DisplayName'],
    'Parameters.TagValue': ['Value'],
  },
  'AWS::CloudFront::Distribution': {
    'DistributionConfig.IPV6Enabled': ['IsIPV6Enabled'],
    'DistributionConfig.Restrictions.GeoRestriction.Locations': ['Items'],
  },
  'AWS::CloudTrail::Trail': {
    // StartLogging versus StopLogging: the command changes, carrying `Name`.
    IsLogging: ['Name'],
    TrailName: ['Name'],
  },
  'AWS::CodeBuild::Project': {
    Visibility: ['projectVisibility'],
  },
  'AWS::CodeCommit::Repository': {
    // The S3 object is fetched and committed as file content.
    'Code.S3.Bucket': ['fileContent'],
    'Code.S3.Key': ['fileContent'],
    'Code.S3.ObjectVersion': ['fileContent'],
    RepositoryName: ['newName'],
  },
  'AWS::Cognito::UserPool': {
    EmailAuthenticationMessage: ['Message'],
    EmailAuthenticationSubject: ['Subject'],
    // Each enabled factor is its own configuration block.
    EnabledMfas: ['EmailMfaConfiguration', 'SmsMfaConfiguration', 'SoftwareTokenMfaConfiguration'],
    UserPoolName: ['PoolName'],
    WebAuthnFactorConfiguration: ['FactorConfiguration'],
    WebAuthnRelyingPartyID: ['RelyingPartyId'],
    WebAuthnUserVerification: ['UserVerification'],
  },
  'AWS::DynamoDB::GlobalTable': {
    'Replicas.ContributorInsightsSpecification.Enabled': ['ContributorInsightsAction'],
    'Replicas.ContributorInsightsSpecification.Mode': ['ContributorInsightsMode'],
    'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification.Enabled': [
      'ContributorInsightsAction',
    ],
    'Replicas.GlobalSecondaryIndexes.ContributorInsightsSpecification.Mode': [
      'ContributorInsightsMode',
    ],
    // A replica override names its index; renaming it drops the override.
    'Replicas.GlobalSecondaryIndexes.IndexName': ['GlobalSecondaryIndexes'],
    'Replicas.Region': ['RegionName'],
    // Table-level SSE also re-keys each replica (`KMSMasterKeyId`).
    'SSESpecification.SSEEnabled': ['Enabled', 'KMSMasterKeyId'],
  },
  'AWS::DynamoDB::Table': {
    'ContributorInsightsSpecification.Enabled': ['ContributorInsightsAction'],
    'ContributorInsightsSpecification.Mode': ['ContributorInsightsMode'],
    'GlobalSecondaryIndexes.ContributorInsightsSpecification.Enabled': [
      'ContributorInsightsAction',
    ],
    'GlobalSecondaryIndexes.ContributorInsightsSpecification.Mode': ['ContributorInsightsMode'],
    'SSESpecification.SSEEnabled': ['Enabled'],
  },
  'AWS::EC2::Instance': {
    // MonitorInstances versus UnmonitorInstances.
    Monitoring: ['InstanceIds'],
    'NetworkInterfaces.GroupSet': ['Groups'],
    SecurityGroupIds: ['Groups'],
  },
  'AWS::EC2::SecurityGroup': {
    GroupDescription: ['Description'],
    'SecurityGroupEgress.DestinationPrefixListId': ['PrefixListId'],
    'SecurityGroupEgress.DestinationSecurityGroupId': ['GroupId'],
    'SecurityGroupIngress.SourcePrefixListId': ['PrefixListId'],
    'SecurityGroupIngress.SourceSecurityGroupId': ['GroupId'],
    'SecurityGroupIngress.SourceSecurityGroupName': ['GroupName'],
    'SecurityGroupIngress.SourceSecurityGroupOwnerId': ['UserId'],
  },
  'AWS::EC2::SecurityGroupIngress': {
    SourcePrefixListId: ['PrefixListId'],
    SourceSecurityGroupId: ['GroupId'],
    SourceSecurityGroupOwnerId: ['UserId'],
  },
  'AWS::EC2::SubnetNetworkAclAssociation': {
    // The subnet's current association is read, then replaced by its id.
    SubnetId: ['AssociationId'],
  },
  'AWS::ECR::Repository': {
    'ImageTagMutabilityExclusionFilters.ImageTagMutabilityExclusionFilterType': ['filterType'],
    'ImageTagMutabilityExclusionFilters.ImageTagMutabilityExclusionFilterValue': ['filter'],
  },
  'AWS::ECS::Service': {
    'ForceNewDeployment.EnableForceNewDeployment': ['forceNewDeployment'],
  },
  'AWS::ElastiCache::CacheCluster': {
    ClusterName: ['CacheClusterId'],
    PreferredAvailabilityZones: ['NewAvailabilityZones'],
    VpcSecurityGroupIds: ['SecurityGroupIds'],
  },
  'AWS::ElastiCache::SubnetGroup': {
    Description: ['CacheSubnetGroupDescription'],
  },
  'AWS::FSx::FileSystem': {
    // From a backup the type is the backup's and not a parameter of
    // CreateFileSystemFromBackup; it reaches only the idempotency token.
    FileSystemType: ['ClientRequestToken'],
    'OntapConfiguration.RouteTableIds': ['AddRouteTableIds'],
    'OpenZFSConfiguration.RouteTableIds': ['AddRouteTableIds'],
  },
  'AWS::Glue::Crawler': {
    'Schedule.ScheduleExpression': ['Schedule'],
  },
  'AWS::Glue::Database': {
    DatabaseName: ['Name'],
  },
  'AWS::IAM::Group': {
    ManagedPolicyArns: ['PolicyArn'],
    Path: ['NewPath'],
  },
  'AWS::IAM::InstanceProfile': {
    Roles: ['RoleName'],
  },
  'AWS::IAM::ManagedPolicy': {
    Groups: ['GroupName'],
    ManagedPolicyName: ['PolicyName'],
    Roles: ['RoleName'],
    Users: ['UserName'],
  },
  'AWS::IAM::Policy': {
    Groups: ['GroupName'],
    Roles: ['RoleName'],
    Users: ['UserName'],
  },
  'AWS::IAM::Role': {
    ManagedPolicyArns: ['PolicyArn'],
  },
  'AWS::IAM::User': {
    Groups: ['GroupName'],
    ManagedPolicyArns: ['PolicyArn'],
    Path: ['NewPath'],
  },
  'AWS::IAM::UserToGroupAddition': {
    Users: ['UserName'],
  },
  'AWS::KMS::Key': {
    // EnableKeyRotation versus DisableKeyRotation, EnableKey versus DisableKey.
    EnableKeyRotation: ['KeyId'],
    Enabled: ['KeyId'],
    'Tags.Key': ['TagKey'],
  },
  'AWS::Kinesis::Stream': {
    DesiredShardLevelMetrics: ['ShardLevelMetrics'],
    Name: ['StreamName'],
    ShardCount: ['TargetShardCount'],
  },
  'AWS::Lambda::Url': {
    TargetFunctionArn: ['FunctionName'],
  },
  'AWS::Neptune::DBCluster': {
    DBPort: ['Port'],
    IamAuthEnabled: ['EnableIAMDatabaseAuthentication'],
  },
  'AWS::RDS::DBCluster': {
    'MasterUserSecret.KmsKeyId': ['MasterUserSecretKmsKeyId'],
  },
  'AWS::RDS::DBInstance': {
    'MasterUserSecret.KmsKeyId': ['MasterUserSecretKmsKeyId'],
    Port: ['DBPortNumber'],
    VPCSecurityGroups: ['VpcSecurityGroupIds'],
  },
  'AWS::RDS::DBProxy': {
    VpcSecurityGroupIds: ['SecurityGroups'],
  },
  'AWS::Route53::RecordSet': {
    // The zone is looked up by name and addressed by id.
    HostedZoneName: ['HostedZoneId'],
  },
  'AWS::S3::Bucket': {
    'AccelerateConfiguration.AccelerationStatus': ['Status'],
    'AnalyticsConfigurations.StorageClassAnalysis.DataExport.Destination.BucketArn': ['Bucket'],
    BucketName: ['Bucket'],
    'CorsConfiguration.CorsRules.ExposedHeaders': ['ExposeHeaders'],
    'CorsConfiguration.CorsRules.MaxAge': ['MaxAgeSeconds'],
    'InventoryConfigurations.Destination.BucketAccountId': ['AccountId'],
    'InventoryConfigurations.Destination.BucketArn': ['Bucket'],
    'InventoryConfigurations.Enabled': ['IsEnabled'],
    'InventoryConfigurations.ScheduleFrequency': ['Frequency'],
    'LifecycleConfiguration.Rules.ExpirationDate': ['Date'],
    'LifecycleConfiguration.Rules.ExpirationInDays': ['Days'],
    'LifecycleConfiguration.Rules.NoncurrentVersionExpirationInDays': ['NoncurrentDays'],
    'LifecycleConfiguration.Rules.NoncurrentVersionTransition.TransitionInDays': ['NoncurrentDays'],
    'LifecycleConfiguration.Rules.NoncurrentVersionTransitions.TransitionInDays': [
      'NoncurrentDays',
    ],
    'LifecycleConfiguration.Rules.Transition.TransitionDate': ['Date'],
    'LifecycleConfiguration.Rules.Transition.TransitionInDays': ['Days'],
    'LifecycleConfiguration.Rules.Transitions.TransitionDate': ['Date'],
    'LifecycleConfiguration.Rules.Transitions.TransitionInDays': ['Days'],
    'LoggingConfiguration.DestinationBucketName': ['TargetBucket'],
    'LoggingConfiguration.LogFilePrefix': ['TargetPrefix'],
    // `true` sends an empty `EventBridgeConfiguration: {}`.
    'NotificationConfiguration.EventBridgeConfiguration.EventBridgeEnabled': [
      'EventBridgeConfiguration',
    ],
    'NotificationConfiguration.LambdaConfigurations.Event': ['Events'],
    'NotificationConfiguration.LambdaConfigurations.Function': ['LambdaFunctionArn'],
    'NotificationConfiguration.QueueConfigurations.Event': ['Events'],
    'NotificationConfiguration.QueueConfigurations.Queue': ['QueueArn'],
    'NotificationConfiguration.TopicConfigurations.Event': ['Events'],
    'NotificationConfiguration.TopicConfigurations.Topic': ['TopicArn'],
    ObjectLockEnabled: ['ObjectLockEnabledForBucket'],
  },
  'AWS::S3Express::DirectoryBucket': {
    BucketName: ['Bucket'],
    LocationName: ['Name'],
  },
  'AWS::S3Tables::Table': {
    Name: ['newName'],
    Namespace: ['newNamespaceName'],
    OpenTableFormat: ['format'],
    TableName: ['name', 'newName'],
  },
  'AWS::S3Tables::TableBucket': {
    TableBucketName: ['name'],
  },
  'AWS::SNS::Topic': {
    // A delivery-status setting is a topic attribute named for its protocol.
    'DeliveryStatusLogging.FailureFeedbackRoleArn': ['LambdaFailureFeedbackRoleArn'],
    'DeliveryStatusLogging.Protocol': ['AttributeName'],
    'DeliveryStatusLogging.SuccessFeedbackRoleArn': ['LambdaSuccessFeedbackRoleArn'],
    'DeliveryStatusLogging.SuccessFeedbackSampleRate': ['LambdaSuccessFeedbackSampleRate'],
    TopicName: ['Name'],
  },
  'AWS::SNS::TopicPolicy': {
    Topics: ['TopicArn'],
  },
  'AWS::SQS::QueuePolicy': {
    Queues: ['QueueUrl'],
  },
  'AWS::SecretsManager::Secret': {
    // The password is generated here and sent as the secret string.
    'GenerateSecretString.ExcludeCharacters': ['SecretString'],
    'GenerateSecretString.ExcludeLowercase': ['SecretString'],
    'GenerateSecretString.ExcludeNumbers': ['SecretString'],
    'GenerateSecretString.ExcludePunctuation': ['SecretString'],
    'GenerateSecretString.ExcludeUppercase': ['SecretString'],
    'GenerateSecretString.GenerateStringKey': ['SecretString'],
    'GenerateSecretString.IncludeSpace': ['SecretString'],
    'GenerateSecretString.PasswordLength': ['SecretString'],
    'GenerateSecretString.RequireEachIncludedType': ['SecretString'],
    'GenerateSecretString.SecretStringTemplate': ['SecretString'],
  },
  'AWS::StepFunctions::StateMachine': {
    // The S3 object is fetched and sent as the definition.
    'DefinitionS3Location.Bucket': ['definition'],
    'DefinitionS3Location.Key': ['definition'],
    'DefinitionS3Location.Version': ['definition'],
    DefinitionString: ['definition'],
    'DefinitionSubstitutions.s': ['definition'],
    StateMachineName: ['name'],
    StateMachineType: ['type'],
  },
  'AWS::WAFv2::WebACL': {
    // Decoded from base64 and sent as the bytes of `SearchString`.
    'Rules.Statement.ByteMatchStatement.SearchStringBase64': ['SearchString'],
    'Rules.Statement.OrStatement.Statements.ByteMatchStatement.SearchStringBase64': [
      'SearchString',
    ],
  },
};
