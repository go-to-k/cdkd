/**
 * The stack-lock guard (go-to-k/cdkd#2174): the SIGINT + lock contract both
 * `destroy-runner.ts` sites used to implement by hand, now in one place.
 *
 * Each case pins one of the five rules the module doc lists, driven through
 * the REAL `process` listener list so a leak or a premature removal is visible
 * as a listener count rather than as a spy call the code could satisfy
 * without effect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});

import { acquireStackLock, type StackLockOptions } from '../../../src/cli/commands/stack-lock-guard.js';

const REGION = 'us-east-1';

function makeLockManager(acquired: boolean | Error = true) {
  return {
    acquireLock: vi.fn(async () => {
      if (acquired instanceof Error) throw acquired;
      return acquired;
    }),
    releaseLock: vi.fn(async () => undefined),
    getLockInfo: vi.fn(async () => null),
  };
}

function opts(
  lockManager: ReturnType<typeof makeLockManager>,
  extra: Partial<StackLockOptions> = {}
): StackLockOptions {
  return {
    lockManager,
    stackName: 'TestStack',
    region: REGION,
    operation: 'destroy',
    recovery: { stateBucket: 'test-bucket' },
    onFirstSignal: vi.fn(),
    ...extra,
  };
}

/** The handler the guard added — the one listener not present before. */
function newListener(before: readonly unknown[]): () => void {
  const added = process.listeners('SIGINT').filter((l) => !before.includes(l));
  expect(added, 'expected exactly one guard listener').toHaveLength(1);
  return added[0] as () => void;
}

