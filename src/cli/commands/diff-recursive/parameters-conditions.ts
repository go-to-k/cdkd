import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { displayIdent, displayStackName, safeMsg } from '../../../utils/display-safe.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { StackState } from '../../../types/state.js';
import { TemplateParser } from '../../../analyzer/template-parser.js';
import {
  IntrinsicFunctionResolver,
  carriesDynamicReference,
  parameterTypeMayLoseSecretIdentity,
  coerceParameterTypedValue,
} from '../../../deployment/intrinsic-function-resolver.js';
import {
  DYNAMIC_REFERENCE_TOKEN_SCAN,
  isSingleDynamicReferenceToken,
  printingCorpusOf,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { StaleAttributeHealer } from '../../../deployment/stale-attribute-heal.js';
import {
  conditionFingerprint,
  conditionInputsFrom,
  parentSuppliedValues,
  readRecordedConditionVerdicts,
} from '../../../deployment/condition-verdicts.js';
import { logger } from './logger.js';
import { STABLE_PSEUDO_PARAMETERS } from './trust.js';

/** Every `Ref` target reachable from a value, collected in one walk. */
export function collectRefTargets(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value) collectRefTargets(element, refs);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (typeof obj['Ref'] === 'string') refs.add(obj['Ref']);
  for (const nested of Object.values(obj)) collectRefTargets(nested, refs);
}

/** Every `{Condition: X}` target reachable from a condition definition. */
function collectConditionTargets(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value) collectConditionTargets(element, names);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (typeof obj['Condition'] === 'string') names.add(obj['Condition']);
  for (const nested of Object.values(obj)) collectConditionTargets(nested, names);
}

/**
 * The conditions whose verdict this diff cannot know (go-to-k/cdkd#4470): each
 * one that reaches a parameter in `unknownParameterNames` — one binding failed
 * for, or one fed a redacted `{{resolve:...}}` token (issue #1903) — directly
 * or through a chain of `{Condition: X}` references.
 *
 * PER CONDITION, never per template. The skip this replaces left the WHOLE
 * `Conditions` section unevaluated as soon as ANY condition depended on such a
 * parameter, or binding failed at all, so every `Fn::If` in the stack took its
 * FALSE branch — including one on a condition that reads no parameter — and
 * diffed as a perpetual spurious UPDATE. Only the dependency closure is
 * unknowable; every other condition gets the verdict the deploy computes.
 *
 * The TRANSITIVE walk is load-bearing here, unlike in the per-template scan it
 * replaces: a chained condition that is not itself unknown would be EVALUATED,
 * and the evaluator answers a `{Condition: X}` to a condition missing from the
 * map it is handed with FALSE — a verdict that prunes. Operands are read two
 * ways: every `Ref` anywhere in the definition, and `TemplateParser`'s
 * reference walk for the `${Name}` placeholders of an `Fn::Sub`. Reading more
 * names than the evaluator would only marks more conditions unknown, which is
 * the safe direction: unknown never prunes.
 *
 * A reference cycle is a template CloudFormation refuses and the evaluator
 * downgrades to FALSE; the fixpoint terminates on one and answers it the same
 * whatever the declaration order.
 */
function unknownConditionNames(
  template: CloudFormationTemplate,
  unknownParameterNames: ReadonlySet<string>
): Set<string> {
  const unknown = new Set<string>();
  const definitions = template.Conditions;
  if (!definitions || typeof definitions !== 'object') return unknown;
  if (unknownParameterNames.size === 0) return unknown;

  // A FIXPOINT, not a memoized depth-first walk: a memo filled while a
  // reference cycle is still being visited records `false` for a member whose
  // dependency is only found after the back-edge, which made the answer
  // depend on declaration order.
  const parser = new TemplateParser();
  const conditionRefsOf = new Map<string, Set<string>>();
  for (const [name, definition] of Object.entries(definitions as Record<string, unknown>)) {
    const parameterRefs = new Set<string>();
    collectRefTargets(definition, parameterRefs);
    for (const ref of parser.extractReferences(definition)) parameterRefs.add(ref);
    if ([...parameterRefs].some((ref) => unknownParameterNames.has(ref))) unknown.add(name);
    const conditionRefs = new Set<string>();
    collectConditionTargets(definition, conditionRefs);
    conditionRefsOf.set(name, conditionRefs);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, conditionRefs] of conditionRefsOf) {
      if (unknown.has(name)) continue;
      if ([...conditionRefs].some((ref) => unknown.has(ref))) {
        unknown.add(name);
        grew = true;
      }
    }
  }
  return unknown;
}

