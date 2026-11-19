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
 * So on that capture only, an answer that differs from the declaration is
 * re-read on {@link LIFECYCLE_BASELINE_REREAD_DELAYS_MS}. A declared
 * configuration the schedule never sees is KEPT in the readback's shape; a
 * just-deleted one still visible records nothing for the key. Every other
 * read takes the first answer.
 */
import {
  isAmbiguousOutcomeError,
  isThrottlingError,
  isTransientServerError,
} from '../../../deployment/retryable-errors.js';
import {
  deepSameValue,
  effectiveLifecycleConfiguration,
  lifecycleRuleRefused,
} from './lifecycle-fold.js';
import { isPlainObject } from './shared.js';

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

/**
 * What the template declares for the lifecycle, folded onto the readback's
 * shape: `absent` (no rules: nothing configured, or a just-deleted
 * configuration), `present` with the folded configuration, or `undefined`
 * when the declaration is one the applier would not send as declared (a
 * non-object rule, a refused rule): AWS then keeps the previous
 * configuration, so the first answer is the truth and nothing is re-read.
 */
export type DeclaredLifecycle =
  | { kind: 'absent' }
  | { kind: 'present'; expected: Record<string, unknown> };

export function declaredLifecycle(properties: unknown): DeclaredLifecycle | undefined {
  if (!isPlainObject(properties)) return undefined;
  const config = properties['LifecycleConfiguration'];
  if (config == null) return { kind: 'absent' };
  if (!isPlainObject(config)) return undefined;
  const rules = config['Rules'];
  if (rules == null || (Array.isArray(rules) && rules.length === 0)) return { kind: 'absent' };
  if (!Array.isArray(rules) || !rules.every(isPlainObject)) return undefined;
  if (rules.some(lifecycleRuleRefused)) return undefined;
  return {
    kind: 'present',
    expected: effectiveLifecycleConfiguration(config) as Record<string, unknown>,
  };
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
 * A lifecycle read failure worth keeping the declared configuration over: a
 * throttle, a 5xx, or a socket failure the SDK's retries did not absorb. A
 * deterministic one (`AccessDenied`) is not: keeping the declared value there
 * would freeze a member every later read drops.
 */
export function isTransientLifecycleReadFailure(err: unknown): boolean {
  return isThrottlingError(err) || isTransientServerError(err) || isAmbiguousOutcomeError(err);
}

/**
 * The lifecycle member of the post-write baseline: `read` re-asked until it
 * matches `declared`. Returns the value to record, or `undefined` to
 * record no `LifecycleConfiguration` at all (an absent top-level key is not
 * compared by drift).
 *
 * - settled: the read, as AWS gave it;
 * - declared present, never settled (absent, another configuration, or a read
 *   that failed transiently or after an unsettled answer): the declared
 *   configuration ({@link declaredLifecycleBaseline});
 * - declared present, a deterministic failure on the first read: nothing;
 * - declared absent, still configured, or a re-read that failed: nothing,
 *   never the configuration this deploy just deleted;
 * - declared absent, the FIRST read failed: the error, as before.
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
  let answered = false;
  try {
    let answer = await read();
    answered = true;
    for (const delayMs of delaysMs) {
      if (settled(answer)) return answer;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      answer = await read();
    }
    if (settled(answer)) return answer;
    return declared.kind === 'present' ? declaredLifecycleBaseline(declared.expected) : undefined;
  } catch (err) {
    if (declared.kind === 'absent') {
      if (answered) return undefined;
      throw err;
    }
    return answered || isTransientLifecycleReadFailure(err)
      ? declaredLifecycleBaseline(declared.expected)
      : undefined;
  }
}

function withoutKeys(bag: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}
