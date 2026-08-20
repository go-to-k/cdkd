import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { DescribeTableCommandOutput } from '@aws-sdk/client-dynamodb';
import { ResourceInUseException } from '@aws-sdk/client-dynamodb';

import {
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  DELETE_INDEX_WAIT_PROCEED_NOTE,
  TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
  deleteTableWithIndexBusyRetry,
  waitForIndexesSettled,
} from '../../../src/provisioning/dynamodb-index-busy-delete.js';
import type { Logger } from '../../../src/types/config.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * Issue #1952 — the index-busy `DeleteTable` loop and the settle poll it
 * re-arms with were both SIGINT-deaf.
 *
 * What made this worse than a slow Ctrl-C: `destroy-runner.ts` wraps `delete()`
 * in `withResourceTimeout`, which does NOT cancel. It rejects and moves on
 * while the loop carries on issuing `DeleteTable` — so the user saw the run
 * end, and cdkd kept deleting behind it for the rest of the budget (the better
 * part of twenty minutes at the `Table` budget).
 *
 * Tested at the MODULE, because that is where the fix lives and because both
 * DynamoDB providers read it: `AWS::DynamoDB::Table` (issue #1931) and
 * `AWS::DynamoDB::GlobalTable` (issue #1830). A per-provider test would have
 * left the other type's identical path unclaimed.
 *
 * THE DISCRIMINATOR IS THE CALL COUNT. Both loops terminate eventually without
 * the fix — that is the whole complaint — so "it threw" / "it returned" is
 * satisfied by the un-threaded code.
 */

function makeLogger(): Logger & { warns: string[]; debugs: string[] } {
  const warns: string[] = [];
  const debugs: string[] = [];
  return {
    warns,
    debugs,
    debug: (m: string) => debugs.push(m),
    info: () => {},
    warn: (m: string) => warns.push(m),
    error: () => {},
    child() {
      return this;
    },
  } as unknown as Logger & { warns: string[]; debugs: string[] };
}

function indexBusyError(): Error {
  return new ResourceInUseException({
    message:
      'Attempt to change a resource which is still in use: Cannot delete table while ' +
      'indexes are being created, updated, or deleted.',
    $metadata: {},
  });
}

function transitioningTable(): DescribeTableCommandOutput {
  return {
    Table: {
      TableName: 't',
      GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'CREATING' }],
    },
    $metadata: {},
  } as unknown as DescribeTableCommandOutput;
}


/**
 * Stand in for the SIGINT handler every real command installs before it reaches
 * a provider (`forwardSigtermToSigint`, the engine's, `destroy-runner.ts`'s).
 *
 * The watch deliberately refuses to install the FIRST SIGINT listener — that
 * would disable Node's default terminate for a command that has no interrupt
 * handling of its own — and a vitest worker registers none, so without this the
 * watch would never arm and every case below would exercise the UNARMED path
 * while appearing to test the armed one.
 *
 * The disarm is because arming is a one-way door in production (the listener is
 * installed once and never removed, so a signal landing between two sequential
 * waits is still recorded), which makes a per-test cold start a test concern
 * rather than a production one. The latch is sticky for the same reason and
 * would otherwise leak a simulated Ctrl-C into every later test in the file.
 */
function armInterruptWatchForSuite(): void {
  disarmInterruptWatchForTests();
  interruptWatchTestSeam.commandOwnsInterrupts = () => true;
}

let baseline: readonly unknown[] = [];
let watchersSeenAtFire = -1;

/** Fire ONLY the listeners this call installed; the count is RECORDED, not asserted. */
function fireInterrupt(): void {
  const ours = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
  watchersSeenAtFire = ours.length;
  for (const listener of ours) (listener as unknown as () => void)();
}

