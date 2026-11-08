import { type RecordedSecretValues } from './pairs.js';
import {
  type PathSourceRules,
  isDynamicReferenceString,
  isSingleDynamicReferenceToken,
  isPlainObject,
} from './rules.js';
import { spanNamesResolvableService } from './anchors.js';
import { redactForState } from './context.js';
import {
  positionByEmbeddedSpan,
  positionByIntrinsicSkeleton,
  positionByIntrinsicFrame,
} from './positions.js';
import { positionByCrossStackSource } from './certified-positions.js';
import { positionByParameterPlaceholders } from './placeholder-positions.js';
import { positionListByCrossStackSource, identityKeyFor } from './identity-keys.js';
import { positionByInheritedParameter, positionByParameterReread } from './nested-stack.js';
import { isKnownSecretExpression } from './mask-only.js';
import { sourceElementsKeptFor, keptLiteralsCorroborate } from './redact-path/array-drop.js';
import {
  RENDERED_DEFINITION_KEYS,
  definitionSourceCarriesSecret,
  nameDefinitionSecrets,
} from './redact-path/definition.js';
import { hasPlainPrototype } from './redact-path/json-equality.js';

export { sourceElementsKeptFor, arrayPairsWhateverDrops } from './redact-path/array-drop.js';
export {
  isReadbackProjectedFromState,
  subtreeHasDynamicReference,
  pathCrossesDottedKey,
} from './redact-path/subtree.js';
export {
  RENDERED_DEFINITION_KEYS,
  definitionSourceCarriesSecret,
  type SentinelDefinition,
  type SecretLeaf,
  sentinelDefinitionOf,
  alignedSecretLeaf,
  collectObjectKeys,
  spelledKeysOf,
  someKeyIsUnspelled,
  replaceAtPath,
} from './redact-path/definition.js';
export { isUncertifiedBaselineMaskPosition } from './redact-path/baseline-mask.js';
export {
  DYNAMIC_REFERENCE_TOKEN_SCAN,
  dynamicReferenceTokens,
  dynamicReferenceSpans,
  mixedLeafMayCarryPublicReference,
} from './redact-path/reference-tokens.js';
export {
  hasPlainPrototype,
  isOrdinaryDate,
  deepEqualJsonValue,
} from './redact-path/json-equality.js';

/**
 * PATH-based redaction: walk `bag` alongside a SOURCE bag that still carries the
 * unresolved `{{resolve:...}}` expressions, and wherever the source leaf is such
 * a string, persist THAT string verbatim.
 *
 * This exists because value-keyed redaction cannot answer the question at all
 * when two expressions share one resolved value (issue #1904): the map is keyed
 * by the plaintext, so the two collapse and every site is rewritten to whichever
 * expression was recorded last — state then holds an expression the template
 * does not have at that leaf, and the stack takes a permanent spurious UPDATE.
 * Position is the only disambiguator, and the source bag supplies it.
 *
 * It also covers the case where there is no secrets map to consult at all
 * (issue #1900): an UNCHANGED resource is never resolved during a deploy, so its
 * `perResourceSecrets` entry is empty, and a live readback that echoes a secret
 * would be persisted in plaintext. Projecting from the resource's OWN state
 * record — which already holds the expressions — redacts it with no secret
 * fetch and no value matching.
 *
 * A source leaf that is an intrinsic OBJECT has no string to copy. A
 * nested-stack child's `{Ref: <Param>}` leaf whose parameter carried an
 * inherited secret into this resource is answered first, as the diff side
 * binds that parameter ({@link positionByInheritedParameter}, issue #2349),
 * and an `Fn::Select` / `Fn::Split` / `Fn::If` leaf over its parameters is
 * re-read with those bindings ({@link positionByParameterReread}, issues
 * #4731, #4919).
 * Any other goes through four positioning passes before the value scan, in
 * this order:
 *
 * - {@link positionByCrossStackSource} (issue #2059), for the two CROSS-STACK
 *   spellings `Fn::ImportValue` / `Fn::GetStackOutput`. Those carry no text
 *   about their expression at all, so the skeleton below structurally cannot
 *   describe them; instead the RESOLVER recorded, while reading the producer,
 *   which `{{resolve:...}}` token this exact leaf identity reads.
 * - {@link positionByParameterPlaceholders} (issue #2320), for an `Fn::Sub` /
 *   `Fn::Join` over a nested-stack child's own parameters, or an `Fn::If`
 *   selecting one: each parameter span the resolver recorded (issue #4446), or
 *   failing that each placeholder the template states, takes the expression
 *   its `{Ref: <Param>}` association names, so a leaf EMBEDDING a parameter
 *   persists what the diff side renders.
 * - {@link positionByIntrinsicSkeleton} (issue #1916), for `Fn::Join` /
 *   `Fn::Sub`: when the intrinsic's literal parts describe exactly one of the
 *   recorded secret expressions, THAT is persisted. This is the dominant CDK
 *   shape — an L2 secret token renders the ARN as a `Ref`, hence a join.
 * - {@link positionByIntrinsicFrame} (issue #2745), for the same two spellings
 *   when their literal parts FRAME one token (`port:` +
 *   `secretValueFromJson(...)`): the one candidate this pass resolved to the
 *   framed middle is written into the frame, under the literal span arm's
 *   bound and mark.
 *
 * An ARRAY leaf beside such an intrinsic OBJECT — the shape a
 * `CommaDelimitedList` nested-stack parameter produces once the child has
 * coerced it — is positioned ELEMENT-WISE by
 * {@link positionListByCrossStackSource} (issue #2327). What certifies an
 * element there is its own recorded plaintext rather than its index, so nothing
 * is aligned against a source array that does not exist; see that function for
 * the two shapes it refuses.
 *
 * The value scan is still applied wherever none can answer: an embedding leaf
 * the span arms refuse (a nonliteral frame, a middle no pair of this pass
 * vouches for), an intrinsic whose skeleton matches several candidates (or
 * none, the pair table included), a cross-stack leaf whose identity is not
 * literally computable, a diverged shape, a key the source lacks. So the passes
 * are complementary rather than alternatives — path where position is knowable,
 * association where the position is a cross-stack read, skeleton where it is a
 * describable intrinsic, value where none is.
 */
