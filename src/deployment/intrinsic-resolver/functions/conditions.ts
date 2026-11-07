import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import { displayMasked, logRender, maskValueLeaves } from '../masking-display.js';
import { resolveDynamicReferencesWithLogTwin } from '../dynamic-refs.js';
import { recordLeafResolution } from '../masking.js';
import { markNonRetryable } from '../../retryable-errors.js';
import { type ResolverContext } from '../support.js';
import { recordTakenIfBranchIn } from '../parameter-secrets.js';
import { recordIntrinsicLeafResolutionAs } from '../../secret-redaction.js';

/**
 * Resolve Fn::If intrinsic function
 *
 * Fn::If: [conditionName, valueIfTrue, valueIfFalse]
 * Returns valueIfTrue if condition evaluates to true, otherwise valueIfFalse
 */
export async function resolveIf(
  resolver: IntrinsicFunctionResolver,
  ifArgs: [string, unknown, unknown],
  context: ResolverContext,
  source: object
): Promise<unknown> {
  const [conditionName, valueIfTrue, valueIfFalse] = ifArgs;
  // The `Fn::If` object answers for the branch it selected (issue #3306):
  // the nested-stack carry reads the record of the object the template
  // spells, and that is this one, not the branch. A STRING branch is
  // resolved by the dynamic-reference pass `resolveValue`'s string arm runs
  // on a reference-bearing string (on any other it returns the string, which
  // is what the pass returns there too), here so its replacements can be
  // recorded; an object branch lends its own record, when the pass kept one.
  const resolveBranch = async (branch: unknown): Promise<unknown> => {
    if (typeof branch === 'string') {
      const pass = await resolveDynamicReferencesWithLogTwin(resolver, branch, branch, context);
      recordLeafResolution(resolver, context, source, {
        input: branch,
        output: pass.result,
        substitutions: pass.substitutions,
        complete: pass.complete,
      });
      return pass.result;
    }
    const resolved = await resolver.resolveValue(branch, context);
    if (context.recordedSecretValues !== undefined) {
      recordIntrinsicLeafResolutionAs(context.recordedSecretValues, source, branch);
    }
    return resolved;
  };

  // Check if condition is evaluated in context. `Object.hasOwn` (issue
  // #2767): `conditionName` is template-controlled, so a bare `in` answered
  // for an `Object.prototype` member -- `Fn::If: ["constructor", A, B]`
  // skipped this warn, read the `Object` FUNCTION as the condition value, and
  // selected the TRUE branch, where the not-found path assumes false.
  if (!context.conditions || !Object.hasOwn(context.conditions, conditionName)) {
    // A DEFAULT-VERBOSITY warn naming a template-supplied condition name --
    // `Fn::If`'s first element, arbitrary JSON (go-to-k/cdkd#3435 review
    // round 2, found by driving the route rather than by reading).
    // `String(...)` FIRST. `resolveIf`'s arguments arrive through an
    // unchecked cast, so element 0 can be a number or an object; the old bare
    // interpolation coerced it, and `displayMasked` -> `stripControlChars`
    // calls `.replace` and would throw a TypeError instead -- turning a
    // warn-and-assume-false into a failed resource (go-to-k/cdkd#3435 review
    // round 3, measured). Coercing keeps the pre-existing behaviour and
    // sanitizes what it produces.
    resolver.logger.warn(
      `Condition ${displayMasked(resolver, String(conditionName), context)} not found in context, assuming false`
    );
    recordTakenIfBranchIn(context, source, false);
    return await resolveBranch(valueIfFalse);
  }

  const conditionValue = context.conditions[conditionName];
  const selectedValue = conditionValue ? valueIfTrue : valueIfFalse;

  // `conditionValue` carries nothing: a boolean, or a list of booleans.
  resolver.logger.debug(
    `Resolved Fn::If: condition ${logRender(resolver, String(conditionName), context)} = ${conditionValue}, selected ${conditionValue ? 'true' : 'false'} branch`
  );

  // Issue #4954: the branch taken, for the persist walk of a leaf whose
  // resolved value cannot name it (the diff side evaluates `conditions` too).
  recordTakenIfBranchIn(context, source, Boolean(conditionValue));
  return await resolveBranch(selectedValue);
}

/**
 * Resolve Fn::Equals intrinsic function
 *
 * Fn::Equals: [value1, value2]
 * Returns true if both values are equal after resolution
 */
export async function resolveEquals(
  resolver: IntrinsicFunctionResolver,
  equalsArgs: [unknown, unknown],
  context: ResolverContext
): Promise<boolean> {
  const [value1, value2] = equalsArgs;

  // Resolve both values
  const resolved1 = await resolver.resolveValue(value1, context);
  const resolved2 = await resolver.resolveValue(value2, context);

  // Deep equality check
  const result = JSON.stringify(resolved1) === JSON.stringify(resolved2);

  // Masked like every other operand-rendering site (`Fn::Select` / `Fn::Split`
  // / `Fn::Join` / `Fn::Sub`). An operand can be a resolved cross-stack value:
  // `cdkd scrub` gained a `stateBackend` on its CONDITION context in issue
  // #2133, so `{"Fn::Equals": [{"Fn::ImportValue": "..."}, "x"]}` now resolves
  // the producer's export -- and `reresolveCrossStackValue` hands back the
  // PLAINTEXT -- inside the command whose whole purpose is removing it.
  // not-in-class(result): a CONDITION verdict -- a boolean, or a list of booleans.
  resolver.logger.debug(
    // Leaf-masked before the encoding — see `resolveSelect`'s twin comment
    // (issue [#2759](https://github.com/go-to-k/cdkd/issues/2759)).
    `Resolved Fn::Equals: ${logRender(resolver, JSON.stringify(maskValueLeaves(resolver, resolved1, context)), context, { structured: true })} === ${logRender(resolver, JSON.stringify(maskValueLeaves(resolver, resolved2, context)), context, { structured: true })} resolved to ${result}`
  );

  return result;
}

