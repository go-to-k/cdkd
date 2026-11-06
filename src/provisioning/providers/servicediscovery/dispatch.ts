import { ProvisioningError } from '../../../utils/error-handler.js';
import type { DeleteContext } from '../../region-check.js';
import { withRemovalDefaults } from '../../update-removal.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  CreateContext,
  UpdateContext,
} from '../../../types/resource.js';
import type { ServiceDiscoveryProvider } from '../servicediscovery-provider.js';

// ─── Dispatch ─────────────────────────────────────────────────────

/**
 * `context` is read for ONE thing today: `maskSecrets` (issue #2050). The
 * Service create path runs a post-create `UpdateServiceAttributes` through
 * `withRetry` — see {@link maskedRetryLogger}.
 *
 * EVERY arm receives it, not just the Service one (issue #2063). The three
 * namespace arms build their `Create*NamespaceCommand` payload out of the
 * RESOLVED `properties` bag — `Name`, `Description`, `Tags` — and each has
 * two disclosure surfaces for it: the `ProvisioningError` its catch throws
 * (printed at ERROR, i.e. DEFAULT verbosity, by `deploy-engine.ts`) and the
 * AWS `ErrorMessage` that {@link pollOperation} raises for a FAILED
 * operation. Cloud Map's create is operation-based, so the second one is the
 * NORMAL rejection path for those arms, not an edge case.
 */
export async function create(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  switch (resourceType) {
    case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
      return this.createNamespace(logicalId, resourceType, properties, context?.maskSecrets);
    case 'AWS::ServiceDiscovery::HttpNamespace':
      return this.createHttpNamespace(logicalId, resourceType, properties, context?.maskSecrets);
    case 'AWS::ServiceDiscovery::PublicDnsNamespace':
      return this.createPublicDnsNamespace(
        logicalId,
        resourceType,
        properties,
        context?.maskSecrets
      );
    case 'AWS::ServiceDiscovery::Service':
      return this.createService(logicalId, resourceType, properties, context?.maskSecrets);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
  }
}

/**
 * `context` is read for ONE thing today: `maskSecrets` (issue #2050) — the
 * update-path twin of the `create()` note above, and threaded into every arm
 * for the same reason (issue #2063). The namespace update arms carry one
 * payload surface the create arms do not: {@link syncNamespaceTags} sends
 * `TagResource` with the resolved `Tags` VALUES, whose rejection lands in
 * the arm's own catch.
 */
export function update(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  properties = withRemovalDefaults(
    this.removalDefaults,
    resourceType,
    properties,
    previousProperties,
    context
  );
  switch (resourceType) {
    case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
      return this.updateNamespace(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets
      );
    case 'AWS::ServiceDiscovery::HttpNamespace':
      return this.updateHttpNamespace(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets
      );
    case 'AWS::ServiceDiscovery::PublicDnsNamespace':
      return this.updatePublicDnsNamespace(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets
      );
    case 'AWS::ServiceDiscovery::Service':
      return this.updateService(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets,
        context?.changedProperties
      );
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

export async function deleteImpl(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  switch (resourceType) {
    case 'AWS::ServiceDiscovery::PrivateDnsNamespace':
    case 'AWS::ServiceDiscovery::HttpNamespace':
    case 'AWS::ServiceDiscovery::PublicDnsNamespace':
      return this.deleteNamespace(logicalId, physicalId, resourceType, context);
    case 'AWS::ServiceDiscovery::Service':
      return this.deleteService(logicalId, physicalId, resourceType, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}
