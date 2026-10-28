import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #5451: the TTL rate-limit wait is bounded by the enclosing resource
// deadline and ends on Ctrl-C. Both are driven from here.
const ctl = vi.hoisted(() => ({
  remaining: [] as number[],
  interrupted: false,
  disposed: 0,
}));
vi.mock('../../../src/deployment/resource-deadline.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/resource-deadline.js')>()),
  // Each read takes the next value; the last one sticks.
  enclosingDeadlineRemainingMs: () =>
    ctl.remaining.length > 1 ? ctl.remaining.shift()! : (ctl.remaining[0] ?? Infinity),
}));
vi.mock('../../../src/provisioning/interrupt-watch.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/interrupt-watch.js')>();
  return {
    ...actual,
    startInterruptWatch: (what: string) => ({
      isInterrupted: () => ctl.interrupted,
      onInterrupted: () => new actual.InterruptedWaitError(what),
      dispose: () => {
        ctl.disposed += 1;
      },
    }),
  };
});

import {
  isTtlRateLimited,
  sendTtlWaitingOutRateLimit,
} from '../../../src/provisioning/dynamodb-ttl.js';
import { isInterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';

const RATE_LIMITED = 'Time to live has been modified multiple times within a fixed interval';
const refusal = (): Error =>
  Object.assign(new Error(RATE_LIMITED), {
    name: 'ValidationException',
    $fault: 'client',
    $metadata: {},
  });

function sender(outcomes: Array<'refuse' | 'ok' | Error>): { send: () => Promise<void>; calls: () => number } {
  let n = 0;
  return {
    send: async () => {
      const o = outcomes[Math.min(n, outcomes.length - 1)];
      n += 1;
      if (o === 'refuse') throw refusal();
      if (o instanceof Error) throw o;
    },
    calls: () => n,
  };
}

describe('sendTtlWaitingOutRateLimit (issue #5451)', () => {
  beforeEach(() => {
    ctl.remaining = [Infinity];
    ctl.interrupted = false;
    ctl.disposed = 0;
  });

  it('recognises the measured AWS refusal and nothing else', () => {
    expect(isTtlRateLimited(RATE_LIMITED)).toBe(true);
    expect(isTtlRateLimited('TimeToLive is already disabled')).toBe(false);
  });

  it('re-sends until AWS accepts, announcing the wait once', async () => {
    const s = sender(['refuse', 'refuse', 'ok']);
    const announce = vi.fn();
    await sendTtlWaitingOutRateLimit(s.send, { what: 'w', announce, retryMs: 5 });
    expect(s.calls()).toBe(3);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(ctl.disposed).toBe(1);
  });

  it('sends once and announces nothing when AWS accepts at once', async () => {
    const s = sender(['ok']);
    const announce = vi.fn();
    await sendTtlWaitingOutRateLimit(s.send, { what: 'w', announce, retryMs: 5 });
    expect(s.calls()).toBe(1);
    expect(announce).not.toHaveBeenCalled();
  });

  it('rethrows any other failure at once', async () => {
    const other = new Error('AccessDeniedException');
    const s = sender([other]);
    const announce = vi.fn();
    await expect(
      sendTtlWaitingOutRateLimit(s.send, { what: 'w', announce, retryMs: 5 })
    ).rejects.toBe(other);
    expect(s.calls()).toBe(1);
    expect(announce).not.toHaveBeenCalled();
  });

  it('rethrows the refusal when the resource deadline has already run out', async () => {
    ctl.remaining = [0];
    const s = sender(['refuse', 'ok']);
    await expect(
      sendTtlWaitingOutRateLimit(s.send, { what: 'w', announce: vi.fn(), retryMs: 5 })
    ).rejects.toThrow(RATE_LIMITED);
    expect(s.calls()).toBe(1);
  });

  it('sends nothing once the deadline runs out during the sleep', async () => {
    // First refusal: time left; the sleep ends at the deadline.
    ctl.remaining = [Infinity, Infinity, 0];
    const s = sender(['refuse', 'ok']);
    await expect(
      sendTtlWaitingOutRateLimit(s.send, { what: 'w', announce: vi.fn(), retryMs: 5 })
    ).rejects.toThrow(RATE_LIMITED);
    expect(s.calls()).toBe(1);
    expect(ctl.disposed).toBe(1);
  });

  it('sleeps no longer than the deadline leaves, then stops', async () => {
    ctl.remaining = [20, 20, 0];
    const s = sender(['refuse', 'ok']);
    const started = Date.now();
    await expect(
      sendTtlWaitingOutRateLimit(s.send, { what: 'w', announce: vi.fn(), retryMs: 60_000 })
    ).rejects.toThrow(RATE_LIMITED);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(s.calls()).toBe(1);
  });

  it('re-sends after a sleep the deadline outlasts', async () => {
    ctl.remaining = [20];
    const s = sender(['refuse', 'ok']);
    await sendTtlWaitingOutRateLimit(s.send, { what: 'w', announce: vi.fn(), retryMs: 60_000 });
    expect(s.calls()).toBe(2);
  });

  it('ends a minute-long retry sleep within a second of Ctrl-C', async () => {
    const s = sender(['refuse', 'ok']);
    const announce = vi.fn(() => {
      setTimeout(() => {
        ctl.interrupted = true;
      }, 50);
    });
    const started = Date.now();
    const err = await sendTtlWaitingOutRateLimit(s.send, {
      what: 'w',
      announce,
      retryMs: 60_000,
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isInterruptedWaitError(err)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(s.calls()).toBe(1);
  });

  it('ends the wait on Ctrl-C without re-sending', async () => {
    const s = sender(['refuse', 'ok']);
    const announce = vi.fn(() => {
      ctl.interrupted = true;
    });
    const err = await sendTtlWaitingOutRateLimit(s.send, { what: 'w', announce, retryMs: 5 }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isInterruptedWaitError(err)).toBe(true);
    expect(s.calls()).toBe(1);
    expect(ctl.disposed).toBe(1);
  });
});
