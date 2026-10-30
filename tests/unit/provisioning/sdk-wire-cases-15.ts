import { describe, expect, it } from 'vite-plus/test';
import {
  ACCOUNT,
  createOnlyOf,
  record,
  setOutputOverrides,
  TAG_THROWS,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { FSxFileSystemProvider } from '../../../src/provisioning/providers/fsx-filesystem-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { NeptuneProvider } from '../../../src/provisioning/providers/neptune-provider.js';
import {
  DOCDB_CLUSTER_KEPT_ON_REMOVAL,
  DocDBProvider,
} from '../../../src/provisioning/providers/docdb-provider.js';
import { DocDBSubnetGroupProvider } from '../../../src/provisioning/providers/docdb-subnet-group-provider.js';

/**
 * The fifteenth batch of wire cases (#3723), run by
 * `sdk-wire-coverage-15.test.ts`: `FSxFileSystemProvider`, `NeptuneProvider`,
 * `DocDBProvider` and `DocDBSubnetGroupProvider`, every type each handles.
 */

/**
 * Wire cases (#3723) for `AWS::FSx::FileSystem`, the one type
 * `FSxFileSystemProvider` handles: one bag per `FileSystemType` (Windows in
 * both of its directory shapes) plus a `CreateFileSystemFromBackup` bag. The
 * Lustre bag's `LogConfiguration` probes pin go-to-k/cdkd#5430 (the block is
 * sent on create and on update); `describeFsxExtras` pins go-to-k/cdkd#5431
 * (OpenZFS `Options` reaches `DeleteFileSystem`).
 */

/**
 * A copy sharing no object with any other bag: the harness's `without` is a
 * `structuredClone`, which KEEPS shared references, so a block reused in two
 * places would lose a path in both at once.
 */
const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const SRC = 'fsx-filesystem-provider.ts';
/** The Windows bag's DNS aliases, which the armed file system holds (go-to-k/cdkd#5469). */
const WINDOWS_ALIASES = ['fs1.example.com', 'fs2.example.com'];
const FS_ID = 'fs-0123456789abcdef0';
const FS_ARN = `arn:aws:fsx:us-east-1:${ACCOUNT}:file-system/${FS_ID}`;
const TYPE = 'AWS::FSx::FileSystem';
const KMS_KEY = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k`;
const LOG_GROUP = `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/fsx/x`;
const SECRET = `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:ad-AbCdEf`;
const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

/**
 * The live file system: AVAILABLE with no administrative action on every
 * `DescribeFileSystems`, so the create wait and the update-action wait settle
 * on their first poll, and carrying the ARN the tag calls need. A create is
 * answered with a file system created AFTER this create's first send, so the
 * token-ownership gate (${SRC}:871-897) takes it.
 */
function armFs(): void {
  const created = () => ({
    FileSystem: { FileSystemId: FS_ID, CreationTime: new Date(Date.now() + 3_600_000) },
  });
  // The file system's DNS aliases (go-to-k/cdkd#5469), holding the Windows
  // bag's: an associate settles AVAILABLE and a disassociate removes the name
  // at once, so update()'s alias waits settle on their first read. As on AWS,
  // disassociating a name that is not associated is a 400.
  const aliases = new Set<string>(WINDOWS_ALIASES);
  const names = (input: Record<string, unknown>): string[] => input['Aliases'] as string[];
  setOutputOverrides({
    AssociateFileSystemAliasesCommand: (input) => {
      names(input).forEach((n) => aliases.add(n));
      return {};
    },
    DisassociateFileSystemAliasesCommand: (input) => {
      const absent = names(input).filter((n) => !aliases.has(n));
      if (absent.length > 0) {
        throw Object.assign(new Error(`aliases not associated: ${absent.join(', ')}`), {
          name: 'BadRequest',
        });
      }
      names(input).forEach((n) => aliases.delete(n));
      return {};
    },
    DescribeFileSystemAliasesCommand: () => ({
      Aliases: [...aliases].map((Name) => ({ Name, Lifecycle: 'AVAILABLE' })),
    }),
    CreateFileSystemCommand: created,
    CreateFileSystemFromBackupCommand: created,
    DescribeFileSystemsCommand: () => ({
      FileSystems: [
        {
          FileSystemId: FS_ID,
          ResourceARN: FS_ARN,
          Lifecycle: 'AVAILABLE',
          AdministrativeActions: [],
        },
      ],
    }),
  });
}

/**
 * Variant sub-properties outside the `UpdateFileSystem` mutable sets
 * (${SRC}:91-169): the schema marks none create-only, but `update()` refuses
 * any change to one before any call with a `--replace` pointer
 * (`ResourceUpdateNotSupportedError`, ${SRC}:1570-1576). Marked create-only
 * here so the update probes skip them, as the engine's `--replace` would;
 * `describeFsxExtras` pins the refusal.
 */
const VARIANT_REFUSED: Record<string, readonly string[]> = {
  LustreConfiguration: [
    'CopyTagsToBackups',
    'DeploymentType',
    'DriveCacheType',
    'EfaEnabled',
    'ExportPath',
    'ImportPath',
    'ImportedFileChunkSize',
  ],
  // go-to-k/cdkd#5469: CloudFormation documents ActiveDirectoryId and
  // PreferredSubnetId "No interruption", but no FSx API changes either, so
  // they stay refused. Aliases is not here: it changes in place through
  // Associate/DisassociateFileSystemAliases.
  WindowsConfiguration: [
    'ActiveDirectoryId',
    'CopyTagsToBackups',
    'DeploymentType',
    'PreferredSubnetId',
  ],
  OntapConfiguration: ['DeploymentType', 'EndpointIpAddressRange', 'PreferredSubnetId'],
  OpenZFSConfiguration: [
    'DeploymentType',
    'EndpointIpAddressRange',
    'PreferredSubnetId',
    'RootVolumeConfiguration',
  ],
};
const UPDATE_REFUSED = Object.entries(VARIANT_REFUSED).flatMap(([block, keys]) =>
  keys.map((k) => `${block}.${k}`)
);

const COMMON = {
  SubnetIds: ['subnet-1', 'subnet-2'],
  SecurityGroupIds: ['sg-1', 'sg-2'],
  KmsKeyId: KMS_KEY,
};

/**
 * A union of every Lustre member, so not a shape AWS accepts: SSD storage beside
 * the INTELLIGENT_TIERING-only ThroughputCapacity and DataReadCacheConfiguration.
 */
const LUSTRE_BAG: Bag = {
  FileSystemType: 'LUSTRE',
  ...fresh(COMMON),
  StorageType: 'SSD',
  StorageCapacity: 1200,
  FileSystemTypeVersion: '2.15',
  NetworkType: 'IPV4',
  LustreConfiguration: {
    DeploymentType: 'PERSISTENT_2',
    PerUnitStorageThroughput: 125,
    WeeklyMaintenanceStartTime: '1:05:00',
    DailyAutomaticBackupStartTime: '05:00',
    AutomaticBackupRetentionDays: 3,
    CopyTagsToBackups: true,
    ImportPath: 's3://bucket/in',
    ExportPath: 's3://bucket/out',
    ImportedFileChunkSize: 1024,
    AutoImportPolicy: 'NEW',
    DriveCacheType: 'READ',
    DataCompressionType: 'LZ4',
    EfaEnabled: true,
    ThroughputCapacity: 4000,
    MetadataConfiguration: { Mode: 'USER_PROVISIONED', Iops: 3000 },
    DataReadCacheConfiguration: { SizingMode: 'USER_PROVISIONED', SizeGiB: 32 },
    LogConfiguration: { Level: 'WARN_ERROR', Destination: LOG_GROUP },
  },
  Tags: fresh(TAGS),
};

const DISK_IOPS = { Mode: 'USER_PROVISIONED', Iops: 3000 };

const WINDOWS_MANAGED_AD_BAG: Bag = {
  FileSystemType: 'WINDOWS',
  ...fresh(COMMON),
  StorageType: 'SSD',
  StorageCapacity: 32,
  WindowsConfiguration: {
    ActiveDirectoryId: 'd-1234567890',
    DeploymentType: 'MULTI_AZ_1',
    PreferredSubnetId: 'subnet-1',
    ThroughputCapacity: 32,
    WeeklyMaintenanceStartTime: '1:05:00',
    DailyAutomaticBackupStartTime: '05:00',
    AutomaticBackupRetentionDays: 7,
    CopyTagsToBackups: true,
    Aliases: [...WINDOWS_ALIASES],
    AuditLogConfiguration: {
      FileAccessAuditLogLevel: 'SUCCESS_AND_FAILURE',
      FileShareAccessAuditLogLevel: 'FAILURE_ONLY',
      AuditLogDestination: LOG_GROUP,
    },
    DiskIopsConfiguration: fresh(DISK_IOPS),
    FsrmConfiguration: { FsrmServiceEnabled: true, EventLogDestination: LOG_GROUP },
  },
};

const WINDOWS_SELF_MANAGED_AD_BAG: Bag = {
  FileSystemType: 'WINDOWS',
  SubnetIds: ['subnet-1'],
  WindowsConfiguration: {
    DeploymentType: 'SINGLE_AZ_2',
    ThroughputCapacity: 32,
    SelfManagedActiveDirectoryConfiguration: {
      DomainName: 'corp.example.com',
      OrganizationalUnitDistinguishedName: 'OU=fsx,DC=corp,DC=example,DC=com',
      FileSystemAdministratorsGroup: 'FSxAdmins',
      UserName: 'svc',
      Password: 'secret',
      DnsIps: ['10.0.0.1', '10.0.0.2'],
      DomainJoinServiceAccountSecret: SECRET,
    },
  },
};

const ONTAP_BAG: Bag = {
  FileSystemType: 'ONTAP',
  ...fresh(COMMON),
  StorageCapacity: 1024,
  OntapConfiguration: {
    DeploymentType: 'MULTI_AZ_2',
    PreferredSubnetId: 'subnet-1',
    EndpointIpAddressRange: '198.19.0.0/24',
    EndpointIpv6AddressRange: 'fd00::/118',
    FsxAdminPassword: 'admin-pass',
    AutomaticBackupRetentionDays: 7,
    DailyAutomaticBackupStartTime: '05:00',
    WeeklyMaintenanceStartTime: '1:05:00',
    DiskIopsConfiguration: fresh(DISK_IOPS),
    RouteTableIds: ['rtb-1', 'rtb-2'],
    ThroughputCapacity: 384,
    ThroughputCapacityPerHAPair: 384,
    HAPairs: 1,
  },
};

/**
 * A union of every OpenZFS member, so not a shape AWS accepts: SSD storage beside
 * the INTELLIGENT_TIERING-only ReadCacheConfiguration.
 */
const OPENZFS_BAG: Bag = {
  FileSystemType: 'OPENZFS',
  ...fresh(COMMON),
  StorageType: 'SSD',
  StorageCapacity: 64,
  NetworkType: 'DUAL',
  OpenZFSConfiguration: {
    DeploymentType: 'MULTI_AZ_1',
    PreferredSubnetId: 'subnet-1',
    EndpointIpAddressRange: '198.19.0.0/24',
    EndpointIpv6AddressRange: 'fd00::/118',
    ThroughputCapacity: 320,
    AutomaticBackupRetentionDays: 7,
    CopyTagsToBackups: true,
    CopyTagsToVolumes: true,
    DailyAutomaticBackupStartTime: '05:00',
    WeeklyMaintenanceStartTime: '1:05:00',
    DiskIopsConfiguration: fresh(DISK_IOPS),
    RouteTableIds: ['rtb-1', 'rtb-2'],
    ReadCacheConfiguration: { SizingMode: 'USER_PROVISIONED', SizeGiB: 128 },
    Options: ['DELETE_CHILD_VOLUMES_AND_SNAPSHOTS'],
    RootVolumeConfiguration: {
      RecordSizeKiB: 128,
      DataCompressionType: 'LZ4',
      CopyTagsToSnapshots: true,
      ReadOnly: false,
      NfsExports: [{ ClientConfigurations: [{ Clients: '*', Options: ['rw', 'crossmnt'] }] }],
      UserAndGroupQuotas: [{ Type: 'USER', Id: 1001, StorageCapacityQuotaGiB: 10 }],
    },
  },
};

/** `CreateFileSystemFromBackup`: no `OntapConfiguration` member, so a Lustre backup. */
const FROM_BACKUP_BAG: Bag = {
  BackupId: 'backup-0123456789abcdef0',
  FileSystemType: 'LUSTRE',
  ...fresh(COMMON),
  StorageType: 'SSD',
  StorageCapacity: 1200,
  FileSystemTypeVersion: '2.15',
  NetworkType: 'IPV4',
  LustreConfiguration: { DeploymentType: 'PERSISTENT_2', PerUnitStorageThroughput: 125 },
};

/**
 * A mutable member REMOVED from the template (issue #1160): `UpdateFileSystem`
 * keeps a field it is not sent and none of these has a safe constant reset, so
 * `update()` sends nothing for it and names it in its own warning
 * (${SRC}:254-270, 1296-1301, 1356-1361, 1577-1580).
 */
const LEFT_IN_PLACE = (name: string, measured: string): string =>
  `left in place with a warning naming ${name} (issue #1160, ${SRC}:254-270, 1296-1301, 1356-1361, 1577-1580): ${measured}`;
const CFN_KEEPS = `CloudFormation keeps the value too (CFn A/B, ${SRC}:272-330)`;
/** Measured kept by CloudFormation only on `shape` (${SRC}:368-431); a union bag is not that shape, so `update()` warns with the unmeasured line (${SRC}:492-494). */
const CFN_KEEPS_OTHER_SHAPE = (shape: string): string =>
  `CloudFormation keeps the value only on the measured shape (${shape}; CFn A/B, ${SRC}:368-431); this bag is not that shape, so the warning claims nothing about CloudFormation (${SRC}:492-494)`;
const CFN_UNMEASURED = `CFn unmeasured, so the warning claims nothing about CloudFormation (${SRC}:293-296, 492-494)`;

const leftInPlace = (
  entries: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(entries).map(([name, measured]) => [
      `update-remove:${name}`,
      LEFT_IN_PLACE(name, measured),
    ])
  );

/**
 * Harness mechanics, not delivery: `update-vary` of a scalar DIRECTLY under a
 * variant block diffs against a previous side lacking the WHOLE block, so the
 * block's update-refused members (`VARIANT_REFUSED`) change too and
 * `update()` refuses both sides before any call (${SRC}:1570-1576). The
 * value reaches the wire on update through `update-add` and on create through
 * `create-vary`.
 */
const blockVary = (block: string, keys: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    keys.map((k) => [
      `update-vary:${block}.${k}`,
      `the varied update's previous side lacks the whole ${block}, so whichever of its update-refused members (${VARIANT_REFUSED[block]!.join(', ')}) the bag declares change as well and update() refuses both sides before any call (${SRC}:1570-1576); the value is observed by update-add and create-vary`,
    ])
  );

const UNSUPPORTED_TYPE: Throw = {
  why: `create() refuses a create with no FileSystemType (and no BackupId) before any call (${SRC}:740-755)`,
  says: /FileSystemType '\(unset\)' is not supported by cdkd/,
};

const OPTIONS_DELETE_ONLY = `OpenZFSConfiguration.Options is a DeleteFileSystem option, not a create or update input (CFn "Update requires: No interruption"): create() never sends it and update() skips it, so a change only lands in the record delete() reads (go-to-k/cdkd#5431, ${SRC}:1566-1569, 1840-1853, 1904-1918); describeFsxExtras pins the delete`;

const FSX_CASE: TypeCase = {
  resourceType: TYPE,
  provider: () => new FSxFileSystemProvider({ pollIntervalMs: 0 }),
  physicalId: FS_ID,
  createOnly: new Set([...createOnlyOf(TYPE), ...UPDATE_REFUSED]),
  arm: armFs,
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'UntagResourceCommand', names: '"k1"', notNames: '"k2"' },
    { path: ['Tags', 1], command: 'UntagResourceCommand', names: '"k2"', notNames: '"k1"' },
  ],
  bags: [
    {
      name: 'LUSTRE',
      bag: fresh(LUSTRE_BAG),
      variants: { FileSystemType: 'OPENZFS' },
      expectedSilent: {
        ...leftInPlace({
          StorageCapacity: CFN_KEEPS,
          StorageType: CFN_KEEPS,
          FileSystemTypeVersion: CFN_KEEPS,
          NetworkType: CFN_UNMEASURED,
          'LustreConfiguration.PerUnitStorageThroughput': CFN_KEEPS,
          'LustreConfiguration.WeeklyMaintenanceStartTime': CFN_KEEPS,
          'LustreConfiguration.DailyAutomaticBackupStartTime': CFN_KEEPS,
          'LustreConfiguration.AutomaticBackupRetentionDays': CFN_KEEPS,
          'LustreConfiguration.AutoImportPolicy': CFN_KEEPS,
          'LustreConfiguration.DataCompressionType': CFN_KEEPS,
          'LustreConfiguration.MetadataConfiguration': CFN_KEEPS,
          'LustreConfiguration.ThroughputCapacity': CFN_KEEPS_OTHER_SHAPE('INTELLIGENT_TIERING storage on both sides'),
          'LustreConfiguration.DataReadCacheConfiguration': CFN_KEEPS_OTHER_SHAPE('INTELLIGENT_TIERING storage on both sides'),
          'LustreConfiguration.LogConfiguration': `${CFN_UNMEASURED}; go-to-k/cdkd#5430 (${SRC}:106-110)`,
        }),
        ...blockVary('LustreConfiguration', [
          'AutoImportPolicy',
          'AutomaticBackupRetentionDays',
          'DailyAutomaticBackupStartTime',
          'DataCompressionType',
          'PerUnitStorageThroughput',
          'ThroughputCapacity',
          'WeeklyMaintenanceStartTime',
        ]),
      },
      expectedRemovalThrows: {
        'create:FileSystemType': UNSUPPORTED_TYPE,
        ...TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
      },
    },
    {
      name: 'WINDOWS, AWS managed AD',
      bag: fresh(WINDOWS_MANAGED_AD_BAG),
      variants: { FileSystemType: 'OPENZFS' },
      expectedSilent: {
        ...leftInPlace({
          StorageCapacity: CFN_UNMEASURED,
          StorageType: CFN_UNMEASURED,
          'WindowsConfiguration.ThroughputCapacity': CFN_UNMEASURED,
          'WindowsConfiguration.WeeklyMaintenanceStartTime': CFN_UNMEASURED,
          'WindowsConfiguration.DailyAutomaticBackupStartTime': CFN_UNMEASURED,
          'WindowsConfiguration.AutomaticBackupRetentionDays': CFN_UNMEASURED,
          'WindowsConfiguration.AuditLogConfiguration': CFN_UNMEASURED,
          'WindowsConfiguration.DiskIopsConfiguration': CFN_UNMEASURED,
          'WindowsConfiguration.FsrmConfiguration': CFN_UNMEASURED,
        }),
        ...blockVary('WindowsConfiguration', [
          'AutomaticBackupRetentionDays',
          'DailyAutomaticBackupStartTime',
          'ThroughputCapacity',
          'WeeklyMaintenanceStartTime',
        ]),
        ...Object.fromEntries(
          ['Aliases', 'Aliases.0', 'Aliases.1'].map((p) => [
            `update-add:WindowsConfiguration.${p}`,
            `the armed file system already holds the bag's aliases (WINDOWS_ALIASES), and update() reconciles its Associate against the live aliases (go-to-k/cdkd#5469), so re-adding one sends nothing; a NEW name reaches AssociateFileSystemAliases through update-vary:WindowsConfiguration.Aliases.N and on create through create-vary`,
          ])
        ),
      },
      expectedRemovalThrows: { 'create:FileSystemType': UNSUPPORTED_TYPE },
    },
    {
      name: 'WINDOWS, self-managed AD',
      bag: fresh(WINDOWS_SELF_MANAGED_AD_BAG),
      variants: { FileSystemType: 'OPENZFS' },
      expectedSilent: {
        ...leftInPlace({
          'WindowsConfiguration.ThroughputCapacity': CFN_UNMEASURED,
          'WindowsConfiguration.SelfManagedActiveDirectoryConfiguration': CFN_UNMEASURED,
        }),
        ...blockVary('WindowsConfiguration', ['ThroughputCapacity']),
      },
      expectedRemovalThrows: { 'create:FileSystemType': UNSUPPORTED_TYPE },
    },
    {
      name: 'ONTAP',
      bag: fresh(ONTAP_BAG),
      variants: { FileSystemType: 'OPENZFS' },
      expectedSilent: {
        ...leftInPlace({
          StorageCapacity: CFN_UNMEASURED,
          'OntapConfiguration.EndpointIpv6AddressRange': CFN_UNMEASURED,
          'OntapConfiguration.FsxAdminPassword': CFN_UNMEASURED,
          'OntapConfiguration.AutomaticBackupRetentionDays': CFN_UNMEASURED,
          'OntapConfiguration.DailyAutomaticBackupStartTime': CFN_UNMEASURED,
          'OntapConfiguration.WeeklyMaintenanceStartTime': CFN_UNMEASURED,
          'OntapConfiguration.DiskIopsConfiguration': CFN_UNMEASURED,
          'OntapConfiguration.ThroughputCapacity': CFN_UNMEASURED,
          'OntapConfiguration.ThroughputCapacityPerHAPair': CFN_UNMEASURED,
          'OntapConfiguration.HAPairs': CFN_UNMEASURED,
        }),
        ...blockVary('OntapConfiguration', [
          'AutomaticBackupRetentionDays',
          'DailyAutomaticBackupStartTime',
          'EndpointIpv6AddressRange',
          'FsxAdminPassword',
          'HAPairs',
          'ThroughputCapacity',
          'ThroughputCapacityPerHAPair',
          'WeeklyMaintenanceStartTime',
        ]),
      },
      expectedRemovalThrows: { 'create:FileSystemType': UNSUPPORTED_TYPE },
    },
    {
      name: 'OPENZFS',
      bag: fresh(OPENZFS_BAG),
      variants: { FileSystemType: 'LUSTRE' },
      expectedSilent: {
        ...leftInPlace({
          StorageCapacity: CFN_KEEPS,
          StorageType: CFN_KEEPS,
          NetworkType: `CloudFormation refuses this removal on this bag's shape (MULTI_AZ_1 with EndpointIpv6AddressRange still declared, ${SRC}:433-443); cdkd leaves it in place`,
          'OpenZFSConfiguration.EndpointIpv6AddressRange': CFN_KEEPS_OTHER_SHAPE('NetworkType removed in the same deploy'),
          'OpenZFSConfiguration.ThroughputCapacity': CFN_KEEPS_OTHER_SHAPE('a NetworkType other than DUAL'),
          'OpenZFSConfiguration.AutomaticBackupRetentionDays': CFN_KEEPS,
          'OpenZFSConfiguration.CopyTagsToBackups': CFN_KEEPS,
          'OpenZFSConfiguration.CopyTagsToVolumes': CFN_KEEPS,
          'OpenZFSConfiguration.DailyAutomaticBackupStartTime': CFN_KEEPS,
          'OpenZFSConfiguration.WeeklyMaintenanceStartTime': CFN_KEEPS,
          'OpenZFSConfiguration.DiskIopsConfiguration': CFN_KEEPS,
          'OpenZFSConfiguration.ReadCacheConfiguration': CFN_KEEPS_OTHER_SHAPE('INTELLIGENT_TIERING storage'),
        }),
        ...blockVary('OpenZFSConfiguration', [
          'AutomaticBackupRetentionDays',
          'CopyTagsToBackups',
          'CopyTagsToVolumes',
          'DailyAutomaticBackupStartTime',
          'EndpointIpv6AddressRange',
          'ThroughputCapacity',
          'WeeklyMaintenanceStartTime',
        ]),
        'create:OpenZFSConfiguration.Options': OPTIONS_DELETE_ONLY,
        'create:OpenZFSConfiguration.Options.0': OPTIONS_DELETE_ONLY,
        'create-vary:OpenZFSConfiguration.Options.0': OPTIONS_DELETE_ONLY,
        'update-add:OpenZFSConfiguration.Options': OPTIONS_DELETE_ONLY,
        'update-remove:OpenZFSConfiguration.Options': OPTIONS_DELETE_ONLY,
        'update-add:OpenZFSConfiguration.Options.0': OPTIONS_DELETE_ONLY,
        'update-remove:OpenZFSConfiguration.Options.0': OPTIONS_DELETE_ONLY,
        'update-vary:OpenZFSConfiguration.Options.0': OPTIONS_DELETE_ONLY,
      },
      expectedRemovalThrows: { 'create:FileSystemType': UNSUPPORTED_TYPE },
    },
    {
      name: 'LUSTRE from a backup',
      bag: fresh(FROM_BACKUP_BAG),
      variants: { FileSystemType: 'OPENZFS' },
      expectedSilent: {
        ...leftInPlace({
          StorageCapacity: CFN_KEEPS,
          StorageType: CFN_KEEPS,
          FileSystemTypeVersion: CFN_KEEPS,
          NetworkType: CFN_UNMEASURED,
          'LustreConfiguration.PerUnitStorageThroughput': CFN_KEEPS,
        }),
        ...blockVary('LustreConfiguration', ['PerUnitStorageThroughput']),
      },
    },
  ],
};

