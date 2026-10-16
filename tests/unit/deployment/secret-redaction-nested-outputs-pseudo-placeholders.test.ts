/**
 * A nested child's `Outputs` `Fn::Join` / `Fn::Sub` reading a parameter beside
 * two or more pseudo parameters keeps the literal parameter's spelling (issue
 * [#4973](https://github.com/go-to-k/cdkd/issues/4973)).
 *
 * The outputs bag is positioned by the placeholder arm's TEMPLATE parse alone
 * (`positionByParameterPlaceholders`; the resolver's spans stay on the outputs
 * pass's own bag), which accepts at most one part it cannot key, and a pseudo
 * parameter was always such a part. So `Fn::Join ['', [{Ref: AWS::Region}, '.',
 * {Ref: AWS::AccountId}, '.', {Ref: SecretB}]]` was a slot read, and
 * `poisonRenderedSpellingsCollidingIn` withdrew the literal `ConnA`'s #4644
 * spelling for the whole child: state held the survivor where
 * `cdkd diff --recursive` renders the literal.
 *
 * The parse and the walk's count now bind a pseudo parameter from the table
 * the child's `resolveParameters` records on the inherited bag (#4962,
 * `recordInheritedPseudoParameters`); a pseudo the table does not hold stays
 * unknown on both sides.
 *
 * Drives a REAL `DeployEngine` outputs pass with the REAL resolver, the REAL
 * `resolveParameters` and the REAL `redactOutputs`, against the diff side the
 * engine binds (`redactParametersForDiff`) and the literal binding
 * `cdkd diff --recursive` renders.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  redactInheritedParameterValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { poisonRenderedSpellingsCollidingIn } from '../../../src/deployment/intrinsic-resolver/parameter-secrets.js';
import { recordInheritedPseudoParameters } from '../../../src/deployment/secret-redaction/nested-stack.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-resolver/account-drain.js';
import { scrubStack } from '../../../src/cli/commands/scrub.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const mockStsSend = vi.fn();
// STS answers the resolver's `AWS::AccountId`; the CloudFormation client is
// inert (the create-only DescribeType prefetch reads the process-global factory).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return {
    ...actual,
    getAwsClients: (...args: Parameters<typeof actual.getAwsClients>) =>
      new Proxy(actual.getAwsClients(...args), {
        get: (target, key) => {
          if (key === 'sts') return { send: mockStsSend };
          if (key === 'cloudFormation') {
            throw new Error('test stub: no real AWS client (cloudFormation)');
          }
          return Reflect.get(target, key) as unknown;
        },
      }),
  };
});

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

const ACCOUNT = '123456789012';
const EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:out4973::}}';
const EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:out4973:AWSCURRENT:}}';
const USER_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:out4973user::}}';
const SHARED = 'sh4red-0utputs-pl4intext-4973';
const USER = 'us3r-0utputs-4973';
const PARAM_A = 'ConnA';
const PARAM_B = 'SecretB';
const SPELLING = `postgres://${USER_EXPR}:${EXPR_A}@host`;
const SURVIVOR_SPELLING = `postgres://${USER_EXPR}:${EXPR_B}@host`;
const CONN = `postgres://${USER}:${SHARED}@host`;
const PARAMETERS = { [PARAM_A]: CONN, [PARAM_B]: SHARED };

const ref = (name: string): Record<string, unknown> => ({ Ref: name });

/** One parent row's bag; `reversed` resolves `ConnA` first, so `EXPR_B` survives. */
function parentRow(
  reversed: boolean,
  shared = SHARED,
  parameters: Record<string, string> = PARAMETERS,
  user = USER
): RecordedSecretValues {
  const conn = [
    [USER_EXPR, user],
    [EXPR_A, shared],
  ] as const;
  const order = reversed ? [...conn, [EXPR_B, shared] as const] : [[EXPR_B, shared] as const, ...conn];
  const parent: RecordedSecretValues = new Map();
  for (const [expression, plaintext] of order) {
    parent.set(plaintext, expression);
    recordResolvedPair(parent, expression, plaintext);
  }
  recordNestedStackParameterExpressions(
    parent,
    'AWS::CloudFormation::Stack',
    { Parameters: parameters },
    { Parameters: { [PARAM_A]: SPELLING, [PARAM_B]: EXPR_B } }
  );
  return parent;
}

function childTemplate(outputs: Record<string, unknown>): CloudFormationTemplate {
  return {
    Parameters: { [PARAM_A]: { Type: 'String' }, [PARAM_B]: { Type: 'String' } },
    Resources: {},
    Outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, { Value: value }])),
  } as CloudFormationTemplate;
}

function childEngine(parent: RecordedSecretValues): DeployEngine {
  return new DeployEngine(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { dryRun: false, inheritedSecrets: parent } as never,
    'us-east-1'
  );
}

