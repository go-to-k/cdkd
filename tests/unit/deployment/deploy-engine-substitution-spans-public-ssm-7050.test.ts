/**
 * go-to-k/cdkd#7050 security review: a leaf masked because a secret's text
 * sits beside a value-bearing part, which also spells a PUBLIC
 * `{{resolve:ssm:...}}` reference. The fingerprints hash that reference's
 * text, not its value, so without the public-reference fingerprint a moved
 * `String` parameter planned no change and the deploy skipped it.
 * CloudFormation documents that skip for Secrets Manager only, so a secret's
 * value change stays unseen (parity) while a public value change is sent.
 * Through the real DeployEngine, DiffCalculator and resolver.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

const LIVE = { pub: 'pub-v1', pubVersion: 1, username: 'pg' };
const secretResponse = (): unknown => ({
  SecretString: JSON.stringify({ username: LIVE.username, other: 'x9' }),
  VersionId: 'a1b2c3d4-0000-4000-8000-000000000002',
});
const ssmResponse = (): unknown => ({
  Parameter: { Value: LIVE.pub, Type: 'String', Version: LIVE.pubVersion },
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    secretsManager: {
      send: vi.fn(async () => secretResponse()),
      config: { region: () => Promise.resolve('us-east-1') },
    },
    ssm: {
      send: vi.fn(async () => ssmResponse()),
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
      return secretResponse();
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
      return ssmResponse();
    }
    destroy(): void {}
  }
  return { ...actual, SSMClient: FakeSSMClient };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

const USERNAME = '{{resolve:secretsmanager:db-secret:SecretString:username::}}';
const OTHER = '{{resolve:secretsmanager:db-secret:SecretString:other::}}';
const PUB = '{{resolve:ssm:/pub}}';

interface Run {
  calls: string[];
  persisted: StackState['resources'][string] | undefined;
  thrown: unknown;
  diff: Map<string, ResourceChange> | undefined;
  sent: Array<{ props: unknown; previous: unknown }>;
}

class CapturingDiffCalculator extends DiffCalculator {
  last: Map<string, ResourceChange> | undefined;
  override async calculateDiff(
    ...args: Parameters<DiffCalculator['calculateDiff']>
  ): ReturnType<DiffCalculator['calculateDiff']> {
    const result = await super.calculateDiff(...args);
    this.last = new Map([...result].map(([id, c]) => [id, structuredClone(c)]));
    return result;
  }
}

const template = {
  Parameters: { Host: { Type: 'String', Default: 'pg-host' } } as Record<string, unknown>,
  Resources: {
    // An in-place property (a create-only one would plan a replacement).
    Db: {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
        Path: '/',
        Tags: [{ Key: 'owner', Value: OTHER }],
        Description: { 'Fn::Join': ['', [PUB, USERNAME, '@', { Ref: 'Host' }]] } as unknown,
      },
    },
  },
};

async function deploy(resources: StackState['resources']): Promise<Run> {
  const state = {
    version: 11,
    stackName: 's',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  } as StackState;
  const calls: string[] = [];
  const sent: Array<{ props: unknown; previous: unknown }> = [];
  const provider = {
    create: vi.fn(async (id: string) => {
      calls.push('create:' + id);
      return { physicalId: 'new', attributes: {} };
    }),
    update: vi.fn(
      async (id: string, _pid: string, _type: string, props: unknown, previous: unknown) => {
        calls.push('update:' + id);
        sent.push({ props, previous });
        return { physicalId: resources[id]!.physicalId, attributes: {} };
      }
    ),
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
      getExecutionLevels: vi.fn().mockReturnValue([['Db']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
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
  await engine.deploy('s', structuredClone(template) as never).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object)
    );
  return {
    calls,
    persisted: saved[saved.length - 1]?.resources['Db'],
    thrown,
    diff: diffCalculator.last,
    sent,
  };
}

const paths = (r: Run): string[] =>
  (r.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path);

async function created(): Promise<StackState['resources'][string]> {
  const run = await deploy({});
  expect(run.thrown).toBeUndefined();
  // The precondition: the leaf is stored masked, with a reference fingerprint.
  expect(run.persisted?.properties['Description']).toBe('***');
  expect(Object.keys(run.persisted?.maskedPropertyReferenceFingerprints ?? {})).toEqual([
    'Description',
  ]);
  // The public value is hashed, never stored; no secret reaches state.
  const text = JSON.stringify(run.persisted).split(/\{\{resolve:[^}]+\}\}/).join(' ');
  expect(text).not.toContain('pub-v');
  expect(text).not.toMatch(/(^|[^a-z])pg([^a-z-]|$)/);
  return run.persisted!;
}

const SPELLED = template.Resources.Db.Properties.Description;

describe('a masked leaf spelling a public ssm reference (#7050 security review)', () => {
  beforeEach(() => {
    template.Parameters = { Host: { Type: 'String', Default: 'pg-host' } };
    template.Resources.Db.Properties.Description = SPELLED;
    LIVE.pub = 'pub-v1';
    LIVE.pubVersion = 1;
    LIVE.username = 'pg';
  });

  it('an unchanged public value plans NO_CHANGE and sends nothing', async () => {
    const record = await created();
    const same = await deploy({ Db: structuredClone(record) });
    expect(same.thrown).toBeUndefined();
    expect(same.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(same.calls).toEqual([]);
  });

  it('a public value equal to a NoEcho parameter value is refused alike by plan and engine', async () => {
    // The engine refuses to hash a value a NoEcho parameter also holds; the
    // plan must refuse it the same way, or it reads a move on every deploy.
    template.Parameters = {
      Host: { Type: 'String', Default: 'pg-host' },
      Pw: { Type: 'String', NoEcho: true, Default: 'pub-v1' },
    };
    const first = await deploy({});
    expect(first.thrown).toBeUndefined();
    const second = await deploy({ Db: structuredClone(first.persisted!) });
    expect(second.thrown).toBeUndefined();
    expect(second.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(second.calls).toEqual([]);
    const third = await deploy({ Db: structuredClone(second.persisted ?? first.persisted!) });
    expect(third.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(JSON.stringify(first.persisted)).not.toContain('pub-v1');
  });

  it('a changed public value plans the key, sends it unmasked, and settles', async () => {
    const record = await created();
    LIVE.pub = 'pub-v2';
    LIVE.pubVersion = 2;
    const moved = await deploy({ Db: structuredClone(record) });
    expect(moved.thrown).toBeUndefined();
    expect(paths(moved)).toEqual(['Description']);
    expect(moved.calls).toEqual(['update:Db']);
    const props = moved.sent[0]!.props as Record<string, unknown>;
    expect(props['Description']).toBe('pub-v2pg@pg-host');
    // The value sent is the resolved one, never the mask (the previous side
    // of a changed masked key is the record's, as for any moved masked key).
    expect(JSON.stringify(moved.sent.map((call) => call.props))).not.toContain('***');
    // The new value is recorded, so the next deploy is quiet again.
    expect(moved.persisted?.maskedPropertyReferenceFingerprints?.['Description']).not.toBe(
      record.maskedPropertyReferenceFingerprints?.['Description']
    );
    const settled = await deploy({ Db: structuredClone(moved.persisted!) });
    expect(settled.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(settled.calls).toEqual([]);
  });

  it("a changed SECRET value stays unseen, as in CloudFormation", async () => {
    const record = await created();
    LIVE.username = 'pz';
    const rotated = await deploy({ Db: structuredClone(record) });
    expect(rotated.thrown).toBeUndefined();
    expect(rotated.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(rotated.calls).toEqual([]);
  });

  it('a record with no reference fingerprint (an older one) plans the key', async () => {
    const record = await created();
    delete record.maskedPropertyReferenceFingerprints;
    const old = await deploy({ Db: structuredClone(record) });
    expect(old.thrown).toBeUndefined();
    expect(paths(old)).toEqual(['Description']);
    expect(old.calls).toEqual(['update:Db']);
    // The value sent is the resolved one, never the mask (the previous side
    // of a changed masked key is the record's, as for any moved masked key).
    expect(JSON.stringify(old.sent.map((call) => call.props))).not.toContain('***');
    expect(old.persisted?.maskedPropertyReferenceFingerprints?.['Description']).toBeDefined();
  });

  it('an entry bound to another text fingerprint reads as absent', async () => {
    const record = await created();
    const entry = record.maskedPropertyReferenceFingerprints!['Description']!;
    record.maskedPropertyReferenceFingerprints = {
      Description: entry.replace(/\+sha256:.*/, '+sha256:' + '0'.repeat(64)),
    };
    const stale = await deploy({ Db: structuredClone(record) });
    expect(paths(stale)).toEqual(['Description']);
  });
});

