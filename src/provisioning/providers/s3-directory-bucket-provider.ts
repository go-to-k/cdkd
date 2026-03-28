import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS::S3Express::DirectoryBucket
 *
 * Uses S3 SDK directly for S3 Express Directory Bucket operations.
 * Directory buckets use the S3 Express One Zone storage class with
 * single-AZ data redundancy.
 */
export class S3DirectoryBucketProvider implements ResourceProvider {
  private s3Client: S3Client;
  private stsClient: STSClient;
  private logger = getLogger().child('S3DirectoryBucketProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
    this.stsClient = awsClients.sts;
  }

  /**
   * Get the region from the S3 client config
   */
  private async getRegion(): Promise<string> {
    const region = await this.s3Client.config.region();
    return region || 'us-east-1';
  }

  /**
   * Get the AWS account ID via STS
   */
  private async getAccountId(): Promise<string> {
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    return identity.Account!;
  }

  /**
   * Build attributes for a directory bucket
   */
  private async buildAttributes(bucketName: string): Promise<Record<string, unknown>> {
    const region = await this.getRegion();
    const accountId = await this.getAccountId();
    return {
      Arn: `arn:aws:s3express:${region}:${accountId}:bucket/${bucketName}`,
    };
  }

  /**
   * Create an S3 Express Directory Bucket
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 Express Directory Bucket ${logicalId}`);

    const dataRedundancy = (properties['DataRedundancy'] as string) || 'SingleAvailabilityZone';
    const locationName = properties['LocationName'] as string | undefined;

    // Generate bucket name if not specified
    // Directory bucket names must follow: {name}--{az-id}--x-s3
    let bucketName = properties['BucketName'] as string | undefined;
    if (!bucketName) {
      const baseName = generateResourceName(logicalId, {
        maxLength: 64,
        lowercase: true,
      });
      // locationName is like "us-east-1a--x-s3", use it directly as suffix
      const suffix = locationName || 'us-east-1a--x-s3';
      bucketName = `${baseName}--${suffix}`;
    }

    try {
      await this.s3Client.send(
        new CreateBucketCommand({
          Bucket: bucketName,
          CreateBucketConfiguration: {
            Bucket: {
              Type: 'Directory',
              DataRedundancy: dataRedundancy as 'SingleAvailabilityZone',
            },
            Location: {
              Name: locationName,
              Type: 'AvailabilityZone',
            },
          },
        })
      );
      this.logger.debug(`Created S3 Express Directory Bucket: ${bucketName}`);

      const attributes = await this.buildAttributes(bucketName);

      return {
        physicalId: bucketName,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 Express Directory Bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        bucketName,
        cause
      );
    }
  }

  /**
   * Update an S3 Express Directory Bucket
   *
   * Most properties are immutable, so this is a no-op.
   */
  update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(
      `Update for S3 Express Directory Bucket ${logicalId} is a no-op (immutable properties)`
    );
    return {
      physicalId,
      wasReplaced: false,
    };
  }

  /**
   * Delete an S3 Express Directory Bucket
   *
   * Must empty the bucket before deletion. Directory buckets do not support
   * versioning, so only current objects need to be deleted.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting S3 Express Directory Bucket ${logicalId}: ${physicalId}`);

    try {
      // Empty the bucket first
      await this.emptyBucket(physicalId);

      // Delete the bucket
      await this.s3Client.send(
        new DeleteBucketCommand({
          Bucket: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted S3 Express Directory Bucket ${logicalId}`);
    } catch (error) {
      // Bucket not found = already deleted (idempotent)
      if (
        error instanceof Error &&
        (error.name === 'NoSuchBucket' || error.name === 'BucketNotFound')
      ) {
        this.logger.debug(`Bucket ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete S3 Express Directory Bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Empty all objects from a directory bucket.
   * Lists and deletes objects in batches of 1000.
   */
  private async emptyBucket(bucketName: string): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const listResponse = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        })
      );

      const objects = listResponse.Contents;
      if (objects && objects.length > 0) {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
              Objects: objects.map((obj) => ({ Key: obj.Key })),
              Quiet: true,
            },
          })
        );
        this.logger.debug(`Deleted ${objects.length} objects from bucket ${bucketName}`);
      }

      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}
