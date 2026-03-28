import {
  CloudFrontClient,
  CreateCloudFrontOriginAccessIdentityCommand,
  DeleteCloudFrontOriginAccessIdentityCommand,
  GetCloudFrontOriginAccessIdentityCommand,
  NoSuchCloudFrontOriginAccessIdentity,
} from '@aws-sdk/client-cloudfront';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS::CloudFront::CloudFrontOriginAccessIdentity
 *
 * CC API DELETE fails with "Invalid request provided" for this resource type.
 * Using CloudFront SDK directly for reliable CRUD operations.
 */
export class CloudFrontOAIProvider implements ResourceProvider {
  private cloudFrontClient: CloudFrontClient;
  private logger = getLogger().child('CloudFrontOAIProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CloudFront::CloudFrontOriginAccessIdentity',
      new Set(['CloudFrontOriginAccessIdentityConfig']),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.cloudFrontClient = awsClients.cloudFront;
  }

  /**
   * Create a CloudFront Origin Access Identity
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CloudFront OAI ${logicalId}`);

    const config = properties['CloudFrontOriginAccessIdentityConfig'] as
      | Record<string, unknown>
      | undefined;
    const comment = (config?.['Comment'] as string | undefined) ?? '';

    try {
      const response = await this.cloudFrontClient.send(
        new CreateCloudFrontOriginAccessIdentityCommand({
          CloudFrontOriginAccessIdentityConfig: {
            CallerReference: logicalId,
            Comment: comment,
          },
        })
      );

      const oai = response.CloudFrontOriginAccessIdentity!;
      const oaiId = oai.Id!;
      const s3CanonicalUserId = oai.S3CanonicalUserId!;

      this.logger.debug(`Created CloudFront OAI: ${oaiId}`);

      return {
        physicalId: oaiId,
        attributes: {
          Id: oaiId,
          S3CanonicalUserId: s3CanonicalUserId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CloudFront OAI ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a CloudFront Origin Access Identity
   *
   * OAI config is effectively immutable (only Comment can change, which is cosmetic).
   * No replacement needed for Comment changes.
   */
  update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Update requested for CloudFront OAI ${logicalId}: ${physicalId} (no-op)`);

    return Promise.resolve({
      physicalId,
      wasReplaced: false,
    });
  }

  /**
   * Delete a CloudFront Origin Access Identity
   *
   * Requires fetching the ETag first, then passing it as IfMatch for deletion.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting CloudFront OAI ${logicalId}: ${physicalId}`);

    try {
      // Get the current ETag (required for deletion)
      let etag: string;
      try {
        const getResponse = await this.cloudFrontClient.send(
          new GetCloudFrontOriginAccessIdentityCommand({ Id: physicalId })
        );
        etag = getResponse.ETag!;
      } catch (error) {
        if (error instanceof NoSuchCloudFrontOriginAccessIdentity) {
          this.logger.debug(`OAI ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Delete the OAI with the ETag
      await this.cloudFrontClient.send(
        new DeleteCloudFrontOriginAccessIdentityCommand({
          Id: physicalId,
          IfMatch: etag,
        })
      );

      this.logger.debug(`Successfully deleted CloudFront OAI ${logicalId}`);
    } catch (error) {
      if (error instanceof NoSuchCloudFrontOriginAccessIdentity) {
        this.logger.debug(`OAI ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CloudFront OAI ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get resource attribute (for Fn::GetAtt resolution)
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id') {
      return physicalId;
    }

    if (attributeName === 'S3CanonicalUserId') {
      const response = await this.cloudFrontClient.send(
        new GetCloudFrontOriginAccessIdentityCommand({ Id: physicalId })
      );
      return response.CloudFrontOriginAccessIdentity?.S3CanonicalUserId;
    }

    throw new Error(
      `Unsupported attribute: ${attributeName} for AWS::CloudFront::CloudFrontOriginAccessIdentity`
    );
  }
}
