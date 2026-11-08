import type { RecordedSecretValues } from '../pairs.js';
import { storeAssociation, crossStackAssociations, crossStackSourceKey } from '../cross-stack.js';
import { isSingleDynamicReferenceToken } from '../rules.js';
import { redactForState } from '../context.js';
import { certifiedListForLeaf, certifiedExpressionForLeaf } from '../certified-positions.js';
import { rendersLiteralTo, renderedTokenOf } from '../positions.js';
import { deepEqualJsonValue } from '../redact-path.js';
import { nestedStackParameterExpressions, renderedParameterSpellings } from './parameter-tables.js';
import { carriesChildOnlyPlaintext } from './child-only-plaintext.js';

/**
 * Copy a parent pass's per-PARAMETER associations onto a nested-stack CHILD
 * resource's own bag, as ordinary {@link crossStackAssociations} rows keyed by
 * `{Ref: <ParamName>}` (issue #2291).
 *
 * Called by the child `DeployEngine` once per resolver context, so each
 * child resource's fresh bag carries them. Pre-seeding every resource this way
 * does NOT reintroduce issue #2087's over-redaction: an association can only
 * change an answer through `positionByCrossStackSource`'s condition 1,
 * which requires the bag leaf to be a plaintext THIS resource's bag holds — and
 * since #2087 that is true only of resources whose own resolution consumed the
 * parameter. The scoping still comes from the plaintext bag; this table only
 * decides WHICH expression such a leaf takes.
 *
 * Nothing is copied when the parent recorded nothing, which is every non-nested
 * caller and every nested one whose parameters carry no secret.
 */
export function inheritNestedStackParameterAssociations(
  childSecrets: RecordedSecretValues,
  parentSecrets: RecordedSecretValues
): void {
  const table = nestedStackParameterExpressions.get(parentSecrets);
  if (table === undefined || table.size === 0) return;
  let associations = crossStackAssociations.get(childSecrets);
  for (const [name, association] of table) {
    const key = crossStackSourceKey({ Ref: name });
    if (key === undefined) continue;
    if (associations === undefined) {
      associations = new Map();
      crossStackAssociations.set(childSecrets, associations);
    }
    // A poisoned parent entry is copied AS the poison, so the child refuses for
    // the same reason the parent could not answer.
    //
    // NO PRODUCTION PATH DISCRIMINATES THIS, which is a narrower claim than the
    // one an earlier revision made ("no test can") — and that one was FALSE,
    // disproved in review by constructing the case through this module's own
    // API. Copying the poison and dropping the entry differ as soon as anything
    // writes the SAME key on the child bag afterwards: with the copy the key
    // stays poisoned and the reader refuses, without it the later write lands on
    // an empty slot and CERTIFIES. `recordCrossStackExpression` is exactly such
    // a writer, so a test reaches it (and now does).
    //
    // Production cannot, because the resolver only ever builds a `sourceKey`
    // from `Fn::ImportValue` / `Fn::GetStackOutput` / `Fn::GetAtt` and never
    // from a `Ref`, so no production writer can collide with an inherited
    // parameter key. That is the same standard the sibling note on
    // {@link storeAssociation} uses — "reachable only through this module's
    // API" — and it is the accurate one here.
    if (typeof association === 'symbol') {
      associations.set(key, association);
      continue;
    }
    storeAssociation(associations, key, association.expression, association.plaintext);
  }
}

