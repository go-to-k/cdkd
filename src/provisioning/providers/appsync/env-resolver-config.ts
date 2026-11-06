import {
  GetGraphqlApiEnvironmentVariablesCommand,
  PutGraphqlApiEnvironmentVariablesCommand,
  type CachingConfig,
  type ConflictDetectionType,
  type ConflictHandlerType,
  type ResolverLevelMetricsConfig,
  type SyncConfig,
  type CreateResolverCommandInput,
  type UpdateResolverCommandInput,
} from '@aws-sdk/client-appsync';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { requireConfigArray } from '../../config-shape.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import type { EnvironmentVariablesRecord } from './shared.js';
import type { AppSyncProvider } from '../appsync-provider.js';

/**
 * `EnvironmentVariables` lives on its OWN API pair
 * (`PutGraphqlApiEnvironmentVariables` / `Get...`), not on
 * Create/UpdateGraphqlApi. The PUT is whole-map replace, so a removed
 * key is cleared by re-putting the remaining map (and `{}` clears all).
 *
 * Returns what STATE must record for `EnvironmentVariables` when this arm
 * sent something other than the desired map (`value: undefined` = drop the
 * key), or `undefined` to record the desired map as-is.
 */
export async function applyEnvironmentVariables(
  this: AppSyncProvider,
  apiId: string,
  resourceType: string,
  logicalId: string,
  properties: Record<string, unknown>,
  previousProperties?: Record<string, unknown>,
  replayingState = false,
  mask: MaskerFn = maskerOrIdentity(undefined)
): Promise<EnvironmentVariablesRecord | undefined> {
  const isUpdate = previousProperties !== undefined;
  // An UPDATE that sends nothing leaves the live map as it was, so state
  // records THAT map. Only a skip of a PENDING change narrows anything: an
  // unchanged malformed map (a template-path update reaches the container
  // warning only that way) is already what the record says.
  //
  // The previous side is not always what AWS holds: `rollback --revert-failed`
  // passes the FAILED update's attempted bag, whose PUT may never have run.
  // So the live map is read, keeping the previous side's DECLARED value for
  // each key whose live string it produces (an unquoted `RETRIES: 3` stays a
  // number, and the next diff stays quiet). An unreadable live map falls back
  // to the previous map, dropped when that is unusable too.
  const retainPrevious = async (): Promise<EnvironmentVariablesRecord | undefined> => {
    const raw = previousProperties?.['EnvironmentVariables'];
    if (this.deepEqual(properties['EnvironmentVariables'], raw)) return undefined;
    const previousMap =
      raw != null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      Object.entries(raw).every(([k, v]) => this.environmentVariableRefusal(k, v) === undefined)
        ? // Every value passed the per-key predicate above.
          (raw as Record<string, string | number | boolean>)
        : undefined;
    let live: Record<string, string> | undefined;
    try {
      const response = await this.getClient().send(
        new GetGraphqlApiEnvironmentVariablesCommand({ apiId })
      );
      live = response.environmentVariables ?? {};
    } catch (error) {
      this.logger.debug(
        `AppSync GraphqlApi ${logicalId}: could not read the live environment variables ` +
          `(${describeAwsFailure(error).detail}); recording the previous map`
      );
      return { value: previousMap ? { ...previousMap } : undefined };
    }
    // AWS renders a cleared map as an absent member.
    if (Object.keys(live).length === 0) return { value: undefined };
    // The previous side's key order first, then keys only AWS holds: the
    // comparator is `JSON.stringify`, so AWS's order would read as a change.
    const recorded: Record<string, unknown> = {};
    // OWN keys only: `in` also answers for `constructor` / `toString`, which
    // are legal AppSync variable names.
    const previousOwn = previousMap ?? {};
    const keys = [
      ...Object.keys(previousOwn).filter((key) => Object.hasOwn(live, key)),
      ...Object.keys(live).filter((key) => !Object.hasOwn(previousOwn, key)),
    ];
    for (const key of keys) {
      const value = live[key]!;
      const declared = Object.hasOwn(previousOwn, key) ? previousOwn[key] : undefined;
      recorded[key] = declared !== undefined && String(declared) === value ? declared : value;
    }
    return { value: recorded };
  };
  let desired: Record<string, unknown> | undefined;
  try {
    desired = this.asObject(properties['EnvironmentVariables'], 'EnvironmentVariables', {
      logicalId,
    });
  } catch (error) {
    // The PUT is a WHOLE-MAP replace, so treating a malformed desired value
    // as "absent" would clear every live variable. On a template-path CREATE
    // refusing is right; on UPDATE — or on a create that REPLAYS a cdkd state
    // record — warn and leave AWS untouched. A template-path UPDATE reaches
    // this warning only with an UNCHANGED malformed value: a changed one is
    // refused before any call (issue #3740,
    // `refuseChangedMalformedGraphQLApiBlocks`), since this arm runs after
    // `UpdateGraphqlApi` has landed.
    if (!isUpdate && !replayingState) throw error;
    this.logger.warn(
      mask(
        `AppSync GraphqlApi ${logicalId}: ${
          describeAwsFailure(error).detail
        } — leaving the live environment variables untouched`
      )
    );
    // Replay-CREATE: nothing was put, so the new API holds no variables.
    return isUpdate ? await retainPrevious() : { value: undefined };
  }
  // The PREVIOUS side comes from cdkd state, never from the user's template:
  // a malformed value recorded there must not make the stack undeployable,
  // so it reads as absent rather than refusing.
  let previous: Record<string, unknown> | undefined;
  if (previousProperties) {
    const raw = previousProperties['EnvironmentVariables'];
    previous =
      raw != null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : undefined;
  }
  if (desired === undefined && previous === undefined) return;
  if (isUpdate && this.deepEqual(desired, previous)) return;

  const environmentVariables: Record<string, string> = {};
  // The DECLARED values of the keys that go out, for a replay-create record.
  const sentDeclared: Record<string, unknown> = {};
  const refusals: string[] = [];
  for (const [key, value] of Object.entries(desired ?? {})) {
    const refusal = this.environmentVariableRefusal(key, value);
    if (refusal !== undefined) {
      refusals.push(refusal);
      continue;
    }
    environmentVariables[key] = String(value);
    sentDeclared[key] = value;
  }
  let narrowed: EnvironmentVariablesRecord | undefined;
  if (refusals.length > 0) {
    // A template-path CREATE refuses (and the caller rolls the API back). A
    // template-path UPDATE never gets here with an unusable value: a changed
    // map is refused before any call (`refuseChangedMalformedGraphQLApiBlocks`,
    // issue #3781) and an unchanged one returned above.
    if (!isUpdate && !replayingState) {
      throw new ProvisioningError(refusals[0]!, resourceType, logicalId, apiId);
    }
    if (isUpdate) {
      // A state-borne UPDATE (rollback revert, `drift --revert`): the PUT
      // REPLACES the whole map, so sending the usable keys alone would
      // delete the skipped one from AWS. Send nothing; AppSync keeps the
      // live map.
      this.logger.warn(
        mask(
          `AppSync GraphqlApi ${logicalId}: ${refusals.join('; ')} — ` +
            'leaving the live environment variables untouched'
        )
      );
      return await retainPrevious();
    }
    // A replay-CREATE has no live map to protect, so the skip unit is the
    // KEY: the restored API gets every variable that can be sent.
    for (const refusal of refusals) {
      this.logger.warn(
        mask(`AppSync GraphqlApi ${logicalId}: ${refusal} (state replay — proceeding without it)`)
      );
    }
    narrowed = { value: Object.keys(sentDeclared).length > 0 ? sentDeclared : undefined };
    if (narrowed.value === undefined) return narrowed;
  }
  try {
    await this.getClient().send(
      new PutGraphqlApiEnvironmentVariablesCommand({ apiId, environmentVariables })
    );
  } catch (error) {
    throw this.wrapUpdateError(
      error,
      resourceType,
      logicalId,
      apiId,
      isUpdate ? 'GraphqlApi (env vars)' : 'GraphqlApi (env vars, post-create)',
      mask,
      // The API itself was just created: an "already exists" from this call
      // is not its name collision (#3826), so it is not restated.
      !isUpdate
    );
  }
  return narrowed;
}

