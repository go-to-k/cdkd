/**
 * The `LifecycleConfiguration` drift baseline the deploy captures right after
 * cdkd's own write (`ReadCurrentStateContext.afterOwnWrite`,
 * go-to-k/cdkd#6609).
 *
 * `GetBucketLifecycleConfiguration` is eventually consistent. Measured in
 * us-east-1 (2026-11-19, reads every ~250 ms for 4 s after each
 * `PutBucketLifecycleConfiguration` / `DeleteBucketLifecycle`): 40 of 143
 * reads answered the PREVIOUS configuration or none, and the answer FLAPS
 * (new, then old again) for at least 4 s. Taken as the baseline, the old
 * rules make `drift --revert` re-apply an old expiration (the data-loss
 * direction) or delete the declared rules.
 *
 * So on that capture, and only when THIS create / update sent a lifecycle Put
 * or Delete ({@link recordLifecycleWrite}), an answer that differs from what
 * was written is re-read on {@link LIFECYCLE_BASELINE_REREAD_DELAYS_MS}. A
 * written configuration the schedule never sees is KEPT in the readback's
 * shape; a just-deleted one still visible records nothing for the key. Every
 * other read, a capture after a write that left the lifecycle alone included,
 * takes the first answer.
 */
import { memberReadFailure, reReadUntilSettled } from '../../settle-after-own-write.js';
import {
  deepSameValue,
  effectiveLifecycleConfiguration,
  lifecycleRuleRefused,
} from './lifecycle-fold.js';
import { coerceCfnNumber, isPlainObject } from './shared.js';

/**
 * Waits between re-reads of a disagreeing answer: five reads, 7.5 s at most,
 * spent only when the first answer disagrees. Longer than the policy
 * schedule (`OWN_WRITE_REREAD_DELAYS_MS`, 3.5 s) because the lifecycle lag was
 * still unsettled at 4 s. Each read was stale about 28% of the time
 * independently of the last, so five stale reads in a row is about 0.2%.
 * A measurement, not a documented bound.
 */
export const LIFECYCLE_BASELINE_REREAD_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000];

/**
 * What S3 reads back as `TransitionDefaultMinimumObjectSize` after a Put that
 * does not send one (measured us-east-1: a bucket holding
 * `varies_by_storage_class` read `all_storage_classes_128K` after such a Put).
 */
export const LIFECYCLE_DEFAULT_TRANSITION_MIN_SIZE = 'all_storage_classes_128K';

const TDMOS_KEY = 'TransitionDefaultMinimumObjectSize';

/** The lifecycle call a create / update just sent for a bucket. */
export type LifecycleWrite = 'put' | 'delete';

/**
 * Per S3 client, the buckets whose lifecycle the running create / update
 * wrote. Keyed by the client so a per-call view of the provider (its
 * prototype is the provider, the client inherited) shares it, while the
 * `noWriteProbe` stub client never reaches a real capture.
 */
const lifecycleWrites = new WeakMap<object, Map<string, { write: LifecycleWrite; op: object }>>();

/**
 * Note that a lifecycle Put / Delete for `bucket` just succeeded. `provider`
 * is the per-call view the create / update runs on, so a call that throws can
 * drop the notes it made ({@link clearLifecycleWritesOf}).
 */
export function recordLifecycleWrite(
  provider: { s3Client: object },
  bucket: string,
  write: LifecycleWrite
): void {
  let writes = lifecycleWrites.get(provider.s3Client);
  if (writes === undefined) {
    writes = new Map();
    lifecycleWrites.set(provider.s3Client, writes);
  }
  writes.set(bucket, { write, op: provider });
}

/** The lifecycle write noted for `bucket`, consumed by the capture that reads it. */
export function takeLifecycleWrite(client: object, bucket: string): LifecycleWrite | undefined {
  const writes = lifecycleWrites.get(client);
  const noted = writes?.get(bucket);
  writes?.delete(bucket);
  return noted?.write;
}

