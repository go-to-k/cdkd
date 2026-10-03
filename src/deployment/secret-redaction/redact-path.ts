import { type RecordedSecretValues, SECRET_MASK } from './pairs.js';
import {
  type PathSourceRules,
  isDynamicReferenceString,
  isSingleDynamicReferenceToken,
  isPlainObject,
  DYNAMIC_REFERENCE_INNER,
} from './rules.js';
import { spanNamesResolvableService } from './anchors.js';
import { redactSecretsForState } from './redact-state.js';
import {
  positionByEmbeddedSpan,
  positionByIntrinsicSkeleton,
  positionByIntrinsicFrame,
} from './positions.js';
import { positionByCrossStackSource } from './certified-positions.js';
import { positionByParameterPlaceholders } from './placeholder-positions.js';
import { positionListByCrossStackSource, identityKeyFor } from './identity-keys.js';
import {
  carriesSecretMask,
  isKnownSecretExpression,
  isRecordedSecretExpression,
} from './mask-only.js';

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
 * A source leaf that is an intrinsic OBJECT has no string to copy, so it goes
 * through four positioning passes before the value scan, in this order:
 *
 * - {@link positionByCrossStackSource} (issue #2059), for the two CROSS-STACK
 *   spellings `Fn::ImportValue` / `Fn::GetStackOutput`. Those carry no text
 *   about their expression at all, so the skeleton below structurally cannot
 *   describe them; instead the RESOLVER recorded, while reading the producer,
 *   which `{{resolve:...}}` token this exact leaf identity reads.
 * - {@link positionByParameterPlaceholders} (issue #2320), for an `Fn::Sub` /
 *   `Fn::Join` over a nested-stack child's own parameters: each placeholder
 *   takes the expression its `{Ref: <Param>}` association names, so a leaf
 *   EMBEDDING a parameter persists what the diff side renders.
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
      // in — see {@link scanLeaf}'s own table. Both guards are still spelled
      // out, and neither may be removed by editing only the other: each has its
      // own probe.
      //
      // While BOTH exist, `redactSecretsForState(bag, secrets)` here would be
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
        if (!spanNamesResolvableService(bag)) return redactSecretsForState(bag, secrets);
        return secrets.get(bag) ?? bag;
      }
      // The source leaf IS what state should hold — exact, and immune to two
      // expressions sharing one resolved value.
      return source;
    }
    // A literal leaf EMBEDDING one token, positioned by the span its source
    // states — exact where the value scan is ambiguous (issue #2485). On every
    // refusal (a public reference, an embedded token this pass cannot vouch
    // for) the arm returns the value scan of the leaf itself — computed for
    // its own `(bag, secrets)`, at its early returns or inside the shared
    // bound helper — so a secret embedded beside the token is still redacted.
    return positionByEmbeddedSpan(bag, source, secrets, bagIsSameGeneration);
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
    // `Fn::Sub` / `Fn::Join` over the child's own parameters, each placeholder
    // answered from its OWN association. Before the skeleton arm, because an
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
        return redactSecretsForState(item, secrets);
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
  }
  // `hasPlainPrototype` for issue
  // [#2869](https://github.com/go-to-k/cdkd/issues/2869): this is the FIRST of
  // the two position walks, so a `Date` an AWS readback carries reached here
  // before {@link refuseUncertifiedReadbackPositions} ever saw it, and
  // `Object.entries(new Date())` being `[]` rebuilt it as `{}` — a baseline AWS
  // never reported, which `cdkd drift --revert` can push. Guarding only the
  // second walk moved the flattening rather than removing it (measured: the
  // Date arrived at that walk already `{}`). A non-plain bag now falls to the
  // divergence arm below, whose value scan returns a `Date` BY IDENTITY — on
  // the empty-map readback paths trivially, and with a POPULATED map since
  // issue [#2427](https://github.com/go-to-k/cdkd/issues/2427) (see
  // {@link isOrdinaryDate}).
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
        : redactSecretsForState(v, secrets);
    }
    return out;
  }
  // Shapes diverged (an array whose length changed, a scalar where the source
  // has an object, a key the source lacks): fall back to the value scan, which
  // is strictly better than leaving the subtree unredacted.
  return redactSecretsForState(bag, secrets);
}

