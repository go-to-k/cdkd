import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withResourceDeadline,
  InvalidResourceDeadlineError,
} from '../../../src/deployment/resource-deadline.js';

describe('withResourceDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the operation result when it settles before warnAfterMs', async () => {
    const op = vi.fn(async () => 'done');
    const onWarn = vi.fn();
    const onTimeout = vi.fn(() => new Error('should not fire'));

    const promise = withResourceDeadline(op, {
      warnAfterMs: 1_000,
      timeoutMs: 5_000,
      onWarn,
      onTimeout,
    });

    // Operation resolves immediately on the microtask queue.
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe('done');
    expect(onWarn).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('fires onWarn at warnAfterMs but does not abort while still under timeoutMs', async () => {
    let resolveOp!: (v: string) => void;
    const op = () =>
      new Promise<string>((resolve) => {
        resolveOp = resolve;
      });
    const onWarn = vi.fn();
    const onTimeout = vi.fn(() => new Error('should not fire yet'));

    const promise = withResourceDeadline(op, {
      warnAfterMs: 1_000,
      timeoutMs: 5_000,
      onWarn,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(1_000);
    expect(onTimeout).not.toHaveBeenCalled();

    // Now let the operation settle before the abort fires.
    resolveOp('late ok');
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe('late ok');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('rejects with onTimeout error at timeoutMs when the operation never settles', async () => {
    const op = () => new Promise<string>(() => {}); // never resolves
    const onWarn = vi.fn();
    const onTimeout = vi.fn((elapsed: number) => new Error(`timed out after ${elapsed}ms`));

    const promise = withResourceDeadline(op, {
      warnAfterMs: 1_000,
      timeoutMs: 3_000,
      onWarn,
      onTimeout,
    });

    // Attach a catch handler before advancing fake timers so the rejection
    // does not trigger an unhandledRejection warning.
    const settled = promise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(3_000);
    const err = (await settled) as Error;

    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(3_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/timed out after/);
  });

  it('does not fire onWarn when no callback is provided', async () => {
    const op = () => new Promise<string>(() => {});
    const onTimeout = vi.fn(() => new Error('boom'));

    const promise = withResourceDeadline(op, {
      warnAfterMs: 1_000,
      timeoutMs: 2_000,
      onTimeout,
    });

    const settled = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('propagates the operation error when it rejects before timeoutMs', async () => {
    const op = vi.fn(async () => {
      throw new Error('provider failed');
    });
    const onTimeout = vi.fn(() => new Error('should not fire'));

    const promise = withResourceDeadline(op, {
      warnAfterMs: 1_000,
      timeoutMs: 5_000,
      onTimeout,
    });
    // Attach a catch handler before yielding to fake-timer microtasks so
    // the rejection has a registered consumer when it settles.
    const settled = promise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0);
    const err = (await settled) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('provider failed');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('rejects when warnAfterMs >= timeoutMs', async () => {
    const op = vi.fn(async () => 'unused');
    await expect(
      withResourceDeadline(op, {
        warnAfterMs: 5_000,
        timeoutMs: 5_000,
        onTimeout: () => new Error('x'),
      })
    ).rejects.toBeInstanceOf(InvalidResourceDeadlineError);
    expect(op).not.toHaveBeenCalled();
  });

  it('rejects on non-positive durations', async () => {
    const op = vi.fn(async () => 'unused');

    await expect(
      withResourceDeadline(op, {
        warnAfterMs: 0,
        timeoutMs: 100,
        onTimeout: () => new Error('x'),
      })
    ).rejects.toBeInstanceOf(InvalidResourceDeadlineError);

    await expect(
      withResourceDeadline(op, {
        warnAfterMs: 50,
        timeoutMs: -100,
        onTimeout: () => new Error('x'),
      })
    ).rejects.toBeInstanceOf(InvalidResourceDeadlineError);

    expect(op).not.toHaveBeenCalled();
  });

  it('passes elapsed milliseconds to the timeout error builder', async () => {
    const op = () => new Promise<string>(() => {});
    let captured = -1;
    const promise = withResourceDeadline(op, {
      warnAfterMs: 100,
      timeoutMs: 1_000,
      onTimeout: (elapsedMs) => {
        captured = elapsedMs;
        return new Error(`elapsed=${elapsedMs}`);
      },
    });

    const settled = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(captured).toBeGreaterThanOrEqual(1_000);
  });

  it('does not call onWarn after the operation has already finished', async () => {
    const op = vi.fn(async () => 'done');
    const onWarn = vi.fn();
    const onTimeout = vi.fn(() => new Error('x'));

    const promise = withResourceDeadline(op, {
      warnAfterMs: 1_000,
      timeoutMs: 5_000,
      onWarn,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // Advance past the warn timer — both timers should have been cleared
    // when the operation settled.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onWarn).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
