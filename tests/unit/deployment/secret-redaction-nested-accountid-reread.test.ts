/**
 * A nested child's re-read binds `AWS::AccountId` deterministically (issue
 * [#4975](https://github.com/go-to-k/cdkd/issues/4975)).
 *
 * #4962 bound the region-derived pseudo parameters in the re-read but left the
 * account unbound: the only account value available before any resource
 * resolves is the process-wide cache, so binding it only when settled flipped
 * the collision-walk verdict between two deploys of an unchanged tree. The
 * child's `resolveParameters` now looks the account up through the resolver's
 * own source (`getAccountInfo`, via `accountIdForReread`) when a resource may
 * re-read it -- settled or not, so the verdict is the same either way -- and
 * asks STS at most once per process, never on an ordinary deploy, and leaves
 * the account unbound on a refused lookup.
 *
 * Drives the REAL resolver, the REAL `redactSecretsForState` and the REAL
 * `redactParametersForDiff`, with STS mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
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
import { templateRereadsAccountId } from '../../../src/deployment/secret-redaction/nested-stack.js';
import {
  accountIdForReread,
  getAccountInfo,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-resolver/account-drain.js';
import {
  redactParametersForDiff,
  type MaskingDeps,
} from '../../../src/deployment/deploy-engine/masking.js';
import { TemplateNoEchoReresolver } from '../../../src/deployment/noecho-delete-reresolution.js';
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

const ACCOUNT = '210987654321';
const EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:collide::}}';
const EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:collide:AWSCURRENT:}}';
const USER_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:collideuser::}}';
const SHARED = 'sh4red-c0llide-pl4intext-4975';
const USER = 'us3r-c0llide-4975';
const PARAM_A = 'ConnA';
const PARAM_B = 'SecretB';
const SPELLING = `postgres://${USER_EXPR}:${EXPR_A}@host`;
const SURVIVOR = `postgres://${USER_EXPR}:${EXPR_B}@host`;
const CONN = `postgres://${USER}:${SHARED}@host`;
const PARAMETERS = { [PARAM_A]: CONN, [PARAM_B]: SHARED };
const SEL_B = { 'Fn::Select': [0, [{ Ref: PARAM_B }]] };

/** The issue's leaf: the account beside ConnA under `Fn::Select`. */
const ACCOUNT_LEAF = { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_A}}-\${AWS::AccountId}` }]] };

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

/** The child engine's step 2.5 (`deploy-flow.ts`): parameters, then the walk. */
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
  const engine = { options: { inheritedSecrets: parent } } as unknown as MaskingDeps;
  const desired = (await resolver.resolve(properties, {
    template,
    resources: {},
    parameters: redactParametersForDiff(engine, PARAMETERS),
    inheritedSecrets: parent,
    skipDynamicReferences: true,
    conditions: {},
    stackName: 'Child',
  } as unknown as ResolverContext)) as Record<string, unknown>;
  return { persisted, desired };
}

let savedOperatorAccount: string | undefined;
beforeEach(() => {
  savedOperatorAccount = process.env['AWS_ACCOUNT_ID'];
  delete process.env['AWS_ACCOUNT_ID'];
  resetAccountInfoCache();
  mockStsSend.mockReset();
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });
});
afterEach(() => {
  if (savedOperatorAccount === undefined) delete process.env['AWS_ACCOUNT_ID'];
  else process.env['AWS_ACCOUNT_ID'] = savedOperatorAccount;
});

describe('the re-read binds AWS::AccountId whether or not the account was settled (#4975)', () => {
  // The B1 two-pass probe from PR #4974's review: two deploys of one tree, one
  // in a process where earlier work settled the account and one where nothing
  // did, must reach one verdict and persist one record.
  for (const reversed of [true, false]) {
    for (const literalLast of [true, false]) {
      it(`${reversed ? 'reversed' : 'forward'} parent order, ${literalLast ? 'literal' : 'sibling'} read last`, async () => {
        const properties = literalLast
          ? { B: SEL_B, A: ACCOUNT_LEAF, Lit: { Ref: PARAM_A } }
          : { Lit: { Ref: PARAM_A }, A: ACCOUNT_LEAF, B: SEL_B };
        const template = childTemplate({ Mixed: properties });
        const passes: Record<string, unknown>[] = [];
        for (const settled of [true, false]) {
          resetAccountInfoCache();
          if (settled) await getAccountInfo('us-east-1');
          const parent = parentRow(reversed);
          await stepTwoPointFive(parent, template);
          // Nothing withdrawn: the diff side binds the literal.
          expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
          const { persisted, desired } = await persistAndDesired(parent, template, properties);
          expect(persisted).toEqual(desired);
          expect(persisted['Lit']).toBe(SPELLING);
          expect(JSON.stringify(persisted['A'])).toContain(EXPR_A);
          expect(JSON.stringify(persisted['A'])).toContain(ACCOUNT);
          expect(JSON.stringify(persisted['A'])).not.toContain(EXPR_B);
          expect(JSON.stringify(persisted)).not.toContain(SHARED);
          expect(JSON.stringify(persisted)).not.toContain(USER);
          passes.push(persisted);
        }
        expect(passes[0]).toEqual(passes[1]);
      });
    }
  }

  for (const [shape, leaf] of Object.entries({
    '{Ref: AWS::AccountId} under Fn::Join': {
      'Fn::Select': [0, [{ 'Fn::Join': ['-', [{ Ref: PARAM_A }, { Ref: 'AWS::AccountId' }]] }]],
    },
    'an Fn::Sub variable bound to {Ref: AWS::AccountId}': {
      'Fn::Select': [0, [{ 'Fn::Sub': [`\${${PARAM_A}}@\${S}`, { S: { Ref: 'AWS::AccountId' } }] }]],
    },
    'Fn::Select over Fn::Split': {
      'Fn::Select': [
        1,
        { 'Fn::Split': ['|', { 'Fn::Sub': `\${AWS::AccountId}|\${${PARAM_A}}` }] },
      ],
    },
  })) {
    it(`binds ${shape}`, async () => {
      const template = childTemplate({ Mixed: { A: leaf, B: SEL_B } });
      const parent = parentRow(true);
      await stepTwoPointFive(parent, template);
      expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
      expect(mockStsSend).toHaveBeenCalledTimes(1);
    });
  }
});

describe('the account lookup is gated: an ordinary deploy asks STS nothing (#4975)', () => {
  it('a non-nested stack (no inherited bag) makes no STS call', async () => {
    const template = childTemplate({ Mixed: { A: ACCOUNT_LEAF, B: SEL_B } });
    await resolver.resolveParameters(template, PARAMETERS);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('a nested child without inherited secrets makes no STS call', async () => {
    const template = childTemplate({ Mixed: { A: ACCOUNT_LEAF, B: SEL_B } });
    const parameters = await resolver.resolveParameters(template, PARAMETERS, {
      inheritedSecrets: new Map(),
    });
    poisonRenderedSpellingsCollidingIn(template, parameters, new Map());
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  for (const [shape, resources] of Object.entries({
    'the account read outside any re-read trigger': {
      Mixed: { A: { 'Fn::Sub': `\${${PARAM_A}}-\${AWS::AccountId}` }, B: { Ref: PARAM_B } },
    },
    'a re-read naming only the region': {
      Mixed: { A: { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_A}}-\${AWS::Region}` }]] }, B: SEL_B },
    },
    'the trigger and the account in different resources': {
      Sel: { B: SEL_B },
      Acct: { A: { 'Fn::Sub': `\${${PARAM_A}}-\${AWS::AccountId}` } },
    },
    'an escaped ${!AWS::AccountId}': {
      Mixed: { A: { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_A}}-\${!AWS::AccountId}` }]] } },
    },
  })) {
    it(`a nested child with secrets but ${shape} makes no STS call`, async () => {
      await stepTwoPointFive(parentRow(true), childTemplate(resources));
      expect(mockStsSend).not.toHaveBeenCalled();
    });
  }

  it('a binding that opts out of the pseudo table makes no STS call', async () => {
    const parent = parentRow(true);
    await resolver.resolveParameters(childTemplate({ Mixed: { A: ACCOUNT_LEAF, B: SEL_B } }), PARAMETERS, {
      inheritedSecrets: parent,
      recordPseudoParameters: false,
    });
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it("cdkd destroy's NoEcho delete re-resolution binds a child's parameters with no STS call", async () => {
    const reresolver = new TemplateNoEchoReresolver({
      template: childTemplate({ Mixed: { A: ACCOUNT_LEAF, B: SEL_B } }),
      stackName: 'Child',
      region: 'us-east-1',
      parameters: PARAMETERS,
      inheritedSecrets: parentRow(true),
      inheritedNoEchoParameters: new Set([PARAM_A]),
    });
    await reresolver.printingNoEchoValues();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('an account already settled in the process makes no further STS call', async () => {
    await getAccountInfo('us-east-1');
    expect(mockStsSend).toHaveBeenCalledTimes(1);
    const parent = parentRow(true);
    await stepTwoPointFive(parent, childTemplate({ Mixed: { A: ACCOUNT_LEAF, B: SEL_B } }));
    expect(mockStsSend).toHaveBeenCalledTimes(1);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
  });

  it('asks STS exactly once across children, per-parameter binding passes and the resolution', async () => {
    const template = childTemplate({ Mixed: { A: ACCOUNT_LEAF, B: SEL_B } });
    // Two children, plus `cdkd diff --recursive`'s one-parameter-at-a-time binding.
    await stepTwoPointFive(parentRow(true), template);
    await stepTwoPointFive(parentRow(false), template);
    const diffBag = parentRow(true);
    for (const name of [PARAM_A, PARAM_B]) {
      await resolver.resolveParameters(
        { ...template, Parameters: { [name]: { Type: 'String' } } },
        PARAMETERS,
        { inheritedSecrets: diffBag }
      );
    }
    await persistAndDesired(parentRow(true), template, { A: ACCOUNT_LEAF, B: SEL_B });
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });
});

describe('a refused account lookup fails closed (#4975)', () => {
  it('leaves the account unbound, raises nothing, and is not retried in the process', async () => {
    mockStsSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    const template = childTemplate({ Mixed: { A: ACCOUNT_LEAF, B: SEL_B } });
    const first = parentRow(true);
    await expect(stepTwoPointFive(first, template)).resolves.toBeUndefined();
    // Unbound: the slot read withdraws the literal's spelling, the pre-#4975 answer.
    expect(redactInheritedParameterValue(first, PARAM_A, CONN)).toBe(SURVIVOR);
    const calls = mockStsSend.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const second = parentRow(true);
    await expect(stepTwoPointFive(second, template)).resolves.toBeUndefined();
    expect(mockStsSend.mock.calls.length).toBe(calls);
    expect(redactInheritedParameterValue(second, PARAM_A, CONN)).toBe(SURVIVOR);
    expect(await accountIdForReread('us-east-1')).toBeUndefined();
  });

  it('an account with no Account in the answer leaves it unbound', async () => {
    mockStsSend.mockResolvedValue({});
    const parent = parentRow(true);
    await stepTwoPointFive(parent, childTemplate({ Mixed: { A: ACCOUNT_LEAF, B: SEL_B } }));
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SURVIVOR);
  });
});

describe('a bound account equal to or overlapping a parent plaintext persists no plaintext (#4975)', () => {
  for (const [shape, { secret, leaf }] of Object.entries({
    'the selected piece is the account alone': {
      secret: ACCOUNT,
      leaf: {
        'Fn::Select': [0, { 'Fn::Split': ['|', { 'Fn::Sub': `\${AWS::AccountId}|\${${PARAM_A}}` }] }],
      },
    },
    'the account beside the parameter': { secret: ACCOUNT, leaf: ACCOUNT_LEAF },
    'a secret straddling the account and literal text': {
      secret: '87654321xyz',
      leaf: { 'Fn::Select': [0, [{ 'Fn::Sub': `\${AWS::AccountId}xyz-\${${PARAM_A}}` }]] },
    },
  })) {
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

describe('templateRereadsAccountId (#4975)', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['a {Ref} under Fn::Select', { R: { P: { 'Fn::Select': [0, [{ Ref: 'AWS::AccountId' }]] } } }, true],
    ['an Fn::Sub string under Fn::If', { R: { P: { 'Fn::If': ['C', { 'Fn::Sub': 'a-${AWS::AccountId}' }, 'b'] } } }, true],
    ['an Fn::Sub with a variable map beside Fn::Split', { R: { P: { 'Fn::Sub': ['${AWS::AccountId}-${X}', { X: { 'Fn::Select': [0, { 'Fn::Split': [',', 'a,b'] }] } }] } } }, true],
    ['no trigger', { R: { P: { 'Fn::Join': ['', [{ Ref: 'AWS::AccountId' }]] } } }, false],
    ['no account', { R: { P: { 'Fn::Select': [0, [{ Ref: 'AWS::Region' }]] } } }, false],
    ['a literal string spelling the name', { R: { P: { 'Fn::Select': [0, ['AWS::AccountId']] } } }, false],
  ];
  for (const [shape, resources, expected] of cases) {
    it(`${shape} -> ${expected}`, () => {
      expect(templateRereadsAccountId({ Resources: resources })).toBe(expected);
    });
  }

  it('reads Outputs too', () => {
    expect(
      templateRereadsAccountId({
        Resources: {},
        Outputs: { O: { Value: { 'Fn::Select': [0, [{ 'Fn::Sub': '${AWS::AccountId}' }]] } } },
      })
    ).toBe(true);
  });

  it('re-reads a copy sharing Resources but not Outputs afresh', () => {
    const resources = { R: { P: { 'Fn::Select': [0, [{ Ref: PARAM_A }]] } } };
    expect(templateRereadsAccountId({ Resources: resources })).toBe(false);
    expect(
      templateRereadsAccountId({
        Resources: resources,
        Outputs: { O: { Value: { 'Fn::Select': [0, [{ Ref: 'AWS::AccountId' }]] } } },
      })
    ).toBe(true);
  });

  it('answers false without a template', () => {
    expect(templateRereadsAccountId(undefined)).toBe(false);
  });
});
