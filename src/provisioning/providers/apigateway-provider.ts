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
  UpdateMethodCommand,
  DeleteMethodCommand,
  GetMethodCommand,
  PutIntegrationCommand,
  PutIntegrationResponseCommand,
  PutMethodResponseCommand,
  CreateAuthorizerCommand,
  UpdateAuthorizerCommand,
  DeleteAuthorizerCommand,
  GetAuthorizerCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
} from '@aws-sdk/client-api-gateway';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { stringifyValue } from '../../utils/stringify.js';
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
        'AuthType',
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
      new Set([
        'RestApiId',
        'StageName',
        'DeploymentId',
        'Description',
        'Tags',
        'TracingEnabled',
        'Variables',
        'MethodSettings',
      ]),
    ],
    [
      'AWS::ApiGateway::Method',
      new Set([
        'RestApiId',
        'ResourceId',
        'HttpMethod',
        'AuthorizationType',
        'AuthorizerId',
        'ApiKeyRequired',
        'OperationName',
        'RequestParameters',
        'RequestModels',
        'RequestValidatorId',
        'AuthorizationScopes',
        'Integration',
        'MethodResponses',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::ApiGateway::Deployment',
      new Map<string, string>([
        [
          'StageName',
          'CFn-only convenience for inline-creating a Stage from a Deployment; declare AWS::ApiGateway::Stage explicitly to attach to this Deployment',
        ],
        [
          'StageDescription',
          'CFn-only convenience for inline-creating a Stage; declare AWS::ApiGateway::Stage with the Description property instead',
        ],
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
        return this.updateAuthorizer(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
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
        return this.updateMethod(
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
    // Use `!== undefined` rather than a truthy gate so that an explicit
    // empty string `''` (the cdkd-state representation of "no
    // CloudWatchRole configured", produced by readCurrentStateAccount
    // and by deleteAccount) reaches AWS as a legitimate
    // `replace /cloudwatchRoleArn ''` patch operation. A truthy gate
    // would silently drop `''` and produce an empty patchOperations
    // list, so `cdkd drift --revert` would succeed with no actual
    // AWS-side change and the very next `cdkd drift` would re-detect
    // the same drift — a silent fail mode.
    const patchOperations =
      cloudWatchRoleArn !== undefined
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
          authType: properties['AuthType'] as string | undefined,
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
   * Update an API Gateway Authorizer via `UpdateAuthorizerCommand` (RFC 6902
   * JSON Patch operations).
   *
   * Mutable fields (per AWS API Gateway PATCH operations docs):
   *   `/name`, `/authType`, `/authorizerUri`, `/authorizerCredentials`,
   *   `/identitySource`, `/identityValidationExpression`,
   *   `/authorizerResultTtlInSeconds`, `/providerARNs`.
   *
   * `Type` and `RestApiId` are immutable (the deploy engine's replacement
   * path handles those changes via DELETE + CREATE before this method is
   * called).
   *
   * The `gate on !== undefined` pattern (NOT truthy) is load-bearing for
   * `cdkd drift --revert`: an empty placeholder coming from
   * `readCurrentStateAuthorizer` (e.g. `IdentitySource: ''` on a Cognito
   * authorizer) MUST reach AWS as `replace /<field> ''` so a console-side
   * change away from "" is actually cleared on revert. A truthy gate would
   * silently drop the empty placeholder and the next drift run would
   * re-detect the same divergence forever.
   */
  private async updateAuthorizer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating API Gateway Authorizer ${logicalId}: ${physicalId}`);

    const restApiId = properties['RestApiId'] as string | undefined;
    if (!restApiId) {
      throw new ProvisioningError(
        `RestApiId is required to update API Gateway Authorizer ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const patchOperations: Array<{ op: 'replace'; path: string; value: string }> = [];

    // Simple `replace` ops for primitive / single-value string fields.
    // ProviderARNs and IdentitySource are passed as-is (AWS accepts them
    // as comma-separated strings; CDK templates already produce the
    // joined form when they are arrays). For ProviderARNs cdkd state
    // holds an array, so we join with `,` to match the PATCH wire format.
    const primitiveFields: Array<{ key: string; path: string }> = [
      { key: 'Name', path: '/name' },
      { key: 'AuthType', path: '/authType' },
      { key: 'AuthorizerUri', path: '/authorizerUri' },
      { key: 'AuthorizerCredentials', path: '/authorizerCredentials' },
      { key: 'IdentitySource', path: '/identitySource' },
      { key: 'IdentityValidationExpression', path: '/identityValidationExpression' },
      { key: 'AuthorizerResultTtlInSeconds', path: '/authorizerResultTtlInSeconds' },
    ];

    for (const { key, path } of primitiveFields) {
      const newVal = properties[key];
      const prevVal = previousProperties[key];
      if (newVal !== prevVal) {
        // `!== undefined` gate (not truthy) — see method docstring.
        patchOperations.push({
          op: 'replace',
          path,
          value: newVal !== undefined ? stringifyValue(newVal) : '',
        });
      }
    }

    // ProviderARNs is an array on the cdkd-state side. AWS accepts a
    // comma-separated string for the `replace /providerARNs` op; an
    // empty string clears the list (the same pattern Account / Stage
    // use to clear a configured field).
    const newArns = properties['ProviderARNs'] as string[] | undefined;
    const prevArns = previousProperties['ProviderARNs'] as string[] | undefined;
    const arnsChanged =
      (newArns?.length ?? 0) !== (prevArns?.length ?? 0) ||
      (newArns ?? []).some((a, i) => a !== prevArns?.[i]);
    if (arnsChanged) {
      patchOperations.push({
        op: 'replace',
        path: '/providerARNs',
        value: (newArns ?? []).join(','),
      });
    }

    if (patchOperations.length === 0) {
      this.logger.debug(`No changes detected for API Gateway Authorizer ${logicalId}`);
      return { physicalId, wasReplaced: false };
    }

    try {
      await this.apiGatewayClient.send(
        new UpdateAuthorizerCommand({
          restApiId,
          authorizerId: physicalId,
          patchOperations,
        })
      );
      this.logger.debug(
        `Successfully updated API Gateway Authorizer ${logicalId} (${patchOperations.length} patch ops)`
      );
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update API Gateway Authorizer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
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
        'API Gateway Deployment is immutable on AWS — there is no UpdateDeployment API for the deployment itself (UpdateStage is for the stage that points at the deployment); every change requires CreateDeployment to produce a new immutable deployment. Re-deploy with cdkd deploy --replace, or change the resource definition to create a new Deployment.'
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
          tracingEnabled: properties['TracingEnabled'] as boolean | undefined,
          variables: properties['Variables'] as Record<string, string> | undefined,
          tags: this.cfnTagsToRecord(properties['Tags']),
        })
      );

      // MethodSettings (issue #966): CreateStage does not accept method
      // settings — they are applied via UpdateStage patch operations
      // (`/{method_setting_key}/throttling/rateLimit` etc.), so a stage
      // declaring them needs one post-create UpdateStage call.
      const methodSettings = properties['MethodSettings'] as CfnStageMethodSetting[] | undefined;
      const methodSettingsOps = buildMethodSettingsPatchOps(undefined, methodSettings);
      if (methodSettingsOps.length > 0) {
        try {
          await this.apiGatewayClient.send(
            new UpdateStageCommand({
              restApiId,
              stageName,
              patchOperations: methodSettingsOps,
            })
          );
        } catch (patchError) {
          // The stage was already created but no state record will be
          // written — without cleanup the corpse holds the stage name and
          // every retry dies with ConflictException (same class as the
          // Cloud Control create-remnant fix, PR #957). Best-effort delete,
          // then rethrow the original failure.
          try {
            await this.apiGatewayClient.send(new DeleteStageCommand({ restApiId, stageName }));
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to clean up stage ${stageName} after a MethodSettings patch failure: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
            );
          }
          throw patchError;
        }
      }

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

    // Build patch operations for changed properties. UpdateStage supports
    // both `replace` (deploymentId / description / tracingEnabled, and
    // adding/replacing a single variables key) and `remove` (dropping a
    // variables key), so the patch op type covers both.
    const patchOperations: Array<{ op: 'replace' | 'remove'; path: string; value?: string }> = [];

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

    // TracingEnabled — X-Ray. UpdateStage renders the boolean as a string
    // value ('true' / 'false') under the `/tracingEnabled` path.
    const tracingEnabled = properties['TracingEnabled'] as boolean | undefined;
    const prevTracingEnabled = previousProperties['TracingEnabled'] as boolean | undefined;
    if (tracingEnabled !== prevTracingEnabled) {
      patchOperations.push({
        op: 'replace',
        path: '/tracingEnabled',
        value: String(tracingEnabled ?? false),
      });
    }

    // Variables — stage variables map. UpdateStage takes one patch op per
    // key: `replace /variables/{key}` to add or change, `remove
    // /variables/{key}` to delete a key that is no longer declared.
    const variables = (properties['Variables'] as Record<string, string> | undefined) ?? {};
    const prevVariables =
      (previousProperties['Variables'] as Record<string, string> | undefined) ?? {};
    for (const [key, value] of Object.entries(variables)) {
      if (prevVariables[key] !== value) {
        patchOperations.push({ op: 'replace', path: `/variables/${key}`, value });
      }
    }
    for (const key of Object.keys(prevVariables)) {
      if (!(key in variables)) {
        patchOperations.push({ op: 'remove', path: `/variables/${key}` });
      }
    }

    // MethodSettings (issue #966) — per-method-path overrides
    // (throttling / metrics / logging / caching) ride the same UpdateStage
    // call as field-level replace/remove ops; a whole entry dropped from the
    // template removes every override for that method path.
    patchOperations.push(
      ...buildMethodSettingsPatchOps(
        previousProperties['MethodSettings'] as CfnStageMethodSetting[] | undefined,
        properties['MethodSettings'] as CfnStageMethodSetting[] | undefined
      )
    );

    try {
      if (patchOperations.length > 0) {
        await this.apiGatewayClient.send(
          new UpdateStageCommand({
            restApiId,
            stageName: physicalId,
            patchOperations,
          })
        );
      }

      // Apply tag diff. API Gateway Stage tags require a constructed ARN:
      // arn:aws:apigateway:{region}::/restapis/{restApiId}/stages/{stageName}
      const stageArn = await this.buildStageArn(restApiId, physicalId);
      if (stageArn) {
        await this.applyTagDiff(
          stageArn,
          previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
          properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
        );
      }

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
   * Creates a method on a resource and optionally sets up the integration
   * (and per-status-code integration responses) plus method responses.
   * PhysicalId format: `{restApiId}|{resourceId}|{httpMethod}`
   *
   * All mutable Method-level fields supported by `PutMethodRequest` are
   * forwarded (`ApiKeyRequired`, `OperationName`, `RequestParameters`,
   * `RequestModels`, `RequestValidatorId`, `AuthorizationScopes`).
   *
   * All mutable Integration-level fields supported by
   * `PutIntegrationRequest` are forwarded (`ConnectionType`,
   * `ConnectionId`, `Credentials`, `RequestParameters`, `RequestTemplates`,
   * `PassthroughBehavior`, `ContentHandling`, `TimeoutInMillis`,
   * `CacheNamespace`, `CacheKeyParameters`, `TlsConfig`,
   * `ResponseTransferMode`). Pre-fix only `Type` / `IntegrationHttpMethod`
   * / `Uri` were forwarded — silently dropping every other field. This
   * surfaced as e.g. `responseTransferMode: 'STREAM'` being lost,
   * producing the AWS rejection
   *   "Invalid ResponseTransferMode. Cannot use ResponseTransferMode
   *    BUFFERED for Lambda functions invoked by InvokeWithResponseStream
   *    for AWS_PROXY integrations."
   * when CDK's `LambdaIntegration({ responseTransferMode: STREAM })` was
   * used together with the streaming `response-streaming-invocations` URI.
   *
   * `MethodResponses` and `IntegrationResponses` are applied as separate
   * per-entry calls (`PutMethodResponseCommand` /
   * `PutIntegrationResponseCommand`). Order matters: every
   * `MethodResponse` is put BEFORE any `IntegrationResponse`, because AWS
   * validates that the matching method response already exists when
   * accepting an integration response (the integration response's
   * `ResponseParameters` / `ResponseTemplates` map onto headers declared
   * by the method response). The inverse order surfaces as
   * `Invalid mapping expression specified: ... [No method response exists
   * for method.]` — the canonical trigger is a CORS preflight OPTIONS
   * method emitted by `RestApi({ defaultCorsPreflightOptions: ... })`.
   *
   * Partial-failure cleanup: if any AWS call AFTER `PutMethodCommand`
   * fails, the method has already been created on AWS but cdkd state
   * does NOT record it (the throw happens before the success return).
   * A subsequent redeploy would then attempt CREATE again and AWS would
   * reject with `Method already exists for this resource`. To prevent
   * this orphan, the post-`PutMethod` block is wrapped in an inner
   * try/catch that issues a best-effort `DeleteMethodCommand` before
   * re-throwing the original error. Cleanup failures are logged at warn
   * (the underlying create failure is what matters; we don't mask it by
   * promoting a cleanup error). The class of bug — partial AWS-side
   * commit on `createMethod` failure — was first seen via the
   * `PutIntegrationResponse`-before-`PutMethodResponse` ordering bug
   * fixed in PR #373; this cleanup makes any future shape of
   * post-`PutMethod` failure self-healing on the next redeploy.
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
    const apiKeyRequired = properties['ApiKeyRequired'] as boolean | undefined;
    const operationName = properties['OperationName'] as string | undefined;
    const methodRequestParameters = properties['RequestParameters'] as
      | Record<string, boolean>
      | undefined;
    const requestModels = properties['RequestModels'] as Record<string, string> | undefined;
    const requestValidatorId = properties['RequestValidatorId'] as string | undefined;
    const authorizationScopes = properties['AuthorizationScopes'] as string[] | undefined;

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
          apiKeyRequired,
          operationName,
          requestParameters: methodRequestParameters,
          requestModels,
          requestValidatorId,
          authorizationScopes,
        })
      );

      // PutMethodCommand has succeeded — AWS has now committed the
      // Method resource. Every subsequent call wires sub-resources onto
      // it; if any of them fail, the method exists on AWS but cdkd state
      // will NOT (the throw aborts before the success-return). The next
      // redeploy would then re-try CREATE and AWS would reject with
      // `Method already exists for this resource`. Wrap the rest of the
      // wiring in an inner try/catch that issues a best-effort
      // `DeleteMethodCommand` before re-throwing, so the failed attempt
      // is self-healing on the next redeploy.
      try {
        // If Integration property exists, set up the integration. All
        // fields supported by `PutIntegrationRequest` are forwarded — see
        // the JSDoc on this method for the full list and the
        // `ResponseTransferMode` regression that motivated the fix.
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
              // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
              connectionType: integration['ConnectionType'] as any,
              connectionId: integration['ConnectionId'] as string | undefined,
              credentials: integration['Credentials'] as string | undefined,
              requestParameters: integration['RequestParameters'] as
                | Record<string, string>
                | undefined,
              requestTemplates: integration['RequestTemplates'] as
                | Record<string, string>
                | undefined,
              passthroughBehavior: integration['PassthroughBehavior'] as string | undefined,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
              contentHandling: integration['ContentHandling'] as any,
              timeoutInMillis: integration['TimeoutInMillis'] as number | undefined,
              cacheNamespace: integration['CacheNamespace'] as string | undefined,
              cacheKeyParameters: integration['CacheKeyParameters'] as string[] | undefined,
              // CFn emits TlsConfig.InsecureSkipVerification (PascalCase) but the
              // SDK input shape is { insecureSkipVerification } (camelCase);
              // passing the CFn object verbatim would silently drop the field.
              tlsConfig: integration['TlsConfig']
                ? {
                    insecureSkipVerification: (integration['TlsConfig'] as Record<string, unknown>)[
                      'InsecureSkipVerification'
                    ] as boolean | undefined,
                  }
                : undefined,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
              responseTransferMode: integration['ResponseTransferMode'] as any,
            })
          );
        }

        // MethodResponses must be created BEFORE IntegrationResponses:
        // `PutIntegrationResponse` validates that the `MethodResponse` for the
        // same `statusCode` already exists (because IntegrationResponse's
        // ResponseParameters / ResponseTemplates map onto headers declared by
        // the MethodResponse). Inverting the order makes AWS reject with
        // `Invalid mapping expression specified: ... [No method response
        // exists for method.]` — the canonical failure mode is a CORS
        // preflight OPTIONS method emitted by
        // `RestApi({ defaultCorsPreflightOptions: ... })`.
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
                responseParameters: resp['ResponseParameters'] as
                  | Record<string, boolean>
                  | undefined,
              })
            );
          }
        }

        if (integration) {
          // IntegrationResponses (CFn shape:
          //   [{StatusCode, SelectionPattern?, ResponseParameters?,
          //     ResponseTemplates?, ContentHandling?}, ...])
          // requires per-entry `PutIntegrationResponseCommand` calls after
          // the integration itself is created AND after the matching
          // MethodResponses are in place (see comment above).
          const integrationResponses = integration['IntegrationResponses'] as
            | Array<Record<string, unknown>>
            | undefined;
          if (integrationResponses) {
            for (const ir of integrationResponses) {
              const statusCode = String(ir['StatusCode']);
              await this.apiGatewayClient.send(
                new PutIntegrationResponseCommand({
                  restApiId,
                  resourceId,
                  httpMethod,
                  statusCode,
                  selectionPattern: ir['SelectionPattern'] as string | undefined,
                  responseParameters: ir['ResponseParameters'] as
                    | Record<string, string>
                    | undefined,
                  responseTemplates: ir['ResponseTemplates'] as Record<string, string> | undefined,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
                  contentHandling: ir['ContentHandling'] as any,
                })
              );
            }
          }
        }
      } catch (innerError) {
        // Best-effort cleanup of the AWS-side Method that PutMethodCommand
        // committed. Failures here are logged at warn but do NOT mask the
        // original error — the user needs to see what actually broke.
        try {
          await this.apiGatewayClient.send(
            new DeleteMethodCommand({ restApiId, resourceId, httpMethod })
          );
          this.logger.debug(
            `Cleaned up partially-created API Gateway Method ${logicalId} (${restApiId}/${resourceId}/${httpMethod}) after wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created API Gateway Method ${logicalId} (${restApiId}/${resourceId}/${httpMethod}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws apigateway delete-method --rest-api-id ${restApiId} --resource-id ${resourceId} --http-method ${httpMethod}`
          );
        }
        throw innerError;
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
   * Update an API Gateway Method via `UpdateMethodCommand` (RFC 6902 JSON
   * Patch operations).
   *
   * Mutable top-level fields:
   *   `/authorizationType`, `/authorizerId`, `/apiKeyRequired`,
   *   `/operationName`, `/requestValidatorId`.
   *
   * Map fields (`RequestParameters`, `RequestModels`) emit per-key
   * `add` / `remove` / `replace` ops with paths like
   *   `/requestParameters/method.request.querystring.foo`
   *   `/requestModels/application~1json` (slashes escaped per RFC 6901).
   *
   * `AuthorizationScopes` is an array — AWS accepts a comma-joined
   * `replace /authorizationScopes` op (same pattern as Authorizer's
   * `ProviderARNs`).
   *
   * `HttpMethod`, `ResourceId`, `RestApiId` are immutable (replacement
   * layer handles them via DELETE + CREATE).
   *
   * `Integration` and `MethodResponses` are NOT touched here — they are
   * separate API Gateway sub-resources (`UpdateIntegration` /
   * `UpdateMethodResponse`) and the cdkd `create()` path treats them as
   * inline children of the Method. Round-tripping their structurally-
   * incomplete `{}` placeholders through `updateMethod` would require
   * destroying / recreating the integration; that work is deferred and
   * the empty placeholders are blocked from reaching AWS by the
   * `!== undefined` gate plus the explicit "ignore Integration /
   * MethodResponses" comment in this method body.
   *
   * The `gate on !== undefined` pattern (NOT truthy) is load-bearing for
   * `cdkd drift --revert`: `ApiKeyRequired: false` and empty-string
   * placeholders must reach AWS as a real `replace` op so a console-
   * side toggle is actually cleared on revert.
   */
  private async updateMethod(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating API Gateway Method ${logicalId}: ${physicalId}`);

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

    const patchOperations: Array<{
      op: 'replace' | 'add' | 'remove';
      path: string;
      value?: string;
    }> = [];

    const primitiveFields: Array<{ key: string; path: string }> = [
      { key: 'AuthorizationType', path: '/authorizationType' },
      { key: 'AuthorizerId', path: '/authorizerId' },
      { key: 'ApiKeyRequired', path: '/apiKeyRequired' },
      { key: 'OperationName', path: '/operationName' },
      { key: 'RequestValidatorId', path: '/requestValidatorId' },
    ];

    for (const { key, path } of primitiveFields) {
      const newVal = properties[key];
      const prevVal = previousProperties[key];
      if (newVal !== prevVal) {
        patchOperations.push({
          op: 'replace',
          path,
          value: newVal !== undefined ? stringifyValue(newVal) : '',
        });
      }
    }

    // Map fields: per-key add / remove / replace.
    appendMapPatchOps(
      patchOperations,
      '/requestParameters',
      (properties['RequestParameters'] as Record<string, unknown> | undefined) ?? {},
      (previousProperties['RequestParameters'] as Record<string, unknown> | undefined) ?? {}
    );
    appendMapPatchOps(
      patchOperations,
      '/requestModels',
      (properties['RequestModels'] as Record<string, unknown> | undefined) ?? {},
      (previousProperties['RequestModels'] as Record<string, unknown> | undefined) ?? {}
    );

    // AuthorizationScopes is an array on the cdkd-state side. AWS
    // accepts a comma-separated string for the `replace
    // /authorizationScopes` op (same pattern as Authorizer's
    // ProviderARNs); an empty string clears the list.
    const newScopes = properties['AuthorizationScopes'] as string[] | undefined;
    const prevScopes = previousProperties['AuthorizationScopes'] as string[] | undefined;
    const scopesChanged =
      (newScopes?.length ?? 0) !== (prevScopes?.length ?? 0) ||
      (newScopes ?? []).some((s, i) => s !== prevScopes?.[i]);
    if (scopesChanged) {
      patchOperations.push({
        op: 'replace',
        path: '/authorizationScopes',
        value: (newScopes ?? []).join(','),
      });
    }

    if (patchOperations.length === 0) {
      this.logger.debug(`No changes detected for API Gateway Method ${logicalId}`);
      return { physicalId, wasReplaced: false };
    }

    try {
      await this.apiGatewayClient.send(
        new UpdateMethodCommand({
          restApiId,
          resourceId,
          httpMethod,
          patchOperations,
        })
      );
      this.logger.debug(
        `Successfully updated API Gateway Method ${logicalId} (${patchOperations.length} patch ops)`
      );
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update API Gateway Method ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
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
   * Build the ARN for an API Gateway Stage, used for tag mutations.
   *
   * Format: `arn:aws:apigateway:{region}::/restapis/{restApiId}/stages/{stageName}`.
   * The double colon (`::`) is intentional: API Gateway tagging uses an
   * account-id-less ARN.
   */
  private async buildStageArn(restApiId: string, stageName: string): Promise<string | undefined> {
    try {
      const region = await this.apiGatewayClient.config.region();
      return `arn:aws:apigateway:${region}::/restapis/${restApiId}/stages/${stageName}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via API Gateway's
   * `TagResource` / `UntagResource` APIs. API Gateway's `TagResource` takes
   * lowercase camelCase fields plus a tag-map (`{ resourceArn, tags: {key: value} }`);
   * `UntagResource` takes `{ resourceArn, tagKeys: [...] }`.
   */
  private async applyTagDiff(
    resourceArn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Record<string, string> = {};
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd[k] = v;
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.apiGatewayClient.send(
        new UntagResourceCommand({ resourceArn, tagKeys: tagsToRemove })
      );
      this.logger.debug(
        `Removed ${tagsToRemove.length} tag(s) from API Gateway resource ${resourceArn}`
      );
    }
    if (Object.keys(tagsToAdd).length > 0) {
      await this.apiGatewayClient.send(new TagResourceCommand({ resourceArn, tags: tagsToAdd }));
      this.logger.debug(
        `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on API Gateway resource ${resourceArn}`
      );
    }
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
      result['Name'] = resp.name ?? '';
      if (resp.type !== undefined) result['Type'] = resp.type;
      // AuthType is a customer-defined label (free-form string used by
      // OpenAPI import/export tooling, no functional impact on the
      // deployed authorizer). Emit-when-present so an Authorizer that
      // never set AuthType does not grow a phantom field that would
      // round-trip into drift.
      if (resp.authType !== undefined) result['AuthType'] = resp.authType;
      result['ProviderARNs'] = resp.providerARNs ? [...resp.providerARNs] : [];
      result['AuthorizerUri'] = resp.authorizerUri ?? '';
      result['AuthorizerCredentials'] = resp.authorizerCredentials ?? '';
      result['IdentitySource'] = resp.identitySource ?? '';
      result['IdentityValidationExpression'] = resp.identityValidationExpression ?? '';
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
      result['ParentId'] = resp.parentId ?? '';
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
      result['Description'] = resp.description ?? '';
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
      result['DeploymentId'] = resp.deploymentId ?? '';
      result['Description'] = resp.description ?? '';
      // #609 backfill: emit-when-present (do NOT emit a default when absent,
      // so a stage that never set these does not surface phantom drift).
      if (resp.tracingEnabled !== undefined) result['TracingEnabled'] = resp.tracingEnabled;
      if (resp.variables !== undefined) result['Variables'] = resp.variables;
      // MethodSettings (issue #966): rebuild the CFn list shape from the
      // get-stage `methodSettings` map, iterating the STATE's entries so the
      // list order matches the baseline (the drift comparator walks arrays
      // positionally) and emitting only the fields the state entry declares
      // (get-stage returns every setting with its default filled in, which
      // would otherwise surface phantom drift on undeclared fields).
      // NOTE this deliberately does NOT require `resp.methodSettings` to be
      // present: when every override was removed out-of-band, the entries
      // still emit (with the declared fields absent) so the drift surfaces
      // instead of the key silently dropping out of the comparison.
      const stateMethodSettings = properties?.['MethodSettings'] as
        | CfnStageMethodSetting[]
        | undefined;
      if (stateMethodSettings && stateMethodSettings.length > 0) {
        result['MethodSettings'] = stateMethodSettings.map((stateEntry) => {
          const awsEntry = (resp.methodSettings ?? {})[methodSettingKey(stateEntry)] as
            | Record<string, unknown>
            | undefined;
          const entry: Record<string, unknown> = {};
          if (stateEntry.ResourcePath !== undefined)
            entry['ResourcePath'] = stateEntry.ResourcePath;
          if (stateEntry.HttpMethod !== undefined) entry['HttpMethod'] = stateEntry.HttpMethod;
          for (const { cfnKey, responseKey } of METHOD_SETTING_PATCH_FIELDS) {
            if (stateEntry[cfnKey] !== undefined && awsEntry?.[responseKey] !== undefined) {
              entry[cfnKey] = awsEntry[responseKey];
            }
          }
          return entry;
        });
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
      result['CloudWatchRoleArn'] = resp.cloudwatchRoleArn ?? '';
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
      // Class 1 (type-discriminator-dependent fields, see
      // docs/provider-development.md § 3b). AuthorizerId is only valid
      // when AuthorizationType is CUSTOM or COGNITO_USER_POOLS — AWS
      // rejects PutMethod with "Invalid authorizer ID specified" or
      // "Authorizer not found" when sent on AuthorizationType=NONE /
      // AWS_IAM. Emitting `''` as a placeholder on a NONE method would
      // make `cdkd drift --revert`'s round-trip push that empty value
      // back, but Method.update currently throws
      // ResourceUpdateNotSupportedError so the AWS-rejection path
      // doesn't fire today; this gate is the structural defense for
      // when Method.update gains a real implementation. Drift
      // detection is not lost: a NONE method cannot legally have
      // AuthorizerId on AWS, so a console-side ADD is impossible.
      const authType = resp.authorizationType;
      if (authType === 'CUSTOM' || authType === 'COGNITO_USER_POOLS') {
        result['AuthorizerId'] = resp.authorizerId ?? '';
      }
      result['Integration'] = resp.methodIntegration ?? {};
      result['MethodResponses'] = resp.methodResponses ?? {};
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

/**
 * CFn `AWS::ApiGateway::Stage.MethodSetting` entry (template shape). Per the
 * CFn docs, `ResourcePath` is ALREADY `~1`-escaped in the template (`/` in a
 * real path segment is encoded as `~1`, e.g. `/~1pets`; `/*` is the
 * all-resources wildcard CDK's `deployOptions` emits), so building the
 * UpdateStage patch path only needs the leading slash stripped.
 */
interface CfnStageMethodSetting {
  ResourcePath?: string;
  HttpMethod?: string;
  ThrottlingRateLimit?: number;
  ThrottlingBurstLimit?: number;
  MetricsEnabled?: boolean;
  LoggingLevel?: string;
  DataTraceEnabled?: boolean;
  CachingEnabled?: boolean;
  CacheTtlInSeconds?: number;
  CacheDataEncrypted?: boolean;
  RequireAuthorizationForCacheControl?: boolean;
  UnauthorizedCacheControlHeaderStrategy?: string;
}

/**
 * CFn MethodSetting field → UpdateStage patch-path suffix under
 * `/{method_setting_key}/`. The get-stage response field for each is the
 * camelCase of the CFn name (used by the drift readback).
 */
const METHOD_SETTING_PATCH_FIELDS: ReadonlyArray<{
  cfnKey: keyof CfnStageMethodSetting & string;
  patchSuffix: string;
  responseKey: string;
}> = [
  {
    cfnKey: 'ThrottlingRateLimit',
    patchSuffix: 'throttling/rateLimit',
    responseKey: 'throttlingRateLimit',
  },
  {
    cfnKey: 'ThrottlingBurstLimit',
    patchSuffix: 'throttling/burstLimit',
    responseKey: 'throttlingBurstLimit',
  },
  { cfnKey: 'MetricsEnabled', patchSuffix: 'metrics/enabled', responseKey: 'metricsEnabled' },
  { cfnKey: 'LoggingLevel', patchSuffix: 'logging/loglevel', responseKey: 'loggingLevel' },
  { cfnKey: 'DataTraceEnabled', patchSuffix: 'logging/dataTrace', responseKey: 'dataTraceEnabled' },
  { cfnKey: 'CachingEnabled', patchSuffix: 'caching/enabled', responseKey: 'cachingEnabled' },
  {
    cfnKey: 'CacheTtlInSeconds',
    patchSuffix: 'caching/ttlInSeconds',
    responseKey: 'cacheTtlInSeconds',
  },
  {
    cfnKey: 'CacheDataEncrypted',
    patchSuffix: 'caching/dataEncrypted',
    responseKey: 'cacheDataEncrypted',
  },
  {
    cfnKey: 'RequireAuthorizationForCacheControl',
    patchSuffix: 'caching/requireAuthorizationForCacheControl',
    responseKey: 'requireAuthorizationForCacheControl',
  },
  {
    cfnKey: 'UnauthorizedCacheControlHeaderStrategy',
    patchSuffix: 'caching/unauthorizedCacheControlHeaderStrategy',
    responseKey: 'unauthorizedCacheControlHeaderStrategy',
  },
];

/**
 * The `{method_setting_key}` API Gateway keys a stage's method settings by:
 * `{resource_path}/{http_method}` with the resource path's leading slash
 * stripped — CDK's stage-level `deployOptions` (`ResourcePath: '/*',
 * HttpMethod: '*'`) keys as the star-slash-star wildcard (the get-stage
 * `methodSettings` map key and the UpdateStage patch-path segment are the
 * same string).
 */
function methodSettingKey(setting: CfnStageMethodSetting): string {
  const resourcePath = setting.ResourcePath ?? '/*';
  const httpMethod = setting.HttpMethod ?? '*';
  // The ROOT resource path is the bare `/` (CFn's documented root shape) and
  // API Gateway keys it as `~1` — `~1/GET` in the get-stage map and in the
  // UpdateStage patch path (verified live 2026-07-03). Bare leading-slash
  // stripping would produce the malformed `//GET` patch path.
  const escaped = resourcePath === '/' ? '~1' : resourcePath.replace(/^\//, '');
  return `${escaped}/${httpMethod}`;
}

/**
 * Build the UpdateStage patch operations that take a stage's method settings
 * from `previous` to `next` (both in the CFn `MethodSettings` list shape):
 *   - an entry present only in `next`: `replace` each specified field
 *     (`replace` both adds and changes a method-setting override)
 *   - an entry present in both with NO fields dropped: `replace` only the
 *     changed fields
 *   - an entry present in both with a field DROPPED: `remove /{key}` then
 *     `replace` every remaining specified field — API Gateway REJECTS a
 *     field-level `remove` (`remove <key>/throttling/rateLimit` fails with
 *     "Cannot remove method setting ... because there is no method setting
 *     for this method"), while whole-key remove followed by field replaces
 *     in the SAME UpdateStage call applies sequentially (both verified live
 *     2026-07-03), so the dropped field reverts to its default (CFn
 *     absent-field semantics)
 *   - an entry present only in `previous`: `remove /{key}` — drops every
 *     override for that method path at once (CFn absent-entry semantics)
 * Values are rendered as strings (the UpdateStage wire format).
 */
function buildMethodSettingsPatchOps(
  previous: CfnStageMethodSetting[] | undefined,
  next: CfnStageMethodSetting[] | undefined
): Array<{ op: 'replace' | 'remove'; path: string; value?: string }> {
  const ops: Array<{ op: 'replace' | 'remove'; path: string; value?: string }> = [];
  const prevByKey = new Map((previous ?? []).map((s) => [methodSettingKey(s), s]));
  const nextByKey = new Map((next ?? []).map((s) => [methodSettingKey(s), s]));

  for (const key of prevByKey.keys()) {
    if (!nextByKey.has(key)) {
      ops.push({ op: 'remove', path: `/${key}` });
    }
  }

  for (const [key, setting] of nextByKey) {
    const prevSetting = prevByKey.get(key);
    const fieldDropped =
      prevSetting !== undefined &&
      METHOD_SETTING_PATCH_FIELDS.some(
        ({ cfnKey }) => prevSetting[cfnKey] !== undefined && setting[cfnKey] === undefined
      );
    if (fieldDropped) {
      // Reset-and-rebuild: clear the whole key, then re-apply every field the
      // new entry still specifies (see the JSDoc — leaf removes are rejected).
      ops.push({ op: 'remove', path: `/${key}` });
    }
    for (const { cfnKey, patchSuffix } of METHOD_SETTING_PATCH_FIELDS) {
      const nextValue = setting[cfnKey];
      const prevValue = fieldDropped ? undefined : prevSetting?.[cfnKey];
      if (nextValue !== undefined && String(nextValue) !== String(prevValue ?? '')) {
        ops.push({ op: 'replace', path: `/${key}/${patchSuffix}`, value: String(nextValue) });
      }
    }
  }

  return ops;
}

/**
 * Append RFC 6902 patch operations describing the diff between two map-shaped
 * properties (e.g. API Gateway Method `RequestParameters` /
 * `RequestModels`). For each key:
 *   - present in `next`, absent in `prev`         → `add`     `<basePath>/<key>` `value`
 *   - absent in `next`, present in `prev`         → `remove`  `<basePath>/<key>`
 *   - present in both with different values       → `replace` `<basePath>/<key>` `value`
 *
 * Slashes inside individual keys are escaped per RFC 6901
 * (`/` → `~1`, `~` → `~0`) so paths like
 *   `/requestModels/application~1json` are well-formed JSON Pointers.
 */
function appendMapPatchOps(
  ops: Array<{ op: 'replace' | 'add' | 'remove'; path: string; value?: string }>,
  basePath: string,
  next: Record<string, unknown>,
  prev: Record<string, unknown>
): void {
  const escape = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');

  // add / replace
  for (const [key, val] of Object.entries(next)) {
    const path = `${basePath}/${escape(key)}`;
    const stringValue = String(val);
    if (!(key in prev)) {
      ops.push({ op: 'add', path, value: stringValue });
    } else if (String(prev[key]) !== stringValue) {
      ops.push({ op: 'replace', path, value: stringValue });
    }
  }

  // remove keys present in prev but not in next
  for (const key of Object.keys(prev)) {
    if (!(key in next)) {
      ops.push({ op: 'remove', path: `${basePath}/${escape(key)}` });
    }
  }
}
