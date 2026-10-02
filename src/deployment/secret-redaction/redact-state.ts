import {
  isSingleDynamicReferenceToken,
  isPlainObject,
  isDynamicReferenceString,
  type PathSourceRules,
  TEMPLATE_DERIVED_RULES,
  buildNeedleRegex,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_BASELINE_RULES,
  STATE_SOURCED_READBACK_RULES,
} from './rules.js';
import {
  spanNamesResolvableService,
  POSITION_UNCERTIFIED,
  type DerivedNeedleCollector,
  learnWholeTokenNeedle,
  POSITION_DECIDED,
  learnMixedLeafNeedle,
  unkeyedArrayPairsByAnchors,
  deriveReadbackNeedles,
  preferPositionDecisions,
  resolvableReferenceSpans,
} from './anchors.js';
import { SECRET_MASK, type RecordedSecretValues, isSameGenerationBag } from './pairs.js';
import {
  hasPlainPrototype,
  subtreeHasDynamicReference,
  mixedLeafMayCarryPublicReference,
  redactByPath,
  isReadbackProjectedFromState,
  isOrdinaryDate,
} from './redact-path.js';
import { wholeStringLeavesOf } from './mask-only.js';
import { identityKeyFor } from './positions.js';
import {
  flattenEmbeddedNoEchoLeaves,
  recordedExpressionsOf,
  substringNeedlesOf,
  isStrictlyInsideASpan,
} from './fresh-noecho.js';

/**
 * FAIL CLOSED over one readback subtree the position walk could not certify
 * (issue [#2852](https://github.com/go-to-k/cdkd/issues/2852)).
 *
 * Every STRING leaf the source cannot account for becomes
 * {@link SECRET_MASK} — at EVERY position it occupies, including a node the bag
 * reaches twice; see the memo below. So does a BINARY leaf, whose bytes are a
 * secret in the clear once `JSON.stringify` writes them. Everything else is
 * kept. Called from
 * {@link refuseUncertifiedReadbackPositions} — through
 * {@link refuseAgainstSource}, and DIRECTLY from its keyed-array arm, which
 * hoists the literal set and re-spells the `failClosed` test — and only where
 * that walk has already established
 * BOTH halves of the evidence: the SOURCE subtree at this position spells a
 * dynamic reference (so the template says a secret lives here), and the two
 * sides cannot be paired (so no position can say WHICH leaf holds its resolved
 * form). Before this, every such branch returned the bag — the decrypted
 * readback — verbatim.
 *
 * "The source cannot account for" is the whole claim, and it is deliberately
 * WEAKER than "no plaintext survives": a leaf the source spells verbatim is
 * kept, so a readback that echoes a template literal back keeps it. What the
 * pass guarantees is that no leaf survives on the strength of the walk having
 * given up.
 *
 * WHY A MASK RATHER THAN THE SOURCE. Substituting the source is what the
 * certified rows do, and it is exactly what the array arm's own comment (and
 * the issue #1915 fences) refuse here: with no pairing, writing the source
 * fabricates baseline content AWS never reported, which `cdkd drift --revert`
 * then pushes to the live resource. A mask fabricates no content — it keeps
 * the bag's SHAPE, adds no key, no element and no scalar-over-container — and
 * `SECRET_MASK` is already a first-class persisted state with its own
 * downstream guards (`drift.ts`'s `collectSecretMaskPaths` /
 * `preserveLiveValuesAtMaskedLeaves`, `runAccept`'s refusal,
 * `rollback-executor/replay-props.ts`'s `refuseMaskedReplayBaseline`), because the
 * mask-only channel (issue #2274) already puts one there.
 *
 * WHY STRINGS ONLY. A recorded secret is a `string` by the type of
 * {@link RecordedSecretValues}, so a number, a boolean or `null` cannot BE a
 * resolved secret and masking one would only cost drift a comparison. A
 * NON-PLAIN object (a `Date` an AWS SDK readback carries, a `Buffer`) is
 * returned BY IDENTITY for the same reason plus a second one: rebuilding it
 * from its own enumerable keys yields `{}` — the corruption of issue
 * [#2869](https://github.com/go-to-k/cdkd/issues/2869).
 *
 * A leaf that IS a whole `{{resolve:...}}` token is kept: it is an expression
 * AWS echoed back unresolved, not plaintext, and replacing it with a mask would
 * DESTROY a value `cdkd drift` can re-resolve. WHOLE, not "contains one" — that
 * wider test spared `postgres://admin:<plaintext>@{{resolve:ssm-secure:/h}}`,
 * where the embedded token vouched for a leaf that was mostly the decrypted
 * secret. The residual is the issue #1917 shape — a plaintext that merely LOOKS
 * like a token — which every arm of this module already trusts.
 *
 * SO IS A LEAF THE SOURCE SUBTREE ITSELF SPELLS, and this is what keeps the
 * fail-closed change from emptying an ordinary drift baseline. `sourceLiterals`
 * is {@link wholeStringLeavesOf} over the SOURCE at the refused position — the
 * literal frame of an `Fn::Join`, the anchor values of an array AWS reordered,
 * every ordinary property beside the reference. A value the template SPELLS is
 * not the resolved form of a reference, so masking it buys nothing; and where
 * it coincides with one, that plaintext is already sitting in the record's own
 * `properties`, so the copy in the readback is not the disclosure. Scoped to
 * the SOURCE AT THE REFUSED POSITION rather than the whole record on purpose: a
 * coincidence three properties away is not evidence about this one. Read that
 * literally — when an ARRAY refuses element by element the refused position is
 * the array, so a SIBLING element's literal does spare a leaf. That is the
 * intended granularity (the elements are peers of one list AWS returned
 * together, and the pairing that failed is between the two LISTS), and it is
 * stated because "subtree" reads narrower than the code is.
 *
 * OVER-MASKING IS THE REMAINING COST AND IT IS THE INTENDED DIRECTION: a value
 * AWS NORMALISED (`us-east-1` returned as `US-EAST-1`) no longer matches the
 * source and is masked with the secret, because nothing distinguishes them once
 * the pairing is gone. That is phantom drift rather than a disclosure — the
 * same way this module chooses to be wrong at
 * {@link mixedLeafMayCarryPublicReference}.
 *
 * `mark` is {@link refuseUncertifiedReadbackPositions}'s MARK MODE, threaded
 * so the parallel tree keeps the same shape: {@link POSITION_UNCERTIFIED}
 * lands wherever the substituting pass puts a mask, and the bag's own value
 * everywhere else — which is that mode's contract.
 */
