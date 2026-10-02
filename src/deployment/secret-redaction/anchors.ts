import {
  isPlainObject,
  isDynamicReferenceString,
  MIN_NEEDLE_LENGTH,
  isSingleDynamicReferenceToken,
  type PathSourceRules,
} from './rules.js';
import {
  subtreeHasDynamicReference,
  deepEqualJsonValue,
  dynamicReferenceSpans,
  DYNAMIC_REFERENCE_TOKEN_SCAN,
  hasPlainPrototype,
  isReadbackProjectedFromState,
} from './redact-path.js';
import { isRecordedSecretExpression } from './mask-only.js';
import { singleSpanFrame } from './positions.js';
import { type RecordedSecretValues } from './pairs.js';
import { refuseUncertifiedReadbackPositions } from './redact-state.js';

/**
 * Is an equal SOURCE value at an anchor position actually EVIDENCE that the two
 * containers describe the same element?
 *
 * A NON-EMPTY STRING is, and deliberately nothing else is. This is the same bar
 * {@link isUniquelyKeyedBy} already applies to an identity field, and for the
 * same reason: `''` is not a distinguishing value (it is also why the value
 * scan refuses it as a needle), and a non-string carries so few inhabitants
 * that equality is nearly free -- `{Name: 1, Value: <literal>}` and `{Name: 1,
 * Value: <expression>}` agree on `Name` whether or not they are the same entry,
 * so pairing on it would copy a secret reference onto an unrelated literal.
 * Both shapes are pinned in `secret-redaction-array-identity.test.ts` on the
 * IDENTITY arm and again in `secret-redaction-anchor-pairing.test.ts` on this
 * one; an anchor that accepted them would reopen from the positional side
 * exactly what that arm refuses.
 *
 * Containers count when something inside them does, so a nested literal object
 * can anchor a pairing its own level cannot. That recursion is also why this
 * predicate ALONE is not enough, and the review that measured it is worth
 * recording: `AWS::AmazonMQ::Broker.Users` renders `Groups: ['admin']`
 * identically on every element, which is distinguishing by this test and yet
 * tells two users APART not at all. Distinguishing is a property of ONE value;
 * telling elements apart is a property of the WHOLE array, and
 * {@link unkeyedArrayPairsByAnchors} is where the second one is enforced.
 *
 * This is a REFINEMENT of the formulation recorded on issue #2012, which said
 * only "every position whose SOURCE carries no dynamic reference is deep-equal
 * on both sides". Taken literally that admits a pairing corroborated ONLY by
 * `Name: ''` or `Name: 1`, which is measurably wrong: the counterexample the
 * issue states (`{Name:'', Value:'lit'}` against `{Name:'db', Value:<expr>}`)
 * has DIFFERING names and refuses on inequality alone, but the fence actually
 * in the tree carries `Name: ''` on BOTH sides, where equality holds and only
 * this predicate stands between an unrelated literal and a false redaction.
 */
function isDistinguishingAnchor(value: unknown): boolean {
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.some(isDistinguishingAnchor);
  if (isPlainObject(value)) return Object.values(value).some(isDistinguishingAnchor);
  return false;
}

/**
 * Stands in for a reference-bearing leaf inside an {@link anchorSignature}.
 *
 * Written UNQUOTED while `JSON.stringify` quotes every real string, so no
 * literal can spell it and collide with a masked reference.
 */
const ANCHOR_REFERENCE_MASK = '<ref>';

/**
 * The part of a SOURCE element the anchors can actually see: the element with
 * every reference-bearing leaf masked, serialized canonically.
 *
 * Two elements with the same signature are INDISTINGUISHABLE to this pass --
 * the anchors say the same thing about both -- so a permutation swapping them
 * preserves every anchor and the alignment is not determined. That is the
 * property {@link isUniquelyKeyedBy} enforces for an identity FIELD, restated
 * for a whole projection instead of a single key.
 *
 * The signature is ORDER-INSENSITIVE in both directions -- object keys AND list
 * elements are sorted -- and that is not cosmetic normalisation. Rule 3's
 * question is "could AWS hand these two elements back SWAPPED without the swap
 * being visible", so the projection has to quotient by everything AWS may
 * itself reorder. Outer list order is the gate's own subject; order WITHIN an
 * anchor's list is this function's, for exactly the reason `descendArrays:
 * false` exists at all. A first cut sorted only the keys, and the security
 * review measured the hole on `AWS::AmazonMQ::Broker.Users`: two users whose
 * `Groups` were `['admin','ops']` and `['ops','admin']` signed DIFFERENTLY, so
 * rule 3 passed while the anchors still deep-equalled position for position,
 * and a reordered `DescribeBroker` put the admin's `Username` / `Password`
 * expressions at the app user's index. Byte-identical anchor content was being
 * assumed -- the order assumption this module refuses everywhere else.
 *
 * Sorting FAILS CLOSED, which is why it is the right shape of fix: it can only
 * make two signatures COLLIDE that previously differed, never the reverse, so
 * its only possible effect is an extra refusal. A missed closure, never a leak.
 *
 * The asymmetry with {@link deepEqualJsonValue} is deliberate and must survive
 * a reader who notices it. That predicate stays order-SENSITIVE on lists
 * because rule 1 asks a different question -- "did AWS return THIS position
 * unchanged" -- and a reordered list is a changed position. Making rule 1
 * order-blind too would weaken the corroboration rather than align it; the case
 * pinning that is `REFUSES an anchor list REORDERED in place` in
 * `secret-redaction-anchor-pairing.test.ts`.
 */
