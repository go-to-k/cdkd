import { DYNAMIC_REFERENCE_INNER_CHAR, escapeRegExp } from '../rules.js';
import type { RecordedSecretValues } from '../pairs.js';
import { recordedSecretExpressions } from '../mask-only.js';
import { plaintextIndexOf } from '../certified-positions.js';

/**
 * Stands in for a source part the skeleton cannot know — an `Fn::Join` element
 * that is itself an intrinsic or any other non-scalar or `null` part (see
 * {@link joinPartLiteralText}), or an `Fn::Sub` `${...}` variable.
 *
 * Built from {@link DYNAMIC_REFERENCE_INNER_CHAR} rather than `.` because a
 * recorded expression's INNER text never contains `}`: the resolver matches
 * them with `/\{\{resolve:([^}]+)\}\}/`, so the first `}` after `{{resolve:` is
 * already the terminator. Excluding it means a wildcard can never swallow one
 * token's terminator and run into the next, so a skeleton for ONE reference
 * cannot match a candidate built from a different one.
 *
 * Zero-or-more here, unlike {@link DYNAMIC_REFERENCE_INNER}: this stands in for
 * an unknown SPAN, which may legitimately be empty (an `Fn::Join` part that
 * resolved to `''`), whereas a token with no inner text is not a token.
 */
const SKELETON_WILDCARD = `${DYNAMIC_REFERENCE_INNER_CHAR}*`;

/**
 * More wildcards than this and the skeleton is REFUSED outright.
 *
 * The bound is what actually closes the backtracking class; the collapse below
 * only closes one ARRANGEMENT of it. A skeleton with N wildcards makes a
 * FAILING match exponential in N — and failing is the common case, since the
 * pattern is tried against every recorded expression that is NOT this leaf's.
 * The collapse merges ADJACENT wildcards, so `${a}${b}${c}` becomes one; but
 * wildcards separated by a literal cannot merge and backtrack identically.
 * Measured against a failing candidate: `Fn::Sub '${a}x${b}x…'` at 6 wildcards
 * 17.7s and at 8 did not finish in two minutes, and a realistic
 * `Fn::Join['-', 9 x {Ref}]` against a hyphen-rich secret ARN took 855ms per
 * candidate. So the producer is the wildcard COUNT, not adjacency.
 *
 * What refusing costs is worth stating plainly rather than waving away, because
 * it is the SAME cost this module's residual note describes: a refused leaf
 * falls to the value scan, and for a colliding pair that means state holds the
 * SIBLING's reference, which `resolveReplayProps` re-resolves and applies. A
 * four-wildcard join carrying substantive literals CAN position uniquely, so
 * the bound does give something up. It is set where it is because the dominant
 * CDK shape carries exactly ONE wildcard (the secret ARN's `{Ref}`) and two or
 * three covers an account plus a region — and because the alternative at the
 * top of that trade is not "slightly better redaction" but a deploy that hangs
 * after its AWS mutations.
 */
const MAX_SKELETON_WILDCARDS = 3;

/**
 * A candidate longer than this REFUSES the whole positioning pass.
 *
 * The wildcard cap bounds the EXPONENT; this bounds the BASE. Cost at the cap
 * is polynomial in the candidate's length (~cubic, measured: 200 chars 4.9ms,
 * 1000 chars 192ms, and an adversarial all-separator 3000-char candidate 4.1s),
 * and candidate length is template-authored — `[^}]*` never crosses a `}`, so
 * the whole expression is one backtracking run. A real `{{resolve:...}}` is
 * 100-250 characters even with a full ARN and a JSON key, so this only excludes
 * the pathological.
 *
 * The whole pass is refused rather than that one candidate being SKIPPED, and
 * the difference is load-bearing: skipping shrinks the candidate set, so a
 * second match could go unseen and condition 2's "exactly one" would be decided
 * over a filtered list — turning a bound meant for speed into a silent
 * weakening of the fence. Refusing degrades to the value scan like every other
 * refusal here.
 */
export const MAX_SKELETON_CANDIDATE_LENGTH = 512;

