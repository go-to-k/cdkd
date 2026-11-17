import type { ResourceProvider } from '../types/resource.js';
import type { ResourceState } from '../types/state.js';
import { CloudControlProvider } from './cloud-control-provider.js';
import { CustomResourceProvider } from './providers/custom-resource-provider.js';
import { getLogger } from '../utils/logger.js';
import { hasNoCloudControlHandlers, NO_CC_HANDLERS_REASON } from './unsupported-types.js';
import { findActionableSdkUnwired } from './property-coverage.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { getAccountInfo } from '../deployment/intrinsic-function-resolver.js';
import { derivePartitionAndUrlSuffix } from '../utils/aws-partition.js';
import { buildUnroutableSdkUnwiredMessage, getProviderFor } from './provider-registry/routing.js';
import {
  validateCustomResourceSecureReferences,
  validateMutuallyExclusiveProperties,
  validateNestedRequiredProperties,
  validateResourceProperties,
  validateResourceTypes,
} from './provider-registry/validate.js';
import {
  findAutoRouteHits,
  reportSdkUnwiredDecisions,
  reportUnrecognizedProperties,
} from './provider-registry/report.js';

import {
  STICKY_CC_MIGRATION_EXEMPT,
  type StickyExemptEntry,
} from './provider-registry/sticky-exempt.js';
import type { CcPhysicalIdContext } from './sticky-exempt-physical-id.js';

// The sticky-CC exemption table lives in its own module; re-exported so
// every importer keeps one entry point.
export {
  STICKY_CC_MIGRATION_EXEMPT,
  type StickyExemptEntry,
  type StickyExemptMode,
} from './provider-registry/sticky-exempt.js';

/**
 * The provisioning layer that owns a particular resource: SDK Provider
 * (cdkd's preferred fast path) or Cloud Control API (the fallback path).
 * Persisted on `ResourceState.provisionedBy` for v7+ state files; legacy
 * v6-and-earlier records have the field absent which is treated as
 * `'sdk'` semantically.
 */
export type ProvisionedBy = 'sdk' | 'cc-api';

/**
 * The routing decision returned by {@link ProviderRegistry.getProviderFor}.
 * Carries the chosen provider, the layer label to persist on the resource's
 * state record, and (when an SDK Provider was bypassed in favor of Cloud
 * Control because of SDK-unwired properties) the list of property names
 * that drove the decision — surfaced by deploy / diff plan rendering and
 * used by {@link ProviderRegistry.findAutoRouteHits} so the user sees WHY
 * a particular resource is taking the CC route.
 */
export interface ProviderRoutingDecision {
  provider: ResourceProvider;
  provisionedBy: ProvisionedBy;
  ccRouteReason?: { properties: string[] };
  /**
   * Set when rule 2 sent a resource whose state record says `'cc-api'` BACK to
   * its SDK provider (issue #2719).
   *
   * ONE reader: `deploy-engine/update-in-place.ts`'s update dispatch, which turns it into the
   * info line that tells the user a live resource moved between provisioning
   * layers. `cdkd diff` does NOT read it — it has no routing decision to read,
   * only a template and a state record, so it re-derives the same answer
   * through {@link wouldReturnToSdkProvider}. An earlier revision of this
   * comment claimed both surfaces read it while neither did, and the field was
   * dead in production with five test assertions pinning it.
   *
   * Absent on every other path, including a resource that was already `'sdk'`:
   * this marks a TRANSITION, and the record says `'sdk'` from the next write
   * on, so it fires once.
   */
  sdkMigration?: true;
}

/**
 * Input shape for {@link ProviderRegistry.getProviderFor}. `properties`
 * drives the SDK-unwired check (only consulted on a fresh deploy);
 * `provisionedBy` is the **sticky** state-recorded layer for an existing
 * resource (load-bearing — once a resource is `'cc-api'`, mid-life updates
 * MUST stay on CC even if the property-coverage backfill closes the gap).
 */
