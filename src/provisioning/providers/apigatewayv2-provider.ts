import {
  ApiGatewayV2Client,
  CreateApiCommand,
  DeleteApiCommand,
  CreateStageCommand,
  DeleteStageCommand,
  CreateIntegrationCommand,
  DeleteIntegrationCommand,
  CreateRouteCommand,
  DeleteRouteCommand,
  CreateAuthorizerCommand,
  DeleteAuthorizerCommand,
  NotFoundException,
  type ProtocolType,
  type IntegrationType,
  type AuthorizationType,
  type AuthorizerType,
} from '@aws-sdk/client-apigatewayv2';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
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
  private logger = getLogger().child('ApiGatewayV2Provider');

  private getClient(): ApiGatewayV2Client {
    if (!this.client) {
      this.client = new ApiGatewayV2Client({});
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

  // eslint-disable-next-line @typescript-eslint/require-await
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    // HTTP API resources are typically replaced rather than updated in-place.
    // For now, return no-op. The deployment engine handles replacement via
    // immutable property detection when needed.
    this.logger.debug(`Updating ${resourceType} ${logicalId}: ${physicalId} (no-op)`);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {},
    };
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    switch (resourceType) {
      case 'AWS::ApiGatewayV2::Api':
        return this.deleteApi(logicalId, physicalId, resourceType);
      case 'AWS::ApiGatewayV2::Stage':
        return this.deleteStage(logicalId, physicalId, resourceType, properties);
      case 'AWS::ApiGatewayV2::Integration':
        return this.deleteIntegration(logicalId, physicalId, resourceType, properties);
      case 'AWS::ApiGatewayV2::Route':
        return this.deleteRoute(logicalId, physicalId, resourceType, properties);
      case 'AWS::ApiGatewayV2::Authorizer':
        return this.deleteAuthorizer(logicalId, physicalId, resourceType, properties);
      default:
        throw new ProvisioningError(
          `Unsupported resource type: ${resourceType}`,
          resourceType,
          logicalId,
          physicalId
        );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (resourceType) {
      case 'AWS::ApiGatewayV2::Api':
        return this.getApiAttribute(physicalId, attributeName);
      case 'AWS::ApiGatewayV2::Stage':
        return this.getStageAttribute(physicalId, attributeName);
      case 'AWS::ApiGatewayV2::Integration':
        return this.getIntegrationAttribute(physicalId, attributeName);
      case 'AWS::ApiGatewayV2::Route':
        return this.getRouteAttribute(physicalId, attributeName);
      case 'AWS::ApiGatewayV2::Authorizer':
        if (attributeName === 'AuthorizerId') return physicalId;
        return undefined;
      default:
        return undefined;
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
    resourceType: string
  ): Promise<void> {
    this.logger.debug(`Deleting API Gateway V2 Api ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteApiCommand({ ApiId: physicalId }));
      this.logger.debug(`Successfully deleted API Gateway V2 Api ${logicalId}`);
    } catch (error) {
      if (error instanceof NotFoundException) {
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
    properties?: Record<string, unknown>
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
    properties?: Record<string, unknown>
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
    properties?: Record<string, unknown>
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
    properties?: Record<string, unknown>
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
}
