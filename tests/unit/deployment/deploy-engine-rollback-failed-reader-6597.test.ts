/**
 * go-to-k/cdkd#6597, through the real `DeployEngine`: when the FAILED update
 * is a reader of a secret whose completed update the rollback reverts by
 * regenerating its value (`GenerateSecretString` changed), the rollback
 * reverts the reader AFTER the secret, at the secret's new value, as
 * CloudFormation restores a reader after the secret it reads. It used to
 * revert the reader first, at the version its record pinned, and leave it a
 * password the secret no longer held.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const log = vi.hoisted(() => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): unknown => fns,
  };
  return fns;
});
vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => log }));
const secret = vi.hoisted(() => ({
  value: '',
  version: '',
  history: {} as Record<string, string>,
}));
const answer = vi.hoisted(() => async (command?: unknown): Promise<unknown> => {
  const input = (command as { input?: { SecretId?: string; VersionId?: string } } | undefined)
    ?.input;
  if (input?.VersionId !== undefined) {
    const value = secret.history[input.VersionId];
    if (value === undefined) {
      throw Object.assign(new Error('no such version'), { name: 'ResourceNotFoundException' });
    }
    return { SecretString: value, VersionId: input.VersionId };
  }
  return { SecretString: secret.value, VersionId: secret.version };
});
vi.mock('../../../src/utils/aws-clients.js', () => {
  const clients = (region: string): Record<string, unknown> => ({
    sts: { send: async () => ({ Account: '123456789012' }) },
    secretsManager: {
      send: (command: unknown) => answer(command),
      config: { region: () => Promise.resolve(region) },
    },
    credentialConfig: {},
    config: { region: () => Promise.resolve(region) },
    withRegion: (target: string) => clients(target),
  });
  return { getAwsClients: () => clients('us-east-1') };
});
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    send(command: unknown): Promise<unknown> {
      return answer(command);
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { markNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate, UpdateContext } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const SECRET = 'AWS::SecretsManager::Secret';
const FN = 'AWS::Lambda::Function';
const ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hunt-sec-AbCdEf';
const REF = `{{resolve:secretsmanager:${ARN}:SecretString:password::}}`;
const PRE = 'a1b2c3d4-0000-1111-2222-000000000001';
const FWD = 'a1b2c3d4-0000-1111-2222-000000000002';
const RB = 'a1b2c3d4-0000-1111-2222-000000000003';
const pw = (p: string): string => JSON.stringify({ username: 'u', password: p });
const gen = (length: number): Record<string, unknown> => ({
  SecretStringTemplate: '{"username":"u"}',
  GenerateStringKey: 'password',
  PasswordLength: length,
});

interface Call {
  logicalId: string;
  props: Record<string, unknown>;
}

async function deploy(
  secretLength: number,
  withCreatedSg = false
): Promise<{ calls: Call[]; thrown: unknown }> {
  const calls: Call[] = [];
  let fnCalls = 0;
  const provider = {
    create: vi.fn(async (logicalId: string) => {
      calls.push({ logicalId: `create ${logicalId}`, props: {} });
      return { physicalId: 'sg-0123456789abcdef0', attributes: {} };
    }),
    update: vi.fn(
      async (
        logicalId: string,
        pid: string,
        _type: string,
        props: Record<string, unknown>,
        _prev: Record<string, unknown>,
        context?: UpdateContext
      ) => {
        calls.push({ logicalId, props });
        if (logicalId === 'Sec') {
          // Every write of a changed GenerateSecretString makes a new value.
          const next = Object.keys(secret.history).length === 1 ? FWD : RB;
          secret.history[next] = pw(next === FWD ? 'forward-pw' : 'rollback-pw');
          secret.value = secret.history[next]!;
          secret.version = next;
        } else if (fnCalls++ === 0) {
          // The deploy's update: accepted far enough to mark, then refused.
          context?.markUnsettled?.('Environment');
          throw markNonRetryable(new Error('ValidationException: MemorySize'));
        }
        return { physicalId: pid, attributes: {} };
      }
    ),
    delete: vi.fn(),
    getAttribute: vi.fn(),
  };
  const fnRecord = (plain: string): Record<string, unknown> => ({
    Environment: { Variables: { PW: REF, PLAIN: plain } },
  });
  const state: StackState = {
    version: 15,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      Sec: {
        physicalId: ARN,
        resourceType: SECRET,
        properties: { Name: 'hunt-sec', GenerateSecretString: gen(20) },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      } as ResourceState,
      Fn: {
        physicalId: 'fn',
        resourceType: FN,
        properties: fnRecord('one'),
        attributes: {},
        dependencies: ['Sec'],
        provisionedBy: 'sdk',
        referenceProvenance: { [REF]: { region: 'us-east-1', versions: [PRE] } },
      } as ResourceState,
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const template = {
    Resources: {
      Sec: {
        Type: SECRET,
        Properties: { Name: 'hunt-sec', GenerateSecretString: gen(secretLength) },
      },
      Fn: {
        Type: FN,
        Properties: withCreatedSg
          ? { ...fnRecord('two'), VpcConfig: { SecurityGroupIds: [{ Ref: 'Sg' }] } }
          : fnRecord('two'),
        DependsOn: withCreatedSg ? ['Sec', 'Sg'] : ['Sec'],
      },
      ...(withCreatedSg && {
        Sg: { Type: 'AWS::EC2::SecurityGroup', Properties: { GroupDescription: 'd' } },
      }),
    },
  } as unknown as CloudFormationTemplate;
  const engine = new DeployEngine(
    {
      getState: vi.fn(async () => ({ state, etag: 'e0' })),
      saveState: vi.fn(async () => 'etag'),
      getStateIfExists: vi.fn(async () => ({ state, etag: 'e0' })),
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
      getExecutionLevels: vi
        .fn()
        .mockReturnValue(withCreatedSg ? [['Sec', 'Sg'], ['Fn']] : [['Sec'], ['Fn']]),
      getDirectDependencies: vi.fn((_g: unknown, id: string) =>
        id === 'Fn' ? (withCreatedSg ? ['Sec', 'Sg'] : ['Sec']) : []
      ),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      dryRun: false,
      forceStatefulRecreation: true,
      unsettledRevertWait: { timeoutMs: 2_000, pollMs: 5 },
    },
    'us-east-1'
  );
  let thrown: unknown;
  await engine.deploy('s', template).catch((e: unknown) => {
    thrown = e;
  });
  return { calls, thrown };
}

const fnPw = (call: Call | undefined): unknown =>
  (call?.props['Environment'] as { Variables: { PW: unknown } } | undefined)?.Variables.PW;

beforeEach(() => {
  secret.history = { [PRE]: pw('pre-deploy-pw') };
  secret.value = pw('pre-deploy-pw');
  secret.version = PRE;
  log.warn.mockClear();
});

describe('a failed reader of a regenerated secret (#6597)', () => {
  it('reverts the failed reader after the secret, at its regenerated value', async () => {
    const run = await deploy(24);
    expect(run.thrown).toBeDefined();
    // Deploy: Sec, Fn (fails). Rollback: Sec, then Fn.
    expect(run.calls.map((c) => c.logicalId)).toEqual(['Sec', 'Fn', 'Sec', 'Fn']);
    expect(secret.version).toBe(RB);
    expect(fnPw(run.calls[3])).toBe('rollback-pw');
  });

  it('keeps a failed reader whose attempt uses a resource this deploy created before the replay', async () => {
    const run = await deploy(24, true);
    expect(run.thrown).toBeDefined();
    const updates = run.calls.map((c) => c.logicalId).filter((id) => !id.startsWith('create '));
    // Deploy: Sec, Fn (fails). Rollback: Fn first (the replay deletes Sg), then Sec.
    expect(updates).toEqual(['Sec', 'Fn', 'Fn', 'Sec']);
  });

  it('keeps the old order and the pin when the secret revert does not regenerate', async () => {
    // GenerateSecretString unchanged: the deploy does not touch the secret.
    const run = await deploy(20);
    expect(run.thrown).toBeDefined();
    expect(run.calls.map((c) => c.logicalId)).toEqual(['Fn', 'Fn']);
    expect(fnPw(run.calls[1])).toBe('pre-deploy-pw');
  });
});
