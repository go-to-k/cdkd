/**
 * A nested-stack CHILD leaf that EMBEDS a parameter (`Fn::Sub` / `Fn::Join`)
 * persists the same string the DIFF side renders for it, when a sibling
 * parameter of the same resource resolves to the same plaintext (issue
 * [#2320](https://github.com/go-to-k/cdkd/issues/2320)).
 *
 * The persist half and the diff half are both the REAL code: the real
 * `IntrinsicFunctionResolver` resolves the child's properties into the
 * resource's own bag, `redactSecretsForState` persists them against the source,
 * and `redactParametersForDiff` (called with a stand-in `this` carrying only
 * `options.inheritedSecrets`) builds the desired side's parameter bag, which the
 * same resolver then renders with `skipDynamicReferences`.
 *
 * THE DISCRIMINATING SHAPE IS TWO LEAVES IN ONE RESOURCE, the embedding leaf
 * over the parameter that resolves FIRST. The resource's bag holds one slot per
 * plaintext — whichever `Ref` resolved last — so with the embedding leaf alone,
 * or resolved last, the value scan already writes its own expression and every
 * assertion here would pass without the fix.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  inheritNestedStackParameterAssociations,
  recordDerivedMaskOnlyValue,
  recordMaskOnlyValue,
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  SECRET_MASK,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { redactParametersForDiff } from '../../../src/deployment/deploy-engine/masking.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/** Two spellings of ONE reference: an empty version stage means `AWSCURRENT`. */
const EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:handoff::}}';
const EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:handoff:AWSCURRENT:}}';
const SHARED = 'sh4red-h4ndoff-pl4intext-2320';
const OTHER_EXPR = '{{resolve:secretsmanager:prod/other:SecretString:k::}}';
const OTHER = 'an0ther-s3cret-pl4intext-2320';

const template: CloudFormationTemplate = {
  Parameters: {
    A: { Type: 'String' },
    B: { Type: 'String' },
    User: { Type: 'String' },
    Tail: { Type: 'String' },
  },
  Resources: {},
};
/**
 * `Tail` has no association and its value ENDS with the text that follows `A`
 * in the two-unknown case below, so a span located from the fixed suffix alone
 * would land on the wrong occurrence.
 */
const PARAMETERS = { A: SHARED, B: SHARED, User: 'app', Tail: `q:${SHARED}` };

/** The parent's bag as its pass leaves it: collapsed onto B, plus the per-name table. */
function parentBag(): RecordedSecretValues {
  const parent: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);
  recordResolvedPair(parent, EXPR_A, SHARED);
  recordResolvedPair(parent, EXPR_B, SHARED);
  recordNestedStackParameterExpressions(
    parent,
    'AWS::CloudFormation::Stack',
    { Parameters: { A: SHARED, B: SHARED, User: 'app' } },
    { Parameters: { A: EXPR_A, B: EXPR_B, User: 'app' } }
  );
  return parent;
}

const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

/** What the child persists for `source`, and what its next diff desires. */
async function bothHalves(
  source: Record<string, unknown>,
  parent: RecordedSecretValues = parentBag()
): Promise<{ persisted: Record<string, unknown>; desired: Record<string, unknown> }> {
  // The child engine's per-resource bag, as `buildResolverContext` builds it.
  const childBag: RecordedSecretValues = new Map();
  inheritNestedStackParameterAssociations(childBag, parent);
  const resolved = await resolver.resolve(source, {
    template,
    resources: {},
    stackName: "ChildStack",
    parameters: PARAMETERS,
    recordedSecretValues: childBag,
    inheritedSecrets: parent,
  } as unknown as ResolverContext);
  const persisted = redactSecretsForState(resolved, childBag, source) as Record<string, unknown>;

  const diffParameters = redactParametersForDiff.call(
    { options: { inheritedSecrets: parent } } as unknown as DeployEngine,
    PARAMETERS
  );
  const desired = (await resolver.resolve(source, {
    template,
    resources: {},
    stackName: "ChildStack",
    parameters: diffParameters,
    skipDynamicReferences: true,
    bestEffort: true,
  } as unknown as ResolverContext)) as Record<string, unknown>;
  return { persisted, desired };
}