/**
 * The expression a nested-stack child's PARAMETER was resolved from, or
 * `undefined` when this pass cannot certify one (issue #2291).
 *
 * The DIFF-side twin of `positionByCrossStackSource`, and it must exist
 * or the fix trades one bug for another. The child's persisted state now holds
 * each parameter-fed leaf's OWN expression, so the desired side of the next
 * diff has to hold it too; `redactParametersForDiff` (`deploy-engine/masking.ts`) rewrites the
 * parameter bag through the plaintext-keyed map alone, which hands BOTH members
 * of a coinciding pair the survivor's expression. The two sides would then
 * never match for the losing parameter: a perpetual UPDATE on every deploy of
 * such a child, which is issue #2087's user-visible symptom arriving through a
 * different door.
 *
 * `parentSecrets` is the INHERITED bag — the parent's own per-resource map, the
 * object this table is keyed by — not the child resource's bag.
 *
 * The same THREE conditions the persist side applies, because it is literally
 * the same code: {@link certifiedExpressionForLeaf} OWNS the question and both
 * halves call it. See that function for why condition 3 is not subsumed by
 * condition 2.
 *
 * RETURNS AN ARRAY for a LIST-typed parameter (issue
 * [#2327](https://github.com/go-to-k/cdkd/issues/2327)), through the same
 * {@link certifiedListForLeaf} the persist side reaches from
 * `positionListByCrossStackSource`. `coerceParameterTypedValue` splits a
 * `CommaDelimitedList` parameter's STRING into an array before either side sees
 * it, so a scalar answer here would be compared against an array in state and
 * report a change forever — this function's own failure mode, one shape over.
 *
 * TWO CALLERS, and the widened return type is why the second one asks a
 * different question. `redactParametersForDiff` assigns the result into a
 * `Record<string, unknown>` and needs the whole parameter's answer, array
 * included. `recordInheritedParameterSecrets` (`intrinsic-resolver/parameter-secrets.ts`) writes
 * into a `Map<string, string>` keyed by PLAINTEXT, so it asks this per
 * PLAINTEXT — passing the carried plaintext rather than the parameter's value —
 * and keeps only a `string` answer. That is not a workaround for the type: a
 * plaintext-keyed bag has one slot per plaintext, and the question it needs
 * answered is "does THIS parameter certify THIS plaintext", which is the same
 * question for a scalar and for an element of a list.
 */
export function inheritedParameterExpression(
  parentSecrets: RecordedSecretValues,
  parameterName: string,
  resolvedValue: unknown
): string | unknown[] | undefined {
  const association = nestedStackParameterExpressions.get(parentSecrets)?.get(parameterName);
  if (association === undefined) {
    return renderedParameterSpelling(parentSecrets, parameterName, resolvedValue);
  }
  if (typeof association === 'symbol') return undefined;

  // A LIST-typed parameter (issue #2327). `coerceParameterTypedValue` split the
  // parent's STRING into an array before this side ever saw it, so the answer
  // has to be an array too — a string here would make the desired side a scalar
  // against an array in state and report a change forever, which is the very
  // failure this function exists to prevent, one shape over.
  //
  // THE SAME {@link certifiedListForLeaf} THE PERSIST SIDE CALLS, not a second
  // spelling of it. The two halves have to agree element for element; sharing
  // the rule is what makes that a property of the code.
  if (Array.isArray(resolvedValue)) {
    return certifiedListForLeaf(parentSecrets, association, resolvedValue);
  }

  // No rendered-spelling fallback here or on the poisoned arm above: an
  // association needs a value that IS a recorded plaintext, which
  // {@link renderedParameterSpelling} refuses.
  return certifiedExpressionForLeaf(parentSecrets, association, resolvedValue);
}

/**
 * The parent's literal spelling of `parameterName` when it EMBEDS the value's
 * plaintexts (issue [#4644](https://github.com/go-to-k/cdkd/issues/4644)), or
 * `undefined`. Two tests, both against the bag this is asked of:
 *
 * 1. WHOLE-VALUE identity: the recorder saw this parameter resolve to exactly
 *    `resolvedValue`, and that value is NOT itself a key of the bag. Such a
 *    value belongs to the association table, and the carry asks per PLAINTEXT:
 *    without the key test a value that a concatenation of tokens happens to
 *    spell (`{{A}}{{B}}`, or another token resolving to the whole string)
 *    would hand the child bag a multi-token entry. The identity half is
 *    implied by 2 while the pairs stand (a pair is never rewritten, only
 *    poisoned), and stated so the answer never rests on that table's write
 *    rule alone.
 * 2. The spelling RE-RENDERS to the value through the bag's own pairs and
 *    holds no plaintext in its literal text ({@link rendersLiteralTo}): the
 *    recorder's word is not taken alone.
 *
 * Nothing is fabricated: the answer is a string the parent's template spells
 * at this parameter, and whose every non-literal character is a plaintext the
 * parent pass resolved that very token to.
 */
function renderedParameterSpelling(
  parentSecrets: RecordedSecretValues,
  parameterName: string,
  resolvedValue: unknown
): string | undefined {
  if (typeof resolvedValue !== 'string' || parentSecrets.has(resolvedValue)) return undefined;
  const rendered = renderedParameterSpellings.get(parentSecrets)?.get(parameterName);
  if (rendered == null || rendered.value !== resolvedValue) return undefined;
  if (!rendersLiteralTo(rendered.spelling, parentSecrets, resolvedValue)) return undefined;
  return rendered.spelling;
}

