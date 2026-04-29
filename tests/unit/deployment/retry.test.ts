import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../../src/deployment/retry.js';

describe('withRetry', () => {
  it('returns the operation result when it succeeds on first try', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(op, 'MyResource', { sleep: () => Promise.resolve() });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-retryable errors immediately without retrying', async () => {
    const op = vi.fn().mockRejectedValue(new Error('InvalidParameterValue'));
    await expect(
      withRetry(op, 'MyResource', { sleep: () => Promise.resolve() })
    ).rejects.toThrow('InvalidParameterValue');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries transient IAM-propagation failures and eventually succeeds', async () => {
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        throw new Error('The role defined for the function cannot be assumed by Lambda.');
      }
      return 'ok';
    });
    const result = await withRetry(op, 'MyResource', { sleep: () => Promise.resolve() });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('uses exponential backoff starting at 1s by default (1s, 2s, 4s, ...)', async () => {
    const sleeps: number[] = [];
    const op = vi.fn().mockRejectedValue(
      new Error('The role defined for the function cannot be assumed by Lambda.')
    );
    await expect(
      withRetry(op, 'MyResource', {
        maxRetries: 4,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      })
    ).rejects.toThrow();
    // Each retry's delay is sliced into 1000ms chunks for interruptibility:
    //   1s -> [1000]
    //   2s -> [1000, 1000]
    //   4s -> [1000, 1000, 1000, 1000]
    //   8s -> [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000] (capped at default 8s)
    // = 1+2+4+8 = 15 sleep calls total before the 5th attempt rethrows.
    expect(sleeps).toHaveLength(15);
    expect(sleeps.every((ms) => ms === 1000)).toBe(true);
    expect(op).toHaveBeenCalledTimes(5);
  });

  it('caps the per-retry delay at maxDelayMs (default 8s)', async () => {
    const sleeps: number[] = [];
    const op = vi.fn().mockRejectedValue(new Error('cannot be assumed'));
    await expect(
      withRetry(op, 'MyResource', {
        maxRetries: 6,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      })
    ).rejects.toThrow();
    // Backoff with default maxDelayMs=8000:
    //   1s, 2s, 4s, 8s, 8s, 8s   (cumulative 31 sleep chunks of 1000ms)
    expect(sleeps).toHaveLength(31);
    expect(op).toHaveBeenCalledTimes(7);
  });

  it('respects a custom maxDelayMs', async () => {
    const sleeps: number[] = [];
    const op = vi.fn().mockRejectedValue(new Error('cannot be assumed'));
    await expect(
      withRetry(op, 'MyResource', {
        maxRetries: 4,
        maxDelayMs: 2_000,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      })
    ).rejects.toThrow();
    // 1s, 2s, 2s, 2s -> 7 chunks
    expect(sleeps).toHaveLength(7);
  });

  it('respects a custom initialDelayMs and maxRetries', async () => {
    const sleeps: number[] = [];
    const op = vi.fn().mockRejectedValue(new Error('DependencyViolation'));
    await expect(
      withRetry(op, 'MyResource', {
        maxRetries: 2,
        initialDelayMs: 5_000,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      })
    ).rejects.toThrow();
    // 5s, then min(10s, 8s default cap) = 8s -> 13 chunks of 1000ms.
    // 3 attempts total (initial + 2 retries).
    expect(sleeps).toHaveLength(13);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('aborts mid-sleep if isInterrupted() returns true', async () => {
    const op = vi.fn().mockRejectedValue(new Error('DependencyViolation'));
    let calls = 0;
    await expect(
      withRetry(op, 'MyResource', {
        sleep: () => Promise.resolve(),
        isInterrupted: () => {
          calls++;
          return calls > 0;
        },
        onInterrupted: () => new Error('SIGINT'),
      })
    ).rejects.toThrow('SIGINT');
    // Operation called once, then interrupted before any retry succeeded.
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('logs each retry attempt via the supplied logger', async () => {
    const debug = vi.fn();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('cannot be assumed'))
      .mockResolvedValueOnce('ok');
    await withRetry(op, 'MyResource', {
      sleep: () => Promise.resolve(),
      logger: { debug },
    });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[0]).toMatch(/Retrying MyResource in 1s/);
  });

  it('rethrows the last error after exhausting maxRetries', async () => {
    const op = vi.fn().mockRejectedValue(new Error('cannot be assumed'));
    await expect(
      withRetry(op, 'MyResource', {
        maxRetries: 2,
        sleep: () => Promise.resolve(),
      })
    ).rejects.toThrow('cannot be assumed');
    expect(op).toHaveBeenCalledTimes(3);
  });
});