const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

/**
 * The child's step 2.5 as `deploy-flow.ts` runs it -- `resolveParameters`
 * (which records the pseudo table) then the collision walk -- unless
 * `skipTable`, then the outputs pass, its persist redaction, the outputs the
 * engine's diff side binds, and the literal binding `cdkd diff --recursive`
 * renders from the parent row.
 */
async function persistAndDesired(
  parent: RecordedSecretValues,
  template: CloudFormationTemplate,
  parameters: Record<string, string> = PARAMETERS,
  skipTable = false
): Promise<{
  persisted: Record<string, unknown>;
  /** One redaction pass alone: the exposure checks read it unaided by the second. */
  once: Record<string, unknown>;
  desired: Record<string, unknown>;
  literal: Record<string, unknown>;
}> {
  const values = skipTable
    ? parameters
    : await resolver.resolveParameters(template, parameters, { inheritedSecrets: parent });
  poisonRenderedSpellingsCollidingIn(template, values, parent);
  const engine = childEngine(parent);
  const resolved = await engine.resolveOutputs(template, {}, 'Parent~Child', template, parameters);
  // Twice, as the save's choke point re-redacts the pass's own redaction.
  const once = engine.redactOutputs(resolved);
  const persisted = engine.redactOutputs(once);
  const resolveOutputsWith = async (bound: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [key, output] of Object.entries(template.Outputs ?? {})) {
      out[key] = await resolver.resolve((output as { Value: unknown }).Value, {
        template,
        resources: {},
        parameters: bound,
        inheritedSecrets: parent,
        stackName: 'Parent~Child',
        skipDynamicReferences: true,
      } as unknown as ResolverContext);
    }
    return out;
  };
  const desired = await resolveOutputsWith(engine.redactParametersForDiff(parameters));
  const literal = await resolveOutputsWith({ [PARAM_A]: SPELLING, [PARAM_B]: EXPR_B });
  return { persisted, once, desired, literal };
}

beforeEach(() => {
  resetAccountInfoCache();
  mockStsSend.mockReset();
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });
});

describe("a nested child's Outputs placeholder beside two or more pseudo parameters keeps each spelling (#4973)", () => {
  // `OB` reads the same-plaintext sibling through a placeholder holding two
  // or more pseudo parameters; `OA` reads the literal (the last shape: both
  // through one placeholder).
  // `AWS::AccountId` is not in the table here (no re-read trigger, #4975), so
  // it stays the one unknown part the parse accepts.
  const SHAPES: Record<string, Record<string, unknown>> = {
    "the issue's Fn::Join: Region, AccountId and SecretB": {
      OA: ref(PARAM_A),
      OB: {
        'Fn::Join': ['', [ref('AWS::Region'), '.', ref('AWS::AccountId'), '.', ref(PARAM_B)]],
      },
    },
    'Fn::Sub of SecretB between Region and URLSuffix': {
      OA: ref(PARAM_A),
      OB: { 'Fn::Sub': `\${AWS::Region}-\${AWS::URLSuffix}-\${${PARAM_B}}` },
    },
    'Fn::Sub of Partition, Region, AccountId and SecretB': {
      OA: ref(PARAM_A),
      OB: { 'Fn::Sub': `arn:\${AWS::Partition}:x:\${AWS::Region}:\${AWS::AccountId}:\${${PARAM_B}}` },
    },
    'Fn::Sub variables bound to Region and URLSuffix': {
      OA: ref(PARAM_A),
      OB: {
        'Fn::Sub': [
          `\${R}/\${U}/\${${PARAM_B}}`,
          { R: ref('AWS::Region'), U: ref('AWS::URLSuffix') },
        ],
      },
    },
    'the literal through an Fn::Join beside Region and Partition, bare SecretB': {
      OA: { 'Fn::Join': ['-', [ref('AWS::Partition'), ref('AWS::Region'), ref(PARAM_A)]] },
      OB: ref(PARAM_B),
    },
    'one Fn::Sub over both parameters and three pseudo parameters': {
      OA: ref(PARAM_A),
      OB: {
        'Fn::Sub': `\${AWS::Region}|\${${PARAM_A}}|\${AWS::URLSuffix}|\${${PARAM_B}}|\${AWS::Partition}`,
      },
    },
  };
  for (const reversed of [true, false]) {
    for (const literalLast of [true, false]) {
      for (const [shape, outputs] of Object.entries(SHAPES)) {
        it(`${reversed ? 'reversed' : 'forward'} parent order, ${literalLast ? 'literal' : 'sibling'} read last, ${shape}`, async () => {
          const ordered = literalLast
            ? { OB: outputs['OB'], OA: outputs['OA'] }
            : { OA: outputs['OA'], OB: outputs['OB'] };
          const parent = parentRow(reversed);
          const { persisted, desired, literal } = await persistAndDesired(
            parent,
            childTemplate(ordered)
          );
          // Nothing withdrawn: the diff side binds the literal.
          expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
          expect(persisted).toEqual(desired);
          expect(persisted).toEqual(literal);
          expect(JSON.stringify(persisted['OA'])).toContain(EXPR_A);
          expect(JSON.stringify(persisted['OB'])).toContain(EXPR_B);
          // The pseudo values are persisted as the resolver rendered them.
          expect(JSON.stringify(persisted)).toContain('us-east-1');
          expect(JSON.stringify(persisted)).not.toContain(SHARED);
          expect(JSON.stringify(persisted)).not.toContain(USER);
        });
      }
    }
  }
});