/**
 * The value a TOKEN-valued child parameter must be COMPARED as, given its
 * declared `Type` (issue [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * `resolveChildStackParameters` sets `skipDynamicReferences`, so a
 * secret-bearing nested input reaches this diff as its unresolved
 * `{{resolve:...}}` expression rather than as the value the deploy will bind.
 * The comparison therefore has to reproduce the SHAPE the child's state holds
 * for that parameter, and the shape depends on the declared type:
 *
 * - `String`, and the AWS-specific SCALAR types — state holds the expression
 *   STRING. Keep the token.
 * - The LIST-SHAPED types — whatever `isListParameterType` accepts, i.e. any
 *   `List<...>` type or `CommaDelimitedList` (`List<AWS::EC2::Subnet::Id>`,
 *   `List<String>`, … are examples, NOT the population) — the deploy's own
 *   `coerceParameterValue` split the RESOLVED value on `,` before redaction,
 *   so state holds an ARRAY of expressions. Splitting the TOKEN the same way
 *   reproduces it, because the reference this fixture-shaped case is about
 *   carries no comma.
 * - `Number` / `List<Number>` — coercion produces `NaN`, which matches neither
 *   side. Keep the token. (A deploy that actually bound a secret to one of
 *   these is refused by `refuseCoercedInheritedSecret`, so there is no state to
 *   agree with anyway.)
 *
 * THE LINE IS NOT A TYPE NAME, IT IS WHETHER EVERY PART SURVIVED AS A STRING.
 * That is the only property this comparison needs, and it is why the code below
 * asks the coerced VALUE rather than the declared type. `List<Number>` is the
 * single list-shaped type that fails it, because its elements are numbers; every
 * other list-shaped type yields trimmed strings and is therefore split here.
 *
 * An earlier revision of this comment said `CommaDelimitedList` was the ONLY
 * splitting type that keeps its parts strings, and singled `List<String>` out as
 * reading like it belonged beside it while coming back as an unchanged STRING.
 * That was a true reading of `coerceParameterTypedValue` at the time -- its
 * `switch` named only `Number`, `List<Number>` and `CommaDelimitedList`, so every
 * other `List<...>` spelling fell to `default` -- and it was ALSO the bug, filed
 * as issue [#2347](https://github.com/go-to-k/cdkd/issues/2347) and since fixed:
 * the coercion now asks the shared `isListParameterType`
 * (`src/utils/parameter-types.ts`), so the whole `List<...>` family splits.
 * The note survives because the shape of the mistake is worth keeping: the claim
 * was measured against the coercion and was accurate about it, and the coercion
 * was the thing that was wrong. Measuring the right function does not make the
 * function right.
 *
 * This function needed no change for that fix, which is the point of deriving
 * rather than enumerating: it never named the splitting types, so widening them
 * moved it automatically.
 *
 * WHAT "carries no comma" DOES AND DOES NOT COVER. It is verified for the slots
 * that vary in practice -- secret id / parameter name and version stage -- and
 * NOT for the JSON-KEY slot, which may contain one:
 * `{{resolve:secretsmanager:sec:SecretString:a,b::}}` splits into TWO elements
 * (measured). The consequence is bounded to THIS function: a `cdkd diff
 * --recursive` over such a parameter reports a phantom change, because the
 * desired side has two elements where state has one. No write path is reached
 * -- the persist side never consults this -- and no plaintext is exposed. It is
 * not closed here because the fix belongs with a comma-aware split of the
 * expression grammar rather than with a comparison shim.
 *
 * MEASURED FROM THE REAL COERCION, never enumerated beside it — the same
 * discipline {@link parameterTypeMayLoseSecretIdentity} adopted after a
 * hand-kept type list was found wrong about one of its own three entries. The
 * test is what the coercion PRODUCED: an unchanged value, a non-array, or an
 * array carrying a non-string all keep the token, so a `Type` added to
 * `coerceParameterTypedValue` is covered the day it is added.
 */
