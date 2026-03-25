import {
  CloudControlClient,
  CreateResourceCommand,
  UpdateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  GetResourceRequestStatusCommand,
  type ProgressEvent,
} from '@aws-sdk/client-cloudcontrol';
import { getAwsClients } from '../utils/aws-clients.js';
import { getLogger } from '../utils/logger.js';
import { ProvisioningError } from '../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../types/resource.js';

/**
 * AWS Cloud Control API Provider
 *
 * Provisions resources using the Cloud Control API, which provides
 * a unified interface for managing AWS resources.
 *
 * Note: Not all AWS resources are supported by Cloud Control API.
 * Use isSupportedResourceType() to check before usage.
 */
export class CloudControlProvider implements ResourceProvider {
  private cloudControlClient: CloudControlClient;
  private logger = getLogger().child('CloudControlProvider');

  // Maximum time to wait for operation completion (15 minutes)
  private readonly MAX_WAIT_TIME_MS = 15 * 60 * 1000;
  // Poll interval for checking operation status (5 seconds)
  private readonly POLL_INTERVAL_MS = 5 * 1000;

  constructor() {
    const awsClients = getAwsClients();
    this.cloudControlClient = awsClients.cloudControl;
  }

  /**
   * Create a resource using Cloud Control API
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.info(`Creating resource ${logicalId} (${resourceType})`);

    try {
      // Start resource creation
      const createResponse = await this.cloudControlClient.send(
        new CreateResourceCommand({
          TypeName: resourceType,
          DesiredState: JSON.stringify(properties),
        })
      );

      if (!createResponse.ProgressEvent?.RequestToken) {
        throw new ProvisioningError(
          `Failed to create resource ${logicalId}: No request token received`,
          resourceType,
          logicalId
        );
      }

      this.logger.debug(
        `Create request submitted for ${logicalId}, token: ${createResponse.ProgressEvent.RequestToken}`
      );

      // Wait for creation to complete
      const progressEvent = await this.waitForOperation(
        createResponse.ProgressEvent.RequestToken,
        logicalId,
        'CREATE'
      );

      if (!progressEvent.Identifier) {
        throw new ProvisioningError(
          `Failed to create resource ${logicalId}: No physical ID returned`,
          resourceType,
          logicalId
        );
      }

      this.logger.info(`Created resource ${logicalId}, physical ID: ${progressEvent.Identifier}`);

      // Parse resource properties to extract attributes
      const result: ResourceCreateResult = {
        physicalId: progressEvent.Identifier,
      };

      if (progressEvent.ResourceModel) {
        result.attributes = this.parseResourceModel(progressEvent.ResourceModel);
      }

      // Enrich attributes with computed values for specific resource types
      result.attributes = this.enrichResourceAttributes(
        resourceType,
        progressEvent.Identifier,
        result.attributes || {}
      );

      return result;
    } catch (error) {
      this.handleError(error, 'CREATE', resourceType, logicalId);
    }
  }

  /**
   * Update a resource using Cloud Control API
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.info(
      `Updating resource ${logicalId} (${resourceType}), physical ID: ${physicalId}`
    );

    // Cloud Control API doesn't use previousProperties for updates
    // It uses a full replacement approach with PatchDocument

    // TODO: Implement proper JSON Patch (RFC 6902) instead of always replacing root
    // Currently we replace the entire resource at '/', but this is not optimal and may fail
    // for some resource types. Should calculate individual property-level patches:
    // - Use 'add' for new properties
    // - Use 'replace' for changed properties
    // - Use 'remove' for deleted properties
    // This requires diffing currentProperties and properties to generate the patch.

    try {
      // Start resource update
      const updateResponse = await this.cloudControlClient.send(
        new UpdateResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
          PatchDocument: JSON.stringify([
            {
              op: 'replace',
              path: '/',
              value: properties,
            },
          ]),
        })
      );

      if (!updateResponse.ProgressEvent?.RequestToken) {
        throw new ProvisioningError(
          `Failed to update resource ${logicalId}: No request token received`,
          resourceType,
          logicalId,
          physicalId
        );
      }

      this.logger.debug(
        `Update request submitted for ${logicalId}, token: ${updateResponse.ProgressEvent.RequestToken}`
      );

      // Wait for update to complete
      const progressEvent = await this.waitForOperation(
        updateResponse.ProgressEvent.RequestToken,
        logicalId,
        'UPDATE'
      );

      this.logger.info(`Updated resource ${logicalId}`);

      // Parse resource properties to extract attributes
      // TODO: Detect resource replacement from Cloud Control API response
      // Currently hardcoded to false, but some property changes (immutable properties)
      // may trigger resource replacement. Need to check progressEvent for replacement indication.
      const result: ResourceUpdateResult = {
        physicalId,
        wasReplaced: false,
      };

      if (progressEvent.ResourceModel) {
        result.attributes = this.parseResourceModel(progressEvent.ResourceModel);
      }

      // Enrich attributes with computed values for specific resource types
      result.attributes = this.enrichResourceAttributes(
        resourceType,
        physicalId,
        result.attributes || {}
      );

      return result;
    } catch (error) {
      this.handleError(error, 'UPDATE', resourceType, logicalId, physicalId);
    }
  }

  /**
   * Delete a resource using Cloud Control API
   */
  async delete(logicalId: string, physicalId: string, resourceType: string): Promise<void> {
    this.logger.info(
      `Deleting resource ${logicalId} (${resourceType}), physical ID: ${physicalId}`
    );

    try {
      // Start resource deletion
      const deleteResponse = await this.cloudControlClient.send(
        new DeleteResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
        })
      );

