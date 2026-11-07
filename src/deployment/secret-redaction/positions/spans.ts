import { isSingleDynamicReferenceToken, MIN_NEEDLE_LENGTH } from '../rules.js';
import { type RecordedSecretValues, resolvedPlaintextOf } from '../pairs.js';
import { redactForState } from '../context.js';
import { provenPublicValue } from '../mask-only.js';
import { dynamicReferenceSpans } from '../redact-path.js';

/**
 * The ONE-span frame shared by {@link positionByEmbeddedSpan},
 * {@link positionByIntrinsicFrame} (over the source's rendered text) and
 * {@link learnMixedLeafNeedle}: a source holding exactly one `{{resolve:...}}`
 * token, and a bag that starts with the source's prefix and ends with its
 * suffix with something non-empty between them that is NOT itself a complete
 * token (an already-redacted record is a persisted answer, not a plaintext).
 * `undefined` for any other shape. One helper rather than three copies so the
 * three refusals cannot drift apart.
 */
export function singleSpanFrame(
  bag: string,
  source: string
): { token: string; prefix: string; suffix: string; middle: string } | undefined {
  const spans = dynamicReferenceSpans(source);
  if (spans.length !== 1) return undefined;
  const [span] = spans as [{ start: number; end: number }];
  const token = source.slice(span.start, span.end);
  const prefix = source.slice(0, span.start);
  const suffix = source.slice(span.end);
  if (bag.length <= prefix.length + suffix.length) return undefined;
  if (!bag.startsWith(prefix) || !bag.endsWith(suffix)) return undefined;
  const middle = bag.slice(prefix.length, bag.length - suffix.length);
  if (isSingleDynamicReferenceToken(middle)) return undefined;
  return { token, prefix, suffix, middle };
}

