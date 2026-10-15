/**
 * A nested child's re-read binds the pseudo parameters every pass knows
 * locally (issue [#4962](https://github.com/go-to-k/cdkd/issues/4962)).
 *
 * A leaf such as `Fn::Select [0, [Fn::Sub "${ConnA}-${AWS::Region}"]]` in a
 * resource that also reads a same-plaintext sibling parameter used to be a
 * slot read: the re-read refused every `AWS::` placeholder, so
 * `poisonRenderedSpellingsCollidingIn` withdrew the literal parameter's
 * #4644 spelling for the whole child, and a leaf reading only the literal
 * persisted the survivor where `cdkd diff --recursive` renders the literal.
 *
 * The child's `resolveParameters` records the pseudo values it would resolve
 * (`AWS::Region`, `AWS::Partition`, `AWS::URLSuffix`: pure functions of its
 * region) on the inherited bag, before the collision walk; the walk, the
 * persist re-read and (through the resolver) the diff side bind the same
 * values. `AWS::AccountId` (settled or not: #4975), `AWS::StackName`,
 * `AWS::StackId`, `AWS::NotificationARNs` and `AWS::NoValue` stay refused.
 *
 * Drives the REAL resolver, the REAL `redactSecretsForState` and the REAL
 * `redactParametersForDiff`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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
import {
  recordInheritedPseudoParameters,
  rereadParameterExpression,
} from '../../../src/deployment/secret-redaction/nested-stack.js';
import {
  getAccountInfo,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-resolver/account-drain.js';
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

const mockStsSend = vi.fn();
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: mockStsSend } }),
}));

const ACCOUNT = '123456789012';
const EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:collide::}}';
const EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:collide:AWSCURRENT:}}';
const USER_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:collideuser::}}';
const SHARED = 'sh4red-c0llide-pl4intext-4962';
const USER = 'us3r-c0llide-4962';
const PARAM_A = 'ConnA';
const PARAM_B = 'SecretB';
const SPELLING = `postgres://${USER_EXPR}:${EXPR_A}@host`;
const CONN = `postgres://${USER}:${SHARED}@host`;
const PARAMETERS = { [PARAM_A]: CONN, [PARAM_B]: SHARED };
const SEL_B = { 'Fn::Select': [0, [{ Ref: PARAM_B }]] };

const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

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

/**
 * The child engine's step 2.5 as `deploy-flow.ts` runs it: resolve the
 * parameters against the inherited bag, then the collision walk.
 */
async function stepTwoPointFive(
  parent: RecordedSecretValues,
  template: CloudFormationTemplate
): Promise<void> {
  const parameters = await resolver.resolveParameters(template, PARAMETERS, {
    inheritedSecrets: parent,
  });
  poisonRenderedSpellingsCollidingIn(template, parameters, parent);
}

/** Persist one resource of the child as the deploy does, and its diff side. */
async function persistAndDesired(
  parent: RecordedSecretValues,
  template: CloudFormationTemplate,
  properties: Record<string, unknown>
): Promise<{ persisted: Record<string, unknown>; desired: Record<string, unknown> }> {
  const recordedSecretValues = new Map<string, string>();
  inheritNestedStackParameterAssociations(recordedSecretValues, parent);
  const resolved = await resolver.resolve(properties, {
    template,
    resources: {},
    parameters: PARAMETERS,
    recordedSecretValues,
    inheritedSecrets: parent,
    conditions: {},
    stackName: 'Child',
  } as unknown as ResolverContext);
  const persisted = redactSecretsForState(resolved, recordedSecretValues, properties) as Record<
    string,
    unknown
  >;
  const engine = { options: { inheritedSecrets: parent } } as unknown as DeployEngine;
  const desired = (await resolver.resolve(properties, {
    template,
    resources: {},
    parameters: redactParametersForDiff.call(engine, PARAMETERS),
    inheritedSecrets: parent,
    skipDynamicReferences: true,
    conditions: {},
    stackName: 'Child',
  } as unknown as ResolverContext)) as Record<string, unknown>;
  return { persisted, desired };
}

const sub = (text: string): unknown => ({ 'Fn::Select': [0, [{ 'Fn::Sub': text }]] });

beforeEach(() => {
  resetAccountInfoCache();
  mockStsSend.mockReset();
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });
});

