/**
 * Which resource types and properties the security diff reads.
 * Split out of `../security-changes.ts` (#5835).
 */

/** A resource type the security diff reads as a whole. */
export type ResourceScrutiny =
  | 'IdentityPolicyResource'
  | 'ResourcePolicyResource'
  | 'LambdaPermission'
  | 'IngressRuleResource'
  | 'EgressRuleResource'
  | 'SsoAssignmentResource'
  | 'SsoInstanceACAConfigResource'
  | 'SsoPermissionSet';

/** A property the security diff reads. */
export type PropertyScrutiny =
  | 'InlineIdentityPolicies'
  | 'InlineResourcePolicy'
  | 'ManagedPolicies'
  | 'IngressRules'
  | 'EgressRules';

/** `scrutinizable` of each resource type in `@aws-cdk/aws-service-spec` that has one. */
export const RESOURCE_SCRUTINY: Readonly<Record<string, ResourceScrutiny>> = {
  'AWS::Bedrock::KnowledgeBasePolicy': 'ResourcePolicyResource',
  'AWS::Bedrock::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::CloudTrail::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::EC2::SecurityGroupEgress': 'EgressRuleResource',
  'AWS::EC2::SecurityGroupIngress': 'IngressRuleResource',
  'AWS::ECR::RegistryPolicy': 'ResourcePolicyResource',
  'AWS::EventSchemas::RegistryPolicy': 'ResourcePolicyResource',
  'AWS::EventsV2::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::IAM::GroupPolicy': 'IdentityPolicyResource',
  'AWS::IAM::ManagedPolicy': 'IdentityPolicyResource',
  'AWS::IAM::Policy': 'IdentityPolicyResource',
  'AWS::IAM::RolePolicy': 'IdentityPolicyResource',
  'AWS::IAM::UserPolicy': 'IdentityPolicyResource',
  'AWS::IoT::Policy': 'ResourcePolicyResource',
  'AWS::Kinesis::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::Lambda::Permission': 'LambdaPermission',
  'AWS::Lambda::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::Lex::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::Logs::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::MSK::ClusterPolicy': 'ResourcePolicyResource',
  'AWS::MediaPackageV2::ChannelPolicy': 'ResourcePolicyResource',
  'AWS::MediaPackageV2::OriginEndpointPolicy': 'ResourcePolicyResource',
  'AWS::MediaTailor::ChannelPolicy': 'ResourcePolicyResource',
  'AWS::S3::BucketPolicy': 'ResourcePolicyResource',
  'AWS::S3::MultiRegionAccessPointPolicy': 'ResourcePolicyResource',
  'AWS::S3Express::BucketPolicy': 'ResourcePolicyResource',
  'AWS::S3Files::FileSystemPolicy': 'ResourcePolicyResource',
  'AWS::S3ObjectLambda::AccessPointPolicy': 'ResourcePolicyResource',
  'AWS::S3Outposts::BucketPolicy': 'ResourcePolicyResource',
  'AWS::S3Tables::TableBucketPolicy': 'ResourcePolicyResource',
  'AWS::S3Tables::TablePolicy': 'ResourcePolicyResource',
  'AWS::S3Vectors::VectorBucketPolicy': 'ResourcePolicyResource',
  'AWS::SMSVOICE::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::SNS::TopicInlinePolicy': 'ResourcePolicyResource',
  'AWS::SNS::TopicPolicy': 'ResourcePolicyResource',
  'AWS::SQS::QueueInlinePolicy': 'ResourcePolicyResource',
  'AWS::SQS::QueuePolicy': 'ResourcePolicyResource',
  'AWS::SSM::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::SSO::Assignment': 'SsoAssignmentResource',
  'AWS::SSO::InstanceAccessControlAttributeConfiguration': 'SsoInstanceACAConfigResource',
  'AWS::SSO::PermissionSet': 'SsoPermissionSet',
  'AWS::SecretsManager::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::VpcLattice::AuthPolicy': 'ResourcePolicyResource',
  'AWS::VpcLattice::ResourcePolicy': 'ResourcePolicyResource',
};

/**
 * `scrutinizable` of each resource property in `@aws-cdk/aws-service-spec` that
 * has one, per type in the database's property order (the order rows are read).
 */
export const PROPERTY_SCRUTINY: Readonly<
  Record<string, Readonly<Record<string, PropertyScrutiny>>>