/**
 * Position a literal source leaf that EMBEDS exactly one `{{resolve:...}}`
 * token — `postgres://app-svc:{{resolve:ssm-secure:NAME}}@db/app` — by the
 * span the source states, writing `prefix + token + suffix` (issue
 * [#2485](https://github.com/go-to-k/cdkd/issues/2485)).
 *
 * WHY THE VALUE SCAN IS NOT ENOUGH HERE. The scan writes the map's surviving
 * expression for a plaintext, and the map keeps one expression per plaintext:
 * a whole-value `NAME:1` sibling that resolved LAST leaves `NAME:1` as the only
 * expression for the value, so the embedded leaf persists the versioned
 * spelling for a template that spells `NAME`, and the deploy diff — expression
 * against expression — reports that leaf on every run. The whole-token arm of
 * {@link redactByPath} is immune because it copies its own source; this arm
 * gives the one-span literal leaf the same immunity.
 *
 * THE EVIDENCE, and why the shape of the frame is not enough on its own: the
 * frame check (`bag` starts with the source's prefix and ends with its suffix,
 * with something between) is what {@link learnMixedLeafNeedle} already uses to
 * LEARN a needle, and it proves only that the bag has the source's shape. The
 * bag can also be a PREVIOUS generation's (`cdkd scrub`, a state-sourced walk)
 * with an earlier plaintext framed exactly like this, and writing today's
 * token over it would record an expression that was never deployed at that
 * position — the hazard `sourceIsSameGeneration` exists for on the whole-token
 * arm. So the middle must EQUAL what THIS pass recorded the source token
 * resolving to ({@link recordResolvedPair}, per map instance): that is evidence
 * of this resolution, not of shape, and it is absent by construction for every
 * bag this pass did not produce. It is also what keeps a PUBLIC `ssm` token
 * resolved (issue #1901) — the resolver records only secret verdicts — and what
 * keeps a mask-only `NoEcho` value out (never recorded).
 *
 * WHAT THIS EVIDENCE DOES NOT CLAIM, stated because a reviewer asked: it does
 * not prove the bag was produced FROM this source. A previous generation's bag
 * whose framed middle happens to EQUAL a plaintext this pass resolved the
 * source token to (`cdkd scrub` walking an old record against today's template,
 * or a failed deploy persisting an old bag) takes this arm and persists TODAY's
 * expression at that position. That is not a new claim: the value scan the
 * arm replaces rewrites that same plaintext onto one of THIS pass's expressions
 * regardless of generation — the map holds no other — so the class of answer
 * is unchanged and only the choice within it improves (the source's own
 * token rather than the map's survivor). The generation hazard this arm must
 * not create is the whole-token arm's: a middle that is ALREADY an expression
 * (a persisted answer from another generation), which the token refusal below
 * keeps out — and, by the same argument, any leaf the value scan would NOT
 * rewrite to exactly `prefix + survivor + suffix`: a whole leaf that is itself
 * another recorded plaintext, a needle starting in the prefix and overlapping
 * the middle, and — on a bag whose generation is NOT proven — a middle shorter
 * than the scan's needle floor. The arm checks that equivalence against the
 * scan's own answer rather than re-deriving the scan's rules. Pinned by the
 * cross-generation cases in `secret-redaction-embedded-span.test.ts`.
 *
 * BELOW THE NEEDLE FLOOR the scan makes no claim at all (issue
 * [#2516](https://github.com/go-to-k/cdkd/issues/2516)): {@link buildNeedleRegex}
 * drops every plaintext shorter than `MIN_NEEDLE_LENGTH` (`rules.ts`) from its
 * alternation, so an embedded 1-3 character secret is left in plaintext by
 * the scan, with or without a same-plaintext sibling. Accepting the scan's
 * silence (`scanned === bag`) as equivalence would therefore be a NEW claim
 * rather than a choice within the scan's class, and on a previous
 * generation's bag it would fabricate: a 1-3 character readback or old
 * record that COINCIDES with today's plaintext (`port:0` where AWS returns a
 * default and today's secret resolved to `0`) would be persisted as today's
 * expression, which round-trips today and, after a rotation, reports a drift
 * that never happened. So that arm is admitted only for a bag whose
 * generation IS proven: `bagIsSameGeneration`, the writer's claim, an argument
 * stated from the object-level mark {@link markSameGenerationBag} puts on the
 * bags the deploy engine hands to
 * redaction on a success path (the record's `properties`, which are the
 * resolved bag or the subset of it the SDK route writes; EVERY
 * `observedProperties` readback `drainObservedCaptures` drains, an unchanged
 * resource's auto-refresh included, where the empty secrets map rather than
 * the mark is what keeps it safe; and the `outputs` bag this pass resolved,
 * whose redacted RETURN VALUE is usually what the record holds) and on two
 * copies of the resolver's own output that the record never holds. That
 * function's contract is the authority — the conditions differ per site and
 * do not survive being stated once. Threaded down from
 * {@link redactSecretsForState} for exactly the object it was handed. With
 * the mark AND the pair, `recorded === middle` says this pass resolved the
 * source token to the middle and the bag is this pass's own, so
 * `prefix + token + suffix` is what the template says at that leaf and what
 * the resource holds. Without the mark the sub-floor middle keeps today's
 * bound, which is the scan's answer: the plaintext, unchanged.
 *
 * What stays, stated here rather than papered over. A provider that
 * substituted `effectiveProperties` built a bag of MIXED provenance; it takes
 * the narrower leaf-certified mark (`markLeafCertifiedBag`, go-to-k/cdkd#5063),
 * which licenses this claim because the arm accepts only a leaf equal to this
 * pass's own rendering, and a carried value fails that. A readback AWS
 * rewrote at that offset to a value that coincides with the 1-3 character
 * secret is persisted as the expression: value-equal
 * until the secret rotates, and the same residual the value scan already has
 * for a 4+ character coincidence in a readback. Every refusal of this arm
 * returns the scan's answer, so a leaf refused for interference (a frame
 * that is itself a recorded plaintext, say) has its frame rewritten and its
 * sub-floor middle left in plaintext. This arm positions a LITERAL source
 * leaf; an `Fn::Join` / `Fn::Sub` source rendering the same `port:` + token
 * — the dominant CDK shape — is {@link positionByIntrinsicFrame}'s (issue
 * #2745), which shares this arm's bound and mark and refuses a frame that is
 * not wholly literal (a region `Ref` OUTSIDE the token), where a sub-floor
 * secret still falls to the value scan and persists in plaintext. `cdkd
 * scrub`, the documented repair tool for a pre-GHSA record, cannot repair a
 * sub-floor embedded leaf: it walks a STORED bag, which no deploy marked, so
 * both arms are unreachable from it by construction and the leaf keeps the
 * scan's answer. The MASKING channel keeps the residual whole:
 * `maskSecretsInText`'s substring arm carries the same four-character floor,
 * so once this arm has put `port:{{resolve:...}}` in state, a warn line
 * quoting an AWS message can still print `port:q7`. Pre-existing and not a
 * regression -- the #2453 class, and the reason the list would otherwise
 * read as complete when it is not (maintainer review of PR 2753, round 2).
 *
 * The next DEPLOY of that resource repairs the leaves the two arms are
 * eligible for — a literal-frame source leaf on a bag the engine marks —
 * because the re-check compares unequal against a record holding the
 * plaintext and the resource is written again from a bag this pass produced.
 * The residual named above (a nonliteral frame) is not repaired by that
 * deploy either.
 *
 * One shape reaches this arm that a reader may not expect: a WHOLE-token
 * source that FAILED the whole-token arm's `isKnownSecretExpression` gate (an
 * `ssm` token whose type came back unclassifiable and which lost the map slot
 * to a sibling). Its "frame" is empty, and if this pass recorded it resolving
 * to the bag it is written back as itself — an expression, and the leaf's own,
 * where the scan wrote the survivor. Stated so it is not mistaken for a leak.
 *
 * TWO OR MORE SPANS take {@link certifiesRenderedLiteral} instead (issue
 * [#4644](https://github.com/go-to-k/cdkd/issues/4644)): no frame can say which
 * span produced which value, so the source is RENDERED with each token's
 * pass-local plaintext and kept verbatim only where that rendering IS the bag.
 * Where some tokens are PUBLIC, a claimed bag takes {@link certifiedMixedLiteral}
 * (go-to-k/cdkd#5056), which renders those from their proven values.
 *
 * Everything else keeps the pre-#2485 fall-through: a multi-span source that
 * certificate refuses, a frame mismatch, a middle that is itself a complete token (an
 * already-redacted record, per the same refusal {@link learnMixedLeafNeedle}
 * makes), and a middle this pass cannot vouch for. An `Fn::Sub` / `Fn::Join`
 * source (an object, not this arm at all) is
 * `positionByParameterPlaceholders` (`placeholder-positions.ts`)'s over a nested child's parameters
 * (issue #2320) and {@link positionByIntrinsicFrame}'s since #2745, and
 * reaches the value scan only where both refuse.
 *
 * The frame is copied from the SOURCE, not scanned. A needle occurring in the
 * literal frame would be a reference the template never had at that offset —
 * the fabricated-baseline direction {@link preferPositionDecisions} refuses —
 * and the whole-token arm returns its source unscanned for the same reason.
 *
 * RETURNS THE VALUE SCAN'S ANSWER ON EVERY REFUSAL, not `undefined`: the two
 * early returns below compute it for `(bag, secrets)`, and the bound in
 * {@link writeFramedTokenWithinScanBound} computes its own from the same two
 * arguments — every fall-through IS that scan — so the compared value provably
 * comes from the same bag and map the arm positions. An earlier revision took
 * the scan as a parameter, which left the bound one wrong caller away from
 * comparing against a scan of some other bag with no type error; the shared
 * helper keeps that property by taking `(bag, secrets)` rather than a scan.
 */