export interface GetProviderForInput {
  resourceType: string;
  properties?: Record<string, unknown> | undefined;
  provisionedBy?: ProvisionedBy | undefined;
  /**
   * The property bag on the resource's EXISTING state record -- the resolved
   * desired bag of its last successful deploy, not a Cloud Control read-back,
   * so it carries no CC-only keys.
   *
   * Load-bearing for the `'sdk-coverage'` exemption (issue #2719) and for one
   * case only: the REMOVAL deploy. A resource carries SDK-unwired property `P`
   * applied under CC; the user deletes `P` from the template. The desired bag
   * is now clean, so a desired-only condition would route THAT deploy to the
   * SDK provider -- which cannot unset `P` -- silently skipping the removal,
   * which is the exact bug the auto-route exists to prevent. Under CC the same
   * deploy patches `P` away correctly, and the NEXT deploy flips. Convergent,
   * one deploy late, never wrong.
   *
   * Also the baseline for an UNRECOGNIZED property (issue
   * [#3713](https://github.com/go-to-k/cdkd/issues/3713)): a key the schema
   * snapshot does not know routes to Cloud Control only when it is absent from,
   * or different in, this bag — so an existing deployment keeps its route. An
   * update site that omits it routes such a resource on presence.
   */
  previousProperties?: Record<string, unknown> | undefined;
  /**
   * go-to-k/cdkd#4705 review H-6: route without the debug lines -- the caller
   * asks ahead of the create, which routes (and logs) again.
   */
  quiet?: boolean;
  /**
   * Suppress the `'sdk-coverage'` exemption for this call, keeping the sticky
   * CC route. Set by `--pin-cc-api` and -- required for correctness -- by
   * `--recreate-via-cc-api`, whose whole purpose is to force the CC layer:
   * without this the exemption would divert that explicit request straight
   * back to the SDK provider and the flag would silently no-op.
   *
   * Deliberately ignored by `'cc-broken'` entries: honoring a pin there would
   * keep a broken CC handler managing the resource, which is the bug those
   * entries exist to escape.
   */
  forceCcApi?: boolean | undefined;
}

/**
 * One auto-route hit returned by {@link ProviderRegistry.findAutoRouteHits}.
 * Used by `reportSdkUnwiredDecisions` (info-log surface) and by the plan
 * renderer's `[via CC API: <reason>]` audit tag.
 */
export interface AutoRouteHit {
  logicalId: string;
  resourceType: string;
  properties: string[];
}

/**
 * Provider registry for managing resource providers.
 *
 * Selection strategy for a fresh resource (see {@link getProviderFor}):
 * 1. Custom Resource (`Custom::*` / `AWS::CloudFormation::CustomResource`)
 *    → Custom Resource provider (recorded as `provisionedBy: 'sdk'`).
 * 2. Existing-state `provisionedBy: 'cc-api'` → Cloud Control (sticky).
 * 3. SDK Provider registered, no SDK-unwired properties (after the
 *    `--allow-unsupported-properties` override filter) → SDK Provider. A
 *    property absent from the schema snapshot counts as SDK-unwired unless
 *    it is read-only, allow-listed, on a type Cloud Control cannot take, or
 *    unchanged from the state record (issue #3713).
 * 4. SDK Provider registered, SDK-unwired properties present, NOT all
 *    in the allow set → Cloud Control (auto-route, info-logged). When the
 *    CC route is NOT viable — the type is `NON_PROVISIONABLE` (no CC
 *    handlers, e.g. AWS::FSx::FileSystem) or the provider sets
 *    `disableCcApiFallback` (e.g. NestedStackProvider) — throw the clear
 *    pre-flight error instead of failing opaquely at provisioning time.
 * 5. SDK Provider registered, SDK-unwired properties present, ALL in
 *    the allow set → SDK Provider (the user explicitly accepted the
 *    unwritten property, warn-logged).
 * 6. No SDK Provider, Cloud Control supports the type → Cloud Control.
 * 7. `--allow-unsupported-types` escape hatch → Cloud Control optimistically.
 * 8. Otherwise → throw (no provider available).
 *
 * SDK-provider-less Tier 3 (`NON_PROVISIONABLE`) types are rejected earlier
 * by {@link validateResourceTypes}. A Tier 1 type that is ALSO
 * NON_PROVISIONABLE (SDK provider registered for a type Cloud Control cannot
 * manage — e.g. AWS::FSx::FileSystem, AWS::DLM::LifecyclePolicy) passes the
 * type check but has no viable CC auto-route; rule 4's viability guard turns
 * that case into a clear pre-flight error.
 */

