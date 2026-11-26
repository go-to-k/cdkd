/*
 * RDS DBInstance / DBCluster properties CloudFormation's RDS handler calls
 * immutable (go-to-k/cdkd#7044), transcribed from
 * aws-cloudformation/aws-cloudformation-resource-providers-rds at commit
 * 5a410e843efb90076c1c4d322707bc989e5a058b:
 * `aws-rds-dbinstance/.../dbinstance/util/ImmutabilityHelper.java`
 * `isChangeMutable` (with `ResourceModelHelper.isDB{Instance,Cluster}ReadReplicaPromotion`)
 * and `aws-rds-dbcluster/.../dbcluster/util/ImmutabilityHelper.java`
 * `isGlobalClusterMutable`. The update handler runs them on the PREVIOUS and
 * DESIRED template models (cdkd's recorded `properties` and the template), and
 * an immutable change fails `NotUpdatable`, which CloudFormation turns into a
 * replacement, as for `Engine` (#5467, `predicates.ts`). MEASURED on #7038:
 * `AvailabilityZone` us-east-1a -> us-east-1b and `PerformanceInsightsKMSKeyId`
 * key A -> key B both created a new DB instance.
 *
 * Each predicate is the handler's check negated, never broader. `Objects.equal`
 * is exact, `isNullOrEmpty` treats an absent value and `""` alike, and
 * `BooleanUtils.isTrue` is only `true`. A value the diff could not resolve (an
 * intrinsic object, or any non-string where the handler reads a string) cannot
 * be judged from the two bags, so it keeps cdkd's previous verdict: no
 * replacement. So does the diff's promoted-dependent probe (no value on either
 * side): the handler sees equal models there. Both are go-to-k/cdkd#7052.
 */
import type { ReplacementSiblings } from './types.js';

/** A value the handler's check cannot be run on from the template bags. */
const UNDECIDABLE = Symbol('undecidable');

/** A Java `String` model field: absent is `null`. */
function javaString(value: unknown): string | null | typeof UNDECIDABLE {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : UNDECIDABLE;
}

/** A Java `Boolean` model field; the model accepts the `"true"` / `"false"` spellings. */
function javaBoolean(value: unknown): boolean | null | typeof UNDECIDABLE {
  if (value === undefined || value === null) return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return UNDECIDABLE;
}

const isNullOrEmpty = (value: string | null): boolean => value === null || value === '';

/**
 * `Objects.equal(previous, desired) || isNullOrEmpty(desired)`, negated: the
 * restore inputs (`DBSnapshotIdentifier`, `DBClusterSnapshotIdentifier`,
 * `RestoreTime`, `SourceDBInstanceAutomatedBackupsArn`, `SourceDbiResourceId`).
 * Adding or changing one replaces; removing one does not.
 */
export function dbInstanceRestoreInputChangeReplaces(
  oldValue: unknown,
  newValue: unknown
): boolean {
  const before = javaString(oldValue);
  const after = javaString(newValue);
  if (before === UNDECIDABLE || after === UNDECIDABLE) return false;
  return before !== after && !isNullOrEmpty(after);
}

/**
 * `isUseLatestRestorableTimeMutable`, negated: replaces when the desired value
 * is `true` and the previous one is not.
 */
export function dbInstanceUseLatestRestorableTimeChangeReplaces(
  oldValue: unknown,
  newValue: unknown
): boolean {
  const before = javaBoolean(oldValue);
  const after = javaBoolean(newValue);
  if (before === UNDECIDABLE || after === UNDECIDABLE) return false;
  return before !== after && after === true;
}

/**
 * `isSourceDBInstanceIdentifierMutable` / `isSourceDBClusterIdentifierMutable`,
 * negated: any change replaces except the read-replica promotion (a non-empty
 * source removed).
 */
export function dbInstanceReplicaSourceChangeReplaces(
  oldValue: unknown,
  newValue: unknown
): boolean {
  const before = javaString(oldValue);
  const after = javaString(newValue);
  if (before === UNDECIDABLE || after === UNDECIDABLE) return false;
  if (before === after) return false;
  const promotion = !isNullOrEmpty(before) && isNullOrEmpty(after);
  return !promotion;
}

/**
 * `isPerformanceInsightsKMSKeyIdMutable`, negated: replaces when the previous
 * key is non-empty and the desired one differs, a removal included. Setting a
 * key where none was declared is in place.
 */
export function dbInstancePerformanceInsightsKmsKeyChangeReplaces(
  oldValue: unknown,
  newValue: unknown
): boolean {
  const before = javaString(oldValue);
  const after = javaString(newValue);
  if (before === UNDECIDABLE || after === UNDECIDABLE) return false;
  return !isNullOrEmpty(before) && before !== after;
}

/**
 * `isAvailabilityZoneChangeMutable`, negated: any change replaces, except a
 * zone left empty on a desired `MultiAZ: true` instance (RDS picks the zones).
 * An empty desired zone whose `MultiAZ` the bags cannot tell (no siblings, or
 * an unresolved value) keeps the previous verdict.
 */
export function dbInstanceAvailabilityZoneChangeReplaces(
  oldValue: unknown,
  newValue: unknown,
  siblings?: ReplacementSiblings
): boolean {
  const before = javaString(oldValue);
  const after = javaString(newValue);
  if (before === UNDECIDABLE || after === UNDECIDABLE) return false;
  if (before === after) return false;
  if (isNullOrEmpty(after)) {
    if (siblings === undefined) return false;
    const multiAz = javaBoolean(siblings.newProperties['MultiAZ']);
    if (multiAz === UNDECIDABLE || multiAz === true) return false;
  }
  return true;
}

/**
 * The DBCluster handler's `isGlobalClusterMutable`, negated: adding or
 * changing the global cluster replaces; removing a non-empty one detaches the
 * cluster in place (`remove-from-global-cluster`).
 */
export function dbClusterGlobalClusterChangeReplaces(
  oldValue: unknown,
  newValue: unknown
): boolean {
  const before = javaString(oldValue);
  const after = javaString(newValue);
  if (before === UNDECIDABLE || after === UNDECIDABLE) return false;
  if (!isNullOrEmpty(before) && isNullOrEmpty(after)) return false;
  return before !== after;
}