export function positionByEmbeddedSpan(
  bag: string,
  source: string,
  secrets: RecordedSecretValues,
  bagIsSameGeneration: boolean
): string {
  const frame = singleSpanFrame(bag, source);
  if (frame === undefined) {
    if (dynamicReferenceSpans(source).length >= 2) {
      if (certifiesRenderedLiteral(bag, source, secrets, bagIsSameGeneration)) return source;
      // go-to-k/cdkd#5056: secret tokens beside a PUBLIC one.
      if (bagIsSameGeneration) {
        const mixed = certifiedMixedLiteral(bag, source, secrets);
        if (mixed !== undefined) return mixed;
      }
    }
    return redactForState(bag, { provenance: 'value-scan', secrets });
  }
  const recorded = resolvedPlaintextOf(secrets, frame.token);
  if (recorded === undefined || recorded !== frame.middle) {
    return redactForState(bag, { provenance: 'value-scan', secrets });
  }
  return writeFramedTokenWithinScanBound(bag, secrets, frame, bagIsSameGeneration);
}

/**
 * Each `{{resolve:...}}` span of a LITERAL `source` with the plaintext the
 * pass owning `secrets` resolved its token to ({@link recordResolvedPair}), or
 * `undefined` when the source holds no token or ANY token lacks a pair. The
 * pair table holds only what the resolver resolved as SECRET -- a collapsed
 * loser and an unpinned `ssm` token included -- so a PUBLIC token (never
 * paired, issue #1901) refuses the whole source rather than being rendered
 * from a guess ({@link certifiedMixedLiteral} renders one from a PROOF). An
 * empty plaintext distinguishes nothing, and one that is itself a token is a
 * persisted answer rather than a plaintext (the self-referential #1917 shape,
 * which {@link singleSpanFrame} refuses too).
 */
