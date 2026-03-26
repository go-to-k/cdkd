import {
  APIGatewayClient,
  UpdateAccountCommand,
  CreateResourceCommand,
  DeleteResourceCommand,
  NotFoundException,
} from '@aws-sdk/client-api-gateway';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

/**
 * AWS API Gateway Provider
 *
 * Implements resource provisioning for:
 * - AWS::ApiGateway::Account (API Gateway account settings)
 * - AWS::ApiGateway::Resource (API Gateway resource / path)
 *
 * These resource types have issues with Cloud Control API:
 * - Account: Needs IAM trust propagation retry logic
 * - Resource: Needs parent ID resolution from properties
 */
export class ApiGatewayProvider implements ResourceProvider {
  private apiGatewayClient: APIGatewayClient;
  private logger = getLogger().child('ApiGatewayProvider');

  /** Maximum number of retries for IAM propagation delays */
  private static readonly MAX_IAM_RETRIES = 3;
  /** Delay between IAM propagation retries (ms) - exponential backoff */
  private static readonly IAM_RETRY_DELAY_MS = 10000;

  constructor() {
    const awsClients = getAwsClients();
    this.apiGatewayClient = awsClients.apiGateway;
  }

  /**
   * Create a resource
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::ApiGateway::Account':
        return this.createAccount(logicalId, resourceType, properties);
      case 'AWS::ApiGateway::Resource':
        return this.createResource(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  /**
   * Update a resource
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::ApiGateway::Account':
        return this.updateAccount(logicalId, physicalId, resourceType, properties);
      case 'AWS::ApiGateway::Resource':
        return this.updateResource(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  /**
   * Delete a resource
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ApiGateway::Account':
        return this.deleteAccount(logicalId, physicalId, resourceType);
      case 'AWS::ApiGateway::Resource':
        return this.deleteResource(logicalId, physicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  /**
   * Get resource attributes (for Fn::GetAtt resolution)
   */
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (resourceType) {
      case 'AWS::ApiGateway::Account':
        // Account has no useful GetAtt attributes
        return undefined;
      case 'AWS::ApiGateway::Resource':
        return this.getResourceAttribute(physicalId, resourceType, attributeName);
      default:
        return undefined;
    }
  }

  // ─── AWS::ApiGateway::Account ───────────────────────────────────────

  /**
   * Create API Gateway Account settings
   *
   * Uses UpdateAccountCommand because API Gateway Account is a singleton.
   * Retries on "not authorized" errors due to IAM role trust propagation delays.
   */
  private async createAccount(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway Account ${logicalId}`);

    const cloudWatchRoleArn = properties['CloudWatchRoleArn'] as string | undefined;

    try {
      await this.updateAccountWithRetry(cloudWatchRoleArn, logicalId, resourceType);

      this.logger.debug(`Successfully created API Gateway Account ${logicalId}`);

      return {
        physicalId: 'ApiGatewayAccount',
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create API Gateway Account ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update API Gateway Account settings
   */
  private async updateAccount(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating API Gateway Account ${logicalId}`);

    const cloudWatchRoleArn = properties['CloudWatchRoleArn'] as string | undefined;

    try {
      await this.updateAccountWithRetry(cloudWatchRoleArn, logicalId, resourceType);

      this.logger.debug(`Successfully updated API Gateway Account ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update API Gateway Account ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete API Gateway Account settings
   *
   * Clears the CloudWatch role ARN by setting it to empty string.
   */
  private async deleteAccount(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway Account ${logicalId}`);

    try {
      await this.apiGatewayClient.send(
        new UpdateAccountCommand({
          patchOperations: [
            {
              op: 'replace',
              path: '/cloudwatchRoleArn',
              value: '',
            },
          ],
        })
      );

      this.logger.debug(`Successfully deleted API Gateway Account ${logicalId}`);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway Account ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Update Account with retry logic for IAM propagation delays
   *
   * When a new IAM role is created and immediately assigned as the API Gateway
   * CloudWatch role, API Gateway may reject it with "not authorized" because
   * the IAM trust relationship hasn't fully propagated yet.
   */
  private async updateAccountWithRetry(
    cloudWatchRoleArn: string | undefined,
    logicalId: string,
    _resourceType: string
  ): Promise<void> {
    const patchOperations = cloudWatchRoleArn
      ? [
          {
            op: 'replace' as const,
            path: '/cloudwatchRoleArn',
            value: cloudWatchRoleArn,
          },
        ]
      : [];

    for (let attempt = 1; attempt <= ApiGatewayProvider.MAX_IAM_RETRIES; attempt++) {
      try {
        await this.apiGatewayClient.send(new UpdateAccountCommand({ patchOperations }));
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isIamPropagationError =
          message.toLowerCase().includes('not authorized') ||
          message.toLowerCase().includes('does not have required permissions') ||
          message.toLowerCase().includes('the role arn does not have required trust') ||
          message.toLowerCase().includes('too many requests');

        if (isIamPropagationError && attempt < ApiGatewayProvider.MAX_IAM_RETRIES) {
          this.logger.warn(
            `IAM propagation delay for ${logicalId} (attempt ${attempt}/${ApiGatewayProvider.MAX_IAM_RETRIES}), ` +
              `retrying in ${ApiGatewayProvider.IAM_RETRY_DELAY_MS / 1000}s...`
          );
          await this.sleep(ApiGatewayProvider.IAM_RETRY_DELAY_MS);
          continue;
        }

        throw error;
      }
    }
  }

  // ─── AWS::ApiGateway::Resource ──────────────────────────────────────

  /**
   * Create an API Gateway Resource (path part)
   */
  private async createResource(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway Resource ${logicalId}`);

    const restApiId = properties['RestApiId'] as string;
    const parentId = properties['ParentId'] as string;
    const pathPart = properties['PathPart'] as string;

    if (!restApiId || !parentId || !pathPart) {
      throw new ProvisioningError(
        `RestApiId, ParentId, and PathPart are required for API Gateway Resource ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.apiGatewayClient.send(
        new CreateResourceCommand({
          restApiId,
          parentId,
          pathPart,
        })
      );

      const resourceId = response.id!;
      this.logger.debug(`Successfully created API Gateway Resource ${logicalId}: ${resourceId}`);

      return {
        physicalId: resourceId,
        attributes: {
          ResourceId: resourceId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create API Gateway Resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an API Gateway Resource
   *
   * API Gateway Resources are immutable - if PathPart changes,
   * the resource must be replaced (returns wasReplaced: true).
   */
  private async updateResource(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating API Gateway Resource ${logicalId}: ${physicalId}`);

    const newPathPart = properties['PathPart'] as string;
    const oldPathPart = previousProperties['PathPart'] as string;

    // PathPart is immutable - if it changed, resource must be replaced
    if (newPathPart !== oldPathPart) {
      this.logger.debug(
        `PathPart changed from "${oldPathPart}" to "${newPathPart}", replacing resource`
      );

      // Create new resource
      const createResult = await this.createResource(logicalId, resourceType, properties);

      // Delete old resource
      try {
        await this.deleteResource(logicalId, physicalId, resourceType, previousProperties);
      } catch (error) {
        this.logger.warn(
          `Failed to delete old API Gateway Resource ${physicalId} during replacement: ${String(error)}. ` +
            `The old resource may be orphaned and require manual cleanup.`
        );
      }

      return {
        physicalId: createResult.physicalId,
        wasReplaced: true,
        attributes: createResult.attributes ?? {},
      };
    }

    // No changes needed (RestApiId and ParentId changes also require replacement,
    // but the deployment engine handles those via immutable property detection)
    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        ResourceId: physicalId,
      },
    };
  }

  /**
   * Delete an API Gateway Resource
   */
  private async deleteResource(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway Resource ${logicalId}: ${physicalId}`);

    const restApiId = properties?.['RestApiId'] as string | undefined;

    if (!restApiId) {
      throw new ProvisioningError(
        `RestApiId is required to delete API Gateway Resource ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.apiGatewayClient.send(
        new DeleteResourceCommand({
          restApiId,
          resourceId: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted API Gateway Resource ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.debug(`API Gateway Resource ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway Resource ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get API Gateway Resource attribute
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  private async getResourceAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // ResourceId is the most common attribute
    if (attributeName === 'ResourceId') {
      return physicalId;
    }

    return undefined;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
