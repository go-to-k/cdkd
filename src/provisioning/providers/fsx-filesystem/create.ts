import type { FSxFileSystemProvider } from '../fsx-filesystem-provider.js';
import {
  CreateFileSystemCommand,
  CreateFileSystemFromBackupCommand,
  DeleteFileSystemCommand,
  type CreateFileSystemLustreConfiguration,
  type CreateFileSystemWindowsConfiguration,
  type CreateFileSystemOntapConfiguration,
  type CreateFileSystemOpenZFSConfiguration,
  type LustreLogCreateConfiguration,
  type FileSystem,
  type FileSystemType,
  type StorageType,
  type NetworkType,
  type LustreReadCacheSizingMode,
} from '@aws-sdk/client-fsx';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { earliestDefined, reserveStackCreateToken } from '../create-token-ledger.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { earliestOwnCreationTime, serverClockReading, withServerClock } from '../server-clock.js';
import { withPasteableAwsProfile } from '../../../utils/pasteable-aws-profile.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { VARIANT_CONFIG_KEY, toNumber, toBoolean } from './shared.js';

export async function create(
  this: FSxFileSystemProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
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
  // from the backup, so they skip this check. `Object.hasOwn`, not `in`
  // (issue #3515): a type named after an `Object.prototype` member
  // (`constructor`, `toString`) answered `in` and passed the guard.
  if (
    backupId === undefined &&
    !(fileSystemType !== undefined && Object.hasOwn(VARIANT_CONFIG_KEY, fileSystemType))
  ) {
    throw new ProvisioningError(
      `AWS::FSx::FileSystem: FileSystemType '${fileSystemType ?? '(unset)'}' is not supported by cdkd — expected one of ${Object.keys(VARIANT_CONFIG_KEY).join(' / ')}.`,
      resourceType,
      logicalId
    );
  }

  this.logger.debug(`Creating FSx FileSystem ${logicalId}`);

  // ClientRequestToken is FSx's idempotency key: a Create with a token
  // whose file system still exists and whose parameters match is answered
  // with THAT file system instead of a new one (load-bearing for a
  // lost-response retry under the deploy engine's outer withRetry). It must
  // be STABLE across retries of THIS create, DIFFER between the old and new
  // file system during a property-driven REPLACEMENT (so hash ONLY the
  // immutable, createOnly inputs), and be SCOPED to this stack — a token
  // shared with another stack's copy of this logical id is handed that
  // stack's file system (go-to-k/cdkd#4428). `stackScopedCreateToken` owns
  // all three; `reserveStackCreateToken` adds the stack's create-token ledger
  // (go-to-k/cdkd#4438): a nonce replaced whenever cdkd lets go of resources
  // it made, so a file system a destroy kept no longer holds the token, and
  // a marker persisted before the create, so a re-run after an interruption
  // sends the same token and is handed the file system it made.
  // EFSProvider's CreationToken takes the same derivation.
  //
  // NOTE the hash deliberately covers only the REGISTRY-createOnly
  // top-level properties, not the provider-classified immutable Lustre
  // sub-properties (DeploymentType / ImportPath / ...). Those changes are
  // rejected by update() with a --replace pointer, and the deploy
  // engine's --replace replacement is DELETE → wait-for-gone → CREATE,
  // so the old file system (and its token) no longer exists when the new
  // create runs — no token collision is possible on that path.
  //
  // FSx ClientRequestToken max length is 63 chars.
  const reservation = await reserveStackCreateToken({
    logicalId,
    immutableInputs: [
      properties['FileSystemType'],
      properties['SubnetIds'],
      properties['SecurityGroupIds'],
      properties['KmsKeyId'],
      properties['BackupId'],
    ],
    maxLength: 63,
  });
  const clientRequestToken = reservation.value;

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
    Tags:
      properties['Tags'] !== undefined && properties['Tags'] !== null
        ? tags.map((t) => ({ Key: t.Key, Value: t.Value }))
        : undefined,
  };

  let fileSystemId: string | undefined;
  // This create's first send: the earliest of this process's earlier attempt
  // and the one the ledger recorded (this run's, or an earlier, interrupted
  // run's), else now.
  const firstSentAt =
    earliestDefined(
      this.createTokenFirstSentAt.get(clientRequestToken),
      reservation.earlierFirstSentAt
    ) ?? Date.now();
  this.createTokenFirstSentAt.set(clientRequestToken, firstSentAt);

  try {
    let created: FileSystem | undefined;
    // Recorded per command: AWS's `Date` for the answered attempt, so the
    // creation-time gate below runs on AWS's clock, not this host's.
    let createCommand: object;
    if (backupId !== undefined) {
      // BackupId routes to a DIFFERENT API — CreateFileSystemFromBackup
      // (FileSystemType is derived from the backup and not a valid param).
      const command = withServerClock(
        new CreateFileSystemFromBackupCommand({ ...common, BackupId: backupId })
      );
      createCommand = command;
      const response = await this.getClient().send(command);
      created = response.FileSystem;
    } else {
      const command = withServerClock(
        new CreateFileSystemCommand({
          ...common,
          FileSystemType: fileSystemType as FileSystemType,
        })
      );
      createCommand = command;
      const response = await this.getClient().send(command);
      created = response.FileSystem;
    }

    const returnedId = created?.FileSystemId;
    if (!returnedId) {
      throw new ProvisioningError(
        `FSx CreateFileSystem for ${logicalId} returned no FileSystemId`,
        resourceType,
        logicalId
      );
    }
    // FSx answers a token that still names a file system with THAT file
    // system. Besides this create's own earlier attempt, the token can be
    // held by one made outside the stack's create-token ledger: under an
    // earlier cdkd, or kept by a destroy while the ledger could not be
    // updated (#4438).
    // Recording such a file system as CREATED would hand it to every delete
    // path a create owns -- the cleanup below, a rollback of this deploy --
    // so only one created after this create's FIRST send is taken; anything
    // older, or carrying no creation time, is refused and left untouched.
    // The comparison is on AWS's clock (`earliestOwnCreationTime`): a host
    // clock running fast must not refuse an ordinary create.
    const createdAt = created?.CreationTime?.getTime();
    if (
      createdAt === undefined ||
      createdAt < earliestOwnCreationTime(firstSentAt, serverClockReading(createCommand))
    ) {
      const inspect = withPasteableAwsProfile('aws fsx describe-file-systems');
      throw markNonRetryable(
        new ProvisioningError(
          safeMsg`FSx answered the create of ${logicalId} with file system ${returnedId}, which ${
            createdAt === undefined ? 'carries no creation time' : 'predates this create'
          }: the create token cdkd derives for this stack's file system is held by it, and it is NOT recorded in cdkd state. It is not one this deploy, or an interrupted earlier deploy of this stack, made: it was created under this token by an earlier cdkd version, or a completed deploy recorded it and cdkd later let go of it, and it may hold data, so cdkd neither records nor deletes it. Inspect it with: ${inspect} --file-system-ids ${returnedId} -- then import it into this stack, or delete it once you are sure its data is not needed, and deploy again.`,
          resourceType,
          logicalId
        )
      );
    }
    fileSystemId = returnedId;
    reportCreatedResource(logicalId, resourceType, returnedId); // go-to-k/cdkd#5511

    // FSx creation is async (typically 5-10 min for Lustre SCRATCH,
    // longer for PERSISTENT) — poll until AVAILABLE.
    const fs = await this.waitForFileSystemAvailable(
      fileSystemId,
      logicalId,
      resourceType,
      context?.maskSecrets
    );

    this.logger.debug(`Successfully created FSx FileSystem ${logicalId}: ${fileSystemId}`);
    this.createTokenFirstSentAt.delete(clientRequestToken);

    return {
      physicalId: fileSystemId,
      attributes: this.buildAttributes(fs),
    };
  } catch (error) {
    // Atomicity: if the create call succeeded but polling failed (the
    // file system went FAILED, or the wait timed out), create() is about
    // to throw without returning a physicalId — the deploy engine cannot
    // roll it back, and an orphaned FSx file system bills per hour.
    // Best-effort delete it here. `fileSystemId` is set only once the
    // returned file system passed the creation-time check above, so this
    // never deletes one FSx handed back from before this create.
    // go-to-k/cdkd#4583: the id of a file system this create made and could
    // not delete, named for the failed-CREATE journal.
    let survivorId: string | undefined;
    if (fileSystemId !== undefined) {
      try {
        await this.getClient().send(new DeleteFileSystemCommand({ FileSystemId: fileSystemId }));
        retractCreatedResource(logicalId, resourceType, fileSystemId);
        this.createTokenFirstSentAt.delete(clientRequestToken);
        this.logger.warn(`Rolled back partially-created FSx FileSystem ${fileSystemId}`);
      } catch (cleanupError) {
        survivorId = fileSystemId;
        const cleanupHead = `Failed to roll back partially-created FSx FileSystem ${fileSystemId}: `;
        this.logger.warn(
          `${cleanupHead}${this.cleanupFailureText(cleanupHead, cleanupError, context?.maskSecrets)} — outside a rollback's re-create, the failed deploy's rollback journal records it for \`cdkd rollback --revert-failed\`; otherwise delete it yourself to stop billing`
        );
      }
    }
    if (error instanceof ProvisioningError) {
      if (survivorId !== undefined) {
        markCreatedBeforeFailure(error, logicalId, resourceType, survivorId);
      }
      throw error;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create FSx FileSystem ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (survivorId !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, survivorId);
    }
    throw thrown;
  }
}

