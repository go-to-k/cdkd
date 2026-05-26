import type { ResourceProvider } from '../types/resource.js';
import { CloudControlProvider } from './cloud-control-provider.js';
import { CustomResourceProvider } from './providers/custom-resource-provider.js';
import { getLogger } from '../utils/logger.js';
import { isNonProvisionable, unsupportedTypeIssueUrl } from './unsupported-types.js';
import { findActionableSilentDrops, findSilentDropProperties } from './property-coverage.js';

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
 *    in the allow set → Cloud Control (auto-route, info-logged).
 * 5. SDK Provider registered, silent-drop properties present, ALL in
 *    the allow set → SDK Provider (the user explicitly accepted the
 *    silent drop, warn-logged).
 * 6. No SDK Provider, Cloud Control supports the type → Cloud Control.
 * 7. `--allow-unsupported-types` escape hatch → Cloud Control optimistically.
 * 8. Otherwise → throw (no provider available).
 *
 * Tier 3 (`NON_PROVISIONABLE`) types are rejected earlier by
 * {@link validateResourceTypes}; the silent-drop auto-route only fires for
 * Tier 1 types whose SDK Provider declares `handledProperties` and where
 * Cloud Control is guaranteed to be a viable alternative.
 */
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
   * `AWS::Lambda::Function:LoggingConfig`). As of issue
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
   * Configure the response bucket for custom resources
   * This allows Lambda handlers using cfn-response to send responses via S3
   */
  setCustomResourceResponseBucket(bucket: string, bucketRegion?: string): void {
    this.customResourceProvider.setResponseBucket(bucket, bucketRegion);
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
    if (provisionedBy === 'cc-api') {
      this.logger.debug(
        `Routing ${resourceType} via Cloud Control (state-recorded provisionedBy=cc-api)`
      );
      return { provider: this.cloudControlProvider, provisionedBy: 'cc-api' };
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
        return { provider: specificProvider, provisionedBy: 'sdk' };
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
   * issue [#614](https://github.com/go-to-k/cdkd/issues/614), this method
   * **no longer throws** — silent drops now auto-route the resource through
   * Cloud Control API by default (see {@link getProviderFor}). The method
   * is retained on the name `validateResourceProperties` so existing deploy
   * call sites continue to work; it now emits info-level routing decisions
   * for each silent-drop resource, plus warn-level lines for resources
   * where the user explicitly opted into the silent drop via
   * `--allow-unsupported-properties`.
   *
   * Must be called AFTER {@link validateResourceTypes} — type-level errors
   * are still hard rejects. For a type allowed via `--allow-unsupported-types`,
   * the property check is a no-op (`findSilentDropProperties` returns `[]`
   * for non-Tier-1 / unknown types).
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
    this.reportSilentDropDecisions(resources);
  }

  /**
   * Info-log every silent-drop routing decision (auto-route via CC API) and
   * warn-log every silent drop the user explicitly opted into via
   * `--allow-unsupported-properties` (forced SDK path, the property will
   * be dropped). Pure side-effect — does not mutate state and never throws.
   *
   * Issue [#614](https://github.com/go-to-k/cdkd/issues/614). Replaces the
   * pre-v0.16x throw path: silent drops are now a routing signal, not an
   * error.
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
      if (drops.length === 0) continue;

      const overridden: string[] = [];
      const autoRouted: string[] = [];
      for (const { property } of drops) {
        const allowKey = `${resourceType}:${property}`;
        if (this.allowedUnsupportedProperties.has(allowKey)) {
          overridden.push(property);
        } else {
          autoRouted.push(property);
        }
      }

      if (autoRouted.length > 0) {
        const propList = autoRouted.join(', ');
        const overrideHint = autoRouted.map((p) => `${resourceType}:${p}`).join(',');
        const message =
          `${logicalId} (${resourceType}): routing via Cloud Control API ` +
          `(cdkd's SDK Provider does not yet wire ${propList} — CC API will ` +
          `forward the full property map. Override via ` +
          `--allow-unsupported-properties ${overrideHint}.)`;
        if (provisionedBy === 'cc-api') {
          // Sticky continuation — already on CC from a prior deploy.
          // Debug-only to avoid repetitive noise on every redeploy.
          this.logger.debug(message);
        } else {
          this.logger.info(message);
        }
      }
      if (overridden.length > 0) {
        const propList = overridden.join(', ');
        this.logger.warn(
          `${logicalId} (${resourceType}): ${propList} will be silently dropped ` +
            `(--allow-unsupported-properties override accepted). Remove the ` +
            `override to route this resource via Cloud Control API instead.`
        );
      }
    }
  }

  /**
   * Pure-functional discovery of every resource whose template uses one or
   * more silent-drop properties that are NOT in the
   * `--allow-unsupported-properties` allow set — i.e. every resource that
   * {@link getProviderFor} would auto-route via Cloud Control. Returned
   * entries carry the silent-drop property names so plan / diff renderers
   * can show `[via CC API: LoggingConfig]`.
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
