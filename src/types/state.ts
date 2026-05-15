/**
 * Schema versions for cdkd state.json.
 *
 * - 1 — legacy layout: `s3://{bucket}/cdkd/{stackName}/state.json` (pre PR 1).
 * - 2 — region-prefixed layout: `s3://{bucket}/cdkd/{stackName}/{region}/state.json`.
 * - 3 — adds `ResourceState.observedProperties` (AWS-current snapshot
 *       captured at deploy/import time, used as the drift comparator's
 *       baseline). Layout is the same as v2; only the resource-level shape
 *       grew. v2 readers see v3 as `version: 3` and fail clearly.
 * - 4 — adds `StackState.imports` (the set of `Fn::ImportValue` references
 *       this stack resolved during its last deploy). Consumed by
 *       `cdkd destroy` to refuse deleting a producer while a consumer still
 *       references its outputs (strong reference, matches CloudFormation).
 *       Layout is the same as v3; only the stack-level shape grew. v3
 *       readers see v4 as `version: 4` and fail clearly.
 * - 5 — adds `ResourceState.deletionPolicy` and `updateReplacePolicy`, the
 *       CloudFormation template attributes recorded at deploy time. cdkd
 *       compares these against the next deploy's template to detect
 *       attribute-only changes (e.g. `RemovalPolicy.DESTROY` removed →
 *       `DeletionPolicy: Retain` now in template), which previously fell
 *       through DiffCalculator as `No changes detected`. Layout is the same
 *       as v4; only the resource-level shape grew. v4 readers see v5 as
 *       `version: 5` and fail clearly.
 *
 * cdkd readers handle every prior version. Writers always emit
 * `STATE_SCHEMA_VERSION_CURRENT`. An older cdkd binary that only knows an
 * earlier version will fail with a clear error when it encounters a higher
 * version, rather than silently mishandling the new format.
 */
export type StateSchemaVersion = 1 | 2 | 3 | 4 | 5;
export const STATE_SCHEMA_VERSION_LEGACY: StateSchemaVersion = 1;
export const STATE_SCHEMA_VERSION_CURRENT: StateSchemaVersion = 5;

/**
 * Every schema version this binary can read. Writers always emit
 * `STATE_SCHEMA_VERSION_CURRENT`; older versions are accepted for
 * forward-migration, and an unknown / future version triggers an explicit
 * "upgrade cdkd" error in the parser.
 */
export const STATE_SCHEMA_VERSIONS_READABLE: readonly StateSchemaVersion[] = [1, 2, 3, 4, 5];

/**
 * One `Fn::ImportValue` reference recorded during a consumer stack's
 * deploy. Persisted in `StackState.imports` so `cdkd destroy` can refuse
 * to delete the producer while the consumer still references its outputs
 * (strong reference, matches CloudFormation behavior).
 *
 * Only `Fn::ImportValue` populates this — `Fn::GetStackOutput` is a weak
 * reference by design (cdkd-specific) and intentionally does NOT record
 * an entry here so the producer stays deletable independently of consumers.
 */
export interface StateImportEntry {
  /** The producer stack whose Output `Export.Name` was imported. */
  sourceStack: string;
  /**
   * The producer's region. Required so destroy-time strong-ref checks
   * can scan the producer's exact `state.json` key (cdkd state is keyed
   * by `(stackName, region)` since schema v2).
   */
  sourceRegion: string;
  /** The CloudFormation Output `Export.Name` that was imported. */
  exportName: string;
}

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

  /**
   * `Fn::ImportValue` references this stack resolved during its last
   * successful deploy. Populated on schema v4+; absent (or undefined)
   * on state written by an older cdkd binary, in which case the
   * destroy-time strong-reference check degrades gracefully (no
   * recorded imports = no consumers known = destroy proceeds). The
   * next deploy of an upgraded stack repopulates the field.
   */
  imports?: StateImportEntry[];

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

  /**
   * AWS-current snapshot of this resource's properties as returned by
   * `provider.readCurrentState` immediately after a successful create /
   * update / import. Used as the drift comparator's baseline (instead of
   * `properties`) so console-side changes to keys the user did not
   * template still surface as drift.
   *
   * Optional for backwards compatibility — resources written by an older
   * cdkd binary (v2 state, or v3 state on a provider that does not
   * implement `readCurrentState`) keep this field undefined; the drift
   * command falls back to comparing against `properties` in that case.
   */
  observedProperties?: Record<string, unknown>;

  /** Resource attributes for Fn::GetAtt resolution */
  attributes?: Record<string, unknown>;

  /** Resource dependencies (logical IDs) for proper deletion order */
  dependencies?: string[];

  /** Additional metadata */
  metadata?: Record<string, unknown>;

  /**
   * CloudFormation `DeletionPolicy` attribute recorded at deploy time
   * (schema v5+). Compared against the template on the next deploy so an
   * attribute-only change (e.g. `RemovalPolicy.DESTROY` removed →
   * `DeletionPolicy: Retain`) is surfaced as a diff instead of silently
   * being marked `No changes`. Optional for backwards compatibility — v4
   * state writes leave this undefined; the diff comparator treats
   * `undefined` as "no attribute recorded" rather than "Delete" so the
   * first post-upgrade deploy only fires the diff when the template
   * actually carries the attribute.
   *
   * The `| undefined` is explicit (vs bare `?:`) so a state-update site
   * can spread `{ ...current, deletionPolicy: undefined }` to clear a
   * previously-recorded value when the user removes the attribute from
   * their CDK code; under `exactOptionalPropertyTypes: true` a bare `?:`
   * would reject the literal-undefined assignment.
   */
  deletionPolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;

  /**
   * CloudFormation `UpdateReplacePolicy` attribute recorded at deploy time
   * (schema v5+). Same semantics as `deletionPolicy` above.
   */
  updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
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

  /**
   * `DeletionPolicy` / `UpdateReplacePolicy` attribute changes (schema v5+).
   * Populated when the template attribute differs from the value recorded in
   * cdkd state. AWS has no API to mutate these attributes per-resource, so
   * the deploy engine handles the change by updating cdkd state only — no
   * provider call. UPDATE classification still fires when only these change
   * (DiffCalculator does not stay at `NO_CHANGE`), so users see the diff
   * instead of `No changes detected`.
   */
  attributeChanges?: AttributeChange[];
}

/**
 * Template-level resource attribute change (schema v5+).
 *
 * `DeletionPolicy` / `UpdateReplacePolicy` are CloudFormation template
 * metadata — they have no AWS API per-resource and are mutated through the
 * cdkd state record alone.
 */
export interface AttributeChange {
  /** Attribute name: `DeletionPolicy` or `UpdateReplacePolicy`. */
  attribute: 'DeletionPolicy' | 'UpdateReplacePolicy';
  oldValue: string | undefined;
  newValue: string | undefined;
}

/**
 * Returns true when a recorded `DeletionPolicy` should prevent cdkd from
 * deleting the underlying AWS resource. `Retain` and `RetainExceptOnCreate`
 * both keep the resource around; `Delete` / `Snapshot` / undefined all
 * fall through to the normal delete path. Shared between
 * `runDestroyForStack` (state-only, no template) and `DeployEngine`'s
 * DELETE branch (state-preferred, template-fallback) so the two paths
 * cannot drift on the policy semantics. Lives here (not in
 * deploy-engine or destroy-runner) because both consumers already
 * depend on this module — placing it in either would create a cycle.
 */
export function shouldRetainResource(
  deletionPolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined
): boolean {
  return deletionPolicy === 'Retain' || deletionPolicy === 'RetainExceptOnCreate';
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
