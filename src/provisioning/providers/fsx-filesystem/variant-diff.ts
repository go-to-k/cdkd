import type { FSxFileSystemProvider } from '../fsx-filesystem-provider.js';
import type {
  UpdateFileSystemLustreConfiguration,
  UpdateFileSystemWindowsConfiguration,
  UpdateFileSystemOntapConfiguration,
  UpdateFileSystemOpenZFSConfiguration,
  LustreReadCacheSizingMode,
} from '@aws-sdk/client-fsx';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import {
  VARIANT_CONFIG_KEY,
  type VariantFieldContext,
  VARIANT_MUTABLE_SUBPROPS,
  routeTableDelta,
  aliasDelta,
  toNumber,
  toBoolean,
} from './shared.js';

/**
 * Which `<Variant>Configuration` block (if any) is present on either side
 * of the update. At most one is expected — the file system's type never
 * changes (FileSystemType is registry-createOnly, guarded above).
 */
export function detectVariantConfigKey(
  this: FSxFileSystemProvider,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): string | undefined {
  for (const key of Object.values(VARIANT_CONFIG_KEY)) {
    if (properties[key] !== undefined || previousProperties[key] !== undefined) return key;
  }
  return undefined;
}

/**
 * Diff a variant config block's sub-properties into the SDK
 * `UpdateFileSystem<Variant>Configuration` shape. A changed sub-field that
 * is NOT in the variant's mutable set is rejected with a `--replace`
 * pointer (UpdateFileSystem cannot express it).
 *
 * A mutable sub-property REMOVED from the desired block (issue #1160) is
 * returned in `leftInPlace` instead of being mapped: `UpdateFileSystem`
 * keeps a field it is not sent, and cdkd sends no reset, so mapping it to
 * `undefined` silently dropped the removal (and issued an
 * `UpdateFileSystem` with an empty variant block when it was the only
 * change). `RouteTableIds` is the exception — its removal IS expressible,
 * as a `RemoveRouteTableIds` delta.
 */
export function computeVariantConfigDiff(
  this: FSxFileSystemProvider,
  resourceType: string,
  logicalId: string,
  configKey: string,
  next: Record<string, unknown>,
  prev: Record<string, unknown>
): {
  diff: Record<string, unknown>;
  hasMutableDiff: boolean;
  leftInPlace: string[];
  aliases: { add: string[]; remove: string[] };
} {
  const mutable = VARIANT_MUTABLE_SUBPROPS[configKey] ?? new Set<string>();
  const keys = new Set([...Object.keys(next), ...Object.keys(prev)]);
  const diff: Record<string, unknown> = {};
  const leftInPlace: string[] = [];
  let aliases: { add: string[]; remove: string[] } = { add: [], remove: [] };
  let hasMutableDiff = false;
  for (const key of keys) {
    const nextVal = next[key];
    const prevVal = prev[key];
    if (JSON.stringify(nextVal) === JSON.stringify(prevVal)) continue;
    // go-to-k/cdkd#5431: OpenZFS `Options` is a DeleteFileSystem option
    // (CFn "Update requires: No interruption"): nothing on AWS to update,
    // so a change or removal only lands in the record delete() reads.
    if (configKey === 'OpenZFSConfiguration' && key === 'Options') continue;
    // go-to-k/cdkd#5469: Windows `Aliases` (CFn "Update requires: No
    // interruption", not createOnly in the registry schema) changes through
    // Associate/DisassociateFileSystemAliases, never UpdateFileSystem.
    if (configKey === 'WindowsConfiguration' && key === 'Aliases') {
      aliases = aliasDelta(nextVal, prevVal);
      continue;
    }
    if (!mutable.has(key)) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `AWS FSx FileSystem ${configKey}.${key} is immutable on AWS — UpdateFileSystem cannot change it after creation. Re-deploy with cdkd deploy --replace --force-stateful-recreation (the type is in cdkd's stateful-recreate guard set, so a bare --replace is refused a second time with STATEFUL_REPLACE_BLOCKED), or destroy + redeploy the stack.`
      );
    }
    if (nextVal === undefined && key !== 'RouteTableIds') {
      leftInPlace.push(key);
      continue;
    }
    const ctx: VariantFieldContext = { resourceType, logicalId, configKey };
    const applied =
      configKey === 'LustreConfiguration'
        ? this.applyLustreUpdateField(ctx, key, nextVal, diff)
        : configKey === 'WindowsConfiguration'
          ? this.applyWindowsUpdateField(ctx, key, nextVal, diff)
          : configKey === 'OntapConfiguration'
            ? this.applyOntapUpdateField(ctx, key, nextVal, prevVal, diff)
            : this.applyOpenZFSUpdateField(ctx, key, nextVal, prevVal, diff);
    // A pure RouteTableIds reorder yields no Add/Remove delta — do not
    // trigger a no-op UpdateFileSystem call for it.
    if (applied) hasMutableDiff = true;
  }
  return { diff, hasMutableDiff, leftInPlace, aliases };
}