/**
 * Drop the notes a create / update made on `provider` (its per-call view):
 * a call that throws is followed by no capture, and a note left behind would
 * make a later, unrelated capture of that bucket re-read on it.
 */
export function clearLifecycleWritesOf(provider: { s3Client: object }): void {
  const writes = lifecycleWrites.get(provider.s3Client);
  if (writes === undefined) return;
  for (const [bucket, noted] of writes) {
    if (noted.op === provider) writes.delete(bucket);
  }
}

/**
 * What the template declares for the lifecycle, folded onto the readback's
 * shape: `absent` (no configuration or no rules), `present` with the folded
 * configuration, or `undefined` when the applier would not send the
 * declaration as written, so no readback can ever equal it: a non-object
 * configuration or rule, a refused rule, or a folded rule holding a shape
 * `readLifecycle` never emits (an `ExpiredObjectDeleteMarker` beside an
 * expiration, which the applier drops with a warning; a non-numeric day
 * count; a date it does not fold). Quoted numbers are coerced, as the wire
 * sends them: S3 reads them back as numbers.
 *
 * `onUnsettled` rides along for the capture to say when it never settled.
 */
export type DeclaredLifecycle =
  | { kind: 'absent'; onUnsettled?: () => void }
  | { kind: 'present'; expected: Record<string, unknown>; onUnsettled?: () => void };

export function declaredLifecycle(properties: unknown): DeclaredLifecycle | undefined {
  if (!isPlainObject(properties)) return undefined;
  const config = properties['LifecycleConfiguration'];
  if (config == null) return { kind: 'absent' };
  if (!isPlainObject(config)) return undefined;
  const rules = config['Rules'];
  if (rules == null || (Array.isArray(rules) && rules.length === 0)) return { kind: 'absent' };
  if (!Array.isArray(rules) || !rules.every(isPlainObject)) return undefined;
  if (rules.some(lifecycleRuleRefused)) return undefined;
  const folded = effectiveLifecycleConfiguration(config) as Record<string, unknown>;
  const expected = readbackShape(folded);
  return expected === undefined ? undefined : { kind: 'present', expected };
}

/**
 * What the post-write capture settles on, given the lifecycle call the
 * create / update sent ({@link takeLifecycleWrite}): a Delete settles on
 * absent; a Put on the declared configuration, when the bag declares one the
 * applier sends as written; anything else (no lifecycle call, no informative
 * bag) `undefined`, the first answer. Built here, not at the read site, whose
 * object literals the nested-key coverage walk reads as reverse-map keys.
 */
export function lifecycleSettleTarget(
  write: LifecycleWrite | undefined,
  properties: Record<string, unknown> | undefined,
  onUnsettled: () => void
): DeclaredLifecycle | undefined {
  if (write === 'delete') return { kind: 'absent', onUnsettled };
  if (write !== 'put' || properties === undefined || Object.keys(properties).length === 0) {
    return undefined;
  }
  const declared = declaredLifecycle(properties);
  return declared?.kind === 'present' ? { ...declared, onUnsettled } : undefined;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RULE_KEYS = new Set([
  'Id',
  'Status',
  'Prefix',
  'ExpirationInDays',
  'ExpirationDate',
  'ExpiredObjectDeleteMarker',
  'Transitions',
  'NoncurrentVersionExpiration',
  'NoncurrentVersionTransitions',
  'AbortIncompleteMultipartUpload',
  'Filter',
]);

/** Thrown inside {@link readbackShape} for a value no readback can hold. */
class NotReadable extends Error {}

function num(value: unknown): number {
  const n = coerceCfnNumber(value);
  if (n === undefined) throw new NotReadable();
  return n;
}

/** `block`'s numeric members coerced, or {@link NotReadable} for a key outside `keys`. */
function numbers(block: unknown, numeric: string[], other: string[] = []): Record<string, unknown> {
  if (!isPlainObject(block)) throw new NotReadable();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (numeric.includes(key)) out[key] = num(value);
    else if (other.includes(key)) out[key] = value;
    else throw new NotReadable();
  }
  return out;
}

