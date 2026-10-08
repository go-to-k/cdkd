import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  recordLogOnlyParameterValue,
  carryLogOnlyValuesCarriedBy,
  inheritedParameterExpression,
  inheritedRenderedToken,
  carryFreshNoEchoMark,
  recordInheritedParameterRead,
  recordNoEchoParameterFreshValue,
  isNoEchoParameterPlaintext,
  MIN_NEEDLE_LENGTH,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import {
  type ResolverContext,
  type ParameterDefinition,
  inheritedSecretsCarriedBy,
  QUOTABLE_RENDER,
  quotedRender,
} from './support.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    recordInheritedParameterSecrets: OmitThisParameter<typeof recordInheritedParameterSecrets>;
    /** @internal */
    recordNoEchoParameterValue: OmitThisParameter<typeof recordNoEchoParameterValue>;
    /** @internal */
    refuseCoercedInheritedSecret: OmitThisParameter<typeof refuseCoercedInheritedSecret>;
  }
}

/**
 * Copy any {@link ResolverContext.inheritedSecrets} pair whose PLAINTEXT is
 * present in a just-resolved parameter value into this context's
 * `recordedSecretValues` (issues #1903 / #2087).
 *
 * WHY AT RESOLUTION TIME. This is the whole of the #2087 fix. The parent
 * hands a nested child already-resolved plaintext, so the child's own
 * resolution never sees a `{{resolve:` and cannot record the pair itself; the
 * first cut pre-SEEDED every child resource's map with the parent's bag,
 * which restored the redaction but destroyed the per-resource scoping
 * `perResourceSecrets` exists for. `redactSecretsForState` substring-matches
 * at or above {@link MIN_NEEDLE_LENGTH}, so a child resource that never
 * referenced the parameter but happens to spell `my-production-bucket` while
 * the secret is `production` had its state persisted as
 * `my-{{resolve:...}}-bucket` — which `redactParametersForDiff` does NOT
 * mirror on the desired side (it rewrites only the PARAMETERS), so every
 * later deploy saw a change: a perpetual UPDATE, or a perpetual REPLACEMENT
 * on a create-only property.
 *
 * Recording here binds the pair to exactly the resources whose resolution
 * consumed the parameter — which are exactly the ones that can carry the
 * plaintext into their persisted state — so the child gets the SAME scoping
 * RULE the PARENT already has, where `perResourceSecrets` is keyed by logical
 * id.
 *
 * That is PARITY with the parent, not a claim of exactness. Once a pair is in
 * a resource's bag, `redactSecretsForState` substring-matches every leaf of
 * THAT resource, so a resource which both `Ref`s the parameter and carries an
 * unrelated literal spelling the plaintext has the literal rewritten too. The
 * parent has precisely this residual for any resource that resolves a
 * `{{resolve:...}}`; what #2087 removed was the much wider version, where
 * every resource in the child got the bag whether it consumed the parameter
 * or not.
 *
 * The TWO ARMS of the match live in {@link inheritedSecretsCarriedBy}, shared
 * with the refusal below so the two can never drift apart.
 *
 * Covers every consumption shape, because `Fn::Sub` / `Fn::Join` /
 * `Fn::Select` / `Fn::FindInMap` all re-enter `resolveValue` and reach the
 * parameter through this same `Ref` branch.
 *
 * WHICH EXPRESSION the pair is recorded against is the issue
 * [#2291](https://github.com/go-to-k/cdkd/issues/2291) round-2 fix, and
 * skipping it made the persist and diff halves DISAGREE.
 *
 * `inherited` is keyed by PLAINTEXT, so two parent parameters resolving to
 * ONE value collapse to a single entry there and this method used to copy
 * whichever expression SURVIVED. That is invisible for a leaf spelled exactly
 * `{Ref: P}` — the persist path positions such a leaf through the parent's
 * per-parameter association and never consults this bag's value — but an
 * EMBEDDING shape (`Fn::Sub`, `Fn::Join`, and `{'Fn::Sub': '${P}'}`, which
 * `crossStackSourceKey` refuses because its `Fn::Sub` arm requires a dotted
 * attribute) fell to the plaintext-keyed VALUE SCAN, which reads exactly this
 * bag. Meanwhile `DeployEngine.redactParametersForDiff` answers PER PARAMETER.
 * So `Fn::Sub "postgres://u:${LoserParam}@host"` — the dominant CDK
 * connection-string shape — persisted the SURVIVOR's expression while the
 * desired side computed the LOSER's, and the two never matched again: a
 * perpetual UPDATE, or a perpetual REPLACEMENT on a create-only property.
 * That is issue [#2087](https://github.com/go-to-k/cdkd/issues/2087)'s symptom
 * arriving through a different door, prevented for the bare-`Ref` leaf and
 * created for the embedded one.
 *
 * Recording THIS parameter's own expression makes the value scan agree with
 * the diff side, so both halves move together.
 * A parameter the parent spelled as a LITERAL embedding its tokens has no
 * per-plaintext association; its own expression for a plaintext is the token
 * that literal spells there (`inheritedRenderedToken`, issue
 * [#4644](https://github.com/go-to-k/cdkd/issues/4644)), which is what the
 * diff side substitutes at every read site.
 *
 * ONE SLOT PER PLAINTEXT is still all this bag can hold, so when ONE
 * resource consumes two such parameters the slot holds whichever `Ref`
 * resolved LAST, and a value-scanned embedding leaf would take that one
 * whatever it embeds. The persist path therefore no longer leaves an
 * `Fn::Sub` / `Fn::Join` over the child's parameters to this slot: since
 * issue [#2320](https://github.com/go-to-k/cdkd/issues/2320)
 * `positionByParameterPlaceholders` answers each placeholder from its OWN
 * parameter association, which is what `redactParametersForDiff` renders on
 * the desired side. Since issue
 * [#4446](https://github.com/go-to-k/cdkd/issues/4446) that arm reads the
 * spans the RESOLVER recorded for each parameter `Ref` it substituted
 * (`IntrinsicLeafResolution.parameterSpans`), so a leaf with several parts
 * the template cannot state, and an `Fn::If` selecting one, are positioned
 * too. What still reaches the slot is a leaf both of its readings refuse: a
 * stretch of other text the value scan would rewrite, a recorded plaintext
 * the final re-scan still finds or one crossing a placeholder's edge, and a
 * leaf with no usable record that the template parse cannot align. There
 * the order-dependent disagreement with the diff side remains. A leaf spelled
 * exactly `{Ref: <Param>}` no longer reads the slot either (issue
 * [#2349](https://github.com/go-to-k/cdkd/issues/2349)): the persist walk
 * answers it from the PARENT bag through the function the diff side binds,
 * for the parameters {@link recordInheritedParameterRead} names here.
 *
 * Substituting is deliberately NOT done here — the resolved value is what
 * reaches AWS, and an `Fn::Equals` over a parameter must compare the real
 * value or the condition flips.
 */
