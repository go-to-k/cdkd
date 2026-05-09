import {
  ApiGatewayV2Client,
  CreateApiCommand,
  DeleteApiCommand,
  UpdateApiCommand,
  CreateStageCommand,
  DeleteStageCommand,
  GetStageCommand,
  UpdateStageCommand,
  CreateIntegrationCommand,
  DeleteIntegrationCommand,
  GetIntegrationCommand,
  UpdateIntegrationCommand,
  CreateRouteCommand,
  DeleteRouteCommand,
  GetRouteCommand,
  UpdateRouteCommand,
  CreateAuthorizerCommand,
  DeleteAuthorizerCommand,
  GetAuthorizerCommand,
  UpdateAuthorizerCommand,
  GetApiCommand,
  GetApisCommand,
  NotFoundException,
  type ProtocolType,
  type IntegrationType,
  type AuthorizationType,
  type AuthorizerType,
  type UpdateApiCommandInput,
  type UpdateStageCommandInput,
  type UpdateIntegrationCommandInput,
  type UpdateRouteCommandInput,
  type UpdateAuthorizerCommandInput,
} from '@aws-sdk/client-apigatewayv2';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  CDK_PATH_TAG,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS API Gateway V2 (HTTP API) Provider
 *
 * Implements resource provisioning for:
 * - AWS::ApiGatewayV2::Api (HTTP API)
 * - AWS::ApiGatewayV2::Stage (Stage with auto-deploy)
 * - AWS::ApiGatewayV2::Integration (Lambda/HTTP integration)
 * - AWS::ApiGatewayV2::Route (Route with route key)
 *
 * Uses local lazy init for ApiGatewayV2Client since it's not in aws-clients.ts.
 */