/**
 * The token `parameterName`'s rendered spelling (the answer
 * {@link inheritedParameterExpression} gives for its whole `value`) spells at
 * `plaintext`, for the nested-stack carry (issue
 * [#4644](https://github.com/go-to-k/cdkd/issues/4644)); `undefined` when the
 * parameter has no rendered spelling or it names no single token there.
 *
 * WHY THE CARRY. The diff side binds the parameter to that spelling at EVERY
 * child read site -- `Fn::Select`, `Fn::Split`, an array, an `Fn::If` -- while
 * the persist side positions only a bare `{Ref}` and the placeholder arms;
 * every other shape falls to the child bag's value scan, which reads the
 * carry's entry. Recording the spelling's own token there makes the scan
 * agree with the diff side for any shape. Which plaintexts are carried (the
 * #2087 scope) is untouched; only the expression attached changes, and only
 * where this certifies one.
 */
export function inheritedRenderedToken(
  parentSecrets: RecordedSecretValues,
  parameterName: string,
  value: unknown,
  plaintext: string
): string | undefined {
  const spelling = inheritedParameterExpression(parentSecrets, parameterName, value);
  if (typeof spelling !== 'string' || isSingleDynamicReferenceToken(spelling)) return undefined;
  return renderedTokenOf(spelling, parentSecrets, plaintext);
}

/**
 * Withdraw `parameterName`'s rendered spelling from the pass owning
 * `parentSecrets`, as a conflicting re-record does: every reader then answers
 * as before issue [#4644](https://github.com/go-to-k/cdkd/issues/4644) -- the
 * diff side, the `{Ref}` arm, {@link inheritedRenderedSpan} and the carry
 * alike. Called by `poisonRenderedSpellingsCollidingIn` for a parameter one
 * child resource reads beside a sibling the carry would record differently
 * for the same plaintext (issue
 * [#4731](https://github.com/go-to-k/cdkd/issues/4731)).
 */
export function withdrawRenderedParameterSpelling(
  parentSecrets: RecordedSecretValues,
  parameterName: string
): void {
  const rendered = renderedParameterSpellings.get(parentSecrets);
  if (rendered?.has(parameterName)) rendered.set(parameterName, null);
}

/**
 * The parent's rendered spelling for a `{Ref: <Param>}` span of a child leaf
 * that EMBEDS the parameter -- `Fn::Join ['x-', {Ref: Conn}]` -- keyed by the
 * span's {@link crossStackSourceKey}, or `undefined` (issue
 * [#4644](https://github.com/go-to-k/cdkd/issues/4644)). Read by the
 * placeholder arms (`placeholder-positions.ts`) for a span no association
 * certifies.
 *
 * The diff side substitutes {@link inheritedParameterExpression}'s answer for
 * the parameter wherever the child template reads it, so an embedding leaf's
 * desired value is the template's literals around that answer. Without this
 * the persist side scanned such a span with the CHILD bag (its survivor for
 * the plaintext) while the diff side held the parameter's own spelling: an
 * UPDATE on every deploy.
 *
 * {@link positionByInheritedParameter}'s conditions, over the span: this
 * resource's resolution READ the parameter while it carried an inherited
 * secret (the #2087 scope), the span's text is the recorded value
 * (`text`, when the caller has it), it carries no child-only plaintext, and
 * the child bag would not rewrite the spelling. `value` is what the span
 * renders to, for a caller aligning the template against the leaf.
 */
export function inheritedRenderedSpan(
  childSecrets: RecordedSecretValues,
  key: string,
  text?: string
): { readonly value: string; readonly spelling: string } | undefined {
  const reads = inheritedParameterReads.get(childSecrets);
  if (reads === undefined || typeof reads === 'symbol') return undefined;
  for (const name of reads.names) {
    if (crossStackSourceKey({ Ref: name }) !== key) continue;
    const value = renderedParameterSpellings.get(reads.parent)?.get(name)?.value;
    if (value === undefined || (text !== undefined && text !== value)) return undefined;
    if (carriesChildOnlyPlaintext(value, childSecrets, reads.parent)) return undefined;
    // THE function the diff side binds, so a parameter the parent's
    // association table answers (or poisons) is answered here the same way.
    const spelling = inheritedParameterExpression(reads.parent, name, value);
    if (typeof spelling !== 'string') return undefined;
    if (redactForState(spelling, { provenance: 'value-scan', secrets: childSecrets }) !== spelling)
      return undefined;
    return { value, spelling };
  }
  return undefined;
}

