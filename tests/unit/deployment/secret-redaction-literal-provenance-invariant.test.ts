/**
 * The provenance INVARIANT behind go-to-k/cdkd#6303 and #7037: text the
 * template spells as a plain literal is public, so the persist walk never
 * spells it as a secret's reference, whatever secret it equals or contains.
 * A redaction artifact there would be a change only the next diff sees (a
 * create-only one replaces the resource).
 *
 * Generated, not hand-picked: every short, common secret value crossed with
 * every literal position. Each case deploys through the real `DeployEngine`,
 * `DiffCalculator` and resolver, then deploys the same template again and
 * asserts that the second deploy's diff is NO_CHANGE and sends nothing. The
 * same template's secret-derived leaves must still be persisted as their
 * references, with no plaintext anywhere in the saved state.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

const secret = vi.hoisted(() => ({
  username: 'postgres',
  password: 'Zq9-unguessable-pw-Xk2',
  pin: 'x9',
}));

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
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    // An account id holding none of the sampled secrets: a gap whose resolved
    // text contains a secret's falls to the value scan by design.
    sts: { send: vi.fn().mockResolvedValue({ Account: '210987654321' }) },
    secretsManager: {
      send: vi.fn(async () => ({ SecretString: JSON.stringify(secret) })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
    ssm: {
      send: vi.fn().mockResolvedValue({
        Parameter: { Value: 'unused', Type: 'String', Version: 1 },
      }),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return { SecretString: JSON.stringify(secret) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSSMClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return { Parameter: { Value: 'unused', Type: 'String', Version: 1 } };
    }
    destroy(): void {}
  }
  return { ...actual, SSMClient: FakeSSMClient };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { MIN_NEEDLE_LENGTH } from '../../../src/deployment/secret-redaction/rules.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/** Short, common secret values, and one under the substring scan's floor. */
const SECRET_VALUES = ['postgres', 'admin', 'root', 'user', 'test', '1234', 'pg'] as const;

/** Every position a template spells a literal at, holding `v` (and the references). */
function literalPositions(
  v: string,
  user: string,
  password: string
): Record<string, Record<string, unknown>> {
  return {
    'whole-value scalar': { Label: v },
    substring: { Label: `x-${v}-y` },
    'nested object': { Settings: { Inner: { Name: v } } },
    'array element': { Names: ['first', v, 'last'] },
    'create-only property (Engine)': { Engine: v },
    'Fn::Join of literal and reference': {
      Label: { 'Fn::Join': ['', [v, ':', user, '@', v]] },
    },
    'Fn::Sub of literal and reference': { Label: { 'Fn::Sub': `${v}:${user}/${v}` } },
    'Fn::Join of literals only': { Label: { 'Fn::Join': ['', [v.slice(0, 1), v.slice(1)]] } },
    'Fn::Join with the password beside a literal': {
      Label: { 'Fn::Join': ['-', [v, password]] },
    },
    'Fn::If taking a literal branch': { Label: { 'Fn::If': ['IsOn', v, 'other'] } },
    'Fn::If with a NoValue branch': { Label: { 'Fn::If': ['IsOn', `${v}-x`, { Ref: 'AWS::NoValue' }] } },
    'Fn::If taking its else branch': { Label: { 'Fn::If': ['IsOff', 'other', v] } },
    'Fn::If taking its else branch beside NoValue': {
      Label: { 'Fn::If': ['IsOff', { Ref: 'AWS::NoValue' }, `${v}-x`] },
    },
    'Fn::If whose literal branch equals the other branch secret': {
      Label: { 'Fn::If': ['IsOn', v, user] },
    },
    'Fn::Select over literals at a create-only property': { Engine: { 'Fn::Select': [0, [v, 'b']] } },
    'Fn::Sub with inline pseudo parameter and reference': {
      Label: { 'Fn::Sub': `${v}-\${AWS::Region}-${user}` },
    },
    // m2 / M3 (#5056 / #5063): a variable mapped to the reference, under the floor too.
    'Fn::Sub variable mapped to the reference': { Label: { 'Fn::Sub': ['${U}:x', { U: user }] } },
    'Fn::Sub variable map of template text': { Label: { 'Fn::Sub': ['${U}-x', { U: v }] } },
    'Fn::Join with an AWS::NoValue element': { Engine: { 'Fn::Join': ['', [v, { Ref: 'AWS::NoValue' }]] } },
    ...generatedMixes(v, user, password),
  };
}

