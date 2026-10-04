/**
 * A nested-stack CHILD leaf that EMBEDS a parameter persists what the DIFF side
 * renders for it, positioned by the parameter spans the RESOLVER substituted
 * (issue [#4446](https://github.com/go-to-k/cdkd/issues/4446), the residual of
 * [#2320](https://github.com/go-to-k/cdkd/issues/2320)).
 *
 * `positionByParameterPlaceholders` re-reads the TEMPLATE and aligns it against
 * the resolved leaf, so it refuses two or more parts whose text the template
 * cannot state, and never runs for a top-level `Fn::If`. These shapes are the
 * ones it refused; here the resolver's own record of WHERE each parameter `Ref`
 * landed answers them. Both halves are the REAL code, as in
 * `secret-redaction-nested-parameter-placeholders.test.ts`.
 *
 * THE DISCRIMINATING SHAPE is the embedding leaf resolved BEFORE a whole-value
 * `{Ref: B}` sibling, `A` and `B` resolving to one plaintext: the resource bag's
 * one slot then holds B's expression, which is what the value scan writes.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  crossStackSourceKey,
  inheritNestedStackParameterAssociations,
  intrinsicLeafResolutionOf,
  recordDerivedMaskOnlyValue,
  recordIntrinsicLeafResolution,
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  SECRET_MASK,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { redactParametersForDiff } from '../../../src/deployment/deploy-engine/masking.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

/** The association key a parameter span carries (issue #4527). */
const refKey = (parameter: string): string => crossStackSourceKey({ Ref: parameter })!;

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

// One PUBLIC ssm parameter, so a dynamic-reference pass can rewrite a leaf's
// text after its parameters were placed.
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        if (command.input?.Name === '/app/region') {
          return { Parameter: { Value: 'eu-west-1', Type: 'String' } };
        }
        const notFound = new Error('ParameterNotFound');
        notFound.name = 'ParameterNotFound';
        throw notFound;
      }),
    },
  }),
}));

/** Two spellings of ONE reference: an empty version stage means `AWSCURRENT`. */
const EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:k::}}';
const EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:k:AWSCURRENT:}}';
const SHARED = 'sh4red-sp4n-pl4intext-4446';
const HOST = 'db.cluster-4446.internal';

const template: CloudFormationTemplate = {
  Parameters: {
    A: { Type: 'String' },
    B: { Type: 'String' },
    User: { Type: 'String' },
    Tail: { Type: 'String' },
    Name: { Type: 'String' },
    Empty: { Type: 'String' },
  },
  Conditions: { On: { 'Fn::Equals': ['a', 'a'] } },
  Resources: { Db: { Type: 'AWS::RDS::DBCluster', Properties: {} } },
};
/** `Tail` has no association and its value holds the shared plaintext. */
const PARAMETERS = { A: SHARED, B: SHARED, User: 'app', Tail: `q:${SHARED}`, Name: 'region', Empty: '' };
const RESOURCES: Record<string, ResourceState> = {
  Db: {
    physicalId: 'db-4446',
    resourceType: 'AWS::RDS::DBCluster',
    properties: {},
    attributes: { 'Endpoint.Address': HOST },
  } as unknown as ResourceState,
};

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

function childContext(childBag: RecordedSecretValues, parent: RecordedSecretValues): ResolverContext {
  return {
    template,
    resources: RESOURCES,
    stackName: 'ChildStack',
    parameters: PARAMETERS,
    conditions: { On: true },
    recordedSecretValues: childBag,
    inheritedSecrets: parent,
  } as unknown as ResolverContext;
}

/** Resolve `source` as the child engine does, returning the resolved bag and the resource's bag. */
async function resolveChild(
  source: Record<string, unknown>
): Promise<{ resolved: Record<string, unknown>; childBag: RecordedSecretValues }> {
  const parent = parentBag();
  const childBag: RecordedSecretValues = new Map();
  inheritNestedStackParameterAssociations(childBag, parent);
  const resolved = (await resolver.resolve(source, childContext(childBag, parent))) as Record<
    string,
    unknown
  >;
  return { resolved, childBag };
}

/** What the child persists for `source`, and what its next diff desires. */
async function bothHalves(
  source: Record<string, unknown>
): Promise<{ persisted: Record<string, unknown>; desired: Record<string, unknown> }> {
  const parent = parentBag();
  const { resolved, childBag } = await resolveChild(source);
  const persisted = redactSecretsForState(resolved, childBag, source) as Record<string, unknown>;
  const diffParameters = redactParametersForDiff.call(
    { options: { inheritedSecrets: parent } } as unknown as DeployEngine,
    PARAMETERS
  );
  const desired = (await resolver.resolve(source, {
    template,
    resources: RESOURCES,
    stackName: 'ChildStack',
    parameters: diffParameters,
    conditions: { On: true },
    skipDynamicReferences: true,
    bestEffort: true,
  } as unknown as ResolverContext)) as Record<string, unknown>;
  return { persisted, desired };
}

