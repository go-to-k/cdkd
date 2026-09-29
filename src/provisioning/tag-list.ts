/**
 * How a CloudFormation `Tags` list (`[{ Key, Value }]`) is read before a
 * provider diffs it into tag / untag calls (go-to-k/cdkd#3994).
 *
 * The untag set is the gap between the recorded and the desired side, so a
 * present-but-malformed value read as empty removes tags. Twenty-two providers
 * used to walk `tags ?? []` and keep entries with a defined `Key` and `Value`:
 * a string was walked by character (every entry dropped out) and an entry
 * missing `Value` dropped silently. On a rollback replay or `drift --revert`,
 * where the desired side is a recorded bag, a `Tags: "x"` untagged every
 * recorded key — tags drive ABAC permissions and cost allocation.
 *
 * - `undefined` / `null` is ABSENT, the empty list.
 * - A list of `{ Key: non-empty string, Value: scalar }` is well-formed, the
 *   Value read as a string: CloudFormation coerces a number or boolean for a
 *   String-typed property, so `Value: 1` deploys there and must here. The
 *   empty-string `Value` is legitimate, and keys are case-sensitive.
 * - Anything else is MALFORMED (a missing, null, object or list Value
 *   included). A malformed DESIRED side is refused before any
 *   call ({@link refuseMalformedDesiredTags}); a malformed RECORDED side is
 *   applied ADD-only: every desired tag is set and nothing is untagged
 *   ({@link planTagDiff}).
 *
 * A Key holding a dynamic reference or cdkd's mask names nothing AWS holds:
 * on the DESIRED side it makes the list malformed; on the RECORDED side (cdkd
 * keeps the reference in state) that entry is left out of the untag set.
 */

import { markNonRetryable } from '../deployment/retryable-errors.js';
import { safeMsg } from '../utils/display-safe.js';
import { ProvisioningError } from '../utils/error-handler.js';
import { holdsSecretDerivedEntry } from './iam-policy-targets.js';

/** One well-formed CloudFormation tag. */
export interface CfnTagEntry {
  Key: string;
  Value: string;
}

export type TagListSide = 'desired' | 'recorded';

/** What {@link readTagList} found. */
export type TagListRead =
  // `hidden`: recorded entries left out because their Key is secret-derived.
  | { kind: 'tags'; tags: CfnTagEntry[]; hidden: number }
  // `secretDerived`: an entry's Key holds a dynamic reference or its mask.
  | { kind: 'malformed'; secretDerived: boolean };

/** Per-type departures from the default shape. */
export interface TagReadOptions {
  /**
   * An entry may omit `Value`, read as `''`: `AWS::RDS::DBProxy` /
   * `DBProxyEndpoint` declare their tag Value optional (CFn and the CDK L1 both
   * accept `{ Key }`). A `null` or object Value stays malformed.
   */
  allowOmittedValue?: boolean;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isTagEntry(
  entry: unknown,
  options: TagReadOptions
): entry is { Key: string; Value?: string | number | boolean } {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  const value = e['Value'];
  return (
    typeof e['Key'] === 'string' &&
    e['Key'].length > 0 &&
    (isScalar(value) || (options.allowOmittedValue === true && value === undefined))
  );
}

/**
 * `AWS::RDS::DBProxy` / `AWS::RDS::DBProxyEndpoint`, whose CFn tag `Value` is
 * optional: the options and the shape a refusal names.
 */
export const DBPROXY_TAG_OPTIONS: TagReadOptions = { allowOmittedValue: true };
export const DBPROXY_TAGS_WHAT =
  'a list of tags with a non-empty string Key and an optional scalar Value';

/** Some entry of a malformed value names its Key with a dynamic reference or its mask. */
function holdsSecretDerivedKey(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        holdsSecretDerivedEntry((e as Record<string, unknown>)['Key'])
    )
  );
}

/**
 * A `Tags` property CloudFormation types as a key -> value MAP
 * (`AWS::SSM::Parameter`, the Glue types): a map whose every key is non-empty
 * and every value a scalar becomes the equivalent list; anything else is
 * returned unchanged, so {@link readTagList} refuses it (desired) or reads it
 * as unreadable (recorded) instead of treating it as no tags.
 */
export function tagMapAsList(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([k, v]) => k.length > 0 && isScalar(v))) return value;
  return entries.map(([Key, Value]) => ({ Key, Value }));
}

/**
 * Read one `Tags` value. On the `recorded` side an entry whose Key holds a
 * dynamic reference or its mask is dropped from `tags` (so it is never
 * untagged); on the `desired` side it makes the whole list malformed.
 */
