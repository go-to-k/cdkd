import type { FSxFileSystemProvider } from '../fsx-filesystem-provider.js';
import {
  DescribeFileSystemsCommand,
  FileSystemNotFound,
  type DiskIopsConfiguration,
  type LustreFileSystemConfiguration,
  type WindowsFileSystemConfiguration,
  type OntapFileSystemConfiguration,
  type OpenZFSFileSystemConfiguration,
  type FileSystem,
} from '@aws-sdk/client-fsx';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../types/resource.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import { VARIANT_CONFIG_KEY, putIfDefined, toLogGroupArn } from './shared.js';

export function buildAttributes(
  this: FSxFileSystemProvider,
  fs: FileSystem
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  if (fs.ResourceARN !== undefined) attributes['ResourceARN'] = fs.ResourceARN;
  if (fs.DNSName !== undefined) attributes['DNSName'] = fs.DNSName;
  if (fs.LustreConfiguration?.MountName !== undefined) {
    attributes['LustreMountName'] = fs.LustreConfiguration.MountName;
  }
  if (fs.OpenZFSConfiguration?.RootVolumeId !== undefined) {
    attributes['RootVolumeId'] = fs.OpenZFSConfiguration.RootVolumeId;
  }
  if (fs.FileSystemId !== undefined) attributes['FileSystemId'] = fs.FileSystemId;
  return attributes;
}

export async function getAttribute(
  this: FSxFileSystemProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'Id' || attributeName === 'FileSystemId') return physicalId;

  const response = await this.getClient().send(
    new DescribeFileSystemsCommand({ FileSystemIds: [physicalId] })
  );
  const fs = response.FileSystems?.[0];
  if (!fs) return undefined;

  switch (attributeName) {
    case 'ResourceARN':
      return fs.ResourceARN;
    case 'DNSName':
      return fs.DNSName;
    case 'LustreMountName':
      return fs.LustreConfiguration?.MountName;
    case 'RootVolumeId':
      // OpenZFS-only attribute; undefined for Lustre file systems.
      return fs.OpenZFSConfiguration?.RootVolumeId;
    default:
      return undefined;
  }
}

/** Map the read-side `LustreConfiguration` back to CFn input shape. */
export function readLustreConfiguration(
  this: FSxFileSystemProvider,
  lustre: LustreFileSystemConfiguration
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  putIfDefined(config, 'WeeklyMaintenanceStartTime', lustre.WeeklyMaintenanceStartTime);
  putIfDefined(config, 'DeploymentType', lustre.DeploymentType);
  putIfDefined(config, 'PerUnitStorageThroughput', lustre.PerUnitStorageThroughput);
  putIfDefined(config, 'DailyAutomaticBackupStartTime', lustre.DailyAutomaticBackupStartTime);
  putIfDefined(config, 'AutomaticBackupRetentionDays', lustre.AutomaticBackupRetentionDays);
  putIfDefined(config, 'CopyTagsToBackups', lustre.CopyTagsToBackups);
  putIfDefined(config, 'DriveCacheType', lustre.DriveCacheType);
  putIfDefined(config, 'DataCompressionType', lustre.DataCompressionType);
  putIfDefined(config, 'EfaEnabled', lustre.EfaEnabled);
  putIfDefined(config, 'ThroughputCapacity', lustre.ThroughputCapacity);

  if (lustre.MetadataConfiguration) {
    const metadata: Record<string, unknown> = {};
    putIfDefined(metadata, 'Mode', lustre.MetadataConfiguration.Mode);
    putIfDefined(metadata, 'Iops', lustre.MetadataConfiguration.Iops);
    if (Object.keys(metadata).length > 0) config['MetadataConfiguration'] = metadata;
  }
  if (lustre.DataReadCacheConfiguration) {
    const readCache: Record<string, unknown> = {};
    putIfDefined(readCache, 'SizingMode', lustre.DataReadCacheConfiguration.SizingMode);
    putIfDefined(readCache, 'SizeGiB', lustre.DataReadCacheConfiguration.SizeGiB);
    if (Object.keys(readCache).length > 0) config['DataReadCacheConfiguration'] = readCache;
  }
  if (lustre.LogConfiguration) {
    const log: Record<string, unknown> = {};
    putIfDefined(log, 'Level', lustre.LogConfiguration.Level);
    putIfDefined(log, 'Destination', toLogGroupArn(lustre.LogConfiguration.Destination));
    if (Object.keys(log).length > 0) config['LogConfiguration'] = log;
  }
  // Data-repository fields live under DataRepositoryConfiguration on the
  // read side but are flat LustreConfiguration inputs in CFn.
  const dataRepo = lustre.DataRepositoryConfiguration;
  if (dataRepo) {
    putIfDefined(config, 'ImportPath', dataRepo.ImportPath);
    putIfDefined(config, 'ExportPath', dataRepo.ExportPath);
    putIfDefined(config, 'AutoImportPolicy', dataRepo.AutoImportPolicy);
    putIfDefined(config, 'ImportedFileChunkSize', dataRepo.ImportedFileChunkSize);
  }
  return config;
}