export class ApiGatewayV2Provider implements ResourceProvider {
  private client: ApiGatewayV2Client | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('ApiGatewayV2Provider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ApiGatewayV2::Api',
      new Set(['Name', 'ProtocolType', 'Description', 'CorsConfiguration', 'Tags']),
    ],
    [
      'AWS::ApiGatewayV2::Stage',
      new Set(['ApiId', 'StageName', 'AutoDeploy', 'Description', 'Tags']),
    ],
    [
      'AWS::ApiGatewayV2::Integration',
      new Set([
        'ApiId',
        'IntegrationType',
        'IntegrationUri',
        'IntegrationMethod',
        'PayloadFormatVersion',
      ]),
    ],
    [
      'AWS::ApiGatewayV2::Route',
      new Set(['ApiId', 'RouteKey', 'Target', 'AuthorizationType', 'AuthorizerId']),
    ],
    [
      'AWS::ApiGatewayV2::Authorizer',
      new Set([
        'ApiId',
        'AuthorizerType',
        'Name',
        'IdentitySource',
        'JwtConfiguration',
        'AuthorizerUri',
        'AuthorizerPayloadFormatVersion',
      ]),
    ],
  ]);

  private getClient(): ApiGatewayV2Client {
    if (!this.client) {
      this.client = new ApiGatewayV2Client(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.client;
  }

  // ─── Dispatch ─────────────────────────────────────────────────────

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    switch (resourceType) {
      case 'AWS::ApiGatewayV2::Api':
        return this.createApi(logicalId, resourceType, properties);
      case 'AWS::ApiGatewayV2::Stage':
        return this.createStage(logicalId, resourceType, properties);
      case 'AWS::ApiGatewayV2::Integration':
        return this.createIntegration(logicalId, resourceType, properties);
      case 'AWS::ApiGatewayV2::Route':
        return this.createRoute(logicalId, resourceType, properties);
      case 'AWS::ApiGatewayV2::Authorizer':
        return this.createAuthorizer(logicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId
        );
    }
  }

  /**
   * AWS API Gateway V2 supports in-place updates for every type cdkd
   * provisions via the matching `Update*Command`. Each command takes the
   * full Update input shape (NOT JSON Patch — that's the v1 surface);
   * cdkd builds the input by selecting only the fields that differ
   * between `previousProperties` and `properties`, so unchanged fields
   * are not echoed back. The few immutable identifiers (`ProtocolType`
   * on Api; `StageName` on Stage) are not part of the Update input shape
   * and are handled by the deploy engine's immutable-property
   * replacement path.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    switch (resourceType) {
      case 'AWS::ApiGatewayV2::Api':
        return this.updateApi(logicalId, physicalId, resourceType, properties, previousProperties);
      case 'AWS::ApiGatewayV2::Stage':
        return this.updateStage(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::ApiGatewayV2::Integration':
        return this.updateIntegration(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::ApiGatewayV2::Route':
        return this.updateRoute(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      case 'AWS::ApiGatewayV2::Authorizer':
        return this.updateAuthorizer(
          logicalId,
          physicalId,
          resourceType,
          properties,
          previousProperties
        );
      default:
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          'unsupported API Gateway V2 resource type for in-place update; re-deploy with cdkd deploy --replace, or destroy + redeploy the stack'
        );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ApiGatewayV2::Api':
        return this.deleteApi(logicalId, physicalId, resourceType, context);
      case 'AWS::ApiGatewayV2::Stage':
        return this.deleteStage(logicalId, physicalId, resourceType, properties, context);
      case 'AWS::ApiGatewayV2::Integration':
        return this.deleteIntegration(logicalId, physicalId, resourceType, properties, context);
      case 'AWS::ApiGatewayV2::Route':
        return this.deleteRoute(logicalId, physicalId, resourceType, properties, context);
      case 'AWS::ApiGatewayV2::Authorizer':
        return this.deleteAuthorizer(logicalId, physicalId, resourceType, properties, context);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown> {
    switch (resourceType) {
      case 'AWS::ApiGatewayV2::Api':
        return Promise.resolve(this.getApiAttribute(physicalId, attributeName));
      case 'AWS::ApiGatewayV2::Stage':
        return Promise.resolve(this.getStageAttribute(physicalId, attributeName));
      case 'AWS::ApiGatewayV2::Integration':
        return Promise.resolve(this.getIntegrationAttribute(physicalId, attributeName));
      case 'AWS::ApiGatewayV2::Route':
        return Promise.resolve(this.getRouteAttribute(physicalId, attributeName));
      case 'AWS::ApiGatewayV2::Authorizer':
        if (attributeName === 'AuthorizerId') return Promise.resolve(physicalId);
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  }

  // ─── AWS::ApiGatewayV2::Api ───────────────────────────────────────

  private async createApi(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway V2 Api ${logicalId}`);

    const name = properties['Name'] as string;
    const protocolType = properties['ProtocolType'] as string;

    if (!name || !protocolType) {
      throw new ProvisioningError(
        `Name and ProtocolType are required for API Gateway V2 Api ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.getClient().send(
        new CreateApiCommand({
          Name: name,
          ProtocolType: protocolType as ProtocolType,
          Description: properties['Description'] as string | undefined,
          CorsConfiguration: properties['CorsConfiguration'] as
            | {
                AllowCredentials?: boolean;
                AllowHeaders?: string[];
                AllowMethods?: string[];
                AllowOrigins?: string[];
                ExposeHeaders?: string[];
                MaxAge?: number;
              }
            | undefined,
          Tags: this.cfnTagsToRecord(properties['Tags']),
        })
      );

      const apiId = response.ApiId!;
      const apiEndpoint = response.ApiEndpoint!;
      this.logger.debug(`Successfully created API Gateway V2 Api ${logicalId}: ${apiId}`);

      return {
        physicalId: apiId,
        attributes: {
          ApiId: apiId,
          ApiEndpoint: apiEndpoint,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create API Gateway V2 Api ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteApi(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway V2 Api ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteApiCommand({ ApiId: physicalId }));
      this.logger.debug(`Successfully deleted API Gateway V2 Api ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`API Gateway V2 Api ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway V2 Api ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private getApiAttribute(physicalId: string, attributeName: string): unknown {
    if (attributeName === 'ApiId') return physicalId;
    // ApiEndpoint is stored in attributes at creation time
    return undefined;
  }

  // ─── AWS::ApiGatewayV2::Stage ─────────────────────────────────────

  private async createStage(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway V2 Stage ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    const stageName = properties['StageName'] as string;

    if (!apiId || !stageName) {
      throw new ProvisioningError(
        `ApiId and StageName are required for API Gateway V2 Stage ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      await this.getClient().send(
        new CreateStageCommand({
          ApiId: apiId,
          StageName: stageName,
          AutoDeploy: properties['AutoDeploy'] as boolean | undefined,
          Description: properties['Description'] as string | undefined,
          Tags: this.cfnTagsToRecord(properties['Tags']),
        })
      );

      this.logger.debug(`Successfully created API Gateway V2 Stage ${logicalId}: ${stageName}`);

      return {
        physicalId: stageName,
        attributes: {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create API Gateway V2 Stage ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteStage(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway V2 Stage ${logicalId}: ${physicalId}`);

    const apiId = properties?.['ApiId'] as string | undefined;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required to delete Stage ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.getClient().send(new DeleteStageCommand({ ApiId: apiId, StageName: physicalId }));
      this.logger.debug(`Successfully deleted API Gateway V2 Stage ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`API Gateway V2 Stage ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway V2 Stage ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private getStageAttribute(physicalId: string, attributeName: string): unknown {
    if (attributeName === 'StageName') return physicalId;
    return undefined;
  }

  // ─── AWS::ApiGatewayV2::Integration ───────────────────────────────

  private async createIntegration(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway V2 Integration ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    const integrationType = properties['IntegrationType'] as string;

    if (!apiId || !integrationType) {
      throw new ProvisioningError(
        `ApiId and IntegrationType are required for API Gateway V2 Integration ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.getClient().send(
        new CreateIntegrationCommand({
          ApiId: apiId,
          IntegrationType: integrationType as IntegrationType,
          IntegrationUri: properties['IntegrationUri'] as string | undefined,
          IntegrationMethod: properties['IntegrationMethod'] as string | undefined,
          PayloadFormatVersion: properties['PayloadFormatVersion'] as string | undefined,
        })
      );

      const integrationId = response.IntegrationId!;
      this.logger.debug(
        `Successfully created API Gateway V2 Integration ${logicalId}: ${integrationId}`
      );

      return {
        physicalId: integrationId,
        attributes: {
          IntegrationId: integrationId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create API Gateway V2 Integration ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteIntegration(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway V2 Integration ${logicalId}: ${physicalId}`);

    const apiId = properties?.['ApiId'] as string | undefined;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required to delete Integration ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.getClient().send(
        new DeleteIntegrationCommand({ ApiId: apiId, IntegrationId: physicalId })
      );
      this.logger.debug(`Successfully deleted API Gateway V2 Integration ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `API Gateway V2 Integration ${physicalId} does not exist, skipping deletion`
        );
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway V2 Integration ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private getIntegrationAttribute(physicalId: string, attributeName: string): unknown {
    if (attributeName === 'IntegrationId') return physicalId;
    return undefined;
  }

  // ─── AWS::ApiGatewayV2::Route ─────────────────────────────────────

  private async createRoute(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway V2 Route ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    const routeKey = properties['RouteKey'] as string;

    if (!apiId || !routeKey) {
      throw new ProvisioningError(
        `ApiId and RouteKey are required for API Gateway V2 Route ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.getClient().send(
        new CreateRouteCommand({
          ApiId: apiId,
          RouteKey: routeKey,
          Target: properties['Target'] as string | undefined,
          AuthorizationType: properties['AuthorizationType'] as AuthorizationType | undefined,
          AuthorizerId: properties['AuthorizerId'] as string | undefined,
        })
      );

      const routeId = response.RouteId!;
      this.logger.debug(`Successfully created API Gateway V2 Route ${logicalId}: ${routeId}`);

      return {
        physicalId: routeId,
        attributes: {
          RouteId: routeId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create API Gateway V2 Route ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteRoute(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway V2 Route ${logicalId}: ${physicalId}`);

    const apiId = properties?.['ApiId'] as string | undefined;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required to delete Route ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.getClient().send(new DeleteRouteCommand({ ApiId: apiId, RouteId: physicalId }));
      this.logger.debug(`Successfully deleted API Gateway V2 Route ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`API Gateway V2 Route ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway V2 Route ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  private getRouteAttribute(physicalId: string, attributeName: string): unknown {
    if (attributeName === 'RouteId') return physicalId;
    return undefined;
  }

  // ─── AWS::ApiGatewayV2::Authorizer ────────────────────────────────

  private async createAuthorizer(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating API Gateway V2 Authorizer ${logicalId}`);

    const apiId = properties['ApiId'] as string;
    const authorizerType = properties['AuthorizerType'] as string;
    const name = (properties['Name'] as string) || logicalId;

    if (!apiId || !authorizerType) {
      throw new ProvisioningError(
        `ApiId and AuthorizerType are required for API Gateway V2 Authorizer ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const response = await this.getClient().send(
        new CreateAuthorizerCommand({
          ApiId: apiId,
          AuthorizerType: authorizerType as AuthorizerType,
          Name: name,
          IdentitySource: (properties['IdentitySource'] as string | string[] | undefined)
            ? typeof properties['IdentitySource'] === 'string'
              ? [properties['IdentitySource']]
              : (properties['IdentitySource'] as string[])
            : undefined,
          JwtConfiguration: properties['JwtConfiguration'] as
            | { Audience?: string[]; Issuer?: string }
            | undefined,
          AuthorizerUri: properties['AuthorizerUri'] as string | undefined,
          AuthorizerPayloadFormatVersion: properties['AuthorizerPayloadFormatVersion'] as
            | string
            | undefined,
        })
      );

      const authorizerId = response.AuthorizerId!;
      this.logger.debug(
        `Successfully created API Gateway V2 Authorizer ${logicalId}: ${authorizerId}`
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
        `Failed to create API Gateway V2 Authorizer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  private async deleteAuthorizer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway V2 Authorizer ${logicalId}: ${physicalId}`);

    const apiId = properties?.['ApiId'] as string | undefined;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required to delete Authorizer ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      await this.getClient().send(
        new DeleteAuthorizerCommand({ ApiId: apiId, AuthorizerId: physicalId })
      );
      this.logger.debug(`Successfully deleted API Gateway V2 Authorizer ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `API Gateway V2 Authorizer ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete API Gateway V2 Authorizer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Drift detection ──────────────────────────────────────────────

  /**
   * Read the AWS-current API Gateway V2 resource configuration in
   * CFn-property shape.
   *
   * **Coverage**:
   *   - `AWS::ApiGatewayV2::Api` → `GetApi`. PhysicalId is the apiId,
   *     self-sufficient.
   *   - `AWS::ApiGatewayV2::Stage` / `Integration` / `Route` / `Authorizer`:
   *     each uses `properties.ApiId` (passed through PR G's signature
   *     extension) to issue the appropriate `Get*` call.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    switch (resourceType) {
      case 'AWS::ApiGatewayV2::Api':
        return this.readApi(physicalId);
      case 'AWS::ApiGatewayV2::Stage':
        return this.readStage(physicalId, properties);
      case 'AWS::ApiGatewayV2::Integration':
        return this.readIntegration(physicalId, properties);
      case 'AWS::ApiGatewayV2::Route':
        return this.readRoute(physicalId, properties);
      case 'AWS::ApiGatewayV2::Authorizer':
        return this.readAuthorizer(physicalId, properties);
      default:
        return undefined;
    }
  }

  private async readApi(physicalId: string): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.getClient().send(new GetApiCommand({ ApiId: physicalId }));
      const result: Record<string, unknown> = {};
      result['Name'] = resp.Name ?? '';
      if (resp.ProtocolType !== undefined) result['ProtocolType'] = resp.ProtocolType;
      result['Description'] = resp.Description ?? '';

      // Class 1 — CorsConfiguration is HTTP-only. Emitting `{}` as a
      // placeholder on a WEBSOCKET API would have `cdkd drift --revert`
      // push the empty value back to AWS, which `UpdateApi` rejects with
      // "CORS configuration is only supported for HTTP APIs".
      // Same pattern as the SNS FifoThroughputScope guard.
      if (resp.ProtocolType === 'HTTP') {
        result['CorsConfiguration'] = resp.CorsConfiguration ?? {};
      }

      // Class 1 — RouteSelectionExpression is required (and meaningful)
      // only for WEBSOCKET. HTTP APIs default it to `$request.method
      // $request.path` server-side and the field is not user-controlled,
      // so emitting it on HTTP APIs would surface AWS-managed defaults
      // as drift.
      if (resp.ProtocolType === 'WEBSOCKET' && resp.RouteSelectionExpression !== undefined) {
        result['RouteSelectionExpression'] = resp.RouteSelectionExpression;
      }

      // Tags from the same GetApi response (returned as a tag-name → value map).
      const tags = normalizeAwsTagsToCfn(resp.Tags);
      result['Tags'] = tags;
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  private async readStage(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const apiId = properties?.['ApiId'] as string | undefined;
    if (!apiId) return undefined;

    try {
      const resp = await this.getClient().send(
        new GetStageCommand({ ApiId: apiId, StageName: physicalId })
      );
      const result: Record<string, unknown> = { ApiId: apiId };
      if (resp.StageName !== undefined) result['StageName'] = resp.StageName;
      result['AutoDeploy'] = resp.AutoDeploy ?? false;
      result['Description'] = resp.Description ?? '';
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  private async readIntegration(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const apiId = properties?.['ApiId'] as string | undefined;
    if (!apiId) return undefined;

    try {
      const resp = await this.getClient().send(
        new GetIntegrationCommand({ ApiId: apiId, IntegrationId: physicalId })
      );
      const result: Record<string, unknown> = { ApiId: apiId };
      if (resp.IntegrationType !== undefined) result['IntegrationType'] = resp.IntegrationType;

      // Class 1 — IntegrationUri is meaningless on MOCK integrations.
      // AWS rejects an empty-string placeholder on MOCK with "Integration
      // URI is not supported for MOCK integrations". Only emit when the
      // discriminator (IntegrationType) requires a URI.
      const uriRequired =
        resp.IntegrationType === 'AWS' ||
        resp.IntegrationType === 'AWS_PROXY' ||
        resp.IntegrationType === 'HTTP' ||
        resp.IntegrationType === 'HTTP_PROXY';
      if (uriRequired) {
        result['IntegrationUri'] = resp.IntegrationUri ?? '';
      }

      result['IntegrationMethod'] = resp.IntegrationMethod ?? '';
      result['PayloadFormatVersion'] = resp.PayloadFormatVersion ?? '';
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  private async readRoute(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const apiId = properties?.['ApiId'] as string | undefined;
    if (!apiId) return undefined;

    try {
      const resp = await this.getClient().send(
        new GetRouteCommand({ ApiId: apiId, RouteId: physicalId })
      );
      const result: Record<string, unknown> = { ApiId: apiId };
      if (resp.RouteKey !== undefined) result['RouteKey'] = resp.RouteKey;
      result['Target'] = resp.Target ?? '';

      // Class 2 — AuthorizationType empty placeholder. AWS uses `'NONE'`
      // (not `''`) as the no-auth sentinel; emitting `''` would have
      // `cdkd drift --revert` push an AWS-rejected value back. Map the
      // missing case to `'NONE'`, matching the AWS-documented default.
      result['AuthorizationType'] = resp.AuthorizationType ?? 'NONE';

      // Class 1 — AuthorizerId and AuthorizationScopes are meaningful
      // only when AuthorizationType is not NONE. Emitting empty
      // placeholders on a no-auth route would push AWS-rejected values
      // back through `--revert`.
      if (resp.AuthorizationType && resp.AuthorizationType !== 'NONE') {
        result['AuthorizerId'] = resp.AuthorizerId ?? '';
        result['AuthorizationScopes'] = resp.AuthorizationScopes
          ? [...resp.AuthorizationScopes]
          : [];
      }
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  private async readAuthorizer(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const apiId = properties?.['ApiId'] as string | undefined;
    if (!apiId) return undefined;

    try {
      const resp = await this.getClient().send(
        new GetAuthorizerCommand({ ApiId: apiId, AuthorizerId: physicalId })
      );
      const result: Record<string, unknown> = { ApiId: apiId };
      if (resp.AuthorizerType !== undefined) result['AuthorizerType'] = resp.AuthorizerType;
      result['Name'] = resp.Name ?? '';
      result['IdentitySource'] = resp.IdentitySource ? [...resp.IdentitySource] : [];

      // Class 1 — JwtConfiguration / AuthorizerUri / AuthorizerPayloadFormatVersion
      // are AuthorizerType-discriminated. JwtConfiguration is JWT-only;
      // AuthorizerUri / AuthorizerPayloadFormatVersion are REQUEST-only.
      // Emitting placeholders on the wrong type would have
      // `cdkd drift --revert` push AWS-rejected values back through
      // `UpdateAuthorizer` ("JwtConfiguration is only valid for JWT
      // authorizers" / "AuthorizerUri is only valid for REQUEST
      // authorizers"). Same pattern as the SNS FifoThroughputScope
      // guard.
      if (resp.AuthorizerType === 'JWT') {
        result['JwtConfiguration'] = resp.JwtConfiguration ?? {};
      } else if (resp.AuthorizerType === 'REQUEST') {
        result['AuthorizerUri'] = resp.AuthorizerUri ?? '';
        result['AuthorizerPayloadFormatVersion'] = resp.AuthorizerPayloadFormatVersion ?? '';
      }
      return result;
    } catch (err) {
      if (err instanceof NotFoundException) return undefined;
      throw err;
    }
  }

  // ─── Import ───────────────────────────────────────────────────────

  /**
   * Adopt an existing API Gateway V2 resource into cdkd state.
   *
   * `AWS::ApiGatewayV2::Api` supports full tag-based auto-lookup via
   * `GetApis` (`Tags` is a `Record<string,string>` map on each item).
   *
   * Sub-resources (`Stage`, `Integration`, `Route`, `Authorizer`) are
   * scoped under a parent `ApiId`, and their physical ids are not
   * globally unique — auto-lookup would need to walk every Api in the
   * account and every sub-resource within. Explicit-override only;
   * users adopt an existing HTTP API by passing
   * `--resource <logicalId>=<physicalId>` for each sub-resource.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.resourceType !== 'AWS::ApiGatewayV2::Api') {
      // Sub-resources: explicit override only.
      if (input.knownPhysicalId) {
        return { physicalId: input.knownPhysicalId, attributes: {} };
      }
      return null;
    }

    const explicit = resolveExplicitPhysicalId(input, null);
    if (explicit) {
      try {
        await this.getClient().send(new GetApiCommand({ ApiId: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof NotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new GetApisCommand({ ...(nextToken && { NextToken: nextToken }) })
      );
      for (const api of list.Items ?? []) {
        if (!api.ApiId) continue;
        if (api.Tags?.[CDK_PATH_TAG] === input.cdkPath) {
          return { physicalId: api.ApiId, attributes: {} };
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }

  // ─── Update implementations ───────────────────────────────────────

  /**
   * `UpdateApi` accepts the full Update input shape (not JSON Patch).
   * Mutable fields cdkd manages: `Name` / `Description` /
   * `CorsConfiguration`. `ProtocolType` is immutable — the deploy
   * engine handles changes via the replacement path; we surface a
   * `ResourceUpdateNotSupportedError` if it ever reaches us anyway.
   */
  private async updateApi(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    if (
      properties['ProtocolType'] !== undefined &&
      previousProperties['ProtocolType'] !== undefined &&
      properties['ProtocolType'] !== previousProperties['ProtocolType']
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'ProtocolType is immutable on AWS::ApiGatewayV2::Api; re-deploy with cdkd deploy --replace'
      );
    }

    const input: UpdateApiCommandInput = { ApiId: physicalId };
    let changed = false;

    if (properties['Name'] !== undefined && properties['Name'] !== previousProperties['Name']) {
      input.Name = properties['Name'] as string;
      changed = true;
    }
    if (
      properties['Description'] !== undefined &&
      properties['Description'] !== previousProperties['Description']
    ) {
      input.Description = properties['Description'] as string;
      changed = true;
    }
    if (
      properties['CorsConfiguration'] !== undefined &&
      !this.deepEqual(properties['CorsConfiguration'], previousProperties['CorsConfiguration'])
    ) {
      input.CorsConfiguration = properties[
        'CorsConfiguration'
      ] as UpdateApiCommandInput['CorsConfiguration'];
      changed = true;
    }

    if (!changed) {
      this.logger.debug(`No mutable Api fields changed for ${logicalId}; skipping UpdateApi`);
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating API Gateway V2 Api ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new UpdateApiCommand(input));
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update API Gateway V2 Api ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * `UpdateStage` keys on `(ApiId, StageName)` — `StageName` is the
   * physicalId and immutable. Mutable fields cdkd manages:
   * `AutoDeploy` / `Description`. `ApiId` is also immutable (a stage
   * cannot be moved between APIs).
   */
  private async updateStage(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    const apiId = (properties['ApiId'] ?? previousProperties['ApiId']) as string | undefined;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required to update Stage ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (
      properties['ApiId'] !== undefined &&
      previousProperties['ApiId'] !== undefined &&
      properties['ApiId'] !== previousProperties['ApiId']
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'ApiId is immutable on AWS::ApiGatewayV2::Stage; re-deploy with cdkd deploy --replace'
      );
    }
    if (
      properties['StageName'] !== undefined &&
      previousProperties['StageName'] !== undefined &&
      properties['StageName'] !== previousProperties['StageName']
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'StageName is immutable on AWS::ApiGatewayV2::Stage; re-deploy with cdkd deploy --replace'
      );
    }

    const input: UpdateStageCommandInput = { ApiId: apiId, StageName: physicalId };
    let changed = false;

    if (
      properties['AutoDeploy'] !== undefined &&
      properties['AutoDeploy'] !== previousProperties['AutoDeploy']
    ) {
      input.AutoDeploy = properties['AutoDeploy'] as boolean;
      changed = true;
    }
    if (
      properties['Description'] !== undefined &&
      properties['Description'] !== previousProperties['Description']
    ) {
      input.Description = properties['Description'] as string;
      changed = true;
    }

    if (!changed) {
      this.logger.debug(`No mutable Stage fields changed for ${logicalId}; skipping UpdateStage`);
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating API Gateway V2 Stage ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new UpdateStageCommand(input));
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update API Gateway V2 Stage ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * `UpdateIntegration` keys on `(ApiId, IntegrationId)`. Mutable
   * fields cdkd manages: `IntegrationType` / `IntegrationUri` /
   * `IntegrationMethod` / `PayloadFormatVersion`.
   */
  private async updateIntegration(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    const apiId = (properties['ApiId'] ?? previousProperties['ApiId']) as string | undefined;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required to update Integration ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (
      properties['ApiId'] !== undefined &&
      previousProperties['ApiId'] !== undefined &&
      properties['ApiId'] !== previousProperties['ApiId']
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'ApiId is immutable on AWS::ApiGatewayV2::Integration; re-deploy with cdkd deploy --replace'
      );
    }

    const input: UpdateIntegrationCommandInput = { ApiId: apiId, IntegrationId: physicalId };
    let changed = false;

    if (
      properties['IntegrationType'] !== undefined &&
      properties['IntegrationType'] !== previousProperties['IntegrationType']
    ) {
      input.IntegrationType = properties['IntegrationType'] as IntegrationType;
      changed = true;
    }
    if (
      properties['IntegrationUri'] !== undefined &&
      properties['IntegrationUri'] !== previousProperties['IntegrationUri']
    ) {
      input.IntegrationUri = properties['IntegrationUri'] as string;
      changed = true;
    }
    if (
      properties['IntegrationMethod'] !== undefined &&
      properties['IntegrationMethod'] !== previousProperties['IntegrationMethod']
    ) {
      input.IntegrationMethod = properties['IntegrationMethod'] as string;
      changed = true;
    }
    if (
      properties['PayloadFormatVersion'] !== undefined &&
      properties['PayloadFormatVersion'] !== previousProperties['PayloadFormatVersion']
    ) {
      input.PayloadFormatVersion = properties['PayloadFormatVersion'] as string;
      changed = true;
    }

    if (!changed) {
      this.logger.debug(
        `No mutable Integration fields changed for ${logicalId}; skipping UpdateIntegration`
      );
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating API Gateway V2 Integration ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new UpdateIntegrationCommand(input));
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update API Gateway V2 Integration ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * `UpdateRoute` keys on `(ApiId, RouteId)`. Mutable fields cdkd
   * manages: `RouteKey` / `Target` / `AuthorizationType` /
   * `AuthorizerId` / `AuthorizationScopes`.
   */
  private async updateRoute(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    const apiId = (properties['ApiId'] ?? previousProperties['ApiId']) as string | undefined;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required to update Route ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (
      properties['ApiId'] !== undefined &&
      previousProperties['ApiId'] !== undefined &&
      properties['ApiId'] !== previousProperties['ApiId']
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'ApiId is immutable on AWS::ApiGatewayV2::Route; re-deploy with cdkd deploy --replace'
      );
    }

    const input: UpdateRouteCommandInput = { ApiId: apiId, RouteId: physicalId };
    let changed = false;

    if (
      properties['RouteKey'] !== undefined &&
      properties['RouteKey'] !== previousProperties['RouteKey']
    ) {
      input.RouteKey = properties['RouteKey'] as string;
      changed = true;
    }
    if (
      properties['Target'] !== undefined &&
      properties['Target'] !== previousProperties['Target']
    ) {
      input.Target = properties['Target'] as string;
      changed = true;
    }
    if (
      properties['AuthorizationType'] !== undefined &&
      properties['AuthorizationType'] !== previousProperties['AuthorizationType']
    ) {
      input.AuthorizationType = properties['AuthorizationType'] as AuthorizationType;
      changed = true;
    }
    if (
      properties['AuthorizerId'] !== undefined &&
      properties['AuthorizerId'] !== previousProperties['AuthorizerId']
    ) {
      input.AuthorizerId = properties['AuthorizerId'] as string;
      changed = true;
    }
    if (
      properties['AuthorizationScopes'] !== undefined &&
      !this.deepEqual(properties['AuthorizationScopes'], previousProperties['AuthorizationScopes'])
    ) {
      input.AuthorizationScopes = properties['AuthorizationScopes'] as string[];
      changed = true;
    }

    if (!changed) {
      this.logger.debug(`No mutable Route fields changed for ${logicalId}; skipping UpdateRoute`);
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating API Gateway V2 Route ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new UpdateRouteCommand(input));
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update API Gateway V2 Route ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * `UpdateAuthorizer` keys on `(ApiId, AuthorizerId)`. Mutable fields
   * cdkd manages: `AuthorizerType` / `Name` / `IdentitySource` /
   * `JwtConfiguration` / `AuthorizerUri` /
   * `AuthorizerPayloadFormatVersion`.
   */
  private async updateAuthorizer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    const apiId = (properties['ApiId'] ?? previousProperties['ApiId']) as string | undefined;
    if (!apiId) {
      throw new ProvisioningError(
        `ApiId is required to update Authorizer ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (
      properties['ApiId'] !== undefined &&
      previousProperties['ApiId'] !== undefined &&
      properties['ApiId'] !== previousProperties['ApiId']
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        'ApiId is immutable on AWS::ApiGatewayV2::Authorizer; re-deploy with cdkd deploy --replace'
      );
    }

    const input: UpdateAuthorizerCommandInput = { ApiId: apiId, AuthorizerId: physicalId };
    let changed = false;

    if (
      properties['AuthorizerType'] !== undefined &&
      properties['AuthorizerType'] !== previousProperties['AuthorizerType']
    ) {
      input.AuthorizerType = properties['AuthorizerType'] as AuthorizerType;
      changed = true;
    }
    if (properties['Name'] !== undefined && properties['Name'] !== previousProperties['Name']) {
      input.Name = properties['Name'] as string;
      changed = true;
    }
    if (properties['IdentitySource'] !== undefined) {
      const next = Array.isArray(properties['IdentitySource'])
        ? (properties['IdentitySource'] as string[])
        : [properties['IdentitySource'] as string];
      const prev = Array.isArray(previousProperties['IdentitySource'])
        ? (previousProperties['IdentitySource'] as string[])
        : previousProperties['IdentitySource'] !== undefined
          ? [previousProperties['IdentitySource'] as string]
          : undefined;
      if (!this.deepEqual(next, prev)) {
        input.IdentitySource = next;
        changed = true;
      }
    }
    if (
      properties['JwtConfiguration'] !== undefined &&
      !this.deepEqual(properties['JwtConfiguration'], previousProperties['JwtConfiguration'])
    ) {
      input.JwtConfiguration = properties[
        'JwtConfiguration'
      ] as UpdateAuthorizerCommandInput['JwtConfiguration'];
      changed = true;
    }
    if (
      properties['AuthorizerUri'] !== undefined &&
      properties['AuthorizerUri'] !== previousProperties['AuthorizerUri']
    ) {
      input.AuthorizerUri = properties['AuthorizerUri'] as string;
      changed = true;
    }
    if (
      properties['AuthorizerPayloadFormatVersion'] !== undefined &&
      properties['AuthorizerPayloadFormatVersion'] !==
        previousProperties['AuthorizerPayloadFormatVersion']
    ) {
      input.AuthorizerPayloadFormatVersion = properties['AuthorizerPayloadFormatVersion'] as string;
      changed = true;
    }

    if (!changed) {
      this.logger.debug(
        `No mutable Authorizer fields changed for ${logicalId}; skipping UpdateAuthorizer`
      );
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating API Gateway V2 Authorizer ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new UpdateAuthorizerCommand(input));
      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update API Gateway V2 Authorizer ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Convert CloudFormation Tags (Array<{Key, Value}>) to SDK Tags (Record<string, string>).
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
   * Structural equality used to skip Update calls when an object /
   * array property is unchanged. Stable JSON serialization is fine
   * here because the API Gateway V2 sub-shapes (`CorsConfiguration`,
   * `JwtConfiguration`, scope arrays, identity-source arrays) are
   * small primitive maps with no key-order semantics on the AWS side.
   */
  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
}
