import {
  hasReasonlessBaselineRefusal,
  hasUnverifiableParameterRefusal,
  type ResourceState,
} from '../../types/state.js';

/**
 * The remedy a template-less command names for a resource whose observed
 * baseline a `cdkd import` run refused (`observedBaselineRefused`), issue
 * [#3465](https://github.com/go-to-k/cdkd/issues/3465).
 *
 * "Deploy a change to this resource" is true only for an
 * `'incomplete-resolution'` refusal. An `'unverifiable-parameter'` one survives
 * every in-place UPDATE, and a REASON-LESS one (an older cdkd's) survives it
 * when the deploy-time template names a declared parameter at that resource —
 * which `cdkd state` and `cdkd drift` cannot tell, holding no template. So:
 *
 * - `'unverifiable-parameter'` → the sticky remedy;
 * - reason-less → the hedged one;
 * - anything else → `undefined`: the caller keeps its own "deploy a change"
 *   wording, which is right for that class.
 *
 * The text never echoes the recorded reason: the record is unvalidated input.
 */
export function refusedBaselineRemedy(
  record:
    | Pick<ResourceState, 'observedBaselineRefused' | 'observedBaselineRefusalReason'>
    | undefined
): string | undefined {
  if (hasUnverifiableParameterRefusal(record)) {
    return (
      'Deploying a change does NOT clear this refusal: the resource reads a template parameter ' +
      'whose deployed value cdkd could not prove, so only a deploy that replaces the resource, ' +
      'or a re-import while a CloudFormation stack can prove that value, restores a baseline.'
    );
  }
  if (hasReasonlessBaselineRefusal(record)) {
    return (
      'This refusal was recorded without a reason this cdkd recognizes: a deploy that actually ' +
      'CHANGES this resource restores a baseline unless the resource reads a template ' +
      'parameter, and then only a deploy that replaces the resource, or a re-import while a ' +
      "CloudFormation stack can prove the parameter's deployed value, does."
    );
  }
  return undefined;
}
