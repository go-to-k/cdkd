import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  IN_FLIGHT_START_TIMEOUT_MS,
  createContainerPool,
  type ContainerSpec,
  type ImageContainerSpec,
  type ZipContainerSpec,
} from '../../../src/local/container-pool.js';
import type { ResolvedZipLambda } from '../../../src/local/lambda-resolver.js';

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
  resolveRuntimeCodeMountPath: vi.fn(() => '/var/task'),
}));

import { removeContainer, runDetached, streamLogs } from '../../../src/local/docker-runner.js';
import { waitForRieReady } from '../../../src/local/rie-client.js';

function makeSpec(logicalId: string): ZipContainerSpec {
  const lambda = {
    kind: 'zip',
    stack: {
      stackName: 'S',
      displayName: 'S',
      artifactId: 'S',
      template: { Resources: {} },
      dependencyNames: [],
    },
    logicalId,
    resource: { Type: 'AWS::Lambda::Function', Properties: {} },
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    memoryMb: 128,
    timeoutSec: 3,
    codePath: '/tmp/code',
  } as unknown as ResolvedZipLambda;
  return {
    kind: 'zip',
    lambda,
    codeDir: '/tmp/code',
    platform: 'linux/arm64',
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

  // Issue #768: the ZIP container must be launched with the spec's
  // `--platform` so a `provided.*` cross-arch `bootstrap` runs under
  // emulation instead of failing with `exec format error`. Before the
  // fix the ZIP `runDetached` call omitted `platform` entirely.
  it('threads the ZIP spec platform into docker run (issue #768)', async () => {
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    expect(runDetached).toHaveBeenCalledWith(expect.objectContaining({ platform: 'linux/arm64' }));
    pool.release(h);
    await pool.dispose();
  });

  // Issue #2056: a resolved `{{resolve:...}}` env value is marked sensitive
  // on the spec; the pool must hand that set to `runDetached` on BOTH
  // branches, which is what renders it as a value-less `-e KEY`.
  it('threads the spec sensitiveEnvKeys into docker run, ZIP and IMAGE (issue #2056)', async () => {
    const keys = new Set(['DB_PASSWORD']);
    const zip = { ...makeSpec('Zip'), sensitiveEnvKeys: keys };
    const image: ImageContainerSpec = {
      kind: 'image',
      lambda: makeSpec('Img').lambda as unknown as ImageContainerSpec['lambda'],
      image: 'local/img:tag',
      platform: 'linux/amd64',
      command: [],
      env: {},
      containerHost: '127.0.0.1',
      sensitiveEnvKeys: keys,
    };
    const specs = new Map<string, ZipContainerSpec | ImageContainerSpec>([
      ['Zip', zip],
      ['Img', image],
    ]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const a = await pool.acquire('Zip');
    const b = await pool.acquire('Img');
    const calls = (runDetached as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { sensitiveEnvKeys?: ReadonlySet<string> }).sensitiveEnvKeys
    );
    expect(calls).toEqual([keys, keys]);
    pool.release(a);
    pool.release(b);
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
    // Per the PR-review fix, dispose() AWAITS in-flight handles before
    // tearing down. The waiter is rejected up front (no in-flight
    // request to wait on); the in-use handle h1 must release before
    // dispose resolves. We start dispose, observe the waiter's
    // rejection, then release h1 to complete the drain.
    const disposePromise = pool.dispose();
    await expect(waiter).rejects.toThrow(/disposed while/);
    pool.release(h1);
    await disposePromise;
    expect(removeContainer).toHaveBeenCalled();
  });

  it('tolerates removeContainer failures during dispose', async () => {
    (removeContainer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    pool.release(h);
    await expect(pool.dispose()).resolves.toBeUndefined();
  });

  it('awaits in-flight startOne and tears down its handle when dispose races a cold start', async () => {
    // Hold waitForRieReady on a manually-controlled gate so dispose
    // races startOne mid-flight. Without the inFlightStarts guard the
    // resulting container handle would be dropped on the floor and
    // leaked; with it, the handle reaches the teardown set and
    // removeContainer is called.
    let releaseRieGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseRieGate = r;
    });
    (waitForRieReady as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate;
    });
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const acquirePromise = pool.acquire('Fn');
    // Let startOne reach `await waitForRieReady`.
    await new Promise((r) => setImmediate(r));

    const disposePromise = pool.dispose();
    // Without releasing the gate, dispose should hang on the in-flight
    // wait; release it now so dispose can drain and tear down.
    releaseRieGate();
    await disposePromise;

    // The pre-fix bug: the resolved acquire result is dropped because
    // entries was already cleared. We still expect the handle to have
    // been torn down by dispose, i.e. removeContainer fired for it.
    expect(removeContainer).toHaveBeenCalled();
    // The original acquire promise should still resolve (or reject) —
    // not hang. We don't care about the outcome shape; we just don't
    // want a permanently-pending promise.
    await Promise.race([
      acquirePromise.catch(() => undefined),
      new Promise((_, reject) => setTimeout(() => reject(new Error('acquire hung')), 1000)),
    ]);
  });

  it('logs and skips when an in-flight startOne rejects during dispose', async () => {
    let rejectRieReady!: (err: Error) => void;
    (waitForRieReady as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectRieReady = reject;
        })
    );
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const acquirePromise = pool.acquire('Fn');
    await new Promise((r) => setImmediate(r));

    const disposePromise = pool.dispose();
    rejectRieReady(new Error('RIE never started'));
    await disposePromise;
    // The acquire surfaces the RIE failure; it must not hang.
    await expect(acquirePromise).rejects.toThrow();
  });
});