/**
 * The per-key read of `EnvironmentVariables`: the refusal sentence for a
 * value `PutGraphqlApiEnvironmentVariables` cannot carry, or `undefined`.
 * CloudFormation coerces scalars into its Map<String,String>, so an unquoted
 * YAML `RETRIES: 3` deploys under CFn and must keep working here (same
 * rationale as `coerceNumber` in config-shape.ts). An OBJECT or array is a
 * template bug — `String({})` would send the literal "[object Object]" to
 * AWS. The sentence names the value's TYPE, never the value (a variable can
 * hold a secret).
 */
export function environmentVariableRefusal(
  this: AppSyncProvider,
  key: string,
  value: unknown
): string | undefined {
  if (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  ) {
    return undefined;
  }
  return `AWS::AppSync::GraphQLApi EnvironmentVariables.${key} must be a string, got ${
    Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  }`;
}

/** The complete `effectiveProperties` bag for an env-var narrowing. */
export function withEnvironmentVariablesRecord(
  this: AppSyncProvider,
  properties: Record<string, unknown>,
  record: EnvironmentVariablesRecord
): Record<string, unknown> {
  const effective: Record<string, unknown> = {
    ...properties,
    EnvironmentVariables: record.value,
  };
  // REMOVE rather than leave `undefined`, which survives `structuredClone`.
  if (record.value === undefined) delete effective['EnvironmentVariables'];
  return effective;
}