describe('a re-read binds the pseudo parameters every pass knows locally (#4962)', () => {
  // Each leaf reads ConnA beside a pseudo parameter; `B` reads SecretB, the
  // same plaintext spelled differently; `Lit` reads ConnA alone.
  const SHAPES: Record<string, unknown> = {
    'Fn::Sub naming AWS::Region': sub(`\${${PARAM_A}}-\${AWS::Region}`),
    'Fn::Sub naming AWS::Partition': sub(`\${AWS::Partition}:\${${PARAM_A}}`),
    'Fn::Sub naming AWS::URLSuffix': sub(`\${${PARAM_A}}.\${AWS::URLSuffix}`),
    'Fn::Select over Fn::Split of an Fn::Sub naming AWS::Region': {
      'Fn::Select': [1, { 'Fn::Split': ['|', { 'Fn::Sub': `\${AWS::Region}|\${${PARAM_A}}` }] }],
    },
    'Fn::Join with a {Ref: AWS::Region} under Fn::Select': {
      'Fn::Select': [0, [{ 'Fn::Join': ['-', [{ Ref: PARAM_A }, { Ref: 'AWS::Region' }]] }]],
    },
    'an Fn::Sub variable bound to {Ref: AWS::URLSuffix}': {
      'Fn::Select': [
        0,
        [{ 'Fn::Sub': [`\${${PARAM_A}}@\${S}`, { S: { Ref: 'AWS::URLSuffix' } }] }],
      ],
    },
  };
  // The forward-order, literal-last arm stays green on `main` too: there the
  // parent survivor IS the literal's own token, so a withdrawal changes
  // nothing it reads. It is kept for the persisted/desired agreement; the
  // other three arms are the ones the fix turns green.
  for (const reversed of [true, false]) {
    for (const literalLast of [true, false]) {
      for (const [shape, A] of Object.entries(SHAPES)) {
        it(`${reversed ? 'reversed' : 'forward'} parent order, ${literalLast ? 'literal' : 'sibling'} read last, ${shape}`, async () => {
          const properties = literalLast
            ? { B: SEL_B, A, Lit: { Ref: PARAM_A } }
            : { Lit: { Ref: PARAM_A }, A, B: SEL_B };
          const template = childTemplate({ Mixed: properties });
          const parent = parentRow(reversed);
          const calls = mockStsSend.mock.calls.length;
          await stepTwoPointFive(parent, template);
          // The recording makes no AWS call.
          expect(mockStsSend.mock.calls.length).toBe(calls);
          // Nothing withdrawn: the diff side binds the literal.
          expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
          const { persisted, desired } = await persistAndDesired(parent, template, properties);
          expect(persisted).toEqual(desired);
          // What `cdkd diff --recursive` renders from the parent row's literal.
          expect(persisted['Lit']).toBe(SPELLING);
          expect(JSON.stringify(persisted['A'])).toContain(EXPR_A);
          expect(JSON.stringify(persisted['A'])).not.toContain(EXPR_B);
          expect(persisted['B']).toBe(EXPR_B);
          expect(JSON.stringify(persisted)).not.toContain(SHARED);
          expect(JSON.stringify(persisted)).not.toContain(USER);
        });
      }
    }
  }
});