/**
 * Issue #4495: `cdkd local start-api`'s ^C cleanup, and a `--watch` reload's
 * background dispose of the previous pool, end in `process.exit` once
 * `dispose()` resolves. Every container a start began must be gone by then.
 */
describe('container-pool — dispose while a start is in flight (issue #4495)', () => {
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  it("during the start's docker run: dispose waits for it and removes the container", async () => {
    let finishRun!: (id: string) => void;
    (runDetached as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<string>((r) => {
          finishRun = r;
        })
    );
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const acquired = pool.acquire('Fn').then(
      () => 'resolved',
      (err: unknown) => String(err)
    );
    await tick();
    expect(runDetached).toHaveBeenCalledTimes(1);

    let disposed = false;
    const disposePromise = pool.dispose().then(() => {
      disposed = true;
    });
    await tick();
    expect(disposed).toBe(false);

    finishRun('container-held');
    await disposePromise;
    expect(removeContainer).toHaveBeenCalledWith('container-held');
    // It went no further than the docker run.
    expect(waitForRieReady).not.toHaveBeenCalled();
    expect(await acquired).toContain('disposed while Fn was starting');
  });

  it('during the RIE readiness wait: dispose does not wait the wait out, and removes the container', async () => {
    (waitForRieReady as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>(() => {})
    );
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const acquired = pool.acquire('Fn').catch((err: unknown) => String(err));
    await tick();
    expect(waitForRieReady).toHaveBeenCalledTimes(1);

    await pool.dispose();
    expect(removeContainer).toHaveBeenCalledWith('container-' + (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0].name);
    expect(await acquired).toContain('disposed while Fn was starting');
  });

  it('a docker run that never returns: dispose gives up after the bound and removes the container by its --name', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    (runDetached as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>(() => {})
    );
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    void pool.acquire('Fn').catch(() => undefined);
    await tick();
    const name = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0].name as string;

    const warned: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((msg: unknown) => {
      warned.push(String(msg));
    });
    try {
      let disposed = false;
      const disposePromise = pool.dispose().then(() => {
        disposed = true;
      });
      await vi.advanceTimersByTimeAsync(IN_FLIGHT_START_TIMEOUT_MS - 1);
      expect(disposed).toBe(false);
      expect(removeContainer).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await disposePromise;
      expect(removeContainer).toHaveBeenCalledWith(name);
    } finally {
      warnSpy.mockRestore();
    }
    // The removal may have run before docker created the container, and the
    // `docker run` still pending can start it later: the warning says so,
    // names the container and gives the command that removes it.
    const line = warned.find((w) => w.includes('still pending'));
    expect(line, JSON.stringify(warned)).toBeDefined();
    expect(line).toContain(`removed container '${name}' if it existed`);
    expect(line).toContain('can still start it');
    expect(line).toContain(`run 'docker rm -f ${name}' if it appears`);
  });

  it('a docker run that FAILS once dispose began: its container is removed by --name', async () => {
    let failRun!: (err: Error) => void;
    (runDetached as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<string>((_, reject) => {
          failRun = reject;
        })
    );
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    void pool.acquire('Fn').catch(() => undefined);
    await tick();
    const name = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]![0].name as string;
    const disposePromise = pool.dispose();
    failRun(new Error('context canceled'));
    await disposePromise;
    expect(removeContainer).toHaveBeenCalledWith(name);
  });

  it('a docker run that fails with no dispose removes nothing by name', async () => {
    (runDetached as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    await expect(pool.acquire('Fn')).rejects.toThrow(/boom/);
    expect(removeContainer).not.toHaveBeenCalled();
    await pool.dispose();
  });

  it("the in-flight start's bound runs alongside the request drain, not after it", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 2, streamLogs: false });
    // One request holds a container and never releases it.
    await pool.acquire('Fn');
    // A second request's start hangs in `docker run`.
    (runDetached as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>(() => {})
    );
    void pool.acquire('Fn').catch(() => undefined);
    await tick();
    const name = (runDetached as ReturnType<typeof vi.fn>).mock.calls[1]![0].name as string;

    const disposePromise = pool.dispose();
    await vi.advanceTimersByTimeAsync(IN_FLIGHT_START_TIMEOUT_MS);
    // Still inside the 30s request drain, the hung start is already removed.
    expect(removeContainer).toHaveBeenCalledWith(name);
    await vi.advanceTimersByTimeAsync(30_000);
    await disposePromise;
  });

  it('a second dispose() waits for the first one to finish tearing down', async () => {
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    // The first dispose waits for the in-use handle to drain.
    const first = pool.dispose();
    let secondDone = false;
    const second = pool.dispose().then(() => {
      secondDone = true;
    });
    await tick();
    expect(secondDone).toBe(false);
    expect(removeContainer).not.toHaveBeenCalled();

    pool.release(h);
    await Promise.all([first, second]);
    expect(removeContainer).toHaveBeenCalledWith(h.containerId);
    expect(removeContainer).toHaveBeenCalledTimes(1);
  });

  it('starts no container once dispose() began', async () => {
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 2, streamLogs: false });
    const h = await pool.acquire('Fn');
    // The dispose is still draining `h` when a request asks for a second one.
    const disposePromise = pool.dispose();
    await expect(pool.acquire('Fn')).rejects.toThrow(/disposed while Fn was starting/);
    expect(runDetached).toHaveBeenCalledTimes(1);
    pool.release(h);
    await disposePromise;
  });

  it('with no dispose, a completed start is handed out and not removed', async () => {
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });
    const h = await pool.acquire('Fn');
    expect(h.containerId).toBeTruthy();
    expect(removeContainer).not.toHaveBeenCalled();
    pool.release(h);
    await pool.dispose();
  });
});

