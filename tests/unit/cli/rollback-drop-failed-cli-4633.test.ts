/**
 * `cdkd rollback` wiring of `--drop-failed` (go-to-k/cdkd#4633): the option
 * routes to the journal-only drop (no provider, no replay, no state write),
 * a conflicting flag is refused before any AWS call, and a plain rollback
 * whose journaled orphan's delete failed names the option on its exit.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const push = (l: unknown) => void logLines.push(String(l));
  const l = { debug: vi.fn(), info: vi.fn(push), warn: vi.fn(push), error: vi.fn(push), setLevel: vi.fn(), child: () => l };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
const provider = vi.hoisted(() => ({ delete: vi.fn(), update: vi.fn() }));
const registryCtor = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: registryCtor.mockImplementation(() => ({
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

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';

const orphan = (logicalId: string) => ({
  logicalId,
  changeType: 'CREATE',
  resourceType: 'AWS::Kinesis::Stream',
  provisionedBy: 'sdk',
  physicalId: `${logicalId.toLowerCase()}-stream`,
  physicalIdRecoveredFromError: true,
  attemptedProperties: {},
});

function install() {
  const backend = {
    listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
    listRawKeys: vi.fn().mockResolvedValue([]),
    getState: vi.fn().mockResolvedValue({
      state: { version: 8, stackName: 'S', region: 'us-east-1', resources: {}, outputs: {}, lastModified: 1 },
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
          failedOperations: [orphan('Stuck'), orphan('Other')],
        },
      ],
    }),
    dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
    saveState: vi.fn().mockResolvedValue('etag-1'),
    popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
    setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
    deleteState: vi.fn().mockResolvedValue(undefined),
  };
  const lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    getLockInfo: vi.fn().mockResolvedValue(null),
  };
  setupMock.mockResolvedValue({
    stateBackend: backend,
    lockManager,
    awsClients: {},
    region: 'us-east-1',
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
  return { backend, lockManager };
}

describe('cdkd rollback --drop-failed (go-to-k/cdkd#4633)', () => {
  beforeEach(() => {
    logLines.length = 0;
    setupMock.mockReset();
    registryCtor.mockClear();
    provider.delete.mockReset();
  });

  it('drops the one entry under the lock, and builds no provider, deletes nothing, saves no state', async () => {
    const { backend, lockManager } = install();
    await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true, dropFailed: 'Stuck' });
    expect(lockManager.acquireLockWithRetry).toHaveBeenCalledTimes(1);
    expect(lockManager.releaseLock).toHaveBeenCalledTimes(1);
    expect(backend.dropRollbackJournalFailedOperations).toHaveBeenCalledTimes(1);
    const [, , drop] = backend.dropRollbackJournalFailedOperations.mock.calls[0]!;
    const segment = (await backend.loadRollbackJournal()).segments[0];
    expect(drop(orphan('Stuck'), segment)).toBe(true);
    expect(drop(orphan('Other'), segment)).toBe(false);
    expect(registryCtor).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(backend.saveState).not.toHaveBeenCalled();
    expect(backend.popRollbackJournalSegment).not.toHaveBeenCalled();
  });

  it.each([
    [{ revertFailed: true }, '--revert-failed'],
    [{ orphan: ['X'] }, '--orphan'],
    [{ skipFinalSnapshot: true }, '--skip-final-snapshot'],
  ])('refuses %o before it opens the state bucket', async (extra, flag) => {
    install();
    await expect(
      rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true, dropFailed: 'Stuck', ...extra })
    ).rejects.toThrow(`--drop-failed cannot be combined with ${flag}`);
    expect(setupMock).not.toHaveBeenCalled();
  });

  it('a failed revert of a failed UPDATE (no orphan) names no --drop-failed', async () => {
    const { backend } = install();
    backend.getState.mockResolvedValue({
      state: {
        version: 8,
        stackName: 'S',
        region: 'us-east-1',
        resources: {
          Upd: { physicalId: 'upd', resourceType: 'AWS::Kinesis::Stream', properties: { A: 2 }, attributes: {}, dependencies: [] },
        },
        outputs: {},
        lastModified: 1,
      },
      etag: 'e0',
    });
    backend.loadRollbackJournal.mockResolvedValue({
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
              logicalId: 'Upd',
              changeType: 'UPDATE',
              resourceType: 'AWS::Kinesis::Stream',
              provisionedBy: 'sdk',
              physicalId: 'upd',
              attemptedProperties: { A: 2 },
              previousState: { physicalId: 'upd', resourceType: 'AWS::Kinesis::Stream', properties: { A: 1 }, attributes: {}, dependencies: [] },
            },
          ],
        },
      ],
    });
    provider.update.mockRejectedValue(new Error('AccessDeniedException'));
    const err = await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true, revertFailed: true }).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    // Premise: the revert was attempted and failed.
    expect(provider.update).toHaveBeenCalled();
    expect(err?.message).toContain('Rollback completed with 1 failed operation(s)');
    expect(err?.message).not.toContain('--drop-failed');
  });

  it("a plain rollback whose orphan's delete failed names --drop-failed for it on the exit", async () => {
    const { backend } = install();
    // The stack's own region differs from the CLI's (`setup.region`), so the
    // pointer must name the one the stack's state is in.
    backend.listStacks.mockResolvedValue([{ stackName: 'S', region: 'eu-west-1' }]);
    provider.delete.mockImplementation(async (logicalId: string) => {
      if (logicalId === 'Stuck') throw new Error('AccessDeniedException');
    });
    const err = await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true }).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err?.message).toContain('Rollback completed with 1 failed operation(s)');
    expect(err?.message).toContain('Drop with: cdkd rollback S --stack-region eu-west-1 --drop-failed Stuck');
    expect(err?.message).not.toContain('--drop-failed Other');
    // The labelled re-run line stays last.
    expect(err!.message.trimEnd().split('\n').at(-1)).toMatch(/^Re-run with: cdkd rollback S/);
  });
});
