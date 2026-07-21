import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createContainerPool,
  type ContainerSpec,
} from '../../../src/local/container-pool.js';
import type { ResolvedZipLambda } from '../../../src/local/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * Coverage for the dispose-while-in-flight contract added in the PR
 * 8c review fix-back: `pool.dispose()` must AWAIT every in-flight
 * `inUse` handle's release before tearing down the underlying
 * container. Pre-fix, dispose() immediately read inUse and called
 * `removeContainer`, which:
 *
 *   1. Killed the request mid-`invokeRie` (502 leak).
 *   2. Caused the request's `release()` from its `finally` to run
 *      AFTER `entries.clear()` and corrupt the empty entries map.
 *
 * The fixes (drainResolvers + disposed flag in `release()`) are tested
 * here against a fake docker-runner so we don't need real Docker.
 */

// Mock docker-runner BEFORE importing container-pool so the spies are
// installed when the pool's module-load `import { runDetached, ...}`
// runs.
const mocks = vi.hoisted(() => {
  return {
    runDetached: vi.fn(async (_args: unknown): Promise<string> => {
      return `cid-${Math.floor(Math.random() * 1_000_000)}`;
    }),
    removeContainer: vi.fn(async (_id: string): Promise<void> => undefined),
    pickFreePort: vi.fn(async (): Promise<number> => 18000 + Math.floor(Math.random() * 1000)),
    streamLogs: vi.fn((_id: string) => () => undefined),
  };
});

vi.mock('../../../src/local/docker-runner.js', () => mocks);

vi.mock('../../../src/local/rie-client.js', () => ({
  waitForRieReady: vi.fn(async (): Promise<void> => undefined),
}));

function fakeSpec(logicalId: string): ContainerSpec {
  return {
    kind: 'zip',
    lambda: {
      kind: 'zip',
      stack: {} as unknown as StackInfo,
      logicalId,
      resource: {} as never,
      runtime: 'nodejs20.x',
      handler: 'index.handler',
      memoryMb: 128,
      timeoutSec: 3,
      codePath: '/tmp/code',
      layers: [],
      architecture: 'x86_64',
    } as ResolvedZipLambda,
    codeDir: '/tmp/code',
    platform: 'linux/amd64',
    env: {},
    containerHost: '127.0.0.1',
  };
}

describe('ContainerPool dispose() in-flight handling', () => {
  beforeEach(() => {
    mocks.runDetached.mockClear();
    mocks.removeContainer.mockClear();
    mocks.pickFreePort.mockClear();
    mocks.streamLogs.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the in-flight handle to release before tearing down the container', async () => {
    const specs = new Map([['L', fakeSpec('L')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });

    // Fire one acquire — pool size 1, so this is the only handle.
    const handle = await pool.acquire('L');
    expect(mocks.runDetached).toHaveBeenCalledTimes(1);
    expect(mocks.removeContainer).not.toHaveBeenCalled();

    // Kick off dispose(); it must not resolve until release() runs.
    let disposeResolved = false;
    const disposePromise = pool.dispose().then(() => {
      disposeResolved = true;
    });

    // Microtask flush — dispose() should not have resolved yet.
    await new Promise((r) => setImmediate(r));
    expect(disposeResolved).toBe(false);
    expect(mocks.removeContainer).not.toHaveBeenCalled();

    // Now release the handle. dispose() should now flow through
    // teardown.
    pool.release(handle);
    await disposePromise;
    expect(disposeResolved).toBe(true);
    expect(mocks.removeContainer).toHaveBeenCalledTimes(1);
  });

  it('release() after dispose() does not corrupt entries / re-arm the idle timer', async () => {
    const specs = new Map([['L', fakeSpec('L')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });

    const handle = await pool.acquire('L');

    // Kick off dispose() and wait one microtask so it has a chance to
    // start waiting on the drainResolver.
    const disposePromise = pool.dispose();
    await new Promise((r) => setImmediate(r));

    // Release the handle from the request's "finally" block. dispose()
    // resolves and tears down. The entries map is then cleared. A
    // hypothetical SECOND release() (defensive — shouldn't happen but
    // could in a test bug) must NOT throw or corrupt anything.
    pool.release(handle);
    await disposePromise;

    expect(() => pool.release(handle)).not.toThrow();
    expect(mocks.removeContainer).toHaveBeenCalledTimes(1);
  });

  it('idempotent: dispose() called twice is a no-op on the second call', async () => {
    const specs = new Map([['L', fakeSpec('L')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const handle = await pool.acquire('L');
    pool.release(handle);
    await pool.dispose();
    expect(mocks.removeContainer).toHaveBeenCalledTimes(1);
    // Second call should not re-tear-down.
    await pool.dispose();
    expect(mocks.removeContainer).toHaveBeenCalledTimes(1);
  });

  it('handles dispose() with no in-flight handles cleanly (warm-only path)', async () => {
    const specs = new Map([['L', fakeSpec('L')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const handle = await pool.acquire('L');
    pool.release(handle);
    // Now warm only.
    await pool.dispose();
    expect(mocks.removeContainer).toHaveBeenCalledTimes(1);
  });
});
