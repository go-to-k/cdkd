/**
 * The hand classification behind `scripts/gen-in-place-attr-coverage.ts`
 * (issue #7001): for every read-only `Fn::GetAtt` attribute of a type with an
 * SDK provider, whether an IN-PLACE update moves it. A Cloud Control type takes
 * an entry only for a pair no rule of the generator can settle rightly (a
 * moving id); it wins over the rules (go-to-k/cdkd#7007).
 *
 *   - `never`      — no in-place update moves it (an id or ARN fixed for the
 *                    resource's life, a value derived only from create-only
 *                    inputs, a value only ANOTHER resource moves).
 *   - `moved-by`   — moves when one of the named top-level properties changes:
 *                    a row of `IN_PLACE_UPDATE_ATTRS_MOVED_BY` with exactly
 *                    these properties.
 *   - `any-update` — any in-place update may move it: a row of
 *                    `IN_PLACE_UPDATE_DERIVED_ATTRS`. Used only where no
 *                    narrower property set is possible.
 *   - `prefix`     — an open family a row of
 *                    `IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES` covers.
 *
 * A key ending `.*` covers every dotted attribute under it (the bare
 * container keeps its own entry). `tests/unit/scripts/in-place-attr-coverage.test.ts`
 * holds every moving verdict equal to its shared.ts row, and every shared.ts
 * row of an SDK type to a moving verdict here.
 *
 * Sources: the CFn schema's create-only properties (an attribute derived only
 * from create-only inputs never moves in place), the service API docs, and the
 * provider's own update().
 */

export type InPlaceAttrVerdict =
  | { readonly kind: 'never'; readonly reason: string }
  | { readonly kind: 'moved-by'; readonly properties: readonly string[]; readonly reason: string }
  | { readonly kind: 'any-update'; readonly reason: string }
  | { readonly kind: 'prefix'; readonly prefix: string; readonly reason: string };

const never = (reason: string): InPlaceAttrVerdict => ({ kind: 'never', reason });
const movedBy = (properties: readonly string[], reason: string): InPlaceAttrVerdict => ({
  kind: 'moved-by',
  properties,
  reason,
});
const anyUpdate = (reason: string): InPlaceAttrVerdict => ({ kind: 'any-update', reason });

/** `BUILD_AFFECTING_CFN_KEYS` of the MicroVM image provider: what rebuilds the image. */
const MICROVM_BUILD_KEYS = [
  'BaseImageArn',
  'BaseImageVersion',
  'BuildRoleArn',
  'Description',
  'CodeArtifact',
  'Logging',
  'EgressNetworkConnectors',
  'CpuConfigurations',
  'Resources',
  'AdditionalOsCapabilities',
  'Hooks',
  'EnvironmentVariables',
  'KmsKeyIdentifier',
] as const;

/** Every in-place `AWS::Pipes::Pipe` property but `Tags`: what UpdatePipe sends. */
const PIPE_UPDATE_KEYS = [
  'Description',
  'DesiredState',
  'Enrichment',
  'EnrichmentParameters',
  'KmsKeyIdentifier',
  'LogConfiguration',
  'RoleArn',
  'SourceParameters',
  'Target',
  'TargetParameters',
] as const;

const ID = never('an id AWS mints at create, fixed for the resource life');
const ARN = never('the ARN is built from create-only inputs');
const OWN_REF = never('the physical id, which an in-place update keeps');
const CREATED = never('the creation time');
const FIXED_ENDPOINT = never('derived from the create-only identifier');
const STEADY_STATUS = never(
  'an operational status that settles back to its steady value after an update; no property sets it'
);

export const SDK_IN_PLACE_ATTR_CLASSIFICATION: Readonly<
  Record<string, Readonly<Record<string, InPlaceAttrVerdict>>>
