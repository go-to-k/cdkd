import {
  LambdaClient,
  PublishLayerVersionCommand,
  DeleteLayerVersionCommand,
  ResourceNotFoundException,
  type LayerVersionContentInput,
  type Runtime,
  type Architecture,
} from '@aws-sdk/client-lambda';
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
 * AWS Lambda LayerVersion Provider
 *
 * Implements resource provisioning for AWS::Lambda::LayerVersion using the Lambda SDK.
 * WHY: PublishLayerVersion is synchronous - the CC API does not support this resource type.
 *
 * Note: Lambda LayerVersions are immutable. Updates publish a new version (new ARN).
 * Deletes target the specific version extracted from the ARN.
 */
export class LambdaLayerVersionProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private logger = getLogger().child('LambdaLayerVersionProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
  }

  /**
   * Create a Lambda layer version
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Lambda layer version ${logicalId}`);

    const layerName =
      (properties['LayerName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 64 });

    const content = properties['Content'] as Record<string, unknown> | undefined;
    if (!content) {
      throw new ProvisioningError(
        `Content is required for Lambda layer version ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const contentInput: LayerVersionContentInput = {};
      if (content['S3Bucket']) contentInput.S3Bucket = content['S3Bucket'] as string;
      if (content['S3Key']) contentInput.S3Key = content['S3Key'] as string;
      if (content['S3ObjectVersion'])
        contentInput.S3ObjectVersion = content['S3ObjectVersion'] as string;

      const response = await this.lambdaClient.send(
        new PublishLayerVersionCommand({
          LayerName: layerName,
          Content: contentInput,
          CompatibleRuntimes: properties['CompatibleRuntimes'] as Runtime[] | undefined,
          CompatibleArchitectures: properties['CompatibleArchitectures'] as
            | Architecture[]
            | undefined,
          Description: properties['Description'] as string | undefined,
          LicenseInfo: properties['LicenseInfo'] as string | undefined,
        })
      );

      const layerVersionArn = response.LayerVersionArn!;
      this.logger.debug(
        `Successfully created Lambda layer version ${logicalId}: ${layerVersionArn}`
      );

      return {
        physicalId: layerVersionArn,
        attributes: {
          LayerVersionArn: layerVersionArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Lambda layer version ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a Lambda layer version
   *
   * Lambda layer versions are immutable. An update publishes a new version.
   * The new LayerVersionArn becomes the physical ID.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Lambda layer version ${logicalId}: ${physicalId}`);

    // Layer versions are immutable - publish a new version
    const createResult = await this.create(logicalId, resourceType, properties);

    return {
      physicalId: createResult.physicalId,
      wasReplaced: true,
      attributes: createResult.attributes ?? {},
    };
  }

  /**
   * Delete a Lambda layer version
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting Lambda layer version ${logicalId}: ${physicalId}`);

    // Extract layer name and version number from the ARN
    // ARN format: arn:aws:lambda:region:account:layer:name:version
    const arnParts = physicalId.split(':');
    if (arnParts.length < 8) {
      this.logger.warn(`Invalid LayerVersionArn format: ${physicalId}, skipping deletion`);
      return;
    }
    const layerName = arnParts[6]!;
    const versionNumber = parseInt(arnParts[7]!, 10);

    if (isNaN(versionNumber)) {
      this.logger.warn(`Could not parse version number from ARN: ${physicalId}, skipping deletion`);
      return;
    }

    try {
      await this.lambdaClient.send(
        new DeleteLayerVersionCommand({
          LayerName: layerName,
          VersionNumber: versionNumber,
        })
      );
      this.logger.debug(`Successfully deleted Lambda layer version ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        this.logger.debug(`Lambda layer version ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Lambda layer version ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }
}
