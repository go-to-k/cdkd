import {
  FSxClient,
  CreateFileSystemCommand,
  CreateFileSystemFromBackupCommand,
  UpdateFileSystemCommand,
  DeleteFileSystemCommand,
  DescribeFileSystemsCommand,
  TagResourceCommand,
  UntagResourceCommand,
  FileSystemNotFound,
  type CreateFileSystemLustreConfiguration,
  type UpdateFileSystemLustreConfiguration,
  type CreateFileSystemWindowsConfiguration,
  type UpdateFileSystemWindowsConfiguration,
  type CreateFileSystemOntapConfiguration,
  type UpdateFileSystemOntapConfiguration,
  type CreateFileSystemOpenZFSConfiguration,
  type UpdateFileSystemOpenZFSConfiguration,
  type SelfManagedActiveDirectoryConfiguration,
  type SelfManagedActiveDirectoryConfigurationUpdates,
  type DiskIopsConfiguration,
  type WindowsAuditLogCreateConfiguration,
  type WindowsFsrmConfiguration,
  type OpenZFSCreateRootVolumeConfiguration,
  type OpenZFSUserOrGroupQuota,
  type OpenZFSReadCacheConfiguration,
  type LustreFileSystemConfiguration,
  type WindowsFileSystemConfiguration,
  type OntapFileSystemConfiguration,
  type OpenZFSFileSystemConfiguration,
  type FileSystem,
  type FileSystemType,
  type StorageType,
  type NetworkType,
  type LustreReadCacheSizingMode,
  type Tag,
} from '@aws-sdk/client-fsx';
import { createHash } from 'node:crypto';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { matchesCdkPath, normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * Default polling budget for FSx lifecycle transitions. Lustre SCRATCH
 * creates typically finish in 5-10 minutes, but PERSISTENT creates,
 * storage-capacity growth and deletes can take substantially longer —
 * mirror the Custom Resource provider's 1-hour ceiling.
 */
const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * Lustre sub-properties that `UpdateFileSystem` accepts (the mutable
 * subset of the CFn `LustreConfiguration` block). Everything else in the
 * block is fixed at creation — FSx has no API to change it in place.
 */
const LUSTRE_MUTABLE_SUBPROPS = new Set<string>([
  'WeeklyMaintenanceStartTime',
  'DailyAutomaticBackupStartTime',
  'AutomaticBackupRetentionDays',
  'AutoImportPolicy',
  'DataCompressionType',
  'PerUnitStorageThroughput',
  'MetadataConfiguration',
  'ThroughputCapacity',
  'DataReadCacheConfiguration',
]);

/**
 * `WindowsConfiguration` sub-properties `UpdateFileSystem` accepts (the
 * mutable subset — mirrors `UpdateFileSystemWindowsConfiguration`).
 * Everything else in the CFn block (ActiveDirectoryId, DeploymentType,
 * PreferredSubnetId, Aliases, ...) is fixed at creation, so a change on one
 * is rejected by update() with a `--replace` pointer.
 */
const WINDOWS_MUTABLE_SUBPROPS = new Set<string>([
  'WeeklyMaintenanceStartTime',
  'DailyAutomaticBackupStartTime',
  'AutomaticBackupRetentionDays',
  'ThroughputCapacity',
  'SelfManagedActiveDirectoryConfiguration',
  'AuditLogConfiguration',
  'DiskIopsConfiguration',
  'FsrmConfiguration',
]);

/**
 * `OntapConfiguration` sub-properties `UpdateFileSystem` accepts (mirrors
 * `UpdateFileSystemOntapConfiguration`). `RouteTableIds` is mutable but the
 * API expresses the change as Add/Remove deltas, computed in
 * {@link FSxFileSystemProvider.applyOntapUpdateField}.
 */
const ONTAP_MUTABLE_SUBPROPS = new Set<string>([
  'AutomaticBackupRetentionDays',
  'DailyAutomaticBackupStartTime',
  'FsxAdminPassword',
  'WeeklyMaintenanceStartTime',
  'DiskIopsConfiguration',
  'ThroughputCapacity',
  'ThroughputCapacityPerHAPair',
  'HAPairs',
  'RouteTableIds',
  'EndpointIpv6AddressRange',
]);

/**
 * `OpenZFSConfiguration` sub-properties `UpdateFileSystem` accepts (mirrors
 * `UpdateFileSystemOpenZFSConfiguration`). `RouteTableIds` is mutable via
 * Add/Remove deltas (see {@link FSxFileSystemProvider.applyOpenZFSUpdateField}).
 * `RootVolumeConfiguration` is NOT here — its fields change through the root
 * volume's own `UpdateVolume` API, which `UpdateFileSystem` cannot express,
 * so a change is rejected with a `--replace` pointer.
 */
const OPENZFS_MUTABLE_SUBPROPS = new Set<string>([
  'AutomaticBackupRetentionDays',
  'CopyTagsToBackups',
  'CopyTagsToVolumes',
  'DailyAutomaticBackupStartTime',
  'ThroughputCapacity',
  'WeeklyMaintenanceStartTime',
  'DiskIopsConfiguration',
  'RouteTableIds',
  'ReadCacheConfiguration',
  'EndpointIpv6AddressRange',
]);

/**
 * The four `FileSystemType` values → their CFn variant-config property name.
 * Each `CreateFileSystem`/`UpdateFileSystem` call carries at most one of
 * these blocks (the one matching the file system's type).
 */
const VARIANT_CONFIG_KEY: Record<string, string> = {
  LUSTRE: 'LustreConfiguration',
  WINDOWS: 'WindowsConfiguration',
  ONTAP: 'OntapConfiguration',
  OPENZFS: 'OpenZFSConfiguration',
};

/**
 * Identity of the resource + variant block an `apply*UpdateField` call is
 * mapping, carried so the unreachable-`default:` guard can name the exact
 * missing mapping (see {@link FSxFileSystemProvider.unmappedMutableSubprop}).
 */
interface VariantFieldContext {
  resourceType: string;
  logicalId: string;
  configKey: string;
}

/**
 * Exported so a unit test can assert every declared-mutable sub-property has
 * a matching `apply*UpdateField` case — the invariant the unreachable
 * `default:` guard enforces at runtime.
 */
export const VARIANT_MUTABLE_SUBPROPS: Record<string, ReadonlySet<string>> = {
  LustreConfiguration: LUSTRE_MUTABLE_SUBPROPS,
  WindowsConfiguration: WINDOWS_MUTABLE_SUBPROPS,
  OntapConfiguration: ONTAP_MUTABLE_SUBPROPS,
  OpenZFSConfiguration: OPENZFS_MUTABLE_SUBPROPS,
};

/**
 * Copy `value` into `target[key]` only when AWS actually returned it, so the
 * snapshot carries no `undefined`-valued keys.
 *
 * The drift comparator walks the BASELINE's keys (`observedProperties`, or
 * `properties` when a resource predates observed-capture), not the AWS side —
 * so an omitted key here is not itself phantom drift. It matters because this
 * snapshot BECOMES the next baseline: `deploy-engine` stores it as
 * `observedProperties`, and an explicit `Foo: undefined` would then be walked
 * as a real key on every later comparison. Omitting is also what keeps the
 * emitted shape a faithful subset of the CFn input shape.
 */
const putIfDefined = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (value !== undefined) target[key] = value;
};