/** Map the read-side `WindowsConfiguration` back to CFn input shape. */
export function readWindowsConfiguration(
  this: FSxFileSystemProvider,
  windows: WindowsFileSystemConfiguration
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  putIfDefined(config, 'ActiveDirectoryId', windows.ActiveDirectoryId);
  putIfDefined(config, 'DeploymentType', windows.DeploymentType);
  putIfDefined(config, 'PreferredSubnetId', windows.PreferredSubnetId);
  putIfDefined(config, 'ThroughputCapacity', windows.ThroughputCapacity);
  putIfDefined(config, 'WeeklyMaintenanceStartTime', windows.WeeklyMaintenanceStartTime);
  putIfDefined(config, 'DailyAutomaticBackupStartTime', windows.DailyAutomaticBackupStartTime);
  putIfDefined(config, 'AutomaticBackupRetentionDays', windows.AutomaticBackupRetentionDays);
  putIfDefined(config, 'CopyTagsToBackups', windows.CopyTagsToBackups);

  // CFn takes Aliases as a plain name list; the API returns objects
  // carrying a per-alias lifecycle state.
  if (windows.Aliases !== undefined) {
    config['Aliases'] = windows.Aliases.map((alias) => alias.Name).filter(
      (name): name is string => name !== undefined
    );
  }

  if (windows.SelfManagedActiveDirectoryConfiguration) {
    const ad = windows.SelfManagedActiveDirectoryConfiguration;
    const adConfig: Record<string, unknown> = {};
    putIfDefined(adConfig, 'DomainName', ad.DomainName);
    putIfDefined(
      adConfig,
      'OrganizationalUnitDistinguishedName',
      ad.OrganizationalUnitDistinguishedName
    );
    putIfDefined(adConfig, 'FileSystemAdministratorsGroup', ad.FileSystemAdministratorsGroup);
    putIfDefined(adConfig, 'UserName', ad.UserName);
    putIfDefined(adConfig, 'DnsIps', ad.DnsIps ? [...ad.DnsIps] : undefined);
    putIfDefined(adConfig, 'DomainJoinServiceAccountSecret', ad.DomainJoinServiceAccountSecret);
    // `Password` is write-only — never returned (see getDriftUnknownPaths).
    if (Object.keys(adConfig).length > 0) {
      config['SelfManagedActiveDirectoryConfiguration'] = adConfig;
    }
  }

  if (windows.AuditLogConfiguration) {
    const audit: Record<string, unknown> = {};
    putIfDefined(
      audit,
      'FileAccessAuditLogLevel',
      windows.AuditLogConfiguration.FileAccessAuditLogLevel
    );
    putIfDefined(
      audit,
      'FileShareAccessAuditLogLevel',
      windows.AuditLogConfiguration.FileShareAccessAuditLogLevel
    );
    putIfDefined(audit, 'AuditLogDestination', windows.AuditLogConfiguration.AuditLogDestination);
    if (Object.keys(audit).length > 0) config['AuditLogConfiguration'] = audit;
  }

  const diskIops = this.readDiskIopsConfiguration(windows.DiskIopsConfiguration);
  if (diskIops) config['DiskIopsConfiguration'] = diskIops;

  if (windows.FsrmConfiguration) {
    const fsrm: Record<string, unknown> = {};
    putIfDefined(fsrm, 'FsrmServiceEnabled', windows.FsrmConfiguration.FsrmServiceEnabled);
    putIfDefined(fsrm, 'EventLogDestination', windows.FsrmConfiguration.EventLogDestination);
    if (Object.keys(fsrm).length > 0) config['FsrmConfiguration'] = fsrm;
  }

  return config;
}

