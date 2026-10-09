/**
 * `cdkd rollback`'s preview re-checks a kept fix-forward orphan as its replay
 * does (go-to-k/cdkd#4754): the plan the user confirms shows the delete
 * exactly when the replay deletes, and keeps the "manual attention" skip when
 * the provider cannot prove the record under the id another resource.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn(), child: () => l };
  return { getLogger: () => l };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
const provider = vi.hoisted(() => ({
  delete: vi.fn(),
  isSameResource: vi.fn(),
  resourceIdentity: vi.fn(async () => 'created-token'),
}));
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

import { rollbackCommand } from '../../../src/cli/commands/rollback.js';
import { getLogger } from '../../../src/utils/logger.js';

const TYPE = 'AWS::Kinesis::Stream';

const orphanOp = (physicalId: string, name: string) => ({
  logicalId: 'Orphan',
  changeType: 'CREATE',
  resourceType: TYPE,
  provisionedBy: 'sdk',
  physicalId,
  physicalIdRecoveredFromError: true,
  deletionPolicy: 'Delete',
  createdResourceIdentity: 'created-token',
  attemptedProperties: { Name: name },
});
const segment = (timestamp: number, op: Record<string, unknown>) => ({
  timestamp,
  reason: 'no-rollback-failure',
  initialDeploy: false,
  operations: [],
  failedOperations: [op],
});

function install(segments: unknown[] = [segment(1, orphanOp('orphan-stream', 'orphan-stream'))]): void {
  setupMock.mockResolvedValue({
    stateBackend: {
      listStacks: vi.fn().mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 8,
          stackName: 'S',
          region: 'us-east-1',
          resources: {
            // The fix-forward's record under the orphan's id: another stream.
            Orphan: {
              physicalId: 'orphan-stream-b',
              resourceType: TYPE,
              properties: { Name: 'orphan-stream-b' },
              attributes: {},
              dependencies: [],
              provisionedBy: 'sdk',
            },
          },
          outputs: {},
          lastModified: 1,
        },
        etag: 'e0',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: 'S',
        region: 'us-east-1',
        segments,
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
    region: 'us-east-1',
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
}

const previewLines = (): string[] =>
  (getLogger().info as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('Orphan (') && l.startsWith('  - '));

describe('cdkd rollback previews a kept orphan as its replay acts on it (go-to-k/cdkd#4754)', () => {
  beforeEach(() => {
    (getLogger().info as unknown as ReturnType<typeof vi.fn>).mockClear();
    (getLogger().warn as unknown as ReturnType<typeof vi.fn>).mockClear();
    provider.delete.mockReset().mockResolvedValue(undefined);
    provider.isSameResource.mockReset();
    install();
  });

  it.each([
    ['proven another resource', () => Promise.resolve('different'), true],
    ['a failed re-check', () => Promise.reject(new Error('AccessDenied')), false],
    ['an undecided re-check', () => Promise.resolve('unknown'), false],
  ] as const)('%s', async (_l, verdict, deletes) => {
    provider.isSameResource.mockImplementation(verdict);
    await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true }).catch(
      () => undefined
    );

    // Asked once: by the preview, whose answer, proven or not, the replay of
    // the same op keeps.
    expect(provider.isSameResource).toHaveBeenCalledOnce();
    const lines = previewLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith('  - delete   Orphan')).toBe(deletes);
    expect(lines[0]!.startsWith('  - skip     Orphan')).toBe(!deletes);
    expect(lines[0]!.includes('needs manual attention')).toBe(!deletes);
    expect(provider.delete.mock.calls.length > 0).toBe(deletes);
    // The replay ran: it deleted, or warned while keeping the entry.
    const warned = (getLogger().warn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0])
    );
    expect(warned.some((l) => l.includes('Skipping failed CREATE of Orphan'))).toBe(!deletes);
  });

  it("keeps the fix-forward's record in the preview after proving a newer segment's orphan", async () => {
    // Two failed deploys left an orphan under the same id; the fix-forward
    // record is neither. The newer is proven, the older is not: the preview
    // must still hold the record when it reaches the older one, as the
    // replay does, or it shows that one as a delete the replay never runs.
    install([
      segment(1, orphanOp('orphan-stream-old', 'orphan-stream-old')),
      segment(2, orphanOp('orphan-stream', 'orphan-stream')),
    ]);
    provider.isSameResource.mockImplementation((journaledId: string) =>
      Promise.resolve(journaledId === 'orphan-stream' ? 'different' : 'unknown')
    );
    await rollbackCommand('S', { statePrefix: 'cdkd', verbose: false, force: true }).catch(
      () => undefined
    );

    const lines = previewLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('  - delete   Orphan')).toBe(true);
    expect(lines[1]!.startsWith('  - skip     Orphan')).toBe(true);
    expect(provider.delete.mock.calls.map((c) => c[1])).toEqual(['orphan-stream']);
  });
});
