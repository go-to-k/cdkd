/**
 * A child resource reading BOTH a literal-spelled parameter (issue #4644) and a
 * same-plaintext sibling keeps the pre-#4644 answer for that parameter, decided
 * from the template before anything resolves (issue
 * [#4731](https://github.com/go-to-k/cdkd/issues/4731)).
 *
 * The carry holds ONE expression per plaintext per resource, so in such a
 * resource the parameter resolved LAST decides every value-scanned leaf
 * (`Fn::Select`, `Fn::Split`, an array). With the literal's own token in the
 * slot, the sibling's leaf persisted a token its diff side did not render;
 * `poisonRenderedSpellingsCollidingIn` withdraws the literal's spelling for the
 * whole child, so the diff side, the `{Ref}` arm and the carry all fall back to
 * the survivor -- `main`'s answer.
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
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { poisonRenderedSpellingsCollidingIn } from '../../../src/deployment/intrinsic-resolver/parameter-secrets.js';
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
    skipDynamicReferences: true,
  } as unknown as ResolverContext)) as Record<string, unknown>;
  return { persisted, desired };
}

describe('a child resource reading BOTH parameters keeps the pre-#4644 answer (#4731)', () => {
  for (const reversed of [true, false]) {
    for (const literalLast of [true, false]) {
      it(`${reversed ? 'reversed' : 'forward'} parent order, ${literalLast ? 'literal' : 'sibling'} read last`, async () => {
        const parent = parentRow(reversed);
        const survivor = reversed ? EXPR_B : EXPR_A;
        const properties = literalLast ? { B: SEL_B, A: SEL_A } : { A: SEL_A, B: SEL_B };
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
    const template = childTemplate({ Mixed: { A: SEL_A, B: SEL_B }, Alone: { A: SEL_A } });
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    const { persisted, desired } = await persistAndDesired(parent, template, { A: SEL_A });
    expect(persisted).toEqual(desired);
    expect(desired['A']).toBe(`postgres://${USER_EXPR}:${EXPR_B}@host`);
  });

  it('a SIBLING child of the same parent, reading only the literal, keeps the #4644 fix', async () => {
    // Two nested-stack rows: two bags. Only the mixed child's is withdrawn.
    const mixedRow = parentRow(true);
    const plainRow = parentRow(true);
    poisonRenderedSpellingsCollidingIn(childTemplate({ Mixed: { A: SEL_A, B: SEL_B } }), PARAMETERS, mixedRow);
    const template = childTemplate({ Alone: { A: SEL_A } });
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, plainRow);
    expect(redactInheritedParameterValue(plainRow, PARAM_A, CONN)).toBe(SPELLING);
    const { persisted, desired } = await persistAndDesired(plainRow, template, { A: SEL_A });
    expect(persisted).toEqual(desired);
    expect(desired['A']).toBe(`postgres://${USER_EXPR}:${EXPR_A}`.concat('@host'));
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
      poisonRenderedSpellingsCollidingIn(childTemplate({ Mixed: { A: SEL_A, B: subRead } }), PARAMETERS, parent);
      expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).not.toBe(SPELLING);
    }
    // A literal `${!Name}` is no read.
    const parent = parentRow(true);
    poisonRenderedSpellingsCollidingIn(
      childTemplate({ Mixed: { A: SEL_A, B: { 'Fn::Sub': `x-\${!${PARAM_B}}` } } }),
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

  it('counts the Outputs as one reader, bare {Ref}s included', () => {
    const parent = parentRow(true);
    const template = {
      ...childTemplate({ X: { A: SEL_A } }),
      Outputs: { OA: { Value: SEL_A }, OB: { Value: { Ref: PARAM_B } } },
    } as CloudFormationTemplate;
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).not.toBe(SPELLING);
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
      ...childTemplate({ Mixed: { A: SEL_A, C: { Ref: PARAM_C } } }),
    } as CloudFormationTemplate;
    poisonRenderedSpellingsCollidingIn(template, { ...PARAMETERS, [PARAM_C]: SHARED }, parent);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
  });
});
