import {
  isSingleDynamicReferenceToken,
  isDynamicReferenceString,
  type PathSourceRules,
  TEMPLATE_DERIVED_RULES,
  buildNeedleRegex,
} from './rules.js';
import {
  spanNamesResolvableService,
  deriveReadbackNeedles,
  preferPositionDecisions,
  resolvableReferenceSpans,
} from './anchors.js';
import { SECRET_MASK, type RecordedSecretValues } from './pairs.js';
import { redactForState, redactAtProvenance } from './context.js';
import { redactByPath, isReadbackProjectedFromState, isOrdinaryDate } from './redact-path.js';
import {
  cutsContainmentNeedle,
  flattenEmbeddedNoEchoLeaves,
  recordedExpressionsOf,
  substringNeedlesOf,
  isStrictlyInsideASpan,
} from './fresh-noecho.js';
import { refuseUncertifiedReadbackPositions } from './readback-certification.js';
import {
  attributeIdCopiesOf,
  physicalNameCopiesOf,
  physicalNameSpans,
} from './physical-name-copies.js';

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
 *
 * `bagIsSameGeneration` is the writer's claim that `bag` is THIS pass's own
 * resolution of `source` (see {@link markSameGenerationBag} for what it
 * licenses). It defaults to `false`, the safe direction: unclaimed, a sub-floor
 * embedded secret keeps the value scan's answer. The walk never reads a mark
 * off the bag (go-to-k/cdkd#5047); `redactForState` and `redactAtProvenance`
 * pass it from the caller's stated claim. Family-private: the barrel does not
 * export this function.
 */
export function redactSecretsForState<T>(
  bag: T,
  secrets: RecordedSecretValues,
  source?: unknown,
  rules: PathSourceRules = TEMPLATE_DERIVED_RULES,
  bagIsSameGeneration = false
): T {
  return flattenEmbeddedNoEchoLeaves(
    redactSecretsForStatePasses(bag, secrets, source, rules, bagIsSameGeneration),
    secrets
  );
}

/** {@link redactSecretsForState} without the containment arm. */
function redactSecretsForStatePasses<T>(
  bag: T,
  secrets: RecordedSecretValues,
  source: unknown,
  rules: PathSourceRules,
  bagIsSameGeneration: boolean
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
    // The generation claim is the caller's ARGUMENT, threaded down the walk
    // unchanged; it is never read off the bag (go-to-k/cdkd#5047), so a
    // sub-bag walked on its own (a caller's slice) claims nothing unless its
    // caller says so, as `recordNestedStackParameterExpressions` does for the
    // copy of a nested-stack `Parameters` block it hands in (issue #2745).
    const positioned = redactByPath(
      bag,
      source,
      secrets,
      rules,
      recordedExpressionsOf(secrets),
      bagIsSameGeneration
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
      redactForState(bag, { provenance: 'value-scan', secrets: derived.certain }),
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
  // The physical ids this pass read (go-to-k/cdkd#4810): a copy of one stays
  // as it is, since the id itself is stored in plaintext. See
  // {@link physicalNameCopiesOf}.
  const physicalNames = physicalNameCopiesOf.get(secrets);

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
   * offset; the scan itself is LEFTMOST-first, so of two matches that OVERLAP
   * at different offsets it consumed the earlier one and left the later one's
   * tail in the clear (`zzABCDEFzz` with needles `ABCD` / `BCDEF` left `EF`).
   * Overlapping matches are therefore taken out of the replace and answered
   * by {@link redactOverlappingMatches} (go-to-k/cdkd#4986).
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
  const expressionFor = (match: string): string => {
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
  };
  const scanLeaf = (value: string, needles: RegExp): string => {
    // Only a leaf that HOLDS a reference can have a span, and the dominant leaf
    // does not — so the offsets are computed only where they can matter.
    const spans = isDynamicReferenceString(value)
      ? resolvableReferenceSpans(value, vouchedExpressions())
      : [];
    const names = physicalNameSpans(physicalNames, value);
    const kept = (start: number, end: number): boolean =>
      isStrictlyInsideASpan(spans, start, end) ||
      // Inside (or equal to) an occurrence of a physical id this pass read.
      names.some((n) => n.start <= start && end <= n.end);
    // go-to-k/cdkd#4986: matches that OVERLAP take the union rule below, and
    // only they do; a leaf whose matches are disjoint is answered by the
    // replace that follows, byte-identically to before.
    // `withLegacyOverlapScan` skips this block to reproduce what a pre-fix
    // cdkd persisted, for the one-time repair of such a record.
    if (!legacyOverlapScan.has(secrets)) {
      const matches = everyMatch(value, needles);
      const redacted = matches.filter((m) => !kept(m.start, m.end));
      // A containment needle (a fresh `NoEcho` value, a derived `Fn::Base64`
      // one) is no substring needle, so a redacted match can cut it, leaving
      // the rest in the clear where the containment post-pass no longer finds
      // it whole. Such a leaf is masked WHOLE here, as that post-pass would.
      if (cutsContainmentNeedle(value, secrets, redacted)) {
        overlapAnswered.add(secrets);
        return SECRET_MASK;
      }
      const overlapping = redactOverlappingMatches(value, matches, redacted, expressionFor);
      if (overlapping !== undefined) {
        overlapAnswered.add(secrets);
        return overlapping;
      }
    }
    // No `lastIndex` reset before `replace`: `RegExp.prototype[Symbol.replace]`
    // sets it to 0 itself for a `/g` pattern. The reset before `.test` at the
    // call site is the one that IS needed.
    return value.replace(needles, (match: string, offset: number) => {
      if (kept(offset, offset + match.length)) return match;
      return expressionFor(match);
    });
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (physicalNames?.has(value) === true) return value;
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

/** Maps whose walk runs the pre-#4986 leftmost-first scan ({@link withLegacyOverlapScan}). */
const legacyOverlapScan = new WeakSet<RecordedSecretValues>();
/** Maps a walk answered by the #4986 overlap rule at least once. */
const overlapAnswered = new WeakSet<RecordedSecretValues>();

/**
 * Did a walk over `secrets` answer a leaf by the overlap rule of
 * go-to-k/cdkd#4986 (a tiled or masked overlap, or a cut containment
 * needle)? The gate on the one-time legacy repair: a record can hold a
 * pre-fix spelling only where today's walk takes that rule.
 */
export function overlapRuleAnswered(secrets: RecordedSecretValues): boolean {
  return overlapAnswered.has(secrets);
}

/**
 * `run` with the substring arm as a pre-go-to-k/cdkd#4986 cdkd ran it
 * (leftmost-first, no overlap rule), so a caller can compute what such a
 * cdkd PERSISTED for today's value and recognise a record it wrote. The walk
 * is synchronous and the flag is cleared afterwards, also on a throw. Its
 * output can hold plaintext and must never be persisted or printed; it is a
 * comparison key only.
 */
export function withLegacyOverlapScan<T>(secrets: RecordedSecretValues, run: () => T): T {
  if (legacyOverlapScan.has(secrets)) return run();
  legacyOverlapScan.add(secrets);
  try {
    return run();
  } finally {
    legacyOverlapScan.delete(secrets);
  }
}

/**
 * The `[legacy, current]` string leaves that differ at the same position of
 * two bags (go-to-k/cdkd#4986): what a pre-fix walk persisted beside what
 * today's persists, for repairing a leaf no desired value stands beside.
 */
export function differingStringLeaves(
  legacy: unknown,
  current: unknown,
  out: Array<readonly [string, string]> = []
): Array<readonly [string, string]> {
  if (typeof legacy === 'string' && typeof current === 'string') {
    if (legacy !== current) out.push([legacy, current]);
    return out;
  }
  if (Array.isArray(legacy) && Array.isArray(current) && legacy.length === current.length) {
    legacy.forEach((item, i) => differingStringLeaves(item, current[i], out));
    return out;
  }
  if (
    legacy !== null &&
    current !== null &&
    typeof legacy === 'object' &&
    typeof current === 'object' &&
    !Array.isArray(legacy) &&
    !Array.isArray(current)
  ) {
    const c = current as Record<string, unknown>;
    for (const [key, value] of Object.entries(legacy as Record<string, unknown>)) {
      if (Object.hasOwn(c, key)) differingStringLeaves(value, c[key], out);
    }
  }
  return out;
}

/**
 * `legacy` with every string leaf that holds a mask (`***`, whole or inside)
 * dropped to `undefined` (go-to-k/cdkd#5056's repair). A masked spelling
 * cannot tell two values apart: a record holding it would match today's
 * legacy spelling after the masked value rotated, and the repair would then
 * take today's form with no send. Such a leaf is left to the ordinary diff.
 */
export function legacyLeavesWithoutMask(legacy: unknown): unknown {
  if (typeof legacy === 'string') return legacy.includes(SECRET_MASK) ? undefined : legacy;
  if (Array.isArray(legacy)) return legacy.map(legacyLeavesWithoutMask);
  if (legacy !== null && typeof legacy === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(legacy as Record<string, unknown>)) {
      out[key] = legacyLeavesWithoutMask(value);
    }
    return out;
  }
  return legacy;
}

/**
 * `legacy` with every string leaf that holds no `{{resolve:` reference (a
 * whole `***` included) replaced by `undefined`, so a position-wise repair
 * against it touches only a leaf a pre-go-to-k/cdkd#4986 walk spelled with a
 * reference. A stored `***` identifies no value: repairing it to today's
 * spelling would take it out of the masked-property fingerprint comparison
 * and could hide a real edit (PR #4988 security review).
 */
export function legacyReferenceLeavesOnly(legacy: unknown): unknown {
  if (typeof legacy === 'string') return legacy.includes('{{resolve:') ? legacy : undefined;
  if (Array.isArray(legacy)) return legacy.map(legacyReferenceLeavesOnly);
  if (legacy !== null && typeof legacy === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(legacy as Record<string, unknown>)) {
      out[key] = legacyReferenceLeavesOnly(value);
    }
    return out;
  }
  return legacy;
}

/**
 * `value` with every string leaf EQUAL to a pair's legacy spelling replaced
 * by its current one; whole leaves only, so no inline mask is ever made.
 * Returns `value` by identity when nothing changed.
 */
export function replaceWholeLeaves(
  value: unknown,
  pairs: ReadonlyArray<readonly [string, string]>
): unknown {
  if (pairs.length === 0) return value;
  if (typeof value === 'string') {
    const hit = pairs.find(([legacy]) => legacy === value);
    return hit === undefined ? value : hit[1];
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = replaceWholeLeaves(item, pairs);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    let out: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = replaceWholeLeaves(item, pairs);
      if (next !== item) {
        out ??= Object.assign(
          Object.create(null) as Record<string, unknown>,
          value as Record<string, unknown>
        );
        out[key] = next;
      }
    }
    return out ?? value;
  }
  return value;
}

/** A match's offsets in its leaf. */
type MatchSpan = { start: number; end: number };

/**
 * Every match of `needles` in `value`, one per start offset (the longest
 * there, as {@link buildNeedleRegex} sorts the alternation longest-first), in
 * ascending order. Unlike a `replace`, a match beginning inside an earlier one
 * is seen (go-to-k/cdkd#4986).
 */
function everyMatch(value: string, needles: RegExp): MatchSpan[] {
  const matches: MatchSpan[] = [];
  needles.lastIndex = 0;
  for (let m = needles.exec(value); m !== null; m = needles.exec(value)) {
    matches.push({ start: m.index, end: m.index + m[0].length });
    // One past this START, not its end: the next match may begin inside it.
    needles.lastIndex = m.index + 1;
  }
  needles.lastIndex = 0;
  return matches;
}

/**
 * The substring arm's answer for a leaf whose matches OVERLAP
 * (go-to-k/cdkd#4986), or `undefined` when no two of `matches` overlap, which
 * leaves the leaf to the ordinary leftmost-first replace.
 *
 * Over `redacted` (the matches the caller's `kept` predicate does not spare),
 * each run of overlapping matches is a CLUSTER:
 *
 * - matches meeting end to start TILE the cluster (one match spanning it, a
 *   needle CONTAINING the others, is the one-tile case) -> each tile's
 *   expression, which together render exactly the cluster's text;
 * - otherwise no sequence of expressions renders the union, and splicing one
 *   per match would leave the shared characters' other owner in the clear ->
 *   the WHOLE leaf is {@link SECRET_MASK}. Never an inline mask: an inline
 *   `***` cannot be told from a literal, so `drift --revert` and the rollback
 *   replay would send the corrupted string, while a whole `***` leaf is one
 *   they refuse or preserve, and the masked-property fingerprints
 *   (`masked-property-fingerprints.ts`) still see a template edit.
 *
 * A spared match stays text unless a redacted match covers it.
 */
function redactOverlappingMatches(
  value: string,
  matches: readonly MatchSpan[],
  redacted: readonly MatchSpan[],
  expressionFor: (match: string) => string
): string | undefined {
  let reach = 0;
  let overlap = false;
  for (const m of matches) {
    if (m.start < reach) overlap = true;
    reach = Math.max(reach, m.end);
  }
  if (!overlap) return undefined;
  let out = '';
  let cursor = 0;
  for (let i = 0; i < redacted.length;) {
    let end = redacted[i]!.end;
    let j = i + 1;
    for (; j < redacted.length && redacted[j]!.start < end; j++) {
      end = Math.max(end, redacted[j]!.end);
    }
    const cluster = redacted.slice(i, j);
    out += value.slice(cursor, cluster[0]!.start);
    // Starts are distinct, so at most one match begins at each offset.
    for (let at = cluster[0]!.start; at < end;) {
      const tile = cluster.find((m) => m.start === at);
      if (tile === undefined) return SECRET_MASK;
      out += expressionFor(value.slice(tile.start, tile.end));
      at = tile.end;
    }
    cursor = end;
    i = j;
  }
  return out + value.slice(cursor);
}

/** The same-generation claim per bag {@link scrubResourceRecord} walks; absent is `unproven`. */
export interface ScrubGenerationClaims {
  readonly properties?: 'same-generation' | 'unproven';
  readonly observed?: 'same-generation' | 'unproven';
}

/**
 * Redact resolved secret plaintext out of one resource state record's
 * `properties` / `attributes` / `observedProperties`, replacing each secret
 * value with its unresolved expression. Returns a NEW record when any field
 * changed, or the input by identity when there are no secrets — so callers can
 * detect a no-op cheaply. Shared by the deploy engine's save choke point and
 * the `cdkd scrub` command so both scrub the same three fields identically.
 *
 * `observedProvenance` overrides the provenance the `observedProperties` walk
 * would otherwise DERIVE from whether a `sourceProperties` bag was supplied. Exactly
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
 * [#2906](https://github.com/go-to-k/cdkd/issues/2906)), the second being
 * `claims.observed`. A caller re-writing a PRIOR generation's
 * `observedProperties` unchanged therefore keeps it intact rather than masking
 * positions it cannot pair.
 *
 * `claims` is the CALLER's same-generation claim per bag (go-to-k/cdkd#5047):
 * `properties` (read only when `sourceProperties` is given; without one that
 * walk is a value scan) and `observed`. Absent means `unproven`. This function
 * reads no mark: a writer holding a bag the deploy engine marked
 * (`propertiesToRecord`, `drainObservedCaptures`) states what the mark says at
 * its call site.
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
  observedProvenance?: 'state-readback' | 'state-cross-generation',
  claims: ScrubGenerationClaims = {}
): T {
  const propertiesClaimed = claims.properties === 'same-generation';
  const observedClaimed = claims.observed === 'same-generation';
  // NOT `sourceProperties === undefined`: an UNCHANGED resource has neither a
  // secrets map nor a template bag, and its observed bag is exactly what needs
  // redacting (issue #1900) — so an early return gated on those two alone made
  // that half dead code.
  if (secrets.size === 0 && sourceProperties === undefined && !record.observedProperties) {
    return record;
  }
  const next = { ...record };
  next.properties =
    sourceProperties === undefined
      ? redactForState(record.properties, { provenance: 'value-scan', secrets })
      : redactAtProvenance(
          record.properties,
          secrets,
          sourceProperties,
          'template-derived',
          propertiesClaimed
        );
  if (record.attributes) {
    // go-to-k/cdkd#4849: a copy of the record's OWN physical id among its
    // attributes (an SNS topic's `TopicArn`, a queue's `QueueUrl`) stays as
    // the id does, in plaintext: a resource NAMED from a `NoEcho` value would
    // otherwise store the attribute as `***`, and a later `Fn::GetAtt` reader
    // could not resolve it. Nothing new reaches state, since `physicalId` is
    // beside it. Another value containing the secret (`TopicName`, unless the
    // physical id IS the value) is no copy of the id and stays masked. The
    // ids a nested row's outputs copy (`attributeIdCopiesOf`) join it here.
    const ownId = (record as { physicalId?: unknown }).physicalId;
    const ids = [...(attributeIdCopiesOf.get(secrets) ?? [])];
    if (typeof ownId === 'string' && ownId !== '') ids.push(ownId);
    const attributes = record.attributes;
    next.attributes =
      ids.length > 0
        ? withPhysicalNameCopies(secrets, ids, () =>
            redactForState(attributes, { provenance: 'value-scan', secrets })
          )
        : redactForState(attributes, { provenance: 'value-scan', secrets });
  }
  // go-to-k/cdkd#5498: the attempted item names (an index name, a tag key)
  // can be secret-derived, so they take the value scan, as `attributes` do. A
  // name rewritten to its expression or `***` never matches a live item
  // (`isUsableAttemptedName`), so it is kept, never removed.
  const attemptedItems = (record as { unsettledItems?: unknown }).unsettledItems;
  if (
    typeof attemptedItems === 'object' &&
    attemptedItems !== null &&
    !Array.isArray(attemptedItems)
  ) {
    (next as { unsettledItems?: unknown }).unsettledItems = redactForState(
      attemptedItems as Record<string, unknown>,
      { provenance: 'value-scan', secrets }
    );
  }
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
    // `observedProvenance` wins when the caller supplied one, because a caller can
    // know something this derivation cannot: that it already MOVED
    // `next.properties` to another generation. See the parameter's doc.
    next.observedProperties = redactAtProvenance(
      record.observedProperties,
      secrets,
      sourceProperties ?? next.properties,
      observedProvenance ??
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
        // this bag one THIS RUN PRODUCED? The caller's `claims.observed`
        // answers it — the deploy engine states {@link markSameGenerationBag}'s
        // mark there — and the mark is put on precisely the bag the refusal
        // exists for — `DeployEngine.observedCapture.drainObservedCaptures` marks EVERY drained
        // READBACK, and it is the only writer of `observedProperties` on the
        // deploy path, so a bag arriving here UNMARKED is a previous
        // generation's by elimination. `redactStateForPersist` reads the mark
        // off the very object drain installed, before any copy. The one unmarked bag that drain installs is the
        // masked-baseline re-capture (issue #3595): a previous generation's
        // baseline with some masks replaced by the record's own references, so
        // it holds nothing this run read from AWS and the argument below
        // covers it unchanged.
        //
        // Failing OPEN on an unmarked bag is safe for the reason the two
        // replayed cases give and for no other: the bag ALREADY SITS in
        // `state.json` verbatim, so a mask protects no reader who is not
        // already exposed, while it destroys a baseline that was intact. A
        // caller whose bag is fresh but which cannot mark it should state
        // `state-baseline` itself (`redactForState`), the way
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
        // A caller that supplied `observedProvenance` keeps its own choice.
        (sourceProperties !== undefined
          ? 'template-sourced'
          : secrets.size === 0 && observedClaimed
            ? 'state-baseline'
            : 'state-readback'),
      // The same claim, as the walk's generation claim, whatever the provenance.
      observedClaimed
    );
  }
  return next;
}

/**
 * `run` with the pass's physical-name copies HIDDEN (go-to-k/cdkd#4810): what
 * the persist walk wrote for `secrets` before that rule, the LEGACY form. The
 * side set is restored before returning, also on a throw; the walk is
 * synchronous, so no other reader of the bag sees it missing.
 */
export function withoutPhysicalNameCopies<T>(secrets: RecordedSecretValues, run: () => T): T {
  const names = physicalNameCopiesOf.get(secrets);
  if (names === undefined) return run();
  physicalNameCopiesOf.delete(secrets);
  try {
    return run();
  } finally {
    physicalNameCopiesOf.set(secrets, names);
  }
}

/**
 * `run` with `ids` added to the pass's physical-name copies for its duration
 * only (go-to-k/cdkd#4810), for a caller whose bag also feeds a reader that
 * must keep rewriting them. The previous side set is restored afterwards,
 * also on a throw; the walk is synchronous.
 */
export function withPhysicalNameCopies<T>(
  secrets: RecordedSecretValues,
  ids: readonly string[],
  run: () => T
): T {
  const previous = physicalNameCopiesOf.get(secrets);
  const names = new Set(previous);
  for (const id of ids) if (id !== '') names.add(id);
  physicalNameCopiesOf.set(secrets, names);
  try {
    return run();
  } finally {
    if (previous === undefined) physicalNameCopiesOf.delete(secrets);
    else physicalNameCopiesOf.set(secrets, previous);
  }
}

/**
 * A RECORD written before go-to-k/cdkd#4810 holds a reader's copy of a read
 * physical id in its rewritten, `{{resolve:` form. Returns `stored` with each
 * leaf that holds exactly what `legacy` (today's value persisted the old way)
 * holds at the same position, where `current` (the persisted form now) holds
 * something else, replaced by `current`'s leaf: the same value, so the
 * comparison reads it as unchanged and the record is repaired. POSITION-wise,
 * so a leaf the template spells as the literal reference (which both forms
 * persist alike) is never touched. Returns `stored` by identity when nothing
 * changed.
 */
export function repairPhysicalNameCopyLeaves(
  stored: unknown,
  legacy: unknown,
  current: unknown
): unknown {
  if (typeof stored === 'string') {
    return typeof legacy === 'string' &&
      typeof current === 'string' &&
      stored === legacy &&
      current !== legacy
      ? current
      : stored;
  }
  if (Array.isArray(stored)) {
    if (!Array.isArray(legacy) || !Array.isArray(current)) return stored;
    if (legacy.length !== stored.length || current.length !== stored.length) return stored;
    let changed = false;
    const out = stored.map((item, i) => {
      const next = repairPhysicalNameCopyLeaves(item, legacy[i], current[i]);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : stored;
  }
  if (stored !== null && typeof stored === 'object') {
    if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) return stored;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return stored;
    const l = legacy as Record<string, unknown>;
    const c = current as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!Object.hasOwn(l, key) || !Object.hasOwn(c, key)) continue;
      const next = repairPhysicalNameCopyLeaves(value, l[key], c[key]);
      if (next !== value) {
        out ??= { ...(stored as Record<string, unknown>) };
        out[key] = next;
      }
    }
    return out ?? stored;
  }
  return stored;
}

/**
 * The `[legacy, plaintext]` spellings of each physical id the pass read whose
 * old persist form EMBEDS a reference in surrounding text
 * (`https://sqs.../{{resolve:...}}`), for repairing a record leaf no desired
 * value stands beside (a provider-recorded attribute such as an SQS queue
 * policy's `cdkd:WrittenQueues`). A copy rewritten WHOLE into a single token
 * is left out: a leaf equal to a token can be a literal reference the
 * template spells. `legacySecrets` names the plaintexts the old walk knew:
 * `secrets` itself, or a map resolved from the RECORD's own references when
 * today's resolution no longer holds the one that rewrote it.
 */
export function embeddedPhysicalNameRewrites(
  secrets: RecordedSecretValues,
  legacySecrets: RecordedSecretValues = secrets
): Array<readonly [string, string]> {
  const names = physicalNameCopiesOf.get(secrets);
  if (names === undefined) return [];
  const pairs: Array<readonly [string, string]> = [];
  withoutPhysicalNameCopies(legacySecrets, () => {
    for (const name of names) {
      const legacy = redactForState(name, { provenance: 'value-scan', secrets: legacySecrets });
      if (
        typeof legacy === 'string' &&
        legacy !== name &&
        legacy.includes('{{resolve:') &&
        !isSingleDynamicReferenceToken(legacy) &&
        !legacy.includes(SECRET_MASK)
      ) {
        pairs.push([legacy, name]);
      }
    }
  });
  return pairs;
}

/** `value` with every string leaf's `legacy` spellings replaced by their plaintext. */
export function replaceEmbeddedPhysicalNameRewrites(
  value: unknown,
  pairs: ReadonlyArray<readonly [string, string]>
): unknown {
  if (pairs.length === 0) return value;
  if (typeof value === 'string') {
    let next = value;
    for (const [legacy, name] of pairs) next = next.split(legacy).join(name);
    return next;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = replaceEmbeddedPhysicalNameRewrites(item, pairs);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === 'object') {
    let out: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = replaceEmbeddedPhysicalNameRewrites(item, pairs);
      if (next !== item) {
        out ??= { ...(value as Record<string, unknown>) };
        out[key] = next;
      }
    }
    return out ?? value;
  }
  return value;
}