/**
 * The physicalId the SDK provider addresses a `provisionedBy: 'cc-api'`
 * record by, once routing sends that record to it (go-to-k/cdkd#5654): the
 * recorded id itself for a parity type, else the entry's declared
 * `normalizeCcPhysicalId` output. Throws, naming the resource, when the
 * normalizer refuses the recorded id. Every site that hands a cc-api record's
 * id to an SDK provider calls this: the deploy's in-place update (whose
 * success write persists the result with `provisionedBy: 'sdk'`) and
 * `readRecordAttributes` (the attribute heals and the NoEcho read, which
 * route a record as its own baseline and so take the same flip).
 *
 * `record` is the state record, read for its type, id and properties (the
 * RECORD's bag, which names the live resource), and `region` the region it
 * lives in (the stack's). The partition is the region's. The account comes
 * from {@link getAccountInfo}, whose per-credential cache the deploy or diff
 * has usually filled already, and only for an entry declaring
 * `normalizerReadsAccountId`, so no other type asks STS here
 * (go-to-k/cdkd#6490). Such an entry's normalizer first runs on a placeholder
 * account, so an id or properties it refuses never reach STS; a failed lookup
 * is thrown as it is, with its own class and remedy.
 */
export async function sdkAddressedPhysicalId(
  record: Pick<ResourceState, 'resourceType' | 'physicalId' | 'properties'>,
  logicalId: string,
  region: string
): Promise<string> {
  const { resourceType, physicalId } = record;
  const entry = STICKY_CC_MIGRATION_EXEMPT.get(resourceType);
  const normalize = entry?.normalizeCcPhysicalId;
  if (normalize === undefined) return physicalId;
  const reads = entry?.normalizerReadsAccountId === true;
  const ctx = {
    properties: record.properties ?? {},
    region,
    // Before the account is known, a well-formed placeholder: the first call
    // only checks the id and the properties, so a refused id never asks STS.
    accountId: reads ? ACCOUNT_PLACEHOLDER : '',
    partition: derivePartitionAndUrlSuffix(region).partition,
  };
  const normalized = normalizeOrRefuse(entry!, normalize, physicalId, ctx, logicalId, resourceType);
  if (!reads) return normalized;
  // Thrown as it is: an account lookup failure is not the id's, and keeps its
  // own class and remedy (AccountIdUnavailableError, a throttle).
  const { accountId } = await getAccountInfo(region);
  return normalizeOrRefuse(
    entry!,
    normalize,
    physicalId,
    { ...ctx, accountId },
    logicalId,
    resourceType
  );
}

/** A 12-digit account no lookup returns, for the account-free first pass. */
const ACCOUNT_PLACEHOLDER = '000000000000';

function normalizeOrRefuse(
  entry: StickyExemptEntry,
  normalize: NonNullable<StickyExemptEntry['normalizeCcPhysicalId']>,
  physicalId: string,
  ctx: CcPhysicalIdContext,
  logicalId: string,
  resourceType: string
): string {
  try {
    return normalize(physicalId, ctx);
  } catch (error) {
    const reason = describeAwsFailure(error).detail;
    const remedy =
      entry.mode === 'sdk-coverage'
        ? ` Pass --pin-cc-api ${logicalId} to keep it on Cloud Control.`
        : '';
    throw new Error(
      `${logicalId} (${resourceType}) cannot move from Cloud Control to its SDK provider: ${reason}.${remedy}`
    );
  }
}

/**
 * The record as the SDK provider's in-place update reads it after a flip: the
 * {@link sdkAddressedPhysicalId} id, and for an entry with a
 * `ccIdentityAttribute` that attribute set to the Cloud Control id, which IS
 * its value. The provider's own holder check reads it, so a record missing or
 * masking it is still checked against the resource Cloud Control recorded
 * (go-to-k/cdkd#6490).
 */
export async function sdkAddressedRecord(
  record: ResourceState,
  logicalId: string,
  region: string
): Promise<ResourceState> {
  const physicalId = await sdkAddressedPhysicalId(record, logicalId, region);
  const attribute = STICKY_CC_MIGRATION_EXEMPT.get(record.resourceType)?.ccIdentityAttribute;
  if (attribute === undefined) return { ...record, physicalId };
  return {
    ...record,
    physicalId,
    attributes: { ...record.attributes, [attribute]: record.physicalId },
  };
}

