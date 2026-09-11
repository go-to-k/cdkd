import type { ResourceProvider } from '../types/resource.js';
import { CloudControlProvider } from './cloud-control-provider.js';
import { CustomResourceProvider } from './providers/custom-resource-provider.js';
import { getLogger } from '../utils/logger.js';
import { isNonProvisionable, unsupportedTypeIssueUrl } from './unsupported-types.js';
import {
  findAcceptedSilentDrops,
  findActionableSilentDrops,
  findSilentDropProperties,
  findUnrecognizedProperties,
  getPropertyCoverage,
  unsupportedPropertyIssueUrl,
} from './property-coverage.js';
import {
  buildMutuallyExclusiveMessage,
  findMutuallyExclusiveViolations,
} from './mutually-exclusive-properties.js';

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
 * Control because of silent-drop properties) the list of property names
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
   * ONE reader: `deploy-engine.ts`'s update dispatch, which turns it into the
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
 * drives the silent-drop check (only consulted on a fresh deploy);
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
   * case only: the REMOVAL deploy. A resource carries silent-drop property `P`
   * applied under CC; the user deletes `P` from the template. The desired bag
   * is now clean, so a desired-only condition would route THAT deploy to the
   * SDK provider -- which cannot unset `P` -- silently skipping the removal,
   * which is the exact bug the auto-route exists to prevent. Under CC the same
   * deploy patches `P` away correctly, and the NEXT deploy flips. Convergent,
   * one deploy late, never wrong.
   */
  previousProperties?: Record<string, unknown> | undefined;
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
 * Used by `reportSilentDropDecisions` (info-log surface) and by the plan
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
 * 3. SDK Provider registered, no silent-drop properties (after the
 *    `--allow-unsupported-properties` override filter) → SDK Provider.
 * 4. SDK Provider registered, silent-drop properties present, NOT all
 *    in the allow set → Cloud Control (auto-route, info-logged). When the
 *    CC route is NOT viable — the type is `NON_PROVISIONABLE` (no CC
 *    handlers, e.g. AWS::FSx::FileSystem) or the provider sets
 *    `disableCcApiFallback` (e.g. NestedStackProvider) — throw the clear
 *    pre-flight error instead of failing opaquely at provisioning time.
 * 5. SDK Provider registered, silent-drop properties present, ALL in
 *    the allow set → SDK Provider (the user explicitly accepted the
 *    silent drop, warn-logged).
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
 * How a type escapes the sticky `provisionedBy: 'cc-api'` routing rule.
 *
 * - `'cc-broken'` -- the CC handler CANNOT correctly manage the resource, so
 *   keeping existing state pinned to cc-api keeps a live bug alive. The
 *   fall-through is UNCONDITIONAL: no property check, and `forceCcApi` is
 *   ignored, because pinning here would be pinning to the broken handler.
 * - `'sdk-coverage'` -- CC routing WORKS, it is merely slower; the SDK
 *   provider has since been backfilled (issue #609) to cover the properties
 *   this resource actually uses. The fall-through is CONDITIONAL on that being
 *   true of the resource in hand, and suppressible with `forceCcApi`.
 */
export type StickyExemptMode = 'cc-broken' | 'sdk-coverage';

/**
 * One type's admission to the sticky-CC exemption, with the evidence that
 * admitted it.
 *
 * The fields are not documentation. `tests/unit/provisioning/
 * sticky-exempt-registry.test.ts` requires `integFixture` to name a directory
 * that EXISTS under `tests/integration/` and to have at least one row in
 * `docs/_generated/integ-last-run.tsv` -- so an entry added before its parity
 * arm was ever run against real AWS fails the unit suite. That is the whole
 * mechanism behind "evidence rather than assumption": physicalId parity is an
 * empirical per-type fact about what the CC handler mints as `Identifier`
 * versus what the SDK provider stores as `physicalId`, and it is FALSE in
 * general (composite ids, ARN-vs-name divergences). Asserting it from provider
 * source is not the same as observing it on a live resource.
 */
export interface StickyExemptEntry {
  mode: StickyExemptMode;
  /** What both layers store as physicalId, in words, for a reviewer. */
  physicalIdForm: string;
  /** The issue that admitted this type. */
  issue: string;
  /** The integ fixture whose run OBSERVED the parity. Must exist and have run. */
  integFixture: string;
}

/**
 * Types exempt from the sticky `provisionedBy: 'cc-api'` routing rule.
 *
 * The sticky rule (rule 2 in `getProviderFor`) exists to avoid physical-ID
 * churn when an SDK provider is backfilled for a type Cloud Control was
 * already managing fine. Both exemption modes are narrow escapes from it; see
 * `StickyExemptMode` for which applies when.
 *
 * Condition 2 -- physicalId parity -- is a hard requirement in BOTH modes and
 * is what makes a flip churn-free. It is also why this is a curated table
 * rather than a predicate: an automatic flip keyed on "the type has coverage"
 * would assert parity for types nobody measured.
 */
export const STICKY_CC_MIGRATION_EXEMPT: ReadonlyMap<string, StickyExemptEntry> = new Map([
  [
    'AWS::Scheduler::Schedule',
    {
      // A schedule in a custom ScheduleGroup is unaddressable via CC (the
      // handlers resolve the bare-Name identifier against the DEFAULT group)
      // -- CC UPDATE fails NotFound and CC DELETE silently no-ops, orphaning a
      // live schedule. Broken, not slow.
      mode: 'cc-broken' as const,
      physicalIdForm:
        'both layers store the bare schedule name; the state properties carry ' +
        'GroupName, so the SDK provider addresses existing records correctly',
      issue: 'https://github.com/go-to-k/cdkd/issues/961',
      integFixture: 'scheduler-custom-group',
    },
  ],
  [
    'AWS::SNS::Topic',
    {
      // The first 'sdk-coverage' member (issue #2719). CC manages topics
      // correctly -- it is only slower -- so this is the mode that had no
      // members before: the type's silentDrop map is empty (issue #609
      // backfill), so a resource using it takes the SDK path on a fresh
      // deploy, and there was no way for one already pinned to cc-api to
      // follow it there short of a destroy + recreate.
      mode: 'sdk-coverage' as const,
      physicalIdForm:
        'both layers store the topic ARN: the schema primaryIdentifier is ' +
        'TopicArn and SnsTopicProvider.create records the CreateTopic TopicArn',
      issue: 'https://github.com/go-to-k/cdkd/issues/2719',
      integFixture: 'cc-to-sdk-reroute',
    },
  ],
]);

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
 * 6. BOTH bags clean of actionable silent drops. See
 *    `GetProviderForInput.previousProperties` for why the desired bag alone is
 *    not enough.
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
   * unreachable: an admitted `'sdk-coverage'` type has an EMPTY silentDrop map
   * by construction (that is why it was admitted), so `findActionableSilentDrops`
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
    (bag) => findActionableSilentDrops(resourceType, bag, allowedUnsupportedProperties).length === 0
  );
}

