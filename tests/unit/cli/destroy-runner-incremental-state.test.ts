import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// Regression tests for https://github.com/go-to-k/cdkd/issues/804 (fix 2):
// the destroy path persists state incrementally — each successfully deleted
// resource is removed from the state object and the trimmed state is written
// back to S3 (mirroring deploy's `saveStateAfterResource`). An interrupted /
// partially-failed destroy then leaves a state file that only lists
// resources that still exist, so a re-run never replays deletes against
// already-deleted resources.

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// Keep the import graph light: the runner only touches these for the
// cross-region path, which these tests never exercise.
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

// Live renderer is TTY plumbing — replace with inert stubs.
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

const REGION = 'us-east-1';

function res(dependencies: string[] = [], extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys-id',
    resourceType: 'AWS::S3::Bucket',
    properties: {},
    attributes: {},
    dependencies,
    ...extra,
  };
}

function makeState(resources: Record<string, ResourceState>): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    lastModified: 1,
  };
}

describe('runDestroyForStack incremental state persistence (issue #804)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();
  const mockAcquireLock = vi.fn();
  const mockReleaseLock = vi.fn();

  function makeCtx() {
    return {
      stateBackend: {
        saveState: mockSaveState,
        deleteState: mockDeleteState,
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: mockAcquireLock,
        releaseLock: mockReleaseLock,
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    };
  }

  /** Resources recorded in the Nth saveState call (0-based). */
  function savedResourcesAt(callIndex: number): Record<string, ResourceState> {
    const stateArg = mockSaveState.mock.calls[callIndex]![2] as StackState;
    return stateArg.resources;
  }

  beforeEach(() => {
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockProviderDelete.mockReset();
    mockAcquireLock.mockReset();
    mockReleaseLock.mockReset();
    warnSpy.mockReset();
    debugSpy.mockReset();
  });

  it('persists state without each resource as deletes complete, then deletes the state file', async () => {
    // B depends on A → deletion order is B first, then A (two DAG levels),
    // so the incremental snapshots are deterministic.
    const state = makeState({ A: res(), B: res(['A']) });

    mockProviderDelete.mockResolvedValue(undefined);

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    expect(result.deletedCount).toBe(2);
    expect(result.errorCount).toBe(0);

    // Two incremental persists: after B (A remains), after A (empty).
    expect(mockSaveState).toHaveBeenCalledTimes(2);
    expect(mockSaveState).toHaveBeenCalledWith('TestStack', REGION, expect.anything());
    expect(Object.keys(savedResourcesAt(0))).toEqual(['A']);
    expect(Object.keys(savedResourcesAt(1))).toEqual([]);

    // Clean destroy still ends with the wholesale state-file delete, and
    // every incremental persist flushed BEFORE it (no resurrection race).
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
    const lastSaveOrder = mockSaveState.mock.invocationCallOrder.at(-1)!;
    const deleteOrder = mockDeleteState.mock.invocationCallOrder[0]!;
    expect(deleteOrder).toBeGreaterThan(lastSaveOrder);
  });

  it('a mid-destroy failure preserves only not-yet-deleted + failed resources in state', async () => {
    // Independent siblings: Failing fails, Ok succeeds.
    const state = makeState({ Failing: res(), Ok: res() });

    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'Failing' ? Promise.reject(new Error('boom')) : Promise.resolve()
    );

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(1);

    // State file is preserved (NOT deleted) ...
    expect(mockDeleteState).not.toHaveBeenCalled();
    // ... and the final authoritative write trims the deleted resource:
    // only the failed one remains.
    const lastSave = savedResourcesAt(mockSaveState.mock.calls.length - 1);
    expect(Object.keys(lastSave)).toEqual(['Failing']);
  });

  it('treats "not found" as already deleted and removes the resource from persisted state', async () => {
    const state = makeState({ Gone: res() });

    mockProviderDelete.mockRejectedValue(new Error('NotFoundException: resource is gone'));

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(Object.keys(savedResourcesAt(0))).toEqual([]);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  it('an incremental persist failure does not fail the destroy', async () => {
    const state = makeState({ A: res() });

    mockProviderDelete.mockResolvedValue(undefined);
    mockSaveState.mockReset().mockRejectedValue(new Error('S3 write denied'));

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    // Destroy completed cleanly despite every persist failing.
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist state after deleting A')
    );
    // Lock is still released.
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('a failed final preserve-write on partial destroy is non-fatal too', async () => {
    const state = makeState({ Failing: res() });

    mockProviderDelete.mockRejectedValue(new Error('boom'));
    mockSaveState.mockReset().mockRejectedValue(new Error('S3 write denied'));

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    expect(result.errorCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist remaining state after partial destroy')
    );
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('retained resources stay in the incrementally persisted state', async () => {
    // Retained must survive every incremental persist — its record is only
    // dropped by the wholesale state-file delete at the end of a clean
    // destroy (matching pre-#804 partial-failure semantics).
    const state = makeState({
      Normal: res(),
      Kept: res([], { deletionPolicy: 'Retain' }),
    });

    mockProviderDelete.mockResolvedValue(undefined);

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    expect(result.deletedCount).toBe(1);
    expect(result.retainedCount).toBe(1);
    expect(result.errorCount).toBe(0);

    // One incremental persist (after Normal) — Kept is still in it.
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(Object.keys(savedResourcesAt(0))).toEqual(['Kept']);
    // Clean destroy: state file deleted wholesale (drops the Kept record).
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });
});
