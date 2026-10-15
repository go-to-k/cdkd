/**
 * A child resource reading BOTH a literal-spelled parameter (issue #4644) and a
 * same-plaintext sibling (issue
 * [#4731](https://github.com/go-to-k/cdkd/issues/4731)).
 *
 * The carry holds ONE expression per plaintext per resource, so in such a
 * resource the parameter resolved LAST decides every value-scanned leaf. A
 * leaf whose source is `Fn::Select` / `Fn::Split` over the child's parameters
 * is re-read with the diff side's bindings (`positionByParameterReread`), so
 * each leaf persists its own parameter's spelling and nothing is withdrawn.
 * A slot read the persist walk cannot re-read (an `Fn::Sub` under
 * `Fn::Select`, an `Fn::If`, a delimiter cutting a plaintext) still makes
 * `poisonRenderedSpellingsCollidingIn` withdraw the literal's spelling for the
 * whole child -- the pre-#4644 answer.
 *
 * Drives the REAL resolver, the REAL `redactSecretsForState` and the REAL
 * `redactParametersForDiff`.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  inheritNestedStackParameterAssociations,
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  redactInheritedParameterValue,
  redactSecretsForState,
  withdrawRenderedParameterSpelling,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { poisonRenderedSpellingsCollidingIn } from '../../../src/deployment/intrinsic-resolver/parameter-secrets.js';
import {
  positionByParameterReread,
  recordInheritedParameterValue,
  rereadParameterExpression,
} from '../../../src/deployment/secret-redaction/nested-stack.js';
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

const EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:collide::}}';
const EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:collide:AWSCURRENT:}}';
const USER_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:collideuser::}}';
const SHARED = 'sh4red-c0llide-pl4intext-4731';
const USER = 'us3r-c0llide-4731';
const PARAM_A = 'ConnA';
const PARAM_B = 'SecretB';
const SPELLING = `postgres://${USER_EXPR}:${EXPR_A}@host`;
const CONN = `postgres://${USER}:${SHARED}@host`;
const PARAMETERS = { [PARAM_A]: CONN, [PARAM_B]: SHARED };

const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
const SEL_A = { 'Fn::Select': [0, [{ Ref: PARAM_A }]] };
const SEL_B = { 'Fn::Select': [0, [{ Ref: PARAM_B }]] };
/** Slot reads no re-read evaluates: an `Fn::Sub` under `Fn::Select`. */
const SUB_SEL_A = { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_A}}` }]] };
const SUB_SEL_B = { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_B}}` }]] };
/** The evaluated `Conditions` both sides resolve `Fn::If` with. */
const CONDITIONS = { On: true };

function childTemplate(resources: Record<string, unknown>): CloudFormationTemplate {
  return {
    Parameters: { [PARAM_A]: { Type: 'String' }, [PARAM_B]: { Type: 'String' } },
    Resources: Object.fromEntries(
      Object.entries(resources).map(([id, properties]) => [
        id,
        { Type: 'AWS::SSM::Parameter', Properties: properties },
      ])
    ),
  } as CloudFormationTemplate;
}

/** One parent row's bag; `reversed` resolves `ConnA` first, so `EXPR_B` survives. */
function parentRow(reversed: boolean): RecordedSecretValues {
  const conn = [
    [USER_EXPR, USER],
    [EXPR_A, SHARED],
  ] as const;
  const order = reversed ? [...conn, [EXPR_B, SHARED] as const] : [[EXPR_B, SHARED] as const, ...conn];
  const parent: RecordedSecretValues = new Map();
  for (const [expression, plaintext] of order) {
    parent.set(plaintext, expression);
    recordResolvedPair(parent, expression, plaintext);
  }
  recordNestedStackParameterExpressions(
    parent,
    'AWS::CloudFormation::Stack',
    { Parameters: PARAMETERS },
    { Parameters: { [PARAM_A]: SPELLING, [PARAM_B]: EXPR_B } }
  );
  return parent;
}