function anchorSignature(source: unknown): string {
  if (isDynamicReferenceString(source)) return ANCHOR_REFERENCE_MASK;
  // ORDER-INSENSITIVE, and this sort is load-bearing rather than tidiness --
  // see the doc above before removing it.
  if (Array.isArray(source)) return `[${source.map(anchorSignature).sort().join(',')}]`;
  if (isPlainObject(source)) {
    return `{${Object.keys(source)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${anchorSignature(source[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(source) ?? 'undefined';
}

/**
 * ANCHOR PAIRING (issue #2012): do these two containers corroborate each other
 * position by position?
 *
 * Two conditions, both required:
 *
 * 1. every SOURCE key is present in the bag (objects) or the index counts match
 *    (arrays) — see the object arm for why containment rather than equality,
 *    and which of the two directions is the fabrication guard, and
 * 2. every position whose SOURCE carries no dynamic reference is deep-equal on
 *    both sides -- the *anchors*.
 *
 * Anchors are what make the pairing EVIDENCE rather than a guess: a position
 * AWS did not rewrite proves the two containers describe the same element. It
 * answers the `descendArrays: false` objection on its own terms the way keying
 * does -- a REORDERED list normally puts a different element under each index,
 * so its anchors stop matching and the whole array is refused.
 *
 * "Normally" is doing real work in that sentence, and an earlier revision of it
 * did not have the word. A reorder is INVISIBLE to the anchors when the
 * elements it swaps look the same to them, which is the whole subject of
 * {@link unkeyedArrayPairsByAnchors}. This function answers only "does position
 * i corroborate position i"; whether the array as a whole may be walked at all
 * is decided there, and nothing here is sufficient on its own.
 *
 * What it deliberately CANNOT buy is baseline content. Every substitution the
 * caller then makes is a STRING leaf at a position the bag already has, so a
 * corroborated pairing never adds a key, adds an element, or writes a scalar
 * over a container. The principle this module is built on -- **redaction may
 * not buy itself a fabricated baseline** -- is preserved structurally rather
 * than by a special case, which is what the first attempt at these rows (taking
 * the SOURCE array wholesale) failed to do.
 *
 * The cost, stated rather than discovered: one deep compare per candidate
 * position, and a yield that drops to ZERO as soon as AWS normalises any
 * sibling field in the same container. That is common, so this closes a SUBSET
 * of the shapes issue #2012 lists rather than all of them, and the residual
 * stays a refusal -- which is the correct direction to be wrong in here.
 */
function anchorsCorroboratePairing(
  bag: unknown,
  source: unknown,
  anchors: { distinguishing: number }
): boolean {
  // An ANCHOR position: the source spells no reference here, so AWS's own value
  // must match it exactly. Inequality is positive evidence the two containers
  // are NOT the same element, which is what refuses the counterexamples.
  if (!subtreeHasDynamicReference(source)) {
    if (!deepEqualJsonValue(bag, source)) return false;
    if (isDistinguishingAnchor(source)) anchors.distinguishing += 1;
    return true;
  }
  // A reference-bearing STRING leaf -- the position a corroborated pairing
  // exists to reach. The bag must still be a string: the caller refuses to
  // write a scalar over a container, and admitting one here would hand it a
  // pairing whose only reference-bearing position it must then decline.
  //
  // PRE-EXISTING and out of scope, recorded because this arm makes it reachable
  // somewhere new: `isDynamicReferenceString` is a SUBSTRING test for
  // `{{resolve:`, so a source LITERAL such as `'not a real {{resolve: token'`
  // is classed reference-bearing. It is therefore exempt from the deep-equality
  // an anchor would demand -- lowering the corroboration bar for its whole
  // container -- and is then written over whatever the readback holds. The
  // string arm of `refuseUncertifiedReadbackPositions` has always done this;
  // tightening the predicate moves every caller of it at once and belongs in
  // its own change rather than riding along here.
  if (isDynamicReferenceString(source)) return typeof bag === 'string';
  if (isPlainObject(source)) {
    if (!isPlainObject(bag)) return false;
    // CONTAINMENT, not equality: every SOURCE key must be present and must
    // corroborate, while a key only the BAG carries is allowed (issue #2036 /
    // #2012's row 6). The two directions are not symmetric and only one of them
    // was ever load-bearing:
    //
    //  - a source key the bag LACKS still refuses, on `Object.hasOwn` below.
    //    That is the fabrication direction — it is how an AWS-reported
    //    `[{Value:'x'}]` was stopped from becoming `[{Name:'db', Value:<expr>}]`
    //    — and nothing here relaxes it.
    //  - a bag key the source lacks used to refuse too, on a key-COUNT
    //    comparison. It bought nothing: the caller's walk maps over the BAG's
    //    keys and takes a source leaf only where `Object.hasOwn(source, k)`, so
    //    an extra bag key can neither be overwritten nor fabricated. What it
    //    cost was the whole element — an AWS readback ROUTINELY adds fields
    //    (`Arn`, `LastModified`, a defaulted flag), so one such field refused
    //    the pairing and every secret INSIDE that element kept its plaintext.
    //
    // The corroboration argument is unchanged by the relaxation, which is the
    // part worth checking rather than asserting. Rule 1's anchors are the
    // positions the SOURCE spells without a reference; an extra bag key is not
    // one of them, so it neither adds nor removes an anchor. Rule 3's
    // {@link anchorSignature} is computed on SOURCE elements alone, so
    // distinguishability is untouched. A permutation is still refused by the
    // anchors it breaks.
    //
    // Do NOT weaken this into "skip a missing bag key": that is a different
    // edit, it removes the fabrication guard, and it is the one the issue #2012
    // review measured as re-opening the false redaction that killed the first
    // attempt at these rows.
    const sourceKeys = Object.keys(source);
    return sourceKeys.every(
      (k) => Object.hasOwn(bag, k) && anchorsCorroboratePairing(bag[k], source[k], anchors)
    );
  }
  if (Array.isArray(source)) {
    if (!Array.isArray(bag) || bag.length !== source.length) return false;
    return source.every((item, i) => anchorsCorroboratePairing(bag[i], item, anchors));
  }
  return false;
}

/**
 * May this UNKEYED array be walked positionally? The gate the anchor relaxation
 * actually rests on (issue #2012 review).
 *
 * {@link anchorsCorroboratePairing} answers per POSITION. Asking it once for
 * the whole array and requiring one distinguishing anchor ANYWHERE in the
 * result -- which an earlier revision did -- is unsound in two INDEPENDENT
 * ways, both measured by review against real shapes rather than reasoned about:
 *
 * - **Evidence for one element was credited to another.** `[{Name:'db',
 *   Value:<exprA>}, {Name:'', Value:<exprB>}]` has a distinguishing anchor at
 *   index 0 and NONE at index 1, and the array-wide counter licensed both -- so
 *   an unrelated literal at index 1 took `<exprB>`. That is precisely the false
 *   redaction `isDistinguishingAnchor` exists to prevent, arriving through the
 *   counter's SCOPE instead of through its definition.
 * - **Equal anchors cannot detect a reorder.** `['--pw', <exprA>, '--pw',
 *   <exprB>]` against a readback holding the two values swapped matches every
 *   anchor at every index, because both anchors are `'--pw'` -- so each
 *   position was pinned to the OTHER secret's expression.
 *   `AWS::AmazonMQ::Broker.Users` is the shape that makes this real rather than
 *   contrived: no `Name`/`Key`, both `Username` and `Password` rendered through
 *   `secretValueFromJson`, and `Groups: ['admin']` equal on every element, so a
 *   `DescribeBroker` returning the users in the other order records the ADMIN
 *   credential's reference at the app user's position -- which `cdkd drift
 *   --revert` then pushes to the live broker.
 *
 * So the gate is:
 *
 * 1. **Every position corroborates**, with the counter scoped PER top-level
 *    element rather than shared across the array.
 * 2. **Every reference-bearing element carries its own evidence.** A CONTAINER
 *    must hold a distinguishing anchor INSIDE it: it has an interior where an
 *    identity could live, so the absence of one is meaningful. A BARE reference
 *    leaf has no interior, so absence says nothing about it and the only
 *    evidence available is the FRAME -- the array's non-reference-bearing
 *    elements, which must then supply a distinguishing anchor between them.
 *    That distinction is exactly what separates `['--pw', <expr>, '--verbose']`
 *    (CLOSES: the literal flags pin the one free slot) from `[{V:'us-east-1'},
 *    {V:<expr>}]` (REFUSES: the second element could hold anything, and
 *    overwriting it would erase a genuine out-of-band change from the drift
 *    baseline, so `cdkd drift` reports clean and `--revert` never sees it).
 * 3. **Reference-bearing elements are pairwise DISTINGUISHABLE**, by
 *    {@link anchorSignature}. Two elements the anchors describe identically
 *    admit a permutation that preserves every anchor, so the alignment is not
 *    determined and no amount of per-position equality makes it so.
 *
 * Checking uniqueness on the SOURCE side alone is sufficient, and the argument
 * is worth stating because the bag side looks like it needs checking too: rule
 * 1 has already established that the bag matches the source at every anchor
 * position, so the two projections are equal element-wise. If some permutation
 * other than the identity also satisfied the anchors, two SOURCE elements would
 * have to share a signature -- which rule 3 excludes. This is the same
 * multiset-correctness argument `isUniquelyKeyedBy` makes for a single field.
 *
 * NESTED arrays are not re-checked here, and do not need to be: the caller
 * recurses through {@link refuseUncertifiedReadbackPositions}, which re-enters
 * its own array arm for every nested list and consults this gate again with
 * that list's own elements. A nested array whose elements are indistinguishable
 * is therefore refused on its own terms while its parent may still pair.
 */
export function unkeyedArrayPairsByAnchors(
  bag: readonly unknown[],
  source: readonly unknown[]
): boolean {
  if (bag.length !== source.length) return false;

  const distinguishingPerElement: number[] = [];
  for (const [i, item] of source.entries()) {
    const anchors = { distinguishing: 0 };
    if (!anchorsCorroboratePairing(bag[i], item, anchors)) return false;
    distinguishingPerElement.push(anchors.distinguishing);
  }

  // The FRAME: elements the source spells with no reference at all. The loop
  // above has already proved each one deep-equal to its bag counterpart, so
  // these are the positions AWS demonstrably did not rewrite.
  const frameDistinguishing = source.reduce<number>(
    (total, item, i) =>
      subtreeHasDynamicReference(item) ? total : total + distinguishingPerElement[i]!,
    0
  );

  const signatures = new Set<string>();
  for (const [i, item] of source.entries()) {
    if (!subtreeHasDynamicReference(item)) continue;

    const signature = anchorSignature(item);
    if (signatures.has(signature)) return false;
    signatures.add(signature);

    if (distinguishingPerElement[i]! > 0) continue;
    // No evidence of its own. Only a BARE reference leaf may fall back on the
    // frame; a container with no distinguishing anchor inside it had somewhere
    // to carry one and did not.
    if (!isDynamicReferenceString(item) || frameDistinguishing === 0) return false;
  }
  return true;
}

/**
 * Marks a position one of the POSITION passes DECIDED, in the parallel tree
 * {@link refuseUncertifiedReadbackPositions} builds when asked to `mark`.
 *
 * A SENTINEL rather than a value comparison, and that distinction was a
 * security blocker on PR #2415. {@link preferPositionDecisions} first inferred
 * "not decided" from `refused === bag`, which cannot tell an UNDECIDED position
 * from one the pass decided IN FAVOUR of the value already there. Two shapes
 * hit it, both fabricating a baseline `cdkd drift --revert` then pushes:
 *
 * - the resolver's unsupported-service arm leaves a `{{resolve:...}}` token it
 *   has no arm for LITERAL (`ssm-secure:` was one until issue #2482), so AWS
 *   echoes it back and the source leaf EQUALS the bag leaf. The string arm
 *   returns `source` — a decision — and the equality made it look like no
 *   decision at all. (A BARE such token takes the whole-token arm and one
 *   embedded in text takes the mixed-leaf arm; both decide, and both were
 *   misread.)
 * - the empty-map arm that deliberately KEEPS a leaf returns `bag` by design.
 *
 * A symbol cannot be produced by any walk of JSON, so no readback value can
 * impersonate it.
 */
export const POSITION_DECIDED = Symbol('position decided by a position pass');

/**
 * Marks a STRING leaf {@link refuseUncertifiedReadbackPositions} REFUSED — a
 * position whose source subtree proves a dynamic reference lives there while
 * the walk could not pair the two sides, so the readback value at it may be a
 * decrypted secret (issue
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852)).
 *
 * A THIRD state, not a second spelling of {@link POSITION_DECIDED}, and the
 * difference is what keeps the fail-closed change from REGRESSING the derived
 * needles issue #2012 added. `POSITION_DECIDED` tells
 * {@link preferPositionDecisions} "this leaf is mine, the scan may not touch
 * it"; a refusal makes the opposite claim — the pass has NO answer here, only
 * the knowledge that the raw value is unsafe. So the scan still gets to win at
 * such a leaf (a derived needle NAMES the expression, which is strictly better
 * than a mask), and the mask stands only where nothing else spoke.
 */
export const POSITION_UNCERTIFIED = Symbol('position refused by a position pass');

/**
 * The (plaintext -> expression) pairs a LEARN pass has established, plus the
 * plaintexts it refuses to speak for.
 *
 * `poisoned` is not bookkeeping — it is the {@link recordedSecretExpressions}
 * collapse (issue #1910) arriving through this door. The map is keyed by the
 * resolved PLAINTEXT, so two expressions that resolve to the same value would
 * silently keep the last one learned and every OTHER occurrence of that value
 * in the record would take a SIBLING's expression. `cdkd drift --revert` and
 * `resolveReplayProps` both re-resolve a persisted expression against the live
 * resource, so that is a wrong-reference write, not a cosmetic mislabel. A
 * plaintext learned twice with two expressions is therefore struck out for the
 * rest of the record and the residual stays a refusal.
 */
export interface DerivedNeedleCollector {
  readonly needles: Map<string, string>;
  readonly poisoned: Set<string>;
  /**
   * Plaintexts whose secret-ness is INFERRED rather than spelled, so they may
   * only ever rewrite a WHOLE leaf — see {@link expressionSecretIsInferred}.
   */
  readonly inferred: Set<string>;
}

/**
 * Record one (plaintext -> expression) pair, or strike the plaintext out.
 *
 * Below {@link MIN_NEEDLE_LENGTH} nothing is recorded, and this floor DECIDES
 * rather than mirrors. {@link buildNeedleRegex} applies the same threshold, so
 * a short needle is dropped from the SUBSTRING arm either way — but the value
 * scan's other arm is a WHOLE-VALUE lookup (`secrets.get(leaf)`) that matches
 * at ANY length, so without this line a two-character derived plaintext would
 * still rewrite every leaf equal to it. That is the false redaction with a
 * blast radius {@link expressionMaySeedANeedle} exists to bound, arriving by
 * length instead of by provenance: a public config value of `us` or `dev` is
 * exactly the kind of short plaintext a readback carries in a dozen unrelated
 * fields.
 */
function learnNeedle(
  collector: DerivedNeedleCollector,
  plaintext: string,
  expression: string
): void {
  if (plaintext.length < MIN_NEEDLE_LENGTH) return;
  if (collector.poisoned.has(plaintext)) return;
  // Recorded unconditionally, and its POSITION here is not load-bearing:
  // {@link expressionSecretIsInferred} is a pure function of the expression, so
  // a plaintext two DIFFERENT expressions claim is POISONED by the arms below
  // rather than narrowed, and one claimed twice by the SAME expression gets the
  // same class both times. An earlier revision of this comment claimed the early
  // placement made a both-classes plaintext keep the narrower radius; measured,
  // that case does not exist — and believing it would license deleting the
  // poison arm.
  if (expressionSecretIsInferred(expression)) collector.inferred.add(plaintext);
  const already = collector.needles.get(plaintext);
  if (already === undefined) {
    collector.needles.set(plaintext, expression);
    return;
  }
  if (already === expression) return;
  collector.needles.delete(plaintext);
  collector.poisoned.add(plaintext);
}

/**
 * The `{{resolve:<service>:` prefixes whose resolved value IS a secret,
 * whatever the parameter or secret is called.
 *
 * `ssm` is in the list and `ssm-secure` is spelled separately, because
 * `startsWith('{{resolve:ssm:')` is FALSE for `{{resolve:ssm-secure:` — the
 * next character is `-`. The two are disjoint tests, not one with a prefix
 * relationship, which is the trap `mixedLeafMayCarryPublicReference`'s own
 * comment already records from the other direction.
 */
const SECRET_BEARING_REFERENCE_PREFIXES = [
  '{{resolve:secretsmanager:',
  '{{resolve:ssm-secure:',
  '{{resolve:ssm:',
] as const;

/**
 * Does this complete `{{resolve:...}}` token name a service cdkd RESOLVES?
 *
 * The value scan spares a needle match lying inside a token, so that a
 * plaintext coinciding with a real reference's own text is not spliced into
 * it (issue #1935). That protection is owed to a REFERENCE only. A token of
 * any other service is left in place by the resolver, so text inside it is
 * ordinary persisted text, and a recorded plaintext there must be redacted
 * (issue [#2743](https://github.com/go-to-k/cdkd/issues/2743)).
 *
 * Exported for the masked-baseline re-capture (issue #3595), which resolves
 * only such tokens: any other one records no pair, so it cannot certify a
 * position, and handing it to the resolver would only warn on every deploy.
 */
export function spanNamesResolvableService(token: string): boolean {
  return SECRET_BEARING_REFERENCE_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/**
 * The spans of `value` the value scan must not splice a needle into: every
 * complete token of a resolvable service.
 *
 * Two scans, unioned. The ordinary one ({@link dynamicReferenceSpans}) is
 * LEFTMOST, so behind an opener of an unresolvable service it reports one
 * outer span and never sees a REAL reference nested in it — which is exactly
 * the text this module writes when it redacts `{{resolve:<plaintext>}}` to
 * `{{resolve:{{resolve:secretsmanager:...}}}}`. Dropping that outer span
 * alone would leave the nested reference unprotected, and a later pass whose
 * map holds a needle occurring in the reference's own text (`password` is an
 * ordinary JSON key AND an ordinary secret value) would splice into it, again
 * on every pass. The second scan starts only at a resolvable-service opener,
 * so it finds the nested reference — and keeps it only when it is an
 * expression of the pass's own map (see the loop).
 *
 * On a leaf with no unresolvable-service opener the two scans report the same
 * spans, so every leaf issue #1935 protects is answered exactly as before.
 */
export function resolvableReferenceSpans(
  value: string,
  vouchedExpressions: ReadonlySet<string>
): Array<{ start: number; end: number }> {
  const spans = dynamicReferenceSpans(value).filter((span) =>
    spanNamesResolvableService(value.slice(span.start, span.end))
  );
  // No second PATTERN: the token grammar is built in exactly two places in
  // this module (fenced), so the nested scan re-runs the shared one from each
  // resolvable-service opener and keeps a token that starts AT it.
  const starts = new Set(spans.map((span) => span.start));
  for (const prefix of SECRET_BEARING_REFERENCE_PREFIXES) {
    for (let at = value.indexOf(prefix); at >= 0; at = value.indexOf(prefix, at + 1)) {
      // A top-level token of a resolvable service is already protected.
      if (starts.has(at)) continue;
      // ONE `exec` anchored by `lastIndex`, not a re-scan of the tail per
      // opener. `exec` ADVANCES the shared pattern's `lastIndex`, which is why
      // the constant's own doc forbids it; it is reset right after, and every
      // other reader resets or ignores it before use.
      DYNAMIC_REFERENCE_TOKEN_SCAN.lastIndex = at;
      const match = DYNAMIC_REFERENCE_TOKEN_SCAN.exec(value);
      DYNAMIC_REFERENCE_TOKEN_SCAN.lastIndex = 0;
      // `index === at`: an opener with no closer of its own must not borrow
      // the end of a LATER token, which would stretch a protected span over
      // whatever sits between them.
      if (match?.index !== at) continue;
      const end = at + match[0].length;
      // ...and only a nested token this pass can VOUCH for: one that is an
      // expression of the pass's own map, i.e. text this module writes. A
      // nested resolvable-service token is ALSO what a secret assembled one
      // level deeper looks like (`{{resolve:x-{{resolve:ssm:<plaintext>}}}}`,
      // which an older binary persisted), and sparing that is a disclosure,
      // while splicing into an unvouched nested reference only rewrites text
      // that was already unresolvable.
      if (!vouchedExpressions.has(value.slice(at, end))) continue;
      spans.push({ start: at, end });
      starts.add(at);
    }
  }
  return spans;
}

/**
 * The prefixes whose SPELLING settles secret-ness, with no lookup and no
 * inference — the subset of {@link SECRET_BEARING_REFERENCE_PREFIXES} that
 * {@link expressionSecretIsInferred} treats as certain.
 *
 * An ALLOWLIST rather than "the admission list minus `{{resolve:ssm:`", and the
 * difference is what happens to the NEXT entry someone adds. Subtracting makes a
 * new prefix default to CERTAIN, i.e. to the WIDER blast radius, which is the
 * wrong direction to fail in; listing makes it default to inferred until someone
 * deliberately promotes it.
 */
export const SPELLED_SECRET_REFERENCE_PREFIXES = [
  '{{resolve:secretsmanager:',
  '{{resolve:ssm-secure:',
] as const;

/**
 * Is this expression's secret-ness INFERRED rather than spelled?
 *
 * SPELLING, and ONLY spelling. `secretsmanager:` and `ssm-secure:` say what they
 * are, in a way that is true in every region and every account. A bare
 * `{{resolve:ssm:` token is not: it is accepted as secret-bearing on the #1901
 * premise (a public `String` is persisted RESOLVED, so a token SURVIVING in a
 * state bag is a `SecureString`), which is sound for the leaf itself and NOT
 * sound as a licence to rewrite every other leaf that merely CONTAINS the value.
 *
 * A RECORDED verdict deliberately does NOT promote one, even though it is a real
 * `GetParameter` answer. {@link recordedSecretExpressions} is keyed on the bare
 * expression and lives for the whole process, so on a `cdkd deploy --all` a
 * verdict pinned where the parameter is a `SecureString` is inherited where it
 * is a plain `String` — and the `skipDynamicReferences` diff path skips the
 * lookup on a `true` verdict, so the second region never retracts it. That is
 * the SAME region blindness this PR withdrew issue #2036's public store for; a
 * secret-direction verdict is safe to inherit for ADMISSION (it can only
 * over-redact a leaf) and is not safe for BLAST RADIUS. The cost of ignoring it
 * here is the substring arm for a verdict-backed, same-region ssm
 * `SecureString` on the empty-map path — a strict subset of the population the
 * no-verdict case already concedes, and in the same direction.
 *
 * The difference is a `--revert` WRITE. Measured on this module: a bare `ssm`
 * token whose value is `production` turned `my-production-logs` into
 * `my-{{resolve:ssm:/app/env}}-logs`, exactly the failure
 * {@link expressionMaySeedANeedle}'s own doc names — and if that parameter is in
 * fact public, the baseline now holds a value AWS never reported, which `cdkd
 * drift --revert` re-resolves and pushes, renaming the live bucket the day the
 * parameter changes.
 *
 * So evidence strength decides BLAST RADIUS, not admission: an inferred needle
 * still closes issue #2012's two rows, because both are WHOLE-VALUE positions
 * (an unpaired element and an observed key both hold the plaintext and nothing
 * else). Only the substring arm is withheld. Issue #2036's withdrawn verdict
 * store is what would promote these to certain; until it returns, scoped by
 * region and account, this is the honest bound.
 */
function expressionSecretIsInferred(expression: string): boolean {
  return !SPELLED_SECRET_REFERENCE_PREFIXES.some((prefix) => expression.startsWith(prefix));
}

/**
 * May this expression's resolved value be used as a REDACTION NEEDLE?
 *
 * A stricter question than "may this expression be persisted at this position",
 * which is what `trustAnyExpression` answers, and the difference is the whole
 * reason this predicate exists. Persisting a source leaf VERBATIM is bounded to
 * that one position; promoting the value it replaced to a needle rewrites EVERY
 * leaf in the record that equals it, so a wrong answer here is a false
 * redaction with a blast radius rather than a mislabelled leaf.
 *
 * Two classes, and each was measured rather than reasoned about:
 *
 * - a NON-SECRET SERVICE. `isSingleDynamicReferenceToken` accepts any
 *   `{{resolve:<anything>}}` spelling, and the resolver's unsupported-service
 *   arm WARNS and returns the literal — so AWS holds the token text itself and
 *   the leaf beside it is ordinary data. `cdkd drift`'s own
 *   `--revert does not register a live value for a look-alike spelling` case
 *   pins exactly this for its sibling registration path
 *   (`{{resolve:notaservice:/x}}`), and this predicate is what keeps the two
 *   commands answering it the same way.
 * - a plain `ssm` reference is ACCEPTED, on the same
 *   #1901 premise the whole-token arm one level up already acts on: a public
 *   `String` / `StringList` parameter is persisted RESOLVED, so a
 *   `{{resolve:ssm:` token SURVIVING in a persisted state bag is a
 *   `SecureString` by construction. Requiring a recorded verdict instead would
 *   make the needle unavailable on `cdkd state refresh-observed`, whose process
 *   resolves nothing and therefore records nothing — i.e. it would fail exactly
 *   where issue #2012 is reported. A PROVEN-public verdict would refine this,
 *   and issue #2036's store was to supply one; PR #2415 withdrew it as a
 *   cross-region disclosure, so a genuinely public parameter's resolved value
 *   CAN still seed a needle here. Bounded by the per-record scope and by
 *   {@link MIN_NEEDLE_LENGTH}, and visible as over-redaction rather than as a
 *   leak.
 */
function expressionMaySeedANeedle(expression: string): boolean {
  return (
    isRecordedSecretExpression(expression) ||
    SECRET_BEARING_REFERENCE_PREFIXES.some((prefix) => expression.startsWith(prefix))
  );
}

/**
 * Learn from a position whose SOURCE is a WHOLE `{{resolve:...}}` token.
 *
 * This is the strongest needle available on a readback path, and it asserts
 * nothing the walk was not already asserting: the caller is about to persist
 * `expression` OVER `bag` at this very position, which is the claim that `bag`
 * is that expression's resolved value. Reading the same claim back out as a
 * needle is free.
 *
 * TWO refusals, both narrow and both necessary:
 *
 * - a bag leaf that is ITSELF a complete token is not a plaintext at all. It is
 *   a record that was already redacted (a re-scrub, a second
 *   `refresh-observed`), and pairing it with itself would put a `{{resolve:...}}`
 *   string in the needle set, where the value scan's own token guard would then
 *   have to keep stepping over it.
 * - a token that does not name a SECRET-BEARING reference at all — see
 *   {@link expressionMaySeedANeedle}.
 */
export function learnWholeTokenNeedle(
  collector: DerivedNeedleCollector,
  bag: string,
  source: string
): void {
  if (isSingleDynamicReferenceToken(bag)) return;
  if (!expressionMaySeedANeedle(source)) return;
  learnNeedle(collector, bag, source);
}

/**
 * Learn from a MIXED leaf — a reference embedded in surrounding text, which
 * this module calls the DOMINANT CDK shape (an `Fn::Join` around
 * `secret.secretValueFromJson(...)`).
 *
 * The caller is about to persist `source` over `bag`, i.e. it has already
 * decided the two are the same leaf one resolution apart. Extracting the
 * plaintext is then arithmetic rather than inference, PROVIDED the extraction
 * is unambiguous — which is exactly the frame {@link singleSpanFrame} accepts,
 * and this function inherits every refusal it makes rather than restating
 * them. What each refusal means HERE:
 *
 * - its one-span rule is CONSERVATIVE rather than a correctness guard for this
 *   caller, and saying so is what stops the next reader treating it as
 *   load-bearing: with two RESOLVED references the prefix / suffix anchoring
 *   refuses independently, because the computed SUFFIX would then contain a
 *   whole `{{resolve:...}}` token and a resolved readback cannot end with one.
 *   The shape it genuinely decides is a second reference that survives
 *   LITERALLY in the readback — the resolver's unsupported-service arm produces
 *   exactly that (`ssm-secure:` did until issue #2482; a spelling with no arm
 *   still does) — where the extraction would in fact be right and is declined
 *   anyway. Measured: a both-resolved fixture leaves that rule unfenced.
 * - its prefix / suffix anchoring is what proves the leaf really is this
 *   source resolved; AWS normalising any of the surrounding text refuses
 *   instead of yielding a needle sliced at the wrong offsets.
 * - its non-overlap floor leaves a non-empty middle, so there is something to
 *   slice at all.
 * - its middle-is-a-token refusal keeps an already-redacted record (a
 *   re-scrub, a second `refresh-observed`) out of the needle set, where a
 *   reference string would be paired as if it were a plaintext — the
 *   asymmetry with the whole-token arm the security review found.
 *
 * Anchoring at the ENDS rather than searching is deliberate: a secret whose own
 * text repeats the suffix (`abc@h` inside `postgres://u:abc@h@h`) still slices
 * correctly, while an `indexOf` scan would cut it short.
 */
export function learnMixedLeafNeedle(
  collector: DerivedNeedleCollector,
  bag: string,
  source: string
): void {
  // The frame is `singleSpanFrame`, shared with `positionByEmbeddedSpan` and
  // `positionByIntrinsicFrame` so the three refusals cannot drift; what each
  // refusal means for this caller is in the docstring above.
  const frame = singleSpanFrame(bag, source);
  if (frame === undefined) return;
  // The TOKEN, never the whole leaf. The needle's replacement is what gets
  // written wherever the plaintext is found NEXT, and those positions carry
  // only the secret — an AWS-added field holding the bare password, say. Pairing
  // it with the surrounding `postgres://u:...@h` frame would write a whole
  // connection string over a field AWS reported as a password: fabricated
  // baseline content, which `--revert` then pushes to the live resource. Pinned
  // by `learns from a MIXED leaf, which is the DOMINANT CDK shape`, which
  // measured exactly that output before this line said `token`.
  const { token, middle: plaintext } = frame;
  if (!expressionMaySeedANeedle(token)) return;
  learnNeedle(collector, plaintext, token);
}

/**
 * Read the mark tree one level down. It has the SAME shape as `refused` by
 * construction (one function, one set of inputs), but this stays defensive: a
 * missing level yields `undefined`, which reads as "not decided" and therefore
 * lets the scan act. That is the same answer the pre-mark code gave, so a shape
 * surprise cannot silently start SUPPRESSING redaction — but it fails toward
 * SCANNING, which is the fabrication direction the mark tree exists to stop.
 * Both are stated because neither default is free; the shapes are identical by
 * construction (one function, one set of inputs), so this arm is a backstop
 * rather than a policy.
 */
function asChild(marks: unknown, key: string): unknown {
  return isPlainObject(marks) && hasPlainPrototype(marks) ? marks[key] : undefined;
}

/** The array-arm twin of {@link asChild}; same fail-open, same reason. */
function asIndex(marks: unknown, index: number): unknown {
  return Array.isArray(marks) ? marks[index] : undefined;
}

/**
 * Merge the DERIVED-needle value scan back over the two POSITION passes, so the
 * scan can only ever ADD a rewrite and never EDIT one.
 *
 * WHY THIS EXISTS AT ALL. Issue #2012's fix has been through both orderings and
 * each has its own way of turning a redaction fix into a fabricated baseline —
 * the two are mirror images, which is why the answer is a merge rather than a
 * third choice of order:
 *
 * - SCAN FIRST (the first revision): a needle rewrites a frame LITERAL that
 *   happens to embed a learned plaintext, {@link unkeyedArrayPairsByAnchors} is
 *   then re-run against the SCANNED bag, the anchor no longer deep-equals its
 *   source, the whole array refuses, and a sibling MIXED leaf that position
 *   ALREADY redacted persists in plaintext. Under-redaction.
 * - SCAN LAST, unrestricted (the second): the scan now runs over leaves whose
 *   content came from the SOURCE. A needle occurring in the literal FRAME of a
 *   source-taken mixed leaf is replaced, so
 *   `postgres://appuser:{{resolve:secretsmanager:...}}@h/db` becomes
 *   `postgres://{{resolve:ssm:/app/db-user}}:{{resolve:...}}@h/db` when
 *   `appuser` is also some whole-token position's resolved value — a reference
 *   the template never had at that offset. `cdkd drift --revert` re-resolves the
 *   baseline before pushing it, so once that parameter's value changes the
 *   revert writes a DIFFERENT user to the live resource. Fabricated baseline,
 *   which is the bar {@link refuseUncertifiedReadbackPositions} refuses to break
 *   at its own bottom.
 *
 * THE RULE. A position the passes DECIDED is theirs; a position they left alone
 * belongs to the scan. Expressed as a walk over their OUTPUT rather than as a
 * second copy of their pairing logic, because a mirror of `identityKeyFor` /
 * `unkeyedArrayPairsByAnchors` would drift from the original and a needle
 * applied at a MIS-paired position is a false redaction everywhere it matches.
 * The shapes line up position-for-position for free: neither pass adds a key,
 * an element, or a scalar-over-container, so `refused` is `bag`'s own shape with
 * some leaves replaced.
 *
 * `typeof bag === 'string'` at the leaf: a derived needle can only ever rewrite
 * a STRING, so for every other leaf the two answers agree and taking `refused`
 * is free.
 *
 * KEEPING A NON-PLAIN LEAF INTACT takes the prototype guard on the object arm,
 * NOT that leaf rule, and an earlier revision of this comment claimed the
 * opposite — measured wrong. The scan's own walk rebuilt objects and turned a
 * `Date` the provider readback carries (`LastModified`) into `{}`; that
 * flattening predated this module's derived needles on the POPULATED-map path
 * (issue #2427, since fixed in the scan). The object arm runs FIRST here and
 * `isPlainObject` admits a `Date`, so without `hasPlainPrototype` this walk did
 * the flattening ITSELF — newly extending #2427 to the EMPTY-map path, where
 * the unchanged-resource `drainObservedCaptures` baseline lives and where
 * `cdkd drift --revert` pushes the result to the live resource. With the guard
 * a non-plain leaf falls through to `refused`. That is the position passes' own
 * answer, which is the bag by identity: their object arm carried no prototype
 * guard of its own until issue
 * [#2869](https://github.com/go-to-k/cdkd/issues/2869), so a non-plain leaf
 * whose source subtree carries a reference WAS already flattened one function
 * earlier and this guard could only keep a `{}` intact. Both halves are guarded
 * now, and the VALUE scan's own walk keeps a `Date` by identity since issue
 * #2427, so `scanned` holds the same instance.
 *
 * The net effect is byte-identical to the FIRST ordering on every input where
 * the un-certification did not fire — which is the whole point: it keeps that
 * ordering's intent and drops only its defect.
 */
export function preferPositionDecisions(
  scanned: unknown,
  refused: unknown,
  bag: unknown,
  marks: unknown,
  inferred: RecordedSecretValues
): unknown {
  // `hasPlainPrototype`, and it is load-bearing rather than tidy:
  // {@link isPlainObject} admits ANY non-null non-array object, a `Date`
  // included, and `Object.entries(new Date())` is `[]` — so without this the
  // object arm rebuilt a readback `Date` as an empty object BEFORE the leaf
  // rule below could keep it, which is the very corruption the leaf rule is
  // documented as preventing. Measured on this tree: a bag of
  // `{A, Copy, LastModified: Date}` came back with `LastModified: {}`.
  if (
    isPlainObject(bag) &&
    hasPlainPrototype(bag) &&
    isPlainObject(refused) &&
    isPlainObject(scanned)
  ) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(refused)) {
      out[k] = preferPositionDecisions(scanned[k], v, bag[k], asChild(marks, k), inferred);
    }
    return out;
  }
  if (
    Array.isArray(bag) &&
    Array.isArray(refused) &&
    Array.isArray(scanned) &&
    refused.length === bag.length &&
    scanned.length === bag.length
  ) {
    return refused.map((item, i) =>
      preferPositionDecisions(scanned[i], item, bag[i], asIndex(marks, i), inferred)
    );
  }
  // The scan owns a STRING leaf no position pass decided. `marks` answers the
  // second half exactly; `refused === bag` used to, and could not distinguish a
  // decision that AGREED with the bag — see {@link POSITION_DECIDED}.
  if (typeof bag !== 'string' || marks === POSITION_DECIDED) return refused;
  // `scanned` carries the CERTAIN needles at full strength. An INFERRED one may
  // only take a leaf WHOLE, so it applies here and only where the certain scan
  // left the leaf alone — see {@link expressionSecretIsInferred} for why the
  // substring arm is withheld from it.
  const scanDecision = scanned === bag ? (inferred.get(bag) ?? scanned) : scanned;
  // A leaf the position pass REFUSED (issue #2852) — `refused` holds
  // {@link SECRET_MASK} there. The scan may take it back, but ONLY by
  // accounting for the WHOLE leaf: `derived.certain` carries the SUBSTRING arm,
  // so a needle naming one embedded value rewrites PART of the leaf, makes
  // `scanDecision !== bag`, and — before this test — discarded the mask while
  // the rest of the decrypted string was written out. Measured on the (#2846)
  // raw-intrinsic shape: a certified `User` sibling turned
  // `postgres://appuser:hunter2-decrypted@h` into
  // `postgres://{{resolve:...username}}:hunter2-decrypted@h`, publishing the
  // password the refusal had just masked.
  //
  // A WHOLE token is the test because that is close to what "the scan named
  // this leaf" means, and both issue #2012 rows this arm protects — an unpaired
  // array element and an observed KEY the source lacks — are whole-value
  // rewrites, so they survive it. An expression is still strictly better than a
  // mask (`cdkd drift` can re-resolve one); a HALF expression is strictly
  // worse than both.
  //
  // CLOSE TO, not identical, and the gap is worth stating rather than leaving
  // to be rediscovered: a leaf the scan accounted for ENTIRELY with two or more
  // ADJACENT needles (`{{resolve:a}}{{resolve:b}}`) is refused here, because
  // the concatenation is not a SINGLE token. Nothing is published by that — the
  // mask stands, which is the fail-closed direction — but it is over-refusal
  // rather than the exact predicate, and it is cheap to state and expensive to
  // widen: any test admitting a run of tokens has to prove the run covers the
  // whole leaf with nothing between, which is the SUBSTRING reasoning this line
  // exists to refuse.
  if (
    marks === POSITION_UNCERTIFIED &&
    !(typeof scanDecision === 'string' && isSingleDynamicReferenceToken(scanDecision))
  ) {
    return refused;
  }
  return scanDecision;
}

/**
 * The learned pairs, split by how strong the evidence for each one is.
 *
 * `certain` gets the full value scan (whole-value AND substring); `inferred`
 * gets a WHOLE-VALUE rewrite only. See {@link expressionSecretIsInferred}.
 */
interface DerivedNeedles {
  readonly certain: RecordedSecretValues;
  readonly inferred: RecordedSecretValues;
}

/**
 * DERIVED NEEDLES (issue [#2012](https://github.com/go-to-k/cdkd/issues/2012)):
 * the secrets map an empty-map readback path can build from its OWN two bags,
 * with no resolution, no AWS call and no new permission.
 *
 * THE PROBLEM THIS ANSWERS. On the readback paths the secrets map is empty by
 * construction (nothing was resolved), so the value scan has no needles and
 * POSITION is the only mechanism. Two shapes have no position to argue from and
 * kept their plaintext: an UNPAIRED array element beside a paired one, and an
 * observed KEY the source does not carry. Both are places {@link redactByPath}
 * ALREADY delegates to the value scan — it is the scan that had nothing to say.
 *
 * WHAT MAKES A NEEDLE AVAILABLE WITHOUT FETCHING. The same record almost always
 * carries the same secret at a position the pass DOES certify: the paired
 * sibling, the key the source does carry. Certifying such a position IS the
 * assertion that AWS's value there is that expression's resolved form — the
 * pass acts on it by persisting the expression over it. Reading that assertion
 * back out gives a plaintext, and a plaintext is exactly what the value scan
 * was missing. Issue #2012's own direction was to RESOLVE the record's
 * expressions to get one, which would have made `cdkd state refresh-observed`
 * and every deploy's observed capture FETCH secrets: a new IAM requirement, a
 * new failure mode and a new place plaintext lives. None of that is needed —
 * AWS already handed us the plaintext, in the very bag being redacted.
 *
 * `redactByPath`'s own comment argued the opposite direction and was right
 * about it: seeding the scan from the SOURCE's expressions cannot work, because
 * a scan needs PLAINTEXT needles. This seeds it from the BAG's values, which is
 * the half that exists.
 *
 * SCOPE, and why each bound is where it is:
 *
 * - ONLY the readback-projected rules. Every other caller either has a real map
 *   or has a source of a different generation, where a value learned from one
 *   generation must not rewrite the other.
 * - ONLY when the map is EMPTY, and this bound is load-bearing for a reason
 *   that is not obvious: {@link crossStackAssociations} and
 *   {@link nestedStackParameterExpressions} are `WeakMap`s keyed by the
 *   RecordedSecretValues INSTANCE, so handing the pipeline a different Map
 *   object would silently lose every association that pass recorded. With an
 *   empty map there are none to lose (an association is only ever recorded for
 *   a plaintext that map holds).
 * - the pairs are scoped to ONE record, exactly as `perResourceSecrets` is on
 *   the deploy path, so one resource's secret can never rewrite another's
 *   coinciding literal.
 *
 * WHERE THE RESULT IS APPLIED, and this is a SEQUENCING claim rather than a
 * scoping one: the returned map is handed to a plain VALUE pass over the RAW
 * bag, whose result is then MERGED over the output of both position passes by
 * {@link preferPositionDecisions}. It reaches neither position pass. Both naive
 * orderings are wrong and that function's doc has the measurements: scanning
 * FIRST lets a needle rewrite a frame LITERAL and un-certify an anchor pairing
 * (under-redaction), scanning LAST over their output lets one rewrite a literal
 * inside a leaf they took from SOURCE (a fabricated baseline). The merge is what
 * makes "a derived needle can only ADD rewrites" literally true.
 *
 * Returns `undefined` when nothing is learned, so the no-secret path skips the
 * scan and the merge entirely and stays byte-identical to the position passes'
 * own output.
 */
export function deriveReadbackNeedles(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  rules: PathSourceRules
): DerivedNeedles | undefined {
  if (!isReadbackProjectedFromState(rules)) return undefined;
  if (secrets.size > 0) return undefined;
  if (!subtreeHasDynamicReference(source)) return undefined;
  const collector: DerivedNeedleCollector = {
    needles: new Map(),
    poisoned: new Set(),
    inferred: new Set(),
  };
  // The LEARN pass. Its return value is discarded — it runs for the pairs its
  // certified positions establish, and it is the same function that decides
  // those positions on the substituting pass, so the two can never disagree
  // about what "certified" means. It reads the RAW `bag` for the same reason:
  // after the position passes those very positions hold the EXPRESSION, so the
  // plaintext half of every pair would be gone.
  refuseUncertifiedReadbackPositions(bag, source, secrets, false, collector);
  if (collector.needles.size === 0) return undefined;
  const certain = new Map<string, string>();
  const inferred = new Map<string, string>();
  for (const [plaintext, expression] of collector.needles) {
    (collector.inferred.has(plaintext) ? inferred : certain).set(plaintext, expression);
  }
  return { certain, inferred };
}