/**
 * Is this rules constant one whose BAG is an AWS readback and whose SOURCE is a
 * persisted STATE bag?
 *
 * Today that is {@link STATE_SOURCED_READBACK_RULES} and its fail-closed twin
 * {@link STATE_SOURCED_BASELINE_RULES}, which differ on nothing this predicate
 * reads (issue #2852 added a DESTINATION flag, not a shape one): the path where
 * the
 * secrets map can be EMPTY by construction (nothing was resolved), so the value
 * scan has no needles and POSITION is the only mechanism left. Derived from the
 * flags rather than compared against the constant so a future one with the same
 * shape is covered automatically. `trustAnyExpression` says the source is a
 * persisted record (holding no PUBLIC reference, so any `{{resolve:...}}` in it
 * is by construction a secret); `!descendArrays` says the bag came back from
 * AWS and may be reordered.
 *
 * `sourceIsSameGeneration` is the third conjunct and it is the one that took a
 * measurement to get right. Without it this also selected
 * {@link STATE_SOURCED_CROSS_GENERATION_RULES} — `cdkd scrub`'s observed walk,
 * whose `properties` have ALREADY been repositioned onto TODAY's template — and
 * taking a source subtree there rewrote a baseline holding the DEPLOYED
 * `:AWSPREVIOUS` reference onto the template's edited `:AWSCURRENT` one. That
 * is precisely the issue #1917 hazard, and `cdkd drift --revert` pushes the
 * baseline to AWS, so it would have applied a reference the stack never
 * deployed. A refusal may only take a source that is the same generation as the
 * bag beside it.
 *
 * A TEMPLATE-sourced caller is deliberately excluded: its source can carry a
 * public `ssm:` reference whose resolved value must STAY resolved (issue
 * #1901), and it always has a populated map, so the value scan already covers
 * the shapes below. So is the rollback replay
 * ({@link STATE_DERIVED_RULES}) — full map, and its bag descends positionally
 * because it was produced by resolving the source.
 */
export function isReadbackProjectedFromState(rules: PathSourceRules): boolean {
  return rules.trustAnyExpression && !rules.descendArrays && rules.sourceIsSameGeneration;
}

/**
 * Does this subtree carry a dynamic reference anywhere?
 *
 * A BOOLEAN, not the occurrence COUNTS an earlier revision collected. The
 * counts existed to decide whether a bag "covered" every reference its source
 * carried, which was the vouching rule for taking a source array wholesale —
 * and that rule is gone (see the array arm), so counting would be a
 * measurement nothing reads.
 */
export function subtreeHasDynamicReference(value: unknown): boolean {
  if (isDynamicReferenceString(value)) return true;
  if (Array.isArray(value)) return value.some(subtreeHasDynamicReference);
  if (isPlainObject(value)) return Object.values(value).some(subtreeHasDynamicReference);
  return false;
}

/**
 * Could the comparator's dotted `path` also be spelled, in `bag`, through an
 * own key that itself contains a dot? Walks own keys as far as `bag` goes; at
 * each level a dotted key equal to, or a dotted prefix of, the rest of the
 * path makes the coordinate ambiguous. Exported so the drift report can ask it
 * of the OBSERVED baseline too, where a readback-only dotted key can sit.
 */
export function pathCrossesDottedKey(bag: unknown, path: string): boolean {
  const segments = path.split('.');
  let cursor: unknown = bag;
  for (let i = 0; i < segments.length; i++) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return false;
    const rest = segments.slice(i).join('.');
    for (const key of Object.keys(cursor)) {
      if (key.includes('.') && (rest === key || rest.startsWith(`${key}.`))) return true;
    }
    if (!Object.hasOwn(cursor, segments[i]!)) return false;
    cursor = (cursor as Record<string, unknown>)[segments[i]!];
  }
  return false;
}

