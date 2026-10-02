import {
  DYNAMIC_REFERENCE_INNER_CHAR,
  escapeRegExp,
  isSingleDynamicReferenceToken,
  isPlainObject,
} from './rules.js';
import {
  type RecordedSecretValues,
  CONFLICTING_PLAINTEXT,
  resolvedPlaintextOf,
  resolvedExpressionsOf,
} from './pairs.js';
import {
  type CrossStackAssociation,
  crossStackSourceKey,
  crossStackAssociations,
} from './cross-stack.js';
import { redactSecretsForState } from './redact-state.js';
import { recordedSecretExpressions } from './mask-only.js';
import { dynamicReferenceSpans } from './redact-path.js';

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
const MAX_SKELETON_CANDIDATE_LENGTH = 512;

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
function anchoredSkeletonPattern(
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
function joinPartLiteralText(part: unknown): string | undefined {
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
 * Walk a {@link RecordedSecretValues} the OTHER way: every expression the pass
 * recorded, against the plaintext it actually resolved to.
 *
 * This is condition 3's index, built ONCE per positioning call rather than
 * re-scanned per candidate. A collapsed LOSER is absent from it, which is the
 * case both callers exist to serve.
 *
 * It is NOT an inversion, because `secrets` need not be injective — one
 * expression CAN appear under two plaintexts. Taking the last such plaintext
 * would WEAKEN condition 3 (the scan it replaced refused when ANY entry
 * disagreed with `bag`), so a conflicting expression is poisoned to a sentinel
 * no bag can equal, which refuses it exactly as the scan did.
 *
 * The branch is HARD to reach from the resolver — one resolver's
 * `cachedDynamicReferences` yields one plaintext per expression and credential
 * identity (issue #3660), so a single pass cannot produce two — but it is no
 * longer unreachable from there since that cache became per-resolver (issue
 * #1933): two resolvers in two regions legitimately resolve one expression to
 * two different plaintexts, and a caller merging their maps lands exactly here.
 * It is reachable through this module's API regardless, and it is FENCED, by
 * the "recorded against MORE THAN ONE plaintext" case. An earlier draft of
 * this comment claimed the divergence was
 * unobservable, reasoning that `plaintextOf[E] === bag` implies
 * `secrets.get(bag) === E` so accepting and falling back agree. That misses the
 * case where a SECOND candidate also matches: accepting `E` then makes it two
 * matches, which condition 2 refuses, and the answers differ. Asserting
 * something cannot be fenced suppresses the attempt, so it needs the same
 * evidence a fence does.
 *
 * `has` is the whole test: `RecordedSecretValues` is keyed by plaintext, so
 * iterating it never yields one plaintext twice and a second sighting of an
 * expression is always a DIFFERENT plaintext.
 *
 * SHARED by {@link positionByIntrinsicSkeleton},
 * {@link positionByCrossStackSource} (issue #2059) and
 * {@link positionByIntrinsicFrame} (issue #2745) rather than copied: the
 * poisoning rule is the subtle half of condition 3, and every copy is another
 * place for it to be relaxed independently.
 */
export function plaintextIndexOf(secrets: RecordedSecretValues): Map<string, string | symbol> {
  const plaintextOf = new Map<string, string | symbol>();
  for (const [plaintext, expression] of secrets) {
    plaintextOf.set(expression, plaintextOf.has(expression) ? CONFLICTING_PLAINTEXT : plaintext);
  }
  return plaintextOf;
}

/**
 * THE THREE CONDITIONS, in ONE place, over one bag and one already-resolved
 * association (issue [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * Three call sites ask this same question and every one of them must answer it
 * identically or the PERSIST side and the DIFF side disagree — which is not a
 * hypothetical: the two halves must produce the same expression for the same
 * leaf, or the desired side of the next diff never matches what was persisted
 * and the resource reports a change on every deploy (issue #2087's symptom,
 * arriving through a second spelling of one predicate). The sites are
 * {@link positionByCrossStackSource} (persist, string leaf),
 * {@link certifiedListForLeaf} (persist and diff, list leaf) and
 * {@link inheritedParameterExpression} (diff, whole parameter). THIS FUNCTION
 * OWNS THE QUESTION; none of them re-spells it.
 *
 * 1. The leaf's WHOLE value is a recorded secret plaintext. A leaf that merely
 *    EMBEDS a secret is not this shape and must keep going to the value scan,
 *    which rewrites just the substring. This is also what keeps a PUBLIC
 *    reference out (issue #1901): the resolver records a plaintext only on a
 *    proven-secret verdict, so a public parameter's value is not a key here.
 *    The empty string is excluded for the reason the value pass excludes it: it
 *    is not a distinguishing value.
 * 2. The association is ABOUT THIS LEAF — the plaintext the WRITER recorded
 *    beside the expression equals the leaf. Within one pass this is the only
 *    guard against a bag/source MISALIGNMENT: a readback bag can hold a
 *    DIFFERENT resource's secret while the source leaf still spells this
 *    import, and condition 3 cannot refuse that (it must ACCEPT an expression
 *    absent from the pass's map, since the collapsed loser is absent too).
 * 3. The match is not DEMONSTRABLY another value's expression, over the
 *    {@link plaintextIndexOf} index. NOT subsumed by condition 2: that one
 *    compares what the WRITER recorded, this one what THIS pass's own map
 *    holds, and they can disagree when one reference answers differently in two
 *    regions (issue #1933). The collapsed LOSER is absent from the index, so it
 *    passes — which is the case this whole mechanism exists to serve.
 */
export function certifiedExpressionForLeaf(
  secrets: RecordedSecretValues,
  association: CrossStackAssociation,
  leaf: unknown
): string | undefined {
  // Condition 1.
  if (typeof leaf !== 'string' || leaf === '') return undefined;
  if (!secrets.has(leaf)) return undefined;
  // Condition 2.
  if (association.plaintext !== leaf) return undefined;
  // Condition 3.
  const recordedPlaintext = plaintextIndexOf(secrets).get(association.expression);
  if (recordedPlaintext !== undefined && recordedPlaintext !== leaf) return undefined;
  return association.expression;
}

/**
 * Apply {@link certifiedExpressionForLeaf} to every ELEMENT of a list leaf
 * (issue [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * WHAT "POSITION" MEANS FOR A LIST ELEMENT, which is the question that killed
 * the earlier attempt in issue #2012 and has to be answered before any array
 * may be certified: **it is not the index.** There is no source ARRAY to align
 * against — a list leaf's source is ONE intrinsic standing for the whole list —
 * so an index-based pairing would have nothing on the other side to pair WITH,
 * and inventing one is exactly the fabrication issue #2012 refused. What
 * certifies an element is its OWN VALUE, through condition 1 and condition 2
 * above. Order is therefore irrelevant: a reordered array certifies
 * identically, and an element the conditions do not reach is left exactly where
 * the value scan would have left it.
 *
 * NOTHING IS FABRICATED. The output array has the SAME length and the SAME
 * element ORDER as the input; every element is either an expression certified
 * from that element's own recorded plaintext, or the value-scan answer this
 * module already produces for it. No element is added, dropped, reordered, or
 * copied from the source — so there is no baseline content here that
 * `cdkd drift --revert` could push to AWS but AWS never reported. That is the
 * constraint the issue #2012 review imposed, satisfied structurally rather than
 * argued around.
 *
 * SHARED BY BOTH HALVES, and that sharing is load-bearing rather than tidy: the
 * persist side reaches it through {@link positionListByCrossStackSource} and
 * the diff side through {@link inheritedParameterExpression}, with the same
 * association content on either side ({@link inheritNestedStackParameterAssociations}
 * copies the parent's rows onto the child bag). Two spellings that agreed on
 * every case but one would reintroduce the perpetual UPDATE at that one case.
 *
 * Returns `undefined` when NO element was certified, so every caller falls
 * through to the value scan and keeps its identity-return: with an empty
 * secrets map (the issue #1900 unchanged-resource path) condition 1 refuses
 * every element, so this costs one walk and changes nothing.
 */
export function certifiedListForLeaf(
  secrets: RecordedSecretValues,
  association: CrossStackAssociation,
  bag: readonly unknown[]
): unknown[] | undefined {
  // CERTIFY FIRST, and only then build the output. The refusal path is the
  // COMMON one -- every leaf whose source keys to an association but whose
  // elements are public, and every array on a pass with an empty bag -- and
  // `redactSecretsForState` rebuilds a needle regex per call, so mapping the
  // whole array before discovering nothing was certified cost N regex builds
  // that {@link redactByPath} then paid again on its own fallback scan.
  const certified = bag.map((element) => certifiedExpressionForLeaf(secrets, association, element));
  if (certified.every((expression) => expression === undefined)) return undefined;
  return bag.map((element, i) => certified[i] ?? redactSecretsForState(element, secrets));
}

/**
 * The association {@link crossStackAssociations} holds for a SOURCE leaf, or
 * `undefined` when this pass has none (or a poisoned one) for it.
 */
function associationForSource(
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): CrossStackAssociation | undefined {
  const key = crossStackSourceKey(source);
  if (key === undefined) return undefined;
  // THIS PASS's associations and no others. A pass that recorded nothing —
  // `cdkd state refresh-observed`, whose bag is empty by construction — finds
  // no bucket and falls through, which is the same answer it gets today.
  const associations = crossStackAssociations.get(secrets);
  if (associations === undefined) return undefined;
  // A poisoned key reads back as the symbol, so this refuses an absent
  // association and a conflicting one in one move.
  const association = associations.get(key);
  if (association === undefined || typeof association === 'symbol') return undefined;
  return association;
}

/**
 * Position a leaf whose SOURCE is a CROSS-STACK intrinsic object
 * (`Fn::ImportValue` / `Fn::GetStackOutput`), by looking its identity up in the
 * association the RESOLVER recorded while it read the producer (issue
 * [#2059](https://github.com/go-to-k/cdkd/issues/2059)).
 *
 * This is the residual {@link positionByIntrinsicSkeleton} leaves behind, and
 * it needs a different mechanism rather than one more skeleton arm.
 * {@link intrinsicSkeletonPattern} is a TEXT matcher over the source leaf's
 * literals, and these two intrinsics carry no text about their expression at
 * all: `Fn::ImportValue`'s only literal is the export NAME, and
 * `Fn::GetStackOutput`'s are `StackName` / `OutputName` / `Region`, none of
 * which bears any relation to the producer's `{{resolve:...}}` string. A
 * pure-wildcard skeleton is not a fallback either — {@link SKELETON_WILDCARD}
 * is `[^}]*`, which cannot cross a token's own `}}` — so it would match zero
 * candidates and always refuse, i.e. degrade to the collapse. The association
 * has to come from the one place that holds both halves at once, which is
 * {@link crossStackAssociations}.
 *
 * THE THREE CONDITIONS ARE {@link certifiedExpressionForLeaf}'s and are stated
 * ONLY there. They were re-enumerated here until issue #2327 extracted the
 * owner, and the copy had already drifted from it three ways within the same
 * change -- it dropped the empty-string clause, it explained condition 2 by a
 * scoping story ({@link crossStackAssociations} being per-pass) that is not the
 * owner's OTHER caller's, and it said "three intrinsic spellings" when
 * {@link crossStackSourceKey} answers for five. A rationale that drifts inside
 * one PR is the argument against duplicating it.
 *
 * There is deliberately NO "exactly one candidate" test (the neighbour's
 * condition 2): this is a LOOKUP rather than a search, so the ambiguity that
 * test exists to catch shows up here as a key recorded against two different
 * associations, which {@link recordCrossStackExpression} already poisons at
 * WRITE time.
 *
 * WHY THIS IS A POSITION CERTIFICATION AND NOT A WIDENING. The issue #1915
 * fences rejected an earlier attempt that took the SOURCE subtree whenever the
 * bag could not be vouched for, because it rewrote a `{Name: '', Value:
 * 'an-unrelated-literal'}` pair. Nothing here can do that: the answer is never
 * the source subtree, it is an expression a WRITER recorded against this exact
 * leaf identity; the arm fires only for the spellings
 * {@link crossStackSourceKey} can key; and
 * condition 1 still demands that the bag leaf be a plaintext this pass
 * resolved. Every rejection degrades to {@link positionByIntrinsicSkeleton},
 * {@link positionByIntrinsicFrame} and then to the value scan, i.e. to today's
 * behavior.
 */
export function positionByCrossStackSource(
  bag: string,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): string | undefined {
  const association = associationForSource(source, secrets);
  if (association === undefined) return undefined;
  // The three conditions live in ONE place (issue #2327). An earlier revision
  // spelled them here and again on the diff side; keeping one owner is what
  // makes "the two halves agree" a property of the code rather than of a
  // reviewer noticing.
  return certifiedExpressionForLeaf(secrets, association, bag);
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
 * drops every plaintext shorter than {@link MIN_NEEDLE_LENGTH} from its
 * alternation, so an embedded 1-3 character secret is left in plaintext by
 * the scan, with or without a same-plaintext sibling. Accepting the scan's
 * silence (`scanned === bag`) as equivalence would therefore be a NEW claim
 * rather than a choice within the scan's class, and on a previous
 * generation's bag it would fabricate: a 1-3 character readback or old
 * record that COINCIDES with today's plaintext (`port:0` where AWS returns a
 * default and today's secret resolved to `0`) would be persisted as today's
 * expression, which round-trips today and, after a rotation, reports a drift
 * that never happened. So that arm is admitted only for a bag whose
 * generation IS proven: `bagIsSameGeneration`, the object-level mark
 * {@link markSameGenerationBag} puts on the bags the deploy engine hands to
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
 * substituted `effectiveProperties` built a bag of MIXED provenance, so that
 * object is never marked and a sub-floor middle in it keeps the scan's
 * answer. A readback AWS rewrote at that offset to a value that coincides
 * with the 1-3 character secret is persisted as the expression: value-equal
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
 * The residuals named above (an `effectiveProperties` substitution, a
 * nonliteral frame) are not repaired by that deploy either.
 *
 * One shape reaches this arm that a reader may not expect: a WHOLE-token
 * source that FAILED the whole-token arm's `isKnownSecretExpression` gate (an
 * `ssm` token whose type came back unclassifiable and which lost the map slot
 * to a sibling). Its "frame" is empty, and if this pass recorded it resolving
 * to the bag it is written back as itself — an expression, and the leaf's own,
 * where the scan wrote the survivor. Stated so it is not mistaken for a leak.
 *
 * Everything else keeps the pre-#2485 fall-through: two or more spans (which
 * span produced which value is genuinely ambiguous when they share one), a
 * frame mismatch, a middle that is itself a complete token (an
 * already-redacted record, per the same refusal {@link learnMixedLeafNeedle}
 * makes), and a middle this pass cannot vouch for. An `Fn::Sub` / `Fn::Join`
 * source (an object, not this arm at all — issue #2320's placeholder
 * primitive) is {@link positionByIntrinsicFrame}'s since #2745, and reaches
 * the value scan only where that arm refuses.
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
  if (frame === undefined) return redactSecretsForState(bag, secrets);
  const recorded = resolvedPlaintextOf(secrets, frame.token);
  if (recorded === undefined || recorded !== frame.middle) {
    return redactSecretsForState(bag, secrets);
  }
  return writeFramedTokenWithinScanBound(bag, secrets, frame, bagIsSameGeneration);
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
function writeFramedTokenWithinScanBound(
  bag: string,
  secrets: RecordedSecretValues,
  frame: { token: string; prefix: string; suffix: string; middle: string },
  bagIsSameGeneration: boolean
): string {
  const scanned = redactSecretsForState(bag, secrets);
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
  // the entry beside `recordResolvedPair`, the one `mergeResolvedPairs` caller
  // copies the entries first, and nothing deletes from a `RecordedSecretValues`
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

/**
 * Position a bag leaf whose `Fn::Join` / `Fn::Sub` source EMBEDS exactly one
 * `{{resolve:...}}` token inside LITERAL surrounding text — `port:` + token —
 * by writing that token into the frame the source states (issue
 * [#2745](https://github.com/go-to-k/cdkd/issues/2745)).
 *
 * This is the intrinsic twin of {@link positionByEmbeddedSpan}, and the shape
 * is the DOMINANT one rather than a corner: `'port:' + secret.secretValueFromJson('pin')`
 * renders the secret ARN as a `Ref`, so CDK emits
 * `{"Fn::Join": ["", ["port:{{resolve:secretsmanager:", {"Ref": ...}, ":SecretString:pin::}}"]]}`
 * — the prefix FUSED into the token's opening part, the `Ref` INSIDE the
 * token. Before this arm such a leaf had no positioning route at all:
 * {@link positionByIntrinsicSkeleton} refuses unless the WHOLE bag is a
 * recorded plaintext (its condition 1), and {@link positionByEmbeddedSpan}
 * needs a source STRING to copy its frame from. So it fell to the value scan,
 * which for a 4+ character middle writes the map's SURVIVOR (a same-plaintext
 * sibling's spelling, the #1904 / #2485 class) and for a 1-3 character middle
 * writes NOTHING — {@link buildNeedleRegex} drops it from the alternation —
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
 * {@link SKELETON_WILDCARD}, capped by {@link MAX_SKELETON_WILDCARDS} through
 * the same {@link joinSkeletonSegments}, so the token pattern is the skeleton
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
 * 2. THIS PASS resolved that candidate to the middle ({@link recordResolvedPair},
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
 * middle. {@link positionByIntrinsicSkeleton} runs first and answers for
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

/**
 * Keys tried, in order, when pairing two arrays whose ORDER cannot be trusted
 * (issue #1915).
 *
 * Both are the identity field of an unordered CloudFormation list that really
 * does carry secrets: `Name` is the ECS `ContainerDefinitions[]` /
 * `Environment[]` / `Secrets[]` and CodeBuild `EnvironmentVariables[]` shape,
 * `Key` is the `Tags[]` shape the drift normalizer already keys on
 * (`canonicalizeTagListsDeep` in `src/analyzer/drift-normalize.ts`). The list
 * is deliberately SHORT: an entry is only useful when it is a genuine identity,
 * and a wrong entry costs a refused pairing rather than a wrong one (see
 * {@link identityKeyFor}), so widening it buys little and has to be justified
 * per shape.
 *
 * Worth naming rather than leaving to be rediscovered: `drift-normalize.ts`
 * deliberately moved its GENERAL case OFF heuristics like this one, onto
 * provider-DECLARED paths (`getDriftUnorderedPaths` + `matchesPathPrefix`),
 * after issue #1783 showed a heuristic claiming order-independence for a list
 * that was order-SIGNIFICANT (`KeySchema`). Only its `Tags[]` pass is still a
 * heuristic. This module diverges on purpose, because the two failure modes are
 * not comparable: there, a wrong claim SUPPRESSES real drift; here, the worst a
 * wrong pairing key can do is fail the uniqueness test and refuse, leaving the
 * leaf exactly where the value scan already had it. If that ever stops being
 * true — if a pairing gains the power to DELETE or REORDER rather than only to
 * rewrite a matched leaf — this list has to move to a declared seam too.
 */
const ARRAY_IDENTITY_KEYS = ['Name', 'Key'] as const;

/**
 * Is every element of `items` a plain object carrying a NON-EMPTY OWN string at
 * `key`, with no two elements sharing a value?
 *
 * `Object.hasOwn` for the same reason the object walk below uses it: without
 * it the prototype chain answers for a key like `constructor`, and while state
 * that came from `JSON.parse` cannot carry one, this module is called with
 * caller-constructed bags too and the two walks disagreeing is the kind of gap
 * that only shows up once something else changes.
 *
 * The empty string is excluded because it is not a distinguishing identity —
 * the same reason the value scan refuses it as a needle. Two elements both
 * carrying `Name: ''` would otherwise pair on "equality" that means nothing.
 */
function isUniquelyKeyedBy(items: readonly unknown[], key: string): boolean {
  if (items.length === 0) return false;
  const seen = new Set<string>();
  for (const item of items) {
    if (!isPlainObject(item) || !Object.hasOwn(item, key)) return false;
    const id = item[key];
    if (typeof id !== 'string' || id === '') return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Pick a key that identifies the elements of BOTH arrays, or `undefined` when
 * none does (issue #1915).
 *
 * This is what lets a leaf nested in an ARRAY be positioned on a path where
 * positional descent is refused. `descendArrays: false` is not a claim that the
 * bag and source elements are unrelated — it is a claim that their ORDER does
 * not correspond, because AWS does not preserve list order (the reason
 * `src/analyzer/drift-normalize.ts` exists). Matching by an identity FIELD
 * answers the order objection directly instead of working around it, so the
 * relaxation is sound on every rules constant and is deliberately NOT gated on
 * one.
 *
 * Requiring uniqueness WITHIN each array is what makes a pairing impossible to
 * get wrong: pairing is by string EQUALITY, so a bag element can only ever meet
 * the source element carrying the same identity, and uniqueness means there is
 * at most one of those. A key that is not really an identity (a repeated enum
 * value) fails the uniqueness test and refuses the whole pairing rather than
 * producing a plausible-looking wrong one. An element with no partner is not
 * guessed at either — it falls to the value scan, exactly as the whole array
 * did before.
 *
 * Keys are tried in {@link ARRAY_IDENTITY_KEYS} order and the FIRST one that
 * qualifies on both sides wins; a key that fails does not veto the next one.
 *
 * Two shapes this deliberately does NOT reach, stated so they are bounds rather
 * than surprises — both fail closed, leaving the leaf to the value scan:
 *
 * - **The identity field itself holds a secret.** The source element carries
 *   `{Name: '{{resolve:...}}'}` and the bag element the resolved plaintext, so
 *   the two never pair and the element's other leaves are not reached either.
 *   Closing it would mean pairing on a field whose two sides are KNOWN to
 *   differ, i.e. exactly the guessing the uniqueness rule exists to forbid. On
 *   the unchanged-resource path the value scan is also a no-op, so such a leaf
 *   keeps its plaintext — narrow (an identity field is a name, not a
 *   credential) but real.
 * - **Arrays of arrays.** `M: [[{Name, Value}]]` pairs nothing HERE, because the
 *   OUTER elements are arrays rather than plain objects and have no identity
 *   field to key on. Blind positional descent into the outer list would
 *   reintroduce the order assumption this function exists to avoid. On the
 *   READBACK paths it is no longer a dead end:
 *   {@link refuseUncertifiedReadbackPositions} (issue #2012) walks the outer
 *   list positionally when {@link unkeyedArrayPairsByAnchors} says the inner
 *   elements' own anchors vouch for the alignment, which meets the order
 *   objection instead of ignoring it. The gate decides; it does not walk. Everywhere else — and whenever
 *   those anchors do not match — the shape still falls to the value scan.
 */
export function identityKeyFor(
  bag: readonly unknown[],
  source: readonly unknown[]
): string | undefined {
  for (const key of ARRAY_IDENTITY_KEYS) {
    if (isUniquelyKeyedBy(bag, key) && isUniquelyKeyedBy(source, key)) return key;
  }
  return undefined;
}

/**
 * Position the ELEMENTS of an array leaf whose SOURCE is an intrinsic OBJECT,
 * by the same leaf-identity lookup {@link positionByCrossStackSource} performs
 * for a string leaf (issue
 * [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * A child parameter declared `CommaDelimitedList` is coerced by
 * `coerceParameterTypedValue` into an ARRAY before any of this runs, so a
 * leaf the child template spells `{Ref: <Param>}` arrives beside an intrinsic
 * OBJECT as an array — a shape NO arm matched, which dropped it to the
 * plaintext-keyed value scan and handed BOTH members of a coinciding pair the
 * survivor's expression. `docs/cli-reference.md` names `CommaDelimitedList` as
 * an ALLOWED spelling for a secret-bearing nested-stack parameter, so it is
 * reachable rather than theoretical.
 *
 * The element rule, what it refuses and why nothing is fabricated all live on
 * {@link certifiedListForLeaf}, which the DIFF side calls too. TWO further
 * refusals belong to THIS site rather than to the shared rule:
 *
 * 1. REFUSAL — a source leaf {@link crossStackSourceKey} cannot key, or one
 *    this pass recorded no association for. Both fall to the value scan, i.e.
 *    to today's behaviour.
 * 2. REFUSAL — {@link positionByIntrinsicSkeleton} is deliberately NOT tried
 *    element-wise, and the asymmetry with the string arm is structural rather
 *    than caution. {@link intrinsicSkeletonPattern} accepts exactly `Fn::Join`
 *    and `Fn::Sub`, both of which produce a STRING; an array bag beside one of
 *    them is a SHAPE DIVERGENCE, not a position. Matching a per-element pattern
 *    built from text that describes the whole joined string would be a guess of
 *    precisely the kind condition 2 of that function exists to refuse.
 *
 * NOT GATED ON `rules`, for the reason the string arm next door is not: the
 * certification rests on the element being a plaintext THIS pass recorded,
 * which a previous generation's persisted expression can never be, and it never
 * depends on the two sides being positionally aligned. In practice only the
 * TEMPLATE-sourced walks can reach it at all — every STATE-sourced source leaf
 * is a persisted value, not an intrinsic object — but the safety does not rest
 * on that.
 */
export function positionListByCrossStackSource(
  bag: readonly unknown[],
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): unknown[] | undefined {
  const association = associationForSource(source, secrets);
  if (association === undefined) return undefined;
  return certifiedListForLeaf(secrets, association, bag);
}