/**
 * A sub-property listed in a `*_MUTABLE_SUBPROPS` set with no matching
 * `apply*UpdateField` case. Reaching here is a cdkd bug, not user error:
 * `computeVariantConfigDiff` already accepted the key as mutable, so
 * falling through would issue a no-op `UpdateFileSystem` (`hasMutableDiff`
 * true, empty diff) and silently drop the user's change. Fail loudly
 * instead so the missing mapping surfaces the moment it is added.
 */
export function unmappedMutableSubprop(
  this: FSxFileSystemProvider,
  ctx: VariantFieldContext,
  key: string
): never {
  throw new ProvisioningError(
    `AWS FSx FileSystem ${ctx.configKey}.${key} is declared mutable but has no UpdateFileSystem mapping in cdkd. This is a cdkd bug — please report it at https://github.com/go-to-k/cdkd/issues`,
    ctx.resourceType,
    ctx.logicalId
  );
}

export function applyLustreUpdateField(
  this: FSxFileSystemProvider,
  ctx: VariantFieldContext,
  key: string,
  next: unknown,
  diff: Record<string, unknown>
): boolean {
  const out = diff as UpdateFileSystemLustreConfiguration;
  switch (key) {
    case 'WeeklyMaintenanceStartTime':
    case 'DailyAutomaticBackupStartTime':
      (diff as Record<string, unknown>)[key] = next as string | undefined;
      break;
    case 'AutomaticBackupRetentionDays':
    case 'PerUnitStorageThroughput':
    case 'ThroughputCapacity':
      (diff as Record<string, unknown>)[key] = toNumber(next);
      break;
    case 'AutoImportPolicy':
    case 'DataCompressionType':
      (diff as Record<string, unknown>)[key] = next;
      break;
    case 'MetadataConfiguration': {
      const metadata = next as Record<string, unknown> | undefined;
      out.MetadataConfiguration = metadata
        ? {
            Mode: metadata['Mode'] as 'AUTOMATIC' | 'USER_PROVISIONED' | undefined,
            Iops: toNumber(metadata['Iops']),
          }
        : undefined;
      break;
    }
    case 'DataReadCacheConfiguration': {
      const readCache = next as Record<string, unknown> | undefined;
      out.DataReadCacheConfiguration = readCache
        ? {
            SizingMode: readCache['SizingMode'] as LustreReadCacheSizingMode,
            SizeGiB: toNumber(readCache['SizeGiB']),
          }
        : undefined;
      break;
    }
    case 'LogConfiguration':
      out.LogConfiguration = this.toLustreLogConfiguration(
        next as Record<string, unknown> | undefined
      );
      break;
    default:
      this.unmappedMutableSubprop(ctx, key);
  }
  return true;
}

