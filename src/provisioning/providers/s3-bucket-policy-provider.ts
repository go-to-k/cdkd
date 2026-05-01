import {
  S3Client,
  PutBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  NoSuchBucket,
} from '@aws-sdk/client-s3';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS S3 Bucket Policy Provider
 *
 * Implements resource provisioning for AWS::S3::BucketPolicy using the S3 SDK.
 * This is required because S3 Bucket Policy is not supported by Cloud Control API.
 */
export class S3BucketPolicyProvider implements ResourceProvider {
  private s3Client: S3Client;
  private logger = getLogger().child('S3BucketPolicyProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::S3::BucketPolicy', new Set(['Bucket', 'PolicyDocument'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
  }

  /**
   * Create an S3 bucket policy
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 bucket policy ${logicalId}`);

    const bucketName = properties['Bucket'] as string | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!bucketName) {
      throw new ProvisioningError(
        `Bucket is required for S3 bucket policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for S3 bucket policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      await this.s3Client.send(
        new PutBucketPolicyCommand({
          Bucket: bucketName,
          Policy: policyDoc,
        })
      );

      this.logger.debug(`Successfully created S3 bucket policy ${logicalId}`);

      // Physical ID is the bucket name
      return {
        physicalId: bucketName,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 bucket policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        bucketName,
        cause
      );
    }
  }

  /**
   * Update an S3 bucket policy
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating S3 bucket policy ${logicalId}: ${physicalId}`);

    const bucketName = properties['Bucket'] as string | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!bucketName) {
      throw new ProvisioningError(
        `Bucket is required for S3 bucket policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for S3 bucket policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      await this.s3Client.send(
        new PutBucketPolicyCommand({
          Bucket: bucketName,
          Policy: policyDoc,
        })
      );

      this.logger.debug(`Successfully updated S3 bucket policy ${logicalId}`);

      return {
        physicalId: bucketName,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update S3 bucket policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an S3 bucket policy
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 bucket policy ${logicalId}: ${physicalId}`);

    try {
      try {
        await this.s3Client.send(
          new DeleteBucketPolicyCommand({
            Bucket: physicalId,
          })
        );
        this.logger.debug(`Successfully deleted S3 bucket policy ${logicalId}`);
      } catch (error) {
        if (error instanceof NoSuchBucket) {
          const clientRegion = await this.s3Client.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Bucket ${physicalId} does not exist, skipping policy deletion`);
          return;
        }
        // If the policy doesn't exist, that's OK too
        if (
          error instanceof Error &&
          (error.name === 'NoSuchBucketPolicy' || error.message.includes('does not have'))
        ) {
          const clientRegion = await this.s3Client.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Bucket policy for ${physicalId} does not exist, skipping`);
          return;
        }
        throw error;
      }
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete S3 bucket policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