/** The folded declaration in what `readLifecycle` can emit, or `undefined`. */
function readbackShape(config: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (key === TDMOS_KEY) {
        if (typeof value !== 'string') throw new NotReadable();
        out[key] = value;
      } else if (key === 'Rules') {
        out[key] = (value as Array<Record<string, unknown>>).map(readbackRule);
      } else {
        throw new NotReadable();
      }
    }
    return out;
  } catch (err) {
    if (err instanceof NotReadable) return undefined;
    throw err;
  }
}

function readbackRule(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule)) {
    if (!RULE_KEYS.has(key)) throw new NotReadable();
    switch (key) {
      case 'ExpirationInDays':
        // A string here is sent as a DATE by the applier, not a day count.
        if (typeof value !== 'number') throw new NotReadable();
        out[key] = value;
        break;
      case 'ExpirationDate':
        if (typeof value !== 'string' || !ISO_DATE.test(value)) throw new NotReadable();
        out[key] = value;
        break;
      case 'ExpiredObjectDeleteMarker':
        if (typeof value !== 'boolean') throw new NotReadable();
        out[key] = value;
        break;
      case 'Transitions':
        if (!Array.isArray(value)) throw new NotReadable();
        out[key] = value.map((t: unknown) => {
          const item = numbers(t, ['TransitionInDays'], ['StorageClass', 'TransitionDate']);
          const date = item['TransitionDate'];
          if (date !== undefined && (typeof date !== 'string' || !ISO_DATE.test(date))) {
            throw new NotReadable();
          }
          return item;
        });
        break;
      case 'NoncurrentVersionExpiration':
        out[key] = numbers(value, ['NoncurrentDays', 'NewerNoncurrentVersions']);
        break;
      case 'NoncurrentVersionTransitions':
        if (!Array.isArray(value)) throw new NotReadable();
        out[key] = value.map((t: unknown) =>
          numbers(t, ['TransitionInDays', 'NewerNoncurrentVersions'], ['StorageClass'])
        );
        break;
      case 'AbortIncompleteMultipartUpload':
        out[key] = numbers(value, ['DaysAfterInitiation']);
        break;
      case 'Filter':
        out[key] = numbers(
          value,
          ['ObjectSizeGreaterThan', 'ObjectSizeLessThan'],
          ['Prefix', 'TagFilters']
        );
        break;
      default:
        out[key] = value;
    }
  }
  // S3 forbids the marker beside a day count or date; the applier sends the
  // expiration and drops the marker with a warning.
  if (
    out['ExpiredObjectDeleteMarker'] !== undefined &&
    (out['ExpirationInDays'] !== undefined || out['ExpirationDate'] !== undefined)
  ) {
    throw new NotReadable();
  }
  return out;
}

/** Whether a `readLifecycle` answer holds no configuration (`NoSuchLifecycleConfiguration`). */
export function lifecycleReadIsAbsent(read: Record<string, unknown>): boolean {
  const rules = read['Rules'];
  return !Array.isArray(rules) || rules.length === 0;
}

/**
 * Whether a `readLifecycle` answer is the declared configuration
 * (`expected`, from {@link declaredLifecycle}). The ONE comparator the
 * post-write capture settles on and the drift heal for pre-fix baselines
 * skips on, so the two cannot disagree.
 *
 * Exact on every key, in any key order, except two values S3 supplies that a
 * template need not declare (both measured, us-east-1, 2026-11-19):
 *
 * - a rule declared WITHOUT an `Id` reads back with an `Id` S3 generates, so
 *   it matches a read rule that HAS an `Id` and equals it on every other key;
 * - an undeclared `TransitionDefaultMinimumObjectSize` reads back as
 *   {@link LIFECYCLE_DEFAULT_TRANSITION_MIN_SIZE} (absent is accepted too).
 *
 * Rules compare by position: S3 kept the declared rule order and tag order.
 */