/**
 * Resolve a `{Condition: <name>}` named-condition reference (issue #840).
 *
 * Inside `Fn::And` / `Fn::Or` / `Fn::Not` a CFn Condition may reference
 * another named condition. When the resolver is mid-`evaluateConditions`
 * the `conditionResolver` hook is present and lazily evaluates the
 * referenced condition (recursing + memoizing + cycle-guarding) so the
 * result is order-independent. Outside that context (which is invalid CFn
 * but handled defensively) we fall back to the already-evaluated
 * `conditions` map, matching `Fn::If`'s warn-and-assume-false behavior.
 */
export async function resolveConditionReference(
  resolver: IntrinsicFunctionResolver,
  conditionName: string,
  context: ResolverContext
): Promise<boolean> {
  if (context.conditionResolver) {
    return await context.conditionResolver(conditionName);
  }

  // `Object.hasOwn` for the same reason as `resolveIf`'s test (issue #2767) —
  // but DEFENSIVE, and known to be so: the only call site gates on
  // `context.conditionResolver` being present, and the branch above returns
  // for exactly that case, so nothing reaches this line today. It is left
  // correct rather than pinned, since a test for it would have to construct a
  // context the resolver never builds. Were it reachable, the bare `in` would
  // hand `Fn::And` / `Fn::Or` / `Fn::Not` the `Object` FUNCTION behind the
  // `boolean` assertion below, which hides the mismatch rather than reporting
  // it.
  if (context.conditions && Object.hasOwn(context.conditions, conditionName)) {
    return context.conditions[conditionName]!;
  }

  // The sibling of the `Fn::If` warn above, on the CONDITION-REFERENCE path,
  // and default-verbosity for the same reason.
  resolver.logger.warn(
    `Condition ${displayMasked(resolver, conditionName, context)} not found in context, assuming false`
  );
  return false;
}

/**
 * Resolve Fn::And intrinsic function
 *
 * Returns true if all conditions evaluate to true
 * Syntax: { "Fn::And": [ condition1, condition2, ... ] }
 */
export async function resolveAnd(
  resolver: IntrinsicFunctionResolver,
  conditions: unknown[],
  context: ResolverContext
): Promise<boolean> {
  if (!Array.isArray(conditions) || conditions.length < 2 || conditions.length > 10) {
    throw markNonRetryable(
      new Error(`Fn::And requires between 2 and 10 conditions, got ${conditions.length}`)
    );
  }

  // Resolve all conditions
  const results: boolean[] = [];
  for (const condition of conditions) {
    const resolved = await resolver.resolveValue(condition, context);
    results.push(Boolean(resolved));
  }

  // Return true if all are true
  const result = results.every((r) => r === true);

  // not-in-class(results.join(', ')): a CONDITION verdict -- a boolean, or a list of booleans.
  // not-in-class(result): a CONDITION verdict -- a boolean, or a list of booleans.
  resolver.logger.debug(`Resolved Fn::And: [${results.join(', ')}] resolved to ${result}`);

  return result;
}

/**
 * Resolve Fn::Or intrinsic function
 *
 * Returns true if at least one condition evaluates to true
 * Syntax: { "Fn::Or": [ condition1, condition2, ... ] }
 */
export async function resolveOr(
  resolver: IntrinsicFunctionResolver,
  conditions: unknown[],
  context: ResolverContext
): Promise<boolean> {
  if (!Array.isArray(conditions) || conditions.length < 2 || conditions.length > 10) {
    throw markNonRetryable(
      new Error(`Fn::Or requires between 2 and 10 conditions, got ${conditions.length}`)
    );
  }

  // Resolve all conditions
  const results: boolean[] = [];
  for (const condition of conditions) {
    const resolved = await resolver.resolveValue(condition, context);
    results.push(Boolean(resolved));
  }

  // Return true if at least one is true
  const result = results.some((r) => r === true);

  // not-in-class(results.join(', ')): a CONDITION verdict -- a boolean, or a list of booleans.
  // not-in-class(result): a CONDITION verdict -- a boolean, or a list of booleans.
  resolver.logger.debug(`Resolved Fn::Or: [${results.join(', ')}] resolved to ${result}`);

  return result;
}

/**
 * Resolve Fn::Not intrinsic function
 *
 * Returns the inverse of the condition
 * Syntax: { "Fn::Not": [ condition ] }
 */
export async function resolveNot(
  resolver: IntrinsicFunctionResolver,
  notArgs: [unknown],
  context: ResolverContext
): Promise<boolean> {
  if (!Array.isArray(notArgs) || notArgs.length !== 1) {
    throw markNonRetryable(
      new Error(
        `Fn::Not requires exactly one condition, got ${Array.isArray(notArgs) ? notArgs.length : 0}`
      )
    );
  }

  const [condition] = notArgs;

  // Resolve the condition
  const resolved = await resolver.resolveValue(condition, context);
  const result = !resolved;

  // not-in-class(Boolean(resolved)): a CONDITION verdict -- a boolean, or a list of booleans.
  // not-in-class(result): a CONDITION verdict -- a boolean, or a list of booleans.
  resolver.logger.debug(`Resolved Fn::Not: ${Boolean(resolved)} resolved to ${result}`);

  return result;
}