/**
 * The token NAME an intrinsic assembles (`valueForStringParameter` with a
 * token name is the `Fn::Join` shape, stock CDK output). The raw template
 * spells no complete token, so the key's tokens come from its input walk's
 * resolved form: an unchanged value must settle, a changed one must move.
 */
describe.each([
  ['Fn::Sub', { 'Fn::Sub': `{{resolve:ssm:/pub/\${Host}}}${USERNAME}@\${Host}` }],
  [
    'Fn::Join',
    { 'Fn::Join': ['', ['{{resolve:ssm:/pub/', { Ref: 'Host' }, '}}', USERNAME, '@', { Ref: 'Host' }]] },
  ],
])('a masked leaf whose public ssm token name %s assembles (#7050)', (_shape, description) => {
  beforeEach(() => {
    LIVE.pub = 'pub-v1';
    LIVE.pubVersion = 1;
    LIVE.username = 'pg';
    template.Resources.Db.Properties.Description = description;
  });

  it('the 2nd and 3rd unchanged deploys plan nothing and make no calls', async () => {
    const record = await created();
    const second = await deploy({ Db: structuredClone(record) });
    expect(second.thrown).toBeUndefined();
    expect(second.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(second.calls).toEqual([]);
    const third = await deploy({ Db: structuredClone(second.persisted ?? record) });
    expect(third.thrown).toBeUndefined();
    expect(third.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(third.calls).toEqual([]);
  });

  it('a changed public value plans the key', async () => {
    const record = await created();
    LIVE.pub = 'pub-v2';
    LIVE.pubVersion = 2;
    const moved = await deploy({ Db: structuredClone(record) });
    expect(moved.thrown).toBeUndefined();
    expect(paths(moved)).toEqual(['Description']);
    expect(moved.calls).toEqual(['update:Db']);
    const settled = await deploy({ Db: structuredClone(moved.persisted!) });
    expect(settled.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(settled.calls).toEqual([]);
  });
});