// --- Neptune ------------------------------------------------------------------

/**
 * Wire cases (#3723) for `NeptuneProvider`: `AWS::Neptune::DBSubnetGroup`,
 * `AWS::Neptune::DBCluster` and `AWS::Neptune::DBInstance`. The provider
 * builds its own Neptune clients (a create client among them) and, for a
 * removed cluster `VpcSecurityGroupIds`, an EC2 client, so the test mocks
 * both packages.
 */

const NEPTUNE_SRC = 'neptune-provider.ts';
const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];
const NEPTUNE_TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];
const KMS = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k1`;
const NEPTUNE_SUBNET_GROUP = 'subnets';
const SUBNET_GROUP_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:subgrp:${NEPTUNE_SUBNET_GROUP}`;
const NEPTUNE_CLUSTER_ID = 'cluster-1';
const NEPTUNE_CLUSTER_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:${NEPTUNE_CLUSTER_ID}`;
const NEPTUNE_INSTANCE_ID = 'instance-1';
const INSTANCE_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:db:${NEPTUNE_INSTANCE_ID}`;
const DEFAULT_SG = 'sg-default';

/** A Modify* call that only sends what `next` declares: a removal sends nothing. */
const KEPT_5004 = (key: string): string =>
  `left in place on removal: Modify* treats an absent member as "no change", and a CloudFormation A/B (#5004) measured a removed ${key} KEPT (${NEPTUNE_SRC}:164-173, 677-682)`;

