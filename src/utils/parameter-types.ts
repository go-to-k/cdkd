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