/**
 * Concatenate skeleton segments, dropping an empty one and COLLAPSING a run of
 * consecutive wildcards into one — then REFUSE (return `undefined`) when more
 * than {@link MAX_SKELETON_WILDCARDS} survive.
 *
 * The collapse is a correctness fix, not tidiness: `[^}]*[^}]*` is semantically
 * identical to `[^}]*`, but the engine has to try every split of the input
 * between them. Measured on a ~120-char candidate, before the collapse:
 * 4 adjacent wildcards 39ms, 5 ~1s, 6 20s, 8 did not finish in two minutes. Two
 * legal CFn shapes CDK can emit produce ADJACENT ones — an `Fn::Join` with an
 * EMPTY delimiter and consecutive intrinsic (or `null`) parts, and an `Fn::Sub` with
 * adjacent `${a}${b}` variables — and the collapse takes both to a single
 * wildcard. It does NOT close the class, which is why the cap exists beside it.
 *
 * This runs on the state-persist choke point, i.e. AFTER the AWS mutations and
 * BEFORE state is written, so a hang there strands real resources.
 *
 * An empty segment is dropped rather than appended because an empty DELIMITER
 * would otherwise sit between two wildcards and defeat the collapse. A
 * non-empty literal between two wildcards is what anchors the match, and those
 * are left exactly as they are — and counted.
 */
function joinSkeletonSegments(segments: readonly string[]): string | undefined {
  const out: string[] = [];
  let wildcards = 0;
  for (const segment of segments) {
    if (segment === '') continue;
    if (segment === SKELETON_WILDCARD) {
      if (out[out.length - 1] === SKELETON_WILDCARD) continue;
      wildcards += 1;
      if (wildcards > MAX_SKELETON_WILDCARDS) return undefined;
    }
    out.push(segment);
  }
  return out.join('');
}

/**
 * Build an anchored pattern describing what a `{{resolve:...}}` expression at
 * this INTRINSIC source leaf must look like — literal parts kept verbatim,
 * unknowable parts wildcarded (issue #1916).
 *
 * The dominant CDK shape is an `Fn::Join`, because `secret.secretValueFromJson(...)`
 * renders the secret's ARN as a `Ref` and CDK joins the pieces:
 *
 * ```json
 * {"Fn::Join": ["", ["{{resolve:secretsmanager:my-secret-", {"Ref": "AWS::AccountId"},
 *                    ":SecretString:password}}"]]}
 * ```
 *
 * which yields `^\{\{resolve:secretsmanager:my\-secret\-[^}]*:SecretString:password\}\}$`
 * — enough to tell that leaf's expression from its `:AWSCURRENT`-suffixed
 * sibling, which is precisely what the value map cannot do once the two
 * resolve to the same plaintext. `Fn::Sub` has the same shape via its literal
 * template string.
 *
 * Returns `undefined` for any source this cannot describe (a delimiter that is
 * itself an intrinsic, a non-array `Fn::Join`, a non-string `Fn::Sub`
 * template, an object that is not a single-key intrinsic at all), and the
 * caller then falls back to the value scan — i.e. to the pre-#1916 behavior.
 *
 * Exported for its TEST only. The reason is now CONVENIENCE rather than
 * necessity, and the distinction is worth keeping straight: before the wildcard
 * cap existed, driving the collapse through `redactSecretsForState` did not
 * fail on a timeout — catastrophic backtracking is SYNCHRONOUS, so it wedged
 * the vitest worker and the run never ended, which is a worse CI outcome than
 * the defect and indistinguishable from a slow machine. With the cap, dropping
 * the collapse turns that same input into a REFUSAL, so the behavior IS
 * observable through the public entry point. Asserting on the returned
 * pattern's shape is still the better fence — it names the invariant (how many
 * unknown spans survived) instead of a downstream consequence — but it is a
 * choice, not the only option.
 */
export function intrinsicSkeletonPattern(source: Record<string, unknown>): RegExp | undefined {
  const segments = intrinsicSkeletonSegments(source);
  if (segments === undefined) return undefined;
  return anchoredSkeletonPattern(segments);
}

/**
 * {@link joinSkeletonSegments} anchored at both ends, or `undefined` where the
 * wildcard cap refused it. The one place the skeleton's regex is built, for
 * both readers of the segment form — and the one place a literal segment is
 * ESCAPED: it takes the segment form itself (literal text, or
 * {@link UNKNOWN_PART}), never pre-built regex text, so a third caller cannot
 * hand it raw template text and get a pattern with live metacharacters and no
 * type error (maintainer review of PR 3052).
 */
