import { type RecordedSecretValues, resolvedPlaintextOf, resolvedExpressionsOf } from './pairs.js';
import { recordedSecretExpressions } from './mask-only.js';
import { plaintextIndexOf } from './certified-positions.js';
import {
  anchoredSkeletonPattern,
  intrinsicSkeletonSegments,
  MAX_SKELETON_CANDIDATE_LENGTH,
  UNKNOWN_PART,
  UNKNOWN_PART_PLACEHOLDER,
} from './positions/skeleton.js';
import { singleSpanFrame, writeFramedTokenWithinScanBound } from './positions/spans.js';

export {
  intrinsicSkeletonPattern,
  UNKNOWN_PART,
  UNKNOWN_PART_PLACEHOLDER,
  joinPartLiteralText,
  intrinsicSkeletonSegments,
  positionByIntrinsicSkeleton,
} from './positions/skeleton.js';
export {
  singleSpanFrame,
  positionByEmbeddedSpan,
  renderedTokenOf,
  rendersLiteralTo,
  certifiesRenderedLiteral,
  mixedLiteralAnswered,
  withLegacyMixedScan,
} from './positions/spans.js';

/**
 * Position a bag leaf whose `Fn::Join` / `Fn::Sub` source EMBEDS exactly one
 * `{{resolve:...}}` token inside LITERAL surrounding text — `port:` + token —
 * by writing that token into the frame the source states (issue
 * [#2745](https://github.com/go-to-k/cdkd/issues/2745)).
 *
 * This is the intrinsic twin of `positionByEmbeddedSpan`, and the shape
 * is the DOMINANT one rather than a corner: `'port:' + secret.secretValueFromJson('pin')`
 * renders the secret ARN as a `Ref`, so CDK emits
 * `{"Fn::Join": ["", ["port:{{resolve:secretsmanager:", {"Ref": ...}, ":SecretString:pin::}}"]]}`
 * — the prefix FUSED into the token's opening part, the `Ref` INSIDE the
 * token. Before this arm such a leaf had no positioning route at all:
 * `positionByIntrinsicSkeleton` refuses unless the WHOLE bag is a
 * recorded plaintext (its condition 1), and `positionByEmbeddedSpan`
 * needs a source STRING to copy its frame from. So it fell to the value scan,
 * which for a 4+ character middle writes the map's SURVIVOR (a same-plaintext
 * sibling's spelling, the #1904 / #2485 class) and for a 1-3 character middle
 * writes NOTHING — `buildNeedleRegex` drops it from the alternation —
 * and `port:q7` was persisted in plaintext.
 *
 * HOW THE FRAME IS FOUND. The source is rendered to text by
 * {@link intrinsicSkeletonSegments} — the same parser the skeleton arm reads —
 * with each unknowable part as one {@link UNKNOWN_PART_PLACEHOLDER}, and
 * {@link singleSpanFrame} then finds the ONE token in that text exactly as it
 * does for a literal source. The prefix and suffix must be wholly literal: a
 * placeholder OUTSIDE the token (a region `Ref` after it, the `DB_URL` shape
 * of the `secrets-dynamic-ref` fixture) means the source cannot establish
 * where the middle ends, and the leaf is REFUSED — the nonliteral-frame shape
 * #2745 deliberately defers. Inside the token a placeholder becomes a
 * `SKELETON_WILDCARD`, capped by `MAX_SKELETON_WILDCARDS` through
 * the same `joinSkeletonSegments`, so the token pattern is the skeleton
 * arm's pattern restricted to the token's own extent.
 *
 * THE EVIDENCE, three checks and each removes a different way of being wrong:
 *
 * 1. EXACTLY ONE candidate expression matches the token pattern, and is not
 *    DEMONSTRABLY another value's — the skeleton arm's conditions 2 and 3,
 *    over its two candidate stores PLUS the pass-local pair table
 *    ({@link resolvedExpressionsOf}; the code says why), and the same
 *    {@link plaintextIndexOf} poisoning rule, with `middle` in the role the
 *    whole bag plays there.
 * 2. THIS PASS resolved that candidate to the middle (`recordResolvedPair`,
 *    per map instance) — the literal arm's evidence, and what a
 *    shape-plausible expression this pass never resolved to the middle
 *    (another resource's, typically) cannot satisfy. What it does NOT prove
 *    is that the candidate is THIS leaf's token. A leaf
 *    whose own reference resolved PUBLIC (an `ssm` `String`, which nothing
 *    records) and carries an unknowable part INSIDE its token (a `Ref` in the
 *    parameter name — a wholly literal public token matches no candidate and
 *    refuses), beside a same-service SECRET sibling whose value coincides
 *    with the middle, passes all three checks and takes the sibling's
 *    expression — a wrong REFERENCE, not a disclosure, the class the
 *    floorless whole-value scan already accepts for a whole-leaf coincidence.
 *    Against the value scan: the scan writes the map's SURVIVOR for a 4+
 *    character middle and nothing below the floor, while this arm writes the
 *    same-service candidate — the two coincide only when that candidate is
 *    the survivor, so at 4+ the arm can change WHICH wrong reference is
 *    taken, and below the floor on a marked bag it adds one where the scan
 *    wrote nothing. "Not a disclosure" is a claim about the STORED artifact
 *    only: `resolveReplayProps` (`rollback-executor/replay-props.ts`) re-resolves every
 *    `{{resolve:` token in a replayed bag without regard to which reference
 *    the leaf named, so a later failed deploy plus `cdkd rollback` resolves
 *    the sibling's expression and writes its CURRENT plaintext into the live
 *    property — the transformed-value-meets-inverse-transform shape of
 *    GHSA-p5qg-v9gv-hc7w's consumer, reached here through a wrong reference
 *    rather than a wrong value (maintainer review of PR 3052). THREE live
 *    consumers re-resolve a stored expression this way, each with a weaker
 *    precondition than the last. `cdkd drift --revert`
 *    (`resolveStateSecretExpressions`, `drift.ts`) needs no failed deploy:
 *    once the sibling rotates, the re-resolved baseline diverges from AWS,
 *    drift fires, and `--revert` pushes the sibling's plaintext to the live
 *    property — and `--accept` is no way out there, since the AWS-side value
 *    of a secret-classified path is masked and `runAccept` refuses to persist
 *    the mask, leaving `--revert` (the harmful button) or a redeploy. A
 *    consumer stack's cross-stack read (`reresolveCrossStackValue`,
 *    `intrinsic-resolver/cross-stack.ts`: `Fn::ImportValue`, `Fn::GetStackOutput`,
 *    a parent's `Fn::GetAtt Nested.Outputs.X`) needs nothing at all: the
 *    outputs bag is marked, so a sub-floor write reaches `state.outputs`, and
 *    an ORDINARY deploy of the consumer after the sibling rotates hands the
 *    sibling's current plaintext to the consumer's `provider.create` /
 *    `update`. Stated rather than closed, and pinned by the unit file:
 *    nothing records a public resolution, so this arm cannot tell "absent
 *    because public" from "absent because collapsed"; the PR that closes
 *    #2745's nested-stack site weighs these consumers rather than re-deriving
 *    them.
 * 3. The write stays within the value scan's class of answer, or — below the
 *    scan's floor — the bag carries the engine's same-generation mark:
 *    {@link writeFramedTokenWithinScanBound}, shared with the literal arm.
 *
 * One shape reaches this arm that a reader may not expect, the literal arm's
 * own: a WHOLE-token source, i.e. an EMPTY frame, where the leaf IS the
 * middle. `positionByIntrinsicSkeleton` runs first and answers for
 * every such leaf it can; what falls through is its REFUSAL, and this arm
 * re-asks over a wider candidate set — the pair table names a token this pass
 * resolved but never pinned (an `ssm` reference whose type came back
 * unclassifiable, #1901) and which lost the map slot to a sibling, a token
 * neither of the skeleton's stores can see. With the pair and the bound that
 * leaf is written back as ITSELF, where the scan wrote the survivor: the
 * leaf's own expression, never another's. Where the skeleton refused for two
 * matches, so does this arm (same pattern, a superset of candidates, same
 * rule); where it refused for want of one — nothing matched, or its only
 * match was skipped as another plaintext's — this arm may find the leaf's
 * own token in the pair table. Either way the whole-token answer changes ONLY
 * where the skeleton had none.
 *
 * Every refusal before the bound returns `undefined` and the walk falls to the
 * value scan; the bound's own refusals return that scan directly — the same
 * answer either way, today's behavior, so no REFUSAL makes a case worse. The
 * one ACCEPTANCE that can is check 2's residual above, where a public leaf
 * gains a wrong reference in place of its plaintext. What stays: the
 * nonliteral frame above; a source with more than one token; an `Fn::Join`
 * whose delimiter is itself an intrinsic (the parser refuses it); and
 * everything the shared bound refuses, listed on the literal arm.
 */