describe('nested-stack child: an embedding leaf positioned by the RESOLVER\'s parameter spans (#4446)', () => {
  it.each([
    [
      'two unknown parts (the issue\'s connection string)',
      {
        'Fn::Join': [
          '',
          ['postgres://', { Ref: 'User' }, ':', { Ref: 'A' }, '@', { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }],
        ],
      },
      `postgres://app:${EXPR_A}@${HOST}`,
    ],
    [
      'two unknown parts in an Fn::Sub',
      { 'Fn::Sub': '${User}-${A}-${AWS::StackName}' },
      `app-${EXPR_A}-ChildStack`,
    ],
    [
      'a top-level Fn::If selecting an Fn::Sub',
      { 'Fn::If': ['On', { 'Fn::Sub': 'x-${A}' }, 'none'] },
      `x-${EXPR_A}`,
    ],
    [
      'an Fn::Join part that is an Fn::If over a {Ref}',
      { 'Fn::Join': ['-', ['x', { 'Fn::If': ['On', { Ref: 'A' }, 'none'] }, { Ref: 'User' }, { Ref: 'AWS::StackName' }]] },
      `x-${EXPR_A}-app-ChildStack`,
    ],
    [
      'a 2-arg Fn::Sub binding V to {Ref: A} beside two unknowns',
      { 'Fn::Sub': ['${User}/${V}/${Db.Endpoint.Address}', { V: { Ref: 'A' } }] },
      `app/${EXPR_A}/${HOST}`,
    ],
    [
      'a nested Fn::Sub inside an Fn::Join beside two unknowns',
      { 'Fn::Join': [':', [{ Ref: 'User' }, { 'Fn::Sub': 'p-${A}' }, { Ref: 'AWS::StackName' }]] },
      `app:p-${EXPR_A}:ChildStack`,
    ],
    // CDK's `Fn.conditionIf(cond, param.valueAsString, ...)`: the `{Ref}`
    // branch lends its own record to the `Fn::If`, which used to poison it.
    ['a top-level Fn::If selecting {Ref: A}', { 'Fn::If': ['On', { Ref: 'A' }, 'none'] }, EXPR_A],
    // An EMPTY parameter places no span (#4467 test review): an empty span
    // would make the persist side refuse the whole record.
    [
      'an Fn::Sub beside an EMPTY parameter',
      { 'Fn::Sub': '${User}-${Empty}-${A}-${AWS::StackName}' },
      `app--${EXPR_A}-ChildStack`,
    ],
    [
      'an Fn::Join beside an EMPTY {Ref} parameter',
      { 'Fn::Join': ['-', [{ Ref: 'Empty' }, { Ref: 'A' }, { Ref: 'AWS::StackName' }, { Ref: 'User' }]] },
      `-${EXPR_A}-ChildStack-app`,
    ],
    // A part whose OWN record places no span it can vouch for is skipped as a
    // GAP, never dropping the enclosing record's spans (#4467 parent review, #4469).
    [
      'an Fn::Join beside a string-selected Fn::If part',
      { 'Fn::Join': ['-', [{ Ref: 'A' }, { 'Fn::If': ['On', 'lit', 'x'] }, { Ref: 'User' }, { Ref: 'AWS::StackName' }]] },
      `${EXPR_A}-lit-app-ChildStack`,
    ],
    [
      'an Fn::Join beside a nested part its own dynamic-reference pass rewrote',
      { 'Fn::Join': [':', [{ Ref: 'A' }, { 'Fn::Sub': '{{resolve:ssm:/app/region}}' }, { Ref: 'User' }, { Ref: 'AWS::StackName' }]] },
      `${EXPR_A}:eu-west-1:app:ChildStack`,
    ],
    [
      'an Fn::Join holding CDK\'s Fn.conditionIf(c, \'-prod\', \'\') part',
      { 'Fn::Join': ['', [{ Ref: 'User' }, ':', { Ref: 'A' }, { 'Fn::If': ['On', '-prod', ''] }, '@', { Ref: 'AWS::StackName' }]] },
      `app:${EXPR_A}-prod@ChildStack`,
    ],
    [
      'an Fn::Sub binding the same Fn::If',
      { 'Fn::Sub': ['${User}:${A}${S}@${AWS::StackName}', { S: { 'Fn::If': ['On', '-prod', ''] } }] },
      `app:${EXPR_A}-prod@ChildStack`,
    ],
    // An escaped `${!X}` and an empty `${}` place no span and shift the rest.
    [
      'an Fn::Sub with an escaped ${!Lit} and an empty ${} before A',
      { 'Fn::Sub': '${User}-${!Lit}-${}-${A}-${AWS::StackName}' },
      `app-\${Lit}-\${}-${EXPR_A}-ChildStack`,
    ],
    // A non-object Join element places no span and shifts the rest.
    [
      'an Fn::Join with a numeric element before A',
      { 'Fn::Join': ['-', [7, { Ref: 'A' }, { Ref: 'User' }, { Ref: 'AWS::StackName' }]] },
      `7-${EXPR_A}-app-ChildStack`,
    ],
  ])('persists %s on A\'s OWN expression, as the diff side renders it', async (_, leaf, expected) => {
    const { persisted, desired } = await bothHalves({ P1: leaf, P2: { Ref: 'B' } });
    expect(persisted['P1']).toBe(expected);
    expect(persisted['P2']).toBe(EXPR_B);
    expect(persisted).toEqual(desired);
  });

  it('measures the premise: the resource bag\'s one slot holds B, the sibling resolved last', async () => {
    const { childBag } = await resolveChild({
      P1: { 'Fn::Sub': '${User}-${A}-${AWS::StackName}' },
      P2: { Ref: 'B' },
    });
    expect(childBag.get(SHARED)).toBe(EXPR_B);
  });

  it('records each parameter span on the resolved output, and nothing for a pseudo parameter or resource', async () => {
    const leaf = { 'Fn::Sub': '${User}-${A}-${AWS::StackName}-${Db}' };
    const { resolved, childBag } = await resolveChild({ P1: leaf });
    const record = intrinsicLeafResolutionOf(childBag, leaf);
    expect(record?.output).toBe(resolved['P1']);
    expect(record?.parameterSpans).toEqual([
      { start: 0, length: 3, key: refKey('User') },
      { start: 4, length: SHARED.length, key: refKey('A') },
    ]);
  });

  it('records no span for a {Ref} object a resource or pseudo parameter answers', async () => {
    const leaf = {
      'Fn::Join': ['-', [{ Ref: 'Db' }, { Ref: 'AWS::StackName' }, { Ref: 'A' }]],
    };
    const { resolved, childBag } = await resolveChild({ P1: leaf });
    const record = intrinsicLeafResolutionOf(childBag, leaf);
    expect(record?.output).toBe(resolved['P1']);
    expect(record?.parameterSpans).toEqual([
      { start: 'db-4446-ChildStack-'.length, length: SHARED.length, key: refKey('A') },
    ]);
  });

  describe('drops the spans when the final dynamic-reference pass rewrote the text they index', () => {
    it.each([
      [
        'Fn::Join',
        { 'Fn::Join': ['', ['{{resolve:ssm:', '/app/region', '}}', '-', { Ref: 'A' }]] },
      ],
      ['Fn::Sub', { 'Fn::Sub': '{{resolve:ssm:/app/${Name}}}-${A}' }],
    ])('%s: no spans recorded, and the leaf takes the value scan\'s answer', async (_, leaf) => {
      const source = { P1: leaf, P2: { Ref: 'B' } };
      const { resolved, childBag } = await resolveChild(source);
      expect(resolved['P1']).toBe(`eu-west-1-${SHARED}`);
      const record = intrinsicLeafResolutionOf(childBag, leaf);
      expect(record?.output).toBe(`eu-west-1-${SHARED}`);
      expect(record?.parameterSpans).toBeUndefined();
      const persisted = redactSecretsForState(resolved, childBag, source) as Record<string, unknown>;
      expect(persisted['P1']).toBe(`eu-west-1-${EXPR_B}`);
    });

    it('keeps them when the pass resolved a token inside a PART, before the parts were placed', async () => {
      const leaf = { 'Fn::Join': ['-', ['{{resolve:ssm:/app/region}}', { Ref: 'A' }]] };
      const { persisted, desired } = await bothHalves({ P1: leaf, P2: { Ref: 'B' } });
      expect(persisted['P1']).toBe(`eu-west-1-${EXPR_A}`);
      expect(persisted).toEqual(desired);
    });
  });

  describe('reads a record only when it can describe THIS leaf', () => {
    /** A child resource bag holding A / B's associations and the collapsed slot. */
    function childBagWithSlot(): RecordedSecretValues {
      const childBag: RecordedSecretValues = new Map();
      inheritNestedStackParameterAssociations(childBag, parentBag());
      childBag.set(SHARED, EXPR_B);
      return childBag;
    }
    const leaf = `app-${SHARED}-ChildStack`;
    const at = 'app-'.length;

    it('premise: a well-formed hand-built record IS positioned', () => {
      const childBag = childBagWithSlot();
      const source = { 'Fn::Sub': '${User}-${A}-${AWS::StackName}' };
      recordIntrinsicLeafResolution(childBag, source, {
        input: leaf,
        output: leaf,
        substitutions: [],
        complete: true,
        parameterSpans: [{ start: at, length: SHARED.length, key: refKey('A') }],
      });
      const persisted = redactSecretsForState({ P1: leaf }, childBag, { P1: source }) as Record<
        string,
        unknown
      >;
      expect(persisted['P1']).toBe(`app-${EXPR_A}-ChildStack`);
    });

    it.each([
      ['overlapping spans', [
        { start: at, length: SHARED.length, key: refKey('A') },
        { start: at + 1, length: SHARED.length - 1, key: refKey('A') },
      ]],
      // The clamped slice is not A's plaintext, so it is refused by certification
      // as much as by the bound (stated beside the bound in positions.ts).
      ['a span past the end (uncertifiable once clamped)', [{ start: at, length: leaf.length, key: refKey('A') }]],
      ['an empty span', [
        { start: 0, length: 0, key: refKey('A') },
        { start: at, length: SHARED.length, key: refKey('A') },
      ]],
      ['an UNCERTIFIED span overlapping the next', [
        { start: 0, length: at + 2, key: refKey('User') },
        { start: at, length: SHARED.length, key: refKey('A') },
      ]],
      ['descending spans', [
        { start: at, length: SHARED.length, key: refKey('A') },
        { start: 0, length: 3, key: refKey('User') },
      ]],
    ])('REFUSES %s (the value scan answers)', (_, parameterSpans) => {
      const childBag = childBagWithSlot();
      // `Fn::If`, which the template parse never reads, so the refusal is this arm's.
      const source = { 'Fn::If': ['On', { 'Fn::Sub': '${User}-${A}-${AWS::StackName}' }, 'x'] };
      recordIntrinsicLeafResolution(childBag, source, {
        input: leaf,
        output: leaf,
        substitutions: [],
        complete: true,
        parameterSpans,
      });
      const persisted = redactSecretsForState({ P1: leaf }, childBag, { P1: source }) as Record<
        string,
        unknown
      >;
      expect(persisted['P1']).toBe(`app-${EXPR_B}-ChildStack`);
    });

    it('REFUSES an overlong span whose clamped text IS the plaintext (the upper bound)', () => {
      const childBag = childBagWithSlot();
      const short = `app-${SHARED}`;
      const source = { 'Fn::If': ['On', { 'Fn::Sub': '${User}-${A}' }, 'x'] };
      recordIntrinsicLeafResolution(childBag, source, {
        input: short,
        output: short,
        substitutions: [],
        complete: true,
        parameterSpans: [{ start: 4, length: SHARED.length + 5, key: refKey('A') }],
      });
      const persisted = redactSecretsForState({ P1: short }, childBag, { P1: source }) as Record<
        string,
        unknown
      >;
      expect(persisted['P1']).toBe(`app-${EXPR_B}`);
    });

    it('skips an ASSOCIATED parameter span that fails certification, positioning the rest', () => {
      const childBag = childBagWithSlot();
      const source = { 'Fn::If': ['On', { 'Fn::Sub': '${A}-${A}-${AWS::StackName}' }, 'x'] };
      recordIntrinsicLeafResolution(childBag, source, {
        input: leaf,
        output: leaf,
        substitutions: [],
        complete: true,
        // `app` is not A's plaintext: A's association refuses that span.
        parameterSpans: [
          { start: 0, length: 3, key: refKey('A') },
          { start: at, length: SHARED.length, key: refKey('A') },
        ],
      });
      const persisted = redactSecretsForState({ P1: leaf }, childBag, { P1: source }) as Record<
        string,
        unknown
      >;
      expect(persisted['P1']).toBe(`app-${EXPR_A}-ChildStack`);
    });

    it('poisons a record one resolution gave spans and another none', () => {
      const childBag = childBagWithSlot();
      const source = { 'Fn::If': ['On', { 'Fn::Sub': '${A}' }, 'x'] };
      const base = { input: leaf, output: leaf, substitutions: [], complete: true };
      recordIntrinsicLeafResolution(childBag, source, {
        ...base,
        parameterSpans: [{ start: at, length: SHARED.length, key: refKey('A') }],
      });
      recordIntrinsicLeafResolution(childBag, source, base);
      expect(intrinsicLeafResolutionOf(childBag, source)).toBeUndefined();
    });

    it('poisons a record two resolutions in one pass placed differently', () => {
      const childBag = childBagWithSlot();
      const source = { 'Fn::If': ['On', { 'Fn::Sub': '${A}' }, 'x'] };
      const base = { input: leaf, output: leaf, substitutions: [], complete: true };
      recordIntrinsicLeafResolution(childBag, source, {
        ...base,
        parameterSpans: [{ start: at, length: SHARED.length, key: refKey('A') }],
      });
      recordIntrinsicLeafResolution(childBag, source, {
        ...base,
        parameterSpans: [{ start: at, length: SHARED.length, key: refKey('B') }],
      });
      expect(intrinsicLeafResolutionOf(childBag, source)).toBeUndefined();
      const persisted = redactSecretsForState({ P1: leaf }, childBag, { P1: source }) as Record<
        string,
        unknown
      >;
      expect(persisted['P1']).toBe(`app-${EXPR_B}-ChildStack`);
    });
  });

  describe('keeps every #4448 guard (each refusal is the value scan\'s answer)', () => {
    it('REFUSES an uncertified span the value scan would rewrite (Tail carries the plaintext)', async () => {
      const { persisted } = await bothHalves({
        P1: { 'Fn::Sub': '${User}:${A}${Tail}' },
        P2: { Ref: 'B' },
      });
      expect(persisted['P1']).toBe(`app:${EXPR_B}q:${EXPR_B}`);
    });

    it('REFUSES a recorded needle crossing a certified span\'s edge', async () => {
      const FRAGMENT = 'topsecretfragment';
      const source = { P1: { 'Fn::Sub': `\${User}-${FRAGMENT}\${A}-\${AWS::StackName}` }, P2: { Ref: 'B' } };
      const { resolved, childBag } = await resolveChild(source);
      const STRADDLE = FRAGMENT + SHARED.slice(0, 3);
      childBag.set(STRADDLE, '{{resolve:ssm:straddle}}');
      const persisted = redactSecretsForState(resolved, childBag, source) as Record<string, unknown>;
      expect(persisted['P1']).not.toContain(FRAGMENT);
      expect(persisted['P1']).toBe(`app-{{resolve:ssm:straddle}}${SHARED.slice(3)}-ChildStack`);
    });

    it('REFUSES when a gap holds a containment needle: the leaf is masked WHOLE', async () => {
      const MIDDLE = 'n0echo-cust0m-res0urce-v4lue';
      const source = {
        P1: { 'Fn::Sub': `\${User}-\${A}-${MIDDLE}-\${AWS::StackName}` },
        P2: { Ref: 'B' },
      };
      const { resolved, childBag } = await resolveChild(source);
      recordDerivedMaskOnlyValue(childBag, MIDDLE);
      const persisted = redactSecretsForState(resolved, childBag, source) as Record<string, unknown>;
      expect(persisted['P1']).toBe(SECRET_MASK);
    });

    it('REFUSES a 1-3 character gap equal to a recorded sub-floor plaintext (never that secret\'s reference)', async () => {
      const PIN_EXPR = '{{resolve:secretsmanager:prod/pin:SecretString:p::}}';
      const source = { P1: { 'Fn::Join': ['', [{ Ref: 'A' }, { Ref: 'User' }]] }, P2: { Ref: 'B' } };
      const { resolved, childBag } = await resolveChild(source);
      childBag.set('app', PIN_EXPR);
      const persisted = redactSecretsForState(resolved, childBag, source) as Record<string, unknown>;
      expect(persisted['P1']).not.toContain(PIN_EXPR);
      expect(persisted['P1']).toBe(`${EXPR_B}app`);
    });

    it('REFUSES when the leaf being persisted is not the output the record describes', async () => {
      const source = { P1: { 'Fn::Sub': '${User}-${A}-${AWS::StackName}' }, P2: { Ref: 'B' } };
      const { childBag } = await resolveChild(source);
      const persisted = redactSecretsForState(
        { P1: `app-${SHARED}-Other`, P2: SHARED },
        childBag,
        source
      ) as Record<string, unknown>;
      expect(persisted['P1']).toBe(`app-${EXPR_B}-Other`);
    });
  });
});
