/**
 * go-to-k/cdkd#7037 through the real `DeployEngine` / `DiffCalculator` /
 * resolver: an `AWS::RDS::DBInstance` with `Engine: postgres` and a generated
 * secret whose `username` is `postgres`. A pre-fix cdkd persisted the literal
 * as the username's reference, and the next deploy that changed anything else
 * refused a stateful replacement over an `Engine` nobody edited.
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
      send: vi.fn().mockResolvedValue({ SecretString: JSON.stringify({ username: 'postgres' }) }),
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
      return { SecretString: JSON.stringify({ username: 'postgres' }) };
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
import type { StackState } from '../../../src/types/state.js';
import { replacesOnlyOnLegacyReferenceSpelling } from '../../../src/deployment/deploy-engine/deploy-flow/plan-checks.js';

const USERNAME = '{{resolve:secretsmanager:db-secret:SecretString:username::}}';

interface Run {
  calls: string[];
  persisted: StackState['resources'][string] | undefined;
  thrown: unknown;
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
    new DiffCalculator(),
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
  await engine.deploy('s', { Resources: templateResources } as never).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object)
    );
  return { calls, persisted: saved[saved.length - 1]?.resources['Db'], thrown };
}

const template = (engine: string, backup: number): Record<string, unknown> => ({
  Db: {
    Type: 'AWS::RDS::DBInstance',
    Properties: { Engine: engine, MasterUsername: USERNAME, BackupRetentionPeriod: backup },
  },
});

describe('Engine: postgres beside the generated username postgres (#7037)', () => {
  it('a fresh deploy persists the literal, and the username as its reference', async () => {
    const run = await deploy({}, template('postgres', 1));
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['create:Db']);
    expect(run.persisted?.properties['Engine']).toBe('postgres');
    expect(run.persisted?.properties['MasterUsername']).toBe(USERNAME);
    expect(JSON.stringify(run.persisted)).not.toContain('"MasterUsername":"postgres"');
  });

  it('a record holding the literal: an in-place change elsewhere is an in-place update', async () => {
    const created = await deploy({}, template('postgres', 1));
    const next = await deploy({ Db: created.persisted! }, template('postgres', 7));
    expect(next.thrown).toBeUndefined();
    expect(next.calls).toEqual(['update:Db']);
    expect(next.persisted?.properties['Engine']).toBe('postgres');
  });
});

describe('a record a pre-#7037 cdkd wrote, holding the username reference at Engine', () => {
  const legacy = (): StackState['resources'] =>
    ({
      Db: {
        physicalId: 'db-instance',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { Engine: USERNAME, MasterUsername: USERNAME, BackupRetentionPeriod: 1 },
        attributes: {},
        observedProperties: { Engine: USERNAME, MasterUsername: USERNAME },
        dependencies: [],
      },
    }) as StackState['resources'];

  it('an unchanged template: nothing is sent, and the record takes the literal', async () => {
    const run = await deploy(legacy(), template('postgres', 1));
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.persisted?.properties['Engine']).toBe('postgres');
    expect(run.persisted?.properties['MasterUsername']).toBe(USERNAME);
    expect(run.persisted?.observedProperties?.['Engine']).toBe('postgres');
  });

  it('another property changed: updated in place, not refused as a replacement', async () => {
    const run = await deploy(legacy(), template('postgres', 7));
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Db']);
    expect(run.persisted?.properties['Engine']).toBe('postgres');
    expect(run.persisted?.properties['BackupRetentionPeriod']).toBe(7);
  });

  it('a key whose legacy leaf is repaired but whose other leaf moved keeps its replacement', async () => {
    // `DBName` is create-only: the repaired `A` alone would drop the row, the
    // edited `B` must keep it (and the stateful refusal with it).
    const record = legacy();
    record['Db']!.properties['DBName'] = { A: USERNAME, B: 1 };
    const t = template('postgres', 1);
    (t['Db'] as { Properties: Record<string, unknown> }).Properties['DBName'] = {
      A: 'postgres',
      B: 2,
    };
    const run = await deploy(record, t);
    expect(run.calls).toEqual([]);
    expect(String((run.thrown as { cause?: unknown } | undefined)?.cause)).toContain(
      'requires replacement (immutable property changed: DBName)'
    );
  });

  it('a real Engine edit is still a stateful replacement the run refuses', async () => {
    const run = await deploy(legacy(), template('mysql', 7));
    expect(run.calls).toEqual([]);
    expect(String((run.thrown as { cause?: unknown } | undefined)?.cause)).toContain(
      'requires replacement (immutable property changed: Engine)'
    );
  });
});

describe('the plan-time hint for a legacy spelling (#7037)', () => {
  const row = (oldValue: unknown, newValue: unknown) => ({
    logicalId: 'Db',
    changeType: 'UPDATE' as const,
    resourceType: 'AWS::RDS::DBInstance',
    propertyChanges: [{ path: 'Engine', oldValue, newValue, requiresReplacement: true }],
  });

  it('names a stored whole token read against a plain template string', () => {
    expect(replacesOnlyOnLegacyReferenceSpelling(row(USERNAME, 'postgres'))).toBe(true);
  });

  it('stays quiet for an ordinary edit, a reference on both sides, or no replacement', () => {
    expect(replacesOnlyOnLegacyReferenceSpelling(row('postgres', 'mysql'))).toBe(false);
    expect(replacesOnlyOnLegacyReferenceSpelling(row(USERNAME, USERNAME.replace('db', 'x')))).toBe(false);
    expect(
      replacesOnlyOnLegacyReferenceSpelling({
        ...row(USERNAME, 'postgres'),
        propertyChanges: [{ path: 'Engine', oldValue: USERNAME, newValue: 'postgres', requiresReplacement: false }],
      })
    ).toBe(false);
    expect(replacesOnlyOnLegacyReferenceSpelling(undefined)).toBe(false);
  });
});
