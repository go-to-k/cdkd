import {
  DeleteAccessLogSettingsCommand,
  DeleteRouteSettingsCommand,
  DeleteRouteRequestParameterCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
} from '@aws-sdk/client-apigatewayv2';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { dynamicReferenceTokens, SECRET_MASK } from '../../../deployment/secret-redaction.js';
import { planTagDiff, tagMapAsList, tagPlanWarning } from '../../tag-list.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';
import { ApiGatewayV2Provider } from '../apigatewayv2-provider.js';
import type { TagChange } from './shared.js';

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * The `RequestParameters` an `UpdateIntegration` carrying `IntegrationSubtype`
 * sends: the DECLARED map, as CloudFormation does. AWS re-validates the
 * service operation's required parameter mapping against the REQUEST on
 * every such call (direct probe, #1160: `Description` + subtype fails with
 * "requires enabling passthrough, or defining all of the following
 * parameters in the parameter mapping: [Detail, DetailType, Source]"), so a
 * call that changed something else must re-send the unchanged map.
 *
 * Nothing is carried from the previous record. Real CloudFormation A/B
 * (#1160): beside a `Description` change, dropping one required key, or the
 * whole map, FAILS the update with that same error, so a template without
 * the full map gets AWS's refusal here too.
 *
 * A declared value that is a `{{resolve:...}}` reference or the `***` mask
 * (a state record handed back by a rollback replay) REFUSES instead of being
 * sent, naming only the keys: it would overwrite the live mapping with the
 * stand-in. A deploy's declared bag is resolved, so it never trips this.
 */
export function serviceIntegrationParameters(
  this: ApiGatewayV2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  sent: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (sent == null) return undefined;
  const redacted = Object.keys(sent).filter((key) => {
    const value: unknown = sent[key];
    return (
      typeof value === 'string' &&
      (dynamicReferenceTokens(value).length > 0 || value === SECRET_MASK)
    );
  });
  if (redacted.length > 0) {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${logicalId} (${resourceType}): this update must re-send the service integration's RequestParameters (AWS re-validates the full mapping beside IntegrationSubtype), but the value of ${redacted.join(', ')} is a redacted secret reference that cdkd cannot send. The integration was not updated.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  return sent;
}

/**
 * Resolve an optional update field so that a property REMOVED from the
 * template is reset to a fixed value (issue #1160).
 *
 * Every API Gateway V2 `Update*` API merges: an ABSENT input field means "no
 * change". Whether removal should reset is PER PROPERTY, decided by a real
 * CloudFormation A/B (#5004). Used for the properties CloudFormation RESETS
 * on removal: Stage `AutoDeploy` (to `false`) and Route `AuthorizationScopes`
 * (to `[]`); plus Route `ApiKeyRequired` (to `false`), which the #5004
 * measurement did NOT cover and so keeps its #1160 reset. Api
 * `CorsConfiguration`, Stage `AccessLogSettings` and `RouteSettings` are reset
 * through dedicated `Delete*` calls. The measured KEEP set (Api Description /
 * Version / DisableExecuteApiEndpoint / IpAddressType /
 * ApiKeySelectionExpression, Stage StageVariables /
 * ClientCertificateId, Integration Description / RequestParameters, Route
 * AuthorizationType / AuthorizerId / OperationName / RequestModels /
 * RequestParameters, Authorizer AuthorizerCredentialsArn /
 * AuthorizerPayloadFormatVersion / AuthorizerResultTtlInSeconds /
 * IdentityValidationExpression) is passed through on change only and sends
 * nothing on removal, as is the KEEP set the #1160 A/B measured for every
 * other optional property. Authorizer `IdentitySource` (CFn clears it) is
 * declared in `removalDefaults`; a removed Integration `IntegrationSubtype`
 * is refused or dropped in `updateIntegration`.
 *
 * Returns `{ changed, value }`: `changed` is true only when the resolved
 * value actually differs from the previous one (so a no-op field never
 * forces an Update call), and `value` is the value to place in the input.
 */
export function clearableUpdate<T>(
  this: ApiGatewayV2Provider,
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
export function droppedKeys(
  this: ApiGatewayV2Provider,
  next: unknown,
  previous: unknown
): string[] {
  if (previous == null || typeof previous !== 'object' || Array.isArray(previous)) return [];
  const prevMap = previous as Record<string, unknown>;
  const nextMap =
    next != null && typeof next === 'object' && !Array.isArray(next)
      ? (next as Record<string, unknown>)
      : {};
  // `hasOwnProperty`, not `in`: a key named `constructor` / `toString` would
  // otherwise resolve on the prototype chain and never report as dropped.
  return Object.keys(prevMap).filter((key) => !Object.prototype.hasOwnProperty.call(nextMap, key));
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
export async function sendTolerantOfNotFound(
  this: ApiGatewayV2Provider,
  send: () => Promise<unknown>
): Promise<void> {
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
export async function applyStageRemovals(
  this: ApiGatewayV2Provider,
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
export async function deleteRouteRequestParameters(
  this: ApiGatewayV2Provider,
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
 * Resolve a `Record<string, string>` update field for `cdkd drift --revert` (`StageVariables`, Route
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
export function mapWithRemovals(
  this: ApiGatewayV2Provider,
  next: unknown,
  previous: unknown
): Record<string, string> | undefined {
  if (this.deepEqual(next, previous)) return undefined;
  const nextMap = (next ?? {}) as Record<string, string>;
  const prevMap = (previous ?? {}) as Record<string, string>;
  const merged: Record<string, string> = { ...nextMap };
  for (const key of Object.keys(prevMap)) {
    if (!Object.hasOwn(nextMap, key)) merged[key] = '';
  }
  return merged;
}

/**
 * True when `next` carries a key that is new or whose value differs from
 * `previous`. The merge-semantics maps (StageVariables, RequestModels,
 * RequestParameters) keep a key that is only DROPPED, as CloudFormation does
 * (#5004), so a drop alone is not a change worth an Update call; when an
 * entry did change the full `next` map is sent.
 */
export function mapEntryAddedOrChanged(
  this: ApiGatewayV2Provider,
  next: unknown,
  previous: unknown
): boolean {
  if (next == null || typeof next !== 'object' || Array.isArray(next)) return false;
  const prevMap =
    previous != null && typeof previous === 'object' && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {};
  return Object.entries(next as Record<string, unknown>).some(
    ([key, value]) =>
      !Object.prototype.hasOwnProperty.call(prevMap, key) || !this.deepEqual(value, prevMap[key])
  );
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
export function warnTlsConfigIgnoredIfPublic(
  this: ApiGatewayV2Provider,
  logicalId: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): void {
  if (properties['TlsConfig'] != null && properties['ConnectionType'] !== 'VPC_LINK') {
    log.warn(
      `AWS::ApiGatewayV2::Integration ${logicalId}: TlsConfig is only honored on a ` +
        `VPC_LINK (private) integration — AWS silently ignores it on a public one, and ` +
        `the value will never be readable back from AWS.`
    );
  }
}

/**
 * Diff the recorded and desired `Tags` of an Api or Stage (go-to-k/cdkd#5390).
 * `UpdateApi` / `UpdateStage` carry no tags, so a change is its own
 * `TagResource` / `UntagResource`. Only new or changed tags are set and only
 * keys the template dropped are untagged — removing the whole `Tags` block
 * untags every recorded key, as CloudFormation does — so a tag added
 * out-of-band is left alone on a deploy, while `cdkd drift --revert` (whose
 * recorded side is the AWS readback) untags it. A recorded `Tags` cdkd cannot
 * read untags nothing and warns.
 */
export function planTags(
  this: ApiGatewayV2Provider,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  resourceType: string,
  logicalId: string,
  physicalId: string,
  log: MaskedLogSinks
): TagChange {
  // The refused-and-filtered desired list is what is diffed, so a warning's
  // "applied N tag(s)" counts only tags that are sent (no `aws:` key).
  const desired = ApiGatewayV2Provider.desiredTags(
    properties['Tags'],
    resourceType,
    logicalId,
    physicalId
  );
  const plan = planTagDiff(tagMapAsList(previousProperties['Tags']), desired);
  const warning = tagPlanWarning(plan, resourceType, logicalId);
  if (warning !== undefined) log.warn(warning);
  const remove = plan.remove.filter((k) => !k.startsWith('aws:'));
  return {
    set: Object.fromEntries(plan.set),
    remove,
    changed: plan.set.size > 0 || remove.length > 0,
  };
}

/**
 * Send a planned tag change to the resource at `path` (`/apis/<id>` or
 * `/apis/<id>/stages/<name>`); a no-op when nothing changed.
 */
export async function applyTagDiff(
  this: ApiGatewayV2Provider,
  path: string,
  change: TagChange
): Promise<void> {
  if (!change.changed) return;
  // The region comes from the client the calls go through, like
  // `buildExecuteApiArn`'s, so the ARN names the region the resource is in.
  const region = await this.getClient().config.region();
  const { partition } = derivePartitionAndUrlSuffix(region);
  const resourceArn = `arn:${partition}:apigateway:${canonicalizeRegion(region)}::${path}`;
  if (change.remove.length > 0) {
    await this.getClient().send(
      new UntagResourceCommand({ ResourceArn: resourceArn, TagKeys: change.remove })
    );
  }
  if (Object.keys(change.set).length > 0) {
    await this.getClient().send(
      new TagResourceCommand({ ResourceArn: resourceArn, Tags: change.set })
    );
  }
}

/**
 * Structural equality used to skip Update calls when an object /
 * array property is unchanged. Stable JSON serialization is fine
 * here because the API Gateway V2 sub-shapes (`CorsConfiguration`,
 * `JwtConfiguration`, scope arrays, identity-source arrays) are
 * small primitive maps with no key-order semantics on the AWS side.
 */
export function deepEqual(this: ApiGatewayV2Provider, a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
