/**
 * ONE definition of "is this CloudFormation Parameter `Type` LIST-shaped?".
 *
 * cdkd used to hold TWO independent answers to this question (issue
 * [#2347](https://github.com/go-to-k/cdkd/issues/2347)):
 *
 * - `coerceParameterTypedValue` in `src/deployment/intrinsic-function-resolver.ts`
 *   named exactly two list types (`List<Number>`, `CommaDelimitedList`) in a
 *   `switch`, so every other `List<...>` spelling fell to `default` and a
 *   `Ref` to it resolved to the raw comma-joined STRING;
 * - `stringifyParamDefault` in `src/synthesis/macro-expander.ts` tested
 *   `inner.startsWith('List<') || inner === 'CommaDelimitedList'` when choosing
 *   the placeholder shape for an `AWS::SSM::Parameter::Value<...>` parameter,
 *   i.e. the WIDER, correct view.
 *
 * The two disagreeing is what let a `List<AWS::EC2::Subnet::Id>` child
 * parameter be handed to a nested stack as a string. They now share this
 * predicate, so a third spelling cannot appear without deleting this file.
 *
 * This lives in `src/utils/` rather than beside either consumer because it has
 * TWO, in different layers -- `src/deployment/intrinsic-function-resolver.ts`
 * and `src/synthesis/macro-expander.ts`. Hosting it in `src/deployment/` gave
 * the tree its FIRST `src/synthesis/**` -> `src/deployment/**` import, which
 * inverts the documented layer order (synthesis runs before deployment); every
 * other synthesis import goes to `../types`, `../utils` or `../cli`.
 * `src/utils/ip-protocol.ts` is the precedent, hosted here for the same reason
 * and stating it in the same place. `src/types/` was the other candidate and is
 * wrong for this: it carries type declarations plus the constants and helpers
 * that read them, not a standalone runtime predicate with no type of its own.
 *
 * ## What CloudFormation actually defines
 *
 * Measured 2026-08-28 against the AWS-published enumerations, NOT against a
 * library:
 *
 * - `parameters-section-structure.html` lists the base types as `String`,
 *   `Number`, `List<Number>`, `CommaDelimitedList`, plus "AWS-specific
 *   parameter types" and "Systems Manager parameter types". **A bare
 *   `List<String>` is NOT in that enumeration.**
 * - `cloudformation-supplied-parameter-types.html` enumerates ten AWS-specific
 *   SCALAR types and nine `List<AWS::...>` types (`List<AWS::EC2::Subnet::Id>`,
 *   `List<AWS::EC2::SecurityGroup::Id>`, ...). `List<String>` appears only as
 *   the INNER shape of the Systems Manager form
 *   `AWS::SSM::Parameter::Value<List<String>>`.
 *
 * `List<String>` is nevertheless accepted here, because `aws-cdk-lib`'s own
 * `CfnParameter` accepts it (`isListType` in
 * `node_modules/aws-cdk-lib/core/lib/cfn-parameter.js` is a substring test) and
 * `valueAsList()` on such a parameter synthesizes a template cdkd will deploy
 * WITHOUT CloudFormation ever seeing it. Treating it as a list is the reading
 * that agrees with the app that produced it; the alternative silently hands a
 * string to something the CDK typed as a string list.
 *
 * ## Why this is `startsWith`, not `aws-cdk-lib`'s `indexOf`
 *
 * `indexOf('List<') >= 0` also matches `MyList<String>` and, load-bearing here,
 * the Systems Manager OUTER form `AWS::SSM::Parameter::Value<List<String>>`.
 * That outer form must NOT be list-shaped for the coercion: the VALUE supplied
 * for an SSM-typed parameter is a Parameter Store KEY, not the resolved list,
 * so splitting it on `,` would shred a key rather than build a list. The
 * macro-expander asks this question of the INNER shape it has already peeled
 * out of `Value<...>`, so the same predicate serves both sites unchanged.
 *
 * A closing `>` is required, so `List<`, `List<>` and `List<String` are NOT
 * list-shaped. That is the whole of the claim: this predicate is a test of the
 * SPELLING, not a validator. Measured, `List< >`, `List<a>`, `List<<>>` and
 * `List<X>>` all return `true` -- nothing here rejects a nonsense inner type,
 * and cdkd deploys without CloudFormation ever seeing the template, so no
 * service-side validation stands behind it either.
 */
export function isListParameterType(type: string): boolean {
  if (type === 'CommaDelimitedList') return true;
  // `List<>` (length 6) carries no inner type and is not a spelling of
  // anything; require at least one character between the brackets.
  return type.length > 'List<>'.length && type.startsWith('List<') && type.endsWith('>');
}

