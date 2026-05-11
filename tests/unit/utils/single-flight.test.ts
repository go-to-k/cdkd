import { describe, it, expect, vi } from 'vitest';
import { singleFlight } from '../../../src/utils/single-flight.js';

describe('singleFlight', () => {
  it('runs the wrapped function exactly once across repeated sequential calls', async () => {
    const inner = vi.fn(async () => {
      /* noop */
    });
    const wrapped = singleFlight(inner);

    await wrapped();
    await wrapped();
    await wrapped();

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers await the same in-flight promise (no parallel runs)', async () => {
    let resolveInner: (() => void) | undefined;
    let invocations = 0;
    const inner = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          invocations += 1;
          resolveInner = resolve;
        })
    );
    const wrapped = singleFlight(inner);

    // Fire 5 concurrent callers; the inner should only have started once.
    const promises = [wrapped(), wrapped(), wrapped(), wrapped(), wrapped()];
    expect(invocations).toBe(1);
    expect(inner).toHaveBeenCalledTimes(1);

    // Resolve the in-flight cleanup; every caller resolves together.
    resolveInner!();
    await Promise.all(promises);

    expect(invocations).toBe(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('post-completion calls still await the same finished promise (no re-run)', async () => {
    const inner = vi.fn(async () => {
      /* noop */
    });
    const wrapped = singleFlight(inner);

    // First batch: drain to completion.
    await wrapped();
    expect(inner).toHaveBeenCalledTimes(1);

    // Second batch: even though the prior promise has resolved, we do
    // NOT re-invoke the inner.
    await wrapped();
    await wrapped();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('swallows inner errors and routes them through the optional onError callback', async () => {
    const boom = new Error('cleanup blew up');
    const inner = vi.fn(async () => {
      throw boom;
    });
    const onError = vi.fn();
    const wrapped = singleFlight(inner, onError);

    // Returned promise resolves rather than rejecting (cleanup should
    // never mask a real handler error by bubbling out of itself).
    await expect(wrapped()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);

    // Subsequent callers see the same memoized resolution; the inner
    // does NOT run again and onError fires once total.
    await wrapped();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('omitted onError still swallows the throw without rejecting the returned promise', async () => {
    const inner = vi.fn(async () => {
      throw new Error('swallow me');
    });
    const wrapped = singleFlight(inner);

    // No onError — the throw is silently swallowed; this is the
    // intended behavior for cleanup paths where we never want
    // cleanup itself to mask a real handler error.
    await expect(wrapped()).resolves.toBeUndefined();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('shares the in-flight promise instance across callers (cleanupPromise identity check)', async () => {
    let resolveInner: (() => void) | undefined;
    const wrapped = singleFlight(
      () =>
        new Promise<void>((resolve) => {
          resolveInner = resolve;
        })
    );

    // Both callers should resolve at the same tick after the inner
    // resolves — they share the same underlying promise.
    const p1 = wrapped();
    const p2 = wrapped();

    let p1Resolved = false;
    let p2Resolved = false;
    void p1.then(() => {
      p1Resolved = true;
    });
    void p2.then(() => {
      p2Resolved = true;
    });

    // Microtask flush before resolving inner — neither should be done yet.
    await new Promise<void>((r) => setImmediate(r));
    expect(p1Resolved).toBe(false);
    expect(p2Resolved).toBe(false);

    resolveInner!();
    await Promise.all([p1, p2]);
    expect(p1Resolved).toBe(true);
    expect(p2Resolved).toBe(true);
  });
});
