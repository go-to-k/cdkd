import {
  ECRClient,
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  DescribeRepositoriesCommand,
  RepositoryNotFoundException,
  type ImageScanningConfiguration,
  type EncryptionConfiguration,
  type ImageTagMutability,
} from '@aws-sdk/client-ecr';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS ECR Repository Provider
 *
 * Implements resource provisioning for AWS::ECR::Repository using the ECR SDK.
 * WHY: The CC API cannot force-delete repositories that contain images.
 * This SDK provider uses DeleteRepositoryCommand with `force: true` to delete
 * repositories along with all their images, supporting CDK's `emptyOnDelete: true`.
 */
export class ECRProvider implements ResourceProvider {
  private client?: ECRClient;
  private logger = getLogger().child('ECRProvider');

  private getClient(): ECRClient {
    if (!this.client) {
      this.client = new ECRClient({});
    }
    return this.client;
  }

  /**
   * Create an ECR Repository
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating ECR Repository ${logicalId}`);

    const repositoryName =
      (properties['RepositoryName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 256 }).toLowerCase();

    try {
      const response = await this.getClient().send(
        new CreateRepositoryCommand({
          repositoryName,
          ...(properties['ImageScanningConfiguration']
            ? {
                imageScanningConfiguration: properties[
                  'ImageScanningConfiguration'
                ] as ImageScanningConfiguration,
              }
            : {}),
          ...(properties['ImageTagMutability']
            ? {
                imageTagMutability: properties['ImageTagMutability'] as ImageTagMutability,
              }
            : {}),
          ...(properties['EncryptionConfiguration']
            ? {
                encryptionConfiguration: properties[
                  'EncryptionConfiguration'
                ] as EncryptionConfiguration,
              }
            : {}),
        })
      );

      const repo = response.repository;
      if (!repo?.repositoryName) {
        throw new Error('CreateRepository did not return repository name');
      }

      const arn = repo.repositoryArn ?? '';
      const repositoryUri = repo.repositoryUri ?? '';

      this.logger.debug(`Successfully created ECR Repository ${logicalId}: ${repo.repositoryName}`);

      return {
        physicalId: repo.repositoryName,
        attributes: {
          Arn: arn,
          RepositoryUri: repositoryUri,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create ECR Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        repositoryName,
        cause
      );
    }
  }

  /**
   * Update an ECR Repository
   *
   * Note: Most ECR repository properties are immutable. RepositoryName changes
   * require replacement. Only ImageScanningConfiguration and ImageTagMutability
   * can be updated, but we keep this as a no-op since the CC API handles updates
   * and these updates are rarely needed.
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Update for ECR Repository ${logicalId} (${physicalId}) - no-op`);

    // Describe the repository to get current attributes
    try {
      const response = await this.getClient().send(
        new DescribeRepositoriesCommand({ repositoryNames: [physicalId] })
      );

      const repo = response.repositories?.[0];
      const arn = repo?.repositoryArn ?? '';
      const repositoryUri = repo?.repositoryUri ?? '';

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: arn,
          RepositoryUri: repositoryUri,
        },
      };
    } catch {
      return {
        physicalId,
        wasReplaced: false,
      };
    }
  }

  /**
   * Delete an ECR Repository
   *
   * Uses `force: true` to delete the repository even if it contains images.
   * This supports CDK's `emptyOnDelete: true` / `removalPolicy: DESTROY` pattern.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting ECR Repository ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteRepositoryCommand({
          repositoryName: physicalId,
          force: true,
        })
      );
      this.logger.debug(`Successfully deleted ECR Repository ${logicalId}`);
    } catch (error) {
      if (error instanceof RepositoryNotFoundException) {
        this.logger.debug(`ECR Repository ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete ECR Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
