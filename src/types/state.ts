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
 * - 6 — adds `StackState.parentStack` / `parentLogicalId` / `parentRegion`
 *       to support `AWS::CloudFormation::Stack` nested-stack adoption (issue
 *       [#459](https://github.com/go-to-k/cdkd/issues/459)). Child stacks
 *       record their parent's name + the child's logical id in the parent's
 *       template, so `cdkd state list` / `state show` can surface the
 *       parent → child tree and `cdkd destroy <child-only>` can reject
 *       with a clear pointer at the parent. The child's S3 key uses
 *       `cdkd/<parent>~<NestedStackLogicalId>/<region>/state.json` (the `~`
 *       separator avoids ambiguity with CDK Stage's `/`). Layout
 *       superset of v5; only the stack-level shape grew. v5 readers
 *       see v6 as `version: 6` and fail clearly. v6 writers always emit
 *       the new fields (undefined on top-level stacks, populated on
 *       nested-stack children). This prep PR adds the type bump alone —
 *       the `NestedStackProvider` that consumes the fields lands in a
 *       follow-up.
 * - 7 — adds `ResourceState.provisionedBy: 'sdk' | 'cc-api'` to support
 *       per-resource Cloud Control API routing for silent-drop properties
 *       (issue [#614](https://github.com/go-to-k/cdkd/issues/614)). When
 *       a fresh deploy detects a silent-drop top-level CFn property on a
 *       Tier 1 type, the resource is routed through Cloud Control API
 *       (which forwards the full property map to AWS) instead of the SDK
 *       Provider (which would drop the field). The state record's
 *       `provisionedBy: 'cc-api'` then sticks for subsequent
 *       deploy / drift / destroy operations on that resource — old
 *       state with the field absent defaults to SDK Provider (matches
 *       pre-v7 behavior). A v6 reader sees the field but doesn't know
 *       what it means and would route a CC-managed resource through
 *       the SDK Provider on update / destroy → silent data corruption
 *       (mid-life provider swap). The bump from 6 to 7 forces a v6
 *       reader to fail with a clear "upgrade cdkd" error instead.
 *       v7 writers always emit `provisionedBy` explicitly (`'sdk'` or
 *       `'cc-api'`); resources read from v6 state with the field
 *       absent are treated as `'sdk'` (legacy default) and the next
 *       write persists it explicitly. Layout superset of v6; only the
 *       resource-level shape grew.
 * - 8 — adds `StackState.outputReads` (the set of `Fn::GetStackOutput`
 *       references this stack resolved during its last deploy), the
 *       sibling of v4's `imports` for the weak-reference `Fn::GetStackOutput`
 *       intrinsic (issue [#668](https://github.com/go-to-k/cdkd/issues/668)).
 *       Consumed by `findDownstreamConsumers` in the
 *       `--recreate-via-cc-api` / `--recreate-via-sdk-provider` warn block
 *       so users can see exactly which downstream stacks read the
 *       recreated resource's outputs via `Fn::GetStackOutput` (in
 *       addition to the v4 `Fn::ImportValue` walk). Unlike `imports`,
 *       this field is purely informational — no destroy-time refusal
 *       (`Fn::GetStackOutput` is a weak reference by design; the
 *       producer stays deletable independently of consumers). Layout
 *       superset of v7; only the stack-level shape grew. v7 readers
 *       see v8 state with `outputReads` undefined → degrade gracefully
 *       (the enumeration just reports no `GetStackOutput` consumers).
 *       v8 writers always emit the field (omitted from JSON when the
 *       set is empty, matching how `imports` is persisted). v7 binary
 *       on v8 state → existing "Upgrade cdkd" hard-fail.
 *
 * cdkd readers handle every prior version. Writers always emit
 * `STATE_SCHEMA_VERSION_CURRENT`. An older cdkd binary that only knows an
 * earlier version will fail with a clear error when it encounters a higher
 * version, rather than silently mishandling the new format.
 */
export type StateSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const STATE_SCHEMA_VERSION_LEGACY: StateSchemaVersion = 1;
export const STATE_SCHEMA_VERSION_CURRENT: StateSchemaVersion = 8;

/**
 * Every schema version this binary can read. Writers always emit
 * `STATE_SCHEMA_VERSION_CURRENT`; older versions are accepted for
 * forward-migration, and an unknown / future version triggers an explicit
 * "upgrade cdkd" error in the parser.
 */
export const STATE_SCHEMA_VERSIONS_READABLE: readonly StateSchemaVersion[] = [
  1, 2, 3, 4, 5, 6, 7, 8,
];

/**
 * One `Fn::ImportValue` reference recorded during a consumer stack's
 * deploy. Persisted in `StackState.imports` so `cdkd destroy` can refuse
 * to delete the producer while the consumer still references its outputs
 * (strong reference, matches CloudFormation behavior).
 *
 * Only `Fn::ImportValue` populates this — `Fn::GetStackOutput` is a weak
 * reference by design (cdkd-specific) and is tracked separately in
 * `StackState.outputReads` (schema v8+) for downstream-consumer
 * enumeration only, NOT for destroy-time refusal.
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
 * One `Fn::GetStackOutput` reference recorded during a consumer stack's
 * deploy (schema v8+, issue
 * [#668](https://github.com/go-to-k/cdkd/issues/668)). Persisted in
 * `StackState.outputReads` so `findDownstreamConsumers` (called from the
 * `--recreate-via-cc-api` / `--recreate-via-sdk-provider` warn block) can
 * name the downstream stacks that will see a stale value after the
 * producer's recreate.
 *
 * Unlike `StateImportEntry`, this does NOT influence destroy semantics —
 * `Fn::GetStackOutput` is a weak reference by design (cdkd-specific),
 * and the producer stays deletable independently of consumers. The
 * enumeration is informational only.
 *
 * Cross-account RoleArn-based reads are NOT recorded in v8 (deferred to
 * a future schema bump alongside a `sourceAccountId` field — `RoleArn`
 * lookups already pay an STS hop at resolve time, so the cross-account
 * consumer set is rarely large in practice).
 */
export interface StateOutputReadEntry {
  /** The producer stack whose Output `Name` was read. */
  sourceStack: string;
  /**
   * The producer's region. Required so the enumeration's
   * `(producerStack, producerRegion)` match key is stable across
   * cross-region `Fn::GetStackOutput` references.
   */
  sourceRegion: string;
  /** The CloudFormation Output `Name` (template `Outputs.<Name>`) that was read. */
  outputName: string;
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

  /**
   * `Fn::GetStackOutput` references this stack resolved during its last
   * successful deploy (schema v8+, issue
   * [#668](https://github.com/go-to-k/cdkd/issues/668)). Sibling of
   * `imports` for the weak-reference `Fn::GetStackOutput` intrinsic —
   * consumed by `findDownstreamConsumers` so the recreate warn block
   * can name downstream stacks whose cached output values will go
   * stale after a producer's recreate.
   *
   * Absent (or undefined) on state written by a pre-v8 binary; the
   * enumeration degrades to imports-only in that case (matches the v4
   * shipped behavior). The next deploy of an upgraded stack
   * repopulates the field. Same persistence policy as `imports`:
   * emitted only when the resolved set is non-empty so an empty array
   * doesn't bloat every state file. Cross-account (`RoleArn`-based)
   * reads are deferred to a future schema bump alongside a
   * `sourceAccountId` field.
   */
  outputReads?: StateOutputReadEntry[];

  /**
   * Parent stack's physical name when THIS state record describes a
   * nested-stack child (issue [#459](https://github.com/go-to-k/cdkd/issues/459)).
   * Undefined on top-level stacks. The pre-v6 reader sees the field as
   * undefined and degrades to "I am a top-level stack" — which is correct
   * for every state file written before nested-stack support shipped.
   * v6+ writers populate this on child state records so `cdkd state list`
   * can surface the parent → child tree and `cdkd destroy <child-only>`
   * can reject with a pointer at the parent (matches CFn's "cannot
   * directly destroy a nested stack" semantic).
   *
   * v6 prep PR adds the field shape only; no writer touches it yet —
   * the `NestedStackProvider` that consumes it lands in the follow-up.
   */
  parentStack?: string;

  /**
   * The `AWS::CloudFormation::Stack` logical ID inside the parent's
   * template that produced this child. Combined with `parentStack`, the
   * pair uniquely identifies the child's position in the parent's DAG.
   * Used by `cdkd destroy` to reject `destroy <child-only>` with a
   * clear "destroy the parent instead" error message that names the
   * specific parent + child-logical-id pair, mirroring CFn's behavior.
   *
   * Undefined on top-level stacks; populated by v6+ writers on child
   * state records. Always paired with `parentStack` / `parentRegion`
   * (never set independently).
   */
  parentLogicalId?: string;

  /**
   * Region of the parent stack. Always equals `region` in v1 of the
   * nested-stack feature (AWS does not support cross-region nested
   * stacks — the `AWS::CloudFormation::Stack` resource lives in the
   * same region as its parent) but recorded explicitly so a future
   * cross-region capability does not require another schema bump.
   *
   * Undefined on top-level stacks; populated by v6+ writers on child
   * state records.
   */
  parentRegion?: string;

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

  /**
   * Which provisioning layer owns this resource (schema v7+, issue
   * [#614](https://github.com/go-to-k/cdkd/issues/614)).
   *
   * - `'sdk'` — SDK Provider (the cdkd-preferred fast path: direct
   *   synchronous AWS SDK calls per resource type, no polling).
   * - `'cc-api'` — Cloud Control API (the fallback path: async polling
   *   create/update/delete via the unified CloudControlClient). Routed
   *   automatically when the resource's template uses a top-level CFn
   *   property the SDK Provider would silently drop. CC API forwards
   *   the full property map to AWS, closing the silent-drop bug.
   *
   * Absent / `undefined` means SDK Provider (legacy v6-and-earlier
   * default — every resource pre-#614 was SDK-managed). v7 writers always
   * emit the field explicitly so the routing decision is durable.
   *
   * The field is **sticky**: once a resource is `'cc-api'`, subsequent
   * SDK Provider backfills (issue #609) do NOT auto-migrate it back to
   * SDK. Avoids physical-ID churn + destroy + recreate cycles on every
   * backfill release. User-initiated migration in either direction lives
   * under issue #615 (`--recreate-via-cc-api`) and a future CC → SDK
   * counterpart.
   */
  provisionedBy?: 'sdk' | 'cc-api' | undefined;
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

  /**
   * Set on synthetic changes created by replacement propagation (issue
   * #807): the property's template value did not change, but a resource it
   * references via Ref / Fn::GetAtt will be REPLACED, so the resolved
   * physical ID / ARN it points at will change at deploy time. `oldValue`
   * is the resolved current value (e.g. an old ARN) while `newValue` is the
   * still-unresolved intrinsic — the diff renderer annotates this so the
   * apparent string -> {Ref} delta reads as a propagated replacement rather
   * than a literal value edit.
   */
  replacementPropagated?: boolean;
}