/**
 * Could a {@link SECRET_MASK} in an `observedProperties` baseline at the dotted
 * `path` be an UNCERTIFIED-POSITION mask (issue
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852)'s fail-closed refusal)
 * rather than a `NoEcho` custom-resource mask (issue
 * [#2274](https://github.com/go-to-k/cdkd/issues/2274))? Issue
 * [#3595](https://github.com/go-to-k/cdkd/issues/3595).
 *
 * Answered from the record's own `properties` — the SOURCE the refusal was
 * positioned against — because nothing in the record names the mask's class.
 * The two classes differ in where they land: a fail-closed mask is written
 * into `observedProperties` only, at a position whose source spells a dynamic
 * reference; a `NoEcho` mask is persisted into `properties` too, since there is
 * no expression to store in its place. So:
 *
 * - the node `properties` holds at `path` must carry a `{{resolve:` string (a
 *   raw `Fn::Join` object embedding one counts) and NO mask leaf; or
 * - where `properties` has no node at `path` — the readback reshaped a scalar
 *   the template spells as a reference into a container, and the comparator
 *   reported a key below it — the deepest node it DOES have on the path must be
 *   a STRING carrying a `{{resolve:`.
 *
 * An ancestor OBJECT whose sibling carries a reference is deliberately NOT
 * enough: a `NoEcho` plaintext echoed into a readback-only key beside a
 * templated reference would then read as the fail-closed class.
 *
 * `path` is the drift comparator's coordinate: object keys joined by `.`, never
 * an array index (it compares arrays whole). Own keys only, for the reason
 * `drift.ts`'s `getAtPath` gives. Homed here, beside the redaction that
 * writes the mask, so any later writer-side check asks the SAME question.
 */