export class ProviderRegistry {
  private logger = getLogger().child('ProviderRegistry');
  private providers = new Map<string, ResourceProvider>();
  private cloudControlProvider: CloudControlProvider;
  private customResourceProvider: CustomResourceProvider;
  private skipResourceTypes = new Set<string>();
  private allowedUnsupportedTypes = new Set<string>();
  private allowedUnsupportedProperties = new Set<string>();

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
   * `AWS::Lambda::Function:RuntimeManagementConfig`). As of issue
   * [#614](https://github.com/go-to-k/cdkd/issues/614), the flag now means
   * "force the SDK Provider path and accept the silent drop" — the default
   * for an un-flagged silent-drop property is to auto-route the resource
   * through Cloud Control instead. Per-type-property (not blanket) so the
   * user explicitly acknowledges each silent drop they accept.
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

  /**
   * Resolve the provider for a resource using the full routing decision
   * matrix (see class docstring). The returned object carries the chosen
   * provider, the `provisionedBy` layer label to persist on the resource's
   * state record, and (for the CC auto-route case) the names of the
   * silent-drop properties that drove the decision so callers can render
   * `[via CC API: <reason>]` plan annotations.
   *
   * @throws Error if no provider can be found for the type.
   */
  getProviderFor(input: GetProviderForInput): ProviderRoutingDecision {
    const { resourceType, properties, provisionedBy } = input;

    // 1. Custom Resource — has no SDK/CC dichotomy, but we record it as
    //    `'sdk'` so the state field is always populated on v7+ writes.
    if (isCustomResource(resourceType)) {
      this.logger.debug(`Using Custom Resource provider for ${resourceType}`);
      return { provider: this.customResourceProvider, provisionedBy: 'sdk' };
    }

    // 2. Sticky: an existing resource recorded as `provisionedBy: 'cc-api'`
    //    stays on Cloud Control regardless of whether the SDK Provider has
    //    since gained coverage. Avoids physical-ID churn / destroy+recreate
    //    cycles on every backfill release.
    //
    //    Two exemptions escape it and differ in how conditional they are — see
    //    STICKY_CC_MIGRATION_EXEMPT and {@link wouldReturnToSdkProvider}. Both
    //    FALL THROUGH to rules 3-5 rather than returning an SDK provider here,
    //    so the re-route is decided by the same matrix as a fresh resource:
    //    a type whose provider was unregistered between releases degrades to
    //    the CC route (rule 6) instead of throwing, and a 'cc-broken' type
    //    whose bag has silent drops still auto-routes (rule 5).
    let returningToSdk = false;
    if (provisionedBy === 'cc-api') {
      const canReturn = wouldReturnToSdkProvider({
        resourceType,
        desiredProperties: properties,
        previousProperties: input.previousProperties,
        allowedUnsupportedProperties: this.allowedUnsupportedProperties,
        forceCcApi: input.forceCcApi === true,
      });
      if (!canReturn) {
        this.logger.debug(
          `Routing ${resourceType} via Cloud Control (state-recorded provisionedBy=cc-api)`
        );
        return { provider: this.cloudControlProvider, provisionedBy: 'cc-api' };
      }
      returningToSdk = true;
    }

    // 3-5. SDK Provider registered: silent-drop check decides between SDK
    //      Provider and the CC API auto-route.
    const specificProvider = this.providers.get(resourceType);
    if (specificProvider) {
      const actionableDrops = findActionableSilentDrops(
        resourceType,
        properties,
        this.allowedUnsupportedProperties
      );
      if (actionableDrops.length === 0) {
        // No silent drops, or every drop is in the allow set → SDK Provider.
        this.logger.debug(`Using specific SDK provider for ${resourceType}`);
        if (returningToSdk) {
          // The only place `sdkMigration` is set. It marks a TRANSITION, so it
          // is attached here rather than to every SDK decision: the state
          // record says 'sdk' from the next write on, and this branch is not
          // reached again for the same resource.
          this.logger.debug(
            `${resourceType} is returning to its SDK provider from a ` +
              `state-recorded cc-api route; physical id is preserved`
          );
          return { provider: specificProvider, provisionedBy: 'sdk', sdkMigration: true };
        }
        return { provider: specificProvider, provisionedBy: 'sdk' };
      }
      // The CC auto-route target must actually be able to manage the type.
      // Providers for NON_PROVISIONABLE types (no Cloud Control handlers)
      // declare `disableCcApiFallback` — e.g. FSxFileSystemProvider, whose
      // Windows/ONTAP/OpenZFS config blocks are deliberately unhandled;
      // routing them to CC would fail at provisioning time with an opaque
      // UnsupportedActionException. Throw the clear error here instead.
      // (`isNonProvisionable` additionally covers the mid-transition window
      // where a provider is registered but the Tier 3 regen hasn't run.)
      if (isNonProvisionable(resourceType) || specificProvider.disableCcApiFallback === true) {
        throw new Error(this.buildUnroutableSilentDropMessage(resourceType, actionableDrops));
      }
      // Silent drops exist that the user has NOT opted into via the override
      // → auto-route through Cloud Control (which forwards the full property
      // map to AWS, closing the silent-drop bug). Closes issue #614.
      this.logger.debug(
        `Auto-routing ${resourceType} via Cloud Control (silent-drop properties: ${actionableDrops
          .map((d) => d.property)
          .join(', ')})`
      );
      return {
        provider: this.cloudControlProvider,
        provisionedBy: 'cc-api',
        ccRouteReason: { properties: actionableDrops.map((d) => d.property) },
      };
    }

    // 6. No SDK Provider — try Cloud Control if it supports the type.
    if (CloudControlProvider.isSupportedResourceType(resourceType)) {
      this.logger.debug(`Using Cloud Control API provider for ${resourceType}`);
      return { provider: this.cloudControlProvider, provisionedBy: 'cc-api' };
    }

    // 7. Escape hatch: user explicitly allowed this unsupported type — try
    //    Cloud Control optimistically (likely fails for NON_PROVISIONABLE).
    if (this.allowedUnsupportedTypes.has(resourceType)) {
      this.logger.debug(
        `Routing escape-hatch-allowed type ${resourceType} through Cloud Control API`
      );
      return { provider: this.cloudControlProvider, provisionedBy: 'cc-api' };
    }

    // 8. No provider available.
    throw new Error(
      `No provider available for resource type: ${resourceType}. ` +
        `This resource type is not supported by Cloud Control API and no SDK provider is registered.`
    );
  }

  /**
   * Error message for a resource whose template uses SDK-provider-unhandled
   * properties on a type where the Cloud Control auto-route (issue #614) is
   * NOT viable — `ProvisioningType: NON_PROVISIONABLE` (no CC handlers) or a
   * provider-level `disableCcApiFallback` opt-out. Includes each property's
   * `unhandledByDesign` rationale so the user sees WHY it is unhandled, plus
   * the `--allow-unsupported-properties` escape hatch (which forces the SDK
   * path and accepts the drop — the provider may still reject the resource
   * if the property is load-bearing, e.g. a non-Lustre FSx variant config).
   */
  private buildUnroutableSilentDropMessage(
    resourceType: string,
    drops: ReadonlyArray<{ property: string; rationale: string }>
  ): string {
    const details = drops.map((d) => `  - ${d.property}: ${d.rationale}`).join('\n');
    const overrideHint = drops.map((d) => `${resourceType}:${d.property}`).join(',');
    const reason = isNonProvisionable(resourceType)
      ? 'ProvisioningType: NON_PROVISIONABLE — Cloud Control has no handlers for it'
      : "the type's SDK provider opts out of the Cloud Control fallback (disableCcApiFallback)";
    return (
      `${resourceType} uses properties cdkd's SDK Provider does not handle, and ` +
      `this type cannot fall back to Cloud Control API (${reason}):\n` +
      `${details}\n` +
      `Remove the properties, or force the SDK provider path and accept the drop via ` +
      `--prefer-sdk-route ${overrideHint} ` +
      `(the provider may still reject the resource if the property is required).`
    );
  }

  /**
   * Legacy entry point that returns just the provider. Delegates to
   * {@link getProviderFor} with no properties / no state-recorded layer —
   * which means silent-drop auto-routing CANNOT fire (no template to
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

  /**
   * Validate that all resource types have available providers
   *
   * This should be called before deployment starts to ensure all resources can be provisioned.
   *
   * @param resourceTypes Set of resource types to validate
   * @throws Error if any resource type doesn't have a provider
   */
  validateResourceTypes(resourceTypes: Set<string>): void {
    const unsupportedTypes: string[] = [];

    for (const resourceType of resourceTypes) {
      if (!this.hasProvider(resourceType)) {
        unsupportedTypes.push(resourceType);
      }
    }

    if (unsupportedTypes.length > 0) {
      const details = unsupportedTypes
        .map((type) => {
          const reason = isNonProvisionable(type)
            ? 'AWS reports this type as NON_PROVISIONABLE (Cloud Control API cannot manage it) and cdkd has no SDK provider for it.'
            : "cdkd does not currently support this type — no SDK provider is registered, and the type is either on cdkd's Cloud Control blocklist (pending a dedicated SDK provider) or is not an AWS:: namespace.";
          return `  - ${type}\n      ${reason}\n      Request support: ${unsupportedTypeIssueUrl(type)}`;
        })
        .join('\n');
      throw new Error(
        `The following resource types are not supported by cdkd:\n` +
          details +
          `\n\nTo attempt deployment anyway (Cloud Control will likely fail for NON_PROVISIONABLE types), ` +
          `re-run with: --allow-unsupported-types ${unsupportedTypes.join(',')}`
      );
    }

    this.logger.debug(
      `Validated ${resourceTypes.size} resource types: all have available providers`
    );
  }

  /**
   * Walk every resource in the template and identify top-level CFn
   * properties cdkd's SDK provider would silently drop on write. As of
   * issue [#614](https://github.com/go-to-k/cdkd/issues/614), silent drops
   * auto-route the resource through Cloud Control API by default (see
   * {@link getProviderFor}) — the method emits info-level routing decisions
   * for each silent-drop resource, plus warn-level lines for resources
   * where the user explicitly opted into the silent drop via
   * `--allow-unsupported-properties`. The ONE remaining throw path is the
   * CC-route viability guard: when the auto-route target cannot manage the
   * type (`NON_PROVISIONABLE` or a provider-level `disableCcApiFallback`
   * opt-out — e.g. AWS::FSx::FileSystem's Windows/ONTAP/OpenZFS blocks),
   * this rejects pre-flight with a clear per-property error instead of
   * letting provisioning fail opaquely.
   *
   * Must be called AFTER {@link validateResourceTypes} — type-level errors
   * are still hard rejects. For a type allowed via `--allow-unsupported-types`,
   * the property check is a no-op (`findSilentDropProperties` returns `[]`
   * for non-Tier-1 / unknown types).
   *
   * Since issue [#1634](https://github.com/go-to-k/cdkd/issues/1634) this
   * ALSO runs the mutually-exclusive-property check
   * ({@link validateMutuallyExclusiveProperties}), which throws BEFORE any
   * routing decision is logged — a template CloudFormation itself rejects
   * should not first produce a page of routing chatter.
   *
   * @see findAutoRouteHits for the pure-functional pre-deploy plan-builder
   *      that returns the same information without logging.
   */
  validateResourceProperties(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
      provisionedBy?: 'sdk' | 'cc-api' | undefined;
    }>
  ): void {
    // Materialized because it is walked TWICE below and the caller's argument
    // is an Iterable — the deploy engine passes an array today, but a
    // generator would be silently empty on the second pass.
    const materialized = [...resources];
    this.validateMutuallyExclusiveProperties(materialized);
    this.reportSilentDropDecisions(materialized);
  }

  /**
   * Reject a template that declares two or more MUTUALLY EXCLUSIVE top-level
   * properties on one resource (issue
   * [#1634](https://github.com/go-to-k/cdkd/issues/1634)).
   *
   * Aggregated into ONE error listing every offending resource, mirroring
   * {@link validateResourceTypes} — a template with three bad routes should
   * report three, not fail three deploys in a row. There is deliberately no
   * `--allow-*` escape hatch: the combination is invalid at CloudFormation and
   * at the service API, so the only correct outcome is a template edit (see
   * the rule module's header).
   *
   * Unlike the provider-side refusal this fires even when the resource already
   * exists and the deploy diff classifies NO_CHANGE, which is the gap the
   * issue was filed for.
   */
  validateMutuallyExclusiveProperties(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
    }>
  ): void {
    const lines: string[] = [];
    for (const { logicalId, resourceType, properties } of resources) {
      for (const violation of findMutuallyExclusiveViolations(resourceType, properties)) {
        lines.push(buildMutuallyExclusiveMessage(logicalId, violation));
      }
    }
    if (lines.length === 0) return;

    throw new Error(
      `The following resources declare mutually exclusive properties:\n` +
        lines.join('\n') +
        `\n\nCloudFormation rejects these combinations too — edit the template to ` +
        `declare only one of each set.`
    );
  }

  /**
   * Info-log every silent-drop routing decision (auto-route via CC API) and
   * warn-log every silent drop the user explicitly opted into via
   * `--allow-unsupported-properties` (forced SDK path, the property will
   * be dropped). Does not mutate state; throws ONLY for the CC-route
   * viability guard (un-allowed silent drops on a type Cloud Control cannot
   * manage — see {@link buildUnroutableSilentDropMessage}).
   *
   * Issue [#614](https://github.com/go-to-k/cdkd/issues/614). Replaces the
   * pre-v0.16x throw path: silent drops are now a routing signal, not an
   * error (except the viability guard above).
   *
   * When the optional `provisionedBy` (from existing state) is `'cc-api'`,
   * the auto-route info line is demoted to `debug` — the resource has been
   * on CC for at least one prior deploy, so the routing decision is
   * **continuation of sticky state, not a fresh auto-route**. Surfacing the
   * info line every deploy would be repetitive noise. The warn line for
   * explicit `--allow-unsupported-properties` overrides is NOT demoted —
   * that override is an active user choice for THIS deploy and should
   * surface every time.
   */
  reportSilentDropDecisions(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
      provisionedBy?: 'sdk' | 'cc-api' | undefined;
    }>
  ): void {
    for (const { logicalId, resourceType, properties, provisionedBy } of resources) {
      const drops = findSilentDropProperties(resourceType, properties);

      // The two lists are NOT a partition of `drops`, and treating them as one
      // was a false warn (issue #2750). The allow set is per `<Type>:<Prop>`
      // while the ROUTE is per resource, and TWO things send a resource to
      // Cloud Control — which forwards the full property map, so the
      // allow-listed keys on it reach AWS after all and no drop happens:
      //
      //   - one UN-ALLOWED drop auto-routes it. `findAcceptedSilentDrops`
      //     answers that and is empty in exactly that case — the same
      //     predicate the record write and the diff read.
      //   - a `provisionedBy: 'cc-api'` record keeps it there (rule 2), for
      //     any bag. That is `stickyCc`, and it is the SAME test
      //     `reportUnrecognizedProperties` already makes below; the exemption
      //     lookup is what keeps a type that will flip BACK to the SDK route
      //     from suppressing a warn about a drop that will then happen.
      //
      // Without the second, this warn told a user with a sticky `cc-api`
      // alarm that `EvaluationWindow` "will be silently dropped" while Cloud
      // Control was writing it, and prescribed removing the override — a
      // no-op, since the resource was already on the route that remedy names.
      const stickyCc = provisionedBy === 'cc-api' && !STICKY_CC_MIGRATION_EXEMPT.has(resourceType);
      const overridden = stickyCc
        ? []
        : findAcceptedSilentDrops(resourceType, properties, this.allowedUnsupportedProperties);
      const autoRouted = drops
        .map(({ property }) => property)
        .filter(
          (property) => !this.allowedUnsupportedProperties.has(`${resourceType}:${property}`)
        );

      if (autoRouted.length > 0) {
        // The CC auto-route is only viable when Cloud Control can actually
        // manage the type. For a NON_PROVISIONABLE type (or a provider that
        // opted out of CC fallback) the route would fail at provisioning
        // time with an opaque error — reject pre-flight with the clear one.
        const provider = this.providers.get(resourceType);
        if (isNonProvisionable(resourceType) || provider?.disableCcApiFallback === true) {
          throw new Error(
            `${logicalId}: ${this.buildUnroutableSilentDropMessage(
              resourceType,
              drops.filter((d) => autoRouted.includes(d.property))
            )}`
          );
        }
        const propList = autoRouted.join(', ');
        const overrideHint = autoRouted.map((p) => `${resourceType}:${p}`).join(',');
        const message =
          `${logicalId} (${resourceType}): routing via Cloud Control API ` +
          `(cdkd's SDK Provider does not yet wire ${propList} — CC API will ` +
          `forward the full property map. Override via ` +
          `--prefer-sdk-route ${overrideHint}.)`;
        if (provisionedBy === 'cc-api') {
          // Sticky continuation — already on CC from a prior deploy.
          // Debug-only to avoid repetitive noise on every redeploy.
          this.logger.debug(message);
        } else {
          this.logger.info(message);
        }
      }

      // Say when the user's preference went INERT, because from their side an
      // explicit instruction looks ignored (issue
      // [#3000](https://github.com/go-to-k/cdkd/issues/3000)).
      //
      // OUTSIDE the auto-route block, and with the cause chosen rather than
      // assumed, because there are TWO ways to be inert and they have opposite
      // remedies. A first cut lived inside that block and named the sibling
      // unconditionally: on a sticky resource it then printed a cause that is
      // false (rule 2 returns Cloud Control before any drop is consulted) and a
      // remedy that is a no-op (widening the set cannot beat a sticky record) —
      // the same shape issue [#2750](https://github.com/go-to-k/cdkd/issues/2750)
      // retired, prescribing a route the resource is already on.
      //
      // It also stayed silent in the case most likely to be reported: sticky
      // with EVERY drop covered, where `autoRouted` is empty, `overridden` is
      // emptied by `stickyCc`, and Cloud Control writes the values anyway.
      const named = drops
        .map(({ property }) => property)
        .filter((property) => this.allowedUnsupportedProperties.has(`${resourceType}:${property}`));
      if (named.length > 0 && (stickyCc || autoRouted.length > 0)) {
        const list = named.join(', ');
        const isAre = named.length === 1 ? 'is' : 'are';
        // STICKY wins when both hold: it is the earlier decision, so naming the
        // sibling would name a cause that is not the operative one.
        const [cause, remedy] = stickyCc
          ? [
              `this resource's state record already routes it to Cloud Control ` +
                `(provisionedBy: cc-api), which is decided before any property is consulted`,
              // NO COMMAND, deliberately — the same call the create-only
              // sentence below makes, for the same reason and against the
              // MIRROR flag. `--recreate-via-sdk-provider <LogicalId>` looks
              // like the answer and is refused in most of this branch's own
              // population: `ambiguousIntentSdk` refuses it while any drop
              // outside the preference is still actionable (which is exactly
              // the `stickyCc && autoRouted.length > 0` half), 17 of the types
              // carrying silentDrop entries are STATEFUL and need
              // `--force-stateful-recreation` on top, and neither flag can
              // address a resource inside a nested-stack child. It is also
              // DESTRUCTIVE, which a one-line remedy must not omit. A sentence
              // that has to be right about four conditions is a sentence that
              // will be wrong about one; the deploy-safety docs carry it with
              // its conditions.
              `Returning this resource to the SDK provider is a destroy-and-recreate, not a ` +
                `flag change — see docs/cli-deploy-safety.md. Widening ` +
                `--prefer-sdk-route alone cannot do it.`,
            ]
          : [
              `${autoRouted.join(', ')} ${autoRouted.length === 1 ? 'is' : 'are'} not covered ` +
                `by it, and one uncovered property routes the whole RESOURCE to Cloud Control`,
              `To keep the resource on its SDK provider, add ` +
                `${autoRouted.map((p) => `${resourceType}:${p}`).join(',')} to --prefer-sdk-route as well.`,
            ];
        this.logger.warn(
          `${logicalId} (${resourceType}): --prefer-sdk-route had no effect for ${list} — ` +
            `${cause}. Cloud Control forwards the full property map, so ${list} ${isAre} ` +
            `written to AWS after all. ${remedy}`
        );
      }
      if (overridden.length > 0) {
        // The REMEDY is per property, because "remove the override" is FALSE
        // for a create-only one (issue #2750, residual #2790): cdkd keeps such
        // a key in the state record -- removing it would make the next deploy
        // read it as an addition and so as a REPLACEMENT -- so with the flag
        // gone the diff is NO_CHANGE, nothing routes anywhere, and the property
        // still does not reach AWS.
        //
        // The create-only sentence deliberately prescribes NO COMMAND. The
        // obvious one, `--recreate-via-cc-api <LogicalId>`, is REFUSED by
        // `validateRecreateTargets` while this very override is still set
        // (`ambiguousIntent`), needs `--force-stateful-recreation` for the 9 of
        // these types that are stateful, and is refused outright for a provider
        // declaring `disableCcApiFallback`. A sentence that has to be right
        // about all three is a sentence that will be wrong about one; the
        // deploy-safety docs carry the remedy with its conditions, and this
        // line carries only what is true unconditionally.
        //
        // The reroutable sentence has its OWN third condition, pre-dating this
        // change and left alone: for a provider declaring
        // `disableCcApiFallback` removing the override makes the drop
        // actionable and rule 4 THROWS instead of routing. Issue
        // [#2792](https://github.com/go-to-k/cdkd/issues/2792).
        const createOnly = getPropertyCoverage(resourceType)?.createOnlyDrops;
        const reroutable = overridden.filter((p) => createOnly?.has(p) !== true);
        const needsRecreate = overridden.filter((p) => createOnly?.has(p) === true);
        const remedies: string[] = [];
        if (reroutable.length > 0) {
          remedies.push(
            `Remove the override for ${reroutable.join(', ')} to route this ` +
              `resource via Cloud Control API instead.`
          );
        }
        if (needsRecreate.length > 0) {
          const one = needsRecreate.length === 1;
          remedies.push(
            `${needsRecreate.join(', ')} ${one ? 'is' : 'are'} create-only, so ` +
              `removing the override does not apply ${one ? 'it' : 'them'} ` +
              `either -- a create-only property can only be applied by ` +
              `recreating the resource.`
          );
        }
        this.logger.warn(
          `${logicalId} (${resourceType}): ${overridden.join(', ')} will be ` +
            `silently dropped (--prefer-sdk-route override ` +
            `accepted). ${remedies.join(' ')}`
        );
      }

      this.reportUnrecognizedProperties(logicalId, resourceType, properties, {
        provisionedBy,
        autoRouted: autoRouted.length > 0,
      });
    }
  }

  /**
   * Warn about top-level template properties this type's committed CFn schema
   * snapshot does not know about, on resources that resolve to the SDK route
   * (issue [#2718](https://github.com/go-to-k/cdkd/issues/2718)).
   *
   * The gap this closes: {@link getProviderFor} decides SDK-vs-Cloud-Control
   * from `property-coverage.generated.ts`, built offline from the schema
   * fixtures, and there is no runtime `DescribeType` on that path. So a
   * property AWS publishes AFTER the fixture snapshot produces no
   * `silentDrop` entry, does not auto-route to Cloud Control, and is dropped
   * with the deploy reporting success — the issue
   * [#614](https://github.com/go-to-k/cdkd/issues/614) failure class reached
   * through the one input the #614 machinery cannot observe. The scheduled
   * fixture-refresh job is the FIX (the property enters the fixture and the
   * existing auto-route handles it); this warn is what protects a user
   * deploying BETWEEN refresh cycles.
   *
   * Fires only on the SDK route, which is where the drop actually happens.
   * The two Cloud-Control routes both forward the full property map verbatim,
   * so the property does reach AWS there and a warn would be false:
   * - `provisionedBy: 'cc-api'` from existing state (sticky rule 2 of
   *   {@link getProviderFor}), minus the `STICKY_CC_MIGRATION_EXEMPT` types
   *   that deliberately re-route back to their SDK provider;
   * - an actionable silent drop auto-routing this deploy (`autoRouted`).
   *
   * The route test MIRRORS `getProviderFor` rather than re-deriving it — the
   * two answering differently is the only way this warn can be wrong about a
   * resource, and it is not decidable from the message.
   *
   * **Known divergence, in the SAFE direction.** This runs on the template's
   * RAW properties (`deploy-engine.ts` calls `validateResourceProperties`
   * pre-flight) while `getProviderFor` runs on RESOLVED ones. So a silent-drop
   * key present only behind an `Fn::If` that resolves to `AWS::NoValue` makes
   * `autoRouted` true here and suppresses the warn, while the real route ends
   * up on the SDK provider and does drop the unrecognized property. The result
   * is a MISSING warn, never a false one — which is the right direction for an
   * advisory line, and why this is documented rather than fixed by resolving
   * twice. `getProviderFor` remains the authority on routing; nothing here
   * changes a routing decision.
   *
   * Suppressed per `<Type>:<Prop>` by `--allow-unsupported-properties`, whose
   * meaning ("accept the silent drop, stay on the SDK path") is exactly this
   * case; deliberately no new flag. Warn rather than error because the drop
   * may be intended, and deliberately NOT an auto-route: flipping to
   * Cloud Control on an UNRECOGNIZED property would let a typo trigger the
   * currently one-way `cc-api` state flip (issue
   * [#2719](https://github.com/go-to-k/cdkd/issues/2719)), and CC would reject
   * the unknown key anyway.
   */
  private reportUnrecognizedProperties(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown> | undefined,
    route: { provisionedBy?: 'sdk' | 'cc-api' | undefined; autoRouted: boolean }
  ): void {
    const stickyCc =
      route.provisionedBy === 'cc-api' && !STICKY_CC_MIGRATION_EXEMPT.has(resourceType);
    if (stickyCc || route.autoRouted) return;

    const unrecognized = findUnrecognizedProperties(resourceType, properties).filter(
      (property) => !this.allowedUnsupportedProperties.has(`${resourceType}:${property}`)
    );
    if (unrecognized.length === 0) return;

    const propList = unrecognized.join(', ');
    const overrideHint = unrecognized.map((p) => `${resourceType}:${p}`).join(',');
    const one = unrecognized.length === 1;
    // Every reading is NAMED with its own remedy, because the code cannot tell
    // them apart and a line that names only some of them misdirects the reader
    // into the wrong fix. The read-only arm is not hypothetical: the coverage
    // generator excludes `readOnlyProperties` from `silentDrop`, so a template
    // that sets an ATTRIBUTE (`AWS::IAM::Role.Arn`) lands in this bucket, and
    // telling that user "AWS published it after our snapshot — report it"
    // would be plainly false.
    this.logger.warn(
      `${logicalId} (${resourceType}): ${propList} ${one ? 'is' : 'are'} not in cdkd's CFn ` +
        `schema snapshot for this type, so ${one ? 'it' : 'they'} will NOT reach AWS — ` +
        `the deploy will still report success. Anything of these shapes looks the same ` +
        `here: a misspelled name (fix the spelling); a read-only attribute, which is not ` +
        `settable on any engine (remove it); or a property AWS published after cdkd's ` +
        `snapshot, which cdkd should be routing via Cloud Control — please report that one: ` +
        `${unsupportedPropertyIssueUrl(resourceType, unrecognized[0]!)}` +
        `${one ? '' : ` (link is for ${unrecognized[0]!})`}. ` +
        `If the drop is intended — an addPropertyOverride escape hatch — silence this via ` +
        `--prefer-sdk-route ${overrideHint}.`
    );
  }

  /**
   * Pure-functional discovery of every resource whose template uses one or
   * more silent-drop properties that are NOT in the
   * `--allow-unsupported-properties` allow set — i.e. every resource that
   * {@link getProviderFor} would auto-route via Cloud Control. Returned
   * entries carry the silent-drop property names so plan / diff renderers
   * can show `[via CC API: RuntimeManagementConfig]`.
   *
   * Does NOT log or throw. Use {@link reportSilentDropDecisions} for the
   * side-effecting info / warn surface.
   */
  findAutoRouteHits(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
    }>
  ): AutoRouteHit[] {
    const hits: AutoRouteHit[] = [];
    for (const { logicalId, resourceType, properties } of resources) {
      const actionable = findActionableSilentDrops(
        resourceType,
        properties,
        this.allowedUnsupportedProperties
      );
      if (actionable.length === 0) continue;
      hits.push({
        logicalId,
        resourceType,
        properties: actionable.map((d) => d.property),
      });
    }
    return hits;
  }
}

function isCustomResource(resourceType: string): boolean {
  return (
    resourceType.startsWith('Custom::') || resourceType === 'AWS::CloudFormation::CustomResource'
  );
}