> = {
  'AWS::ApiGateway::DomainNameV2': { Policy: 'InlineResourcePolicy' },
  'AWS::ApiGateway::RestApi': { Policy: 'InlineResourcePolicy' },
  'AWS::Backup::BackupVault': { AccessPolicy: 'InlineResourcePolicy' },
  'AWS::Backup::LogicallyAirGappedBackupVault': { AccessPolicy: 'InlineResourcePolicy' },
  'AWS::CodeArtifact::Domain': { PermissionsPolicyDocument: 'InlineResourcePolicy' },
  'AWS::CodeArtifact::Repository': { PermissionsPolicyDocument: 'InlineResourcePolicy' },
  'AWS::EC2::SecurityGroup': {
    SecurityGroupEgress: 'EgressRules',
    SecurityGroupIngress: 'IngressRules',
  },
  'AWS::EC2::VPCEndpoint': { PolicyDocument: 'InlineResourcePolicy' },
  'AWS::ECR::PublicRepository': { RepositoryPolicyText: 'InlineResourcePolicy' },
  'AWS::ECR::Repository': { RepositoryPolicyText: 'InlineResourcePolicy' },
  'AWS::EFS::FileSystem': { FileSystemPolicy: 'InlineResourcePolicy' },
  'AWS::Events::EventBus': { Policy: 'InlineResourcePolicy' },
  'AWS::IAM::Group': { ManagedPolicyArns: 'ManagedPolicies', Policies: 'InlineIdentityPolicies' },
  'AWS::IAM::Role': {
    AssumeRolePolicyDocument: 'InlineResourcePolicy',
    ManagedPolicyArns: 'ManagedPolicies',
    Policies: 'InlineIdentityPolicies',
  },
  'AWS::IAM::User': { ManagedPolicyArns: 'ManagedPolicies', Policies: 'InlineIdentityPolicies' },
  'AWS::KMS::Key': { KeyPolicy: 'InlineResourcePolicy' },
  'AWS::KMS::ReplicaKey': { KeyPolicy: 'InlineResourcePolicy' },
  'AWS::Logs::LogGroup': {
    DataProtectionPolicy: 'InlineResourcePolicy',
    ResourcePolicyDocument: 'InlineResourcePolicy',
  },
  'AWS::MPA::ApprovalTeam': { Policies: 'InlineIdentityPolicies' },
  'AWS::NetworkManager::CoreNetwork': { PolicyDocument: 'InlineResourcePolicy' },
  'AWS::Oam::Sink': { Policy: 'InlineResourcePolicy' },
  'AWS::Omics::SequenceStore': { S3AccessPolicy: 'InlineResourcePolicy' },
  'AWS::RAM::Permission': { PolicyTemplate: 'InlineResourcePolicy' },
  'AWS::Redshift::Cluster': { NamespaceResourcePolicy: 'InlineResourcePolicy' },
  'AWS::RedshiftServerless::Namespace': { NamespaceResourcePolicy: 'InlineResourcePolicy' },
  'AWS::RolesAnywhere::Profile': { ManagedPolicyArns: 'ManagedPolicies' },
  'AWS::S3::AccessPoint': { Policy: 'InlineResourcePolicy' },
  'AWS::S3Express::AccessPoint': { Policy: 'InlineResourcePolicy' },
  'AWS::S3Outposts::AccessPoint': { Policy: 'InlineResourcePolicy' },
  'AWS::SNS::Subscription': {
    RedrivePolicy: 'InlineResourcePolicy',
    ReplayPolicy: 'InlineResourcePolicy',
  },
  'AWS::SNS::Topic': {
    DataProtectionPolicy: 'InlineResourcePolicy',
    ArchivePolicy: 'InlineResourcePolicy',
  },
  'AWS::SQS::Queue': { RedriveAllowPolicy: 'InlineResourcePolicy' },
  'AWS::SSO::PermissionSet': {
    InlinePolicy: 'InlineResourcePolicy',
    ManagedPolicies: 'ManagedPolicies',
  },
  'AWS::SageMaker::ModelPackageGroup': { ModelPackageGroupPolicy: 'InlineResourcePolicy' },
  'AWS::Serverless::Function': { AssumeRolePolicyDocument: 'InlineResourcePolicy' },
};

export function resourceScrutiny(type: string): ResourceScrutiny | undefined {
  return Object.hasOwn(RESOURCE_SCRUTINY, type) ? RESOURCE_SCRUTINY[type] : undefined;
}

export function propertyScrutinies(type: string): Readonly<Record<string, PropertyScrutiny>> {
  return Object.hasOwn(PROPERTY_SCRUTINY, type) ? (PROPERTY_SCRUTINY[type] ?? {}) : {};
}

/**
 * Is `path` of a `type` resource read by the security diff: the resource is
 * scrutinized as a whole, or the property is.
 */
export function isScrutinizedProperty(type: string, path: string): boolean {
  return resourceScrutiny(type) !== undefined || Object.hasOwn(propertyScrutinies(type), path);
}