/** Map the read-side `OntapConfiguration` back to CFn input shape. */
export function readOntapConfiguration(
  this: FSxFileSystemProvider,
  ontap: OntapFileSystemConfiguration
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  putIfDefined(config, 'DeploymentType', ontap.DeploymentType);
  putIfDefined(config, 'AutomaticBackupRetentionDays', ontap.AutomaticBackupRetentionDays);
  putIfDefined(config, 'DailyAutomaticBackupStartTime', ontap.DailyAutomaticBackupStartTime);
  putIfDefined(config, 'WeeklyMaintenanceStartTime', ontap.WeeklyMaintenanceStartTime);
  putIfDefined(config, 'EndpointIpAddressRange', ontap.EndpointIpAddressRange);
  putIfDefined(config, 'PreferredSubnetId', ontap.PreferredSubnetId);
  putIfDefined(config, 'ThroughputCapacity', ontap.ThroughputCapacity);
  putIfDefined(config, 'ThroughputCapacityPerHAPair', ontap.ThroughputCapacityPerHAPair);
  putIfDefined(config, 'HAPairs', ontap.HAPairs);
  putIfDefined(config, 'RouteTableIds', ontap.RouteTableIds ? [...ontap.RouteTableIds] : undefined);
  putIfDefined(config, 'EndpointIpv6AddressRange', ontap.EndpointIpv6AddressRange);
  // `FsxAdminPassword` is write-only — the API never echoes it back (see
  // getDriftUnknownPaths).

  const diskIops = this.readDiskIopsConfiguration(ontap.DiskIopsConfiguration);
  if (diskIops) config['DiskIopsConfiguration'] = diskIops;

  return config;
}

/** Map the read-side `OpenZFSConfiguration` back to CFn input shape. */
export function readOpenZFSConfiguration(
  this: FSxFileSystemProvider,
  openzfs: OpenZFSFileSystemConfiguration
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  putIfDefined(config, 'DeploymentType', openzfs.DeploymentType);
  putIfDefined(config, 'AutomaticBackupRetentionDays', openzfs.AutomaticBackupRetentionDays);
  putIfDefined(config, 'CopyTagsToBackups', openzfs.CopyTagsToBackups);
  putIfDefined(config, 'CopyTagsToVolumes', openzfs.CopyTagsToVolumes);
  putIfDefined(config, 'DailyAutomaticBackupStartTime', openzfs.DailyAutomaticBackupStartTime);
  putIfDefined(config, 'WeeklyMaintenanceStartTime', openzfs.WeeklyMaintenanceStartTime);
  putIfDefined(config, 'ThroughputCapacity', openzfs.ThroughputCapacity);
  putIfDefined(config, 'PreferredSubnetId', openzfs.PreferredSubnetId);
  putIfDefined(config, 'EndpointIpAddressRange', openzfs.EndpointIpAddressRange);
  putIfDefined(
    config,
    'RouteTableIds',
    openzfs.RouteTableIds ? [...openzfs.RouteTableIds] : undefined
  );
  putIfDefined(config, 'EndpointIpv6AddressRange', openzfs.EndpointIpv6AddressRange);
  // RootVolumeConfiguration lives on the root VOLUME (DescribeFileSystems
  // returns only its id) — it stays in getDriftUnknownPaths.

  const diskIops = this.readDiskIopsConfiguration(openzfs.DiskIopsConfiguration);
  if (diskIops) config['DiskIopsConfiguration'] = diskIops;

  if (openzfs.ReadCacheConfiguration) {
    const readCache: Record<string, unknown> = {};
    putIfDefined(readCache, 'SizingMode', openzfs.ReadCacheConfiguration.SizingMode);
    putIfDefined(readCache, 'SizeGiB', openzfs.ReadCacheConfiguration.SizeGiB);
    if (Object.keys(readCache).length > 0) config['ReadCacheConfiguration'] = readCache;
  }

  return config;
}