describe('container-pool — startOne RIE-readiness failure cleanup', () => {
  it('cleans up streamLogs + container when waitForRieReady rejects', async () => {
    const stopFn = vi.fn();
    (streamLogs as ReturnType<typeof vi.fn>).mockReturnValueOnce(stopFn);
    (waitForRieReady as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('RIE failed to come up')
    );
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: true });

    await expect(pool.acquire('Fn')).rejects.toThrow(/RIE failed to come up/);
    expect(stopFn).toHaveBeenCalledTimes(1);
    expect(removeContainer).toHaveBeenCalledTimes(1);

    // After the failure, a subsequent acquire on the same logical ID
    // should proceed (mutex was released, no deadlock).
    const h = await pool.acquire('Fn');
    expect(h.containerId).toBeTruthy();
    pool.release(h);
    await pool.dispose();
  });
});

describe('container-pool — withMutex error propagation', () => {
  it('releases the mutex when startOne throws so a follow-up acquire succeeds', async () => {
    (runDetached as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('docker run boom'));
    const specs = new Map([['Fn', makeSpec('Fn')]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });

    await expect(pool.acquire('Fn')).rejects.toThrow(/docker run boom/);

    // The mutex must have been released; otherwise this second acquire
    // would deadlock waiting for the previous body to settle.
    const h = await pool.acquire('Fn');
    expect(h.containerId).toBeTruthy();
    pool.release(h);
    await pool.dispose();
  });
});