function refuseUncertifiedSubtree(
  value: unknown,
  sourceLiterals: ReadonlySet<string>,
  mark: boolean | undefined,
  seen: Map<object, unknown> = new Map()
): unknown {
  if (typeof value === 'string') {
    // A WHOLE token, not a string that merely CONTAINS one. The substring test
    // this arm shipped with spared `postgres://admin:<plaintext>@{{resolve:...}}`
    // -- a leaf whose embedded token made it look like an already-persisted
    // expression while the rest of it was the decrypted secret. On the paths
    // this pass runs on the map is EMPTY, so `redactByPath` rewrote nothing and
    // every leaf here came back from AWS verbatim; a leaf the source spells as a
    // mixed expression is still kept, by `sourceLiterals` one clause down, so
    // narrowing this to a whole token costs only a leaf AWS echoed back
    // unresolved AND the source does not spell.
    // ...and one naming a service cdkd RESOLVES (issue #2743): a token of any
    // other service is not an expression a deploy could have persisted here.
    if (
      (isSingleDynamicReferenceToken(value) && spanNamesResolvableService(value)) ||
      sourceLiterals.has(value)
    ) {
      return value;
    }
    // `''` is not a value any resolved secret can take (the resolver records
    // none, and the value scan excludes it as a needle for the same reason), so
    // masking it only costs drift a comparison.
    if (value === '') return value;
    return mark ? POSITION_UNCERTIFIED : SECRET_MASK;
  }
  if (value === null || typeof value !== 'object') return value;
  // MEMOISE THE RESULT, and seed it BEFORE descending. An AWS SDK readback is a
  // live object graph: it can loop, and it can carry the SAME object at two
  // positions (a DAG). A plain visited-SET answers both by returning the node
  // by identity, which is right for a walk that ACCUMULATES and wrong for one
  // that REBUILDS -- measured on this tree, `{A: [shared, shared]}` came back
  // `[{Pw: '***'}, {Pw: '<plaintext>'}]`, and a cyclic bag's back-edge pointed
  // at the original object, so a guard added to stop a `RangeError` persisted
  // the secret it was walking past. It does NOT claim to stop that crash: a
  // truly cyclic bag still blows the stack in the value scan one merge over,
  // and `origin/main` does the same -- measured, after an earlier revision of
  // this comment said otherwise. Handing back the REFUSED copy answers both
  // shapes: a DAG is masked at every position, and a cycle terminates on a
  // back-edge into the copy rather than the original.
  //
  // {@link wholeStringLeavesOf} and `recordMaskOnlyValuesIn` keep a plain
  // visited-set instead, correctly: they accumulate INTO a set, so a revisit
  // changes no answer and re-walking a shared node is the only cost.
  // `!== undefined` rather than `seen.has`: nothing is ever memoised AS
  // `undefined` (every branch below stores a container or the node itself), so
  // the two agree and this one reads as what it means.
  //
  // The copies it hands back are SHARED, exactly as the input's were: two DAG
  // positions come back as one object, so a caller mutating the returned
  // `observedProperties` at one position sees it at the other. That mirrors the
  // bag it was given and every consumer here treats the result as read-only
  // before `JSON.stringify`, but it is stated because "deep clone" is what a
  // reader assumes of a walk that rebuilds.
  const memo = seen.get(value);
  if (memo !== undefined) return memo;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(refuseUncertifiedSubtree(item, sourceLiterals, mark, seen));
    return out;
  }
  if (isPlainObject(value) && hasPlainPrototype(value)) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    seen.set(value, out);
    for (const [k, v] of Object.entries(value)) {
      out[k] = refuseUncertifiedSubtree(v, sourceLiterals, mark, seen);
    }
    return out;
  }
  // BINARY IS NOT A SAFE LEAF. An AWS SDK v3 readback returns a `Uint8Array`
  // for a binary member -- Secrets Manager's `SecretBinary` is the one that
  // matters here -- and its bytes are the secret in the clear once
  // `JSON.stringify` writes them as `{"type":"Buffer","data":[...]}`. The
  // "STRING leaves only" rule argues from {@link RecordedSecretValues}'s type,
  // which is a fact about the MAP and not about what AWS returns, so it does
  // not reach this case. Measured before this arm: a readback of
  // `{D:[{B: Buffer('binary-secret'), S:'hunter2'}]}` under a refused position
  // persisted the bytes while masking the string beside them.
  //
  // Masked rather than kept, and the shape change is deliberate: the leaf's
  // value is the thing being refused, and every downstream reader of a mask
  // already handles a string there.
  //
  // The `mark` ternary here is DEFENSIVE and deliberately unpinned, which is
  // stated because collapsing it to a plain `SECRET_MASK` leaves the whole
  // suite green and the output byte-identical. The reason is not that the two
  // agree: `preferPositionDecisions` consults the mark tree only where the BAG
  // leaf is a `string`, so at a binary leaf no consumer ever reads this
  // position's mark, and no input can make the two answers differ. What the
  // ternary buys is that the mark tree stays a tree of MARKS — putting the
  // literal `'***'` into it would be indistinguishable from a mark-mode walk
  // over a bag whose own leaf is `'***'`, so a future merge arm that widened
  // past `typeof bag === 'string'` would silently read this position as
  // undecided. Cheap here, and impossible to notice from the failure it would
  // cause there.
  if (ArrayBuffer.isView(value)) return mark ? POSITION_UNCERTIFIED : SECRET_MASK;
  // A `Date` / class instance: kept BY IDENTITY, and memoised as itself so a
  // second reference to it answers the same way. A `Date` carries no bytes a
  // secret could hide in -- it is a timestamp AWS reports beside the property,
  // which is the issue #2869 population.
  seen.set(value, value);
  return value;
}

/**
 * {@link refuseUncertifiedSubtree} over a bag whose SOURCE is in hand, so the
 * literal set can never be built from anything but the source at the SAME
 * position.
 *
 * NOT the only spelling, and an earlier revision of this sentence said it was.
 * The keyed-array arm calls {@link refuseUncertifiedSubtree} DIRECTLY, because
 * it hoists the literal set out of its `bag.map` — so it also re-spells the
 * `failClosed` test this function owns. A future edit that drops that
 * re-spelling drops the DESTINATION check with it, which is why the two are
 * named here rather than left to be noticed.
 */
function refuseAgainstSource(
  bag: unknown,
  source: unknown,
  failClosed: boolean | undefined,
  mark: boolean | undefined
): unknown {
  // ONLY where the CALLER declared its bag is a drift baseline. Two earlier
  // discriminators were tried here and each was measured wrong: the RULES alone
  // select `cdkd drift`'s writers too, and `secrets.size === 0` does not
  // separate them either — `runAccept` reaches an empty map through its
  // cross-region refusal and through a resource whose only `{{resolve:`-shaped
  // leaf names a service cdkd resolves for nobody, and with no
  // `observedProperties` on the record it then writes the mask into
  // `properties`. Destination is not derivable from the two bags; see
  // {@link PathSourceRules.failClosedOnUncertifiedPositions}.
  if (failClosed !== true) return bag;
  return refuseUncertifiedSubtree(bag, wholeStringLeavesOf(source), mark);
}

/**
 * Does any element of `source` that the bag did NOT pair carry a dynamic
 * reference (issue [#2852](https://github.com/go-to-k/cdkd/issues/2852))?
 *
 * The evidence that licenses refusing the bag's own unpaired elements in the
 * IDENTITY-KEYED array arm. An identity key that does not round-trip
 * byte-identically — AWS case-normalises a `Name`, or expands one to an ARN —
 * drops its element to `partner === undefined`, and the element the source
 * spells as a reference is then left over with nothing pointing at it, so its
 * resolved plaintext is somewhere in the unpaired remainder.
 *
 * The converse is why this is a QUESTION rather than a blanket refusal: when
 * every reference-bearing source element DID find its partner, an extra bag
 * element is a peer AWS added (another `Environment` entry) and carries no
 * secret this source can account for. Refusing those would mask ordinary
 * readback content for no evidence, which is the same trade the object arm's
 * extra-KEY branch declines to make.
 */
function unpairedSourceCarriesReference(
  source: readonly unknown[],
  key: string,
  bagIdentities: ReadonlySet<unknown>
): boolean {
  return source.some(
    (item) =>
      !bagIdentities.has((item as Record<string, unknown>)[key]) && subtreeHasDynamicReference(item)
  );
}