export function recordInheritedParameterSecrets(
  this: IntrinsicFunctionResolver,
  parameterName: string,
  value: unknown,
  context: ResolverContext
): void {
  const inherited = context.inheritedSecrets;
  const recorded = context.recordedSecretValues;
  // go-to-k/cdkd#1998: a `NoEcho` value the PARENT consumed is a log-only
  // needle of the parent's bag, and the child's own parameter declaration
  // (a CDK-synthesized one never says `NoEcho`) cannot re-derive it. Carried
  // BEFORE the size test below, which reads a bag holding only log-only
  // needles as empty.
  if (inherited && recorded) carryLogOnlyValuesCarriedBy(inherited, recorded, value);
  if (inherited && recorded)
    recordInheritedNoEchoListElements(this, inherited, recorded, value, context);
  if (!inherited || inherited.size === 0 || !recorded) return;
  // Issue #2291 round 2. THIS parameter's own expression, when the parent
  // certified one, rather than the collapsed map's survivor. See the
  // "WHICH EXPRESSION" section of the doc above for why the survivor is the
  // wrong answer for an EMBEDDING leaf and what residual is left.
  for (const [plaintext, expression] of inheritedSecretsCarriedBy(value, inherited)) {
    // ASKED PER PLAINTEXT, not per VALUE (issue #2327). This bag is keyed by
    // PLAINTEXT, so the question it needs answered is "does THIS parameter
    // certify THIS plaintext" -- which `inheritedParameterExpression` answers
    // through the same predicate the persist side uses, for a scalar value
    // and for an ELEMENT of a coerced `CommaDelimitedList` alike. The earlier
    // spelling asked about the whole `value` and gated on `plaintext ===
    // value`, which can never hold once `coerceParameterValue` has turned the
    // parent's string into an ARRAY: the override typechecked but could not
    // fire, so a list-typed parameter kept the collapsed survivor here.
    //
    // The scalar answer is UNCHANGED by the move, because the recorder's
    // condition 2 already subsumes the old gate: the association's recorded
    // plaintext IS this parameter's whole resolved value, so it can only
    // equal a carried plaintext that the old `plaintext === value` also
    // accepted. `inheritedSecretsCarriedBy` still returns pairs for OTHER
    // inherited plaintexts this value merely CONTAINS, and those still fall
    // through to their own parameter's expression -- handing them this one's
    // would be the collapse, one step over.
    //
    // `typeof own === 'string'` rather than `!== undefined`: the function
    // answers with an ARRAY for a list-typed parameter's whole value, and
    // this bag holds strings. Nothing here asks for that shape, but the guard
    // is what says so rather than leaving it to the argument passed above.
    const own = inheritedParameterExpression(inherited, parameterName, plaintext);
    // Issue #4644: a parameter the parent spelled as a LITERAL embedding its
    // tokens has no per-plaintext association, so it used to take the
    // survivor here while the diff side binds that literal at every read
    // site. The token the literal itself spells at this plaintext, where the
    // spelling certifies one; the survivor otherwise.
    const spelled =
      typeof own === 'string'
        ? own
        : inheritedRenderedToken(inherited, parameterName, value, plaintext);
    recorded.set(plaintext, spelled ?? expression);
    // Issue #2349: the persist walk answers a `{Ref: <Param>}` leaf of THIS
    // resource from the parent bag, as the diff side does, and only for a
    // parameter recorded here -- the #2087 scope this loop already applies.
    recordInheritedParameterRead(recorded, inherited, parameterName);
    // go-to-k/cdkd#3717: a `NoEcho` value the parent supplied in THIS deploy
    // stays fresh in the child resource's bag, or its no-change skip reads
    // the new value's `***` as equal to the recorded `***`.
    carryFreshNoEchoMark(inherited, recorded, plaintext);
  }
}