/** Persist one resource of the child as the deploy does, and its diff side. */
async function persistAndDesired(
  parent: RecordedSecretValues,
  template: CloudFormationTemplate,
  properties: Record<string, unknown>
): Promise<{ persisted: Record<string, unknown>; desired: Record<string, unknown> }> {
  const recordedSecretValues = new Map<string, string>();
  inheritNestedStackParameterAssociations(recordedSecretValues, parent);
  const ctx = {
    template,
    resources: {},
    parameters: PARAMETERS,
    recordedSecretValues,
    inheritedSecrets: parent,
    conditions: CONDITIONS,
  } as unknown as ResolverContext;
  const resolved = await resolver.resolve(properties, ctx);
  const persisted = redactSecretsForState(resolved, recordedSecretValues, properties) as Record<
    string,
    unknown
  >;
  const engine = { options: { inheritedSecrets: parent } } as unknown as DeployEngine;
  const desired = (await resolver.resolve(properties, {
    template,
    resources: {},
    parameters: redactParametersForDiff.call(engine, PARAMETERS),
    // As `buildResolverContext` sets it on the deploy's diff context.
    inheritedSecrets: parent,
    skipDynamicReferences: true,
    conditions: CONDITIONS,
  } as unknown as ResolverContext)) as Record<string, unknown>;
  return { persisted, desired };
}

