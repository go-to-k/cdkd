import type { FSxFileSystemProvider } from '../fsx-filesystem-provider.js';
import type {
  SelfManagedActiveDirectoryConfiguration,
  SelfManagedActiveDirectoryConfigurationUpdates,
  DiskIopsConfiguration,
  WindowsAuditLogCreateConfiguration,
  WindowsFsrmConfiguration,
  OpenZFSCreateRootVolumeConfiguration,
  OpenZFSUserOrGroupQuota,
  OpenZFSReadCacheConfiguration,
} from '@aws-sdk/client-fsx';
import { toNumber, toBoolean } from './shared.js';

export function toDiskIopsConfiguration(
  this: FSxFileSystemProvider,
  config: Record<string, unknown> | undefined
): DiskIopsConfiguration | undefined {
  if (!config) return undefined;
  return {
    Mode: config['Mode'] as DiskIopsConfiguration['Mode'],
    Iops: toNumber(config['Iops']),
  };
}

export function toSelfManagedAdConfiguration(
  this: FSxFileSystemProvider,
  config: Record<string, unknown> | undefined
): SelfManagedActiveDirectoryConfiguration | undefined {
  if (!config) return undefined;
  return {
    DomainName: config['DomainName'] as string,
    OrganizationalUnitDistinguishedName: config['OrganizationalUnitDistinguishedName'] as
      | string
      | undefined,
    FileSystemAdministratorsGroup: config['FileSystemAdministratorsGroup'] as string | undefined,
    UserName: config['UserName'] as string | undefined,
    Password: config['Password'] as string | undefined,
    DnsIps: config['DnsIps'] as string[],
    DomainJoinServiceAccountSecret: config['DomainJoinServiceAccountSecret'] as string | undefined,
  };
}

export function toSelfManagedAdConfigurationUpdates(
  this: FSxFileSystemProvider,
  config: Record<string, unknown> | undefined
): SelfManagedActiveDirectoryConfigurationUpdates | undefined {
  if (!config) return undefined;
  return {
    UserName: config['UserName'] as string | undefined,
    Password: config['Password'] as string | undefined,
    DnsIps: config['DnsIps'] as string[] | undefined,
    DomainName: config['DomainName'] as string | undefined,
    OrganizationalUnitDistinguishedName: config['OrganizationalUnitDistinguishedName'] as
      | string
      | undefined,
    FileSystemAdministratorsGroup: config['FileSystemAdministratorsGroup'] as string | undefined,
    DomainJoinServiceAccountSecret: config['DomainJoinServiceAccountSecret'] as string | undefined,
  };
}

export function toWindowsAuditLogConfiguration(
  this: FSxFileSystemProvider,
  config: Record<string, unknown> | undefined
): WindowsAuditLogCreateConfiguration | undefined {
  if (!config) return undefined;
  return {
    FileAccessAuditLogLevel: config[
      'FileAccessAuditLogLevel'
    ] as WindowsAuditLogCreateConfiguration['FileAccessAuditLogLevel'],
    FileShareAccessAuditLogLevel: config[
      'FileShareAccessAuditLogLevel'
    ] as WindowsAuditLogCreateConfiguration['FileShareAccessAuditLogLevel'],
    AuditLogDestination: config['AuditLogDestination'] as string | undefined,
  };
}

export function toWindowsFsrmConfiguration(
  this: FSxFileSystemProvider,
  config: Record<string, unknown> | undefined
): WindowsFsrmConfiguration | undefined {
  if (!config) return undefined;
  return {
    FsrmServiceEnabled: toBoolean(config['FsrmServiceEnabled']) as boolean,
    EventLogDestination: config['EventLogDestination'] as string | undefined,
  };
}

export function toOpenZFSRootVolumeConfiguration(
  this: FSxFileSystemProvider,
  config: Record<string, unknown> | undefined
): OpenZFSCreateRootVolumeConfiguration | undefined {
  if (!config) return undefined;
  const nfsExports = config['NfsExports'] as Array<Record<string, unknown>> | undefined;
  const quotas = config['UserAndGroupQuotas'] as Array<Record<string, unknown>> | undefined;
  return {
    RecordSizeKiB: toNumber(config['RecordSizeKiB']),
    DataCompressionType: config[
      'DataCompressionType'
    ] as OpenZFSCreateRootVolumeConfiguration['DataCompressionType'],
    NfsExports: nfsExports?.map((exp) => ({
      ClientConfigurations: (
        (exp['ClientConfigurations'] as Array<Record<string, unknown>> | undefined) ?? []
      ).map((cc) => ({
        Clients: cc['Clients'] as string,
        Options: cc['Options'] as string[],
      })),
    })),
    UserAndGroupQuotas: quotas?.map((q) => ({
      Type: q['Type'] as OpenZFSUserOrGroupQuota['Type'],
      Id: toNumber(q['Id']) as number,
      StorageCapacityQuotaGiB: toNumber(q['StorageCapacityQuotaGiB']) as number,
    })),
    CopyTagsToSnapshots: toBoolean(config['CopyTagsToSnapshots']),
    ReadOnly: toBoolean(config['ReadOnly']),
  };
}

export function toOpenZFSReadCacheConfiguration(
  this: FSxFileSystemProvider,
  config: Record<string, unknown> | undefined
): OpenZFSReadCacheConfiguration | undefined {
  if (!config) return undefined;
  return {
    SizingMode: config['SizingMode'] as OpenZFSReadCacheConfiguration['SizingMode'],
    SizeGiB: toNumber(config['SizeGiB']),
  };
}
