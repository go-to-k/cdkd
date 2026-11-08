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

  /**
   * Set on synthetic changes created by IN-PLACE attribute propagation
   * (`DiffCalculator.promoteInPlaceAttributeDependents`, every arm): the
   * property's template value did not change, but an attribute it reads of an
   * updated resource may move. Whether it DID is known only once the deploy
   * resolves the reader, so `requiresReplacement` here is a CEILING, not a
   * verdict: the deploy engine drops it for a path whose resolved value equals
   * the record (go-to-k/cdkd#3662). `replacementPropagated` changes get the
   * same treatment, since their seed can be such a ceiling too.
   */
  inPlacePropagated?: boolean;

  /**
   * Set on an `inPlacePropagated` change whose ONLY cause is a `NoEcho`
   * template parameter the property reads (go-to-k/cdkd#4043): state holds
   * `***` there, so the diff cannot tell whether the value moved, and the
   * engine settles it by a readback that never replaces the resource on its
   * word. `--require-approval` and the destructive report do not count it.
   */
  noEchoPromoted?: true;

  /**
   * Set on a change only the record's `maskedPropertyFingerprints` detects
   * (go-to-k/cdkd#4451): both sides read `***`, but the property's template
   * expression changed (the text around a secret reference, or its target),
   * or a non-secret input it reads did (go-to-k/cdkd#4543). The diff
   * renderer labels it, since `*** -> ***` reads as no change.
   */
  maskedExpressionChanged?: true;

  /**
   * Set on a change only the record's `unsettledProperties` adds
   * (go-to-k/cdkd#5380): an earlier update of the property failed after an
   * irreversible call, so AWS may hold either side although the template and
   * the record agree. Always in place; the diff renderer labels it.
   */
  unsettled?: true;

  /**
   * Set on an `inPlacePropagated` change the READ-PROVENANCE arm added
   * (state schema v12, go-to-k/cdkd#4852): the property holds a secret token
   * it read from an upstream whose record no longer holds the version the
   * reader recorded. A ceiling like every propagated change; the engine sends
   * it only when the versions it is served moved.
   */
  readProvenancePromoted?: true;
}
