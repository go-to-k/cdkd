/**
 * Issue #2171: `runDestroyForStack`'s 0-resource early return deleted the state
 * record with NO lock held, from a snapshot the CALLER took before this
 * function was entered.
 *
 * A record reads as empty for exactly one interval that is not idle — the start
 * of a concurrent `cdkd deploy`, after it has taken the lock and before its
 * first resource lands — so the unlocked delete removed the state file out from
 * under a live deploy. The fix takes the lock and RE-READS, which is the half a
 * lock alone would not have fixed: the emptiness has to be re-established under
 * the lock rather than inherited from the caller's stale snapshot.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(() => ({ getProviderFor: vi.fn() })),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(() => ({ destroy: vi.fn() })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => {
  const renderer = {
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  };
  return { getLiveRenderer: () => renderer };
});

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';

const REGION = 'us-east-1';

function emptyState(): StackState {
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: {},
    outputs: {},
    lastModified: 1,
  };
}

function populatedResource(): ResourceState {
  return {
    physicalId: 'phys-id',
    resourceType: 'AWS::SSM::Parameter',
    properties: {},
    attributes: {},
    dependencies: [],
  };
}

function makeCtx(opts: {
  acquired?: boolean;
  /** What the RE-READ under the lock finds. */
  recheck?: Awaited<ReturnType<S3StateBackend['getState']>>;
  getLockInfo?: unknown;
  statePrefix?: string;
}) {
  const acquireLock = vi.fn().mockResolvedValue(opts.acquired ?? true);
  const releaseLock = vi.fn().mockResolvedValue(undefined);
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const getState = vi.fn().mockResolvedValue(opts.recheck ?? null);
  const getLockInfo = vi.fn().mockResolvedValue(opts.getLockInfo ?? null);
  const order: string[] = [];
  acquireLock.mockImplementation(async () => {
    order.push('acquire');
    return opts.acquired ?? true;
  });
  deleteState.mockImplementation(async () => {
    order.push('deleteState');
  });
  releaseLock.mockImplementation(async () => {
    order.push('release');
  });
  return {
    acquireLock,
    releaseLock,
    deleteState,
    getState,
    order,
    ctx: {
      stateBackend: {
        getState,
        deleteState,
        saveState: vi.fn(),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: { acquireLock, releaseLock, getLockInfo } as unknown as LockManager,
      providerRegistry: { getProviderFor: vi.fn() } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      ...(opts.statePrefix !== undefined && { statePrefix: opts.statePrefix }),
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

describe('runDestroyForStack — empty-state cleanup takes the lock (issue #2171)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('acquires the lock BEFORE deleting the state record, and releases it after', async () => {
    const h = makeCtx({ acquired: true, recheck: null });

    const result = await runDestroyForStack('TestStack', emptyState(), h.ctx);

    expect(result.skippedEmpty).toBe(true);
    expect(h.deleteState).toHaveBeenCalledWith('TestStack', REGION);
    // The ORDER is the fence: a delete before the acquire is the defect.
    expect(h.order).toEqual(['acquire', 'deleteState', 'release']);
  });

  it('refuses when the lock is held, and deletes nothing', async () => {
    const h = makeCtx({ acquired: false });
    const before = process.listeners('SIGINT');

    await expect(runDestroyForStack('TestStack', emptyState(), h.ctx)).rejects.toThrow(
      /Could not acquire lock/
    );
    expect(h.deleteState).not.toHaveBeenCalled();
    // The foreign lock must be left alone — releasing here is exactly the
    // owner-blind delete issue #2161 removed from the main path.
    expect(h.releaseLock).not.toHaveBeenCalled();
    // ...and the listener must go with it. The source-text pin cannot see this
    // one: its window is satisfied by the SIBLING cleanup on the throw path a
    // few lines up, so deleting THIS removeListener left it green.
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('RE-READS under the lock and refuses when the record is no longer empty', async () => {
    // The half a lock alone would not fix: the caller's snapshot was taken
    // before this function ran, so a deploy that landed in between is only
    // visible to a read taken under the lock.
    const h = makeCtx({
      acquired: true,
      recheck: {
        state: { ...emptyState(), resources: { Param: populatedResource() } },
        etag: '"e"',
      } as Awaited<ReturnType<S3StateBackend['getState']>>,
    });

    await expect(runDestroyForStack('TestStack', emptyState(), h.ctx)).rejects.toThrow(
      /now has 1 resource\(s\)/
    );
    expect(h.deleteState).not.toHaveBeenCalled();
    // Our own lock IS released — we took it, so leaving it stranded would be
    // the mirror-image defect.
    expect(h.releaseLock).toHaveBeenCalledWith('TestStack', REGION);
  });

  it('reads the state back for the same stack and region it locked', async () => {
    const h = makeCtx({ acquired: true, recheck: null });
    await runDestroyForStack('TestStack', emptyState(), h.ctx);
    expect(h.getState).toHaveBeenCalledWith('TestStack', REGION);
    expect(h.acquireLock).toHaveBeenCalledWith('TestStack', REGION, undefined, 'destroy');
  });

  it('removes its SIGINT listener when the acquire THROWS, not just when it returns false', async () => {
    // `acquireLock` throws a LockError on an S3 failure, which is a DIFFERENT
    // path from the contention `false`. The first cut removed the listener only
    // on the boolean path, so a 5xx leaked a handler that then pre-empts every
    // later drain in the process.
    const h = makeCtx({ acquired: true });
    h.acquireLock.mockRejectedValue(new Error('S3 unavailable'));
    const before = process.listeners('SIGINT');

    await expect(runDestroyForStack('TestStack', emptyState(), h.ctx)).rejects.toThrow(
      'S3 unavailable'
    );

    expect(process.listeners('SIGINT')).toEqual(before);
    expect(h.releaseLock).not.toHaveBeenCalled();
  });

  it('DRAINS on the first SIGINT rather than exiting the process', async () => {
    // A nested-stack child reaches this branch through
    // `NestedStackProvider.delete`, and listeners fire in registration order —
    // so a handler that exits on the FIRST signal kills the process after the
    // PARENT's handler has merely set its drain flag, stranding the parent's
    // lock for its full TTL. The contract here is the main handler's: first
    // signal records, second force-quits.
    const h = makeCtx({ acquired: true, recheck: null });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    let handler: NodeJS.SignalsListener | undefined;
    h.acquireLock.mockImplementation(async () => {
      // Captured while the branch owns it — this is the only window in which
      // the handler is registered.
      handler = process.listeners('SIGINT').at(-1) as NodeJS.SignalsListener;
      return true;
    });

    const result = await runDestroyForStack('TestStack', emptyState(), h.ctx);
    expect(handler, 'no SIGINT handler was registered by the empty branch').toBeDefined();

    // Firing it once must NOT exit.
    handler!('SIGINT');
    expect(exitSpy).not.toHaveBeenCalled();
    // Second signal force-quits.
    handler!('SIGINT');
    expect(exitSpy).toHaveBeenCalledWith(130);

    expect(result.skippedEmpty).toBe(true);
    exitSpy.mockRestore();
  });

  it('does NOT report `interrupted` after DELETING the state record', async () => {
    // Round 3 (issue #2117): this case used to assert the exact opposite, and
    // it was 10/10 green while pinning the defect. `result.interrupted ||=
    // emptyInterrupted` sat at the end of this branch, ~950 lines above the
    // main path's `&& statePreserved` gate and BEFORE the `try`/`finally` that
    // carries it — so a first Ctrl-C here made `destroy.ts` throw
    // `Destroy interrupted by Ctrl-C. State preserved -- re-run 'cdkd destroy'
    // to finish` and exit 2 over a stack whose state file it had just DELETED,
    // and skip `--purge-events` for a stack with no state left to post-mortem.
    //
    // `result.interrupted` is the PER-STACK answer to "is there work left in
    // this stack?". After `deleteState` the answer is no, whatever signal
    // arrived: nothing is preserved and nothing remains to re-run against.
    // The command-level "the user asked to stop" question has a different
    // owner (`watchCommandInterrupt`), which both `--all` loops read live.
    const h = makeCtx({ acquired: true, recheck: null });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    h.getState.mockImplementation(async () => {
      // Mid-branch: the handler is registered and the lock is held. Firing
      // from INSIDE is what makes the flag observable at all — the drain case
      // above fires after the call resolved.
      (process.listeners('SIGINT').at(-1) as NodeJS.SignalsListener)('SIGINT');
      return null;
    });

    const result = await runDestroyForStack('TestStack', emptyState(), h.ctx);

    // The two assertions are one invariant: the record is GONE, so the stack
    // must not report work left in it.
    expect(h.deleteState).toHaveBeenCalledWith('TestStack', REGION);
    expect(result.interrupted).toBe(false);
    expect(result.skippedEmpty).toBe(true);
    // A first signal still DRAINS rather than exiting: the cleanup completed.
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('leaves `interrupted` false on the clean, signal-free empty branch too', async () => {
    // Negative control for the case above: without it, a `result.interrupted =
    // false` hard-coded anywhere would satisfy it, and so would a branch that
    // never sets the flag under ANY condition for the wrong reason.
    const h = makeCtx({ acquired: true, recheck: null });
    const result = await runDestroyForStack('TestStack', emptyState(), h.ctx);
    expect(result.interrupted).toBe(false);
    expect(result.skippedEmpty).toBe(true);
  });

  it('carries --state-prefix into the recovery hint when it is not the default', async () => {
    // `force-unlock` re-resolves the prefix from its own default, so a run
    // under `--state-prefix team-a` that suggested a bare command would send
    // the user at a DIFFERENT team's lock in a shared bucket — the
    // wrong-lock-object class #2170 exists to close.
    const h = makeCtx({ acquired: false, statePrefix: 'team-a' });
    h.ctx.lockManager.getLockInfo = vi.fn().mockResolvedValue(null);

    await expect(runDestroyForStack('TestStack', emptyState(), h.ctx)).rejects.toThrow(
      /--state-prefix team-a/
    );
  });

  it('omits --state-prefix when it is the default', async () => {
    const h = makeCtx({ acquired: false, statePrefix: 'cdkd' });
    h.ctx.lockManager.getLockInfo = vi.fn().mockResolvedValue(null);

    await expect(runDestroyForStack('TestStack', emptyState(), h.ctx)).rejects.toThrow(
      /Could not acquire lock/
    );
    const thrown = await runDestroyForStack('TestStack', emptyState(), h.ctx).catch(
      (e: Error) => e.message
    );
    expect(thrown).not.toContain('--state-prefix');
  });

  it('releases the lock even when the delete itself fails', async () => {
    const h = makeCtx({ acquired: true, recheck: null });
    h.deleteState.mockRejectedValue(new Error('S3 down'));

    await expect(runDestroyForStack('TestStack', emptyState(), h.ctx)).rejects.toThrow('S3 down');
    expect(h.releaseLock).toHaveBeenCalledWith('TestStack', REGION);
  });
});