// --- AWS::Neptune::DBSubnetGroup -----------------------------------------------

/** DescribeDBSubnetGroups answers the group's ARN (the tag diff's target) and its VPC. */
function neptuneArmSubnetGroup(): void {
  setOutputOverrides({
    DescribeDBSubnetGroupsCommand: () => ({
      DBSubnetGroups: [{ DBSubnetGroupArn: SUBNET_GROUP_ARN, VpcId: 'vpc-1' }],
    }),
  });
}

const NEPTUNE_SUBNET_GROUP_CASE: TypeCase = {
  resourceType: 'AWS::Neptune::DBSubnetGroup',
  provider: () => new NeptuneProvider(),
  physicalId: NEPTUNE_SUBNET_GROUP,
  createOnly: createOnlyOf('AWS::Neptune::DBSubnetGroup'),
  arm: () => neptuneArmSubnetGroup(),
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'RemoveTagsFromResourceCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'RemoveTagsFromResourceCommand', names: 'k2', notNames: 'k1' },
    // ModifyDBSubnetGroup sends the whole desired list (form-encoded).
    {
      path: ['SubnetIds', 0],
      command: 'ModifyDBSubnetGroupCommand',
      names: '=subnet-2',
      notNames: '=subnet-1',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        DBSubnetGroupName: NEPTUNE_SUBNET_GROUP,
        DBSubnetGroupDescription: 'neptune subnets',
        SubnetIds: ['subnet-1', 'subnet-2'],
        Tags: fresh(NEPTUNE_TAGS),
      },
      expectedSilent: {
        'update-remove:SubnetIds':
          `SubnetIds is required by the schema (#top required), so no deployable template removes it; update() sends only a declared non-empty list (${NEPTUNE_SRC}:437-442, 456)`,
        ...Object.fromEntries(
          [0, 1].map((i) => [
            `update-remove:SubnetIds.${i}`,
            `ModifyDBSubnetGroup sends the WHOLE desired list from next, never reading prev, so an element removal is delivered by next alone (update-add observes it; ${NEPTUNE_SRC}:441-456)`,
          ])
        ),
      },
      expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
    },
  ],
};

