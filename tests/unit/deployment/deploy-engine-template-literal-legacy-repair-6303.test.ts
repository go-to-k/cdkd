/**
 * go-to-k/cdkd#6303, the MIGRATION half, through the real `DeployEngine` /
 * `DiffCalculator` / resolver: a record a pre-fix cdkd wrote holds the
 * template's literal `aurora-postgresql` with the generated username
 * `postgres` rewritten into its expression. With the template unchanged nothing
 * may be sent (`Engine` is create-only: a REPLACEMENT); the record takes the
 * literal. A real edit still sends.
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


const USERNAME = '{{resolve:secretsmanager:db-secret:SecretString:username::}}';
const MANGLED = `aurora-${USERNAME}ql`;

interface Run {
  calls: string[];
  persisted: StackState['resources'][string] | undefined;
  thrown: unknown;
}

async function deploy(
  resources: StackState['resources'],
  templateResources: Record<string, unknown>,
  order: string[][],
  extra: Partial<StackState> = {},
  engineOptions: Record<string, unknown> = {}
): Promise<Run> {
  const state = {
    version: 11,
    stackName: 's',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
    ...extra,
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
  const reader = order[order.length - 1]![0]!;
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
      getExecutionLevels: vi.fn().mockReturnValue(order),
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
    { dryRun: false, ...engineOptions },
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
  return { calls, persisted: saved[saved.length - 1]?.resources[reader], thrown };
}

describe('a record a pre-#6303 cdkd wrote with the username spliced into Engine', () => {
  const record = (engine: string): StackState['resources'] =>
    ({
      Db: {
        physicalId: 'db-cluster',
        resourceType: 'AWS::RDS::DBCluster',
        properties: { Engine: engine, MasterUsername: USERNAME },
        attributes: {},
        observedProperties: { Engine: engine, MasterUsername: USERNAME },
        dependencies: [],
      },
    }) as StackState['resources'];
  const template = (engine: string): Record<string, unknown> => ({
    Db: {
      Type: 'AWS::RDS::DBCluster',
      Properties: { Engine: engine, MasterUsername: USERNAME },
    },
  });

  it("an unchanged template: nothing is sent, and the record takes the literal", async () => {
    const run = await deploy(record(MANGLED), template('aurora-postgresql'), [['Db']]);
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.persisted?.properties['Engine']).toBe('aurora-postgresql');
    expect(run.persisted?.properties['MasterUsername']).toBe(USERNAME);
    expect(run.persisted?.observedProperties?.['Engine']).toBe('aurora-postgresql');
  });

  it('a real template edit is still a create-only change', async () => {
    const run = await deploy(record(MANGLED), template('aurora-mysql'), [['Db']]);
    expect(run.calls).toEqual([]);
    // A stateful replacement the run refuses without its flag: the edit was
    // seen, not skipped as the repaired spelling.
    expect(String((run.thrown as { cause?: unknown } | undefined)?.cause)).toContain(
      'requires replacement (immutable property changed: Engine)'
    );
  });

  it('a fresh deploy persists the literal', async () => {
    const run = await deploy({}, template('aurora-postgresql'), [['Db']]);
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['create:Db']);
    expect(run.persisted?.properties['Engine']).toBe('aurora-postgresql');
    expect(run.persisted?.properties['MasterUsername']).toBe(USERNAME);
  });
});
