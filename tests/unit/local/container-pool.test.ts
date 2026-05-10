import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContainerPool, type ContainerSpec } from '../../../src/local/container-pool.js';
import type { ResolvedLambda } from '../../../src/local/lambda-resolver.js';

vi.mock('../../../src/local/docker-runner.js', () => {
  let counter = 0;
  return {
    pickFreePort: vi.fn(async () => {
      counter += 1;
      return 30000 + counter;
    }),
    runDetached: vi.fn(async (opts: { name?: string }) => `container-${opts.name}`),
    streamLogs: vi.fn(() => () => undefined),
    removeContainer: vi.fn(async () => undefined),
  };
});

vi.mock('../../../src/local/rie-client.js', () => ({
  waitForRieReady: vi.fn(async () => undefined),
}));

vi.mock('../../../src/local/runtime-image.js', () => ({
  resolveRuntimeImage: vi.fn(() => 'public.ecr.aws/lambda/nodejs:20'),
}));

import { removeContainer, runDetached } from '../../../src/local/docker-runner.js';

function makeSpec(logicalId: string): ContainerSpec {
  const lambda = {
    stack: { stackName: 'S', displayName: 'S', artifactId: 'S', template: { Resources: {} }, dependencyNames: [] },
    logicalId,
    resource: { Type: 'AWS::Lambda::Function', Properties: {} },
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    memoryMb: 128,
    timeoutSec: 3,
    codePath: '/tmp/code',
    inlineCode: undefined,
  } as unknown as ResolvedLambda;
  return {
    lambda,
    codeDir: '/tmp/code',
    env: {},
    containerHost: '127.0.0.1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('container-pool — basic acquire / release', () => {
  it('lazy-starts a container on first acquire, reuses it on the second', async () => {
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 2, streamLogs: false });
    const h1 = await pool.acquire('Fn');
    expect(runDetached).toHaveBeenCalledTimes(1);
    pool.release(h1);
    const h2 = await pool.acquire('Fn');
    expect(runDetached).toHaveBeenCalledTimes(1); // reused
    expect(h2.containerId).toBe(h1.containerId);
    pool.release(h2);
    await pool.dispose();
  });

  it('grows up to the cap when concurrent acquires hit', async () => {
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 2, streamLogs: false });
    const [h1, h2] = await Promise.all([pool.acquire('Fn'), pool.acquire('Fn')]);
    expect(runDetached).toHaveBeenCalledTimes(2);
    expect(h1.containerId).not.toBe(h2.containerId);
    pool.release(h1);
    pool.release(h2);
    await pool.dispose();
  });

  it('queues acquire when at the cap and resolves on release', async () => {
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h1 = await pool.acquire('Fn');
    let resolved = false;
    const p = pool.acquire('Fn').then((h) => {
      resolved = true;
      return h;
    });
    // Give the queue a tick to register.
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);
    pool.release(h1);
    const h2 = await p;
    expect(h2.containerId).toBe(h1.containerId);
    pool.release(h2);
    await pool.dispose();
  });

  it('rejects unknown logicalId', async () => {
    const pool = createContainerPool(new Map(), { perLambdaConcurrency: 1, streamLogs: false });
    await expect(pool.acquire('Unknown')).rejects.toThrow(/no spec registered/);
    await pool.dispose();
  });
});

describe('container-pool — idle GC', () => {
  it('tears down idle handles after the configured idleMs', async () => {
    vi.useFakeTimers();
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, {
      perLambdaConcurrency: 1,
      idleMs: 1000,
      streamLogs: false,
    });
    const h1 = await pool.acquire('Fn');
    pool.release(h1);
    expect(removeContainer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    expect(removeContainer).toHaveBeenCalledTimes(1);
    await pool.dispose();
  });

  it('releases reset the idle timer', async () => {
    vi.useFakeTimers();
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, {
      perLambdaConcurrency: 1,
      idleMs: 1000,
      streamLogs: false,
    });
    const h = await pool.acquire('Fn');
    pool.release(h);
    await vi.advanceTimersByTimeAsync(500);
    const h2 = await pool.acquire('Fn');
    pool.release(h2);
    await vi.advanceTimersByTimeAsync(500);
    // Only 1s has elapsed since the second release; container still idle.
    expect(removeContainer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(removeContainer).toHaveBeenCalledTimes(1);
    await pool.dispose();
  });
});

describe('container-pool — dispose', () => {
  it('tears down warm + in-use handles and rejects pending waiters', async () => {
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h1 = await pool.acquire('Fn');
    const waiter = pool.acquire('Fn');
    await new Promise((r) => setImmediate(r));
    await pool.dispose();
    expect(removeContainer).toHaveBeenCalled();
    await expect(waiter).rejects.toThrow(/disposed while/);
    // The acquired handle is still the caller's reference but the pool
    // is gone — the caller doesn't release it after dispose, just exits.
    void h1;
  });

  it('tolerates removeContainer failures during dispose', async () => {
    (removeContainer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom')
    );
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    pool.release(h);
    await expect(pool.dispose()).resolves.toBeUndefined();
  });
});