// --- AWS::Neptune::DBCluster -----------------------------------------------------

/**
 * DescribeDBClusters answers the cluster `available` with the security groups
 * the last ModifyDBCluster sent (the bag's own before any), all `active`, so
 * the create wait and the security-group wait (`waitForSecurityGroupsApplied`)
 * both settle on their first poll. DescribeDBSubnetGroups / EC2's
 * DescribeSecurityGroups answer the VPC's default group a removed
 * `VpcSecurityGroupIds` falls back to.
 */
function neptuneArmCluster(_physicalId: string, bag: Bag): void {
  let groups = (bag['VpcSecurityGroupIds'] as string[] | undefined) ?? [];
  setOutputOverrides({
    ModifyDBClusterCommand: (input) => {
      const sent = input['VpcSecurityGroupIds'] as string[] | undefined;
      if (sent !== undefined) groups = sent;
      return {};
    },
    DescribeDBClustersCommand: () => ({
      DBClusters: [
        {
          DBClusterIdentifier: NEPTUNE_CLUSTER_ID,
          DBClusterArn: NEPTUNE_CLUSTER_ARN,
          Status: 'available',
          DBSubnetGroup: NEPTUNE_SUBNET_GROUP,
          DBClusterMembers: [],
          VpcSecurityGroups: groups.map((id) => ({ VpcSecurityGroupId: id, Status: 'active' })),
        },
      ],
    }),
    DescribeDBSubnetGroupsCommand: () => ({
      DBSubnetGroups: [{ DBSubnetGroupArn: SUBNET_GROUP_ARN, VpcId: 'vpc-1' }],
    }),
    DescribeSecurityGroupsCommand: () => ({ SecurityGroups: [{ GroupId: DEFAULT_SG }] }),
  });
}

