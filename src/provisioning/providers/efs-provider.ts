import {
  EFSClient,
  type CreateFileSystemCommandInput,
  type FileSystemDescription,
  type AccessPointDescription,
  type CreateAccessPointCommandInput,
} from '@aws-sdk/client-efs';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { type DeleteContext } from '../region-check.js';
import { type StackCreateToken } from './create-token-ledger.js';
import { type ResourceNotFound } from '../../types/resource.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
} from '../../types/resource.js';
import { type MaskedLogSinks } from '../masked-retry-logger.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  getClient,
  getMountTargetCreateClient,
  wrapMaskedError,
  wrapDeleteError,
  create,
  update,
  applyTagDiff,
  deleteImpl,
  retryOnTransientControlPlane,
  readCurrentState,
  importImpl,
} from './efs/core.js';
import {
  updateFileSystem,
  applyLifecyclePolicies,
  applyBackupPolicy,
  applyFileSystemPolicy,
  deleteFileSystemPolicy,
  applyFileSystemProtection,
  deleteFileSystem,
} from './efs/file-system.js';
import {
  warnOfPreLedgerHolder,
  createFileSystem,
  sendCreateFileSystem,
  foreignHolderMessage,
  waitForFileSystemAvailable,
} from './efs/file-system-create.js';
import {
  updateMountTarget,
  createMountTarget,
  optionalMountTargetString,
  waitForMountTargetAvailable,
  deleteMountTarget,
  waitForMountTargetDeleted,
} from './efs/mount-target.js';
import {
  updateAccessPoint,
  createAccessPoint,
  createOrAdoptAccessPoint,
  deleteAccessPoint,
} from './efs/access-point.js';
import {
  readFileSystem,
  readAccessPoint,
  readMountTarget,
  importFileSystem,
  importMountTarget,
  importAccessPoint,
} from './efs/read-state.js';

/**
 * SDK Provider for AWS EFS resources
 *
 * Supports:
 * - AWS::EFS::FileSystem
 * - AWS::EFS::MountTarget
 * - AWS::EFS::AccessPoint
 *
 * EFS CreateFileSystem/CreateAccessPoint are synchronous.
 * MountTarget requires polling until state becomes "available".
 */
export class EFSProvider implements ResourceProvider {
  client: EFSClient | undefined;
  mountTargetCreateClient: EFSClient | undefined;
  readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('EFSProvider');
  /**
   * File-system creation tokens under which THIS process may hold a file
   * system that no `createFileSystem` call has yet returned or deleted: the
   * create was answered and a later step failed, or the create ended
   * AMBIGUOUS (a 5xx, a timeout, a reset) with no response read. Each maps to
   * the time of the FIRST such send. Only such a token's
   * `FileSystemAlreadyExists` can be a replay of this process's own create —
   * see `sendCreateFileSystem`. The token is stack- and region-scoped, so one
   * entry never speaks for another stack.
   */
  readonly unconfirmedCreationTokens = new Map<string, number>();