describe('acquireStackLock (go-to-k/cdkd#2174)', () => {
  let before: readonly unknown[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderr: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy.mockReset();
    before = [...process.listeners('SIGINT')];
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    stderr = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    // A failing case must not leak a guard listener into the next one.
    for (const l of process.listeners('SIGINT')) {
      if (!before.includes(l)) process.removeListener('SIGINT', l as () => void);
    }
  });

  it('rule 1: the handler is armed BEFORE the acquire runs', async () => {
    const lm = makeLockManager();
    let armedDuringAcquire = 0;
    lm.acquireLock.mockImplementation(async () => {
      armedDuringAcquire = process.listeners('SIGINT').length - before.length;
      return true;
    });

    const onAcquireFailure = vi.fn();
    // A non-default operation proves the option is passed through.
    const lock = await acquireStackLock(
      opts(lm, { operation: 'state-destroy', onAcquireFailure })
    );
    await lock.release({ failureMessage: 'x' });

    expect(armedDuringAcquire).toBe(1);
    // The failure hook is the failure arm's alone: a successful acquire must
    // not restore the caller's cross-region globals out from under it.
    expect(onAcquireFailure).not.toHaveBeenCalled();
    expect(lm.acquireLock).toHaveBeenCalledWith('TestStack', REGION, undefined, 'state-destroy');
  });

  it('rule 2: the FIRST signal records and notifies, it does not exit', async () => {
    const lm = makeLockManager();
    const o = opts(lm);
    const lock = await acquireStackLock(o);

    expect(lock.interrupted).toBe(false);
    newListener(before)();

    expect(lock.interrupted).toBe(true);
    expect(o.onFirstSignal).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(lm.releaseLock).not.toHaveBeenCalled();
    await lock.release({ failureMessage: 'x' });
  });

  it('rule 2: the SECOND signal force-quits with a best-effort release and the recovery command', async () => {
    const lm = makeLockManager();
    const lock = await acquireStackLock(opts(lm));
    const handler = newListener(before);

    handler();
    handler();

    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(lm.releaseLock).toHaveBeenCalledWith('TestStack', REGION);
    const text = stderr.join('');
    expect(text).toContain('Force-quit: stack lock may not be released.');
    expect(text).toContain('cdkd force-unlock TestStack');
    expect(text).toContain(REGION);
    // The recovery context reaches the clause, not just the name and region.
    expect(text).toContain('--state-bucket test-bucket');
    await lock.release({ failureMessage: 'x' });
  });

  it('a first-signal notice that THROWS is swallowed, and the interrupt still counts', async () => {
    const lm = makeLockManager();
    const lock = await acquireStackLock(
      opts(lm, {
        onFirstSignal: () => {
          throw new Error('EPIPE');
        },
      })
    );

    expect(() => newListener(before)()).not.toThrow();
    expect(lock.interrupted).toBe(true);
    await lock.release({ failureMessage: 'x' });
  });

  it('rule 3: a force-quit BEFORE the acquire resolves does not touch the (possibly foreign) lock', async () => {
    const lm = makeLockManager();
    lm.acquireLock.mockImplementation(async () => {
      const handler = newListener(before);
      handler();
      handler();
      return true;
    });

    const lock = await acquireStackLock(opts(lm));

    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(lm.releaseLock).not.toHaveBeenCalled();
    expect(stderr.join('')).not.toContain('Force-quit');
    // The interrupt that landed during the acquire is still reported.
    expect(lock.interrupted).toBe(true);
    await lock.release({ failureMessage: 'x' });
  });

  it('rule 3: a force-quit AFTER the release does not fire a second, owner-blind release', async () => {
    const lm = makeLockManager();
    const lock = await acquireStackLock(opts(lm));
    const handler = newListener(before);
    await lock.release({ failureMessage: 'x' });
    expect(lm.releaseLock).toHaveBeenCalledOnce();

    // Invoked directly: it is no longer registered, which is the point of
    // rule 5, so this models a signal that raced the removal.
    handler();
    handler();

    expect(lm.releaseLock).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('rule 4: contention (`false`) throws the contention message and removes the listener', async () => {
    const lm = makeLockManager(false);
    const onAcquireFailure = vi.fn();

    await expect(acquireStackLock(opts(lm, { onAcquireFailure }))).rejects.toThrow(
      /Could not acquire lock/
    );

    expect(process.listeners('SIGINT')).toEqual(before);
    expect(onAcquireFailure).toHaveBeenCalledOnce();
    expect(lm.releaseLock).not.toHaveBeenCalled();
  });

  it('rule 4: an acquire THROW removes the listener and propagates the error unchanged', async () => {
    const lm = makeLockManager(new Error('S3 unavailable'));
    const onAcquireFailure = vi.fn();

    await expect(acquireStackLock(opts(lm, { onAcquireFailure }))).rejects.toThrow(
      'S3 unavailable'
    );

    expect(process.listeners('SIGINT')).toEqual(before);
    expect(onAcquireFailure).toHaveBeenCalledOnce();
    expect(lm.releaseLock).not.toHaveBeenCalled();
  });

  it('rule 4: a throwing `beforeAcquire` is an acquire failure — no acquire, listener removed', async () => {
    const lm = makeLockManager();
    const onAcquireFailure = vi.fn();
    let armedInHook = -1;

    await expect(
      acquireStackLock(
        opts(lm, {
          beforeAcquire: () => {
            armedInHook = process.listeners('SIGINT').length - before.length;
            throw new Error('EPIPE');
          },
          onAcquireFailure,
        })
      )
    ).rejects.toThrow('EPIPE');

    // The hook runs ARMED: a Ctrl-C during its (stdout-writing) log line is
    // the guard's to answer, not the bare process default.
    expect(armedInHook).toBe(1);
    expect(lm.acquireLock).not.toHaveBeenCalled();
    expect(onAcquireFailure).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('rule 4: `onAcquireFailure` runs while the listener is still registered, and a throw in it still removes it', async () => {
    const lm = makeLockManager(false);
    let armedInHook = 0;

    await expect(
      acquireStackLock(
        opts(lm, {
          onAcquireFailure: () => {
            armedInHook = process.listeners('SIGINT').length - before.length;
            throw new Error('restore failed');
          },
        })
      )
    ).rejects.toThrow('restore failed');

    expect(armedInHook).toBe(1);
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('rule 5: the handler stays armed for the whole release round-trip, then is removed', async () => {
    const lm = makeLockManager();
    let armedDuringRelease = 0;
    lm.releaseLock.mockImplementation(async () => {
      armedDuringRelease = process.listeners('SIGINT').length - before.length;
    });
    const lock = await acquireStackLock(opts(lm));

    await lock.release({ failureMessage: 'x' });

    expect(armedDuringRelease).toBe(1);
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('a FAILING release warns with the caller prefix, never throws, and still removes the listener', async () => {
    const lm = makeLockManager();
    lm.releaseLock.mockRejectedValue(new Error('SlowDown'));
    const lock = await acquireStackLock(opts(lm));

    await expect(
      lock.release({ failureMessage: 'Failed to release lock after X' })
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0]![0])).toMatch(/^Failed to release lock after X: .*SlowDown/);
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('a release failure carrying terminal control bytes is warned neutralized', async () => {
    const lm = makeLockManager();
    lm.releaseLock.mockRejectedValue(new Error('SlowDown\u001b[2J\nforged line'));
    const lock = await acquireStackLock(opts(lm));

    await lock.release({ failureMessage: 'Failed to release lock after X' });

    const warned = String(warnSpy.mock.calls[0]![0]);
    expect(warned).toMatch(/^Failed to release lock after X: .*SlowDown/);
    expect(warned).not.toContain('\u001b');
    expect(warned).not.toContain('\n');
  });

  it('`beforeRelease` runs armed and before the release; a throw in it skips the release but not the removal', async () => {
    const lm = makeLockManager();
    const order: string[] = [];
    lm.releaseLock.mockImplementation(async () => {
      order.push('release');
    });
    const lock = await acquireStackLock(opts(lm));

    await lock.release({
      failureMessage: 'x',
      beforeRelease: () => {
        order.push(`before:${process.listeners('SIGINT').length - before.length}`);
      },
    });
    expect(order).toEqual(['before:1', 'release']);

    const lm2 = makeLockManager();
    const lock2 = await acquireStackLock(opts(lm2));
    await expect(
      lock2.release({
        failureMessage: 'x',
        beforeRelease: () => {
          throw new Error('EPIPE');
        },
      })
    ).rejects.toThrow('EPIPE');
    expect(lm2.releaseLock).not.toHaveBeenCalled();
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('release() is idempotent: a second call issues no second release', async () => {
    const lm = makeLockManager();
    const lock = await acquireStackLock(opts(lm));

    await lock.release({ failureMessage: 'x' });
    await lock.release({ failureMessage: 'x' });

    expect(lm.releaseLock).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(before);
  });

  it('raises the listener ceiling to at least 100 and never lowers it', async () => {
    const original = process.getMaxListeners();
    try {
      process.setMaxListeners(10);
      const lock = await acquireStackLock(opts(makeLockManager()));
      await lock.release({ failureMessage: 'x' });
      expect(process.getMaxListeners()).toBe(100);

      process.setMaxListeners(500);
      const lock2 = await acquireStackLock(opts(makeLockManager()));
      await lock2.release({ failureMessage: 'x' });
      expect(process.getMaxListeners()).toBe(500);
    } finally {
      process.setMaxListeners(original);
    }
  });
});