/**
 * go-to-k/cdkd#4043: a child `CommaDelimitedList` / `List<...>` parameter fed
 * a parent's `NoEcho` PARAMETER value arrives split, and no element equals the
 * parent's whole value, so the value arm would leave each element in the
 * clear in the child's record. An element that is a piece of such a value
 * (from `MIN_NEEDLE_LENGTH`, the value arm's floor) is recorded as a fresh
 * mask-only needle of the parameter class in the child resource's bag.
 */
function recordInheritedNoEchoListElements(
  resolver: IntrinsicFunctionResolver,
  inherited: RecordedSecretValues,
  recorded: RecordedSecretValues,
  value: unknown,
  context: ResolverContext
): void {
  if (!Array.isArray(value)) return;
  const parameterValues = [...inherited.keys()].filter((plaintext) =>
    isNoEchoParameterPlaintext(inherited, plaintext)
  );
  if (parameterValues.length === 0) return;
  // The LIST as a whole must be (a part of) such a value, as the parent
  // supplied it and the coercion split and trimmed it: an element of a
  // public list that merely occurs inside a parent's NoEcho value is no
  // piece of it.
  const joined = value.map((element) => String(element)).join(',');
  const normalized = (plaintext: string): string =>
    plaintext
      .split(',')
      .map((piece) => piece.trim())
      .join(',');
  // Whole pieces only (comma boundaries), so a one-element public list
  // equal to a word INSIDE a piece is no match.
  if (!parameterValues.some((plaintext) => `,${normalized(plaintext)},`.includes(`,${joined},`))) {
    return;
  }
  for (const element of value) {
    if (typeof element !== 'string' || element.length < MIN_NEEDLE_LENGTH) continue;
    recordNoEchoParameterFreshValue(element, recorded, resolver.publicNoEchoTokens(context));
  }
}