// ─── AWS::AppSync::Resolver / DataSource config converters (#609) ──
//
// Same doctrine as the GraphQLApi block above: every member is
// hand-mapped, never mechanically case-flipped, because the AWS SDK v3
// serializer silently DROPS unknown members. The casing traps this batch
// pins: `openSearchServiceConfig` (capital S twice), `dbClusterIdentifier`
// (CFn spells it `DbClusterIdentifier`), `awsSecretStoreArn`, and
// `lambdaConflictHandlerConfig.lambdaConflictHandlerArn`.

/** CFn `CachingConfig` (`Ttl` / `CachingKeys`) -> SDK `cachingConfig`. */
export function toSdkCachingConfig(
  this: AppSyncProvider,
  value: unknown,
  logicalId: string
): CachingConfig | undefined {
  const cfn = this.asObject(value, 'CachingConfig', { logicalId }, 'AWS::AppSync::Resolver');
  if (!cfn) return undefined;
  const out: CachingConfig = {
    // `Ttl` is REQUIRED by both CFn and the SDK; forwarded verbatim so an
    // omission reaches AWS as a loud validation error naming the field.
    ttl: cfn['Ttl'] as number,
  };
  if (cfn['CachingKeys'] !== undefined) {
    // `requireConfigArray` validates the CONTAINER (an unresolved intrinsic
    // or a string where the template meant a list must not silently become
    // "no caching keys"); the elements are plain strings forwarded as-is.
    out.cachingKeys = requireConfigArray(
      cfn['CachingKeys'],
      'AWS::AppSync::Resolver CachingConfig.CachingKeys'
    ) as unknown as string[];
  }
  return out;
}

/**
 * CFn `SyncConfig` (`ConflictDetection` / `ConflictHandler` /
 * `LambdaConflictHandlerConfig.LambdaConflictHandlerArn`) -> SDK
 * `syncConfig`.
 */
export function toSdkSyncConfig(
  this: AppSyncProvider,
  value: unknown,
  logicalId: string
): SyncConfig | undefined {
  const cfn = this.asObject(value, 'SyncConfig', { logicalId }, 'AWS::AppSync::Resolver');
  if (!cfn) return undefined;
  const out: SyncConfig = {};
  if (cfn['ConflictDetection'] !== undefined) {
    out.conflictDetection = cfn['ConflictDetection'] as ConflictDetectionType;
  }
  if (cfn['ConflictHandler'] !== undefined) {
    out.conflictHandler = cfn['ConflictHandler'] as ConflictHandlerType;
  }
  const lambdaHandler = this.asObject(
    cfn['LambdaConflictHandlerConfig'],
    'SyncConfig.LambdaConflictHandlerConfig',
    { logicalId },
    'AWS::AppSync::Resolver'
  );
  if (lambdaHandler) {
    out.lambdaConflictHandlerConfig = {
      lambdaConflictHandlerArn: lambdaHandler['LambdaConflictHandlerArn'] as string,
    };
  }
  return out;
}

/**
 * Parse the `s3://bucket/key` URL the AppSync `*S3Location` string
 * properties carry.
 *
 * CDK's asset bindings (`appsync.Code.fromAsset`, `aws-s3-assets` Asset
 * `s3ObjectUrl`) emit exactly this form, and the CloudFormation examples
 * for these properties use it too. Anything else (an `https://` object
 * URL, a bare bucket, a non-string) is refused with a clear error naming
 * the property — never silently dropped.
 */
