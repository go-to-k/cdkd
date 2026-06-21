import {
  LambdaClient,
  PutFunctionEventInvokeConfigCommand,
  DeleteFunctionEventInvokeConfigCommand,
  GetFunctionEventInvokeConfigCommand,
  ResourceNotFoundException,
  type DestinationConfig,
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
 * AWS Lambda EventInvokeConfig Provider
 *
 * Implements provisioning for AWS::Lambda::EventInvokeConfig (the async-invoke
 * configuration CDK synthesizes whenever a Function sets `maxEventAge`,
 * `retryAttempts`, or `onFailure` / `onSuccess` destinations).
 *
 * WHY an SDK provider instead of the Cloud Control fallback:
 * `PutFunctionEventInvokeConfig` is a synchronous **full-replace** write —
 * exactly what CloudFormation uses for this type. The Cloud Control UPDATE
 * path instead applies a JSON-patch read-modify-write, and Lambda's
 * EventInvokeConfig read handler returns an AWS-injected empty
 * `DestinationConfig.OnSuccess: {}` even when only `OnFailure` was configured.
 * That empty object then fails Cloud Control model validation on every UPDATE
 * (`#/DestinationConfig/OnSuccess: required key [Destination] not found`), so a
 * common daily pattern — an async Lambda with `onFailure` whose `maxEventAge`
 * or `retryAttempts` is later changed — was undeployable via the CC route.
 * The full-replace SDK call sends exactly the template's DestinationConfig and
 * sidesteps the merge entirely.
 *
 * The physical id is the Cloud Control primaryIdentifier shape
 * `<FunctionName>|<Qualifier>` so import / migration stays consistent with the
 * prior CC-routed behavior.
 */
export class LambdaEventInvokeConfigProvider implements ResourceProvider {
  private lambdaClient: LambdaClient;
  private logger = getLogger().child('LambdaEventInvokeConfigProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::EventInvokeConfig',
      new Set([
        'FunctionName',
        'Qualifier',
        'MaximumEventAgeInSeconds',
        'MaximumRetryAttempts',
        'DestinationConfig',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.lambdaClient = awsClients.lambda;
  }

  /**
   * Compose the Cloud-Control-compatible compound physical id.
   */
  private buildPhysicalId(functionName: string, qualifier: string): string {
    return `${functionName}|${qualifier}`;
  }

  /**
   * Split a `<FunctionName>|<Qualifier>` physical id back into its parts.
   * Tolerates a bare function name (defaults the qualifier to `$LATEST`).
   * Splits on the FIRST `|`, which is unambiguous: a Lambda function name is
   * `[a-zA-Z0-9-_]+` and a function ARN contains no `|`, so the separator can
   * never appear inside the FunctionName segment.
   */
  private parsePhysicalId(physicalId: string): { functionName: string; qualifier: string } {
    const sep = physicalId.indexOf('|');
    if (sep === -1) {
      return { functionName: physicalId, qualifier: '$LATEST' };
    }
    return {
      functionName: physicalId.slice(0, sep),
      qualifier: physicalId.slice(sep + 1),
    };
  }

  /**
   * Build the SDK DestinationConfig from CFn properties.
   *
   * Only emit a sub-key (`OnSuccess` / `OnFailure`) when the template actually
   * carries a `Destination` for it — never send an empty `{}`, which is the
   * exact shape that fails the type's model validation.
   */
  private buildDestinationConfig(
    raw: Record<string, unknown> | undefined
  ): DestinationConfig | undefined {
    if (!raw) return undefined;
    const config: DestinationConfig = {};
    const onSuccess = raw['OnSuccess'] as Record<string, unknown> | undefined;
    if (onSuccess && typeof onSuccess['Destination'] === 'string') {
      config.OnSuccess = { Destination: onSuccess['Destination'] };
    }
    const onFailure = raw['OnFailure'] as Record<string, unknown> | undefined;
    if (onFailure && typeof onFailure['Destination'] === 'string') {
      config.OnFailure = { Destination: onFailure['Destination'] };
    }
    return Object.keys(config).length > 0 ? config : undefined;
  }

  private buildPutInput(
    properties: Record<string, unknown>
  ): import('@aws-sdk/client-lambda').PutFunctionEventInvokeConfigCommandInput {
    const functionName = properties['FunctionName'] as string;
    const qualifier = (properties['Qualifier'] as string | undefined) ?? '$LATEST';
    const input: import('@aws-sdk/client-lambda').PutFunctionEventInvokeConfigCommandInput = {
      FunctionName: functionName,
    };
    // '$LATEST' is the API default; passing it is harmless but omit for clarity
    // when it is the unqualified target.
    if (qualifier !== '$LATEST') input.Qualifier = qualifier;
    if (properties['MaximumEventAgeInSeconds'] !== undefined) {
      input.MaximumEventAgeInSeconds = Number(properties['MaximumEventAgeInSeconds']);
    }
    if (properties['MaximumRetryAttempts'] !== undefined) {
      input.MaximumRetryAttempts = Number(properties['MaximumRetryAttempts']);
    }
    const dest = this.buildDestinationConfig(
      properties['DestinationConfig'] as Record<string, unknown> | undefined
    );
    if (dest) input.DestinationConfig = dest;
    return input;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Lambda EventInvokeConfig ${logicalId}`);

    const functionName = properties['FunctionName'] as string;
    if (!functionName) {
      throw new ProvisioningError(
        `FunctionName is required for Lambda EventInvokeConfig ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const qualifier = (properties['Qualifier'] as string | undefined) ?? '$LATEST';

    try {
      await this.lambdaClient.send(
        new PutFunctionEventInvokeConfigCommand(this.buildPutInput(properties))
      );
      const physicalId = this.buildPhysicalId(functionName, qualifier);
      this.logger.debug(
        `Successfully created Lambda EventInvokeConfig ${logicalId}: ${physicalId}`
      );
      return { physicalId, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Lambda EventInvokeConfig ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        functionName,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Lambda EventInvokeConfig ${logicalId}: ${physicalId}`);

    // Diff-based no-op: `cdkd drift --revert` round-trips the observed snapshot
    // back through update() on a no-drift resource, leaving new === previous.
    // Skip the AWS call so the round-trip stays a logical no-op (matches the
    // Lambda URL / SNS / SQS provider pattern).
    const handled =
      this.handledProperties.get('AWS::Lambda::EventInvokeConfig') ?? new Set<string>();
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
      return { physicalId, wasReplaced: false, attributes: {} };
    }

    try {
      // Full-replace write (Put, not the CC patch) — this is the whole reason
      // this type has an SDK provider. See the class doc comment.
      await this.lambdaClient.send(
        new PutFunctionEventInvokeConfigCommand(this.buildPutInput(properties))
      );
      this.logger.debug(`Successfully updated Lambda EventInvokeConfig ${logicalId}`);
      return { physicalId, wasReplaced: false, attributes: {} };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Lambda EventInvokeConfig ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Lambda EventInvokeConfig ${logicalId}: ${physicalId}`);

    const { functionName, qualifier } = this.parsePhysicalId(physicalId);
    const deleteInput: import('@aws-sdk/client-lambda').DeleteFunctionEventInvokeConfigCommandInput =
      { FunctionName: functionName };
    if (qualifier !== '$LATEST') deleteInput.Qualifier = qualifier;

    try {
      await this.lambdaClient.send(new DeleteFunctionEventInvokeConfigCommand(deleteInput));
      this.logger.debug(`Successfully deleted Lambda EventInvokeConfig ${logicalId}`);
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
        this.logger.debug(
          `Lambda EventInvokeConfig ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Lambda EventInvokeConfig ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * AWS::Lambda::EventInvokeConfig exposes no `Fn::GetAtt` return values, so
   * there is nothing to resolve. Present for interface completeness / orphan
   * rewrites.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- no attributes to fetch
  async getAttribute(
    _physicalId: string,
    _resourceType: string,
    _attributeName: string
  ): Promise<unknown> {
    return undefined;
  }

  /**
   * Read the AWS-current async-invoke configuration in CFn-property shape for
   * `cdkd drift`. Surfaces only the keys cdkd writes; the AWS-injected empty
   * `DestinationConfig.OnSuccess: {}` is dropped so a config set with only
   * `OnFailure` does not show phantom drift.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    const { functionName, qualifier } = this.parsePhysicalId(physicalId);
    let resp;
    try {
      const input: import('@aws-sdk/client-lambda').GetFunctionEventInvokeConfigCommandInput = {
        FunctionName: functionName,
      };
      if (qualifier !== '$LATEST') input.Qualifier = qualifier;
      resp = await this.lambdaClient.send(new GetFunctionEventInvokeConfigCommand(input));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }

    // Emit Qualifier UNCONDITIONALLY (even the default '$LATEST'). CDK always
    // synthesizes `Qualifier: '$LATEST'` into the template for a base function,
    // so cdkd state stores it; the drift comparator walks state keys, so a
    // snapshot that omitted Qualifier would report phantom drift
    // (`'$LATEST'` vs undefined) on every `cdkd drift` for the most common
    // (base-function) async-invoke case. The qualifier is authoritative from
    // the physical id, so always surface it.
    const result: Record<string, unknown> = { FunctionName: functionName, Qualifier: qualifier };
    if (resp.MaximumEventAgeInSeconds !== undefined) {
      result['MaximumEventAgeInSeconds'] = resp.MaximumEventAgeInSeconds;
    }
    if (resp.MaximumRetryAttempts !== undefined) {
      result['MaximumRetryAttempts'] = resp.MaximumRetryAttempts;
    }
    const dest: Record<string, unknown> = {};
    if (resp.DestinationConfig?.OnSuccess?.Destination) {
      dest['OnSuccess'] = { Destination: resp.DestinationConfig.OnSuccess.Destination };
    }
    if (resp.DestinationConfig?.OnFailure?.Destination) {
      dest['OnFailure'] = { Destination: resp.DestinationConfig.OnFailure.Destination };
    }
    if (Object.keys(dest).length > 0) result['DestinationConfig'] = dest;

    return result;
  }

  /**
   * Adopt an existing EventInvokeConfig into cdkd state.
   *
   * **Explicit override only.** The config attaches to a function/qualifier and
   * has no standalone identity or `aws:cdk:path` tag to look up. Users pass
   * `--resource <logicalId>=<FunctionName>|<Qualifier>`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }
    return null;
  }
}
