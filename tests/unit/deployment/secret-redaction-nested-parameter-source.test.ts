import { describe, it, expect, beforeEach } from 'vite-plus/test';
import {
  clearRecordedSecretExpressions,
  crossStackSourceKey,
  isRecordedSecretExpression,
  isSameGenerationBag,
  markSameGenerationBag,
  MIN_NEEDLE_LENGTH,
  recordCrossStackExpression,
  recordResolvedPair,
  redactSecretsForState,
  STATE_DERIVED_RULES,
  recordNestedStackParameterExpressions,
  inheritNestedStackParameterAssociations,
  inheritedParameterExpression,
  type PathSourceRules,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

/**
 * POSITION certification for a NESTED-STACK CHILD's `{Ref: <Param>}` source
 * leaf (issue [#2291](https://github.com/go-to-k/cdkd/issues/2291)).
 *
 * The parent resolves the child's `Parameters` block, so the child receives
 * PLAINTEXT and its own template spells the consumption as an intrinsic OBJECT
 * carrying no text about the producer's `{{resolve:...}}` string. Two things
 * had to be true for a leaf to keep its own expression and NEITHER was:
 *
 * 1. `RecordedSecretValues` is keyed by PLAINTEXT, so two parameters resolving
 *    to one value collapse to a single entry IN THE PARENT, before the child
 *    engine exists. The survivor is whichever the parent recorded last.
 * 2. Even with an uncollapsed bag the child could not use it: `{Ref: P}` gives
 *    the position pass nothing to certify against, so the leaf fell to the
 *    plaintext-keyed value scan — which hands both leaves the survivor.
 *
 * Consequence: a child leaf persists its SIBLING's version stage,
 * `resolveReplayProps` re-resolves that, and `cdkd drift --revert` / rollback
 * pushes the WRONG secret version to the live resource.
 *
 * THE DISCRIMINATING SHAPE IS TWO LEAVES IN ONE BAG, and only that. A single
 * leaf passes with the collapse fully intact — with one needle there is nothing
 * to collapse onto — and TWO RESOURCES would pass too, because
 * `perResourceSecrets` is keyed by logical id and two bags each hold one pair.
 * So every behavioural case below puts both leaves in ONE bag whose map has
 * already collapsed to `size === 1`, exactly as the parent hands it down.
 *
 * THE PARENT BAG IS HAND-BUILT AS THE COLLAPSED MAP, deliberately: it is the
 * measured pre-condition of this issue (`parent inheritedSecrets.size = 1`),
 * and building it any other way would be building the thing under test. What is
 * NOT hand-built is the association table — every case drives the real
 * `recordNestedStackParameterExpressions` against a real parent template
 * source, because that recorder deriving each expression from the POSITION pass
 * rather than from the collapsed map is the whole fix.
 */

const SECRET_ID = 'prod/db/cred';
/**
 * Two spellings of ONE reference. An empty version-stage defaults to
 * `AWSCURRENT`, so these resolve identically — issue #2059's rotating-secret
 * shape made deterministic. Neither is a substring of the other, so an
 * assertion naming one cannot be satisfied by the other.
 */
const EXPR_A = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:handoff::}}`;
const EXPR_B = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:handoff:AWSCURRENT:}}`;
const SHARED = 'sh4red-h4ndoff-pl4intext-2291';
/**
 * A THIRD expression, used only by the conflict case. It must differ from the
 * collapsed map's SURVIVOR (`EXPR_B`) or poisoning and last-write-wins become
 * indistinguishable — see that case's own note.
 */
