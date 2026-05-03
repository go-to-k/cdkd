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
 * Input passed to a provider's `import` method.
 *
 * Carries everything a provider needs to find an existing AWS resource that
 * corresponds to a logicalId in the user's CDK template:
 * - the logicalId itself (sometimes embedded in physical names),
 * - the resource's CDK path (`aws:cdk:path` tag) for tag-based lookup,
 * - the parent stack name and AWS region,
 * - the template properties (often contain explicit names like `BucketName`
 *   that bypass the tag lookup entirely).
 */
export interface ResourceImportInput {
  /** Logical ID from the CDK template (e.g., `MyBucket`). */
  logicalId: string;

  /** CloudFormation resource type (e.g., `AWS::S3::Bucket`). */
  resourceType: string;

  /**
   * CDK construct path that CDK encodes into the `aws:cdk:path` tag, e.g.
   * `MyStack/MyConstruct/MyBucket`. The most reliable lookup key when present.
   */
  cdkPath: string;

  /** Physical CloudFormation stack name (used for naming-pattern fallback). */
  stackName: string;

  /** AWS region the resource lives in. */
  region: string;

  /** Properties from the template (resolved as far as possible). */
  properties: Record<string, unknown>;

  /**
   * Caller-supplied physical id, e.g. via `--resource MyBucket=my-bucket` or
   * `--resource-mapping`. When set, the provider should treat it as ground
   * truth: verify the resource exists and fetch attributes, but do NOT
   * search. When `undefined`, the provider performs its own lookup
   * (tag-based, name-based, etc.).
   */
  knownPhysicalId?: string;
}

/**
 * Result returned by a provider's `import` method.
 *
 * `null` from the provider means "no matching resource found in AWS" — the
 * caller (state-import command) marks it as skipped, not as a failure, since
 * the user's template might reference resources that have not been deployed.
 */
export interface ResourceImportResult {
  /** Physical resource ID. */
  physicalId: string;
  /** Resource attributes for `Fn::GetAtt` resolution (same shape as `create` returns). */
  attributes?: Record<string, unknown>;
}

/**
 * Context passed to a provider's `delete` method.
 *
 * Re-exported from `src/provisioning/region-check.ts` so that callers
 * implementing the provider interface only need to import from
 * `src/types/resource.ts`.
 */
export type { DeleteContext } from '../provisioning/region-check.js';
import type { DeleteContext } from '../provisioning/region-check.js';

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
   * If true, the deploy engine MUST NOT wrap the provider's `create` /
   * `update` / `delete` calls in its outer transient-error retry loop
   * (`withRetry` from `src/deployment/retry.ts`).
   *
   * The retry loop generates fresh state for each attempt — for the
   * Custom Resource provider, that means a new pre-signed S3 URL and a
   * new RequestId. The first attempt's Lambda response then lands at
   * an S3 key that nobody polls, hanging the deploy until the polling
   * timeout. Providers that prepare per-call invariant state in a way
   * that an outer retry would invalidate must opt out via this flag and
   * implement their own retry strategy internally.
   *
   * When unset, the deploy engine retries transient SDK errors (IAM
   * propagation, HTTP 429/503, etc.) as it always has.
   */
  disableOuterRetry?: boolean;

  /**
   * Self-reported minimum wall-clock timeout (ms) the provider needs in
   * order to complete `create` / `update` / `delete` against AWS in the
   * worst case.
   *
   * When set, the deploy engine resolves the effective per-resource
   * timeout as:
   *   `perTypeCliOverride ?? max(getMinResourceTimeoutMs(), globalCliDefault)`
   *
   * This lets long-running providers (Custom Resources poll for up to
   * 1 hour, mirroring CDK's default `totalTimeout`) lift the timeout
   * for their resources without forcing every user to remember
   * `--resource-timeout 1h`. A user-supplied per-type override always
   * wins over the self-report (`--resource-timeout AWS::CloudFormation::CustomResource=5m`
   * is the explicit escape hatch).
   */
  getMinResourceTimeoutMs?(): number;
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
   * @param context Delete-time context (optional, for back-compat). Contains
   *   `expectedRegion` from the stack state so providers can refuse to treat
   *   `NotFound` as idempotent success when the AWS client's region does not
   *   match the region the resource was deployed to. See
   *   `src/provisioning/region-check.ts` for the shared verification helper.
   */
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void>;

  /**
   * Get resource attributes (for Fn::GetAtt resolution)
   * @param physicalId Physical resource ID
   * @param resourceType CloudFormation resource type
   * @param attributeName Attribute name
   * @returns Attribute value
   */
  getAttribute?(physicalId: string, resourceType: string, attributeName: string): Promise<unknown>;

  /**
   * Find an already-deployed AWS resource matching the given logicalId from
   * the CDK template, and return its physical id + attributes so the state
   * file can be reconstructed.
   *
   * Used by `cdkd state import` to recover state after disasters (lost state
   * file, manual deletion, drift between cdkd and AWS) and to adopt
   * AWS-resident resources into cdkd's management.
   *
   * Lookup strategy is provider-specific. Recommended order:
   *   1. If the template's `properties` carries an explicit name field
   *      (`BucketName`, `FunctionName`, `RoleName`, etc.), look up by name —
   *      it's exact and cheap.
   *   2. Otherwise, walk the service's `List*` API and match against the
   *      `aws:cdk:path` tag (every CDK-deployed resource carries one).
   *   3. Last resort: stack-name prefix matching on physical names. Risky;
   *      providers may choose to skip rather than guess.
   *
   * Return `null` if no matching resource is found — the caller treats this
   * as "skipped" (not an error). Throw on AWS errors so the caller can
   * surface them.
   *
   * Optional: providers without an `import` implementation are reported as
   * unsupported by `cdkd state import` and the corresponding logical IDs are
   * skipped with a warning.
   */
  import?(input: ResourceImportInput): Promise<ResourceImportResult | null>;
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
