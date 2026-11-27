/**
 * The spec-replacement candidates nobody has measured yet (go-to-k/cdkd#7070):
 * `@aws-cdk/aws-service-spec` calls each a replacement while the registry
 * schema leaves it mutable, and neither a `REPLACEMENT_EVIDENCE` row nor a
 * hand rule decides it. Each keeps today's in-place update, which fails loudly
 * where AWS refuses the change and loses no data.
 *
 * The spec is not trusted on its own: on #7070, 12 of 14 probed rows updated
 * in place. To settle a row, measure it and move it into `REPLACEMENT_EVIDENCE`
 * as `replace` or `update`. `tests/unit/analyzer/replacement-evidence.test.ts`
 * fails on a candidate with no verdict and no line here, and on a line that is
 * no longer an unsettled candidate. Read by that test and the generator only.
 */
export const UNMEASURED_SPEC_REPLACEMENT_CANDIDATES: ReadonlySet<string> = new Set([
  'AWS::AppStream::StackFleetAssociation#FleetName',
  'AWS::AppStream::StackFleetAssociation#StackName',
  'AWS::Batch::ComputeEnvironment#EksConfiguration',
  'AWS::DataSync::LocationFSxLustre#Subdirectory',
  'AWS::DataSync::LocationFSxONTAP#Protocol',
  'AWS::DataSync::LocationFSxONTAP#Subdirectory',
  'AWS::DataSync::LocationFSxOpenZFS#Protocol',
  'AWS::DataSync::LocationFSxOpenZFS#Subdirectory',
  'AWS::DataSync::LocationFSxWindows#Domain',
  'AWS::DataSync::LocationFSxWindows#Password',
  'AWS::DataSync::LocationFSxWindows#Subdirectory',
  'AWS::DataSync::LocationFSxWindows#User',
  'AWS::DataSync::LocationNFS#ServerHostname',
  'AWS::DataSync::LocationObjectStorage#ServerHostname',
  'AWS::DataSync::LocationSMB#ServerHostname',
  // Measured on #7083: its mutable member, ElasticLoadBalancing, applies in
  // place with Auto Mode, and IpFamily / ServiceIpv4Cidr already replace
  // through the schema's nested create-only paths. Neither `replace` nor
  // `update` describes the whole property, so it stays here. A lone
  // ElasticLoadBalancing toggle is left unapplied by CloudFormation too
  // (UPDATE_COMPLETE on the same cluster), and cdkd refuses it (#7099).
  'AWS::EKS::Cluster#KubernetesNetworkConfig',
  'AWS::EMRServerless::Application#ImageConfiguration',
  'AWS::EMRServerless::Application#ImageConfiguration.ImageUri',
  'AWS::EMRServerless::Application#WorkerTypeSpecifications',
  'AWS::EMRServerless::Application#WorkerTypeSpecifications.*.ImageConfiguration',
  'AWS::EMRServerless::Application#WorkerTypeSpecifications.*.ImageConfiguration.ImageUri',
  // Members of NodeGroupConfiguration, whose own row is a CloudFormation-
  // measured `replace` (#7100): replacing on it already covers each of them,
  // and a member cannot be compared per element.
  'AWS::ElastiCache::ReplicationGroup#NodeGroupConfiguration.*.NodeGroupId',
  'AWS::ElastiCache::ReplicationGroup#NodeGroupConfiguration.*.PrimaryAvailabilityZone',
  'AWS::ElastiCache::ReplicationGroup#NodeGroupConfiguration.*.ReplicaAvailabilityZones',
  'AWS::ElastiCache::ReplicationGroup#NodeGroupConfiguration.*.ReplicaCount',
  'AWS::ElastiCache::ReplicationGroup#NodeGroupConfiguration.*.Slots',
  // Measured on #7083 (CloudFormation A/B): the version change (no
  // UpdatePolicy) and a KmsKeyId change each required a replacement;
  // Enabled applied in place, so the whole EncryptionAtRestOptions stays
  // here too. The `replace` / conditional rows need a fixture first (#7130).
  'AWS::Elasticsearch::Domain#ElasticsearchVersion',
  'AWS::Elasticsearch::Domain#EncryptionAtRestOptions',
  'AWS::Elasticsearch::Domain#EncryptionAtRestOptions.KmsKeyId',
  'AWS::FSx::FileSystem#LustreConfiguration.CopyTagsToBackups',
  'AWS::FSx::FileSystem#LustreConfiguration.DeploymentType',
  'AWS::FSx::FileSystem#LustreConfiguration.DriveCacheType',
  'AWS::FSx::FileSystem#LustreConfiguration.ExportPath',
  'AWS::FSx::FileSystem#LustreConfiguration.ImportPath',
  'AWS::FSx::FileSystem#LustreConfiguration.ImportedFileChunkSize',
  'AWS::FSx::FileSystem#LustreConfiguration.PerUnitStorageThroughput',
  'AWS::FSx::FileSystem#OntapConfiguration.DeploymentType',
  'AWS::FSx::FileSystem#OntapConfiguration.EndpointIpAddressRange',
  'AWS::FSx::FileSystem#OntapConfiguration.PreferredSubnetId',
  'AWS::FSx::FileSystem#OpenZFSConfiguration.DeploymentType',
  'AWS::FSx::FileSystem#OpenZFSConfiguration.EndpointIpAddressRange',
  'AWS::FSx::FileSystem#OpenZFSConfiguration.PreferredSubnetId',
  'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.CopyTagsToSnapshots',
  'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.DataCompressionType',
  'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.NfsExports',
  'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.ReadOnly',
  'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.RecordSizeKiB',
  'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.UserAndGroupQuotas',
  'AWS::FSx::FileSystem#WindowsConfiguration.ActiveDirectoryId',
  'AWS::FSx::FileSystem#WindowsConfiguration.CopyTagsToBackups',
  'AWS::FSx::FileSystem#WindowsConfiguration.DeploymentType',
  'AWS::FSx::FileSystem#WindowsConfiguration.PreferredSubnetId',
  'AWS::FSx::FileSystem#WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.DomainName',
  'AWS::FSx::FileSystem#WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.FileSystemAdministratorsGroup',
  'AWS::FSx::FileSystem#WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.OrganizationalUnitDistinguishedName',
  'AWS::HealthLake::FHIRDatastore#DatastoreName',
  'AWS::HealthLake::FHIRDatastore#IdentityProviderConfiguration',
  'AWS::ImageBuilder::Image#Tags',
  'AWS::KafkaConnect::Connector#ConnectorConfiguration',
  'AWS::KafkaConnect::Connector#Plugins',
  'AWS::KafkaConnect::Connector#WorkerConfiguration',
  // Measured on #7083 (CloudFormation A/B): the handler refuses either change
  // unless the rule's Name changes too ("requires changing the safety rule
  // name"); with a new Name it applied under a NEW rule ARN. Neither verdict
  // describes that, and Cloud Control's update was not measured.
  'AWS::Route53RecoveryControl::SafetyRule#ControlPanelArn',
  'AWS::Route53RecoveryControl::SafetyRule#RuleConfig',
  // Measured on #7083: its one member, NonFilterableMetadataKeys, is
  // create-only in the schema, so the diff replaces on it through that
  // nested path; CloudFormation replaced the index on such a change (new
  // ARN). As for EKS KubernetesNetworkConfig, neither `replace` nor `update`
  // describes the whole property, so it stays here.
  'AWS::S3Vectors::Index#MetadataConfiguration',
  'AWS::SageMaker::App#Tags',
  // Measured on #7083: Cloud Control refuses it (NotUpdatable), and
  // CloudFormation replaced on it (its named domain failed AlreadyExists).
  // The `replace` row needs a fixture first (#7126).
  'AWS::SageMaker::Domain#VpcId',
  // Measured on #7083: TtlDuration applies in place under CloudFormation, and
  // a StorageType change replaces through the schema's nested create-only
  // paths (CloudFormation: "requires replacing"). As for EKS
  // KubernetesNetworkConfig, neither verdict describes the whole property.
  'AWS::SageMaker::FeatureGroup#OnlineStoreConfig',
  'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.Framework',
  'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecifications.*.Containers.*.ImageDigest',
  'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.Framework',
  'AWS::SageMaker::ModelPackage#AdditionalInferenceSpecificationsToAdd.*.Containers.*.ImageDigest',
  'AWS::WorkSpaces::Workspace#BundleId',
  'AWS::WorkSpaces::Workspace#RootVolumeEncryptionEnabled',
  'AWS::WorkSpaces::Workspace#UserVolumeEncryptionEnabled',
  'AWS::WorkSpaces::Workspace#VolumeEncryptionKey',
]);
