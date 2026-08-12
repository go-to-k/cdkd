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
import { clearOnUpdateRemoval } from '../update-removal.js';
import { replayWarn, requireConfigString } from '../config-shape.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
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
    properties: Record<string, unknown>,
    context?: CreateContext
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

    // `|| 'NONE'` turned a blank / null AuthType into a PUBLIC function URL
    // (issue #1493). The #1490 sweep of this idiom keyed on the `as string`
    // cast and so missed this typed-cast spelling.
    //
    // `replayWarn`: on a rollback's reverse-replacement replay the properties
    // are a cdkd STATE record the user cannot edit, so the refusal downgrades
    // to a warning there (issue #1544) — the resource would otherwise be
    // unrestorable. Template-path creates keep the refusal.
    //
    // An ABSENT `AuthType` is NOT a malformed value, so neither the refusal
    // nor `replayWarn` fires for it — the read simply takes the `'NONE'`
    // default. On a template-path create that is correct and silent: the user
    // declared no auth type and CFn's own default is `NONE`. On a STATE REPLAY
    // it is not, and issue #1654 is what made it reachable: `update()`'s
    // OMITTED arm now DROPS `AuthType` from the recorded bag when it cannot
    // vouch for the value, so a later reverse-replacement replay reads a
    // record with no `AuthType` and would silently recreate the function URL
    // as PUBLIC — turning a loud problem into a silent one, which is worse
    // than the malformed-value-in-state behavior the drop replaced. The
    // announcement is what keeps the drop honest, so warn before defaulting.
    // Deliberately NOT a refusal: refusing would make the URL unrestorable,
    // which is the whole reason this site downgrades at all.
    if (context?.replayingState === true && properties['AuthType'] === undefined) {
      this.logger.warn(
        `Lambda URL ${logicalId} is being restored from a cdkd state record that ` +
          `carries no AuthType, so cdkd cannot vouch for the auth type the URL had. ` +
          `Creating it with the default (NONE), which makes the function URL PUBLIC. ` +
          `Verify the URL's auth type after the rollback completes and set ` +
          `'authType' explicitly in your CDK code if it should be AWS_IAM.`
      );
    }
    const authType = requireConfigString(
      properties['AuthType'],
      'NONE',
      'AWS::Lambda::Url AuthType',
      replayWarn(this.logger, context)
    ) as FunctionUrlAuthType;

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
    resourceType: string,
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

    // `|| 'NONE'` turned a blank / null AuthType into a PUBLIC function URL
    // (issue #1493). The #1490 sweep of this idiom keyed on the `as string`
    // cast and so missed this typed-cast spelling.
    //
    // The refusal is DOWNGRADED to a warning here (issue #1551), unlike the
    // create-path site: `rollback-executor.ts` replays a rollback via
    // `update(..., previousState.properties, ...)` and `cdkd drift --revert`
    // does the same, so this desired bag can be a historical cdkd STATE
    // record the user cannot edit from the template. A hard refusal would
    // make such a URL un-rollbackable.
    //
    // The fallback is the PREVIOUS value, never the create default: warning
    // and then defaulting to `'NONE'` would silently flip a live IAM-guarded
    // function URL to PUBLIC — strictly worse than the pre-guard behavior,
    // where AWS rejected the junk value loudly and the auth stayed put. When
    // the previous side is unusable too (or absent), `AuthType` is OMITTED
    // from the update: `UpdateFunctionUrlConfig` has merge semantics (the
    // same live-probed behavior the `InvokeMode` / `Cors` handling below
    // relies on), so the live auth type is retained rather than reset.
    let authTypeUnusable = false;
    const requestedAuthType = requireConfigString(
      properties['AuthType'],
      'NONE',
      'AWS::Lambda::Url AuthType',
      {
        onUnusable: (message) => {
          authTypeUnusable = true;
          this.logger.warn(
            `${message} The function URL's existing auth type is kept for this ` +
              `update rather than reset to the default (NONE), which would make ` +
              `the URL public.`
          );
        },
      }
    ) as FunctionUrlAuthType;
    const previousAuthType = previousProperties['AuthType'];
    const authType = authTypeUnusable
      ? typeof previousAuthType === 'string' && previousAuthType.trim() !== ''
        ? (previousAuthType as FunctionUrlAuthType)
        : undefined
      : requestedAuthType;

    // issue #1654: a SUBSTITUTED value is the same class as a dropped key
    // (.claude/rules/providers.md, #1633) — the deploy SUCCEEDS, so without
    // this the engine records the MALFORMED desired `AuthType` while AWS
    // holds the previous / live one. `readCurrentState` reads `AuthType`
    // back, so that mismatch is permanent phantom drift: re-reported by
    // every `cdkd drift` and re-issued by `drift --revert`, which calls
    // `update()` again. So answer with the bag actually delivered.
    //
    // The two arms differ because what reached AWS differs:
    //
    //  - PREVIOUS-VALUE arm: `AuthType: <previous>` was genuinely SENT, so
    //    that is what state must describe.
    //  - OMITTED arm (the previous side is unusable / absent too): NOTHING
    //    was sent for `AuthType`, so the key is DROPPED from the effective
    //    bag. Three candidates were considered and this is the only one that
    //    never lets state claim an auth type cdkd cannot vouch for.
    //    Recording the create default `'NONE'` would describe a PUBLIC URL
    //    that may in fact be IAM-guarded — the exact outcome the guard above
    //    exists to prevent. Recording the live value off the
    //    `UpdateFunctionUrlConfig` RESPONSE would be what AWS HOLDS rather
    //    than what cdkd SENT: the rules file puts a read-back value in
    //    `observedProperties`, not in `properties`, because `properties` is
    //    the DESIRED baseline the #1160 absent-field removal derivation
    //    reads — and it would launder a template cdkd could not apply into a
    //    clean-looking record. A dropped key is never compared by
    //    `drift-calculator` (it only descends into keys present in state),
    //    so the phantom drift is gone either way.
    //
    //    Two consequences of the DROP that are easy to assume away:
    //    the malformed template keeps re-warning on every later deploy for
    //    most shapes, but NOT for `AuthType: null` — once the key is gone
    //    from the previous side, the `changed` loop above compares
    //    `JSON.stringify(null ?? null)` on both sides, finds no change, and
    //    returns early without warning or calling AWS. That is benign (the
    //    live auth type is untouched and state still claims nothing), but it
    //    means the announcement is not guaranteed to repeat. And the record
    //    with no `AuthType` is later readable by `create()` on a
    //    reverse-replacement replay, where the absent key would silently
    //    default to a PUBLIC `'NONE'` — which is why `create()` carries its
    //    own replay warning for exactly that shape (see the note there).
    //
    // Deliberately NOT paired with a `canonicalizeDesiredProperties` twin:
    // this is a SUBSTITUTION, not a pure narrowing of the desired bag, so
    // canonicalizing the desired side would compare a previous side holding
    // a valid `AuthType` against a desired side with the key removed and
    // derive a REMOVAL (issue #1612's carve-out).
    let effectiveProperties: Record<string, unknown> | undefined;
    if (authTypeUnusable) {
      effectiveProperties = { ...properties };
      if (authType === undefined) delete effectiveProperties['AuthType'];
      else effectiveProperties['AuthType'] = authType;
    }

    const updateParams: import('@aws-sdk/client-lambda').UpdateFunctionUrlConfigCommandInput = {
      FunctionName: physicalId,
      ...(authType !== undefined && { AuthType: authType }),
    };
    // issue #1160: UpdateFunctionUrlConfig uses merge semantics (live-probed
    // 2026-07-27: an update omitting InvokeMode / Cors retains the live
    // values), while CFn resets a property removed from the template to its
    // default. Route both mutable optional fields through
    // clearOnUpdateRemoval with the live-probed clear shapes:
    //   InvokeMode -> 'BUFFERED' (the documented CFn/API default)
    //   Cors       -> {} (an empty Cors object clears CORS entirely —
    //                 GetFunctionUrlConfig omits the field afterwards)
    const invokeMode = clearOnUpdateRemoval(
      properties['InvokeMode'] as InvokeMode | undefined,
      previousProperties['InvokeMode'] as InvokeMode | undefined,
      'BUFFERED'
    );
    if (invokeMode !== undefined) updateParams.InvokeMode = invokeMode;
    // Class 2 sanitize: `readCurrentState` always-emits a `Cors` placeholder
    // with empty arrays for `AllowOrigins` / `AllowMethods` / `AllowHeaders`
    // / `ExposeHeaders` so a console-side CORS toggle on a URL configured
    // without CORS surfaces as drift. On `cdkd drift --revert` that
    // placeholder round-trips back through `update()` — sending an
    // all-empty `Cors` to AWS would needlessly mutate the URL to
    // "CORS-configured-but-empty" instead of "no CORS". Mirror
    // `serializeRedrivePolicy` in `sqs-queue-provider.ts` and normalize the
    // empty-shape placeholder to "no CORS" on BOTH sides before the removal
    // check — so a placeholder on the new side with real previous CORS still
    // clears, and a placeholder-only previous never triggers a spurious
    // clear call.
    const newCorsRaw = properties['Cors'] as Record<string, unknown> | undefined;
    const prevCorsRaw = previousProperties['Cors'] as Record<string, unknown> | undefined;
    const newCorsBuilt = newCorsRaw ? this.buildCorsConfig(newCorsRaw) : undefined;
    const prevCorsBuilt = prevCorsRaw ? this.buildCorsConfig(prevCorsRaw) : undefined;
    const corsParam = clearOnUpdateRemoval(
      newCorsBuilt && Object.keys(newCorsBuilt).length > 0 ? newCorsBuilt : undefined,
      prevCorsBuilt && Object.keys(prevCorsBuilt).length > 0 ? prevCorsBuilt : undefined,
      {}
    );
    if (corsParam !== undefined) updateParams.Cors = corsParam;

    try {
      const response = await this.lambdaClient.send(
        new UpdateFunctionUrlConfigCommand(updateParams)
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          FunctionUrl: response.FunctionUrl,
          FunctionArn: response.FunctionArn,
        },
        ...(effectiveProperties && { effectiveProperties }),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Lambda URL ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
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
   * leaving CORS unset. `update()` normalizes an empty build to "no CORS"
   * on both comparison sides (issue #1160 — an empty `Cors` object is the
   * live-probed CLEAR shape there, sent only on a real removal); `create()`
   * passes the build through as-is (template values, never placeholders,
   * and `Cors: {}` on create means "no CORS" per the same probe). `MaxAge`
   * uses `!== undefined` so the valid AWS input `MaxAge: 0` (= "do not
   * cache preflight responses") is preserved.
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