/**
 * Compute the Add/Remove route-table-id deltas an ONTAP / OpenZFS
 * `UpdateFileSystem` needs from the previous vs. next `RouteTableIds` list.
 * Route table membership is an unordered set, so a pure reorder yields no
 * delta.
 */
const routeTableDelta = (next: unknown, prev: unknown): { add?: string[]; remove?: string[] } => {
  const nextIds = new Set((next as string[] | undefined) ?? []);
  const prevIds = new Set((prev as string[] | undefined) ?? []);
  const add = [...nextIds].filter((id) => !prevIds.has(id));
  const remove = [...prevIds].filter((id) => !nextIds.has(id));
  return {
    ...(add.length > 0 && { add }),
    ...(remove.length > 0 && { remove }),
  };
};

/**
 * Top-level properties that are create-only per the CFn registry schema
 * (`createOnlyProperties`). A change on any of these is routed through
 * DELETE+CREATE by the replacement-detection layer; if a diff somehow
 * reaches update() with one of them changed, refuse loudly instead of
 * silently applying a partial update.
 */
const TOP_LEVEL_IMMUTABLE_PROPS = [
  'FileSystemType',
  'SubnetIds',
  'SecurityGroupIds',
  'KmsKeyId',
  'BackupId',
] as const;

const toNumber = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v));

const toBoolean = (v: unknown): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v === 'true';
  return Boolean(v);
};

/**
 * SDK Provider for `AWS::FSx::FileSystem`.
 *
 * The type is `ProvisioningType: NON_PROVISIONABLE` in the CFn registry,
 * so cdkd's Cloud Control fallback cannot handle it (issue #1042).
 *
 * Supported variants: **Lustre** (the CDK L2 `aws-fsx.LustreFileSystem`),
 * **Windows** (FSx for Windows File Server), **ONTAP** (FSx for NetApp
 * ONTAP), and **OpenZFS** (FSx for OpenZFS) — each carries its own
 * `<Variant>Configuration` block, mapped per-variant on create and diffed
 * against the `UpdateFileSystem` mutable surface on update (issue #1068).
 *
 * Lifecycle handling — every mutation is async on AWS:
 *  - `create` → `CreateFileSystem` (or `CreateFileSystemFromBackup` when
 *    `BackupId` is set) + poll `DescribeFileSystems` until `AVAILABLE`.
 *  - `update` → `UpdateFileSystem` for the mutable surface (StorageCapacity,
 *    Lustre mutable sub-props, StorageType, FileSystemTypeVersion,
 *    NetworkType) + `TagResource`/`UntagResource` for `Tags`; polls back to
 *    `AVAILABLE`.
 *  - `delete` → `DeleteFileSystem` + poll until the file system is GONE
 *    (`FileSystemNotFound` / dropped from the Describe response). A timeout
 *    here is a hard error — a lingering FSx file system bills per hour.
 *
 * `getMinResourceTimeoutMs()` lifts the deploy engine's per-resource
 * deadline to the polling ceiling (mirrors `CustomResourceProvider`), so
 * slow FSx creates don't require a manual `--resource-timeout`.
 */
export class FSxFileSystemProvider implements ResourceProvider {
  /**
   * Cloud Control has NO handlers for this type (`ProvisioningType:
   * NON_PROVISIONABLE` in the CFn registry), so the deploy engine's #614
   * silent-drop auto-route MUST NOT send a Windows/ONTAP/OpenZFS template
   * to CC — it would fail at provisioning time with an opaque
   * UnsupportedActionException. With this opt-out the ProviderRegistry
   * rejects such templates pre-flight with a clear error instead.
   * (The runtime Tier 3 set cannot express this: it excludes SDK-covered
   * types by design, so `isNonProvisionable()` is false for this type.)
   */
  readonly disableCcApiFallback = true;

