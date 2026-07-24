import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn(), child: () => l };
  return { getLogger: () => l };
});

vi.mock('../../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
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

describe('rollbackCommand exit codes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a PartialFailureError (exit 2) shape for the corruption path guard', () => {
    // Sanity: PartialFailureError maps to exit code 2 (used for partial replay).
    expect(new PartialFailureError('x').exitCode).toBe(2);
  });
});
