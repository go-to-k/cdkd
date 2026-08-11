import {
  ApiGatewayV2Client,
  CreateApiCommand,
  DeleteApiCommand,
  UpdateApiCommand,
  DeleteCorsConfigurationCommand,
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
  DeleteAccessLogSettingsCommand,
  DeleteRouteSettingsCommand,
  DeleteRouteRequestParameterCommand,
  GetAuthorizerCommand,
  UpdateAuthorizerCommand,
  GetApiCommand,
  NotFoundException,
  type ProtocolType,
  type IpAddressType,
  type IntegrationType,
  type ConnectionType,
  type ContentHandlingStrategy,
  type PassthroughBehavior,
  type TlsConfigInput,
  type AuthorizationType,
  type AuthorizerType,
  type AccessLogSettings,
  type ParameterConstraints,
  type RouteSettings,
  type UpdateApiCommandInput,
  type UpdateStageCommandInput,
  type UpdateIntegrationCommandInput,
  type UpdateRouteCommandInput,
  type UpdateAuthorizerCommandInput,
} from '@aws-sdk/client-apigatewayv2';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
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
      new Set([
        'Name',
        'ProtocolType',
        'Description',
        'CorsConfiguration',
        'Tags',
        'DisableExecuteApiEndpoint',
        'Version',
        'RouteSelectionExpression',
        'ApiKeySelectionExpression',
        'IpAddressType',
      ]),
    ],
    [
      'AWS::ApiGatewayV2::Stage',
      new Set([
        'ApiId',
        'StageName',
        'AutoDeploy',
        'Description',
        'Tags',
        'StageVariables',
        'DefaultRouteSettings',
        'AccessLogSettings',
        'ClientCertificateId',
        'DeploymentId',
        'RouteSettings',
      ]),
    ],
    [
      'AWS::ApiGatewayV2::Integration',
      new Set([
        'ApiId',
        'IntegrationType',
        'IntegrationUri',
        'IntegrationMethod',
        'PayloadFormatVersion',
        'TimeoutInMillis',
        'RequestParameters',
        'Description',
        'ConnectionId',
        'ConnectionType',
        'ContentHandlingStrategy',
        'CredentialsArn',
        'IntegrationSubtype',
        'PassthroughBehavior',
        'RequestTemplates',
        'ResponseParameters',
        'TemplateSelectionExpression',
        'TlsConfig',
      ]),
    ],
    [
      'AWS::ApiGatewayV2::Route',
      new Set([
        'ApiId',
        'RouteKey',
        'Target',
        'AuthorizationType',
        'AuthorizerId',
        'AuthorizationScopes',
        'OperationName',
        'ApiKeyRequired',
        'ModelSelectionExpression',
        'RequestModels',
        'RequestParameters',
        'RouteResponseSelectionExpression',
      ]),
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
        'AuthorizerCredentialsArn',
        'AuthorizerPayloadFormatVersion',
        'AuthorizerResultTtlInSeconds',
        'EnableSimpleResponses',
        'IdentityValidationExpression',
      ]),
    ],
  ]);

  /**
   * Properties this provider deliberately does NOT wire through to the SDK
   * call, with a one-line rationale per entry. Consumed by the development-
   * time coverage check (`tests/unit/provisioning/property-coverage.test.ts`,
   * issue #391) — see `ResourceProvider.unhandledByDesign` doc.
   *
   * The five OpenAPI-import fields on `AWS::ApiGatewayV2::Api` trigger an
   * entirely separate `ImportApi` AWS API code path (inline OpenAPI spec or
   * S3-hosted), not the field-by-field `CreateApi` cdkd already supports.
   * Wiring them would require parsing OpenAPI semantics + a different
   * mutation surface and is out of scope for the SDK-Provider safety net.
   */
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::ApiGatewayV2::Api',
      new Map([
        [
          'Body',
          'OpenAPI/Swagger inline spec; routed through ImportApi, not the field-by-field CreateApi path.',
        ],
        [
          'BodyS3Location',
          'OpenAPI/Swagger spec on S3; routed through ImportApi, not the field-by-field CreateApi path.',
        ],
        ['FailOnWarnings', 'OpenAPI-import-only flag; meaningful only on the ImportApi code path.'],
        [
          'DisableSchemaValidation',
          'Schema-validation toggle on CreateApi/UpdateApi that AWS docs scope to WebSocket APIs using AWS::ApiGatewayV2::Model — that resource type is not yet registered in cdkd, so the toggle has no effect to wire.',
        ],
        [
          'BasePath',
          'OpenAPI-import-only basePath override; meaningful only on the ImportApi code path.',
        ],
        [
          'RouteKey',
          'Quick-create shortcut: CreateApi inline-creates a default route+integration from RouteKey/Target/CredentialsArn. cdkd models routes/integrations as explicit AWS::ApiGatewayV2::Route/::Integration resources, so this convenience field is not wired.',
        ],
        [
          'Target',
          'Quick-create shortcut (paired with RouteKey/CredentialsArn); cdkd models the integration as an explicit AWS::ApiGatewayV2::Integration resource instead.',
        ],
        [
          'CredentialsArn',
          'Quick-create shortcut (paired with RouteKey/Target); cdkd models the integration as an explicit AWS::ApiGatewayV2::Integration resource instead.',
        ],
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
          'Unsupported API Gateway V2 resource type for in-place update in cdkd; re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.'
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
          DisableExecuteApiEndpoint: properties['DisableExecuteApiEndpoint'] as boolean | undefined,
          Version: properties['Version'] as string | undefined,
          RouteSelectionExpression: properties['RouteSelectionExpression'] as string | undefined,
          ApiKeySelectionExpression: properties['ApiKeySelectionExpression'] as string | undefined,
          IpAddressType: properties['IpAddressType'] as IpAddressType | undefined,
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
          StageVariables: properties['StageVariables'] as Record<string, string> | undefined,
          DefaultRouteSettings: properties['DefaultRouteSettings'] as RouteSettings | undefined,
          AccessLogSettings: properties['AccessLogSettings'] as AccessLogSettings | undefined,
          ClientCertificateId: properties['ClientCertificateId'] as string | undefined,
          DeploymentId: properties['DeploymentId'] as string | undefined,
          RouteSettings: properties['RouteSettings'] as Record<string, RouteSettings> | undefined,
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

    this.warnTlsConfigIgnoredIfPublic(logicalId, properties);

    try {
      const response = await this.getClient().send(
        new CreateIntegrationCommand({
          ApiId: apiId,
          IntegrationType: integrationType as IntegrationType,
          IntegrationUri: properties['IntegrationUri'] as string | undefined,
          IntegrationMethod: properties['IntegrationMethod'] as string | undefined,
          PayloadFormatVersion: properties['PayloadFormatVersion'] as string | undefined,
          TimeoutInMillis: properties['TimeoutInMillis'] as number | undefined,
          RequestParameters: properties['RequestParameters'] as Record<string, string> | undefined,
          Description: properties['Description'] as string | undefined,
          ConnectionId: properties['ConnectionId'] as string | undefined,
          ConnectionType: properties['ConnectionType'] as ConnectionType | undefined,
          ContentHandlingStrategy: properties['ContentHandlingStrategy'] as
            | ContentHandlingStrategy
            | undefined,
          CredentialsArn: properties['CredentialsArn'] as string | undefined,
          IntegrationSubtype: properties['IntegrationSubtype'] as string | undefined,
          PassthroughBehavior: properties['PassthroughBehavior'] as PassthroughBehavior | undefined,
          RequestTemplates: properties['RequestTemplates'] as Record<string, string> | undefined,
          ResponseParameters: this.toSdkResponseParameters(properties['ResponseParameters']),
          TemplateSelectionExpression: properties['TemplateSelectionExpression'] as
            | string
            | undefined,
          TlsConfig: properties['TlsConfig'] as TlsConfigInput | undefined,
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
          AuthorizationScopes: properties['AuthorizationScopes'] as string[] | undefined,
          OperationName: properties['OperationName'] as string | undefined,
          ApiKeyRequired: properties['ApiKeyRequired'] as boolean | undefined,
          ModelSelectionExpression: properties['ModelSelectionExpression'] as string | undefined,
          RequestModels: properties['RequestModels'] as Record<string, string> | undefined,
          RequestParameters: properties['RequestParameters'] as
            | Record<string, ParameterConstraints>
            | undefined,
          RouteResponseSelectionExpression: properties['RouteResponseSelectionExpression'] as
            | string
            | undefined,
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
          // REQUEST-only create-time scalar (IAM role ARN API Gateway assumes
          // to invoke the REQUEST Lambda authorizer). AWS rejects it on JWT
          // authorizers and CDK only emits it for REQUEST; passing undefined
          // when absent is a no-op, so no AuthorizerType gate is needed here.
          AuthorizerCredentialsArn: properties['AuthorizerCredentialsArn'] as string | undefined,
          AuthorizerPayloadFormatVersion: properties['AuthorizerPayloadFormatVersion'] as
            | string
            | undefined,
          AuthorizerResultTtlInSeconds: properties['AuthorizerResultTtlInSeconds'] as
            | number
            | undefined,
          EnableSimpleResponses: properties['EnableSimpleResponses'] as boolean | undefined,
          IdentityValidationExpression: properties['IdentityValidationExpression'] as
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
  /**
   * `TlsConfig` is meaningful ONLY for a private (VPC-Link) integration.
   * On a public one (`ConnectionType` absent or `INTERNET`) AWS SILENTLY
   * IGNORES the field — it is absent from both the `CreateIntegration`
   * echo and the `GetIntegration` read-back (direct A/B, 2026-08-11
   * us-east-1) — so the provider can never read it back and a template
   * that declares it would report permanent phantom drift on the
   * `properties`-fallback baseline, with `--revert` re-sending a value AWS
   * discards on every run (issue #1602). The path is scoped by the
   * resource's own `ConnectionType` via the optional `properties` bag: a
   * VPC_LINK integration keeps full `TlsConfig` drift coverage (AWS
   * returns the field there). Without a USABLE properties bag the answer
   * stays empty — comparing is the safe default, since hiding a private
   * integration's real `TlsConfig` drift is worse than a false positive on
   * a caller that could not supply the bag. An EMPTY bag counts as unusable
   * for the same reason: the caller passes `resource.properties ?? {}`, so
   * `{}` means "nothing recorded", not "ConnectionType is absent, therefore
   * public" (an empty bag also has no `TlsConfig` key for the comparator to
   * walk, so refusing to declare costs nothing).
   */
  getDriftUnknownPaths(resourceType: string, properties?: Record<string, unknown>): string[] {
    if (
      resourceType === 'AWS::ApiGatewayV2::Integration' &&
      properties !== undefined &&
      Object.keys(properties).length > 0 &&
      properties['ConnectionType'] !== 'VPC_LINK'
    ) {
      return ['TlsConfig'];
    }
    return [];
  }

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

      // Class 1 — ApiKeySelectionExpression is supported only for
      // WEBSOCKET APIs (AWS docs). Emitting it on an HTTP API would push
      // an AWS-rejected value back through `cdkd drift --revert`. Same
      // discriminator guard as RouteSelectionExpression above.
      if (resp.ProtocolType === 'WEBSOCKET' && resp.ApiKeySelectionExpression !== undefined) {
        result['ApiKeySelectionExpression'] = resp.ApiKeySelectionExpression;
      }

      // DisableExecuteApiEndpoint / Version / IpAddressType ride on both
      // protocols and are user-controllable on CreateApi/UpdateApi — emit
      // when present (no default-when-absent, matching the provider's
      // convention).
      if (resp.DisableExecuteApiEndpoint !== undefined) {
        result['DisableExecuteApiEndpoint'] = resp.DisableExecuteApiEndpoint;
      }
      if (resp.Version !== undefined) result['Version'] = resp.Version;
      if (resp.IpAddressType !== undefined) result['IpAddressType'] = resp.IpAddressType;

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

      // StageVariables / DefaultRouteSettings are user-controllable on
      // CreateStage/UpdateStage — emit when present (no default-when-absent,
      // matching the provider's convention). The drift comparator is
      // state-keys-only, so emit-when-present cannot cause phantom drift.
      if (resp.StageVariables !== undefined) result['StageVariables'] = resp.StageVariables;
      if (resp.DefaultRouteSettings !== undefined) {
        result['DefaultRouteSettings'] = resp.DefaultRouteSettings;
      }
      // Issue #609 backfill. Same emit-when-present convention: the drift
      // comparator only descends into keys present in the recorded baseline,
      // so a stage that never set one of these cannot drift on it.
      if (resp.AccessLogSettings !== undefined) {
        result['AccessLogSettings'] = resp.AccessLogSettings;
      }
      if (resp.ClientCertificateId !== undefined) {
        result['ClientCertificateId'] = resp.ClientCertificateId;
      }
      // DeploymentId is emitted ONLY when the template declared it. Under
      // `AutoDeploy: true` AWS mints a NEW deployment id on every route /
      // integration change, so capturing it into the observed-properties drift
      // baseline reports permanent phantom drift on an untouched stack — and
      // `--revert` then pushes the stale id back through UpdateStage, rolling
      // the live stage back to an old deployment. The value is a non-empty
      // string, so `undeclaredEmptyObservedKeys` cannot skip it.
      if (properties?.['DeploymentId'] !== undefined && resp.DeploymentId !== undefined) {
        result['DeploymentId'] = resp.DeploymentId;
      }
      if (resp.RouteSettings !== undefined) result['RouteSettings'] = resp.RouteSettings;
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

      // TimeoutInMillis / RequestParameters / Description are
      // user-controllable on CreateIntegration/UpdateIntegration — emit
      // when present (no default-when-absent, matching the provider's
      // convention). The drift comparator is state-keys-only, so
      // emit-when-present cannot cause phantom drift.
      if (resp.TimeoutInMillis !== undefined) result['TimeoutInMillis'] = resp.TimeoutInMillis;
      if (resp.RequestParameters !== undefined) {
        result['RequestParameters'] = resp.RequestParameters;
      }
      if (resp.Description !== undefined) result['Description'] = resp.Description;

      // Issue #609 backfill, same emit-when-present convention as above. These
      // reads are not optional extras: the write side now delivers each of
      // these properties, so a read side that stayed silent would leave every
      // one of them permanently un-comparable — and `ResponseParameters` would
      // additionally report phantom drift forever, because AWS returns the
      // FLAT SDK map while the cdkd baseline holds the CFn list-of-pairs.
      if (resp.ConnectionId !== undefined) result['ConnectionId'] = resp.ConnectionId;
      if (resp.ConnectionType !== undefined) result['ConnectionType'] = resp.ConnectionType;
      if (resp.ContentHandlingStrategy !== undefined) {
        result['ContentHandlingStrategy'] = resp.ContentHandlingStrategy;
      }
      if (resp.CredentialsArn !== undefined) result['CredentialsArn'] = resp.CredentialsArn;
      if (resp.IntegrationSubtype !== undefined) {
        result['IntegrationSubtype'] = resp.IntegrationSubtype;
      }
      if (resp.PassthroughBehavior !== undefined) {
        result['PassthroughBehavior'] = resp.PassthroughBehavior;
      }
      if (resp.RequestTemplates !== undefined) result['RequestTemplates'] = resp.RequestTemplates;
      if (resp.ResponseParameters !== undefined) {
        result['ResponseParameters'] = this.toCfnResponseParameters(
          resp.ResponseParameters,
          properties?.['ResponseParameters']
        );
      }
      if (resp.TemplateSelectionExpression !== undefined) {
        result['TemplateSelectionExpression'] = resp.TemplateSelectionExpression;
      }
      if (resp.TlsConfig !== undefined) result['TlsConfig'] = resp.TlsConfig;
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

      // OperationName is a free-form label valid on any route regardless
      // of AuthorizationType. Emit-when-present so a route that never set
      // it does not grow a phantom-drift key.
      if (resp.OperationName !== undefined) result['OperationName'] = resp.OperationName;
      // Issue #609 backfill, same emit-when-present convention as above.
      // `ApiKeyRequired` gets its AWS default (false) rather than being
      // omitted: unlike the others it is a boolean cdkd now actively RESETS on
      // removal, so the read side has to be able to show the reset landed.
      result['ApiKeyRequired'] = resp.ApiKeyRequired ?? false;
      if (resp.ModelSelectionExpression !== undefined) {
        result['ModelSelectionExpression'] = resp.ModelSelectionExpression;
      }
      if (resp.RequestModels !== undefined) result['RequestModels'] = resp.RequestModels;
      if (resp.RequestParameters !== undefined) {
        result['RequestParameters'] = resp.RequestParameters;
      }
      if (resp.RouteResponseSelectionExpression !== undefined) {
        result['RouteResponseSelectionExpression'] = resp.RouteResponseSelectionExpression;
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

        // AuthorizerCredentialsArn / AuthorizerResultTtlInSeconds /
        // EnableSimpleResponses / IdentityValidationExpression are valid
        // only for REQUEST authorizers. Emit-when-present (gate each on
        // `!== undefined`) so a REQUEST authorizer that never set them
        // does not grow a phantom-drift key, and a JWT authorizer never
        // surfaces them at all.
        if (resp.AuthorizerCredentialsArn !== undefined)
          result['AuthorizerCredentialsArn'] = resp.AuthorizerCredentialsArn;
        if (resp.AuthorizerResultTtlInSeconds !== undefined)
          result['AuthorizerResultTtlInSeconds'] = resp.AuthorizerResultTtlInSeconds;
        if (resp.EnableSimpleResponses !== undefined)
          result['EnableSimpleResponses'] = resp.EnableSimpleResponses;
        if (resp.IdentityValidationExpression !== undefined)
          result['IdentityValidationExpression'] = resp.IdentityValidationExpression;
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
   * `AWS::ApiGatewayV2::Api` resolves an explicit `--resource` override
   * (verified via `GetApi`). There is no `aws:cdk:path` tag walk — AWS
   * rejects `aws:`-prefixed tag writes, so that tag never exists on a real
   * resource (issue #1134); auto-mode import resolves ids from
   * CloudFormation's `DescribeStackResources` instead.
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

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; an
    // API reaching here needs an explicit `--resource` override.
    return null;
  }

  // ─── Update implementations ───────────────────────────────────────

  /**
   * `UpdateApi` accepts the full Update input shape (not JSON Patch).
   * Mutable fields cdkd manages: `Name` / `Description` /
   * `CorsConfiguration` / `DisableExecuteApiEndpoint` / `Version` /
   * `RouteSelectionExpression` / `ApiKeySelectionExpression` /
   * `IpAddressType`.
   * `ProtocolType` is immutable — the deploy engine handles changes via
   * the replacement path; we surface a `ResourceUpdateNotSupportedError`
   * if it ever reaches us anyway.
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

    // Name is required on AWS::ApiGatewayV2::Api, so it is never removed —
    // pass it through as a plain change (no reset value).
    if (properties['Name'] !== undefined && properties['Name'] !== previousProperties['Name']) {
      input.Name = properties['Name'] as string;
      changed = true;
    }
    // Description clears on '' when removed (#1160).
    {
      const r = this.clearableUpdate(
        properties['Description'] as string | undefined,
        previousProperties['Description'] as string | undefined,
        ''
      );
      if (r.changed) {
        input.Description = r.value;
        changed = true;
      }
    }
    // CorsConfiguration is set here on change; REMOVAL is handled out-of-band
    // via DeleteCorsConfiguration below (an empty Cors in UpdateApi does not
    // clear it — live-probed #1160).
    if (
      properties['CorsConfiguration'] !== undefined &&
      !this.deepEqual(properties['CorsConfiguration'], previousProperties['CorsConfiguration'])
    ) {
      input.CorsConfiguration = properties[
        'CorsConfiguration'
      ] as UpdateApiCommandInput['CorsConfiguration'];
      changed = true;
    }
    const corsRemoved =
      properties['CorsConfiguration'] === undefined &&
      previousProperties['CorsConfiguration'] !== undefined;
    // DisableExecuteApiEndpoint resets to false (CFn default) on removal.
    {
      const r = this.clearableUpdate(
        properties['DisableExecuteApiEndpoint'] as boolean | undefined,
        previousProperties['DisableExecuteApiEndpoint'] as boolean | undefined,
        false
      );
      if (r.changed) {
        input.DisableExecuteApiEndpoint = r.value;
        changed = true;
      }
    }
    // Version clears on '' when removed.
    {
      const r = this.clearableUpdate(
        properties['Version'] as string | undefined,
        previousProperties['Version'] as string | undefined,
        ''
      );
      if (r.changed) {
        input.Version = r.value;
        changed = true;
      }
    }
    // RouteSelectionExpression is NOT cleared: required (and immutable in
    // practice) for WebSocket APIs, fixed for HTTP APIs, so removal is not a
    // valid template transition — pass it through as a plain change only.
    if (
      properties['RouteSelectionExpression'] !== undefined &&
      properties['RouteSelectionExpression'] !== previousProperties['RouteSelectionExpression']
    ) {
      input.RouteSelectionExpression = properties['RouteSelectionExpression'] as string;
      changed = true;
    }
    // ApiKeySelectionExpression is WebSocket-only; its CFn default is the
    // header expression, so removal resets to that (a WebSocket API is the
    // only place `previous` is ever set).
    {
      const r = this.clearableUpdate(
        properties['ApiKeySelectionExpression'] as string | undefined,
        previousProperties['ApiKeySelectionExpression'] as string | undefined,
        '$request.header.x-api-key'
      );
      if (r.changed) {
        input.ApiKeySelectionExpression = r.value;
        changed = true;
      }
    }
    // IpAddressType resets to 'ipv4' (CFn default) on removal.
    {
      const r = this.clearableUpdate(
        properties['IpAddressType'] as IpAddressType | undefined,
        previousProperties['IpAddressType'] as IpAddressType | undefined,
        'ipv4' as IpAddressType
      );
      if (r.changed) {
        input.IpAddressType = r.value;
        changed = true;
      }
    }

    if (!changed && !corsRemoved) {
      this.logger.debug(`No mutable Api fields changed for ${logicalId}; skipping UpdateApi`);
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating API Gateway V2 Api ${logicalId}: ${physicalId}`);

    try {
      if (changed) {
        await this.getClient().send(new UpdateApiCommand(input));
      }
      if (corsRemoved) {
        this.logger.debug(`Clearing CORS configuration for Api ${logicalId}: ${physicalId}`);
        await this.getClient().send(new DeleteCorsConfigurationCommand({ ApiId: physicalId }));
      }
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
   * `AutoDeploy` / `Description` / `StageVariables` /
   * `DefaultRouteSettings` / `AccessLogSettings` / `ClientCertificateId` /
   * `DeploymentId` / `RouteSettings`. `ApiId` is also immutable (a stage
   * cannot be moved between APIs). `AccessLogSettings` and per-key
   * `RouteSettings` can only be CLEARED through their dedicated delete APIs —
   * see {@link applyStageRemovals}.
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

    // AutoDeploy resets to false (CFn default) on removal (#1160).
    {
      const r = this.clearableUpdate(
        properties['AutoDeploy'] as boolean | undefined,
        previousProperties['AutoDeploy'] as boolean | undefined,
        false
      );
      if (r.changed) {
        input.AutoDeploy = r.value;
        changed = true;
      }
    }
    // Description is NOT cleared: UpdateStage silently ignores an empty-string
    // reset (live-probed #1160 — unlike UpdateApi, the value persists), so the
    // API cannot clear it and CloudFormation faces the same constraint.
    if (
      properties['Description'] !== undefined &&
      properties['Description'] !== previousProperties['Description']
    ) {
      input.Description = properties['Description'] as string;
      changed = true;
    }
    // StageVariables merges on the AWS side; removed keys (or the whole block)
    // are cleared by sending them with an empty-string value (#1160).
    {
      const merged = this.mapWithRemovals(
        properties['StageVariables'],
        previousProperties['StageVariables']
      );
      if (merged !== undefined) {
        input.StageVariables = merged;
        changed = true;
      }
    }
    // DefaultRouteSettings is NOT cleared: UpdateStage merges it and offers no
    // whole-block reset (the throttle sub-fields have no account-default
    // sentinel), so removal is left to match the CFn/API constraint (#1160).
    if (
      properties['DefaultRouteSettings'] !== undefined &&
      !this.deepEqual(
        properties['DefaultRouteSettings'],
        previousProperties['DefaultRouteSettings']
      )
    ) {
      input.DefaultRouteSettings = properties['DefaultRouteSettings'] as RouteSettings;
      changed = true;
    }
    // AccessLogSettings / RouteSettings are OBJECT-valued blocks UpdateStage
    // MERGES, so an omitted member is a no-op — live-probed 2026-08-11: a
    // stage keeps its AccessLogSettings verbatim through an UpdateStage that
    // omits it. Both therefore have DEDICATED delete APIs, handled out-of-band
    // below exactly like CorsConfiguration on ::Api.
    if (
      properties['AccessLogSettings'] !== undefined &&
      !this.deepEqual(properties['AccessLogSettings'], previousProperties['AccessLogSettings'])
    ) {
      input.AccessLogSettings = properties['AccessLogSettings'] as AccessLogSettings;
      changed = true;
    }
    const accessLogRemoved =
      properties['AccessLogSettings'] === undefined &&
      previousProperties['AccessLogSettings'] !== undefined;
    if (
      properties['RouteSettings'] !== undefined &&
      !this.deepEqual(properties['RouteSettings'], previousProperties['RouteSettings'])
    ) {
      input.RouteSettings = properties['RouteSettings'] as Record<string, RouteSettings>;
      changed = true;
    }
    // Per-ROUTE-KEY removal: the map merges, so a key dropped from the
    // template (or the whole block removed) survives unless it is deleted by
    // name. Live-probed 2026-08-11: DeleteRouteSettings clears exactly one key.
    const droppedRouteSettingKeys = this.droppedKeys(
      properties['RouteSettings'],
      previousProperties['RouteSettings']
    );
    // ClientCertificateId clears on '' (detaches the certificate) when removed,
    // mirroring the AuthorizerId treatment on Route.
    {
      const r = this.clearableUpdate(
        properties['ClientCertificateId'] as string | undefined,
        previousProperties['ClientCertificateId'] as string | undefined,
        ''
      );
      if (r.changed) {
        input.ClientCertificateId = r.value;
        changed = true;
      }
    }
    // DeploymentId points at a specific Deployment resource; it is only
    // meaningful while AutoDeploy is off, and there is no "no deployment"
    // sentinel — pass through on change only.
    if (
      properties['DeploymentId'] !== undefined &&
      properties['DeploymentId'] !== previousProperties['DeploymentId']
    ) {
      input.DeploymentId = properties['DeploymentId'] as string;
      changed = true;
    }

    if (!changed) {
      // The out-of-band removals are their own API calls, so a template whose
      // ONLY change is dropping one of them still has work to do here.
      if (accessLogRemoved || droppedRouteSettingKeys.length > 0) {
        try {
          await this.applyStageRemovals(
            apiId,
            physicalId,
            accessLogRemoved,
            droppedRouteSettingKeys
          );
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
        return { physicalId, wasReplaced: false };
      }
      this.logger.debug(`No mutable Stage fields changed for ${logicalId}; skipping UpdateStage`);
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating API Gateway V2 Stage ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new UpdateStageCommand(input));
      await this.applyStageRemovals(apiId, physicalId, accessLogRemoved, droppedRouteSettingKeys);
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
   * `IntegrationMethod` / `PayloadFormatVersion` / `TimeoutInMillis` /
   * `RequestParameters` / `Description`, plus the issue #609 backfill
   * (`ConnectionId` / `ConnectionType` / `ContentHandlingStrategy` /
   * `CredentialsArn` / `IntegrationSubtype` / `PassthroughBehavior` /
   * `RequestTemplates` / `ResponseParameters` / `TemplateSelectionExpression`
   * / `TlsConfig`).
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
    if (
      properties['TimeoutInMillis'] !== undefined &&
      properties['TimeoutInMillis'] !== previousProperties['TimeoutInMillis']
    ) {
      input.TimeoutInMillis = properties['TimeoutInMillis'] as number;
      changed = true;
    }
    // IntegrationType / IntegrationUri / IntegrationMethod /
    // PayloadFormatVersion above are required per integration type — the API
    // rejects an empty reset for them, so removal is not a valid transition and
    // they pass through as plain changes only. TimeoutInMillis is likewise left
    // alone (its default is integration-type-dependent with no clean reset).
    // RequestParameters merges per key on the AWS side; removed keys (or the
    // whole block) are cleared by sending them with an empty-string value
    // (live-probed #1160 — `{}` does NOT clear).
    {
      const merged = this.mapWithRemovals(
        properties['RequestParameters'],
        previousProperties['RequestParameters']
      );
      if (merged !== undefined) {
        input.RequestParameters = merged;
        changed = true;
      }
    }
    // Description clears on '' when removed (#1160).
    {
      const r = this.clearableUpdate(
        properties['Description'] as string | undefined,
        previousProperties['Description'] as string | undefined,
        ''
      );
      if (r.changed) {
        input.Description = r.value;
        changed = true;
      }
    }

    // Issue #609 backfill — the ten properties below were previously DECLARED
    // nowhere and delivered nowhere, so a template using any of them lost it
    // silently. They pass through ON CHANGE ONLY.
    //
    // Absent-field REMOVAL is deliberately NOT backfilled here. Each of these
    // would need its own live CloudFormation A/B to establish whether CFn
    // resets the field or retains it, and which sentinel the API accepts as
    // "unset" (the ones already handled above — Description on '',
    // RequestParameters per key — were each live-probed before being written
    // that way, and the probes repeatedly contradicted the intuitive answer).
    // Guessing a reset value here would turn a silent drop into a silent
    // OVERWRITE of a live integration, which is strictly worse. Removal
    // semantics for this group belong to the #1160 umbrella.
    //
    // That deferral covers PER-KEY removal too, which is NOT the same
    // statement and is worth spelling out: `RequestTemplates` and
    // `ResponseParameters` are maps, and the sibling `RequestParameters` above
    // goes through `mapWithRemovals` precisely because UpdateIntegration
    // MERGES a map (live-probed for that field — `{}` does not clear it). If
    // these two merge the same way, then dropping ONE content type or ONE
    // Destination while changing another is a CHANGE rather than a whole-field
    // removal: the reduced map is sent, AWS keeps the old key, and cdkd reports
    // success. The `''` sentinel `mapWithRemovals` relies on has NOT been
    // probed for either field, and for `RequestTemplates` an empty string is a
    // legitimate mapping-template body — so reusing it on a guess could delete
    // a live template. Both stay whole-value pass-throughs until probed.
    if (
      properties['ConnectionId'] != null &&
      properties['ConnectionId'] !== previousProperties['ConnectionId']
    ) {
      input.ConnectionId = properties['ConnectionId'] as string;
      changed = true;
    }
    if (
      properties['ConnectionType'] != null &&
      properties['ConnectionType'] !== previousProperties['ConnectionType']
    ) {
      input.ConnectionType = properties['ConnectionType'] as ConnectionType;
      changed = true;
    }
    if (
      properties['ContentHandlingStrategy'] != null &&
      properties['ContentHandlingStrategy'] !== previousProperties['ContentHandlingStrategy']
    ) {
      input.ContentHandlingStrategy = properties[
        'ContentHandlingStrategy'
      ] as ContentHandlingStrategy;
      changed = true;
    }
    if (
      properties['CredentialsArn'] != null &&
      properties['CredentialsArn'] !== previousProperties['CredentialsArn']
    ) {
      input.CredentialsArn = properties['CredentialsArn'] as string;
      changed = true;
    }
    if (
      properties['IntegrationSubtype'] != null &&
      properties['IntegrationSubtype'] !== previousProperties['IntegrationSubtype']
    ) {
      input.IntegrationSubtype = properties['IntegrationSubtype'] as string;
      changed = true;
    }
    // ...and IntegrationSubtype is ALSO re-sent when it did NOT change, which
    // is the one place this provider's send-only-what-differs rule does not
    // hold. `IntegrationSubtype` is the DISCRIMINATOR that makes an AWS_PROXY
    // integration a service integration rather than a URI-based one, and
    // UpdateIntegration re-validates the whole shape against the patch: with
    // the subtype absent AWS reads the integration as URI-based and rejects
    // the call with `Invalid integration URI specified`.
    //
    // Live A/B, 2026-08-11 us-east-1, on an EventBridge-PutEvents integration
    // (found by the apigatewayv2-update-removal integ, not by the unit tests —
    // a mocked client agrees with either shape):
    //   RequestParameters alone                  -> BadRequestException
    //   RequestParameters + IntegrationSubtype   -> OK
    //
    // The PREVIOUS side is the fallback because the constraint is about the
    // LIVE integration, which stays a service integration even when the
    // desired template drops the subtype (removal being out of scope here) —
    // sourcing this only from the desired bag would send a discriminator-less
    // patch for exactly that template and fail the deploy.
    if (input.IntegrationSubtype === undefined) {
      const liveSubtype =
        properties['IntegrationSubtype'] ?? previousProperties['IntegrationSubtype'];
      if (liveSubtype !== undefined) input.IntegrationSubtype = liveSubtype as string;
    }
    if (
      properties['PassthroughBehavior'] != null &&
      properties['PassthroughBehavior'] !== previousProperties['PassthroughBehavior']
    ) {
      input.PassthroughBehavior = properties['PassthroughBehavior'] as PassthroughBehavior;
      changed = true;
    }
    if (
      properties['RequestTemplates'] != null &&
      !this.deepEqual(properties['RequestTemplates'], previousProperties['RequestTemplates'])
    ) {
      input.RequestTemplates = properties['RequestTemplates'] as Record<string, string>;
      changed = true;
    }
    // ResponseParameters is COMPARED on the CFn side (the shape both the
    // template and cdkd state carry) and converted only on the way out, so a
    // no-op deploy does not re-send it.
    if (
      properties['ResponseParameters'] != null &&
      !this.deepEqual(properties['ResponseParameters'], previousProperties['ResponseParameters'])
    ) {
      input.ResponseParameters = this.toSdkResponseParameters(properties['ResponseParameters']);
      changed = true;
    }
    if (
      properties['TemplateSelectionExpression'] != null &&
      properties['TemplateSelectionExpression'] !==
        previousProperties['TemplateSelectionExpression']
    ) {
      input.TemplateSelectionExpression = properties['TemplateSelectionExpression'] as string;
      changed = true;
    }
    if (
      properties['TlsConfig'] != null &&
      !this.deepEqual(properties['TlsConfig'], previousProperties['TlsConfig'])
    ) {
      this.warnTlsConfigIgnoredIfPublic(logicalId, properties);
      input.TlsConfig = properties['TlsConfig'] as TlsConfigInput;
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
   * `AuthorizerId` / `AuthorizationScopes` / `OperationName` /
   * `ApiKeyRequired` / `RequestModels` / `RequestParameters` /
   * `ModelSelectionExpression` / `RouteResponseSelectionExpression`.
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

    // RouteKey and Target are required in practice (a route cannot exist
    // without a key, and a non-Mock route needs a target) — pass through as
    // plain changes only.
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
    // AuthorizationType resets to 'NONE' (CFn default) on removal (#1160).
    {
      const r = this.clearableUpdate(
        properties['AuthorizationType'] as AuthorizationType | undefined,
        previousProperties['AuthorizationType'] as AuthorizationType | undefined,
        'NONE' as AuthorizationType
      );
      if (r.changed) {
        input.AuthorizationType = r.value;
        changed = true;
      }
    }
    // AuthorizerId clears on '' (detaches the authorizer) when removed.
    {
      const r = this.clearableUpdate(
        properties['AuthorizerId'] as string | undefined,
        previousProperties['AuthorizerId'] as string | undefined,
        ''
      );
      if (r.changed) {
        input.AuthorizerId = r.value;
        changed = true;
      }
    }
    // AuthorizationScopes clears on [] when removed.
    {
      const r = this.clearableUpdate(
        properties['AuthorizationScopes'] as string[] | undefined,
        previousProperties['AuthorizationScopes'] as string[] | undefined,
        []
      );
      if (r.changed) {
        input.AuthorizationScopes = r.value;
        changed = true;
      }
    }
    // OperationName clears on '' when removed.
    {
      const r = this.clearableUpdate(
        properties['OperationName'] as string | undefined,
        previousProperties['OperationName'] as string | undefined,
        ''
      );
      if (r.changed) {
        input.OperationName = r.value;
        changed = true;
      }
    }
    // ApiKeyRequired resets to false (CFn default) on removal (#1160).
    {
      const r = this.clearableUpdate(
        properties['ApiKeyRequired'] as boolean | undefined,
        previousProperties['ApiKeyRequired'] as boolean | undefined,
        false
      );
      if (r.changed) {
        input.ApiKeyRequired = r.value;
        changed = true;
      }
    }
    // RequestModels merges on the AWS side exactly like the Integration
    // RequestParameters map, so a dropped key is cleared by sending it with an
    // empty-string value (see mapWithRemovals).
    {
      const merged = this.mapWithRemovals(
        properties['RequestModels'],
        previousProperties['RequestModels']
      );
      if (merged !== undefined) {
        input.RequestModels = merged;
        changed = true;
      }
    }
    // RequestParameters here is Record<string, ParameterConstraints> — an
    // OBJECT-valued map that UpdateRoute MERGES, so the empty-string per-key
    // clear the string maps use does not apply and a dropped key survives.
    // AWS ships a dedicated per-key delete for exactly this (live-probed
    // 2026-08-11: DeleteRouteRequestParameter clears one parameter), applied
    // out-of-band below.
    if (
      properties['RequestParameters'] !== undefined &&
      !this.deepEqual(properties['RequestParameters'], previousProperties['RequestParameters'])
    ) {
      input.RequestParameters = properties[
        'RequestParameters'
      ] as UpdateRouteCommandInput['RequestParameters'];
      changed = true;
    }
    const droppedRequestParameterKeys = this.droppedKeys(
      properties['RequestParameters'],
      previousProperties['RequestParameters']
    );
    // ModelSelectionExpression / RouteResponseSelectionExpression are
    // WebSocket-only selection expressions. Pass-through on change only, same
    // treatment as the API-level RouteSelectionExpression above: removal is not
    // a valid transition for a WebSocket route and no reset sentinel is
    // documented.
    if (
      properties['ModelSelectionExpression'] !== undefined &&
      properties['ModelSelectionExpression'] !== previousProperties['ModelSelectionExpression']
    ) {
      input.ModelSelectionExpression = properties['ModelSelectionExpression'] as string;
      changed = true;
    }
    if (
      properties['RouteResponseSelectionExpression'] !== undefined &&
      properties['RouteResponseSelectionExpression'] !==
        previousProperties['RouteResponseSelectionExpression']
    ) {
      input.RouteResponseSelectionExpression = properties[
        'RouteResponseSelectionExpression'
      ] as string;
      changed = true;
    }

    if (!changed) {
      // The per-key parameter deletes are their own API calls, so a template
      // whose ONLY change is dropping one still has work to do here.
      if (droppedRequestParameterKeys.length > 0) {
        try {
          await this.deleteRouteRequestParameters(apiId, physicalId, droppedRequestParameterKeys);
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
        return { physicalId, wasReplaced: false };
      }
      this.logger.debug(`No mutable Route fields changed for ${logicalId}; skipping UpdateRoute`);
      return { physicalId, wasReplaced: false };
    }

    this.logger.debug(`Updating API Gateway V2 Route ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new UpdateRouteCommand(input));
      await this.deleteRouteRequestParameters(apiId, physicalId, droppedRequestParameterKeys);
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
   * `JwtConfiguration` / `AuthorizerUri` / `AuthorizerCredentialsArn` /
   * `AuthorizerPayloadFormatVersion` / `AuthorizerResultTtlInSeconds` /
   * `EnableSimpleResponses`.
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
    // AuthorizerUri is required for REQUEST authorizers (a JWT authorizer has
    // none) — removal implies a type change, not a clean reset, so it passes
    // through as a plain change only.
    if (
      properties['AuthorizerUri'] !== undefined &&
      properties['AuthorizerUri'] !== previousProperties['AuthorizerUri']
    ) {
      input.AuthorizerUri = properties['AuthorizerUri'] as string;
      changed = true;
    }
    // AuthorizerCredentialsArn clears on '' when removed (#1160).
    {
      const r = this.clearableUpdate(
        properties['AuthorizerCredentialsArn'] as string | undefined,
        previousProperties['AuthorizerCredentialsArn'] as string | undefined,
        ''
      );
      if (r.changed) {
        input.AuthorizerCredentialsArn = r.value;
        changed = true;
      }
    }
    // AuthorizerPayloadFormatVersion clears on '' when removed.
    {
      const r = this.clearableUpdate(
        properties['AuthorizerPayloadFormatVersion'] as string | undefined,
        previousProperties['AuthorizerPayloadFormatVersion'] as string | undefined,
        ''
      );
      if (r.changed) {
        input.AuthorizerPayloadFormatVersion = r.value;
        changed = true;
      }
    }
    // AuthorizerResultTtlInSeconds resets to 0 (CFn default = no cache) on removal.
    {
      const r = this.clearableUpdate(
        properties['AuthorizerResultTtlInSeconds'] as number | undefined,
        previousProperties['AuthorizerResultTtlInSeconds'] as number | undefined,
        0
      );
      if (r.changed) {
        input.AuthorizerResultTtlInSeconds = r.value;
        changed = true;
      }
    }
    // EnableSimpleResponses is REQUEST-authorizer-only — UpdateAuthorizer
    // rejects it (even `false`) on a JWT authorizer, so it cannot be blindly
    // reset; pass through as a plain change only (#1160).
    if (
      properties['EnableSimpleResponses'] !== undefined &&
      properties['EnableSimpleResponses'] !== previousProperties['EnableSimpleResponses']
    ) {
      input.EnableSimpleResponses = properties['EnableSimpleResponses'] as boolean;
      changed = true;
    }
    // IdentityValidationExpression clears on '' when removed.
    {
      const r = this.clearableUpdate(
        properties['IdentityValidationExpression'] as string | undefined,
        previousProperties['IdentityValidationExpression'] as string | undefined,
        ''
      );
      if (r.changed) {
        input.IdentityValidationExpression = r.value;
        changed = true;
      }
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
   * Resolve an optional update field so that a property REMOVED from the
   * template is reset to its CloudFormation default instead of silently
   * retaining the old live value (issue #1160 — the absent-field removal
   * silent-drop bug class; reference fix `LambdaFunctionProvider`, #1157).
   *
   * Every API Gateway V2 `Update*` API uses PATCH / merge semantics: an
   * ABSENT input field means "no change", so passing `undefined` for a
   * field the user just dropped leaves the old value live on AWS while
   * CloudFormation resets it to the property default. For each removable
   * field we therefore send its explicit reset value (`resetValue`) when
   * it was present before and is now absent.
   *
   * The reset values below were live-probed against real AWS (2026-07-22):
   * string fields clear on `''`, boolean/enum fields on their CFn default,
   * `AuthorizationScopes` on `[]`, `AuthorizerResultTtlInSeconds` on `0`.
   * `CorsConfiguration` is the ONE exception — an empty `Cors` in
   * `UpdateApi` does NOT clear it, so removal is handled out-of-band via
   * `DeleteCorsConfiguration` (see `updateApi`). Fields that are required
   * per protocol/authorizer type (`Name`, `RouteKey`, `Target`,
   * `RouteSelectionExpression`, `IntegrationType`/`Uri`/`Method`,
   * `PayloadFormatVersion`, `IdentitySource`, `JwtConfiguration`,
   * `EnableSimpleResponses`) are NOT cleared: the underlying API rejects a
   * reset value for them, so CloudFormation faces the same constraint and
   * cdkd leaving them matches CFn. `Stage.Description` /
   * `DefaultRouteSettings` are likewise left alone — the API silently
   * ignores an empty-string / empty-object reset for them.
   *
   * Returns `{ changed, value }`: `changed` is true only when the resolved
   * value actually differs from the previous one (so a no-op field never
   * forces an Update call), and `value` is the value to place in the input.
   */
  private clearableUpdate<T>(
    next: T | undefined,
    previous: T | undefined,
    resetValue: T
  ): { changed: boolean; value: T | undefined } {
    const resolved = next !== undefined ? next : previous !== undefined ? resetValue : undefined;
    const changed = resolved !== undefined && !this.deepEqual(resolved, previous);
    return { changed, value: resolved };
  }

  /**
   * Keys present in `previous` but absent from `next` — the set a
   * merge-semantics map silently keeps unless each is deleted BY NAME. A
   * whole-block removal (`next` undefined) therefore yields every previous key.
   */
  private droppedKeys(next: unknown, previous: unknown): string[] {
    if (previous == null || typeof previous !== 'object' || Array.isArray(previous)) return [];
    const prevMap = previous as Record<string, unknown>;
    const nextMap =
      next != null && typeof next === 'object' && !Array.isArray(next)
        ? (next as Record<string, unknown>)
        : {};
    // `hasOwnProperty`, not `in`: a key named `constructor` / `toString` would
    // otherwise resolve on the prototype chain and never report as dropped.
    return Object.keys(prevMap).filter(
      (key) => !Object.prototype.hasOwnProperty.call(nextMap, key)
    );
  }

  /**
   * Send a delete that is idempotent by intent.
   *
   * These removal deletes run AFTER the merge-Update in the same update, so a
   * partial failure (throttle on the second of two) leaves state unsaved and
   * the next deploy recomputes the SAME dropped-key set and re-issues an
   * already-applied delete. A console-side removal produces the same shape.
   * Treating NotFound as success is what keeps that from becoming a permanent
   * failure loop.
   */
  private async sendTolerantOfNotFound(send: () => Promise<unknown>): Promise<void> {
    try {
      await send();
    } catch (error) {
      if (error instanceof NotFoundException) return;
      throw error;
    }
  }

  /**
   * The two Stage members `UpdateStage` cannot clear.
   *
   * Both MERGE server-side — live-probed 2026-08-11: a stage keeps its
   * `AccessLogSettings` verbatim through an `UpdateStage` that omits the
   * member — so a removal that only omits the field is the silent no-op issue
   * #1160 tracks (access logging, and its billing, keep running). AWS ships
   * dedicated delete APIs for both; this mirrors the `DeleteCorsConfiguration`
   * path on `::Api`.
   *
   * KNOWN BOUND: `DeleteRouteSettings` removes a whole ROUTE KEY, so dropping
   * one member INSIDE a kept entry (`LoggingLevel` while `ThrottlingRateLimit`
   * stays) still merges and survives — the #1225 sub-field class, one level
   * below what this closes. Same for a partial `AccessLogSettings`.
   */
  private async applyStageRemovals(
    apiId: string,
    stageName: string,
    accessLogRemoved: boolean,
    droppedRouteSettingKeys: readonly string[]
  ): Promise<void> {
    if (accessLogRemoved) {
      await this.sendTolerantOfNotFound(() =>
        this.getClient().send(
          new DeleteAccessLogSettingsCommand({ ApiId: apiId, StageName: stageName })
        )
      );
    }
    for (const routeKey of droppedRouteSettingKeys) {
      await this.sendTolerantOfNotFound(() =>
        this.getClient().send(
          new DeleteRouteSettingsCommand({ ApiId: apiId, StageName: stageName, RouteKey: routeKey })
        )
      );
    }
  }

  /**
   * `RequestParameters` on a Route is an OBJECT-valued merge map, so a dropped
   * key needs the per-key delete API (live-probed 2026-08-11:
   * `DeleteRouteRequestParameter` clears exactly one parameter).
   */
  private async deleteRouteRequestParameters(
    apiId: string,
    routeId: string,
    droppedKeys: readonly string[]
  ): Promise<void> {
    for (const key of droppedKeys) {
      await this.sendTolerantOfNotFound(() =>
        this.getClient().send(
          new DeleteRouteRequestParameterCommand({
            ApiId: apiId,
            RouteId: routeId,
            RequestParameterKey: key,
          })
        )
      );
    }
  }

  /**
   * Resolve a `Record<string, string>` update field (`StageVariables`, Route
   * `RequestModels`, Integration `RequestParameters`) with per-key removal
   * awareness.
   *
   * These maps also merge on the AWS side: sending `{}` (or a map missing
   * a previously-present key) does NOT delete the dropped key — it is kept
   * live. Live-probed 2026-07-22 (and again 2026-08-11 for `RequestModels`):
   * a key is cleared only by sending it with an empty-string value. So the
   * resolved map is `next` plus every key present in `previous` but absent
   * from `next`, set to `''`. Whole-block removal (next `undefined`, previous
   * populated) therefore sends every old key as `''`. Returns `undefined` when
   * nothing changed.
   */
  private mapWithRemovals(next: unknown, previous: unknown): Record<string, string> | undefined {
    if (this.deepEqual(next, previous)) return undefined;
    const nextMap = (next ?? {}) as Record<string, string>;
    const prevMap = (previous ?? {}) as Record<string, string>;
    const merged: Record<string, string> = { ...nextMap };
    for (const key of Object.keys(prevMap)) {
      if (!(key in nextMap)) merged[key] = '';
    }
    return merged;
  }

  /**
   * Announce a `TlsConfig` that AWS will silently discard (issue #1602):
   * the field is only honored on a private (VPC-Link) integration, and on a
   * public one (`ConnectionType` absent or `INTERNET`) AWS accepts the value
   * and drops it — it never appears on the `GetIntegration` read-back
   * (direct A/B, 2026-08-11 us-east-1). cdkd still sends the field (parity:
   * CloudFormation forwards it too and AWS accepts it), but the never-silent
   * policy requires saying so. The matching drift false positive is closed
   * by {@link getDriftUnknownPaths}. A WARN on both create and update, never
   * a throw — the update path can be a state-record replay
   * (`rollback-executor.ts` / `drift --revert`) where a refusal would leave
   * the resource un-revertable.
   */
  private warnTlsConfigIgnoredIfPublic(
    logicalId: string,
    properties: Record<string, unknown>
  ): void {
    if (properties['TlsConfig'] != null && properties['ConnectionType'] !== 'VPC_LINK') {
      this.logger.warn(
        `AWS::ApiGatewayV2::Integration ${logicalId}: TlsConfig is only honored on a ` +
          `VPC_LINK (private) integration — AWS silently ignores it on a public one, and ` +
          `the value will never be readable back from AWS (issue #1602).`
      );
    }
  }

  /**
   * `ResponseParameters` is the one `AWS::ApiGatewayV2::Integration` property
   * whose CFn shape does NOT match the SDK's, so forwarding it verbatim is not
   * an option (issue #609). CloudFormation models it as
   * `{ "<statusCode>": { ResponseParameters: [{ Destination, Source }, ...] } }`
   * while `CreateIntegration` / `UpdateIntegration` take the flattened
   * `{ "<statusCode>": { "<Destination>": "<Source>" } }`. The AWS SDK v3
   * serializer drops members it cannot model, so the un-converted CFn shape
   * would deliver an EMPTY map per status code — the silent-drop class one
   * level down.
   *
   * Anything that is not the expected object / array shape (an unresolved
   * intrinsic, a malformed block) passes through untouched so AWS surfaces the
   * real validation error instead of cdkd inventing one.
   *
   * `Source` is COERCED from a number / boolean rather than skipped. CFn types
   * `ResponseParameters` as free-form `object` and coerces scalars, cdkd does
   * not (the `coerceNumber` class in `.claude/rules/providers.md`), so an
   * unquoted `Source: 403` under the canonical `overwrite:statuscode`
   * destination is a perfectly legal template whose value arrives as a NUMBER.
   * Skipping it would re-introduce the silent drop this method exists to close.
   * A `Destination` is never coerced — it becomes an SDK map KEY, and a
   * non-string there is a malformed template, not a scalar shorthand.
   */
  private toSdkResponseParameters(
    value: unknown
  ): Record<string, Record<string, string>> | undefined {
    if (value == null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
      return value as Record<string, Record<string, string>>;
    }

    const out: Record<string, Record<string, string>> = {};
    for (const [statusCode, block] of Object.entries(value as Record<string, unknown>)) {
      if (block == null || typeof block !== 'object' || Array.isArray(block)) {
        out[statusCode] = block as Record<string, string>;
        continue;
      }
      const entries = (block as Record<string, unknown>)['ResponseParameters'];
      if (!Array.isArray(entries)) {
        // Already flat (`{ "<Destination>": "<Source>" }`) — a hand-written
        // template may use the SDK spelling directly; pass it through.
        out[statusCode] = block as Record<string, string>;
        continue;
      }
      const mapped: Record<string, string> = {};
      for (const entry of entries) {
        const destination =
          entry != null && typeof entry === 'object' && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)['Destination']
            : undefined;
        const source =
          entry != null && typeof entry === 'object' && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)['Source']
            : undefined;
        const coerced =
          typeof source === 'string'
            ? source
            : typeof source === 'number' || typeof source === 'boolean'
              ? String(source)
              : undefined;
        if (typeof destination !== 'string' || coerced === undefined) {
          // Never silent: an entry cdkd cannot deliver is the same class of
          // defect as the drop this whole method closes, so it is announced
          // rather than skipped quietly.
          this.logger.warn(
            `AWS::ApiGatewayV2::Integration ResponseParameters['${statusCode}'] has an entry ` +
              `cdkd cannot deliver (Destination must be a string and Source a string / number / ` +
              `boolean; got ${JSON.stringify(destination)} / ${JSON.stringify(source)}); ` +
              `skipping that entry.`
          );
          continue;
        }
        mapped[destination] = coerced;
      }
      out[statusCode] = mapped;
    }
    return out;
  }

  /**
   * Inverse of {@link toSdkResponseParameters}, for `readCurrentState`. Without
   * it the AWS-current side would carry the flat SDK map while the cdkd
   * baseline carries the CFn list-of-pairs, and every `cdkd drift` run would
   * report permanent phantom drift on a resource nobody touched.
   *
   * Order matters because this turns an UNORDERED SDK map into an ARRAY, and
   * `calculateResourceDrift` compares arrays POSITIONALLY — AWS does not
   * guarantee map readback order, so an arbitrary rebuild would trade the
   * shape-mismatch phantom drift for an ordering one (and `--revert` would
   * re-push an identical value forever). Declared destinations therefore keep
   * their DECLARED position and anything else is sorted; both are stable
   * across reads. Same reasoning as `src/analyzer/drift-normalize.ts`,
   * applied at the source instead.
   *
   * `declared` (the state-recorded desired `ResponseParameters` block, when
   * the caller has it) makes the inverse MIRROR the template's spelling per
   * status code (issue #1602): {@link toSdkResponseParameters} accepts an
   * ALREADY-FLAT block (`{ "<status>": { "<Destination>": "<Source>" } }` —
   * the SDK spelling a hand-written template may use) and passes it through,
   * which made the pair non-injective — this method always rebuilt the CFn
   * list shape, so a flat-spelled baseline could never compare equal to the
   * read-back and reported permanent phantom drift. For a status code whose
   * DECLARED block matches the flat-passthrough branch of
   * {@link toSdkResponseParameters} (an object without an array
   * `ResponseParameters` member), the read-back now stays flat too; every
   * other status code (declared CFn shape, declared absent, no `declared` at
   * all) keeps the CFn list shape. Object comparison is key-based, so the
   * flat map round-trips without the sort the list shape needs.
   *
   * The CFn arm mirrors the declared block too, in the two ways the
   * `properties`-fallback baseline is compared on: ENTRY ORDER (the
   * comparator walks arrays positionally, and the template's order is
   * whatever the author wrote — sorting only the read side is the mistake
   * `drift-normalize.ts`'s header records) and SCALAR TYPE (CFn types
   * `Source` as free-form and cdkd coerces a number to a string on the way
   * out, so re-emitting AWS's string against a numeric declaration is
   * permanent phantom drift). Declared destinations keep their declared
   * position and their declared scalar whenever the value still agrees with
   * AWS; a destination AWS returns that the template never declared is
   * appended in sorted order, so the result stays deterministic across reads.
   */
  private toCfnResponseParameters(
    value: Record<string, Record<string, string>> | undefined,
    declared?: unknown
  ): Record<string, unknown> | undefined {
    if (value == null) return undefined;
    const declaredBlocks =
      declared != null && typeof declared === 'object' && !Array.isArray(declared)
        ? (declared as Record<string, unknown>)
        : undefined;
    const out: Record<string, unknown> = {};
    for (const [statusCode, flat] of Object.entries(value)) {
      if (flat == null || typeof flat !== 'object' || Array.isArray(flat)) continue;
      const declaredBlock = declaredBlocks?.[statusCode];
      const declaredIsBlock =
        declaredBlock != null && typeof declaredBlock === 'object' && !Array.isArray(declaredBlock);
      const declaredEntries = declaredIsBlock
        ? (declaredBlock as Record<string, unknown>)['ResponseParameters']
        : undefined;
      if (declaredIsBlock && !Array.isArray(declaredEntries)) {
        // Declared in the flat SDK spelling (the pass-through branch of
        // `toSdkResponseParameters`) — keep the read-back flat so the two
        // sides compare equal.
        out[statusCode] = flat;
        continue;
      }
      out[statusCode] = {
        ResponseParameters: this.mirrorDeclaredResponsePairs(flat, declaredEntries),
      };
    }
    return out;
  }

  /**
   * Rebuild one status code's CFn list-of-pairs from AWS's flat map, keeping
   * the DECLARED entries' order and scalar types where they still agree with
   * AWS. See {@link toCfnResponseParameters} for why both matter.
   */
  private mirrorDeclaredResponsePairs(
    flat: Record<string, string>,
    declaredEntries: unknown
  ): Array<{ Destination: string; Source: unknown }> {
    const remaining = new Map(Object.entries(flat));
    const pairs: Array<{ Destination: string; Source: unknown }> = [];
    if (Array.isArray(declaredEntries)) {
      for (const entry of declaredEntries) {
        if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const destination = (entry as Record<string, unknown>)['Destination'];
        if (typeof destination !== 'string' || !remaining.has(destination)) continue;
        const awsSource = remaining.get(destination)!;
        remaining.delete(destination);
        // Re-emit the DECLARED scalar when it denotes the same value AWS
        // returned (`Source: 404` vs `'404'`); a genuinely changed value
        // takes AWS's string, which is the drift the user wants to see.
        const declaredSource = (entry as Record<string, unknown>)['Source'];
        const declaredDenotesSame =
          (typeof declaredSource === 'number' || typeof declaredSource === 'boolean') &&
          String(declaredSource) === awsSource;
        pairs.push({
          Destination: destination,
          Source: declaredDenotesSame ? declaredSource : awsSource,
        });
      }
    }
    // Anything AWS returned that the template did not declare is appended in
    // a stable order — AWS does not guarantee map readback order, so an
    // unsorted tail would trade the shape mismatch for an ordering one. (A
    // declared destination whose VALUE no longer matches is not here: it kept
    // its declared position above and carries AWS's value, which is the drift
    // the user wants to see.)
    for (const [destination, source] of [...remaining.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )) {
      pairs.push({ Destination: destination, Source: source });
    }
    return pairs;
  }

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