export function readTagList(
  value: unknown,
  side: TagListSide,
  options: TagReadOptions = {}
): TagListRead {
  if (value === undefined || value === null) return { kind: 'tags', tags: [], hidden: 0 };
  if (!Array.isArray(value) || !value.every((e) => isTagEntry(e, options))) {
    return { kind: 'malformed', secretDerived: holdsSecretDerivedKey(value) };
  }
  const tags: CfnTagEntry[] = value.map((t) => ({ Key: t.Key, Value: String(t.Value ?? '') }));
  const secretKey = (t: CfnTagEntry): boolean => holdsSecretDerivedEntry(t.Key);
  if (side === 'desired') {
    return tags.some(secretKey)
      ? { kind: 'malformed', secretDerived: true }
      : { kind: 'tags', tags, hidden: 0 };
  }
  const kept = tags.filter((t) => !secretKey(t));
  return { kind: 'tags', tags: kept, hidden: tags.length - kept.length };
}

/**
 * Refuse a malformed DESIRED `Tags` before any call, on create and update
 * alike, naming the property and never its content. Returns the well-formed
 * list. `physicalId` is set on the update path; `what` describes the accepted
 * shape for a property that also takes another one (a key -> value map).
 */
export function refuseMalformedDesiredTags(
  value: unknown,
  resourceType: string,
  logicalId: string,
  physicalId?: string,
  property = 'Tags',
  what = 'a list of tags with a non-empty string Key and a scalar Value',
  options: TagReadOptions = {}
): CfnTagEntry[] {
  const read = readTagList(value, 'desired', options);
  if (read.kind === 'tags') return read.tags;
  const updating = physicalId !== undefined;
  throw markNonRetryable(
    new ProvisioningError(
      safeMsg`${updating ? 'desired ' : ''}${property} of ${resourceType} ${logicalId} is not ${what}` +
        (read.secretDerived
          ? ` (${property} holds a dynamic reference or its mask where a tag key belongs, ` +
            `which names nothing AWS holds)`
          : '') +
        ` — the resource was not ${updating ? 'updated' : 'created'}`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/** What {@link planTagDiff} decided. */
export interface TagDiffPlan {
  /** Desired tags to set: new or changed ones, or every desired tag when the record is unreadable. */
  set: Map<string, string>;
  /** Recorded keys the desired side no longer names; always empty when the record is unreadable. */
  remove: string[];
  /** The recorded side was malformed, so nothing is untagged: warn with {@link tagPlanWarning}. */
  recordedUnreadable: boolean;
  /**
   * Recorded entries whose Key is secret-derived, left out of `remove`: cdkd
   * cannot name them, so one the template dropped stays on AWS. Warn with
   * {@link tagPlanWarning}.
   */
  recordedHidden: number;
}

function toTagMap(tags: CfnTagEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tags) m.set(t.Key, t.Value);
  return m;
}

/**
 * Diff a recorded and a desired `Tags` value. The desired side must already
 * have passed {@link refuseMalformedDesiredTags}; a malformed one throws here
 * rather than being read as empty.
 */
export function planTagDiff(
  recorded: unknown,
  desired: unknown,
  options: TagReadOptions = {}
): TagDiffPlan {
  const next = readTagList(desired, 'desired', options);
  if (next.kind === 'malformed') {
    throw new Error('desired Tags is not a list of tags; refuse it before planning the diff');
  }
  const newMap = toTagMap(next.tags);
  const prev = readTagList(recorded, 'recorded', options);
  if (prev.kind === 'malformed') {
    return { set: newMap, remove: [], recordedUnreadable: true, recordedHidden: 0 };
  }
  const oldMap = toTagMap(prev.tags);
  const set = new Map<string, string>();
  for (const [k, v] of newMap) {
    if (oldMap.get(k) !== v) set.set(k, v);
  }
  const remove = [...oldMap.keys()].filter((k) => !newMap.has(k));
  return { set, remove, recordedUnreadable: false, recordedHidden: prev.hidden };
}

/**
 * The warning a plan owes, or `undefined`: a recorded `Tags` cdkd cannot read,
 * or recorded keys it cannot name. Echoes no record content.
 */
export function tagPlanWarning(
  plan: TagDiffPlan,
  resourceType: string,
  id: string
): string | undefined {
  if (plan.recordedUnreadable) {
    return recordedTagsUnreadableWarning(resourceType, id, plan.set.size);
  }
  if (plan.recordedHidden > 0) {
    return safeMsg`The recorded Tags of ${resourceType} ${id} holds ${plan.recordedHidden} key(s) derived from a dynamic reference or its mask, which cdkd cannot name, so it removed none of them. Untag any such key the template no longer names yourself.`;
  }
  return undefined;
}

/** The warning for a recorded `Tags` cdkd cannot read; echoes no record content. */
export function recordedTagsUnreadableWarning(
  resourceType: string,
  id: string,
  applied: number
): string {
  return safeMsg`The recorded Tags of ${resourceType} ${id} is not a list cdkd can read, so cdkd removed no tag and applied the ${applied} desired tag(s) only. Untag any key the template no longer names yourself.`;
}
