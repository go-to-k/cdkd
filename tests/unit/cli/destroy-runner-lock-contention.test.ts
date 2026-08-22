import { describe, it, expect, vi } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * Regression fence for the discarded-`acquireLock`-return bug (issue #2161).
 *
 * `runDestroyForStack` used to call `LockManager.acquireLock(...)` and throw
 * away the boolean it returns. `acquireLock` returns `false` (it does NOT
 * throw) when a live, non-expired lock is already held by another owner, so a
 * `destroy` launched while another process (e.g. an in-flight `cdkd deploy`)
 * held the lock ran anyway — deleting resources out from under that process
 * AND releasing its lock through the normal owner-blind release path on the way
 * out.
 *
 * The fix checks the boolean and throws on `!acquired` (the fail-fast pattern
 * `cdkd export` already uses). These tests pin that: when `acquireLock` reports
 * contention by returning `false`, destroy must abort BEFORE any provider
 * delete, must NOT delete state, and — most importantly — must NOT release the
 * foreign lock.
 *
 * The mock makes `acquireLock` RESOLVE `false` (not reject), which is exactly
 * the shape the bug fed on: a test whose mock returned `undefined`/`false` and
 * asserted the delete still ran would keep passing against the reverted, buggy
 * source, which is the false green this fence exists to prevent.
 */

// A STABLE `info` spy, hoisted so a test can make it throw. The previous mock
// returned a fresh object per `getLogger()` call, so the captured instance was
// unreachable and the `logger.info` that issue #2170 moved inside the acquire
// `try` could be hoisted back out with the whole suite green.
const infoSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  // The cross-region path constructs a fresh ProviderRegistry and calls these
  // before the (never-reached) delete loop, so the mock must carry them.
  ProviderRegistry: vi.fn(() => ({
    setCustomResourceResponseBucket: vi.fn(),
    allowUnsupportedTypes: vi.fn(),
    getProviderFor: () => ({ provider: { delete: vi.fn() } }),
  })),
}));
// Shared, hoisted state so the vi.mock factory (hoisted above the file) can
// record every AwsClients instance's `destroy` spy and expose the
// `setAwsClients` spy for the cross-region restore assertions below.
const awsClientsMock = vi.hoisted(() => {
  const instances: Array<{ region?: string; destroy: ReturnType<typeof vi.fn> }> = [];
  return { instances, setAwsClients: vi.fn(), destroyThrows: false };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn((opts?: { region?: string }) => {
    const inst = {
      region: opts?.region,
      // A test can flip `destroyThrows` to prove a teardown failure is
      // swallowed rather than masking the real error / skipping cleanup.
      destroy: vi.fn(() => {
        if (awsClientsMock.destroyThrows) throw new Error('client destroy boom');
      }),
    };
    awsClientsMock.instances.push(inst);
    return inst;
  }),
  setAwsClients: awsClientsMock.setAwsClients,
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

import { beforeEach } from 'vite-plus/test';
import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import { getLiveRenderer } from '../../../src/utils/live-renderer.js';

const REGION = 'us-east-1';

function makeState(): StackState {
  const resource: ResourceState = {
    physicalId: 'phys-id',
    resourceType: 'AWS::SSM::Parameter',
    properties: {},
    attributes: {},
    dependencies: [],
  };
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: { Param: resource },
    outputs: {},
    lastModified: 1,
  };
}

function makeCtx(): {
  ctx: Parameters<typeof runDestroyForStack>[2];
  acquireLock: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
  deleteState: ReturnType<typeof vi.fn>;
  providerDelete: ReturnType<typeof vi.fn>;
} {
  // Contention: a live foreign lock is held, so `acquireLock` RESOLVES false.
  const acquireLock = vi.fn().mockResolvedValue(false);
  const releaseLock = vi.fn().mockResolvedValue(undefined);
  const deleteState = vi.fn().mockResolvedValue(undefined);
  const saveState = vi.fn().mockResolvedValue('"etag"');
  const providerDelete = vi.fn().mockResolvedValue(undefined);
  return {
    acquireLock,
    releaseLock,
    deleteState,
    providerDelete,
    ctx: {
      stateBackend: {
        saveState,
        deleteState,
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock,
        releaseLock,
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: providerDelete } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2],
  };
}

describe('runDestroyForStack refuses to proceed when another process holds the lock (issue #2161)', () => {
  it('rejects instead of deleting resources under contention', async () => {
    const { ctx, acquireLock, providerDelete } = makeCtx();

    await expect(runDestroyForStack('TestStack', makeState(), ctx)).rejects.toThrow(
      /Could not acquire lock/
    );

    expect(acquireLock).toHaveBeenCalledOnce();
    // The core of the bug: no resource may be deleted when the lock is held.
    expect(providerDelete).not.toHaveBeenCalled();
  });

  it('does NOT release the foreign lock and does NOT delete state', async () => {
    const { ctx, releaseLock, deleteState } = makeCtx();

    await expect(runDestroyForStack('TestStack', makeState(), ctx)).rejects.toThrow();

    // Releasing here would delete the lock the OTHER process holds — the
    // second half of the bug. `acquired` was false, so `lockHeld` was never
    // set and the release path must not run.
    expect(releaseLock).not.toHaveBeenCalled();
    expect(deleteState).not.toHaveBeenCalled();
  });
});

describe('a cross-region destroy restores region + clients when the lock is held (issue #2161)', () => {
  beforeEach(() => {
    awsClientsMock.instances.length = 0;
    awsClientsMock.setAwsClients.mockClear();
    awsClientsMock.destroyThrows = false;
    process.env['AWS_REGION'] = REGION;
    process.env['AWS_DEFAULT_REGION'] = REGION;
  });

  it('destroys the switched client, restores AWS_REGION + global clients, and removes the SIGINT listener', async () => {
    // A stack deployed to a DIFFERENT region than the CLI base: the runner
    // switches AWS_REGION + the global AwsClients before acquiring the lock.
    // The pre-#2161 code left those switched when the acquire path threw, so an
    // ordinary contention on a cross-region stack leaked region/clients into
    // the rest of a `--all` run.
    const stackRegion = 'us-west-2';
    const baseAwsClients = { marker: 'base' } as unknown as AwsClients;
    const { ctx } = makeCtx();
    const crossCtx = {
      ...ctx,
      baseRegion: REGION,
      baseAwsClients,
    } as unknown as Parameters<typeof runDestroyForStack>[2];
    const state = makeState();
    state.region = stackRegion;

    const before = process.listeners('SIGINT');

    await expect(runDestroyForStack('TestStack', state, crossCtx)).rejects.toThrow(
      /Could not acquire lock/
    );

    // The region-scoped client the runner built for the switch was destroyed.
    expect(awsClientsMock.instances).toHaveLength(1);
    expect(awsClientsMock.instances[0]!.region).toBe(stackRegion);
    expect(awsClientsMock.instances[0]!.destroy).toHaveBeenCalledOnce();

    // The process-global region + clients are back to the base.
    expect(process.env['AWS_REGION']).toBe(REGION);
    expect(process.env['AWS_DEFAULT_REGION']).toBe(REGION);
    // Last setAwsClients call restored the base clients (the first switched to
    // the region-scoped instance).
    expect(awsClientsMock.setAwsClients).toHaveBeenLastCalledWith(baseAwsClients);

    // The SIGINT handler the runner registered before the acquire was removed.
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('also restores region + clients when the lock-protected strong-ref scan fails (lock acquired)', async () => {
    // The strong-ref path's `releaseThenUnregister` is a SECOND exit before the
    // main finally: a cross-region destroy that acquires the lock but then the
    // lock-protected scan FAILS (or refuses) must restore region/clients there
    // too (issue #2161). The pre-flight scan (before the lock) passes; the
    // lock-protected scan (after the lock) throws.
    const stackRegion = 'us-west-2';
    const baseAwsClients = { marker: 'base' } as unknown as AwsClients;
    const acquireLock = vi.fn().mockResolvedValue(true); // lock IS acquired here
    const releaseLock = vi.fn().mockResolvedValue(undefined);
    const crossCtx = {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn(),
        getState: vi.fn(),
        // Pre-flight scan (before the lock) sees no consumers and passes; the
        // lock-protected scan (after the lock) fails, driving the refusal exit.
        listStacks: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockRejectedValueOnce(new Error('scan failed under the lock')),
      } as unknown as S3StateBackend,
      lockManager: { acquireLock, releaseLock } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: vi.fn() } }),
      } as unknown as ProviderRegistry,
      baseAwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2];
    // A producer state with an output → needsStrongRefCheck is true.
    const state = makeState();
    state.region = stackRegion;
    state.outputs = { X: 'export-value' };

    const before = process.listeners('SIGINT');

    await expect(runDestroyForStack('TestStack', state, crossCtx)).rejects.toThrow(
      /scan failed under the lock/
    );

    // The lock the runner DID hold is released (not a foreign lock — it is ours
    // here), and the region-scoped client + globals are restored.
    expect(releaseLock).toHaveBeenCalledWith('TestStack', stackRegion);
    expect(awsClientsMock.instances).toHaveLength(1);
    expect(awsClientsMock.instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(process.env['AWS_REGION']).toBe(REGION);
    expect(awsClientsMock.setAwsClients).toHaveBeenLastCalledWith(baseAwsClients);
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('restores region + clients when the cross-region SETUP itself throws (issue #2161)', async () => {
    // A throw while building the region-scoped clients / provider registry is
    // also before the main try/finally, so it must not leak the switched
    // region/clients either.
    const stackRegion = 'us-west-2';
    const baseAwsClients = { marker: 'base' } as unknown as AwsClients;
    (registerAllProviders as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('provider registration boom');
    });
    const { ctx } = makeCtx();
    const crossCtx = {
      ...ctx,
      baseRegion: REGION,
      baseAwsClients,
    } as unknown as Parameters<typeof runDestroyForStack>[2];
    const state = makeState();
    state.region = stackRegion;

    const before = process.listeners('SIGINT');

    await expect(runDestroyForStack('TestStack', state, crossCtx)).rejects.toThrow(
      /provider registration boom/
    );

    // Even though the failure was in setup (not the lock), the region-scoped
    // client is destroyed and the process globals are back to the base.
    expect(awsClientsMock.instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(process.env['AWS_REGION']).toBe(REGION);
    expect(awsClientsMock.setAwsClients).toHaveBeenLastCalledWith(baseAwsClients);
    // The SIGINT handler is only registered AFTER setup, so a setup failure
    // must leave the listener set exactly as it found it.
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('restores region + clients even when releaseLock REJECTS on the success path (issue #2161)', async () => {
    // The success-path restore runs in the main `finally`; a throwing
    // `releaseLock` there must not skip it and leak the switched region.
    const stackRegion = 'us-west-2';
    const baseAwsClients = { marker: 'base' } as unknown as AwsClients;
    const acquireLock = vi.fn().mockResolvedValue(true);
    const releaseLock = vi.fn().mockRejectedValue(new Error('S3 DeleteObject failed'));
    const crossCtx = {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn().mockResolvedValue(undefined),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: { acquireLock, releaseLock } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: vi.fn().mockResolvedValue(undefined) } }),
      } as unknown as ProviderRegistry,
      baseAwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2];
    const state = makeState(); // no outputs → strong-ref scan skipped, delete runs
    state.region = stackRegion;

    const before = process.listeners('SIGINT');

    // Issue #2168 made a failed release non-fatal here: `releaseLock` now
    // RAISES on failures it used to absorb, and letting one out of the main
    // `finally` would replace a real destroy error and abort a `--all` run
    // over a lock that lapses on its own. What this test fences is unchanged
    // and is asserted below -- the cross-region restore still happens on a
    // path where the release failed.
    await expect(runDestroyForStack('TestStack', state, crossCtx)).resolves.toBeDefined();
    expect(releaseLock).toHaveBeenCalledOnce();

    expect(awsClientsMock.instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(process.env['AWS_REGION']).toBe(REGION);
    expect(awsClientsMock.setAwsClients).toHaveBeenLastCalledWith(baseAwsClients);
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('swallows a throwing client destroy() — original error surfaces, cleanup still runs (issue #2161)', async () => {
    // A failing client teardown must not mask the real error nor skip the
    // SIGINT-listener removal / region restore.
    const stackRegion = 'us-west-2';
    const baseAwsClients = { marker: 'base' } as unknown as AwsClients;
    awsClientsMock.destroyThrows = true;
    const { ctx } = makeCtx(); // acquireLock resolves false
    const crossCtx = {
      ...ctx,
      baseRegion: REGION,
      baseAwsClients,
    } as unknown as Parameters<typeof runDestroyForStack>[2];
    const state = makeState();
    state.region = stackRegion;

    const before = process.listeners('SIGINT');

    // The ACQUIRE error surfaces, not the destroy error.
    await expect(runDestroyForStack('TestStack', state, crossCtx)).rejects.toThrow(
      /Could not acquire lock/
    );

    // Region restored (it runs before the throwing destroy), and the listener
    // is still removed despite the teardown throw.
    expect(process.env['AWS_REGION']).toBe(REGION);
    expect(awsClientsMock.setAwsClients).toHaveBeenLastCalledWith(baseAwsClients);
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('restores region + removes the listener when the Acquiring-lock log throws (issue #2170)', async () => {
    // PR #2165 moved `logger.info('Acquiring lock...')` INSIDE the acquire
    // `try` because it reaches `process.stdout.write` and can EPIPE
    // (`cdkd destroy | head`) — it sits after `regionSwitched = true` and after
    // the SIGINT registration, so a throw outside the `try` leaks both. That
    // move shipped UNFENCED (issue #2170 item 3): the logger mock returned a
    // fresh object per call, so nothing could make `info` throw and the move
    // was revertible with the whole suite green.
    //
    // The discriminator is the pair below — region restored AND listener gone.
    // Reverting the move (hoisting the log above the `try`) turns both red,
    // because the catch that performs them is never entered.
    const stackRegion = 'us-west-2';
    const baseAwsClients = { marker: 'base' } as unknown as AwsClients;
    const acquireLock = vi.fn().mockResolvedValue(true);
    const releaseLock = vi.fn().mockResolvedValue(undefined);
    const epipe = Object.assign(new Error('acquiring-lock log EPIPE'), { code: 'EPIPE' });
    infoSpy.mockImplementation((msg: unknown) => {
      // Only the Acquiring-lock line throws; every other info() must still
      // work, or the test would pass off an unrelated failure as this one.
      if (typeof msg === 'string' && msg.includes('Acquiring lock for stack')) throw epipe;
    });
    const crossCtx = {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn(),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: { acquireLock, releaseLock } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: vi.fn() } }),
      } as unknown as ProviderRegistry,
      baseAwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2];
    const state = makeState();
    state.region = stackRegion;

    const before = process.listeners('SIGINT');

    await expect(runDestroyForStack('TestStack', state, crossCtx)).rejects.toThrow(
      /acquiring-lock log EPIPE/
    );

    // The log throws BEFORE the acquire resolves, so no lock was ever taken —
    // releasing here would delete a lock this process does not own.
    expect(releaseLock).not.toHaveBeenCalled();
    // ...but the cross-region globals and the SIGINT listener, both claimed
    // before the log, must be given back.
    expect(process.env['AWS_REGION']).toBe(REGION);
    expect(awsClientsMock.setAwsClients).toHaveBeenLastCalledWith(baseAwsClients);
    expect(awsClientsMock.instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(before);

    infoSpy.mockReset();
  });

  it('releases the lock + restores region when renderer.start() throws AFTER the lock (issue #2161)', async () => {
    // `renderer.start()` writes to stdout and can EPIPE; it is the first
    // statement after `lockHeld = true`, so a throw must be caught by the main
    // finally (release lock + restore region + remove listener), not strand
    // them.
    const stackRegion = 'us-west-2';
    const baseAwsClients = { marker: 'base' } as unknown as AwsClients;
    const acquireLock = vi.fn().mockResolvedValue(true);
    const releaseLock = vi.fn().mockResolvedValue(undefined);
    const renderer = getLiveRenderer() as unknown as { start: ReturnType<typeof vi.fn> };
    renderer.start.mockImplementationOnce(() => {
      throw new Error('renderer start EPIPE');
    });
    const crossCtx = {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn(),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: { acquireLock, releaseLock } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: vi.fn() } }),
      } as unknown as ProviderRegistry,
      baseAwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
    } as unknown as Parameters<typeof runDestroyForStack>[2];
    const state = makeState();
    state.region = stackRegion;

    const before = process.listeners('SIGINT');

    await expect(runDestroyForStack('TestStack', state, crossCtx)).rejects.toThrow(
      /renderer start EPIPE/
    );

    // The lock the runner held is released (not stranded), region restored,
    // listener removed.
    expect(releaseLock).toHaveBeenCalledWith('TestStack', stackRegion);
    expect(process.env['AWS_REGION']).toBe(REGION);
    expect(awsClientsMock.setAwsClients).toHaveBeenLastCalledWith(baseAwsClients);
    expect(process.listeners('SIGINT')).toEqual(before);
  });
});