/**
 * Throws, naming the resource, when an SDK provider's read of a normalized
 * cc-api record answered for a resource other than the one Cloud Control
 * recorded: the entry's `ccIdentityAttribute` must equal the recorded Cloud
 * Control id (go-to-k/cdkd#6490). A no-op for any other record.
 */
export function assertSdkReadMatchesCcId(
  record: Pick<ResourceState, 'resourceType' | 'physicalId'>,
  logicalId: string,
  attributes: Record<string, unknown>
): void {
  const attribute = STICKY_CC_MIGRATION_EXEMPT.get(record.resourceType)?.ccIdentityAttribute;
  if (attribute === undefined || attributes[attribute] === record.physicalId) return;
  throw new Error(
    `${logicalId} (${record.resourceType}) cannot move from Cloud Control to its SDK provider: ` +
      `the resource its recorded properties name does not carry the ${attribute} Cloud Control recorded. ` +
      `Pass --pin-cc-api ${logicalId} to keep it on Cloud Control.`
  );
}

/** Why a `'cc-broken'` type cannot be routed to Cloud Control, as users read it. */
export const CC_BROKEN_REASON = "Cloud Control's handler cannot manage this type correctly";

/**
 * {@link CC_BROKEN_REASON} for a `'cc-broken'` sticky-exempt type, else
 * `undefined`. Deliberately NOT part of `ProviderRegistry.ccRouteUnavailableReason`:
 * that one also gates the auto-route of SCHEMA-KNOWN SDK-unwired properties, which a
 * `'cc-broken'` type keeps (see `getProviderFor`); its UNRECOGNIZED keys are
 * kept off Cloud Control separately, through the generated
 * `ccRouteUnavailable`. The two predicates are not interchangeable.
 */
export function ccBrokenReason(resourceType: string): string | undefined {
  return STICKY_CC_MIGRATION_EXEMPT.get(resourceType)?.mode === 'cc-broken'
    ? CC_BROKEN_REASON
    : undefined;
}

/**
 * Would a resource recorded as `provisionedBy: 'cc-api'` return to its SDK
 * provider on its next mutating deploy?
 *
 * THE one implementation of the flip condition. `ProviderRegistry.getProviderFor`
 * rule 2 and `cdkd diff`'s routing annotation both call it, which is the point:
 * an earlier revision had the registry and the renderer carrying separate
 * copies, and a mutation probe caught it -- changing "check BOTH property bags"
 * to "check the desired one twice" in the registry copy left the whole suite
 * green, because the only test of that condition exercised the OTHER copy. Two
 * implementations of one predicate means the tests can only ever pin one.
 *
 * It answers the EXEMPTION question only, deliberately not the whole routing
 * question: whether an SDK provider is registered for the type is knowable
 * only from a registry. A `true` means "the sticky rule will not hold this
 * resource", not "the SDK provider will run it" -- which is why `getProviderFor`
 * falls THROUGH to rules 3-5 rather than returning a provider from rule 2, and
 * why the diff token this drives says the resource is LEAVING Cloud Control
 * rather than naming its destination.
 *
 * The gates, in order:
 *
 * 1. Not exempt -> false. The sticky rule holds, as it always did.
 * 2. `'cc-broken'` -> true, unconditionally. Its CC handler cannot manage the
 *    resource at all, so no property bag would make staying correct, and a pin
 *    is deliberately not consulted: honoring one would pin the resource to the
 *    broken handler.
 * 3. `forceCcApi` -> false. `--pin-cc-api`, and `--recreate-via-cc-api`, whose
 *    explicit "use Cloud Control" would otherwise be silently reversed here.
 * 4. NO PROPERTIES, NO FLIP. A call with no template bag cannot establish
 *    anything about the resource. This single rule is what makes destroy,
 *    rollback deletes, the observed-capture re-derivation and the legacy
 *    `getProvider()` conservative for free rather than by four special cases,
 *    and it confines the flip to a mutating deploy -- the only moment the CC
 *    latency is actually paid, so exactly where issue #609's benefit lives.
 * 5. An ABSENT recorded bag is UNKNOWN, not empty, and blocks the flip. A
 *    caller holding a state record but not passing its bag is indistinguishable
 *    here from one with no record, and guessing "clean" would reopen the
 *    removal-deploy hole through the one door this exists to close.
 * 6. BOTH bags clean of actionable SDK-unwired properties. See
 *    `GetProviderForInput.previousProperties` for why the desired bag alone is
 *    not enough. An unrecognized key counts on PRESENCE here, never against a
 *    baseline, so it always keeps the resource on Cloud Control (issue #3713).
 */
