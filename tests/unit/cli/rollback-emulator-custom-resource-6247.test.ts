/**
 * go-to-k/cdkd#6247: when a custom resource's handler failed in AWS Emulator's
 * own Lambda runtime (the local runtime is on, but `cdkd rollback` never reads
 * the app), the failed rollback does not advise re-running itself, which
 * fails the same way every time; it names a deploy forward from the app.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
const provider = vi.hoisted(() => ({ delete: vi.fn(), update: vi.fn() }));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
const setupMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cli/commands/state.js')>(
    '../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});
const wiring = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveWorkloadAwsWiring: () => wiring.value,
}));
vi.mock('../../../src/synthesis/synthesized-stacks.js', () => ({
  synthesizedStacks: () => [],
}));

const { rollbackCommand } = await import('../../../src/cli/commands/rollback.js');
const {
  noteCustomResourceFailure,
  resetCustomResourceFailuresForTest,
  setLocalCustomResourceRuntimeEnabled,
} = await import('../../../src/local/custom-resource-runtime-gate.js');

const TYPE = 'Custom::AWS';
const previous = {
  physicalId: 'p',
  resourceType: TYPE,
  properties: { V: '2' },
  attributes: {},
  dependencies: [],
};

function install(): void {
  const backend = {
    listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
    getRegistryMarker: vi.fn().mockResolvedValue(null),
    claimRegistryMarker: vi.fn().mockResolvedValue('claimed'),
    listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue({
      state: {
        version: 8,
        stackName: 'S',
        region: 'us-east-1',
        resources: { PutParam: { ...previous, properties: { V: '3' } } },
        outputs: {},
        lastModified: 1,
      },
      etag: 'e0',
    }),
    loadRollbackJournal: vi.fn().mockResolvedValue({
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [
            {
              logicalId: 'PutParam',
              changeType: 'UPDATE',
              resourceType: TYPE,
              provisionedBy: 'sdk',
              physicalId: 'p',
              attemptedProperties: { V: '3' },
              previousState: previous,
            },
          ],
        },
      ],
    }),
    saveState: vi.fn().mockResolvedValue('etag-1'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
  };
  setupMock.mockResolvedValue({
    stateBackend: backend,
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      getLockInfo: vi.fn().mockResolvedValue(null),
    },
    awsClients: {},
    region: 'us-east-1',
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

async function failedRollback(): Promise<Error | undefined> {
  return rollbackCommand('S', {
    statePrefix: 'cdkd',
    verbose: false,
    force: true,
    revertFailed: true,
  }).then(
    () => undefined,
    (e: unknown) => e as Error
  );
}

beforeEach(() => {
  resetCustomResourceFailuresForTest();
  setLocalCustomResourceRuntimeEnabled(true, 'rollback');
  wiring.value = { mode: 'emulator' };
  setupMock.mockReset();
  // The real provider records the failure in its catch (pinned in
  // custom-resource-failure-without-app-6247.test.ts); this one does the same.
  provider.update.mockReset().mockImplementation(async (logicalId: string) => {
    noteCustomResourceFailure(logicalId);
    throw new Error(`Failed to update custom resource ${logicalId}: Cannot find module 'zlib'`);
  });
});

describe('cdkd rollback after a custom resource failed in the emulator runtime (#6247)', () => {
  it('names a deploy forward, not a re-run', async () => {
    install();
    const err = await failedRollback();
    expect(provider.update).toHaveBeenCalled();
    const message = err!.message;
    expect(message).toContain('Rollback completed with 1 failed operation(s). Journal preserved.');
    expect(message).toContain('Custom resource(s) PutParam failed in AWS Emulator');
    expect(message).toContain('a re-run fails the same way');
    expect(message).not.toContain('re-run the rollback to retry');
    expect(message).not.toContain('Re-run with:');
    expect(message.trimEnd().split('\n').at(-1)).toBe('Deploy forward with: cdkd deploy S');
  });

  it('a failure off the emulator still advises the re-run', async () => {
    wiring.value = undefined;
    install();
    const err = await failedRollback();
    const message = err!.message;
    expect(message).toContain('re-run the rollback to retry');
    expect(message.trimEnd().split('\n').at(-1)).toMatch(/^Re-run with: cdkd rollback S/);
  });
});