/**
 * The literal prefix of the Systems Manager parameter form. Declared ABOVE the
 * docblock below so that docblock attaches to {@link ssmResolvedValueType}
 * rather than to this constant.
 */
export const SSM_PARAMETER_VALUE_PREFIX = 'AWS::SSM::Parameter::Value<';

/**
 * ONE definition of "peel the inner shape out of
 * `AWS::SSM::Parameter::Value<...>`", returning `undefined` when `type` is not
 * that form.
 *
 * It lives beside {@link isListParameterType} for the reason that predicate
 * exists at all: this file was created by issue
 * [#2347](https://github.com/go-to-k/cdkd/issues/2347) after cdkd was found
 * holding TWO answers to one type question in these same two modules, and
 * issue [#2367](https://github.com/go-to-k/cdkd/issues/2367) then wrote a
 * SECOND peel in `src/deployment/intrinsic-function-resolver.ts` next to the
 * one already in `src/synthesis/macro-expander.ts` -- reproducing the exact
 * shape #2347 had just deleted, one question with two spellings in one file
 * pair. Both now call this.
 *
 * ## The two callers, and the one deliberate difference between them
 *
 * The peel is shared; the handling of a MALFORMED spelling is not, and that is
 * a call-site policy rather than a second answer:
 *
 *  - `resolveParameters` (deployment) treats `undefined` as "do not coerce" and
 *    keeps the resolved string verbatim -- the safe direction on a path that
 *    writes state.
 *  - `stringifyParamDefault` (synthesis) keeps its own pre-existing behaviour
 *    of emitting the SCALAR placeholder for anything carrying the prefix,
 *    including a malformed one, rather than falling through to its generic
 *    warn + `PARAMETER_PLACEHOLDER`. Routing a malformed spelling to that
 *    fallback would change the emitted placeholder text (`placeholder` ->
 *    `cdkd-macro-expand-placeholder`) and add a warn line, which is a
 *    behaviour change unrelated to #2367.
 *
 * The STRICTNESS here is the stricter of the two originals: a closing `>` is
 * required and the inner shape must be non-empty, so `Value<` and `Value<>`
 * peel to `undefined`. The synthesis site never required either, but it also
 * never distinguished the cases -- `''` is not list-shaped, so it took the
 * scalar arm, which is what its `undefined` branch now does explicitly.
 *
 * ## WHAT THE SUPPLIED VALUE IS -- AN OPEN DISAGREEMENT INSIDE THIS REPO
 *
 * This function answers only "what shape does `Value<...>` WRAP". It
 * deliberately does NOT settle what the value SUPPLIED for such a parameter
 * means, because cdkd currently holds two incompatible readings and this
 * function's callers do not need the answer:
 *
 *  - **Read from the AWS documentation** (`cloudformation-supplied-parameter-types.html`,
 *    2026-08-29): the supplied value is ONE Parameter Store key, phrased in the
 *    singular throughout ("you must specify a Parameter Store key", "you must
 *    provide the parameter name"), with `Value<List<String>>` /
 *    `Value<CommaDelimitedList>` described as "a Systems Manager parameter
 *    whose value is a list of strings". `aws-cdk-lib`'s own
 *    `StringListParameter.fromListParameterAttributes` agrees: it emits
 *    `{type: 'AWS::SSM::Parameter::Value<List<String>>', default:
 *    attrs.parameterName}` -- a single name.
 *  - **A LIVE CloudFormation OBSERVATION** recorded at
 *    `src/synthesis/macro-expander.ts` (the CR-MJ3 fix): a single-string
 *    placeholder against a `Value<List<*>>` type "would reject the changeset
 *    with `Parameter ... must be a list`", which is why that site emits a
 *    2-element comma-joined placeholder. Someone watched CloudFormation do
 *    that, and a live observation outranks a documentation read.
 *
 * THESE MAY BOTH BE TRUE OF DIFFERENT THINGS -- CloudFormation's pre-macro
 * changeset VALIDATOR may demand a list-shaped literal while the runtime
 * resolves one key -- and that reconciliation is plausible but UNMEASURED. It
 * is recorded as unresolved rather than decided, and neither caller depends on
 * it: the synthesis site is choosing a placeholder for a validator, and the
 * deployment site is coercing a value `GetParameter` ALREADY returned, which is
 * downstream of whatever the supplied key meant.
 */
export function ssmResolvedValueType(type: string): string | undefined {
  if (!type.startsWith(SSM_PARAMETER_VALUE_PREFIX) || !type.endsWith('>')) return undefined;
  const inner = type.slice(SSM_PARAMETER_VALUE_PREFIX.length, -1);
  return inner.length > 0 ? inner : undefined;
}
