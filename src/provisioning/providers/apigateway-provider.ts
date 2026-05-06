import {
  APIGatewayClient,
  UpdateAccountCommand,
  GetAccountCommand,
  CreateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  CreateDeploymentCommand,
  DeleteDeploymentCommand,
  GetDeploymentCommand,
  CreateStageCommand,
  UpdateStageCommand,
  DeleteStageCommand,
  GetStageCommand,
  PutMethodCommand,
  DeleteMethodCommand,
  GetMethodCommand,
  PutIntegrationCommand,
  PutMethodResponseCommand,
  CreateAuthorizerCommand,
  DeleteAuthorizerCommand,
  GetAuthorizerCommand,
  NotFoundException,
} from '@aws-sdk/client-api-gateway';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
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

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::ApiGateway::Account', new Set(['CloudWatchRoleArn'])],
    [
      'AWS::ApiGateway::Authorizer',
      new Set([
        'RestApiId',
        'Name',
        'Type',
        'ProviderARNs',
        'AuthorizerUri',
        'AuthorizerCredentials',
        'IdentitySource',
        'IdentityValidationExpression',
        'AuthorizerResultTtlInSeconds',
      ]),
    ],
    ['AWS::ApiGateway::Resource', new Set(['RestApiId', 'ParentId', 'PathPart'])],
    ['AWS::ApiGateway::Deployment', new Set(['RestApiId', 'Description'])],
    [
      'AWS::ApiGateway::Stage',
      new Set(['RestApiId', 'StageName', 'DeploymentId', 'Description', 'Tags']),
    ],
    [
      'AWS::ApiGateway::Method',
      new Set([
        'RestApiId',
        'ResourceId',
        'HttpMethod',
        'AuthorizationType',
        'AuthorizerId',
        'Integration',
        'MethodResponses',
      ]),
    ],
  ]);

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
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ApiGateway::Account':
        return this.deleteAccount(logicalId, physicalId, resourceType);
      case 'AWS::ApiGateway::Authorizer':
        return this.deleteAuthorizer(logicalId, physicalId, resourceType, properties, context);
      case 'AWS::ApiGateway::Resource':
        return this.deleteResource(logicalId, physicalId, resourceType, properties, context);
      case 'AWS::ApiGateway::Deployment':
        return this.deleteDeployment(logicalId, physicalId, resourceType, properties, context);
      case 'AWS::ApiGateway::Stage':
        return this.deleteStage(logicalId, physicalId, resourceType, properties, context);
      case 'AWS::ApiGateway::Method':
        return this.deleteMethod(logicalId, physicalId, resourceType, context);
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
   * Update an API Gateway Authorizer.
   *
   * AWS exposes `UpdateAuthorizer` (PATCH) but cdkd does not yet plumb the
   * patch-operations builder through. Authorizers are recreated by the
   * deploy engine's immutable-property replacement path. `cdkd drift
   * --revert` surfaces a clear "use --replace or re-deploy" message
   * instead of silently no-op'ing the revert.
   */
  private updateAuthorizer(
    logicalId: string,
    _physicalId: string,
    _resourceType: string
  ): Promise<ResourceUpdateResult> {
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        'AWS::ApiGateway::Authorizer',
        logicalId,
        'API Gateway Authorizer updates are not yet implemented in cdkd; re-deploy with cdkd deploy --replace, or destroy + redeploy the stack'
      )
    );
  }

  /**
   * Delete an API Gateway Authorizer
   */
  private async deleteAuthorizer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
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
        const clientRegion = await this.apiGatewayClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
    properties?: Record<string, unknown>,
    context?: DeleteContext
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
        const clientRegion = await this.apiGatewayClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
   * Update an API Gateway Deployment.
   *
   * Deployments are immutable — every property change requires a fresh
   * Deployment. `cdkd drift --revert` therefore throws
   * `ResourceUpdateNotSupportedError` instead of silently no-op'ing.
   */
  private updateDeployment(
    logicalId: string,
    _physicalId: string,
    _resourceType: string
  ): Promise<ResourceUpdateResult> {
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        'AWS::ApiGateway::Deployment',
        logicalId,
        'API Gateway Deployment is immutable; re-deploy with cdkd deploy --replace, or change the resource definition to create a new Deployment'
      )
    );
  }

  /**
   * Delete an API Gateway Deployment
   */
  private async deleteDeployment(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
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
        const clientRegion = await this.apiGatewayClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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
          tags: this.cfnTagsToRecord(properties['Tags']),
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
    properties?: Record<string, unknown>,
    context?: DeleteContext
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
        const clientRegion = await this.apiGatewayClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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

      // If MethodResponses property exists, set up method responses
      const methodResponses = properties['MethodResponses'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (methodResponses) {
        for (const resp of methodResponses) {
          const statusCode = String(resp['StatusCode']);
          await this.apiGatewayClient.send(
            new PutMethodResponseCommand({
              restApiId,
              resourceId,
              httpMethod,
              statusCode,
              responseModels: resp['ResponseModels'] as Record<string, string> | undefined,
              responseParameters: resp['ResponseParameters'] as Record<string, boolean> | undefined,
            })
          );
        }
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
   * Update an API Gateway Method.
   *
   * AWS exposes `UpdateMethod` (PATCH) but cdkd does not yet plumb the
   * patch-operations builder through. Methods are recreated by the deploy
   * engine's immutable-property replacement path. `cdkd drift --revert`
   * surfaces a clear "use --replace or re-deploy" message instead of
   * silently no-op'ing the revert.
   */
  private updateMethod(logicalId: string, _physicalId: string): Promise<ResourceUpdateResult> {
    return Promise.reject(
      new ResourceUpdateNotSupportedError(
        'AWS::ApiGateway::Method',
        logicalId,
        'API Gateway Method updates are not yet implemented in cdkd; re-deploy with cdkd deploy --replace, or destroy + redeploy the stack'
      )
    );
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
    resourceType: string,
    context?: DeleteContext
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
        const clientRegion = await this.apiGatewayClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
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

  /**
   * Convert CloudFormation Tags (Array<{Key, Value}>) to SDK tags (Record<string, string>).
   */
  private cfnTagsToRecord(tags: unknown): Record<string, string> | undefined {
    if (!tags || !Array.isArray(tags)) return undefined;
    const result: Record<string, string> = {};
    for (const tag of tags as Array<{ Key: string; Value: string }>) {
      result[tag.Key] = tag.Value;
    }
    return result;
  }

  /**
   * Read the AWS-current API Gateway resource configuration in CFn-property
   * shape.
   *
   * **Coverage**:
   *   - `AWS::ApiGateway::Account` → `GetAccount` for `CloudWatchRoleArn`.
   *   - `AWS::ApiGateway::Method` → `GetMethod`. PhysicalId is the composite
   *     `restApiId|resourceId|httpMethod`, so we have everything needed
   *     without `Properties`.
   *   - `AWS::ApiGateway::Authorizer` / `Resource` / `Deployment` / `Stage`:
   *     each uses `properties.RestApiId` (passed through PR G's signature
   *     extension) to issue the appropriate `Get*` call.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    switch (resourceType) {
      case 'AWS::ApiGateway::Account':
        return this.readCurrentStateAccount();
      case 'AWS::ApiGateway::Method':
        return this.readCurrentStateMethod(physicalId);
      case 'AWS::ApiGateway::Authorizer':
        return this.readCurrentStateAuthorizer(physicalId, properties);
      case 'AWS::ApiGateway::Resource':
        return this.readCurrentStateResource(physicalId, properties);
      case 'AWS::ApiGateway::Deployment':
        return this.readCurrentStateDeployment(physicalId, properties);
      case 'AWS::ApiGateway::Stage':
        return this.readCurrentStateStage(physicalId, properties);
      default:
        return undefined;
    }
  }

  private async readCurrentStateAuthorizer(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const restApiId = properties?.['RestApiId'] as string | undefined;
    if (!restApiId) return undefined;

    try {
      const resp = await this.apiGatewayClient.send(
        new GetAuthorizerCommand({ restApiId, authorizerId: physicalId })
      );
      const result: Record<string, unknown> = { RestApiId: restApiId };
      if (resp.name !== undefined) result['Name'] = resp.name;
      if (resp.type !== undefined) result['Type'] = resp.type;
      if (resp.providerARNs !== undefined && resp.providerARNs.length > 0) {
        result['ProviderARNs'] = [...resp.providerARNs];
      }
      if (resp.authorizerUri !== undefined) result['AuthorizerUri'] = resp.authorizerUri;
      if (resp.authorizerCredentials !== undefined) {
        result['AuthorizerCredentials'] = resp.authorizerCredentials;
      }
      if (resp.identitySource !== undefined) result['IdentitySource'] = resp.identitySource;
      if (resp.identityValidationExpression !== undefined) {
        result['IdentityValidationExpression'] = resp.identityValidationExpression;
      }
      if (resp.authorizerResultTtlInSeconds !== undefined) {
        result['AuthorizerResultTtlInSeconds'] = resp.authorizerResultTtlInSeconds;
      }
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  private async readCurrentStateResource(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const restApiId = properties?.['RestApiId'] as string | undefined;
    if (!restApiId) return undefined;

    try {
      const resp = await this.apiGatewayClient.send(
        new GetResourceCommand({ restApiId, resourceId: physicalId })
      );
      const result: Record<string, unknown> = { RestApiId: restApiId };
      if (resp.parentId !== undefined) result['ParentId'] = resp.parentId;
      if (resp.pathPart !== undefined) result['PathPart'] = resp.pathPart;
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  private async readCurrentStateDeployment(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const restApiId = properties?.['RestApiId'] as string | undefined;
    if (!restApiId) return undefined;

    try {
      const resp = await this.apiGatewayClient.send(
        new GetDeploymentCommand({ restApiId, deploymentId: physicalId })
      );
      const result: Record<string, unknown> = { RestApiId: restApiId };
      if (resp.description !== undefined && resp.description !== '') {
        result['Description'] = resp.description;
      }
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  private async readCurrentStateStage(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const restApiId = properties?.['RestApiId'] as string | undefined;
    if (!restApiId) return undefined;

    try {
      const resp = await this.apiGatewayClient.send(
        new GetStageCommand({ restApiId, stageName: physicalId })
      );
      const result: Record<string, unknown> = { RestApiId: restApiId };
      if (resp.stageName !== undefined) result['StageName'] = resp.stageName;
      if (resp.deploymentId !== undefined) result['DeploymentId'] = resp.deploymentId;
      if (resp.description !== undefined && resp.description !== '') {
        result['Description'] = resp.description;
      }
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  private async readCurrentStateAccount(): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.apiGatewayClient.send(new GetAccountCommand({}));
      const result: Record<string, unknown> = {};
      if (resp.cloudwatchRoleArn !== undefined) {
        result['CloudWatchRoleArn'] = resp.cloudwatchRoleArn;
      }
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  private async readCurrentStateMethod(
    physicalId: string
  ): Promise<Record<string, unknown> | undefined> {
    const parts = physicalId.split('|');
    if (parts.length !== 3) return undefined;
    const [restApiId, resourceId, httpMethod] = parts;

    try {
      const resp = await this.apiGatewayClient.send(
        new GetMethodCommand({ restApiId, resourceId, httpMethod })
      );
      const result: Record<string, unknown> = {};
      if (restApiId !== undefined) result['RestApiId'] = restApiId;
      if (resourceId !== undefined) result['ResourceId'] = resourceId;
      if (resp.httpMethod !== undefined) result['HttpMethod'] = resp.httpMethod;
      if (resp.authorizationType !== undefined) {
        result['AuthorizationType'] = resp.authorizationType;
      }
      if (resp.authorizerId !== undefined) result['AuthorizerId'] = resp.authorizerId;
      if (resp.methodIntegration) result['Integration'] = resp.methodIntegration;
      if (resp.methodResponses) result['MethodResponses'] = resp.methodResponses;
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Adopt an existing API Gateway sub-resource into cdkd state.
   *
   * **Explicit override only.** API Gateway sub-resources (Authorizer,
   * Resource, Deployment, Stage, Method) live under a parent `RestApi`,
   * and their physical ids are not globally unique — they're scoped
   * `<restApiId>/<sub-id>`. Auto-lookup by `aws:cdk:path` would need to
   * walk every RestApi in the account, then every sub-resource within
   * each, which is impractical and error-prone.
   *
   * `AWS::ApiGateway::RestApi` itself is handled by the Cloud Control
   * API fallback (also explicit-override only — see
   * `cloud-control-provider.ts`).
   *
   * Users adopting an existing API Gateway should pass
   * `--resource <logicalId>=<physicalId>` for each sub-resource; the
   * physical id format follows what `create()` returns for the same
   * type (e.g. `<restApiId>|<resourceId>` for `AWS::ApiGateway::Resource`).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }
}
