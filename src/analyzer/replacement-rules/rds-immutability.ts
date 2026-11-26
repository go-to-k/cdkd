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
 * `BooleanUtils.isTrue` is only `true`.
 *
 * A string field the diff could not resolve (an intrinsic object, typically a
 * `Ref` / `Fn::GetAtt` of a resource this deploy creates, or any non-string
 * where the handler reads a string) is judged as the handler will see it once
 * resolved (go-to-k/cdkd#7052): a non-empty value that differs from every
 * other value but the same unresolved one. A new resource's id or ARN cannot
 * equal the previous string, and the diff calls such a pair changed too
 * (`valuesEqual`). So does the diff's promoted-dependent probe (`undefined`,
 * `undefined`): the field references a resource being replaced, so both sides
 * are non-empty and the value WILL move once it resolves. That answer is a
 * ceiling the engine lowers when the resolved value turns out unmoved, and
 * re-judges with the resolved values when it moved
 * (`eventInvokeConfigFunctionChanged` answers the probe the same way).
 *
 * A known RESIDUAL: an unresolved value that resolves to the recorded one
 * anyway (an attribute of a new resource, or a new export, holding the same
 * key ARN). That row is no ceiling, so the replacement stands, and the
 * stateful guard refuses it without `--force-stateful-recreation`.
 *
 * A `Boolean` field the diff could not resolve stays undecidable: it may
 * resolve to either value, so it keeps cdkd's previous verdict (no
 * replacement), except for the probe, which is a ceiling.
 */
import { keyOrderFreeJson } from '../../deployment/deploy-value-equality.js';
import type { ReplacementSiblings } from './types.js';

/**
 * A string field the diff could not resolve: non-empty once resolved, and
 * equal only to the same unresolved value.
 */
const UNRESOLVED = Symbol('unresolved');

/** A `Boolean` field the diff could not resolve. */
const UNDECIDABLE = Symbol('undecidable');

/** A Java `String` model field: absent is `null`. */
type JavaString = string | null | typeof UNRESOLVED;

/** Both sides of a string field, and whether the handler's `Objects.equal` holds. */
interface StringChange {
  readonly before: JavaString;
  readonly after: JavaString;
  readonly equal: boolean;
}

function javaString(value: unknown): JavaString {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : UNRESOLVED;
}

/** The two sides of a string field, the promoted-dependent probe included. */
function stringChange(oldValue: unknown, newValue: unknown): StringChange {
  if (oldValue === undefined && newValue === undefined) {
    // The probe: a reference to a resource being replaced, on both sides.
    return { before: UNRESOLVED, after: UNRESOLVED, equal: false };
  }
  const before = javaString(oldValue);
  const after = javaString(newValue);
  const equal =
    before === UNRESOLVED && after === UNRESOLVED
      ? keyOrderFreeJson(oldValue) === keyOrderFreeJson(newValue)
      : before === after;
  return { before, after, equal };
}

/** A Java `Boolean` model field; the model accepts the `"true"` / `"false"` spellings. */
function javaBoolean(value: unknown): boolean | null | typeof UNDECIDABLE {
  if (value === undefined || value === null) return null;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return UNDECIDABLE;
}

/** An unresolved value is non-empty once resolved. */
const isNullOrEmpty = (value: JavaString): boolean => value === null || value === '';

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
  const { after, equal } = stringChange(oldValue, newValue);
  return !equal && !isNullOrEmpty(after);
}

/**
 * `isUseLatestRestorableTimeMutable`, negated: replaces when the desired value
 * is `true` and the previous one is not. An unresolved side keeps the previous
 * verdict; the promoted-dependent probe answers `true` (a ceiling).
 */
export function dbInstanceUseLatestRestorableTimeChangeReplaces(
  oldValue: unknown,
  newValue: unknown
): boolean {
  if (oldValue === undefined && newValue === undefined) return true;
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
  const { before, after, equal } = stringChange(oldValue, newValue);
  if (equal) return false;
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
  const { before, equal } = stringChange(oldValue, newValue);
  return !isNullOrEmpty(before) && !equal;
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
  const { after, equal } = stringChange(oldValue, newValue);
  if (equal) return false;
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
  const { before, after, equal } = stringChange(oldValue, newValue);
  if (!isNullOrEmpty(before) && isNullOrEmpty(after)) return false;
  return !equal;
}