function pairedSpans(
  source: string,
  secrets: RecordedSecretValues
): Array<{ start: number; end: number; plaintext: string }> | undefined {
  const spans = dynamicReferenceSpans(source);
  if (spans.length === 0) return undefined;
  const out: Array<{ start: number; end: number; plaintext: string }> = [];
  for (const span of spans) {
    const plaintext = resolvedPlaintextOf(secrets, source.slice(span.start, span.end));
    if (plaintext === undefined || plaintext === '') return undefined;
    if (isSingleDynamicReferenceToken(plaintext)) return undefined;
    out.push({ ...span, plaintext });
  }
  return out;
}

/**
 * The ONE token a LITERAL `spelling` spells at every span this pass resolved
 * to `plaintext` (issue [#4644](https://github.com/go-to-k/cdkd/issues/4644)),
 * or `undefined` when no span did, two spans name different tokens for it, or
 * any span is unpaired ({@link pairedSpans}). The nested-stack carry records a
 * certified parameter's plaintexts with it, so the child's value scan writes
 * the spelling's own token rather than the parent map's survivor.
 */
export function renderedTokenOf(
  spelling: string,
  secrets: RecordedSecretValues,
  plaintext: string
): string | undefined {
  const spans = pairedSpans(spelling, secrets);
  if (spans === undefined) return undefined;
  const tokens = new Set(
    spans
      .filter((span) => span.plaintext === plaintext)
      .map((span) => spelling.slice(span.start, span.end))
  );
  return tokens.size === 1 ? [...tokens][0] : undefined;
}

/** `source` with span `i` replaced by `textOf(i)`, its literal text kept. */
function renderSpans(
  source: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
  textOf: (index: number) => string
): string {
  let out = '';
  let cursor = 0;
  spans.forEach((span, index) => {
    out += source.slice(cursor, span.start) + textOf(index);
    cursor = span.end;
  });
  return out + source.slice(cursor);
}

/**
 * Does the LITERAL `spelling` render, through this pass's own pairs, to
 * EXACTLY `value` -- and is its literal text free of every plaintext `secrets`
 * would rewrite (issue [#4644](https://github.com/go-to-k/cdkd/issues/4644))?
 *
 * The certificate `mixedLeafProvenPublic` (`redact-path.ts`) applies to a
 * public readback, over secret pairs: every character of the value is either
 * text the spelling states or the plaintext THIS pass resolved the token at
 * that span to. Exact equality only -- no search, no substring, nothing taken
 * from anywhere but the spelling -- so it can only CONFIRM a spelling, never
 * find one. `redactForState(spelling, { provenance: 'value-scan', secrets }) === spelling` keeps a
 * plaintext out of the literal text: returning the spelling would otherwise
 * persist it. The value scan spares a match strictly inside a resolvable span,
 * so the spelling's own tokens pass.
 *
 * Read by {@link certifiesRenderedLiteral} at persist time and by the
 * nested-stack parameter reader, which re-asks it of the parent's bag at read
 * time rather than trusting what the recorder saw.
 */
export function rendersLiteralTo(
  spelling: string,
  secrets: RecordedSecretValues,
  value: string
): boolean {
  return renderedLiteralSpans(spelling, secrets, value) !== undefined;
}

/** {@link rendersLiteralTo}'s test, returning the paired spans it passed on. */
function renderedLiteralSpans(
  spelling: string,
  secrets: RecordedSecretValues,
  value: string
): Array<{ start: number; end: number; plaintext: string }> | undefined {
  const spans = pairedSpans(spelling, secrets);
  if (spans === undefined) return undefined;
  if (renderSpans(spelling, spans, (i) => spans[i]!.plaintext) !== value) return undefined;
  return redactForState(spelling, { provenance: 'value-scan', secrets }) === spelling
    ? spans
    : undefined;
}