/**
 * `Port` is read-only in the schema (`readOnlyProperties`), but older CDK
 * emits it; both create and update send `DBPort` when declared and fall back
 * to `Port` only without it (${NEPTUNE_SRC}:572-580, 722-727). Beside `DBPort`,
 * `Port` therefore never reaches the wire, by design.
 */
const PORT_SHADOWED = `DBPort wins when both are declared: Port is read-only in the schema and only a fallback for older CDK output (${NEPTUNE_SRC}:572-580, 722-727)`;

/** A port removal sends nothing: CloudFormation keeps the live port (#1160 A/B, 8183 stayed 8183). */
const PORT_KEPT = `left in place on removal: a CloudFormation A/B (#1160) showed a removed DBPort KEEPS the live port, so update() sends no reset (${NEPTUNE_SRC}:693-696)`;

const NEPTUNE_CLUSTER_CASE: TypeCase = {
  resourceType: 'AWS::Neptune::DBCluster',
  provider: () => new NeptuneProvider(),
  physicalId: NEPTUNE_CLUSTER_ID,
  createOnly: createOnlyOf('AWS::Neptune::DBCluster'),
  arm: neptuneArmCluster,
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'RemoveTagsFromResourceCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'RemoveTagsFromResourceCommand', names: 'k2', notNames: 'k1' },
    // ModifyDBCluster sends the whole desired list (form-encoded).
    {
      path: ['VpcSecurityGroupIds', 0],
      command: 'ModifyDBClusterCommand',
      names: '=sg-2',
      notNames: '=sg-1',
    },
  ],
  bags: [
    {
      name: 'every property, DBPort',
      bag: {
        DBClusterIdentifier: NEPTUNE_CLUSTER_ID,
        EngineVersion: '1.3.2.0',
        DBPort: 8183,
        VpcSecurityGroupIds: ['sg-1', 'sg-2'],
        DBSubnetGroupName: NEPTUNE_SUBNET_GROUP,
        StorageEncrypted: true,
        KmsKeyId: KMS,
        BackupRetentionPeriod: 7,
        PreferredBackupWindow: '03:00-04:00',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        DBClusterParameterGroupName: 'cluster-params',
        IamAuthEnabled: true,
        DeletionProtection: true,
        Tags: fresh(NEPTUNE_TAGS),
      },
      expectedSilent: {
        'update-remove:DBPort': PORT_KEPT,
        'update-remove:BackupRetentionPeriod': KEPT_5004('BackupRetentionPeriod'),
        'update-remove:IamAuthEnabled': KEPT_5004('IamAuthEnabled'),
        'update-remove:DeletionProtection': KEPT_5004('DeletionProtection'),
        'update-remove:EngineVersion': `deliberately not reset on removal: that would mean moving to the engine's default version, a possibly major upgrade cdkd must not synthesize (${NEPTUNE_SRC}:683-685)`,
        'update-remove:DBClusterParameterGroupName': `deliberately not reset on removal: the default is the engine-version-dependent default.neptune1.x family, and synthesizing it risks a wrong-family apply (${NEPTUNE_SRC}:686-688)`,
        ...Object.fromEntries(
          ['PreferredBackupWindow', 'PreferredMaintenanceWindow'].map((key) => [
            `update-remove:${key}`,
            `not reset on removal: AWS assigns a RANDOM window at create and documents no reset-to-random sentinel, so the API cannot restore it (${NEPTUNE_SRC}:689-692)`,
          ])
        ),
        ...Object.fromEntries(
          [0, 1].map((i) => [
            `update-remove:VpcSecurityGroupIds.${i}`,
            `ModifyDBCluster sends the WHOLE desired list from next (${NEPTUNE_SRC}:1535-1536), so an element removal is delivered by next alone (update-add observes it); only a whole-list removal reads prev (the VPC default group, :1537-1605)`,
          ])
        ),
      },
      expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
    },
    {
      // The pair as one template could declare it: which one reaches the wire.
      name: 'DBPort and Port both declared',
      bag: { DBPort: 8183, Port: 8184 },
      expectedSilent: {
        'create:Port': PORT_SHADOWED,
        'create-vary:Port': PORT_SHADOWED,
        'update-add:Port': PORT_SHADOWED,
        'update-remove:Port': PORT_SHADOWED,
        'update-vary:Port': PORT_SHADOWED,
        'update-remove:DBPort': `removing DBPort falls back to the declared Port, which update() sends from next (${NEPTUNE_SRC}:722-727), so no DBPort reset is due`,
      },
    },
    {
      name: 'Port only (older CDK output)',
      bag: { Port: 8184 },
      expectedSilent: {
        'update-remove:Port': PORT_KEPT,
      },
    },
  ],
};

