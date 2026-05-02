import {
  LambdaClient,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionUrlConfigCommand,
  GetFunctionUrlConfigCommand,
  UpdateFunctionUrlConfigCommand,
  ResourceNotFoundException,
  type FunctionUrlAuthType,
  type InvokeMode,
} from '@aws-sdk/client-lambda';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS Lambda Function URL Provider
 *
 * Implements resource provisioning for AWS::Lambda::Url using the Lambda SDK.
 * WHY: CreateFunctionUrlConfig is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class LambdaUrlProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private logger = getLogger().child('LambdaUrlProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::Url',
      new Set(['TargetFunctionArn', 'AuthType', 'Qualifier', 'InvokeMode', 'Cors']),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
  }

  /**
   * Create a Lambda Function URL
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Lambda URL ${logicalId}`);

    const targetFunctionArn = properties['TargetFunctionArn'] as string;
    if (!targetFunctionArn) {
      throw new ProvisioningError(
        `TargetFunctionArn is required for Lambda URL ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const authType = (properties['AuthType'] as FunctionUrlAuthType) || 'NONE';

    try {
      const cors = properties['Cors'] as Record<string, unknown> | undefined;

      const createParams: import('@aws-sdk/client-lambda').CreateFunctionUrlConfigCommandInput = {
        FunctionName: targetFunctionArn,
        AuthType: authType,
      };
      if (properties['Qualifier']) createParams.Qualifier = properties['Qualifier'] as string;
      if (properties['InvokeMode'])
        createParams.InvokeMode = properties['InvokeMode'] as InvokeMode;
      if (cors) {
        createParams.Cors = this.buildCorsConfig(cors);
      }

      const response = await this.lambdaClient.send(
        new CreateFunctionUrlConfigCommand(createParams)
      );

      const functionUrl = response.FunctionUrl;
      const functionArn = response.FunctionArn;

      this.logger.debug(`Successfully created Lambda URL ${logicalId}: ${functionUrl}`);

      return {
        physicalId: functionArn || targetFunctionArn,
        attributes: {
          FunctionUrl: functionUrl,
          FunctionArn: functionArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Lambda URL ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        targetFunctionArn,
        cause
      );
    }
  }

  /**
   * Update a Lambda Function URL
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Lambda URL ${logicalId}: ${physicalId}`);

    const authType = (properties['AuthType'] as FunctionUrlAuthType) || 'NONE';
    const cors = properties['Cors'] as Record<string, unknown> | undefined;

    const updateParams: import('@aws-sdk/client-lambda').UpdateFunctionUrlConfigCommandInput = {
      FunctionName: physicalId,
      AuthType: authType,
    };
    if (properties['InvokeMode']) updateParams.InvokeMode = properties['InvokeMode'] as InvokeMode;
    if (cors) {
      updateParams.Cors = this.buildCorsConfig(cors);
    }

    const response = await this.lambdaClient.send(new UpdateFunctionUrlConfigCommand(updateParams));

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        FunctionUrl: response.FunctionUrl,
        FunctionArn: response.FunctionArn,
      },
    };
  }

  /**
   * Delete a Lambda Function URL
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Lambda URL ${logicalId}: ${physicalId}`);

    try {
      await this.lambdaClient.send(
        new DeleteFunctionUrlConfigCommand({ FunctionName: physicalId })
      );
      this.logger.debug(`Successfully deleted Lambda URL ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.lambdaClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Lambda URL ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Lambda URL ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing Lambda Function
   * URL.
   *
   * CloudFormation's `AWS::Lambda::Url` exposes `FunctionArn` and
   * `FunctionUrl`. Both come from `GetFunctionUrlConfig`. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-url.html#aws-resource-lambda-url-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    try {
      const resp = await this.lambdaClient.send(
        new GetFunctionUrlConfigCommand({ FunctionName: physicalId })
      );
      switch (attributeName) {
        case 'FunctionArn':
          return resp.FunctionArn;
        case 'FunctionUrl':
          return resp.FunctionUrl;
        default:
          return undefined;
      }
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Adopt an existing Lambda Function URL into cdkd state.
   *
   * **Explicit override only.** A `Lambda::Url` is a configuration attached
   * to a Lambda function — it has no standalone identity (the natural
   * physical id is the parent function's ARN/name) and `FunctionUrlConfig`
   * is not independently taggable. There is no `aws:cdk:path` tag to look
   * up by; only the parent function carries the CDK path tag.
   *
   * Users adopting an existing function URL should pass
   * `--resource <logicalId>=<functionArnOrName>` (matching the physical id
   * format returned by `create()`).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }

  /**
   * Build CORS configuration from CDK properties
   */
  private buildCorsConfig(cors: Record<string, unknown>): import('@aws-sdk/client-lambda').Cors {
    const config: import('@aws-sdk/client-lambda').Cors = {};
    if (cors['AllowOrigins']) config.AllowOrigins = cors['AllowOrigins'] as string[];
    if (cors['AllowMethods']) config.AllowMethods = cors['AllowMethods'] as string[];
    if (cors['AllowHeaders']) config.AllowHeaders = cors['AllowHeaders'] as string[];
    if (cors['ExposeHeaders']) config.ExposeHeaders = cors['ExposeHeaders'] as string[];
    if (cors['MaxAge']) config.MaxAge = cors['MaxAge'] as number;
    if (cors['AllowCredentials'] !== undefined)
      config.AllowCredentials = cors['AllowCredentials'] as boolean;
    return config;
  }
}