describe('container-pool — ContainerSpec.optDir propagation (PR 6 of #224, issue #232)', () => {
  // The Layer-merge / bind-mount path lives in `local-start-api.ts`'s
  // `materializeLambdaLayers(...)` (resolved once at server boot), and
  // the resulting host path rides on `ContainerSpec.optDir`. The pool's
  // `startOne` must thread that path into `runDetached(extraMounts)`
  // verbatim — this test guards the wire contract so a refactor in
  // `container-pool.ts` doesn't drop the field on the floor and silently
  // disable layers for `cdkd local start-api`.
  it('emits {hostPath: optDir, containerPath: /opt, readOnly: true} as extraMounts when optDir is set', async () => {
    const spec = makeSpec('LayeredFn');
    spec.optDir = '/tmp/cdkd-merged-layers-abc';
    const specs = new Map([['LayeredFn', spec]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });

    const h = await pool.acquire('LayeredFn');

    expect(runDetached).toHaveBeenCalledTimes(1);
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      extraMounts?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
    };
    expect(callArg.extraMounts).toEqual([
      { hostPath: '/tmp/cdkd-merged-layers-abc', containerPath: '/opt', readOnly: true },
    ]);

    pool.release(h);
    await pool.dispose();
  });

  it('emits empty extraMounts when optDir is undefined (no layers configured)', async () => {
    const spec = makeSpec('NoLayerFn');
    // Spec.optDir intentionally NOT set.
    const specs = new Map([['NoLayerFn', spec]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });

    const h = await pool.acquire('NoLayerFn');

    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      extraMounts?: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
    };
    expect(callArg.extraMounts).toEqual([]);

    pool.release(h);
    await pool.dispose();
  });
});

describe('container-pool — ContainerSpec.tmpfs propagation (issue #440)', () => {
  // `cdkd local start-api` resolves `Properties.EphemeralStorage.Size`
  // once at server boot in `buildContainerSpec` and stores it on
  // `ContainerSpec.tmpfs`. The pool's `startOne` MUST thread that into
  // `runDetached(tmpfs)` verbatim so every cold-started warm container
  // for that Lambda gets the same sized `/tmp` cap the deployed
  // function would have.
  it('threads ContainerSpec.tmpfs into runDetached(tmpfs)', async () => {
    const spec = makeSpec('SizedFn');
    spec.tmpfs = { target: '/tmp', sizeMb: 1024 };
    const specs = new Map([['SizedFn', spec]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });

    const h = await pool.acquire('SizedFn');

    expect(runDetached).toHaveBeenCalledTimes(1);
    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      tmpfs?: { target: string; sizeMb: number };
    };
    expect(callArg.tmpfs).toEqual({ target: '/tmp', sizeMb: 1024 });

    pool.release(h);
    await pool.dispose();
  });

  it('omits runDetached(tmpfs) when ContainerSpec.tmpfs is undefined', async () => {
    const spec = makeSpec('NoSizeFn');
    // spec.tmpfs intentionally NOT set.
    const specs = new Map([['NoSizeFn', spec]]);
    const pool = createContainerPool(specs, { perLambdaConcurrency: 1, streamLogs: false });

    const h = await pool.acquire('NoSizeFn');

    const callArg = (runDetached as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      tmpfs?: { target: string; sizeMb: number };
    };
    expect(callArg.tmpfs).toBeUndefined();

    pool.release(h);
    await pool.dispose();
  });
});
