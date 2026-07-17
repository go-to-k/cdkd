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
 * v1 scope: the **Lustre** variant (the CDK L2, `aws-fsx.LustreFileSystem`).
 * The `WindowsConfiguration` / `OntapConfiguration` / `OpenZFSConfiguration`
 * sub-trees are declared `unhandledByDesign`, so templates using them are
 * rejected by the property-coverage pre-flight instead of silently dropping
 * the whole variant config (each non-Lustre `FileSystemType` REQUIRES its
 * variant block, so no non-Lustre template can slip past the pre-flight).
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
        'SecurityGroupIds',
        'StorageCapacity',
        'StorageType',
        'SubnetIds',
        'Tags',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::FSx::FileSystem',
      new Map<string, string>([
        [
          'WindowsConfiguration',
          'FSx for Windows File Server variant — requires Active Directory wiring and Windows-specific update/delete semantics (final backups, throughput tiers) that v1 does not implement; only the Lustre variant (the CDK L2) is supported. Follow-up to issue #1042.',
        ],
        [
          'OntapConfiguration',
          'FSx for NetApp ONTAP variant — the file system is only a container for SVMs/volumes (separate AWS::FSx::StorageVirtualMachine / AWS::FSx::Volume types, both still unsupported), so shipping it alone would be misleading; only the Lustre variant is supported in v1. Follow-up to issue #1042.',
        ],
        [
          'OpenZFSConfiguration',
          'FSx for OpenZFS variant — root-volume semantics (RootVolumeId, child AWS::FSx::Volume trees) are not implemented in v1; only the Lustre variant is supported. Follow-up to issue #1042.',
        ],
      ]),
    ],
  ]);

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

    // Defensive: the property-coverage pre-flight already rejects the
    // Windows/ONTAP/OpenZFS config blocks, and every non-Lustre
    // FileSystemType requires its block — but refuse clearly if a
    // non-Lustre create reaches us anyway (e.g. via
    // --allow-unsupported-properties).
    if (backupId === undefined && fileSystemType !== 'LUSTRE') {
      throw new ProvisioningError(
        `AWS::FSx::FileSystem: FileSystemType '${fileSystemType ?? '(unset)'}' is not supported by cdkd yet — only the LUSTRE variant is implemented (issue #1042). Windows / ONTAP / OpenZFS file systems can follow in a later PR.`,
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
      LustreConfiguration: this.toCreateLustreConfiguration(
        properties['LustreConfiguration'] as Record<string, unknown> | undefined
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

    // Lustre sub-property immutability: the CFn registry schema does NOT
    // mark LustreConfiguration (or its sub-fields) createOnly, so the
    // schema-based replacement fallback never fires for them — the
    // provider must classify them itself. Reject changes on sub-fields
    // UpdateFileSystem cannot express.
    const nextLustre = (properties['LustreConfiguration'] ?? {}) as Record<string, unknown>;
    const prevLustre = (previousProperties['LustreConfiguration'] ?? {}) as Record<string, unknown>;
    const lustreKeys = new Set([...Object.keys(nextLustre), ...Object.keys(prevLustre)]);
    const lustreMutableDiff: UpdateFileSystemLustreConfiguration = {};
    let lustreHasMutableDiff = false;
    for (const key of lustreKeys) {
      const next = nextLustre[key];
      const prev = prevLustre[key];
      if (JSON.stringify(next) === JSON.stringify(prev)) continue;
      if (!LUSTRE_MUTABLE_SUBPROPS.has(key)) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS FSx FileSystem LustreConfiguration.${key} is immutable on AWS — UpdateFileSystem cannot change it after creation. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
        );
      }
      lustreHasMutableDiff = true;
      switch (key) {
        case 'WeeklyMaintenanceStartTime':
        case 'DailyAutomaticBackupStartTime':
          (lustreMutableDiff as Record<string, unknown>)[key] = next as string | undefined;
          break;
        case 'AutomaticBackupRetentionDays':
        case 'PerUnitStorageThroughput':
        case 'ThroughputCapacity':
          (lustreMutableDiff as Record<string, unknown>)[key] = toNumber(next);
          break;
        case 'AutoImportPolicy':
        case 'DataCompressionType':
          (lustreMutableDiff as Record<string, unknown>)[key] = next;
          break;
        case 'MetadataConfiguration': {
          const metadata = next as Record<string, unknown> | undefined;
          lustreMutableDiff.MetadataConfiguration = metadata
            ? {
                Mode: metadata['Mode'] as 'AUTOMATIC' | 'USER_PROVISIONED' | undefined,
                Iops: toNumber(metadata['Iops']),
              }
            : undefined;
          break;
        }
        case 'DataReadCacheConfiguration': {
          const readCache = next as Record<string, unknown> | undefined;
          lustreMutableDiff.DataReadCacheConfiguration = readCache
            ? {
                SizingMode: readCache['SizingMode'] as LustreReadCacheSizingMode,
                SizeGiB: toNumber(readCache['SizeGiB']),
              }
            : undefined;
          break;
        }
      }
    }

    const storageCapacityChanged = changed('StorageCapacity');
    const storageTypeChanged = changed('StorageType');
    const typeVersionChanged = changed('FileSystemTypeVersion');
    const networkTypeChanged = changed('NetworkType');
    const tagsChanged = changed('Tags');

    if (
      !lustreHasMutableDiff &&
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
        lustreHasMutableDiff ||
        storageCapacityChanged ||
        storageTypeChanged ||
        typeVersionChanged ||
        networkTypeChanged;

      let updatedFs: FileSystem | undefined;

      if (needsUpdateCall) {
        await this.getClient().send(
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
            ...(lustreHasMutableDiff && { LustreConfiguration: lustreMutableDiff }),
          })
        );

        // UpdateFileSystem applies the change via an ASYNC administrative
        // action (`AdministrativeActions[].Type: FILE_SYSTEM_UPDATE`) — the
        // Lifecycle can report AVAILABLE while the config change has not
        // propagated to the Describe view yet (observed live: a
        // DataCompressionType NONE -> LZ4 change still read NONE seconds
        // after UpdateFileSystem returned). Wait until the update action
        // completes so the next read (drift compare, verify scripts) sees
        // the final values — CloudFormation waits the same way.
        updatedFs = await this.waitForUpdateActionComplete(physicalId, logicalId, resourceType);
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
      // otherwise degrade Fn::GetAtt to the physical-id fallback.
      if (!updatedFs) {
        const resp = await this.getClient().send(
          new DescribeFileSystemsCommand({ FileSystemIds: [physicalId] })
        );
        updatedFs = resp.FileSystems?.[0];
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
   */
  private async waitForUpdateActionComplete(
    fileSystemId: string,
    logicalId: string,
    resourceType: string
  ): Promise<FileSystem> {
    const startTime = Date.now();
    const transientState = { count: 0 };

    while (Date.now() - startTime < this.maxWaitMs) {
      const fs = await this.describeForPoll(fileSystemId, transientState);

      if (fs) {
        const updateActions = (fs.AdministrativeActions ?? []).filter(
          (a) => a.AdministrativeActionType === 'FILE_SYSTEM_UPDATE'
        );
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
        if (!inProgress && fs.Lifecycle === 'AVAILABLE') return fs;

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

  /**
   * State property paths this provider cannot read back from AWS:
   *  - `SecurityGroupIds` — `DescribeFileSystems` returns network
   *    interface ids, never the original security group list.
   *  - `BackupId` — creation-source input, not surfaced on the deployed
   *    file system.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType !== 'AWS::FSx::FileSystem') return [];
    return ['SecurityGroupIds', 'BackupId'];
  }

  /**
   * Read the AWS-current file system configuration in CFn-property shape
   * via `DescribeFileSystems`. Lustre data-repository fields (`ImportPath`
   * / `ExportPath` / `AutoImportPolicy` / `ImportedFileChunkSize`) are
   * mapped back from the nested `DataRepositoryConfiguration` the API
   * returns. Returns `undefined` when the file system is gone.
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
    if (fs.FileSystemType !== undefined) result['FileSystemType'] = fs.FileSystemType;
    if (fs.StorageCapacity !== undefined) result['StorageCapacity'] = fs.StorageCapacity;
    if (fs.StorageType !== undefined) result['StorageType'] = fs.StorageType;
    if (fs.SubnetIds !== undefined) result['SubnetIds'] = [...fs.SubnetIds];
    if (fs.KmsKeyId !== undefined) result['KmsKeyId'] = fs.KmsKeyId;
    if (fs.FileSystemTypeVersion !== undefined) {
      result['FileSystemTypeVersion'] = fs.FileSystemTypeVersion;
    }
    if (fs.NetworkType !== undefined) result['NetworkType'] = fs.NetworkType;

    const lustre = fs.LustreConfiguration;
    if (lustre) {
      const config: Record<string, unknown> = {};
      if (lustre.WeeklyMaintenanceStartTime !== undefined) {
        config['WeeklyMaintenanceStartTime'] = lustre.WeeklyMaintenanceStartTime;
      }
      if (lustre.DeploymentType !== undefined) config['DeploymentType'] = lustre.DeploymentType;
      if (lustre.PerUnitStorageThroughput !== undefined) {
        config['PerUnitStorageThroughput'] = lustre.PerUnitStorageThroughput;
      }
      if (lustre.DailyAutomaticBackupStartTime !== undefined) {
        config['DailyAutomaticBackupStartTime'] = lustre.DailyAutomaticBackupStartTime;
      }
      if (lustre.AutomaticBackupRetentionDays !== undefined) {
        config['AutomaticBackupRetentionDays'] = lustre.AutomaticBackupRetentionDays;
      }
      if (lustre.CopyTagsToBackups !== undefined) {
        config['CopyTagsToBackups'] = lustre.CopyTagsToBackups;
      }
      if (lustre.DriveCacheType !== undefined) config['DriveCacheType'] = lustre.DriveCacheType;
      if (lustre.DataCompressionType !== undefined) {
        config['DataCompressionType'] = lustre.DataCompressionType;
      }
      if (lustre.EfaEnabled !== undefined) config['EfaEnabled'] = lustre.EfaEnabled;
      if (lustre.ThroughputCapacity !== undefined) {
        config['ThroughputCapacity'] = lustre.ThroughputCapacity;
      }
      if (lustre.MetadataConfiguration) {
        const metadata: Record<string, unknown> = {};
        if (lustre.MetadataConfiguration.Mode !== undefined) {
          metadata['Mode'] = lustre.MetadataConfiguration.Mode;
        }
        if (lustre.MetadataConfiguration.Iops !== undefined) {
          metadata['Iops'] = lustre.MetadataConfiguration.Iops;
        }
        if (Object.keys(metadata).length > 0) config['MetadataConfiguration'] = metadata;
      }
      if (lustre.DataReadCacheConfiguration) {
        const readCache: Record<string, unknown> = {};
        if (lustre.DataReadCacheConfiguration.SizingMode !== undefined) {
          readCache['SizingMode'] = lustre.DataReadCacheConfiguration.SizingMode;
        }
        if (lustre.DataReadCacheConfiguration.SizeGiB !== undefined) {
          readCache['SizeGiB'] = lustre.DataReadCacheConfiguration.SizeGiB;
        }
        if (Object.keys(readCache).length > 0) config['DataReadCacheConfiguration'] = readCache;
      }
      // Data-repository fields live under DataRepositoryConfiguration on
      // the read side but are flat LustreConfiguration inputs in CFn.
      const dataRepo = lustre.DataRepositoryConfiguration;
      if (dataRepo) {
        if (dataRepo.ImportPath !== undefined) config['ImportPath'] = dataRepo.ImportPath;
        if (dataRepo.ExportPath !== undefined) config['ExportPath'] = dataRepo.ExportPath;
        if (dataRepo.AutoImportPolicy !== undefined) {
          config['AutoImportPolicy'] = dataRepo.AutoImportPolicy;
        }
        if (dataRepo.ImportedFileChunkSize !== undefined) {
          config['ImportedFileChunkSize'] = dataRepo.ImportedFileChunkSize;
        }
      }
      if (Object.keys(config).length > 0) result['LustreConfiguration'] = config;
    }

    result['Tags'] = normalizeAwsTagsToCfn(fs.Tags);

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
