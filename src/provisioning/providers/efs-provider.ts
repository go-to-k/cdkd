import {
  EFSClient,
  CreateFileSystemCommand,
  DeleteFileSystemCommand,
  CreateMountTargetCommand,
  DeleteMountTargetCommand,
  DescribeMountTargetsCommand,
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  DescribeFileSystemsCommand,
  DescribeAccessPointsCommand,
  DescribeLifecycleConfigurationCommand,
  DescribeBackupPolicyCommand,
  FileSystemNotFound,
  MountTargetNotFound,
  AccessPointNotFound,
  type PerformanceMode,
  type ThroughputMode,
} from '@aws-sdk/client-efs';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { matchesCdkPath } from '../import-helpers.js';
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
      ]),
    ],
    ['AWS::EFS::MountTarget', new Set(['FileSystemId', 'SubnetId', 'SecurityGroups'])],
    [
      'AWS::EFS::AccessPoint',
      new Set(['FileSystemId', 'PosixUser', 'RootDirectory', 'AccessPointTags']),
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

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Update for ${resourceType} ${logicalId} (${physicalId}) - no-op, immutable`);
    if (
      resourceType !== 'AWS::EFS::FileSystem' &&
      resourceType !== 'AWS::EFS::MountTarget' &&
      resourceType !== 'AWS::EFS::AccessPoint'
    ) {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    return Promise.resolve({ physicalId, wasReplaced: false });
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
          Tags: tags?.map((t) => ({ Key: t.Key, Value: t.Value })),
        })
      );

      const fileSystemId = response.FileSystemId!;
      const arn = response.FileSystemArn!;

      // Wait for FileSystem to become available
      await this.waitForFileSystemAvailable(fileSystemId, logicalId, resourceType);

      this.logger.debug(`Successfully created EFS FileSystem ${logicalId}: ${fileSystemId}`);

      return {
        physicalId: fileSystemId,
        attributes: {
          Arn: arn,
          FileSystemId: fileSystemId,
        },
      };
    } catch (error) {
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
   *    ThroughputMode, Encrypted, KmsKeyId, ProvisionedThroughputInMibps),
   *    plus optional `DescribeLifecycleConfiguration` and
   *    `DescribeBackupPolicy` enrichment. Each enrichment call is wrapped
   *    in its own try/catch so a "not configured" error on either omits
   *    the corresponding key without failing the whole snapshot.
   *  - `AccessPoint` → `DescribeAccessPoints` filtered by id (PosixUser,
   *    RootDirectory).
   *  - `MountTarget` → `DescribeMountTargets` (FileSystemId, SubnetId).
   *    SecurityGroups requires a separate call and is omitted for v1.
   *
   * Tags are skipped across all three (CDK auto-tag handling deferred).
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

    // LifecyclePolicies — separate call, "not configured" omits the key.
    try {
      const resp = await this.getClient().send(
        new DescribeLifecycleConfigurationCommand({ FileSystemId: physicalId })
      );
      const policies = resp.LifecyclePolicies;
      if (policies && policies.length > 0) {
        result['LifecyclePolicies'] = policies.map((p) => {
          const out: Record<string, unknown> = {};
          if (p.TransitionToIA !== undefined) out['TransitionToIA'] = p.TransitionToIA;
          if (p.TransitionToPrimaryStorageClass !== undefined) {
            out['TransitionToPrimaryStorageClass'] = p.TransitionToPrimaryStorageClass;
          }
          if (p.TransitionToArchive !== undefined)
            out['TransitionToArchive'] = p.TransitionToArchive;
          return out;
        });
      }
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
    // SecurityGroups omitted: requires DescribeMountTargetSecurityGroups
    // (separate call). Out of scope for v1 — drift comparator only descends
    // into keys present in state, so an absent key cannot fire false drift.
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
