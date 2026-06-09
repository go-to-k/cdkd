import {
  EFSClient,
  CreateFileSystemCommand,
  UpdateFileSystemCommand,
  DeleteFileSystemCommand,
  CreateMountTargetCommand,
  DeleteMountTargetCommand,
  DescribeMountTargetsCommand,
  ModifyMountTargetSecurityGroupsCommand,
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  DescribeFileSystemsCommand,
  DescribeAccessPointsCommand,
  DescribeLifecycleConfigurationCommand,
  DescribeBackupPolicyCommand,
  DescribeMountTargetSecurityGroupsCommand,
  DescribeFileSystemPolicyCommand,
  PutLifecycleConfigurationCommand,
  PutBackupPolicyCommand,
  PutFileSystemPolicyCommand,
  UpdateFileSystemProtectionCommand,
  FileSystemNotFound,
  MountTargetNotFound,
  AccessPointNotFound,
  type PerformanceMode,
  type ThroughputMode,
  type LifecyclePolicy,
  type Status,
  type ReplicationOverwriteProtection,
} from '@aws-sdk/client-efs';
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
  private client: EFSClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('EFSProvider');

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
    ['AWS::EFS::MountTarget', new Set(['FileSystemId', 'SubnetId', 'SecurityGroups'])],
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
          'Cross-region EFS replication (CreateReplicationConfiguration) provisions a separate destination file system in another region with its own lifecycle, KMS key, and availability-zone placement; replicating + then tearing down the destination on destroy is a multi-resource, cross-region orchestration that is out of scope for the single-resource SDK provider. Tracked as a follow-up to issue #609.',
        ],
      ]),
    ],
    [
      'AWS::EFS::AccessPoint',
      new Map<string, string>([
        [
          'ClientToken',
          'AWS SDK manages this idempotency token internally on CreateAccessPoint; no user-supplied value is honored',
        ],
      ]),
    ],
  ]);

  private getClient(): EFSClient {
    if (!this.client) {
      this.client = new EFSClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.createFileSystem(logicalId, resourceType, properties);
      case 'AWS::EFS::MountTarget':
        return this.createMountTarget(logicalId, resourceType, properties);
      case 'AWS::EFS::AccessPoint':
        return this.createAccessPoint(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  /**
   * Mutable surfaces by resource type:
   *  - `AWS::EFS::FileSystem` → `UpdateFileSystem` (ThroughputMode,
   *    ProvisionedThroughputInMibps). Other property changes
   *    (Encrypted / KmsKeyId / PerformanceMode / etc.) are routed
   *    through DELETE+CREATE by the replacement-detection layer; if a
   *    diff somehow includes them, defensively reject.
   *  - `AWS::EFS::MountTarget` → `ModifyMountTargetSecurityGroups`
   *    (SecurityGroups only). IpAddress / SubnetId / FileSystemId are
   *    immutable.
   *  - `AWS::EFS::AccessPoint` → no mutable surface; AWS recreates on
   *    every change. Reject so `cdkd drift --revert` surfaces a clear
   *    "use --replace" hint.
   */
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.updateFileSystem(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::EFS::MountTarget':
        return this.updateMountTarget(logicalId, physicalId, resourceType, properties);
      case 'AWS::EFS::AccessPoint':
        return Promise.reject(
          new ResourceUpdateNotSupportedError(
            resourceType,
            logicalId,
            'AWS EFS AccessPoint has no in-place update API — there is no UpdateAccessPoint command; every property change requires DeleteAccessPoint + CreateAccessPoint. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.'
          )
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  private async updateFileSystem(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // Defensive guard: any non-mutable diff means the replacement-detection
    // layer should have routed this through DELETE+CREATE — if we reach
    // here with an Encrypted / KmsKeyId / PerformanceMode / AvailabilityZoneName
    // change, refuse to silently apply a partial update.
    const immutableKeys = [
      'Encrypted',
      'KmsKeyId',
      'PerformanceMode',
      'AvailabilityZoneName',
    ] as const;
    for (const key of immutableKeys) {
      const next = properties[key];
      const prev = previousProperties[key];
      if (
        next !== undefined &&
        prev !== undefined &&
        JSON.stringify(next) !== JSON.stringify(prev)
      ) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `AWS EFS FileSystem ${key} is immutable on AWS — UpdateFileSystem does not accept ${key}; the property is fixed at creation. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
        );
      }
    }

    const newThroughputMode = properties['ThroughputMode'] as ThroughputMode | undefined;
    const newProvisioned = properties['ProvisionedThroughputInMibps'] as number | undefined;
    const oldThroughputMode = previousProperties['ThroughputMode'] as ThroughputMode | undefined;
    const oldProvisioned = previousProperties['ProvisionedThroughputInMibps'] as number | undefined;

    const throughputModeChanged =
      newThroughputMode !== undefined && newThroughputMode !== oldThroughputMode;
    const provisionedChanged = newProvisioned !== undefined && newProvisioned !== oldProvisioned;

    // Separate post-create control-plane properties — each compares deep so a
    // changed nested value (or a removal) fires its own Put*/Update* call.
    const changed = (key: string): boolean =>
      JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key]);
    const lifecycleChanged = changed('LifecyclePolicies');
    const backupChanged = changed('BackupPolicy');
    const policyChanged = changed('FileSystemPolicy') || changed('BypassPolicyLockoutSafetyCheck');
    const protectionChanged = changed('FileSystemProtection');

    if (
      !throughputModeChanged &&
      !provisionedChanged &&
      !lifecycleChanged &&
      !backupChanged &&
      !policyChanged &&
      !protectionChanged
    ) {
      // No mutable diff — nothing to do (silent success, matching the
      // wider provider convention). Drift comparator wouldn't have
      // surfaced this resource if there was no diff to start with.
      this.logger.debug(`No mutable diff for EFS FileSystem ${logicalId}, skipping update`);
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating EFS FileSystem ${logicalId}: ${physicalId}`);

    try {
      if (throughputModeChanged || provisionedChanged) {
        await this.getClient().send(
          new UpdateFileSystemCommand({
            FileSystemId: physicalId,
            ...(throughputModeChanged && { ThroughputMode: newThroughputMode }),
            ...(provisionedChanged && { ProvisionedThroughputInMibps: newProvisioned }),
          })
        );

        // EFS UpdateFileSystem is async; wait until the FileSystem state
        // returns to `available` so the comparator's next read sees the
        // final values rather than `updating`.
        await this.waitForFileSystemAvailable(physicalId, logicalId, resourceType);
      }

      // Post-create control-plane diffs — separate Put*/Update* APIs. Each is
      // applied only when its value changed (a removal clears LifecyclePolicies;
      // BackupPolicy / FileSystemPolicy / FileSystemProtection have no clean
      // "drop" mapping in CFn, so a pure removal is a deliberate no-op).
      if (lifecycleChanged) {
        await this.applyLifecyclePolicies(
          physicalId,
          properties['LifecyclePolicies'],
          previousProperties['LifecyclePolicies']
        );
      }
      if (backupChanged) {
        await this.applyBackupPolicy(physicalId, properties['BackupPolicy']);
      }
      if (policyChanged) {
        await this.applyFileSystemPolicy(
          physicalId,
          properties['FileSystemPolicy'],
          properties['BypassPolicyLockoutSafetyCheck']
        );
      }
      if (protectionChanged) {
        await this.applyFileSystemProtection(physicalId, properties['FileSystemProtection']);
      }

      this.logger.debug(`Successfully updated EFS FileSystem ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update EFS FileSystem ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async updateMountTarget(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating EFS MountTarget ${logicalId}: ${physicalId}`);

    const securityGroups = properties['SecurityGroups'] as string[] | undefined;
    if (securityGroups === undefined) {
      // Nothing mutable to apply (IpAddress / SubnetId / FileSystemId are
      // immutable on MountTarget). Silent success keeps `cdkd drift
      // --revert` consistent with the wider provider convention when
      // only immutable fields differ.
      this.logger.debug(`No mutable diff for EFS MountTarget ${logicalId}, skipping update`);
      return { physicalId, wasReplaced: false };
    }

    try {
      await this.getClient().send(
        new ModifyMountTargetSecurityGroupsCommand({
          MountTargetId: physicalId,
          SecurityGroups: securityGroups,
        })
      );

      this.logger.debug(`Successfully updated EFS MountTarget ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update EFS MountTarget ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.deleteFileSystem(logicalId, physicalId, resourceType, context);
      case 'AWS::EFS::MountTarget':
        return this.deleteMountTarget(logicalId, physicalId, resourceType, context);
      case 'AWS::EFS::AccessPoint':
        return this.deleteAccessPoint(logicalId, physicalId, resourceType, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // ─── AWS::EFS::FileSystem ──────────────────────────────────────────

  private async createFileSystem(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating EFS FileSystem ${logicalId}`);

    const creationToken = `cdkd-${logicalId}`;

    const tags = properties['FileSystemTags'] as Array<{ Key: string; Value: string }> | undefined;

    // Track creation so a post-ACTIVE control-plane failure (LifecyclePolicies
    // / BackupPolicy / FileSystemPolicy / FileSystemProtection) best-effort
    // rolls back the just-created file system rather than orphaning it.
    let fileSystemId: string | undefined;

    try {
      const response = await this.getClient().send(
        new CreateFileSystemCommand({
          CreationToken: creationToken,
          Encrypted: properties['Encrypted'] as boolean | undefined,
          KmsKeyId: properties['KmsKeyId'] as string | undefined,
          PerformanceMode: properties['PerformanceMode'] as PerformanceMode | undefined,
          ThroughputMode: properties['ThroughputMode'] as ThroughputMode | undefined,
          ProvisionedThroughputInMibps: properties['ProvisionedThroughputInMibps'] as
            | number
            | undefined,
          // AvailabilityZoneName — One Zone EFS. Rides on CreateFileSystem and
          // is immutable (create-only); a change later is routed through
          // DELETE+CREATE by the replacement-detection layer.
          AvailabilityZoneName: properties['AvailabilityZoneName'] as string | undefined,
          Tags: tags?.map((t) => ({ Key: t.Key, Value: t.Value })),
        })
      );

      fileSystemId = response.FileSystemId!;
      const arn = response.FileSystemArn!;

      // Wait for FileSystem to become available
      await this.waitForFileSystemAvailable(fileSystemId, logicalId, resourceType);

      // LifecyclePolicies / BackupPolicy / FileSystemPolicy /
      // FileSystemProtection do NOT ride on CreateFileSystem — each is a
      // separate post-ACTIVE control-plane call. AWS rejects them against a
      // still-creating file system, which is why they run after the wait
      // above. Each is wrapped in transient-control-plane retry because
      // back-to-back EFS control-plane ops can collide.
      await this.applyLifecyclePolicies(fileSystemId, properties['LifecyclePolicies']);
      await this.applyBackupPolicy(fileSystemId, properties['BackupPolicy']);
      await this.applyFileSystemPolicy(
        fileSystemId,
        properties['FileSystemPolicy'],
        properties['BypassPolicyLockoutSafetyCheck']
      );
      await this.applyFileSystemProtection(fileSystemId, properties['FileSystemProtection']);

      this.logger.debug(`Successfully created EFS FileSystem ${logicalId}: ${fileSystemId}`);

      return {
        physicalId: fileSystemId,
        attributes: {
          Arn: arn,
          FileSystemId: fileSystemId,
        },
      };
    } catch (error) {
      // Atomicity: if CreateFileSystem succeeded but a post-ACTIVE step failed,
      // the file system exists but create() is about to throw without
      // returning its physicalId — the deploy engine can't roll it back, so
      // best-effort delete it here to avoid an orphan + a "CreationToken
      // already in use" failure on the next deploy attempt.
      if (fileSystemId !== undefined) {
        try {
          await this.getClient().send(new DeleteFileSystemCommand({ FileSystemId: fileSystemId }));
          this.logger.debug(`Rolled back partially-created EFS FileSystem ${fileSystemId}`);
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to roll back partially-created EFS FileSystem ${fileSystemId}: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`
          );
        }
      }
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create EFS FileSystem ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  // ─── Post-ACTIVE control-plane helpers ─────────────────────────────
  //
  // LifecyclePolicies / BackupPolicy / FileSystemPolicy / FileSystemProtection
  // are NOT settable on CreateFileSystem — each has its own EFS API
  // (PutLifecycleConfiguration / PutBackupPolicy / PutFileSystemPolicy /
  // UpdateFileSystemProtection). Called from both create() (after ACTIVE) and
  // update() (only when the value changed). Each is idempotent and wrapped in
  // retryOnTransientControlPlane because back-to-back EFS control-plane ops can
  // collide with an IncorrectFileSystemLifeCycleState / "in progress" error.

  /**
   * Apply `LifecyclePolicies` via `PutLifecycleConfiguration`. CFn shape is an
   * array of `{ TransitionToIA?, TransitionToPrimaryStorageClass?,
   * TransitionToArchive? }`. An empty / dropped array clears all lifecycle
   * policies (PutLifecycleConfiguration with `LifecyclePolicies: []`).
   */
  private async applyLifecyclePolicies(
    fileSystemId: string,
    spec: unknown,
    previousSpec?: unknown
  ): Promise<void> {
    if (spec === undefined) {
      // Removal (new absent, previous present): clear all policies.
      if (previousSpec === undefined) return;
    }
    const policies = (spec as LifecyclePolicy[] | undefined) ?? [];
    await this.retryOnTransientControlPlane(
      () =>
        this.getClient().send(
          new PutLifecycleConfigurationCommand({
            FileSystemId: fileSystemId,
            LifecyclePolicies: policies,
          })
        ),
      `set LifecyclePolicies on ${fileSystemId}`
    );
    this.logger.debug(
      `Set ${policies.length} LifecyclePolicy entry(ies) on EFS FileSystem ${fileSystemId}`
    );
  }

  /**
   * Apply `BackupPolicy` via `PutBackupPolicy`. CFn shape is
   * `{ Status: 'ENABLED' | 'DISABLED' }`.
   */
  private async applyBackupPolicy(fileSystemId: string, spec: unknown): Promise<void> {
    if (spec === undefined || spec === null) return;
    const status = (spec as { Status?: string }).Status;
    if (status === undefined) return;
    await this.retryOnTransientControlPlane(
      () =>
        this.getClient().send(
          new PutBackupPolicyCommand({
            FileSystemId: fileSystemId,
            BackupPolicy: { Status: status as Status },
          })
        ),
      `set BackupPolicy on ${fileSystemId}`
    );
    this.logger.debug(`Set BackupPolicy Status=${status} on EFS FileSystem ${fileSystemId}`);
  }

  /**
   * Apply `FileSystemPolicy` via `PutFileSystemPolicy`. The CFn `FileSystemPolicy`
   * property is a JSON policy *object* but the SDK's `Policy` field is a JSON
   * *string*, so an object value is `JSON.stringify`'d. `BypassPolicyLockoutSafetyCheck`
   * is a field ON `PutFileSystemPolicy` (not a standalone resource property), so
   * the two wire together.
   */
  private async applyFileSystemPolicy(
    fileSystemId: string,
    policy: unknown,
    bypass: unknown
  ): Promise<void> {
    if (policy === undefined || policy === null) return;
    const policyString = typeof policy === 'string' ? policy : JSON.stringify(policy);
    await this.retryOnTransientControlPlane(
      () =>
        this.getClient().send(
          new PutFileSystemPolicyCommand({
            FileSystemId: fileSystemId,
            Policy: policyString,
            BypassPolicyLockoutSafetyCheck: bypass === undefined ? undefined : Boolean(bypass),
          })
        ),
      `set FileSystemPolicy on ${fileSystemId}`
    );
    this.logger.debug(`Set FileSystemPolicy on EFS FileSystem ${fileSystemId}`);
  }

  /**
   * Apply `FileSystemProtection` via `UpdateFileSystemProtection`. CFn shape is
   * `{ ReplicationOverwriteProtection: 'ENABLED' | 'DISABLED' | 'REPLICATING' }`.
   */
  private async applyFileSystemProtection(fileSystemId: string, spec: unknown): Promise<void> {
    if (spec === undefined || spec === null) return;
    const protection = (spec as { ReplicationOverwriteProtection?: string })
      .ReplicationOverwriteProtection;
    if (protection === undefined) return;
    await this.retryOnTransientControlPlane(
      () =>
        this.getClient().send(
          new UpdateFileSystemProtectionCommand({
            FileSystemId: fileSystemId,
            ReplicationOverwriteProtection: protection as ReplicationOverwriteProtection,
          })
        ),
      `set FileSystemProtection on ${fileSystemId}`
    );
    this.logger.debug(
      `Set ReplicationOverwriteProtection=${protection} on EFS FileSystem ${fileSystemId}`
    );
  }

  /**
   * Retry an EFS control-plane call on the transient "settling" errors AWS
   * returns when two file-system-modifying operations land back-to-back (e.g.
   * a `PutLifecycleConfiguration` immediately followed by a `PutBackupPolicy`).
   * `IncorrectFileSystemLifeCycleState` / `ThrottlingException` /
   * `ConflictException` and the message-pattern set below are the same class.
   * Backoff: ~2s,4s,8s,16s,30s,30s... bounded to ~2min total.
   */
  private async retryOnTransientControlPlane<T>(
    op: () => Promise<T>,
    label: string,
    maxAttempts = 8
  ): Promise<T> {
    let delayMs = 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : '';
        const transient =
          /in progress|please retry|incorrect file system life ?cycle state|being (updated|modified)|try again/i.test(
            msg
          ) ||
          name === 'IncorrectFileSystemLifeCycleState' ||
          name === 'ConflictException' ||
          name === 'ThrottlingException';
        if (!transient || attempt >= maxAttempts) throw error;
        this.logger.debug(
          `Transient error on "${label}" (attempt ${attempt}/${maxAttempts}): ${msg} — retrying in ${delayMs}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
  }

  private async deleteFileSystem(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting EFS FileSystem ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteFileSystemCommand({
          FileSystemId: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted EFS FileSystem ${logicalId}`);
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
        this.logger.debug(`EFS FileSystem ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete EFS FileSystem ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async waitForFileSystemAvailable(
    fileSystemId: string,
    logicalId: string,
    resourceType: string
  ): Promise<void> {
    const pollIntervalMs = 2000;
    const maxWaitMs = 60000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const response = await this.getClient().send(
        new DescribeFileSystemsCommand({ FileSystemId: fileSystemId })
      );
      const fs = response.FileSystems?.[0];
      if (fs?.LifeCycleState === 'available') {
        return;
      }
      this.logger.debug(
        `FileSystem ${fileSystemId} state: ${fs?.LifeCycleState ?? 'unknown'}, waiting...`
      );
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for EFS FileSystem ${fileSystemId} to become available (60s)`,
      resourceType,
      logicalId,
      fileSystemId
    );
  }

  // ─── AWS::EFS::MountTarget ─────────────────────────────────────────

  private async createMountTarget(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating EFS MountTarget ${logicalId}`);

    const fileSystemId = properties['FileSystemId'] as string | undefined;
    if (!fileSystemId) {
      throw new ProvisioningError(
        `FileSystemId is required for EFS MountTarget ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const subnetId = properties['SubnetId'] as string | undefined;
    if (!subnetId) {
      throw new ProvisioningError(
        `SubnetId is required for EFS MountTarget ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const securityGroups = properties['SecurityGroups'] as string[] | undefined;

    try {
      const response = await this.getClient().send(
        new CreateMountTargetCommand({
          FileSystemId: fileSystemId,
          SubnetId: subnetId,
          SecurityGroups: securityGroups,
        })
      );

      const mountTargetId = response.MountTargetId!;
      this.logger.debug(
        `Created EFS MountTarget ${logicalId}: ${mountTargetId}, waiting for available state`
      );

      // Poll until mount target is available
      await this.waitForMountTargetAvailable(mountTargetId, logicalId, resourceType);

      this.logger.debug(`Successfully created EFS MountTarget ${logicalId}: ${mountTargetId}`);

      return {
        physicalId: mountTargetId,
        attributes: {},
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create EFS MountTarget ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async waitForMountTargetAvailable(
    mountTargetId: string,
    logicalId: string,
    resourceType: string
  ): Promise<void> {
    const pollIntervalMs = 5000;
    const maxWaitMs = 120000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const response = await this.getClient().send(
        new DescribeMountTargetsCommand({
          MountTargetId: mountTargetId,
        })
      );

      const mountTarget = response.MountTargets?.[0];
      if (mountTarget?.LifeCycleState === 'available') {
        return;
      }

      this.logger.debug(
        `MountTarget ${mountTargetId} state: ${mountTarget?.LifeCycleState ?? 'unknown'}, waiting...`
      );

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new ProvisioningError(
      `Timed out waiting for EFS MountTarget ${mountTargetId} to become available (120s)`,
      resourceType,
      logicalId,
      mountTargetId
    );
  }

  private async deleteMountTarget(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting EFS MountTarget ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteMountTargetCommand({
          MountTargetId: physicalId,
        })
      );

      // Wait for mount target to be fully deleted
      await this.waitForMountTargetDeleted(physicalId, logicalId);

      this.logger.debug(`Successfully deleted EFS MountTarget ${logicalId}`);
    } catch (error) {
      if (error instanceof MountTargetNotFound) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`EFS MountTarget ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete EFS MountTarget ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private async waitForMountTargetDeleted(mountTargetId: string, logicalId: string): Promise<void> {
    const pollIntervalMs = 5000;
    const maxWaitMs = 120000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const response = await this.getClient().send(
          new DescribeMountTargetsCommand({
            MountTargetId: mountTargetId,
          })
        );

        const mountTarget = response.MountTargets?.[0];
        if (!mountTarget) {
          return;
        }

        this.logger.debug(
          `MountTarget ${mountTargetId} state: ${mountTarget.LifeCycleState ?? 'unknown'}, waiting for deletion...`
        );
      } catch (error) {
        if (error instanceof MountTargetNotFound) {
          return;
        }
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    this.logger.warn(
      `Timed out waiting for EFS MountTarget ${mountTargetId} deletion for ${logicalId} (120s)`
    );
  }

  // ─── AWS::EFS::AccessPoint ─────────────────────────────────────────

  private async createAccessPoint(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating EFS AccessPoint ${logicalId}`);

    const fileSystemId = properties['FileSystemId'] as string | undefined;
    if (!fileSystemId) {
      throw new ProvisioningError(
        `FileSystemId is required for EFS AccessPoint ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const posixUser = properties['PosixUser'] as
      | { Uid: number; Gid: number; SecondaryGids?: number[] }
      | undefined;

    const rootDirectory = properties['RootDirectory'] as
      | {
          Path?: string;
          CreationInfo?: {
            OwnerUid: number;
            OwnerGid: number;
            Permissions: string;
          };
        }
      | undefined;

    const tags = properties['AccessPointTags'] as Array<{ Key: string; Value: string }> | undefined;

    try {
      const response = await this.getClient().send(
        new CreateAccessPointCommand({
          FileSystemId: fileSystemId,
          PosixUser: posixUser
            ? {
                Uid: Number(posixUser.Uid),
                Gid: Number(posixUser.Gid),
                SecondaryGids: posixUser.SecondaryGids?.map(Number),
              }
            : undefined,
          RootDirectory: rootDirectory
            ? {
                Path: rootDirectory.Path,
                CreationInfo: rootDirectory.CreationInfo
                  ? {
                      OwnerUid: Number(rootDirectory.CreationInfo.OwnerUid),
                      OwnerGid: Number(rootDirectory.CreationInfo.OwnerGid),
                      Permissions: rootDirectory.CreationInfo.Permissions,
                    }
                  : undefined,
              }
            : undefined,
          Tags: tags?.map((t) => ({ Key: t.Key, Value: t.Value })),
        })
      );

      const accessPointId = response.AccessPointId!;
      const arn = response.AccessPointArn!;

      this.logger.debug(`Successfully created EFS AccessPoint ${logicalId}: ${accessPointId}`);

      return {
        physicalId: accessPointId,
        attributes: {
          Arn: arn,
          AccessPointId: accessPointId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create EFS AccessPoint ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteAccessPoint(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting EFS AccessPoint ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteAccessPointCommand({
          AccessPointId: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted EFS AccessPoint ${logicalId}`);
    } catch (error) {
      if (error instanceof AccessPointNotFound) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`EFS AccessPoint ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete EFS AccessPoint ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current EFS resource configuration in CFn-property shape.
   *
   * Dispatch per resource type:
   *  - `FileSystem` → `DescribeFileSystems` filtered by id (PerformanceMode,
   *    ThroughputMode, Encrypted, KmsKeyId, ProvisionedThroughputInMibps,
   *    AvailabilityZoneName, FileSystemProtection), plus optional
   *    `DescribeLifecycleConfiguration`, `DescribeBackupPolicy`, and
   *    `DescribeFileSystemPolicy` enrichment. Each enrichment call is wrapped
   *    in its own try/catch so a "not configured" error on any of them omits
   *    the corresponding key without failing the whole snapshot.
   *  - `AccessPoint` → `DescribeAccessPoints` filtered by id (PosixUser,
   *    RootDirectory).
   *  - `MountTarget` → `DescribeMountTargets` (FileSystemId, SubnetId)
   *    plus `DescribeMountTargetSecurityGroups` for the SG list (always-
   *    emit `[]` when AWS reports none so a console-side ADD on a
   *    previously-unconfigured mount target is detectable).
   *
   * `FileSystemTags` (the CFn property name on `AWS::EFS::FileSystem`) is
   * surfaced from the same `DescribeFileSystems` response — `aws:*`
   * auto-tags filtered, key omitted when empty. `AccessPoint` and
   * `MountTarget` are not surfaced for tags here (`AccessPointTags` would
   * mirror this approach but the test scope below covers `FileSystem`
   * only; further coverage can land in a follow-up).
   * Returns `undefined` when the resource is gone (`*NotFound`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    switch (resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.readFileSystem(physicalId);
      case 'AWS::EFS::AccessPoint':
        return this.readAccessPoint(physicalId);
      case 'AWS::EFS::MountTarget':
        return this.readMountTarget(physicalId);
      default:
        return undefined;
    }
  }

  private async readFileSystem(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let fs;
    try {
      const resp = await this.getClient().send(
        new DescribeFileSystemsCommand({ FileSystemId: physicalId })
      );
      fs = resp.FileSystems?.[0];
    } catch (err) {
      if (err instanceof FileSystemNotFound) return undefined;
      throw err;
    }
    if (!fs) return undefined;

    const result: Record<string, unknown> = {};
    if (fs.PerformanceMode !== undefined) result['PerformanceMode'] = fs.PerformanceMode;
    if (fs.ThroughputMode !== undefined) result['ThroughputMode'] = fs.ThroughputMode;
    if (fs.Encrypted !== undefined) result['Encrypted'] = fs.Encrypted;
    if (fs.KmsKeyId !== undefined) result['KmsKeyId'] = fs.KmsKeyId;
    if (fs.ProvisionedThroughputInMibps !== undefined) {
      result['ProvisionedThroughputInMibps'] = fs.ProvisionedThroughputInMibps;
    }
    // AvailabilityZoneName (One Zone EFS) and FileSystemProtection ride on the
    // same DescribeFileSystems response.
    if (fs.AvailabilityZoneName !== undefined) {
      result['AvailabilityZoneName'] = fs.AvailabilityZoneName;
    }
    if (fs.FileSystemProtection?.ReplicationOverwriteProtection !== undefined) {
      result['FileSystemProtection'] = {
        ReplicationOverwriteProtection: fs.FileSystemProtection.ReplicationOverwriteProtection,
      };
    }

    // LifecyclePolicies — separate call, "not configured" omits the key.
    try {
      const resp = await this.getClient().send(
        new DescribeLifecycleConfigurationCommand({ FileSystemId: physicalId })
      );
      const policies = resp.LifecyclePolicies ?? [];
      result['LifecyclePolicies'] = policies.map((p) => {
        const out: Record<string, unknown> = {};
        if (p.TransitionToIA !== undefined) out['TransitionToIA'] = p.TransitionToIA;
        if (p.TransitionToPrimaryStorageClass !== undefined) {
          out['TransitionToPrimaryStorageClass'] = p.TransitionToPrimaryStorageClass;
        }
        if (p.TransitionToArchive !== undefined) out['TransitionToArchive'] = p.TransitionToArchive;
        return out;
      });
    } catch (err) {
      // "Not configured" is service-specific; FileSystemNotFound on this call
      // means the FS itself is gone (already covered above), so re-throw.
      if (err instanceof FileSystemNotFound) return undefined;
      // Other errors (e.g. PolicyNotFound, AccessDenied) — omit the key,
      // don't fail the whole snapshot.
      const e = err as { name?: string };
      if (e.name !== 'PolicyNotFound') {
        // Best-effort: log and continue. Drift comparator only descends into
        // keys present in state, so an absent key cannot fire false drift.
      }
    }

    // BackupPolicy — separate call, "not configured" omits the key.
    try {
      const resp = await this.getClient().send(
        new DescribeBackupPolicyCommand({ FileSystemId: physicalId })
      );
      if (resp.BackupPolicy?.Status !== undefined) {
        result['BackupPolicy'] = { Status: resp.BackupPolicy.Status };
      }
    } catch (err) {
      if (err instanceof FileSystemNotFound) return undefined;
      // PolicyNotFound or similar — omit the key.
    }

    // FileSystemPolicy — separate DescribeFileSystemPolicy call. AWS returns
    // the policy as a JSON string; the CFn property is a policy object, so
    // parse it back so the drift comparator compares object-to-object.
    // "PolicyNotFound" (no policy attached) omits the key.
    try {
      const resp = await this.getClient().send(
        new DescribeFileSystemPolicyCommand({ FileSystemId: physicalId })
      );
      if (resp.Policy !== undefined) {
        try {
          result['FileSystemPolicy'] = JSON.parse(resp.Policy);
        } catch {
          // Non-JSON policy string (should not happen) — surface verbatim.
          result['FileSystemPolicy'] = resp.Policy;
        }
      }
    } catch (err) {
      if (err instanceof FileSystemNotFound) return undefined;
      // PolicyNotFound or similar — omit the key.
    }

    // FileSystemTags from the same DescribeFileSystems response.
    const tags = normalizeAwsTagsToCfn(fs.Tags);
    result['FileSystemTags'] = tags;

    return result;
  }

  private async readAccessPoint(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let ap;
    try {
      const resp = await this.getClient().send(
        new DescribeAccessPointsCommand({ AccessPointId: physicalId })
      );
      ap = resp.AccessPoints?.[0];
    } catch (err) {
      if (err instanceof AccessPointNotFound) return undefined;
      throw err;
    }
    if (!ap) return undefined;

    const result: Record<string, unknown> = {};
    if (ap.FileSystemId !== undefined) result['FileSystemId'] = ap.FileSystemId;
    if (ap.PosixUser) {
      const posix: Record<string, unknown> = {};
      if (ap.PosixUser.Uid !== undefined) posix['Uid'] = ap.PosixUser.Uid;
      if (ap.PosixUser.Gid !== undefined) posix['Gid'] = ap.PosixUser.Gid;
      if (ap.PosixUser.SecondaryGids && ap.PosixUser.SecondaryGids.length > 0) {
        posix['SecondaryGids'] = [...ap.PosixUser.SecondaryGids];
      }
      if (Object.keys(posix).length > 0) result['PosixUser'] = posix;
    }
    if (ap.RootDirectory) {
      const root: Record<string, unknown> = {};
      if (ap.RootDirectory.Path !== undefined) root['Path'] = ap.RootDirectory.Path;
      if (ap.RootDirectory.CreationInfo) {
        const ci: Record<string, unknown> = {};
        if (ap.RootDirectory.CreationInfo.OwnerUid !== undefined) {
          ci['OwnerUid'] = ap.RootDirectory.CreationInfo.OwnerUid;
        }
        if (ap.RootDirectory.CreationInfo.OwnerGid !== undefined) {
          ci['OwnerGid'] = ap.RootDirectory.CreationInfo.OwnerGid;
        }
        if (ap.RootDirectory.CreationInfo.Permissions !== undefined) {
          ci['Permissions'] = ap.RootDirectory.CreationInfo.Permissions;
        }
        if (Object.keys(ci).length > 0) root['CreationInfo'] = ci;
      }
      if (Object.keys(root).length > 0) result['RootDirectory'] = root;
    }
    return result;
  }

  private async readMountTarget(physicalId: string): Promise<Record<string, unknown> | undefined> {
    let mt;
    try {
      const resp = await this.getClient().send(
        new DescribeMountTargetsCommand({ MountTargetId: physicalId })
      );
      mt = resp.MountTargets?.[0];
    } catch (err) {
      if (err instanceof MountTargetNotFound) return undefined;
      throw err;
    }
    if (!mt) return undefined;

    const result: Record<string, unknown> = {};
    if (mt.FileSystemId !== undefined) result['FileSystemId'] = mt.FileSystemId;
    if (mt.SubnetId !== undefined) result['SubnetId'] = mt.SubnetId;

    // SecurityGroups via DescribeMountTargetSecurityGroups. Always-emit
    // `[]` placeholder when AWS reports none so a console-side ADD on a
    // previously-unconfigured mount target is detectable on the v3
    // observedProperties baseline.
    let securityGroups: string[] = [];
    try {
      const sgResp = await this.getClient().send(
        new DescribeMountTargetSecurityGroupsCommand({ MountTargetId: physicalId })
      );
      securityGroups = (sgResp.SecurityGroups ?? []).filter(
        (s): s is string => typeof s === 'string'
      );
    } catch {
      // Best-effort.
    }
    result['SecurityGroups'] = securityGroups;

    return result;
  }

  /**
   * Adopt an existing EFS resource into cdkd state.
   *
   * Supported types:
   *  - `AWS::EFS::FileSystem` — full tag-based lookup via
   *    `DescribeFileSystems` with `Tags` inline on each item.
   *  - `AWS::EFS::AccessPoint` — full tag-based lookup via
   *    `DescribeAccessPoints` with `Tags` inline on each item.
   *  - `AWS::EFS::MountTarget` — override-only (mount targets are
   *    not taggable; auto lookup is impractical).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    switch (input.resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.importFileSystem(input);
      case 'AWS::EFS::AccessPoint':
        return this.importAccessPoint(input);
      case 'AWS::EFS::MountTarget':
        if (input.knownPhysicalId) {
          return { physicalId: input.knownPhysicalId, attributes: {} };
        }
        return null;
      default:
        return null;
    }
  }

  private async importFileSystem(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.getClient().send(
          new DescribeFileSystemsCommand({ FileSystemId: input.knownPhysicalId })
        );
        const fs = resp.FileSystems?.[0];
        return fs?.FileSystemId ? { physicalId: fs.FileSystemId, attributes: {} } : null;
      } catch (err) {
        if (err instanceof FileSystemNotFound) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let marker: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeFileSystemsCommand({ ...(marker && { Marker: marker }) })
      );
      for (const fs of list.FileSystems ?? []) {
        if (!fs.FileSystemId) continue;
        if (matchesCdkPath(fs.Tags, input.cdkPath)) {
          return { physicalId: fs.FileSystemId, attributes: {} };
        }
      }
      marker = list.NextMarker;
    } while (marker);
    return null;
  }

  private async importAccessPoint(
    input: ResourceImportInput
  ): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.getClient().send(
          new DescribeAccessPointsCommand({ AccessPointId: input.knownPhysicalId })
        );
        const ap = resp.AccessPoints?.[0];
        return ap?.AccessPointId ? { physicalId: ap.AccessPointId, attributes: {} } : null;
      } catch (err) {
        if (err instanceof AccessPointNotFound) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    // Scope to the parent FileSystemId when the template provides one,
    // otherwise scan all access points in the account.
    const fileSystemId = input.properties['FileSystemId'] as string | undefined;
    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeAccessPointsCommand({
          ...(nextToken && { NextToken: nextToken }),
          ...(fileSystemId && { FileSystemId: fileSystemId }),
        })
      );
      for (const ap of list.AccessPoints ?? []) {
        if (!ap.AccessPointId) continue;
        if (matchesCdkPath(ap.Tags, input.cdkPath)) {
          return { physicalId: ap.AccessPointId, attributes: {} };
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }
}