export function redactByPath(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  rules: PathSourceRules,
  secretExpressions: ReadonlySet<string>,
  bagIsSameGeneration: boolean
): unknown {
  if (isDynamicReferenceString(source) && typeof bag === 'string') {
    // A TEMPLATE source carries PUBLIC ssm expressions too, and those must stay
    // RESOLVED in state (#1901) or the diff compares a resolved desired side
    // against a stored expression forever. A STATE source cannot hold one.
    if (
      isSingleDynamicReferenceToken(source) &&
      (rules.trustAnyExpression || isKnownSecretExpression(source, secretExpressions))
    ) {
      // ...unless the BAG leaf is ALREADY a complete token of its own and the
      // source cannot certify that it describes the same GENERATION of this
      // resource (issues #1917 / its review). Then the two are two persisted
      // answers rather than a plaintext and its reference, and overwriting one
      // with the other is how a rolled-back or not-yet-deployed reference gets
      // reported as applied — see the generation table on `PathSourceRules`.
      //
      // Falling back to a WHOLE-VALUE redaction rather than returning `bag` is
      // what makes this safe to set conservatively: a token-shaped PLAINTEXT
      // this pass resolved is a key of `secrets` and is still rewritten onto its
      // own expression, while a previous generation's EXPRESSION is not a key
      // and survives. The refusal costs nothing on the bags that were genuinely
      // resolved here.
      //
      // WHOLE-VALUE, not the full value scan, and the difference WAS a defect
      // this went through once: the scan's other arm rewrote a secret found as
      // a SUBSTRING, and this leaf is a complete `{{resolve:...}}` token, so a
      // short secret VALUE occurring inside it (an ssm SecureString holding
      // `prod`, against `{{resolve:secretsmanager:prod/db:SecretString:pw}}`)
      // was spliced INTO the token. That mangles a persisted expression on
      // every `cdkd scrub` over already-clean state — full map, bag of
      // expressions by construction — and the replay then re-resolves the
      // wreckage, whose `[^}]+` stops at the first `}`, into a request for a
      // bogus secret id.
      //
      // The scan no longer does that to a leaf of THIS shape since issue
      // [#1935](https://github.com/go-to-k/cdkd/issues/1935) — it keeps a match
      // that lies STRICTLY INSIDE a complete `{{resolve:...}}` span, and a
      // whole-token leaf is one span end to end, so every match in it is either
      // strictly inside (kept) or coextensive with it, and coextensive means
      // the whole leaf, which the whole-value arm above already answered. So
      // this arm and the full scan now agree here for TWO independent reasons
      // rather than one.
      //
      // NOT "never rewrites inside a span", which an earlier revision of this
      // comment said: a needle that STRADDLES or CONTAINS a span does consume
      // span text, deliberately, because refusing it left the plaintext in
      // state. The exception is about a match SHORTER than the span it sits
      // in — see `scanLeaf`'s own table. Both guards are still spelled
      // out, and neither may be removed by editing only the other: each has its
      // own probe.
      //
      // While BOTH exist, `redactForState(bag, { provenance: 'value-scan', secrets })` here would be
      // byte-equivalent for a token of a RESOLVABLE service — the walk's own
      // token guard makes it whole-value-only for this shape — so a mutation swapping the two is an equivalent mutant
      // rather than an uncovered case. The duplication is the point: delete
      // either guard and the other still holds, and each has its own probe.
      //
      // A bag token of a service cdkd does NOT resolve is not a persisted
      // answer at all (issue #2743): it is what an older binary left behind
      // for a secret assembled into the service position, so it takes the
      // full value scan, which no longer spares it.
      if (!rules.sourceIsSameGeneration && isSingleDynamicReferenceToken(bag)) {
        if (!spanNamesResolvableService(bag))
          return redactForState(bag, { provenance: 'value-scan', secrets });
        return secrets.get(bag) ?? bag;
      }
      // The source leaf IS what state should hold — exact, and immune to two
      // expressions sharing one resolved value.
      return source;
    }
    // A literal leaf EMBEDDING one token, positioned by the span its source
    // states — exact where the value scan is ambiguous (issue #2485) — or
    // several, kept verbatim where the source renders to it (#4644). On every
    // refusal (a public reference, an embedded token this pass cannot vouch
    // for) the arm returns the value scan of the leaf itself — computed for
    // its own `(bag, secrets)`, at its early returns or inside the shared
    // bound helper — so a secret embedded beside the token is still redacted.
    return positionByEmbeddedSpan(bag, source, secrets, bagIsSameGeneration);
  }
  if ((typeof bag === 'string' || Array.isArray(bag)) && isPlainObject(source)) {
    // A nested-stack child leaf spelled `{Ref: <Param>}` that this resource's
    // resolution read with an inherited secret in it (issue #2349): persisted
    // as the DIFF side binds that parameter, from the same function and the
    // same PARENT bag, ahead of the arms below. Their fall-through scans the
    // CHILD bag, whose slot holds whichever parameter's expression resolved
    // last, while the diff side scans the parent's.
    const inherited = positionByInheritedParameter(bag, source, secrets);
    if (inherited !== undefined) return inherited;
    // Its `Fn::Select` / `Fn::Split` / `Fn::If` twin (issues #4731, #4919):
    // such a leaf, re-read with the diff side's parameter bindings, rather
    // than from that slot.
    const reread = positionByParameterReread(bag, source, secrets);
    if (reread !== undefined) return reread;
  }
  if (typeof bag === 'string' && isPlainObject(source)) {
    // The source leaf is an intrinsic OBJECT, so there is no string to copy —
    // the residual #1904 left and #1916 closes. Deliberately NOT gated on
    // `rules`: `descendArrays` is about walking a LIST, `trustAnyExpression`
    // relaxes a check this arm does not make, and `sourceIsSameGeneration`
    // answers a question neither arm below asks. The skeleton arm requires the
    // bag leaf to be a plaintext THIS pass recorded (its condition 1), which a
    // previous generation's persisted expression can never be. The frame arm
    // (issue #2745) accepts a leaf that merely EMBEDS one, so its generation
    // claim comes from the same two places the literal arm's does: the value
    // scan's own bound, and — for a middle below the scan's floor — the
    // ENGINE's object-level mark, `bagIsSameGeneration`, never the rules
    // constant. The candidates come only from stores the resolver populates
    // for a reference it treated as SECRET — a proven verdict, or, in the
    // pair table the frame arm also reads, an `ssm` type that came back
    // unclassifiable and was resolved as secret for THIS pass and left
    // unpinned (#1901) — never a definitively PUBLIC parameter, so none can
    // be a public ssm reference (the perpetual-UPDATE hazard of that issue)
    // — see `positionByIntrinsicSkeleton`'s own doc, which explains why it
    // holds NO `isKnownSecretExpression` check.
    //
    // The CROSS-STACK arm runs FIRST (issue #2059). It answers for the
    // spellings the skeleton pass structurally cannot describe
    // (`Fn::ImportValue` / `Fn::GetStackOutput` carry no text about their
    // expression, and a nested-stack child's `{Ref: <Param>}` carries none
    // either — issue #2291), so the two are disjoint rather than competing today; the
    // order is what keeps them disjoint if the skeleton ever gains a
    // wildcard-only arm, since a lookup against a recorded leaf identity is
    // strictly better evidence than a pattern that matched everything.
    const certified = positionByCrossStackSource(bag, source, secrets);
    if (certified !== undefined) return certified;
    // The EMBEDDING twin of the `{Ref: <Param>}` arm above (issue #2320): an
    // `Fn::Sub` / `Fn::Join` over the child's own parameters, or embedding a
    // cross-stack read (issue #2298), each placeholder answered from its OWN
    // association. Before the skeleton arm, because an
    // association is exact evidence where a pattern is a search.
    const placeheld = positionByParameterPlaceholders(bag, source, secrets);
    if (placeheld !== undefined) return placeheld;
    const positioned = positionByIntrinsicSkeleton(bag, source, secrets, secretExpressions);
    if (positioned !== undefined) return positioned;
    // The FRAME arm LAST (issue #2745): a leaf that EMBEDS one token inside
    // the intrinsic's literal text, which the skeleton arm declines — and a
    // whole-token leaf the skeleton arm REFUSED, answered here only on
    // pass-local pair evidence the skeleton's stores cannot hold (its
    // docstring names the one shape).
    const framed = positionByIntrinsicFrame(
      bag,
      source,
      secrets,
      secretExpressions,
      bagIsSameGeneration
    );
    if (framed !== undefined) return framed;
    // Fall through to the value scan below on any refusal.
  }
  if (Array.isArray(bag) && isPlainObject(source)) {
    // The LIST-VALUED twin of the arm above (issue #2327). A child parameter
    // declared `CommaDelimitedList` is coerced by `coerceParameterTypedValue`
    // into an ARRAY before any of this runs, so a
    // leaf the child template spells `{Ref: <Param>}` arrives here as an array
    // beside an intrinsic OBJECT — a shape NO arm matched, which dropped it to
    // the plaintext-keyed value scan and handed BOTH members of a coinciding
    // pair the survivor's expression. That is issue #2291's collapse arriving
    // through the one door its string-only arms left open, and
    // `docs/cli-reference.md` names `CommaDelimitedList` as an ALLOWED spelling
    // for a secret-bearing nested-stack parameter, so it is reachable rather
    // than theoretical.
    //
    // See {@link positionListByCrossStackSource} for what POSITION means for an
    // element and for the two shapes this deliberately REFUSES.
    const positionedList = positionListByCrossStackSource(bag, source, secrets);
    if (positionedList !== undefined) return positionedList;
    // Fall through to the value scan below on any refusal.
  }
  if (Array.isArray(bag) && Array.isArray(source)) {
    // KEYED descent FIRST (issue #1915). It is order-independent, so it is what
    // makes a secret nested in an array reachable at all on the
    // UNCHANGED-resource path, where positional descent is refused AND the
    // value scan is a no-op (the resource was never resolved this deploy, so
    // its `perResourceSecrets` entry is empty — the #1900 shape). Without it
    // that leaf keeps its plaintext in `observedProperties` forever while
    // `properties` correctly holds the expression.
    //
    // Chosen over the other candidate direction — seeding the value scan from
    // the SOURCE bag's own expression set — because that one cannot work here:
    // a value scan needs PLAINTEXT needles, and on the unchanged path no
    // plaintext is known for this resource at all. The source contributes
    // EXPRESSIONS, so seeding from it could only over-redact by position-blind
    // masking, which would destroy the drift baseline it is trying to protect.
    // Keying restores POSITION, which is the thing that was actually missing,
    // and it answers the `descendArrays: false` rationale on its own terms
    // rather than overriding it: the objection is ORDER, and a key does not
    // depend on order.
    //
    // It runs BEFORE the positional arm, not only where positional is refused,
    // and the ordering is deliberate. `descendArrays` rests on an assumption
    // this module states but cannot enforce — see the rules doc, "every
    // `effectiveProperties` producer TODAY preserves length and order". A
    // provider that reorders an equal-length `Tags[]` satisfies the length
    // check and mis-pairs by index, while the pairing that CANNOT mis-align is
    // right here. Preferring the one with no failure mode costs a Map build on
    // a list that would have paired identically anyway.
    //
    // "CANNOT mis-align" is a claim about THIS pairing — equality on a field
    // unique across both sides — and not about position generally. The anchor
    // pass in `refuseUncertifiedReadbackPositions` pairs by position and CAN
    // mis-align if its evidence is weak, which is why it carries a uniqueness
    // rule of its own (`unkeyedArrayPairsByAnchors`) rather than inheriting
    // this one's guarantee. Reading that guarantee as covering both is exactly
    // the mistake the #2012 review measured.
    const key = identityKeyFor(bag, source);
    if (key !== undefined) {
      const sourceIndexById = new Map<string, number>();
      source.forEach((item, i) => {
        sourceIndexById.set((item as Record<string, unknown>)[key] as string, i);
      });
      // `-1` marks a bag element whose identity the source does not carry.
      //
      // The casts are safe because `identityKeyFor` has already verified BOTH
      // sides: every element is a plain object with an OWN non-empty string at
      // `key`, unique within its array. Nothing structural ties the two, so if
      // that validation is ever relaxed these casts have to be revisited with
      // it.
      let orderPreserved = true;
      const partnerIndex = bag.map((item, i) => {
        const j = sourceIndexById.get((item as Record<string, unknown>)[key] as string);
        if (j === undefined) return -1;
        if (j !== i) orderPreserved = false;
        return j;
      });

      // An UNPAIRED element is guessed at positionally exactly when positional
      // descent would have been EXACT for the whole array anyway: the bag was
      // produced by resolving the source (`descendArrays`), the lengths agree,
      // and every pairing that DID happen sits at its own index — the last
      // being the check that the order assumption actually HELD here rather
      // than being assumed. Under those three, `source[i]` is necessarily
      // unclaimed for an unpaired `i` (any other bag element pairing with it
      // would have to sit at index `i` itself), so this cannot hand two bag
      // elements the same partner.
      //
      // The invariant is: keying must never pre-empt a positional descent that
      // would have been exact. Without this, keying ONE element pre-empted the
      // positional arm for ALL of them, and an unpaired leaf dropped to the
      // value scan — which on a colliding pair writes a SIBLING's expression,
      // the #1910 wrong-reference class, on a path (`STATE_DERIVED_RULES`, the
      // replay) that then applies it to AWS.
      //
      // When those three do NOT hold, an unpaired element falls to the value
      // scan and stays there. That is deliberate: on the UNCHANGED-resource
      // path (`descendArrays: false`, issue #1900) the value scan has no
      // needles at all, so refusing the whole array until EVERY element pairs
      // would let one AWS-added element un-redact the secrets that did pair —
      // the exact case issue #1915 exists to fix.
      //
      // Note there is no separate "did anything pair at all" gate, and its
      // absence is load-bearing rather than an omission. ZERO pairings means
      // the two sides are keyed on DISJOINT identities (a provider normalising
      // `Name` / `Key` in its `effectiveProperties`), and that case must not
      // pre-empt positional descent — but it no longer can: with no pairings
      // `orderPreserved` is vacuously true, so `positionalIsExact` reduces to
      // the positional arm's own condition and every element takes `source[i]`,
      // which is what falling through would have done. An earlier draft carried
      // an explicit `paired > 0` gate beside this; once the positional fallback
      // landed the gate became unreachable, and a guard that cannot change an
      // answer reads as protection while fencing nothing.
      const positionalIsExact =
        rules.descendArrays && bag.length === source.length && orderPreserved;
      return bag.map((item, i) => {
        const j = partnerIndex[i]!;
        if (j >= 0)
          return redactByPath(
            item,
            source[j],
            secrets,
            rules,
            secretExpressions,
            bagIsSameGeneration
          );
        if (positionalIsExact) {
          return redactByPath(
            item,
            source[i],
            secrets,
            rules,
            secretExpressions,
            bagIsSameGeneration
          );
        }
        return redactForState(item, { provenance: 'value-scan', secrets });
      });
    }
    if (rules.descendArrays && bag.length === source.length) {
      // No identity field on either side (a list of plain strings, a list of
      // objects with no `Name` / `Key`). Positional descent is sound here ONLY
      // because the bag was produced by resolving the source. An AWS readback
      // may be REORDERED, so that kind does not take this arm at all and falls
      // to the value scan rather than writing an expression onto a wrong
      // element.
      return bag.map((item, i) =>
        redactByPath(item, source[i], secrets, rules, secretExpressions, bagIsSameGeneration)
      );
    }
    // SHORTER than a source that resolving produced (issue
    // [#4919](https://github.com/go-to-k/cdkd/issues/4919)): the resolver
    // drops an element that resolves to `AWS::NoValue`, so where its record
    // (issue #4954) or the count alone says WHICH elements dropped, the rest
    // pair in order. Every kept
    // LITERAL element must equal its bag element, and every kept token must be
    // the one this pass resolved to it, the corroboration the length check
    // gives the positional arm: a producer that removed an element itself
    // (rules.ts) falls to the value scan. Any other shortfall
    // keeps the value scan.
    if (rules.descendArrays && bag.length < source.length) {
      const kept = sourceElementsKeptFor(source, bag.length, secrets);
      if (kept !== undefined && keptLiteralsCorroborate(kept, bag, secrets)) {
        return bag.map((item, i) =>
          redactByPath(item, kept[i], secrets, rules, secretExpressions, bagIsSameGeneration)
        );
      }
    }
  }
  // `hasPlainPrototype` for issue
  // [#2869](https://github.com/go-to-k/cdkd/issues/2869): this is the FIRST of
  // the two position walks, so a `Date` an AWS readback carries reached here
  // before `refuseUncertifiedReadbackPositions` ever saw it, and
  // `Object.entries(new Date())` being `[]` rebuilt it as `{}` — a baseline AWS
  // never reported, which `cdkd drift --revert` can push. Guarding only the
  // second walk moved the flattening rather than removing it (measured: the
  // Date arrived at that walk already `{}`). A non-plain bag now falls to the
  // divergence arm below, whose value scan returns a `Date` BY IDENTITY — on
  // the empty-map readback paths trivially, and with a POPULATED map since
  // issue [#2427](https://github.com/go-to-k/cdkd/issues/2427) (see
  // `isOrdinaryDate`).
  if (isPlainObject(bag) && hasPlainPrototype(bag) && isPlainObject(source)) {
    // `Object.create(null)` (issue #1943's class): `JSON.parse` of an AWS
    // readback can produce an OWN `__proto__` key, and `out[k] = ...` on a
    // normal object invokes the prototype setter instead of defining it — so
    // the key would be silently dropped from the persisted bag and read as
    // phantom drift ever after.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(bag)) {
      // `Object.hasOwn`, not `k in source`: the prototype chain would answer for
      // `constructor` / `toString` and hand the walk a function as the source.
      out[k] = Object.hasOwn(source, k)
        ? redactByPath(v, source[k], secrets, rules, secretExpressions, bagIsSameGeneration)
        : redactForState(v, { provenance: 'value-scan', secrets });
      // A rendered Step Functions definition (issues #5315, #5333). Neither
      // the path pass nor the value scan reads object KEYS or names a NUMBER,
      // so a populated map — the deploy's own persist of the resource that
      // resolved the secret — wrote a secret placed in a key (a state name) or
      // outside quotes verbatim. Scoped to these keys and to a record whose
      // definition carries a secret: everywhere else a number is a value the
      // template spells as one. See {@link nameDefinitionSecrets}.
      if (
        secrets.size > 0 &&
        RENDERED_DEFINITION_KEYS.has(k) &&
        definitionSourceCarriesSecret(source)
      ) {
        out[k] = nameDefinitionSecrets(out[k], source, secrets);
      }
    }
    return out;
  }
  // Shapes diverged (an array whose length changed, a scalar where the source
  // has an object, a key the source lacks): fall back to the value scan, which
  // is strictly better than leaving the subtree unredacted.
  return redactForState(bag, { provenance: 'value-scan', secrets });
}