  private client: FSxClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('FSxFileSystemProvider');

  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(options?: { pollIntervalMs?: number; maxWaitMs?: number }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::FSx::FileSystem',
      new Set([
        'BackupId',
        'FileSystemType',
        'FileSystemTypeVersion',
        'KmsKeyId',
        'LustreConfiguration',
        'NetworkType',
        'OntapConfiguration',
        'OpenZFSConfiguration',
        'SecurityGroupIds',
        'StorageCapacity',
        'StorageType',
        'SubnetIds',
        'Tags',
        'WindowsConfiguration',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>();

  private getClient(): FSxClient {
    if (!this.client) {
      this.client = new FSxClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  /**
   * Self-reported minimum per-resource timeout: the deploy engine resolves
   * `max(getMinResourceTimeoutMs(), globalCliDefault)` so FSx's slow
   * create/delete polling fits inside the resource deadline without the
   * user passing `--resource-timeout`.
   */
  getMinResourceTimeoutMs(): number {
    return this.maxWaitMs;
  }

  // ─── CREATE ────────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    if (resourceType !== 'AWS::FSx::FileSystem') {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
    }

    const backupId = properties['BackupId'] as string | undefined;
    const fileSystemType = properties['FileSystemType'] as string | undefined;

    // Defensive: refuse clearly if a create reaches us with a
    // FileSystemType cdkd does not implement (e.g. a future AWS variant, or
    // a typo routed past the pre-flight). BackupId creates derive the type
    // from the backup, so they skip this check.
    if (
      backupId === undefined &&
      !(fileSystemType !== undefined && fileSystemType in VARIANT_CONFIG_KEY)
    ) {
      throw new ProvisioningError(
        `AWS::FSx::FileSystem: FileSystemType '${fileSystemType ?? '(unset)'}' is not supported by cdkd — expected one of ${Object.keys(VARIANT_CONFIG_KEY).join(' / ')}.`,
        resourceType,
        logicalId
      );
    }

    this.logger.debug(`Creating FSx FileSystem ${logicalId}`);

    // ClientRequestToken is FSx's idempotency key: a retried Create with
    // the SAME token returns the existing file system instead of creating
    // a duplicate (load-bearing for a lost-response retry under the deploy
    // engine's outer withRetry). It must be STABLE across retries of THIS
    // create but DIFFER between the old and new file system during a
    // property-driven REPLACEMENT — hash ONLY the immutable (createOnly)
    // inputs in a fixed order (same rationale as EFSProvider's
    // CreationToken derivation in efs-provider.ts).
    //
    // NOTE the hash deliberately covers only the REGISTRY-createOnly
    // top-level properties, not the provider-classified immutable Lustre
    // sub-properties (DeploymentType / ImportPath / ...). Those changes are
    // rejected by update() with a --replace pointer, and the deploy
    // engine's --replace replacement is DELETE → wait-for-gone → CREATE,
    // so the old file system (and its token) no longer exists when the new
    // create runs — no token collision is possible on that path.
    const tokenHash = createHash('sha256')
      .update(
        [
          properties['FileSystemType'],
          properties['SubnetIds'],
          properties['SecurityGroupIds'],
          properties['KmsKeyId'],
          properties['BackupId'],
        ]
          .map((v) => JSON.stringify(v ?? null))
          .join(' ')
      )
      .digest('hex')
      .slice(0, 12);
    // FSx ClientRequestToken max length is 63 chars — truncate long CDK
    // logical ids and keep the hash suffix for uniqueness.
    const clientRequestToken = `cdkd-${logicalId.slice(0, 45)}-${tokenHash}`;

    const tags = properties['Tags'] as Tag[] | undefined;
    const common = {
      ClientRequestToken: clientRequestToken,
      SubnetIds: properties['SubnetIds'] as string[],
      SecurityGroupIds: properties['SecurityGroupIds'] as string[] | undefined,
      KmsKeyId: properties['KmsKeyId'] as string | undefined,
      StorageType: properties['StorageType'] as StorageType | undefined,
      StorageCapacity: toNumber(properties['StorageCapacity']),
      FileSystemTypeVersion: properties['FileSystemTypeVersion'] as string | undefined,
      NetworkType: properties['NetworkType'] as NetworkType | undefined,
      // Exactly one variant block is non-undefined for any given file system
      // (the one matching FileSystemType); the SDK ignores the undefined rest.
      LustreConfiguration: this.toCreateLustreConfiguration(
        properties['LustreConfiguration'] as Record<string, unknown> | undefined
      ),
      WindowsConfiguration: this.toCreateWindowsConfiguration(
        properties['WindowsConfiguration'] as Record<string, unknown> | undefined
      ),
      OntapConfiguration: this.toCreateOntapConfiguration(
        properties['OntapConfiguration'] as Record<string, unknown> | undefined
      ),
      OpenZFSConfiguration: this.toCreateOpenZFSConfiguration(
        properties['OpenZFSConfiguration'] as Record<string, unknown> | undefined
      ),
      Tags: tags?.map((t) => ({ Key: t.Key, Value: t.Value })),
    };

    let fileSystemId: string | undefined;

    try {
      let created: FileSystem | undefined;
      if (backupId !== undefined) {
        // BackupId routes to a DIFFERENT API — CreateFileSystemFromBackup
        // (FileSystemType is derived from the backup and not a valid param).
        const response = await this.getClient().send(
          new CreateFileSystemFromBackupCommand({ ...common, BackupId: backupId })
        );
        created = response.FileSystem;
      } else {
        const response = await this.getClient().send(
          new CreateFileSystemCommand({
            ...common,
            FileSystemType: fileSystemType as FileSystemType,
          })
        );
        created = response.FileSystem;
      }

      fileSystemId = created?.FileSystemId;
      if (!fileSystemId) {
        throw new ProvisioningError(
          `FSx CreateFileSystem for ${logicalId} returned no FileSystemId`,
          resourceType,
          logicalId
        );
      }

      // FSx creation is async (typically 5-10 min for Lustre SCRATCH,
      // longer for PERSISTENT) — poll until AVAILABLE.
      const fs = await this.waitForFileSystemAvailable(fileSystemId, logicalId, resourceType);

      this.logger.debug(`Successfully created FSx FileSystem ${logicalId}: ${fileSystemId}`);

      return {
        physicalId: fileSystemId,
        attributes: this.buildAttributes(fs),
      };
    } catch (error) {
      // Atomicity: if the create call succeeded but polling failed (the
      // file system went FAILED, or the wait timed out), create() is about
      // to throw without returning a physicalId — the deploy engine cannot
      // roll it back, and an orphaned FSx file system bills per hour.
      // Best-effort delete it here.
      if (fileSystemId !== undefined) {
        try {
          await this.getClient().send(new DeleteFileSystemCommand({ FileSystemId: fileSystemId }));
          this.logger.warn(`Rolled back partially-created FSx FileSystem ${fileSystemId}`);
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to roll back partially-created FSx FileSystem ${fileSystemId}: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            } — delete it manually to stop billing`
          );
        }
      }
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create FSx FileSystem ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Map the CFn `LustreConfiguration` block to the SDK create shape. The
   * field names are identical (both PascalCase); numeric / boolean fields
   * are coerced defensively because template values can arrive as strings.
   */
  private toCreateLustreConfiguration(
    config: Record<string, unknown> | undefined
  ): CreateFileSystemLustreConfiguration | undefined {
    if (!config) return undefined;
    const metadata = config['MetadataConfiguration'] as Record<string, unknown> | undefined;
    const readCache = config['DataReadCacheConfiguration'] as Record<string, unknown> | undefined;
    const out: CreateFileSystemLustreConfiguration = {
      WeeklyMaintenanceStartTime: config['WeeklyMaintenanceStartTime'] as string | undefined,
      ImportPath: config['ImportPath'] as string | undefined,
      ExportPath: config['ExportPath'] as string | undefined,
      ImportedFileChunkSize: toNumber(config['ImportedFileChunkSize']),
      DeploymentType: config[
        'DeploymentType'
      ] as CreateFileSystemLustreConfiguration['DeploymentType'],
      AutoImportPolicy: config[
        'AutoImportPolicy'
      ] as CreateFileSystemLustreConfiguration['AutoImportPolicy'],
      PerUnitStorageThroughput: toNumber(config['PerUnitStorageThroughput']),
      DailyAutomaticBackupStartTime: config['DailyAutomaticBackupStartTime'] as string | undefined,
      AutomaticBackupRetentionDays: toNumber(config['AutomaticBackupRetentionDays']),
      CopyTagsToBackups: toBoolean(config['CopyTagsToBackups']),
      DriveCacheType: config[
        'DriveCacheType'
      ] as CreateFileSystemLustreConfiguration['DriveCacheType'],
      DataCompressionType: config[
        'DataCompressionType'
      ] as CreateFileSystemLustreConfiguration['DataCompressionType'],
      EfaEnabled: toBoolean(config['EfaEnabled']),
      ThroughputCapacity: toNumber(config['ThroughputCapacity']),
      MetadataConfiguration: metadata
        ? {
            Mode: metadata['Mode'] as 'AUTOMATIC' | 'USER_PROVISIONED' | undefined,
            Iops: toNumber(metadata['Iops']),
          }
        : undefined,
      DataReadCacheConfiguration: readCache
        ? {
            SizingMode: readCache['SizingMode'] as LustreReadCacheSizingMode,
            SizeGiB: toNumber(readCache['SizeGiB']),
          }
        : undefined,
    };
    return out;
  }

  /** Map the CFn `WindowsConfiguration` block to the SDK create shape. */
  private toCreateWindowsConfiguration(
    config: Record<string, unknown> | undefined
  ): CreateFileSystemWindowsConfiguration | undefined {
    if (!config) return undefined;
    return {
      ActiveDirectoryId: config['ActiveDirectoryId'] as string | undefined,
      SelfManagedActiveDirectoryConfiguration: this.toSelfManagedAdConfiguration(
        config['SelfManagedActiveDirectoryConfiguration'] as Record<string, unknown> | undefined
      ),
      DeploymentType: config[
        'DeploymentType'
      ] as CreateFileSystemWindowsConfiguration['DeploymentType'],
      PreferredSubnetId: config['PreferredSubnetId'] as string | undefined,
      // ThroughputCapacity is required by the SDK type (number | undefined);
      // a Windows template always carries it, but coerce defensively.
      ThroughputCapacity: toNumber(config['ThroughputCapacity']) as number,
      WeeklyMaintenanceStartTime: config['WeeklyMaintenanceStartTime'] as string | undefined,
      DailyAutomaticBackupStartTime: config['DailyAutomaticBackupStartTime'] as string | undefined,
      AutomaticBackupRetentionDays: toNumber(config['AutomaticBackupRetentionDays']),
      CopyTagsToBackups: toBoolean(config['CopyTagsToBackups']),
      Aliases: config['Aliases'] as string[] | undefined,
      AuditLogConfiguration: this.toWindowsAuditLogConfiguration(
        config['AuditLogConfiguration'] as Record<string, unknown> | undefined
      ),
      DiskIopsConfiguration: this.toDiskIopsConfiguration(
        config['DiskIopsConfiguration'] as Record<string, unknown> | undefined
      ),
      FsrmConfiguration: this.toWindowsFsrmConfiguration(
        config['FsrmConfiguration'] as Record<string, unknown> | undefined
      ),
    };
  }

  /** Map the CFn `OntapConfiguration` block to the SDK create shape. */
  private toCreateOntapConfiguration(
    config: Record<string, unknown> | undefined
  ): CreateFileSystemOntapConfiguration | undefined {
    if (!config) return undefined;
    return {
      AutomaticBackupRetentionDays: toNumber(config['AutomaticBackupRetentionDays']),
      DailyAutomaticBackupStartTime: config['DailyAutomaticBackupStartTime'] as string | undefined,
      DeploymentType: config[
        'DeploymentType'
      ] as CreateFileSystemOntapConfiguration['DeploymentType'],
      EndpointIpAddressRange: config['EndpointIpAddressRange'] as string | undefined,
      FsxAdminPassword: config['FsxAdminPassword'] as string | undefined,
      DiskIopsConfiguration: this.toDiskIopsConfiguration(
        config['DiskIopsConfiguration'] as Record<string, unknown> | undefined
      ),
      PreferredSubnetId: config['PreferredSubnetId'] as string | undefined,
      RouteTableIds: config['RouteTableIds'] as string[] | undefined,
      ThroughputCapacity: toNumber(config['ThroughputCapacity']),
      WeeklyMaintenanceStartTime: config['WeeklyMaintenanceStartTime'] as string | undefined,
      HAPairs: toNumber(config['HAPairs']),
      ThroughputCapacityPerHAPair: toNumber(config['ThroughputCapacityPerHAPair']),
      EndpointIpv6AddressRange: config['EndpointIpv6AddressRange'] as string | undefined,
    };
  }

  /** Map the CFn `OpenZFSConfiguration` block to the SDK create shape. */
  private toCreateOpenZFSConfiguration(
    config: Record<string, unknown> | undefined
  ): CreateFileSystemOpenZFSConfiguration | undefined {
    if (!config) return undefined;
    return {
      AutomaticBackupRetentionDays: toNumber(config['AutomaticBackupRetentionDays']),
      CopyTagsToBackups: toBoolean(config['CopyTagsToBackups']),
      CopyTagsToVolumes: toBoolean(config['CopyTagsToVolumes']),
      DailyAutomaticBackupStartTime: config['DailyAutomaticBackupStartTime'] as string | undefined,
      DeploymentType: config[
        'DeploymentType'
      ] as CreateFileSystemOpenZFSConfiguration['DeploymentType'],
      // ThroughputCapacity is required by the SDK type; coerce defensively.
      ThroughputCapacity: toNumber(config['ThroughputCapacity']) as number,
      WeeklyMaintenanceStartTime: config['WeeklyMaintenanceStartTime'] as string | undefined,
      DiskIopsConfiguration: this.toDiskIopsConfiguration(
        config['DiskIopsConfiguration'] as Record<string, unknown> | undefined
      ),
      RootVolumeConfiguration: this.toOpenZFSRootVolumeConfiguration(
        config['RootVolumeConfiguration'] as Record<string, unknown> | undefined
      ),
      PreferredSubnetId: config['PreferredSubnetId'] as string | undefined,
      EndpointIpAddressRange: config['EndpointIpAddressRange'] as string | undefined,
      EndpointIpv6AddressRange: config['EndpointIpv6AddressRange'] as string | undefined,
      RouteTableIds: config['RouteTableIds'] as string[] | undefined,
      ReadCacheConfiguration: this.toOpenZFSReadCacheConfiguration(
        config['ReadCacheConfiguration'] as Record<string, unknown> | undefined
      ),
    };
  }

  // ─── Nested sub-block mappers (shared by create + update) ───────────

  private toDiskIopsConfiguration(
    config: Record<string, unknown> | undefined
  ): DiskIopsConfiguration | undefined {
    if (!config) return undefined;
    return {
      Mode: config['Mode'] as DiskIopsConfiguration['Mode'],
      Iops: toNumber(config['Iops']),
    };
  }

  private toSelfManagedAdConfiguration(
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
      DomainJoinServiceAccountSecret: config['DomainJoinServiceAccountSecret'] as
        | string
        | undefined,
    };
  }

  private toSelfManagedAdConfigurationUpdates(
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
      DomainJoinServiceAccountSecret: config['DomainJoinServiceAccountSecret'] as
        | string
        | undefined,
    };
  }

  private toWindowsAuditLogConfiguration(
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

  private toWindowsFsrmConfiguration(
    config: Record<string, unknown> | undefined
  ): WindowsFsrmConfiguration | undefined {
    if (!config) return undefined;
    return {
      FsrmServiceEnabled: toBoolean(config['FsrmServiceEnabled']) as boolean,
      EventLogDestination: config['EventLogDestination'] as string | undefined,
    };
  }

  private toOpenZFSRootVolumeConfiguration(
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

  private toOpenZFSReadCacheConfiguration(
    config: Record<string, unknown> | undefined
  ): OpenZFSReadCacheConfiguration | undefined {
    if (!config) return undefined;
    return {
      SizingMode: config['SizingMode'] as OpenZFSReadCacheConfiguration['SizingMode'],
      SizeGiB: toNumber(config['SizeGiB']),
    };
  }

  // ─── UPDATE ────────────────────────────────────────────────────────

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    const changed = (key: string): boolean =>
      JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key]);

    // Defensive guard: registry-createOnly top-level changes should have
    // been routed through DELETE+CREATE by the replacement-detection layer.
    // An undefined→defined transition (property ADDED post-create) is a
    // change too — do not require both sides to be present.
    for (const key of TOP_LEVEL_IMMUTABLE_PROPS) {
      const next = properties[key];
      const prev = previousProperties[key];
      if (JSON.stringify(next ?? null) !== JSON.stringify(prev ?? null)) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS FSx FileSystem ${key} is immutable on AWS — UpdateFileSystem does not accept ${key}; the property is fixed at creation. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
        );
      }
    }

    // Variant sub-property immutability: the CFn registry schema does NOT
    // mark the <Variant>Configuration blocks (or their sub-fields) createOnly,
    // so the schema-based replacement fallback never fires for them — the
    // provider classifies each itself, mapping the UpdateFileSystem-mutable
    // subset and rejecting every other changed sub-field with a --replace
    // pointer. At most ONE variant block is present per file system.
    const variantConfigKey = this.detectVariantConfigKey(properties, previousProperties);
    const { diff: variantDiff, hasMutableDiff: variantHasMutableDiff } = variantConfigKey
      ? this.computeVariantConfigDiff(
          resourceType,
          logicalId,
          variantConfigKey,
          (properties[variantConfigKey] ?? {}) as Record<string, unknown>,
          (previousProperties[variantConfigKey] ?? {}) as Record<string, unknown>
        )
      : { diff: {}, hasMutableDiff: false };

    const storageCapacityChanged = changed('StorageCapacity');
    const storageTypeChanged = changed('StorageType');
    const typeVersionChanged = changed('FileSystemTypeVersion');
    const networkTypeChanged = changed('NetworkType');
    const tagsChanged = changed('Tags');

    if (
      !variantHasMutableDiff &&
      !storageCapacityChanged &&
      !storageTypeChanged &&
      !typeVersionChanged &&
      !networkTypeChanged &&
      !tagsChanged
    ) {
      this.logger.debug(`No mutable diff for FSx FileSystem ${logicalId}, skipping update`);
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating FSx FileSystem ${logicalId}: ${physicalId}`);

    try {
      const needsUpdateCall =
        variantHasMutableDiff ||
        storageCapacityChanged ||
        storageTypeChanged ||
        typeVersionChanged ||
        networkTypeChanged;

      let updatedFs: FileSystem | undefined;

      if (needsUpdateCall) {
        const callTimeMs = Date.now();
        const updateResponse = await this.getClient().send(
          new UpdateFileSystemCommand({
            FileSystemId: physicalId,
            ...(storageCapacityChanged && {
              StorageCapacity: toNumber(properties['StorageCapacity']),
            }),
            ...(storageTypeChanged && {
              StorageType: properties['StorageType'] as StorageType | undefined,
            }),
            ...(typeVersionChanged && {
              FileSystemTypeVersion: properties['FileSystemTypeVersion'] as string | undefined,
            }),
            ...(networkTypeChanged && {
              NetworkType: properties['NetworkType'] as NetworkType | undefined,
            }),
            ...(variantHasMutableDiff && variantConfigKey
              ? { [variantConfigKey]: variantDiff }
              : {}),
          })
        );

        // UpdateFileSystem applies the change via an ASYNC administrative
        // action (`AdministrativeActions[].Type: FILE_SYSTEM_UPDATE`) — the
        // Lifecycle can report AVAILABLE while the config change has not
        // propagated to the Describe view yet (observed live: a
        // DataCompressionType NONE -> LZ4 change still read NONE seconds
        // after UpdateFileSystem returned). Wait until THIS update's action
        // completes so the next read (drift compare, verify scripts) sees
        // the final values — CloudFormation waits the same way.
        //
        // The wait must scope to actions from THIS update: FSx keeps
        // completed/FAILED actions in the AdministrativeActions history, so
        // an unscoped wait would (a) mistake a PAST failed update for this
        // one, permanently failing every retry, and (b) return early when
        // the just-created action is not visible in Describe yet. The
        // UpdateFileSystem response carries the newly-created action —
        // derive the tracking threshold from its RequestTime, falling back
        // to the local call time minus a clock-skew margin.
        const respPendingActions = (updateResponse.FileSystem?.AdministrativeActions ?? []).filter(
          (a) =>
            a.AdministrativeActionType === 'FILE_SYSTEM_UPDATE' &&
            (a.Status === 'PENDING' || a.Status === 'IN_PROGRESS')
        );
        const requestTimes = respPendingActions
          .map((a) => a.RequestTime?.getTime())
          .filter((t): t is number => t !== undefined);
        const actionThresholdMs =
          requestTimes.length > 0 ? Math.min(...requestTimes) : callTimeMs - 60_000;

        updatedFs = await this.waitForUpdateActionComplete(
          physicalId,
          logicalId,
          resourceType,
          actionThresholdMs,
          // When the update response CONFIRMED a newly-created action, the
          // wait must actually observe an in-threshold action at least once
          // before returning — a lagging Describe read replica could
          // otherwise yield an empty filtered list (inProgress=false) and
          // return prematurely with the pre-update config.
          respPendingActions.length > 0
        );
      }

      if (tagsChanged) {
        await this.applyTagDiff(
          physicalId,
          properties['Tags'] as Tag[] | undefined,
          previousProperties['Tags'] as Tag[] | undefined
        );
      }

      // Re-derive the attribute set so the deploy engine's state write keeps
      // GetAtt-served attributes (DNSName / LustreMountName / ResourceARN)
      // fresh across updates — an update result without attributes would
      // otherwise degrade Fn::GetAtt to the physical-id fallback. Best-effort:
      // the real update already succeeded at this point, so a transient
      // Describe failure must NOT fail (and roll back) the whole update —
      // returning without attributes lets the deploy engine carry the
      // previously-stored attributes forward, which is exactly the intended
      // degradation.
      if (!updatedFs) {
        try {
          const resp = await this.getClient().send(
            new DescribeFileSystemsCommand({ FileSystemIds: [physicalId] })
          );
          updatedFs = resp.FileSystems?.[0];
        } catch (describeError) {
          this.logger.debug(
            `Post-update attribute refresh for ${physicalId} failed (returning without attributes): ${
              describeError instanceof Error ? describeError.message : String(describeError)
            }`
          );
        }
      }

      this.logger.debug(`Successfully updated FSx FileSystem ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        ...(updatedFs && { attributes: this.buildAttributes(updatedFs) }),
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update FSx FileSystem ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Variant UPDATE diff ────────────────────────────────────────────

  /**
   * Which `<Variant>Configuration` block (if any) is present on either side
   * of the update. At most one is expected — the file system's type never
   * changes (FileSystemType is registry-createOnly, guarded above).
   */
  private detectVariantConfigKey(
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
   */
  private computeVariantConfigDiff(
    resourceType: string,
    logicalId: string,
    configKey: string,
    next: Record<string, unknown>,
    prev: Record<string, unknown>
  ): { diff: Record<string, unknown>; hasMutableDiff: boolean } {
    const mutable = VARIANT_MUTABLE_SUBPROPS[configKey] ?? new Set<string>();
    const keys = new Set([...Object.keys(next), ...Object.keys(prev)]);
    const diff: Record<string, unknown> = {};
    let hasMutableDiff = false;
    for (const key of keys) {
      const nextVal = next[key];
      const prevVal = prev[key];
      if (JSON.stringify(nextVal) === JSON.stringify(prevVal)) continue;
      if (!mutable.has(key)) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS FSx FileSystem ${configKey}.${key} is immutable on AWS — UpdateFileSystem cannot change it after creation. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
        );
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
    return { diff, hasMutableDiff };
  }

  /**
   * A sub-property listed in a `*_MUTABLE_SUBPROPS` set with no matching
   * `apply*UpdateField` case. Reaching here is a cdkd bug, not user error:
   * `computeVariantConfigDiff` already accepted the key as mutable, so
   * falling through would issue a no-op `UpdateFileSystem` (`hasMutableDiff`
   * true, empty diff) and silently drop the user's change. Fail loudly
   * instead so the missing mapping surfaces the moment it is added.
   */
  private unmappedMutableSubprop(ctx: VariantFieldContext, key: string): never {
    throw new ProvisioningError(
      `AWS FSx FileSystem ${ctx.configKey}.${key} is declared mutable but has no UpdateFileSystem mapping in cdkd. This is a cdkd bug — please report it at https://github.com/go-to-k/cdkd/issues`,
      ctx.resourceType,
      ctx.logicalId
    );
  }

  private applyLustreUpdateField(
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
      default:
        this.unmappedMutableSubprop(ctx, key);
    }
    return true;
  }

  private applyWindowsUpdateField(
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

  private applyOntapUpdateField(
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

  private applyOpenZFSUpdateField(
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

  /**
   * Apply a `Tags` diff via `TagResource` / `UntagResource` (the FSx
   * `UpdateFileSystem` API does not accept tags). Needs the ARN — resolve
   * it from `DescribeFileSystems`.
   */
  private async applyTagDiff(
    physicalId: string,
    nextTags: Tag[] | undefined,
    prevTags: Tag[] | undefined
  ): Promise<void> {
    const resp = await this.getClient().send(
      new DescribeFileSystemsCommand({ FileSystemIds: [physicalId] })
    );
    const arn = resp.FileSystems?.[0]?.ResourceARN;
    if (!arn) {
      throw new Error(`could not resolve ResourceARN for FSx FileSystem ${physicalId}`);
    }

    const next = new Map((nextTags ?? []).map((t) => [t.Key, t.Value]));
    const prev = new Map((prevTags ?? []).map((t) => [t.Key, t.Value]));

    const toSet: Tag[] = [];
    for (const [key, value] of next) {
      if (key === undefined) continue;
      if (prev.get(key) !== value) toSet.push({ Key: key, Value: value });
    }
    const toRemove: string[] = [];
    for (const key of prev.keys()) {
      if (key !== undefined && !next.has(key)) toRemove.push(key);
    }

    if (toSet.length > 0) {
      await this.getClient().send(new TagResourceCommand({ ResourceARN: arn, Tags: toSet }));
    }
    if (toRemove.length > 0) {
      await this.getClient().send(
        new UntagResourceCommand({ ResourceARN: arn, TagKeys: toRemove })
      );
    }
  }

  // ─── DELETE ────────────────────────────────────────────────────────

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting FSx FileSystem ${logicalId}: ${physicalId}`);

    try {
      // No delete-time configuration: matches CloudFormation, which calls
      // DeleteFileSystem with API defaults (SCRATCH Lustre deployments have
      // no final backup; PERSISTENT deployments take the API-default final
      // backup).
      await this.getClient().send(new DeleteFileSystemCommand({ FileSystemId: physicalId }));
    } catch (error) {
      if (error instanceof FileSystemNotFound) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`FSx FileSystem ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete FSx FileSystem ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }

    // Deletion is async — poll until the file system is GONE. A timeout is
    // a hard error (never warn-and-continue): a half-deleted FSx file
    // system keeps billing and the destroy must not report success.
    await this.waitForFileSystemDeleted(physicalId, logicalId, resourceType);

    this.logger.debug(`Successfully deleted FSx FileSystem ${logicalId}`);
  }

  // ─── Lifecycle polling ─────────────────────────────────────────────

  /**
   * Issue the polling `DescribeFileSystems` with bounded tolerance for
   * TRANSIENT errors (throttling / 5xx / connection resets): up to
   * `maxConsecutiveTransient` consecutive failures are absorbed (with the
   * normal poll delay) before the error propagates. A 5-10 minute create
   * poll at 15s intervals would otherwise turn a single throttle into a
   * spurious failure + best-effort rollback cycle. Non-transient errors
   * (incl. FileSystemNotFound) propagate immediately.
   */
  private async describeForPoll(
    fileSystemId: string,
    transientState: { count: number },
    maxConsecutiveTransient = 5
  ): Promise<FileSystem | undefined> {
    try {
      const response = await this.getClient().send(
        new DescribeFileSystemsCommand({ FileSystemIds: [fileSystemId] })
      );
      transientState.count = 0;
      return response.FileSystems?.[0];
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const msg = error instanceof Error ? error.message : String(error);
      const transient =
        name === 'ThrottlingException' ||
        name === 'ServiceLimitExceeded' ||
        name === 'InternalServerError' ||
        name === 'TimeoutError' ||
        /rate exceeded|too many requests|timed? ?out|ECONNRESET|EPIPE|socket hang up/i.test(msg);
      if (transient && transientState.count < maxConsecutiveTransient) {
        transientState.count += 1;
        this.logger.debug(
          `Transient DescribeFileSystems error while polling ${fileSystemId} (${transientState.count}/${maxConsecutiveTransient}): ${msg} — retrying`
        );
        // Signal "no data this round" — the caller's loop delay applies.
        return undefined;
      }
      throw error;
    }
  }

  private async waitForFileSystemAvailable(
    fileSystemId: string,
    logicalId: string,
    resourceType: string
  ): Promise<FileSystem> {
    const startTime = Date.now();
    const transientState = { count: 0 };

    while (Date.now() - startTime < this.maxWaitMs) {
      const fs = await this.describeForPoll(fileSystemId, transientState);
      const lifecycle = fs?.Lifecycle;

      if (fs && lifecycle === 'AVAILABLE') return fs;

      if (lifecycle === 'FAILED' || lifecycle === 'MISCONFIGURED') {
        const detail = fs?.FailureDetails?.Message ?? 'no failure details reported';
        throw new ProvisioningError(
          `FSx FileSystem ${fileSystemId} entered lifecycle state ${lifecycle}: ${detail}`,
          resourceType,
          logicalId,
          fileSystemId
        );
      }

      this.logger.debug(
        `FSx FileSystem ${fileSystemId} state: ${lifecycle ?? 'unknown'}, waiting...`
      );
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for FSx FileSystem ${fileSystemId} to become AVAILABLE (${Math.round(this.maxWaitMs / 60000)} min)`,
      resourceType,
      logicalId,
      fileSystemId
    );
  }

  /**
   * Wait until the async `FILE_SYSTEM_UPDATE` administrative action kicked
   * off by `UpdateFileSystem` completes (and the Lifecycle is AVAILABLE).
   * `STORAGE_OPTIMIZATION` actions are intentionally ignored — they can run
   * for hours after a capacity grow, and CloudFormation does not wait for
   * them either (`UPDATED_OPTIMIZING` counts as done). A FAILED update
   * action is a hard error carrying the action's failure message.
   *
   * `actionThresholdMs` scopes the wait to THIS update's actions: FSx keeps
   * terminal (COMPLETED / FAILED) actions in the history, so only actions
   * whose `RequestTime` is at or after the threshold are considered — a
   * PAST failed update must not fail this one's retry. An action without a
   * `RequestTime` is conservatively tracked.
   *
   * `requireActionObservation` guards the eventual-consistency race: when
   * the UpdateFileSystem response confirmed a newly-created action, the
   * wait refuses to return until an in-threshold action has been observed
   * in at least one Describe response — a lagging read replica could
   * otherwise briefly show none and cause a premature return with the
   * pre-update config. Terminal actions stay in the history, so the
   * observation is guaranteed to eventually succeed (bounded by
   * `maxWaitMs`).
   */
  private async waitForUpdateActionComplete(
    fileSystemId: string,
    logicalId: string,
    resourceType: string,
    actionThresholdMs: number,
    requireActionObservation: boolean
  ): Promise<FileSystem> {
    const startTime = Date.now();
    const transientState = { count: 0 };
    let seenTrackedAction = false;

    while (Date.now() - startTime < this.maxWaitMs) {
      const fs = await this.describeForPoll(fileSystemId, transientState);

      if (fs) {
        const updateActions = (fs.AdministrativeActions ?? []).filter(
          (a) =>
            a.AdministrativeActionType === 'FILE_SYSTEM_UPDATE' &&
            (a.RequestTime === undefined || a.RequestTime.getTime() >= actionThresholdMs)
        );
        if (updateActions.length > 0) seenTrackedAction = true;
        const failed = updateActions.find((a) => a.Status === 'FAILED');
        if (failed) {
          const detail = failed.FailureDetails?.Message ?? 'no failure details reported';
          throw new ProvisioningError(
            `FSx FileSystem ${fileSystemId} update failed (FILE_SYSTEM_UPDATE administrative action): ${detail}`,
            resourceType,
            logicalId,
            fileSystemId
          );
        }
        const inProgress = updateActions.some(
          (a) => a.Status === 'PENDING' || a.Status === 'IN_PROGRESS'
        );
        const observationSatisfied = !requireActionObservation || seenTrackedAction;
        if (!inProgress && observationSatisfied && fs.Lifecycle === 'AVAILABLE') return fs;

        this.logger.debug(
          `FSx FileSystem ${fileSystemId} update in progress (lifecycle: ${fs.Lifecycle ?? 'unknown'}), waiting...`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for FSx FileSystem ${fileSystemId} update to complete (${Math.round(this.maxWaitMs / 60000)} min)`,
      resourceType,
      logicalId,
      fileSystemId
    );
  }

  private async waitForFileSystemDeleted(
    fileSystemId: string,
    logicalId: string,
    resourceType: string
  ): Promise<void> {
    const startTime = Date.now();
    const transientState = { count: 0 };

    while (Date.now() - startTime < this.maxWaitMs) {
      let fs: FileSystem | undefined;
      let sawResponse = true;
      try {
        fs = await this.describeForPoll(fileSystemId, transientState);
        if (fs === undefined && transientState.count > 0) {
          // Transient error absorbed — not a "gone" signal.
          sawResponse = false;
        }
      } catch (error) {
        if (error instanceof FileSystemNotFound) return;
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(
          `Failed to poll FSx FileSystem ${fileSystemId} deletion: ${error instanceof Error ? error.message : String(error)}`,
          resourceType,
          logicalId,
          fileSystemId,
          cause
        );
      }

      if (!fs && sawResponse) return;
      if (!fs) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        continue;
      }

      if (fs.Lifecycle === 'FAILED') {
        const detail = fs.FailureDetails?.Message ?? 'no failure details reported';
        throw new ProvisioningError(
          `FSx FileSystem ${fileSystemId} entered lifecycle state FAILED during deletion: ${detail}`,
          resourceType,
          logicalId,
          fileSystemId
        );
      }

      this.logger.debug(
        `FSx FileSystem ${fileSystemId} state: ${fs.Lifecycle ?? 'unknown'}, waiting for deletion...`
      );
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for FSx FileSystem ${fileSystemId} deletion (${Math.round(this.maxWaitMs / 60000)} min) — verify and delete it manually to stop billing`,
      resourceType,
      logicalId,
      fileSystemId
    );
  }

  // ─── Attributes / drift / import ───────────────────────────────────

  private buildAttributes(fs: FileSystem): Record<string, unknown> {
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

  async getAttribute(
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

  // ─── readCurrentState variant reverse-mappers ──────────────────────
  //
  // Each maps a `DescribeFileSystems` variant block back to the flat CFn
  // `*Configuration` input shape cdkd stores in state. Read-only fields the
  // template never carries (`Endpoints`, `RootVolumeId`, `EndpointIpAddress`,
  // `RemoteAdministrationEndpoint`, `PreferredFileServerIp`,
  // `MaintenanceOperationsInProgress`) are deliberately NOT mapped — surfacing
  // them would add AWS-only keys the state baseline can never match. Inputs
  // AWS does not return at all stay in `getDriftUnknownPaths`.

  /** Map the read-side `LustreConfiguration` back to CFn input shape. */
  private readLustreConfiguration(lustre: LustreFileSystemConfiguration): Record<string, unknown> {
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
  private readWindowsConfiguration(
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
  private readOntapConfiguration(ontap: OntapFileSystemConfiguration): Record<string, unknown> {
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
    putIfDefined(
      config,
      'RouteTableIds',
      ontap.RouteTableIds ? [...ontap.RouteTableIds] : undefined
    );
    putIfDefined(config, 'EndpointIpv6AddressRange', ontap.EndpointIpv6AddressRange);
    // `FsxAdminPassword` is write-only — the API never echoes it back (see
    // getDriftUnknownPaths).

    const diskIops = this.readDiskIopsConfiguration(ontap.DiskIopsConfiguration);
    if (diskIops) config['DiskIopsConfiguration'] = diskIops;

    return config;
  }

  /** Map the read-side `OpenZFSConfiguration` back to CFn input shape. */
  private readOpenZFSConfiguration(
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
  private readDiskIopsConfiguration(
    diskIops: DiskIopsConfiguration | undefined
  ): Record<string, unknown> | undefined {
    if (!diskIops) return undefined;
    const out: Record<string, unknown> = {};
    putIfDefined(out, 'Mode', diskIops.Mode);
    putIfDefined(out, 'Iops', diskIops.Iops);
    return Object.keys(out).length > 0 ? out : undefined;
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
   *
   * The whole-block `WindowsConfiguration` / `OntapConfiguration` /
   * `OpenZFSConfiguration` entries are gone as of the variant reverse-mappers
   * — only the individually-unreadable leaves above stay unknown.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::FSx::FileSystem') return [];
    return [
      'SecurityGroupIds',
      'BackupId',
      'WindowsConfiguration.SelfManagedActiveDirectoryConfiguration.Password',
      'OntapConfiguration.FsxAdminPassword',
      'OpenZFSConfiguration.RootVolumeConfiguration',
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
  getDriftUnorderedPaths(resourceType: string): string[] {
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
   * Emission follows `docs/provider-development.md` §3b: every top-level
   * property `update()` can mutate is emitted unconditionally with a
   * placeholder, registry-createOnly properties keep their guard, and the
   * `<Variant>Configuration` blocks take the Class 1 type-discriminator
   * carve-out — exactly the ONE block matching `FileSystemType` is emitted
   * (at most one is ever legal on AWS), never the other three.
   * Returns `undefined` when the file system is gone.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    if (resourceType !== 'AWS::FSx::FileSystem') return undefined;

    let fs: FileSystem | undefined;
    try {
      const resp = await this.getClient().send(
        new DescribeFileSystemsCommand({ FileSystemIds: [physicalId] })
      );
      fs = resp.FileSystems?.[0];
    } catch (err) {
      if (err instanceof FileSystemNotFound) return undefined;
      throw err;
    }
    if (!fs) return undefined;

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
        // cdkd does not support yet.
        break;
    }

    return result;
  }

  /**
   * Adopt an existing FSx file system into cdkd state. Explicit physical
   * id is verified via `DescribeFileSystems`; otherwise a paginated walk
   * matches the `aws:cdk:path` tag (`Tags` ride inline on each item).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
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

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeFileSystemsCommand({ ...(nextToken && { NextToken: nextToken }) })
      );
      for (const fs of list.FileSystems ?? []) {
        if (!fs.FileSystemId) continue;
        if (matchesCdkPath(fs.Tags, input.cdkPath)) {
          return { physicalId: fs.FileSystemId, attributes: this.buildAttributes(fs) };
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }
}