/**
 * Refuse to persist a readback leaf the path pass could not CERTIFY, at any
 * position the STATE source proves is secret-bearing (issue #1926 review).
 *
 * {@link redactByPath} substitutes only where the source leaf is a WHOLE
 * `{{resolve:...}}` token. On the paths {@link isReadbackProjectedFromState}
 * selects the secrets map may be EMPTY, so its value-scan fallback is a no-op,
 * and four shapes reached `state.json` holding the DECRYPTED value. Measured
 * against this module before this pass existed — three by `cdkd state
 * refresh-observed`, and the same three by a plain `cdkd deploy`, whose
 * `drainObservedCaptures` baseline reaches the persist choke point with exactly
 * this configuration. `cdkd scrub` is NOT one of them: its observed walk is
 * CROSS-generation, so {@link isReadbackProjectedFromState} excludes it by
 * design:
 *
 * ```text
 *   source leaf in the STATE record                  before        now
 *   -----------------------------------------------  ------------  ---------------
 *   `postgres://u:{{resolve:...}}@h` (MIXED string)   LEAK          take source
 *   ...the same MIXED leaf inside a PAIRED element    LEAK          take source
 *   `['--pw', '{{resolve:...}}']` (no identity key)   LEAK          take source*
 *   `[{Field, Val: '{{resolve:...}}'}]` (no `Name`)   LEAK          take source*
 *   ...either of those, but REORDERED / normalised    LEAK          MASK (#2852)
 *   an UNPAIRED element, source reference left over   LEAK          needle | MASK
 *   an UNPAIRED element, every source reference paired LEAK         needle (#2012)
 *   a RESHAPED container / added wrapper level        LEAK          MASK (#2852)
 *   a source leaf promoted to a container             LEAK          MASK (#2852)
 *   a RAW `Fn::Join` source vs a STRING readback      LEAK          MASK (#2846)
 *   an observed KEY the source does not carry         LEAK          needle | LEAK
 *   a `Date` under a reference-bearing source subtree `{}`          kept (#2869)
 *   whole `{{resolve:...}}` token                     ok            ok
 *   `Environment[]` keyed by `Name` (issue #1915)     ok            ok
 *   PUBLIC ssm MIXED leaf, POPULATED map               ok            ok
 *   PUBLIC ssm MIXED leaf, EMPTY map                   ok            over-redacts
 * ```
 *
 * MASK rows are the FAIL-CLOSED change of issue
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852). Every branch this walk
 * could not certify used to `return bag` — the decrypted readback, verbatim —
 * so "cannot pair" and "safe to persist" were the same answer. They are now
 * {@link refuseUncertifiedSubtree}, whose doc argues why a mask rather than the
 * source and why STRING leaves only. `needle | MASK` means the derived needles
 * of issue #2012 are consulted FIRST and the mask stands only where they had
 * nothing to say ({@link preferPositionDecisions}), so no row this table
 * previously closed by a needle is taken back.
 *
 * ONE row is deliberately still open: an observed KEY the source does not carry
 * keeps the plaintext when no needle names it. Refusing there needs evidence
 * that does not exist — the source has NO leaf at that position, so the walk
 * would be guessing — and the cost of guessing is not bounded: a write-only
 * credential AWS never echoes back (RDS `MasterUserPassword` and every
 * `getDriftUnknownPaths` sibling) leaves a reference-bearing source key
 * unpaired on EVERY readback, so keying the refusal on that would mask
 * `Runtime` / `FunctionArn` / `LastModified` for every secret-bearing resource
 * in the account. The extra-KEY asymmetry stated further down is the same
 * argument; issue [#2868](https://github.com/go-to-k/cdkd/issues/2868) owns the
 * shape where the plaintext has no counterpart in the source at all.
 *
 * The last row is the price of the row above it and is tracked as issue
 * [#2036](https://github.com/go-to-k/cdkd/issues/2036): with no map nothing was
 * resolved, so nothing distinguishes a public parameter from a `SecureString`
 * and the leaf is refused. Phantom drift, not a disclosure — see
 * {@link mixedLeafMayCarryPublicReference} for why that is the right way to be
 * wrong here.
 *
 * What this pass closes is the row POSITION can actually justify: a leaf whose
 * KEY the source carries, where the source is the same generation and the only
 * thing the older code lacked was the willingness to substitute a leaf that was
 * not a WHOLE token. Everything it takes is the record's own value at the
 * record's own path.
 *
 * The starred rows are the two ANCHOR PAIRING closed for issue #2012, and the
 * star is load-bearing: they close only when the pairing is CORROBORATED. Four
 * conditions, all required — the index counts match; every position the source
 * does not spell as a reference is deep-equal on both sides; every
 * reference-bearing ELEMENT carries its own distinguishing anchor, or, being a
 * bare reference leaf with no interior to carry one, leans on the array's
 * literal FRAME; and no two reference-bearing elements look alike to the
 * anchors. That is why the row beneath them exists. As soon as AWS reorders the
 * list or normalises any sibling field, the anchors stop matching and the same
 * two shapes refuse again, so the closure is a SUBSET of each row rather than
 * the whole of it.
 *
 * An earlier revision of this paragraph stated only the first two conditions
 * plus "at least one of them distinguishing", which was the gate BEFORE the
 * #2012 review — under it `['--pw', <exprA>, '--pw', <exprB>]` closes and
 * misattributes, so the text documented the defect as the design. See
 * {@link unkeyedArrayPairsByAnchors}, which is where all four live;
 * {@link anchorsCorroboratePairing} answers only one of them and its own doc
 * says nothing in it is sufficient alone.
 *
 * The MASK rows are one root cause, not several: no needle and no
 * position, so nothing distinguishes a resolved secret from an ordinary
 * literal. They are NOT closed by taking the source subtree, which an earlier
 * revision did and the issue #1915 fences correctly rejected — measured, it
 * rewrote `{Name:'', Value:'an-unrelated-literal'}` onto the expression and
 * turned an AWS-reported `[{Value:'x'}]` into `[{Name:'db', Value:<expr>}]`,
 * fabricating drift-baseline content AWS never reported that `cdkd drift
 * --revert` then pushes to the live resource. Redaction may not buy itself a
 * fabricated baseline — which is also the bar anchor pairing had to clear, and
 * clears structurally: it only ever licenses a walk of positions the BAG
 * already has, so it can add no key, no element and no scalar-over-container.
 *
 * The MIXED row is the shape this module itself calls DOMINANT for CDK — an
 * `Fn::Join` around `secret.secretValueFromJson(...)`.
 *
 * TAKE SOURCE rather than a {@link SECRET_MASK} on the rows it CERTIFIES, for
 * the same reason the whole-token arm does: a mask is not a value `cdkd drift`
 * can re-resolve, so it would report a permanent phantom — and `cdkd drift
 * --revert` pushes the BASELINE to AWS, so a masked baseline would write the
 * literal `***` onto the live resource (the issue #1498 / #1501 class).
 *
 * That is an argument about a row where a SOURCE VALUE IS AVAILABLE, and it
 * decides nothing about a row where none is (issue #2852). There the choice is
 * not mask-versus-source but mask-versus-PLAINTEXT, and the two costs above are
 * both real: `runAccept` refuses a masked change and
 * `preserveLiveValuesAtMaskedLeaves` moves AWS's own value in before `--revert`
 * sends anything, so the mask degrades those two commands on that resource
 * rather than corrupting it — while the plaintext it replaces is the disclosure
 * of GHSA-p5qg-v9gv-hc7w sitting in `state.json`. Do not read the paragraph
 * above as a rule against the mask everywhere; it is a rule about the rows with
 * a certified source.
 *
 * The needle rows were the RESIDUAL and are closed by DERIVED NEEDLES (issue
 * #2012) — see {@link deriveReadbackNeedles}. Neither has a position to argue
 * from: an unpaired array element and an observed KEY the source does not carry
 * are both positions with no source leaf to take. What they never lacked was a
 * VALUE — the same plaintext usually sits at a position this pass DOES certify,
 * and certifying it is already an assertion that the value is that expression's
 * resolved form. Reading that assertion back out as a needle turns the value
 * scan on for the rest of the record without resolving anything.
 *
 * The extra-KEY asymmetry stays as it was and is worth restating, because the
 * needle does not replace it: an extra array element is a PEER of the
 * secret-bearing ones (another `Environment` entry), while an extra object KEY
 * is a different FIELD entirely (`Runtime`, `FunctionArn`, `LastModified`) and
 * is the NORM in an AWS readback. Refusing those wholesale would empty the
 * drift baseline of every secret-bearing resource, which is why they are
 * value-scanned rather than refused.
 *
 * `learn` is the LEARN PASS's collector and is `undefined` on the substituting
 * pass. It changes NO verdict — every branch below decides exactly what it
 * decided before — it only records the (plaintext, expression) pairs the
 * certified positions establish. Deriving them through this function rather
 * than a second walk is deliberate: the pairing rules (identity keys, anchor
 * corroboration, the refusals) are subtle enough that a mirror of them would
 * drift, and a needle learned from a MIS-paired position is a false redaction
 * everywhere it then matches.
 */