export function parseS3LocationUrl(
  this: AppSyncProvider,
  location: unknown,
  resourceType: string,
  logicalId: string,
  propertyPath: string
): { bucket: string; key: string } {
  if (typeof location !== 'string') {
    throw new ProvisioningError(
      `${resourceType} ${propertyPath} must be a string s3://bucket/key URL, got ` +
        `${Array.isArray(location) ? 'array' : typeof location} — check for an unresolved intrinsic`,
      resourceType,
      logicalId
    );
  }
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(location);
  if (!match || !match[1] || !match[2]) {
    throw new ProvisioningError(
      `${resourceType} ${propertyPath} must be an s3://bucket/key URL (got '${location}')`,
      resourceType,
      logicalId
    );
  }
  return { bucket: match[1], key: match[2] };
}

/**
 * Fetch an `*S3Location` object body as a UTF-8 string.
 *
 * CloudFormation's behavior for these properties is to download the S3
 * object and pass its CONTENT as the corresponding inline member
 * (`code` / `requestMappingTemplate` / `responseMappingTemplate` /
 * `definition`); the URL itself never reaches AppSync. Mirrors
 * `StepFunctionsProvider.fetchDefinitionFromS3`, including the
 * empty-body refusal (AWS would reject '' with a generic validation
 * error naming nothing).
 */
export async function fetchS3LocationBody(
  this: AppSyncProvider,
  location: unknown,
  resourceType: string,
  logicalId: string,
  propertyPath: string,
  // AWS can echo a template value back; absent means unmasked.
  mask: MaskerFn = maskerOrIdentity(undefined)
): Promise<string> {
  const { bucket, key } = this.parseS3LocationUrl(location, resourceType, logicalId, propertyPath);
  this.logger.debug(`Fetching ${propertyPath} for ${logicalId} from s3://${bucket}/${key}`);
  let body: string;
  try {
    const resp = await this.getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!resp.Body) {
      throw new Error(`object returned no body`);
    }
    body = await resp.Body.transformToString();
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to fetch ${propertyPath} s3://${bucket}/${key} for ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
  if (body.length === 0) {
    throw new ProvisioningError(
      `${propertyPath} object s3://${bucket}/${key} returned an empty body`,
      resourceType,
      logicalId
    );
  }
  return body;
}

/**
 * Resolve an inline-or-S3 property pair to the inline SDK value.
 *
 * Precedence: the INLINE property wins when both are present, matching
 * the repo's established S3Location precedent (StepFunctions
 * `DefinitionString` over `DefinitionS3Location`, AppSync GraphQLSchema
 * `Definition` over `DefinitionS3Location`) — CFn treats the pair as
 * alternatives and CDK's bindings only ever emit one, so both-present is
 * a hand-authored template; it is honored inline-first with a loud
 * warning rather than refused.
 */
export async function resolveInlineOrS3Template(
  this: AppSyncProvider,
  inline: unknown,
  s3Location: unknown,
  inlineKey: string,
  s3Key: string,
  resourceType: string,
  logicalId: string,
  mask: MaskerFn = maskerOrIdentity(undefined)
): Promise<string | undefined> {
  if (inline !== undefined) {
    if (s3Location !== undefined) {
      this.logger.warn(
        `${resourceType} ${logicalId}: both ${inlineKey} and ${s3Key} are set — ` +
          `using the inline ${inlineKey} and ignoring ${s3Key} (CFn treats them as alternatives)`
      );
    }
    return inline as string;
  }
  if (s3Location !== undefined) {
    return this.fetchS3LocationBody(s3Location, resourceType, logicalId, s3Key, mask);
  }
  return undefined;
}

/**
 * Fill the mutable members shared by `CreateResolver` and `UpdateResolver`
 * from the CFn property bag — the single mapper both paths use so they
 * cannot diverge (the `applyGraphQLApiConfig` pattern).
 *
 * REMOVAL semantics: unlike `UpdateGraphqlApi` (where an omitted member is
 * "no change" and removal needs reset sentinels), `UpdateResolver` is a
 * FULL-REPLACE write — the desired bag is mapped in its entirety and an
 * omitted member is cleared server-side, so "absent in template => omitted
 * from the update input => cleared by AppSync" and no sentinel is needed.
 * That semantic is pinned live by the integ fixture's REMOVAL phase
 * (tests/integration/appsync/verify.sh drops the resolver's MetricsConfig
 * and asserts AWS reset it while a sibling DataSource keeps its own).
 * MetricsConfig is the one member A/B'd against real AWS; the other
 * members rest on the same UpdateResolver full-replace API contract, not
 * on a per-member live probe (the #1160 doctrine's per-member A/B was
 * deliberately not paid here — recorded in the PR body).
 *
 * Resolver shape is `Kind`-discriminated:
 *   - Kind=UNIT     -> DataSourceName applies, PipelineConfig is N/A.
 *   - Kind=PIPELINE -> PipelineConfig applies, DataSourceName is N/A
 *                      (AWS rejects the call if it's set).
 * The gate applies ONLY on update (`forUpdate`), where the effective Kind
 * falls back to the state-recorded previous value and finally AWS's
 * default 'UNIT' — an update must not re-send the other kind's member on a
 * live resolver. On CREATE both members forward UNCONDITIONALLY when
 * present: gating there would silently drop a crossed shape (the very
 * silent-drop class this batch closes) where CFn parity is AWS's own loud
 * rejection — the same forward-don't-gate doctrine as
 * `applyDataSourceConfig`'s per-type sub-configs.
 */
