import {
  APIGatewayClient,
  UpdateAccountCommand,
  CreateResourceCommand,
  DeleteResourceCommand,
  CreateDeploymentCommand,
  DeleteDeploymentCommand,
  CreateStageCommand,
  UpdateStageCommand,
  DeleteStageCommand,
  PutMethodCommand,
  DeleteMethodCommand,
  PutIntegrationCommand,
  CreateAuthorizerCommand,
  DeleteAuthorizerCommand,
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
 * - AWS::ApiGateway::Authorizer (API Gateway authorizer - Cognito, Token, Request)
 * - AWS::ApiGateway::Resource (API Gateway resource / path)
 * - AWS::ApiGateway::Deployment (API Gateway deployment)
 * - AWS::ApiGateway::Stage (API Gateway stage)
 * - AWS::ApiGateway::Method (API Gateway method)
 *
 * These resource types have issues with Cloud Control API:
 * - Account: Needs IAM trust propagation retry logic
 * - Resource: Needs parent ID resolution from properties
 * - Deployment: Needs RestApiId from Ref resolution
 * - Stage: Needs RestApiId, StageName, DeploymentId from properties
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
      case 'AWS::ApiGateway::Authorizer':
        return this.createAuthorizer(logicalId, resourceType, properties);
      case 'AWS::ApiGateway::Resource':
        return this.createResource(logicalId, resourceType, properties);
      case 'AWS::ApiGateway::Deployment':
        return this.createDeployment(logicalId, resourceType, properties);
      case 'AWS::ApiGateway::Stage':
        return this.createStage(logicalId, resourceType, properties);
      case 'AWS::ApiGateway::Method':
        return this.createMethod(logicalId, resourceType, properties);
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
      case 'AWS::ApiGateway::Authorizer':
        return this.updateAuthorizer(logicalId, physicalId, resourceType);
      case 'AWS::ApiGateway::Resource':
        return this.updateResource(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::ApiGateway::Deployment':
        return this.updateDeployment(logicalId, physicalId, resourceType);
      case 'AWS::ApiGateway::Stage':
        return this.updateStage(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::ApiGateway::Method':
        return this.updateMethod(logicalId, physicalId);
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
      case 'AWS::ApiGateway::Authorizer':
        return this.deleteAuthorizer(logicalId, physicalId, resourceType, properties);
      case 'AWS::ApiGateway::Resource':
        return this.deleteResource(logicalId, physicalId, resourceType, properties);
      case 'AWS::ApiGateway::Deployment':
        return this.deleteDeployment(logicalId, physicalId, resourceType, properties);
      case 'AWS::ApiGateway::Stage':
        return this.deleteStage(logicalId, physicalId, resourceType, properties);
      case 'AWS::ApiGateway::Method':
        return this.deleteMethod(logicalId, physicalId, resourceType);
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
      case 'AWS::ApiGateway::Authorizer':
        return this.getAuthorizerAttribute(physicalId, attributeName);
      case 'AWS::ApiGateway::Resource':
        return this.getResourceAttribute(physicalId, resourceType, attributeName);
      case 'AWS::ApiGateway::Deployment':
        return this.getDeploymentAttribute(physicalId, attributeName);
      case 'AWS::ApiGateway::Stage':
        return this.getStageAttribute(physicalId, attributeName);
      case 'AWS::ApiGateway::Method':
        return this.getMethodAttribute(physicalId, attributeName);
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

  // ─── AWS::ApiGateway::Authorizer ────────────────────────────────────

  /**
   * Create an API Gateway Authorizer
   *
   * Physical ID is the authorizer ID (not composite), so that Ref resolves
   * to the authorizer ID that API Gateway Methods expect for AuthorizerId.
   */
  private async createAuthorizer(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway Authorizer ${logicalId}`);

    const restApiId = properties['RestApiId'] as string;
    const name = properties['Name'] as string;
    const type = properties['Type'] as string;

    if (!restApiId || !name || !type) {
      throw new ProvisioningError(
        `RestApiId, Name, and Type are required for API Gateway Authorizer ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const providerArns = properties['ProviderARNs'] as string[] | undefined;

      const response = await this.apiGatewayClient.send(
        new CreateAuthorizerCommand({
          restApiId,
          name,
          type: type as 'TOKEN' | 'REQUEST' | 'COGNITO_USER_POOLS',
          providerARNs: providerArns,
          authorizerUri: properties['AuthorizerUri'] as string | undefined,
          authorizerCredentials: properties['AuthorizerCredentials'] as string | undefined,
          identitySource: properties['IdentitySource'] as string | undefined,
          identityValidationExpression: properties['IdentityValidationExpression'] as
            | string
            | undefined,
          authorizerResultTtlInSeconds: properties['AuthorizerResultTtlInSeconds'] as
            | number
            | undefined,
        })
      );

      const authorizerId = response.id!;
      this.logger.debug(
        `Successfully created API Gateway Authorizer ${logicalId}: ${authorizerId}`
      );

      return {
        physicalId: authorizerId,
        attributes: {
          AuthorizerId: authorizerId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create API Gateway Authorizer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an API Gateway Authorizer
   *
   * Authorizer updates are not commonly needed. For now, this is a no-op.
   * The deployment engine handles replacement for immutable property changes.
   */
  private updateAuthorizer(
    logicalId: string,
    physicalId: string,
    _resourceType: string
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating API Gateway Authorizer ${logicalId}: ${physicalId} (no-op)`);

    return Promise.resolve({
      physicalId,
      wasReplaced: false,
      attributes: {
        AuthorizerId: physicalId,
      },
    });
  }

  /**
   * Delete an API Gateway Authorizer
   */
  private async deleteAuthorizer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway Authorizer ${logicalId}: ${physicalId}`);

    const restApiId = properties?.['RestApiId'] as string | undefined;

    if (!restApiId) {
      throw new ProvisioningError(
        `RestApiId is required to delete API Gateway Authorizer ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.apiGatewayClient.send(
        new DeleteAuthorizerCommand({
          restApiId,
          authorizerId: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted API Gateway Authorizer ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.debug(`API Gateway Authorizer ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway Authorizer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get API Gateway Authorizer attribute
   */
  private getAuthorizerAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    if (attributeName === 'AuthorizerId') {
      return Promise.resolve(physicalId);
    }

    return Promise.resolve(undefined);
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
  private getResourceAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // ResourceId is the most common attribute
    if (attributeName === 'ResourceId') {
      return Promise.resolve(physicalId);
    }

    return Promise.resolve(undefined);
  }

  // ─── AWS::ApiGateway::Deployment ───────────────────────────────────

  /**
   * Create an API Gateway Deployment
   */
  private async createDeployment(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway Deployment ${logicalId}`);

    const restApiId = properties['RestApiId'] as string;

    if (!restApiId) {
      throw new ProvisioningError(
        `RestApiId is required for API Gateway Deployment ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.apiGatewayClient.send(
        new CreateDeploymentCommand({
          restApiId,
          description: properties['Description'] as string | undefined,
        })
      );

      const deploymentId = response.id!;
      this.logger.debug(
        `Successfully created API Gateway Deployment ${logicalId}: ${deploymentId}`
      );

      return {
        physicalId: deploymentId,
        attributes: {
          DeploymentId: deploymentId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create API Gateway Deployment ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an API Gateway Deployment
   *
   * Deployments are immutable - updates are not supported.
   * The deployment engine should handle replacement if needed.
   */
  private updateDeployment(
    logicalId: string,
    physicalId: string,
    _resourceType: string
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating API Gateway Deployment ${logicalId}: ${physicalId} (no-op)`);

    return Promise.resolve({
      physicalId,
      wasReplaced: false,
      attributes: {
        DeploymentId: physicalId,
      },
    });
  }

  /**
   * Delete an API Gateway Deployment
   */
  private async deleteDeployment(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway Deployment ${logicalId}: ${physicalId}`);

    const restApiId = properties?.['RestApiId'] as string | undefined;

    if (!restApiId) {
      throw new ProvisioningError(
        `RestApiId is required to delete API Gateway Deployment ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.apiGatewayClient.send(
        new DeleteDeploymentCommand({
          restApiId,
          deploymentId: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted API Gateway Deployment ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.debug(`API Gateway Deployment ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway Deployment ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get API Gateway Deployment attribute
   */
  private getDeploymentAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    if (attributeName === 'DeploymentId') {
      return Promise.resolve(physicalId);
    }

    return Promise.resolve(undefined);
  }

  // ─── AWS::ApiGateway::Stage ──────────────────────────────────────

  /**
   * Create an API Gateway Stage
   */
  private async createStage(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway Stage ${logicalId}`);

    const restApiId = properties['RestApiId'] as string;
    const stageName = properties['StageName'] as string;
    const deploymentId = properties['DeploymentId'] as string;

    if (!restApiId || !stageName || !deploymentId) {
      throw new ProvisioningError(
        `RestApiId, StageName, and DeploymentId are required for API Gateway Stage ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      await this.apiGatewayClient.send(
        new CreateStageCommand({
          restApiId,
          stageName,
          deploymentId,
          description: properties['Description'] as string | undefined,
        })
      );

      this.logger.debug(`Successfully created API Gateway Stage ${logicalId}: ${stageName}`);

      return {
        physicalId: stageName,
        attributes: {
          StageName: stageName,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create API Gateway Stage ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an API Gateway Stage
   *
   * Uses UpdateStageCommand with patch operations for changed properties.
   */
  private async updateStage(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating API Gateway Stage ${logicalId}: ${physicalId}`);

    const restApiId = properties['RestApiId'] as string;

    if (!restApiId) {
      throw new ProvisioningError(
        `RestApiId is required to update API Gateway Stage ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // Build patch operations for changed properties
    const patchOperations: Array<{ op: 'replace'; path: string; value: string }> = [];

    const deploymentId = properties['DeploymentId'] as string | undefined;
    const prevDeploymentId = previousProperties['DeploymentId'] as string | undefined;
    if (deploymentId && deploymentId !== prevDeploymentId) {
      patchOperations.push({ op: 'replace', path: '/deploymentId', value: deploymentId });
    }

    const description = properties['Description'] as string | undefined;
    const prevDescription = previousProperties['Description'] as string | undefined;
    if (description !== prevDescription) {
      patchOperations.push({
        op: 'replace',
        path: '/description',
        value: description ?? '',
      });
    }

    if (patchOperations.length === 0) {
      this.logger.debug(`No changes detected for API Gateway Stage ${logicalId}`);
      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          StageName: physicalId,
        },
      };
    }

    try {
      await this.apiGatewayClient.send(
        new UpdateStageCommand({
          restApiId,
          stageName: physicalId,
          patchOperations,
        })
      );

      this.logger.debug(`Successfully updated API Gateway Stage ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          StageName: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update API Gateway Stage ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an API Gateway Stage
   */
  private async deleteStage(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway Stage ${logicalId}: ${physicalId}`);

    const restApiId = properties?.['RestApiId'] as string | undefined;

    if (!restApiId) {
      throw new ProvisioningError(
        `RestApiId is required to delete API Gateway Stage ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.apiGatewayClient.send(
        new DeleteStageCommand({
          restApiId,
          stageName: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted API Gateway Stage ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.debug(`API Gateway Stage ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway Stage ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get API Gateway Stage attribute
   */
  private getStageAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    if (attributeName === 'StageName') {
      return Promise.resolve(physicalId);
    }

    return Promise.resolve(undefined);
  }

  // ─── AWS::ApiGateway::Method ──────────────────────────────────────

  /**
   * Create an API Gateway Method
   *
   * Creates a method on a resource and optionally sets up the integration.
   * PhysicalId format: `{restApiId}|{resourceId}|{httpMethod}`
   */
  private async createMethod(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway Method ${logicalId}`);

    const restApiId = properties['RestApiId'] as string;
    const resourceId = properties['ResourceId'] as string;
    const httpMethod = properties['HttpMethod'] as string;
    const authorizationType = (properties['AuthorizationType'] as string) ?? 'NONE';
    const authorizerId = properties['AuthorizerId'] as string | undefined;

    if (!restApiId || !resourceId || !httpMethod) {
      throw new ProvisioningError(
        `RestApiId, ResourceId, and HttpMethod are required for API Gateway Method ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      await this.apiGatewayClient.send(
        new PutMethodCommand({
          restApiId,
          resourceId,
          httpMethod,
          authorizationType,
          authorizerId,
        })
      );

      // If Integration property exists, set up the integration
      const integration = properties['Integration'] as Record<string, unknown> | undefined;
      if (integration) {
        await this.apiGatewayClient.send(
          new PutIntegrationCommand({
            restApiId,
            resourceId,
            httpMethod,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
            type: integration['Type'] as any,
            integrationHttpMethod: integration['IntegrationHttpMethod'] as string | undefined,
            uri: integration['Uri'] as string | undefined,
          })
        );
      }

      const physicalId = `${restApiId}|${resourceId}|${httpMethod}`;
      this.logger.debug(`Successfully created API Gateway Method ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create API Gateway Method ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an API Gateway Method
   *
   * Methods are typically replaced via new deployment, so this is a no-op.
   */
  private updateMethod(logicalId: string, physicalId: string): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating API Gateway Method ${logicalId}: ${physicalId} (no-op)`);

    return Promise.resolve({
      physicalId,
      wasReplaced: false,
      attributes: {},
    });
  }

  /**
   * Delete an API Gateway Method
   *
   * Parses the composite physicalId (`restApiId|resourceId|httpMethod`) and
   * calls DeleteMethodCommand. Handles NotFoundException gracefully.
   */
  private async deleteMethod(
    logicalId: string,
    physicalId: string,
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway Method ${logicalId}: ${physicalId}`);

    const parts = physicalId.split('|');
    if (parts.length !== 3) {
      throw new ProvisioningError(
        `Invalid physicalId format for API Gateway Method ${logicalId}: expected "restApiId|resourceId|httpMethod", got "${physicalId}"`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const [restApiId, resourceId, httpMethod] = parts;

    try {
      await this.apiGatewayClient.send(
        new DeleteMethodCommand({
          restApiId,
          resourceId,
          httpMethod,
        })
      );

      this.logger.debug(`Successfully deleted API Gateway Method ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        this.logger.debug(`API Gateway Method ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway Method ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get API Gateway Method attribute
   */
  private getMethodAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    const parts = physicalId.split('|');
    if (parts.length === 3) {
      if (attributeName === 'RestApiId') return Promise.resolve(parts[0]);
      if (attributeName === 'ResourceId') return Promise.resolve(parts[1]);
      if (attributeName === 'HttpMethod') return Promise.resolve(parts[2]);
    }

    return Promise.resolve(undefined);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
