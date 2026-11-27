/**
 * The FSx file system rows of `REPLACEMENT_EVIDENCE` (`./evidence.ts`),
 * measured on go-to-k/cdkd#7083. `AWS::FSx::FileSystem` has no Cloud Control
 * handlers, so every row rests on a CloudFormation A/B chain in us-east-1,
 * one property per step, a replacement read as a new file system id.
 */
import { type ReplacementEvidence, nested, replace, update } from './evidence-rows.ts';

export const FSX_FILE_SYSTEM_EVIDENCE: ReadonlyArray<readonly [string, ReplacementEvidence]> = [
  // Lustre (CopyTagsToBackups, PerUnitStorageThroughput
  // and DeploymentType on PERSISTENT_1; ImportPath, ExportPath and
  // ImportedFileChunkSize on SCRATCH_2; DriveCacheType on HDD): every member
  // below replaced the file system except PerUnitStorageThroughput (50 ->
  // 100, same id). DeploymentType PERSISTENT_1 -> PERSISTENT_2 moved
  // PerUnitStorageThroughput too (the step before showed it alone is in
  // place). ImportPath was measured alone, with no ExportPath.
  ['AWS::FSx::FileSystem#LustreConfiguration.CopyTagsToBackups', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#LustreConfiguration.DeploymentType', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#LustreConfiguration.DriveCacheType', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#LustreConfiguration.ExportPath', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#LustreConfiguration.ImportPath', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#LustreConfiguration.ImportedFileChunkSize', replace('cfn-measured', 7083)],
  [
    'AWS::FSx::FileSystem#LustreConfiguration.PerUnitStorageThroughput',
    update('cfn-measured', 7083),
  ],
  // The whole block replaces only through those members (the measured
  // replacement paths below), while the reference page reads "No
  // interruption" for it.
  ['AWS::FSx::FileSystem#LustreConfiguration', nested('cfn-measured', 7083)],
  // OpenZFS SINGLE_AZ_1 and MULTI_AZ_1: each change replaced the file system.
  // DeploymentType SINGLE_AZ_1 -> SINGLE_AZ_2 moved ThroughputCapacity too
  // (64 -> 160: the two types share no value).
  ['AWS::FSx::FileSystem#OpenZFSConfiguration.DeploymentType', replace('cfn-measured', 7083)],
  [
    'AWS::FSx::FileSystem#OpenZFSConfiguration.EndpointIpAddressRange',
    replace('cfn-measured', 7083),
  ],
  ['AWS::FSx::FileSystem#OpenZFSConfiguration.PreferredSubnetId', replace('cfn-measured', 7083)],
  [
    'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.CopyTagsToSnapshots',
    replace('cfn-measured', 7083),
  ],
  [
    'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.DataCompressionType',
    replace('cfn-measured', 7083),
  ],
  [
    'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.NfsExports',
    replace('cfn-measured', 7083),
  ],
  [
    'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.ReadOnly',
    replace('cfn-measured', 7083),
  ],
  [
    'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.RecordSizeKiB',
    replace('cfn-measured', 7083),
  ],
  [
    'AWS::FSx::FileSystem#OpenZFSConfiguration.RootVolumeConfiguration.UserAndGroupQuotas',
    replace('cfn-measured', 7083),
  ],
  ['AWS::FSx::FileSystem#OpenZFSConfiguration', nested('cfn-measured', 7083)],
  // ONTAP MULTI_AZ_1: EndpointIpAddressRange replaced the file system; a
  // PreferredSubnetId change went to the create path, whose new file system
  // failed on the endpoint range the old one still held, and rolled back.
  // DeploymentType SINGLE_AZ_1 -> SINGLE_AZ_2 (one subnet, HAPairs 1)
  // replaced it too, with ThroughputCapacityPerHAPair 128 -> 1536 (SINGLE_AZ_2
  // takes no lower value).
  ['AWS::FSx::FileSystem#OntapConfiguration.DeploymentType', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#OntapConfiguration.EndpointIpAddressRange', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#OntapConfiguration.PreferredSubnetId', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#OntapConfiguration', nested('cfn-measured', 7083)],
  // Windows SINGLE_AZ_1 / SINGLE_AZ_2 / MULTI_AZ_1, joined to throwaway
  // Managed ADs (the self-managed rows join one as self-managed, with its DNS
  // IPs and Admin user): each change replaced the file system.
  // DeploymentType SINGLE_AZ_1 -> SINGLE_AZ_2 kept the subnet; DomainName
  // moved its DnsIps with it (another directory).
  ['AWS::FSx::FileSystem#WindowsConfiguration.ActiveDirectoryId', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#WindowsConfiguration.CopyTagsToBackups', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#WindowsConfiguration.DeploymentType', replace('cfn-measured', 7083)],
  ['AWS::FSx::FileSystem#WindowsConfiguration.PreferredSubnetId', replace('cfn-measured', 7083)],
  [
    'AWS::FSx::FileSystem#WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.DomainName',
    replace('cfn-measured', 7083),
  ],
  [
    'AWS::FSx::FileSystem#WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.FileSystemAdministratorsGroup',
    replace('cfn-measured', 7083),
  ],
  [
    'AWS::FSx::FileSystem#WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.OrganizationalUnitDistinguishedName',
    replace('cfn-measured', 7083),
  ],
  ['AWS::FSx::FileSystem#WindowsConfiguration', nested('cfn-measured', 7083)],
];