function tokenValueForComparison(token: unknown, declaredType: string | undefined): unknown {
  if (typeof token !== 'string' || declaredType === undefined) return token;
  const coerced = coerceParameterTypedValue(token, declaredType);
  // `String` and every unrecognised type: the coercion is the identity.
  if (coerced === token) return token;
  // `Number`: a scalar that is no longer the token.
  if (!Array.isArray(coerced)) return token;
  // `List<Number>`: an array whose elements are no longer the token's text.
  if (!coerced.every((element) => typeof element === 'string')) return token;
  return coerced;
}

/**
 * Steps 1 and 2 of {@link computeStackDiff}: bind the template `Parameters`
 * and evaluate its `Conditions`, pruning condition-false resources.
 */
export async function bindParametersAndConditions({
  template,
  parameters,
  stackName,
  stateBackend,
  currentState,
  intrinsicResolver,
  inheritedForResolver,
  inheritedSecrets,
  parentUnresolvedParameters,
  attributeHealer,
}: {
  template: CloudFormationTemplate;
  parameters: Record<string, unknown> | undefined;
  stackName: string;
  stateBackend: S3StateBackend;
  currentState: StackState;
  intrinsicResolver: IntrinsicFunctionResolver;
  inheritedForResolver: RecordedSecretValues | undefined;
  inheritedSecrets: RecordedSecretValues | undefined;
  parentUnresolvedParameters: ReadonlySet<string> | undefined;
  attributeHealer: StaleAttributeHealer | undefined;
}) {
  // Mirror the deploy engine's parameter/condition preprocessing (steps
  // 2.5-2.7, issue #1027) so the diff matches what deploy will actually do.
  // Everything here is best-effort, and PER PARAMETER / PER CONDITION
  // (go-to-k/cdkd#4470): a parameter that cannot be bound (e.g. a required one
  // with no default) stays out of the bound set — its `Ref`s keep the raw
  // intrinsic, which the calculator compares as-is — and only the conditions
  // that depend on it go unevaluated.
  //
  // 1) Bind template `Parameters` (defaults + SSM-typed lookups). The
  //    nested-stack input parameters (see the resolver-context comment
  //    below) act as the user-provided values, exactly like
  //    `DeployEngineOptions.parameters` does on deploy.
  let mergedParameters: Record<string, unknown> | undefined = parameters;
  // The declared parameters binding FAILED for. `resolveParameters` throws on
  // the first one (a required parameter with no value, a failed SSM lookup), so
  // it is asked one parameter at a time: one unbindable parameter used to leave
  // EVERY parameter unbound and every condition unevaluated.
  const unboundParameterNames = new Set<string>();
  // The names whose incoming value is a REDACTED `{{resolve:...}}` token rather
  // than the value the deploy will actually bind (issue #1903).
  // `resolveChildStackParameters` sets `skipDynamicReferences`, so a
  // secret-bearing nested input arrives here as its expression — which is right
  // for the COMPARISON (the child's state holds the expression too) and wrong
  // for anything that has to reason about the VALUE. Two such things live
  // below, and both are handled by knowing this set rather than by decrypting:
  //
  //  - `resolveParameters` COERCES by declared `Type`, so a `Type: Number`
  //    parameter fed a token becomes `NaN`, which then diffs against the real
  //    number in state on every run.
  //  - `evaluateConditions` compares it, so an `Fn::Equals` over a
  //    secret-valued parameter answers differently here than on deploy — where
  //    the deploy engine deliberately hands the CONDITION context the real
  //    values — and condition-gated child resources appear as phantom CREATEs
  //    or DELETEs.
  const tokenParameterNames = new Set(
    Object.entries(parameters ?? {})
      .filter(([, value]) => carriesDynamicReference(value))
      .map(([name]) => name)
  );
  // The deploy path REFUSES a token-valued child parameter whose declared
  // `Type` loses the plaintext under coercion -- asked of the coercion itself
  // via `parameterTypeMayLoseSecretIdentity`, never re-enumerated here. The
  // enumeration this replaced named `Number` / `List<Number>` and so stayed
  // silent on `CommaDelimitedList`, whose `,`-split shreds the dominant
  // Secrets Manager shape (a JSON blob) -- because coercing it drops the value
  // out of cdkd's string-keyed redaction model and the child's state.json would
  // keep the DECRYPTED secret (`refuseCoercedInheritedSecret`). `cdkd diff` is
  // best-effort by contract and must not hard-fail, so it says so instead —
  // otherwise the first the user hears of it is a failed deploy.
  for (const name of tokenParameterNames) {
    const declaredType = (template.Parameters?.[name] as { Type?: unknown } | undefined)?.Type;
    if (typeof declaredType === 'string' && parameterTypeMayLoseSecretIdentity(declaredType)) {
      logger.warn(
        `Stack ${displayStackName(stackName)}: parameter ${displayIdent(name)} is declared Type: ${displayIdent(declaredType)} and is fed ` +
          `a secret dynamic reference. 'cdkd deploy' refuses this when the coercion actually ` +
          `destroys the plaintext (a comma-bearing secret in a list-typed parameter) — declare ` +
          `it 'Type: String' — and this diff compares the unresolved reference, shaped by the ` +
          `declared type only where that keeps every part of it a string.`
      );
    }
  }
  const userParameters: Record<string, string> = {};
  for (const [name, value] of Object.entries(parameters ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      userParameters[name] = String(value);
    }
  }
  const templateParameters = nullPrototypeRecord<unknown>();
  const declaredParameters =
    template.Parameters && typeof template.Parameters === 'object' ? template.Parameters : {};
  for (const [name, definition] of Object.entries(declaredParameters)) {
    try {
      // `inheritedForResolver` masks this method's `using user-provided value`
      // debug lines (go-to-k/cdkd#4049). The template keeps every other
      // section, so the SSM unreferenced-skip (#1002) still reads the whole of
      // it; only `Parameters` is narrowed to the one being bound.
      const bound = await intrinsicResolver.resolveParameters(
        { ...template, Parameters: { [name]: definition } },
        userParameters,
        inheritedForResolver ? { inheritedSecrets: inheritedForResolver } : undefined
      );
      if (Object.hasOwn(bound, name)) templateParameters[name] = bound[name];
    } catch (error) {
      unboundParameterNames.add(name);
      logger.debug(
        `Diff parameter binding for stack ${displayStackName(stackName)} is partial: ${describeAwsFailure(error).detail}`
      );
    }
  }
  // `resolveParameters` output wins for template-declared parameters — it
  // carries the deploy-coerced values (a Number-typed nested input becomes
  // a number, like deploy) — while raw nested inputs survive for any name
  // the template does not declare.
  //
  // EXCEPT for a redacted token (see `tokenParameterNames`), which is bound to
  // the shape the CHILD'S STATE HOLDS for it -- see
  // {@link tokenValueForComparison}. An earlier revision kept the raw token
  // for EVERY such parameter and justified it as "exactly what the child's
  // state holds", which is true only for a SCALAR one; issue
  // [#2327](https://github.com/go-to-k/cdkd/issues/2327) measured that a
  // `CommaDelimitedList` parameter's state leaf is an ARRAY, so the raw token
  // compared a string against a list and reported a phantom change on every
  // run. An over-stated invariant in a comment is durable precisely because
  // it stops the next reader looking, which is why the correction is spelled
  // here rather than only in the helper.
  mergedParameters = { ...parameters, ...templateParameters };
  for (const name of tokenParameterNames) {
    const declaredType = (template.Parameters?.[name] as { Type?: unknown } | undefined)?.Type;
    mergedParameters[name] = tokenValueForComparison(
      (parameters ?? {})[name],
      typeof declaredType === 'string' ? declaredType : undefined
    );
  }

  // 2) Evaluate `Conditions` and prune condition-false resources, so a
  //    condition-false resource is neither reported as "to create" nor
  //    diffed against state (matching deploy's `filterResourcesByCondition`
  //    step — a condition-false resource still in state correctly falls
  //    through to the DELETE path, exactly like deploy).
  //
  //    PER CONDITION (go-to-k/cdkd#4470). A condition that reaches an UNBOUND
  //    parameter, or one fed a redacted `{{resolve:...}}` token (issue #1903),
  //    has no verdict this side can compute: the resolver downgrades a
  //    condition it cannot evaluate to FALSE, and one evaluated over the token
  //    compares an expression where the deploy compares the real value — the
  //    deploy engine deliberately hands its CONDITION context the unredacted
  //    parameters, and this side does not have them and must not fetch them.
  //    Pruning by either verdict reports phantom DELETEs (or CREATEs). So that
  //    dependency closure ({@link unknownConditionNames}) is left out of the
  //    map handed to the evaluator, and `filterResourcesByCondition` — which
  //    prunes only a name the map holds as `false` — keeps every resource
  //    gated on it. Every OTHER condition gets its real verdict.
  //
  //    This used to be all-or-nothing, and the cost was not merely "diffed
  //    rather than pruned": with `conditions` undefined `resolveIf` takes the
  //    FALSE branch for EVERY `Fn::If`, so a condition-true property on a
  //    condition that reads no parameter at all diffed as a perpetual
  //    spurious UPDATE and `--fail` exited 1.
  //
  //    An UNKNOWN condition takes the verdict the last deploy RECORDED for it
  //    (go-to-k/cdkd#4479), but only when the fingerprint of its definitions
  //    and parameter inputs, recomputed here, equals the recorded one: the
  //    deploy then computes that same verdict, so it drives `Fn::If` and
  //    pruning exactly as a known one does. No record, a different
  //    fingerprint, or an unbound parameter in its closure keeps it unknown,
  //    so an `Fn::If` on it takes FALSE and it never prunes.
  let effectiveTemplate = template;
  let conditions: Record<string, boolean> | undefined;
  const unknownConditions = unknownConditionNames(
    template,
    new Set([...unboundParameterNames, ...tokenParameterNames])
  );
  // go-to-k/cdkd#4479: the parameters whose bound value the next deploy binds
  // too. DEFAULT DENY: a secret-fed token; a value the parent row supplied
  // that its own classification trusted (`rowValueTrusted`; any other row key
  // arrives in `parentUnresolvedParameters`); or a `Default` the parent did
  // not override, unless the type is resolved live from SSM. An UNBOUND
  // parameter, or one bound to its `Default` because the row value was not
  // trusted, is not: its deploy-time value may differ.
  //
  // Also never: a value carrying a needle of the inherited NoEcho corpus. The
  // deploy promotes every reader of such a parameter (`freshParameters`,
  // go-to-k/cdkd#3717) whatever this diff shows, so a reader's NO_CHANGE here
  // is no evidence. Read outside every `{{resolve:...}}` span, as the
  // deploy's `carriesFreshNoEchoValue` reads it.
  const inheritedNeedles =
    inheritedSecrets === undefined
      ? []
      : [...printingCorpusOf(inheritedSecrets).keys()].filter(
          (needle) => needle.length > 0 && !isSingleDynamicReferenceToken(needle)
        );
  const carriesInheritedNoEcho = (value: unknown): boolean => {
    if (typeof value === 'string') {
      const outside = value.replace(DYNAMIC_REFERENCE_TOKEN_SCAN, '');
      return inheritedNeedles.some((needle) => outside.includes(needle));
    }
    if (Array.isArray(value)) return value.some(carriesInheritedNoEcho);
    return false;
  };
  const trustedParameters = new Set<string>();
  for (const [name, definition] of Object.entries(declaredParameters)) {
    if (unboundParameterNames.has(name) || parentUnresolvedParameters?.has(name)) continue;
    // Before the supplied branch, so an SSM-typed parameter is never trusted:
    // its Default is a live read, and a supplied value is withheld too rather
    // than split into cases.
    const declaredType = (definition as { Type?: unknown } | undefined)?.Type;
    if (
      typeof declaredType === 'string' &&
      declaredType.startsWith('AWS::SSM::Parameter::Value<')
    ) {
      continue;
    }
    if (parameters !== undefined && Object.hasOwn(parameters, name)) {
      if (!carriesInheritedNoEcho(parameters[name])) trustedParameters.add(name);
      continue;
    }
    trustedParameters.add(name);
  }
  // Each unknown condition whose recorded fingerprint matches. A secret-fed
  // parameter's input is its `{{resolve:...}}` token as this diff received it
  // (the expression the deploy redacted the value back to); a parameter that
  // is not trusted has no input, so a condition reaching one never matches.
  const recordedVerdicts = nullPrototypeRecord<boolean>();
  const recorded = readRecordedConditionVerdicts(currentState);
  const recordedTokens = nullPrototypeRecord<string>();
  const unusableTokens = new Set<string>();
  for (const name of tokenParameterNames) {
    const token = (parameters ?? {})[name];
    if (typeof token === 'string') recordedTokens[name] = token;
    else unusableTokens.add(name);
  }
  const inputOf = conditionInputsFrom({
    tokens: recordedTokens,
    bound: templateParameters,
    // A name the resolver serves from a state RESOURCE first (`Ref` checks
    // resources before parameters) is no parameter input, as on the deploy.
    unavailable: new Set([
      ...Object.keys(declaredParameters).filter((name) => !trustedParameters.has(name)),
      ...unusableTokens,
      ...Object.keys(currentState.resources ?? {}),
      // A plain value the parent supplied, withheld exactly as the deploy
      // withholds it, so both fingerprints read the same inputs.
      ...parentSuppliedValues(template, parameters, tokenParameterNames),
    ]),
  });
  const mismatchedRecords: string[] = [];
  for (const name of unknownConditions) {
    if (!Object.hasOwn(recorded, name)) continue;
    const fingerprinted = conditionFingerprint(template, name, inputOf);
    if (fingerprinted !== undefined && fingerprinted.fingerprint === recorded[name]!.fingerprint) {
      recordedVerdicts[name] = recorded[name]!.verdict;
    } else {
      mismatchedRecords.push(name);
    }
  }
  // Whether EVERY parameter bound and EVERY condition has a verdict — what
  // `conditions !== undefined` meant before go-to-k/cdkd#4470. The Outputs merge
  // below still needs all of it.
  let everyConditionKnown = false;
  // go-to-k/cdkd#4479: the verdicts a nested child's row may branch on; see
  // `trustedConditionNames`. Empty when evaluation failed.
  let trustedConditions: ReadonlySet<string> = new Set();
  try {
    // A known condition never references an unknown one (the closure is
    // transitive), so the narrowed map is self-contained.
    const knownTemplate: CloudFormationTemplate =
      unknownConditions.size === 0 || !template.Conditions
        ? template
        : {
            ...template,
            Conditions: Object.fromEntries(
              Object.entries(template.Conditions).filter(([name]) => !unknownConditions.has(name))
            ),
          };
    const evaluated = await intrinsicResolver.evaluateConditions({
      template: knownTemplate,
      resources: currentState.resources,
      stateBackend,
      stackName,
      bestEffort: true,
      ...(mergedParameters && { parameters: mergedParameters }),
      // Its `Evaluated condition` / `Resolved` debug lines print a condition
      // over a parent-fed value (go-to-k/cdkd#4049).
      ...(inheritedForResolver && { inheritedSecrets: inheritedForResolver }),
      ...(attributeHealer && { attributeHealer }),
    });
    // The recorded verdicts join the evaluated ones in the SAME bag: a known
    // condition never references an unknown one, so neither can contradict
    // the other.
    for (const [name, verdict] of Object.entries(recordedVerdicts)) evaluated[name] = verdict;
    conditions = evaluated;
    trustedConditions = trustedConditionNames(template, evaluated, trustedParameters);
    effectiveTemplate = new TemplateParser().filterResourcesByCondition(template, conditions);
    everyConditionKnown = unboundParameterNames.size === 0 && unknownConditions.size === 0;
  } catch (error) {
    logger.debug(
      `Diff condition evaluation for stack ${displayStackName(stackName)} skipped: ${describeAwsFailure(error).detail}`
    );
  }
  if (mismatchedRecords.length > 0) {
    // The FALSE fallback can HIDE a change as well as show a phantom one: a
    // condition edited since a deploy that recorded FALSE may now be TRUE.
    // Named so a clean result over such a condition is not read as proof.
    logger.warn(
      safeMsg`Stack ${displayStackName(stackName)}: condition(s) ${mismatchedRecords.map((name) => displayIdent(name)).join(', ')} read a secret-fed parameter and changed since the last deploy, or one of their inputs did. This diff cannot tell which branch the next deploy takes, and shows each Fn::If on them as its FALSE branch.`
    );
  }
  const stillUnknown = [...unknownConditions].filter(
    (name) => !Object.hasOwn(recordedVerdicts, name)
  );
  if (stillUnknown.length > 0) {
    const names = stillUnknown.map((name) => displayIdent(name)).join(', ');
    logger.debug(
      safeMsg`Stack ${displayStackName(stackName)}: condition(s) ${names} depend on a parameter this diff cannot bind or read and have no matching recorded verdict; resources gated on them are not pruned, and an Fn::If on them takes its FALSE branch`
    );
  }
  return {
    mergedParameters,
    unboundParameterNames,
    effectiveTemplate,
    conditions,
    trustedParameters,
    everyConditionKnown,
    trustedConditions,
    stillUnknown,
  };
}