export function anchoredSkeletonPattern(
  segments: ReadonlyArray<string | typeof UNKNOWN_PART>
): RegExp | undefined {
  const body = joinSkeletonSegments(
    segments.map((segment) =>
      segment === UNKNOWN_PART ? SKELETON_WILDCARD : escapeRegExp(segment)
    )
  );
  return body === undefined ? undefined : new RegExp(`^${body}$`);
}

/**
 * A source part the skeleton cannot know — an `Fn::Join` element that is
 * itself an intrinsic or any other non-scalar or `null` part (see
 * {@link joinPartLiteralText}), or an `Fn::Sub` `${...}` variable. The segment form of
 * {@link SKELETON_WILDCARD}: what a part IS, before {@link anchoredSkeletonPattern}
 * — the one speller — turns it into the wildcard.
 */
export const UNKNOWN_PART = Symbol('unknown intrinsic part');

/**
 * Stands in, while a source is RENDERED to text, for a part the skeleton cannot
 * know. A single character so the rendered string keeps the literal parts at
 * their true offsets, and NOT `}` so {@link dynamicReferenceSpans} reads it as
 * a token's INNER text (the resolver's `[^}]+`) rather than as its terminator —
 * which is exactly how a `{Ref}` sitting inside a `{{resolve:...}}` opening
 * must read. A NUL, RESERVED here as the placeholder: a template string can
 * carry one (CDK preserves it), so a source whose literal text does is refused
 * outright rather than rendered with one unknowable part too many.
 */
export const UNKNOWN_PART_PLACEHOLDER = '\u0000';

/**
 * The literal text an `Fn::Join` PART contributes, or `undefined` when the
 * part is not knowable from the template (issue #3055).
 *
 * The resolver joins every part as `String(await resolveValue(part))`, and
 * `resolveValue` returns a NUMBER or BOOLEAN unchanged, so such a part
 * contributes exactly `String(part)` -- `8080` joins as `8080`, `true` as
 * `true`. A string part is its raw text here as it always was (a
 * `{{resolve:` inside it is the token the readers look for, not text this
 * function resolves). Reading only strings as literal made the other two a
 * wildcard for the skeleton arm (a candidate differing at that position could
 * match) and a placeholder for the frame arm (whose rendered frame then no
 * longer equals the leaf's text around the middle, so the arm refuses) -- and,
 * through the frame arm's rewrite, for the nested-stack parameter recorder's
 * `frameSpellingOf`, which carries a framed parameter to the child only when
 * the position pass rewrote it -- which, on a value the recorder's gate (ii)
 * finds the scan silent on, only the frame arm can do (the value scan, the
 * skeleton arm and the cross-stack arm each rewrite an object-sourced leaf
 * whose WHOLE value is a recorded plaintext, and (ii) is what refuses that
 * value). The recorder's own rendering of such a part does not
 * decide the case: a part outside the token leaves its one span and service
 * prefix the same either way.
 *
 * `null` stays unknowable although the resolver would join it as `null`, as it
 * was before this function existed: it is not a part a CloudFormation template
 * can carry meaningfully. Being a wildcard, it can still let the skeleton arm
 * match a lone candidate spelling something else at that position -- the
 * arm's existing wrong-reference residual, not narrowed here. The literal
 * reading reaches that same residual in a few more places: a source that left
 * two candidates matching as a wildcard can now leave ONE, which the arm
 * accepts even when the leaf's own reference was never recorded (a public
 * `ssm` parameter). An object or array part (an intrinsic, a list, or any
 * other object) stays {@link UNKNOWN_PART}.
 */
export function joinPartLiteralText(part: unknown): string | undefined {
  if (typeof part === 'string') return part;
  if (typeof part === 'number' || typeof part === 'boolean') return String(part);
  return undefined;
}

/**
 * The text of an `Fn::Join` / `Fn::Sub` source in order: a literal part as its
 * RAW text (a number or boolean `Fn::Join` part as the text the resolver joins
 * it as, {@link joinPartLiteralText}), an unknowable part as
 * {@link UNKNOWN_PART}. ONE parser for the three
 * readers of that shape — {@link intrinsicSkeletonPattern}, which hands every
 * segment to {@link anchoredSkeletonPattern} to spell as a regex,
 * {@link positionByIntrinsicFrame}, which needs the
 * literal text VERBATIM to know where a token's frame begins and ends, and
 * `frameSpellingOf` in {@link recordNestedStackParameterExpressions}, which
 * renders the same text to find the token a carried frame spells — so
 * they cannot disagree about what a source says (issues #2745, #3062).
 *
 * `undefined` for any source this cannot describe, per the pattern reader's
 * doc: a delimiter that is itself an intrinsic, a non-array `Fn::Join`, a
 * non-string `Fn::Sub` template, an object that is not a single-key intrinsic.
 */
