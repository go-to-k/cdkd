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

function makeState(
  resources: Record<string, ResourceState>,
  extra: Partial<StackState> = {}
): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources,
    outputs: {},
    lastModified: 1,
    ...extra,
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
        // No other stack imports from us — the strong-ref pre-flight /
        // lock-protected scans short-circuit on an empty stack list.
        listStacks: vi.fn().mockResolvedValue([]),
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
    return savedStateAt(callIndex).resources;
  }

  /** Full state object recorded in the Nth saveState call (0-based). */
  function savedStateAt(callIndex: number): StackState {
    return mockSaveState.mock.calls[callIndex]![2] as StackState;
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

  // ---- MAJOR fix (issue #804 review): the preserved partial state must NOT
  // advertise outputs / imports / outputReads for resources that are gone.
  it('clears outputs and drops imports/outputReads in every persisted partial-destroy snapshot', async () => {
    // A producer-shaped stack: it has outputs (a potential export), AND it
    // is also a consumer (imports[] + outputReads[]). One resource fails so
    // the state is PRESERVED (not deleted), surfacing the persisted shape.
    const state = makeState(
      { Failing: res(), Ok: res() },
      {
        outputs: { BucketArn: 'arn:aws:s3:::my-bucket' },
        imports: [
          { sourceStack: 'ProducerStack', sourceRegion: REGION, exportName: 'SomeExport' },
        ],
        outputReads: [
          { sourceStack: 'OtherStack', sourceRegion: REGION, outputName: 'SomeOutput' },
        ],
      }
    );

    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'Failing' ? Promise.reject(new Error('boom')) : Promise.resolve()
    );

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    expect(result.errorCount).toBe(1);
    // State preserved, not deleted.
    expect(mockDeleteState).not.toHaveBeenCalled();

    // EVERY persisted snapshot (incremental after Ok + the final
    // preserve-write) clears outputs and drops imports / outputReads — the
    // gone resources' exports must not linger.
    expect(mockSaveState.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < mockSaveState.mock.calls.length; i++) {
      const saved = savedStateAt(i);
      expect(saved.outputs).toEqual({});
      expect(saved.imports).toBeUndefined();
      expect(saved.outputReads).toBeUndefined();
    }

    // The in-memory `state` object the strong-ref check reads is NOT mutated
    // — clearing happens only in the persisted snapshot copies.
    expect(state.outputs).toEqual({ BucketArn: 'arn:aws:s3:::my-bucket' });
    expect(state.imports).toHaveLength(1);
    expect(state.outputReads).toHaveLength(1);
  });

  it('also clears outputs in incremental snapshots on a clean destroy', async () => {
    // Even when the destroy fully succeeds (state-file deleted at the end),
    // the intermediate incremental snapshots must already be output-free —
    // an interrupt between the last incremental persist and the wholesale
    // delete would otherwise leave a phantom-export state behind.
    const state = makeState(
      { A: res(), B: res(['A']) },
      { outputs: { Out: 'value' } }
    );
    mockProviderDelete.mockResolvedValue(undefined);

    await runDestroyForStack('TestStack', state, makeCtx());

    expect(mockSaveState).toHaveBeenCalledTimes(2);
    expect(savedStateAt(0).outputs).toEqual({});
    expect(savedStateAt(1).outputs).toEqual({});
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  // ---- Test gap 3: a mid-chain incremental persist failure must not poison
  // later links — the destroy is still clean end-to-end.
  it('a mid-chain incremental persist failure does not poison later links or the final deleteState', async () => {
    // Three independent siblings → three incremental persists. The MIDDLE
    // one (2nd saveState) rejects; the destroy must still complete cleanly
    // and reach the wholesale deleteState.
    const state = makeState({ A: res(), B: res(), C: res() });
    mockProviderDelete.mockResolvedValue(undefined);

    let saveCall = 0;
    mockSaveState.mockReset().mockImplementation(() => {
      saveCall++;
      return saveCall === 2
        ? Promise.reject(new Error('transient S3 error mid-chain'))
        : Promise.resolve('"etag"');
    });

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    expect(result.deletedCount).toBe(3);
    expect(result.errorCount).toBe(0);
    // All three links ran (the failed middle one did not abort the chain).
    expect(mockSaveState).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to persist state'));
    // The wholesale state-file delete still fired despite the mid-chain error.
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
    const lastSaveOrder = mockSaveState.mock.invocationCallOrder.at(-1)!;
    const deleteOrder = mockDeleteState.mock.invocationCallOrder[0]!;
    expect(deleteOrder).toBeGreaterThan(lastSaveOrder);
  });

  // ---- Test gap 5: concurrent-level snapshot determinism. Three independent
  // siblings in one DAG level finish concurrently; the final snapshot is
  // empty and the intermediate snapshots shrink monotonically.
  it('produces monotonically shrinking snapshots for 3 concurrent siblings in one level', async () => {
    const state = makeState({ A: res(), B: res(), C: res() });
    mockProviderDelete.mockResolvedValue(undefined);

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    expect(result.deletedCount).toBe(3);
    expect(result.errorCount).toBe(0);

    // One incremental persist per sibling, serialized through the save
    // chain. The snapshot bodies are spread at FLUSH time (not schedule
    // time) from the shared `remainingResources`, so with three siblings
    // completing concurrently the exact per-snapshot sizes are NOT pinned —
    // what IS deterministic is that the sizes are monotonically
    // non-increasing and the LAST snapshot is empty (every delete has
    // landed by the time the final chain link flushes). This pins the
    // flush-time-spread semantics: a re-run after an interrupt never sees a
    // snapshot LARGER than an earlier one, and the terminal snapshot is the
    // fully-trimmed state.
    expect(mockSaveState).toHaveBeenCalledTimes(3);
    const sizes = mockSaveState.mock.calls.map(
      (c) => Object.keys((c[2] as StackState).resources).length
    );
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]!).toBeLessThanOrEqual(sizes[i - 1]!);
    }
    expect(sizes.at(-1)).toBe(0);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
  });

  // ---- Test gap 4: nested-stack recursion. NestedStackProvider.delete
  // recurses into runDestroyForStack for the CHILD (its own state key,
  // flushing + deleting the child state before the parent's own final
  // deleteState). We model the recursion at the provider seam the runner
  // controls: the parent's single AWS::CloudFormation::Stack resource's
  // delete() drives child-key state writes + a child deleteState, and we
  // assert (a) the child key differs from the parent and (b) the child's
  // deleteState lands BEFORE the parent's wholesale deleteState.
  it('a nested-stack child delete drives its own state key and flushes before the parent deleteState', async () => {
    const PARENT = 'ParentStack';
    const CHILD_KEY = 'ParentStack~Nested';
    const state = makeState({
      Nested: res([], { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'child-arn' }),
    });

    // The provider's delete() simulates NestedStackProvider recursing into
    // runDestroyForStack for the child: a child incremental persist + a
    // child wholesale deleteState, both on the CHILD state key.
    mockProviderDelete.mockImplementation(async () => {
      await mockSaveState(CHILD_KEY, REGION, makeState({ GrandA: res() }));
      await mockSaveState(CHILD_KEY, REGION, makeState({}));
      await mockDeleteState(CHILD_KEY, REGION);
    });

    const result = await runDestroyForStack(PARENT, state, makeCtx());

    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);

    // Child state writes used the child key; parent's used the parent key.
    const childKeySaves = mockSaveState.mock.calls.filter((c) => c[0] === CHILD_KEY);
    const parentKeySaves = mockSaveState.mock.calls.filter((c) => c[0] === PARENT);
    expect(childKeySaves.length).toBe(2);
    expect(parentKeySaves.length).toBe(1); // incremental persist after the nested delete

    // The child's wholesale deleteState (key = CHILD_KEY) landed BEFORE the
    // parent's wholesale deleteState (key = PARENT) — child fully torn down
    // and flushed before the parent's final state decision.
    const childDeleteOrder = mockDeleteState.mock.calls.findIndex((c) => c[0] === CHILD_KEY);
    const parentDeleteOrder = mockDeleteState.mock.calls.findIndex((c) => c[0] === PARENT);
    expect(childDeleteOrder).toBeGreaterThanOrEqual(0);
    expect(parentDeleteOrder).toBeGreaterThanOrEqual(0);
    expect(
      mockDeleteState.mock.invocationCallOrder[childDeleteOrder]!
    ).toBeLessThan(mockDeleteState.mock.invocationCallOrder[parentDeleteOrder]!);
  });
});
