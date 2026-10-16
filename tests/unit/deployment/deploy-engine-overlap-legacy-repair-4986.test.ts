/**
 * Issue [#4986](https://github.com/go-to-k/cdkd/issues/4986), the MIGRATION
 * half, through the real `DeployEngine` / `DiffCalculator` / resolver: a record
 * a pre-fix cdkd wrote holds an overlapping leaf in its leftmost-first spelling
 * (`{{resolve:A}}` + the rest of B's plaintext). With the template unchanged
 * nothing may be sent (a create-only property would be REPLACED); the record
 * takes today's `***`. A real edit, or a record not equal to the old spelling,
 * still sends.
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
      send: vi.fn().mockResolvedValue({ SecretString: JSON.stringify({ a: 'us-east-1pw12', b: 'pw12-str4ddle-4973' }) }),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
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
      return { SecretString: JSON.stringify({ a: 'us-east-1pw12', b: 'pw12-str4ddle-4973' }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { StackState } from '../../../src/types/state.js';

const A_REF = '{{resolve:secretsmanager:ovl:SecretString:a::}}';
const B_REF = '{{resolve:secretsmanager:ovl:SecretString:b::}}';
// What the pre-fix leftmost-first walk persisted for `us-east-1pw12-str4ddle-4973`.
const LEGACY_VALUE = `${A_REF}-str4ddle-4973`;

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

describe('a record a pre-#4986 cdkd wrote with an overlapping leaf', () => {
  const record = (value: string): StackState['resources'] =>
    ({
      Param: {
        physicalId: 'ovl-param',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: 'ovl-param', Type: 'String', Value: value, Description: A_REF },
        attributes: { Value: value },
        observedProperties: { Value: value, Description: A_REF },
        dependencies: [],
      },
    }) as StackState['resources'];
  const template = (value: unknown): Record<string, unknown> => ({
    Param: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: 'ovl-param', Type: 'String', Value: value, Description: A_REF },
    },
  });

  it('an unchanged template: nothing is sent, and the record takes the mask everywhere', async () => {
    const run = await deploy(record(LEGACY_VALUE), template(`us-east-1${B_REF}`), [['Param']]);
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(run.persisted?.properties['Value']).toBe('***');
    expect(run.persisted?.properties['Description']).toBe(A_REF);
    expect(run.persisted?.attributes?.['Value']).toBe('***');
    expect(run.persisted?.observedProperties?.['Value']).toBe('***');
    expect(JSON.stringify(run.persisted)).not.toContain('str4ddle');
  });

  it('a real template edit is still sent', async () => {
    const run = await deploy(record(LEGACY_VALUE), template(`us-east-2${B_REF}`), [['Param']]);
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Param']);
  });

  it('a record that is NOT the old spelling of today\'s value is still sent', async () => {
    const run = await deploy(record(`${A_REF}-str4ddle-0000`), template(`us-east-1${B_REF}`), [
      ['Param'],
    ]);
    expect(run.thrown).toBeUndefined();
    expect(run.calls).toEqual(['update:Param']);
  });
});