describe('a slot read no re-read answers keeps the pre-#4644 answer (#4731)', () => {
  for (const reversed of [true, false]) {
    for (const literalLast of [true, false]) {
      it(`${reversed ? 'reversed' : 'forward'} parent order, ${literalLast ? 'literal' : 'sibling'} read last`, async () => {
        const parent = parentRow(reversed);
        const survivor = reversed ? EXPR_B : EXPR_A;
        const properties = literalLast ? { B: SUB_SEL_B, A: SUB_SEL_A } : { A: SUB_SEL_A, B: SUB_SEL_B };
        const template = childTemplate({ Mixed: properties });
        poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);

        // The literal's spelling is withdrawn: the diff side binds the scan.
        expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
          `postgres://${USER_EXPR}:${survivor}@host`
        );
        const { persisted, desired } = await persistAndDesired(parent, template, properties);
        // What `main` persisted and bound: the slot holds the LAST read's
        // expression -- the survivor for `ConnA`, `EXPR_B` for `SecretB`.
        const slot = literalLast ? survivor : EXPR_B;
        expect(persisted['A']).toBe(`postgres://${USER_EXPR}:${slot}@host`);
        expect(persisted['B']).toBe(slot);
        expect(desired['A']).toBe(`postgres://${USER_EXPR}:${survivor}@host`);
        expect(desired['B']).toBe(EXPR_B);
        if (reversed) {
          // The case #4644's first draft regressed: both leaves agree again.
          expect(persisted).toEqual(desired);
        } else {
          // The pre-existing #2349 slot residual, unchanged: the leaf of the
          // parameter read FIRST takes the other's expression.
          expect(persisted['A'] === desired['A'] && persisted['B'] === desired['B']).toBe(false);
        }
        expect(JSON.stringify(persisted)).not.toContain(SHARED);
      });
    }
  }

  it('withdraws for the WHOLE child, so a resource reading only the literal agrees too', async () => {
    const parent = parentRow(true);
    const template = childTemplate({ Mixed: { A: SUB_SEL_A, B: SUB_SEL_B }, Alone: { A: SEL_A } });
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    const { persisted, desired } = await persistAndDesired(parent, template, { A: SEL_A });
    expect(persisted).toEqual(desired);
    expect(desired['A']).toBe(`postgres://${USER_EXPR}:${EXPR_B}@host`);
  });

  it('a SIBLING child of the same parent, reading only the literal, keeps the #4644 fix', async () => {
    // Two nested-stack rows: two bags. Only the mixed child's is withdrawn.
    const mixedRow = parentRow(true);
    const plainRow = parentRow(true);
    poisonRenderedSpellingsCollidingIn(childTemplate({ Mixed: { A: SUB_SEL_A, B: SUB_SEL_B } }), PARAMETERS, mixedRow);
    const template = childTemplate({ Alone: { A: SEL_A } });
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, plainRow);
    expect(redactInheritedParameterValue(plainRow, PARAM_A, CONN)).toBe(SPELLING);
    const { persisted, desired } = await persistAndDesired(plainRow, template, { A: SEL_A });
    expect(persisted).toEqual(desired);
    expect(desired['A']).toBe(SPELLING);
  });

  it('keeps the spelling where the two parameters are read by DIFFERENT resources', () => {
    const parent = parentRow(true);
    poisonRenderedSpellingsCollidingIn(childTemplate({ X: { A: SEL_A }, Y: { B: SEL_B } }), PARAMETERS, parent);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
  });

  it('finds an `Fn::Sub` read (string and variable-map forms) as well as a `Ref`', () => {
    for (const subRead of [
      { 'Fn::Sub': `x-\${${PARAM_B}}` },
      { 'Fn::Sub': [`x-\${${PARAM_B}}`, {}] },
    ]) {
      const parent = parentRow(true);
      poisonRenderedSpellingsCollidingIn(childTemplate({ Mixed: { A: SUB_SEL_A, B: subRead } }), PARAMETERS, parent);
      expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
        `postgres://${USER_EXPR}:${EXPR_B}@host`
      );
    }
    // A literal `${!Name}` is no read.
    const parent = parentRow(true);
    poisonRenderedSpellingsCollidingIn(
      childTemplate({ Mixed: { A: SUB_SEL_A, B: { 'Fn::Sub': `x-\${!${PARAM_B}}` } } }),
      PARAMETERS,
      parent
    );
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
  });

  it("keeps the spelling for the issue's own shape: two BARE {Ref}s in one resource, positioned per parameter", async () => {
    const parent = parentRow(true);
    const properties = { Description: { Ref: PARAM_A }, Value: { Ref: PARAM_B } };
    const template = childTemplate({ Pair: properties });
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
    const { persisted, desired } = await persistAndDesired(parent, template, properties);
    expect(persisted).toEqual(desired);
    expect(persisted['Description']).toBe(SPELLING);
  });

  // A bare `{Ref}` is positioned per parameter but still WRITES the slot, so a
  // slot read of the other parameter in the same resource collides with it.
  const BARE_BESIDE_SLOT: Record<string, Record<string, unknown>> = {
    'bare SecretB, then Sub-in-Select ConnA': { B: { Ref: PARAM_B }, A: SUB_SEL_A },
    'Sub-in-Select ConnA, then bare SecretB': { A: SUB_SEL_A, B: { Ref: PARAM_B } },
    'bare ConnA, then Sub-in-Select SecretB': { A: { Ref: PARAM_A }, B: SUB_SEL_B },
    'Sub-in-Select SecretB, then bare ConnA': { B: SUB_SEL_B, A: { Ref: PARAM_A } },
    'Sub-in-Select SecretB, then ConnA in a plain array': { B: SUB_SEL_B, A: [{ Ref: PARAM_A }] },
    'Sub-in-Select SecretB, then ConnA in a plain object': { B: SUB_SEL_B, A: { K: { Ref: PARAM_A } } },
    // An `Fn::If` branch holding an array is value-scanned, so `Fn::If` is a
    // slot read; the other side of the collision is positioned.
    'Fn::If array of SecretB, then bare ConnA': {
      B: { 'Fn::If': ['On', [{ Ref: PARAM_B }], 'z'] },
      A: { Ref: PARAM_A },
    },
    'Fn::Join of ConnA, then Fn::If array of SecretB': {
      A: { 'Fn::Join': ['', ['x-', { Ref: PARAM_A }]] },
      B: { 'Fn::If': ['On', [{ Ref: PARAM_B }], 'z'] },
    },
  };
  for (const reversed of [true, false]) {
    for (const [shape, properties] of Object.entries(BARE_BESIDE_SLOT)) {
      it(`${reversed ? 'reversed' : 'forward'} parent order, ${shape}: persists what main persisted`, async () => {
        const template = childTemplate({ Mixed: properties });
        const parent = parentRow(reversed);
        poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
        // Forward, the survivor IS the literal's own token: same answer.
        expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
          `postgres://${USER_EXPR}:${reversed ? EXPR_B : EXPR_A}@host`
        );
        // `main`: no rendered spelling for either parameter.
        const before = parentRow(reversed);
        withdrawRenderedParameterSpelling(before, PARAM_A);
        withdrawRenderedParameterSpelling(before, PARAM_B);
        const ours = await persistAndDesired(parent, template, properties);
        expect(ours).toEqual(await persistAndDesired(before, template, properties));
        if (reversed) expect(ours.persisted).toEqual(ours.desired);
        expect(JSON.stringify(ours.persisted)).not.toContain(SHARED);
      });
    }
  }

  // `Fn::Join` and `Fn::Sub` reads are positioned per parameter, as a bare
  // `{Ref}` is: no slot read, no collision, the #4644 fix kept.
  const POSITIONED: Record<string, (p: string) => unknown> = {
    'Fn::Join': (p) => ({ 'Fn::Join': ['', ['x-', { Ref: p }]] }),
    'Fn::Sub': (p) => ({ 'Fn::Sub': `x-\${${p}}` }),
  };
  for (const [readA, wrapA] of Object.entries(POSITIONED)) {
    for (const [readB, wrapB] of Object.entries({ bare: (p: string) => ({ Ref: p }), ...POSITIONED })) {
      it(`keeps the spelling where ConnA is read through ${readA} beside a ${readB} SecretB`, async () => {
        for (const properties of [
          { A: wrapA(PARAM_A), B: wrapB(PARAM_B) },
          { B: wrapB(PARAM_B), A: wrapA(PARAM_A) },
        ]) {
          const parent = parentRow(true);
          const template = {
            ...childTemplate({ Mixed: properties }),
            Conditions: { On: { 'Fn::Equals': ['a', 'a'] } },
          } as CloudFormationTemplate;
          poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
          expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
          const { persisted, desired } = await persistAndDesired(parent, template, properties);
          expect(persisted).toEqual(desired);
          expect(JSON.stringify(persisted)).toContain(EXPR_A);
        }
      });
    }
  }

  // A withdrawal moves ConnA's carry to the survivor, which opens a collision
  // in ANOTHER resource with a second literal still carrying its own token:
  // the walk runs to a fixed point.
  for (const dFirst of [false, true]) {
    it(`withdraws to a fixed point: a cascade into a second literal (${dFirst ? 'ConnD' : 'ConnA'} read first)`, async () => {
      const PARAM_D = 'ConnD';
      const SPELLING_D = `mysql://${USER_EXPR}:${EXPR_A}@other`;
      const CONN_D = `mysql://${USER}:${SHARED}@other`;
      const params = { ...PARAMETERS, [PARAM_D]: CONN_D };
      const parent = parentRow(true);
      recordNestedStackParameterExpressions(
        parent,
        'AWS::CloudFormation::Stack',
        { Parameters: params },
        { Parameters: { [PARAM_A]: SPELLING, [PARAM_B]: EXPR_B, [PARAM_D]: SPELLING_D } }
      );
      expect(redactInheritedParameterValue(parent, PARAM_D, CONN_D)).toBe(SPELLING_D);
      const selD = { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_D}}` }]] };
      const other = dFirst ? { D: selD, A: SUB_SEL_A } : { A: SUB_SEL_A, D: selD };
      const template = childTemplate({ Mixed: { A: SUB_SEL_A, B: SUB_SEL_B }, Other: other });
      poisonRenderedSpellingsCollidingIn(template, params, parent);
      expect(redactInheritedParameterValue(parent, PARAM_D, CONN_D)).toBe(
        `mysql://${USER_EXPR}:${EXPR_B}@other`
      );
      const recordedSecretValues = new Map<string, string>();
      inheritNestedStackParameterAssociations(recordedSecretValues, parent);
      const resolved = await resolver.resolve(other, {
        template,
        resources: {},
        parameters: params,
        recordedSecretValues,
        inheritedSecrets: parent,
        conditions: CONDITIONS,
      } as unknown as ResolverContext);
      const persisted = redactSecretsForState(resolved, recordedSecretValues, other);
      const engine = { options: { inheritedSecrets: parent } } as unknown as DeployEngine;
      const desired = await resolver.resolve(other, {
        template,
        resources: {},
        parameters: redactParametersForDiff.call(engine, params),
        skipDynamicReferences: true,
        conditions: CONDITIONS,
      } as unknown as ResolverContext);
      expect(persisted).toEqual(desired);
      expect(JSON.stringify(persisted)).not.toContain(SHARED);
    });
  }

  // The Outputs are one reader whose leaves are each `Value`, classified as a
  // resource's (#4913; the persist side is
  // `secret-redaction-nested-outputs-collision.test.ts`).
  it('counts the Outputs as one reader, each Value read as a resource leaf', () => {
    for (const [outputs, withdrawn] of [
      [{ OA: { Value: SEL_A }, OB: { Value: { Ref: PARAM_B } } }, false],
      [{ OA: { Value: { Ref: PARAM_A } }, OB: { Value: { Ref: PARAM_B } } }, false],
      [{ OA: { Value: SUB_SEL_A }, OB: { Value: { Ref: PARAM_B } } }, true],
    ] as const) {
      const parent = parentRow(true);
      const template = {
        ...childTemplate({ X: { A: SEL_A } }),
        Outputs: outputs,
      } as CloudFormationTemplate;
      poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
      expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
        withdrawn ? `postgres://${USER_EXPR}:${EXPR_B}@host` : SPELLING
      );
    }
  });

  it('withdraws nothing where both parameters would carry the SAME expression', () => {
    // A resource reading `ConnA` beside a parameter whose own expression for
    // the plaintext IS `EXPR_A`: no collision.
    const parent = parentRow(true);
    const PARAM_C = 'SecretC';
    recordNestedStackParameterExpressions(
      parent,
      'AWS::CloudFormation::Stack',
      { Parameters: { ...PARAMETERS, [PARAM_C]: SHARED } },
      { Parameters: { [PARAM_A]: SPELLING, [PARAM_B]: EXPR_B, [PARAM_C]: EXPR_A } }
    );
    const template = {
      ...childTemplate({
        Mixed: { A: SUB_SEL_A, C: { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_C}}` }]] } },
      }),
    } as CloudFormationTemplate;
    poisonRenderedSpellingsCollidingIn(template, { ...PARAMETERS, [PARAM_C]: SHARED }, parent);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
  });
});

describe('a child resource reading BOTH parameters through Fn::Select / Fn::Split keeps each spelling (#4731)', () => {
  const SPLIT_A = { 'Fn::Select': [0, { 'Fn::Split': ['@', { Ref: PARAM_A }] }] };
  const SPLIT_PIECE_A = `postgres://${USER_EXPR}:${EXPR_A}`;
  // Both read shapes: the literal through a re-read beside the sibling bare,
  // in an array or an object, and the sibling through a re-read beside the
  // literal bare -- plus both through re-reads.
  const REREAD: Record<string, Record<string, unknown>> = {
    'Select ConnA, Select SecretB': { A: SEL_A, B: SEL_B },
    'Select over Split ConnA, Select SecretB': { A: SPLIT_A, B: SEL_B },
    'Select ConnA, bare SecretB': { A: SEL_A, B: { Ref: PARAM_B } },
    'bare ConnA, Select SecretB': { A: { Ref: PARAM_A }, B: SEL_B },
    'ConnA in a plain array, Select SecretB': { A: [{ Ref: PARAM_A }], B: SEL_B },
    'ConnA in a plain object, Select SecretB': { A: { K: { Ref: PARAM_A } }, B: SEL_B },
    'Fn::Join around Select ConnA, Select SecretB': {
      A: { 'Fn::Join': ['', ['x-', SEL_A]] },
      B: SEL_B,
    },
    // A plain array (no element can drop out) keeps the leaf position.
    'ConnA Select inside a plain array, Select SecretB': { A: [SEL_A], B: SEL_B },
    'Fn::Split ConnA (a list leaf), Select SecretB': {
      A: { 'Fn::Split': ['@', { Ref: PARAM_A }] },
      B: SEL_B,
    },
    // Issue #4914: `:` occurs inside every token's text, and the diff side
    // keeps each token whole where it splits.
    'Select over a token-cutting Split ConnA, Select SecretB': {
      A: { 'Fn::Select': [2, { 'Fn::Split': [':', { Ref: PARAM_A }] }] },
      B: SEL_B,
    },
    'token-cutting Fn::Split ConnA (a list leaf), Select SecretB': {
      A: { 'Fn::Split': [':', { Ref: PARAM_A }] },
      B: SEL_B,
    },
  };
  for (const reversed of [true, false]) {
    for (const literalLast of [true, false]) {
      for (const [shape, shapeProperties] of Object.entries(REREAD)) {
        it(`${reversed ? 'reversed' : 'forward'} parent order, ${literalLast ? 'literal' : 'sibling'} read last, ${shape}`, async () => {
          const properties = literalLast
            ? { B: shapeProperties['B'], A: shapeProperties['A'] }
            : { A: shapeProperties['A'], B: shapeProperties['B'] };
          const template = childTemplate({ Mixed: properties });
          const parent = parentRow(reversed);
          poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
          // Nothing withdrawn: the diff side binds the literal.
          expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
          const { persisted, desired } = await persistAndDesired(parent, template, properties);
          expect(persisted).toEqual(desired);
          // Each leaf its OWN parameter's token, whichever resolved last.
          expect(persisted['B']).toBe(EXPR_B);
          const a = JSON.stringify(persisted['A']);
          expect(a).toContain(EXPR_A);
          expect(a).not.toContain(EXPR_B);
          expect(JSON.stringify(persisted)).not.toContain(SHARED);
          expect(JSON.stringify(persisted)).not.toContain(USER);
        });
      }
    }
  }

  it('persists the piece the diff side computes for a Select over Split', async () => {
    const parent = parentRow(true);
    const properties = { A: SPLIT_A, B: SEL_B };
    const template = childTemplate({ Mixed: properties });
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    const { persisted } = await persistAndDesired(parent, template, properties);
    expect(persisted['A']).toBe(SPLIT_PIECE_A);
  });

  // A re-read that does NOT render back to the leaf is no re-read: the
  // collision walk counts it a slot read and withdraws, as before. A delimiter
  // in a token's TEXT no longer does that (issue #4914, the table above); one
  // cutting a PLAINTEXT does.
  it('withdraws where a Split delimiter cuts a plaintext (the re-read does not render to the leaf)', async () => {
    const properties = { A: { 'Fn::Select': [0, { 'Fn::Split': ['-', { Ref: PARAM_A }] }] }, B: SEL_B };
    const template = childTemplate({ Mixed: properties });
    const parent = parentRow(true);
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
      `postgres://${USER_EXPR}:${EXPR_B}@host`
    );
    const before = parentRow(true);
    withdrawRenderedParameterSpelling(before, PARAM_A);
    withdrawRenderedParameterSpelling(before, PARAM_B);
    const ours = await persistAndDesired(parent, template, properties);
    expect(ours).toEqual(await persistAndDesired(before, template, properties));
    expect(JSON.stringify(ours.persisted)).not.toContain(USER);
  });

  // An `Fn::If` is the persist walk's leaf, and no re-read: a Select inside
  // it reads through the slot, so the collision walk must not count it
  // positioned.
  it('withdraws where the re-readable Select sits inside an Fn::If leaf', async () => {
    const properties = { A: { 'Fn::If': ['On', SEL_A, 'z'] }, B: SEL_B };
    const template = childTemplate({ Mixed: properties });
    const parent = parentRow(true);
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
      `postgres://${USER_EXPR}:${EXPR_B}@host`
    );
    const before = parentRow(true);
    withdrawRenderedParameterSpelling(before, PARAM_A);
    withdrawRenderedParameterSpelling(before, PARAM_B);
    const ours = await persistAndDesired(parent, template, properties);
    expect(ours).toEqual(await persistAndDesired(before, template, properties));
    expect(ours.persisted).toEqual(ours.desired);
  });

  // An array holding an element that can resolve to `AWS::NoValue` shrinks
  // in the bag, so the persist walk value-scans the WHOLE array from the slot:
  // a re-read or bare `{Ref}` inside it is a slot read, and the walk withdraws.
  for (const [shape, inner, shrinker] of [
    ['a re-readable Select', SEL_A, { 'Fn::If': ['Off', 'x', { Ref: 'AWS::NoValue' }] }],
    ['a bare Ref', { Ref: PARAM_A }, { 'Fn::If': ['Off', 'x', { Ref: 'AWS::NoValue' }] }],
    ['a re-readable Select beside a bare AWS::NoValue', SEL_A, { Ref: 'AWS::NoValue' }],
  ] as const) {
    for (const reversed of [true, false]) {
      it(`withdraws for ${shape} in an array that can shrink (${reversed ? 'reversed' : 'forward'})`, async () => {
        const properties = {
          L: [shrinker, inner],
          B: SEL_B,
        };
        const template = {
          ...childTemplate({ Mixed: properties }),
          Conditions: { Off: { 'Fn::Equals': ['a', 'b'] } },
        } as CloudFormationTemplate;
        const parent = parentRow(reversed);
        poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
        const before = parentRow(reversed);
        withdrawRenderedParameterSpelling(before, PARAM_A);
        withdrawRenderedParameterSpelling(before, PARAM_B);
        expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
          redactInheritedParameterValue(before, PARAM_A, CONN)
        );
        const conditions = { Off: false };
        const run = async (row: RecordedSecretValues) => {
          const recordedSecretValues = new Map<string, string>();
          inheritNestedStackParameterAssociations(recordedSecretValues, row);
          const resolvedProps = await resolver.resolve(properties, {
            template, resources: {}, parameters: PARAMETERS, recordedSecretValues,
            inheritedSecrets: row, conditions,
          } as unknown as ResolverContext);
          const engine = { options: { inheritedSecrets: row } } as unknown as DeployEngine;
          const desired = await resolver.resolve(properties, {
            template, resources: {}, parameters: redactParametersForDiff.call(engine, PARAMETERS),
            skipDynamicReferences: true, conditions,
          } as unknown as ResolverContext);
          return { persisted: redactSecretsForState(resolvedProps, recordedSecretValues, properties), desired };
        };
        const ours = await run(parent);
        expect(ours).toEqual(await run(before));
        if (reversed) expect(ours.persisted).toEqual(ours.desired);
        expect(JSON.stringify(ours.persisted)).not.toContain(SHARED);
      });
    }
  }

  // A PUBLIC parameter read beside the literal: the re-read must bind it
  // too, so every parameter this resource reads is recorded, secret or not.
  for (const reversed of [true, false]) {
    it(`re-reads a leaf joining a public parameter with the literal (${reversed ? 'reversed' : 'forward'})`, async () => {
      const PUB = 'Pub';
      const params = { ...PARAMETERS, [PUB]: 'pub-' };
      const properties = {
        A: {
          'Fn::Select': [0, { 'Fn::Split': ['@', { 'Fn::Join': ['', [{ Ref: PUB }, { Ref: PARAM_A }]] }] }],
        },
        B: SEL_B,
      };
      const template = {
        Parameters: {
          [PARAM_A]: { Type: 'String' },
          [PARAM_B]: { Type: 'String' },
          [PUB]: { Type: 'String' },
        },
        Resources: { Mixed: { Type: 'AWS::SSM::Parameter', Properties: properties } },
      } as CloudFormationTemplate;
      const parent = parentRow(reversed);
      poisonRenderedSpellingsCollidingIn(template, params, parent);
      expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
      const recordedSecretValues = new Map<string, string>();
      inheritNestedStackParameterAssociations(recordedSecretValues, parent);
      const resolved = await resolver.resolve(properties, {
        template,
        resources: {},
        parameters: params,
        recordedSecretValues,
        inheritedSecrets: parent,
        conditions: CONDITIONS,
      } as unknown as ResolverContext);
      const persisted = redactSecretsForState(resolved, recordedSecretValues, properties);
      const engine = { options: { inheritedSecrets: parent } } as unknown as DeployEngine;
      const desired = await resolver.resolve(properties, {
        template,
        resources: {},
        parameters: redactParametersForDiff.call(engine, params),
        skipDynamicReferences: true,
        conditions: CONDITIONS,
      } as unknown as ResolverContext);
      expect(persisted).toEqual(desired);
      expect((persisted as Record<string, unknown>)['A']).toBe(`pub-postgres://${USER_EXPR}:${EXPR_A}`);
      expect(JSON.stringify(persisted)).not.toContain(SHARED);
    });
  }

  it('keeps each spelling in one Fn::Split leaf reading both parameters', async () => {
    const properties = { L: { 'Fn::Split': [',', { 'Fn::Join': [',', [{ Ref: PARAM_A }, { Ref: PARAM_B }]] }] } };
    const template = childTemplate({ Mixed: properties });
    for (const reversed of [true, false]) {
      const parent = parentRow(reversed);
      poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
      const { persisted, desired } = await persistAndDesired(parent, template, properties);
      expect(persisted).toEqual(desired);
      expect(persisted['L']).toEqual([SPELLING, EXPR_B]);
    }
  });
});

