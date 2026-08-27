import { describe, it, expect, afterEach } from 'vite-plus/test';
import {
  clearRecordedSecretExpressions,
  recordSecretExpression,
  redactSecretsForState,
  recordNestedStackParameterExpressions,
  inheritNestedStackParameterAssociations,
  inheritedParameterExpression,
  STATE_DERIVED_RULES,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

/**
 * POSITION certification for a LIST-VALUED nested-stack child leaf (issue
 * [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * Issue #2291 closed the collapse for a child parameter declared `Type: String`.
 * A parameter declared `CommaDelimitedList` is ALSO an allowed spelling for a
 * secret-bearing nested-stack parameter — `docs/cli-reference.md` says so
 * explicitly — and `coerceParameterTypedValue` turns it into an ARRAY
 * before any redaction runs. `redactByPath` then had no arm for "array bag
 * beside an intrinsic OBJECT", so the leaf dropped to the plaintext-keyed value
 * scan and BOTH members of a coinciding pair took the survivor's expression:
 * the child persists its SIBLING's version stage, `resolveReplayProps`
 * re-resolves that, and a rollback or `cdkd drift --revert` pushes the WRONG
 * secret version to the live resource.
 *
 * THE DISCRIMINATING SHAPE IS TWO LIST LEAVES IN ONE BAG, for the reason the
 * string suite next door states: a single leaf passes with the collapse fully
 * intact, because with one needle there is nothing to collapse onto. Every
 * behavioural case below puts both leaves in ONE bag whose map has already
 * collapsed to `size === 1`, exactly as the parent hands it down.
 *
 * WHAT IS ASSERTED IS WHICH EXPRESSION EACH LEAF PERSISTS, never "redaction
 * happened" — the broken code redacts too, onto the wrong reference.
 */

const SECRET_ID = 'prod/db/cred';
/**
 * Two spellings of ONE reference, resolving identically (an empty version stage
 * defaults to `AWSCURRENT`). Neither is a substring of the other, so an
 * assertion naming one cannot be satisfied by the other.
 */
const EXPR_A = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:listarm::}}`;
const EXPR_B = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:listarm:AWSCURRENT:}}`;
const SHARED = 'sh4red-l1st-pl4intext-2327';

const PARAM_A = 'SecretListA';
const PARAM_B = 'SecretListB';

/** The parent's UNRESOLVED `AWS::CloudFormation::Stack` properties. */
const PARENT_SOURCE = {
  TemplateURL: 'https://s3.amazonaws.com/bucket/child.json',
  Parameters: { [PARAM_A]: EXPR_A, [PARAM_B]: EXPR_B },
};

/**
 * The same properties AFTER the parent resolved them: one value, twice, and
 * both STRINGS. The parent never sees an array — `NestedStackProvider`'s
 * `extractParameters` refuses a non-scalar parameter value outright — so the
 * recorder's own string-only refusal is correct as it stands and is NOT what
 * this issue changes. The array appears only INSIDE the child, produced by the
 * child's own `Type` coercion of this string.
 */
const PARENT_RESOLVED = {
  TemplateURL: 'https://s3.amazonaws.com/bucket/child.json',
  Parameters: { [PARAM_A]: SHARED, [PARAM_B]: SHARED },
};

/** The parent's per-resource bag as a resolution pass actually leaves it. */
function collapsedParentBag(): RecordedSecretValues {
  return new Map([[SHARED, EXPR_B]]);
}

/**
 * A child bag that never got the per-parameter override — one entry, the
 * parent's collapsed SURVIVOR. That is what a child which inherits no
 * association holds, and what every child held before issue #2291.
 */
function childBagFrom(parent: RecordedSecretValues): RecordedSecretValues {
  const survivor = parent.get(SHARED);
  return survivor === undefined ? new Map() : new Map([[SHARED, survivor]]);
}

/** A parent that has recorded its per-parameter associations. */
function recordedParent(): RecordedSecretValues {
  const parent = collapsedParentBag();
  recordNestedStackParameterExpressions(
    parent,
    'AWS::CloudFormation::Stack',
    PARENT_RESOLVED,
    PARENT_SOURCE
  );
  return parent;
}