export function applyWindowsUpdateField(
  this: FSxFileSystemProvider,
  ctx: VariantFieldContext,
  key: string,
  next: unknown,
  diff: Record<string, unknown>
): boolean {
  const out = diff as UpdateFileSystemWindowsConfiguration;
  switch (key) {
    case 'WeeklyMaintenanceStartTime':
    case 'DailyAutomaticBackupStartTime':
      (diff as Record<string, unknown>)[key] = next as string | undefined;
      break;
    case 'AutomaticBackupRetentionDays':
    case 'ThroughputCapacity':
      (diff as Record<string, unknown>)[key] = toNumber(next);
      break;
    case 'SelfManagedActiveDirectoryConfiguration':
      out.SelfManagedActiveDirectoryConfiguration = this.toSelfManagedAdConfigurationUpdates(
        next as Record<string, unknown> | undefined
      );
      break;
    case 'AuditLogConfiguration':
      out.AuditLogConfiguration = this.toWindowsAuditLogConfiguration(
        next as Record<string, unknown> | undefined
      );
      break;
    case 'DiskIopsConfiguration':
      out.DiskIopsConfiguration = this.toDiskIopsConfiguration(
        next as Record<string, unknown> | undefined
      );
      break;
    case 'FsrmConfiguration':
      out.FsrmConfiguration = this.toWindowsFsrmConfiguration(
        next as Record<string, unknown> | undefined
      );
      break;
    default:
      this.unmappedMutableSubprop(ctx, key);
  }
  return true;
}

export function applyOntapUpdateField(
  this: FSxFileSystemProvider,
  ctx: VariantFieldContext,
  key: string,
  next: unknown,
  prev: unknown,
  diff: Record<string, unknown>
): boolean {
  const out = diff as UpdateFileSystemOntapConfiguration;
  switch (key) {
    case 'DailyAutomaticBackupStartTime':
    case 'WeeklyMaintenanceStartTime':
    case 'FsxAdminPassword':
    case 'EndpointIpv6AddressRange':
      (diff as Record<string, unknown>)[key] = next as string | undefined;
      break;
    case 'AutomaticBackupRetentionDays':
    case 'ThroughputCapacity':
    case 'ThroughputCapacityPerHAPair':
    case 'HAPairs':
      (diff as Record<string, unknown>)[key] = toNumber(next);
      break;
    case 'DiskIopsConfiguration':
      out.DiskIopsConfiguration = this.toDiskIopsConfiguration(
        next as Record<string, unknown> | undefined
      );
      break;
    case 'RouteTableIds': {
      const { add, remove } = routeTableDelta(next, prev);
      if (add) out.AddRouteTableIds = add;
      if (remove) out.RemoveRouteTableIds = remove;
      return add !== undefined || remove !== undefined;
    }
    default:
      this.unmappedMutableSubprop(ctx, key);
  }
  return true;
}

export function applyOpenZFSUpdateField(
  this: FSxFileSystemProvider,
  ctx: VariantFieldContext,
  key: string,
  next: unknown,
  prev: unknown,
  diff: Record<string, unknown>
): boolean {
  const out = diff as UpdateFileSystemOpenZFSConfiguration;
  switch (key) {
    case 'DailyAutomaticBackupStartTime':
    case 'WeeklyMaintenanceStartTime':
    case 'EndpointIpv6AddressRange':
      (diff as Record<string, unknown>)[key] = next as string | undefined;
      break;
    case 'CopyTagsToBackups':
    case 'CopyTagsToVolumes':
      (diff as Record<string, unknown>)[key] = toBoolean(next);
      break;
    case 'AutomaticBackupRetentionDays':
    case 'ThroughputCapacity':
      (diff as Record<string, unknown>)[key] = toNumber(next);
      break;
    case 'DiskIopsConfiguration':
      out.DiskIopsConfiguration = this.toDiskIopsConfiguration(
        next as Record<string, unknown> | undefined
      );
      break;
    case 'ReadCacheConfiguration':
      out.ReadCacheConfiguration = this.toOpenZFSReadCacheConfiguration(
        next as Record<string, unknown> | undefined
      );
      break;
    case 'RouteTableIds': {
      const { add, remove } = routeTableDelta(next, prev);
      if (add) out.AddRouteTableIds = add;
      if (remove) out.RemoveRouteTableIds = remove;
      return add !== undefined || remove !== undefined;
    }
    default:
      this.unmappedMutableSubprop(ctx, key);
  }
  return true;
}
