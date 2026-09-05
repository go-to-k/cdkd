import { describe, it, expect, vi } from 'vite-plus/test';
import {
  createDestroyCommand,
  purgeEventsAfterDestroy,
} from '../../../src/cli/commands/destroy.js';
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
    // Issue #2624: `--purge-events` routes through `deleteRawObjects`, which
    // sends `DeleteObjects` with no `VersionId`, so on the versioned state
    // bucket the earlier versions of those keys stay readable. "Purged" alone
    // reads as removal and is not one — the line has to carry the bound.
    const line = String(info.mock.calls[0]![0]);
    expect(line).toContain('Purged deployment-event history for MyStack (us-east-1).');
    expect(line).toContain('earlier versions of those keys survive');
    expect(line).toContain('VersionId');
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
    // THE OTHER POLARITY of the versioning note asserted above (issue #2624):
    // nothing was deleted here, so nothing is printed at all — and therefore
    // no caveat about a delete that did not happen either.
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

/**
 * The `--purge-events` HELP text is one of the corrected claims of issue
 * [#2624](https://github.com/go-to-k/cdkd/issues/2624), and it had nothing
 * holding it: the log line above is pinned, the docs are prose, and `--help` is
 * the surface a user reads BEFORE deciding to pass the flag. Without this case,
 * restoring "so the state bucket returns fully empty" here reds nothing. (Its
 * sibling, `cdkd events prune`'s own description, is pinned in
 * `tests/unit/cli/commands/events.test.ts`.)
 *
 * Read the option's OWN `description`, never `helpInformation()`, for the long
 * needles. `helpInformation()` re-wraps at a width derived from the widest
 * option name and from `process.stdout.columns`, so a needle longer than a line
 * matches only by accident: measured on this command, dropping an unrelated
 * long-named option is enough to start wrapping and break it. The raw
 * description is the string the code actually sets.
 */
describe('cdkd destroy --purge-events help text', () => {
  const description = (): string =>
    createDestroyCommand().options.find((o) => o.long === '--purge-events')?.description ?? '';

  it('promises an empty LISTING and names the surviving versions, not an empty bucket', () => {
    // Bound the arm first: a missing option yields '' above, which would
    // satisfy every `not.toContain` below for free.
    expect(description()).not.toBe('');
    expect(description()).toContain('an object listing of the state bucket comes back empty');
    expect(description()).toContain('earlier versions of those keys survive');
    expect(description()).toContain('VersionId');
    // The hedge: cdkd bootstrap skips PutBucketVersioning for a pre-existing
    // bucket, so the claim is conditional and must read as conditional.
    expect(description()).toContain('Where the state bucket is versioned');
  });

  it('THE OTHER POLARITY: it no longer claims the bucket itself ends empty', () => {
    // Self-bound rather than leaning on the sibling case above.
    expect(description()).not.toBe('');
    // The exact phrase that shipped, so a revert to it reds here rather than
    // passing because some other wording happens to be absent.
    expect(description()).not.toContain('so the state bucket returns fully empty');
  });
});