// --- AWS::Neptune::DBInstance ----------------------------------------------------

/** DescribeDBInstances answers the instance available with its ARN: the create wait settles at once. */
function neptuneArmInstance(): void {
  setOutputOverrides({
    DescribeDBInstancesCommand: () => ({
      DBInstances: [
        {
          DBInstanceIdentifier: NEPTUNE_INSTANCE_ID,
          DBInstanceArn: INSTANCE_ARN,
          DBInstanceStatus: 'available',
        },
      ],
    }),
  });
}

const NEPTUNE_INSTANCE_CASE: TypeCase = {
  resourceType: 'AWS::Neptune::DBInstance',
  provider: () => new NeptuneProvider(),
  physicalId: NEPTUNE_INSTANCE_ID,
  createOnly: createOnlyOf('AWS::Neptune::DBInstance'),
  arm: () => neptuneArmInstance(),
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'RemoveTagsFromResourceCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'RemoveTagsFromResourceCommand', names: 'k2', notNames: 'k1' },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        DBInstanceIdentifier: NEPTUNE_INSTANCE_ID,
        DBInstanceClass: 'db.r5.large',
        DBClusterIdentifier: NEPTUNE_CLUSTER_ID,
        DBSubnetGroupName: NEPTUNE_SUBNET_GROUP,
        DBParameterGroupName: 'instance-params',
        AvailabilityZone: 'us-east-1a',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        AutoMinorVersionUpgrade: true,
        DeletionProtection: true,
        Tags: fresh(NEPTUNE_TAGS),
      },
      expectedSilent: {
        'update-remove:DBInstanceClass': `DBInstanceClass is required by the schema (#top required), so no deployable template removes it; update() sends only a declared value (${NEPTUNE_SRC}:1081)`,
        'update-remove:AutoMinorVersionUpgrade': KEPT_5004('AutoMinorVersionUpgrade'),
        'update-remove:DeletionProtection': `not a CloudFormation property of AWS::Neptune::DBInstance (#5004), so never reset on removal; the pass-through is kept as is (${NEPTUNE_SRC}:169-172, 1089-1090)`,
        'update-remove:DBParameterGroupName': `deliberately not reset on removal: the default is the engine-version-dependent default.neptune1.x family, and synthesizing it risks a wrong-family apply (${NEPTUNE_SRC}:1069-1071)`,
        'update-remove:PreferredMaintenanceWindow': `not reset on removal: AWS assigns a RANDOM window at create and documents no reset-to-random sentinel (${NEPTUNE_SRC}:1072-1073)`,
      },
      expectedRemovalThrows: TAG_THROWS(ALL_DIRECTIONS, 2),
    },
  ],
};

// --- DocumentDB ---------------------------------------------------------------

/**
 * Wire cases (#3723) for the DocumentDB providers: `DocDBProvider`
 * (`AWS::DocDB::DBCluster`, `AWS::DocDB::DBInstance`) and
 * `DocDBSubnetGroupProvider` (`AWS::DocDB::DBSubnetGroup`).
 */

const DOCDB_SRC = 'docdb-provider.ts';
const SUBNET_SRC = 'docdb-subnet-group-provider.ts';

const DOCDB_TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

/** Every Tags entry without its Key or Value is refused before any call (go-to-k/cdkd#3994). */
const TAG_REFUSALS = TAG_THROWS(['create', 'update-add', 'update-remove'], 2);