export function positionByIntrinsicFrame(
  bag: string,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues,
  secretExpressions: ReadonlySet<string>,
  bagIsSameGeneration: boolean
): string | undefined {
  const segments = intrinsicSkeletonSegments(source);
  if (segments === undefined) return undefined;
  if (segments.some((s) => s !== UNKNOWN_PART && s.includes(UNKNOWN_PART_PLACEHOLDER))) {
    return undefined;
  }
  const rendered = segments
    .map((s) => (s === UNKNOWN_PART ? UNKNOWN_PART_PLACEHOLDER : s))
    .join('');
  const frame = singleSpanFrame(bag, rendered);
  if (frame === undefined) return undefined;
  const { token, prefix, suffix, middle } = frame;
  if (prefix.includes(UNKNOWN_PART_PLACEHOLDER) || suffix.includes(UNKNOWN_PART_PLACEHOLDER)) {
    return undefined;
  }
  const pattern = anchoredSkeletonPattern(
    token
      .split(UNKNOWN_PART_PLACEHOLDER)
      .flatMap((literal, i) => (i === 0 ? [literal] : [UNKNOWN_PART, literal]))
  );
  if (pattern === undefined) return undefined;

  const plaintextOf = plaintextIndexOf(secrets);
  let matched: string | undefined;
  // The skeleton arm's two stores PLUS the pass-local pair table. The map's
  // values hold one survivor per plaintext and the process-wide set holds only
  // PINNED expressions, so the one this leaf actually resolved — a collapsed
  // loser, or an `ssm` token whose type came back unclassifiable and is
  // recorded as a pair but never pinned (#1901) — can be absent from both.
  // Absent from the CANDIDATES it is absent from the uniqueness count too, and
  // the arm would then write the sibling's expression over a leaf whose own
  // token it never saw: the #1910 wrong-reference class, measured on this
  // arm's first draft. The pair table is exactly "what this pass resolved",
  // which is also the population check 2 below accepts from.
  for (const candidate of new Set([
    ...secretExpressions,
    ...recordedSecretExpressions,
    ...resolvedExpressionsOf(secrets),
  ])) {
    if (candidate.length > MAX_SKELETON_CANDIDATE_LENGTH) return undefined;
    if (!pattern.test(candidate)) continue;
    const recordedPlaintext = plaintextOf.get(candidate);
    if (recordedPlaintext !== undefined && recordedPlaintext !== middle) continue;
    if (matched !== undefined) return undefined;
    matched = candidate;
  }
  if (matched === undefined || resolvedPlaintextOf(secrets, matched) !== middle) {
    return undefined;
  }
  return writeFramedTokenWithinScanBound(
    bag,
    secrets,
    { token: matched, prefix, suffix, middle },
    bagIsSameGeneration
  );
}
