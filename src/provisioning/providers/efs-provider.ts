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
  FileSystemNotFound,
  MountTargetNotFound,
  AccessPointNotFound,
  type PerformanceMode,
  type ThroughputMode,
} from '@aws-sdk/client-efs';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
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
    _properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::EFS::FileSystem':
        return this.deleteFileSystem(logicalId, physicalId, resourceType);
      case 'AWS::EFS::MountTarget':
        return this.deleteMountTarget(logicalId, physicalId, resourceType);
      case 'AWS::EFS::AccessPoint':
        return this.deleteAccessPoint(logicalId, physicalId, resourceType);
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
    resourceType: string
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
    resourceType: string
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
    resourceType: string
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
}
