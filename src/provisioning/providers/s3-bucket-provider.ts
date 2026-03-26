import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutBucketVersioningCommand,
  PutBucketTaggingCommand,
  NoSuchBucket,
} from '@aws-sdk/client-s3';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS::S3::Bucket
 *
 * Uses S3 SDK directly instead of CC API for synchronous bucket creation.
 * S3's CreateBucket is synchronous - no polling needed, unlike CC API which
 * requires async polling (1s→1.5s→2.25s...) adding seconds per resource.
 */
export class S3BucketProvider implements ResourceProvider {
  private s3Client: S3Client;
  private logger = getLogger().child('S3BucketProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
  }

  /**
   * Generate a bucket name from logicalId when none is specified.
   * S3 bucket names must be lowercase, 3-63 chars, no underscores.
   */
  private generateBucketName(logicalId: string): string {
    // Create a short hash for uniqueness
    const hash = Buffer.from(logicalId)
      .toString('base64')
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 8)
      .toLowerCase();

    // Sanitize logicalId: lowercase, replace underscores, truncate
    const prefix = logicalId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);

    return `${prefix}-${hash}`;
  }

  /**
   * Get the region from the S3 client config
   */
  private async getRegion(): Promise<string> {
    const region = await this.s3Client.config.region();
    return region || 'us-east-1';
  }

  /**
   * Build attributes for an S3 bucket
   */
  private async buildAttributes(bucketName: string): Promise<Record<string, unknown>> {
    const region = await this.getRegion();
    return {
      Arn: `arn:aws:s3:::${bucketName}`,
      DomainName: `${bucketName}.s3.amazonaws.com`,
      RegionalDomainName: `${bucketName}.s3.${region}.amazonaws.com`,
      WebsiteURL: `http://${bucketName}.s3-website-${region}.amazonaws.com`,
    };
  }

  /**
   * Apply versioning configuration if specified
   */
  private async applyVersioning(
    bucketName: string,
    versioningConfig: Record<string, unknown>
  ): Promise<void> {
    const status = (versioningConfig['Status'] as string) || 'Suspended';
    await this.s3Client.send(
      new PutBucketVersioningCommand({
        Bucket: bucketName,
        VersioningConfiguration: {
          Status: status as 'Enabled' | 'Suspended',
        },
      })
    );
    this.logger.debug(`Applied versioning (${status}) to bucket ${bucketName}`);
  }

  /**
   * Apply tags if specified
   */
  private async applyTags(
    bucketName: string,
    tags: Array<{ Key: string; Value: string }>
  ): Promise<void> {
    await this.s3Client.send(
      new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: {
          TagSet: tags,
        },
      })
    );
    this.logger.debug(`Applied ${tags.length} tags to bucket ${bucketName}`);
  }

  /**
   * Apply additional bucket configuration after creation
   */
  private async applyConfiguration(
    bucketName: string,
    properties: Record<string, unknown>
  ): Promise<void> {
    // Versioning
    const versioningConfig = properties['VersioningConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (versioningConfig) {
      await this.applyVersioning(bucketName, versioningConfig);
    }

    // Tags
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    if (tags && Array.isArray(tags) && tags.length > 0) {
      await this.applyTags(bucketName, tags);
    }
  }

  /**
   * Create an S3 bucket
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 bucket ${logicalId}`);

    const bucketName =
      (properties['BucketName'] as string | undefined) || this.generateBucketName(logicalId);

    try {
      // CreateBucket params
      const createParams: {
        Bucket: string;
        CreateBucketConfiguration?: { LocationConstraint: string };
      } = {
        Bucket: bucketName,
      };

      // Add LocationConstraint for non-us-east-1 regions
      const region = await this.getRegion();
      if (region !== 'us-east-1') {
        createParams.CreateBucketConfiguration = {
          LocationConstraint: region as import('@aws-sdk/client-s3').BucketLocationConstraint,
        };
      }

      await this.s3Client.send(new CreateBucketCommand(createParams));
      this.logger.debug(`Created S3 bucket: ${bucketName}`);

      // Apply additional configuration
      await this.applyConfiguration(bucketName, properties);

      const attributes = await this.buildAttributes(bucketName);

      this.logger.debug(`Successfully created S3 bucket ${logicalId}: ${bucketName}`);

      return {
        physicalId: bucketName,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        bucketName,
        cause
      );
    }
  }

  /**
   * Update an S3 bucket
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating S3 bucket ${logicalId}: ${physicalId}`);

    const newBucketName = properties['BucketName'] as string | undefined;

    // Bucket name is immutable - if changed, requires replacement
    if (newBucketName && newBucketName !== physicalId) {
      this.logger.debug(
        `Bucket name changed (${physicalId} -> ${newBucketName}), replacement required`
      );
      return {
        physicalId,
        wasReplaced: true,
      };
    }

    try {
      // Apply configuration changes
      await this.applyConfiguration(physicalId, properties);

      const attributes = await this.buildAttributes(physicalId);

      this.logger.debug(`Successfully updated S3 bucket ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an S3 bucket
   *
   * Note: The bucket must be empty before deletion.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting S3 bucket ${logicalId}: ${physicalId}`);

    try {
      try {
        await this.s3Client.send(
          new DeleteBucketCommand({
            Bucket: physicalId,
          })
        );
        this.logger.debug(`Successfully deleted S3 bucket ${logicalId}`);
      } catch (error) {
        if (error instanceof NoSuchBucket) {
          this.logger.debug(`Bucket ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
