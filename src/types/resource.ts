/**
 * CloudFormation template structure
 */
export interface CloudFormationTemplate {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Parameters?: Record<string, TemplateParameter>;
  Resources: Record<string, TemplateResource>;
  Outputs?: Record<string, TemplateOutput>;
  Conditions?: Record<string, unknown>;
  Mappings?: Record<string, unknown>;
}

/**
 * CloudFormation template parameter
 */
export interface TemplateParameter {
  Type: string;
  Default?: unknown;
  Description?: string;
  AllowedValues?: unknown[];
  AllowedPattern?: string;
  ConstraintDescription?: string;
}

/**
 * CloudFormation template resource
 */
export interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | readonly string[];
  Condition?: string;
  Metadata?: Record<string, unknown>;
  CreationPolicy?: Record<string, unknown>;
  UpdatePolicy?: Record<string, unknown>;
  DeletionPolicy?: 'Delete' | 'Retain' | 'Snapshot';
  UpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot';
}

/**
 * CloudFormation template output
 */
export interface TemplateOutput {
  Value: unknown;
  Description?: string;
  Export?: {
    Name: string;
  };
}

/**
 * Resource creation result
 */
export interface ResourceCreateResult {
  /** Physical resource ID */
  physicalId: string;
  /** Resource attributes for Fn::GetAtt resolution */
  attributes?: Record<string, unknown>;
}

/**
 * Resource update result
 */
export interface ResourceUpdateResult {
  /** Physical resource ID (may be different if resource was replaced) */
  physicalId: string;
  /** Whether the resource was replaced (new physical ID) */
  wasReplaced: boolean;
  /** Updated resource attributes */
  attributes?: Record<string, unknown>;
}

/**
 * Resource provider interface
 */
export interface ResourceProvider {
  /**
   * Map of resource type → set of CloudFormation property names handled in create/update.
   * When defined for a resource type, if a template contains properties NOT in the set
   * and the resource type is supported by Cloud Control API, the deploy engine will fall
   * back to CC API for create/update operations to ensure all properties are applied.
   *
   * If undefined or the resource type is not in the map, the provider is assumed to
   * handle ALL properties (no safety net).
   * DELETE always uses the SDK provider regardless of this setting.
   */
  handledProperties?: ReadonlyMap<string, ReadonlySet<string>>;

  /**
   * If true, the provider refuses CC API fallback for create/update.
   * When unhandled properties are detected, the deploy engine will throw an error
   * instead of falling back to CC API.
   *
   * Use this for providers that exist because CC API has known issues with this
   * resource type (e.g., bugs, incorrect behavior, missing features).
   */
  disableCcApiFallback?: boolean;
  /**
   * Optional: Pre-process properties before CC API fallback.
   * Called when the safety net falls back to CC API for create/update, allowing
   * the SDK provider to apply custom transformations (e.g., default name generation)
   * so that CC API receives the same defaults the SDK provider would have applied.
   *
   * If not implemented, properties are passed to CC API as-is.
   */
  preparePropertiesForFallback?(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown>;

  /**
   * Create a new resource
   * @param logicalId Logical ID from template
   * @param resourceType CloudFormation resource type (e.g., "AWS::S3::Bucket")
   * @param properties Resource properties
   * @returns Physical resource ID and attributes
   */
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult>;

  /**
   * Update an existing resource
   * @param logicalId Logical ID from template
   * @param physicalId Current physical resource ID
   * @param resourceType CloudFormation resource type
   * @param properties Updated properties
   * @param previousProperties Previous properties (for comparison)
   * @returns Updated physical ID and attributes
   */
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult>;

  /**
   * Delete a resource
   * @param logicalId Logical ID from template
   * @param physicalId Physical resource ID
   * @param resourceType CloudFormation resource type
   * @param properties Resource properties (optional, for providers that need them)
   */
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void>;

  /**
   * Get resource attributes (for Fn::GetAtt resolution)
   * @param physicalId Physical resource ID
   * @param resourceType CloudFormation resource type
   * @param attributeName Attribute name
   * @returns Attribute value
   */
  getAttribute?(physicalId: string, resourceType: string, attributeName: string): Promise<unknown>;
}

/**
 * Provider registry interface
 */
export interface ProviderRegistry {
  /**
   * Get provider for a resource type
   * @param resourceType CloudFormation resource type
   * @returns Resource provider
   */
  getProvider(resourceType: string): ResourceProvider;

  /**
   * Check if a resource type is supported
   * @param resourceType CloudFormation resource type
   * @returns Whether the resource type is supported
   */
  isSupported(resourceType: string): boolean;
}