export async function applyResolverConfig(
  this: AppSyncProvider,
  input: CreateResolverCommandInput | UpdateResolverCommandInput,
  resourceType: string,
  logicalId: string,
  properties: Record<string, unknown>,
  previousProperties?: Record<string, unknown>,
  forUpdate = false,
  mask: MaskerFn = maskerOrIdentity(undefined)
): Promise<void> {
  const effectiveKind =
    (properties['Kind'] as 'UNIT' | 'PIPELINE' | undefined) ??
    (previousProperties?.['Kind'] as 'UNIT' | 'PIPELINE' | undefined) ??
    'UNIT';

  if ((!forUpdate || effectiveKind === 'UNIT') && properties['DataSourceName'] !== undefined) {
    input.dataSourceName = properties['DataSourceName'] as string;
  }
  if (properties['Kind'] !== undefined) {
    input.kind = properties['Kind'] as 'UNIT' | 'PIPELINE';
  }
  if ((!forUpdate || effectiveKind === 'PIPELINE') && properties['PipelineConfig'] !== undefined) {
    const pipelineConfig = properties['PipelineConfig'] as Record<string, unknown>;
    input.pipelineConfig = {
      functions: pipelineConfig['Functions'] as string[] | undefined,
    };
  }
  if (properties['Runtime'] !== undefined) {
    const runtime = properties['Runtime'] as Record<string, unknown>;
    input.runtime = {
      name: runtime['Name'] as 'APPSYNC_JS',
      runtimeVersion: runtime['RuntimeVersion'] as string,
    };
  }

  // The three inline-or-S3 pairs. CFn's behavior for the *S3Location
  // variants is to fetch the S3 object and pass its BODY as the inline
  // member — there is no SDK member for the URL itself. The bag reads stay
  // DIRECT at this call site (the helper takes values, not keys) so each
  // `properties['X']` read stays visible (and greppable) here.
  const requestTemplate = await this.resolveInlineOrS3Template(
    properties['RequestMappingTemplate'],
    properties['RequestMappingTemplateS3Location'],
    'RequestMappingTemplate',
    'RequestMappingTemplateS3Location',
    resourceType,
    logicalId,
    mask
  );
  if (requestTemplate !== undefined) input.requestMappingTemplate = requestTemplate;
  const responseTemplate = await this.resolveInlineOrS3Template(
    properties['ResponseMappingTemplate'],
    properties['ResponseMappingTemplateS3Location'],
    'ResponseMappingTemplate',
    'ResponseMappingTemplateS3Location',
    resourceType,
    logicalId,
    mask
  );
  if (responseTemplate !== undefined) input.responseMappingTemplate = responseTemplate;
  const code = await this.resolveInlineOrS3Template(
    properties['Code'],
    properties['CodeS3Location'],
    'Code',
    'CodeS3Location',
    resourceType,
    logicalId,
    mask
  );
  if (code !== undefined) input.code = code;

  const caching = this.toSdkCachingConfig(properties['CachingConfig'], logicalId);
  if (caching) input.cachingConfig = caching;
  const sync = this.toSdkSyncConfig(properties['SyncConfig'], logicalId);
  if (sync) input.syncConfig = sync;
  if (properties['MaxBatchSize'] !== undefined) {
    input.maxBatchSize = properties['MaxBatchSize'] as number;
  }
  if (properties['MetricsConfig'] !== undefined) {
    // Scalar enum (ENABLED / DISABLED), not a block.
    input.metricsConfig = properties['MetricsConfig'] as ResolverLevelMetricsConfig;
  }
}
