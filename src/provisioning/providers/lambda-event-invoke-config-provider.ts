import {
  LambdaClient,
  PutFunctionEventInvokeConfigCommand,
  DeleteFunctionEventInvokeConfigCommand,
  GetFunctionEventInvokeConfigCommand,
  ResourceNotFoundException,
  type DestinationConfig,
} from '@aws-sdk/client-lambda';
import { getLogger } from '../../utils/logger.js';
import { canonicalLambdaFunctionName } from '../../utils/lambda-function-name.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { replayWarn, requireConfigString } from '../config-shape.js';
import { packCompositeId, type CompositeIdOptions } from '../composite-id.js';
import type { CreateContext } from '../../types/resource.js';
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
  private buildPhysicalId(
    logicalId: string,
    functionName: string,
    qualifier: string,
    options?: CompositeIdOptions
  ): string {
    return packCompositeId(
      'AWS::Lambda::EventInvokeConfig',
      logicalId,
      [
        { name: 'functionName', value: functionName },
        { name: 'qualifier', value: qualifier },
      ],
      options
    );
  }

  /**
   * Split a `<FunctionName>|<Qualifier>` physical id back into its parts.
   * Tolerates a bare function name (defaults the qualifier to `$LATEST`).
   * Splits on the FIRST `|`, which is unambiguous: a Lambda function name is
   * `[a-zA-Z0-9-_]+` and a function ARN contains no `|`, so the separator can
   * never appear inside the FunctionName segment.
   */
  /**
   * The id the config is addressed by AFTER an in-place Put (issue #4118). A
   * re-spelling of the same function keeps `physicalId`. When the function
   * NAME itself moved -- the config was classified in place against the
   * PRE-deploy value of a `Ref` / `Fn::GetAtt` whose function is being
   * replaced in the same deploy -- the Put landed on the new function, so the
   * id must name it, or drift and a later delete address the old one.
   */
  private physicalIdAfterUpdate(
    logicalId: string,
    physicalId: string,
    properties: Record<string, unknown>
  ): string {
    const next = properties['FunctionName'];
    if (typeof next !== 'string') return physicalId;
    const nextName = canonicalLambdaFunctionName(next);
    const { functionName: recorded, qualifier } = this.parsePhysicalId(physicalId);
    if (canonicalLambdaFunctionName(recorded) === nextName) return physicalId;
    const nextQualifier =
      typeof properties['Qualifier'] === 'string' ? properties['Qualifier'] : qualifier;
    return this.buildPhysicalId(logicalId, nextName, nextQualifier);
  }

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
    // Shared by create() and update(), so this one WARNS: a rollback replays
    // through `update()` with a historical cdkd STATE record as the desired
    // bag, and refusing there could leave the resource un-rollbackable. The
    // create path refuses at its own call site before reaching this helper
    // (issue #1513). `coerceNumber` because an unquoted YAML `Qualifier: 1` is
    // a NUMBER today and deploys fine.
    //
    // Who reaches the warning: `create()` only on a replay (its own read runs
    // first and refuses on the template path), and `update()` on every caller.
    // The update arm KEEPS the warning on the template path too, decided when
    // the #3728 split was widened (issue #3740): `Qualifier` is createOnly (CFn
    // schema), so a changed value is a REPLACEMENT and never reaches
    // `update()`. A malformed value here is one the recorded configuration
    // already carries, and the only template edit that changes it replaces the
    // resource.
    const qualifier = requireConfigString(
      properties['Qualifier'],
      '$LATEST',
      'AWS::Lambda::EventInvokeConfig Qualifier',
      { coerceNumber: true, onUnusable: (message) => this.logger.warn(message) }
    );
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
    properties: Record<string, unknown>,
    context?: CreateContext
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
    const qualifier = requireConfigString(
      properties['Qualifier'],
      '$LATEST',
      'AWS::Lambda::EventInvokeConfig Qualifier',
      { coerceNumber: true, ...replayWarn(this.logger, context) }
    );

    // Refuse a `|` in either segment BEFORE `PutFunctionEventInvokeConfig`
    // runs (issue #1672). Neither is realistically pipe-capable — a Lambda
    // function NAME is `[a-zA-Z0-9-_]+`, a function ARN carries no `|`, and a
    // qualifier is a version number or an alias name — which is exactly the
    // premise `parsePhysicalId` already documents for splitting on the FIRST
    // separator. This makes that premise ENFORCED rather than assumed.
    // Computed before the call so a refusal cannot leave a configuration AWS
    // has already applied without a state record.
    const physicalId = this.buildPhysicalId(
      logicalId,
      functionName,
      qualifier,
      // A reverse-replacement rollback creates from a STATE record, so the
      // refusal downgrades to a warning, matching the `Qualifier` guard above.
      {
        // Issue #2176: the refusal QUOTES the offending segment value, on the
        // thrown arm (durable) and the warn arm (terminal) alike, so the masker
        // goes through unconditionally -- it is absent on the paths that have no
        // context, where it degrades to identity.
        maskSecrets: context?.maskSecrets,
        ...(context?.replayingState === true && {
          onRefusal: (message: string) => this.logger.warn(message),
        }),
      }
    );

    try {
      await this.lambdaClient.send(
        new PutFunctionEventInvokeConfigCommand(this.buildPutInput(properties))
      );
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
      return {
        physicalId: this.physicalIdAfterUpdate(logicalId, physicalId, properties),
        wasReplaced: false,
        attributes: {},
      };
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
   * Strip a `DestinationConfig.OnSuccess` / `OnFailure` that names no
   * `Destination` from a drift comparison side, and `DestinationConfig`
   * itself once nothing is left (issue #4091). Cloud Control's read handler
   * injects those empty members, so an `observedProperties` bag captured
   * while the resource was on Cloud Control carries them, while this
   * provider's readback -- which reads a `'cc-broken'` record since the
   * exemption -- never does. CloudFormation refuses such a member in a
   * template, so stripping it drops nothing a user declared.
   */
  canonicalizeDriftProperties(
    _resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    // A re-spelled FunctionName (name <-> unqualified ARN) names one function,
    // and the readback emits the NAME from the physical id (issue #4118).
    const fn = properties['FunctionName'];
    const fnName = typeof fn === 'string' ? canonicalLambdaFunctionName(fn) : fn;
    const base = fnName === fn ? properties : { ...properties, FunctionName: fnName };
    const dest = properties['DestinationConfig'];
    if (dest === null || typeof dest !== 'object' || Array.isArray(dest)) return base;
    const members = dest as Record<string, unknown>;
    const empty = (key: string): boolean => {
      const m = members[key];
      return (
        m !== null &&
        typeof m === 'object' &&
        !Array.isArray(m) &&
        (m as Record<string, unknown>)['Destination'] == null
      );
    };
    const stripped = ['OnSuccess', 'OnFailure'].filter((key) => key in members && empty(key));
    if (stripped.length === 0) return base;
    const kept = Object.fromEntries(
      Object.entries(members).filter(([key]) => !stripped.includes(key))
    );
    const out = { ...base };
    if (Object.keys(kept).length === 0) delete out['DestinationConfig'];
    else out['DestinationConfig'] = kept;
    return out;
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