export function refuseUncertifiedReadbackPositions(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  failClosed?: boolean,
  learn?: DerivedNeedleCollector,
  // MARK MODE. Returns the same SHAPE with {@link POSITION_DECIDED} at every
  // position this pass decides, and the bag's own value everywhere else, so
  // {@link preferPositionDecisions} can ask "was this decided?" instead of
  // guessing from value equality. Running the real function rather than a
  // mirror of it is the point: the pairing rules (identity keys, anchor
  // corroboration, the refusals) decide which positions EXIST, and a second
  // copy of them would drift.
  mark?: boolean
): unknown {
  // The string arm, and BOTH of its guards were added after review measured
  // what their absence did.
  //
  // `typeof bag === 'string'` mirrors the sibling test in `redactByPath`, and
  // it is load-bearing rather than defensive: without it a source leaf of
  // `{{resolve:...}}` whose BAG is a container returned the scalar string,
  // turning `{Foo: {a: 1}}` into `{Foo: '{{resolve:...}}'}` — fabricating a
  // baseline AWS never reported, which is the exact thing this function refuses
  // to do at its own bottom and the principle this pass was built on. It is
  // reachable whenever a provider structures a leaf the template spells as a
  // reference, and the result is permanent phantom drift plus a `--revert` that
  // writes a string where AWS holds an object. With the guard, such a leaf
  // falls to the shape-divergence fallback and the bag is kept.
  //
  // NOT a no-op short-circuit, which an earlier revision of this comment
  // claimed: the fallback returns `bag`, so deleting this arm changes the
  // answer rather than reproducing it. (That claim WAS true when the fallback
  // still returned the source, and it stopped being true when the fallback was
  // narrowed. A comment asserting equivalence has to be re-measured whenever
  // either side moves.)
  if (isDynamicReferenceString(source) && typeof bag === 'string') {
    // A WHOLE token: `redactByPath` already decided this leaf, and returning
    // the source agrees with it.
    if (isSingleDynamicReferenceToken(source)) {
      // ...and the bag it replaces is that expression's resolved value, exactly
      // and with nothing inferred. That is the strongest needle available here.
      if (learn) learnWholeTokenNeedle(learn, bag, source);
      return mark ? POSITION_DECIDED : source;
    }
    // A MIXED leaf embedding something that may be PUBLIC config: keep the
    // resolved value AWS actually holds. See the predicate's own doc. KEEPING
    // is a decision like any other, which is why it marks.
    //
    // NO TEST FENCES THAT MARK, and the reason is structural rather than a gap:
    // the merge only runs when the map is EMPTY ({@link deriveReadbackNeedles}
    // returns `secrets` by identity otherwise), and with an empty map the
    // predicate above is constant `false`. So this arm and the mark tree cannot
    // both be live today. It is written correctly anyway because issue #2036's
    // withdrawn verdict store is what makes the predicate non-constant there,
    // and whoever revives it must not also have to rediscover this line.
    if (mixedLeafMayCarryPublicReference(source, secrets)) {
      return mark ? POSITION_DECIDED : bag;
    }
    if (learn) learnMixedLeafNeedle(learn, bag, source);
    return mark ? POSITION_DECIDED : source;
  }
  // Nothing to protect in this subtree — return the bag by identity, which is
  // what keeps an ordinary readback (and any AWS-added element in it) intact.
  if (!subtreeHasDynamicReference(source)) return bag;
  // `hasPlainPrototype`, for the reason its twin on {@link
  // preferPositionDecisions} carries and this arm lacked (issue
  // [#2869](https://github.com/go-to-k/cdkd/issues/2869)): {@link isPlainObject}
  // admits a `Date`, an AWS SDK v3 readback really does carry them
  // (`LastModified`, `CreationDate`) beside reference-bearing properties, and
  // `Object.entries(new Date())` is `[]` — so this loop REBUILT one as `{}`, a
  // baseline value AWS never reported that `cdkd drift --revert` can push to
  // the live resource. With the guard it falls to the divergence arm at the
  // bottom, where {@link refuseUncertifiedSubtree} returns a non-plain object
  // BY IDENTITY. `preferPositionDecisions` already guarded its own copy of this
  // walk and its comment named this arm as the remaining half.
  if (isPlainObject(bag) && hasPlainPrototype(bag) && isPlainObject(source)) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(bag)) {
      // `Object.hasOwn` rather than `k in source` keeps this walk consistent
      // with the two beside it; unlike there, no test can pin the difference —
      // both arms of this one return a value rather than a function, so a
      // prototype hit would produce the same output. Consistency is the whole
      // claim being made here.
      out[k] = Object.hasOwn(source, k)
        ? refuseUncertifiedReadbackPositions(v, source[k], secrets, failClosed, learn, mark)
        : // No source leaf here, so this pass has nothing to substitute. It is
          // no longer a residual, but the closure happens OUTSIDE this walk:
          // `redactSecretsForState` scans the RAW bag with the DERIVED needles
          // and {@link preferPositionDecisions} merges that result in wherever
          // neither position pass changed a leaf (issue #2012) — which is
          // exactly this position. What this walk hands on is therefore the raw
          // value, and the merged scan decides it. Neither naive ORDER works;
          // the reasons are measured on `preferPositionDecisions`.
          v;
    }
    return out;
  }
  if (Array.isArray(bag) && Array.isArray(source)) {
    // DESCEND ONLY. An element that pairs by identity (issue #1915) is walked
    // so a MIXED leaf inside it is still refused; an element that does NOT pair
    // is returned untouched.
    //
    // An earlier revision of this pass instead took the SOURCE array wholesale
    // whenever it could not vouch for the bag, which closed two more leak
    // shapes and was WRONG — the existing issue #1915 fences caught it, and
    // they are right. Measured, it rewrote `{Name:'', Value:'an-unrelated-
    // literal'}` into `Value: <expression>` (a FALSE redaction of a value that
    // was never a secret) and turned an AWS-reported `[{Value:'x'}]` into
    // `[{Name:'db', Value:<expression>}]` — fabricating baseline content AWS
    // never reported, which `cdkd drift --revert` then pushes to the live
    // resource. That is the issue #1917 / #1498 class this module already
    // refuses to commit elsewhere.
    //
    // An unpairable array is therefore walked only when the positions
    // themselves corroborate the alignment — the anchor pass added for issue
    // [#2012](https://github.com/go-to-k/cdkd/issues/2012), below. Where they
    // do not, the refusal stands for the original reason: with an empty secrets
    // map there is no needle, and with no identity there is no position, so
    // nothing can distinguish a resolved secret from an ordinary literal.
    //
    // Until issue #2852 that refusal PERSISTED the plaintext, which made the
    // safe-looking "return the bag unchanged" the disclosure itself. Being
    // unable to tell a secret from a literal is a reason to keep NEITHER, so
    // the arm now masks; the source is still not written, because that is the
    // fabrication this comment's own paragraph above rejects.
    const key = identityKeyFor(bag, source);
    if (key === undefined) {
      // ANCHOR PAIRING (issue #2012). No identity field, so the only thing that
      // can pair these is POSITION — and position alone is exactly what the
      // paragraph above refuses. What licenses it is corroboration: the index
      // counts match, every position the source does NOT spell as a reference
      // is deep-equal on both sides, each reference-bearing element carries its
      // own evidence, and no two of them look alike to the anchors. AWS's own
      // unrewritten values then vouch for the alignment, and a reorder they
      // cannot see is refused rather than guessed at. The last two conditions
      // are the review's, not the original formulation's, and the shapes that
      // forced them are named on `unkeyedArrayPairsByAnchors`.
      // FAIL CLOSED (issue #2852). The paragraph above is unchanged about what
      // may be SUBSTITUTED here — nothing, because nothing pairs — but the
      // refusal used to hand the RAW bag on, so the decrypted readback of every
      // reference this source spells was persisted verbatim. Keeping the
      // plaintext was never the safe half of that trade; it is the disclosure
      // the module exists to prevent. See {@link refuseUncertifiedSubtree}.
      if (!unkeyedArrayPairsByAnchors(bag, source))
        return refuseAgainstSource(bag, source, failClosed, mark);
      return bag.map((item, i) =>
        refuseUncertifiedReadbackPositions(item, source[i], secrets, failClosed, learn, mark)
      );
    }
    const sourceByIdentity = new Map<string, unknown>();
    for (const item of source) {
      sourceByIdentity.set((item as Record<string, unknown>)[key] as string, item);
    }
    // Computed ONCE over the whole array rather than per unpaired element: the
    // question is about the SOURCE's leftovers, which do not change as the map
    // below is walked. See {@link unpairedSourceCarriesReference} for why an
    // unpaired element is refused only when the source has an unpaired
    // reference to account for.
    const bagIdentities = new Set(
      bag.map((item) => (item as Record<string, unknown>)[key] as string)
    );
    const orphanedReference = unpairedSourceCarriesReference(source, key, bagIdentities);
    // Built ONCE for the whole array rather than per element. The refusal below
    // runs inside `bag.map` against the SAME source array, so calling
    // {@link refuseAgainstSource} there rebuilt the literal set for every
    // element and made the arm quadratic in the array's size (measured on an
    // 800-element list: 155 ms, against 0.7 ms with the set hoisted). The
    // destination flag is spelled here rather than inherited because this path
    // no longer goes through `refuseAgainstSource`.
    const orphanLiterals =
      orphanedReference && failClosed === true ? wholeStringLeavesOf(source) : undefined;
    return bag.map((item) => {
      const partner = sourceByIdentity.get((item as Record<string, unknown>)[key] as string);
      return partner === undefined
        ? // FAIL CLOSED (issue #2852) when the source has a reference-bearing
          // element that found no partner — an identity key AWS normalised
          // (case, or a name expanded to an ARN) lands here, and the plaintext
          // it dropped is in this remainder. With no such leftover the element
          // is a peer AWS added and keeps its value, which is the row derived
          // needles (issue #2012) close when they can.
          orphanLiterals !== undefined
          ? refuseUncertifiedSubtree(item, orphanLiterals, mark)
          : item
        : refuseUncertifiedReadbackPositions(item, partner, secrets, failClosed, learn, mark);
    });
  }
  // Shapes diverged (a scalar where the source has a container, or the reverse)
  // while the source subtree still carries a reference. The source is still not
  // SUBSTITUTED here, for the reason the unpairable array gives: writing it
  // would fabricate a baseline AWS never reported. The one shape that IS
  // substituted is the string leaf at the top of this function, where the
  // position is exact and the source is the same generation.
  //
  // What CHANGED for issue [#2852](https://github.com/go-to-k/cdkd/issues/2852)
  // is that "not substituted" no longer means "persist the readback". This arm
  // was the widest of the fail-open branches — every reshaped container, every
  // added wrapper level, every scalar promoted to a container, and the whole
  // raw-intrinsic population of issue
  // [#2846](https://github.com/go-to-k/cdkd/issues/2846) (a record whose
  // `properties` hold the `Fn::Join` / `Fn::Sub` OBJECT `cdkd import`'s warn
  // path writes, against a readback whose leaf is a STRING) lands here. All of
  // them persisted the decrypted value. They now fail closed; see
  // {@link refuseUncertifiedSubtree}.
  return refuseAgainstSource(bag, source, failClosed, mark);
}