/**
 * The generated half of the space: every TEMPLATE-TEXT part crossed with
 * every GAP kind, in an `Fn::Join` and in an `Fn::Sub` variable map. The text
 * parts must persist as spelled and the gaps as the diff side computes them
 * (resolved, or the reference itself), which the NO_CHANGE assertion checks.
 */
function generatedMixes(
  v: string,
  user: string,
  password: string
): Record<string, Record<string, unknown>> {
  const texts: Record<string, unknown> = {
    'the value': v,
    'a URL scheme around it': `${v}ql://`,
    'a path holding it': `/${v}`,
    'a number': 5432,
    'an Fn::Select of an Fn::Split of literals': { 'Fn::Select': [0, { 'Fn::Split': [',', `${v},other`] }] },
    'an Fn::Select of a literal list': { 'Fn::Select': ['1', ['x', v]] },
  };
  const gaps: Record<string, unknown> = {
    'a pseudo parameter': { Ref: 'AWS::Region' },
    'another pseudo parameter': { Ref: 'AWS::AccountId' },
    "a reader's copy of a secret-named resource": { Ref: 'Queue' },
    'the username reference': user,
    'the password reference': password,
    'an Fn::If inside the join': { 'Fn::If': ['IsOn', { Ref: 'AWS::Region' }, 'zz'] },
  };
  const out: Record<string, Record<string, unknown>> = {};
  for (const [textName, text] of Object.entries(texts)) {
    for (const [gapName, gap] of Object.entries(gaps)) {
      out[`Join: ${textName} + ${gapName}`] = {
        Label: { 'Fn::Join': ['', [text, gap, `/${v}`]] },
      };
      out[`Sub map: ${textName} + ${gapName}`] = {
        Label: { 'Fn::Sub': ['${A}@${G}:${A}', { A: text, G: gap }] },
      };
    }
  }
  return out;
}

/**
 * The shapes of the earlier instances of this class, present in EVERY case, so
 * each secret value meets them too: a 1-3 character secret embedded in a
 * literal (#5056 / #5063, under the substring floor), an `Fn::If` taking its
 * reference branch (#4954), and a reader's copy of a secret-derived name
 * (#4810). Each secret-derived leaf has an exact expected spelling.
 */
function classShapes(user: string, pin: string): Record<string, unknown> {
  return {
    PinUrl: `db://host/?pin=${pin}`,
    LongEmbedded: `owner=${user};`,
    IfReference: { 'Fn::If': ['IsOn', user, 'fallback'] },
    QueueUrl: { Ref: 'Queue' },
  };
}

interface Run {
  calls: string[];
  persisted: StackState['resources'] | undefined;
  diff: Map<string, ResourceChange> | undefined;
  thrown: unknown;
}

/** A queue NAMED from the username: its URL is a secret-derived physical name (#4810). */
function physicalIdOf(id: string): string {
  return id === 'Queue'
    ? `https://sqs.us-east-1.amazonaws.com/210987654321/q-${secret.username}`
    : 'db-instance';
}

class CapturingDiffCalculator extends DiffCalculator {
  last: Map<string, ResourceChange> | undefined;
  override async calculateDiff(
    ...args: Parameters<DiffCalculator['calculateDiff']>
  ): ReturnType<DiffCalculator['calculateDiff']> {
    const result = await super.calculateDiff(...args);
    this.last = result;
    return result;
  }
}

