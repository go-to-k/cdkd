import type { ResourceProvider } from '../types/resource.js';
import { CloudControlProvider } from './cloud-control-provider.js';
import { CustomResourceProvider } from './providers/custom-resource-provider.js';
import { getLogger } from '../utils/logger.js';
import { isNonProvisionable, unsupportedTypeIssueUrl } from './unsupported-types.js';
import { findSilentDropProperties, unsupportedPropertyIssueUrl } from './property-coverage.js';

/**
 * Provider registry for managing resource providers
 *
 * Implements a fallback strategy:
 * 1. Try specific SDK provider if registered for this resource type
 * 2. Fall back to Cloud Control API if resource type is supported
 * 3. Throw error if no provider available
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
   * `AWS::Lambda::Function:LoggingConfig`). Named entries bypass the
   * property-level silent-drop pre-flight reject for that exact type+property
   * pair. Per-type-property (not blanket) so the user explicitly acknowledges
   * each silent drop they accept.
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
   * Get provider for a resource type
   *
   * Selection strategy:
   * 1. If specific SDK provider is registered, use it
   * 2. Otherwise, use Cloud Control API if supported
   * 3. Throw error if no provider available
   *
   * @param resourceType CloudFormation resource type
   * @returns Provider instance
   * @throws Error if no provider available
   */
  getProvider(resourceType: string): ResourceProvider {
    // 1. Check for specific SDK provider
    const specificProvider = this.providers.get(resourceType);
    if (specificProvider) {
      this.logger.debug(`Using specific SDK provider for ${resourceType}`);
      return specificProvider;
    }

    // 2. Check if Cloud Control API supports this resource type
    if (CloudControlProvider.isSupportedResourceType(resourceType)) {
      this.logger.debug(`Using Cloud Control API provider for ${resourceType}`);
      return this.cloudControlProvider;
    }

    // 3. Check if it's a custom resource (Custom:: prefix or AWS::CloudFormation::CustomResource)
    if (
      resourceType.startsWith('Custom::') ||
      resourceType === 'AWS::CloudFormation::CustomResource'
    ) {
      this.logger.debug(`Using Custom Resource provider for ${resourceType}`);
      return this.customResourceProvider;
    }

    // 4. Escape hatch: user explicitly allowed this unsupported type — try
    // Cloud Control optimistically (likely fails for NON_PROVISIONABLE types).
    if (this.allowedUnsupportedTypes.has(resourceType)) {
      this.logger.debug(
        `Routing escape-hatch-allowed type ${resourceType} through Cloud Control API`
      );
      return this.cloudControlProvider;
    }

    // 5. No provider available
    throw new Error(
      `No provider available for resource type: ${resourceType}. ` +
        `This resource type is not supported by Cloud Control API and no SDK provider is registered.`
    );
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
      resourceType.startsWith('Custom::') ||
      resourceType === 'AWS::CloudFormation::CustomResource'
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
   * Pre-flight reject: walk every resource in the template and identify
   * top-level CFn properties cdkd's SDK provider would silently drop on
   * write. Throws with a per-resource per-property breakdown + the exact
   * `--allow-unsupported-properties` re-run command. No-op for Tier 2 (Cloud
   * Control) types — CC forwards the full property map to AWS, so cdkd has
   * no write-side silent drop for those.
   *
   * Must be called AFTER {@link validateResourceTypes} — type-level errors
   * are reported first. For a type allowed via `--allow-unsupported-types`,
   * the type-level check passes and this property check is a no-op
   * (`findSilentDropProperties` returns `[]` for non-Tier-1 / unknown types).
   */
  validateResourceProperties(
    resources: Iterable<{
      logicalId: string;
      resourceType: string;
      properties: Record<string, unknown> | undefined;
    }>
  ): void {
    const errors: Array<{
      logicalId: string;
      resourceType: string;
      property: string;
      rationale: string;
    }> = [];
    for (const { logicalId, resourceType, properties } of resources) {
      const drops = findSilentDropProperties(resourceType, properties);
      for (const { property, rationale } of drops) {
        const allowKey = `${resourceType}:${property}`;
        if (this.allowedUnsupportedProperties.has(allowKey)) continue;
        errors.push({ logicalId, resourceType, property, rationale });
      }
    }
    if (errors.length === 0) return;
    throw new Error(renderPropertyCoverageError(errors));
  }
}

/**
 * Render the actionable pre-flight error for property-level silent drops.
 * Groups by logical ID, sorts properties within each resource, and emits
 * a comma-joined `--allow-unsupported-properties` re-run command with
 * deduplicated `Type:Prop` entries (the same type appearing in two
 * resources only needs one entry — the flag is per-type-prop, not
 * per-resource).
 */
function renderPropertyCoverageError(
  errors: Array<{
    logicalId: string;
    resourceType: string;
    property: string;
    rationale: string;
  }>
): string {
  const byLogicalId = new Map<
    string,
    { resourceType: string; props: Array<{ property: string; rationale: string }> }
  >();
  for (const e of errors) {
    let entry = byLogicalId.get(e.logicalId);
    if (!entry) {
      entry = { resourceType: e.resourceType, props: [] };
      byLogicalId.set(e.logicalId, entry);
    }
    entry.props.push({ property: e.property, rationale: e.rationale });
  }
  const sections: string[] = [];
  const sortedLogicalIds = [...byLogicalId.keys()].sort((a, b) => a.localeCompare(b));
  for (const logicalId of sortedLogicalIds) {
    const { resourceType, props } = byLogicalId.get(logicalId)!;
    const sortedProps = [...props].sort((a, b) => a.property.localeCompare(b.property));
    const propLines = sortedProps
      .map(({ property, rationale }) => {
        const issueUrl = unsupportedPropertyIssueUrl(resourceType, property);
        return (
          `    - ${property}\n` + `        ${rationale}\n` + `        Request support: ${issueUrl}`
        );
      })
      .join('\n');
    sections.push(`  ${logicalId} (${resourceType}):\n${propLines}`);
  }
  const dedupRerun = Array.from(new Set(errors.map((e) => `${e.resourceType}:${e.property}`))).join(
    ','
  );
  return (
    `cdkd would silently drop these properties at deploy time:\n\n` +
    sections.join('\n\n') +
    `\n\nThese properties exist in your CDK code but cdkd will not write them to ` +
    `AWS. The deployed resource will be missing these fields.\n\n` +
    `To proceed anyway (accepts the silent drop), re-run with:\n` +
    `  --allow-unsupported-properties ${dedupRerun}`
  );
}
