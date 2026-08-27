import { describe, it, expect, beforeEach } from 'vite-plus/test';
import {
  clearRecordedSecretExpressions,
  crossStackSourceKey,
  recordCrossStackExpression,
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
  return new Map([[SHARED, EXPR_B]]);
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
    // store would certify `EXPR_C`.
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
    // The child's own grandchild row: SAME parameter name, DIFFERENT expression.
    recordNestedStackParameterExpressions(
      child,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: SHARED } },
      { Parameters: { [PARAM_A]: EXPR_B } }
    );

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
});

describe('recordNestedStackParameterExpressions — the `rules` argument (#2291)', () => {
  /**
   * THE DISCRIMINATING INPUT is an `ssm` reference whose SecureString verdict
   * this process has not pinned. A `secretsmanager` reference cannot see the
   * difference: `isKnownSecretExpression` answers true by SPELLING, so both
   * rule sets certify it and the argument is unobservable. Only the `ssm` form
   * — secret by the parameter's TYPE rather than by its text (issue #1901) —
   * separates them, because `TEMPLATE_DERIVED_RULES` sets
   * `trustAnyExpression: false` and must consult the verdict store, while
   * `STATE_DERIVED_RULES` sets it true: a persisted JOURNAL holds no PUBLIC
   * reference, since a plain `String` ssm parameter is stored RESOLVED.
   *
   * That is exactly why the rollback replay passes `STATE_DERIVED_RULES` and
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

  function recordUnder(rules?: PathSourceRules): RecordedSecretValues {
    const parent: RecordedSecretValues = new Map([[SSM_SHARED, SSM_EXPR_B]]);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { [PARAM_A]: SSM_SHARED, [PARAM_B]: SSM_SHARED } },
      { Parameters: { [PARAM_A]: SSM_EXPR_A, [PARAM_B]: SSM_EXPR_B } },
      ...(rules ? ([rules] as const) : ([] as const))
    );
    return parent;
  }

  it('the TEMPLATE default REFUSES an unpinned ssm reference, because a template can carry a public one', () => {
    const parent = recordUnder();
    expect(inheritedParameterExpression(parent, PARAM_A, SSM_SHARED)).toBeUndefined();
    // AND — the load-bearing half — it must not fall back to recording the
    // SURVIVOR under the LOSING parameter's name. That is what the value-scan
    // fallback produced before refusal 2b, and it labelled the sibling's
    // reference as certified for `PARAM_A`.
    expect(inheritedParameterExpression(parent, PARAM_A, SSM_SHARED)).not.toBe(SSM_EXPR_B);
  });

  it('STATE_DERIVED_RULES certifies it, because a JOURNAL holds no public reference', () => {
    const parent = recordUnder(STATE_DERIVED_RULES);
    expect(inheritedParameterExpression(parent, PARAM_A, SSM_SHARED)).toBe(SSM_EXPR_A);
    expect(inheritedParameterExpression(parent, PARAM_B, SSM_SHARED)).toBe(SSM_EXPR_B);
  });

  it('the two constants AGREE on a secretsmanager reference, which is why the ssm form is the probe', () => {
    // Scope control: without this, the two cases above could be read as a
    // blanket difference rather than the narrow one they are.
    const bySpelling = (rules?: PathSourceRules): string | undefined => {
      const parent: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);
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
