import { describe, it, expect, vi } from 'vite-plus/test';
import {
  createDestroyCommand,
  purgeEventsAfterDestroy,
} from '../../../src/cli/commands/destroy.js';
import {
  DeploymentEventsReader,
  type DeploymentEventsPruneResult,
} from '../../../src/state/deployment-events-store.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { expectNoCommandBesideDisplay } from '../utils/paste-harness.js';

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
  // Bodies were swept too, so turning the residue-only `else if` into an
  // `if` would print a SECOND line and trip `toHaveBeenCalledTimes(1)`.
  earlierVersions: { deletedBodies: 1, complete: true },
};

describe('purgeEventsAfterDestroy', () => {
  // Issue #2624: the prefix sweep reports what it deleted, and destroy uses
  // that count the way `cdkd events prune --all` does.
  it('nothing current but earlier versions swept: prints a line scoped to those versions', async () => {
    const { reader } = fakeReader({
      deletedRunIds: [],
      remainingRunIds: [],
      indexDeleted: false,
      earlierVersions: { deletedBodies: 2, complete: true },
    });
    const { logger, info } = fakeLogger();
    await purgeEventsAfterDestroy(
      reader,
      'MyStack',
      'us-east-1',
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: false },
      logger
    );
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]![0]);
    expect(line).toContain(
      'Purged earlier deployment-event versions left under the deployments/ prefix of MyStack (us-east-1)'
    );
    expect(line).toContain('unless a warning above says otherwise');
    expect(line).not.toContain('Purged deployment-event history');
  });

  it('nothing current and the sweep deleted nothing: prints nothing', async () => {
    const { reader } = fakeReader({
      deletedRunIds: [],
      remainingRunIds: [],
      indexDeleted: false,
      earlierVersions: { deletedBodies: 0, complete: true },
    });
    const { logger, info } = fakeLogger();
    await purgeEventsAfterDestroy(
      reader,
      'MyStack',
      'us-east-1',
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: false },
      logger
    );
    expect(info).not.toHaveBeenCalled();
  });

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
    // Issue #2624: `pruneRuns({ all: true })` purges every noncurrent version
    // under the stack's deployments/ prefix, streams deleted EARLIER included,
    // so "Purged" covers them -- bounded by the purge's own warning, which
    // prints first when it could not finish.
    const line = String(info.mock.calls[0]![0]);
    expect(line).toContain('Purged deployment-event history for MyStack (us-east-1)');
    expect(line).toContain('and every earlier version under its deployments/ prefix');
    // The narrower #4558 scoping is retired on this path.
    expect(line).not.toContain('of the deleted keys');
    expect(line).not.toContain('earlier object versions included');
    expect(line).toContain('unless a warning above says otherwise');
    expect(line).not.toContain('survive');
  });

  it('names no cdkd invocation on the purge line that displays the stack name (go-to-k/cdkd#3950)', async () => {
    // The versioning note said `which cdkd bootstrap enables`, a `cdkd`
    // invocation in prose, on the line that displays the stack name; a block
    // that displays an untrusted value carries no pasteable command.
    const { logger, info } = fakeLogger();
    const stack = 'x$(touch OWNED)';
    await purgeEventsAfterDestroy(
      fakeReader(PRUNED).reader,
      stack,
      'us-east-1',
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: false },
      logger
    );
    const line = String(info.mock.calls[0]![0]);
    expect(line).toContain('Purged deployment-event history');
    expectNoCommandBesideDisplay(line, stack);
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

  it('prints nothing for a stack with no event history, through the REAL reader (issue #2624)', async () => {
    // The case above feeds the gate a hand-built all-false result, so it
    // cannot see what `pruneRuns({ all: true })` actually returns. Over an
    // empty prefix its `DeleteObjects` still succeeds (S3 deletes are
    // idempotent); a reader that reported that success as `indexDeleted`
    // made this line announce a purge of history that never existed.
    const deleteRawObjects = vi.fn(async () => {});
    const backend = {
      prefix: 'cdkd',
      listRawKeys: vi.fn(async () => []),
      getRawObject: vi.fn(async () => null),
      putRawObject: vi.fn(async () => {}),
      deleteRawObjects,
      purgeNoncurrentVersions: vi.fn(async () => {}),
      purgeNoncurrentVersionsUnderPrefix: vi.fn(async () => {}),
    } as unknown as S3StateBackend;
    const { logger, info } = fakeLogger();
    const res = await purgeEventsAfterDestroy(
      new DeploymentEventsReader(backend),
      'MyStack',
      'us-east-1',
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: false },
      logger
    );
    // Positive control: the purge DID run its delete — only the claim is gone.
    expect(deleteRawObjects).toHaveBeenCalledOnce();
    // And the prefix-wide version sweep ran on the EXACT directory, trailing
    // `/` included, even with nothing current listed (issue #2624): that is
    // the stack whose history an earlier delete left behind markers.
    expect(backend.purgeNoncurrentVersionsUnderPrefix).toHaveBeenCalledWith(
      'cdkd/MyStack/us-east-1/deployments/',
      expect.anything()
    );
    expect(backend.purgeNoncurrentVersions).not.toHaveBeenCalled();
    expect(res).toEqual({ deletedRunIds: [], remainingRunIds: [], indexDeleted: false });
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

  it('folds a newline in the stack, region and error onto one line (go-to-k/cdkd#3773)', async () => {
    // The name is the operator's argument or an S3 key segment, and the error
    // is AWS text: a newline in any of them started a line of its own.
    const stack = 'Ghost\n  Purged deployment-event history for RealStack';
    const region = 'us-east-1\nforged-region-row';
    const purged = fakeLogger();
    await purgeEventsAfterDestroy(
      fakeReader(PRUNED).reader,
      stack,
      region,
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: false },
      purged.logger
    );
    const failed = fakeLogger();
    await purgeEventsAfterDestroy(
      fakeReader(PRUNED, { throws: new Error('AccessDenied\nforged-error-row') }).reader,
      stack,
      region,
      { purgeEvents: true, runResult: 'SUCCEEDED', interrupted: false },
      failed.logger
    );
    const purgedLine = String(purged.info.mock.calls[0]![0]);
    const failedLine = String(failed.warn.mock.calls[0]![0]);
    // Positive controls: each line fired, naming the folded values.
    expect(purgedLine).toContain('Ghost   Purged deployment-event history for RealStack (us-east-1 forged-region-row)');
    expect(failedLine).toContain('Ghost   Purged deployment-event history for RealStack: AccessDenied forged-error-row');
    expect(purgedLine).not.toMatch(/[\n\r]/);
    expect(failedLine).not.toMatch(/[\n\r]/);
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

  it("says every earlier version under the stack's deployments/ prefix is purged too (issue #2624)", () => {
    // Bound the arm first: a missing option yields '' above, which would
    // satisfy every `not.toContain` below for free.
    expect(description()).not.toBe('');
    expect(description()).toContain(
      "purging every earlier version under the stack's deployments/ prefix on a versioned state bucket too unless a warning says otherwise"
    );
    expect(description()).not.toContain('survive and stay readable');
  });

  it('THE OTHER POLARITY: it no longer claims the bucket itself ends empty', () => {
    // Self-bound rather than leaning on the sibling case above.
    expect(description()).not.toBe('');
    // The exact phrase that shipped, so a revert to it reds here rather than
    // passing because some other wording happens to be absent.
    expect(description()).not.toContain('so the state bucket returns fully empty');
  });
});