/**
 * Record the value of a `NoEcho: true` PARAMETER as a LOG-ONLY needle of the
 * pass that consumed it (go-to-k/cdkd#1998). `NoEcho` is the template
 * author's declaration that the value is sensitive, and CloudFormation masks
 * it everywhere it echoes one.
 *
 * Every leaf a log line can spell is recorded: a string leaf, the
 * `String()` form of a number (a `Number` parameter is coerced before this
 * runs), and a list's comma-joined form, the spelling the user supplied and
 * the one `String()` renders. The log-only record over-covers at the cost of
 * a masked log line; the mask-only record (go-to-k/cdkd#4043) is what
 * persistence reads. Recorded into the pass's own bag and nowhere else:
 * a pass without one (the parameter pass's log context) has no masker to
 * feed.
 */
export function recordNoEchoParameterValue(
  this: IntrinsicFunctionResolver,
  paramDef: ParameterDefinition | undefined,
  value: unknown,
  context: ResolverContext
): void {
  const bag = context.recordedSecretValues;
  if (paramDef?.NoEcho !== true || bag === undefined) return;
  // One spelling rule, shared with the deploy's diff log masker, which
  // records every `NoEcho` value up front (go-to-k/cdkd#4049).
  recordLogOnlyParameterValue(bag, value);
  // go-to-k/cdkd#4043 (the value arm): also a FRESH mask-only needle of the
  // pass, so everything that persists from this bag stores `***` where a
  // leaf equals or embeds the value, and the engine knows the bag carries a
  // value supplied in this deploy. A value under the needle floor, or a
  // number, registers nothing here; the positional arm masks it by template
  // position. The public tokens (region, stack name) stay out of the
  // containment arm, as for a custom resource's echo.
  recordNoEchoParameterFreshValue(value, bag, this.publicNoEchoTokens(context));
}

/**
 * Refuse a child parameter whose declared `Type` would COERCE an inherited
 * secret out of cdkd's string-keyed secret model (issue #1903, review round
 * 2).
 *
 * THE MODEL IS STRING-KEYED END TO END. `RecordedSecretValues` is keyed by
 * plaintext STRING, {@link recordInheritedParameterSecrets} scans strings and
 * string array elements, and `redactSecretsForState` rewrites string LEAVES.
 * `coerceParameterValue` turns a `Number` / `List<Number>` parameter into a JS
 * number before any of that runs, so the pair was never recorded, the leaf was
 * never rewritten, and the child's `state.json` persisted the DECRYPTED value
 * verbatim — the exact disclosure this issue closes for `String` parameters —
 * with `cdkd diff --recursive` then reporting a change on every run.
 *
 * WHY A REFUSAL RATHER THAN RECORDING ON THE PRE-COERCION STRING. Recording
 * the pair is not enough on its own: the persisted leaf is a NUMBER, so the
 * redactor would additionally have to rewrite a number leaf into an
 * expression STRING, matched by `String(n) === plaintext`. That comparison
 * both UNDER-covers (`"007"` coerces to `7` and stringifies back to `"7"`, so
 * a zero-padded secret silently stays plaintext) and OVER-covers (a numeric
 * secret like `8080` whole-value-matches every unrelated port in the bag —
 * issue #2087's class, on a path where `MIN_NEEDLE_LENGTH` does not apply).
 * A remedy that can silently under-cover is the wrong one for a disclosure
 * path, so this refuses and NAMES the parameter instead.
 *
 * The blast radius is nil for CDK-authored apps: CDK synthesizes every
 * nested-stack cross-reference parameter as `Type: String`. A hand-authored
 * template that really wants a numeric secret can declare the parameter
 * `String` and keep the value a string, which is what CloudFormation's own
 * `NoEcho` / dynamic-reference handling assumes anyway.
 *
 * SCOPED TO THE INHERITED BAG, which is non-empty only on a nested-stack
 * child engine, and only for a value that actually carries a pair the parent
 * PROVED secret. An ordinary `Type: Number` parameter is untouched.
 *
 * The message never quotes the value.
 */