  /**
   * Issue #1160: what CloudFormation resets a REMOVED `BackupPolicy` /
   * `FileSystemProtection` to (live CFn A/B: its update sent `PutBackupPolicy
   * {Status: DISABLED}` and `UpdateFileSystemProtection
   * {ReplicationOverwriteProtection: ENABLED}`). A removed `FileSystemPolicy`
   * is a `DeleteFileSystemPolicy`, not a value, so it stays in `updateFileSystem`.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    [
      'AWS::EFS::FileSystem',
      new Map<string, unknown>([
        ['BackupPolicy', { Status: 'DISABLED' }],
        ['FileSystemProtection', { ReplicationOverwriteProtection: 'ENABLED' }],
      ]),
    ],
  ]);

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EFS::FileSystem',
      new Set([
        'FileSystemTags',
        'Encrypted',
        'KmsKeyId',
        'PerformanceMode',
        'ThroughputMode',
        'ProvisionedThroughputInMibps',
        'AvailabilityZoneName',
        'LifecyclePolicies',
        'BackupPolicy',
        'FileSystemPolicy',
        'BypassPolicyLockoutSafetyCheck',
        'FileSystemProtection',
      ]),
    ],
    [
      'AWS::EFS::MountTarget',
      new Set([
        'FileSystemId',
        'SubnetId',
        'SecurityGroups',
        'IpAddress',
        'IpAddressType',
        'Ipv6Address',
      ]),
    ],
    [
      'AWS::EFS::AccessPoint',
      new Set(['FileSystemId', 'PosixUser', 'RootDirectory', 'AccessPointTags']),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::EFS::FileSystem',
      new Map<string, string>([
        [
          'ReplicationConfiguration',
          'Cross-region EFS replication (CreateReplicationConfiguration) provisions a separate destination file system in another region with its own lifecycle, KMS key, and availability-zone placement; replicating + then tearing down the destination on destroy is a multi-resource, cross-region orchestration that is out of scope for the single-resource SDK provider.',
        ],
      ]),
    ],
    [
      'AWS::EFS::AccessPoint',
      new Map<string, string>([
        [
          'ClientToken',
          'cdkd supplies its own retry-stable ClientToken on CreateAccessPoint, so a template-supplied value would be overwritten. The SDK does not own this field either: an omitted ClientToken is auto-filled with a FRESH uuid per attempt, which leaves a retried 500 free to mint a second access point, while a caller-supplied value goes on the wire verbatim.',
        ],
      ]),
    ],
  ]);

  getClient(): EFSClient {
    return getClient.call(this);
  }

  getMountTargetCreateClient(): EFSClient {
    return getMountTargetCreateClient.call(this);
  }

  wrapMaskedError(
    log: MaskedLogSinks,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedError.call(this, log, error, build);
  }

  wrapDeleteError(
    log: MaskedLogSinks,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapDeleteError.call(this, log, error, build);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  applyTagDiff(
    resourceId: string,
    resourceType: string,
    logicalId: string,
    recorded: unknown,
    desired: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    return applyTagDiff.call(this, resourceId, resourceType, logicalId, recorded, desired, log);
  }

  updateAccessPoint(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    return updateAccessPoint.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log
    );
  }

  updateFileSystem(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    stateBorneDesired: boolean
  ): Promise<ResourceUpdateResult> {
    return updateFileSystem.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      stateBorneDesired
    );
  }

  updateMountTarget(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    return updateMountTarget.call(this, logicalId, physicalId, resourceType, properties, log);
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  warnOfPreLedgerHolder(logicalId: string, base: string, log: MaskedLogSinks): Promise<void> {
    return warnOfPreLedgerHolder.call(this, logicalId, base, log);
  }

  createFileSystem(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createFileSystem.call(this, logicalId, resourceType, properties, log);
  }

  sendCreateFileSystem(
    logicalId: string,
    resourceType: string,
    reservation: StackCreateToken,
    input: CreateFileSystemCommandInput & { CreationToken: string }
  ): Promise<{ fileSystemId: string; arn: string | undefined }> {
    return sendCreateFileSystem.call(this, logicalId, resourceType, reservation, input);
  }

  foreignHolderMessage(
    logicalId: string,
    token: string,
    holderId: string | undefined,
    why: string
  ): string {
    return foreignHolderMessage.call(this, logicalId, token, holderId, why);
  }

  applyLifecyclePolicies(
    fileSystemId: string,
    spec: unknown,
    log: MaskedLogSinks,
    previousSpec?: unknown
  ): Promise<void> {
    return applyLifecyclePolicies.call(this, fileSystemId, spec, log, previousSpec);
  }

  applyBackupPolicy(fileSystemId: string, spec: unknown, log: MaskedLogSinks): Promise<void> {
    return applyBackupPolicy.call(this, fileSystemId, spec, log);
  }

  applyFileSystemPolicy(
    fileSystemId: string,
    policy: unknown,
    bypass: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    return applyFileSystemPolicy.call(this, fileSystemId, policy, bypass, log);
  }

  deleteFileSystemPolicy(fileSystemId: string, log: MaskedLogSinks): Promise<void> {
    return deleteFileSystemPolicy.call(this, fileSystemId, log);
  }

  applyFileSystemProtection(
    fileSystemId: string,
    spec: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    return applyFileSystemProtection.call(this, fileSystemId, spec, log);
  }

  retryOnTransientControlPlane<T>(
    op: () => Promise<T>,
    label: string,
    log: MaskedLogSinks,
    maxAttempts?: number
  ): Promise<T> {
    return retryOnTransientControlPlane.call<
      EFSProvider,
      [() => Promise<T>, string, MaskedLogSinks, number | undefined],
      Promise<T>
    >(this, op, label, log, maxAttempts);
  }

  deleteFileSystem(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteFileSystem.call(this, logicalId, physicalId, resourceType, context);
  }

  waitForFileSystemAvailable(
    fileSystemId: string,
    logicalId: string,
    resourceType: string,
    log: MaskedLogSinks
  ): Promise<FileSystemDescription> {
    return waitForFileSystemAvailable.call(this, fileSystemId, logicalId, resourceType, log);
  }

  createMountTarget(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createMountTarget.call(this, logicalId, resourceType, properties, log, context);
  }

  optionalMountTargetString(
    value: unknown,
    key: 'IpAddress' | 'IpAddressType' | 'Ipv6Address',
    logicalId: string,
    context: CreateContext | undefined
  ): string | undefined {
    return optionalMountTargetString.call(this, value, key, logicalId, context);
  }

  waitForMountTargetAvailable(
    mountTargetId: string,
    logicalId: string,
    resourceType: string,
    log: MaskedLogSinks
  ): Promise<void> {
    return waitForMountTargetAvailable.call(this, mountTargetId, logicalId, resourceType, log);
  }

  deleteMountTarget(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteMountTarget.call(this, logicalId, physicalId, resourceType, context);
  }

  waitForMountTargetDeleted(mountTargetId: string, logicalId: string): Promise<void> {
    return waitForMountTargetDeleted.call(this, mountTargetId, logicalId);
  }

  createAccessPoint(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createAccessPoint.call(this, logicalId, resourceType, properties, log);
  }

  createOrAdoptAccessPoint(
    logicalId: string,
    resourceType: string,
    log: MaskedLogSinks,
    input: CreateAccessPointCommandInput & { ClientToken: string }
  ): Promise<Pick<AccessPointDescription, 'AccessPointId' | 'AccessPointArn'>> {
    return createOrAdoptAccessPoint.call(this, logicalId, resourceType, log, input);
  }

  deleteAccessPoint(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteAccessPoint.call(this, logicalId, physicalId, resourceType, context);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType);
  }

  readFileSystem(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readFileSystem.call(this, physicalId);
  }

  readAccessPoint(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readAccessPoint.call(this, physicalId);
  }

  readMountTarget(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readMountTarget.call(this, physicalId);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  importFileSystem(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importFileSystem.call(this, input);
  }

  importMountTarget(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importMountTarget.call(this, input);
  }

  importAccessPoint(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importAccessPoint.call(this, input);
  }
}