describe('positionByParameterReread refuses what it cannot certify (#4731)', () => {
  /** Resolve `properties` as a child resource and return its bag and resolved bag. */
  async function resolved(
    parent: RecordedSecretValues,
    properties: Record<string, unknown>
  ): Promise<{ bag: RecordedSecretValues; value: Record<string, unknown> }> {
    const bag = new Map<string, string>();
    inheritNestedStackParameterAssociations(bag, parent);
    const value = (await resolver.resolve(properties, {
      template: childTemplate({ R: properties }),
      resources: {},
      parameters: PARAMETERS,
      recordedSecretValues: bag,
      inheritedSecrets: parent,
      conditions: CONDITIONS,
    } as unknown as ResolverContext)) as Record<string, unknown>;
    return { bag, value };
  }

  it('answers the certified leaf (the positive control)', async () => {
    const parent = parentRow(true);
    const { bag, value } = await resolved(parent, { A: SEL_A });
    expect(positionByParameterReread(value['A'], SEL_A, bag)).toBe(SPELLING);
  });

  it('refuses a leaf the source does not evaluate to', async () => {
    const parent = parentRow(true);
    const { bag } = await resolved(parent, { A: SEL_A });
    expect(positionByParameterReread(`${CONN}x`, SEL_A, bag)).toBeUndefined();
  });

  it('refuses a source naming a parameter this resource did not read', async () => {
    const parent = parentRow(true);
    const { bag, value } = await resolved(parent, { A: SEL_A });
    const source = { 'Fn::Select': [0, [{ Ref: PARAM_A }, { Ref: PARAM_B }]] };
    expect(positionByParameterReread(value['A'], source, bag)).toBeUndefined();
  });

  it('refuses a bag with no reads record', async () => {
    const parent = parentRow(true);
    const { value } = await resolved(parent, { A: SEL_A });
    expect(positionByParameterReread(value['A'], SEL_A, new Map())).toBeUndefined();
  });

  it('refuses a reads record holding two values for one parameter', async () => {
    const parent = parentRow(true);
    const { bag, value } = await resolved(parent, { A: SEL_A });
    recordInheritedParameterValue(bag, parent, PARAM_A, 'another-value');
    expect(positionByParameterReread(value['A'], SEL_A, bag)).toBeUndefined();
  });

  // Two child-only plaintexts: one inside the parent's plaintext, which the
  // answer no longer spells (only the child-only check sees it), and one in
  // the literal text, which the answer keeps (the re-scan sees it too).
  for (const childOnly of ['c0llide-pl4in', 'postgres']) {
    it(`refuses a child-only plaintext in the leaf (${childOnly})`, async () => {
      const parent = parentRow(true);
      const { bag, value } = await resolved(parent, { A: SEL_A });
      bag.set(childOnly, '{{resolve:secretsmanager:child-only:SecretString:x::}}');
      expect(positionByParameterReread(value['A'], SEL_A, bag)).toBeUndefined();
    });
  }

  it('refuses a source holding no Fn::Select / Fn::Split (another arm answers it)', async () => {
    const parent = parentRow(true);
    const { bag, value } = await resolved(parent, { A: SEL_A });
    const join = { 'Fn::Join': ['', [{ Ref: PARAM_A }]] };
    expect(positionByParameterReread(value['A'], join, bag)).toBeUndefined();
  });

  for (const [shape, source] of Object.entries({
    'an index out of bounds': { 'Fn::Select': [1, [{ Ref: PARAM_A }]] },
    'a non-literal index': { 'Fn::Select': [{ Ref: PARAM_A }, [{ Ref: PARAM_A }]] },
    'a leading-zero index': { 'Fn::Select': ['00', [{ Ref: PARAM_A }]] },
    'a {{resolve: literal': { 'Fn::Select': [0, [{ Ref: PARAM_A }, EXPR_A]] },
    // JavaScript would split on `"null"` and so render the leaf back.
    // A list reaches `Fn::Split`: JavaScript arrays have no `split`, so the
    // collision walk, which runs before any resolution, would throw.
    'a list to split': { 'Fn::Select': [0, { 'Fn::Split': [',', ['a', 'b']] }] },
    'a non-string delimiter': { 'Fn::Select': [0, { 'Fn::Split': [null, { Ref: PARAM_A }] }] },
    // JavaScript would join `[[CONN]]` to `CONN`.
    'an array part in Fn::Join': {
      'Fn::Select': [0, [{ 'Fn::Join': ['', [[{ Ref: PARAM_A }]]] }]],
    },
    'an Fn::If': { 'Fn::Select': [0, [{ 'Fn::If': ['On', { Ref: PARAM_A }, 'z'] }]] },
    'a pseudo parameter': { 'Fn::Select': [0, [{ Ref: 'AWS::Region' }]] },
    'a two-key object': { 'Fn::Select': [0, [{ Ref: PARAM_A }]], Extra: 1 },
  })) {
    it(`refuses ${shape}`, async () => {
      const parent = parentRow(true);
      const { bag, value } = await resolved(parent, { A: SEL_A });
      expect(positionByParameterReread(value['A'], source, bag)).toBeUndefined();
    });
  }
});

describe('rereadParameterExpression keeps a parent plaintext out of a piece no token reached (#4731)', () => {
  it('refuses a piece equal to a short plaintext the binding left in place', () => {
    // `ab` is below the substring floor, so the parent scan leaves it inside
    // `ab:cd` (the binding), but takes it WHOLE: the piece is a plaintext.
    const parent: RecordedSecretValues = new Map();
    const token = '{{resolve:secretsmanager:short:SecretString:x::}}';
    parent.set('ab', token);
    recordResolvedPair(parent, token, 'ab');
    const bind = (name: string): { value: unknown } | undefined =>
      name === 'X' ? { value: 'ab:cd' } : undefined;
    expect(redactInheritedParameterValue(parent, 'X', 'ab:cd')).toBe('ab:cd');
    const piece = (index: number): unknown => ({
      'Fn::Select': [index, { 'Fn::Split': [':', { Ref: 'X' }] }],
    });
    expect(rereadParameterExpression(piece(0), bind, parent)).toBeUndefined();
    // The control: the other piece holds no plaintext.
    expect(rereadParameterExpression(piece(1), bind, parent)).toEqual({ resolved: 'cd', redacted: 'cd' });
  });
});