describe('the index-busy DeleteTable loop honours Ctrl-C (#1952)', () => {
  beforeEach(() => {
    armInterruptWatchForSuite();
    baseline = process.listeners('SIGINT');
    watchersSeenAtFire = -1;
  });

  afterEach(() => {
    expect(process.listeners('SIGINT').length).toBeLessThanOrEqual(baseline.length + 1);
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('stops at the attempt the signal landed in, not after the whole budget', async () => {
    const logger = makeLogger();
    let deletes = 0;
    let reArms = 0;

    await expect(
      deleteTableWithIndexBusyRetry({
        logicalId: 'Orders',
        physicalId: 'orders-table',
        typeLabel: 'table',
        logger,
        deleteTable: () => {
          deletes += 1;
          // The SECOND attempt, so this also proves the loop retried at all.
          if (deletes === 2) fireInterrupt();
          return Promise.reject(indexBusyError());
        },
        reArm: () => {
          reArms += 1;
          return Promise.resolve();
        },
        // Collapse the backoff: a REGRESSED run would otherwise spend 95s of
        // real sleep before failing, and a timed-out test reports "timed out"
        // rather than "15 attempts instead of 2". The interrupt is consulted at
        // the top of every sleep slice whatever the slice is worth.
        sleepSeam: { sleep: () => Promise.resolve() },
        maxRetries: TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
      })
    ).rejects.toThrow(/interrupted by user \(SIGINT\)/);

    // THE discriminator: 15 un-threaded (one attempt plus 14 retries), each
    // preceded by a 60-poll settle wait.
    expect(deletes).toBe(2);
    // ...and the re-arm ran exactly once, before the second attempt. An
    // un-threaded run pays 14 of them.
    expect(reArms).toBe(1);
    expect(watchersSeenAtFire).toBe(1);
  });

  it('retries normally when nothing interrupts — the abort is the SIGNAL, not the wiring', async () => {
    // The other polarity: a watch stuck reporting "interrupted" would pass the
    // case above while breaking every ordinary index-busy retry.
    const logger = makeLogger();
    let deletes = 0;

    await deleteTableWithIndexBusyRetry({
      logicalId: 'Orders',
      physicalId: 'orders-table',
      typeLabel: 'table',
      logger,
      deleteTable: () => {
        deletes += 1;
        return deletes < 3 ? Promise.reject(indexBusyError()) : Promise.resolve();
      },
      reArm: () => Promise.resolve(),
      sleepSeam: { sleep: () => Promise.resolve() },
      maxRetries: TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
    });

    expect(deletes).toBe(3);
    // Non-vacuity: the loop really did announce the condition, i.e. it went
    // through the index-busy arm rather than some other path.
    expect(logger.warns.join('\n')).toContain('a global secondary index is still being');
  });
});

describe('the delete-path settle poll honours Ctrl-C (#1952)', () => {
  beforeEach(() => {
    armInterruptWatchForSuite();
    baseline = process.listeners('SIGINT');
    watchersSeenAtFire = -1;
  });

  afterEach(() => {
    expect(process.listeners('SIGINT').length).toBeLessThanOrEqual(baseline.length + 1);
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
  });

  it('stops polling on the signal instead of running its whole cap', async () => {
    // This ONE wait serves both delete-path callers — `GlobalTable`'s #1521
    // pre-delete gate and the #1830 / #1931 retry re-arm on both DynamoDB types
    // — so threading it is what makes all of them interruptible. Issue #1952
    // asked for exactly that: interrupting only one wait on the path buys
    // little.
    const logger = makeLogger();
    let describes = 0;

    await waitForIndexesSettled({
      tableName: 'orders-table',
      logicalId: 'Orders',
      logger,
      describeTable: () => {
        describes += 1;
        if (describes === 1) fireInterrupt();
        return Promise.resolve(transitioningTable());
      },
      maxAttempts: DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
      proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
    });

    // THE discriminator: 60 polls (~72s measured) without the fix, on a table
    // whose index never settles.
    expect(describes).toBe(1);
    expect(watchersSeenAtFire).toBe(1);
    // It STOPS WAITING rather than throwing — the contract every other give-up
    // arm in this wait keeps, and what leaves AWS's own refusal as the backstop.
    expect(logger.debugs.join('\n')).toContain('Interrupted while waiting for indexes');
    // ...and it did NOT emit the give-up warning, which would have blamed AWS
    // for a wait cdkd itself ended.
    expect(logger.warns.join('\n')).not.toContain('did not all reach ACTIVE');
  });

  it('polls to its cap when nothing interrupts', async () => {
    const logger = makeLogger();
    let describes = 0;

    await waitForIndexesSettled({
      tableName: 'orders-table',
      logicalId: 'Orders',
      logger,
      describeTable: () => {
        describes += 1;
        return Promise.resolve(transitioningTable());
      },
      // A small cap: the real 60 would be a minute of real sleeping, and the
      // point here is only that the loop is NOT short-circuited by a watch that
      // reports "interrupted" when nothing was.
      maxAttempts: 2,
      proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
    });

    expect(describes).toBe(2);
    expect(logger.warns.join('\n')).toContain('did not all reach ACTIVE');
  }, 30_000);
});
