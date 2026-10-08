/**
 * go-to-k/cdkd#4703: `cdkd rollback --remove-protection` hands the flag to the
 * nested-stack context its segment replay runs under, which is where a nested
 * child's revert (`revertNestedChildFromJournal`) reads it. Only when passed.
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
const provider = vi.hoisted(() => ({ delete: vi.fn() }));
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
// A pass-through spy on the scope the segment replay runs under.
const nestedCtxs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../../src/provisioning/nested-stack-context.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/nested-stack-context.js')>();
  return {
    ...actual,
    withNestedStackContext: (ctx: Record<string, unknown>, fn: () => unknown) => {
      nestedCtxs.push(ctx);
      return actual.withNestedStackContext(ctx as never, fn);
    },
  };
});

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';

const REGION = 'us-east-1';

function install(): void {
  const state = {
    version: 8,
    stackName: 'S',
    region: REGION,
    resources: {
      P: {
        physicalId: 'p-1',
        resourceType: 'AWS::SSM::Parameter',
        properties: {},
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    },
    outputs: {},
    lastModified: 1,
  };
  setupMock.mockResolvedValue({
    stateBackend: {
      listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: REGION }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn(async (name: string) =>
        name === 'S' ? { state: structuredClone(state), etag: 'e0' } : null
      ),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: REGION,
        segments: [
          {
            runId: 'r',
            timestamp: 1,
            reason: 'no-rollback-failure',
            initialDeploy: false,
            operations: [
              {
                logicalId: 'P',
                changeType: 'CREATE',
                resourceType: 'AWS::SSM::Parameter',
                physicalId: 'p-1',
                provisionedBy: 'sdk',
                properties: {},
              },
            ],
          },
        ],
      }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      getLockInfo: vi.fn().mockResolvedValue(null),
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

const BASE = { statePrefix: 'cdkd', verbose: false, force: true };

describe('cdkd rollback threads --remove-protection into nested reverts (go-to-k/cdkd#4703)', () => {
  beforeEach(() => {
    nestedCtxs.length = 0;
    provider.delete.mockReset().mockResolvedValue(undefined);
    install();
  });

  it('sets destroyOptions.removeProtection on the segment scope with the flag', async () => {
    await rollbackCommand('S', { ...BASE, removeProtection: true });
    expect(nestedCtxs).toHaveLength(1);
    expect(nestedCtxs[0]!['destroyOptions']).toEqual({
      statePrefix: 'cdkd',
      removeProtection: true,
    });
  });

  it.each([
    ['absent', {}],
    ['false', { removeProtection: false }],
  ])('leaves it off when the flag is %s', async (_l, flag) => {
    await rollbackCommand('S', { ...BASE, ...flag });
    expect(nestedCtxs).toHaveLength(1);
    expect(nestedCtxs[0]!['destroyOptions']).not.toHaveProperty('removeProtection');
  });
});
