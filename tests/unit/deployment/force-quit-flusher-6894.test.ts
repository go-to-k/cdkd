/**
 * go-to-k/cdkd#6894: `forceQuitFlusher` in isolation — the bounded wait for
 * queued state saves, and which stack name it answers for the rollback line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const writes = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../../src/deployment/deploy-engine/rollback/journal-write.js', () => ({
  writeRollbackJournalSegment: (...args: unknown[]) => writes.fn(...args),
}));

const identity = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../../src/deployment/rollback-executor/orphan-identity.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  orphanNeedsIdentity: () => true,
  readResourceIdentity: (...args: unknown[]) => identity.read(...args),
}));

import { forceQuitFlusher } from '../../../src/deployment/deploy-engine/execute/force-quit-flush.js';
import { FORCE_QUIT_STATE_WAIT_MS } from '../../../src/deployment/force-quit-journal.js';
import type { DeployRun } from '../../../src/deployment/deploy-engine/execute/run.js';
import { DagExecutor } from '../../../src/deployment/dag-executor.js';
import { CreatedResourceSink } from '../../../src/provisioning/created-resource-sink.js';
import type { ResourceChange } from '../../../src/types/state.js';

function fakeRun(parentStackInfo?: unknown): DeployRun {
  return {
    engine: {
      interrupted: false,
      interruptCause: null,
      options: { ...(parentStackInfo !== undefined && { parentStackInfo }) },
      rollbackDeps: () => ({}),
      attemptedResolvedProps: new Map(),
      replacementRun: { oldDeletedBeforeCreate: new Set() },
    },
    stackName: 'Stack',
    currentState: { resources: {} },
    newResources: {},
    completedOperations: [{ logicalId: 'A', changeType: 'CREATE', resourceType: 'T' }],
    failedOperations: [],
    inFlightCreatedSinks: new Map(),
    template: { Resources: {} },
  } as unknown as DeployRun;
}

beforeEach(() => {
  identity.read.mockReset();
  identity.read.mockResolvedValue('identity-token');
  writes.fn.mockReset();
  writes.fn.mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('forceQuitFlusher', () => {
  it('waits for the queued state saves at most FORCE_QUIT_STATE_WAIT_MS, then writes', async () => {
    vi.useFakeTimers();
    const run = fakeRun();
    const flush = forceQuitFlusher(
      run,
      { executors: () => [], saveChain: () => new Promise<void>(() => undefined) },
      false
    );
    const done = flush();
    // Stops new dispatch at once.
    expect(run.engine.interrupted).toBe(true);
    await vi.advanceTimersByTimeAsync(FORCE_QUIT_STATE_WAIT_MS - 1);
    expect(writes.fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe('Stack');
    expect(writes.fn).toHaveBeenCalledOnce();
    expect(writes.fn.mock.calls[0]![4]).toBe('interrupted');
  });

  it('writes as soon as the queued saves settle', async () => {
    let saved!: () => void;
    const flush = forceQuitFlusher(
      fakeRun(),
      { executors: () => [], saveChain: () => new Promise<void>((r) => (saved = r)) },
      true
    );
    const done = flush();
    await new Promise((r) => setTimeout(r, 5));
    expect(writes.fn).not.toHaveBeenCalled();
    saved();
    await done;
    expect(writes.fn).toHaveBeenCalledOnce();
    // `initialDeploy` is passed through.
    expect(writes.fn.mock.calls[0]![5]).toBe(true);
  });

  it('a nested child writes its segment but names no stack for the rollback line', async () => {
    const flush = forceQuitFlusher(
      fakeRun({ parentStackName: 'Parent', logicalId: 'Child' }),
      { executors: () => [], saveChain: () => Promise.resolve() },
      false
    );
    await expect(flush()).resolves.toBeUndefined();
    expect(writes.fn).toHaveBeenCalledOnce();
  });

  it('names no stack when the write failed', async () => {
    writes.fn.mockResolvedValue(false);
    const flush = forceQuitFlusher(
      fakeRun(),
      { executors: () => [], saveChain: () => Promise.resolve() },
      false
    );
    await expect(flush()).resolves.toBeUndefined();
  });

  it('never reads a reported resource identity, even after a sibling failure (the read outlasts the exit budget)', async () => {
    const run = fakeRun();
    (run.engine as unknown as { interruptCause: string }).interruptCause = 'sibling-failure';
    const sink = new CreatedResourceSink('Made', 'AWS::SQS::Queue');
    sink.record({ physicalId: 'phys-made' });
    run.inFlightCreatedSinks.set('Made', sink);
    const executor = new DagExecutor<ResourceChange>();
    executor.add({
      id: 'Made',
      dependencies: new Set(),
      state: 'running',
      data: { logicalId: 'Made', changeType: 'CREATE', resourceType: 'AWS::SQS::Queue' } as never,
    });
    const flush = forceQuitFlusher(
      run,
      { executors: () => [executor], saveChain: () => Promise.resolve() },
      false
    );
    await flush();
    expect(identity.read).not.toHaveBeenCalled();
    const failed = writes.fn.mock.calls[0]![3] as Array<{ logicalId: string; physicalId?: string }>;
    // The resource is still journaled by its id.
    expect(failed).toEqual([expect.objectContaining({ logicalId: 'Made', physicalId: 'phys-made' })]);
  });
});
