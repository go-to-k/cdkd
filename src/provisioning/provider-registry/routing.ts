import { CloudControlProvider } from '../cloud-control-provider.js';
import { findActionableSdkUnwired } from '../property-coverage.js';
import { safeMsg } from '../../utils/display-safe.js';
import {
  isCustomResource,
  wouldReturnToSdkProvider,
  type GetProviderForInput,
  type ProviderRegistry,
  type ProviderRoutingDecision,
} from '../provider-registry.js';

/**
 * Resolve the provider for a resource using the full routing decision
 * matrix (see class docstring). The returned object carries the chosen
 * provider, the `provisionedBy` layer label to persist on the resource's
 * state record, and (for the CC auto-route case) the names of the
 * SDK-unwired properties that drove the decision so callers can render
 * `[via CC API: <reason>]` plan annotations.
 *
 * @throws Error if no provider can be found for the type.
 */
export function getProviderFor(
  this: ProviderRegistry,
  input: GetProviderForInput
): ProviderRoutingDecision {
  // go-to-k/cdkd#4705 review H-6: a plan-time ask (`quiet`) routes the same
  // resource again at its create, which logs the decision once.
  const debug = (message: string): void => {
    if (input.quiet !== true) this.logger.debug(message);
  };
  const { resourceType, properties, provisionedBy } = input;

  // 1. Custom Resource — has no SDK/CC dichotomy, but we record it as
  //    `'sdk'` so the state field is always populated on v7+ writes.
  if (isCustomResource(resourceType)) {
    debug(`Using Custom Resource provider for ${resourceType}`);
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
  //    whose bag has SDK-unwired properties still auto-routes (rule 5).
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
      debug(`Routing ${resourceType} via Cloud Control (state-recorded provisionedBy=cc-api)`);
      return { provider: this.cloudControlProvider, provisionedBy: 'cc-api' };
    }
    returningToSdk = true;
  }

  // 3-5. SDK Provider registered: SDK-unwired check decides between SDK
  //      Provider and the CC API auto-route.
  const specificProvider = this.providers.get(resourceType);
  if (specificProvider) {
    const actionableDrops = findActionableSdkUnwired(
      resourceType,
      properties,
      this.allowedUnsupportedProperties,
      input.previousProperties
    );
    if (actionableDrops.length === 0) {
      // No SDK-unwired properties, or every unwired property is in the allow set → SDK Provider.
      debug(`Using specific SDK provider for ${resourceType}`);
      if (returningToSdk) {
        // The only place `sdkMigration` is set. It marks a TRANSITION, so it
        // is attached here rather than to every SDK decision: the state
        // record says 'sdk' from the next write on, and this branch is not
        // reached again for the same resource.
        debug(
          `${resourceType} is returning to its SDK provider from a ` +
            `state-recorded cc-api route; the resource is updated in place`
        );
        return { provider: specificProvider, provisionedBy: 'sdk', sdkMigration: true };
      }
      return { provider: specificProvider, provisionedBy: 'sdk' };
    }
    // The CC auto-route target must actually be able to manage the type.
    // A NON_PROVISIONABLE type (no Cloud Control handlers) with an SDK
    // provider is listed in SDK_PROVIDER_NON_PROVISIONABLE_TYPES, per type,
    // and a provider may also opt out wholesale via `disableCcApiFallback`;
    // routing either to CC would fail at provisioning time with an opaque
    // UnsupportedActionException. Throw the clear error here instead.
    // (The Tier 3 set additionally covers the mid-transition window where a
    // provider is registered but the Tier 3 regen hasn't run.)
    const unroutable = this.ccRouteUnavailableReason(resourceType);
    if (unroutable !== undefined) {
      throw new Error(
        this.buildUnroutableSdkUnwiredMessage(resourceType, actionableDrops, unroutable)
      );
    }
    // SDK-unwired properties exist that the user has NOT opted into via the override
    // → auto-route through Cloud Control (which forwards the full property
    // map to AWS, closing the silent-drop bug). Closes issue #614.
    debug(
      `Auto-routing ${resourceType} via Cloud Control (SDK-unwired properties: ${actionableDrops
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
    debug(`Using Cloud Control API provider for ${resourceType}`);
    return { provider: this.cloudControlProvider, provisionedBy: 'cc-api' };
  }

  // 7. Escape hatch: user explicitly allowed this unsupported type — try
  //    Cloud Control optimistically (likely fails for NON_PROVISIONABLE).
  if (this.allowedUnsupportedTypes.has(resourceType)) {
    debug(`Routing escape-hatch-allowed type ${resourceType} through Cloud Control API`);
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
 * provider-level `disableCcApiFallback` opt-out; `reason` is
 * `ccRouteUnavailableReason`'s answer. Includes each property's
 * `unhandledByDesign` rationale so the user sees WHY it is unhandled, plus
 * the `--allow-unsupported-properties` escape hatch (which forces the SDK
 * path and leaves the property unwritten — the provider may still reject the resource
 * if the property is load-bearing, e.g. a non-Lustre FSx variant config).
 */
export function buildUnroutableSdkUnwiredMessage(
  this: ProviderRegistry,
  resourceType: string,
  drops: ReadonlyArray<{ property: string; rationale: string }>,
  reason: string
): string {
  // go-to-k/cdkd#2676: every value flattened (a property name and the type
  // come from the template); the list's own newlines are cdkd's.
  const details = drops.map((d) => safeMsg`  - ${d.property}: ${d.rationale}`).join('\n');
  const overrideHint = drops.map((d) => safeMsg`${resourceType}:${d.property}`).join(',');
  return (
    safeMsg`${resourceType} uses properties cdkd's SDK Provider does not handle, and ` +
    safeMsg`this type cannot fall back to Cloud Control API (${reason}):\n` +
    `${details}\n` +
    `Remove the properties, or force the SDK provider path and accept leaving them unwritten via ` +
    `--prefer-sdk-route ${overrideHint} ` +
    `(the provider may still reject the resource if the property is required).`
  );
}
