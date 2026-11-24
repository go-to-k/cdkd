/**
 * go-to-k/cdkd#6820, through the real `DeployEngine` / `DiffCalculator` /
 * resolver: a Connect user's `Password` is refused on every Cloud Control
 * update, so `CloudControlProvider.update` leaves a reference-only difference
 * out. The engine tells the two cases apart as written: a RE-POINTED reference
 * is refused before any provider call (else the record would name the new
 * secret while AWS keeps the old password), and the same reference over a
 * rotated value updates as before. A changed literal is not refused here.
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
/** The value every reference resolves to; changed to rotate. */
const secret = vi.hoisted(() => ({ password: 'Passw0rdOne' }));
const answer = vi.hoisted(
  () => async (): Promise<unknown> => ({
    SecretString: JSON.stringify({ password: secret.password }),
    VersionId: 'a1b2c3d4-0000-1111-2222-333333333333',
  })
);
vi.mock('../../../src/utils/aws-clients.js', () => {
  const clients = (region: string): Record<string, unknown> => ({
    sts: { send: async () => ({ Account: '123456789012' }) },
    secretsManager: {
      send: () => answer(),
      config: { region: () => Promise.resolve(region) },
    },
    credentialConfig: {},
    withRegion: (target: string) => clients(target),
  });
  return { getAwsClients: () => clients('us-east-1') };
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
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    send(): Promise<unknown> {
      return answer();
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { WRITE_ONLY_KEY_CHANGE_REFUSED } from '../../../src/deployment/deploy-engine/update/finish.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::Connect::User';
const REF_A = '{{resolve:secretsmanager:pw-a:SecretString:password::}}';
const REF_B = '{{resolve:secretsmanager:pw-b:SecretString:password::}}';

beforeEach(() => {
  secret.password = 'Passw0rdOne';
});

async function deploy(recorded: Record<string, unknown>, desired: Record<string, unknown>) {
  const provider = {
    create: vi.fn(),
    update: vi.fn(async (_id: string, pid: string) => ({ physicalId: pid, attributes: {} })),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn(async () => undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const state = {
    version: 12,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      User: {
        physicalId: 'arn:aws:connect:us-east-1:123456789012:instance/i/agent/u',
        resourceType: TYPE,
        provisionedBy: 'cc-api',
        properties: recorded,
        attributes: {},
        dependencies: [],
      } as ResourceState,
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const engine = new DeployEngine(
    {
      getState: vi.fn(async () => ({ state, etag: 'e0' })),
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
      getExecutionLevels: vi.fn().mockReturnValue([['User']]),
      getDirectDependencies: vi.fn(() => []),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'cc-api' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    { dryRun: false },
    'us-east-1'
  );
  const template = {
    Resources: { User: { Type: TYPE, Properties: desired } },
  } as CloudFormationTemplate;
  let thrown: unknown;
  await engine.deploy('s', template).catch((e: unknown) => {
    thrown = e;
  });
  return { thrown, provider, saveState };
}

/** Every error in the cause chain, so a wrapped refusal is still found. */
function refusal(error: unknown): (Error & { code?: string }) | undefined {
  let node: unknown = error;
  for (let i = 0; i < 10 && node instanceof Error; i++) {
    if ((node as { code?: string }).code === WRITE_ONLY_KEY_CHANGE_REFUSED) {
      return node as Error & { code?: string };
    }
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

const base = { Username: 'u', IdentityInfo: { FirstName: 'Alpha' } };

describe('DeployEngine - a Connect user Password (go-to-k/cdkd#6820)', () => {
  it('refuses a re-pointed secret reference before any provider call, naming the key and the remedy', async () => {
    const { thrown, provider, saveState } = await deploy(
      { ...base, Password: REF_A },
      { ...base, Password: REF_B }
    );
    const error = refusal(thrown);
    expect(error).toBeDefined();
    expect(isMarkedNonRetryable(error!)).toBe(true);
    expect(isRefusedBeforeApplying(error!, 'User')).toBe(true);
    expect(error!.message).toContain(
      'User (AWS::Connect::User): Password cannot be changed after creation, and its secret reference changed (or was added or removed)'
    );
    expect(error!.message).toContain('replace the resource under a new logical id');
    expect(error!.message).not.toContain(secret.password);
    expect(provider.update).not.toHaveBeenCalled();
    // State still records A: no save carries the new reference.
    expect(JSON.stringify(saveState.mock.calls)).not.toContain('pw-b');
  });

  it('refuses a reference replaced by a literal, and a re-pointed reference built by Fn::Join', async () => {
    const toLiteral = await deploy({ ...base, Password: REF_A }, { ...base, Password: 'Literal1x' });
    expect(refusal(toLiteral.thrown)).toBeDefined();
    expect(toLiteral.provider.update).not.toHaveBeenCalled();

    const joined = {
      'Fn::Join': ['', ['{{resolve:secretsmanager:', 'pw-b', ':SecretString:password::}}']],
    };
    const viaJoin = await deploy({ ...base, Password: REF_A }, { ...base, Password: joined });
    expect(refusal(viaJoin.thrown)).toBeDefined();
    expect(viaJoin.provider.update).not.toHaveBeenCalled();
  });

  it('updates when the same reference reads a rotated value beside another change', async () => {
    secret.password = 'Rotat3dPassw0rd';
    const { thrown, provider } = await deploy(
      { ...base, Password: REF_A },
      { ...base, Password: REF_A, IdentityInfo: { FirstName: 'Beta' } }
    );
    expect(refusal(thrown)).toBeUndefined();
    expect(provider.update).toHaveBeenCalledTimes(1);
  });

  it('does not refuse a changed literal Password (the provider sends it; AWS refuses it visibly)', async () => {
    const { thrown, provider } = await deploy(
      { ...base, Password: 'Passw0rdOld' },
      { ...base, Password: 'Passw0rdNew' }
    );
    expect(refusal(thrown)).toBeUndefined();
    expect(provider.update).toHaveBeenCalledTimes(1);
  });
});