/**
 * `stored` with each string leaf repaired by `pairs` ONLY where the repaired
 * leaf then equals `target`'s leaf at the same position (go-to-k/cdkd#4810):
 * the legacy spelling was the whole difference. Any other leaf, and any leaf
 * whose repair would not reach `target`, is left as it is. Returns `stored`
 * by identity when nothing changed.
 */
export function repairEmbeddedPhysicalNamesTowards(
  stored: unknown,
  target: unknown,
  pairs: ReadonlyArray<readonly [string, string]>
): unknown {
  if (pairs.length === 0) return stored;
  if (typeof stored === 'string') {
    if (typeof target !== 'string' || stored === target) return stored;
    const repaired = replaceEmbeddedPhysicalNameRewrites(stored, pairs);
    return repaired === target ? repaired : stored;
  }
  if (Array.isArray(stored)) {
    if (!Array.isArray(target) || target.length !== stored.length) return stored;
    let changed = false;
    const out = stored.map((item, i) => {
      const next = repairEmbeddedPhysicalNamesTowards(item, target[i], pairs);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : stored;
  }
  if (stored !== null && typeof stored === 'object') {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) return stored;
    const t = target as Record<string, unknown>;
    let out: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!Object.hasOwn(t, key)) continue;
      const next = repairEmbeddedPhysicalNamesTowards(value, t[key], pairs);
      if (next !== value) {
        out ??= { ...(stored as Record<string, unknown>) };
        out[key] = next;
      }
    }
    return out ?? stored;
  }
  return stored;
}