const TAG_TARGET = {
  path: ['Tags', 0],
  command: 'RemoveTagsFromResourceCommand',
  names: 'k1',
  notNames: 'k2',
};

// --- AWS::DocDB::DBCluster -----------------------------------------------------

const DOCDB_CLUSTER_ID = 'docdb-cluster';
const DOCDB_CLUSTER_ARN = `arn:aws:rds:us-east-1:${ACCOUNT}:cluster:${DOCDB_CLUSTER_ID}`;

/**
 * DescribeDBClusters answers the live cluster: `available`, the bag's port and
 * groups (all `active`), and its ARN, so the create wait returns on its first
 * poll and the tag diff has an ARN. An update that SENDS a new Port or group
 * list is answered as applied (the value the ModifyDBCluster just carried),
 * so `waitForClusterPortApplied` / `waitForSecurityGroupsApplied`
 * (docdb-provider.ts) settle on their first poll too. No member instances, so
 * the member waits have nothing to poll.
 */
function docdbArmCluster(_physicalId: string, bag: Bag): void {
  let sentPort: number | undefined;
  let sentGroups: string[] | undefined;
  setOutputOverrides({
    ModifyDBClusterCommand: (input) => {
      if (input['Port'] !== undefined) sentPort = input['Port'] as number;
      if (input['VpcSecurityGroupIds'] !== undefined) {
        sentGroups = input['VpcSecurityGroupIds'] as string[];
      }
      return {};
    },
    DescribeDBClustersCommand: () => ({
      DBClusters: [
        {
          DBClusterIdentifier: DOCDB_CLUSTER_ID,
          Engine: 'docdb',
          Status: 'available',
          Port: sentPort ?? (bag['Port'] != null ? Number(bag['Port']) : 27017),
          VpcSecurityGroups: (sentGroups ?? (bag['VpcSecurityGroupIds'] as string[]) ?? []).map(
            (id) => ({ VpcSecurityGroupId: id, Status: 'active' })
          ),
          DBClusterArn: DOCDB_CLUSTER_ARN,
          DBClusterMembers: [],
        },
      ],
    }),
  });
}

const kept = (why: string): string =>
  `left in place on removal: ModifyDBCluster keeps a member it is not sent (merge semantics), ${why}`;

const DOCDB_CLUSTER_CASE: TypeCase = {
  resourceType: 'AWS::DocDB::DBCluster',
  provider: () => new DocDBProvider(),
  physicalId: DOCDB_CLUSTER_ID,
  createOnly: createOnlyOf('AWS::DocDB::DBCluster'),
  arm: docdbArmCluster,
  exempt: {},
  targets: [
    TAG_TARGET,
    // ModifyDBCluster sends the whole desired group list.
    {
      path: ['VpcSecurityGroupIds', 1],
      command: 'ModifyDBClusterCommand',
      names: 'sg-1',
      notNames: 'sg-2',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        DBClusterIdentifier: DOCDB_CLUSTER_ID,
        EngineVersion: '5.0.0',
        MasterUsername: 'docdbadmin',
        // Obviously fake: never a real credential.
        MasterUserPassword: 'FAKE-not-a-real-password',
        Port: 27018,
        VpcSecurityGroupIds: ['sg-1', 'sg-2'],
        DBSubnetGroupName: 'docdb-subnets',
        StorageEncrypted: true,
        KmsKeyId: `arn:aws:kms:us-east-1:${ACCOUNT}:key/k`,
        BackupRetentionPeriod: 7,
        PreferredBackupWindow: '03:00-04:00',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        DBClusterParameterGroupName: 'docdb-params',
        DeletionProtection: true,
        Tags: fresh(DOCDB_TAGS),
      },
      expectedSilent: {
        ...Object.fromEntries(
          DOCDB_CLUSTER_KEPT_ON_REMOVAL.map((key) => [
            `update-remove:${key}`,
            kept(
              `and CloudFormation keeps the live value too, warned about by update() (CFn A/B, #5004 / #1160 / go-to-k/cdkd#5543, ${DOCDB_SRC} DOCDB_CLUSTER_KEPT_ON_REMOVAL)`
            ),
          ])
        ),
        'update-remove:MasterUserPassword': kept(
          `and a removed password sends nothing: any supplied password is a master-credential reset, and removal cannot synthesize one (go-to-k/cdkd#5153, ${DOCDB_SRC} masterUserPasswordToSend)`
        ),
        ...Object.fromEntries(
          [0, 1].map((i) => [
            `update-remove:VpcSecurityGroupIds.${i}`,
            `the desired group list is sent whole from next (${DOCDB_SRC} updateDBCluster, sendVpcSgIds), so a dropped element reaches the wire through next, which update-add observes`,
          ])
        ),
      },
      expectedRemovalThrows: TAG_REFUSALS,
    },
  ],
};

// --- AWS::DocDB::DBInstance ----------------------------------------------------

const DOCDB_INSTANCE_ID = 'docdb-instance';

/** DescribeDBInstances answers the instance available with its ARN: the create wait returns at once. */
function docdbArmInstance(): void {
  setOutputOverrides({
    DescribeDBInstancesCommand: () => ({
      DBInstances: [
        {
          DBInstanceIdentifier: DOCDB_INSTANCE_ID,
          Engine: 'docdb',
          DBInstanceStatus: 'available',
          DBInstanceArn: `arn:aws:rds:us-east-1:${ACCOUNT}:db:${DOCDB_INSTANCE_ID}`,
        },
      ],
    }),
  });
}

const DOCDB_INSTANCE_CASE: TypeCase = {
  resourceType: 'AWS::DocDB::DBInstance',
  provider: () => new DocDBProvider(),
  physicalId: DOCDB_INSTANCE_ID,
  createOnly: createOnlyOf('AWS::DocDB::DBInstance'),
  arm: () => docdbArmInstance(),
  exempt: {},
  targets: [TAG_TARGET],
  bags: [
    {
      name: 'every property',
      bag: {
        DBInstanceIdentifier: DOCDB_INSTANCE_ID,
        DBInstanceClass: 'db.r6g.large',
        DBClusterIdentifier: DOCDB_CLUSTER_ID,
        AvailabilityZone: 'us-east-1a',
        PreferredMaintenanceWindow: 'sun:05:00-sun:06:00',
        AutoMinorVersionUpgrade: true,
        Tags: fresh(DOCDB_TAGS),
      },
      expectedSilent: {
        'update-remove:DBInstanceClass': `DBInstanceClass is required by the CloudFormation schema, so no deployable template removes it; update() sends only a declared value (${DOCDB_SRC} updateDBInstance)`,
        'update-remove:PreferredMaintenanceWindow': `left in place on removal and warned about, as CloudFormation keeps it (CFn A/B, go-to-k/cdkd#5543, ${DOCDB_SRC} DOCDB_INSTANCE_KEPT_ON_REMOVAL)`,
        'update-remove:AutoMinorVersionUpgrade': `left in place on removal: the member is inert on DocumentDB ("does not apply to Amazon DocumentDB"), so a reset would change nothing (${DOCDB_SRC} updateDBInstance)`,
      },
      expectedRemovalThrows: TAG_REFUSALS,
    },
  ],
};

