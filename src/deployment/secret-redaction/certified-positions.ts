import { type RecordedSecretValues, CONFLICTING_PLAINTEXT } from './pairs.js';
import {
  type CrossStackAssociation,
  crossStackSourceKey,
  crossStackAssociations,
} from './cross-stack.js';
import { redactSecretsForState } from './redact-state.js';

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
export function associationForSource(
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
