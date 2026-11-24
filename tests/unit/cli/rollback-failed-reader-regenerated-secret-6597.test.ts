/**
 * go-to-k/cdkd#6597: `cdkd rollback --revert-failed` reverts a failed UPDATE
 * that reads a secret AFTER the segment's completed revert of that secret
 * regenerates it, at the secret's new value — not first, at the version its
 * record pinned. Driven through the real command and executor.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import { readAtKeyRegion } from '../_state-read-double.js';

const logger = vi.hoisted(() => {
  const l: Record<string, unknown> = {};
  Object.assign(l, {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  });
  return l;
});
vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => logger }));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const provider = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
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
    withRegion: (target: string) => clients(target),
    destroy: vi.fn(),
  });
  return {
    AwsClients: vi.fn(() => clients('us-east-1')),
    setAwsClients: vi.fn(),
    runWithStackAwsClients: (_c: unknown, fn: () => unknown) => fn(),
    getAwsClients: vi.fn(() => clients('us-east-1')),
  };
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
vi.mock('../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../../src/provisioning/resource-name.js', () => ({
  withNameGeneration: (_binding: unknown, fn: () => unknown) => fn(),
  isNameGeneration: (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
  stackInstanceNameSuffix: () => '000000000000',
  withStackScope: (_name: string, fn: () => unknown) => fn(),
  withSkipPrefix: (_skip: boolean, fn: () => unknown) => fn(),
  getCurrentSkipPrefix: () => true,
  explicitNamePropertyFor: () => undefined,
}));

const setupMock = vi.fn();
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';

const REGION = 'us-east-1';
const STACK = 'S';
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
const rec = (
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) => ({
  physicalId,
  resourceType,
  properties,
  attributes: {},
  dependencies: [] as string[],
  provisionedBy: 'sdk' as const,
  ...extra,
});
const fnProps = (plain: string): Record<string, unknown> => ({
  Environment: { Variables: { PW: REF, PLAIN: plain } },
});
const fnRecord = rec('fn', FN, fnProps('one'), {
  dependencies: ['Sec'],
  referenceProvenance: { [REF]: { region: REGION, versions: [PRE] } },
});

let calls: string[];
let sent: Record<string, Record<string, unknown>>;

function install(extraFailed: Record<string, unknown> = {}): void {
  const record: StackState = {
    version: 15,
    stackName: STACK,
    region: REGION,
    resources: {
      Sec: rec(ARN, SECRET, { Name: 'hunt-sec', GenerateSecretString: gen(24) }),
      // A failed update keeps the pre-deploy record.
      Fn: structuredClone(fnRecord),
    },
    outputs: {},
    lastModified: 1,
  } as unknown as StackState;
  const backend = {
    getRegistryMarker: vi.fn().mockResolvedValue(null),
    claimRegistryMarker: vi.fn().mockResolvedValue('claimed'),
    lockUnderPrefix: vi.fn().mockResolvedValue(false),
    listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
    recordUnderPrefix: vi.fn().mockResolvedValue('absent'),
    listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue(readAtKeyRegion(record, REGION)),
    loadRollbackJournal: vi.fn().mockResolvedValue({
      journalVersion: 1,
      stackName: STACK,
      region: REGION,
      segments: [
        {
          operations: [
            {
              logicalId: 'Sec',
              changeType: 'UPDATE',
              resourceType: SECRET,
              provisionedBy: 'sdk',
              physicalId: ARN,
              previousState: rec(ARN, SECRET, { Name: 'hunt-sec', GenerateSecretString: gen(20) }),
              properties: { Name: 'hunt-sec', GenerateSecretString: gen(24) },
              oldResourceRetained: false,
            },
          ],
          failedOperations: [
            {
              logicalId: 'Fn',
              changeType: 'UPDATE',
              resourceType: FN,
              provisionedBy: 'sdk',
              physicalId: 'fn',
              previousState: structuredClone(fnRecord),
              attemptedProperties: { ...fnProps('two'), MemorySize: 20000 },
              ...extraFailed,
            },
          ],
        },
      ],
    }),
    saveState: vi.fn(async () => 'etag-2'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
  };
  setupMock.mockResolvedValue({
    stateBackend: { ...backend, prefix: 'cdkd' },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

describe('cdkd rollback --revert-failed: a failed reader of a regenerated secret (#6597)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    sent = {};
    secret.history = { [PRE]: pw('pre-deploy-pw'), [FWD]: pw('forward-pw') };
    secret.value = pw('forward-pw');
    secret.version = FWD;
    provider.update.mockImplementation(
      async (logicalId: string, physicalId: string, _t: string, props: Record<string, unknown>) => {
        calls.push(`update ${logicalId}`);
        sent[logicalId] = props;
        if (logicalId === 'Sec') {
          secret.history[RB] = pw('rollback-pw');
          secret.value = pw('rollback-pw');
          secret.version = RB;
        }
        return { physicalId, wasReplaced: false, attributes: {} };
      }
    );
  });

  it('reverts the secret first, then the failed reader at the regenerated value', async () => {
    install();
    await rollbackCommand(STACK, {
      yes: true,
      stateBucket: 'b',
      region: REGION,
      revertFailed: true,
    } as unknown as Parameters<typeof rollbackCommand>[1]);
    expect(calls).toEqual(['update Sec', 'update Fn']);
    const env = sent['Fn']?.['Environment'] as { Variables: { PW: unknown } } | undefined;
    expect(env?.Variables.PW).toBe('rollback-pw');
  });

  it('keeps a delete-first failed reader in its place (#4690 journal entry)', async () => {
    install({ oldDeletedBeforeCreate: true });
    await rollbackCommand(STACK, {
      yes: true,
      stateBucket: 'b',
      region: REGION,
      revertFailed: true,
    } as unknown as Parameters<typeof rollbackCommand>[1]);
    // Not deferred: whatever the first pass does with it happens before the secret.
    expect(calls.indexOf('update Sec')).toBe(calls.length - 1);
  });
});