/**
 * Deep-clone `bag`, replacing every occurrence of a recorded secret value with
 * the unresolved `{{resolve:...}}` expression it came from. A string whose WHOLE
 * value equals a secret is replaced by that secret's expression exactly; a
 * string that merely CONTAINS one (an `Fn::Join` / `Fn::Sub` result) has the
 * secret substring replaced in place. Returns the input by identity when there
 * is nothing to redact, so callers can persist the original object unchanged in
 * the common no-secret case.
 *
 * A leaf that still CONTAINS a containment needle after every pass is
 * replaced WHOLE by {@link SECRET_MASK} (go-to-k/cdkd#2453); see
 * {@link flattenEmbeddedNoEchoLeaves}.
 */
export function redactSecretsForState<T>(
  bag: T,
  secrets: RecordedSecretValues,
  source?: unknown,
  rules: PathSourceRules = TEMPLATE_DERIVED_RULES
): T {
  return flattenEmbeddedNoEchoLeaves(
    redactSecretsForStatePasses(bag, secrets, source, rules),
    secrets
  );
}

/** {@link redactSecretsForState} without the containment arm. */
function redactSecretsForStatePasses<T>(
  bag: T,
  secrets: RecordedSecretValues,
  source: unknown,
  rules: PathSourceRules
): T {
  // The PATH pass runs even with no recorded secrets — that is the whole point
  // for an UNCHANGED resource, whose `perResourceSecrets` entry is empty
  // because it was never resolved this deploy (issue #1900).
  if (secrets.size === 0 && source === undefined) return bag;
  if (source !== undefined) {
    // BOTH POSITION PASSES FIRST, over the UNTOUCHED bag. `secrets` is EMPTY by
    // construction on the paths this pass was BUILT for — `cdkd state
    // refresh-observed`, `cdkd import`'s observed capture, and the deploy's own
    // `drainObservedCaptures` baseline — so `redactByPath`'s value arms are
    // no-ops there and this pair is byte-identical to the shipped pipeline.
    // NOT on every caller of {@link isReadbackProjectedFromState}: `cdkd drift
    // --accept` / `--revert`, the rollback replay's trailing scrub and the
    // deploy journal's `previousState` all reach it with a POPULATED map, where
    // the value arms do run. A populated map is NOT evidence that nothing is
    // left to protect, either — it holds TODAY's value, and a rotated secret
    // leaves the state bag on the previous one — which is why the fail-closed
    // refusal keys on the caller's DESTINATION rather than on the map at all;
    // see {@link PathSourceRules.failClosedOnUncertifiedPositions}. The DERIVED needles are then scanned over the RAW
    // bag and MERGED over this pair's output by
    // {@link preferPositionDecisions} — NOT run "after" it, which is a
    // distinction PR #2415 paid for twice.
    //
    // The first revision fed the derived map into `redactByPath` BEFORE the
    // refusal pass, and the security review probed the regression: the value
    // scan can rewrite a frame LITERAL that happens to contain a learned
    // plaintext (a coinciding anchor — exactly this issue's population), after
    // which `unkeyedArrayPairsByAnchors` re-runs against the SCANNED bag, the
    // rewritten anchor no longer deep-equals its source, the WHOLE array
    // refuses, and a sibling MIXED leaf that the shipped code redacts BY
    // POSITION persists in full plaintext. A derived needle could therefore
    // UN-CERTIFY a pairing — a regression of shipped redaction, in the
    // GHSA-p5qg-v9gv-hc7w disclosure direction.
    //
    // The second revision simply ran the scan LAST over their output, which is
    // the MIRROR defect — see {@link preferPositionDecisions}, where both are
    // measured and the merge that ends them is argued.
    // The generation mark is read for the OBJECT this call was handed and
    // threaded down the walk unchanged: a sub-bag walked on its own (a
    // caller's slice) is a different object and answers `false`, which is the
    // safe direction -- unless its caller marked it, as
    // `recordNestedStackParameterExpressions` marks the COPY of a nested-stack
    // `Parameters` block it hands in (issue #2745).
    const positioned = redactByPath(
      bag,
      source,
      secrets,
      rules,
      recordedExpressionsOf(secrets),
      isSameGenerationBag(bag)
    );
    if (!isReadbackProjectedFromState(rules)) return positioned as T;
    // The path pass certifies a WHOLE-TOKEN source leaf and nothing else, so on
    // the readback paths — where the map can be empty and the value scan is a
    // no-op — a MIXED leaf or an unpairable array still held plaintext. Every
    // caller of those paths inherits the refusal from here rather than
    // spelling it at the call site: `cdkd state refresh-observed`, the deploy's
    // own `drainObservedCaptures` baseline (through `scrubResourceRecord` at
    // the persist choke point), and any future one.
    //
    // NOT `cdkd scrub`: its observed walk passes
    // `STATE_SOURCED_CROSS_GENERATION_RULES`, whose `sourceIsSameGeneration:
    // false` makes the gate above return false. That is deliberate — scrub has
    // already repositioned `properties` onto TODAY's template — and it is
    // stated here because two earlier revisions of this comment listed scrub as
    // an inheritor, which the gate contradicts one screen away.
    //
    // `secrets`, NOT the derived map, and this is the one line where the
    // distinction can turn a fix into a disclosure. The refusal pass reads its
    // map for exactly one decision — {@link mixedLeafMayCarryPublicReference} —
    // and that predicate SPLITS on whether a map exists: a non-empty map means
    // "a resolution pass ran, so absence from the verdict store is evidence of
    // a PUBLIC parameter, keep the resolved value". A DERIVED map satisfies
    // `size > 0` while proving nothing of the kind — nothing was resolved and
    // nothing could have been recorded — so handing it over would read every
    // `{{resolve:ssm:` mixed leaf as public and persist the decrypted
    // `SecureString`. That is the regression the `secrets-dynamic-ref` integ
    // caught before #1926 shipped, reachable again through a new door. Neither
    // the merge nor anything above softens it: the derived map still never
    // reaches this call.
    const failClosed = rules.failClosedOnUncertifiedPositions === true;
    const refused = refuseUncertifiedReadbackPositions(positioned, source, secrets, failClosed);
    // DERIVED NEEDLES (issue #2012), scanned over the RAW bag and MERGED over
    // the two passes above. On an empty-map readback path the value scan has
    // nothing to look for, which is why the two positionless shapes kept their
    // plaintext. This gives it needles taken from the record's OWN certified
    // positions — see {@link deriveReadbackNeedles}. Every other caller gets
    // `secrets` back by identity, so nothing else changes.
    //
    // The LEARN pass reads `bag`, the RAW readback, not `refused`: it needs the
    // pre-substitution values, since a position the refusal pass has already
    // rewritten onto its source expression no longer carries the plaintext the
    // pairing is made of.
    const derived = deriveReadbackNeedles(bag, source, secrets, rules);
    if (derived === undefined) return refused as T;
    // Scanned over the RAW bag, then merged so the passes above win wherever
    // they DECIDED a position — see {@link preferPositionDecisions} for the two
    // fabricated-baseline shapes the naive orderings produce. Scanning `bag`
    // rather than `refused` also means the scan never sees a persisted
    // expression, so it cannot splice a needle into one.
    // The MARK pass: the same walk again, over the same inputs, returning
    // POSITION_DECIDED wherever it decides. Cheap (in-memory, no needles, no
    // learning) and exact, because it IS the pass rather than a mirror of it.
    const marks = refuseUncertifiedReadbackPositions(
      positioned,
      source,
      secrets,
      failClosed,
      undefined,
      true
    );
    return preferPositionDecisions(
      redactSecretsForState(bag, derived.certain),
      refused,
      bag,
      marks,
      derived.inferred
    ) as T;
  }
  // `substringNeedlesOf`, not `secrets.keys()`: the MASK-ONLY class (issue
  // #2274) is withheld from this scan and reaches the whole-value arm below
  // (and, for a fresh `NoEcho` value, the containment arm the exported
  // wrapper runs afterwards). See the mask-only channel note above — an inline `***` cannot be told from
  // a user's own literal, so nothing downstream could recognise it and
  // `drift --revert` / the rollback replay would push the corrupted string to
  // AWS. Every EXPRESSION-bearing needle is unaffected, so a bag with no
  // mask-only entry produces a byte-identical regex.
  const regex = buildNeedleRegex(substringNeedlesOf(secrets));
  // Even below the needle threshold, a NON-EMPTY whole-value match must still be
  // redacted. An empty-string secret is never a needle (it would match every
  // empty leaf and corrupt unrelated properties); a resolved secret of '' is
  // degenerate and the resolver does not record one.
  //
  // This arm is ALSO where a mask-only entry is served: `secrets.get(s)` is
  // {@link SECRET_MASK} for one, so the leaf is replaced WHOLE.
  const wholeValueExpr = (s: string): string | undefined => (s === '' ? undefined : secrets.get(s));

  /**
   * The SUBSTRING arm for a leaf the resolver substituted INTO rather than
   * replaced. ONE rule over the WHOLE leaf (issue
   * [#1935](https://github.com/go-to-k/cdkd/issues/1935)):
   *
   * > replace every recorded-plaintext match EXCEPT one that lies STRICTLY
   * > INSIDE a complete `{{resolve:...}}` span.
   *
   * "Strictly inside" means contained by a span and SHORTER than it. The four
   * positions a match can take, and why each lands where it does:
   *
   * - **strictly inside a span** -> KEPT. This is the defect: a plaintext that
   *   happens to occur inside a token's own TEXT was spliced into the
   *   reference. Deploy 1 persists
   *   `jdbc://appdb:{{resolve:secretsmanager:appdb/creds:SecretString:password}}@host`;
   *   deploy 2 records an ssm SecureString whose plaintext is `appdb`; the walk
   *   wrote `{{resolve:secretsmanager:{{resolve:ssm:/app/dbname}}/creds:...}}`.
   *   `resolveReplayProps` scans with `([^}]+)`, which stops at the FIRST `}`,
   *   so the replay asks Secrets Manager for the secret id
   *   `{{resolve:ssm:/app/dbname` — rollback blocked, or garbage applied to a
   *   live resource. `cdkd scrub` writes the same wreckage into `properties`
   *   and `observedProperties`.
   * - **coextensive with a span** -> REPLACED. A secret whose resolved
   *   PLAINTEXT is itself a `{{resolve:...}}` string (issue #1917), embedded in
   *   a larger leaf. This is why "mask only OUTSIDE the spans" is wrong on its
   *   own: that plaintext IS a span, so span-skipping would stop redacting it
   *   and trade a mangling bug for a disclosure.
   * - **containing or straddling a span** -> REPLACED. A recorded plaintext
   *   that embeds a whole reference plus surrounding text. Nothing is spliced,
   *   because the whole reference is consumed by the replacement. An earlier
   *   revision of this fix expressed the rule as TWO rules — replace a span
   *   that is a recorded plaintext, value-scan the text between spans — and
   *   that form DROPPED this case at both ends (it is neither a whole span nor
   *   contained in the text between spans), persisting the plaintext in the
   *   clear where the pre-fix code had redacted it. A REGRESSION, caught by the
   *   security review, and the reason the rule is one predicate over the whole
   *   leaf rather than a split.
   * - **disjoint from every span** -> REPLACED. The ordinary embedded secret.
   * - **inside a span whose service cdkd does not resolve** -> REPLACED (issue
   *   [#2743](https://github.com/go-to-k/cdkd/issues/2743)). Such a span is not
   *   a reference: `{{resolve:<plaintext>}}` is what an `Fn::Sub` putting a
   *   resolved secret in the SERVICE position assembled, and sparing it
   *   persisted the plaintext. The result, `{{resolve:{{resolve:...}}}}`, is
   *   garbage but not plaintext, the same trade as the stray-opener residual
   *   below; the REAL reference nested in it is protected again
   *   ({@link resolvableReferenceSpans}). The cost: an untainted look-alike
   *   token whose text coincides with a recorded secret is rewritten like any
   *   other text, and a replay then sends the rewritten literal.
   *
   * Scanning the WHOLE leaf in ONE pass is also what preserves what needle
   * PRECEDENCE there is. {@link buildNeedleRegex} sorts alternatives
   * longest-first, which decides only between alternatives matching at the SAME
   * offset; the scan itself is LEFTMOST-first, so a shorter secret starting
   * EARLIER still wins and the tail of the longer one survives in the clear
   * (`zzABCDEFzz` with needles `ABCD` / `BCDEF` leaves `EF`). That is regex
   * semantics, identical before and after this change, and is not something
   * this rule claims to fix.
   *
   * What the single pass DOES restore is the same-offset ordering across a span
   * boundary. The two-rule form scanned each BETWEEN-span stretch separately,
   * so a long straddling needle was never even a candidate and a short one
   * starting later in the tail won by default — the leaf took the WRONG
   * expression, which the replay then re-resolves and applies (the issue #1910
   * class).
   *
   * TWO KNOWN RESIDUALS around a STRAY `{{resolve:` opener, both pinned by
   * tests rather than left as prose, and they fail in OPPOSITE directions
   * because the span grammar is greedy `[^}]+` (deliberately — it is the
   * resolver's own spelling, unified by issue #1936):
   *
   * - **no later `}}` in the leaf** -> no span, so a needle after the opener is
   *   REPLACED and the result reads as a reference to a bogus secret id.
   *   Identical to the pre-fix code. Refusing to redact there would leave
   *   PLAINTEXT behind two characters any string can contain.
   * - **a later `}}` anywhere in the leaf** -> the opener and that `}}` form
   *   ONE span swallowing everything between them, so a needle in that region
   *   is KEPT when the opener spells a resolvable service (`{{resolve:ssm:`
   *   ...; any other opener is the unresolvable-service row above) — the only
   *   shape where this rule redacts LESS than the code it replaced. Narrow but real, and the reachable carrier is named rather than
   *   waved at: the resolver shares this grammar, so such a leaf could not have
   *   resolved on the deploy path, which leaves an `observedProperties`
   *   READBACK (arbitrary text from AWS) as the way one arrives.
   *
   * Narrowing the span pattern here would close the second and open two worse
   * holes: it would re-fork the one grammar issue #1936 unified, and it would
   * make an ALREADY-MANGLED legacy leaf parse differently and be spliced again,
   * contradicting this change's own "not repaired, not made worse" property.
   * So the residual is documented, not fixed.
   */
  // Built once per pass, and only if a leaf needs it.
  let vouched: Set<string> | undefined;
  const vouchedExpressions = (): ReadonlySet<string> => (vouched ??= new Set(secrets.values()));
  const scanLeaf = (value: string, needles: RegExp): string => {
    // Only a leaf that HOLDS a reference can have a span, and the dominant leaf
    // does not — so the offsets are computed only where they can matter.
    const spans = isDynamicReferenceString(value)
      ? resolvableReferenceSpans(value, vouchedExpressions())
      : [];
    // No `lastIndex` reset before `replace`: `RegExp.prototype[Symbol.replace]`
    // sets it to 0 itself for a `/g` pattern. The reset before `.test` at the
    // call site is the one that IS needed.
    return value.replace(needles, (match: string, offset: number) => {
      if (isStrictlyInsideASpan(spans, offset, offset + match.length)) return match;
      // Unreachable today: `needles` is built from {@link substringNeedlesOf},
      // i.e. from `secrets.keys()` minus the mask-only class, so every match is
      // a key. (It was `secrets.keys()` verbatim before issue #2274 narrowed
      // the substring arm; the reachability argument is unchanged, since
      // narrowing the needle set can only REMOVE matches.) {@link SECRET_MASK}
      // anyway on a miss, and the polarity is the
      // whole point of keeping a dead branch — a caller that ever hands this
      // function a regex built from somewhere else gets a MASK rather than the
      // plaintext. An earlier revision made it identity on the grounds that the
      // branch cannot run; a branch that cannot run still has to fail in the
      // safe direction, because the day it runs is the day nobody is looking.
      return secrets.get(match) ?? SECRET_MASK;
    });
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = wholeValueExpr(value);
      if (whole !== undefined) return whole;
      // A leaf that is ALREADY a complete `{{resolve:...}}` token is an
      // EXPRESSION, not text that might embed a secret, so the substring arm
      // below must not touch it. Without this a recorded secret VALUE that
      // happens to occur inside the token's own text — a SecureString parameter
      // holding `prod`, inside
      // `{{resolve:secretsmanager:prod/db:SecretString:pw}}` — is spliced into
      // the reference, corrupting a persisted expression into one no service
      // can resolve. Reached with no source on the journal's `previousState`
      // walk and on `attributes`, so it is not reachable only through the
      // path pass.
      //
      // {@link scanLeaf} answers this shape identically, and the argument is
      // short enough to check: the whole-value arm above has already ruled out
      // the leaf BEING a recorded plaintext, so no match can be coextensive
      // with the single span covering it, and every other match is strictly
      // inside that span and therefore kept. It stays as an EARLY-OUT because
      // the whole-token leaf is what a re-scrub of already-clean state is made
      // of, and it costs a `matchAll` plus a string rebuild otherwise.
      //
      // Removing it is an EQUIVALENT mutant, so no test can red on it — stated
      // rather than claimed pinned, which an earlier revision of this comment
      // got wrong. What IS pinned is the ANSWER for this shape, so an edit that
      // makes the two paths disagree reds whichever one it broke.
      //
      // Only for a token naming a service cdkd RESOLVES (issue #2743): see
      // {@link spanNamesResolvableService}.
      if (isSingleDynamicReferenceToken(value) && spanNamesResolvableService(value)) return value;
      // No needle can be a token-shaped plaintext either: the shortest possible
      // `{{resolve:x}}` is far longer than {@link MIN_NEEDLE_LENGTH}, so an
      // absent regex means nothing in this leaf can be rewritten at all.
      if (!regex) return value;
      // `.test` on a `/g` pattern ADVANCES `lastIndex`, so it is reset before
      // every use. A leaf holding no needle occurrence cannot be rewritten:
      // a span that is a recorded plaintext would be a needle match itself.
      regex.lastIndex = 0;
      if (!regex.test(value)) return value;
      return scanLeaf(value, regex);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === 'object') {
      // A readback `Date` (`LastModified`, `CreationDate`) is kept BY IDENTITY
      // (issue [#2427](https://github.com/go-to-k/cdkd/issues/2427)): it has no
      // own entries, so the rebuild below turned it into `{}` — a drift
      // baseline AWS never reported, which `cdkd drift --revert` can push. See
      // {@link isOrdinaryDate} for why this is not every non-plain object.
      if (isOrdinaryDate(value)) {
        // Identity only when the PERSISTED form survives the string arms: a
        // recorded plaintext can itself be an ISO timestamp, and the string
        // spelling of the same value is replaced there (PR #3586 review).
        // `toJSON` is `Date.prototype`'s own (no own keys) — the ISO string,
        // or `null` for an invalid date, which no needle can match.
        const persisted = value.toJSON();
        if (typeof persisted !== 'string') return value;
        const scanned = walk(persisted);
        return scanned === persisted ? value : scanned;
      }
      // Null-prototype for the same reason the path walk uses one: an own
      // `__proto__` key must land as DATA, not on the prototype.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  };

  return walk(bag) as T;
}

/**
 * Redact resolved secret plaintext out of one resource state record's
 * `properties` / `attributes` / `observedProperties`, replacing each secret
 * value with its unresolved expression. Returns a NEW record when any field
 * changed, or the input by identity when there are no secrets — so callers can
 * detect a no-op cheaply. Shared by the deploy engine's save choke point and
 * the `cdkd scrub` command so both scrub the same three fields identically.
 *
 * `observedRules` overrides the rules the `observedProperties` walk would
 * otherwise DERIVE from whether a `sourceProperties` bag was supplied. Exactly
 * one caller needs it and the reason is not obvious, so it is a parameter
 * rather than another derivation: `cdkd scrub` has already repositioned
 * `properties` against TODAY's template by the time it calls this, so the
 * "record's own properties" this walk falls back to are no longer the same
 * GENERATION as the observed bag beside them (issue #1917 review). Left
 * unspecified, the derivation below is right for every other caller, whose
 * `properties` reach this function untouched.
 *
 * That derivation's fail-closed arm asks TWO questions, not one — the secrets
 * map must be EMPTY and the observed bag must be one THIS RUN produced (issue
 * [#2906](https://github.com/go-to-k/cdkd/issues/2906)). A caller re-writing a
 * PRIOR generation's `observedProperties` unchanged therefore keeps it intact
 * rather than masking positions it cannot pair. A caller whose bag IS fresh but
 * which does not route it through {@link markSameGenerationBag} should pass
 * {@link STATE_SOURCED_BASELINE_RULES} through `observedRules` rather than lean
 * on the derivation.
 */
export function scrubResourceRecord<
  T extends {
    properties: Record<string, unknown>;
    attributes?: Record<string, unknown>;
    observedProperties?: Record<string, unknown>;
  },
>(
  record: T,
  secrets: RecordedSecretValues,
  sourceProperties?: Record<string, unknown>,
  observedRules?: PathSourceRules
): T {
  // NOT `sourceProperties === undefined`: an UNCHANGED resource has neither a
  // secrets map nor a template bag, and its observed bag is exactly what needs
  // redacting (issue #1900) — so an early return gated on those two alone made
  // that half dead code.
  if (secrets.size === 0 && sourceProperties === undefined && !record.observedProperties) {
    return record;
  }
  const next = { ...record };
  next.properties = redactSecretsForState(record.properties, secrets, sourceProperties);
  if (record.attributes) next.attributes = redactSecretsForState(record.attributes, secrets);
  if (record.observedProperties) {
    // `observedProperties` is a live AWS readback, so its OWN source of truth is
    // the record's (already redacted) `properties` — a member whose stored value
    // is an expression must not be overwritten by the plaintext AWS echoes back
    // (issue #1900). When a `sourceProperties` bag was supplied it is the
    // template, which is the better source; otherwise fall back to the record's
    // own properties, which is what makes an UNCHANGED resource redactable at
    // all.
    // `next.properties`, not `record.properties`: the just-redacted bag is the
    // one that actually holds expressions. On the `cdkd scrub` path the original
    // is still plaintext, so using it would degrade this to the value scan.
    // The RULES differ by which source we ended up with, which is the whole
    // point of them being separate flags: a TEMPLATE source carries public ssm
    // expressions (so no blanket trust) and is a different generation from this
    // bag (so it may not overwrite a leaf that already holds an expression),
    // while the record's own untouched properties are neither (so the #1900
    // no-secrets-map path works). Neither descends arrays POSITIONALLY, because
    // this bag came back from AWS and AWS does not preserve list order — both
    // still descend by an element IDENTITY KEY, which is order-independent
    // (issue #1915).
    //
    // `observedRules` wins when the caller supplied one, because a caller can
    // know something this derivation cannot: that it already MOVED
    // `next.properties` to another generation. See the parameter's doc.
    next.observedProperties = redactSecretsForState(
      record.observedProperties,
      secrets,
      sourceProperties ?? next.properties,
      observedRules ??
        // This branch redacts `observedProperties` SPECIFICALLY, so the
        // DESTINATION is known here and the fail-closed refusal of issue #2852
        // may apply — which is how the deploy's `drainObservedCaptures`
        // baseline gets it without a call-site change.
        //
        // `secrets.size === 0` narrows it further, and the reason is a
        // MEASUREMENT rather than symmetry with the destination flag. The
        // rollback replay's trailing scrub always arrives with a POPULATED
        // map, and the deploy JOURNAL's `previousState` no longer consults
        // this derivation at all — `redactOperationsForJournal` passes the
        // readback constant explicitly (issue
        // [#2886](https://github.com/go-to-k/cdkd/issues/2886)), because its
        // empty-map ops took the fail-closed arm here and a rollback restore
        // carried the resulting masks into the persisted record. Both are
        // REPLAYED baselines: the bag is a previous generation's readback, and
        // masking a position there poisons the record a rollback then persists,
        // for a leaf the scan had every chance to name.
        //
        // `secrets.size === 0` is NOT SUFFICIENT ON ITS OWN, and the sentence
        // that used to end this paragraph — "what is left on this empty-map arm
        // is exactly the deploy persist choke point's #1900 walk, the fresh
        // drained readback the refusal exists for" — was FALSE (issue
        // [#2906](https://github.com/go-to-k/cdkd/issues/2906)). The same
        // empty-map arm is also taken by `redactStateForPersist` on every
        // FAILURE-PATH and intermediate save, for a resource whose resolve
        // threw before recording anything: there the observed bag is the PRIOR
        // generation's `observedProperties`, read out of `state.json` and being
        // RE-WRITTEN UNCHANGED. Masking an unpairable position in THAT bag —
        // an array AWS reordered, an identity key AWS normalised — replaces a
        // correct persisted baseline with {@link SECRET_MASK} and produces
        // permanent phantom drift no `cdkd drift` run clears, until the next
        // SUCCESSFUL deploy's `drainObservedCaptures` overwrites the record.
        // Exactly the two REPLAYED-baseline cases above, one writer over.
        //
        // So the arm asks the question those two answer by construction: is
        // this bag one THIS RUN PRODUCED? {@link markSameGenerationBag} already
        // answers it, and the mark is put on precisely the bag the refusal
        // exists for — `DeployEngine.drainObservedCaptures` marks EVERY drained
        // READBACK, and it is the only writer of `observedProperties` on the
        // deploy path, so a bag arriving here UNMARKED is a previous
        // generation's by elimination. The record spread below and
        // `redactStateForPersist`'s preserve the object identity the mark is
        // carried on. The one unmarked bag that drain installs is the
        // masked-baseline re-capture (issue #3595): a previous generation's
        // baseline with some masks replaced by the record's own references, so
        // it holds nothing this run read from AWS and the argument below
        // covers it unchanged.
        //
        // Failing OPEN on an unmarked bag is safe for the reason the two
        // replayed cases give and for no other: the bag ALREADY SITS in
        // `state.json` verbatim, so a mask protects no reader who is not
        // already exposed, while it destroys a baseline that was intact. A
        // caller whose bag is fresh but which cannot mark it should pass
        // {@link STATE_SOURCED_BASELINE_RULES} through `observedRules`, the way
        // `cdkd state refresh-observed` and `cdkd import`'s observed capture
        // already do — neither reaches this derivation at all.
        //
        // The evidence is per-VALUE, not per-map, and this comment said
        // otherwise until a review measured it: a rotated secret, or a
        // pre-GHSA legacy leaf, is not a key of THIS pass's map, so a populated
        // map does not mean every plaintext in the bag was covered. What the
        // narrowing buys is not "nothing left to protect" — it is that the
        // value already sits in `state.json` (`cdkd scrub` is its repairer) and
        // a mask here would be a fresh, permanent hole in a baseline
        // `cdkd drift --accept` then refuses for the life of the record.
        //
        // It is safe to key on the map HERE, unlike inside the walk, precisely
        // because the destination is already settled: the question left is
        // evidence, not where the bag lands.
        //
        // A caller that supplied `observedRules` keeps its own choice.
        (sourceProperties !== undefined
          ? TEMPLATE_SOURCED_RULES
          : secrets.size === 0 && isSameGenerationBag(record.observedProperties)
            ? STATE_SOURCED_BASELINE_RULES
            : STATE_SOURCED_READBACK_RULES)
    );
  }
  return next;
}
