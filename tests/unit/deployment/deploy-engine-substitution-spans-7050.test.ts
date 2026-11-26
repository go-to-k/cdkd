/**
 * go-to-k/cdkd#7050 through the real DeployEngine, DiffCalculator and
 * resolver: each shape the parent review probed. Deployed, deployed again
 * unchanged (the plan must show NO_CHANGE: a masked leaf never reads as a
 * change), then deployed with another property changed in place (it must be
 * updated in place, never refused as a stateful replacement). Every saved
 * state is scanned whole for any secret's plaintext outside a reference.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

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
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    secretsManager: {
      send: vi.fn().mockResolvedValue({ SecretString: JSON.stringify({ username: 'pg', other: 'x9', long: 'postgres' }), VersionId: 'a1b2c3d4-0000-4000-8000-000000000002' }),
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
      return { SecretString: JSON.stringify({ username: 'pg', other: 'x9', long: 'postgres' }), VersionId: 'a1b2c3d4-0000-4000-8000-000000000002' };
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
import type { ResourceChange, StackState } from '../../../src/types/state.js';

const USERNAME = '{{resolve:secretsmanager:db-secret:SecretString:username::}}';

interface Run {
  calls: string[];
  persisted: StackState['resources'][string] | undefined;
  thrown: unknown;
  diff: Map<string, ResourceChange> | undefined;
}

class CapturingDiffCalculator extends DiffCalculator {
  last: Map<string, ResourceChange> | undefined;
  override async calculateDiff(
    ...args: Parameters<DiffCalculator['calculateDiff']>
  ): ReturnType<DiffCalculator['calculateDiff']> {
    // A copy of what the PLAN saw: provisioning later edits the rows in place.
    const result = await super.calculateDiff(...args);
    this.last = new Map([...result].map(([id, c]) => [id, structuredClone(c)]));
    return result;
  }
}

async function deploy(
  resources: StackState['resources'],
  templateResources: Record<string, unknown>
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
      return { physicalId: 'new', attributes: {} };
    }),
    update: vi.fn(async (id: string) => {
      calls.push('update:' + id);
      return { physicalId: resources[id]!.physicalId, attributes: {} };
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
  await engine.deploy('s', { Parameters: { Suffix: { Type: 'String', Default: SUFFIX.v } }, Resources: templateResources } as never).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object)
    );
  return { calls, persisted: saved[saved.length - 1]?.resources['Db'], thrown, diff: diffCalculator.last };
}

const OTHER = '{{resolve:secretsmanager:db-secret:SecretString:other::}}';
const LONG = '{{resolve:secretsmanager:db-secret:SecretString:long::}}';
const SUFFIX = { v: 'x9' };
const tpl = (dbName: unknown, backup: number): Record<string, unknown> => ({
  Db: {
    Type: 'AWS::RDS::DBInstance',
    Properties: {
      Engine: 'mysql',
      MasterUsername: USERNAME,
      MasterUserPassword: OTHER,
      DBName: dbName,
      BackupRetentionPeriod: backup,
    },
  },
});
const show = (label: string, r: Run): void => {
  const c = r.diff?.get('Db');
  // eslint-disable-next-line no-console
  console.log(
    `PROBE ${label}: persisted DBName=${JSON.stringify(r.persisted?.properties['DBName'])} calls=${JSON.stringify(r.calls)} thrown=${r.thrown === undefined ? 'none' : String((r.thrown as Error).message).slice(0, 300)} changeType=${c?.changeType} rows=${JSON.stringify((c?.propertyChanges ?? []).map((p) => [p.path, p.requiresReplacement, p.oldValue, p.newValue]))}`
  );
};

const SECRETS = ['pg', 'x9', 'postgres'];
function exposes(state: unknown): string | undefined {
  const text = JSON.stringify(state).split(/\{\{resolve:[^}]+\}\}/).join('\u0000');
  return SECRETS.find((secret) => text.includes(secret));
}

describe('a secret beside a value-bearing part never leaks or reads as a change (#7050)', () => {
  for (const [label, suffix, dbName] of [
    ['own text equal (Suffix pg)', 'pg', { 'Fn::Join': ['_', [USERNAME, { Ref: 'Suffix' }]] }],
    ['another secret equal (Suffix x9)', 'x9', { 'Fn::Join': ['_', [USERNAME, { Ref: 'Suffix' }]] }],
    ['another secret inside (Suffix ax9b)', 'ax9b', { 'Fn::Join': ['_', [USERNAME, { Ref: 'Suffix' }]] }],
    ['own text inside (Suffix apgb)', 'apgb', { 'Fn::Join': ['_', [USERNAME, { Ref: 'Suffix' }]] }],
    ['an Fn::Sub variable map', 'pg', { 'Fn::Sub': ['${U}_${Suffix}', { U: USERNAME }] }],
    ['a 4+ character secret equal (Suffix postgres)', 'postgres', { 'Fn::Join': ['_', [LONG, { Ref: 'Suffix' }]] }],
    ['an Fn::Select-lent reference beside its text', 'pg', { 'Fn::Join': ['', ['tt:', { 'Fn::Select': [0, [USERNAME]] }, { Ref: 'Suffix' }]] }],
    ['an Fn::Select-lent reference alone', 'zz', { 'Fn::Join': ['', ['tt:', { 'Fn::Select': [0, [USERNAME]] }]] }],
  ] as const) {
    it(label, async () => {
      SUFFIX.v = suffix;
      const created = await deploy({}, tpl(dbName, 1));
      expect(created.thrown).toBeUndefined();
      expect(created.persisted).toBeDefined();
      expect(exposes(created.persisted)).toBeUndefined();
      const same = await deploy({ Db: structuredClone(created.persisted!) }, tpl(dbName, 1));
      expect(same.thrown).toBeUndefined();
      expect(same.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
      expect(same.calls).toEqual([]);
      const next = await deploy({ Db: structuredClone(created.persisted!) }, tpl(dbName, 7));
      expect(next.thrown).toBeUndefined();
      expect((next.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toEqual([
        'BackupRetentionPeriod',
      ]);
      expect(next.calls).toEqual(['update:Db']);
      expect(exposes(next.persisted)).toBeUndefined();
    });
  }
});