// --- AWS::DocDB::DBSubnetGroup -------------------------------------------------

const DOCDB_SUBNET_GROUP = 'docdb-subnets';

/** DescribeDBSubnetGroups answers the group's ARN, which the update's tag diff needs. */
function docdbArmSubnetGroup(): void {
  setOutputOverrides({
    DescribeDBSubnetGroupsCommand: () => ({
      DBSubnetGroups: [
        {
          DBSubnetGroupName: DOCDB_SUBNET_GROUP,
          DBSubnetGroupArn: `arn:aws:rds:us-east-1:${ACCOUNT}:subgrp:${DOCDB_SUBNET_GROUP}`,
        },
      ],
    }),
  });
}

const DOCDB_SUBNET_GROUP_CASE: TypeCase = {
  resourceType: 'AWS::DocDB::DBSubnetGroup',
  provider: () => new DocDBSubnetGroupProvider(),
  physicalId: DOCDB_SUBNET_GROUP,
  createOnly: createOnlyOf('AWS::DocDB::DBSubnetGroup'),
  arm: () => docdbArmSubnetGroup(),
  exempt: {},
  targets: [
    TAG_TARGET,
    // ModifyDBSubnetGroup sends the whole desired subnet list.
    {
      path: ['SubnetIds', 1],
      command: 'ModifyDBSubnetGroupCommand',
      names: 'subnet-1',
      notNames: 'subnet-2',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        DBSubnetGroupName: DOCDB_SUBNET_GROUP,
        DBSubnetGroupDescription: 'docdb subnets',
        SubnetIds: ['subnet-1', 'subnet-2'],
        Tags: fresh(DOCDB_TAGS),
      },
      expectedSilent: {
        'update-remove:SubnetIds': `SubnetIds is required by the CloudFormation schema, so no deployable template removes it; update() sends only a declared, non-empty list (${SUBNET_SRC}:200-205, 218)`,
        ...Object.fromEntries(
          [0, 1].map((i) => [
            `update-remove:SubnetIds.${i}`,
            `the desired subnet list is sent whole from next (${SUBNET_SRC}:204-205, 218), so a dropped element reaches the wire through next, which update-add observes`,
          ])
        ),
      },
      expectedRemovalThrows: TAG_REFUSALS,
    },
  ],
};

export const CASES_15: TypeCase[] = [
  FSX_CASE,
  NEPTUNE_SUBNET_GROUP_CASE,
  NEPTUNE_CLUSTER_CASE,
  NEPTUNE_INSTANCE_CASE,
  DOCDB_CLUSTER_CASE,
  DOCDB_INSTANCE_CASE,
  DOCDB_SUBNET_GROUP_CASE,
];

/** Direct-call checks the bag probes cannot make. */
export function describeFsxExtras(): void {
  describe('AWS::FSx::FileSystem variant members update() refuses to change', () => {
    const bagWith = (block: string): Bag =>
      FSX_CASE.bags.map((b) => b.bag).find((b) => block in b && !('BackupId' in b))!;
    const refusal = async (label: string, next: Bag, prev: Bag): Promise<void> => {
      let thrown: unknown;
      armFs();
      const outcome = await record(async () => {
        try {
          await new FSxFileSystemProvider({ pollIntervalMs: 0 }).update(
            'L',
            FS_ID,
            TYPE,
            structuredClone(next),
            structuredClone(prev)
          );
        } catch (error) {
          thrown = error;
        }
      });
      expect(outcome).toEqual({ threw: false, wire: '' });
      expect(thrown).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect((thrown as Error).message).toContain(`${label} is immutable on AWS`);
    };
    const members = Object.entries(VARIANT_REFUSED).flatMap(([block, keys]) =>
      keys.map((key) => ({ block, key }))
    );
    it.each(members)('refuses a changed $block.$key and sends nothing', async ({ block, key }) => {
      const bag = bagWith(block);
      const next = fresh(bag);
      (next[block] as Record<string, unknown>)[key] = 'other';
      await refusal(`${block}.${key}`, next, bag);
    });
    it.each(members)('refuses a removed $block.$key and sends nothing', async ({ block, key }) => {
      const bag = bagWith(block);
      const next = fresh(bag);
      delete (next[block] as Record<string, unknown>)[key];
      await refusal(`${block}.${key}`, next, bag);
    });
  });

  describe('AWS::FSx::FileSystem delete', () => {
    const deleteWire = async (properties: Bag): Promise<string> => {
      armFs();
      // An empty DescribeFileSystems answer is "gone", so the wait returns at once.
      setOutputOverrides({ DescribeFileSystemsCommand: () => ({ FileSystems: [] }) });
      const outcome = await record(() =>
        new FSxFileSystemProvider({ pollIntervalMs: 0 }).delete('L', FS_ID, TYPE, properties)
      );
      expect(outcome).toMatchObject({ threw: false });
      return (outcome as { wire: string }).wire;
    };
    it('sends the recorded OpenZFS Options on DeleteFileSystem (go-to-k/cdkd#5431)', async () => {
      const wire = await deleteWire(fresh(OPENZFS_BAG));
      expect(wire).toContain('DeleteFileSystemCommand');
      expect(wire).toContain('DELETE_CHILD_VOLUMES_AND_SNAPSHOTS');
    });
    it('sends no OpenZFS block for an OpenZFS record without Options', async () => {
      const bag = fresh(OPENZFS_BAG);
      delete (bag['OpenZFSConfiguration'] as Record<string, unknown>)['Options'];
      const wire = await deleteWire(bag);
      expect(wire).toContain('DeleteFileSystemCommand');
      expect(wire).not.toContain('OpenZFSConfiguration');
    });
    it('sends no OpenZFS block for a Lustre record', async () => {
      const wire = await deleteWire(fresh(LUSTRE_BAG));
      expect(wire).toContain('DeleteFileSystemCommand');
      expect(wire).not.toContain('OpenZFSConfiguration');
    });
  });
}