export function intrinsicSkeletonSegments(
  source: Record<string, unknown>
): Array<string | typeof UNKNOWN_PART> | undefined {
  const keys = Object.keys(source);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;

  if (key === 'Fn::Join') {
    const args = source[key];
    if (!Array.isArray(args) || args.length !== 2) return undefined;
    const [delimiter, parts] = args as [unknown, unknown];
    // A non-string delimiter is REFUSED. An intrinsic one is unknowable, and it
    // sits BETWEEN every pair of parts, so wildcarding it would erase most of
    // the skeleton's specificity. A number delimiter would be knowable (joined
    // as `String(delimiter)`, like a part), but no template is known to carry
    // one. Refusing it costs a parser-wide refusal: every reader gets
    // `undefined`, so the leaf falls to the value scan and no nested-stack
    // carry is recorded.
    if (typeof delimiter !== 'string' || !Array.isArray(parts)) return undefined;
    const segments: Array<string | typeof UNKNOWN_PART> = [];
    parts.forEach((part, index) => {
      if (index > 0) segments.push(delimiter);
      segments.push(joinPartLiteralText(part) ?? UNKNOWN_PART);
    });
    return segments;
  }

  if (key === 'Fn::Sub') {
    const args = source[key];
    // Both forms: the bare template string, and the 2-arg `[template, vars]`.
    // The variable MAP is deliberately not consulted — a var can be bound to an
    // intrinsic, so only the `${...}` POSITIONS are reliably knowable.
    const template = typeof args === 'string' ? args : Array.isArray(args) ? args[0] : undefined;
    if (typeof template !== 'string') return undefined;
    const segments: Array<string | typeof UNKNOWN_PART> = [];
    let cursor = 0;
    const variable = /\$\{([^}]*)\}/g;
    let hit: RegExpExecArray | null;
    while ((hit = variable.exec(template)) !== null) {
      segments.push(template.slice(cursor, hit.index));
      const inner = hit[1]!;
      // `${!Foo}` is CloudFormation's escape for a LITERAL `${Foo}`, so it is
      // known text rather than a substitution point.
      segments.push(inner.startsWith('!') ? `\${${inner.slice(1)}}` : UNKNOWN_PART);
      cursor = hit.index + hit[0].length;
    }
    segments.push(template.slice(cursor));
    return segments;
  }

  return undefined;
}

