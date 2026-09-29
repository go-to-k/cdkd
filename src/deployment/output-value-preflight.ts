/**
 * The Output-`Value` shape CloudFormation rejects before it creates anything
 * (issue [#4077](https://github.com/go-to-k/cdkd/issues/4077)).
 *
 * An Output whose `Value` selects `AWS::NoValue` — directly, or through the
 * taken branch of an `Fn::If` chain — fails `CreateStack` / `UpdateStack` with
 * `Template format error: The Value field of every Outputs member must
 * evaluate to a String.` (measured 2026-09-29, a condition-false `Fn::If`). No
 * resource is touched. cdkd used to provision the stack and then publish
 * nothing for the Output, with no warning and, under `--strict-getatt`, no
 * failure (the resolver answers the `AWS_NO_VALUE` symbol, not `undefined`).
 *
 * Decided from the evaluated `Conditions`, and only where the answer is
 * certain: an `Fn::If` on a condition cdkd could not evaluate is left alone,
 * matching `isOutputSuppressedByCondition`'s "unknown names are kept".
 */

import type { TemplateOutput } from '../types/resource.js';
import { displayIdent } from '../utils/display-safe.js';
import { isOutputSuppressedByCondition } from './outputs-export-alias.js';
import { markNonRetryable } from './retryable-errors.js';

/** Does `value` evaluate to `AWS::NoValue` under `conditions`? */
function selectsNoValue(value: unknown, conditions: Record<string, boolean>, depth = 0): boolean {
  // A bound, not a correctness condition: a real template nests a handful.
  if (depth > 64 || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const record = value as Record<string, unknown>;
  if (keys[0] === 'Ref') return record['Ref'] === 'AWS::NoValue';
  if (keys[0] !== 'Fn::If') return false;
  const args = record['Fn::If'];
  if (!Array.isArray(args) || args.length !== 3 || typeof args[0] !== 'string') return false;
  if (!Object.hasOwn(conditions, args[0])) return false;
  return selectsNoValue(conditions[args[0]] ? args[1] : args[2], conditions, depth + 1);
}

/**
 * Throw when a published Output's `Value` evaluates to `AWS::NoValue`, naming
 * every such Output. Call it before provisioning, with the conditions the
 * deploy acts on.
 */
export function refuseNoValueOutputs(
  outputs: Record<string, TemplateOutput> | undefined,
  conditions: Record<string, boolean>
): void {
  if (!outputs) return;
  const offending = Object.entries(outputs)
    .filter(([, output]) => !isOutputSuppressedByCondition(output, conditions))
    .filter(([, output]) => selectsNoValue(output.Value, conditions))
    .map(([name]) => displayIdent(name));
  if (offending.length === 0) return;
  // Marked: the verdict is the template plus its evaluated conditions, which a
  // retry cannot change, and the text carries template-controlled Output
  // names a substring classifier could read as transient (the #1874 hazard,
  // reachable through a nested child's parent).
  throw markNonRetryable(
    new Error(
      `Output ${offending.join(', ')} evaluates to AWS::NoValue, and CloudFormation rejects ` +
        `the template for it ("The Value field of every Outputs member must evaluate to a ` +
        `String") before creating anything. To publish an Output only sometimes, give it a ` +
        `Condition instead of selecting AWS::NoValue in its Value.`
    )
  );
}
