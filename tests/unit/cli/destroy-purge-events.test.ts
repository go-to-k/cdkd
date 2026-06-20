import { describe, it, expect, vi } from 'vite-plus/test';
import { purgeEventsAfterDestroy } from '../../../src/cli/commands/destroy.js';
import type { DeploymentEventsPruneResult } from '../../../src/state/deployment-events-store.js';

/**
 * Unit coverage for the `cdkd destroy --purge-events` gating helper (issue
 * #885). The helper is pure aside from the injected reader + logger, so these
 * tests exercise it directly without the full synth / AWS-client harness.
 */
function fakeReader(result: DeploymentEventsPruneResult, opts?: { throws?: Error }) {
  const pruneRuns = vi.fn(async () => {
    if (opts?.throws) throw opts.throws;
    return result;
  });
  return { reader: { pruneRuns }, pruneRuns };
}

function fakeLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  return { logger: { info, warn }, info, warn };
}

const PRUNED: DeploymentEventsPruneResult = {
  deletedRunIds: ['20260101T000000000Z-aa'],
  remainingRunIds: [],
  indexDeleted: true,
};

describe('purgeEventsAfterDestroy', () => {
  it('purges (all) after a clean, non-interrupted destroy with --purge-events', async () => {
    const { reader, pruneRuns } = fakeReader(PRUNED);
    const { logger, info } = fakeLogger();
    const res = await purgeEventsAfterDestroy(
      reader,
      'MyStack',
      'us-east-1',
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: false },
      logger
    );
    expect(pruneRuns).toHaveBeenCalledWith('MyStack', 'us-east-1', { all: true });
    expect(res).toBe(PRUNED);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when --purge-events was not passed', async () => {
    const { reader, pruneRuns } = fakeReader(PRUNED);
    const { logger } = fakeLogger();
    const res = await purgeEventsAfterDestroy(
      reader,
      'MyStack',
      'us-east-1',
      { purgeEvents: false, runResult: 'SUCCEEDED', interrupted: false },
      logger
    );
    expect(pruneRuns).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('does NOT purge on a FAILED destroy (events are the post-mortem)', async () => {
    const { reader, pruneRuns } = fakeReader(PRUNED);
    const { logger } = fakeLogger();
    const res = await purgeEventsAfterDestroy(
      reader,
      'MyStack',
      'us-east-1',
      { purgeEvents: true, runResult: 'FAILED', interrupted: false },
      logger
    );
    expect(pruneRuns).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('does NOT purge on an interrupted destroy', async () => {
    const { reader, pruneRuns } = fakeReader(PRUNED);
    const { logger } = fakeLogger();
    const res = await purgeEventsAfterDestroy(
      reader,
      'MyStack',
      'us-east-1',
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: true },
      logger
    );
    expect(pruneRuns).not.toHaveBeenCalled();
    expect(res).toBeNull();
  });

  it('does not log when nothing was actually deleted', async () => {
    const empty: DeploymentEventsPruneResult = {
      deletedRunIds: [],
      remainingRunIds: [],
      indexDeleted: false,
    };
    const { reader } = fakeReader(empty);
    const { logger, info } = fakeLogger();
    const res = await purgeEventsAfterDestroy(
      reader,
      'MyStack',
      'us-east-1',
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: false },
      logger
    );
    expect(res).toBe(empty);
    expect(info).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the purge itself fails — destroy already succeeded', async () => {
    const { reader, pruneRuns } = fakeReader(PRUNED, { throws: new Error('AccessDenied') });
    const { logger, warn } = fakeLogger();
    const res = await purgeEventsAfterDestroy(
      reader,
      'MyStack',
      'us-east-1',
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: false },
      logger
    );
    expect(pruneRuns).toHaveBeenCalledOnce();
    expect(res).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/Failed to purge.*AccessDenied/s);
  });
});