export interface ReturnToSdkInput {
  resourceType: string;
  desiredProperties?: Record<string, unknown> | undefined;
  previousProperties?: Record<string, unknown> | undefined;
  allowedUnsupportedProperties?: ReadonlySet<string> | undefined;
  forceCcApi?: boolean | undefined;
  /**
   * The exemption table. Defaults to the shipped one; overridable ONLY so
   * tests can supply a synthetic entry.
   *
   * This is injecting DATA, not swapping the logic under test -- every gate
   * below runs unchanged, and the shipped table stays covered by the cases
   * that omit this. It exists because the both-bags condition is otherwise
   * unreachable: an admitted `'sdk-coverage'` type has an EMPTY sdkUnwired map
   * by construction (that is why it was admitted), so `findActionableSdkUnwired`
   * returns [] for every bag and the loop cannot discriminate. Measured -- with
   * the shipped table only, mutating the loop to read the desired bag twice, or
   * the recorded bag twice, left the whole suite green. The removal-deploy
   * case is the single most important thing this predicate does; it does not
   * get to be the untested one.
   */
  exemptions?: ReadonlyMap<string, StickyExemptEntry> | undefined;
}

export function wouldReturnToSdkProvider(input: ReturnToSdkInput): boolean {
  const {
    resourceType,
    desiredProperties,
    previousProperties,
    allowedUnsupportedProperties = new Set<string>(),
    forceCcApi = false,
    exemptions = STICKY_CC_MIGRATION_EXEMPT,
  } = input;
  const exemption = exemptions.get(resourceType);
  if (exemption === undefined) return false;
  if (exemption.mode === 'cc-broken') return true;
  if (forceCcApi) return false;
  if (desiredProperties === undefined) return false;
  if (previousProperties === undefined) return false;
  return [desiredProperties, previousProperties].every(
    (bag) => findActionableSdkUnwired(resourceType, bag, allowedUnsupportedProperties).length === 0
  );
}

export class ProviderRegistry {
  /** @internal */
  logger = getLogger().child('ProviderRegistry');
  /** @internal */
  providers = new Map<string, ResourceProvider>();
  /** @internal */
  cloudControlProvider: CloudControlProvider;
  /** @internal */
  customResourceProvider: CustomResourceProvider;
  private skipResourceTypes = new Set<string>();
  /** @internal */
  allowedUnsupportedTypes = new Set<string>();
  /** @internal */
  allowedUnsupportedProperties = new Set<string>();

  constructor() {
    this.cloudControlProvider = new CloudControlProvider();
    this.customResourceProvider = new CustomResourceProvider();
  }

  /**
   * Escape hatch for the `--allow-unsupported-types` CLI flag. Named types
   * bypass the pre-flight unsupported-type rejection and are routed through
   * Cloud Control optimistically (which will likely still fail for genuinely
   * NON_PROVISIONABLE types — but the choice is the user's). Per-type rather
   * than a blanket flag so the user explicitly acknowledges each type.
   */
  allowUnsupportedTypes(resourceTypes: Iterable<string>): void {
    for (const resourceType of resourceTypes) {
      this.allowedUnsupportedTypes.add(resourceType);
      this.logger.debug(`Allowing unsupported resource type via escape hatch: ${resourceType}`);
    }
  }

  /**
   * Escape hatch for the `--allow-unsupported-properties` CLI flag. Each entry
   * is a `<ResourceType>:<PropertyName>` token (e.g.
   * `AWS::ApiGatewayV2::Api:Body`). As of issue
   * [#614](https://github.com/go-to-k/cdkd/issues/614), the flag now means
   * "force the SDK Provider path and leave the property unwritten" — the default
   * for an un-flagged SDK-unwired property is to auto-route the resource
   * through Cloud Control instead. Per-type-property (not blanket) so the
   * user explicitly acknowledges each unwritten property they accept.
   */
  allowUnsupportedProperties(entries: Iterable<string>): void {
    for (const entry of entries) {
      this.allowedUnsupportedProperties.add(entry);
      this.logger.debug(`Allowing unsupported property via escape hatch: ${entry}`);
    }
  }