/**
 * A resolved list-typed parameter value: an array of scalars. An array holding
 * anything else (an unresolved intrinsic) is left as it is — the deploy
 * refuses it, and joining it would print `[object Object]`.
 */
export function isScalarList(value: unknown): value is Array<string | number | boolean> {
  return (
    Array.isArray(value) &&
    value.every(
      (element) =>
        typeof element === 'string' || typeof element === 'number' || typeof element === 'boolean'
    )
  );
}

/**
 * The conditions of `bag` whose verdict comes from trusted inputs only
 * (go-to-k/cdkd#4479): every `Ref` / `${Name}` in the closure (its own
 * definition and every `{Condition: X}` it reaches) names a trusted parameter
 * or a stable pseudo parameter, and every condition it reaches has a verdict.
 * A cycle is never trusted.
 */
function trustedConditionNames(
  template: CloudFormationTemplate,
  bag: Record<string, boolean>,
  trustedParameters: ReadonlySet<string>
): Set<string> {
  const definitions = (template.Conditions ?? {}) as Record<string, unknown>;
  const parser = new TemplateParser();
  const memo = new Map<string, boolean>();
  const trusted = (name: string, visiting: Set<string>): boolean => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name) || !Object.hasOwn(bag, name) || !Object.hasOwn(definitions, name)) {
      return false;
    }
    visiting.add(name);
    const definition = definitions[name];
    const refs = new Set<string>();
    collectRefTargets(definition, refs);
    for (const ref of parser.extractReferences(definition)) refs.add(ref);
    const chained = new Set<string>();
    collectConditionTargets(definition, chained);
    const verdict =
      [...refs].every((ref) => trustedParameters.has(ref) || STABLE_PSEUDO_PARAMETERS.has(ref)) &&
      [...chained].every((next) => trusted(next, visiting));
    visiting.delete(name);
    memo.set(name, verdict);
    return verdict;
  };
  const names = new Set<string>();
  for (const name of Object.keys(bag)) if (trusted(name, new Set())) names.add(name);
  return names;
}