describe('a pseudo parameter the table does not hold stays unknown (#4973)', () => {
  const UNBOUND: Record<string, Record<string, unknown>> = {
    // `AWS::StackName` is never in the table; `AWS::AccountId` is not without
    // a re-read trigger: two unknown parts.
    'StackName and AccountId': {
      OA: ref(PARAM_A),
      OB: { 'Fn::Sub': `\${AWS::StackName}-\${AWS::AccountId}-\${${PARAM_B}}` },
    },
    'StackId and StackName in an Fn::Join': {
      OA: ref(PARAM_A),
      OB: { 'Fn::Join': ['-', [ref('AWS::StackId'), ref('AWS::StackName'), ref(PARAM_B)]] },
    },
    // One bound pseudo parameter does not make up for two unbound ones.
    'Region beside StackName and AccountId': {
      OA: ref(PARAM_A),
      OB: { 'Fn::Sub': `\${AWS::Region}-\${AWS::StackName}-\${AWS::AccountId}-\${${PARAM_B}}` },
    },
  };
  for (const literalLast of [true, false]) {
    for (const [shape, outputs] of Object.entries(UNBOUND)) {
      it(`${shape} (${literalLast ? 'literal' : 'sibling'} read last): withdraws, and persists what the diff side binds`, async () => {
        const parent = parentRow(true);
        const ordered = literalLast
          ? { OB: outputs['OB'], OA: outputs['OA'] }
          : { OA: outputs['OA'], OB: outputs['OB'] };
        const { persisted, desired } = await persistAndDesired(parent, childTemplate(ordered));
        expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SURVIVOR_SPELLING);
        expect(persisted).toEqual(desired);
        expect(JSON.stringify(persisted)).not.toContain(SHARED);
      });
    }
  }

  it('withdraws where the walk runs without the child having recorded the table', async () => {
    const parent = parentRow(true);
    const template = childTemplate({
      OA: ref(PARAM_A),
      OB: { 'Fn::Sub': `\${AWS::Region}-\${AWS::URLSuffix}-\${${PARAM_B}}` },
    });
    const { persisted, desired } = await persistAndDesired(parent, template, PARAMETERS, true);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SURVIVOR_SPELLING);
    expect(persisted).toEqual(desired);
  });

  it('withdraws once two passes recorded different values on one bag (a poisoned table)', async () => {
    const parent = parentRow(true);
    recordInheritedPseudoParameters(parent, new Map([['AWS::Region', 'eu-west-1']]));
    const template = childTemplate({
      OA: ref(PARAM_A),
      OB: { 'Fn::Sub': `\${AWS::Region}-\${AWS::URLSuffix}-\${${PARAM_B}}` },
    });
    const { persisted, desired } = await persistAndDesired(parent, template);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SURVIVOR_SPELLING);
    expect(persisted).toEqual(desired);
  });

  it('asks STS for nothing to bind a pseudo parameter', async () => {
    const parent = parentRow(true);
    const template = childTemplate({
      OA: ref(PARAM_A),
      OB: { 'Fn::Sub': `\${AWS::Region}-\${AWS::URLSuffix}-\${${PARAM_B}}` },
    });
    await resolver.resolveParameters(template, PARAMETERS, { inheritedSecrets: parent });
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    expect(mockStsSend).not.toHaveBeenCalled();
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
  });
});

