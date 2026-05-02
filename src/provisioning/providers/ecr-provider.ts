import {
  ECRClient,
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  DescribeRepositoriesCommand,
  PutLifecyclePolicyCommand,
  SetRepositoryPolicyCommand,
  PutImageScanningConfigurationCommand,
  PutImageTagMutabilityCommand,
  TagResourceCommand,
  ListTagsForResourceCommand,
  RepositoryNotFoundException,
  type ImageScanningConfiguration,
  type EncryptionConfiguration,
  type ImageTagMutability,
  type Tag,
} from '@aws-sdk/client-ecr';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { matchesCdkPath, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
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
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('ECRProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ECR::Repository',
      new Set([
        'RepositoryName',
        'ImageScanningConfiguration',
        'ImageTagMutability',
        'EncryptionConfiguration',
        'LifecyclePolicy',
        'RepositoryPolicyText',
        'Tags',
        'EmptyOnDelete',
        'ImageTagMutabilityExclusionFilters',
      ]),
    ],
  ]);

  private getClient(): ECRClient {
    if (!this.client) {
      this.client = new ECRClient(this.providerRegion ? { region: this.providerRegion } : {});
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
      // Convert CFn Tags format to SDK tags format
      const tags = properties['Tags'] as Tag[] | undefined;

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
          ...(tags ? { tags } : {}),
        })
      );

      const repo = response.repository;
      if (!repo?.repositoryName) {
        throw new Error('CreateRepository did not return repository name');
      }

      const arn = repo.repositoryArn ?? '';
      const repositoryUri = repo.repositoryUri ?? '';

      // Apply lifecycle policy (separate API call)
      const lifecyclePolicy = properties['LifecyclePolicy'] as
        | { LifecyclePolicyText?: string }
        | undefined;
      if (lifecyclePolicy?.LifecyclePolicyText) {
        await this.getClient().send(
          new PutLifecyclePolicyCommand({
            repositoryName: repo.repositoryName,
            lifecyclePolicyText: lifecyclePolicy.LifecyclePolicyText,
          })
        );
        this.logger.debug(`Applied lifecycle policy to ${repo.repositoryName}`);
      }

      // Apply repository policy (separate API call)
      const repositoryPolicyText = properties['RepositoryPolicyText'];
      if (repositoryPolicyText) {
        const policyText =
          typeof repositoryPolicyText === 'string'
            ? repositoryPolicyText
            : JSON.stringify(repositoryPolicyText);
        await this.getClient().send(
          new SetRepositoryPolicyCommand({
            repositoryName: repo.repositoryName,
            policyText,
          })
        );
        this.logger.debug(`Applied repository policy to ${repo.repositoryName}`);
      }

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
   * Mutable properties: ImageScanningConfiguration, ImageTagMutability,
   * LifecyclePolicy, RepositoryPolicyText, Tags.
   * Immutable: RepositoryName, EncryptionConfiguration (require replacement).
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating ECR Repository ${logicalId} (${physicalId})`);

    try {
      // Update ImageScanningConfiguration if changed
      const newScanConfig = properties['ImageScanningConfiguration'] as
        | ImageScanningConfiguration
        | undefined;
      const oldScanConfig = previousProperties['ImageScanningConfiguration'] as
        | ImageScanningConfiguration
        | undefined;
      if (JSON.stringify(newScanConfig) !== JSON.stringify(oldScanConfig)) {
        await this.getClient().send(
          new PutImageScanningConfigurationCommand({
            repositoryName: physicalId,
            imageScanningConfiguration: newScanConfig ?? { scanOnPush: false },
          })
        );
        this.logger.debug(`Updated image scanning configuration for ${physicalId}`);
      }

      // Update ImageTagMutability if changed
      const newMutability = properties['ImageTagMutability'] as ImageTagMutability | undefined;
      const oldMutability = previousProperties['ImageTagMutability'] as
        | ImageTagMutability
        | undefined;
      if (newMutability !== oldMutability) {
        await this.getClient().send(
          new PutImageTagMutabilityCommand({
            repositoryName: physicalId,
            imageTagMutability: newMutability ?? 'MUTABLE',
          })
        );
        this.logger.debug(`Updated image tag mutability for ${physicalId}`);
      }

      // Update LifecyclePolicy if changed
      const newLifecycle = properties['LifecyclePolicy'] as
        | { LifecyclePolicyText?: string }
        | undefined;
      const oldLifecycle = previousProperties['LifecyclePolicy'] as
        | { LifecyclePolicyText?: string }
        | undefined;
      if (JSON.stringify(newLifecycle) !== JSON.stringify(oldLifecycle)) {
        if (newLifecycle?.LifecyclePolicyText) {
          await this.getClient().send(
            new PutLifecyclePolicyCommand({
              repositoryName: physicalId,
              lifecyclePolicyText: newLifecycle.LifecyclePolicyText,
            })
          );
          this.logger.debug(`Updated lifecycle policy for ${physicalId}`);
        }
      }

      // Update RepositoryPolicyText if changed
      const newPolicy = properties['RepositoryPolicyText'];
      const oldPolicy = previousProperties['RepositoryPolicyText'];
      if (JSON.stringify(newPolicy) !== JSON.stringify(oldPolicy) && newPolicy) {
        const policyText = typeof newPolicy === 'string' ? newPolicy : JSON.stringify(newPolicy);
        await this.getClient().send(
          new SetRepositoryPolicyCommand({
            repositoryName: physicalId,
            policyText,
          })
        );
        this.logger.debug(`Updated repository policy for ${physicalId}`);
      }

      // Update Tags if changed
      const newTags = properties['Tags'] as Tag[] | undefined;
      const oldTags = previousProperties['Tags'] as Tag[] | undefined;
      if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
        // Get repository ARN for tagging
        const describeResponse = await this.getClient().send(
          new DescribeRepositoriesCommand({ repositoryNames: [physicalId] })
        );
        const repoArn = describeResponse.repositories?.[0]?.repositoryArn;
        if (repoArn && newTags) {
          await this.getClient().send(
            new TagResourceCommand({
              resourceArn: repoArn,
              tags: newTags,
            })
          );
          this.logger.debug(`Updated tags for ${physicalId}`);
        }
      }

      // Get current attributes
      const response = await this.getClient().send(
        new DescribeRepositoriesCommand({ repositoryNames: [physicalId] })
      );
      const repo = response.repositories?.[0];

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: repo?.repositoryArn ?? '',
          RepositoryUri: repo?.repositoryUri ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update ECR Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        _resourceType,
        logicalId,
        physicalId,
        cause
      );
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
    _properties?: Record<string, unknown>,
    context?: DeleteContext
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
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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

  /**
   * Adopt an existing ECR repository into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.RepositoryName` → verify via
   *     `DescribeRepositories`.
   *  2. `DescribeRepositories` paginated, then `ListTagsForResource(arn)`
   *     per repository to match `aws:cdk:path` (`Tag[]` array shape).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'RepositoryName');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeRepositoriesCommand({ repositoryNames: [explicit] })
        );
        return resp.repositories?.[0]?.repositoryName
          ? { physicalId: explicit, attributes: {} }
          : null;
      } catch (err) {
        if (err instanceof RepositoryNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new DescribeRepositoriesCommand({ ...(nextToken && { nextToken }) })
      );
      for (const repo of list.repositories ?? []) {
        if (!repo.repositoryArn || !repo.repositoryName) continue;
        try {
          const tagsResp = await this.getClient().send(
            new ListTagsForResourceCommand({ resourceArn: repo.repositoryArn })
          );
          if (matchesCdkPath(tagsResp.tags, input.cdkPath)) {
            return { physicalId: repo.repositoryName, attributes: {} };
          }
        } catch (err) {
          if (err instanceof RepositoryNotFoundException) continue;
          throw err;
        }
      }
      nextToken = list.nextToken;
    } while (nextToken);
    return null;
  }
}
