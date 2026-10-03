import {
  isSingleDynamicReferenceToken,
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
  deriveReadbackNeedles,
  preferPositionDecisions,
  resolvableReferenceSpans,
} from './anchors.js';
import { SECRET_MASK, type RecordedSecretValues, isSameGenerationBag } from './pairs.js';
import { redactByPath, isReadbackProjectedFromState, isOrdinaryDate } from './redact-path.js';
import {
  flattenEmbeddedNoEchoLeaves,
  recordedExpressionsOf,
  substringNeedlesOf,
  isStrictlyInsideASpan,
} from './fresh-noecho.js';
import { refuseUncertifiedReadbackPositions } from './readback-certification.js';

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
  // wrapper runs afterwards). See the mask-only channel note in mask-only.ts — an inline `***` cannot be told from
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