/**
 * The child resource's bag EXACTLY as `recordInheritedParameterSecrets` builds
 * it, plus the inherited associations.
 *
 * NOT `new Map(parent)`, which is what this helper used to return and what hid
 * the issue #2327 review's blocker: the persist side would then have been
 * reading a bag production never hands it, and the whole point of the parity
 * claim is that the two sides read DIFFERENT bags. Production writes ONE entry
 * per plaintext, holding whichever parameter's own expression resolved LAST --
 * so `lastResolved` is a real degree of freedom and the cases below exercise
 * both settings of it.
 */
function wiredChild(
  parent: RecordedSecretValues,
  lastResolved: string = PARAM_B
): RecordedSecretValues {
  const child: RecordedSecretValues = new Map();
  const order = lastResolved === PARAM_A ? [PARAM_B, PARAM_A] : [PARAM_A, PARAM_B];
  const survivor = parent.get(SHARED);
  if (survivor !== undefined) {
    for (const name of order) {
      const own = inheritedParameterExpression(parent, name, SHARED);
      child.set(SHARED, typeof own === 'string' ? own : survivor);
    }
  }
  inheritNestedStackParameterAssociations(child, parent);
  return child;
}

/** The child template's two leaves, both fed by a LIST-typed parameter. */
const CHILD_SOURCE = { AList: { Ref: PARAM_A }, BList: { Ref: PARAM_B } };

// `recordSecretExpression` writes a PROCESS-WIDE set, so the skeleton case
// below would otherwise leak its candidate into every later case in this file
// and into whatever runs after it in the same worker.
afterEach(() => {
  clearRecordedSecretExpressions();
});

