import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * Issue #1348 class, reached through a new door (#2053 / #1952 review round 3).
 *
 * `runDestroyForStack`'s `finally` used to remove its SIGINT handler FIRST and
 * release the stack lock LAST. `destroy.ts` / `state.ts` register no handler of
 * their own, so from that removal until the release resolved the command had NO
 * SIGINT handler while still holding the lock — and the provider-side interrupt
 * watch, armed by any DynamoDB / CustomResource / ELBv2 / CloudMap wait earlier
 * in the run, answers a Ctrl-C with a last-listener force-quit. The process
 * exited 130 and the release never ran: the lock sat for its full 30-minute TTL.
 * On `cdkd destroy --all` the watch stays armed across stacks, so every later
 * stack inherited it.
 *
 * The ordering is the fix and the ordering is what these pin. This file's twin
 * rule is already stated in the same source at the strong-ref refusal path:
 * "Release FIRST, remove the listener LAST: while the release round-trip is in
 * flight the handler stays armed."
 */

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

// Keep the import graph light: the runner only touches these on the
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
// ONE renderer object for the whole module, so a case can make `stop()` throw.
// The inline-factory form returns a fresh object per call, which no test can
// reach.
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
import { getLiveRenderer } from '../../../src/utils/live-renderer.js';
import { InterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const REGION = 'us-east-1';

/**
 * A logical id carrying the classifier's own needle.
 *
 * Not a contrived name: `HandleNotFoundException` is an ordinary thing to call
 * a construct, and the interrupt message interpolates it verbatim.
 */
const NEEDLE_LOGICAL_ID = 'HandleNotFoundException';

function makeState(logicalId: string): StackState {
  const resource: ResourceState = {
    physicalId: 'phys-id',
    resourceType: 'AWS::DynamoDB::Table',
    properties: {},
    attributes: {},
    dependencies: [],
  };
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: { [logicalId]: resource },
    outputs: {},
    lastModified: 1,
  };
}