/**
 * The parameters a nested-stack CHILD resource's resolution READ while their
 * value carried an inherited secret, and the PARENT bag that value was
 * checked against, keyed by the child resource's own bag (issue
 * [#2349](https://github.com/go-to-k/cdkd/issues/2349)).
 *
 * A `WeakMap` keyed by the pass's bag, for the reason
 * {@link nestedStackParameterExpressions} gives: the parent bag holds
 * PLAINTEXT and must not outlive the pass. `POISONED_PARAMETER_READS` marks a
 * child bag that was handed TWO different parent bags; no engine does that
 * (one child engine has one `inheritedSecrets`), and the reader refuses it
 * rather than choose.
 */
export const inheritedParameterReads = new WeakMap<
  RecordedSecretValues,
  | {
      readonly parent: RecordedSecretValues;
      readonly names: Set<string>;
      /**
       * EVERY parameter this resource read, carrying a secret or not, with
       * its value (issue #4731): what `positionByParameterReread`
       * re-reads a leaf from. `names` stays the secret-carrying subset.
       */
      readonly values: Map<string, unknown>;
      /**
       * The parameter names the child template DECLARES (issue #4919), so a
       * re-read can tell an unread parameter (a branch the pass did not take)
       * from a `Ref` to anything else; `undefined` until a recording names
       * them, when every unanswered name refuses.
       */
      declared?: ReadonlySet<string>;
    }
  | symbol
>();
const POISONED_PARAMETER_READS: unique symbol = Symbol('cdkd.inherited-parameter-reads.poisoned');

/** The reads record of `childSecrets` for `parentSecrets`, created if absent. */
function parameterReadsFor(
  childSecrets: RecordedSecretValues,
  parentSecrets: RecordedSecretValues
):
  | {
      readonly names: Set<string>;
      readonly values: Map<string, unknown>;
      declared?: ReadonlySet<string>;
    }
  | undefined {
  const reads = inheritedParameterReads.get(childSecrets);
  if (reads === undefined) {
    const created = { parent: parentSecrets, names: new Set<string>(), values: new Map() };
    inheritedParameterReads.set(childSecrets, created);
    return created;
  }
  if (typeof reads === 'symbol') return undefined;
  if (reads.parent !== parentSecrets) {
    inheritedParameterReads.set(childSecrets, POISONED_PARAMETER_READS);
    return undefined;
  }
  return reads;
}

/**
 * Record that the child resource owning `childSecrets` read `parameterName`
 * as `value` (issue [#4731](https://github.com/go-to-k/cdkd/issues/4731)),
 * for every parameter it reads while the child inherits a non-empty bag.
 * Two different values for one name refuse the whole record, as two parent
 * bags do; one deploy binds one value per parameter.
 */
export function recordInheritedParameterValue(
  childSecrets: RecordedSecretValues,
  parentSecrets: RecordedSecretValues,
  parameterName: string,
  value: unknown,
  declared?: ReadonlySet<string>
): void {
  const reads = parameterReadsFor(childSecrets, parentSecrets);
  if (reads === undefined) return;
  if (declared !== undefined) {
    // One child template per bag; two differing sets refuse the record.
    if (reads.declared === undefined) reads.declared = declared;
    else if (
      reads.declared.size !== declared.size ||
      [...declared].some((name) => !reads.declared!.has(name))
    ) {
      inheritedParameterReads.set(childSecrets, POISONED_PARAMETER_READS);
      return;
    }
  }
  if (reads.values.has(parameterName)) {
    if (!deepEqualJsonValue(reads.values.get(parameterName), value)) {
      inheritedParameterReads.set(childSecrets, POISONED_PARAMETER_READS);
    }
    return;
  }
  reads.values.set(parameterName, value);
}

/**
 * Record that the child resource owning `childSecrets` read `parameterName`
 * and that its value carried a plaintext of `parentSecrets` (issue #2349).
 * Called by `recordInheritedParameterSecrets` (`intrinsic-resolver/parameter-secrets.ts`) at the
 * moment it carries such a pair into the child bag, so the record exists for
 * exactly the parameters the #2087 scoping already admits into that bag.
 */