/**
 * Position a leaf whose SOURCE is an intrinsic OBJECT, by matching the shape of
 * that intrinsic against the expressions this process recorded as secrets
 * (issue #1916).
 *
 * This is the residual {@link redactByPath} left behind. Its plain-string arm
 * persists the source leaf VERBATIM, which needs a source string to copy; when
 * the source leaf is an `Fn::Join` / `Fn::Sub` there is none, so the leaf fell
 * to the value scan — and the value map is keyed by the resolved PLAINTEXT, so
 * a colliding pair collapses there exactly as it did before #1904. That is the
 * DOMINANT CDK shape rather than an edge case: a secret reached through an L2
 * token usually renders the secret ARN as a `Ref`, hence an `Fn::Join`. The
 * exceptions render a plain `{{resolve:...}}` string, which the literal arm
 * already positions: a secret imported by a LITERAL ARN
 * (`Secret.fromSecretCompleteArn` / `fromSecretPartialArn`, whose
 * `secretValue` and `secretValueFromJson` both inline it),
 * `SecretValue.secretsManager('<literal arn>')` and
 * `SecretValue.ssmSecure(...)` (synth-probed on this repo's aws-cdk-lib,
 * issue #3143; `new Secret(...)` and `fromSecretNameV2` are the join).
 *
 * Three conditions must ALL hold before an expression is persisted, and each
 * removes a different way of being wrong:
 *
 * 1. The bag leaf's WHOLE value is a recorded secret plaintext. The skeleton
 *    describes ONE complete `{{resolve:...}}` token, so a leaf that merely
 *    EMBEDS a secret (a join with surrounding text) is not this shape at all
 *    and goes on to {@link positionByIntrinsicFrame} (issue #2745), and only
 *    where that refuses to the value scan, which rewrites just the substring.
 * 2. EXACTLY ONE candidate matches. Two matching candidates mean the skeleton
 *    genuinely cannot separate them (`{Ref}` in the position that differs), and
 *    guessing would be the collapse this fix exists to remove, one step over.
 * 3. The match is not DEMONSTRABLY another value's expression. The pass's own
 *    map holds each surviving expression against the plaintext it resolved to,
 *    so a candidate recorded there under a DIFFERENT plaintext is refused. That
 *    is what fences a bag/source misalignment: a shape-plausible expression is
 *    rejected outright when the pass can see it resolved to something else. A
 *    candidate absent from that map is a collapsed LOSER, which is the case
 *    this whole function exists to serve, so it is accepted.
 *
 * Every rejection falls to {@link positionByIntrinsicFrame} (issue #2745) and,
 * where that arm refuses too, to the value scan, i.e. to today's behavior, so
 * no case gets worse than it is without this pass.
 *
 * One residual is worth naming rather than leaving to be rediscovered: a single
 * WRONG candidate can win only when this leaf's own expression is in NEITHER
 * store — an `ssm` reference whose `Type` came back unclassifiable
 * (deliberately unpinned per #1901) and which then lost the value collapse, or
 * a PUBLIC `ssm` reference (stored resolved, #1901) whose value coincides with
 * a recorded secret's plaintext. `recordedSecretExpressions` is process-wide, so the winner
 * could in principle come from another resource, and condition 3 cannot refuse
 * one the pass never recorded.
 *
 * **What that costs is a WRONG REFERENCE in state, not merely a noisy diff.**
 * Persisting another leaf's expression is the pre-#1904 failure exactly:
 * `resolveReplayProps` RE-RESOLVES the persisted expression against AWS and
 * hands the result to `provider.update`, so a rollback replays the wrong secret
 * — immediately, if the two references already resolve to different values. It
 * is narrow (unclassifiable or public `ssm` leaves only) but it is not cosmetic, and an
 * earlier draft of this paragraph called it "a spurious UPDATE rather than a
 * disclosure", which understated it.
 *
 * There is deliberately NO {@link isKnownSecretExpression} check here, and the
 * asymmetry with {@link redactByPath}'s plain-string arm is principled rather
 * than an oversight. That arm's candidate is the SOURCE LEAF itself — arbitrary
 * template text, which genuinely can be a PUBLIC ssm reference that must stay
 * resolved in state (issue #1901), so it has to be tested. Here the candidates
 * come only from {@link recordedSecretExpressions} and from the values of a
 * {@link RecordedSecretValues} map, which the resolver populates ONLY on a
 * proven-secret verdict — and, since issue #2745, the nested-stack recorder's
 * framed carry entries ({@link recordedExpressionsOf}), which are not
 * references but ARE map values, so the same membership test reads them as
 * secret too. So the test could never answer `false`, and an
 * unfalsifiable guard reads as protection while fencing nothing. Widening the
 * candidate sources to a reference that can be public is what would make it
 * necessary again.
 */
export function positionByIntrinsicSkeleton(
  bag: string,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues,
  secretExpressions: ReadonlySet<string>
): string | undefined {
  // Condition 1. The empty string is excluded for the reason the value pass
  // excludes it: it is not a distinguishing value.
  if (bag === '' || !secrets.has(bag)) return undefined;

  const pattern = intrinsicSkeletonPattern(source);
  if (!pattern) return undefined;

  const plaintextOf = plaintextIndexOf(secrets);

  let matched: string | undefined;
  for (const candidate of new Set([...secretExpressions, ...recordedSecretExpressions])) {
    if (candidate.length > MAX_SKELETON_CANDIDATE_LENGTH) return undefined;
    if (!pattern.test(candidate)) continue;
    // Condition 3.
    const recordedPlaintext = plaintextOf.get(candidate);
    if (recordedPlaintext !== undefined && recordedPlaintext !== bag) continue;
    // Condition 2.
    if (matched !== undefined) return undefined;
    matched = candidate;
  }
  return matched;
}