describe('nested-stack child: an EMBEDDED parameter leaf beside a WHOLE-VALUE sibling (#2320)', () => {
  it('measures the premise: the resource bag holds ONE slot, the sibling resolved last', async () => {
    const parent = parentBag();
    const childBag: RecordedSecretValues = new Map();
    inheritNestedStackParameterAssociations(childBag, parent);
    await resolver.resolve(
      { P1: { 'Fn::Sub': 'x-${A}' }, P2: { Ref: 'B' } },
      {
        template,
        resources: {},
        stackName: "ChildStack",
        parameters: PARAMETERS,
        recordedSecretValues: childBag,
        inheritedSecrets: parent,
      } as unknown as ResolverContext
    );
    // Without the fix this slot is what the embedding leaf would persist.
    expect(childBag.get(SHARED)).toBe(EXPR_B);
  });

  it.each([
    ['Fn::Sub', { 'Fn::Sub': 'x-${A}' }],
    ['Fn::Sub (2-arg, unbound)', { 'Fn::Sub': ['x-${A}', { Unused: 'u' }] }],
    ['Fn::Join', { 'Fn::Join': ['-', ['x', { Ref: 'A' }]] }],
  ])('persists the %s leaf on its OWN expression, as the diff side renders it', async (_, leaf) => {
    const { persisted, desired } = await bothHalves({ P1: leaf, P2: { Ref: 'B' } });
    expect(persisted['P1']).toBe(`x-${EXPR_A}`);
    expect(persisted['P2']).toBe(EXPR_B);
    expect(persisted).toEqual(desired);
  });

  it('is order-independent: the embedding leaf resolved LAST answers the same', async () => {
    const { persisted, desired } = await bothHalves({
      P2: { Ref: 'B' },
      P1: { 'Fn::Sub': 'x-${A}' },
    });
    expect(persisted['P1']).toBe(`x-${EXPR_A}`);
    expect(persisted).toEqual(desired);
  });

  it('gives two embedding leaves over the two parameters each their own expression', async () => {
    const { persisted, desired } = await bothHalves({
      P1: { 'Fn::Sub': 'x-${A}' },
      P2: { 'Fn::Sub': 'y-${B}' },
    });
    expect(persisted['P1']).toBe(`x-${EXPR_A}`);
    expect(persisted['P2']).toBe(`y-${EXPR_B}`);
    expect(persisted).toEqual(desired);
  });

  it('positions ADJACENT placeholders with equal values by the template, not by search', async () => {
    const { persisted, desired } = await bothHalves({
      P1: { 'Fn::Sub': '${A}${B}' },
      P2: { Ref: 'B' },
    });
    expect(persisted['P1']).toBe(`${EXPR_A}${EXPR_B}`);
    expect(persisted).toEqual(desired);
  });

  it('keeps an escaped ${!A} as literal text', async () => {
    const { persisted, desired } = await bothHalves({
      P1: { 'Fn::Sub': 'x-${A}-${!A}' },
      P2: { Ref: 'B' },
    });
    expect(persisted['P1']).toBe(`x-${EXPR_A}-\${A}`);
    expect(persisted).toEqual(desired);
  });

  it('takes ONE unknown part (a pseudo parameter) from the span between the fixed parts', async () => {
    const { persisted, desired } = await bothHalves({
      P1: { 'Fn::Sub': 'x-${A}@${AWS::StackName}/db' },
      P2: { Ref: 'B' },
    });
    expect(persisted['P1']).toBe(`x-${EXPR_A}@ChildStack/db`);
    expect(persisted).toEqual(desired);
  });

  it('takes ONE unknown part (a parameter with no association) the same way', async () => {
    const { persisted, desired } = await bothHalves({
      P1: { 'Fn::Join': ['', ['postgres://', { Ref: 'User' }, ':', { Ref: 'A' }, '@host']] },
      P2: { Ref: 'B' },
    });
    expect(persisted['P1']).toBe(`postgres://app:${EXPR_A}@host`);
    expect(persisted).toEqual(desired);
  });

  it('reads a placeholder BOUND to a string literal as that literal, not as the same-named parameter', async () => {
    const { persisted, desired } = await bothHalves({
      P1: { 'Fn::Sub': ['${A}-${B}', { A: 'bound' }] },
      P2: { Ref: 'A' },
    });
    expect(persisted['P1']).toBe(`bound-${EXPR_B}`);
    expect(persisted).toEqual(desired);
  });

  it.each([
    // CDK's `Fn.sub('x-${V}', {V: param.valueAsString})`.
    ['a 2-arg Fn::Sub binding V to {Ref: A}', { 'Fn::Sub': ['x-${V}', { V: { Ref: 'A' } }] }],
    ['an Fn::Join over a nested Fn::Sub', { 'Fn::Join': ['', ['x-', { 'Fn::Sub': '${A}' }]] }],
    [
      'a 2-arg Fn::Sub binding V to a nested Fn::Join',
      { 'Fn::Sub': ['${V}', { V: { 'Fn::Join': ['-', ['x', { Ref: 'A' }]] } }] },
    ],
  ])('positions %s on the parameter\'s OWN expression (parent review M1)', async (_, leaf) => {
    const { persisted, desired } = await bothHalves({ P1: leaf, P2: { Ref: 'B' } });
    expect(persisted['P1']).toBe(`x-${EXPR_A}`);
    expect(persisted).toEqual(desired);
  });

  it('does not treat a prototype key (`${constructor}`) as bound by the 2-arg map', () => {
    // `Object.hasOwn`, the resolver's own test over its null-prototype copy:
    // `constructor` is not an OWN key of `{}`, so it is the PARAMETER of that
    // name. An `in` test would read `Object` there and refuse.
    const parent: RecordedSecretValues = new Map([[SHARED, EXPR_A]]);
    recordResolvedPair(parent, EXPR_A, SHARED);
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { constructor: SHARED } },
      { Parameters: { constructor: EXPR_A } }
    );
    const childBag: RecordedSecretValues = new Map();
    inheritNestedStackParameterAssociations(childBag, parent);
    childBag.set(SHARED, EXPR_B);
    const persisted = redactSecretsForState({ P1: `x-${SHARED}` }, childBag, {
      P1: { 'Fn::Sub': ['x-${constructor}', {}] },
    }) as Record<string, unknown>;
    expect(persisted['P1']).toBe(`x-${EXPR_A}`);
  });

  it('positions two unknown parts from the RESOLVER\'s spans, which the template parse refuses (#4446)', async () => {
    const source = {
      P1: { 'Fn::Sub': '${User}-${A}-${AWS::StackName}' },
      P2: { Ref: 'B' },
    };
    const { persisted, desired } = await bothHalves(source);
    expect(persisted['P1']).toBe(`app-${EXPR_A}-ChildStack`);
    expect(persisted).toEqual(desired);
    // Without the resolver's record (a hand-built bag) the template parse
    // still refuses it: the value scan's answer, the resource's one slot.
    const hand = redactSecretsForState({ P1: `app-${SHARED}-ChildStack` }, childBagWithSlot(), {
      P1: source.P1,
    }) as Record<string, unknown>;
    expect(hand['P1']).toBe(`app-${EXPR_B}-ChildStack`);
  });

  it('REFUSES two unknown parts where the suffix still matches, here also caught by the unknown-span re-scan', async () => {
    const { persisted } = await bothHalves({
      P1: { 'Fn::Sub': '${User}:${A}${Tail}' },
      P2: { Ref: 'B' },
    });
    // The value scan's answer over the whole leaf, never a span cut at the
    // SECOND `:<plaintext>` (which would write `app:<B>q:<A>`).
    expect(persisted['P1']).toBe(`app:${EXPR_B}q:${EXPR_B}`);
  });

  it('REFUSES when the template literal itself holds a recorded plaintext, so nothing the scan rewrites is persisted', () => {
    const parent = parentBag();
    const childBag: RecordedSecretValues = new Map();
    inheritNestedStackParameterAssociations(childBag, parent);
    childBag.set(SHARED, EXPR_B);
    childBag.set(OTHER, OTHER_EXPR);
    const source = { 'Fn::Sub': `${OTHER}-\${A}` };
    const persisted = redactSecretsForState({ P1: `${OTHER}-${SHARED}` }, childBag, {
      P1: source,
    }) as Record<string, unknown>;
    expect(persisted['P1']).not.toContain(OTHER);
    expect(persisted['P1']).toBe(`${OTHER_EXPR}-${EXPR_B}`);
  });

  it('REFUSES a leaf the parts do not reassemble (the Ref answered something else)', () => {
    const parent = parentBag();
    const childBag: RecordedSecretValues = new Map();
    inheritNestedStackParameterAssociations(childBag, parent);
    childBag.set(SHARED, EXPR_B);
    const persisted = redactSecretsForState({ P1: `y-${SHARED}` }, childBag, {
      P1: { 'Fn::Sub': 'x-${A}' },
    }) as Record<string, unknown>;
    expect(persisted['P1']).toBe(`y-${EXPR_B}`);
  });

  /** A child resource bag holding A / B's associations and the collapsed slot. */
  function childBagWithSlot(): RecordedSecretValues {
    const childBag: RecordedSecretValues = new Map();
    inheritNestedStackParameterAssociations(childBag, parentBag());
    childBag.set(SHARED, EXPR_B);
    return childBag;
  }

  describe('keeps the unknown span verbatim, refusing a span the value scan would rewrite (#4448 review)', () => {
    const MIDDLE = 'n0echo-cust0m-res0urce-v4lue';
    const source = { 'Fn::Join': ['', [{ Ref: 'A' }, '-', { 'Fn::GetAtt': ['Cr', 'Secret'] }]] };
    const leaf = `${SHARED}-${MIDDLE}`;

    it('a containment (derived mask-only) needle: the leaf is masked WHOLE, never `<expr>-***`', () => {
      const childBag = childBagWithSlot();
      recordDerivedMaskOnlyValue(childBag, MIDDLE);
      const persisted = redactSecretsForState({ P1: leaf }, childBag, { P1: source }) as Record<
        string,
        unknown
      >;
      expect(persisted['P1']).toBe(SECRET_MASK);
    });

    it('a mask-only value as the whole span: the value scan answer, never an inline `***`', () => {
      const childBag = childBagWithSlot();
      recordMaskOnlyValue(childBag, MIDDLE);
      const persisted = redactSecretsForState({ P1: leaf }, childBag, { P1: source }) as Record<
        string,
        unknown
      >;
      expect(persisted['P1']).not.toContain(SECRET_MASK);
      // The value scan's answer: the mask-only value is withheld from the
      // substring arm, the shared plaintext takes the bag's one slot.
      expect(persisted['P1']).toBe(`${EXPR_B}-${MIDDLE}`);
    });

    it('a 1-3 character span equal to a recorded sub-floor plaintext keeps its text, not that secret\'s reference', () => {
      const childBag = childBagWithSlot();
      const PIN_EXPR = '{{resolve:secretsmanager:prod/pin:SecretString:p::}}';
      childBag.set('q7', PIN_EXPR);
      const persisted = redactSecretsForState({ P1: `${SHARED}:q7` }, childBag, {
        P1: { 'Fn::Join': [':', [{ Ref: 'A' }, { Ref: 'Port' }]] },
      }) as Record<string, unknown>;
      expect(persisted['P1']).not.toContain(PIN_EXPR);
      expect(persisted['P1']).toBe(`${EXPR_B}:q7`);
    });
  });

  it('REFUSES a recorded needle crossing a certified span\'s edge, whose leftover half the re-scan cannot see (#4448 review)', () => {
    const childBag = childBagWithSlot();
    const FRAGMENT = 'topsecretfragment';
    const STRADDLE = FRAGMENT + SHARED.slice(0, 3);
    childBag.set(STRADDLE, '{{resolve:ssm:straddle}}');
    const persisted = redactSecretsForState({ P1: `u-${FRAGMENT}${SHARED}` }, childBag, {
      P1: { 'Fn::Sub': '${User}${A}' },
    }) as Record<string, unknown>;
    expect(persisted['P1']).not.toContain(FRAGMENT);
    // The value scan's answer, leftmost-first: the straddling needle wins at
    // its offset and the shared plaintext's tail stays (the pre-existing
    // overlap residual, identical without this arm).
    expect(persisted['P1']).toBe(`u-{{resolve:ssm:straddle}}${SHARED.slice(3)}`);
  });

  it('ACCEPTS a SUB-FLOOR plaintext crossing a certified span\'s edge, which the value scan never reads either', () => {
    const childBag = childBagWithSlot();
    childBag.set(`-${SHARED.slice(0, 2)}`, '{{resolve:ssm:tiny}}');
    const persisted = redactSecretsForState({ P1: `x-${SHARED}` }, childBag, {
      P1: { 'Fn::Sub': 'x-${A}' },
    }) as Record<string, unknown>;
    expect(persisted['P1']).toBe(`x-${EXPR_A}`);
  });

  describe('the single-unknown span is located only where the fixed parts match (parent review G1)', () => {
    it('REFUSES a leaf whose PREFIX disagrees with the template', () => {
      const persisted = redactSecretsForState({ P1: `y-${SHARED}-app` }, childBagWithSlot(), {
        P1: { 'Fn::Sub': 'x-${A}-${User}' },
      }) as Record<string, unknown>;
      expect(persisted['P1']).toBe(`y-${EXPR_B}-app`);
    });

    it('REFUSES a leaf whose SUFFIX disagrees with the template', () => {
      const persisted = redactSecretsForState({ P1: `app-${SHARED}-q` }, childBagWithSlot(), {
        P1: { 'Fn::Sub': '${User}-${A}-z' },
      }) as Record<string, unknown>;
      expect(persisted['P1']).toBe(`app-${EXPR_B}-q`);
    });

    it('REFUSES a leaf shorter than its fixed prefix and suffix together (they would OVERLAP)', () => {
      // `SHARED` itself ends with `2320`, so both the prefix and the suffix
      // test pass on a leaf that is just `SHARED`; only the length floor
      // refuses, and the value scan answers it whole.
      expect(SHARED.endsWith('2320')).toBe(true);
      const persisted = redactSecretsForState({ P1: SHARED }, childBagWithSlot(), {
        P1: { 'Fn::Sub': '${A}${User}2320' },
      }) as Record<string, unknown>;
      expect(persisted['P1']).toBe(EXPR_B);
    });
  });

  it('REFUSES a SECOND unknown part even when every other check passes (a sub-floor parameter, parent review G2)', () => {
    // A parameter `C` whose plaintext is two characters: no check that reads
    // NEEDLES can see it. Skipping the second unknown part (`Tail`) instead of
    // refusing would cut the span at the second `:q7` and persist `q7` -- C's
    // plaintext -- in the clear beside C's own expression.
    const C_EXPR = '{{resolve:secretsmanager:prod/pin:SecretString:c::}}';
    const parent: RecordedSecretValues = new Map([['q7', C_EXPR]]);
    recordResolvedPair(parent, C_EXPR, 'q7');
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { C: 'q7' } },
      { Parameters: { C: C_EXPR } }
    );
    const childBag: RecordedSecretValues = new Map();
    inheritNestedStackParameterAssociations(childBag, parent);
    childBag.set('q7', C_EXPR);
    // Premise: C alone IS positioned by the arm, so the refusal below is the guard's.
    const alone = redactSecretsForState({ P1: 'app:q7' }, childBag, {
      P1: { 'Fn::Sub': '${User}:${C}' },
    }) as Record<string, unknown>;
    expect(alone['P1']).toBe(`app:${C_EXPR}`);
    const persisted = redactSecretsForState({ P1: 'app:q7z:q7' }, childBag, {
      P1: { 'Fn::Sub': '${User}:${C}${Tail}' },
    }) as Record<string, unknown>;
    // The value scan's answer: a sub-floor plaintext inside a longer leaf is
    // left as it is (the floor), never a span cut at the wrong `:q7`.
    expect(persisted['P1']).toBe('app:q7z:q7');
  });

  describe('bounds the expansion of bound variables (#4448 security review S-1)', () => {
    /** `d` levels of `{'Fn::Sub': ['${V}' x k, {V: <next>}]}` around `inner`. */
    function nestedSub(k: number, d: number, inner: unknown): unknown {
      let value = inner;
      for (let level = 0; level < d; level++) {
        value = { 'Fn::Sub': ['${V}'.repeat(k), { V: value }] };
      }
      return value;
    }

    it('REFUSES a k^d bound-variable bomb (k=8, d=6) without throwing, leaving the value scan answer', () => {
      const childBag = childBagWithSlot();
      const source = { P1: nestedSub(8, 6, '') };
      let persisted: Record<string, unknown> | undefined;
      expect(() => {
        persisted = redactSecretsForState({ P1: '' }, childBag, source) as Record<string, unknown>;
      }).not.toThrow();
      expect(persisted!['P1']).toBe('');
    });

    it('stops expanding at the PART budget: a k=8, d=8 bomb (16.7M placeholders) is refused at once', () => {
      // Within the depth cap, so only the part budget bounds it. Unbounded,
      // the parse would build tens of millions of parts before the
      // reassembly refused -- far past this case's timeout.
      const childBag = childBagWithSlot();
      const started = Date.now();
      const persisted = redactSecretsForState({ P1: '' }, childBag, {
        P1: nestedSub(8, 8, ''),
      }) as Record<string, unknown>;
      expect(persisted['P1']).toBe('');
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('REFUSES a source nested deeper than the depth cap, even one that would reassemble', () => {
      const childBag = childBagWithSlot();
      // One placeholder per level, so the part count stays tiny: only the
      // DEPTH bound can refuse. The value scan's answer is the slot.
      const source = { P1: nestedSub(1, 10, { 'Fn::Sub': 'x-${A}' }) };
      const persisted = redactSecretsForState({ P1: `x-${SHARED}` }, childBag, source) as Record<
        string,
        unknown
      >;
      expect(persisted['P1']).toBe(`x-${EXPR_B}`);
      // Premise: two levels ARE positioned, so the refusal above is the cap's.
      const shallow = redactSecretsForState({ P1: `x-${SHARED}` }, childBag, {
        P1: nestedSub(1, 2, { 'Fn::Sub': 'x-${A}' }),
      }) as Record<string, unknown>;
      expect(shallow['P1']).toBe(`x-${EXPR_A}`);
    });
  });

  it('is inert on a bag carrying no parameter association (every non-nested pass)', () => {
    const bag: RecordedSecretValues = new Map([[SHARED, EXPR_B]]);
    const persisted = redactSecretsForState({ P1: `x-${SHARED}` }, bag, {
      P1: { 'Fn::Sub': 'x-${A}' },
    }) as Record<string, unknown>;
    expect(persisted['P1']).toBe(`x-${EXPR_B}`);
  });
});