export function lifecycleMatchesDeclared(
  read: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  const declaredSize = expected[TDMOS_KEY];
  const readSize = read[TDMOS_KEY];
  if (declaredSize !== undefined) {
    if (readSize !== declaredSize) return false;
  } else if (readSize !== undefined && readSize !== LIFECYCLE_DEFAULT_TRANSITION_MIN_SIZE) {
    return false;
  }
  const readRules = read['Rules'];
  const declaredRules = expected['Rules'];
  if (!Array.isArray(readRules) || !Array.isArray(declaredRules)) return false;
  if (readRules.length !== declaredRules.length) return false;
  const restRead = withoutKeys(read, [TDMOS_KEY, 'Rules']);
  const restDeclared = withoutKeys(expected, [TDMOS_KEY, 'Rules']);
  if (!deepSameValue(restRead, restDeclared)) return false;
  return declaredRules.every((declaredRule: unknown, index) => {
    const readRule: unknown = readRules[index];
    if (!isPlainObject(declaredRule) || !isPlainObject(readRule)) return false;
    if (declaredRule['Id'] !== undefined) return deepSameValue(readRule, declaredRule);
    return (
      typeof readRule['Id'] === 'string' &&
      deepSameValue(withoutKeys(readRule, ['Id']), declaredRule)
    );
  });
}

/**
 * The declared configuration in the shape `readLifecycle` emits for it, kept
 * when the post-write capture never read it back: the folded rules plus the
 * `TransitionDefaultMinimumObjectSize` S3 reports for it. A rule declared
 * without an `Id` stays without one, since the `Id` S3 generates cannot be
 * known; the drift heal compares that key with {@link lifecycleMatchesDeclared}
 * instead, and `drift --revert` re-puts such a rule without an `Id`, for which
 * S3 generates a new one.
 */
export function declaredLifecycleBaseline(
  expected: Record<string, unknown>
): Record<string, unknown> {
  return {
    [TDMOS_KEY]: expected[TDMOS_KEY] ?? LIFECYCLE_DEFAULT_TRANSITION_MIN_SIZE,
    ...withoutKeys(expected, [TDMOS_KEY]),
  };
}

/**
 * The lifecycle member of the post-write baseline: `read` re-asked
 * ({@link reReadUntilSettled}) until it matches what was written. Returns the
 * value to record, or `undefined` to record no `LifecycleConfiguration` at
 * all (an absent top-level key is not compared by drift).
 *
 * - settled: the read, as AWS gave it;
 * - written present, never settled (absent, another configuration, a re-read
 *   that failed, or a first read that failed transiently —
 *   {@link memberReadFailure}): the written configuration
 *   ({@link declaredLifecycleBaseline});
 * - just deleted, still configured or a re-read that failed: nothing, never
 *   the configuration this deploy just deleted;
 * - a first read that failed deterministically (`AccessDenied`), or any first
 *   read failure after a delete: the error, as before this capture re-read,
 *   so the capture records no baseline and drift compares the template.
 *
 * `declared.onUnsettled` runs once on every arm that did not settle.
 */
export async function settleLifecycleRead(
  read: () => Promise<Record<string, unknown>>,
  declared: DeclaredLifecycle,
  delaysMs: readonly number[]
): Promise<Record<string, unknown> | undefined> {
  const settled = (answer: Record<string, unknown>): boolean =>
    declared.kind === 'absent'
      ? lifecycleReadIsAbsent(answer)
      : lifecycleMatchesDeclared(answer, declared.expected);
  const unsettled = (): Record<string, unknown> | undefined => {
    declared.onUnsettled?.();
    return declared.kind === 'present' ? declaredLifecycleBaseline(declared.expected) : undefined;
  };
  let answered = false;
  try {
    const outcome = await reReadUntilSettled(
      async () => {
        const answer = await read();
        answered = true;
        return answer;
      },
      settled,
      delaysMs
    );
    return outcome.settled ? outcome.answer : unsettled();
  } catch (err) {
    if (answered) return unsettled();
    if (declared.kind === 'present' && memberReadFailure(err) === 'failed') return unsettled();
    throw err;
  }
}

function withoutKeys(bag: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}