/**
 * Map the CFn `LustreConfiguration` block to the SDK create shape. The
 * field names are identical (both PascalCase); numeric / boolean fields
 * are coerced defensively because template values can arrive as strings.
 */
export function toCreateLustreConfiguration(
  this: FSxFileSystemProvider,
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
    LogConfiguration: this.toLustreLogConfiguration(
      config['LogConfiguration'] as Record<string, unknown> | undefined
    ),
  };
  return out;
}

/**
 * Map the CFn `LustreConfiguration.LogConfiguration` block to the SDK shape
 * `CreateFileSystem` and `UpdateFileSystem` both take (go-to-k/cdkd#5430).
 */
export function toLustreLogConfiguration(
  this: FSxFileSystemProvider,
  config: Record<string, unknown> | undefined
): LustreLogCreateConfiguration | undefined {
  if (!config) return undefined;
  return {
    Level: config['Level'] as LustreLogCreateConfiguration['Level'],
    Destination: config['Destination'] as string | undefined,
  };
}

/** Map the CFn `WindowsConfiguration` block to the SDK create shape. */
export function toCreateWindowsConfiguration(
  this: FSxFileSystemProvider,
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
export function toCreateOntapConfiguration(
  this: FSxFileSystemProvider,
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
export function toCreateOpenZFSConfiguration(
  this: FSxFileSystemProvider,
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
