import type { ResourceProvider } from '../types/resource.js';
import { CloudControlProvider } from './cloud-control-provider.js';
import { CustomResourceProvider } from './providers/custom-resource-provider.js';
import { getLogger } from '../utils/logger.js';

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

  constructor() {
    this.cloudControlProvider = new CloudControlProvider();
    this.customResourceProvider = new CustomResourceProvider();
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

    // 4. No provider available
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
      throw new Error(
        `The following resource types are not supported:\n` +
          unsupportedTypes.map((type) => `  - ${type}`).join('\n') +
          `\n\nThese resource types are not supported by Cloud Control API and no SDK provider is registered.\n` +
          `Please report this issue at https://github.com/your-org/cdkd/issues so we can add SDK provider support.`
      );
    }

    this.logger.debug(
      `Validated ${resourceTypes.size} resource types: all have available providers`
    );
  }
}