> = {
  'AWS::ApiGateway::Account': { Id: OWN_REF },
  'AWS::ApiGateway::Authorizer': { AuthorizerId: ID },
  'AWS::ApiGateway::Deployment': {
    DeploymentId: never('a new deployment is a new logical id; an in-place edit keeps the id'),
  },
  'AWS::ApiGateway::Resource': { ResourceId: ID },
  'AWS::ApiGateway::RestApi': { RestApiId: ID, RootResourceId: ID },
  'AWS::ApiGatewayV2::Api': {
    ApiId: ID,
    ApiEndpoint: never('derived from the api id and region'),
    ExecuteApiArn: never('derived from the api id'),
  },
  'AWS::ApiGatewayV2::Authorizer': { AuthorizerId: ID },
  'AWS::ApiGatewayV2::Integration': { IntegrationId: ID },
  'AWS::ApiGatewayV2::Route': { RouteId: ID },
  'AWS::AppConfig::Environment': { EnvironmentId: ID },
  'AWS::AppSync::ApiKey': {
    ApiKeyId: ID,
    ApiKey: never('the key value; an Expires / Description update keeps it'),
    Arn: never('derived from the api id and key id'),
  },
  'AWS::AppSync::DataSource': { DataSourceArn: never('derived from the api id and create-only name') },
  'AWS::AppSync::GraphQLApi': {
    ApiId: ID,
    Arn: never('derived from the api id'),
    GraphQLEndpointArn: never('derived from the api id'),
    GraphQLUrl: never('the api id host, fixed for the api life'),
    GraphQLDns: never('the api id host, fixed for the api life'),
    RealtimeUrl: never('the api id host, fixed for the api life'),
    RealtimeDns: never('the api id host, fixed for the api life'),
  },
  'AWS::AppSync::GraphQLSchema': { Id: never('derived from the create-only api id') },
  'AWS::AppSync::Resolver': {
    ResolverArn: never('derived from the create-only api id, type name and field name'),
  },
  'AWS::AutoScaling::AutoScalingGroup': { AutoScalingGroupARN: ARN },
  'AWS::BedrockAgentCore::Browser': {
    BrowserArn: ID,
    BrowserId: ID,
    Name: never('the browser name is fixed at create'),
    Status: STEADY_STATUS,
  },
  'AWS::BedrockAgentCore::CodeInterpreter': {
    CodeInterpreterArn: ID,
    CodeInterpreterId: ID,
    Status: STEADY_STATUS,
  },
  'AWS::BedrockAgentCore::Evaluator': {
    EvaluatorArn: ID,
    EvaluatorId: ID,
    CreatedAt: CREATED,
    Status: STEADY_STATUS,
    EvaluatorType: movedBy(
      ['EvaluatorConfig'],
      'Custom / CustomCode / CustomDerived follows the kind of EvaluatorConfig'
    ),
    Provider: movedBy(['EvaluatorConfig'], 'follows the evaluator configuration'),
    UpdatedAt: movedBy(
      ['Description', 'EvaluatorConfig', 'Level', 'KmsKeyArn'],
      'stamped by UpdateEvaluator, which a Tags-only edit does not call'
    ),
  },
  'AWS::BedrockAgentCore::Runtime': {
    AgentRuntimeArn: ID,
    AgentRuntimeId: ID,
    AgentRuntimeVersion: anyUpdate(
      'every UpdateAgentRuntime mints a version, and the update sends one for every change (#6962)'
    ),
    CreatedAt: CREATED,
    LastUpdatedAt: anyUpdate('every UpdateAgentRuntime stamps it'),
    Status: STEADY_STATUS,
    FailureReason: STEADY_STATUS,
    WorkloadIdentityDetails: never('the workload identity is created with the runtime'),
  },
  'AWS::Budgets::Budget': { Id: OWN_REF },
  'AWS::CertificateManager::Certificate': { CertificateArn: ID },
  'AWS::CloudFormation::Stack': {
    StackId: ID,
    RootId: never('the root stack id, fixed'),
    ParentId: never('the parent stack id, fixed'),
    CreationTime: CREATED,
    StackStatus: never('cdkd deploys the child itself and refuses a GetAtt of it'),
    ChangeSetId: never('cdkd deploys the child itself and refuses a GetAtt of it'),
    LastUpdateTime: never('cdkd deploys the child itself and refuses a GetAtt of it'),
    Outputs: {
      kind: 'prefix',
      prefix: 'Outputs.',
      reason: 'a child-only change moves its outputs (#3631)',
    },
  },
  'AWS::CloudFormation::WaitCondition': {
    Id: OWN_REF,
    Data: movedBy(['Handle', 'Count', 'Timeout'], 'a changed wait re-waits and records the new signals'),
  },
  'AWS::CloudFormation::WaitConditionHandle': { Id: OWN_REF },
  'AWS::CloudFront::CloudFrontOriginAccessIdentity': {
    Id: ID,
    S3CanonicalUserId: never('the canonical user of the identity, fixed for its life'),
  },
  'AWS::CloudFront::Distribution': { Id: ID, DomainName: never('the distribution id host') },
  'AWS::CloudFront::OriginAccessControl': { Id: ID },
  'AWS::CloudTrail::Trail': {
    Arn: ARN,
    SnsTopicArn: movedBy(['SnsTopicName'], 'the ARN of the topic SnsTopicName names'),
  },
  'AWS::CloudWatch::Alarm': { Arn: ARN },
  'AWS::CloudWatch::AnomalyDetector': { Id: ID },
  'AWS::CodeBuild::Project': { Arn: ARN },
  'AWS::CodeCommit::Repository': {
    RepositoryId: ID,
    Arn: movedBy(['RepositoryName'], 'UpdateRepositoryName renames in place; the ARN ends in the name'),
    Name: movedBy(['RepositoryName'], 'UpdateRepositoryName renames in place'),
    CloneUrlHttp: movedBy(['RepositoryName'], 'the clone URL ends in the repository name'),
    CloneUrlSsh: movedBy(['RepositoryName'], 'the clone URL ends in the repository name'),
  },
  'AWS::Cognito::UserPool': {
    UserPoolId: ID,
    Arn: never('derived from the pool id'),
    ProviderName: never('derived from the pool id'),
    ProviderURL: never('derived from the pool id'),
  },
  'AWS::Connect::Instance': {
    Id: ID,
    Arn: never('derived from the instance id'),
    CreatedTime: CREATED,
    InstanceStatus: STEADY_STATUS,
    ServiceRole: never('the service-linked role Connect creates with the instance'),
  },
  'AWS::DLM::LifecyclePolicy': { PolicyId: ID, Arn: never('derived from the policy id') },
  'AWS::DocDB::DBCluster': {
    Id: OWN_REF,
    ClusterResourceId: ID,
    Endpoint: FIXED_ENDPOINT,
    ReadEndpoint: FIXED_ENDPOINT,
    ServerlessV2PlatformVersion: movedBy(
      ['EngineVersion'],
      'unmeasured, taken conservatively: an engine upgrade may move the serverless platform'
    ),
  },
  'AWS::DocDB::DBInstance': {
    Id: OWN_REF,
    Endpoint: FIXED_ENDPOINT,
    Port: never("the cluster's port; only the cluster's own update moves it"),
  },
  'AWS::DynamoDB::GlobalTable': {
    Arn: ARN,
    TableId: ID,
    StreamArn: movedBy(['StreamSpecification'], 'a stream change mints a new stream (#6999)'),
  },
  'AWS::DynamoDB::Table': {
    Arn: ARN,
    StreamArn: movedBy(['StreamSpecification'], 'a stream change mints a new stream (#6999)'),
  },
  'AWS::EC2::EIP': {
    AllocationId: ID,
    PublicIp: never('the address is allocated at create; its inputs are create-only'),
  },
  'AWS::EC2::Instance': {
    InstanceId: ID,
    VpcId: never('the subnet is create-only'),
    PrivateIp: never('the primary private address is create-only and survives a stop/start'),
    State: STEADY_STATUS,
    PublicIp: anyUpdate('a stop/start update gives an instance without an EIP a new address (#5446)'),
    PublicDnsName: anyUpdate('follows the public address (#5446)'),
    PrivateDnsName: anyUpdate('a PrivateDnsNameOptions change renames it (#5630)'),
  },
  // Cloud Control: an in-place RouteTableId change calls
  // ReplaceRouteTableAssociation, which answers a NEW association id
  // (`NewAssociationId`) (go-to-k/cdkd#7007).
  'AWS::EC2::GatewayRouteTableAssociation': {
    AssociationId: movedBy(['RouteTableId'], 'ReplaceRouteTableAssociation mints a new association id'),
  },
  'AWS::EC2::InternetGateway': { InternetGatewayId: ID },
  'AWS::EC2::NatGateway': {
    NatGatewayId: ID,
    EniId: never('the primary interface is created with the gateway'),
    RouteTableId: never('a regional gateway route table is created with it'),
    AutoProvisionZones: never(
      'the zone mode never switches in place: adding AvailabilityZoneAddresses to an automatic gateway replaces it'
    ),
    AutoScalingIps: never(
      'the zone mode never switches in place: adding AvailabilityZoneAddresses to an automatic gateway replaces it'
    ),
  },
  'AWS::EC2::NetworkAcl': { Id: ID },
  'AWS::EC2::NetworkAclEntry': { Id: OWN_REF },
  'AWS::EC2::Route': { CidrBlock: never('the create-only DestinationCidrBlock') },
  'AWS::EC2::RouteTable': { RouteTableId: ID },
  'AWS::EC2::SecurityGroup': { GroupId: ID, Id: ID },
  'AWS::EC2::SecurityGroupIngress': { Id: ID },
  'AWS::EC2::Subnet': {
    SubnetId: ID,
    NetworkAclAssociationId: never(
      'a SubnetNetworkAclAssociation moves it, never the subnet update'
    ),
    BlockPublicAccessStates: never('a VPC block-public-access resource moves it'),
    Ipv6CidrBlocks: movedBy(['Ipv6CidrBlock'], 'an associated or disassociated IPv6 block'),
  },
  'AWS::EC2::SubnetNetworkAclAssociation': {
    AssociationId: never('its subnet and network ACL are create-only'),
  },
  'AWS::EC2::SubnetRouteTableAssociation': {
    Id: never('its subnet and route table are create-only'),
  },
  'AWS::EC2::VPC': {
    VpcId: ID,
    DefaultNetworkAcl: never('created with the VPC'),
    DefaultSecurityGroup: never('created with the VPC'),
    CidrBlockAssociations: never('a VPCCidrBlock resource moves it; CidrBlock is create-only'),
    Ipv6CidrBlocks: never('a VPCCidrBlock resource moves it'),
    'VpcEncryptionControl.*': never('VpcEncryptionControl is create-only'),
  },
  'AWS::EC2::VPCEndpoint': {
    Id: ID,
    CreationTimestamp: CREATED,
    NetworkInterfaceIds: movedBy(['SubnetIds'], 'a subnet gains or loses its interface (#6939)'),
    DnsEntries: movedBy(
      ['SubnetIds', 'PrivateDnsEnabled', 'DnsOptions', 'IpAddressType'],
      'subnets, private DNS and DNS options add or drop DNS names (#6939)'
    ),
  },
  'AWS::EC2::VPCGatewayAttachment': {
    AttachmentType: movedBy(
      ['InternetGatewayId', 'VpnGatewayId'],
      'internet or VPN gateway, whichever is attached'
    ),
  },
  'AWS::ECR::Repository': { Arn: ARN, RepositoryUri: never('derived from the create-only name') },
  'AWS::ECS::Cluster': { Arn: ARN },
  'AWS::ECS::Service': { ServiceArn: ARN, Name: never('the create-only ServiceName') },
  'AWS::ECS::TaskDefinition': {
    TaskDefinitionArn: never('every definition change registers a new revision (a replacement)'),
  },
  'AWS::EFS::AccessPoint': { AccessPointId: ID, Arn: never('derived from the access point id') },
  'AWS::EFS::FileSystem': { FileSystemId: ID, Arn: never('derived from the file system id') },
  'AWS::EFS::MountTarget': { Id: ID },
  'AWS::EMR::Cluster': { Id: ID, MasterPublicDNS: never('the master node is created with the cluster') },
  'AWS::EMR::InstanceFleetConfig': { InstanceFleetId: ID },
  'AWS::EMR::InstanceGroupConfig': { InstanceGroupId: ID },
  'AWS::ElastiCache::CacheCluster': {
    ConfigurationEndpoint: FIXED_ENDPOINT,
    'ConfigurationEndpoint.*': FIXED_ENDPOINT,
    RedisEndpoint: FIXED_ENDPOINT,
    'RedisEndpoint.*': FIXED_ENDPOINT,
  },
  'AWS::ElasticLoadBalancingV2::Listener': { ListenerArn: ID },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    LoadBalancerArn: ID,
    LoadBalancerFullName: never('derived from the ARN'),
    LoadBalancerName: never('the create-only Name'),
    DNSName: FIXED_ENDPOINT,
    CanonicalHostedZoneID: never('the regional zone of the load balancer type'),
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    TargetGroupArn: ID,
    TargetGroupFullName: never('derived from the ARN'),
    TargetGroupName: never('the create-only Name'),
    LoadBalancerArns: never('a listener or listener rule moves it, never the target group update'),
  },
  'AWS::Events::Archive': { Arn: ARN },
  'AWS::Events::EventBus': { Arn: ARN },
  'AWS::Events::Rule': {
    Arn: never('built from the create-only Name and EventBusName'),
    RuleName: never('the create-only Name'),
  },
  'AWS::FSx::FileSystem': {
    Id: ID,
    ResourceARN: never('derived from the file system id'),
    RootVolumeId: never('created with the file system'),
    DNSName: FIXED_ENDPOINT,
    LustreMountName: never('assigned at create'),
  },
  'AWS::Glue::Connection': {
    Name: never('a ConnectionInput.Name change replaces the connection (create-only path)'),
  },
  'AWS::IAM::AccessKey': {
    Id: ID,
    SecretAccessKey: never('a Serial change replaces the key; a Status change keeps it'),
  },
  'AWS::IAM::Group': { Arn: movedBy(['Path'], 'UpdateGroup moves the group to the new path') },
  'AWS::IAM::InstanceProfile': { Arn: ARN },
  'AWS::IAM::ManagedPolicy': {
    PolicyArn: ARN,
    PolicyId: ID,
    CreateDate: CREATED,
    IsAttachable: never('every customer managed policy is attachable'),
    DefaultVersionId: movedBy(['PolicyDocument'], 'a document change creates the next default version'),
    UpdateDate: movedBy(['PolicyDocument'], 'stamped by the new policy version'),
    AttachmentCount: movedBy(
      ['Roles', 'Users', 'Groups'],
      'the number of principals attached; a same-length swap keeps it'
    ),
    PermissionsBoundaryUsageCount: never('other principals using it as a boundary move it'),
  },
  'AWS::IAM::Policy': { Id: OWN_REF },
  'AWS::IAM::Role': { Arn: ARN, RoleId: ID },
  'AWS::IAM::User': { Arn: movedBy(['Path'], 'UpdateUser moves the user to the new path') },
  'AWS::IAM::UserToGroupAddition': { Id: OWN_REF },
  'AWS::KMS::Key': { KeyId: ID, Arn: never('derived from the key id') },
  'AWS::Kinesis::Stream': {
    Arn: ARN,
    WarmThroughputObject: movedBy(
      ['WarmThroughputMiBps', 'StreamModeDetails'],
      'the warm throughput an on-demand stream holds'
    ),
  },
  'AWS::Kinesis::StreamConsumer': {
    ConsumerARN: ARN,
    ConsumerCreationTimestamp: CREATED,
    ConsumerStatus: STEADY_STATUS,
  },
  'AWS::KinesisFirehose::DeliveryStream': { Arn: ARN },
  'AWS::Lambda::EventSourceMapping': { Id: ID, EventSourceMappingArn: never('derived from the id') },
  'AWS::Lambda::Function': {
    Arn: ARN,
    SnapStartResponse: movedBy(['SnapStart'], 'the SnapStart setting'),
    'SnapStartResponse.*': movedBy(['SnapStart'], 'the SnapStart setting'),
  },
  'AWS::Lambda::LayerVersion': { LayerVersionArn: never('a layer version is immutable') },
  'AWS::Lambda::MicrovmImage': {
    ImageArn: ARN,
    CreatedAt: CREATED,
    State: STEADY_STATUS,
    LatestActiveImageVersion: movedBy(MICROVM_BUILD_KEYS, 'a build-key change builds a new version'),
    LatestFailedImageVersion: movedBy(MICROVM_BUILD_KEYS, 'a failed build records its version'),
    UpdatedAt: movedBy(MICROVM_BUILD_KEYS, 'stamped by UpdateMicrovmImage; a Tags-only edit skips it'),
  },
  'AWS::Lambda::NetworkConnector': {
    Arn: ARN,
    State: STEADY_STATUS,
    LatestVersion: movedBy(
      ['Configuration', 'OperatorRole'],
      'a configuration update creates a new immutable version'
    ),
    LatestVersionArn: movedBy(['Configuration', 'OperatorRole'], 'the ARN of the latest version'),
  },
  'AWS::Lambda::Permission': { Id: OWN_REF },
  'AWS::Lambda::Url': {
    FunctionArn: never('the create-only TargetFunctionArn and Qualifier'),
    FunctionUrl: never('the URL id is fixed for the URL config life'),
  },
  'AWS::Lambda::WebFunctionEndpoint': {
    EndpointArn: ARN,
    FunctionArn: never('the create-only FunctionName'),
    DomainName: never('assigned at create'),
    RegionalEndpoints: never('one per create-only Region'),
    CreatedAt: CREATED,
    State: STEADY_STATUS,
    StateReason: STEADY_STATUS,
    UpdateStatus: STEADY_STATUS,
    UpdateStatusReason: STEADY_STATUS,
    UpdatedAt: movedBy(
      ['Description', 'AuthType', 'RevisionWeights', 'ScalingConfig', 'ThrottleConfig'],
      'stamped by UpdateWebFunctionEndpoint (every in-place property but the create-only ones)'
    ),
  },
  'AWS::Lambda::WebFunctionRevision': {
    FunctionArn: never('every property is create-only'),
    RevisionId: never('every property is create-only'),
    RevisionArn: never('every property is create-only'),
    State: STEADY_STATUS,
    StateReason: STEADY_STATUS,
    CreatedAt: CREATED,
  },
  'AWS::Lightsail::Alarm': {
    AlarmArn: ARN,
    State: never('the alarm state the metric drives, never an update'),
  },
  'AWS::Logs::Delivery': {
    DeliveryId: ID,
    Arn: never('derived from the delivery id'),
    DeliveryDestinationType: never('follows the create-only DeliveryDestinationArn'),
  },
  'AWS::Logs::DeliveryDestination': { Arn: ARN },
  'AWS::Logs::DeliverySource': {
    Arn: ARN,
    ResourceArns: movedBy(['ResourceArn'], 'the source resource'),
    Service: movedBy(['ResourceArn'], 'the service of the source resource'),
    Status: STEADY_STATUS,
    StatusReason: STEADY_STATUS,
  },
  'AWS::Logs::LogGroup': { Arn: ARN },
  'AWS::Neptune::DBCluster': {
    ClusterResourceId: ID,
    Endpoint: FIXED_ENDPOINT,
    ReadEndpoint: FIXED_ENDPOINT,
    Port: movedBy(['DBPort'], 'ModifyDBCluster moves the cluster to the new port'),
  },
  'AWS::Neptune::DBInstance': {
    Endpoint: FIXED_ENDPOINT,
    Port: never("the cluster's port; only the cluster's own update moves it"),
  },
  'AWS::Pipes::Pipe': {
    Arn: ARN,
    CreationTime: CREATED,
    CurrentState: movedBy(['DesiredState'], 'RUNNING or STOPPED, as DesiredState asks'),
    StateReason: STEADY_STATUS,
    LastModifiedTime: movedBy(PIPE_UPDATE_KEYS, 'stamped by UpdatePipe; a Tags-only edit skips it'),
  },
  'AWS::RDS::DBCluster': {
    DBClusterArn: ARN,
    DBClusterResourceId: ID,
    Endpoint: movedBy(['Port'], 'the endpoint object carries the port'),
    'Endpoint.Address': FIXED_ENDPOINT,
    'Endpoint.Port': movedBy(['Port'], 'ModifyDBCluster moves the cluster to the new port'),
    ReadEndpoint: FIXED_ENDPOINT,
    'ReadEndpoint.Address': FIXED_ENDPOINT,
    'MasterUserSecret.SecretArn': movedBy(
      ['ManageMasterUserPassword'],
      'turning the managed password off and on mints a new secret (#6913)'
    ),
    StorageThroughput: movedBy(
      ['StorageType', 'Iops', 'AllocatedStorage'],
      'a storage change moves a Multi-AZ cluster throughput (#6913)'
    ),
    StorageEncryptionType: never('follows the create-only StorageEncrypted and KmsKeyId'),
  },
  'AWS::RDS::DBInstance': {
    DBInstanceArn: ARN,
    DbiResourceId: ID,
    InstanceCreateTime: CREATED,
    Endpoint: movedBy(['Port'], 'the endpoint object carries the port, modified in place'),
    'Endpoint.Port': movedBy(['Port'], 'ModifyDBInstance moves the instance to the new port'),
    'Endpoint.Address': FIXED_ENDPOINT,
    'Endpoint.HostedZoneId': never('the regional zone of the endpoint'),
    ListenerEndpoint: movedBy(['Port'], 'the listener endpoint carries the port'),
    'ListenerEndpoint.Port': movedBy(['Port'], 'follows the instance port'),
    'ListenerEndpoint.Address': FIXED_ENDPOINT,
    'ListenerEndpoint.HostedZoneId': never('the regional zone of the endpoint'),
    'MasterUserSecret.SecretArn': movedBy(
      ['ManageMasterUserPassword'],
      'turning the managed password off and on mints a new secret (#6913)'
    ),
    CertificateDetails: movedBy(['CACertificateIdentifier'], 'the server certificate of the CA'),
    'CertificateDetails.*': movedBy(['CACertificateIdentifier'], 'the server certificate of the CA'),
    SecondaryAvailabilityZone: movedBy(['MultiAZ'], 'a Multi-AZ instance gains a standby zone'),
    AutomaticRestartTime: never('set only while the instance is stopped, which no property does'),
    DBInstanceStatus: STEADY_STATUS,
    IsStorageConfigUpgradeAvailable: never('an AWS recommendation, no property sets it'),
    LatestRestorableTime: never('advances with time, never by an update'),
    PercentProgress: STEADY_STATUS,
    ReadReplicaDBClusterIdentifiers: never('replicas created elsewhere move it'),
    ReadReplicaDBInstanceIdentifiers: never('replicas created elsewhere move it'),
    ResumeFullAutomationModeTime: never('RDS Custom automation mode, which no property sets'),
    StatusInfos: STEADY_STATUS,
    StorageOperationStatus: STEADY_STATUS,
    StorageOperationPercentProgress: STEADY_STATUS,
  },
  'AWS::RDS::DBProxy': {
    DBProxyArn: ARN,
    Endpoint: FIXED_ENDPOINT,
    VpcId: never('follows the create-only VpcSubnetIds'),
  },
  'AWS::RDS::DBProxyEndpoint': {
    DBProxyEndpointArn: ARN,
    Endpoint: FIXED_ENDPOINT,
    IsDefault: never('only the proxy-created default endpoint is default'),
    VpcId: never('follows the create-only VpcSubnetIds'),
  },
  'AWS::RDS::DBProxyTargetGroup': { TargetGroupArn: ARN },
  'AWS::RDS::DBSubnetGroup': { DBSubnetGroupArn: ARN },
  'AWS::Route53::HostedZone': {
    Id: ID,
    NameServers: never('the delegation set is assigned at create'),
  },
  'AWS::Route53::RecordSetGroup': { Id: OWN_REF },
  'AWS::S3::Bucket': {
    Arn: ARN,
    DomainName: FIXED_ENDPOINT,
    DualStackDomainName: FIXED_ENDPOINT,
    RegionalDomainName: FIXED_ENDPOINT,
    WebsiteURL: never('derived from the bucket name and region'),
    'MetadataTableConfiguration.*': movedBy(
      ['MetadataTableConfiguration'],
      'the metadata table the configuration creates'
    ),
    'MetadataConfiguration.*': movedBy(
      ['MetadataConfiguration'],
      'destination and journal: only when the configuration is added or removed; ' +
        'inventory / annotation: also when its ConfigurationState flips (move tests)'
    ),
  },
  'AWS::S3Express::DirectoryBucket': {
    Arn: ARN,
    AvailabilityZoneName: never('follows the create-only Location'),
  },
  'AWS::S3Tables::Table': {
    TableARN: never('carries the table id, which a rename keeps'),
    WarehouseLocation: never('assigned at create'),
    VersionToken: never(
      'moved only by a metadata commit; a rename, namespace move, maintenance or tag edit keeps it (measured)'
    ),
  },
  'AWS::S3Tables::TableBucket': { TableBucketARN: ARN },
  'AWS::S3Vectors::VectorBucket': { VectorBucketArn: ARN, CreationTime: CREATED },
  'AWS::SNS::Subscription': { Arn: ID },
  'AWS::SNS::Topic': { TopicArn: ARN },
  'AWS::SNS::TopicPolicy': { Id: OWN_REF },
  'AWS::SQS::Queue': { Arn: ARN, QueueUrl: never('derived from the create-only QueueName') },
  'AWS::SQS::QueuePolicy': { Id: OWN_REF },
  'AWS::SSM::Parameter': { Arn: ARN },
  'AWS::Scheduler::Schedule': {
    Arn: never('built from the create-only Name and the group, whose change the update refuses'),
  },
  'AWS::SecretsManager::Secret': { Id: ID },
  'AWS::ServiceDiscovery::HttpNamespace': { Id: ID, Arn: never('derived from the namespace id') },
  'AWS::ServiceDiscovery::PrivateDnsNamespace': {
    Id: ID,
    Arn: never('derived from the namespace id'),
    HostedZoneId: never('created with the namespace'),
  },
  'AWS::ServiceDiscovery::PublicDnsNamespace': {
    Id: ID,
    Arn: never('derived from the namespace id'),
    HostedZoneId: never('created with the namespace'),
  },
  'AWS::ServiceDiscovery::Service': { Id: ID, Arn: never('derived from the service id') },
  'AWS::StepFunctions::StateMachine': {
    Arn: ARN,
    Name: never('the create-only StateMachineName'),
    StateMachineRevisionId: movedBy(
      [
        'Definition',
        'DefinitionString',
        'DefinitionS3Location',
        'DefinitionSubstitutions',
        'RoleArn',
        'LoggingConfiguration',
        'TracingConfiguration',
        'EncryptionConfiguration',
      ],
      'a changed definition, role, tracing, logging or encryption mints a revision; an identical ' +
        'update or a tag edit does not (measured); substitutions and the S3 location render into the definition'
    ),
  },
  'AWS::WAFv2::WebACL': {
    Id: ID,
    Arn: never('built from the create-only Name and Scope and the id'),
    LabelNamespace: never('built from the create-only Name'),
    Capacity: movedBy(['Rules'], 'the capacity units the rules use'),
  },
};