export function refuseCoercedInheritedSecret(
  this: IntrinsicFunctionResolver,
  name: string,
  paramDef: ParameterDefinition,
  userValue: string,
  inherited: RecordedSecretValues | undefined
): void {
  if (!inherited || inherited.size === 0) return;
  // MEASURE the loss; do not enumerate the types that cause it. A hand-kept
  // list of "types that lose string identity" was wrong the moment it was
  // written: it named `Number` / `List<Number>` and explicitly cleared
  // `CommaDelimitedList` as safe because it "produces an array of strings
  // (both of which the recording scan and the redactor handle)". That holds
  // only while the secret contains no comma -- and the dominant Secrets
  // Manager shape is a JSON blob, which is nothing but commas. `,`-splitting
  // shreds the plaintext into FRAGMENTS, so neither arm of
  // `inheritedSecretsCarriedBy` matches, nothing is recorded, the redactor is
  // the identity, and the child's state.json keeps the cleartext -- the exact
  // escape this refusal exists to close, on a type an audit had cleared.
  //
  // Comparing the pairs BEFORE and AFTER coercion answers the real question
  // ("did coercion destroy a needle we would have redacted with?") instead of
  // a proxy for it. It subsumes `Number` and `List<Number>`, covers the
  // `.trim()` whitespace variant, keeps a comma-FREE `CommaDelimitedList`
  // secret working, and cannot go stale when a new `Type` is added to
  // `coerceParameterValue`.
  //
  // A parent `NoEcho` PARAMETER's value is not such a pair (go-to-k/cdkd#4043
  // review round 11): the value arm records it as a mask-only entry, but the
  // child positions the parameter the parent fills from it
  // (`passedNoEchoParameters`), so a split or coerced value is masked by
  // template position, each element and a number included. Counting it here
  // refused every CommaDelimitedList / Number child parameter fed a NoEcho
  // value, naming a secret dynamic reference the template never had.
  const secretPairs: RecordedSecretValues = new Map(
    [...inherited].filter(([plaintext]) => !isNoEchoParameterPlaintext(inherited, plaintext))
  );
  if (secretPairs.size === 0) return;
  const carriedBefore = inheritedSecretsCarriedBy(userValue, secretPairs).length;
  if (carriedBefore === 0) return;
  const carriedAfter = inheritedSecretsCarriedBy(
    this.coerceParameterValue(userValue, paramDef.Type),
    secretPairs
  ).length;
  if (carriedAfter >= carriedBefore) return;
  // `markNonRetryable` for the same reason the `Fn::GetAtt` refusals (`getatt.ts`)
  // carry it: the decision comes from the template's declared `Type`, which
  // no retry rewrites, and the message interpolates a template-controlled
  // parameter NAME that the substring-matching retry classifiers can read as
  // transient (issue #1838).
  //
  // `name` is a template-declared PARAMETER key, i.e. arbitrary JSON, so it
  // takes the builder like every other identifier the resolver renders
  // (go-to-k/cdkd#3435 review round 2). It appears TWICE in this message, so
  // it is bound once. The declared `Type` takes it too (issue #3441): this
  // arm is reached by any type the coercion SPLITS, and
  // `isListParameterType` accepts every `List<...>` spelling, so the inner
  // text is arbitrary template JSON.
  const loggedName = this.displayMasked(name);
  const loggedType = this.displayMasked(paramDef.Type);
  throw markNonRetryable(
    new IntrinsicResolutionRefusalError(
      `Nested-stack parameter ${quotedRender(loggedName, "'")} is declared ${QUOTABLE_RENDER.test(loggedType) ? `'Type: ${loggedType}'` : 'with a Type that is not a plain identifier'}, but the ` +
        `parent stack resolved a SECRET dynamic reference into it. cdkd keeps a resolved ` +
        `secret out of persisted state by rewriting STRING leaves back to their ` +
        `{{resolve:...}} expression; coercing this value to ${quotedRender(loggedType, "'", 'that Type')} destroys the ` +
        `plaintext cdkd would have matched on, so the DECRYPTED secret would be left in the ` +
        `child stack's state.json with nothing to redact it back ` +
        `to. Declare ${quotedRender(loggedName, "'", 'the parameter')} as 'Type: String' in the nested stack's template (CDK does ` +
        `this by default for cross-stack references), or stop passing a secret reference ` +
        `into it.`,
      undefined,
      'NESTED_STACK_SECRET_PARAMETER_TYPE'
    )
  );
}