  /**
   * The `--allow-unsupported-properties` set this registry was configured with,
   * for the diff's desired-side narrowing (issue
   * [#2750](https://github.com/go-to-k/cdkd/issues/2750)), which must not report
   * a change for a property the SDK route will not write.
   *
   * Not the only reader of the underlying CLI value — `deploy.ts` builds a
   * SECOND set from `options.allowUnsupportedProperties` for
   * `validateRecreateTargets`. That copy predates this getter and is a
   * separate question (which recreate targets are legal), not a second
   * spelling of the routing rule; collapsing the two is issue-worthy, not
   * something to do from here.
   *
   * DATA, not a predicate. Every question about the set — is this drop
   * actionable, is it accepted — is answered by the shared helpers in
   * `property-coverage.ts`, so a second consumer cannot re-derive the rule and
   * disagree with `getProviderFor`. Read-only for the same reason: the flag is
   * a deploy-time input, and a caller that could add to it here would change a
   * routing decision from outside the routing layer.
   */
  getAllowedUnsupportedProperties(): ReadonlySet<string> {
    return this.allowedUnsupportedProperties;
  }

  /**
   * Configure the response bucket for custom resources
   * This allows Lambda handlers using cfn-response to send responses via S3
   */
  setCustomResourceResponseBucket(bucket: string): void {
    this.customResourceProvider.setResponseBucket(bucket);
    this.logger.debug(`Custom resource response bucket set to: ${bucket}`);
  }

  /**
   * Register a resource type to be skipped during deployment
   *
   * @param resourceType CloudFormation resource type to skip
   */
  skipResourceType(resourceType: string): void {
    this.logger.debug(`Registering ${resourceType} to be skipped`);
    this.skipResourceTypes.add(resourceType);
  }

  /**
   * Register a specific provider for a resource type
   *
   * @param resourceType CloudFormation resource type (e.g., "AWS::S3::Bucket")
   * @param provider Provider instance
   */
  register(resourceType: string, provider: ResourceProvider): void {
    this.logger.debug(`Registering provider for ${resourceType}`);
    this.providers.set(resourceType, provider);
  }

  /**
   * Unregister a provider for a resource type
   */
  unregister(resourceType: string): void {
    this.logger.debug(`Unregistering provider for ${resourceType}`);
    this.providers.delete(resourceType);
  }

  getProviderFor(input: GetProviderForInput): ProviderRoutingDecision {
    return getProviderFor.call(this, input);
  }

  /**
   * Why the Cloud Control auto-route cannot serve `resourceType`, or
   * `undefined` when it can. The ONE predicate both refusal sites
   * (`getProviderFor` and `reportSdkUnwiredDecisions`) and the accepted-drop
   * warn read, so the warn that predicts what a flag-less deploy does cannot
   * disagree with the refusal that deploy then hits (issue #2792). Public for
   * `validateRecreateTargets`, which refuses `--recreate-via-cc-api` on such a
   * type before the recreate deletes anything (issue #3887).
   */
  ccRouteUnavailableReason(resourceType: string): string | undefined {
    if (hasNoCloudControlHandlers(resourceType)) {
      return NO_CC_HANDLERS_REASON;
    }
    if (this.providers.get(resourceType)?.disableCcApiFallback === true) {
      return "the type's SDK provider opts out of the Cloud Control fallback (disableCcApiFallback)";
    }
    return undefined;
  }

  /** @internal */
  buildUnroutableSdkUnwiredMessage(
    resourceType: string,
    drops: ReadonlyArray<{ property: string; rationale: string }>,
    reason: string
  ): string {
    return buildUnroutableSdkUnwiredMessage.call(this, resourceType, drops, reason);
  }