/**
 * Position a literal source leaf EMBEDDING two or more `{{resolve:...}}`
 * tokens -- `postgres://{{resolve:...user}}:{{resolve:...password}}@host` --
 * by persisting the SOURCE verbatim when it provably IS the bag (issue
 * [#4644](https://github.com/go-to-k/cdkd/issues/4644)).
 *
 * WHY. {@link singleSpanFrame} positions one span; with two there is no frame
 * to read, so the leaf fell to the value scan, which writes the map's
 * SURVIVOR per plaintext. Where a same-plaintext sibling resolved last, the
 * leaf persisted the sibling's spelling for a template that spells its own --
 * and a nested-stack child's `{Ref}` to such a parameter persisted the same
 * survivor, while `cdkd diff --recursive` renders the parameter's literal:
 * a change on every run that no deploy clears.
 *
 * THE EVIDENCE is {@link rendersLiteralTo}: every token paired in THIS pass,
 * the rendering equal to the bag, and no plaintext in the literal text. A
 * previous generation's bag fails it unless every plaintext coincides, the
 * same claim the one-span arm states for its middle.
 *
 * THE BOUND, the one-span arm's ({@link writeFramedTokenWithinScanBound})
 * per span: accepted only where the value scan rewrites the bag to the source
 * with each token replaced by the map's survivor for its plaintext, so the
 * answer stays a CHOICE among this pass's expressions -- an interfering
 * needle (a whole-leaf plaintext, one straddling literal text and a
 * plaintext) makes the scan answer differently and the leaf keeps the scan's
 * answer. Below the scan's floor a plaintext is left by the scan, and that
 * silence is accepted only on a bag its writer claimed same-generation,
 * exactly as for one span. Strictly narrower than the scan: it never rewrites
 * a leaf the scan would leave, nor a character the scan would not.
 */
export function certifiesRenderedLiteral(
  bag: string,
  source: string,
  secrets: RecordedSecretValues,
  bagIsSameGeneration: boolean
): boolean {
  const spans = renderedLiteralSpans(source, secrets, bag);
  if (spans === undefined) return false;
  const survivors: string[] = [];
  for (const span of spans) {
    const survivor = secrets.get(span.plaintext);
    // A type-narrowing formality, as in the one-span bound: the resolver's
    // seams `set` the entry beside every pair.
    if (survivor === undefined) return false;
    survivors.push(survivor);
  }
  const scanned = redactForState(bag, { provenance: 'value-scan', secrets });
  if (scanned === renderSpans(source, spans, (i) => survivors[i]!)) return true;
  if (!bagIsSameGeneration) return false;
  return (
    scanned ===
    renderSpans(source, spans, (i) =>
      spans[i]!.plaintext.length >= MIN_NEEDLE_LENGTH ? survivors[i]! : spans[i]!.plaintext
    )
  );
}

/**
 * Position a literal source leaf embedding SECRET tokens beside one or more
 * PUBLIC ones -- `postgres://{{resolve:ssm:/db/host}}:5432/?pin={{resolve:
 * secretsmanager:...}}` -- on a bag its writer claimed same-generation
 * (go-to-k/cdkd#5056). {@link certifiesRenderedLiteral} refuses such a leaf
 * outright, since a public token has no pair, and the value scan then left a
 * 1-3 character secret in it in plaintext.
 *
 * Returns the leaf to persist -- each secret span as its own token, each
 * public span as its RESOLVED value, which is what state holds for a public
 * reference (#1901) -- or `undefined` on any doubt:
 *
 * - every token is either paired in this pass (a secret, as in
 *   {@link pairedSpans}) or has a PROVEN public value for this bag
 *   ({@link provenPublicValue}: this pass's lookup proved it public and
 *   nothing records it as a secret), with at least one of each;
 * - a public value is not empty and spells no `{{resolve:` text;
 * - the source, each span rendered with its plaintext or public value, IS
 *   the bag, exactly, and its literal text holds no plaintext the scan would
 *   rewrite ({@link renderedLiteralSpans}' checks);
 * - THE BOUND, {@link certifiesRenderedLiteral}'s claimed arm: the value scan
 *   of the bag equals the source rendered with each secret span's survivor
 *   (its plaintext below the floor) and each public value, so an interfering
 *   needle anywhere in the leaf keeps the scan's answer.
 *
 * Only on a claimed bag: the claim is what makes the scan's silence over a
 * sub-floor plaintext equivalence, and the proof is pass-local.
 *
 * A public value EQUAL to or CONTAINING a secret's plaintext is accepted:
 * the rendering fixes which span is which, the value is public by this pass's
 * own lookup and stays in state either way, and a refusal here lands on the
 * scan's answer, which keeps the short secret in plaintext at its own span
 * too. (A 4+ character secret inside a public value fails THE BOUND, since
 * the scan rewrites it there.)
 */
