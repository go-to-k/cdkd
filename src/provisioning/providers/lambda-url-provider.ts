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
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Lambda URL ${logicalId}: ${physicalId}`);

    // Diff-based no-op: when `cdkd drift --revert` round-trips the
    // observed snapshot back through `update()` on a no-drift resource,
    // the new and previous property maps are identical. Skip the AWS
    // call entirely in that case so the round-trip is a logical no-op
    // (matches the SNS / SQS provider pattern; mechanical guard
    // documented in `tests/unit/provisioning/lambda-url-provider-roundtrip.test.ts`).
    const handled = this.handledProperties.get('AWS::Lambda::Url') ?? new Set<string>();
    let changed = false;
    for (const key of handled) {
      if (
        JSON.stringify(properties[key] ?? null) !== JSON.stringify(previousProperties[key] ?? null)
      ) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return {
        physicalId,
        wasReplaced: false,
        attributes: {},
      };
    }

    const authType = (properties['AuthType'] as FunctionUrlAuthType) || 'NONE';
    const cors = properties['Cors'] as Record<string, unknown> | undefined;

    const updateParams: import('@aws-sdk/client-lambda').UpdateFunctionUrlConfigCommandInput = {
      FunctionName: physicalId,
      AuthType: authType,
    };
    if (properties['InvokeMode'] !== undefined)
      updateParams.InvokeMode = properties['InvokeMode'] as InvokeMode;
    // Class 2 sanitize: `readCurrentState` always-emits a `Cors` placeholder
    // with empty arrays for `AllowOrigins` / `AllowMethods` / `AllowHeaders`
    // / `ExposeHeaders` so a console-side CORS toggle on a URL configured
    // without CORS surfaces as drift. On `cdkd drift --revert` that
    // placeholder round-trips back through `update()` — sending an
    // all-empty `Cors` to AWS would needlessly mutate the URL to
    // "CORS-configured-but-empty" instead of "no CORS". Mirror
    // `serializeRedrivePolicy` in `sqs-queue-provider.ts` and treat the
    // empty-shape placeholder as "no CORS" (omit `Cors` from the
    // UpdateFunctionUrlConfig input entirely).
    if (cors) {
      const builtCors = this.buildCorsConfig(cors);
      if (Object.keys(builtCors).length > 0) {
        updateParams.Cors = builtCors;
      }
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
   * Read the AWS-current Lambda Function URL configuration in CFn-property
   * shape.
   *
   * Issues `GetFunctionUrlConfig` with the parent function's ARN/name (the
   * physical id) and surfaces `AuthType`, `InvokeMode`, and `Cors`.
   * AWS-managed fields (`FunctionUrl`, `FunctionArn`, `CreationTime`,
   * `LastModifiedTime`) are filtered at the wire layer.
   *
   * `TargetFunctionArn` is surfaced from `physicalId` (the create() flow
   * stores the parent function's ARN/name there). `Qualifier` is NOT
   * available from `GetFunctionUrlConfig` (it's only an input on Create);
   * cdkd state stores it but AWS does not surface it back, so we omit it
   * from the snapshot — the comparator's "key absent in state never
   * drifts" rule handles the omission cleanly when state lacks Qualifier
   * too, and cases where state HAS Qualifier surface as drift only when
   * the qualifier was changed via Update (which the SDK supports through
   * `physicalId` rather than the qualifier itself).
   *
   * Returns `undefined` when the URL config is gone
   * (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let resp;
    try {
      resp = await this.lambdaClient.send(
        new GetFunctionUrlConfigCommand({ FunctionName: physicalId })
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }

    const result: Record<string, unknown> = {
      TargetFunctionArn: physicalId,
    };

    if (resp.AuthType !== undefined) result['AuthType'] = resp.AuthType;
    if (resp.InvokeMode !== undefined) result['InvokeMode'] = resp.InvokeMode;
    // Only surface the Cors keys cdkd's `create()` accepts; the SDK
    // returns the same shape but defensively-copy the arrays so the
    // comparator can do equality cheaply. Always emit so a console-side
    // CORS toggle on a URL configured without CORS at deploy time
    // surfaces as drift.
    const cors: Record<string, unknown> = {
      AllowOrigins: resp.Cors?.AllowOrigins ? [...resp.Cors.AllowOrigins] : [],
      AllowMethods: resp.Cors?.AllowMethods ? [...resp.Cors.AllowMethods] : [],
      AllowHeaders: resp.Cors?.AllowHeaders ? [...resp.Cors.AllowHeaders] : [],
      ExposeHeaders: resp.Cors?.ExposeHeaders ? [...resp.Cors.ExposeHeaders] : [],
    };
    if (resp.Cors?.MaxAge !== undefined) cors['MaxAge'] = resp.Cors.MaxAge;
    if (resp.Cors?.AllowCredentials !== undefined) {
      cors['AllowCredentials'] = resp.Cors.AllowCredentials;
    }
    result['Cors'] = cors;

    return result;
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
   * Build CORS configuration from CDK properties.
   *
   * Empty arrays from `readCurrentState`'s always-emit placeholder
   * (`AllowOrigins: []`, `AllowMethods: []`, `AllowHeaders: []`,
   * `ExposeHeaders: []`) are intentionally dropped here — emitting them
   * to AWS would configure CORS with empty allowlists instead of
   * leaving CORS unset. The caller (`update()` / `create()`) treats an
   * empty `Cors` object as "no CORS configured" and omits it from the
   * SDK input. `MaxAge` uses `!== undefined` so the valid AWS input
   * `MaxAge: 0` (= "do not cache preflight responses") is preserved.
   */
  private buildCorsConfig(cors: Record<string, unknown>): import('@aws-sdk/client-lambda').Cors {
    const config: import('@aws-sdk/client-lambda').Cors = {};
    const allowOrigins = cors['AllowOrigins'];
    if (Array.isArray(allowOrigins) && allowOrigins.length > 0) {
      config.AllowOrigins = allowOrigins as string[];
    }
    const allowMethods = cors['AllowMethods'];
    if (Array.isArray(allowMethods) && allowMethods.length > 0) {
      config.AllowMethods = allowMethods as string[];
    }
    const allowHeaders = cors['AllowHeaders'];
    if (Array.isArray(allowHeaders) && allowHeaders.length > 0) {
      config.AllowHeaders = allowHeaders as string[];
    }
    const exposeHeaders = cors['ExposeHeaders'];
    if (Array.isArray(exposeHeaders) && exposeHeaders.length > 0) {
      config.ExposeHeaders = exposeHeaders as string[];
    }
    if (cors['MaxAge'] !== undefined) config.MaxAge = cors['MaxAge'] as number;
    if (cors['AllowCredentials'] !== undefined)
      config.AllowCredentials = cors['AllowCredentials'] as boolean;
    return config;
  }
}
