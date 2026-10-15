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
 * Since issue #4919 that covers an `Fn::Sub` under `Fn::Select`, an `Fn::If`
 * whose leaf names its branch, and a bag array that drops an `AWS::NoValue`
 * element. A slot read the persist walk cannot re-read (an intrinsic the
 * re-read does not evaluate, an `Fn::If` whose branches the leaf cannot tell
 * apart, a delimiter cutting a plaintext) still makes
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
import {
  arrayPairsWhateverDrops,
  sourceElementsKeptFor,
} from '../../../src/deployment/secret-redaction/redact-path.js';
import { TEMPLATE_SOURCED_RULES } from '../../../src/deployment/secret-redaction/rules.js';
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
/** Re-read since issue #4919: an `Fn::Sub` under `Fn::Select`. */
const SUB_SEL_A = { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_A}}` }]] };
const SUB_SEL_B = { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_B}}` }]] };
/**
 * Slot reads no re-read evaluates: an `Fn::Select` over a list holding an
 * intrinsic the re-read does not evaluate (`Fn::Base64`).
 */
const OPAQUE_SEL_A = { 'Fn::Select': [0, [{ Ref: PARAM_A }, { 'Fn::Base64': 'x' }]] };
const OPAQUE_SEL_B = { 'Fn::Select': [0, [{ Ref: PARAM_B }, { 'Fn::Base64': 'x' }]] };
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
        const properties = literalLast ? { B: OPAQUE_SEL_B, A: OPAQUE_SEL_A } : { A: OPAQUE_SEL_A, B: OPAQUE_SEL_B };
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
    const template = childTemplate({ Mixed: { A: OPAQUE_SEL_A, B: OPAQUE_SEL_B }, Alone: { A: SEL_A } });
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    const { persisted, desired } = await persistAndDesired(parent, template, { A: SEL_A });
    expect(persisted).toEqual(desired);
    expect(desired['A']).toBe(`postgres://${USER_EXPR}:${EXPR_B}@host`);
  });

  it('a SIBLING child of the same parent, reading only the literal, keeps the #4644 fix', async () => {
    // Two nested-stack rows: two bags. Only the mixed child's is withdrawn.
    const mixedRow = parentRow(true);
    const plainRow = parentRow(true);
    poisonRenderedSpellingsCollidingIn(childTemplate({ Mixed: { A: OPAQUE_SEL_A, B: OPAQUE_SEL_B } }), PARAMETERS, mixedRow);
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
      poisonRenderedSpellingsCollidingIn(childTemplate({ Mixed: { A: OPAQUE_SEL_A, B: subRead } }), PARAMETERS, parent);
      expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
        `postgres://${USER_EXPR}:${EXPR_B}@host`
      );
    }
    // A literal `${!Name}` is no read.
    const parent = parentRow(true);
    poisonRenderedSpellingsCollidingIn(
      childTemplate({ Mixed: { A: OPAQUE_SEL_A, B: { 'Fn::Sub': `x-\${!${PARAM_B}}` } } }),
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
    'bare SecretB, then opaque Select ConnA': { B: { Ref: PARAM_B }, A: OPAQUE_SEL_A },
    'opaque Select ConnA, then bare SecretB': { A: OPAQUE_SEL_A, B: { Ref: PARAM_B } },
    'bare ConnA, then opaque Select SecretB': { A: { Ref: PARAM_A }, B: OPAQUE_SEL_B },
    'opaque Select SecretB, then bare ConnA': { B: OPAQUE_SEL_B, A: { Ref: PARAM_A } },
    'opaque Select SecretB, then ConnA in a plain array': { B: OPAQUE_SEL_B, A: [{ Ref: PARAM_A }] },
    'opaque Select SecretB, then ConnA in a plain object': { B: OPAQUE_SEL_B, A: { K: { Ref: PARAM_A } } },
    // A re-read (issue #4919) is positioned but still WRITES the slot, so a
    // slot read of the other parameter beside it collides too.
    'Sub-in-Select ConnA, then opaque Select SecretB': { A: SUB_SEL_A, B: OPAQUE_SEL_B },
    'Fn::If over ConnA, then opaque Select SecretB': {
      A: { 'Fn::If': ['On', { Ref: PARAM_A }, 'z'] },
      B: OPAQUE_SEL_B,
    },
    'ConnA in a shrinkable array, then opaque Select SecretB': {
      A: [{ Ref: 'AWS::NoValue' }, { Ref: PARAM_A }],
      B: OPAQUE_SEL_B,
    },
    // An `Fn::If` branch holding an array no re-read evaluates is
    // value-scanned, so that `Fn::If` is a slot read; the other side of the
    // collision is positioned.
    'Fn::If array of opaque SecretB, then bare ConnA': {
      B: { 'Fn::If': ['On', [OPAQUE_SEL_B], 'z'] },
      A: { Ref: PARAM_A },
    },
    'Fn::Join of ConnA, then Fn::If array of opaque SecretB': {
      A: { 'Fn::Join': ['', ['x-', { Ref: PARAM_A }]] },
      B: { 'Fn::If': ['On', [OPAQUE_SEL_B], 'z'] },
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
      const selD = { 'Fn::Select': [0, [{ Ref: PARAM_D }, { 'Fn::Base64': 'x' }]] };
      const other = dFirst ? { D: selD, A: OPAQUE_SEL_A } : { A: OPAQUE_SEL_A, D: selD };
      const template = childTemplate({ Mixed: { A: OPAQUE_SEL_A, B: OPAQUE_SEL_B }, Other: other });
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
      [{ OA: { Value: OPAQUE_SEL_A }, OB: { Value: { Ref: PARAM_B } } }, true],
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
        Mixed: { A: OPAQUE_SEL_A, C: { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_C}}` }]] } },
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

  // An `Fn::If` is re-read only where its leaf names its branch (issue
  // #4919). Here both branches resolve to the shared plaintext, spelled
  // `EXPR_B` (SecretB) in one and `EXPR_A` (a piece of ConnA) in the other:
  // the leaf cannot say which, so the collision walk counts it a slot read.
  it('withdraws where an Fn::If leaf cannot name its branch', async () => {
    const piece = {
      'Fn::Select': [0, { 'Fn::Split': ['@', { 'Fn::Select': [2, { 'Fn::Split': [':', { Ref: PARAM_A }] }] }] }],
    };
    const properties = { A: { 'Fn::If': ['On', SEL_B, piece] }, B: SEL_B };
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
  // in the bag. The persist walk pairs the rest only where the count says
  // which dropped (issue #4919); with two `Fn::If` elements one of which
  // drops, or an element it cannot classify, it value-scans the WHOLE array
  // from the slot: a re-read or bare `{Ref}` inside it is a slot read, and the
  // walk withdraws.
  const IF_ON = { 'Fn::If': ['On', 'y', { Ref: 'AWS::NoValue' }] };
  const IF_OFF = { 'Fn::If': ['Off', 'x', { Ref: 'AWS::NoValue' }] };
  // A `{{resolve:` literal kept beside the drop (a public reference, or one
  // embedded in text) has no pair the persist pairing can corroborate, so
  // the array is value-scanned and the walk withdraws, whichever parent order.
  for (const literal of ['{{resolve:ssm:/public/x}}', `--x=${EXPR_A}`]) {
    for (const reversed of [true, false]) {
      it(`withdraws for a shrinkable array holding ${literal.startsWith('--') ? 'an embedded' : 'a public'} {{resolve: literal (${reversed ? 'reversed' : 'forward'})`, () => {
        const template = {
          ...childTemplate({ Mixed: { L: [literal, IF_OFF, { Ref: PARAM_A }], B: { Ref: PARAM_B } } }),
          Conditions: { On: { 'Fn::Equals': ['a', 'a'] }, Off: { 'Fn::Equals': ['a', 'b'] } },
        } as CloudFormationTemplate;
        const parent = parentRow(reversed);
        poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
        expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
          `postgres://${USER_EXPR}:${reversed ? EXPR_B : EXPR_A}@host`
        );
        // The control: without the literal the array pairs, nothing withdrawn.
        const control = parentRow(reversed);
        poisonRenderedSpellingsCollidingIn(
          {
            ...template,
            Resources: childTemplate({ Mixed: { L: ['plain', IF_OFF, { Ref: PARAM_A }], B: { Ref: PARAM_B } } })
              .Resources,
          } as CloudFormationTemplate,
          PARAMETERS,
          control
        );
        expect(redactInheritedParameterValue(control, PARAM_A, CONN)).toBe(SPELLING);
      });
    }
  }
  for (const [shape, inner, shrinkers] of [
    ['a re-readable Select beside two Fn::If elements', SEL_A, [IF_OFF, IF_ON]],
    ['a bare Ref beside two Fn::If elements', { Ref: PARAM_A }, [IF_ON, IF_OFF]],
    [
      'a re-readable Select beside an intrinsic no count classifies',
      SEL_A,
      [IF_OFF, { 'Fn::Base64': 'x' }],
    ],
  ] as const) {
    for (const reversed of [true, false]) {
      it(`withdraws for ${shape} in an array that can shrink (${reversed ? 'reversed' : 'forward'})`, async () => {
        const properties = {
          L: [...shrinkers, inner],
          B: SEL_B,
        };
        const template = {
          ...childTemplate({ Mixed: properties }),
          Conditions: { On: { 'Fn::Equals': ['a', 'a'] }, Off: { 'Fn::Equals': ['a', 'b'] } },
        } as CloudFormationTemplate;
        const parent = parentRow(reversed);
        poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
        const before = parentRow(reversed);
        withdrawRenderedParameterSpelling(before, PARAM_A);
        withdrawRenderedParameterSpelling(before, PARAM_B);
        expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
          redactInheritedParameterValue(before, PARAM_A, CONN)
        );
        const conditions = { On: true, Off: false };
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

  it('refuses a source holding no Fn::Select / Fn::Split / Fn::If (another arm answers it)', async () => {
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
    'an intrinsic the re-read does not evaluate': OPAQUE_SEL_A,
    'a pseudo parameter in an Fn::Sub': { 'Fn::Select': [0, [{ 'Fn::Sub': `\${AWS::Region}\${${PARAM_A}}` }]] },
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

describe('Fn::If, Fn::Sub under Fn::Select and a shrinkable array keep each spelling (#4919)', () => {
  /** Conditions both sides resolve `Fn::If` with: `On` true, `Off` false. */
  const BRANCHES = { On: true, Off: false };
  const conditioned = (resources: Record<string, unknown>): CloudFormationTemplate =>
    ({
      ...childTemplate(resources),
      Conditions: { On: { 'Fn::Equals': ['a', 'a'] }, Off: { 'Fn::Equals': ['a', 'b'] } },
    }) as CloudFormationTemplate;

  /** Persist and diff one resource with {@link BRANCHES}. */
  async function run(
    parent: RecordedSecretValues,
    template: CloudFormationTemplate,
    properties: Record<string, unknown>
  ): Promise<{ persisted: Record<string, unknown>; desired: Record<string, unknown> }> {
    const recordedSecretValues = new Map<string, string>();
    inheritNestedStackParameterAssociations(recordedSecretValues, parent);
    const resolvedProps = await resolver.resolve(properties, {
      template,
      resources: {},
      parameters: PARAMETERS,
      recordedSecretValues,
      inheritedSecrets: parent,
      conditions: BRANCHES,
    } as unknown as ResolverContext);
    const engine = { options: { inheritedSecrets: parent } } as unknown as DeployEngine;
    const desired = (await resolver.resolve(properties, {
      template,
      resources: {},
      parameters: redactParametersForDiff.call(engine, PARAMETERS),
      inheritedSecrets: parent,
      skipDynamicReferences: true,
      conditions: BRANCHES,
    } as unknown as ResolverContext)) as Record<string, unknown>;
    return {
      persisted: redactSecretsForState(resolvedProps, recordedSecretValues, properties) as Record<
        string,
        unknown
      >,
      desired,
    };
  }

  const IF_NO_VALUE_OFF = { 'Fn::If': ['Off', 'x', { Ref: 'AWS::NoValue' }] };
  // Each shape reads ConnA in `A` and SecretB in `B`; both leaves are answered
  // per parameter, so nothing is withdrawn whichever parent order or read order.
  const POSITIONED_NOW: Record<string, { A: unknown; B: unknown }> = {
    'Sub-in-Select ConnA, Sub-in-Select SecretB': { A: SUB_SEL_A, B: SUB_SEL_B },
    'Sub-in-Select ConnA, bare SecretB': { A: SUB_SEL_A, B: { Ref: PARAM_B } },
    'bare ConnA, Sub-in-Select SecretB': { A: { Ref: PARAM_A }, B: SUB_SEL_B },
    'Sub with a variable map in Select ConnA, Select SecretB': {
      A: { 'Fn::Select': [0, [{ 'Fn::Sub': ['${V}', { V: { Ref: PARAM_A } }] }]] },
      B: SEL_B,
    },
    'Sub with text and an escape in Select ConnA, Select SecretB': {
      A: { 'Fn::Select': [0, [{ 'Fn::Sub': `x-\${!Lit}-\${${PARAM_A}}` }]] },
      B: SEL_B,
    },
    'Fn::If over Select ConnA (true branch), Select SecretB': {
      A: { 'Fn::If': ['On', SEL_A, 'z'] },
      B: SEL_B,
    },
    'Fn::If over bare ConnA (false branch), Fn::If over Sub-in-Select SecretB': {
      A: { 'Fn::If': ['Off', 'z', { Ref: PARAM_A }] },
      B: { 'Fn::If': ['On', SUB_SEL_B, { Ref: PARAM_A }] },
    },
    'Fn::If array of SecretB, bare ConnA': {
      A: { Ref: PARAM_A },
      B: { 'Fn::If': ['On', [{ Ref: PARAM_B }], 'z'] },
    },
    'Fn::Join around an Fn::If over ConnA, bare SecretB': {
      A: { 'Fn::Join': ['', ['x-', { 'Fn::If': ['On', { Ref: PARAM_A }, ''] }]] },
      B: { Ref: PARAM_B },
    },
    'nested Fn::If over ConnA, Select SecretB': {
      A: { 'Fn::If': ['On', { 'Fn::If': ['Off', 'z', SEL_A] }, 'y'] },
      B: SEL_B,
    },
    'a shrinkable array (Fn::If NoValue) around Select ConnA, Select SecretB': {
      A: [IF_NO_VALUE_OFF, SEL_A],
      B: SEL_B,
    },
    'a shrinkable array (Fn::If NoValue) around bare ConnA, bare SecretB': {
      A: [IF_NO_VALUE_OFF, { Ref: PARAM_A }],
      B: { Ref: PARAM_B },
    },
    'a shrinkable array (bare AWS::NoValue) around Select ConnA, Select SecretB': {
      A: [{ Ref: 'AWS::NoValue' }, SEL_A],
      B: SEL_B,
    },
    'a shrinkable array whose Fn::If is kept, bare ConnA, Select SecretB': {
      A: [{ 'Fn::If': ['On', 'x', { Ref: 'AWS::NoValue' }] }, { Ref: PARAM_A }],
      B: SEL_B,
    },
    'ConnA after a dropped AWS::NoValue and a dropped Fn::If, Select SecretB': {
      A: [{ Ref: 'AWS::NoValue' }, { Ref: PARAM_A }, IF_NO_VALUE_OFF],
      B: SEL_B,
    },
    // The CDK `Fn.conditionIf(cond, secret, Aws.NO_VALUE)` element: the
    // droppable element itself carries the read.
    'Fn::If(ConnA, NoValue) kept in an array beside a literal, bare SecretB': {
      A: [{ 'Fn::If': ['On', { Ref: PARAM_A }, { Ref: 'AWS::NoValue' }] }, 'lit'],
      B: { Ref: PARAM_B },
    },
    'Fn::If(Select ConnA, NoValue) kept alone in an array, Select SecretB': {
      A: [{ 'Fn::If': ['On', SEL_A, { Ref: 'AWS::NoValue' }] }],
      B: SEL_B,
    },
    'Fn::If(NoValue, ConnA) kept on its false branch beside a literal, bare SecretB': {
      A: [{ 'Fn::If': ['Off', { Ref: 'AWS::NoValue' }, { Ref: PARAM_A }] }, 'x'],
      B: { Ref: PARAM_B },
    },
    'Fn::If array of ConnA, bare SecretB': {
      A: { 'Fn::If': ['On', [{ Ref: PARAM_A }], 'z'] },
      B: { Ref: PARAM_B },
    },
    'SecretB in a shrinkable array, Sub-in-Select ConnA': {
      A: SUB_SEL_A,
      B: [IF_NO_VALUE_OFF, { Ref: PARAM_B }],
    },
  };
  for (const reversed of [true, false]) {
    for (const literalLast of [true, false]) {
      for (const [shape, { A, B }] of Object.entries(POSITIONED_NOW)) {
        it(`${reversed ? 'reversed' : 'forward'} parent order, ${literalLast ? 'literal' : 'sibling'} read last, ${shape}`, async () => {
          const properties = literalLast ? { B, A } : { A, B };
          const template = conditioned({ Mixed: properties });
          const parent = parentRow(reversed);
          poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
          // Nothing withdrawn: the diff side binds the literal.
          expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
          const { persisted, desired } = await run(parent, template, properties);
          expect(persisted).toEqual(desired);
          const a = JSON.stringify(persisted['A']);
          expect(a).toContain(EXPR_A);
          expect(a).not.toContain(EXPR_B);
          expect(JSON.stringify(persisted['B'])).toContain(EXPR_B);
          expect(JSON.stringify(persisted)).not.toContain(SHARED);
          expect(JSON.stringify(persisted)).not.toContain(USER);
        });
      }
    }
  }
});

describe('the #4919 re-read and array pairing refuse what they cannot certify', () => {
  const bind = (name: string): { value: unknown } | undefined =>
    Object.hasOwn(PARAMETERS, name) ? { value: (PARAMETERS as Record<string, unknown>)[name] } : undefined;

  it('re-reads an Fn::If whose every branch re-reads, whichever branch a leaf took', () => {
    const parent = parentRow(true);
    expect(rereadParameterExpression({ 'Fn::If': ['On', SEL_A, 'z'] }, bind, parent)).toBeDefined();
    // A branch dropping out on both sides is no refusal.
    expect(
      rereadParameterExpression({ 'Fn::If': ['On', { Ref: 'AWS::NoValue' }, SEL_B] }, bind, parent)
    ).toEqual({ resolved: SHARED, redacted: EXPR_B });
  });

  it('refuses an Fn::If whose leaf cannot name its branch (equal values, different spellings)', () => {
    const parent = parentRow(true);
    const piece = {
      'Fn::Select': [0, { 'Fn::Split': ['@', { 'Fn::Select': [2, { 'Fn::Split': [':', { Ref: PARAM_A }] }] }] }],
    };
    expect(rereadParameterExpression(piece, bind, parent)).toEqual({ resolved: SHARED, redacted: EXPR_A });
    expect(rereadParameterExpression({ 'Fn::If': ['On', SEL_B, piece] }, bind, parent)).toBeUndefined();
    // One condition name takes one branch per pass: the same name twice is
    // never the mixed assignment.
    expect(
      rereadParameterExpression(
        { 'Fn::Join': ['', [{ 'Fn::If': ['On', SEL_B, 'x'] }, { 'Fn::If': ['On', 'y', piece] }]] },
        bind,
        parent
      )
    ).toBeDefined();
  });

  it('refuses an Fn::If with a branch no re-read evaluates, or a malformed one', () => {
    const parent = parentRow(true);
    for (const source of [
      { 'Fn::If': ['On', SEL_A, OPAQUE_SEL_B] },
      { 'Fn::If': ['On', SEL_A, { K: 'object branch' }] },
      // A branch reading something no binding answers (a resource, a pseudo
      // parameter): if the pass took it, the leaf names no re-read.
      { 'Fn::If': ['On', SEL_A, { Ref: 'SomeResource' }] },
      { 'Fn::If': ['On', { Ref: 'AWS::Region' }, SEL_A] },
      { 'Fn::If': ['On', SEL_A] },
      { 'Fn::If': [{ Condition: 'On' }, SEL_A, 'z'] },
      // `AWS::NoValue` inside an argument, not passed up by an `Fn::If`: the
      // resolver drops it from the list, so index 1 is out of bounds there.
      { 'Fn::Select': [1, [{ Ref: 'AWS::NoValue' }, { Ref: PARAM_A }]] },
      { 'Fn::Select': [1, [{ 'Fn::If': ['On', { Ref: 'AWS::NoValue' }, 'z'] }, { Ref: PARAM_A }]] },
    ]) {
      expect(rereadParameterExpression(source, bind, parent)).toBeUndefined();
    }
  });

  it('refuses more than four condition names, and re-reads four', () => {
    const parent = parentRow(true);
    const nest = (names: string[]): unknown =>
      names.reduce<unknown>((inner, name) => ({ 'Fn::If': [name, inner, inner] }), SEL_A);
    expect(rereadParameterExpression(nest(['C1', 'C2', 'C3', 'C4']), bind, parent)).toBeDefined();
    expect(rereadParameterExpression(nest(['C1', 'C2', 'C3', 'C4', 'C5']), bind, parent)).toBeUndefined();
  });

  it('evaluates Fn::Sub as the resolver does, and refuses what it cannot', () => {
    const parent = parentRow(true);
    const sel = (sub: unknown): unknown => ({ 'Fn::Select': [0, [{ 'Fn::Sub': sub }]] });
    expect(rereadParameterExpression(sel(`a-\${!X}-\${}-\${${PARAM_B}}`), bind, parent)).toEqual({
      resolved: `a-\${X}-\${}-${SHARED}`,
      redacted: `a-\${X}-\${}-${EXPR_B}`,
    });
    // A variable-map name takes the variable, even one naming a parameter.
    expect(
      rereadParameterExpression(sel([`\${${PARAM_B}}`, { [PARAM_B]: { Ref: PARAM_A } }]), bind, parent)
    ).toEqual({ resolved: CONN, redacted: SPELLING });
    for (const sub of [
      `\${AWS::Region}`,
      `\${Res.Attr}`,
      `\${ Missing }`,
      `\${${PARAM_B}}${EXPR_A}`,
      [`\${V}`, { V: ['a list'] }],
      [`\${V}`, { V: OPAQUE_SEL_A }],
      [`\${V}`, 'not a map'],
      [`\${V}`, {}, 'extra'],
    ]) {
      expect(rereadParameterExpression(sel(sub), bind, parent)).toBeUndefined();
    }
  });

  it('positions an Fn::If leaf by the branch the leaf names, reading only the taken branch', async () => {
    const parent = parentRow(true);
    const source = { 'Fn::If': ['Off', { Ref: PARAM_B }, SUB_SEL_A] };
    const bag = new Map<string, string>();
    inheritNestedStackParameterAssociations(bag, parent);
    const value = (await resolver.resolve(
      { A: source },
      {
        template: childTemplate({ R: { A: source } }),
        resources: {},
        parameters: PARAMETERS,
        recordedSecretValues: bag,
        inheritedSecrets: parent,
        conditions: { Off: false },
      } as unknown as ResolverContext
    )) as Record<string, unknown>;
    // SecretB was never read: the true branch does not bind, so it is not a
    // candidate, and the false branch is the one the leaf names.
    expect(positionByParameterReread(value['A'], source, bag)).toBe(SPELLING);
    expect(positionByParameterReread(`${CONN}x`, source, bag)).toBeUndefined();
    // Both branches binding to the leaf with different spellings: refused.
    recordInheritedParameterValue(bag, parent, PARAM_B, SHARED);
    const piece = {
      'Fn::Select': [0, { 'Fn::Split': ['@', { 'Fn::Select': [2, { 'Fn::Split': [':', { Ref: PARAM_A }] }] }] }],
    };
    expect(positionByParameterReread(SHARED, { 'Fn::If': ['On', { Ref: PARAM_B }, piece] }, bag)).toBeUndefined();
  });

  it('refuses an Fn::If leaf whose taken branch no re-read evaluates, though another branch matches', async () => {
    const parent = parentRow(false);
    // The taken (false) branch derives the shared plaintext from ConnA
    // through an intrinsic the re-read does not evaluate; the untaken branch
    // reads SecretB, which this resource reads elsewhere, to the same value.
    const opaquePiece = {
      'Fn::Select': [
        0,
        [
          { 'Fn::Select': [0, { 'Fn::Split': ['@', { 'Fn::Select': [2, { 'Fn::Split': [':', { Ref: PARAM_A }] }] }] }] },
          { 'Fn::Base64': 'x' },
        ],
      ],
    };
    const source = { 'Fn::If': ['Off', { Ref: PARAM_B }, opaquePiece] };
    const properties = { A: source, O: { Ref: PARAM_B } };
    const bag = new Map<string, string>();
    inheritNestedStackParameterAssociations(bag, parent);
    const value = (await resolver.resolve(properties, {
      template: childTemplate({ R: properties }),
      resources: {},
      parameters: PARAMETERS,
      recordedSecretValues: bag,
      inheritedSecrets: parent,
      conditions: { Off: false },
    } as unknown as ResolverContext)) as Record<string, unknown>;
    expect(value['A']).toBe(SHARED);
    expect(positionByParameterReread(value['A'], source, bag)).toBeUndefined();
    // A taken branch over a resource or pseudo `Ref` is no unread parameter:
    // the leaf refuses rather than take the SecretB branch that equals it.
    for (const other of [{ Ref: 'SomeResource' }, { Ref: 'AWS::Region' }]) {
      expect(positionByParameterReread(SHARED, { 'Fn::If': ['On', other, { Ref: PARAM_B }] }, bag)).toBeUndefined();
    }
    // The positive control: both branches read parameters, and the leaf names
    // the SecretB one.
    expect(positionByParameterReread(SHARED, { 'Fn::If': ['On', { Ref: PARAM_A }, { Ref: PARAM_B }] }, bag)).toBe(
      EXPR_B
    );
    // A malformed `Fn::If` in the untaken branch refuses the leaf too.
    const malformed = { 'Fn::If': ['On', SEL_A, { 'Fn::If': [{ x: 1 }, 'a', 'b'] }] };
    const { bag: selBag, value: selValue } = await (async () => {
      const b = new Map<string, string>();
      inheritNestedStackParameterAssociations(b, parent);
      const v = (await resolver.resolve(
        { A: SEL_A },
        {
          template: childTemplate({ R: { A: SEL_A } }),
          resources: {},
          parameters: PARAMETERS,
          recordedSecretValues: b,
          inheritedSecrets: parent,
          conditions: CONDITIONS,
        } as unknown as ResolverContext
      )) as Record<string, unknown>;
      return { bag: b, value: v };
    })();
    expect(positionByParameterReread(selValue['A'], { 'Fn::If': ['On', SEL_A, 'z'] }, selBag)).toBe(SPELLING);
    expect(positionByParameterReread(selValue['A'], malformed, selBag)).toBeUndefined();
  });

  it('poisons a reads record handed two different declared-parameter sets, not one read twice', async () => {
    const parent = parentRow(true);
    const resolveOnto = async (bag: RecordedSecretValues, template: CloudFormationTemplate): Promise<unknown> =>
      ((await resolver.resolve(
        { A: SEL_A },
        {
          template,
          resources: {},
          parameters: PARAMETERS,
          recordedSecretValues: bag,
          inheritedSecrets: parent,
          conditions: CONDITIONS,
        } as unknown as ResolverContext
      )) as Record<string, unknown>)['A'];
    // The same template read twice (one cached set), and an equal set from
    // another `Parameters` object: the record stands.
    const same = new Map<string, string>();
    inheritNestedStackParameterAssociations(same, parent);
    const template = childTemplate({ R: { A: SEL_A } });
    await resolveOnto(same, template);
    const leaf = await resolveOnto(same, template);
    await resolveOnto(same, childTemplate({ R: { A: SEL_A } }));
    expect(positionByParameterReread(leaf, SEL_A, same)).toBe(SPELLING);
    // A different declared set on the same bag: the record is poisoned.
    const mixed = new Map<string, string>();
    inheritNestedStackParameterAssociations(mixed, parent);
    const mixedLeaf = await resolveOnto(mixed, template);
    await resolveOnto(mixed, {
      ...template,
      Parameters: { ...template.Parameters, Extra: { Type: 'String' } },
    } as CloudFormationTemplate);
    expect(positionByParameterReread(mixedLeaf, SEL_A, mixed)).toBeUndefined();
    // Directly, through the recorder, on a bag holding the carried pairs.
    const direct = new Map<string, string>([
      [USER, USER_EXPR],
      [SHARED, EXPR_A],
    ]);
    recordInheritedParameterValue(direct, parent, PARAM_A, CONN, new Set([PARAM_A, PARAM_B]));
    expect(positionByParameterReread(CONN, SEL_A, direct)).toBe(SPELLING);
    recordInheritedParameterValue(direct, parent, PARAM_B, SHARED, new Set([PARAM_A]));
    expect(positionByParameterReread(CONN, SEL_A, direct)).toBeUndefined();
  });

  it('pairs a shrunken array only where the count says which elements dropped', () => {
    const IF_ON = { 'Fn::If': ['On', 'y', { Ref: 'AWS::NoValue' }] };
    const NO_VALUE = { Ref: 'AWS::NoValue' };
    expect(sourceElementsKeptFor([IF_ON, 'a'], 1)).toEqual(['a']);
    expect(sourceElementsKeptFor([IF_ON, 'a'], 2)).toEqual([IF_ON, 'a']);
    expect(sourceElementsKeptFor([NO_VALUE, IF_ON, 'a'], 2)).toEqual([IF_ON, 'a']);
    expect(sourceElementsKeptFor([NO_VALUE, IF_ON, 'a'], 1)).toEqual(['a']);
    // Two conditional elements, one dropped: either could be the one.
    expect(sourceElementsKeptFor([IF_ON, IF_ON, 'a'], 2)).toBeUndefined();
    expect(sourceElementsKeptFor([IF_ON, IF_ON, 'a'], 1)).toEqual(['a']);
    // A count no outcome produces.
    expect(sourceElementsKeptFor([NO_VALUE, 'a', 'b'], 1)).toBeUndefined();
    // An element nothing here classifies, a multi-key `Fn::If`, a malformed one.
    for (const odd of [
      { 'Fn::FindInMap': ['M', 'a', 'b'] },
      { 'Fn::If': ['On', 'y', NO_VALUE], Extra: 1 },
      { 'Fn::If': ['On', 'y'] },
      { 'Fn::If': ['On', { 'Fn::Base64': 'x' }, NO_VALUE] },
    ]) {
      expect(sourceElementsKeptFor([IF_ON, odd, 'a'], 2)).toBeUndefined();
    }
    // `Ref` is dispatched first; an `Fn::If` neither of whose branches drops
    // never drops; one whose branches both do always does.
    expect(sourceElementsKeptFor([{ Ref: 'AWS::NoValue', 'Fn::If': ['On', 'a', 'b'] }, 'a'], 1)).toEqual(['a']);
    expect(sourceElementsKeptFor([{ 'Fn::If': ['On', 'a', 'b'] }, NO_VALUE], 1)).toEqual([
      { 'Fn::If': ['On', 'a', 'b'] },
    ]);
    expect(sourceElementsKeptFor([{ 'Fn::If': ['On', NO_VALUE, NO_VALUE] }, 'a'], 1)).toEqual(['a']);

    expect(arrayPairsWhateverDrops(['a', { 'Fn::FindInMap': ['M', 'a', 'b'] }])).toBe(true);
    // `resolveFindInMap` can return `AWS::NoValue` through a `DefaultValue`.
    expect(
      arrayPairsWhateverDrops(['a', { 'Fn::FindInMap': ['M', 'a', 'b', { DefaultValue: NO_VALUE }] }])
    ).toBe(false);
    expect(arrayPairsWhateverDrops([IF_ON, NO_VALUE, NO_VALUE, 'a'])).toBe(true);
    expect(arrayPairsWhateverDrops([IF_ON, IF_ON, 'a'])).toBe(false);
    expect(arrayPairsWhateverDrops([IF_ON, { 'Fn::FindInMap': ['M', 'a', 'b'] }])).toBe(false);
    expect(arrayPairsWhateverDrops([{ 'Fn::If': ['On', 'y', NO_VALUE], Extra: 1 }])).toBe(false);
    // A kept object the persist corroboration cannot accept on every outcome:
    // a property an `Fn::FindInMap` `DefaultValue` can drop, an intrinsic key
    // beside others. A plain object with intrinsic leaves pairs.
    expect(
      arrayPairsWhateverDrops([IF_ON, { K: { 'Fn::FindInMap': ['M', 'a', 'b', { DefaultValue: NO_VALUE }] } }])
    ).toBe(false);
    expect(
      arrayPairsWhateverDrops([
        IF_ON,
        { K: { 'Fn::If': ['On', 'a', { 'Fn::FindInMap': ['M', 'a', 'b', { DefaultValue: NO_VALUE }] }] } },
      ])
    ).toBe(false);
    expect(arrayPairsWhateverDrops([IF_ON, { Ref: 'P', X: 1 }])).toBe(false);
    expect(arrayPairsWhateverDrops([IF_ON, { K: { Ref: 'P' }, L: 'x' }])).toBe(true);
  });

  it('pairs a shrunken array only on a bag resolved from the source (descendArrays)', async () => {
    const parent = parentRow(true);
    const properties = { L: [{ Ref: 'AWS::NoValue' }, { Ref: PARAM_A }], B: { Ref: PARAM_B } };
    const recordedSecretValues = new Map<string, string>();
    inheritNestedStackParameterAssociations(recordedSecretValues, parent);
    const resolvedProps = (await resolver.resolve(properties, {
      template: childTemplate({ R: properties }),
      resources: {},
      parameters: PARAMETERS,
      recordedSecretValues,
      inheritedSecrets: parent,
      conditions: CONDITIONS,
    } as unknown as ResolverContext)) as Record<string, unknown>;
    // The resource read SecretB last, so the slot holds `EXPR_B`.
    const derived = redactSecretsForState(resolvedProps, recordedSecretValues, properties) as Record<string, unknown>;
    expect(derived['L']).toEqual([SPELLING]);
    const sourced = redactSecretsForState(
      resolvedProps,
      recordedSecretValues,
      properties,
      TEMPLATE_SOURCED_RULES
    ) as Record<string, unknown>;
    expect(sourced['L']).toEqual([`postgres://${USER_EXPR}:${EXPR_B}@host`]);
  });

  it("pairs a shrunken array in any stack's resource, so a {{resolve:...}} element keeps its own spelling", () => {
    // Two references, one plaintext; the map's survivor is `EXPR_B`.
    const secrets: RecordedSecretValues = new Map();
    for (const expression of [EXPR_A, EXPR_B]) {
      secrets.set(SHARED, expression);
      recordResolvedPair(secrets, expression, SHARED);
    }
    const source = { L: [{ 'Fn::If': ['Off', 'x', { Ref: 'AWS::NoValue' }] }, EXPR_A], M: EXPR_B };
    const bag = { L: [SHARED], M: SHARED };
    expect(redactSecretsForState(bag, secrets, source)).toEqual({ L: [EXPR_A], M: EXPR_B });
    // A producer that removed an element itself: the count would drop the
    // `Fn::If`, but the kept literal disagrees with its bag element, so the
    // value scan answers rather than writing `EXPR_A` over `x`.
    const removed = {
      L: [{ 'Fn::If': ['On', 'x', { Ref: 'AWS::NoValue' }] }, EXPR_A, 'lit'],
      M: EXPR_B,
    };
    expect(redactSecretsForState({ L: ['x', SHARED], M: SHARED }, secrets, removed)).toEqual({
      L: ['x', EXPR_B],
      M: EXPR_B,
    });
    // ...and with no kept literal, the kept TOKEN must be the one resolved to
    // its bag element: `EXPR_A` resolved to the shared value, not to `x`.
    const removedBesideRef = {
      L: [{ 'Fn::If': ['On', 'x', { Ref: 'AWS::NoValue' }] }, EXPR_A, { Ref: 'Other' }],
      M: EXPR_B,
    };
    expect(redactSecretsForState({ L: ['x', SHARED], M: SHARED }, secrets, removedBesideRef)).toEqual({
      L: ['x', EXPR_B],
      M: EXPR_B,
    });
    // A kept plain OBJECT is corroborated leaf by leaf: the producer dropped
    // the third tag, so `{Key: b, Value: EXPR_B}` would pair with tag `c`
    // and write B's token onto it; the keys disagree and the value scan answers.
    const TOKEN_C = '{{resolve:secretsmanager:prod/db/cred:SecretString:tagc::}}';
    recordResolvedPair(secrets, TOKEN_C, 'plain-c-value-4919');
    secrets.set('plain-c-value-4919', TOKEN_C);
    const tags = {
      Tags: [
        { Key: 'a', Value: EXPR_A },
        { 'Fn::If': ['On', { Key: 'c', Value: TOKEN_C }, { Ref: 'AWS::NoValue' }] },
        { Key: 'b', Value: EXPR_B },
      ],
    };
    const tagBag = {
      Tags: [
        { Key: 'a', Value: SHARED },
        { Key: 'c', Value: 'plain-c-value-4919' },
      ],
    };
    const tagsOut = redactSecretsForState(tagBag, secrets, tags) as { Tags: Array<{ Value: string }> };
    expect(tagsOut.Tags[1]!.Value).toBe(TOKEN_C);
    expect(JSON.stringify(tagsOut)).not.toContain(SHARED);
    expect(JSON.stringify(tagsOut)).not.toContain('plain-c-value-4919');
    // ...while a genuine drop (the `Fn::If` dropped) pairs the kept objects.
    const genuine = redactSecretsForState(
      { Tags: [{ Key: 'a', Value: SHARED }, { Key: 'b', Value: SHARED }] },
      secrets,
      { Tags: [tags.Tags[0], { 'Fn::If': ['Off', 'x', { Ref: 'AWS::NoValue' }] }, tags.Tags[2]] }
    );
    expect(genuine).toEqual({ Tags: [{ Key: 'a', Value: EXPR_A }, { Key: 'b', Value: EXPR_B }] });
    // A public or embedding `{{resolve:` literal has no pair to corroborate:
    // the value scan answers, as the collision walk predicts.
    const PUB = '{{resolve:ssm:/public/x}}';
    for (const literal of [PUB, `--x=${EXPR_A}`]) {
      const shape = { L: [literal, { 'Fn::If': ['Off', '--y', { Ref: 'AWS::NoValue' }] }, EXPR_A, EXPR_B] };
      const out = redactSecretsForState({ L: ['resolved-text', SHARED, SHARED] }, secrets, shape) as {
        L: string[];
      };
      expect(out.L.slice(1)).toEqual([EXPR_B, EXPR_B]);
      expect(arrayPairsWhateverDrops(shape.L)).toBe(false);
    }
    // Two droppable elements, one kept: the value scan's survivor, as before.
    const ambiguous = {
      L: [{ 'Fn::If': ['Off', 'x', { Ref: 'AWS::NoValue' }] }, { 'Fn::If': ['On', 'y', { Ref: 'AWS::NoValue' }] }, EXPR_A],
      M: EXPR_B,
    };
    expect(redactSecretsForState({ L: ['y', SHARED], M: SHARED }, secrets, ambiguous)).toEqual({
      L: ['y', EXPR_B],
      M: EXPR_B,
    });
  });
});