function certifiedMixedLiteral(
  bag: string,
  source: string,
  secrets: RecordedSecretValues
): string | undefined {
  if (legacyMixedScan.has(secrets)) return undefined;
  const answer = certifyMixedLiteral(bag, source, secrets);
  if (answer !== undefined) mixedAnswered.add(secrets);
  return answer;
}

const mixedAnswered = new WeakSet<RecordedSecretValues>();
const legacyMixedScan = new WeakSet<RecordedSecretValues>();

/**
 * Did a walk over `secrets` position a leaf by {@link certifiedMixedLiteral}
 * (go-to-k/cdkd#5056)? The gate on the one-time legacy repair: a record a
 * pre-fix cdkd wrote can hold the old spelling only where today's walk takes
 * this arm.
 */
export function mixedLiteralAnswered(secrets: RecordedSecretValues): boolean {
  return mixedAnswered.has(secrets);
}

/**
 * `run` with {@link certifiedMixedLiteral} off, as a pre-go-to-k/cdkd#5056
 * cdkd walked, so a caller can recognise a record such a cdkd wrote for
 * today's value. Synchronous, cleared on a throw. Its output can hold a short
 * secret in plaintext: a comparison key, never persisted or printed.
 */
export function withLegacyMixedScan<T>(secrets: RecordedSecretValues, run: () => T): T {
  if (legacyMixedScan.has(secrets)) return run();
  legacyMixedScan.add(secrets);
  try {
    return run();
  } finally {
    legacyMixedScan.delete(secrets);
  }
}

function certifyMixedLiteral(
  bag: string,
  source: string,
  secrets: RecordedSecretValues
): string | undefined {
  const spans = dynamicReferenceSpans(source);
  const parts: Array<
    { kind: 'secret'; plaintext: string; survivor: string } | { kind: 'public'; value: string }
  > = [];
  for (const span of spans) {
    const token = source.slice(span.start, span.end);
    const plaintext = resolvedPlaintextOf(secrets, token);
    if (plaintext !== undefined) {
      if (plaintext === '' || isSingleDynamicReferenceToken(plaintext)) return undefined;
      const survivor = secrets.get(plaintext);
      if (survivor === undefined) return undefined;
      parts.push({ kind: 'secret', plaintext, survivor });
      continue;
    }
    const value = provenPublicValue(secrets, token);
    if (value === undefined || value === '' || value.includes('{{resolve:')) return undefined;
    parts.push({ kind: 'public', value });
  }
  const secretParts = parts.filter((p) => p.kind === 'secret');
  const publicParts = parts.filter((p) => p.kind === 'public');
  if (secretParts.length === 0 || publicParts.length === 0) return undefined;
  const textOf =
    (secret: (p: { plaintext: string; survivor: string }) => string) =>
    (i: number): string => {
      const part = parts[i]!;
      return part.kind === 'secret' ? secret(part) : part.value;
    };
  if (
    renderSpans(
      source,
      spans,
      textOf((p) => p.plaintext)
    ) !== bag
  )
    return undefined;
  if (redactForState(source, { provenance: 'value-scan', secrets }) !== source) return undefined;
  const scanned = redactForState(bag, { provenance: 'value-scan', secrets });
  const expected = renderSpans(
    source,
    spans,
    textOf((p) => (p.plaintext.length >= MIN_NEEDLE_LENGTH ? p.survivor : p.plaintext))
  );
  if (scanned !== expected) return undefined;
  return renderSpans(source, spans, (i) => {
    const part = parts[i]!;
    return part.kind === 'secret' ? source.slice(spans[i]!.start, spans[i]!.end) : part.value;
  });
}

