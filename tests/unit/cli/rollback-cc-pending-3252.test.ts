/**
 * `cdkd rollback` settles a journaled abandoned Cloud Control CREATE under its
 * lock before it reads the journal (go-to-k/cdkd#3252).
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

const reader = vi.hoisted(() => ({
  resumeAbandonedRequest: vi.fn(),
  buildResumeCommand: vi.fn(async () => 'aws cloudcontrol get-resource-request-status'),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: { delete: vi.fn() } }),
    getCloudControlProvider: () => reader,
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_c: unknown, fn: () => unknown) => fn(),
  getAwsClients: vi.fn(() => ({})),
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

const pendingJournal = () => ({
  journalVersion: 1,
  stackName: STACK,
  region: REGION,
  segments: [
    {
      timestamp: 1,
      reason: 'auto-rollback-clean',
      initialDeploy: false,
      operations: [],
      failedOperations: [
        {
          logicalId: 'Group',
          changeType: 'CREATE',
          resourceType: 'AWS::Logs::LogGroup',
          provisionedBy: 'cc-api',
          pendingCloudControlRequest: { requestToken: 'tok', abandonedAt: 1 },
        },
      ],
    },
  ],
});

function install(order: string[]) {
  const stateBackend = {
    listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
    getRegistryMarker: vi.fn().mockResolvedValue(null),
    claimRegistryMarker: vi.fn().mockResolvedValue('claimed'),
    listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: REGION }]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue({ state: { resources: {}, outputs: {} }, etag: 'e' }),
    loadRollbackJournal: vi.fn(async () => {
      order.push('load');
      return pendingJournal();
    }),
    rewriteRollbackJournalFailedOperations: vi.fn(async (..._args: unknown[]) => {
      order.push('rewrite');
      return 1;
    }),
    purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
    rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
    warmConnections: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue('etag-1'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
  };
  setupMock.mockResolvedValue({
    stateBackend,
    lockManager: {
      acquireLockWithRetry: vi.fn(async () => {
        order.push('lock');
      }),
      releaseLock: vi.fn(async () => {
        order.push('release');
      }),
    },
    awsClients: {},
    region: REGION,
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
  return stateBackend;
}

const opts = { statePrefix: 'cdkd', verbose: false, force: true };

describe('rollbackCommand: a journaled abandoned Cloud Control CREATE (#3252)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses while the request is still unknown, under its lock, and releases it', async () => {
    const order: string[] = [];
    const backend = install(order);
    reader.resumeAbandonedRequest.mockResolvedValue({
      status: 'unresolved',
      error: new Error('IN_PROGRESS'),
    });
    await expect(rollbackCommand(STACK, { ...opts })).rejects.toThrow(/cdkd rollback of .* refused/);
    expect(reader.resumeAbandonedRequest).toHaveBeenCalledWith('tok', 'Group', 'AWS::Logs::LogGroup');
    expect(order[0]).toBe('lock');
    expect(order.at(-1)).toBe('release');
    expect(backend.deleteRollbackJournal).not.toHaveBeenCalled();
  });

  it('settles a create that made its resource before the journal is read for the plan', async () => {
    const order: string[] = [];
    reader.resumeAbandonedRequest.mockResolvedValue({ status: 'succeeded', identifier: 'g' });
    const backend = install(order);
    order.length = 0;
    await rollbackCommand(STACK, { ...opts }).catch(() => undefined);
    // The command's own read is the peek; it re-reads only after the rewrite.
    expect(order.slice(0, 4)).toEqual(['lock', 'load', 'rewrite', 'load']);
    // What the rewrite does to the op: the proven-orphan shape.
    const rewrite = backend.rewriteRollbackJournalFailedOperations.mock.calls[0]![2] as unknown as (
      op: unknown
    ) => unknown;
    expect(rewrite(pendingJournal().segments[0]!.failedOperations[0])).toMatchObject({
      physicalId: 'g',
      physicalIdRecoveredFromError: true,
      provisionedBy: 'cc-api',
    });
  });
});