describe('list-valued nested-stack parameter leaves (#2327)', () => {
  it('gives each list leaf ITS OWN expression, out of a parent bag that has already collapsed', () => {
    const parent = recordedParent();
    // The measured pre-condition: the parent bag genuinely cannot answer this.
    expect(parent.size).toBe(1);
    expect(parent.get(SHARED)).toBe(EXPR_B);

    const persisted = redactSecretsForState(
      { AList: [SHARED], BList: [SHARED] },
      wiredChild(parent),
      CHILD_SOURCE
    ) as Record<string, unknown>;

    expect(persisted['AList']).toEqual([EXPR_A]);
    expect(persisted['BList']).toEqual([EXPR_B]);
    // And the plaintext is gone from both, stated so a fix that stopped
    // redacting could not pass the two above by leaving the leaves alone.
    expect(JSON.stringify(persisted)).not.toContain(SHARED);
  });

  it('collapses onto the survivor when the associations are NOT inherited (the pre-fix answer, kept as the discriminator)', () => {
    const parent = recordedParent();
    // A child bag with no associations copied onto it — a top-level stack, or
    // any caller that inherits nothing. This is what makes the case above an
    // assertion about the fix rather than about the harness.
    const persisted = redactSecretsForState(
      { AList: [SHARED], BList: [SHARED] },
      childBagFrom(parent),
      CHILD_SOURCE
    ) as Record<string, unknown>;

    expect(persisted['AList']).toEqual([EXPR_B]);
    expect(persisted['BList']).toEqual([EXPR_B]);
  });

  it('is not gated on `rules` — the replay walk certifies the same way', () => {
    const parent = recordedParent();
    const persisted = redactSecretsForState(
      { AList: [SHARED], BList: [SHARED] },
      wiredChild(parent),
      CHILD_SOURCE,
      STATE_DERIVED_RULES
    ) as Record<string, unknown>;

    expect(persisted['AList']).toEqual([EXPR_A]);
    expect(persisted['BList']).toEqual([EXPR_B]);
  });

  it('certifies by element IDENTITY, not by index — a multi-element list keeps its length, order and public elements', () => {
    const parent = recordedParent();
    // The secret sits at a DIFFERENT index in each list, and each list also
    // carries ordinary public entries. If the arm certified by position it
    // could only be right about one of the two.
    const persisted = redactSecretsForState(
      {
        AList: ['sg-public-first', SHARED, 'sg-public-last'],
        BList: [SHARED, 'sg-public-only'],
      },
      wiredChild(parent),
      CHILD_SOURCE
    ) as Record<string, unknown>;

    expect(persisted['AList']).toEqual(['sg-public-first', EXPR_A, 'sg-public-last']);
    expect(persisted['BList']).toEqual([EXPR_B, 'sg-public-only']);
  });

  it('fabricates nothing: an element the conditions cannot reach keeps the answer the value scan gives it', () => {
    const parent = recordedParent();
    const embedded = `postgres://u:${SHARED}@host`;
    const persisted = redactSecretsForState(
      // One element IS the whole plaintext (certifiable) and one merely EMBEDS
      // it (refusal 1) — so certification and refusal have to coexist inside a
      // single array.
      { AList: [SHARED, embedded] },
      wiredChild(parent),
      CHILD_SOURCE
    ) as Record<string, unknown>;

    const out = persisted['AList'] as unknown[];
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(EXPR_A);
    // The embedded element takes the value scan's substring rewrite — today's
    // behaviour, unchanged — and is NOT handed this parameter's expression.
    expect(out[1]).toBe(`postgres://u:${EXPR_B}@host`);
    expect(out[1]).not.toContain(EXPR_A);
  });

  it('REFUSES a non-string element rather than descending into it', () => {
    const parent = recordedParent();
    const persisted = redactSecretsForState(
      { AList: [{ Nested: SHARED }] },
      wiredChild(parent),
      CHILD_SOURCE
    ) as Record<string, unknown>;

    // The source intrinsic describes the LIST and says nothing about the shape
    // of a container inside it, so the element falls to the value scan and
    // takes the survivor — the pre-fix answer, deliberately retained.
    expect(persisted['AList']).toEqual([{ Nested: EXPR_B }]);
  });

  it('REFUSES the skeleton pass element-wise: an array beside an Fn::Join is a shape divergence, not a position', () => {
    // `intrinsicSkeletonPattern` accepts `Fn::Join` / `Fn::Sub`, both of which
    // produce a STRING. Matching a per-element pattern built from text that
    // describes the whole joined string would be a guess, so the arm does not
    // try it and the leaf keeps the value scan's answer.
    //
    // THE SKELETON PASS HAS TO BE ABLE TO ANSWER, or this case refuses for a
    // reason that has nothing to do with the arm under test. Measured: without
    // the `recordSecretExpression` below, `EXPR_A` is in NEITHER candidate
    // source (the child bag's values hold only the survivor), so the skeleton
    // finds zero matches and refuses on its own -- and a mutation that DOES try
    // it element-wise left this case green. Registering the expression is what
    // makes the refusal this test's rather than the skeleton's.
    recordSecretExpression(EXPR_A);
    const parent = recordedParent();
    const persisted = redactSecretsForState(
      { Joined: [SHARED] },
      wiredChild(parent),
      { Joined: { 'Fn::Join': ['', [EXPR_A]] } }
    ) as Record<string, unknown>;

    expect(persisted['Joined']).toEqual([EXPR_B]);
    expect(persisted['Joined']).not.toEqual([EXPR_A]);
  });

  it('changes nothing on the unchanged-resource path, where the bag is empty by construction', () => {
    const parent = recordedParent();
    const emptyChild: RecordedSecretValues = new Map();
    inheritNestedStackParameterAssociations(emptyChild, parent);
    const bag = { AList: ['sg-public-first', 'sg-public-last'] };

    const persisted = redactSecretsForState(bag, emptyChild, CHILD_SOURCE) as Record<
      string,
      unknown
    >;
    // `toBe`, NOT `toEqual`: the claim is the issue #1900 IDENTITY-return, and a
    // rebuilt array with equal contents satisfies `toEqual` while breaking it.
    // Measured -- with `toEqual` here, a mutation that returned the rebuilt
    // array instead of `undefined` from `certifiedListForLeaf` left this case
    // green and was fenced on the diff side alone.
    expect(persisted['AList']).toBe(bag.AList);
  });
});

/**
 * PARITY between the PERSIST side and the DIFF side (issue
 * [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * "The persist side is correct" is NOT the property that matters, and it is
 * satisfied by a broken diff side too: the child's state holds each leaf's own
 * expression while `redactParametersForDiff` computes the collapsed survivor,
 * the two never match again for the LOSING parameter, and the resource reports
 * a change on every deploy -- issue #2087's user-visible symptom arriving
 * through a different door. So the discriminator is the two halves AGREEING,
 * per leaf, on a bag where they could disagree.
 *
 * They agree by CONSTRUCTION rather than by coincidence: both reach
 * `certifiedListForLeaf` / `certifiedExpressionForLeaf`, which own the three
 * conditions. These cases fence that the wiring actually routes there.
 */
