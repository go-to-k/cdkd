import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// Tests for https://github.com/go-to-k/cdkd/issues/816: graceful SIGINT
// handling on `cdkd destroy`. The first Ctrl-C stops scheduling NEW deletes,
// lets the in-flight provider.delete calls finish, flushes the incremental
// state (the save-chain from #804), releases the lock, and surfaces a non-zero
// exit (result.interrupted = true). A second Ctrl-C force-quits via
// process.exit(130). The handler is registered on `process` only for the
// duration of the call and removed afterwards (no listener leak).
//
// We DO NOT send real OS signals. Instead we spy on `process.on('SIGINT', ...)`
// to capture the handler the runner registers, then invoke it directly at a
// controlled point (while a delete is in flight) — this drives the draining
// flag exactly as a real SIGINT would.

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
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

describe('runDestroyForStack graceful SIGINT (issue #816)', () => {
  const mockSaveState = vi.fn();
  const mockDeleteState = vi.fn();
  const mockProviderDelete = vi.fn();
  const mockAcquireLock = vi.fn();
  const mockReleaseLock = vi.fn();
  const mockRemoveStack = vi.fn();

  // The runner registers exactly one SIGINT handler per call. We capture it
  // here so a test can invoke it (= simulate Ctrl-C) at a controlled moment.
  let capturedSigintHandlers: Array<() => void>;
  let onSpy: ReturnType<typeof vi.spyOn>;
  let removeListenerSpy: ReturnType<typeof vi.spyOn>;

  function makeCtx() {
    return {
      stateBackend: {
        saveState: mockSaveState,
        deleteState: mockDeleteState,
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
      exportIndexStore: { removeStack: mockRemoveStack } as never,
    };
  }

  function savedResourcesAt(callIndex: number): Record<string, ResourceState> {
    return (mockSaveState.mock.calls[callIndex]![2] as StackState).resources;
  }

  beforeEach(() => {
    mockSaveState.mockReset().mockResolvedValue('"etag"');
    mockDeleteState.mockReset().mockResolvedValue(undefined);
    mockProviderDelete.mockReset();
    mockAcquireLock.mockReset().mockResolvedValue(true);
    mockReleaseLock.mockReset();
    mockRemoveStack.mockReset().mockResolvedValue(undefined);
    warnSpy.mockReset();

    capturedSigintHandlers = [];
    const realOn = process.on.bind(process);
    const realRemove = process.removeListener.bind(process);
    onSpy = vi.spyOn(process, 'on').mockImplementation((event: string | symbol, handler: () => void) => {
      if (event === 'SIGINT') {
        capturedSigintHandlers.push(handler);
        return process;
      }
      return realOn(event as never, handler as never);
    }) as never;
    removeListenerSpy = vi
      .spyOn(process, 'removeListener')
      .mockImplementation((event: string | symbol, handler: () => void) => {
        if (event === 'SIGINT') {
          capturedSigintHandlers = capturedSigintHandlers.filter((h) => h !== handler);
          return process;
        }
        return realRemove(event as never, handler as never);
      }) as never;
  });

  afterEach(() => {
    onSpy.mockRestore();
    removeListenerSpy.mockRestore();
  });

  it('on first SIGINT: finishes the in-flight delete, schedules no new deletes, preserves trimmed state, releases lock, marks interrupted', async () => {
    // Two levels: B (deleted first), then A. Fire SIGINT while B's delete is
    // in flight so the A level is never scheduled.
    const state = makeState({ A: res(), B: res(['A']) });

    let firstDeleteResolve: () => void = () => {};
    mockProviderDelete.mockImplementation((logicalId: string) => {
      if (logicalId === 'B') {
        // In-flight: trigger the interrupt, then let this delete finish.
        return new Promise<void>((resolve) => {
          firstDeleteResolve = resolve;
          // Simulate Ctrl-C now (handler is registered by this point).
          expect(capturedSigintHandlers.length).toBe(1);
          capturedSigintHandlers[0]!();
          resolve();
        });
      }
      return Promise.resolve();
    });

    const result = await runDestroyForStack('TestStack', state, makeCtx());
    void firstDeleteResolve;

    // B (in-flight when interrupt fired) completed; A was never deleted.
    expect(mockProviderDelete).toHaveBeenCalledTimes(1);
    expect(mockProviderDelete).toHaveBeenCalledWith('B', expect.anything(), expect.anything(), expect.anything(), expect.anything());
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.interrupted).toBe(true);

    // State PRESERVED (not deleted) and trimmed to the surviving resource A.
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockRemoveStack).not.toHaveBeenCalled();
    const lastSave = savedResourcesAt(mockSaveState.mock.calls.length - 1);
    expect(Object.keys(lastSave)).toEqual(['A']);

    // Lock released and the listener removed (no leak).
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    expect(capturedSigintHandlers.length).toBe(0);

    // User-facing interrupt warning surfaced.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('interrupted'));
  });

  it('schedules no deletes in subsequent levels once draining (level-boundary gate)', async () => {
    // Diamond: D depends on B and C; B and C both depend on A. Deletion order
    // (reverse DAG) = level [D], then level [B, C], then level [A]. Fire the
    // interrupt while D (the first level) is in flight: the B/C level and the
    // A level must never be scheduled, so only D is deleted and {A, B, C}
    // survive in the preserved state.
    const state = makeState({
      A: res(),
      B: res(['A']),
      C: res(['A']),
      D: res(['B', 'C']),
    });

    mockProviderDelete.mockImplementation((logicalId: string) => {
      if (logicalId === 'D') {
        capturedSigintHandlers[0]!();
      }
      return Promise.resolve();
    });

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    // Only the first level (D) ran; the level-boundary check stopped the rest.
    expect(mockProviderDelete).toHaveBeenCalledTimes(1);
    expect(mockProviderDelete).toHaveBeenCalledWith('D', expect.anything(), expect.anything(), expect.anything(), expect.anything());
    expect(result.deletedCount).toBe(1);
    expect(result.interrupted).toBe(true);

    // A, B, C survive in the preserved (not deleted) state.
    expect(mockDeleteState).not.toHaveBeenCalled();
    const lastSave = savedResourcesAt(mockSaveState.mock.calls.length - 1);
    expect(Object.keys(lastSave).sort()).toEqual(['A', 'B', 'C']);
  });

  it('a second SIGINT force-quits via process.exit(130), prints the recovery command, and attempts a best-effort lock release', async () => {
    const state = makeState({ A: res() });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((() => true) as unknown) as typeof process.stderr.write);

    mockReleaseLock.mockResolvedValue(undefined);
    mockProviderDelete.mockImplementation(() => {
      // First Ctrl-C → draining; second Ctrl-C → force-quit.
      capturedSigintHandlers[0]!();
      capturedSigintHandlers[0]!();
      return Promise.resolve();
    });

    await runDestroyForStack('TestStack', state, makeCtx());

    expect(exitSpy).toHaveBeenCalledWith(130);

    // BLOCKER fix (issue #816): the force-quit bypasses the `finally`, so it
    // MUST print the exact recovery command (interpolating the real stack
    // name) before exiting so a stranded lock is recoverable deterministically.
    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).toContain('Force-quit: stack lock may not be released');
    expect(stderrText).toContain('cdkd force-unlock TestStack');

    // ... and fire a best-effort (un-awaited) release first.
    expect(mockReleaseLock).toHaveBeenCalledWith('TestStack', REGION);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('the SIGINT listener is removed after a normal (uninterrupted) completion', async () => {
    const state = makeState({ A: res(), B: res(['A']) });
    mockProviderDelete.mockResolvedValue(undefined);

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    expect(result.interrupted).toBe(false);
    expect(result.deletedCount).toBe(2);
    // Clean destroy: state file deleted, listener removed.
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
    expect(capturedSigintHandlers.length).toBe(0);
  });

  it('does NOT report interrupted when the signal lands after the state was DELETED', async () => {
    // The outer `finally`'s `result.interrupted ||= draining` re-sync used to
    // run UNGATED, and everything it spans (`renderer.stop()`, the `saveChain`
    // flush, the real `deleteState` S3 round-trip, `releaseLock`) happens with
    // `sigintHandler` still armed and AFTER the in-`try` read that decided
    // `preserveState`. So a signal there flipped the PER-STACK flag true over a
    // stack whose state file was already gone — and `destroy.ts` / `state.ts`
    // OR that flag unconditionally into the terminal verdict, so the command
    // exited 2 with "State preserved — re-run 'cdkd destroy' to finish" over a
    // destroy that had fully completed. Both halves of that sentence false.
    //
    // Firing from inside `deleteState` puts the signal exactly in that window:
    // past the in-`try` read, before the runner's `removeListener`.
    const state = makeState({ A: res() });
    mockProviderDelete.mockResolvedValue(undefined);
    mockDeleteState.mockImplementation(async () => {
      capturedSigintHandlers[0]!();
    });

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    // The positive marker that this really is the deleted-state case rather
    // than an unrelated early exit: the delete ran and the state file is gone.
    expect(mockProviderDelete).toHaveBeenCalledTimes(1);
    expect(mockDeleteState).toHaveBeenCalledTimes(1);
    expect(result.deletedCount).toBe(1);
    expect(result.errorCount).toBe(0);
    // The invariant: a stack whose state was deleted never reports interrupted.
    expect(result.interrupted).toBe(false);
  });

  it('DOES re-sync a tail signal when the stack left work behind', async () => {
    // The discriminator for the case above, and the reason the fix is a gate
    // rather than a deletion of the re-sync. Same window, opposite premise: the
    // stack PRESERVED its state (a failed delete), so there genuinely is work
    // to re-run and the late signal must still reach the caller. Deleting the
    // re-sync line entirely would pass the case above and fail this one.
    const state = makeState({ A: res(), B: res(['A']) });
    mockProviderDelete.mockImplementation((logicalId: string) =>
      logicalId === 'B' ? Promise.reject(new Error('delete blew up')) : Promise.resolve()
    );
    // `releaseLock` runs in the inner `finally`, i.e. still before the re-sync
    // and still with the handler armed.
    mockReleaseLock.mockImplementation(async () => {
      capturedSigintHandlers[0]!();
    });

    const result = await runDestroyForStack('TestStack', state, makeCtx());

    // Positive markers that state really was preserved for a retry.
    expect(result.errorCount).toBe(1);
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(result.interrupted).toBe(true);
  });

  it('removes the SIGINT listener via process.removeListener in the finally', async () => {
    const state = makeState({ A: res() });
    mockProviderDelete.mockResolvedValue(undefined);

    await runDestroyForStack('TestStack', state, makeCtx());

    expect(removeListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(capturedSigintHandlers.length).toBe(0);
  });
});