  /**
   * Legacy entry point that returns just the provider. Delegates to
   * {@link getProviderFor} with no properties / no state-recorded layer —
   * which means SDK-unwired auto-routing CANNOT fire (no template to
   * inspect) and `provisionedBy === undefined` is treated as SDK semantics
   * (legacy default). Use {@link getProviderFor} when the caller has
   * properties / state — otherwise a CC-managed existing resource will get
   * an SDK Provider on its update / delete path, which is the
   * silent-data-corruption hazard that v7's schema bump is meant to
   * prevent.
   *
   * Kept on the public surface for the destroy / drift / state-refresh
   * paths whose call sites only know the resource type (the caller should
   * still thread `provisionedBy` from state when it's available; this
   * shape is only safe for type-only callers).
   */
  getProvider(resourceType: string): ResourceProvider {
    return this.getProviderFor({ resourceType }).provider;
  }

  /**
   * Check if a resource type should be skipped
   */
  shouldSkipResource(resourceType: string): boolean {
    return this.skipResourceTypes.has(resourceType);
  }

  /**
   * Check if a provider is available for a resource type
   */
  hasProvider(resourceType: string): boolean {
    // Skipped resources are considered as "having a provider" to avoid validation errors
    if (this.shouldSkipResource(resourceType)) {
      return true;
    }
    // Escape-hatch-allowed types are treated as available (routed to Cloud Control).
    if (this.allowedUnsupportedTypes.has(resourceType)) {
      return true;
    }
    return (
      this.providers.has(resourceType) ||
      CloudControlProvider.isSupportedResourceType(resourceType) ||
      isCustomResource(resourceType)
    );
  }

  /**
   * Get the Cloud Control provider instance (for resource state lookup)
   */
  getCloudControlProvider(): CloudControlProvider {
    return this.cloudControlProvider;
  }

  /**
   * Get all registered resource types (excluding Cloud Control)
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get provider type for a resource type
   *
   * @returns 'sdk' | 'cloud-control' | null
   */
  getProviderType(resourceType: string): 'sdk' | 'cloud-control' | null {
    if (this.providers.has(resourceType)) {
      return 'sdk';
    }
    if (CloudControlProvider.isSupportedResourceType(resourceType)) {
      return 'cloud-control';
    }
    // Escape-hatch-allowed types are routed through Cloud Control by
    // getProvider/hasProvider; keep this method consistent.
    if (this.allowedUnsupportedTypes.has(resourceType)) {
      return 'cloud-control';
    }
    return null;
  }

  validateResourceTypes(resourceTypes: Set<string>): void {
    return validateResourceTypes.call(this, resourceTypes);
  }

  validateResourceProperties(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
      provisionedBy?: 'sdk' | 'cc-api' | undefined;
      previousProperties?: Record<string, unknown> | undefined;
    }>
  ): void {
    return validateResourceProperties.call(this, resources);
  }

  validateMutuallyExclusiveProperties(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
    }>
  ): void {
    return validateMutuallyExclusiveProperties.call(this, resources);
  }

  validateNestedRequiredProperties(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
    }>
  ): void {
    return validateNestedRequiredProperties.call(this, resources);
  }

  validateCustomResourceSecureReferences(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
    }>
  ): void {
    return validateCustomResourceSecureReferences.call(this, resources);
  }

  reportSdkUnwiredDecisions(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
      provisionedBy?: 'sdk' | 'cc-api' | undefined;
      /** The state record's bag — `GetProviderForInput.previousProperties`. */
      previousProperties?: Record<string, unknown> | undefined;
    }>
  ): void {
    return reportSdkUnwiredDecisions.call(this, resources);
  }

  /** @internal */
  reportUnrecognizedProperties(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown> | undefined,
    route: {
      provisionedBy?: 'sdk' | 'cc-api' | undefined;
      autoRouted: boolean;
      previousProperties?: Record<string, unknown> | undefined;
    }
  ): void {
    return reportUnrecognizedProperties.call(this, logicalId, resourceType, properties, route);
  }

  findAutoRouteHits(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
      /** The state record's bag — `GetProviderForInput.previousProperties`. */
      previousProperties?: Record<string, unknown> | undefined;
    }>
  ): AutoRouteHit[] {
    return findAutoRouteHits.call(this, resources);
  }
}

/**
 * True for the types `CustomResourceProvider` serves. Exported for
 * `type-change-guard.ts`'s `equalIdNamesSameResource`: these types are the one
 * family whose physical ids share ONE namespace across types.
 */
export function isCustomResource(resourceType: string): boolean {
  return (
    resourceType.startsWith('Custom::') || resourceType === 'AWS::CloudFormation::CustomResource'
  );
}