describe('#2327 persist/diff parity', () => {
  it('THE DISCRIMINATOR: both halves produce the SAME expression per leaf, and the two leaves DIFFER', () => {
    const parent = recordedParent();
    // THE TWO HALVES READ DIFFERENT BAGS IN PRODUCTION, and this case now
    // supplies different ones. `redactParametersForDiff` reads
    // `options.inheritedSecrets` -- the PARENT's bag, whose single entry is the
    // collapsed SURVIVOR -- while the persist side reads the issue #2087-scoped
    // per-resource CHILD bag, which `recordInheritedParameterSecrets` fills
    // with each parameter's OWN expression, so its entry is whichever `Ref`
    // resolved LAST. Passing `new Map(parent)` to both would have asserted
    // agreement only for the case where that distinction does not exist.
    //
    // WHAT THE SUBSET GUARANTEE DOES AND DOES NOT COVER, corrected in review.
    // `inheritedSecretsCarriedBy` records every inherited plaintext the value
    // carries and nothing else, so the child bag's KEYS for a parameter-fed
    // leaf are a subset of the parent's -- which makes CONDITION 1 answer
    // identically on both sides, and that is all it does. It says nothing about
    // condition 3, which reads the bag's VALUES, nor about the value-scan
    // FALL-THROUGH, which also reads values. Condition 3 is now decided ONCE at
    // write time (refusal 4), so both sides read one verdict; the fall-through
    // asymmetry is older than this arm and is pinned as a residual below.
    const child = wiredChild(parent, PARAM_A);
    expect(child.get(SHARED)).not.toBe(parent.get(SHARED));

    // The PERSIST side: what the child's state.json will hold.
    const persisted = redactSecretsForState(
      { AList: [SHARED], BList: [SHARED] },
      child,
      CHILD_SOURCE
    ) as Record<string, unknown>;

    // The DIFF side: what `redactParametersForDiff` binds for each parameter,
    // which the diff resolver then hands back for `{Ref: <Param>}`.
    const desiredA = inheritedParameterExpression(parent, PARAM_A, [SHARED]);
    const desiredB = inheritedParameterExpression(parent, PARAM_B, [SHARED]);

    // Agreement, per leaf. This is the assertion that could only pass after the
    // fix: before it the persist side collapsed and the diff side refused.
    expect(desiredA).toEqual(persisted['AList']);
    expect(desiredB).toEqual(persisted['BList']);

    // ...and the two leaves are NOT the same answer, so "both halves returned
    // the survivor" cannot satisfy the two assertions above.
    expect(desiredA).not.toEqual(desiredB);
    expect(desiredA).toEqual([EXPR_A]);
    expect(desiredB).toEqual([EXPR_B]);
  });

  it('THE #2327 REVIEW BLOCKER: the two-regions shape cannot certify on one side and refuse on the other', () => {
    // THE SHAPE (issue #1933): this pass ALSO watched `EXPR_A` resolve to a
    // DIFFERENT plaintext. Read-time condition 3 sees that through the bag's
    // VALUES -- and the two sides hold different bags, so it answered
    // differently on each: the PERSIST side certified `EXPR_A` (absent from the
    // child bag's values, so nothing to object to) while the DIFF side refused
    // and fell back to the survivor. Measured over a sweep of bag
    // configurations, that diverged on 4 of 16.
    //
    // Worse than a phantom diff: the child would persist the ONE expression the
    // pass has direct evidence resolves to something else, and
    // `resolveReplayProps` re-resolves what is persisted -- so a rollback or
    // `cdkd drift --revert` applies the WRONG secret. Issue #2327's own failure
    // mode, one shape over.
    //
    // Refusal 4 moves that verdict to WRITE time, against the parent's map,
    // which is the bag that watched the resolution. Both readers then see one
    // table and degrade together to the value scan.
    const parent: RecordedSecretValues = new Map([
      [SHARED, EXPR_B],
      ['a-different-plaintext-2327', EXPR_A],
    ]);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );

    // Both settings of the only degree of freedom the child bag has.
    for (const last of [PARAM_A, PARAM_B]) {
      const child = wiredChild(parent, last);
      const persisted = redactSecretsForState(
        { AList: [SHARED], BList: [SHARED] },
        child,
        CHILD_SOURCE
      ) as Record<string, unknown>;
      for (const [name, key] of [
        [PARAM_A, 'AList'],
        [PARAM_B, 'BList'],
      ] as const) {
        const desired =
          inheritedParameterExpression(parent, name, [SHARED]) ??
          redactSecretsForState([SHARED], parent);
        expect(desired, `${name} with ${last} resolved last`).toEqual(persisted[key]);
      }
      // ...and the answer is the SURVIVOR on both sides, i.e. both degraded
      // together. Stated so "they agree" cannot be satisfied by both sides
      // certifying the expression this pass has evidence against.
      expect(persisted['AList']).toEqual([EXPR_B]);
    }
  });

  it('REFUSAL 4 also fires through the CONFLICTING-plaintext symbol, not only a plain mismatch', () => {
    // A SECOND SHAPE for refusal 4, because the blocker case above was its only
    // discriminating test and a single point of fence is what this lane has
    // twice found to be worth less than it looks.
    //
    // DIFFERENT ROUTE THROUGH THE SAME COMPARISON. There, `plaintextIndexOf`
    // answers with a STRING -- one other plaintext this pass watched `EXPR_A`
    // resolve to -- and the refusal is a plain inequality. Here `EXPR_A` is
    // recorded against TWO other plaintexts, so the index POISONS its entry and
    // answers with `CONFLICTING_PLAINTEXT`; the refusal then rests on a symbol
    // never equalling the resolved value. A fix that compared only strings
    // would pass the case above and fail this one.
    //
    // Measured in an isolated copy: with refusal 4 removed, this configuration
    // diverges on 2 of its 4 rows (persist certifies `EXPR_A`, the diff side
    // refuses and falls back), and with it in place all 4 agree.
    const parent: RecordedSecretValues = new Map([
      [SHARED, EXPR_B],
      ['a-different-plaintext-2327', EXPR_A],
      ['third-plaintext-2327', EXPR_A],
    ]);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );

    for (const last of [PARAM_A, PARAM_B]) {
      const child = wiredChild(parent, last);
      const persisted = redactSecretsForState(
        { AList: [SHARED], BList: [SHARED] },
        child,
        CHILD_SOURCE
      ) as Record<string, unknown>;
      for (const [name, key] of [
        [PARAM_A, 'AList'],
        [PARAM_B, 'BList'],
      ] as const) {
        const desired =
          inheritedParameterExpression(parent, name, [SHARED]) ??
          redactSecretsForState([SHARED], parent);
        expect(desired, `${name} with ${last} resolved last`).toEqual(persisted[key]);
      }
      // `PARAM_A` degraded to the value scan; `PARAM_B`'s association is intact
      // (its own expression has a clean index entry) and still certifies. So
      // this case also fences that refusal 4 is PER PARAMETER rather than
      // per pass -- a blanket refusal would satisfy the agreement above.
      expect(persisted['AList']).toEqual([EXPR_B]);
      expect(inheritedParameterExpression(parent, PARAM_B, [SHARED])).toEqual([EXPR_B]);
      expect(inheritedParameterExpression(parent, PARAM_A, [SHARED])).toBeUndefined();
    }
  });

  it('PINNED RESIDUAL: the value-scan fall-through reads a different bag on each side', () => {
    // OLDER THAN THIS ARM and deliberately not closed here. When neither side
    // certifies, both fall through to `redactSecretsForState` -- the persist
    // side over the CHILD bag, the diff side over the PARENT's -- and those
    // differ in VALUES by construction.
    //
    // TWO SHAPES REACH IT, not one. An earlier revision of this comment named
    // only the first, and issue
    // [#2349](https://github.com/go-to-k/cdkd/issues/2349) was filed on that
    // narrower description:
    //
    // 1. an EMBEDDING element, which `crossStackSourceKey` can never key, so no
    //    association could have helped it -- the shape this case pins; and
    // 2. a BARE element whose parameter's association REFUSAL 4 refused while
    //    its SIBLING's survived. Measured on the final tree with no embedding
    //    anywhere in the bag: with `EXPR_B` recorded against two plaintexts,
    //    refusal 4 fires for `PARAM_B` only, the child bag takes `PARAM_A`'s own
    //    expression, and `PARAM_B`'s bare leaf then falls through to it while
    //    the diff side falls through to the parent's survivor.
    //
    // Shape 2 is one refusal 4 itself creates, and it is still a strict
    // BASELINE member -- the same sweep with the arm and refusal 4 both absent
    // diverges there too -- so it is a residual rather than new exposure.
    //
    // MEASURED: with the array arm disabled entirely and refusal 4 absent, the
    // same sweep that found the blocker above still diverged on 4 of 16
    // configurations, all of them here. This case pins one, so a future change
    // that alters it has to say so rather than drift.
    const parent = recordedParent();
    const embedded = `postgres://u:${SHARED}@host`;
    const child = wiredChild(parent, PARAM_A);

    const persisted = redactSecretsForState({ AList: [embedded] }, child, CHILD_SOURCE) as Record<
      string,
      unknown
    >;
    const desired =
      inheritedParameterExpression(parent, PARAM_A, [embedded]) ??
      redactSecretsForState([embedded], parent);

    // The persist side splices the child bag's entry, the diff side the
    // parent's, and they are different expressions.
    expect(persisted['AList']).toEqual([`postgres://u:${EXPR_A}@host`]);
    expect(desired).toEqual([`postgres://u:${EXPR_B}@host`]);
    expect(desired).not.toEqual(persisted['AList']);
  });

  it('PINNED RESIDUAL, shape 2: a BARE element diverges when refusal 4 fires for one parameter and not its sibling', () => {
    // THE SECOND SHAPE that reaches the issue
    // [#2349](https://github.com/go-to-k/cdkd/issues/2349) fall-through, and
    // the one its scope is written from. No EMBEDDING anywhere in this bag --
    // both leaves are bare `[SHARED]` -- so the case above cannot stand in for
    // it, and nothing else would notice a future change to refusal 4 that
    // widened or removed it.
    //
    // THE MECHANISM: `EXPR_B` is recorded against TWO plaintexts, so
    // `plaintextIndexOf` poisons its entry and refusal 4 fires for `PARAM_B`.
    // `PARAM_A`'s expression has a clean entry, so its association SURVIVES,
    // the child bag takes `PARAM_A`'s own expression, and `PARAM_B`'s
    // now-uncertifiable bare leaf falls through onto it -- while the diff side
    // falls through onto the parent's survivor.
    const parent: RecordedSecretValues = new Map([
      [SHARED, EXPR_B],
      ['a-different-plaintext-2327', EXPR_B],
    ]);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );
    const child = wiredChild(parent, PARAM_A);

    const persisted = redactSecretsForState(
      { AList: [SHARED], BList: [SHARED] },
      child,
      CHILD_SOURCE
    ) as Record<string, unknown>;
    const desiredB =
      inheritedParameterExpression(parent, PARAM_B, [SHARED]) ??
      redactSecretsForState([SHARED], parent);

    // THE DIVERGENCE, asserted POSITIVELY rather than as an inequality: a
    // future change that made both sides wrong TOGETHER would satisfy
    // `not.toEqual` and must not satisfy this.
    expect(persisted['BList']).toEqual([EXPR_A]);
    expect(desiredB).toEqual([EXPR_B]);

    // ...AND IT IS A BASELINE MEMBER, stated as the property that makes it one
    // rather than as a comment: NEITHER side certified this leaf, so the
    // divergence belongs entirely to the value-scan fall-through -- the
    // mechanism that predates the array arm and refusal 4 alike. If a future
    // change makes either side CERTIFY here, these two assertions stop being
    // about the residual and the case must be rewritten rather than renumbered.
    expect(inheritedParameterExpression(parent, PARAM_B, [SHARED])).toBeUndefined();
    expect(persisted['BList']).toEqual(redactSecretsForState([SHARED], child));

    // The SIBLING is the reason this shape exists at all: its association
    // survived refusal 4 and still certifies, which is what put its expression
    // into the child bag. A blanket refusal would remove the divergence.
    expect(inheritedParameterExpression(parent, PARAM_A, [SHARED])).toEqual([EXPR_A]);
  });

  it('keeps the SCALAR answer byte-identical, so the #2291 mechanism is untouched', () => {
    const parent = recordedParent();
    expect(inheritedParameterExpression(parent, PARAM_A, SHARED)).toBe(EXPR_A);
    expect(inheritedParameterExpression(parent, PARAM_B, SHARED)).toBe(EXPR_B);
  });

  it('refuses an unknown parameter, a non-list non-string value, and a value the association is not about', () => {
    const parent = recordedParent();
    expect(inheritedParameterExpression(parent, 'NoSuchParam', [SHARED])).toBeUndefined();
    expect(inheritedParameterExpression(parent, PARAM_A, 42)).toBeUndefined();
    expect(inheritedParameterExpression(parent, PARAM_A, '')).toBeUndefined();
    expect(inheritedParameterExpression(parent, PARAM_A, ['some-other-value'])).toBeUndefined();
    // An array with NOTHING certifiable returns `undefined` rather than a
    // rebuilt array, so the caller keeps its own fallback and its
    // identity-return.
    expect(inheritedParameterExpression(new Map(), PARAM_A, [SHARED])).toBeUndefined();
  });

  it('CONDITION 1, list-wise: an element the bag does not hold is refused even when the association names it', () => {
    // The association's plaintext and the element AGREE, so condition 2 passes
    // and only condition 1 can refuse. Dropping `!secrets.has(leaf)` certifies
    // a value this pass never resolved -- and every other list case in this
    // file is refused by condition 2 first, so none of them can see it.
    const parent = recordedParent();
    expect(parent.delete(SHARED)).toBe(true);
    expect(inheritedParameterExpression(parent, PARAM_A, [SHARED])).toBeUndefined();
  });

  it('CONDITION 1, list-wise: an EMPTY-STRING element is refused even when the bag holds it', () => {
    // The empty string is not a distinguishing value, so it is excluded before
    // the bag is consulted. Reaching this needs an association RECORDED against
    // `''`, which the real recorder will build when the parent's resolved value
    // is `''` and the bag holds it -- the resolver does not produce that today,
    // which is exactly why the clause is defence in depth and why nothing else
    // in this file fences it.
    const parent: RecordedSecretValues = new Map([
      ['', EXPR_A],
      [SHARED, EXPR_B],
    ]);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: '', [PARAM_B]: SHARED } },
      { Parameters: { [PARAM_A]: EXPR_A, [PARAM_B]: EXPR_B } }
    );
    // THE PREMISE, ESTABLISHED BY A POSITIVE OBSERVATION. A SIBLING recorded in
    // the SAME call must CERTIFY, which proves the recorder ran and reached
    // this `Parameters` block. Asserting a second `undefined` here -- which an
    // earlier revision did -- was inert: `undefined` is also what an absent
    // association returns, so deleting the recorder call left the file green
    // and the empty-string clause unfenced.
    expect(inheritedParameterExpression(parent, PARAM_B, SHARED)).toBe(EXPR_B);
    // ...and the empty-string element is refused by condition 1's own clause,
    // which is the only thing that can refuse it: it IS a key of the bag and it
    // IS what the writer recorded.
    expect(inheritedParameterExpression(parent, PARAM_A, [''])).toBeUndefined();
  });

  it('REFUSAL 4, list-wise: an expression this pass saw resolve ELSEWHERE is never recorded', () => {
    // Conditions 1 and 2 both pass -- the element is a key of the bag AND is
    // what the writer would have recorded -- so the only thing that can refuse
    // is the evidence that this pass watched `EXPR_A` resolve to a DIFFERENT
    // plaintext (issue #1933's two-regions shape).
    //
    // That verdict now lives at WRITE time, so nothing is recorded at all and
    // BOTH readers refuse together; see the blocker case above for why
    // deciding it at read time made the two sides disagree.
    const parent: RecordedSecretValues = new Map([
      [SHARED, EXPR_B],
      ['a-different-plaintext-2327', EXPR_A],
    ]);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );
    expect(inheritedParameterExpression(parent, PARAM_A, [SHARED])).toBeUndefined();
  });

  it('answers PER PLAINTEXT, which is the question the resolver-side bag asks', () => {
    // `recordInheritedParameterSecrets` writes a `Map<plaintext, expression>`,
    // so it passes the CARRIED PLAINTEXT rather than the parameter's value. A
    // plaintext this parameter does not own must not take its expression --
    // that is the collapse, one step over, and it is what the removed
    // `plaintext === value` gate used to prevent.
    const parent = recordedParent();
    const INNER = 'l1st-pl4intext';
    expect(SHARED).toContain(INNER);
    parent.set(INNER, `{{resolve:secretsmanager:${SECRET_ID}:SecretString:inner::}}`);

    expect(inheritedParameterExpression(parent, PARAM_A, SHARED)).toBe(EXPR_A);
    expect(inheritedParameterExpression(parent, PARAM_A, INNER)).toBeUndefined();
  });
});
