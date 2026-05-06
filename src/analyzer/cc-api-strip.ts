/**
 * Strip AWS-managed / generated fields from a Cloud Control API
 * `GetResource` response BEFORE the drift comparator sees it.
 *
 * The drift comparator (`src/analyzer/drift-calculator.ts`) only descends
 * into keys that exist in cdkd state, so AWS-only top-level fields
 * (`CreationDate`, `LastModifiedTime`, ...) are already harmless: state
 * doesn't carry them, so the comparator never traverses them. The strip
 * pass exists for two narrower reasons:
 *
 *   1. **Ambiguous overlaps** — sometimes AWS attaches a managed field at
 *      the same path that ALSO appears in cdkd state (typically because
 *      the field IS managed but cdkd records its initial value at create
 *      time, then AWS rewrites it on every subsequent operation —
 *      `Arn`-with-account-rotation / `RevisionId` / etc.). The
 *      comparator would see the path in state, descend into AWS, and
 *      surface the rewritten value as drift even though the user did
 *      nothing.
 *   2. **Future-proofing** — for the deny-list-style approach we want a
 *      single chokepoint that catches the cross-cutting "AWS reports
 *      this in every response and it has nothing to do with cdkd's
 *      desired state" cases without a per-type entry. A single strip
 *      list is far cheaper to maintain than per-resource overrides.
 *
 * The helper is intentionally **generic** — it applies to every CC API
 * response without a per-resource-type switch. The cost of a false
 * negative (a real drift on one of these paths) is low because every
 * field listed here is documented as AWS-managed, generated, or
 * timestamp-shaped — none of them are properties a user could set
 * meaningfully via a CFn template.
 *
 * Strips are shallow only — fields are removed if they appear at any
 * depth (recursive walk) but the values themselves are not modified.
 * Arrays are walked element-wise.
 */

/**
 * Field names AWS attaches to nearly every resource. These are NOT user
 * configurable in the CFn template, so they have no counterpart in cdkd
 * state and surfacing them through the drift comparator is always noise.
 *
 * Match is case-sensitive — AWS uses PascalCase consistently in CC API
 * responses. The list intentionally errs on the side of "drop common
 * timestamp / generated-id fields" rather than tracking every per-type
 * managed field — the deny-list catches per-type structural divergence;
 * this helper catches generic noise.
 */
const ALWAYS_STRIPPED_FIELDS = new Set<string>([
  // Timestamps — AWS-managed, change on every modification. Names are
  // unambiguous: no CFn template ever exposes a "CreationDate" /
  // "LastModifiedTime" as a settable input.
  'CreationDate',
  'CreationTime',
  'CreatedTime',
  'CreatedDate',
  'CreatedAt',
  'LastModifiedDate',
  'LastModifiedTime',
  'LastModified',
  'LastUpdatedTime',
  'LastUpdatedDate',
  'UpdatedAt',

  // Owner / account / principal info — derived from the calling
  // principal, never user-set in a CFn template. `CreatedBy` /
  // `OwnerArn` are unique enough that no settable CFn property
  // collides with them.
  'OwnerId',
  'OwnerAccountId',
  'CreatedBy',
  'OwnerArn',

  // Lambda-specific generated identifiers. `RevisionId` rotates on
  // every operation; `LastUpdateStatus*` mirror runtime state. None
  // are settable in a CFn template.
  'RevisionId',
  'LastUpdateStatus',
  'LastUpdateStatusReason',
  'LastUpdateStatusReasonCode',

  // CloudFormation/Cloud Control passthrough metadata — never
  // appears as a settable input in a CFn template body.
  'StackId',
  'PhysicalResourceId',
  'LogicalResourceId',

  // Notes on intentional EXCLUSIONS:
  //
  // `State` / `Status` / `StateReason` / `StatusReason` — these
  // names ARE used by some CFn types as settable nested properties
  // (e.g. `AWS::ECS::CapacityProvider.AutoScalingGroupProvider.ManagedScaling.Status`,
  // `AWS::S3::Bucket.VersioningConfiguration.Status`). Stripping them
  // globally would cause false-positive drift on a clean stack.
  // The comparator already ignores AWS-only top-level `Status` values
  // because state doesn't carry them; only the nested-name-collision
  // cases would have leaked through, and excluding them here protects
  // those.
  //
  // `Arn` — many CFn types accept `Arn` as a settable property and
  // cdkd state may record it at create time. Drift on `Arn` is
  // genuine drift the user wants to see.
  //
  // `VersionId` / `GenerationId` / `ETag` — narrow utility (only S3
  // / KMS / ImageBuilder use these in their Get* responses), and at
  // least `VersionId` IS a settable input on `AWS::S3::Bucket`'s
  // versioning config. Per-provider readCurrentState handles them.
  //
  // `AccountId` / `StackName` — also collide with settable inputs
  // on a few CFn types (`AWS::CloudWatch::CrossAccountSharingRule.AccountId`,
  // `AWS::CloudFormation::HookDefaultVersion.StackName`).
  //
  // `StartTime` / `EndTime` — used as settable inputs in scheduling
  // shapes (e.g. `AWS::AutoScaling::ScheduledAction.StartTime`).
]);

/**
 * Strip known AWS-managed / generated fields from a CC API GetResource
 * response. Runs recursively so nested objects (e.g.
 * `LoggingConfiguration.LastModifiedTime`) are also cleaned.
 *
 * The `resourceType` parameter is currently unused — kept on the
 * signature so per-type overrides can slot in later without a caller
 * change. (Most cross-cutting noise is handled by the generic list;
 * per-type quirks should prefer first-class SDK `readCurrentState`.)
 *
 * Returns a new object — does not mutate the input.
 */
export function stripCcApiAwsManagedFields(
  resourceType: string,
  awsProps: Record<string, unknown>
): Record<string, unknown> {
  void resourceType;
  return stripWalk(awsProps) as Record<string, unknown>;
}

function stripWalk(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(stripWalk);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (ALWAYS_STRIPPED_FIELDS.has(key)) continue;
      out[key] = stripWalk(child);
    }
    return out;
  }
  return value;
}

/**
 * Test-only export of the strip list, so the unit tests can assert
 * against the exact set of fields without re-declaring it.
 *
 * Not part of the public surface — `cc-api-strip.test.ts` is the only
 * intended consumer. The export is `Set<string>` (read-only by
 * convention; `Set` itself is mutable but tests do not modify it).
 */
export const STRIPPED_FIELDS_FOR_TEST: ReadonlySet<string> = ALWAYS_STRIPPED_FIELDS;
