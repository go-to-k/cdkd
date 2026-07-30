import { describe, it, expect, vi } from 'vite-plus/test';
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
      .mockRejectedValueOnce(new Error('DependencyViolation'))
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

describe('withRetry IAM-propagation cadence', () => {
  /** Collect the per-retry delay (seconds) from the debug log lines. */
  const delaysFrom = (debug: ReturnType<typeof vi.fn>): number[] =>
    debug.mock.calls.map((call) => {
      const m = /Retrying \S+ in ([\d.]+)s/.exec(String(call[0]));
      return Number(m?.[1]);
    });

  it('uses the dense sub-second schedule for an IAM-propagation error', async () => {
    const debug = vi.fn();
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      // The exact wire message from the measured EC2 deploy.
      if (calls < 6) {
        throw new Error(
          "Value (BenchEc2-Instance1InstanceProfileC04770B7) for parameter iamInstanceProfile.name is invalid. Invalid IAM Instance Profile name"
        );
      }
      return 'ok';
    });

    const result = await withRetry(op, 'Instance1', {
      sleep: () => Promise.resolve(),
      logger: { debug },
    });

    expect(result).toBe('ok');
    // 0.25s -> 0.5s -> 1s -> 2s -> 2s (flat at the cap), NOT 1/2/4/8/8.
    expect(delaysFrom(debug)).toEqual([0.25, 0.5, 1, 2, 2]);
  });

  it('keeps the generic exponential schedule for a non-propagation transient error', async () => {
    const debug = vi.fn();
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 6) {
        throw new Error('Rate exceeded. Ensure you have the high-throughput setting enabled');
      }
      return 'ok';
    });

    const result = await withRetry(op, 'Param1', {
      sleep: () => Promise.resolve(),
      logger: { debug },
    });

    expect(result).toBe('ok');
    // Throttling genuinely wants exponential backoff — hammering is harmful.
    expect(delaysFrom(debug)).toEqual([1, 2, 4, 8, 8]);
  });

  it('keeps the generic schedule for a throttle raised by error NAME (no message match)', async () => {
    const debug = vi.fn();
    const throttle = Object.assign(new Error('Too many requests for this account'), {
      name: 'ThrottlingException',
    });
    const op = vi.fn().mockRejectedValueOnce(throttle).mockResolvedValueOnce('ok');

    await withRetry(op, 'Param1', { sleep: () => Promise.resolve(), logger: { debug } });

    expect(delaysFrom(debug)).toEqual([1]);
  });

  it('re-classifies per attempt: a throttle hit mid-propagation backs off exponentially', async () => {
    const debug = vi.fn();
    let calls = 0;
    const op = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error('Invalid IAM Instance Profile name');
      if (calls === 2) throw new Error('Rate exceeded');
      if (calls === 3) throw new Error('Invalid IAM Instance Profile name');
      return 'ok';
    });

    await withRetry(op, 'Instance1', { sleep: () => Promise.resolve(), logger: { debug } });

    // attempt 0 propagation -> 0.25s; attempt 1 throttle -> generic 1*2^1 = 2s;
    // attempt 2 propagation again -> min(0.25*2^2, 2) = 1s.
    expect(delaysFrom(debug)).toEqual([0.25, 2, 1]);
  });

  it('does not shrink the propagation retry window (total sleep >= the generic 47s budget)', async () => {
    const sleeps: number[] = [];
    const op = vi.fn().mockRejectedValue(new Error('Invalid IAM Instance Profile name'));

    await expect(
      withRetry(op, 'Instance1', {
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      })
    ).rejects.toThrow(/Invalid IAM Instance Profile/);

    const totalMs = sleeps.reduce((a, b) => a + b, 0);
    // 0.25 + 0.5 + 1 + 2 x 23 = 47.75s, vs the generic schedule's 47s.
    expect(totalMs).toBe(47_750);
    expect(totalMs).toBeGreaterThanOrEqual(47_000);
    // 26 retries + the initial attempt.
    expect(op).toHaveBeenCalledTimes(27);
  });

  it('honours an explicit caller schedule even for a propagation error', async () => {
    const debug = vi.fn();
    const op = vi.fn().mockRejectedValue(new Error('Invalid IAM Instance Profile name'));

    // The DELETE path's schedule: 3 retries starting at 5s.
    await expect(
      withRetry(op, 'Instance1', {
        maxRetries: 3,
        initialDelayMs: 5_000,
        sleep: () => Promise.resolve(),
        logger: { debug },
      })
    ).rejects.toThrow();

    expect(delaysFrom(debug)).toEqual([5, 8, 8]);
    expect(op).toHaveBeenCalledTimes(4);
  });

  it('honours an explicit maxRetries alone (no dense-schedule budget extension)', async () => {
    const op = vi.fn().mockRejectedValue(new Error('cannot be assumed'));

    await expect(
      withRetry(op, 'Fn1', { maxRetries: 2, sleep: () => Promise.resolve() })
    ).rejects.toThrow('cannot be assumed');

    expect(op).toHaveBeenCalledTimes(3);
  });

  it('still rethrows a non-retryable error on the propagation path', async () => {
    const op = vi.fn().mockRejectedValue(new Error('ValidationError: image id is malformed'));
    await expect(
      withRetry(op, 'Instance1', { sleep: () => Promise.resolve() })
    ).rejects.toThrow('ValidationError');
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry isRetryable override', () => {
  it('retries an error shape the shared transient table excludes', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('thing already exists');
        return 'ok';
      },
      'Res',
      {
        maxRetries: 5,
        initialDelayMs: 1,
        maxDelayMs: 1,
        sleep: async () => {},
        isRetryable: (message) => /already exists/i.test(message),
      }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('the override REPLACES the default classifier (transient errors are not retried unless matched)', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          // 'trust policy' is in the shared transient table, but the
          // override only accepts 'already exists'.
          throw new Error('trust policy propagation');
        },
        'Res',
        {
          maxRetries: 5,
          initialDelayMs: 1,
          maxDelayMs: 1,
          sleep: async () => {},
          isRetryable: (message) => /already exists/i.test(message),
        }
      )
    ).rejects.toThrow(/trust policy/);
    expect(attempts).toBe(1);
  });
});