export function recordInheritedParameterRead(
  childSecrets: RecordedSecretValues,
  parentSecrets: RecordedSecretValues,
  parameterName: string
): void {
  parameterReadsFor(childSecrets, parentSecrets)?.names.add(parameterName);
}

/**
 * THE one answer for a nested-stack child PARAMETER's value with its inherited
 * secrets rewritten back to their expressions, read off the PARENT's bag
 * (issue [#2349](https://github.com/go-to-k/cdkd/issues/2349)).
 *
 * The DIFF side (`redactParametersForDiff` (`deploy-engine/masking.ts`)) binds this for every
 * parameter, and the PERSIST side ({@link positionByInheritedParameter})
 * writes it for a leaf the child template spells `{Ref: <Param>}`. One
 * function, so the two cannot disagree on any input.
 *
 * Before #2349 the persist side certified through the same predicate but FELL
 * THROUGH to a value scan of the CHILD resource's bag, whose one slot per
 * plaintext holds whichever parameter's own expression resolved LAST, while
 * the diff side fell through to the parent's collapsed survivor. Two shapes
 * reached it: an element that EMBEDS the plaintext, and a bare one whose
 * parameter's association was refused while a sibling's survived. Either way
 * the next diff reported a change that no deploy could clear.
 */
export function redactInheritedParameterValue(
  parentSecrets: RecordedSecretValues,
  parameterName: string,
  value: unknown
): unknown {
  return (
    inheritedParameterExpression(parentSecrets, parameterName, value) ??
    redactForState(value, { provenance: 'value-scan', secrets: parentSecrets })
  );
}

/**
 * Persist a nested-stack child leaf spelled exactly `{Ref: <Param>}` as
 * {@link redactInheritedParameterValue} answers it, so the persisted value is
 * the diff side's desired value by construction (issue #2349).
 *
 * `undefined` (the caller keeps its existing arms) unless ALL of:
 *
 * 1. the source is a single-key `{Ref: <string>}`;
 * 2. this resource's own resolution read that parameter while its value
 *    carried an inherited secret ({@link recordInheritedParameterRead}). That
 *    is the #2087 scope: a resource that never consumed the parameter has no
 *    record, and a leaf of a resource that did is the parameter's own value,
 *    which is all the parent bag is asked about;
 * 3. the leaf is a string or a list, the two shapes a parameter takes once
 *    `coerceParameterValue` has run (a number that carried a secret is refused
 *    upstream by `refuseCoercedInheritedSecret`);
 * 4. FAIL-CLOSED, on the ORIGINAL value: it carries no child-bag key the
 *    parent does not hold (a child-only plaintext, needle or mask-only, which
 *    the parent scan would leave or cut apart where a parent needle overlaps
 *    it), and no child NEEDLE the parent holds only as mask-only (no parent
 *    needle, so cut apart the same way), and no parent needle the child bag
 *    lacks (which the parent scan could take first, cutting an overlapping
 *    child plaintext); and the answer holds nothing the child bag would still
 *    rewrite. The existing arms
 *    redact with the child bag, so falling back to them keeps every leaf at
 *    least as redacted as before #2349; only the agreement with the diff
 *    side is given up, on that row alone.
 */
export function positionByInheritedParameter(
  bag: unknown,
  source: Record<string, unknown>,
  secrets: RecordedSecretValues
): unknown {
  const keys = Object.keys(source);
  if (keys.length !== 1 || keys[0] !== 'Ref') return undefined;
  const name = source['Ref'];
  if (typeof name !== 'string') return undefined;
  const reads = inheritedParameterReads.get(secrets);
  if (reads === undefined || typeof reads === 'symbol' || !reads.names.has(name)) {
    return undefined;
  }
  if (typeof bag !== 'string' && !Array.isArray(bag)) return undefined;
  // Condition 4, asked of the ORIGINAL value: a child-only plaintext the
  // parent-bag scan could cut apart (a parent needle overlapping it) would
  // leave fragments the answer's own re-scan can no longer find.
  if (carriesChildOnlyPlaintext(bag, secrets, reads.parent)) return undefined;
  const answer = redactInheritedParameterValue(reads.parent, name, bag);
  // ...and of the answer, for a parent expression that itself spells a
  // child needle. Deep equality, not identity: the value walk rebuilds every
  // array it visits, so `!==` would refuse every list leaf.
  if (!deepEqualJsonValue(redactForState(answer, { provenance: 'value-scan', secrets }), answer))
    return undefined;
  return answer;
}
