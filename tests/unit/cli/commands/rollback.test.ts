import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn(), child: () => l };
  return { getLogger: () => l };
});

vi.mock('../../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

// A ProviderRegistry stub whose getProviderFor returns a shared spyable
// provider so the replay path (CREATE delete / UPDATE update) can be driven.
const replayProvider = {
  delete: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue({ physicalId: 'p' }),
};
vi.mock('../../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: replayProvider }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../../src/provisioning/nested-stack-context.js', () => ({
  withNestedStackContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

vi.mock('../../../../src/provisioning/resource-name.js', () => ({
  withStackName: (_name: string, fn: () => unknown) => fn(),
}));

vi.mock('../../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));

const setupMock = vi.fn();
vi.mock('../../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/cli/commands/state.js')>(
    '../../../../src/cli/commands/state.js'
  );
  return {
    ...actual,
    setupStateBackend: (...args: unknown[]) => setupMock(...args),
  };
});

import { rollbackCommand } from '../../../../src/cli/commands/rollback.js';
import { PartialFailureError } from '../../../../src/utils/error-handler.js';

interface FakeBackend {
  listStacks: ReturnType<typeof vi.fn>;
  listRawKeys: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  loadRollbackJournal: ReturnType<typeof vi.fn>;
  saveState: ReturnType<typeof vi.fn>;
  popRollbackJournalSegment: ReturnType<typeof vi.fn>;
  setRollbackJournalFailedOperations: ReturnType<typeof vi.fn>;
  deleteState: ReturnType<typeof vi.fn>;
  deleteRollbackJournal: ReturnType<typeof vi.fn>;
  setCustomResourceResponseBucket?: ReturnType<typeof vi.fn>;
}

function installSetup(backend: Partial<FakeBackend>): FakeBackend {
  const full: FakeBackend = {
    listStacks: vi.fn().mockResolvedValue([]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue(null),
    loadRollbackJournal: vi.fn().mockResolvedValue(null),
    saveState: vi.fn().mockResolvedValue('etag-1'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
    deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    ...backend,
  };
  setupMock.mockResolvedValue({
    stateBackend: full,
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    },
    awsClients: {},
    region: 'us-east-1',
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
  return full;
}

const baseOpts = { statePrefix: 'cdkd', verbose: false, force: true };

describe('rollbackCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no arg + no journals → returns without error', async () => {
    installSetup({ listRawKeys: vi.fn().mockResolvedValue([]) });
    await expect(rollbackCommand(undefined, { ...baseOpts })).resolves.toBeUndefined();
  });

  it('no arg + multiple journals → throws multi-candidate error', async () => {
    installSetup({
      listRawKeys: vi.fn().mockResolvedValue([
        'cdkd/A/us-east-1/rollback-journal.json',
        'cdkd/B/us-east-1/rollback-journal.json',
      ]),
    });
    await expect(rollbackCommand(undefined, { ...baseOpts })).rejects.toThrow(/Multiple stacks/);
  });

  it('named stack with no journal → throws nothing-to-roll-back', async () => {
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({ state: { resources: {}, outputs: {} }, etag: 'e' }),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
    });
    await expect(rollbackCommand('S', { ...baseOpts })).rejects.toThrow(/Nothing to roll back/);
  });

  it('journal present but state.json missing → throws corruption error', async () => {
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue(null),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [] }],
      }),
    });
    await expect(rollbackCommand('S', { ...baseOpts })).rejects.toThrow(/state appears corrupted|state\.json is missing/i);
  });

  it('replays a real CREATE segment → deletes the resource, saves state, pops the journal', async () => {
    replayProvider.delete.mockClear();
    const createOp = {
      logicalId: 'Bucket',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-Bucket',
    };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { Bucket: { physicalId: 'phys-Bucket', resourceType: 'AWS::S3::Bucket', properties: {}, attributes: {}, dependencies: [] } },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [createOp] }],
      }),
    });
    await expect(rollbackCommand('S', { ...baseOpts })).resolves.toBeUndefined();
    expect(replayProvider.delete).toHaveBeenCalledWith(
      'Bucket',
      'phys-Bucket',
      'AWS::S3::Bucket',
      undefined,
      expect.objectContaining({ expectedRegion: 'us-east-1' })
    );
    expect(backend.saveState).toHaveBeenCalled(); // state persisted after the delete
    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
    // Not an initialDeploy → state.json NOT deleted.
    expect(backend.deleteState).not.toHaveBeenCalled();
  });

  it('a per-op provider failure → exit code 2 (PartialFailureError), journal kept', async () => {
    replayProvider.delete.mockClear();
    replayProvider.delete.mockRejectedValueOnce(new Error('AWS delete boom'));
    const createOp = {
      logicalId: 'Bucket',
      changeType: 'CREATE',
      resourceType: 'AWS::S3::Bucket',
      physicalId: 'phys-Bucket',
    };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { Bucket: { physicalId: 'phys-Bucket', resourceType: 'AWS::S3::Bucket', properties: {}, attributes: {}, dependencies: [] } },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [createOp] }],
      }),
    });
    const err = await rollbackCommand('S', { ...baseOpts }).catch((e) => e);
    expect(err).toBeInstanceOf(PartialFailureError);
    expect((err as PartialFailureError).exitCode).toBe(2);
    // Failed segment is NOT popped (kept for re-run).
    expect(backend.popRollbackJournalSegment).not.toHaveBeenCalled();
  });

  it('a skip-with-warning op (unrecoverable DELETE) → exit code 2 but segment still pops', async () => {
    const deleteOp = { logicalId: 'Gone', changeType: 'DELETE', resourceType: 'AWS::S3::Bucket' };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: { version: 8, stackName: 'S', region: 'us-east-1', resources: {}, outputs: {}, lastModified: 1 },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [deleteOp] }],
      }),
    });
    const err = await rollbackCommand('S', { ...baseOpts }).catch((e) => e);
    expect(err).toBeInstanceOf(PartialFailureError);
    // A warning (not a failure) still pops the segment.
    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
  });

  it('--revert-failed off: journaled failed op is left as-is, segment still pops (#1198)', async () => {
    replayProvider.update.mockClear();
    const failedOp = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'phys-Q',
      previousState: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] },
      attemptedProperties: { a: 2 },
    };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { Q: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] } },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [], failedOperations: [failedOp] }],
      }),
    });
    await expect(rollbackCommand('S', { ...baseOpts })).resolves.toBeUndefined();
    expect(replayProvider.update).not.toHaveBeenCalled();
    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
  });

  it('--revert-failed on: force-reverts the failed UPDATE with previous-vs-attempted (#1198)', async () => {
    replayProvider.update.mockClear();
    const failedOp = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'phys-Q',
      previousState: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] },
      attemptedProperties: { a: 2 },
    };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { Q: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] } },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [], failedOperations: [failedOp] }],
      }),
    });
    await expect(rollbackCommand('S', { ...baseOpts, revertFailed: true })).resolves.toBeUndefined();
    expect(replayProvider.update).toHaveBeenCalledWith(
      'Q',
      'phys-Q',
      'AWS::SQS::Queue',
      { a: 1 }, // desired = previous properties
      { a: 2 } // previous side of the diff = ATTEMPTED properties
    );
    expect(backend.saveState).toHaveBeenCalled();
    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
    // Idempotency: the replayed failed-ops are stripped from the journal so a
    // later completed-op failure re-run cannot re-issue the revert.
    expect(backend.setRollbackJournalFailedOperations).toHaveBeenCalledWith('S', 'us-east-1', []);
  });

  it('--revert-failed on: a failed-op revert failure keeps the segment (exit 2)', async () => {
    replayProvider.update.mockClear();
    replayProvider.update.mockRejectedValueOnce(new Error('revert boom'));
    const failedOp = {
      logicalId: 'Q',
      changeType: 'UPDATE',
      resourceType: 'AWS::SQS::Queue',
      physicalId: 'phys-Q',
      previousState: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] },
      attemptedProperties: { a: 2 },
    };
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: { Q: { physicalId: 'phys-Q', resourceType: 'AWS::SQS::Queue', properties: { a: 1 }, attributes: {}, dependencies: [] } },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [], failedOperations: [failedOp] }],
      }),
    });
    const err = await rollbackCommand('S', { ...baseOpts, revertFailed: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PartialFailureError);
    expect(backend.popRollbackJournalSegment).not.toHaveBeenCalled();
    // Failed revert → the failed-op stays in the journal for the re-run
    // (remaining list unchanged, so no strip write is issued).
    expect(backend.setRollbackJournalFailedOperations).not.toHaveBeenCalled();
  });

  it('initialDeploy segment with empty ops → pops journal and deletes state.json', async () => {
    const backend = installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue({ state: { resources: {}, outputs: {}, region: 'us-east-1', stackName: 'S', version: 8, lastModified: 1 }, etag: 'e' }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: true, operations: [] }],
      }),
    });
    await expect(rollbackCommand('S', { ...baseOpts })).resolves.toBeUndefined();
    expect(backend.popRollbackJournalSegment).toHaveBeenCalled();
    expect(backend.deleteState).toHaveBeenCalledWith('S', 'us-east-1');
  });
});

describe('rollbackCommand corruption path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('journal-without-state is a HARD error (exit 1, plain Error — NOT PartialFailureError)', async () => {
    installSetup({
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      getState: vi.fn().mockResolvedValue(null),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [] }],
      }),
    });
    const err = await rollbackCommand('S', { ...baseOpts }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PartialFailureError); // hard error → exit 1, not partial
  });
});