export function isUncertifiedBaselineMaskPosition(
  properties: Record<string, unknown>,
  path: string
): boolean {
  // A KEY containing a dot is one segment to the comparator but several here,
  // so the path is AMBIGUOUS wherever such a key could spell the rest of it —
  // and the walk could stop at a sibling string without seeing a mask the real
  // node carries. Fail closed: an ambiguous position keeps the `NoEcho`
  // disposition.
  if (pathCrossesDottedKey(properties, path)) return false;
  let cursor: unknown = properties;
  for (const segment of path.split('.')) {
    if (typeof cursor === 'string') break;
    if (
      cursor === null ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      !Object.hasOwn(cursor, segment)
    ) {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor === 'string') {
    return isDynamicReferenceString(cursor) && cursor !== SECRET_MASK;
  }
  return subtreeHasDynamicReference(cursor) && !carriesSecretMask(cursor);
}

/**
 * Every complete `{{resolve:...}}` token inside a string.
 *
 * This was a FOURTH spelling of the token pattern (`[^{}]*`, global) and is
 * built from {@link DYNAMIC_REFERENCE_INNER} since issue #1936, so it agrees
 * with the resolver like every other predicate here.
 *
 * EXPORTED, and `drift.ts`'s `survivingDynamicReferences` calls it rather than
 * re-spelling the scan (issue #2088 review). The character CLASS was shared
 * from #1936, but the assembled PATTERN was still byte-duplicated in the two
 * files — which is how a later flag or anchor change re-forks exactly the way
 * the four spellings did.
 *
 * The pattern is a module-level constant. An earlier revision built a fresh
 * `RegExp` per call, justified as "a shared global instance carries
 * `lastIndex` between callers" — that is FALSE for this use and was measured:
 * `String.prototype.match` with a `/g` pattern sets `lastIndex` to 0 on entry
 * and leaves it 0, so no state crosses callers. The per-call construction was
 * compiling a pattern per string leaf at the persist choke point, which walks
 * every record. Do NOT call `.exec` / `.test` on this constant — those DO
 * advance `lastIndex`, which is exactly why the shared instance is safe only
 * for `.match`. (ONE site does, `resolvableReferenceSpans`, and it resets
 * `lastIndex` to 0 in the statement after the `exec`.)
 *
 * Widening it changes one answer, in the SAFE direction for BOTH readers.
 *
 * `drift.ts`'s `survivingDynamicReferences` is the reader that is easy to
 * forget, because it lives in another file — it feeds the survivor REPORT
 * (`onUnresolved`, and through it the `unresolvedToken` cause), so seeing MORE
 * tokens can only report more, never less. Do not shorten this to "the only
 * reader": that sentence is what a later editor uses to bound the blast
 * radius of touching the class, and getting it wrong points them away from
 * the report / `--json` / `--accept` path where an unreported survivor would
 * surface.
 *
 * The other reader is the DECLARED direction for issue #1901:
 * {@link mixedLeafMayCarryPublicReference}, which asks whether a MIXED leaf
 * embeds a `{{resolve:ssm:` token the verdict store does not know. A token
 * carrying a `{` inside it used to be INVISIBLE here, so such a leaf was
 * always treated as secret-bearing and the source expression was substituted
 * over the resolved value. Now it is seen and classified by the same rule as
 * every other token — which, on a POPULATED map, means a genuinely public ssm
 * parameter keeps the resolved value it is supposed to keep.
 */
export const DYNAMIC_REFERENCE_TOKEN_SCAN = new RegExp(
  `\\{\\{resolve:${DYNAMIC_REFERENCE_INNER}\\}\\}`,
  'g'
);

export function dynamicReferenceTokens(value: string): string[] {
  return value.match(DYNAMIC_REFERENCE_TOKEN_SCAN) ?? [];
}

/**
 * Where each complete `{{resolve:...}}` token sits in the string, as
 * `[start, end)` offsets. The OFFSETS are what {@link dynamicReferenceTokens}
 * cannot give, and the value scan needs them to decide whether a needle match
 * lies inside a reference or merely beside one.
 *
 * `lastIndex` is reset before `matchAll`, and that is load-bearing rather than
 * defensive. `String.prototype.matchAll` does not MUTATE the pattern's
 * `lastIndex` — it clones — but it SEEDS the clone from it, so a caller that
 * left the shared constant dirty (the constant's own doc forbids `.exec` /
 * `.test` on it for exactly this reason) would make this function skip every
 * span before that offset, silently restoring the splice this offsets are used
 * to prevent. Measured, not assumed.
 */
export function dynamicReferenceSpans(value: string): Array<{ start: number; end: number }> {
  DYNAMIC_REFERENCE_TOKEN_SCAN.lastIndex = 0;
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(DYNAMIC_REFERENCE_TOKEN_SCAN)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * Does this MIXED leaf embed a reference that may be PUBLIC config?
 *
 * A plain `{{resolve:ssm:...}}` is classified by the parameter's TYPE, not by
 * its spelling (issue #1901): a `String` / `StringList` parameter is public and
 * is legitimately persisted RESOLVED. Substituting the expression over it gives
 * the drift baseline a value AWS does not hold, which is phantom drift on
 * ordinary config — and `--revert` then pushes the literal expression.
 *
 * `trustAnyExpression` is what would otherwise wave this through, and its
 * premise ("a persisted STATE bag holds no public expression") is documented as
 * FALSE in one place: `cdkd import`'s warn path can leave one there. The
 * whole-token arm accepts that risk knowingly and `cdkd drift --accept`
 * re-checks its write; the MIXED arm added later has no such re-check, so it
 * declines instead.
 *
 * A reference the resolver RECORDED as secret is kept: that is the ssm
 * `SecureString` case, where the verdict came off the same `GetParameter`
 * response that carried the value. `{{resolve:ssm-secure:` does not match this
 * prefix at all (the next character is `-`), so it is never refused here.
 *
 * The verdict store only carries signal where something RESOLVED, so this
 * splits on whether a secrets map exists at all.
 *
 * WITH a map, a pass resolved this bag: the engine's change detection walks
 * every template property with `skipDynamicReferences`, which only flips
 * `decrypt` on the ssm branch — the `GetParameter` still runs, a definitive
 * `SecureString` is recorded, and a parameter that comes back public has its
 * memo RETRACTED. Absence from the store is then real evidence of a public
 * parameter, and the resolved value is kept.
 *
 * WITHOUT one, absence means only that the question was never asked HERE. It
 * does not mean nothing was resolved: the deploy path resolves every template
 * property with `skipDynamicReferences`, which records or retracts the
 * `SecureString` verdict even for an UNCHANGED resource -- that bag simply is
 * not the one this call receives. The leaf is treated as
 * secret-bearing and refused. That is not merely the cautious branch, it is the
 * SAME premise the whole-token arm one level up already acts on: a PUBLIC
 * `String` / `StringList` reference is persisted RESOLVED (issue #1901), so a
 * `{{resolve:ssm:` token that SURVIVES in a persisted state bag is a
 * SecureString by construction. An earlier revision applied a stricter rule to
 * a MIXED leaf than to a whole token on the identical source, and that
 * inconsistency is what persisted a decrypted secret.
 *
 * NOT CLOSED here. Issue
 * [#2036](https://github.com/go-to-k/cdkd/issues/2036) tracks the price this
 * refusal pays: a genuinely PUBLIC ssm mixed leaf is OVER-redacted on the
 * empty-map paths, so the baseline no longer matches AWS. Giving the empty-map
 * path POSITIVE evidence (a store of PROVEN-public verdicts, which the
 * resolver's own `pinSecretVerdict` retraction already computes) was drafted in
 * PR #2415 and WITHDRAWN there: such a store is keyed on the bare expression
 * and lives for the whole process, so on a `cdkd deploy --all` spanning regions
 * a verdict recorded where the parameter is a plain `String` un-redacts a
 * SecureString of the same name in another region — measured, and the
 * un-redacting direction, which is worse than the over-redaction it fixes. Any
 * revival must key the verdict by SCOPE (region + account) at the READ side.
 *
 * The residual is therefore the whole population an empty map describes, which
 * is the state issue #2036 records. Refusing is still the right way to be wrong
 * here: under-redaction persists a decrypted secret, a disclosure and the thing
 * this lane exists to prevent, while over-redaction is visible, recoverable and
 * discloses nothing.
 *
 * `tests/integration/secrets-dynamic-ref` is the end-to-end proof, and it is
 * the only place the empty-map defect surfaced — every unit assertion passed.
 * Three of its phases pin a DIFFERENT map state for the same two leaves, which
 * is what makes the split observable rather than asserted: Phase 1 is the
 * populated-map deploy (the resource is being created), Phase 1g the EMPTY-map
 * deploy (the resource is UNCHANGED, so it has no per-resource map but the
 * resolver has still classified the parameter this run), and Phase 1f the
 * empty-map command, which classifies nothing and therefore still refuses. An
 * earlier revision of this sentence called Phase 1g the populated-map case,
 * which is the opposite of what that phase is built to reach.
 */
export function mixedLeafMayCarryPublicReference(
  source: string,
  secrets: RecordedSecretValues
): boolean {
  // NO MAP, NO EVIDENCE — so this cannot answer, and it must not pretend to.
  // `isRecordedSecretExpression` only ever says "yes" about a token some pass
  // RESOLVED, and the empty-map paths resolve nothing by construction (issue
  // #1926's own design decision). Reading absence as "public" there turned
  // every `{{resolve:ssm:` mixed leaf into a public one and persisted the
  // DECRYPTED SecureString — measured by the `secrets-dynamic-ref` integ, which
  // is the only place it showed: every unit assertion passed.
  if (secrets.size === 0) return false;
  return dynamicReferenceTokens(source).some(
    (token) => token.startsWith('{{resolve:ssm:') && !isRecordedSecretExpression(token)
  );
}

/**
 * Does this value carry an ORDINARY object prototype?
 *
 * `isPlainObject` answers `typeof === 'object' && !Array.isArray`, which admits
 * CLASS INSTANCES, and that is a hole under {@link deepEqualJsonValue}: an AWS
 * SDK v3 readback reaching `drainObservedCaptures` is PRE-JSON and really does
 * carry `Date` values (`LastModified`, `CreationDate`). `Object.keys(new
 * Date())` is `[]`, so without this check a `Date` compared equal to `{}` and
 * to every other `Date` -- an anchor that corroborates a pairing while proving
 * nothing. Widening `isPlainObject` itself was rejected: it is read by three
 * other walks whose behaviour would change with it, and the defect is in what
 * EQUALITY means here, not in what counts as a container.
 *
 * A `Date` anchor now corroborates NOTHING, so an element carrying one refuses
 * rather than pairs. That is the conservative direction this module always
 * takes -- the residual stays a refusal -- and it is stated because the
 * opposite reading (that a `Date` on both sides is evidence) is the one a
 * future edit will be tempted by.
 */
export function hasPlainPrototype(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Is this a `Date` the value scan may return BY IDENTITY (issue
 * [#2427](https://github.com/go-to-k/cdkd/issues/2427))?
 *
 * The scan redacts what PERSISTS, and `JSON.stringify` persists an unmodified
 * `Date` as `Date.prototype.toJSON`'s ISO timestamp (or `null`) — never its own
 * entries. So the only thing to scan is that timestamp — the walk runs it
 * through the string arms and keeps the `Date` only when they leave it alone —
 * and rebuilding it just threw the timestamp away. "Unmodified" is three
 * conjuncts, each closing a shape whose persisted form is NOT that timestamp:
 * the EXACT prototype, a real `[[DateValue]]` (the `getTime` brand check, which
 * a `Proxy` or an `Object.create(Date.prototype)` fails), and NO own keys — an
 * own `toJSON` (enumerable or not) is what `JSON.stringify` would call instead.
 * No SDK readback or `JSON.parse` produces any of those; they are refused
 * because the identity return must mean exactly "persists as a timestamp".
 *
 * Deliberately NOT "any non-plain object". `JSON.stringify` persists an
 * arbitrary class instance's OWN ENUMERABLE fields, which is exactly what the
 * rebuild scans, so returning one by identity would persist a plaintext held in
 * such a field — a disclosure, traded for fidelity. A `Uint8Array` persists as
 * the same `{"0":...}` either way. The EXACT prototype (not `instanceof`) keeps
 * a `Date` subclass on the rebuild: its prototype can override `toJSON`, which
 * the rebuild drops and identity would honour. A cross-realm `Date` fails the
 * test too, which is the old flattening rather than a leak.
 */
export function isOrdinaryDate(value: object): value is Date {
  if (Object.getPrototypeOf(value) !== Date.prototype) return false;
  try {
    Date.prototype.getTime.call(value);
  } catch {
    return false;
  }
  return Reflect.ownKeys(value).length === 0;
}

/**
 * Structural equality over the JSON shapes this module walks (issue #2012).
 *
 * Own ENUMERABLE keys only, and a key count on both sides, so an inherited
 * field is not equality and neither is a bag that merely CONTAINS the source's
 * keys. That agrees with the two walks beside it -- `isUniquelyKeyedBy` and the
 * object arm of {@link refuseUncertifiedReadbackPositions} both use
 * `Object.hasOwn` -- and it matters here rather than being hygiene: this
 * predicate is the evidence an anchor pairing rests on, so a comparison that
 * reads the prototype chain would let a constructed bag corroborate a pairing
 * it does not actually match.
 *
 * `JSON.stringify` was the obvious alternative and is wrong twice over: it is
 * key-ORDER sensitive (an AWS readback routinely reorders object keys, which
 * says nothing about the values) and it silently drops `undefined`, so
 * `{A: undefined}` and `{}` would compare equal while their key counts differ.
 */
export function deepEqualJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqualJsonValue(item, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    // See {@link hasPlainPrototype}: a `Date` has no own keys, so without this
    // the key-count arm below reports it equal to `{}` and to any other `Date`.
    if (!hasPlainPrototype(a) || !hasPlainPrototype(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.hasOwn(b, k) && deepEqualJsonValue(a[k], b[k]));
  }
  return false;
}