/** Shared `DiskIopsConfiguration` reverse-mapper (Windows / ONTAP / OpenZFS). */
export function readDiskIopsConfiguration(
  this: FSxFileSystemProvider,
  diskIops: DiskIopsConfiguration | undefined
): Record<string, unknown> | undefined {
  if (!diskIops) return undefined;
  const out: Record<string, unknown> = {};
  putIfDefined(out, 'Mode', diskIops.Mode);
  putIfDefined(out, 'Iops', diskIops.Iops);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Drop a logging-off `LustreConfiguration.LogConfiguration` (`Level`
 * `DISABLED`, no `Destination`) from each drift comparison side
 * (go-to-k/cdkd#5430). AWS reports that block on a Lustre file system that
 * never enabled logging, and `readLustreConfiguration` started reading it
 * back in #5430, so an `observedProperties` baseline captured by an earlier
 * binary lacks the key while the readback carries it: `drift.ts` walks the
 * key union on that baseline, and every existing Lustre file system would
 * report `LogConfiguration` as drift until a `drift --accept`. Logging off
 * and the key absent mean the same here, so both sides drop it; logging
 * turned ON or OFF against the baseline still differs and is still reported.
 *
 * Also lowercase each `WindowsConfiguration.Aliases` name on both sides
 * (go-to-k/cdkd#5469): FSx stores an alias lowercased whatever spelling it
 * was given, and `update()` compares names case-insensitively, so a
 * mixed-case template (`Keep.corp.example.com`) against the readback is no
 * difference.
 */
export function canonicalizeDriftProperties(
  this: FSxFileSystemProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::FSx::FileSystem') return properties;
  const lustre = properties['LustreConfiguration'];
  if (typeof lustre !== 'object' || lustre === null || Array.isArray(lustre)) {
    return this.canonicalizeWindowsAliases(properties);
  }
  const log = (lustre as Record<string, unknown>)['LogConfiguration'];
  if (
    typeof log !== 'object' ||
    log === null ||
    Array.isArray(log) ||
    JSON.stringify(log) !== JSON.stringify({ Level: 'DISABLED' })
  ) {
    return this.canonicalizeWindowsAliases(properties);
  }
  const { LogConfiguration: _disabled, ...rest } = lustre as Record<string, unknown>;
  return this.canonicalizeWindowsAliases({ ...properties, LustreConfiguration: rest });
}

export function canonicalizeWindowsAliases(
  this: FSxFileSystemProvider,
  properties: Record<string, unknown>
): Record<string, unknown> {
  const windows = properties['WindowsConfiguration'];
  if (typeof windows !== 'object' || windows === null || Array.isArray(windows)) return properties;
  const aliases = (windows as Record<string, unknown>)['Aliases'];
  if (
    !Array.isArray(aliases) ||
    aliases.every((a) => typeof a !== 'string' || a === a.toLowerCase())
  ) {
    return properties;
  }
  return {
    ...properties,
    WindowsConfiguration: {
      ...(windows as Record<string, unknown>),
      Aliases: aliases.map((a) => (typeof a === 'string' ? a.toLowerCase() : a)),
    },
  };
}

/**
 * State property paths this provider cannot read back from AWS:
 *  - `SecurityGroupIds` — `DescribeFileSystems` returns network
 *    interface ids, never the original security group list.
 *  - `BackupId` — creation-source input, not surfaced on the deployed
 *    file system.
 *  - `WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.Password`
 *    / `OntapConfiguration.FsxAdminPassword` — write-only credentials; the
 *    API never echoes them back.
 *  - `OpenZFSConfiguration.RootVolumeConfiguration` — configured on the
 *    root VOLUME, not the file system; `DescribeFileSystems` returns only
 *    `RootVolumeId`, so reading it back would need a separate
 *    `DescribeVolumes` call (out of scope here).
 *  - `OpenZFSConfiguration.Options` — a `DeleteFileSystem` option
 *    (go-to-k/cdkd#5431), never stored on the file system.
 *
 * The whole-block `WindowsConfiguration` / `OntapConfiguration` /
 * `OpenZFSConfiguration` entries are gone as of the variant reverse-mappers
 * — only the individually-unreadable leaves above stay unknown.
 */
export function getDriftUnknownPaths(this: FSxFileSystemProvider, resourceType: string): string[] {
  if (resourceType !== 'AWS::FSx::FileSystem') return [];
  return [
    'SecurityGroupIds',
    'BackupId',
    'WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.Password',
    'OntapConfiguration.FsxAdminPassword',
    'OpenZFSConfiguration.RootVolumeConfiguration',
    'OpenZFSConfiguration.Options',
  ];
}

/**
 * Plain-string arrays FSx returns as unordered sets.
 *
 *  - `WindowsConfiguration.Aliases` — DNS alias names (`files.example.com`).
 *    Alternate names the file system answers to; the API documents no
 *    ordering semantics and no name is privileged over another, so a
 *    `DescribeFileSystems` reorder carries no meaning.
 *
 * This does not match the shared normalizer's AWS-id / ARN heuristic, so
 * without the declaration a reorder would surface as phantom drift. Declared
 * here rather than sorted in `readWindowsConfiguration` so the sort applies
 * to BOTH comparison sides — see
 * {@link ResourceProvider.getDriftUnorderedPaths}.
 *
 * Deliberately NOT declared:
 *
 *  - `WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.DnsIps` —
 *    the API reference describes it only as "A list of IP addresses of DNS
 *    servers or domain controllers in the self-managed AD directory"
 *    (https://docs.aws.amazon.com/fsx/latest/APIReference/API_SelfManagedActiveDirectoryConfiguration.html),
 *    with no statement that order is insignificant. DNS resolver lists are
 *    conventionally preference-ordered (primary first), and if FSx honors
 *    that when joining the domain, sorting would HIDE a real reorder. A
 *    false positive is visible and correctable; silently hiding drift is
 *    not. Same reasoning excludes ElastiCache `PreferredAvailabilityZones`.
 *  - `OntapConfiguration.RouteTableIds` / `OpenZFSConfiguration.RouteTableIds`
 *    — their `rtb-` elements already match the shared id heuristic.
 */
export function getDriftUnorderedPaths(
  this: FSxFileSystemProvider,
  resourceType: string
): string[] {
  if (resourceType !== 'AWS::FSx::FileSystem') return [];
  return ['WindowsConfiguration.Aliases'];
}

/**
 * Read the AWS-current file system configuration in CFn-property shape
 * via `DescribeFileSystems`. Lustre data-repository fields (`ImportPath`
 * / `ExportPath` / `AutoImportPolicy` / `ImportedFileChunkSize`) are
 * mapped back from the nested `DataRepositoryConfiguration` the API
 * returns. The Windows / ONTAP / OpenZFS variant blocks are reverse-mapped
 * by their respective `read*Configuration` helpers; the few inputs AWS
 * never returns stay listed in {@link getDriftUnknownPaths}.
 *
 * Emission follows `docs/provider-rules.md#readcurrentstate-for-drift-detection`: every top-level
 * property `update()` can mutate is emitted unconditionally with a
 * placeholder, registry-createOnly properties keep their guard, and the
 * `<Variant>Configuration` blocks take the Class 1 type-discriminator
 * carve-out — exactly the ONE block matching `FileSystemType` is emitted
 * (at most one is ever legal on AWS), never the other three.
 * Returns `RESOURCE_NOT_FOUND` when the file system is gone.
 */
export async function readCurrentState(
  this: FSxFileSystemProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::FSx::FileSystem') return undefined;

  let fs: FileSystem | undefined;
  let listed: readonly FileSystem[] | undefined;
  try {
    const resp = await this.getClient().send(
      new DescribeFileSystemsCommand({ FileSystemIds: [physicalId] })
    );
    listed = resp.FileSystems;
    fs = resp.FileSystems?.[0];
  } catch (err) {
    if (err instanceof FileSystemNotFound) return RESOURCE_NOT_FOUND;
    throw err;
  }
  // An empty list for the requested id is AWS saying it is gone; an absent
  // list (empty body) keeps `undefined`.
  if (!fs) return listed?.length === 0 ? RESOURCE_NOT_FOUND : undefined;

  const result: Record<string, unknown> = {};

  // Guarded (conditional) emits — every one is registry-createOnly, so
  // `update()` rejects any change and a console user cannot ADD the
  // property post-create. This is §3b's "immutable on create" carve-out:
  // AWS returning the field as undefined is a wire-layer artifact, and a
  // placeholder would only risk tripping the TOP_LEVEL_IMMUTABLE_PROPS
  // guard on a later deploy.
  putIfDefined(result, 'FileSystemType', fs.FileSystemType);
  putIfDefined(result, 'SubnetIds', fs.SubnetIds ? [...fs.SubnetIds] : undefined);
  putIfDefined(result, 'KmsKeyId', fs.KmsKeyId);
  // `SecurityGroupIds` / `BackupId` are createOnly AND never returned by
  // DescribeFileSystems — they stay declared in getDriftUnknownPaths().

  // Always-emit placeholders — exactly the top-level properties
  // `update()` can mutate (StorageCapacity / StorageType /
  // FileSystemTypeVersion / NetworkType / Tags). Without the placeholder,
  // a file system deployed WITHOUT the property never carries the key in
  // `observedProperties`, and the comparator's state-keys-only walk would
  // skip a console-side ADD forever (§3b).
  result['StorageCapacity'] = fs.StorageCapacity ?? 0;
  result['StorageType'] = fs.StorageType ?? 'SSD'; // AWS-documented default
  result['FileSystemTypeVersion'] = fs.FileSystemTypeVersion ?? '';
  result['NetworkType'] = fs.NetworkType ?? 'IPV4'; // AWS-documented default
  result['Tags'] = normalizeAwsTagsToCfn(fs.Tags);

  // Variant block: §3b Class 1 type-discriminator carve-out. At most ONE
  // of the four `<Variant>Configuration` blocks may legally be present for
  // a given `FileSystemType`, so emitting all four as `{}` would make
  // `drift --revert` push an AWS-invalid shape. Emit EXACTLY the block the
  // discriminator selects — unconditionally, so the always-emit contract
  // still holds for the one legal block — and never the other three.
  // Drift detection is not lost: a foreign variant block cannot legally
  // exist on AWS, so a console-side ADD of one is impossible.
  const variantKey = fs.FileSystemType ? VARIANT_CONFIG_KEY[fs.FileSystemType] : undefined;
  switch (variantKey) {
    case 'LustreConfiguration':
      result[variantKey] = this.readLustreConfiguration(fs.LustreConfiguration ?? {});
      break;
    case 'WindowsConfiguration':
      result[variantKey] = this.readWindowsConfiguration(fs.WindowsConfiguration ?? {});
      break;
    case 'OntapConfiguration':
      result[variantKey] = this.readOntapConfiguration(fs.OntapConfiguration ?? {});
      break;
    case 'OpenZFSConfiguration':
      result[variantKey] = this.readOpenZFSConfiguration(fs.OpenZFSConfiguration ?? {});
      break;
    default:
      // Unknown / absent FileSystemType: emit no variant block rather than
      // guessing one. cdkd's create() rejects such a type up front, so this
      // is only reachable for a file system created outside cdkd on a type
      // cdkd does not support yet (a future 5th variant).
      //
      // WARN, not silence: this branch is a real behavior regression risk.
      // Before the discriminator carve-out, whatever config block AWS
      // returned was emitted regardless of type, so an unrecognized variant
      // still produced a (partial) snapshot. Now it produces NONE — which
      // reads downstream as "no drift" on a resource whose configuration
      // cdkd never actually looked at. Guessing a block is not better than
      // omitting one, so the behavior stays; it just must not be quiet.
      this.logger.warn(
        `FSx FileSystem ${physicalId} has FileSystemType '${fs.FileSystemType ?? '(unset)'}', which cdkd does not recognize (expected one of ${Object.keys(
          VARIANT_CONFIG_KEY
        ).join(
          ' / '
        )}). Its variant configuration is NOT included in the drift snapshot, so drift in that block cannot be detected. Please report this at https://github.com/go-to-k/cdkd/issues`
      );
      break;
  }

  return result;
}

/**
 * Adopt an existing FSx file system into cdkd state. Explicit physical
 * id is verified via `DescribeFileSystems`; without an override the
 * resource is reported as not-found.
 */
export async function importImpl(
  this: FSxFileSystemProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.resourceType !== 'AWS::FSx::FileSystem') return null;

  if (input.knownPhysicalId) {
    try {
      const resp = await this.getClient().send(
        new DescribeFileSystemsCommand({ FileSystemIds: [input.knownPhysicalId] })
      );
      const fs = resp.FileSystems?.[0];
      return fs?.FileSystemId
        ? { physicalId: fs.FileSystemId, attributes: this.buildAttributes(fs) }
        : null;
    } catch (err) {
      if (err instanceof FileSystemNotFound) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // file system reaching here needs an explicit `--resource` override.
  return null;
}