describe('a bound pseudo value equal to or overlapping a parent plaintext persists no plaintext (#4973)', () => {
  // The secret IS a pseudo value's text, or straddles one. The walk counts
  // such a value keyed; the parse's final re-scan refuses it, so the leaf
  // falls to the value scan and persists no plaintext.
  const LEAVES: Record<string, { secret: string; leaf: unknown }> = {
    'the secret is the region': {
      secret: 'us-east-1',
      leaf: { 'Fn::Sub': `\${AWS::Region}-\${AWS::URLSuffix}-\${${PARAM_B}}` },
    },
    'the secret is the URL suffix': {
      secret: 'amazonaws.com',
      leaf: { 'Fn::Join': ['/', [ref('AWS::Region'), ref('AWS::URLSuffix'), ref(PARAM_B)]] },
    },
    'a secret straddling the region and literal text': {
      secret: 'east-1xyz',
      leaf: { 'Fn::Sub': `\${AWS::URLSuffix}.\${AWS::Region}xyz-\${${PARAM_B}}` },
    },
  };
  for (const reversed of [true, false]) {
    for (const [shape, { secret, leaf }] of Object.entries(LEAVES)) {
      it(`${reversed ? 'reversed' : 'forward'} parent order, ${shape}`, async () => {
        const conn = `postgres://${USER}:${secret}@host`;
        const parameters = { [PARAM_A]: conn, [PARAM_B]: secret };
        const parent = parentRow(reversed, secret, parameters);
        const { persisted, once } = await persistAndDesired(
          parent,
          childTemplate({ OA: ref(PARAM_A), OB: leaf }),
          parameters
        );
        for (const bag of [once, persisted]) {
          expect(JSON.stringify(bag)).not.toContain(secret);
          expect(JSON.stringify(bag)).not.toContain(USER);
        }
      });
    }
  }
});

describe('a parent plaintext crossing from a bound pseudo value into a certified span persists no plaintext (#4973)', () => {
  // `user` is the region followed by the head of SecretB's value, so in
  // `${AWS::Region}${SecretB}` it starts in the pseudo text and ends inside
  // SecretB's certified span: the straddle guard refuses it on the resolved
  // leaf, since the span's swap would leave its pseudo half unscannable.
  for (const reversed of [true, false]) {
    it(`${reversed ? 'reversed' : 'forward'} parent order`, async () => {
      const secret = 'pw12-str4ddle-4973';
      const user = 'us-east-1pw12';
      const parameters = { [PARAM_A]: `postgres://${user}:${secret}@host`, [PARAM_B]: secret };
      const parent = parentRow(reversed, secret, parameters, user);
      const { persisted, once } = await persistAndDesired(
        parent,
        childTemplate({
          OA: ref(PARAM_A),
          OB: { 'Fn::Sub': `\${AWS::Region}\${${PARAM_B}}` },
        }),
        parameters
      );
      for (const bag of [once, persisted]) {
        expect(JSON.stringify(bag)).not.toContain(secret);
        expect(JSON.stringify(bag)).not.toContain(user);
        // ...nor the needle's pseudo half beside SecretB's spelling, which is
        // what persisting the span's expression would leave behind.
        expect(bag['OB']).not.toContain('us-east-1');
      }
    });
  }
});

describe('cdkd scrub writes the outputs the deploy persists (#4973)', () => {
  const scrubLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
  for (const reversed of [true, false]) {
    for (const literalLast of [true, false]) {
      it(`${reversed ? 'reversed' : 'forward'} parent order, ${literalLast ? 'literal' : 'sibling'} read last`, async () => {
        const pseudo = {
          'Fn::Join': ['', [ref('AWS::Region'), '.', ref('AWS::URLSuffix'), '.', ref(PARAM_B)]],
        };
        const template = childTemplate(
          literalLast ? { OB: pseudo, OA: ref(PARAM_A) } : { OA: ref(PARAM_A), OB: pseudo }
        );
        const scrubParent = parentRow(reversed);
        const state = {
          version: 9,
          region: 'us-east-1',
          stackName: 'Parent~Child',
          resources: {},
          // A record holding the plaintext, as scrub exists to repair.
          outputs: { OA: CONN, OB: `us-east-1.amazonaws.com.${SHARED}` },
          lastModified: 0,
        } as unknown as StackState;
        const saveState = vi.fn().mockResolvedValue('etag-2');
        await scrubStack(
          { stackName: 'Parent~Child', template } as never,
          'us-east-1',
          {
            getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
            saveState,
            purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
            listStacks: vi.fn().mockResolvedValue([]),
          } as never,
          {
            acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
            releaseLock: vi.fn().mockResolvedValue(undefined),
          } as never,
          {
            dryRun: false,
            logger: scrubLogger,
            nestedChild: {
              logicalId: 'Child',
              stackName: 'Parent~Child',
              input: { parameters: PARAMETERS, inheritedSecrets: scrubParent },
            },
          } as never
        );
        expect(redactInheritedParameterValue(scrubParent, PARAM_A, CONN)).toBe(SPELLING);
        const saved = (saveState.mock.calls.at(-1)![2] as StackState).outputs;
        const { persisted, literal } = await persistAndDesired(parentRow(reversed), template);
        expect(saved).toEqual(persisted);
        expect(saved).toEqual(literal);
        expect(saved['OA']).toBe(SPELLING);
        expect(saved['OB']).toBe(`us-east-1.amazonaws.com.${EXPR_B}`);
      });
    }
  }
});
