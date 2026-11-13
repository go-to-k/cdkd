import { ApiGatewayV2Client, GetApiCommand, NotFoundException } from '@aws-sdk/client-apigatewayv2';
import { deployReplaceCommand } from '../../../utils/pasteable-command.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import type { DeleteContext } from '../../region-check.js';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';
import { readTagList, tagMapAsList } from '../../tag-list.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import type {
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ResourceNotFound,
} from '../../../types/resource.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import {
  pasteableAwsCommand,
  type PasteableAwsCommand,
} from '../../replacement-protection-advice.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { ApiGatewayV2Provider } from '../apigatewayv2-provider.js';
import { API_ID_ADDRESSED_TYPES, stageSinks } from './shared.js';

export function getClient(this: ApiGatewayV2Provider): ApiGatewayV2Client {
  if (!this.client) {
    this.client = new ApiGatewayV2Client({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.client;
}

/**
 * The client `CreateApi`, `CreateIntegration` and `CreateAuthorizer` go
 * through: SDK retries on, except a 5xx (`withoutServerErrorRetries`, issue
 * #2080). Separate so every other call keeps the full SDK retry.
 */
export function getCreateClient(this: ApiGatewayV2Provider): ApiGatewayV2Client {
  if (!this.createClient) {
    this.createClient = withoutServerErrorRetries(
      new ApiGatewayV2Client({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      })
    );
  }
  return this.createClient;
}

/**
 * ` --region <r>` for an orphan report's pasteable commands (issue #2080),
 * from the client the lookup listed through: without it a stack deployed
 * outside the operator's default region pastes a read against the wrong
 * region, and its NotFound reads as "no orphan". Empty when the region
 * cannot be read -- the report must never fail the create.
 */
export async function orphanCommandRegionArg(
  this: ApiGatewayV2Provider,
  aws: ReturnType<typeof pasteableAwsCommand>
): Promise<PasteableAwsCommand> {
  let region: string | undefined;
  try {
    region = await this.getClient().config.region();
  } catch {
    region = undefined;
  }
  return region ? aws` --region ${region}` : aws``;
}

/**
 * The failure wrap every `create()` / `update()` / `delete()` catch throws.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `log.debug` (masked), and
 * the wrap is stamped `markRedactedCause`, so the retry classifiers read the
 * withheld text on the `cause` chain. An "already exists" is restated
 * ({@link relayedNameCollision}).
 *
 * A cdkd-authored or transport error, or a non-`Error` throw, keeps its text
 * masked (issue #2177): AWS quotes a rejected request value back (a stage
 * name, an integration URI, an authorizer URI) off the RESOLVED `properties`
 * bag, and masking the raw text reaches the masker's whole-value arm, which
 * the assembled sentence cannot. A message the mask CHANGED is stamped too
 * (`wrapMaskedAwsError`, the issue #4244 class). A delete builds its sinks
 * from `DeleteContext.maskSecrets`.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call. A method, so `gen-update-wrap-coverage`
 * sees the catch that throws it as a wrap.
 */
export function wrapMaskedError(
  this: ApiGatewayV2Provider,
  log: MaskedLogSinks,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!(error instanceof Error)) return build(log.mask(failure.detail));
  if (!failure.redacted) return wrapMaskedAwsError(log.mask, error, build);
  log.debug(build(log.mask(failure.detail)).message);
  return markRedactedCause(
    build(`${log.mask(failure.summary)}${relayedNameCollision(failure.detail)}`)
  );
}

// ─── Dispatch ─────────────────────────────────────────────────────

/**
 * The `context` parameter is read for ONE thing today: `maskSecrets` (issue
 * #1932 item 3). Each `create()` / `update()` builds ONE masked sink set from
 * its own context (issue #2177, `.claude/rules/provider-masking.md`) and
 * routes every log line and wrapped AWS error text through it; a bag value a
 * cdkd line interpolates is also masked RAW (`log.value`), so a secret below
 * the masker's substring floor is caught too. Read defensively — `create()`
 * is also called by the import path and by tests, neither of which supplies a
 * context; absent means identity. The one exception is the Stage path
 * (`stageSinks`): a Stage name whose source `StageName` spells a
 * `{{resolve:` reference or is exactly `***` is masked even with no masker,
 * because that test needs none (on `update()` this is the previous side
 * read from state).
 */
export async function create(
  this: ApiGatewayV2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const log =
    resourceType === 'AWS::ApiGatewayV2::Stage'
      ? // `withDerivedNameMasks` drops a non-string name at runtime.
        stageSinks(this.logger, context, [
          [properties['StageName'], properties['StageName'] as string | undefined],
        ])
      : createMaskedLogSinks(this.logger, context?.maskSecrets);
  switch (resourceType) {
    case 'AWS::ApiGatewayV2::Api':
      return this.createApi(logicalId, resourceType, properties, log);
    case 'AWS::ApiGatewayV2::Stage':
      return this.createStage(logicalId, resourceType, properties, log);
    case 'AWS::ApiGatewayV2::Integration':
      return this.createIntegration(logicalId, resourceType, properties, log);
    case 'AWS::ApiGatewayV2::Route':
      return this.createRoute(logicalId, resourceType, properties, log);
    case 'AWS::ApiGatewayV2::Authorizer':
      return this.createAuthorizer(logicalId, resourceType, properties, log);
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
 *
 * The `context` parameter mirrors {@link create}'s: read only for
 * `maskSecrets`, one masked sink set per operation. The update path carries
 * the same RESOLVED bag as the create path, so the masking requirement is
 * identical on both — a masker present on one and absent from the other is
 * not a partial fix, it is a fix with a hole in the shape of whichever path a
 * given deploy takes.
 */
export async function update(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // A Stage's recorded name is its physical id. `updateStage` refuses a
  // StageName CHANGE before it logs anything, so a line is reached only when
  // both sides agree (a replay of state, which passes the recorded
  // `{{resolve:` reference or `***`) or one side is absent. Either side
  // being secret-derived makes the physical id a needle, which covers a
  // plaintext in no bag of this deploy (a rotated secret); it can only
  // over-mask.
  const log =
    resourceType === 'AWS::ApiGatewayV2::Stage'
      ? stageSinks(this.logger, context, [
          [properties['StageName'], physicalId],
          [previousProperties['StageName'], physicalId],
        ])
      : createMaskedLogSinks(this.logger, context?.maskSecrets);
  switch (resourceType) {
    case 'AWS::ApiGatewayV2::Api':
      return this.updateApi(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log
      );
    case 'AWS::ApiGatewayV2::Stage':
      return this.updateStage(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log,
        context?.desiredFromAwsReadback === true
      );
    case 'AWS::ApiGatewayV2::Integration':
      return this.updateIntegration(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log,
        context?.desiredFromAwsReadback === true,
        context
      );
    case 'AWS::ApiGatewayV2::Route':
      return this.updateRoute(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log,
        context?.desiredFromAwsReadback === true
      );
    case 'AWS::ApiGatewayV2::Authorizer':
      return this.updateAuthorizer(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        log,
        context
      );
    default:
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `Unsupported API Gateway V2 resource type for in-place update in cdkd; re-deploy with ${deployReplaceCommand()}, or destroy + redeploy the stack.`
      );
  }
}

export async function deleteImpl(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  // go-to-k/cdkd#3952: see the ApiGateway provider -- the recorded ApiId is
  // the address, and a not-found on it reads as "already deleted".
  if (API_ID_ADDRESSED_TYPES.has(resourceType)) {
    const skip = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      resourceType,
      redactedDeleteAddressFields({ ApiId: properties?.['ApiId'] })
    );
    if (skip) return skip;
  }
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

export function getAttribute(
  this: ApiGatewayV2Provider,
  physicalId: string,
  resourceType: string,
  attributeName: string
): Promise<unknown> {
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
export function getDriftUnknownPaths(
  this: ApiGatewayV2Provider,
  resourceType: string,
  properties?: Record<string, unknown>
): string[] {
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

/**
 * Drift for an Api / Stage whose baseline predates go-to-k/cdkd#5390. Before
 * it, CreateApi / CreateStage never sent a map-shaped `Tags`, `readApi`
 * recorded tags as a `{Key,Value}` list and `readStage` recorded none. Such
 * a LEGACY baseline (a list-shaped `Tags` on either type — a pre-fix Api
 * readback, or a hand-written `{Key,Value}` list on the `properties`
 * baseline — or a Stage baseline with no `Tags` while the template declares
 * one) is completed with the template's
 * declared tags in the map shape the readback now uses, so the tags a pre-fix
 * deploy never applied show as drift and `cdkd drift --revert` tags them —
 * a deploy cannot, as the record already equals the template. A current-shape
 * baseline is compared as it is. No AWS call.
 */
export async function canonicalizeDriftPair(
  this: ApiGatewayV2Provider,
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  properties: Record<string, unknown> = {}
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  if (resourceType !== 'AWS::ApiGatewayV2::Api' && resourceType !== 'AWS::ApiGatewayV2::Stage') {
    return { baseline, aws };
  }
  // A list-shaped baseline `Tags` on either type (a pre-fix Api readback, or
  // a hand-written `{Key,Value}` list on the `properties` baseline) would
  // compare a list against the map readback.
  const legacy =
    Array.isArray(baseline['Tags']) ||
    (resourceType === 'AWS::ApiGatewayV2::Stage' &&
      !Object.hasOwn(baseline, 'Tags') &&
      properties['Tags'] !== undefined &&
      properties['Tags'] !== null);
  if (!legacy) return { baseline, aws };
  // The template's tags, else (an Api whose template declares none) the
  // legacy list itself, re-shaped. A declared Tags cdkd cannot read is left
  // alone: deploy refuses it.
  const source = properties['Tags'] ?? baseline['Tags'];
  // A dynamic reference or its mask ANYWHERE in the source leaves the pair
  // alone: the recorded template holds the unresolved `{{resolve:...}}`, so a
  // completed value would reach `TagResource` as that literal on
  // `--revert`, and a dropped key would be untagged.
  if (holdsSecretDerivedEntry(source)) return { baseline, aws };
  const declared = tagMapAsList(source);
  if (!Array.isArray(declared)) return { baseline, aws };
  const read = readTagList(declared, 'recorded');
  if (read.kind !== 'tags' || read.hidden > 0) return { baseline, aws };
  const tags = Object.fromEntries(
    read.tags.filter((t) => !t.Key.startsWith('aws:')).map((t) => [t.Key, t.Value])
  );
  return { baseline: { ...baseline, Tags: tags }, aws };
}

export async function readCurrentState(
  this: ApiGatewayV2Provider,
  physicalId: string,
  _logicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
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
export async function importImpl(
  this: ApiGatewayV2Provider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
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
      const got = await this.getClient().send(new GetApiCommand({ ApiId: explicit }));
      // The SAME attributes `create` records. An adopted API that carried
      // none would hard-throw on `Fn::GetAtt ExecuteApiArn` while a created
      // one resolved — the split `AppSyncProvider.childImportAttributes`
      // closed for its siblings in issue #1728, and this change is what makes
      // users reach for the attribute in the first place.
      const executeApiArn = await this.buildExecuteApiArn(explicit);
      return {
        physicalId: explicit,
        attributes: {
          ApiId: explicit,
          ...(got.ApiEndpoint !== undefined ? { ApiEndpoint: got.ApiEndpoint } : {}),
          ...(executeApiArn !== undefined ? { ExecuteApiArn: executeApiArn } : {}),
        },
      };
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
