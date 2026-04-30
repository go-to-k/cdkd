/**
 * Schema versions for cdkd state.json.
 *
 * - 1 — legacy layout: `s3://{bucket}/cdkd/{stackName}/state.json` (pre PR 1).
 * - 2 — region-prefixed layout: `s3://{bucket}/cdkd/{stackName}/{region}/state.json`.
 *
 * cdkd readers handle both. Writers always emit `version: 2`. An older cdkd
 * binary that only knows `version: 1` will fail with a clear error when it
 * encounters `version: 2`, rather than silently mishandling the new format.
 */
export type StateSchemaVersion = 1 | 2;
export const STATE_SCHEMA_VERSION_LEGACY: StateSchemaVersion = 1;
export const STATE_SCHEMA_VERSION_CURRENT: StateSchemaVersion = 2;

/**
 * Stack state stored in S3
 */
export interface StackState {
  /**
   * Schema version. `1` is the legacy unversioned-key layout, `2` is the
   * region-prefixed layout. New writes always use the current version.
   */
  version: StateSchemaVersion;

  /** Stack name */
  stackName: string;

  /**
   * Target region for this stack. Required on `version: 2` since the region
   * is part of the S3 key. Optional on `version: 1` for backwards compat.
   */
  region?: string;

  /** Resources in the stack */
  resources: Record<string, ResourceState>;

  /** Stack outputs (values can be any type) */
  outputs: Record<string, unknown>;

  /** Last modification timestamp (Unix milliseconds) */
  lastModified: number;
}

/**
 * Individual resource state
 */
export interface ResourceState {
  /** Physical resource ID (ARN, name, etc.) */
  physicalId: string;

  /** CloudFormation resource type (e.g., AWS::Lambda::Function) */
  resourceType: string;

  /** Resource properties */
  properties: Record<string, unknown>;

  /** Resource attributes for Fn::GetAtt resolution */
  attributes?: Record<string, unknown>;

  /** Resource dependencies (logical IDs) for proper deletion order */
  dependencies?: string[];

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Lock information for stack operations
 */
export interface LockInfo {
  /** Lock owner (e.g., username, CI job ID) */
  owner: string;

  /** Lock acquisition timestamp (Unix milliseconds) */
  timestamp: number;

  /** Lock expiration timestamp (Unix milliseconds) */
  expiresAt: number;

  /** Optional operation being performed */
  operation?: string;
}

/**
 * Change type for resource diff
 */
export type ChangeType = 'CREATE' | 'UPDATE' | 'DELETE' | 'NO_CHANGE';

/**
 * Resource change information
 */
export interface ResourceChange {
  /** Logical ID from CloudFormation template */
  logicalId: string;

  /** Type of change */
  changeType: ChangeType;

  /** Resource type */
  resourceType: string;

  /** Current properties (for UPDATE/DELETE) */
  currentProperties?: Record<string, unknown>;

  /** Desired properties (for CREATE/UPDATE) */
  desiredProperties?: Record<string, unknown>;

  /** Property-level changes (for UPDATE) */
  propertyChanges?: PropertyChange[];
}

/**
 * Property-level change
 */
export interface PropertyChange {
  /** Property path (e.g., "Code.S3Key") */
  path: string;

  /** Old value */
  oldValue: unknown;

  /** New value */
  newValue: unknown;

  /** Whether this change requires replacement */
  requiresReplacement: boolean;
}
