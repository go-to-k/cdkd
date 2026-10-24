import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { displayMasked, logRender, maskValueLeaves } from './masking-display.js';
import { resolveDynamicReferencesWithLogTwin } from './dynamic-refs.js';
import {
  hasLogOnlyNeedles,
  logTextOfLeaf,
  maskNeedlesForLog,
  maskNeedlesOfBags,
  maskPrintedNeedlesForLog,
  recordLeafResolution,
  regionLogText,
} from './masking.js';
import { markNonRetryable, markRedactedCause } from '../retryable-errors.js';
import { injectiveKey } from '../../state/record-keys.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../utils/ambient-client-defaults.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import {
  AWS_NO_VALUE,
  type ResolverContext,
  cachedAvailabilityZones,
  effectiveAccountInfoRegion,
  getAccountInfo,
  isClientSafeRegion,
  quotedRender,
} from './support.js';
import { keepsSecretReferenceToken } from './context.js';
import { recordTakenIfBranchIn } from './parameter-secrets.js';
import {
  SECRET_MASK,
  embedsFreshNoEchoValue,
  markNoEchoParameterClass,
  hasMaskableValues,
  recordDerivedMaskOnlyValue,
  recordFreshNoEchoValuesIn,
  recordIntrinsicLeafResolutionAs,
  recordLogOnlyValue,
} from '../secret-redaction.js';
import { safeMsg } from '../../utils/display-safe.js';
import { DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2';
import { namedRequestMasks } from './stack-output.js';

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

/**
 * Resolve Fn::FindInMap intrinsic function
 *
 * Fn::FindInMap: [MapName, TopLevelKey, SecondLevelKey]
 * Fn::FindInMap: [MapName, TopLevelKey, SecondLevelKey, { DefaultValue: <value> }]
 * Looks up a value in the Mappings section of the template. When the optional
 * 4th argument supplies a `DefaultValue` and the requested top-level OR
 * second-level key is absent, CloudFormation returns the DefaultValue instead
 * of failing; cdkd mirrors that here. Without a DefaultValue the missing-key
 * cases throw (backward compatible).
 */
export async function resolveFindInMap(
  resolver: IntrinsicFunctionResolver,
  findInMapArgs: [unknown, unknown, unknown] | [unknown, unknown, unknown, unknown],
  context: ResolverContext
): Promise<unknown> {
  const [rawMapName, rawTopLevelKey, rawSecondLevelKey, rawOptions] = findInMapArgs;

  // Recursively resolve each argument (they could be Refs or other intrinsic functions)
  const mapName = String(await resolver.resolveValue(rawMapName, context));
  const topLevelKey = String(await resolver.resolveValue(rawTopLevelKey, context));
  const secondLevelKey = String(await resolver.resolveValue(rawSecondLevelKey, context));

  // Optional 4th argument: { DefaultValue: <value> }. The DefaultValue may
  // itself be an intrinsic, so resolve it lazily only when we need to fall
  // back to it. `hasDefaultValue` distinguishes "no 4th arg" from a 4th arg
  // whose DefaultValue is intentionally undefined/null.
  const hasDefaultValue =
    typeof rawOptions === 'object' &&
    rawOptions !== null &&
    !Array.isArray(rawOptions) &&
    'DefaultValue' in (rawOptions as Record<string, unknown>);
  const resolveDefault = (): Promise<unknown> =>
    resolver.resolveValue((rawOptions as Record<string, unknown>)['DefaultValue'], context);

  // Access the Mappings section of the template
  const mappings = context.template.Mappings;
  // `Object.hasOwn` on all three lookups below (issue #2767). Every one of
  // `mapName` / `topLevelKey` / `secondLevelKey` is template-controlled, and
  // mapping keys are FREE-FORM text rather than logical ids, so this is the
  // most reachable site of the class: `Fn::FindInMap: [M, K, "constructor"]`
  // returned the `Object` function as the resolved VALUE instead of throwing,
  // and a `__proto__` top-level key returned `Object.prototype`.
  // `!= null`, NOT `!== undefined`: the read this replaced was `mappings?.[…]`,
  // whose optional chain short-circuits on NULL as well, and `Object.hasOwn`
  // throws `Cannot convert undefined or null to object`. A YAML `Mappings:`
  // with an empty body parses to `null` and reaches here through
  // `cdkd import --migrate-from-cloudformation`, so the narrower test turned
  // the `DefaultValue` arm and the named refusal below into a raw `TypeError`.
  // The `!mappings` guard underneath is falsy-checked for exactly that reason.
  const map = (
    mappings != null && Object.hasOwn(mappings, mapName) ? mappings[mapName] : undefined
  ) as Record<string, Record<string, unknown>> | undefined;

  if (!mappings) {
    if (hasDefaultValue) {
      return await resolveDefault();
    }
    throw markNonRetryable(new Error(`Fn::FindInMap: no Mappings section found in template`));
  }

  if (!map) {
    if (hasDefaultValue) {
      return await resolveDefault();
    }
    // MASKED at the throw (issue
    // [#2827](https://github.com/go-to-k/cdkd/issues/2827)): all three
    // `Fn::FindInMap` arguments come back from `resolveValue`, so any of
    // them can be a decrypted secret an `Fn::Sub` assembled. Masked per RAW
    // value, which is what reaches the floorless whole-value arm.
    throw markNonRetryable(
      new Error(
        `Fn::FindInMap: mapping ${quotedRender(displayMasked(resolver, mapName, context), "'")} not found in Mappings section`
      )
    );
  }

  const topLevel = Object.hasOwn(map, topLevelKey) ? map[topLevelKey] : undefined;
  if (!topLevel || typeof topLevel !== 'object') {
    if (hasDefaultValue) {
      return await resolveDefault();
    }
    throw markNonRetryable(
      new Error(
        `Fn::FindInMap: top-level key ${quotedRender(displayMasked(resolver, topLevelKey, context), "'")} ` +
          `not found in mapping ${quotedRender(displayMasked(resolver, mapName, context), "'")}`
      )
    );
  }

  if (!Object.hasOwn(topLevel, secondLevelKey)) {
    if (hasDefaultValue) {
      return await resolveDefault();
    }
    throw markNonRetryable(
      new Error(
        `Fn::FindInMap: second-level key ${quotedRender(displayMasked(resolver, secondLevelKey, context), "'")} ` +
          `not found in mapping ${quotedRender(displayMasked(resolver, mapName, context), "'")} under ` +
          // `under`, not `->`: pasted, `->` is `-` plus a `>` redirect onto the
          // quoted top-level key, which `QUOTABLE_RENDER` admits as a path
          // (`../x`, go-to-k/cdkd#4100 review M1).
          `top-level key ${quotedRender(displayMasked(resolver, topLevelKey, context), "'")}`
      )
    );
  }

  const result = topLevel[secondLevelKey];
  resolver.logger.debug(
    // MASKED like the three throws above (issue
    // [#2827](https://github.com/go-to-k/cdkd/issues/2827) review): all three
    // keys come back from `resolveValue`, and this is the SUCCESS path — the
    // common one — so leaving it bare printed at `--verbose` exactly the
    // values the neighbouring refusals mask. The mapped VALUE is leaf-masked
    // too: a mapping may legitimately hold a value assembled from a secret.
    `Resolved Fn::FindInMap: ${logRender(resolver, mapName, context)}.` +
      `${logRender(resolver, topLevelKey, context)}.` +
      `${logRender(resolver, secondLevelKey, context)} resolved to ` +
      `${logRender(resolver, JSON.stringify(maskValueLeaves(resolver, result, context)), context, { structured: true })}`
  );
  return result;
}

/**
 * Resolve Fn::Base64 intrinsic function
 *
 * Fn::Base64: valueToEncode
 * Returns the Base64 representation of the input string
 */
export async function resolveBase64(
  resolver: IntrinsicFunctionResolver,
  value: unknown,
  context: ResolverContext
): Promise<string> {
  // Recursively resolve the value first (it could be another intrinsic function)
  const resolvedValue = await resolver.resolveValue(value, context);

  if (typeof resolvedValue !== 'string') {
    // Names the TYPE only, never the value — nothing to mask, and nothing to
    // widen. Left as-is deliberately while its two siblings that DO
    // interpolate a value (`Fn::GetAtt`'s attribute-name refusal,
    // `Fn::Cidr`'s `ipBlock`) gained `maskValueLeaves`.
    throw markNonRetryable(
      new Error(`Fn::Base64: value must resolve to a string, got ${typeof resolvedValue}`)
    );
  }

  // THE COMPARISON PATH ANSWERS WHAT THE DEPLOY PERSISTS (issue
  // [#2909](https://github.com/go-to-k/cdkd/issues/2909)). Under
  // `skipDynamicReferences` (the deploy's diff pass, `cdkd diff`) a SECRET
  // reference is left as its `{{resolve:...}}` token, so encoding here
  // yielded base64 of the TOKEN, while the deploy encodes the plaintext and
  // persists `***` for it (the derived needle below). The two never agreed,
  // so such a resource diffed UPDATE on every run and `cdkd diff --fail`
  // was permanently red. Answering the mask compares like-for-like.
  //
  // `***` cannot say which expression it came from, so an edit to the text
  // around, or the target of, a secret reference inside the same
  // `Fn::Base64` compares equal HERE (as does a rotated value). The record's
  // `maskedPropertyFingerprints` (go-to-k/cdkd#4451), a hash of the
  // UNRESOLVED template value, is what tells the diff and the deploy's
  // no-change skip that such an edit happened.
  //
  // Only a token of a service the deploy RESOLVES counts: one of any other
  // service is left as written on BOTH paths, so its encoding already
  // agrees. Only a secret keeps its token through this pass (`secretsmanager`
  // and `ssm-secure` by spelling, a plain `ssm` one whose parameter is a
  // `SecureString`), which `keepsSecretReferenceToken` reads.
  //
  // NOT when the input also embeds a `NoEcho` value supplied in THIS deploy
  // (go-to-k/cdkd#3662): `***` against the recorded `***` would diff
  // NO_CHANGE and a re-minted value (a cross-stack read recovered from a
  // producer in the same `deploy --all`) would never be sent. The encoding
  // path below marks the encoding fresh, so the diff reports UPDATE and the
  // engine's skip refuses it.
  if (
    context.skipDynamicReferences === true &&
    keepsSecretReferenceToken(resolvedValue) &&
    !(
      context.recordedSecretValues !== undefined &&
      embedsFreshNoEchoValue(resolvedValue, context.recordedSecretValues)
    )
  ) {
    resolver.logger.debug(
      safeMsg`Resolved Fn::Base64: ${logRender(resolver, logTextOfLeaf(resolver, resolvedValue, context), context)} resolved to ${SECRET_MASK} (an unresolved secret reference, compared as the mask the deploy persists)`
    );
    return SECRET_MASK;
  }

  const result = Buffer.from(resolvedValue).toString('base64');

  // DERIVED NEEDLE (issue
  // [#2759](https://github.com/go-to-k/cdkd/issues/2759)). `Fn::Base64` over
  // a dynamic reference produces the secret in a trivially reversible
  // encoding, and every needle in the bag matches LITERALLY — so nothing
  // downstream can see it. The log line below masked the INPUT and printed
  // the OUTPUT in the same breath, and `resolveBase64` RETURNS `result`, so
  // the encoded secret reached `redactSecretsForState` and was persisted to
  // `state.json`, where one command decodes it (the GHSA-p5qg-v9gv-hc7w
  // class). Registering the TRANSFORMED value gives the existing masker
  // something to match, at the one site that still holds both forms.
  //
  // THE DETECTOR IS THE MASKER ITSELF — "did masking change the input?" —
  // rather than a `secrets.has(resolvedValue)` membership test, because the
  // input is often ASSEMBLED (`Fn::Sub` builds a UserData script around a
  // `{{resolve:...}}` reference), and base64 of a string that merely
  // CONTAINS a secret decodes back to that secret just as completely. TWO
  // maskers ask it, and each sees what the other cannot: the NEEDLE mask
  // catches a plaintext at or above {@link MIN_NEEDLE_LENGTH} wherever it
  // sits, and the POSITION mask (`logTextOfLeaf`, issue #3100) catches a
  // sub-floor plaintext an earlier write of this pass put into the input,
  // which the substring arm is blind to by design (issues #2516 / #2745).
  // Before the second asked (issue #3119), `port:` + a two-character
  // `secretValueFromJson('pin')` under `Fn::Base64` — the CDK UserData
  // shape — persisted its encoding to `state.json` in the clear while the
  // debug line beside it was already masked. The position twin is keyed by
  // the exact string a secret was written into, so a value it masks CARRIES
  // that secret's text, and registering its encoding is the same direction
  // the needle arm takes.
  //
  // THIS DECISION PERSISTS, and since issue #3114 it crosses the nested-stack
  // boundary: the position mask also reads the twins the PARENT registered
  // (`registeredLogTwin`), so in a CHILD this guard records the encoding into
  // the child's own bag and `***` lands in the child's `state.json` (a
  // rollback replay of that resource then refuses the masked baseline). The
  // log line below is not the only thing a change here affects.
  //
  // MASK-ONLY, not an expression pair. The whole point of an expression is
  // that a reader can re-resolve it, and re-resolving `{{resolve:...}}` here
  // would yield the PLAINTEXT rather than its base64 — a value AWS would
  // reject as UserData. `recordMaskOnlyValue` also refuses to demote a
  // plaintext that already carries a real expression, so registering the
  // encoding can never weaken the entry for the secret itself.
  //
  // Recorded BEFORE the debug line, which is what lets that line's NEEDLE
  // mask catch its right half; the line masks the right half whole on a
  // positioned input regardless, since the encoding decodes straight back
  // to the plaintext the input's mask hides.
  const inputLogText = logTextOfLeaf(resolver, resolvedValue, context);
  if (
    context.recordedSecretValues &&
    (inputLogText !== resolvedValue ||
      maskNeedlesForLog(resolver, resolvedValue, context) !== resolvedValue)
  ) {
    // DERIVED, so a leaf EMBEDDING the encoding is masked whole too
    // (go-to-k/cdkd#2453).
    recordDerivedMaskOnlyValue(context.recordedSecretValues, result);
    // The encoding of a FRESH `NoEcho` value is fresh too (go-to-k/cdkd#3662),
    // or a Base64 consumer of a re-minted token would be skipped as
    // `***` == `***`. The encoding of an ordinary secret is NOT: its record
    // already positions the reference, and marking it would update that
    // resource on every deploy.
    if (embedsFreshNoEchoValue(resolvedValue, context.recordedSecretValues)) {
      recordFreshNoEchoValuesIn(result, context.recordedSecretValues);
      // The encoding of a `NoEcho` PARAMETER's value is read as that
      // parameter's value is (go-to-k/cdkd#4043): one readback, never a
      // replacement on its word.
      if (embedsFreshNoEchoValue(resolvedValue, context.recordedSecretValues, 'parameter')) {
        markNoEchoParameterClass(context.recordedSecretValues, result);
      }
    }
  }
  // go-to-k/cdkd#1998: the encoding of text holding a LOG-ONLY needle (a
  // `NoEcho` parameter's value) decodes straight back to it, so it is a
  // log-only needle too. LOG-ONLY, deliberately, and outside the guard
  // above: that guard decides what is PERSISTED and must not see this class.
  if (
    context.recordedSecretValues &&
    hasLogOnlyNeedles(resolver, context) &&
    maskPrintedNeedlesForLog(resolver, resolvedValue, context) !==
      maskNeedlesForLog(resolver, resolvedValue, context)
  ) {
    recordLogOnlyValue(context.recordedSecretValues, result);
  }
  // The PRINT-ONLY twin (go-to-k/cdkd#4043): an encoding of text that only
  // the print-only corpus masks is recorded THERE, never into the pass's
  // bag, whose log-only needles decide an export alias.
  // Each mask is computed only inside its own guard, so a Base64 with no
  // printing bag or sink runs no extra scan.
  const printing = context.printingSecrets;
  let withPrinting: string | undefined;
  const maskedWithPrinting = (): string =>
    (withPrinting ??= maskNeedlesOfBags(resolver, resolvedValue, context, printing));
  if (
    printing !== undefined &&
    hasMaskableValues(printing) &&
    maskedWithPrinting() !== maskPrintedNeedlesForLog(resolver, resolvedValue, context)
  ) {
    recordLogOnlyValue(printing, result);
  }
  // The same for a command's derived-name sink (go-to-k/cdkd#3869): the
  // encoding of text embedding a secret-derived name (a CDK `UserData` over a
  // `Ref`) decodes straight back to it.
  const sink = context.secretNameSink;
  if (
    sink !== undefined &&
    hasMaskableValues(sink) &&
    maskNeedlesOfBags(resolver, resolvedValue, context, printing, sink) !== maskedWithPrinting()
  ) {
    recordLogOnlyValue(sink, result);
  }

  resolver.logger.debug(
    `Resolved Fn::Base64: ${logRender(resolver, inputLogText, context)} resolved to ${logRender(resolver, inputLogText !== resolvedValue ? SECRET_MASK : result, context)}`
  );
  return result;
}

/**
 * Resolve Fn::GetAZs intrinsic function
 *
 * Fn::GetAZs: region
 * Returns a list of availability zones for the specified region.
 * If region is empty string or {"Ref": "AWS::Region"}, uses the current region.
 * Results are cached per region to avoid repeated API calls.
 */
export async function resolveGetAZs(
  resolver: IntrinsicFunctionResolver,
  value: unknown,
  context: ResolverContext
): Promise<string[]> {
  // Recursively resolve the value first (it could be a Ref or other intrinsic function)
  const resolvedValue = await resolver.resolveValue(value, context);

  let region: string;
  /**
   * Which region's clients answer the `DescribeAvailabilityZones` below.
   *
   * `DescribeAvailabilityZones` lists the AZs of the region the CLIENT is
   * pointed at; the `region-name` filter narrows that listing, it does not
   * widen it to another region. So a foreign-region client returns an EMPTY
   * list, which this method then caches and hands back as the resolved value
   * of `Fn::GetAZs` — silently, since an empty list is not an error here
   * (issue #1957).
   *
   * When the template names a region explicitly, THAT is the region to talk
   * to. Otherwise fall back to the resolver's own — but only when it was
   * given explicitly (see {@link explicitRegion}).
   */
  let clientRegion: string | undefined;
  // How `region` is printed (issue #3150): a template-supplied region takes
  // its raw value's log text; the account's own region has none.
  let loggedRegionText: string | undefined;
  if (typeof resolvedValue === 'string' && resolvedValue !== '') {
    // REFUSE a template-derived region that is not region-shaped, BEFORE it
    // can reach `clientsForRegion` (issue #1957 review).
    //
    // This argument is the only attacker-influenceable value in this class
    // that now selects an SDK ENDPOINT: it is template-derived and can arrive
    // through an `Fn::ImportValue` or a parameter, so it is not necessarily
    // written by whoever runs the deploy. Before dynamic-reference lookups
    // were bound to a region it only fed the `region-name` FILTER below and
    // could not build a client; binding made it reachable, so the gate ships
    // with the binding. The measured escape is `evil.example.com#`, which the
    // SSM endpoint ruleset turns into
    // `https://ssm.evil.example.com/#.amazonaws.com` — a SigV4-SIGNED request
    // (access key id + signature) to an attacker-controlled host.
    //
    // THROW rather than fall back to the resolver's own region. Substituting
    // a different region's AZ names would be a silent wrong answer that
    // propagates into subnet placement, which is worse than a stopped deploy;
    // and a template asking for the AZs of a non-region is a bug or an
    // attack, never something to paper over. `clientsForRegion` keeps its own
    // softer backstop for any FUTURE caller, but this path is the one that is
    // reachable today and it fails loudly.
    const requested = canonicalizeRegion(resolvedValue);
    if (!isClientSafeRegion(requested)) {
      // MASKED BEFORE THE TRANSFORM (issue
      // [#2827](https://github.com/go-to-k/cdkd/issues/2827)). `resolvedValue`
      // comes back from `resolveValue`, so an `Fn::Sub`-assembled region
      // position can BE a decrypted secret; masking the finished message
      // instead would be decorative, because `stripControlChars` and
      // `.slice(0, 64)` both rewrite the text a literal needle has to match
      // — a measured 80-character secret printed its first 64 characters at
      // default verbosity with the needle recorded and a boundary mask
      // applied. Masking the RAW value also reaches the whole-value arm,
      // which has no {@link MIN_NEEDLE_LENGTH} floor.
      throw markNonRetryable(
        new Error(
          // `the value` LEADS the clause: after `: ` a quoted value would be
          // the pasted clause's COMMAND, and `QUOTABLE_RENDER` admits a path
          // (`'/usr/bin/touch' is not …` runs touch; go-to-k/cdkd#4100 M2).
          `Fn::GetAZs: the value ${quotedRender(displayMasked(resolver, logTextOfLeaf(resolver, resolvedValue, context) !== resolvedValue ? SECRET_MASK : resolvedValue, context).slice(0, 64), "'")} is not a valid AWS ` +
            `region name. A region is substituted into the AWS service hostname, so cdkd will ` +
            `not build a client from it.`
        )
      );
    }
    region = requested;
    clientRegion = requested;
    loggedRegionText = regionLogText(resolver, resolvedValue, context);
  } else {
    // Empty string or non-string: use current region. The SAME value
    // `AWS::Region` answers, and like it, with no STS hop: an AZ list needs no
    // account, so an STS outage must not refuse it (issue #1730).
    region = effectiveAccountInfoRegion(resolver.resolverRegion);
    clientRegion = resolver.explicitRegion;
  }

  // Check cache. The key is read HERE, synchronously beside the
  // `clientsForRegion` selection below, and reused at the `set`, so the list is
  // filed under the identity whose client read it (issue #3660). Never log it.
  const azCacheKey = injectiveKey(credentialFingerprint(ambientCredentialConfig()), region);
  const cached = cachedAvailabilityZones.get(azCacheKey);
  if (cached) {
    // `region` masked for the reason the two throws below state: it has
    // cleared `isClientSafeRegion`, which a real plaintext can (issue #2827
    // review).
    resolver.logger.debug(
      `Resolved Fn::GetAZs from cache: ${logRender(resolver, loggedRegionText ?? region, context)} resolved to ${logRender(resolver, JSON.stringify(maskValueLeaves(resolver, cached, context)), context, { structured: true })}`
    );
    return cached;
  }

  // Call EC2 DescribeAvailabilityZones
  const ec2Client = resolver.clients.clientsForRegion(
    clientRegion,
    loggedRegionText === undefined ? undefined : displayMasked(resolver, loggedRegionText, context)
  ).ec2;

  // The try wraps ONLY the call. The empty-list refusal below deliberately
  // sits outside it: inside, the catch would rewrap it into
  // `failed to describe ...: no availability zones returned ...` — a doubled
  // prefix, and a "failed to describe" on a call that SUCCEEDED.
  let azNames: string[];
  try {
    const response = await ec2Client.send(
      new DescribeAvailabilityZonesCommand({
        Filters: [
          {
            Name: 'region-name',
            Values: [region],
          },
          {
            Name: 'state',
            Values: ['available'],
          },
        ],
      })
    );

    azNames = (response.AvailabilityZones || [])
      .map((az) => az.ZoneName)
      .filter((name): name is string => name !== undefined)
      .sort();
  } catch (error) {
    // BOTH halves masked, and per raw value (issue
    // [#2827](https://github.com/go-to-k/cdkd/issues/2827)). `region` has
    // cleared `isClientSafeRegion`, which is only
    // `/^[a-z0-9][a-z0-9-]{0,30}$/` — a real plaintext passes it — and the
    // caught AWS message quotes the region back.
    //
    // The AWS text takes the region's POSITIONAL mask first (go-to-k/cdkd#3171):
    // the needle mask alone cannot see a sub-floor secret an `Fn::Sub`
    // assembled into the region, and the SDK quotes the region as SENT —
    // canonicalized, which is why the pair keys on `region` rather than on
    // the raw value `loggedRegionText` was derived from.
    const loggedRegion = displayMasked(resolver, loggedRegionText ?? region, context);
    const masks = namedRequestMasks(resolver, [[region, loggedRegion]], context);
    // go-to-k/cdkd#2319: a thrown message is persisted to
    // `deployments/{runId}.jsonl`, and an EC2 `UnauthorizedOperation` names
    // the caller's ARN. An AWS-authored failure is named by its class plus the
    // `--verbose` pointer, AWS's text goes to `debug` masked, and the masked
    // error rides as `cause`, stamped so the retry classifiers read it. A
    // cdkd-authored or transport error, or a non-`Error` value (#3361), keeps
    // its text.
    const failure = describeAwsFailure(error);
    const message = (text: string): string =>
      `Fn::GetAZs: failed to describe availability zones for region ` +
      `${quotedRender(loggedRegion, "'")}: ${masks.text(text)}`;
    if (!(error instanceof Error) || !failure.redacted) throw new Error(message(failure.detail));
    resolver.logger.debug(message(failure.detail));
    const masked = masks.error(error);
    const wrapped = new Error(
      message(failure.summary),
      masked instanceof Error ? { cause: masked } : undefined
    );
    throw masked instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  // An EMPTY list is never a legitimate answer: every enabled AWS region has
  // at least one availability zone. It means the call was answered by the
  // wrong region's endpoint (the `region-name` filter narrows a listing, it
  // does not redirect one), or the region is opt-in and not enabled on this
  // account. Neither is a value to hand back — and it must certainly not be
  // CACHED, because `cachedAvailabilityZones` is module-global, so one
  // degenerate answer would be replayed as the resolved value of every later
  // `Fn::GetAZs` for that region and identity in the process (issue #1957
  // review).
  if (azNames.length === 0) {
    throw markNonRetryable(
      new Error(
        `Fn::GetAZs: no availability zones returned for region ` +
          `${quotedRender(displayMasked(resolver, loggedRegionText ?? region, context), "'")}. Either the region ` +
          `is not enabled on this account (opt-in regions must be enabled before use), or the ` +
          `request was answered by a different region's endpoint.`
      )
    );
  }

  cachedAvailabilityZones.set(azCacheKey, azNames);
  resolver.logger.debug(
    `Resolved Fn::GetAZs: ${logRender(resolver, loggedRegionText ?? region, context)} resolved to ${logRender(resolver, JSON.stringify(maskValueLeaves(resolver, azNames, context)), context, { structured: true })}`
  );
  return azNames;
}

/**
 * Resolve pseudo parameters
 *
 * Pseudo parameters are built-in CloudFormation references like AWS::Region
 */
export async function resolvePseudoParameter(
  resolver: IntrinsicFunctionResolver,
  name: string,
  context?: ResolverContext
): Promise<string | string[] | symbol | undefined> {
  switch (name) {
    // `AWS::Region` and `AWS::Partition` need no account, so they take no STS
    // hop: `getAccountInfo` REFUSES when STS cannot name the account (issue
    // #1730), and a template that never names the account must not fail on
    // that. The values are the ones `getAccountInfo` would have answered —
    // `accountInfoFor` derives both from this same helper.
    case 'AWS::Region':
      return effectiveAccountInfoRegion(resolver.resolverRegion);

    // REFUSES (throws `AccountIdUnavailableError`) when STS cannot name the
    // account and `AWS_ACCOUNT_ID` is unset: there is no placeholder account
    // (issue #1730). Outside any catch in `resolveSub`, so `${AWS::AccountId}`
    // refuses there too rather than staying a literal.
    case 'AWS::AccountId': {
      const accountInfo = await getAccountInfo(resolver.resolverRegion);
      return accountInfo.accountId;
    }

    case 'AWS::Partition':
      return derivePartitionAndUrlSuffix(effectiveAccountInfoRegion(resolver.resolverRegion))
        .partition;

    case 'AWS::StackName':
      return context?.stackName ?? 'UnknownStack';

    case 'AWS::StackId': {
      // cdkd doesn't use CloudFormation stacks, generate a synthetic ID.
      // The partition is derived, not hardcoded (issue #1730 review) — this
      // is the same defect class as `getAccountInfo`'s own field, one site
      // over, and `arn:aws:` is wrong in every non-commercial partition.
      // The REGION segment is folded for the same reason (issue #1850). This
      // site is in `resolvePseudoParameter` rather than `constructAttribute`,
      // so it does NOT inherit that method's destructure-level fold — worth
      // stating, because the fold's own comment calls itself exhaustive and
      // that is true only WITHIN `constructAttribute`.
      const info = await getAccountInfo(resolver.resolverRegion);
      return `arn:${info.partition}:cloudformation:${canonicalizeRegion(info.region)}:${info.accountId}:stack/${context?.stackName ?? 'UnknownStack'}/cdkd`;
    }

    case 'AWS::URLSuffix':
      // Derived rather than hardcoded (issue #1730 review): `amazonaws.com.cn`
      // in `aws-cn`, and CloudFormation resolves `${AWS::URLSuffix}` through
      // exactly this mapping. Deliberately NO `getAccountInfo` hop, unlike
      // `AWS::StackId` which needs the account: the suffix is a pure function
      // of the region. The round trip could only add latency and, on an STS
      // outage, a refusal (issue #1730).
      //
      // An earlier revision justified that by saying `resolverRegion` is what
      // `getAccountInfo(resolver.resolverRegion)` "would have set `region` to
      // anyway". That stopped being true when issue #1882 folded
      // `effectiveAccountInfoRegion`: for a mis-cased `resolverRegion` the
      // two now differ in case. The OUTPUT is unaffected, because
      // `derivePartitionAndUrlSuffix` canonicalizes its own input (issue
      // #1795) -- which is the whole reason the skipped hop is still safe --
      // but the stated reason had to change with it.
      return derivePartitionAndUrlSuffix(resolver.resolverRegion).urlSuffix;

    case 'AWS::NotificationARNs':
      // cdkd has no stack-notification-ARN concept — a cdkd deploy never
      // sets SNS notification ARNs on a stack — so the list is always
      // empty. Returned as an EMPTY LIST, as CloudFormation resolves it (issue #3809): an
      // `Fn::Join` over it renders '' there, and inside `Fn::Sub` it is
      // rejected as a list, which `resolveSub` mirrors. It used to be '',
      // on which `Fn::Join` failed with "resolved to string".
      return [];

    case 'AWS::NoValue':
      // Return special symbol to indicate property should be omitted
      return AWS_NO_VALUE;

    default:
      return undefined;
  }
}

/**
 * Resolve an SSM Parameter Store dynamic reference
 *
 * Format: ssm:PARAMETER_NAME
 * Parts[0] = 'ssm'
 * Parts[1] = PARAMETER_NAME
 */
/**
 * Resolve Fn::Cidr intrinsic function
 *
 * Fn::Cidr returns an array of CIDR address blocks.
 * Syntax: { "Fn::Cidr": [ ipBlock, count, cidrBits ] }
 * - ipBlock: The user-specified CIDR address block to be split
 * - count: The number of CIDRs to generate
 * - cidrBits: The number of subnet bits for the CIDR (e.g., "64" for /64 in IPv6)
 */
export async function resolveCidr(
  resolver: IntrinsicFunctionResolver,
  args: [unknown, unknown, unknown],
  context: ResolverContext
): Promise<string[]> {
  const [rawIpBlock, rawCount, rawCidrBits] = args;
  const ipBlock = (await resolver.resolveValue(rawIpBlock, context)) as string;
  const count = Number(await resolver.resolveValue(rawCount, context));
  const cidrBits = Number(await resolver.resolveValue(rawCidrBits, context));

  if (!ipBlock || typeof ipBlock !== 'string') {
    throw markNonRetryable(
      new Error(
        `Fn::Cidr: ipBlock must be a string, got ${typeof ipBlock}: ${JSON.stringify(maskValueLeaves(resolver, ipBlock, context))}`
      )
    );
  }

  // `count` / `cidrBits` through the builder (PR #3575 review): as
  // `Number()` results they cannot carry a control character, but they come
  // back from `resolveValue`, so a numeric secret whose text survives
  // `Number()` would otherwise print (`"0064"` or `"1e3"` does not survive,
  // and is not masked).
  resolver.logger.debug(
    // Leaf-masked like the refusal above (issue #2827 review): `ipBlock`
    // comes back from `resolveValue`.
    `Resolving Fn::Cidr: ipBlock=${displayMasked(resolver, JSON.stringify(maskValueLeaves(resolver, ipBlock, context)), context)}, count=${displayMasked(resolver, String(count), context)}, cidrBits=${displayMasked(resolver, String(cidrBits), context)}`
  );

  const isIpv6 = ipBlock.includes(':');
  const results: string[] = [];

  if (isIpv6) {
    // IPv6 CIDR calculation
    // Parse the base IPv6 address and prefix
    const [baseAddr, prefixStr] = ipBlock.split('/');
    const basePrefix = parseInt(prefixStr!, 10);
    const subnetPrefix = 128 - cidrBits; // cidrBits = host bits, so subnet prefix = 128 - cidrBits

    // Expand IPv6 address to full form
    const expanded = expandIPv6(resolver, baseAddr!);
    const addrBigInt = ipv6ToBigInt(resolver, expanded);

    // Calculate subnet size
    const subnetSize = BigInt(1) << BigInt(128 - subnetPrefix);

    // Mask the base address to the network prefix
    const prefixMask =
      (BigInt(1) << BigInt(128)) -
      BigInt(1) -
      ((BigInt(1) << BigInt(128 - basePrefix)) - BigInt(1));
    const networkBase = addrBigInt & prefixMask;

    for (let i = 0; i < count; i++) {
      const subnetAddr = networkBase + subnetSize * BigInt(i);
      results.push(`${bigIntToIPv6(resolver, subnetAddr)}/${subnetPrefix}`);
    }
  } else {
    // IPv4 CIDR calculation
    const [baseAddr, prefixStr] = ipBlock.split('/');
    const basePrefix = parseInt(prefixStr!, 10);
    const subnetPrefix = 32 - cidrBits;

    const parts = baseAddr!.split('.').map(Number);
    const baseInt = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
    const subnetSize = 1 << (32 - subnetPrefix);
    const prefixMask = (0xffffffff << (32 - basePrefix)) >>> 0;
    const networkBase = (baseInt & prefixMask) >>> 0;

    for (let i = 0; i < count; i++) {
      const subnetAddr = (networkBase + subnetSize * i) >>> 0;
      const a = (subnetAddr >>> 24) & 0xff;
      const b = (subnetAddr >>> 16) & 0xff;
      const c = (subnetAddr >>> 8) & 0xff;
      const d = subnetAddr & 0xff;
      results.push(`${a}.${b}.${c}.${d}/${subnetPrefix}`);
    }
  }

  // The RESULT is derived from `ipBlock`, so it inherits its provenance
  // (issue #2827 review, item D2: one of the five encodings the fix's own
  // comment had claimed were all leaf-masked).
  //
  // As NEEDLE masks the two on this line are MUTUALLY redundant, and no test
  // can discriminate either one (measured both ways, review round 4:
  // stripping the leaf walk reds nothing, and so does stripping the outer
  // call; only removing BOTH reds). Since issue #3100 the leaf arm also
  // consults the pass's log-twin registry, which only ever masks MORE: a
  // computed CIDR equal to a string an earlier write masked by position is
  // masked by the leaf walk and not by the outer call, an over-mask. For the
  // needle part the leaf arm is `displayMasked`,
  // so the only thing that could separate per-leaf from whole-JSON masking is
  // `maskSecretsInText`'s asymmetry — the whole-string arm has no floor while
  // the substring arm is floored at {@link MIN_NEEDLE_LENGTH} = 4 — and
  // reaching it needs a needle of 3 characters or fewer equal to a WHOLE leaf.
  // `results` holds only values this method COMPUTED: dotted-decimal (min 9
  // characters, `0.0.0.0/0`) or colon-hex (min 17, `bigIntToIPv6` never
  // compresses), over `[0-9a-f:./-]` plus `NaN` / `Infinity` — nothing
  // `JSON.stringify` escapes, and nothing short enough. So the two orders
  // produce identical output for every needle set.
  //
  // BOTH stay, because the redundancy is a property of what `results` holds
  // TODAY rather than of the site: the day this pushes something it did not
  // compute, the leaf walk is the mask that still works.
  resolver.logger.debug(
    `Fn::Cidr result: ${displayMasked(resolver, JSON.stringify(maskValueLeaves(resolver, results, context)), context)}`
  );
  return results;
}

/** Expand IPv6 address to full 8-group form */
export function expandIPv6(_resolver: IntrinsicFunctionResolver, addr: string): string {
  // Handle :: expansion
  if (addr.includes('::')) {
    const [left, right] = addr.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - leftParts.length - rightParts.length;
    const middle = Array.from({ length: missing }, () => '0000');
    const all = [...leftParts, ...middle, ...rightParts];
    return all.map((p: string) => p.padStart(4, '0')).join(':');
  }
  return addr
    .split(':')
    .map((p) => p.padStart(4, '0'))
    .join(':');
}

/** Convert expanded IPv6 string to BigInt */
export function ipv6ToBigInt(_resolver: IntrinsicFunctionResolver, expanded: string): bigint {
  const parts = expanded.split(':');
  let result = BigInt(0);
  for (const part of parts) {
    result = (result << BigInt(16)) | BigInt(parseInt(part, 16));
  }
  return result;
}

/** Convert BigInt to compressed IPv6 string */
export function bigIntToIPv6(_resolver: IntrinsicFunctionResolver, n: bigint): string {
  const parts: string[] = [];
  for (let i = 7; i >= 0; i--) {
    parts.push(((n >> BigInt(i * 16)) & BigInt(0xffff)).toString(16));
  }
  // Simple format — don't compress with :: for clarity
  return parts.join(':');
}