async function deploy(
  resources: StackState['resources'],
  template: Record<string, unknown>
): Promise<Run> {
  const state = {
    version: 11,
    stackName: 's',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  } as StackState;
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async (id: string) => {
      calls.push('create:' + id);
      return { physicalId: physicalIdOf(id), attributes: {} };
    }),
    update: vi.fn(async (id: string) => {
      calls.push('update:' + id);
      return { physicalId: physicalIdOf(id), attributes: {} };
    }),
    delete: vi.fn(async (id: string) => {
      calls.push('delete:' + id);
    }),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const diffCalculator = new CapturingDiffCalculator();
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Queue'], ['Db']]),
      getDirectDependencies: vi.fn((_dag: unknown, id: string) => (id === 'Db' ? ['Queue'] : [])),
    } as never,
    diffCalculator,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    { dryRun: false },
    'us-east-1'
  );
  let thrown: unknown;
  await engine.deploy('s', template as never).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object)
    );
  return { calls, persisted: saved[saved.length - 1]?.resources, diff: diffCalculator.last, thrown };
}

describe('a template literal is never persisted as a secret reference (#6303, #7037)', () => {
  it('the sample reaches under the substring floor', () => {
    expect(SECRET_VALUES.some((v) => v.length < MIN_NEEDLE_LENGTH)).toBe(true);
    expect(secret.pin.length).toBeLessThan(MIN_NEEDLE_LENGTH);
  });

  const cases = SECRET_VALUES.flatMap((v) =>
    Object.keys(literalPositions(v, 'u', 'p')).map((position) => [v, position] as const)
  );

  it.each(cases)('secret %j at %s: no change on the next deploy, no plaintext', async (v, position) => {
    secret.username = v;
    // A secret per case: the resolver's lookups and verdicts are process-wide.
    const arn = `arn:aws:secretsmanager:us-east-1:210987654321:secret:db-${position.replace(/\W+/g, '')}-${v}`;
    const user = `{{resolve:secretsmanager:${arn}:SecretString:username::}}`;
    const password = `{{resolve:secretsmanager:${arn}:SecretString:password::}}`;
    const pin = `{{resolve:secretsmanager:${arn}:SecretString:pin::}}`;
    const template = {
      Conditions: {
        IsOn: { 'Fn::Equals': ['a', 'a'] },
        IsOff: { 'Fn::Equals': ['a', 'b'] },
      },
      Resources: {
        Queue: {
          Type: 'AWS::SQS::Queue',
          Properties: { QueueName: { 'Fn::Join': ['', ['q-', user]] } },
        },
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: {
            MasterUsername: user,
            MasterUserPassword: password,
            ...classShapes(user, pin),
            ...literalPositions(v, user, password)[position],
          },
        },
      },
    };

    const first = await deploy({}, template);
    expect(first.thrown).toBeUndefined();
    expect(first.calls).toEqual(['create:Queue', 'create:Db']);
    const record = first.persisted?.['Db'];
    expect(record).toBeDefined();
    // No leak: every secret-derived leaf keeps its reference, at its exact
    // spelling, and no plaintext the template does not spell is in state.
    expect(record!.properties['MasterUsername']).toBe(user);
    expect(record!.properties['MasterUserPassword']).toBe(password);
    expect(record!.properties['PinUrl']).toBe(`db://host/?pin=${pin}`);
    expect(record!.properties['LongEmbedded']).toBe(`owner=${user};`);
    expect(record!.properties['IfReference']).toBe(user);
    expect(first.persisted?.['Queue']?.properties['QueueName']).toBe(`q-${user}`);
    // The reader's copy of the queue's URL is the physical id, as cdkd keeps it.
    expect(record!.properties['QueueUrl']).toBe(physicalIdOf('Queue'));
    const saved = JSON.stringify(first.persisted);
    expect(saved).not.toContain(secret.password);
    expect(saved).not.toContain(`pin=${secret.pin}`);

    const second = await deploy(first.persisted!, template);
    expect(second.thrown).toBeUndefined();
    expect(second.diff?.get('Queue')?.changeType).toBe('NO_CHANGE');
    expect(second.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(second.calls).toEqual([]);
  });
});
