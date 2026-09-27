import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { waitForGoneAfterDelete } from '../../../src/provisioning/delete-gone-wait.js';
import {
  clearResolvedResourceTimeouts,
  setResolvedResourceTimeouts,
} from '../../../src/provisioning/resource-timeout-registry.js';
import { isWaitAbandonedError } from '../../../src/provisioning/wait-abandoned.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * Issue #3872: after an ACCEPTED Kinesis / Firehose delete, wait until the
 * stream is gone so a same-name create is not refused while it is DELETING.
 * Every exit returns — the delete was accepted — and the non-gone exits warn.
 *
 * Time is driven by an injected clock that `sleep` advances, so the deadline
 * arms run without real waiting and the poll COUNT is the discriminator.
 */

const TYPE = 'AWS::KinesisFirehose::DeliveryStream';

function makeHarness(statuses: Array<string | undefined | Error>) {
  let clock = 0;
  const sleeps: number[] = [];
  const logger = { debug: vi.fn(), warn: vi.fn() };
  let calls = 0;
  const describe = vi.fn(async () => {
    const next = statuses[Math.min(calls, statuses.length - 1)];
    calls += 1;
    if (next instanceof Error) throw next;
    return next;
  });
  const run = (
    maxWaitMs = 60_000,
    pollIntervalMs = 5_000,
    failedStatus?: (status: string) => Error | undefined
  ) =>
    waitForGoneAfterDelete({
      failedStatus,
      what: 'Firehose delivery stream s1',
      resourceType: TYPE,
      describe,
      logger,
      pollIntervalMs,
      maxWaitMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
  return { run, describe, logger, sleeps, clock: () => clock };
}

function waitUntilGone(
  h: ReturnType<typeof makeHarness>,
  failedStatus: (status: string) => Error | undefined
): Promise<void> {
  return h.run(60_000, 5_000, failedStatus);
}

function throttle(): Error {
  const err = new Error('Rate exceeded');
  err.name = 'ThrottlingException';
  return err;
}

function accessDenied(): Error {
  const err = new Error('User is not authorized to perform firehose:DescribeDeliveryStream');
  err.name = 'AccessDeniedException';
  (err as unknown as Record<string, unknown>)['$metadata'] = { httpStatusCode: 400 };
  return err;
}

describe('waitForGoneAfterDelete (#3872)', () => {
  afterEach(() => {
    clearResolvedResourceTimeouts();
  });

  it('returns at once, without sleeping, when the resource is already gone', async () => {
    const h = makeHarness([undefined]);
    await h.run();
    expect(h.describe).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('polls through DELETING until the resource is gone', async () => {
    const h = makeHarness(['DELETING', 'DELETING', 'DELETING', undefined]);
    await h.run();
    expect(h.describe).toHaveBeenCalledTimes(4);
    expect(h.sleeps).toEqual([5_000, 5_000, 5_000]);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('keeps polling through a throttled status read', async () => {
    const h = makeHarness(['DELETING', throttle(), undefined]);
    await h.run();
    expect(h.describe).toHaveBeenCalledTimes(3);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('keeps polling through a transient 5xx status read', async () => {
    const err = new Error('Service Unavailable');
    err.name = 'ServiceUnavailableException';
    (err as unknown as Record<string, unknown>)['$metadata'] = { httpStatusCode: 503 };
    const h = makeHarness(['DELETING', err, undefined]);
    await h.run();
    expect(h.describe).toHaveBeenCalledTimes(3);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('stops watching with a warning, without throwing, on a non-throttle status-read failure', async () => {
    const h = makeHarness(['DELETING', accessDenied(), undefined]);
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.describe).toHaveBeenCalledTimes(2);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn.mock.calls[0]![0]).toMatch(/status could not be read/);
    expect(h.logger.warn.mock.calls[0]![0]).toMatch(/AccessDeniedException/);
  });

  it('logs the withheld AWS detail at debug when the status read fails', async () => {
    const h = makeHarness([accessDenied()]);
    await h.run();
    const debug = h.logger.debug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debug).toMatch(/status read failed: .*not authorized to perform firehose:DescribeDeliveryStream/);
  });

  it('throws the caller error, marked as an abandoned wait, on a terminal failed status', async () => {
    const h = makeHarness(['DELETING', 'DELETING_FAILED', undefined]);
    const failure = new Error('stream s1 entered DELETING_FAILED');
    let caught: unknown;
    try {
      await waitUntilGone(h, (s) => (s === 'DELETING_FAILED' ? failure : undefined));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(failure);
    expect(isWaitAbandonedError(caught)).toBe(true);
    expect(h.describe).toHaveBeenCalledTimes(2);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('does not trust a failed status on the FIRST read, and waits through it when the re-delete moves it on', async () => {
    // The re-run the DELETING_FAILED error asks for re-deletes a stream still
    // in that status; the read straight after can show the stale status.
    const h = makeHarness(['DELETING_FAILED', 'DELETING', undefined]);
    const failure = new Error('stream s1 entered DELETING_FAILED');
    await expect(
      waitUntilGone(h, (s) => (s === 'DELETING_FAILED' ? failure : undefined))
    ).resolves.toBeUndefined();
    expect(h.describe).toHaveBeenCalledTimes(3);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('throws on a failed status that persists one poll interval past the first read', async () => {
    const h = makeHarness(['DELETING_FAILED', 'DELETING_FAILED', undefined]);
    const failure = new Error('stream s1 entered DELETING_FAILED');
    let caught: unknown;
    try {
      await waitUntilGone(h, (s) => (s === 'DELETING_FAILED' ? failure : undefined));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(failure);
    expect(isWaitAbandonedError(caught)).toBe(true);
    expect(h.describe).toHaveBeenCalledTimes(2);
    expect(h.sleeps).toEqual([5_000]);
  });

  it('keeps waiting through a status the failedStatus predicate does not name', async () => {
    const h = makeHarness(['DELETING', undefined]);
    await expect(waitUntilGone(h, () => undefined)).resolves.toBeUndefined();
    expect(h.describe).toHaveBeenCalledTimes(2);
  });

  it('stops at the cap with a warning naming the last status, without throwing', async () => {
    const h = makeHarness(['DELETING']);
    await expect(h.run(60_000, 5_000)).resolves.toBeUndefined();
    // 12 sleeps of 5s reach the 60s cap, and one final poll runs AT the cap.
    expect(h.sleeps).toHaveLength(12);
    expect(h.describe).toHaveBeenCalledTimes(13);
    expect(h.clock()).toBe(60_000);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn.mock.calls[0]![0]).toMatch(/stopped waiting .* after 60s/);
    expect(h.logger.warn.mock.calls[0]![0]).toMatch(/last status: DELETING/);
  });

  it('never sleeps past the cap', async () => {
    const h = makeHarness(['DELETING']);
    await h.run(12_000, 5_000);
    expect(h.sleeps).toEqual([5_000, 5_000, 2_000]);
    expect(h.clock()).toBe(12_000);
  });

  it('an explicit --resource-timeout for the type lowers the cap to half of it', async () => {
    setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 20_000 } });
    const h = makeHarness(['DELETING']);
    await h.run(600_000, 5_000);
    expect(h.clock()).toBe(10_000);
    expect(h.logger.warn.mock.calls[0]![0]).toMatch(/after 10s/);
  });

  it('an explicit global --resource-timeout above twice the cap leaves the cap alone', async () => {
    setResolvedResourceTimeouts({ globalMs: 3_600_000 });
    const h = makeHarness(['DELETING']);
    await h.run(60_000, 5_000);
    expect(h.clock()).toBe(60_000);
  });
});

describe('waitForGoneAfterDelete on Ctrl-C (#3872)', () => {
  let baseline: readonly unknown[] = [];

  beforeEach(() => {
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    baseline = process.listeners('SIGINT');
  });

  afterEach(() => {
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('stops watching with a warning, without throwing, at the poll after the signal', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    let polls = 0;
    await expect(
      waitForGoneAfterDelete({
        what: 'Kinesis stream s1',
        resourceType: 'AWS::Kinesis::Stream',
        describe: async () => {
          polls += 1;
          if (polls === 2) {
            const ours = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
            for (const listener of ours) (listener as unknown as () => void)();
          }
          return 'DELETING';
        },
        logger,
        pollIntervalMs: 1,
        maxWaitMs: 60_000,
        sleep: async () => {},
      })
    ).resolves.toBeUndefined();
    expect(polls).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/interrupted/);
  });
});