      if (!deleteResponse.ProgressEvent?.RequestToken) {
        throw new ProvisioningError(
          `Failed to delete resource ${logicalId}: No request token received`,
          resourceType,
          logicalId,
          physicalId
        );
      }

      this.logger.debug(
        `Delete request submitted for ${logicalId}, token: ${deleteResponse.ProgressEvent.RequestToken}`
      );

      // Wait for deletion to complete
      await this.waitForOperation(deleteResponse.ProgressEvent.RequestToken, logicalId, 'DELETE');

      this.logger.info(`Deleted resource ${logicalId}`);
    } catch (error) {
      this.handleError(error, 'DELETE', resourceType, logicalId, physicalId);
    }
  }

  /**
   * Get current state of a resource
   */
  async getResourceState(
    resourceType: string,
    physicalId: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.cloudControlClient.send(
        new GetResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
        })
      );

      if (!response.ResourceDescription?.Properties) {
        return null;
      }

      return this.parseResourceModel(response.ResourceDescription.Properties);
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Wait for an asynchronous operation to complete
   */
  private async waitForOperation(
    requestToken: string,
    logicalId: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE'
  ): Promise<ProgressEvent> {
    const startTime = Date.now();
    let attempts = 0;

    while (Date.now() - startTime < this.MAX_WAIT_TIME_MS) {
      attempts++;

      const statusResponse = await this.cloudControlClient.send(
        new GetResourceRequestStatusCommand({
          RequestToken: requestToken,
        })
      );

      const progressEvent = statusResponse.ProgressEvent;

      if (!progressEvent) {
        throw new ProvisioningError(
          `Failed to get status for ${logicalId}: No progress event`,
          'Unknown',
          logicalId
        );
      }

      this.logger.debug(
        `${operation} ${logicalId}: ${progressEvent.OperationStatus} (attempt ${attempts})`
      );

      switch (progressEvent.OperationStatus) {
        case 'SUCCESS':
          return progressEvent;

        case 'FAILED':
          throw new ProvisioningError(
            `${operation} failed for ${logicalId}: ${progressEvent.StatusMessage || 'Unknown error'}`,
            progressEvent.TypeName || 'Unknown',
            logicalId,
            progressEvent.Identifier
          );

        case 'CANCEL_COMPLETE':
          throw new ProvisioningError(
            `${operation} cancelled for ${logicalId}`,
            progressEvent.TypeName || 'Unknown',
            logicalId,
            progressEvent.Identifier
          );

        case 'IN_PROGRESS':
        case 'PENDING':
          // Continue waiting
          await this.sleep(this.POLL_INTERVAL_MS);
          break;

        default:
          this.logger.warn(
            `Unknown operation status for ${logicalId}: ${progressEvent.OperationStatus}`
          );
          await this.sleep(this.POLL_INTERVAL_MS);
      }
    }

    throw new ProvisioningError(
      `${operation} timeout for ${logicalId} after ${this.MAX_WAIT_TIME_MS / 1000}s`,
      'Unknown',
      logicalId
    );
  }

  /**
   * Parse resource model JSON string
   */
  private parseResourceModel(resourceModel: string): Record<string, unknown> {
    try {
      return JSON.parse(resourceModel) as Record<string, unknown>;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to parse resource model: ${errorMessage}\n` +
          `Raw model: ${resourceModel.substring(0, 500)}${resourceModel.length > 500 ? '...' : ''}`
      );
      return {};
    }
  }

  /**
   * Enrich resource attributes with computed values
   *
   * Some resource types don't return all attributes via Cloud Control API.
   * This method adds computed attributes based on resource type and physical ID.
   */
  private enrichResourceAttributes(
    resourceType: string,
    physicalId: string,
    attributes: Record<string, unknown>
  ): Record<string, unknown> {
    const enriched = { ...attributes };

    switch (resourceType) {
      case 'AWS::S3::Bucket':
        // S3 bucket ARN: arn:aws:s3:::bucket-name
        if (!enriched['Arn']) {
          enriched['Arn'] = `arn:aws:s3:::${physicalId}`;
        }
        break;

      // Add more resource types as needed
      default:
        break;
    }

    return enriched;
  }

  /**
   * Handle errors and throw ProvisioningError
   */
  private handleError(
    error: unknown,
    operation: string,
    resourceType: string,
    logicalId: string,
    physicalId?: string
  ): never {
    const err = error as { name?: string; message?: string };

    // Check if resource type is not supported
    if (err.name === 'UnsupportedActionException' || err.name === 'TypeNotFoundException') {
      throw new ProvisioningError(
        `Resource type ${resourceType} is not supported by Cloud Control API and no SDK provider is registered.\n` +
          `Please report this issue at https://github.com/your-org/cdkq/issues so we can add SDK provider support.\n` +
          `Error: ${err.message || 'Unknown error'}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }

    // Re-throw if already a ProvisioningError
    if (error instanceof ProvisioningError) {
      throw error;
    }

    // Wrap other errors
    throw new ProvisioningError(
      `${operation} failed for ${logicalId}: ${err.message || 'Unknown error'}`,
      resourceType,
      logicalId,
      physicalId,
      error instanceof Error ? error : undefined
    );
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if a resource type is supported by Cloud Control API
   *
   * This is a best-effort check. Some resource types may still fail
   * even if they appear to be supported.
   */
  static isSupportedResourceType(resourceType: string): boolean {
    // Common resource types that are NOT supported by Cloud Control API
    const unsupportedTypes = new Set([
      // IAM (most types not supported)
      'AWS::IAM::Role',
      'AWS::IAM::Policy',
      'AWS::IAM::ManagedPolicy',
      'AWS::IAM::User',
      'AWS::IAM::Group',
      'AWS::IAM::InstanceProfile',

      // Lambda layers
      'AWS::Lambda::LayerVersion',

      // S3 bucket policies (use SDK instead)
      'AWS::S3::BucketPolicy',

      // CloudFormation-specific resources
      'AWS::CloudFormation::Stack',
      'AWS::CloudFormation::WaitCondition',
      'AWS::CloudFormation::WaitConditionHandle',
      'AWS::CloudFormation::CustomResource',

      // CDK-specific resources
      'AWS::CDK::Metadata',
      'Custom::CDKBucketDeployment',
      'Custom::S3AutoDeleteObjects',

      // Route53 hosted zones (complex)
      'AWS::Route53::HostedZone',

      // ACM certificates (validation complexity)
      'AWS::CertificateManager::Certificate',
    ]);

    if (unsupportedTypes.has(resourceType)) {
      return false;
    }

    // Custom resources are never supported by Cloud Control
    if (
      resourceType.startsWith('Custom::') ||
      resourceType.startsWith('AWS::CloudFormation::CustomResource')
    ) {
      return false;
    }

    // Most other AWS:: resources should be supported
    // (This is optimistic; some may still fail)
    return resourceType.startsWith('AWS::');
  }
}
