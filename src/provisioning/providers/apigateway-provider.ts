import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { type ConsoleLogger, getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import type { MaskedLogSinks, MaskerFn } from '../masked-retry-logger.js';
import { pasteableAwsCommand, type PasteableAwsCommand } from '../replacement-protection-advice.js';
import {
  getCreateClient,
  orphanCommandRegionArg,
  wrapMaskedError,
  create,
  update,
  deleteImpl,
  getAttribute,
  buildStageArn,
  applyTagDiff,
  sleep,
} from './apigateway/core.js';
import {
  createAccount,
  updateAccount,
  deleteAccount,
  updateAccountWithRetry,
} from './apigateway/account.js';
import {
  createAuthorizer,
  updateAuthorizer,
  deleteAuthorizer,
  getAuthorizerAttribute,
} from './apigateway/authorizer.js';
import {
  createResource,
  updateResource,
  deleteResource,
  getResourceAttribute,
  createDeployment,
  updateDeployment,
  deleteDeployment,
  getDeploymentAttribute,
} from './apigateway/resource-deployment.js';
import { createStage, updateStage, deleteStage, getStageAttribute } from './apigateway/stage.js';
import {
  createMethod,
  priorAttemptLeftMethod,
  updateMethod,
  deleteMethod,
  getMethodAttribute,
} from './apigateway/method.js';
import {
  createRestApi,
  updateRestApi,
  deleteRestApi,
  getRestApiAttribute,
  readCurrentStateRestApi,
  importRestApi,
} from './apigateway/rest-api.js';
import {
  canonicalizeDriftProperties,
  getDriftUnknownPaths,
  getDriftUnorderedPaths,
  readCurrentState,
  readCurrentStateAuthorizer,
  readCurrentStateResource,
  readCurrentStateDeployment,
  readCurrentStateStage,
  readCurrentStateAccount,
  readCurrentStateMethod,
  importImpl,
} from './apigateway/read-state.js';

export { resetApiGatewayCreateRetryStateForTests, methodChildCalls } from './apigateway/shared.js';

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
 * - AWS::ApiGateway::RestApi (the REST API itself; go-to-k/cdkd#6139)
 *
 * These resource types have issues with Cloud Control API:
 * - Account: Needs IAM trust propagation retry logic
 * - Resource: Needs parent ID resolution from properties
 * - Deployment: Needs RestApiId from Ref resolution
 * - Stage: Needs RestApiId, StageName, DeploymentId from properties
 */
export class ApiGatewayProvider implements ResourceProvider {
  apiGatewayClient: APIGatewayClient;
  logger: ConsoleLogger = getLogger().child('ApiGatewayProvider');

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
        'AccessLogSetting',
        'CacheClusterEnabled',
        'CacheClusterSize',
        'CanarySetting',
        'ClientCertificateId',
        'DocumentationVersion',
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
    [
      'AWS::ApiGateway::RestApi',
      new Set([
        'Name',
        'Description',
        'Version',
        'Body',
        'BodyS3Location',
        'Mode',
        'FailOnWarnings',
        'Parameters',
        'CloneFrom',
        'Policy',
        'EndpointConfiguration',
        'BinaryMediaTypes',
        'MinimumCompressionSize',
        'ApiKeySourceType',
        'DisableExecuteApiEndpoint',
        'SecurityPolicy',
        'EndpointAccessMode',
        'Tags',
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
        [
          // Issue #2762, measured in us-east-1 (request 2571bd53-7f09-4cbd-9c38-0bff4edf32ec):
          // a stage-less CreateDeployment with canarySettings is refused on both routes.
          'DeploymentCanarySettings',
          'API Gateway requires StageName for a canary deployment ("Non null and non empty stageName must be provided for canary deployment"), and StageName is not handled here, so a valid canary Deployment routes to Cloud Control; declare AWS::ApiGateway::Stage with CanarySetting for an SDK-routed canary',
        ],
      ]),
    ],
  ]);

  /**
   * Issue #1160: a `CloudWatchRoleArn` REMOVED from the template is cleared,
   * as CloudFormation clears it (measured by a CFn A/B in us-east-1).
   * `UpdateAccount` is a PATCH, so with no operation for the removed key the
   * role ARN would stay set on the region's account. `''` is the clear value
   * `deleteAccount` sends; `updateAccountWithRetry` forwards it verbatim as
   * `replace /cloudwatchRoleArn ''`.
   */
  removalDefaults = new Map<string, ReadonlyMap<string, unknown>>([
    ['AWS::ApiGateway::Account', new Map<string, unknown>([['CloudWatchRoleArn', '']])],
  ]);

  /** Maximum number of retries for IAM propagation delays */
  static readonly MAX_IAM_RETRIES = 3;
  /** Delay between IAM propagation retries (ms) - exponential backoff */
  static readonly IAM_RETRY_DELAY_MS = 10000;

  constructor() {
    const awsClients = getAwsClients();
    this.apiGatewayClient = awsClients.apiGateway;
  }

  createClient: Promise<APIGatewayClient> | undefined;

  getCreateClient(): Promise<APIGatewayClient> {
    return getCreateClient.call(this);
  }

  orphanCommandRegionArg(
    aws: ReturnType<typeof pasteableAwsCommand>
  ): Promise<PasteableAwsCommand> {
    return orphanCommandRegionArg.call(this, aws);
  }

  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedError.call(this, mask, error, build);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getAttribute(physicalId: string, resourceType: string, attributeName: string): Promise<unknown> {
    return getAttribute.call(this, physicalId, resourceType, attributeName);
  }

  createAccount(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createAccount.call(this, logicalId, resourceType, properties, log);
  }

  updateAccount(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    return updateAccount.call(this, logicalId, physicalId, resourceType, properties, log);
  }

  deleteAccount(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteAccount.call(this, logicalId, physicalId, resourceType, context);
  }

  updateAccountWithRetry(
    cloudWatchRoleArn: string | undefined,
    logicalId: string,
    _resourceType: string,
    log: MaskedLogSinks
  ): Promise<void> {
    return updateAccountWithRetry.call(this, cloudWatchRoleArn, logicalId, _resourceType, log);
  }

  createAuthorizer(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createAuthorizer.call(this, logicalId, resourceType, properties, log);
  }

  updateAuthorizer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    return updateAuthorizer.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log
    );
  }

  deleteAuthorizer(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteAuthorizer.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getAuthorizerAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    return getAuthorizerAttribute.call(this, physicalId, attributeName);
  }

  createResource(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createResource.call(this, logicalId, resourceType, properties, log);
  }

  updateResource(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    return updateResource.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log
    );
  }

  deleteResource(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteResource.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getResourceAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    return getResourceAttribute.call(this, physicalId, _resourceType, attributeName);
  }

  createDeployment(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createDeployment.call(this, logicalId, resourceType, properties, log);
  }

  updateDeployment(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    return updateDeployment.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log
    );
  }

  deleteDeployment(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteDeployment.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getDeploymentAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    return getDeploymentAttribute.call(this, physicalId, attributeName);
  }

  createStage(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createStage.call(this, logicalId, resourceType, properties, log);
  }

  updateStage(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceUpdateResult> {
    return updateStage.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log
    );
  }

  deleteStage(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteStage.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  getStageAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    return getStageAttribute.call(this, physicalId, attributeName);
  }

  createMethod(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return createMethod.call(this, logicalId, resourceType, properties, log, context);
  }

  priorAttemptLeftMethod(
    logicalId: string,
    physicalId: string,
    log: MaskedLogSinks
  ): Promise<boolean> {
    return priorAttemptLeftMethod.call(this, logicalId, physicalId, log);
  }

  updateMethod(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    previousIsLiveReadback = false
  ): Promise<ResourceUpdateResult> {
    return updateMethod.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      previousIsLiveReadback
    );
  }

  deleteMethod(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteMethod.call(this, logicalId, physicalId, resourceType, context);
  }

  getMethodAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    return getMethodAttribute.call(this, physicalId, attributeName);
  }

  createRestApi(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    log: MaskedLogSinks
  ): Promise<ResourceCreateResult> {
    return createRestApi.call(this, logicalId, resourceType, properties, log);
  }

  updateRestApi(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    log: MaskedLogSinks,
    changedProperties?: ReadonlySet<string>,
    noEchoOnlyChanged?: ReadonlySet<string>,
    keptNoEchoOnly?: (propertyName: string) => void
  ): Promise<ResourceUpdateResult> {
    return updateRestApi.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      log,
      changedProperties,
      noEchoOnlyChanged,
      keptNoEchoOnly
    );
  }

  deleteRestApi(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context?: DeleteContext
  ): Promise<void> {
    return deleteRestApi.call(this, logicalId, physicalId, resourceType, context);
  }

  getRestApiAttribute(physicalId: string, attributeName: string): Promise<unknown> {
    return getRestApiAttribute.call(this, physicalId, attributeName);
  }

  readCurrentStateRestApi(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateRestApi.call(this, physicalId, properties);
  }

  importRestApi(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importRestApi.call(this, input);
  }

  buildStageArn(restApiId: string, stageName: string): Promise<string | undefined> {
    return buildStageArn.call(this, restApiId, stageName);
  }

  applyTagDiff(
    resourceArn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown,
    log: MaskedLogSinks,
    displayArn: string
  ): Promise<void> {
    return applyTagDiff.call(
      this,
      resourceArn,
      resourceType,
      logicalId,
      oldTagsRaw,
      newTagsRaw,
      log,
      displayArn
    );
  }

  sleep(ms: number): Promise<void> {
    return sleep.call(this, ms);
  }

  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    return canonicalizeDriftProperties.call(this, resourceType, properties);
  }

  getDriftUnknownPaths(resourceType: string): string[] {
    return getDriftUnknownPaths.call(this, resourceType);
  }

  getDriftUnorderedPaths(resourceType: string): string[] {
    return getDriftUnorderedPaths.call(this, resourceType);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, resourceType, properties);
  }

  readCurrentStateAuthorizer(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateAuthorizer.call(this, physicalId, properties);
  }

  readCurrentStateResource(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateResource.call(this, physicalId, properties);
  }

  readCurrentStateDeployment(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateDeployment.call(this, physicalId, properties);
  }

  readCurrentStateStage(
    physicalId: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateStage.call(this, physicalId, properties);
  }

  readCurrentStateAccount(): Promise<Record<string, unknown> | undefined> {
    return readCurrentStateAccount.call(this);
  }

  readCurrentStateMethod(
    physicalId: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentStateMethod.call(this, physicalId);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