/**
 * Write `prefix + token + suffix` for a framed leaf whose pass-local pair the
 * CALLER has already verified (`token` resolved to `middle` in the pass that
 * owns `secrets`), and ONLY where that stays within the value scan's own class
 * of answer — or, below the scan's floor, on a bag the engine marked. Returns
 * the scan's answer on every refusal.
 *
 * ONE helper for {@link positionByEmbeddedSpan} (a literal source, issue
 * #2485) and {@link positionByIntrinsicFrame} (an `Fn::Join` / `Fn::Sub`
 * source, issue #2745), for the reason {@link singleSpanFrame} is one: the
 * bound and the mark are the two claims this module makes about a FRAMED
 * leaf, and two copies are two places for one of them to be relaxed alone.
 *
 * THE SCAN IS COMPUTED HERE, for `(bag, secrets)` — the bound below compares
 * against it, and every fall-through IS it — so the compared value provably
 * comes from the same bag and map the token is written into. An earlier
 * revision of the literal arm took the scan as a parameter, which left the
 * bound one wrong caller away from comparing against a scan of some other
 * bag with no type error.
 */
export function writeFramedTokenWithinScanBound(
  bag: string,
  secrets: RecordedSecretValues,
  frame: { token: string; prefix: string; suffix: string; middle: string },
  bagIsSameGeneration: boolean
): string {
  const scanned = redactForState(bag, { provenance: 'value-scan', secrets });
  const { token, prefix, suffix, middle } = frame;
  // THE SAME CLASS OF ANSWER AS THE VALUE SCAN, proven rather than argued: on
  // a bag whose generation is NOT proven the arm accepts only a leaf the scan
  // itself would rewrite to `prefix + <the map's survivor for the middle> +
  // suffix` — the middle and nothing else. That is what makes the
  // substitution a CHOICE among this pass's expressions rather than a new
  // claim: where another recorded plaintext matches the WHOLE leaf, or starts
  // in the prefix and overlaps the middle, the scan's whole-value / leftmost
  // precedence picks that needle instead (so does this arm, by falling
  // through to it). See the generation note in `positionByEmbeddedSpan`'s
  // docstring for why this bound matters, and for the one relaxation below it.
  const survivor = secrets.get(middle);
  // A type-narrowing formality, not a reachable refusal: the caller's pair
  // check already implies an entry for `middle` — both resolver seams `set`
  // the entry beside its pair (`recordSecretResolution`), every carry of the
  // pairs (`mergeResolvedPairs`, `foldRecording`) copies or holds the entries
  // first, and nothing deletes from a `RecordedSecretValues`
  // map. Kept in the fail-closed shape rather than as a non-null assertion.
  if (survivor === undefined) return scanned;
  if (scanned === prefix + survivor + suffix) return prefix + token + suffix;
  // Below the scan's needle floor the scan leaves the middle alone, and its
  // silence is accepted as equivalence ONLY on a bag whose generation the
  // engine proved (issue #2516) — see "BELOW THE NEEDLE FLOOR" in
  // `positionByEmbeddedSpan`'s docstring. `scanned === bag` rather than a
  // length test on the middle: an interference case whose OTHER needle is 4+
  // characters makes the scan rewrite SOMETHING, so it stays refused here
  // exactly as it is refused one line up, and a sub-floor middle in a leaf
  // the scan otherwise left untouched is what reaches the return. The claim
  // is not universal (maintainer review of PR 2753, round 2): it holds for
  // SUBSTRING interference by a 4+ character needle. An interfering needle
  // that is itself sub-floor leaves the scan silent too, so such a leaf
  // reaches this arm. A sub-floor needle matching the WHOLE leaf is rewritten
  // by the scan's own exact-match arm, which has no floor, and where that
  // happens splits on the FRAME (rounds 2 and 3 of the same review each
  // corrected this sentence): with an EMPTY frame -- leaf === middle --
  // `scanned` equals the survivor, so the equality one line up ACCEPTS the
  // leaf and it never reaches here, which is the right answer and this
  // pass's own token either way; with a NONEMPTY frame the scan's answer is
  // the other secret's expression, that equality fails, and the leaf is
  // refused here. What the silent case costs is the OTHER secret's
  // under-redaction — the value scan's own pre-existing residual below the
  // floor — never a fabricated expression, because the returned token is
  // still the one THIS pass recorded resolving to this leaf's middle.
  if (bagIsSameGeneration && scanned === bag) return prefix + token + suffix;
  return scanned;
}