describe('a re-read refuses every pseudo parameter it cannot prove equal across passes (#4962)', () => {
  const REFUSED: Record<string, unknown> = {
    'AWS::StackName (the child engine names it per pass)': sub(`\${${PARAM_A}}-\${AWS::StackName}`),
    'AWS::StackId (absent on a first deploy)': sub(`\${${PARAM_A}}-\${AWS::StackId}`),
    'AWS::NotificationARNs (a list)': {
      'Fn::Select': [0, [{ 'Fn::Join': ['-', [{ Ref: PARAM_A }, { 'Fn::Join': ['', { Ref: 'AWS::NotificationARNs' }] }]] }]],
    },
    'an unknown AWS:: name': sub(`\${${PARAM_A}}-\${AWS::Bogus}`),
    'a {Ref: AWS::StackName}': {
      'Fn::Select': [0, [{ 'Fn::Join': ['-', [{ Ref: PARAM_A }, { Ref: 'AWS::StackName' }]] }]],
    },
  };
  for (const [shape, A] of Object.entries(REFUSED)) {
    it(`withdraws the literal's spelling for ${shape}`, async () => {
      const template = childTemplate({ Mixed: { A, B: SEL_B } });
      const parent = parentRow(true);
      await stepTwoPointFive(parent, template);
      // The pre-#4644 answer: the literal reads the survivor.
      expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
        `postgres://${USER_EXPR}:${EXPR_B}@host`
      );
    });
  }

  // Issue #4975: the account is known without an AWS call only once something
  // in the process looked it up, so binding it would flip the verdict between
  // two deploys of one tree. Refused either way, so the verdict is the same.
  for (const settled of [true, false]) {
    it(`withdraws the literal's spelling for AWS::AccountId, whether or not the account lookup settled (${settled})`, async () => {
      if (settled) await getAccountInfo('us-east-1');
      const template = childTemplate({
        Mixed: { A: sub(`\${${PARAM_A}}-\${AWS::AccountId}`), B: SEL_B },
      });
      const parent = parentRow(true);
      const calls = mockStsSend.mock.calls.length;
      await stepTwoPointFive(parent, template);
      expect(mockStsSend.mock.calls.length).toBe(calls);
      expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
        `postgres://${USER_EXPR}:${EXPR_B}@host`
      );
    });
  }

  it('binds nothing where the walk runs without the child having resolved its parameters', () => {
    const template = childTemplate({
      Mixed: { A: sub(`\${${PARAM_A}}-\${AWS::Region}`), B: SEL_B },
    });
    const parent = parentRow(true);
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
      `postgres://${USER_EXPR}:${EXPR_B}@host`
    );
  });

  it('binds nothing once two passes recorded different values on one bag', async () => {
    const template = childTemplate({
      Mixed: { A: sub(`\${${PARAM_A}}-\${AWS::Region}`), B: SEL_B },
    });
    const parent = parentRow(true);
    await new IntrinsicFunctionResolver('eu-west-1', { cfnFallback: false }).resolveParameters(
      template,
      PARAMETERS,
      { inheritedSecrets: parent }
    );
    await stepTwoPointFive(parent, template);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
      `postgres://${USER_EXPR}:${EXPR_B}@host`
    );
  });

  it('refuses an AWS:: name a parameter binding answers too (resolveRef and resolveSub disagree on it)', () => {
    const parent = parentRow(true);
    recordInheritedPseudoParameters(parent, new Map([['AWS::Region', 'us-east-1']]));
    const source = sub(`\${${PARAM_A}}-\${AWS::Region}`);
    const bind = (name: string): { value: unknown } | undefined =>
      name === PARAM_A ? { value: CONN } : undefined;
    // The control: the pseudo value alone binds it.
    expect(rereadParameterExpression(source, bind, parent)?.resolved).toBe(`${CONN}-us-east-1`);
    const both = (name: string): { value: unknown } | undefined =>
      name === 'AWS::Region' ? { value: 'us-east-1' } : bind(name);
    expect(rereadParameterExpression(source, both, parent)).toBeUndefined();
  });
});

describe('a bound pseudo value equal to or overlapping a parent plaintext persists no plaintext (#4962)', () => {
  // The secret IS the region's text, or straddles it; the guards the re-read
  // already applies to literal text (`rendersReadTo`, the child-only check,
  // the final re-scan) must keep it out of state.
  const LEAVES: Record<string, { secret: string; leaf: unknown }> = {
    'the selected piece is the region alone': {
      secret: 'us-east-1',
      leaf: { 'Fn::Select': [0, { 'Fn::Split': ['|', { 'Fn::Sub': `\${AWS::Region}|\${${PARAM_A}}` }] }] },
    },
    'the region beside the parameter in one Fn::Sub': {
      secret: 'us-east-1',
      leaf: sub(`\${AWS::Region}-\${${PARAM_A}}`),
    },
    'a secret straddling the region and literal text': {
      secret: 'east-1xyz',
      leaf: sub(`\${AWS::Region}xyz-\${${PARAM_A}}`),
    },
  };
  for (const [shape, { secret, leaf }] of Object.entries(LEAVES)) {
    it(shape, async () => {
      const conn = `postgres://${USER}:${secret}@host`;
      const parameters = { [PARAM_A]: conn, [PARAM_B]: secret };
      const parent: RecordedSecretValues = new Map();
      for (const [expression, plaintext] of [
        [USER_EXPR, USER],
        [EXPR_A, secret],
        [EXPR_B, secret],
      ] as const) {
        parent.set(plaintext, expression);
        recordResolvedPair(parent, expression, plaintext);
      }
      recordNestedStackParameterExpressions(
        parent,
        'AWS::CloudFormation::Stack',
        { Parameters: parameters },
        { Parameters: { [PARAM_A]: SPELLING, [PARAM_B]: EXPR_B } }
      );
      const properties = { A: leaf, B: SEL_B, Lit: { Ref: PARAM_A } };
      const template = childTemplate({ Mixed: properties });
      const resolved = await resolver.resolveParameters(template, parameters, {
        inheritedSecrets: parent,
      });
      poisonRenderedSpellingsCollidingIn(template, resolved, parent);
      const recordedSecretValues = new Map<string, string>();
      inheritNestedStackParameterAssociations(recordedSecretValues, parent);
      const out = await resolver.resolve(properties, {
        template,
        resources: {},
        parameters,
        recordedSecretValues,
        inheritedSecrets: parent,
        conditions: {},
        stackName: 'Child',
      } as unknown as ResolverContext);
      const persisted = JSON.stringify(redactSecretsForState(out, recordedSecretValues, properties));
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain(USER);
    });
  }
});