function makeCtx(mockProviderDelete: ReturnType<typeof vi.fn>) {
  const saveState = vi.fn().mockResolvedValue('"etag"');
  const deleteState = vi.fn().mockResolvedValue(undefined);
  return {
    saveState,
    deleteState,
    ctx: {
      stateBackend: {
        saveState,
        deleteState,
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn(),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: mockProviderDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    },
  };
}

describe('runDestroyForStack releases the lock BEFORE unregistering its SIGINT handler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** SIGINT listeners present at the moment `releaseLock` was entered. */
  function ctxObservingRelease(): {
    ctx: ReturnType<typeof makeCtx>['ctx'];
    listenersDuringRelease: () => readonly unknown[];
    releaseLock: ReturnType<typeof vi.fn>;
  } {
    let observed: readonly unknown[] = [];
    const releaseLock = vi.fn().mockImplementation(() => {
      observed = [...process.listeners('SIGINT')];
      return Promise.resolve(undefined);
    });
    const base = makeCtx(vi.fn().mockResolvedValue(undefined));
    return {
      ctx: {
        ...base.ctx,
        lockManager: {
          acquireLock: vi.fn(),
          releaseLock,
        } as unknown as LockManager,
      },
      listenersDuringRelease: () => observed,
      releaseLock,
    };
  }

  it('keeps its handler armed for the whole release round-trip', async () => {
    // THE fence. Pre-fix `observed` was empty: the handler was already gone
    // while the lock was still held, which is the window a Ctrl-C force-quit
    // into and stranded the lock.
    const before = process.listeners('SIGINT');
    const { ctx, listenersDuringRelease, releaseLock } = ctxObservingRelease();

    await runDestroyForStack('TestStack', makeState('Table'), ctx);

    expect(releaseLock).toHaveBeenCalledOnce();
    const during = listenersDuringRelease();
    // Exactly one listener MORE than the harness started with — the runner's
    // own graceful handler, still registered.
    expect(during.length).toBe(before.length + 1);
  });

  it('...and removes it once the release has resolved', async () => {
    // The other half: keeping it armed must not mean leaking it. One leaked
    // handler per stack would also keep the shared interrupt watch from ever
    // being the last listener, silently disabling its force-quit.
    const before = process.listeners('SIGINT');
    const { ctx } = ctxObservingRelease();

    await runDestroyForStack('TestStack', makeState('Table'), ctx);

    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('removes it even when a RENDERER teardown throws, and still releases', async () => {
    // The nested `try` opens at `renderer.stop()`, not at the release.
    // `stop()` writes to stdout and can throw EPIPE on a closed pipe, and
    // covering only the release produced the exact double-badness the block's
    // own comment argues against: measured `threw=EPIPE releaseLock=0
    // leakedListeners=1` — lock stranded AND handler leaked.
    const before = process.listeners('SIGINT');
    const { ctx, releaseLock } = ctxObservingRelease();
    const renderer = getLiveRenderer() as unknown as { stop: ReturnType<typeof vi.fn> };
    renderer.stop.mockImplementationOnce(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });

    // The destroy itself SUCCEEDS: a teardown write failing after every delete
    // has landed is not a destroy failure, and turning it into one would fail a
    // run whose resources are all gone.
    await runDestroyForStack('TestStack', makeState('Table'), ctx);

    // Neither half may be sacrificed to the other. The enclosing `finally`
    // protects the listener; only the catch around `stop()` protects the lock.
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('reports interrupted=true when the Ctrl-C lands DURING the release', async () => {
    // THE round-4 regression, in the reviewer's own probe shape.
    //
    // `result.interrupted` is assigned once inside the `try`, after the level
    // loop. Keeping `sigintHandler` armed across the renderer teardown, the
    // state flush and the lock release — which is what fixed the stranded lock
    // — moved a whole class of signals to AFTER that read, so `draining` flipped
    // too late and the flag stayed false. `destroy.ts` reads exactly that flag
    // to decide whether to stop, and registers no SIGINT handler of its own, so
    // `--all` went on to delete the NEXT STACK after the user asked it to stop.
    //
    // Pre-round-4 the same signal hit the interrupt watch's force-quit and
    // exited 130: the lock was stranded, but stack B survived. Trading a
    // 30-minute TTL for a destroyed stack is the worse side of that trade,
    // which is why the re-sync at the end of the `finally` is not cosmetic.
    const base = makeCtx(vi.fn().mockResolvedValue(undefined));
    const ctx = {
      ...base.ctx,
      lockManager: {
        acquireLock: vi.fn(),
        releaseLock: vi.fn().mockImplementation(() => {
          // Fire only the runner's own handler — the one it still has armed at
          // this point — so the harness's SIGINT handling is untouched.
          for (const listener of process.listeners('SIGINT')) {
            (listener as unknown as () => void)();
          }
          return Promise.resolve(undefined);
        }),
      } as unknown as LockManager,
    };

    const result = await runDestroyForStack('TestStack', makeState('Table'), ctx);

    expect(result.interrupted).toBe(true);
  });

  it('INVERTED CONTROL — an uninterrupted destroy still reports interrupted=false', async () => {
    // `||=` only ever turns false into true, and this is what stops the re-sync
    // being a constant. Without it the case above passes with
    // `result.interrupted = true` hard-coded.
    const { ctx } = ctxObservingRelease();

    const result = await runDestroyForStack('TestStack', makeState('Table'), ctx);

    expect(result.interrupted).toBe(false);
  });

  it('removes it even when the release THROWS', async () => {
    // Without the inner `finally` a failing release leaks the handler, and the
    // leak is worse than the failure: it is per stack on a `--all` run.
    const before = process.listeners('SIGINT');
    const base = makeCtx(vi.fn().mockResolvedValue(undefined));
    const ctx = {
      ...base.ctx,
      lockManager: {
        acquireLock: vi.fn(),
        releaseLock: vi.fn().mockRejectedValue(new Error('S3 DeleteObject failed')),
      } as unknown as LockManager,
    };

    await expect(runDestroyForStack('TestStack', makeState('Table'), ctx)).rejects.toThrow(
      'S3 DeleteObject failed'
    );

    expect(process.listeners('SIGINT')).toEqual(before);
  });
});