const EXPR_C = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:handoff:AWSPREVIOUS:}}`;

const PARAM_A = 'SecretStageA';
const PARAM_B = 'SecretStageB';

/** The parent's UNRESOLVED `AWS::CloudFormation::Stack` properties. */
const PARENT_SOURCE = {
  TemplateURL: 'https://s3.amazonaws.com/bucket/child.json',
  Parameters: { [PARAM_A]: EXPR_A, [PARAM_B]: EXPR_B },
};

/** The same properties AFTER the parent resolved them: one value, twice. */
const PARENT_RESOLVED = {
  TemplateURL: 'https://s3.amazonaws.com/bucket/child.json',
  Parameters: { [PARAM_A]: SHARED, [PARAM_B]: SHARED },
};

/**
 * The parent's per-resource bag as it ACTUALLY comes out of a resolution pass
 * over the two references above: ONE entry, because the map is keyed by the
 * resolved plaintext. `EXPR_B` survives because it was recorded last.
 */
function collapsedParentBag(): RecordedSecretValues {
  // The map collapsed, the PAIR TABLE beside it not: the resolver records
  // `recordResolvedPair` for every resolution, so both tokens are on record
  // against `SHARED` -- what the recorder's refusal 5 (issue #3090) reads.
  const parent: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);
  recordResolvedPair(parent, EXPR_A, SHARED);
  recordResolvedPair(parent, EXPR_B, SHARED);
  return parent;
}

/**
 * The child resource's own bag. `recordInheritedParameterSecrets` copies the
 * inherited pair in at the moment the resource's `{Ref: P}` resolves, so the
 * child's bag inherits the SAME collapse — one entry, the survivor.
 */
function childBagFrom(parent: RecordedSecretValues): RecordedSecretValues {
  return new Map(parent);
}

/** The child template's two leaves, both fed by a parameter. */
const CHILD_SOURCE = { Value: { Ref: PARAM_A }, Description: { Ref: PARAM_B } };
/** What the child resolver produced for them: one plaintext, twice. */
const CHILD_RESOLVED = { Value: SHARED, Description: SHARED };

describe('crossStackSourceKey — the {Ref: <Param>} arm (#2291)', () => {
  it('keys two parameter names apart, and matches what the recorder writes', () => {
    const a = crossStackSourceKey({ Ref: PARAM_A });
    const b = crossStackSourceKey({ Ref: PARAM_B });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    // The two sides compute the same string from the same input, which is the
    // property that makes the store reachable at all.
    expect(crossStackSourceKey({ Ref: PARAM_A })).toBe(a);
  });

  it('cannot be confused with the other arms, and refuses a non-literal name', () => {
    // A `Ref` key must not collide with a `Fn::GetAtt` / `Fn::ImportValue` one
    // that happens to name the same string.
    expect(crossStackSourceKey({ Ref: 'Child.Outputs.Pw' })).not.toBe(
      crossStackSourceKey({ 'Fn::GetAtt': 'Child.Outputs.Pw' })
    );
    expect(crossStackSourceKey({ Ref: 'Producer:Pw' })).not.toBe(
      crossStackSourceKey({ 'Fn::ImportValue': 'Producer:Pw' })
    );
    expect(crossStackSourceKey({ Ref: '' })).toBeUndefined();
    expect(crossStackSourceKey({ Ref: { 'Fn::Sub': '${Name}' } })).toBeUndefined();
    expect(crossStackSourceKey({ Ref: 42 })).toBeUndefined();
    // A multi-key leaf is not valid CloudFormation and keys nowhere.
    expect(crossStackSourceKey({ Ref: PARAM_A, Extra: 1 })).toBeUndefined();
  });
});

describe('nested-stack parameter associations (#2291)', () => {
  it('gives each child leaf ITS OWN expression, out of a parent bag that has already collapsed', () => {
    const parent = collapsedParentBag();
    // The measured pre-condition: the parent bag genuinely cannot answer this.
    expect(parent.size).toBe(1);
    expect(parent.get(SHARED)).toBe(EXPR_B);

    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );

    const child = childBagFrom(parent);
    inheritNestedStackParameterAssociations(child, parent);

    const persisted = redactSecretsForState(CHILD_RESOLVED, child, CHILD_SOURCE) as Record<
      string,
      unknown
    >;
    expect(persisted['Value']).toBe(EXPR_A);
    expect(persisted['Description']).toBe(EXPR_B);
    // And the plaintext is gone from both, which the value scan also achieved —
    // stated so a fix that stopped redacting could not pass the two above by
    // leaving the leaves alone.
    expect(JSON.stringify(persisted)).not.toContain(SHARED);
  });

  it('collapses onto the survivor when the associations are NOT inherited (the pre-fix answer, kept as the discriminator)', () => {
    const parent = collapsedParentBag();
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );

    // A child bag with no associations copied onto it — a top-level stack, or
    // any caller that inherits nothing. This is what makes the case above an
    // assertion about the fix rather than about the harness.
    const child = childBagFrom(parent);
    const persisted = redactSecretsForState(CHILD_RESOLVED, child, CHILD_SOURCE) as Record<
      string,
      unknown
    >;
    expect(persisted['Value']).toBe(EXPR_B);
    expect(persisted['Description']).toBe(EXPR_B);
  });

  it('records nothing for a resource type that is not AWS::CloudFormation::Stack', () => {
    const parent = collapsedParentBag();
    recordNestedStackParameterExpressions(
      parent,
      'AWS::SSM::Parameter',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );
    const child = childBagFrom(parent);
    inheritNestedStackParameterAssociations(child, parent);

    const persisted = redactSecretsForState(CHILD_RESOLVED, child, CHILD_SOURCE) as Record<
      string,
      unknown
    >;
    expect(persisted['Value']).toBe(EXPR_B);
    expect(persisted['Description']).toBe(EXPR_B);
  });

  it('refuses a parameter that merely EMBEDS the secret, because no single expression describes it', () => {
    // The parent built this one with an `Fn::Sub`, so the resolved value is
    // `postgres://u:<secret>@host` and the source leaf is an intrinsic. There
    // is no whole token to hand down; the child leaf must fall to the value
    // scan, which rewrites only the substring.
    const EMBEDDED = `postgres://u:${SHARED}@host`;
    const parent = collapsedParentBag();
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: EMBEDDED } },
      { Parameters: { [PARAM_A]: { 'Fn::Sub': `postgres://u:${EXPR_A}@host` } } }
    );
    const child = childBagFrom(parent);
    inheritNestedStackParameterAssociations(child, parent);

    const persisted = redactSecretsForState(
      { Value: EMBEDDED },
      child,
      { Value: { Ref: PARAM_A } }
    ) as Record<string, unknown>;
    expect(persisted['Value']).toBe(`postgres://u:${EXPR_B}@host`);
  });

  it('never hands a TOKEN-SHAPED PLAINTEXT down as though it were its own expression (#1917)', () => {
    // Issue #1917's shape: a secret whose resolved VALUE is itself a
    // `{{resolve:...}}` string, so it cannot be told from a reference by
    // looking at it.
    //
    // MEASURED: this is an OUTCOME fence over the composed pipeline, NOT a
    // discriminator for `recordNestedStackParameterExpressions`'s
    // `expression === resolvedValue` refusal. A probe deleting that line leaves
    // THIS case green, because here the bag maps the token-shaped plaintext to a
    // DIFFERENT expression, so `redactByPath`'s `sourceIsSameGeneration` guard
    // returns `secrets.get(bag)` — which differs from the bag and the refusal
    // never fires. What DOES discriminate that refusal is a SELF-REFERENTIAL
    // secret, and it has its own case below. The two are complementary and both
    // are kept: this one fences the composition (a future change to either layer
    // must not start persisting the plaintext), that one fences the refusal.
    const TOKEN_SHAPED_PLAINTEXT = '{{resolve:secretsmanager:other/secret:SecretString:pw::}}';
    const parent: RecordedSecretValues = new Map([[TOKEN_SHAPED_PLAINTEXT, EXPR_B]]);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: TOKEN_SHAPED_PLAINTEXT } },
      { Parameters: { [PARAM_A]: TOKEN_SHAPED_PLAINTEXT } }
    );
    const child = childBagFrom(parent);
    inheritNestedStackParameterAssociations(child, parent);

    const persisted = redactSecretsForState(
      { Value: TOKEN_SHAPED_PLAINTEXT },
      child,
      { Value: { Ref: PARAM_A } }
    ) as Record<string, unknown>;
    // The value scan's answer — the reference it was resolved from — and NOT
    // the plaintext handed back as though it were an expression.
    expect(persisted['Value']).toBe(EXPR_B);
  });

  it('refuses a SELF-REFERENTIAL secret, so a PLAINTEXT is never handed back as its own expression (#1917)', () => {
    // THE DISCRIMINATOR for `recordNestedStackParameterExpressions`'s
    // `expression === resolvedValue` refusal. An earlier revision of this file
    // called that line an unreachable invariant and told the next reader not to
    // fence it; both claims were wrong, and the module's own rule (see
    // `plaintextIndexOf`'s note: "asserting something cannot be fenced
    // suppresses the attempt, so it needs the same evidence a fence does") is
    // what they violated.
    //
    // The reaching shape is a secret whose stored VALUE is byte-identical to
    // its own `{{resolve:...}}` text, so the pass records `SELF -> SELF`.
    // `redactByPath`'s `!sourceIsSameGeneration && isSingleDynamicReferenceToken(bag)`
    // arm then returns `secrets.get(bag) ?? bag`, which for this input IS the
    // bag — so the position pass certified nothing and the two halves coincide.
    //
    // ASSERTED ON `inheritedParameterExpression`, NOT on a redacted leaf, and
    // that is forced rather than chosen: both halves are the same string, so a
    // persisted leaf reads identically whether the association answered or the
    // value scan did. The observable cost is the junk entry itself — the store
    // would hand a caller a PLAINTEXT labelled as an expression.
    const SELF = '{{resolve:secretsmanager:self/ref:SecretString:token::}}';
    const parent: RecordedSecretValues = new Map([[SELF, SELF]]);
    recordResolvedPair(parent, SELF, SELF); // the pass resolved it (refusal 5, #3090)
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: SELF } },
      { Parameters: { [PARAM_A]: SELF } }
    );
    expect(inheritedParameterExpression(parent, PARAM_A, SELF)).toBeUndefined();
    // Scope control: the refusal is about the COINCIDENCE, not about the value
    // being token-shaped. The same token-shaped plaintext resolved from a
    // DIFFERENT expression still certifies normally.
    const other: RecordedSecretValues = new Map([[SELF, EXPR_A]]);
    recordResolvedPair(other, EXPR_A, SELF);
    recordNestedStackParameterExpressions(
      other,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: SELF } },
      { Parameters: { [PARAM_A]: EXPR_A } }
    );
    expect(inheritedParameterExpression(other, PARAM_A, SELF)).toBe(EXPR_A);
  });

  it('COPIES a poisoned parent entry, so a later write on the child cannot certify it (#2291)', () => {
    // THE DISCRIMINATOR for `inheritNestedStackParameterAssociations`'s
    // poison-copy branch. An earlier revision of this file asserted that no test
    // could tell copying from dropping, because both make the reader refuse.
    // That is true only while NOTHING ELSE writes the same key afterwards.
    // `recordCrossStackExpression` is such a writer, and reaching it is enough:
    //
    //   copied  -> the key is already the poison symbol, `storeAssociation`
    //              returns early, the reader refuses, the value scan answers
    //              `EXPR_B`;
    //   dropped -> the key is absent, the later write CERTIFIES `EXPR_C`.
    //
    // A THIRD expression is required for the same reason the conflict case
    // needs one: `EXPR_B` is the survivor, so writing it would be a confluence
    // point.
    //
    // No PRODUCTION path reaches this — the resolver builds a `sourceKey` only
    // from `Fn::ImportValue` / `Fn::GetStackOutput` / `Fn::GetAtt`, never from a
    // `Ref` — which is why the module comment says "no production path" rather
    // than "unfenceable".
    const parent = collapsedParentBag();
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: SHARED } },
      { Parameters: { [PARAM_A]: EXPR_C } }
    );

    const child = childBagFrom(parent);
    inheritNestedStackParameterAssociations(child, parent);
    // The later same-key write the copy has to survive.
    recordCrossStackExpression(child, crossStackSourceKey({ Ref: PARAM_A })!, EXPR_C, SHARED);

    const persisted = redactSecretsForState(CHILD_RESOLVED, child, CHILD_SOURCE) as Record<
      string,
      unknown
    >;
    expect(persisted['Value']).toBe(EXPR_B);
    expect(persisted['Value']).not.toBe(EXPR_C);
  });

  it('refuses a MISALIGNED bag: the association must be about the value being certified', () => {
    const parent = collapsedParentBag();
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );
    // A child bag holding a DIFFERENT resource's secret while the source leaf
    // still spells this parameter.
    const OTHER_PLAINTEXT = 'a-completely-different-2291-password';
    const OTHER_EXPR = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:other::}}`;
    const child: RecordedSecretValues = new Map([[OTHER_PLAINTEXT, OTHER_EXPR]]);
    inheritNestedStackParameterAssociations(child, parent);

    const persisted = redactSecretsForState(
      { Value: OTHER_PLAINTEXT },
      child,
      { Value: { Ref: PARAM_A } }
    ) as Record<string, unknown>;
    expect(persisted['Value']).toBe(OTHER_EXPR);
  });

  it('poisons a parameter name seen against two different expressions, and both leaves fall back', () => {
    const parent = collapsedParentBag();
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );
    // A second sighting of PARAM_A under a THIRD expression: one leaf identity
    // read two ways. Guessing between them would be the collapse this exists to
    // remove, one step over.
    //
    // A THIRD expression rather than `EXPR_B`, deliberately. `EXPR_B` is the
    // collapsed map's SURVIVOR, so poisoning and last-write-wins would both end
    // up answering `EXPR_B` and the case would be a confluence point that
    // passes under either. `EXPR_C` makes the two outcomes differ: poison
    // refuses and falls back to the value scan (`EXPR_B`), while an overwriting
    // store would certify `EXPR_C`. The second sighting is a RESOLUTION, so it
    // carries its pair (refusal 5, #3090) -- without one the recorder refuses
    // the sighting before it can poison, and the case measures nothing.
    recordResolvedPair(parent, EXPR_C, SHARED);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: SHARED } },
      { Parameters: { [PARAM_A]: EXPR_C } }
    );

    const child = childBagFrom(parent);
    inheritNestedStackParameterAssociations(child, parent);

    const persisted = redactSecretsForState(CHILD_RESOLVED, child, CHILD_SOURCE) as Record<
      string,
      unknown
    >;
    // PARAM_A refuses and degrades to the value scan — NOT to `EXPR_C`, which
    // is what an overwriting store would have certified.
    expect(persisted['Value']).toBe(EXPR_B);
    expect(persisted['Value']).not.toBe(EXPR_C);
    // ...while PARAM_B, never contradicted, still gets its own answer.
    expect(persisted['Description']).toBe(EXPR_B);
    expect(inheritedParameterExpression(parent, PARAM_A, SHARED)).toBeUndefined();
    expect(inheritedParameterExpression(parent, PARAM_B, SHARED)).toBe(EXPR_B);
  });

  it('does not let a GRANDCHILD parameter of the same name poison the child leaf it inherited', () => {
    // (The POISON-COPY branch has its own case below — an earlier revision of
    // this file claimed no test could reach it, which was false.)
    // A child engine that itself owns a nested-stack row records the
    // GRANDCHILD's parameter names against the CHILD's own bag — the same bag
    // that already carries the child's inherited `{Ref: ...}` associations. If
    // the two shared one table, a same-named grandchild parameter would poison
    // the child's entry and the child leaf would silently fall back.
    const parent = collapsedParentBag();
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );

    const child = childBagFrom(parent);
    inheritNestedStackParameterAssociations(child, parent);
    // The child's own grandchild row: SAME parameter name, DIFFERENT expression
    // -- a STRING source the child RESOLVED itself, so its pair is on the
    // child's table (refusal 5, #3090).
    recordResolvedPair(child, EXPR_B, SHARED);
    recordNestedStackParameterExpressions(
      child,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: SHARED } },
      { Parameters: { [PARAM_A]: EXPR_B } }
    );
    // POSITIVE CONTROL: the grandchild row WAS recorded on the child's table,
    // or the separation asserted below is vacuous (a future refusal of this
    // row would leave every later line green).
    expect(inheritedParameterExpression(child, PARAM_A, SHARED)).toBe(EXPR_B);

    const persisted = redactSecretsForState(CHILD_RESOLVED, child, CHILD_SOURCE) as Record<
      string,
      unknown
    >;
    expect(persisted['Value']).toBe(EXPR_A);
    expect(persisted['Description']).toBe(EXPR_B);
    // ...and the grandchild still gets ITS answer, one level down.
    const grandchild = childBagFrom(child);
    inheritNestedStackParameterAssociations(grandchild, child);
    const grandchildPersisted = redactSecretsForState(
      { Value: SHARED },
      grandchild,
      { Value: { Ref: PARAM_A } }
    ) as Record<string, unknown>;
    expect(grandchildPersisted['Value']).toBe(EXPR_B);
  });

  it('carries a THREE-LEVEL chain per leaf: a child whose bag holds inherited ENTRIES but no PAIRS still certifies its grandchild row spelled {Ref} (#3090 review)', () => {
    // The child engine's bag is filled by `recordInheritedParameterSecrets`
    // -- entries, never pairs -- and its own nested row spells the grandchild's
    // parameters as `{Ref: <own parameter>}`. Refusal 5 asks the pair table,
    // which this bag cannot answer; unscoped it refused every such row and the
    // grandchild collapsed onto the survivor (measured in review, all three
    // reviewers). It is scoped to STRING sources; the intrinsic source
    // positions through the association the parent's recorder already gated.
    // THE LOSER is asserted -- the survivor is a confluence point.
    const parent = collapsedParentBag();
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );
    const child = childBagFrom(parent); // entries only, no pairs -- the carry's shape
    inheritNestedStackParameterAssociations(child, parent);
    recordNestedStackParameterExpressions(
      child,
      'AWS::CloudFormation::Stack',
      { Parameters: { GA: SHARED, GB: SHARED } },
      { Parameters: { GA: { Ref: PARAM_A }, GB: { Ref: PARAM_B } } }
    );
    expect(inheritedParameterExpression(child, 'GA', SHARED)).toBe(EXPR_A);
    expect(inheritedParameterExpression(child, 'GB', SHARED)).toBe(EXPR_B);
    const grandchild = childBagFrom(child);
    inheritNestedStackParameterAssociations(grandchild, child);
    const persisted = redactSecretsForState(
      { U: SHARED, V: SHARED },
      grandchild,
      { U: { Ref: 'GA' }, V: { Ref: 'GB' } }
    ) as Record<string, unknown>;
    expect(persisted['U']).toBe(EXPR_A);
    expect(persisted['V']).toBe(EXPR_B);
  });

  it('child bag: refusal 4 alone refuses a STRING-sourced row whose expression the map ties to an INHERITED plaintext while its own pair is clean (#3093 review)', () => {
    // The one shape refusal 5 does not subsume (measured in review: deleting
    // refusal 4 changed this alone). A child engine's bag holds INHERITED
    // entries (no pairs) beside the child's OWN resolutions (with pairs):
    // `EXPR_A` was inherited against `INHERITED`, and the child then resolved
    // `EXPR_A` and `EXPR_B` itself to `OWN` (survivor `EXPR_B`). Its nested
    // row spells `A: EXPR_A` as a STRING. Refusal 5 passes `A` (the pair
    // `EXPR_A -> OWN` is clean); the map's index says `EXPR_A -> INHERITED`,
    // and refusal 4 is what refuses. Without it the grandchild's persist side
    // certifies `EXPR_A` while the diff side refuses -- the split refusal 4
    // was written to prevent.
    const INHERITED = 'inherited-plaintext-3093';
    const OWN = 'own-plaintext-3093';
    const child: RecordedSecretValues = new Map([
      [INHERITED, EXPR_A],
      [OWN, EXPR_B],
    ]);
    recordResolvedPair(child, EXPR_A, OWN);
    recordResolvedPair(child, EXPR_B, OWN);
    recordNestedStackParameterExpressions(
      child,
      'AWS::CloudFormation::Stack',
      { Parameters: { A: OWN, B: OWN } },
      { Parameters: { A: EXPR_A, B: EXPR_B } }
    );
    // NOT asserted on the child's own table: its reader's condition 3 reads
    // the same index refusal 4 does and answers `undefined` either way (a
    // confluence -- measured, the first draft of this case was green with
    // refusal 4 deleted). The split shows one level down: the GRANDCHILD's
    // bag is the carry's shape, holding only `OWN -> survivor`, so `EXPR_A`
    // is not a value there and condition 3 cannot see the inherited tie.
    // With refusal 4 the association was never written and the grandchild
    // takes the value scan (`EXPR_B`); without it the persist side certifies
    // `EXPR_A` while the diff side (the child's bag) refuses.
    const grandchild: RecordedSecretValues = new Map([[OWN, EXPR_B]]);
    inheritNestedStackParameterAssociations(grandchild, child);
    const persisted = redactSecretsForState({ U: OWN, V: OWN }, grandchild, {
      U: { Ref: 'A' },
      V: { Ref: 'B' },
    }) as Record<string, unknown>;
    expect(persisted['U']).toBe(EXPR_B);
    // POSITIVE CONTROL: the sibling with a clean index entry IS recorded and
    // reaches the grandchild by name.
    expect(inheritedParameterExpression(child, 'B', OWN)).toBe(EXPR_B);
    expect(persisted['V']).toBe(EXPR_B);
  });
});

describe('recordNestedStackParameterExpressions — the `rules` argument (#2291)', () => {
  /**
   * THE PROBE INPUT is an `ssm` reference whose SecureString verdict this
   * process has not pinned. A `secretsmanager` reference cannot see any
   * difference: `isKnownSecretExpression` answers true by SPELLING. The `ssm`
   * form — secret by the parameter's TYPE rather than by its text (issue
   * #1901) — is where `TEMPLATE_DERIVED_RULES` (`trustAnyExpression: false`,
   * consults the verdict store) and `STATE_DERIVED_RULES` (`true`: a JOURNAL
   * holds no PUBLIC reference, a plain `String` parameter being stored
   * RESOLVED) part ways in `redactByPath`'s whole-token arm.
   *
   * SINCE ISSUE #3090 THAT SPLIT IS NOT OBSERVABLE THROUGH THIS RECORDER on a
   * resolver-populated bag: refusal 5 asks the pair table under both rule
   * sets, and a resolved unpinned `ssm` reference has a pair (only its pin is
   * withheld), which positions it through `positionByEmbeddedSpan`'s empty
   * frame under either. The cases below fence THAT: paired certifies under
   * both, unpaired refuses under both. What the two constants still change
   * here is `sourceIsSameGeneration`, fenced by the replay call sites' file.
   *
   * That is still why the rollback replay passes `STATE_DERIVED_RULES` and
   * the deploy path keeps the `TEMPLATE_DERIVED_RULES` default.
   *
   * THIS FILE FENCES THE ARGUMENT'S SEMANTICS; the CALL SITES are fenced in
   * `rollback-executor-nested-stack-secret-scope.test.ts`. An earlier revision
   * of this note claimed the call sites could not be fenced at all, reasoning
   * that a live resolver necessarily PINS an `ssm` verdict. That argument covers
   * only `trustAnyExpression`; the two constants also differ on
   * `sourceIsSameGeneration`, which a TOKEN-SHAPED plaintext reaches — see that
   * file's own case. The rule this violated is the module's own, at
   * {@link plaintextIndexOf}: asserting something cannot be fenced needs the
   * same evidence a fence does.
   */
  const SSM_EXPR_A = '{{resolve:ssm:/app/db/pw}}';
  const SSM_EXPR_B = '{{resolve:ssm:/app/db/pw-alias}}';
  const SSM_SHARED = 'ssm-sh4red-2291-pl4intext';

  beforeEach(() => {
    // The verdict store is PROCESS-WIDE, so a sibling file that recorded this
    // spelling would make the TEMPLATE arm answer true and the case would pass
    // for the wrong reason.
    clearRecordedSecretExpressions();
  });

  function recordUnder(rules?: PathSourceRules, paired = true): RecordedSecretValues {
    const parent: RecordedSecretValues = new Map([[SSM_SHARED, SSM_EXPR_B]]);
    // An unpinned `ssm` resolution still records its PAIR (only the verdict
    // pin is withheld) -- the production shape. `paired = false` is the bag
    // NO resolver populated, kept as refusal 5's discriminator (#3090).
    if (paired) {
      recordResolvedPair(parent, SSM_EXPR_A, SSM_SHARED);
      recordResolvedPair(parent, SSM_EXPR_B, SSM_SHARED);
    }
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: SSM_SHARED, [PARAM_B]: SSM_SHARED } },
      { Parameters: { [PARAM_A]: SSM_EXPR_A, [PARAM_B]: SSM_EXPR_B } },
      ...(rules ? ([rules] as const) : ([] as const))
    );
    return parent;
  }

  it('certifies an unpinned ssm reference this pass RESOLVED under BOTH rulesets: the pair positions it through the span arm, and only the pin is withheld', () => {
    // Before issue #3090 the TEMPLATE default refused this shape and
    // STATE_DERIVED_RULES certified it -- on a bag WITHOUT pairs, which no
    // resolver produces. With the pair on record `positionByEmbeddedSpan`
    // writes the source through an EMPTY frame under either ruleset, so
    // `trustAnyExpression` alone no longer changes what the recorder writes
    // for a resolved reference; the constants still differ on
    // `sourceIsSameGeneration`, fenced by the replay call sites' own file.
    for (const rules of [undefined, STATE_DERIVED_RULES]) {
      const parent = recordUnder(rules);
      expect(inheritedParameterExpression(parent, PARAM_A, SSM_SHARED)).toBe(SSM_EXPR_A);
      expect(inheritedParameterExpression(parent, PARAM_B, SSM_SHARED)).toBe(SSM_EXPR_B);
    }
  });

  it('REFUSES it under BOTH rulesets when the pass recorded NO pair -- the bag no resolver populated (refusal 5, #3090)', () => {
    // The hole #3090 closes: STATE_DERIVED_RULES trusts any expression, so a
    // raw public `ssm` token a `cdkd import` record kept passed the position
    // pass with no pair and, when its plaintext coincided with a held secret,
    // was recorded as the child's reference. Refusal 5 asks the pair table,
    // which a public token is never in. Red without it under STATE rules;
    // the TEMPLATE arm refuses earlier (`isKnownSecretExpression`) and is
    // the scope control.
    for (const rules of [undefined, STATE_DERIVED_RULES]) {
      const parent = recordUnder(rules, false);
      expect(inheritedParameterExpression(parent, PARAM_A, SSM_SHARED)).toBeUndefined();
      // The SURVIVOR's own parameter is refused too: it has no pair either.
      expect(inheritedParameterExpression(parent, PARAM_B, SSM_SHARED)).toBeUndefined();
      // AND -- the load-bearing half -- it must not fall back to recording
      // the SURVIVOR under the LOSING parameter's name (the value-scan answer
      // before refusal 2b).
      expect(inheritedParameterExpression(parent, PARAM_A, SSM_SHARED)).not.toBe(SSM_EXPR_B);
    }
  });

  it("does NOT record a raw PUBLIC ssm token whose plaintext COINCIDES with a held secret, on the whole-token walk under STATE_DERIVED_RULES (#3090, the reported shape)", () => {
    // The parent op bag holds `prod` from a secretsmanager token, with its
    // pair; a journaled public `ssm` token also resolved to `prod` and has NO
    // pair. Refusal 1 passes on the secret's key, refusal 4 finds nothing to
    // disagree with; refusal 5 is what refuses. The child's `{Ref: Env}` leaf
    // then takes the value scan's answer (the secret's token -- the #2291
    // collapse, pre-existing), never the PUBLIC reference.
    const PUBLIC = '{{resolve:ssm:/public/env}}';
    const parent: RecordedSecretValues = new Map([['prod', EXPR_A]]);
    recordResolvedPair(parent, EXPR_A, 'prod');
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { Env: 'prod', Pw: 'prod' } },
      { Parameters: { Env: PUBLIC, Pw: EXPR_A } },
      STATE_DERIVED_RULES
    );
    expect(inheritedParameterExpression(parent, 'Env', 'prod')).toBeUndefined();
    expect(inheritedParameterExpression(parent, 'Pw', 'prod')).toBe(EXPR_A);
    const child: RecordedSecretValues = new Map([['prod', EXPR_A]]);
    inheritNestedStackParameterAssociations(child, parent);
    const persisted = redactSecretsForState(
      { Value: 'prod', Pw: 'prod' },
      child,
      { Value: { Ref: 'Env' }, Pw: { Ref: 'Pw' } }
    ) as Record<string, unknown>;
    expect(persisted['Value']).not.toBe(PUBLIC);
    expect(persisted['Value']).toBe(EXPR_A);
    expect(persisted['Pw']).toBe(EXPR_A);
  });

  it('the two constants AGREE on a secretsmanager reference, which is why the ssm form is the probe', () => {
    // Scope control: without this, the two cases above could be read as a
    // blanket difference rather than the narrow one they are.
    const bySpelling = (rules?: PathSourceRules): string | unknown[] | undefined => {
      const parent = collapsedParentBag();
      recordNestedStackParameterExpressions(
        parent,
        'AWS::CloudFormation::Stack',
        PARENT_RESOLVED,
        PARENT_SOURCE,
        ...(rules ? ([rules] as const) : ([] as const))
      );
      return inheritedParameterExpression(parent, PARAM_A, SHARED);
    };
    expect(bySpelling()).toBe(EXPR_A);
    expect(bySpelling(STATE_DERIVED_RULES)).toBe(EXPR_A);
  });
});

describe('inheritedParameterExpression — the DIFF side (#2291)', () => {
  it('answers per parameter, so the desired side matches what the persist side wrote', () => {
    const parent = collapsedParentBag();
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );
    expect(inheritedParameterExpression(parent, PARAM_A, SHARED)).toBe(EXPR_A);
    expect(inheritedParameterExpression(parent, PARAM_B, SHARED)).toBe(EXPR_B);
  });

  it('refuses an unknown parameter, a non-string value and a value the association is not about', () => {
    const parent = collapsedParentBag();
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      PARENT_RESOLVED,
      PARENT_SOURCE
    );
    expect(inheritedParameterExpression(parent, 'NoSuchParam', SHARED)).toBeUndefined();
    expect(inheritedParameterExpression(parent, PARAM_A, 42)).toBeUndefined();
    expect(inheritedParameterExpression(parent, PARAM_A, '')).toBeUndefined();
    expect(inheritedParameterExpression(parent, PARAM_A, 'some-other-value')).toBeUndefined();
    // A pass that recorded nothing — `cdkd state refresh-observed`, whose bag is
    // empty by construction — finds no table at all.
    expect(inheritedParameterExpression(new Map(), PARAM_A, SHARED)).toBeUndefined();
  });
});

/**
 * THE SUB-FLOOR CARRY (issue [#2745](https://github.com/go-to-k/cdkd/issues/2745),
 * its nested-stack site). A parent `Parameters` entry spelled as a LITERAL
 * frame around one token (`Pin: 'port:{{resolve:...:pin::}}'`) resolves to
 * `port:q7`. That value is not a key of the parent's map, and its middle sits
 * below `MIN_NEEDLE_LENGTH`, so the child's carry missed it both ways and the
 * child persisted `port:q7`. The recorder now positions a MARKED copy of the
 * resolved parameters and records `'port:q7' -> 'port:{{resolve:...}}'` as a
 * whole-value entry of the parent's own bag; every consumer then reads it
 * through the floorless whole-value arms that already exist.
 *
 * EVERY case drives the real recorder against a real parent source; the
 * positive cases then read the result back through the real child-side walk.
 * The child's bag is built by `childBagFor`, a MIRROR of
 * `inheritedSecretsCarriedBy`'s two arms (whole value at any length, substring
 * at or above the floor) over the leaves the child resolves, plus the
 * inherited associations — so it holds the framed entry and NOT the bare
 * middle, exactly as `recordInheritedParameterSecrets` leaves it for a
 * `{Ref: <Param>}` leaf. Mirrored, not fenced: the real carry is driven by
 * `intrinsic-resolver-inherited-parameter-secrets.test.ts`.
 */
describe('recordNestedStackParameterExpressions — the SUB-FLOOR CARRY (#2745)', () => {
  const PIN = 'q7';
  const PIN_TOKEN_A = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin::}}`;
  const PIN_TOKEN_B = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin:AWSCURRENT:}}`;
  const frame = (token: string): string => `port:${token}`;
  const NESTED = 'AWS::CloudFormation::Stack';

  /**
   * The parent's map after the given references resolved, IN ORDER: the map
   * is keyed by plaintext so the last one wins the slot, while the pair table
   * beside it keeps every `token -> plaintext` — the shape the resolver's
   * `secrets.set` + `recordResolvedPair` pair produces.
   */
  function parentResolved(
    ...pairs: ReadonlyArray<readonly [token: string, plaintext: string]>
  ): RecordedSecretValues {
    const secrets: RecordedSecretValues = new Map();
    for (const [token, plaintext] of pairs) {
      secrets.set(plaintext, token);
      recordResolvedPair(secrets, token, plaintext);
    }
    return secrets;
  }

  /** The carry's two arms, mirrored, over the string leaves the child resolved. */
  function childBagFor(parent: RecordedSecretValues, leaves: Record<string, unknown>): RecordedSecretValues {
    const child: RecordedSecretValues = new Map();
    for (const value of Object.values(leaves)) {
      if (typeof value !== 'string') continue;
      for (const [plaintext, expression] of parent) {
        if (value === plaintext || (plaintext.length >= MIN_NEEDLE_LENGTH && value.includes(plaintext))) {
          child.set(plaintext, expression);
        }
      }
    }
    inheritNestedStackParameterAssociations(child, parent);
    return child;
  }

  function childPersist(
    parent: RecordedSecretValues,
    leaves: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> {
    return redactSecretsForState(leaves, childBagFor(parent, leaves), source) as Record<string, unknown>;
  }

  beforeEach(() => clearRecordedSecretExpressions());

  it('records the framed value as a WHOLE-VALUE entry of the parent bag, which the child carries and persists floorless', () => {
    const parent = parentResolved([PIN_TOKEN_A, PIN]);
    // Premises, asserted rather than assumed: the middle is below the floor
    // and the value scan is silent on the framed value — the exact reason the
    // pre-fix child persisted it.
    expect(PIN.length).toBeLessThan(MIN_NEEDLE_LENGTH);
    expect(redactSecretsForState(frame(PIN), parent)).toBe(frame(PIN));

    const resolved = { Parameters: { Pin: frame(PIN), Plain: 'hello' } };
    recordNestedStackParameterExpressions(parent, NESTED, resolved, {
      Parameters: { Pin: frame(PIN_TOKEN_A), Plain: 'hello' },
    });

    expect(parent.get(frame(PIN))).toBe(frame(PIN_TOKEN_A));
    expect(parent.size).toBe(2);
    // The value is not a token, and the recorder says so by recording no pin
    // for it: the entry lives in the map alone. (A PAIR for it would be inert
    // -- nothing reads the pair table by a non-token expression -- and the
    // table has no reader this file can reach, so "no pair" is stated on the
    // docstring rather than pinned here.)
    expect(isRecordedSecretExpression(frame(PIN_TOKEN_A))).toBe(false);
    // The COPY is what carries the mark; the caller's own objects never do
    // (whether they get marked is decided at the caller).
    expect(isSameGenerationBag(resolved)).toBe(false);
    expect(isSameGenerationBag(resolved.Parameters)).toBe(false);

    // The child: whole-value carry, whole-value persist, no floor in either.
    const persisted = childPersist(
      parent,
      { Value: frame(PIN), Desc: 'hello' },
      { Value: { Ref: 'Pin' }, Desc: { Ref: 'Plain' } }
    );
    expect(persisted['Value']).toBe(frame(PIN_TOKEN_A));
    expect(persisted['Desc']).toBe('hello');
    // ...and the framed value is now a 7-character SUBSTRING needle in the
    // child bag, so an embedding child leaf is spliced (residual (b), the
    // #2087 direction, bounded to bags that consumed the parameter).
    const embedding = childPersist(
      parent,
      { Dsn: `x-${frame(PIN)}-y` },
      { Dsn: { 'Fn::Sub': 'x-${Pin}-y' } }
    );
    expect(embedding['Dsn']).toBe(`x-${frame(PIN_TOKEN_A)}-y`);
  });

  // The INVARIANT across the whole sub-floor range, and the control at the
  // floor: there the child's substring arm already carries the value, so the
  // recorder must write NO extra entry — a version that recorded every framed
  // parameter would double every map (`port:abcd` beside `abcd`) for no reader.
  // Both the range AND the boundary are spelled out rather than derived from
  // the floor: a floor lowered to 3 reds the three-character case, a floor
  // raised to 5 reds the four-character control, where a derived control
  // would simply move with it (the intrinsic-frame file pins its range the
  // same way). The premise line is what names the floor this pins.
  for (const middle of ['z', 'zz', 'zzz', 'zzzz'] as const) {
    const below = middle.length <= 3;
    it(`for a ${middle.length}-character middle: ${below ? 'entry written' : 'NO entry, the substring arm carries it'}`, () => {
      expect(middle.length < MIN_NEEDLE_LENGTH).toBe(below);
      const parent = parentResolved([PIN_TOKEN_A, middle]);
      recordNestedStackParameterExpressions(
        parent,
        NESTED,
        { Parameters: { Pin: frame(middle) } },
        { Parameters: { Pin: frame(PIN_TOKEN_A) } }
      );
      expect(parent.has(frame(middle))).toBe(below);
      expect(parent.size).toBe(below ? 2 : 1);
      // Either way the child persists the frame — which is what makes the
      // at-floor control a control rather than a gap.
      const persisted = childPersist(parent, { Value: frame(middle) }, { Value: { Ref: 'Pin' } });
      expect(persisted['Value']).toBe(frame(PIN_TOKEN_A));
    });
  }

  it("records ONLY the survivor's frame as the ENTRY when two framed parameters share one middle, and each leaf's own frame as its ASSOCIATION, so both records stay per leaf (#3079)", () => {
    // `PIN_TOKEN_B` resolved last, so it holds the `q7` slot. The SOURCE order
    // is the reverse on purpose: a recorder that skipped condition (iii) would
    // write the LAST framed parameter's frame (`PIN_TOKEN_A`'s), the parent's
    // `Pin1` leaf would then fail the span arm's bound against the map's
    // survivor and persist `PIN_TOKEN_A`'s frame — the wrong reference.
    const parent = parentResolved([PIN_TOKEN_A, PIN], [PIN_TOKEN_B, PIN]);
    expect(parent.get(PIN)).toBe(PIN_TOKEN_B);
    const resolved = { Parameters: { Pin1: frame(PIN), Pin2: frame(PIN) } };
    const source = { Parameters: { Pin1: frame(PIN_TOKEN_B), Pin2: frame(PIN_TOKEN_A) } };

    recordNestedStackParameterExpressions(parent, NESTED, resolved, source);

    // The ENTRY: the survivor's frame, and only that (condition (iii)'s first
    // arm -- the value is spelled twice, so its second arm cannot fire).
    expect(parent.get(frame(PIN))).toBe(frame(PIN_TOKEN_B));
    expect([...parent.values()]).not.toContain(frame(PIN_TOKEN_A));
    // The ASSOCIATIONS: per name, the loser's own frame included -- the
    // diff-side reader answers with them directly.
    expect(inheritedParameterExpression(parent, 'Pin1', frame(PIN))).toBe(frame(PIN_TOKEN_B));
    expect(inheritedParameterExpression(parent, 'Pin2', frame(PIN))).toBe(frame(PIN_TOKEN_A));

    // The PARENT's own record of the row, positioned the way `propertiesToRecord`
    // positions it (a marked bag): each leaf keeps ITS OWN token.
    const parentRecord = redactSecretsForState(
      markSameGenerationBag(structuredClone(resolved)),
      parent,
      source
    ) as { Parameters: Record<string, unknown> };
    expect(parentRecord.Parameters['Pin1']).toBe(frame(PIN_TOKEN_B));
    expect(parentRecord.Parameters['Pin2']).toBe(frame(PIN_TOKEN_A));

    // The CHILD (issue #3079, the residual (a) half #3070 left): the loser's
    // `{Ref: Pin2}` leaf persists ITS OWN frame, through the association the
    // child inherits and reads by name in `positionByCrossStackSource`. Both
    // leaves in ONE bag, the discriminating shape (the file header says why).
    const persisted = childPersist(
      parent,
      { Value: frame(PIN), Description: frame(PIN) },
      { Value: { Ref: 'Pin1' }, Description: { Ref: 'Pin2' } }
    );
    expect(persisted['Value']).toBe(frame(PIN_TOKEN_B));
    expect(persisted['Description']).toBe(frame(PIN_TOKEN_A));

    // The pre-fix answer, kept as the discriminator: with the associations NOT
    // inherited the child has only the entry, and both leaves take the
    // survivor's frame -- the wrong reference `cdkd rollback` / `drift
    // --revert` would re-resolve into the loser's live property.
    const child: RecordedSecretValues = new Map([[frame(PIN), parent.get(frame(PIN))!]]);
    const collapsed = redactSecretsForState(
      { Value: frame(PIN), Description: frame(PIN) },
      child,
      { Value: { Ref: 'Pin1' }, Description: { Ref: 'Pin2' } }
    ) as Record<string, unknown>;
    expect(collapsed['Description']).toBe(frame(PIN_TOKEN_B));
  });

  it("with DIFFERENT frames over one middle, records BOTH frames as entries -- each value is spelled once, so (iii)'s second arm fires for the loser -- and the child persists each leaf's own frame (#3079)", () => {
    const parent = parentResolved([PIN_TOKEN_A, PIN], [PIN_TOKEN_B, PIN]);
    expect(parent.get(PIN)).toBe(PIN_TOKEN_B);
    const resolved = { Parameters: { Pin1: `port:${PIN}`, Pin2: `url:${PIN}` } };
    const source = { Parameters: { Pin1: `port:${PIN_TOKEN_A}`, Pin2: `url:${PIN_TOKEN_B}` } };

    recordNestedStackParameterExpressions(parent, NESTED, resolved, source);

    expect(parent.get(`url:${PIN}`)).toBe(`url:${PIN_TOKEN_B}`);
    // The LOSER's entry: `port:q7` is spelled by `Pin1` alone, so the entry
    // names its frame although `PIN_TOKEN_A` lost the `q7` slot. Before
    // #3079 this key was refused and the child persisted `port:q7`.
    expect(parent.get(`port:${PIN}`)).toBe(`port:${PIN_TOKEN_A}`);
    // The parent's own record: still per leaf. `Pin1` reaches the entry by
    // the OTHER route -- the span arm's bound (`port:` + the survivor) fails,
    // and the value scan's whole-value arm writes the entry, which is the
    // leaf's own frame.
    const parentRecord = redactSecretsForState(
      markSameGenerationBag(structuredClone(resolved)),
      parent,
      source
    ) as { Parameters: Record<string, unknown> };
    expect(parentRecord.Parameters['Pin1']).toBe(`port:${PIN_TOKEN_A}`);
    expect(parentRecord.Parameters['Pin2']).toBe(`url:${PIN_TOKEN_B}`);
    // The child: each leaf its own frame, no plaintext left.
    const persisted = childPersist(
      parent,
      { Value: `port:${PIN}`, Description: `url:${PIN}` },
      { Value: { Ref: 'Pin1' }, Description: { Ref: 'Pin2' } }
    );
    expect(persisted['Value']).toBe(`port:${PIN_TOKEN_A}`);
    expect(persisted['Description']).toBe(`url:${PIN_TOKEN_B}`);
  });

  it("records a LOSER's entry when every spelling of its value carries the same token, and refuses it the moment a same-frame sibling carries another (#3079, (iii)'s second arm)", () => {
    // Three leaves, one middle: `port:` around A (the loser) TWICE and `url:`
    // around B (the survivor). Every `port:q7` spelling carries A, so the
    // entry is safe: the parent's two `port:` leaves both fail the span arm's
    // bound (`port:` + B) and take the entry from the value scan, which IS
    // their frame. A second arm keyed on "spelled once" refuses this row and
    // leaves both child leaves in PLAINTEXT for no reason -- the shape that
    // separates the token-set arm from a spelling count.
    const parent = parentResolved([PIN_TOKEN_A, PIN], [PIN_TOKEN_B, PIN]);
    const resolved = {
      Parameters: { Pin1: `port:${PIN}`, Pin2: `port:${PIN}`, Pin3: `url:${PIN}` },
    };
    const source = {
      Parameters: {
        Pin1: `port:${PIN_TOKEN_A}`,
        Pin2: `port:${PIN_TOKEN_A}`,
        Pin3: `url:${PIN_TOKEN_B}`,
      },
    };
    recordNestedStackParameterExpressions(parent, NESTED, resolved, source);
    expect(parent.get(`port:${PIN}`)).toBe(`port:${PIN_TOKEN_A}`);
    expect(parent.get(`url:${PIN}`)).toBe(`url:${PIN_TOKEN_B}`);
    const parentRecord = redactSecretsForState(
      markSameGenerationBag(structuredClone(resolved)),
      parent,
      source
    ) as { Parameters: Record<string, unknown> };
    expect(parentRecord.Parameters['Pin1']).toBe(`port:${PIN_TOKEN_A}`);
    expect(parentRecord.Parameters['Pin2']).toBe(`port:${PIN_TOKEN_A}`);
    expect(parentRecord.Parameters['Pin3']).toBe(`url:${PIN_TOKEN_B}`);
    const persisted = childPersist(
      parent,
      { Value: `port:${PIN}`, Description: `port:${PIN}`, Url: `url:${PIN}` },
      { Value: { Ref: 'Pin1' }, Description: { Ref: 'Pin2' }, Url: { Ref: 'Pin3' } }
    );
    expect(persisted['Value']).toBe(`port:${PIN_TOKEN_A}`);
    expect(persisted['Description']).toBe(`port:${PIN_TOKEN_A}`);
    expect(persisted['Url']).toBe(`url:${PIN_TOKEN_B}`);
    // The refusing half of this arm -- the same frame under TWO tokens, the
    // loser iterated last -- is the survivor-only case above.
  });

  it('positions ONE child resource that consumes BOTH parameters per leaf, through the associations rather than the plaintext-keyed slot (#3079)', () => {
    // The child bag is keyed by plaintext, so a resource whose two leaves
    // both resolve to `port:q7` holds ONE slot for it -- whichever `{Ref}`
    // resolved last. The value scan would write that slot's frame on both
    // leaves; the association gives each its own.
    const parent = parentResolved([PIN_TOKEN_A, PIN], [PIN_TOKEN_B, PIN]);
    const resolved = { Parameters: { Pin1: frame(PIN), Pin2: frame(PIN) } };
    const source = { Parameters: { Pin1: frame(PIN_TOKEN_B), Pin2: frame(PIN_TOKEN_A) } };
    recordNestedStackParameterExpressions(parent, NESTED, resolved, source);

    for (const slot of [frame(PIN_TOKEN_A), frame(PIN_TOKEN_B)]) {
      const child: RecordedSecretValues = new Map([[frame(PIN), slot]]);
      inheritNestedStackParameterAssociations(child, parent);
      const persisted = redactSecretsForState(
        { Value: frame(PIN), Description: frame(PIN) },
        child,
        { Value: { Ref: 'Pin1' }, Description: { Ref: 'Pin2' } }
      ) as Record<string, unknown>;
      expect(persisted['Value']).toBe(frame(PIN_TOKEN_B));
      expect(persisted['Description']).toBe(frame(PIN_TOKEN_A));
    }
  });

  it('refuses a value the row spells through a DIFFERENT frame or CONTAINS elsewhere, so the parent record keeps each leaf its own token (conditions (iv) and (v))', () => {
    // `port:` + `q7` and `port` + `:q7` are both `port:q7`. Each passes
    // (i)-(iii) on its own; a recorder without (iv) writes whichever came
    // last, and the parent's other leaf then fails the span arm's bound
    // against that entry and persists the sibling's frame.
    const COLON_TOKEN = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:colonpin::}}`;
    const parent = parentResolved([PIN_TOKEN_A, PIN], [COLON_TOKEN, `:${PIN}`]);
    const resolved = { Parameters: { Pin1: `port:${PIN}`, Pin2: `port:${PIN}` } };
    const source = { Parameters: { Pin1: `port:${PIN_TOKEN_A}`, Pin2: `port${COLON_TOKEN}` } };

    recordNestedStackParameterExpressions(parent, NESTED, resolved, source);

    expect(parent.has(`port:${PIN}`)).toBe(false);
    expect(parent.size).toBe(2);
    const parentRecord = redactSecretsForState(
      markSameGenerationBag(structuredClone(resolved)),
      parent,
      source
    ) as { Parameters: Record<string, unknown> };
    expect(parentRecord.Parameters['Pin1']).toBe(`port:${PIN_TOKEN_A}`);
    expect(parentRecord.Parameters['Pin2']).toBe(`port${COLON_TOKEN}`);

    // The spelling (iii) REFUSED still counts: with a third token C winning
    // the `q7` slot, `port:` + A is refused by (iii) and would not reach a
    // conflict check placed after it -- yet the entry `port` + B would write
    // answers for A's leaf on the parent's record all the same.
    const C_TOKEN = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pin:AWSPREVIOUS:}}`;
    const three = parentResolved([PIN_TOKEN_A, PIN], [COLON_TOKEN, `:${PIN}`], [C_TOKEN, PIN]);
    const threeResolved = { Parameters: { Pin1: `port:${PIN}`, Pin2: `port:${PIN}`, Pin3: PIN } };
    const threeSource = {
      Parameters: { Pin1: `port:${PIN_TOKEN_A}`, Pin2: `port${COLON_TOKEN}`, Pin3: C_TOKEN },
    };
    recordNestedStackParameterExpressions(three, NESTED, threeResolved, threeSource);
    expect(three.has(`port:${PIN}`)).toBe(false);
    const threeRecord = redactSecretsForState(
      markSameGenerationBag(structuredClone(threeResolved)),
      three,
      threeSource
    ) as { Parameters: Record<string, unknown> };
    expect(threeRecord.Parameters['Pin1']).toBe(`port:${PIN_TOKEN_A}`);
    expect(threeRecord.Parameters['Pin2']).toBe(`port${COLON_TOKEN}`);
    expect(threeRecord.Parameters['Pin3']).toBe(C_TOKEN);

    // An OBJECT spelling of the same value blocks the entry too, and so does a
    // PLAIN LITERAL equal to it: neither is a single-span literal frame, and
    // the entry would turn the plain literal's own record into an expression
    // it never referenced.
    for (const sibling of [{ 'Fn::Sub': `port:${PIN_TOKEN_A}` }, `port:${PIN}`]) {
      const mixed = parentResolved([PIN_TOKEN_A, PIN]);
      recordNestedStackParameterExpressions(
        mixed,
        NESTED,
        { Parameters: { Pin1: `port:${PIN}`, Pin2: `port:${PIN}` } },
        { Parameters: { Pin1: `port:${PIN_TOKEN_A}`, Pin2: sibling } }
      );
      expect(mixed.has(`port:${PIN}`)).toBe(false);
    }

    // A sibling leaf that merely CONTAINS the value blocks it too (condition
    // (v)): the entry would be a substring needle in this row's bag, so `Two`
    // -- `x-port` + `:q7` from a third token -- would be spliced with `One`'s
    // frame on the parent's record, and a plain literal likewise. Read over
    // the whole row, `TemplateURL` included.
    for (const two of [{ value: `x-port:${PIN}`, source: `x-port${COLON_TOKEN}` }, { value: `literal-port:${PIN}-end`, source: `literal-port:${PIN}-end` }]) {
      const row = parentResolved([PIN_TOKEN_A, PIN], [COLON_TOKEN, `:${PIN}`]);
      const rowResolved = { Parameters: { One: `port:${PIN}`, Two: two.value } };
      const rowSource = { Parameters: { One: `port:${PIN_TOKEN_A}`, Two: two.source } };
      recordNestedStackParameterExpressions(row, NESTED, rowResolved, rowSource);
      expect(row.has(`port:${PIN}`)).toBe(false);
      const rowRecord = redactSecretsForState(
        markSameGenerationBag(structuredClone(rowResolved)),
        row,
        rowSource
      ) as { Parameters: Record<string, unknown> };
      expect(rowRecord.Parameters['One']).toBe(`port:${PIN_TOKEN_A}`);
      expect(rowRecord.Parameters['Two']).toBe(two.source);
    }
    const url = parentResolved([PIN_TOKEN_A, PIN]);
    recordNestedStackParameterExpressions(
      url,
      NESTED,
      { Parameters: { One: `port:${PIN}` }, TemplateURL: `https://bucket/port:${PIN}/child.json` },
      { Parameters: { One: `port:${PIN_TOKEN_A}` }, TemplateURL: `https://bucket/port:${PIN}/child.json` }
    );
    expect(url.has(`port:${PIN}`)).toBe(false);
    // The frame's IDENTITY is prefix AND suffix, each on its own side: two
    // spellings whose prefix + suffix concatenate to the same text (`a` + X +
    // `bb` beside `ab` + Y + `b`, both `abqbb` over the sub-floor middles `bq`
    // and `qb`) are different frames, and so are two sharing a prefix (`p` +
    // X + `x` beside `p` + Y, both `pq7x` over `q7` and `q7x`). A key that
    // dropped the length split, or the suffix, would merge each pair into one
    // frame and record an entry the other leaf then answers against.
    const BQ_TOKEN = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:bq::}}`;
    const QB_TOKEN = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:qb::}}`;
    const Q7X_TOKEN = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:q7x::}}`;
    for (const shape of [
      { value: 'abqbb', pairs: [[BQ_TOKEN, 'bq'], [QB_TOKEN, 'qb']] as const, sources: [`a${BQ_TOKEN}bb`, `ab${QB_TOKEN}b`] },
      { value: `p${PIN}x`, pairs: [[PIN_TOKEN_A, PIN], [Q7X_TOKEN, `${PIN}x`]] as const, sources: [`p${PIN_TOKEN_A}x`, `p${Q7X_TOKEN}`] },
    ]) {
      const bag = parentResolved(...shape.pairs);
      const shapeResolved = { Parameters: { Pin1: shape.value, Pin2: shape.value } };
      const shapeSource = { Parameters: { Pin1: shape.sources[0], Pin2: shape.sources[1] } };
      recordNestedStackParameterExpressions(bag, NESTED, shapeResolved, shapeSource);
      expect(bag.has(shape.value)).toBe(false);
      const shapeRecord = redactSecretsForState(
        markSameGenerationBag(structuredClone(shapeResolved)),
        bag,
        shapeSource
      ) as { Parameters: Record<string, unknown> };
      expect(shapeRecord.Parameters['Pin1']).toBe(shape.sources[0]);
      expect(shapeRecord.Parameters['Pin2']).toBe(shape.sources[1]);
    }

    // A same-frame sibling WITHOUT this pass's pair blocks it too: a PUBLIC
    // `ssm` reference in the same `port:` frame resolving to the same value
    // (a String parameter holding `q7`) is kept resolved on the parent's
    // record, and the entry would rewrite it to the SECRET sibling's
    // expression. (iv)'s frame identity therefore requires pair evidence.
    const PUBLIC_TOKEN = '{{resolve:ssm:public-pin}}';
    const withPublic = parentResolved([PIN_TOKEN_A, PIN]);
    const publicResolved = { Parameters: { One: `port:${PIN}`, Pub: `port:${PIN}` } };
    const publicSource = { Parameters: { One: `port:${PIN_TOKEN_A}`, Pub: `port:${PUBLIC_TOKEN}` } };
    recordNestedStackParameterExpressions(withPublic, NESTED, publicResolved, publicSource);
    expect(withPublic.has(`port:${PIN}`)).toBe(false);
    const publicRecord = redactSecretsForState(
      markSameGenerationBag(structuredClone(publicResolved)),
      withPublic,
      publicSource
    ) as { Parameters: Record<string, unknown> };
    expect(publicRecord.Parameters['One']).toBe(`port:${PIN_TOKEN_A}`);
    expect(publicRecord.Parameters['Pub']).toBe(`port:${PIN}`);

    // A LIST-valued sibling parameter (an array by the time this runs, which
    // `extractParameters` joins back for the wire) has no frame either, so its
    // leaves count equal or containing.
    for (const list of [[`literal-port:${PIN}-end`], [`port:${PIN}`]]) {
      const withList = parentResolved([PIN_TOKEN_A, PIN]);
      recordNestedStackParameterExpressions(
        withList,
        NESTED,
        { Parameters: { One: `port:${PIN}`, Public: list } },
        { Parameters: { One: `port:${PIN_TOKEN_A}`, Public: list } }
      );
      expect(withList.has(`port:${PIN}`)).toBe(false);
    }
    // ...and outside `Parameters` EQUALITY counts too: a `TemplateURL` equal to
    // the value has no frame of its own, escapes (iv), and the entry would
    // rewrite it whole to the parameter's expression.
    const equalUrl = parentResolved([PIN_TOKEN_A, PIN]);
    const urlValue = `https://bucket/${PIN}.json`;
    const urlResolved = { Parameters: { Tpl: urlValue }, TemplateURL: urlValue };
    const urlSource = { Parameters: { Tpl: `https://bucket/${PIN_TOKEN_A}.json` }, TemplateURL: urlValue };
    recordNestedStackParameterExpressions(equalUrl, NESTED, urlResolved, urlSource);
    expect(equalUrl.has(urlValue)).toBe(false);
    const urlRecord = redactSecretsForState(
      markSameGenerationBag(structuredClone(urlResolved)),
      equalUrl,
      urlSource
    ) as { Parameters: Record<string, unknown>; TemplateURL: unknown };
    expect(urlRecord.Parameters['Tpl']).toBe(`https://bucket/${PIN_TOKEN_A}.json`);
    expect(urlRecord.TemplateURL).toBe(urlValue);

    // The SAME frame twice is one spelling, not a conflict.
    const twice = parentResolved([PIN_TOKEN_A, PIN]);
    recordNestedStackParameterExpressions(
      twice,
      NESTED,
      { Parameters: { Pin1: `port:${PIN}`, Pin2: `port:${PIN}` } },
      { Parameters: { Pin1: `port:${PIN_TOKEN_A}`, Pin2: `port:${PIN_TOKEN_A}` } }
    );
    expect(twice.get(`port:${PIN}`)).toBe(`port:${PIN_TOKEN_A}`);
  });

  it('is read by the child through the WHOLE-VALUE arm alone, shown on a framed value shorter than the floor in total', () => {
    // `port:q7` is 7 characters, so the child's SUBSTRING arm would carry it
    // too and the positive cases cannot tell the two arms apart. A frame whose
    // WHOLE length is below the floor (`p` + `q7`) leaves only the whole-value
    // arm, which is the one the carry rests on.
    const tiny = `p${PIN}`;
    expect(tiny.length).toBeLessThan(MIN_NEEDLE_LENGTH);
    const parent = parentResolved([PIN_TOKEN_A, PIN]);
    recordNestedStackParameterExpressions(
      parent,
      NESTED,
      { Parameters: { Pin: tiny } },
      { Parameters: { Pin: `p${PIN_TOKEN_A}` } }
    );
    expect(parent.get(tiny)).toBe(`p${PIN_TOKEN_A}`);
    const persisted = childPersist(parent, { Value: tiny }, { Value: { Ref: 'Pin' } });
    expect(persisted['Value']).toBe(`p${PIN_TOKEN_A}`);
    // ...and an EMBEDDING child leaf is left alone at this length: no
    // substring needle exists for it.
    const embedding = childPersist(parent, { Dsn: `x-${tiny}-y` }, { Dsn: { 'Fn::Sub': 'x-${Pin}-y' } });
    expect(embedding['Dsn']).toBe(`x-${tiny}-y`);

    // For the same reason (v) lets a sibling merely CONTAINING a tiny frame
    // through -- nothing can splice it -- while a sibling EQUAL to it outside
    // `Parameters` still refuses, the whole-value arm having no floor.
    const beside = parentResolved([PIN_TOKEN_A, PIN]);
    recordNestedStackParameterExpressions(
      beside,
      NESTED,
      { Parameters: { Pin: tiny, Other: `x-${tiny}-y` }, TemplateURL: `https://bucket/${tiny}/child.json` },
      { Parameters: { Pin: `p${PIN_TOKEN_A}`, Other: `x-${tiny}-y` }, TemplateURL: `https://bucket/${tiny}/child.json` }
    );
    expect(beside.get(tiny)).toBe(`p${PIN_TOKEN_A}`);
    const equal = parentResolved([PIN_TOKEN_A, PIN]);
    recordNestedStackParameterExpressions(
      equal,
      NESTED,
      { Parameters: { Pin: tiny }, TemplateURL: tiny },
      { Parameters: { Pin: `p${PIN_TOKEN_A}` }, TemplateURL: tiny }
    );
    expect(equal.has(tiny)).toBe(false);
    // ...at any length inside a LIST-valued sibling as well (an array element
    // equal to the value is rewritten whole), while an element merely
    // containing a tiny frame is not: the same split, one container in.
    for (const [list, carried] of [
      [[tiny], false],
      [[`x-${tiny}-y`], true],
    ] as const) {
      const withList = parentResolved([PIN_TOKEN_A, PIN]);
      recordNestedStackParameterExpressions(
        withList,
        NESTED,
        { Parameters: { Pin: tiny, Public: [...list] } },
        { Parameters: { Pin: `p${PIN_TOKEN_A}`, Public: [...list] } }
      );
      expect(withList.get(tiny)).toBe(carried ? `p${PIN_TOKEN_A}` : undefined);
    }
    // ...and the walk outside `Parameters` is a deep one: a leaf nested under
    // another property (`Tags[].Value`) equal to the value refuses too.
    const nested = parentResolved([PIN_TOKEN_A, PIN]);
    recordNestedStackParameterExpressions(
      nested,
      NESTED,
      { Parameters: { Pin: tiny }, Tags: [{ Key: 'pin', Value: tiny }] },
      { Parameters: { Pin: `p${PIN_TOKEN_A}` }, Tags: [{ Key: 'pin', Value: tiny }] }
    );
    expect(nested.has(tiny)).toBe(false);

    // The BOUNDARY of that split, AT the floor: a 4-character framed value
    // (`p` + a 3-character middle) IS a substring needle, so a containing
    // sibling refuses it, while alone it is carried. A gate one character
    // off in either direction reds one of the two halves.
    const atFloor = `p${'z'.repeat(MIN_NEEDLE_LENGTH - 1)}`;
    expect(atFloor.length).toBe(MIN_NEEDLE_LENGTH);
    const contained = parentResolved([PIN_TOKEN_A, 'z'.repeat(MIN_NEEDLE_LENGTH - 1)]);
    const containedResolved = { Parameters: { Pin: atFloor, Other: `x-${atFloor}-y` } };
    const containedSource = { Parameters: { Pin: `p${PIN_TOKEN_A}`, Other: `x-${atFloor}-y` } };
    recordNestedStackParameterExpressions(contained, NESTED, containedResolved, containedSource);
    expect(contained.has(atFloor)).toBe(false);
    const containedRecord = redactSecretsForState(
      markSameGenerationBag(structuredClone(containedResolved)),
      contained,
      containedSource
    ) as { Parameters: Record<string, unknown> };
    expect(containedRecord.Parameters['Other']).toBe(`x-${atFloor}-y`);
    const alone = parentResolved([PIN_TOKEN_A, 'z'.repeat(MIN_NEEDLE_LENGTH - 1)]);
    recordNestedStackParameterExpressions(
      alone,
      NESTED,
      { Parameters: { Pin: atFloor } },
      { Parameters: { Pin: `p${PIN_TOKEN_A}` } }
    );
    expect(alone.get(atFloor)).toBe(`p${PIN_TOKEN_A}`);
  });

  it('records under STATE_DERIVED_RULES too, which is what the replay call sites pass', () => {
    const parent = parentResolved([PIN_TOKEN_A, PIN]);
    recordNestedStackParameterExpressions(
      parent,
      NESTED,
      { Parameters: { Pin: frame(PIN) } },
      { Parameters: { Pin: frame(PIN_TOKEN_A) } },
      STATE_DERIVED_RULES
    );
    expect(parent.get(frame(PIN))).toBe(frame(PIN_TOKEN_A));
  });

  it('writes NO association under STATE_DERIVED_RULES for a raw PUBLIC token the record kept, which that ruleset certifies WITHOUT a pair (#3079 review)', () => {
    // The whole-token source arm returns the source verbatim on
    // `trustAnyExpression` with no pair evidence, so (i) and (ii) pass for a
    // public `ssm` token a `cdkd import` record kept raw (the doc's carve-out)
    // -- an empty frame around a value the map never held. Without the pair
    // gate the recorder would store `Env -> {{resolve:ssm:/public/env}}`, and
    // a CHILD resource that resolved the same plaintext from a secret of its
    // own would then persist the PUBLIC reference on its `{Ref: Env}` leaf.
    const PUBLIC = '{{resolve:ssm:/public/env}}';
    const parent = parentResolved([PIN_TOKEN_A, PIN]); // no pair for PUBLIC
    recordNestedStackParameterExpressions(
      parent,
      NESTED,
      { Parameters: { Env: 'prod', Pin: frame(PIN) } },
      { Parameters: { Env: PUBLIC, Pin: frame(PIN_TOKEN_A) } },
      STATE_DERIVED_RULES
    );
    expect(parent.has('prod')).toBe(false);
    const child: RecordedSecretValues = new Map([['prod', EXPR_C]]);
    inheritNestedStackParameterAssociations(child, parent);
    const persisted = redactSecretsForState({ Value: 'prod' }, child, {
      Value: { Ref: 'Env' },
    }) as Record<string, unknown>;
    // The value scan's answer (the child's own token), never the public one.
    expect(persisted['Value']).not.toBe(PUBLIC);
    expect(persisted['Value']).toBe(EXPR_C);
  });

  it('writes NO association under the TEMPLATE rules either for a secretsmanager whole token a bag no resolver populated never paired (#3079 review, round 2)', () => {
    // The TEMPLATE twin of the case above: the whole-token arm is merely
    // SPELLING-gated there, so a `secretsmanager` token passes (i) with no
    // pair as well. Same gate, same refusal -- the child's `{Ref}` leaf keeps
    // its own token rather than one this pass has no evidence for.
    const UNPAIRED = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:env::}}`;
    const parent = parentResolved([PIN_TOKEN_A, PIN]); // `prod` never resolved here
    recordNestedStackParameterExpressions(
      parent,
      NESTED,
      { Parameters: { Env: 'prod', Pin: frame(PIN) } },
      { Parameters: { Env: UNPAIRED, Pin: frame(PIN_TOKEN_A) } }
    );
    expect(parent.has('prod')).toBe(false);
    const child: RecordedSecretValues = new Map([['prod', EXPR_C]]);
    inheritNestedStackParameterAssociations(child, parent);
    const persisted = redactSecretsForState({ Value: 'prod' }, child, {
      Value: { Ref: 'Env' },
    }) as Record<string, unknown>;
    expect(persisted['Value']).not.toBe(UNPAIRED);
    expect(persisted['Value']).toBe(EXPR_C);
  });

  it("pins what remains of residual (a): ONE resource consuming both twins through an Fn::Sub embedding reads the slot's frame, its bare {Ref} its own (#3079)", () => {
    const parent = parentResolved([PIN_TOKEN_A, PIN], [PIN_TOKEN_B, PIN]);
    const resolved = { Parameters: { Pin1: frame(PIN), Pin2: frame(PIN) } };
    const source = { Parameters: { Pin1: frame(PIN_TOKEN_B), Pin2: frame(PIN_TOKEN_A) } };
    recordNestedStackParameterExpressions(parent, NESTED, resolved, source);
    // The child bag as the carry leaves it when `{Ref: Pin2}` resolved LAST:
    // one slot, A's frame.
    const child: RecordedSecretValues = new Map([[frame(PIN), frame(PIN_TOKEN_A)]]);
    inheritNestedStackParameterAssociations(child, parent);
    const persisted = redactSecretsForState(
      { Value: frame(PIN), Dsn: `x-${frame(PIN)}-y` },
      child,
      { Value: { Ref: 'Pin1' }, Dsn: { 'Fn::Sub': 'x-${Pin1}-y' } }
    ) as Record<string, unknown>;
    // The bare `{Ref: Pin1}` leaf: positioned by NAME, its own frame (B's).
    expect(persisted['Value']).toBe(frame(PIN_TOKEN_B));
    // The embedding leaf: the value scan, the slot's frame (A's) -- the stated
    // answer, the #2320 class, not closed here.
    expect(persisted['Dsn']).toBe(`x-${frame(PIN_TOKEN_A)}-y`);
  });

  // These pin each SHAPE's outcome, not one condition: every shape below is
  // refused by more than one of (i)-(v) (a two-span source fails (i) as well
  // as (iii); a value the pair table does not vouch for fails (i) and (iii);
  // a bag equal to its source fails (i)'s reading and (iii)'s token-middle
  // refusal alike), so no single mutant reds one of them alone. The
  // per-condition discriminators are the cases above.
  describe('writes nothing for', () => {
    const WORD_TOKEN = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:word::}}`;
    const REFUSALS: ReadonlyArray<
      readonly [
        label: string,
        resolved: unknown,
        source: unknown,
        extra?: ReadonlyArray<readonly [token: string, plaintext: string]>,
      ]
    > = [
      [
        "a whole-token source: the whole-value entry already exists and refusal 1's association covers it",
        PIN,
        PIN_TOKEN_A,
      ],
      [
        'a source with TWO spans, where which span produced which value is ambiguous',
        `port:${PIN}:${PIN}`,
        `port:${PIN_TOKEN_A}:${PIN_TOKEN_B}`,
        [[PIN_TOKEN_B, PIN]],
      ],
      [
        "an OBJECT-spelled source (residual (e): out of this arm's reach, issue #3062)",
        frame(PIN),
        { 'Fn::Sub': frame(PIN_TOKEN_A) },
      ],
      ["a value that does not fit the source's frame", `PORT:${PIN}`, frame(PIN_TOKEN_A)],
      [
        'a value the pair table does not vouch for (the token resolved to something else)',
        frame('zz'),
        frame(PIN_TOKEN_A),
      ],
      [
        "a bag equal to its source (refusal 3's self-referential shape: the middle is itself a token)",
        frame(PIN_TOKEN_A),
        frame(PIN_TOKEN_A),
      ],
      [
        'a value another 4+ character needle already rewrites (the interference refusal)',
        frame(PIN),
        frame(PIN_TOKEN_A),
        [[WORD_TOKEN, 'port']],
      ],
    ];
    for (const [label, resolved, source, extra = []] of REFUSALS) {
      it(label, () => {
        const parent = parentResolved([PIN_TOKEN_A, PIN], ...extra);
        const before = new Map(parent);
        recordNestedStackParameterExpressions(
          parent,
          NESTED,
          { Parameters: { Pin: resolved } },
          { Parameters: { Pin: source } }
        );
        expect([...parent]).toEqual([...before]);
      });
    }

    it('a map NO RESOLVER populated (the entry without its pair): the position pass refuses, so the carry must too', () => {
      // Condition (i) alone. The map's survivor for `q7` IS the frame's token
      // and the scan is silent, so (ii) and (iii) both pass -- what refuses
      // is the span arm, which needs the pass-local pair
      // (`recordResolvedPair`) before it will write a sub-floor middle, and
      // the recorder must not out-certify the positioner it derives from. An
      // inheritance copy or a `new Map` copy is exactly this shape.
      const parent: RecordedSecretValues = new Map([[PIN, PIN_TOKEN_A]]);
      recordNestedStackParameterExpressions(
        parent,
        NESTED,
        { Parameters: { Pin: frame(PIN) } },
        { Parameters: { Pin: frame(PIN_TOKEN_A) } }
      );
      expect([...parent]).toEqual([[PIN, PIN_TOKEN_A]]);
    });
  });
});
