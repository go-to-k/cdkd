/**
 * The condition names `IntrinsicFunctionResolver.evaluateConditions` ASSUMED
 * rather than evaluated (issue
 * [#4077](https://github.com/go-to-k/cdkd/issues/4077)), keyed by the bag it
 * returned: a declared condition whose evaluation threw, an undeclared one a
 * `{Condition: X}` reference named, and every condition whose value was
 * computed while one of those was on its evaluation path. Each holds `false`
 * in the bag, which is a guess, so a caller that REFUSES on a condition's
 * value (the `AWS::NoValue` Output preflight) must not act on these.
 *
 * A side table rather than a field, because the bag's readers index it or
 * call `Object.keys`, and a marker key would read as a condition. An
 * import-free LEAF, so a test that mocks the resolver module does not take
 * the reader away from `output-value-preflight.ts`.
 */

const assumedConditionNames = new WeakMap<object, ReadonlySet<string>>();

/** Called once per `evaluateConditions` run, with the set it fills. */
export function recordAssumedConditions(
  conditions: Record<string, boolean>,
  assumed: ReadonlySet<string>
): void {
  assumedConditionNames.set(conditions, assumed);
}

/** The names in `conditions` that `evaluateConditions` assumed false (empty for any other bag). */
export function conditionsAssumedFalse(conditions: Record<string, boolean>): ReadonlySet<string> {
  return assumedConditionNames.get(conditions) ?? new Set<string>();
}
