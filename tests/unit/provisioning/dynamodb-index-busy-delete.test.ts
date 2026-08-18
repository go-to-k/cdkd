import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { DescribeTableCommandOutput } from '@aws-sdk/client-dynamodb';
import {
  DescribeTableCommand,
  DeleteTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

/**
 * The index-busy `DeleteTable` rule BOTH DynamoDB providers read
 * (`src/provisioning/dynamodb-index-busy-delete.ts`).
 *
 * It lives in its own file, named for the module, because a third consumer's
 * author looks for `<module>.test.ts`. The per-provider suites
 * (`dynamodb-globaltable-provider-delete-retry-warm-throughput.test.ts`,
 * `dynamodb-table-provider-delete-index-busy.test.ts`) exercise the same module
 * through each provider's delete path; this file pins the RULE, and pins that
 * both providers actually route through it rather than each holding a copy.
 *
 * Provenance: the rule shipped for `AWS::DynamoDB::GlobalTable` first (issue
 * #1830, PR #1930), provider-locally. Issue #1931 is the sibling
 * `AWS::DynamoDB::Table` gap that left — its `delete()` had no retry at all —
 * and lifting the rule here is what makes "the same refusal, the same answer"
 * a fact rather than a convention.
 */

const { mockSend, mockAutoScalingSend, retrySpy, settleSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  retrySpy: vi.fn(),
  settleSpy: vi.fn(),
}));

/**
 * Spread the REAL module and wrap ONE export. Everything the rule tests below
 * assert is therefore the real implementation; the wrapper exists so the
 * binding test can see WHICH providers went through the shared retry — a
 * provider that re-spelled the loop locally would still pass every behavioural
 * test in its own suite while never touching this module.
 */
vi.mock('../../../src/provisioning/dynamodb-index-busy-delete.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/dynamodb-index-busy-delete.js')>();
  return {
    ...actual,
    deleteTableWithIndexBusyRetry: (opts: Parameters<typeof actual.deleteTableWithIndexBusyRetry>[0]) => {
      retrySpy(opts);
      return actual.deleteTableWithIndexBusyRetry(opts);
    },
    waitForIndexesSettled: (opts: Parameters<typeof actual.waitForIndexesSettled>[0]) => {
      settleSpy(opts);
      return actual.waitForIndexesSettled(opts);
    },
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-application-auto-scaling')>(
      '@aws-sdk/client-application-auto-scaling'
    );
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

import {
  DELETE_INDEX_BUSY_MAX_RETRIES,
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  DELETE_INDEX_WAIT_PROCEED_NOTE,
  INDEX_SETTLE_POLL_INTERVAL_MS,
  deleteTableWithIndexBusyRetry,
  hasTransitionalIndex,
  indexBusyRetryWarning,
  isIndexBusyDeleteError,
  waitForIndexesSettled,
} from '../../../src/provisioning/dynamodb-index-busy-delete.js';
// The REAL per-resource destroy deadline the budget below has to fit inside.
// Imported rather than restated so lowering it reds this suite — a fence has to
// watch the field it claims to watch.
import { DEFAULT_RESOURCE_TIMEOUT_MS } from '../../../src/deployment/deploy-engine.js';
import { isRetryableTransientError } from '../../../src/deployment/retryable-errors.js';
import type { Logger } from '../../../src/types/config.js';
import {
  DynamoDBTableProvider,
  deleteTableRetryDelays as tableDeleteDelays,
} from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import {
  DynamoDBGlobalTableProvider,
  deleteTableRetryDelays as globalTableDeleteDelays,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';

const INDEX_BUSY_MESSAGE =
  'Attempt to change a resource which is still in use: Cannot delete table while ' +
  'indexes are being created, updated, or deleted.';

describe('isIndexBusyDeleteError (the ONE classifier, issues #1830 / #1931)', () => {
  // The whole safety argument for retrying at all is that this predicate says
  // YES only to a condition that clears itself. AWS reports it as a plain
  // `ResourceInUseException` — a NAME it also uses for terminal conflicts — so
  // the message clause is the only discriminator there is.
  it.each([
    ['AWS`s verbatim refusal', INDEX_BUSY_MESSAGE, true],
    [
      'the same clause upper-cased (the wrapper prefix`s casing is not ours)',
      INDEX_BUSY_MESSAGE.toUpperCase(),
      true,
    ],
    [
      'the clause without AWS`s trailing status list (which AWS may reword)',
      'Cannot delete table while indexes are being changed',
      true,
    ],
    [
      'a table still being created — same exception NAME, never self-clearing',
      'Attempt to change a resource which is still in use: Table is being created: t',
      false,
    ],
    [
      'a table already existing — same exception NAME, never self-clearing',
      'Attempt to change a resource which is still in use: Table already exists: t',
      false,
    ],
    [
      'the generic in-use prefix ALONE (a prefix-keyed classifier would say yes)',
      'Attempt to change a resource which is still in use:',
      false,
    ],
    ['a table-not-found', 'Requested resource not found: Table: t not found', false],
    ['a throttle', 'Throughput exceeds the current capacity of your table', false],
    ['an empty message', '', false],
  ])('%s', (_name, message, expected) => {
    expect(isIndexBusyDeleteError(message)).toBe(expected);
  });
});

describe('hasTransitionalIndex (the CONDITION the re-arm waits on)', () => {
  // The test is on the TRANSITIONAL values rather than on `!== ACTIVE`: an
  // absent or unrecognized status must not park a delete for the whole cap on a
  // table that is fine.
  it.each([
    ['no index list at all', undefined, false],
    ['an empty list', [], false],
    ['every index ACTIVE', [{ IndexStatus: 'ACTIVE' }], false],
    ['a CREATING index', [{ IndexStatus: 'ACTIVE' }, { IndexStatus: 'CREATING' }], true],
    ['an UPDATING index', [{ IndexStatus: 'UPDATING' }], true],
    ['a DELETING index (it reports until it is gone)', [{ IndexStatus: 'DELETING' }], true],
    ['an absent status (a partial response is not a reason to wait)', [{}], false],
    ['an unrecognized status', [{ IndexStatus: 'SOMETHING_NEW' }], false],
  ])('%s', (_name, indexes, expected) => {
    expect(hasTransitionalIndex(indexes as { IndexStatus?: string }[] | undefined)).toBe(expected);
  });
});

describe('indexBusyRetryWarning (the ONE line printed at default verbosity)', () => {
  it('derives the remaining attempts from the budget rather than spelling it', () => {
    // `withRetry` runs `1 + maxRetries` attempts and the line fires from inside
    // the attempt now starting, so the first retry has 7 left, not 8. It
    // shipped saying 8 because the number was the raw budget constant.
    const first = indexBusyRetryWarning({
      typeLabel: 'table',
      logicalId: 'Orders',
      physicalId: 'orders-table',
      attemptNumber: 2,
    });
    expect(first).toContain(`up to ${DELETE_INDEX_BUSY_MAX_RETRIES - 1} more attempts`);
    expect(first).toContain(`up to ${DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS} DescribeTable polls`);
    expect(first).toContain('DynamoDB table Orders');
    expect(first).toContain('orders-table');
  });

  it('attaches the settle budget to a count that INCLUDES the announced attempt', () => {
    // The line fires from inside the attempt now starting, and that attempt
    // re-arms too — so there are 8 re-arms behind 7 "more attempts". Written as
    // "N more attempts, each preceded by 60 polls" the one sentence quoted two
    // different counts; the settle clause therefore ranges over "this attempt
    // plus the N more", which is what the code actually does.
    const first = indexBusyRetryWarning({
      typeLabel: 'table',
      logicalId: 'Orders',
      physicalId: 'orders-table',
      attemptNumber: 2,
    });
    expect(first).toContain(
      `this attempt plus up to ${DELETE_INDEX_BUSY_MAX_RETRIES - 1} more attempts`
    );
    expect(first).toContain(
      `each one first waits up to ${DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS} DescribeTable polls`
    );
    // The old wording read as the budget applying only to the remaining N.
    expect(first).not.toContain('more attempts, each preceded by');
  });

  it('states the remaining WALL CLOCK as a floor, derived from the constants', () => {
    // Issue #1950 took the budget to 14, so the loop can now run for the better
    // part of twenty minutes and an attempt COUNT no longer tells a user
    // watching one table whether it is settling or stuck. A floor rather than
    // an estimate: `INDEX_SETTLE_POLL_INTERVAL_MS` is only the sleep, so the
    // real wall clock is longer — and a line promising a shorter wait than the
    // loop takes would be the more misleading of the two.
    //
    // The line fires from inside attempt 2, where the attempts still to run —
    // each of which re-arms — number exactly `DELETE_INDEX_BUSY_MAX_RETRIES`.
    const firstRetryMinutes = Math.round(
      (DELETE_INDEX_BUSY_MAX_RETRIES *
        DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS *
        INDEX_SETTLE_POLL_INTERVAL_MS) /
        60_000
    );
    expect(
      indexBusyRetryWarning({
        typeLabel: 'table',
        logicalId: 'Orders',
        physicalId: 'orders-table',
        attemptNumber: 2,
      })
    ).toContain(`at least ~${firstRetryMinutes} more minutes`);

    // ...and it SHRINKS with the attempt, so the figure is derived from where
    // the loop actually is rather than being one more constant in the string.
    // (Production only ever prints the line once, on the first retry; a fixed
    // string would pass the assertion above and this is what catches it.)
    expect(
      indexBusyRetryWarning({
        typeLabel: 'table',
        logicalId: 'Orders',
        physicalId: 'orders-table',
        attemptNumber: DELETE_INDEX_BUSY_MAX_RETRIES,
      })
    ).toContain(
      `at least ~${Math.round(
        (2 * DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS * INDEX_SETTLE_POLL_INTERVAL_MS) / 60_000
      )} more minutes`
    );
  });

  it('names the caller`s resource type, so neither provider claims the other`s', () => {
    const gt = indexBusyRetryWarning({
      typeLabel: 'GlobalTable',
      logicalId: 'Warm',
      physicalId: 'warm-table',
      attemptNumber: 2,
    });
    expect(gt).toContain('DynamoDB GlobalTable Warm');
  });

  it('never quotes AWS`s own sentence', () => {
    // `tests/integration/dynamodb-globaltable/verify.sh` step 15b greps the
    // destroy log for `Cannot delete table while indexes are being` to prove
    // AWS really refused; a cdkd-authored copy would satisfy that grep with no
    // refusal having happened, and the arm would stop discriminating.
    expect(
      indexBusyRetryWarning({
        typeLabel: 'table',
        logicalId: 'Orders',
        physicalId: 'orders-table',
        attemptNumber: 2,
      })
    ).not.toContain('Cannot delete table while indexes are being');
  });
});

describe('the shared budget constants', () => {
  /**
   * What ONE re-arm poll costs in wall clock.
   *
   * {@link INDEX_SETTLE_POLL_INTERVAL_MS} is only the SLEEP; each poll also
   * pays a `DescribeTable` round trip. The live #1950 run measured the pair at
   * ~1.2s: a 60-poll re-arm took ~72s, and the per-attempt gaps were 73 / 74 /
   * 77 / 80 / 80 / 80s once `withRetry`'s backoff is subtracted. The fence the
   * budget shipped with priced a poll at the interval ALONE, which is how it
   * came to quote a ~8.8 min worst case for a loop the same run showed taking
   * ~10.4 min.
   */
  const MEASURED_POLL_RTT_MS = 200;
  /**
   * A poll costing 1.5x the interval instead of the measured ~1.2x — the "AWS
   * is slower today than it was on 2026-08-18" arm. The budget has to survive
   * it too, because the deadline it is sized against does not move with it.
   */
  const PESSIMISTIC_POLL_RTT_MS = 500;
  /**
   * `TABLE_ACTIVE_WAIT_ATTEMPTS` from `dynamodb-table-provider.ts`: the <=60
   * polls `--remove-protection` spends waiting for the table to reach ACTIVE
   * BEFORE this loop starts, inside the same per-resource deadline.
   *
   * The one term here that is a copy rather than an import — the constant is
   * module-private on that provider. It is also the smallest term, and the
   * pessimistic fence below covers it growing by half.
   */
  const TABLE_ACTIVE_WAIT_POLLS = 60;
  /**
   * The FLOOR the budget has to clear by a real multiple: a FIVE-item table's
   * GSI create took ~8 min on the live #1950 run. Five items is about as small
   * as a backfill gets, so that is AWS's roughly fixed index-create latency
   * rather than a data-proportional cost.
   */
  const MEASURED_FLOOR_MS = 8 * 60_000;

  /**
   * Drive the REAL loop against a refusal that never clears, recording what it
   * actually spends: how many times it re-armed, and every millisecond it asked
   * to sleep.
   *
   * MEASURED rather than restated, because that is what makes the fences below
   * move when a sibling constant does. `withRetry`'s schedule (1, 2, 4, 8, 8
   * ... capped at 8s) lives in `retry.ts`, and the fence this replaces hard-
   * coded its 47s total — a figure DERIVED from a budget of 8, so raising the
   * budget silently left the fence asserting the old loop's cost.
   */
  async function measureLoop(): Promise<{
    attempts: number;
    reArms: number;
    backoffMs: number;
  }> {
    let attempts = 0;
    let reArms = 0;
    let backoffMs = 0;
    const silent: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    await expect(
      deleteTableWithIndexBusyRetry({
        logicalId: 'Orders',
        physicalId: 'orders-table',
        typeLabel: 'table',
        logger: silent,
        deleteTable: () => {
          attempts += 1;
          return Promise.reject(
            new ResourceInUseException({ message: INDEX_BUSY_MESSAGE, $metadata: {} })
          );
        },
        reArm: () => {
          reArms += 1;
          return Promise.resolve();
        },
        // Records instead of sleeping. `withRetry` splits each delay into <=1s
        // chunks for its interrupt check, so the SUM of the calls is the
        // backoff, not any single one.
        sleepSeam: {
          sleep: (ms: number) => {
            backoffMs += ms;
            return Promise.resolve();
          },
        },
      })
    ).rejects.toThrow(INDEX_BUSY_MESSAGE);
    return { attempts, reArms, backoffMs };
  }

  /** Loop + the Table path's pre-delete ACTIVE wait, at a given poll cost. */
  function deletePathWorstCaseMs(
    pollRttMs: number,
    measured: { reArms: number; backoffMs: number }
  ): number {
    const pollMs = INDEX_SETTLE_POLL_INTERVAL_MS + pollRttMs;
    return (
      measured.reArms * DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS * pollMs +
      measured.backoffMs +
      TABLE_ACTIVE_WAIT_POLLS * pollMs
    );
  }

  it('spends exactly `1 + budget` attempts and one re-arm per retry', async () => {
    // The shape both fences below are computed from, pinned separately so a
    // failure there is readable: if this is wrong, the wall-clock numbers are
    // measuring something other than the loop.
    const measured = await measureLoop();
    expect(measured.attempts).toBe(1 + DELETE_INDEX_BUSY_MAX_RETRIES);
    expect(measured.reArms).toBe(DELETE_INDEX_BUSY_MAX_RETRIES);
  });

  it('covers a backfill well past the FLOOR case the budget used to stop at', async () => {
    // Issue #1950: at the shipped budget of 8 the loop ran ~10.4 min against a
    // ~8 min floor — one retry of headroom on the cheapest backfill AWS can do,
    // so the feature delivered its promise only for the smallest possible
    // table. Requiring 2x the floor is what "not calibrated at the floor" means
    // as a number: AWS's fixed index-create latency PLUS a data-proportional
    // term of comparable size. It cannot mean "covers any backfill" — that term
    // is unbounded and no fixed budget reaches it.
    const measured = await measureLoop();
    const loopMs =
      measured.reArms *
        DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS *
        (INDEX_SETTLE_POLL_INTERVAL_MS + MEASURED_POLL_RTT_MS) +
      measured.backoffMs;
    expect(loopMs).toBeGreaterThanOrEqual(2 * MEASURED_FLOOR_MS);
  });

  it('keeps the whole DELETE-path worst case under the per-resource deadline', async () => {
    // `destroy-runner.ts` caps the whole `delete()` CALL at
    // `DEFAULT_RESOURCE_TIMEOUT_MS` and neither provider declares a
    // `getMinResourceTimeoutMs` to lift it. Asserting against the IMPORTED
    // constant (not a copy of its value) is what makes lowering the real
    // deadline red this test.
    const measured = await measureLoop();

    // MARGIN: two thirds of the deadline, and note what this now counts that
    // the half-the-deadline fence it replaces did not — the Table path's
    // pre-delete ACTIVE wait, and a poll priced at its MEASURED cost rather
    // than at the bare sleep interval. Counting more terms at a truer cost is
    // why the threshold moved; the value it permits (14) is one retry above
    // what the old fence's own formula allowed (13), not a doubling.
    expect(deletePathWorstCaseMs(MEASURED_POLL_RTT_MS, measured)).toBeLessThan(
      (DEFAULT_RESOURCE_TIMEOUT_MS * 2) / 3
    );

    // ...and it still fits, with five minutes to spare, if a poll turns out to
    // cost half again what the live run measured. `withResourceDeadline` does
    // NOT cancel the operation it wraps: on an overshoot it rejects while this
    // loop keeps issuing `DeleteTable` in the background, so the cost of being
    // wrong here is not merely a worse message.
    expect(deletePathWorstCaseMs(PESSIMISTIC_POLL_RTT_MS, measured)).toBeLessThan(
      DEFAULT_RESOURCE_TIMEOUT_MS - 5 * 60_000
    );
  });

  it('states what proceeding costs on the delete path, not the auto-scaling one', () => {
    expect(DELETE_INDEX_WAIT_PROCEED_NOTE).toContain('DeleteTable goes ahead anyway');
  });

  /**
   * One sleep seam PER PROVIDER, not one shared object.
   *
   * The rationale has been stated in both provider files since the rule was
   * lifted here, and nothing pinned it. The failure mode is silent and looks
   * like success: a suite that installed the no-op on one provider's seam
   * would also silence the OTHER provider's `withRetry` backoff, so the
   * sibling's tests would keep passing at full speed while never proving they
   * control their own seam — and a suite that forgot to install it would then
   * pay the real ~47s schedule only once the first suite stopped running.
   */
  it('gives each provider its OWN sleep seam rather than one shared object', () => {
    expect(tableDeleteDelays).not.toBe(globalTableDeleteDelays);

    // Identity alone would still pass for two objects sharing a prototype, so
    // WRITE through one and prove the other did not move. Saved / restored
    // rather than assumed empty: this must not depend on which suites ran
    // first.
    const previousTable = tableDeleteDelays.sleep;
    const previousGlobal = globalTableDeleteDelays.sleep;
    const marker = () => Promise.resolve();
    try {
      tableDeleteDelays.sleep = marker;
      expect(globalTableDeleteDelays.sleep).not.toBe(marker);
    } finally {
      if (previousTable === undefined) delete tableDeleteDelays.sleep;
      else tableDeleteDelays.sleep = previousTable;
      if (previousGlobal === undefined) delete globalTableDeleteDelays.sleep;
      else globalTableDeleteDelays.sleep = previousGlobal;
    }
  });
});

/**
 * `waitForIndexesSettled` — the bounded poll BOTH providers re-arm with.
 *
 * Exercised directly here rather than only through a provider: its arms are
 * error-path arms (a gone table, a throttle, an unclassified failure, an
 * exhausted budget), and driving each one through a full `delete()` needs a
 * different `mockSend` script per arm while proving less. The providers' own
 * suites still cover the arms they can reach end to end.
 */
describe('waitForIndexesSettled (the bounded re-arm poll)', () => {
  function recordingLogger(): {
    logger: Logger;
    warns: string[];
    debugs: string[];
  } {
    const warns: string[] = [];
    const debugs: string[] = [];
    const logger: Logger = {
      debug: (m: string) => {
        debugs.push(m);
      },
      info: () => {},
      warn: (m: string) => {
        warns.push(m);
      },
      error: () => {},
    };
    return { logger, warns, debugs };
  }

  const BASE = {
    tableName: 'orders-table',
    logicalId: 'Orders',
    maxAttempts: 60,
    proceedNote: DELETE_INDEX_WAIT_PROCEED_NOTE,
  };

  it('returns WITHOUT warning when the table is already gone', async () => {
    // The routine concurrent-destroy shape, and newly reachable on the
    // `AWS::DynamoDB::Table` path: the re-arm runs between two `DeleteTable`
    // attempts, so a sibling destroy (or a re-run of this one) can take the
    // table out from under it. There is nothing left to wait for, and warning
    // about it would train the user to ignore the one line this module prints
    // at default verbosity.
    const { logger, warns, debugs } = recordingLogger();
    let describes = 0;

    await waitForIndexesSettled({
      ...BASE,
      logger,
      describeTable: () => {
        describes += 1;
        return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
      },
    });

    // It RETURNED (the await resolved) rather than burning the budget, and it
    // did so on the first poll.
    expect(describes).toBe(1);
    expect(warns).toEqual([]);
    expect(debugs.some((d) => d.includes('no longer exists'))).toBe(true);
  });

  it('warns naming the exhausted budget when no index ever settles', async () => {
    // The give-up arm executes today only through a GlobalTable wall-clock
    // test, which asserts the retry COUNT and never reads this message. The
    // message is the whole product of the arm: it is what a user sees when a
    // large index backfill outlasts the budget, so it has to say how much
    // waiting was actually done.
    vi.useFakeTimers();
    try {
      const { logger, warns } = recordingLogger();
      let describes = 0;
      const pending = waitForIndexesSettled({
        ...BASE,
        maxAttempts: 3,
        logger,
        describeTable: () => {
          describes += 1;
          return Promise.resolve({
            Table: { GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'CREATING' }] },
          } as unknown as DescribeTableCommandOutput);
        },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;

      expect(describes).toBe(3);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('did not all reach ACTIVE within 3 DescribeTable polls');
      // Stated as POLLS with the wall clock DERIVED from them, never as a bare
      // duration: each poll also pays a round trip, so "3s" would claim a
      // budget the loop does not have.
      expect(warns[0]).toContain('~1s apart');
      expect(warns[0]).toContain(DELETE_INDEX_WAIT_PROCEED_NOTE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coerces a non-Error throw instead of printing `undefined`', async () => {
    // `describeTable` is a caller-supplied closure around an SDK send, and a
    // rejected non-Error (a string, a plain object) reaches here as-is. The
    // arm reads `err.message` for the Error case, so without the `String(err)`
    // fallback the debug line would say `undefined` — and this is the arm
    // whose whole job is telling the user WHY the wait stopped.
    const { logger, warns, debugs } = recordingLogger();

    await waitForIndexesSettled({
      ...BASE,
      logger,
      describeTable: () => Promise.reject('dynamodb exploded'),
    });

    expect(debugs.some((d) => d.includes('dynamodb exploded'))).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]).not.toContain('undefined');
    // A non-Error has no `name`, so the class falls back to its typeof rather
    // than to an empty parenthesis.
    expect(warns[0]).toContain('(string)');
  });

  it('keeps AWS`s raw message out of the default-verbosity warning', async () => {
    // An `AccessDeniedException` message embeds the account id, the assumed
    // role and the session name, and this warning is wrapped into the
    // persisted deployment-events store as well as the terminal. The CLASS is
    // what a default-verbosity run needs; the rest is `--verbose` only.
    const denied = Object.assign(
      new Error(
        'User: arn:aws:sts::123456789012:assumed-role/cdkd-deploy-role/cdkd-session is not ' +
          'authorized to perform: dynamodb:DescribeTable on resource: orders-table'
      ),
      { name: 'AccessDeniedException' }
    );
    const { logger, warns, debugs } = recordingLogger();

    await waitForIndexesSettled({ ...BASE, logger, describeTable: () => Promise.reject(denied) });

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('AccessDeniedException');
    expect(warns[0]).not.toContain('123456789012');
    expect(warns[0]).not.toContain('assumed-role');
    expect(warns[0]).toContain(DELETE_INDEX_WAIT_PROCEED_NOTE);
    // Nothing is LOST — the raw message is still one `--verbose` away, which is
    // what makes this a level change rather than a redaction.
    expect(debugs.some((d) => d.includes('123456789012'))).toBe(true);
  });
});

/**
 * The binding: both providers' `delete()` go through THIS module.
 *
 * Behavioural suites cannot see this — a provider holding its own copy of the
 * loop would satisfy every retry expectation in its own file while being free
 * to drift on the next edit, which is exactly the failure that made
 * `dynamodb-warm-throughput.ts` exist.
 */
describe('both DynamoDB providers route DeleteTable through the shared retry', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    retrySpy.mockReset();
    settleSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    tableDeleteDelays.sleep = () => Promise.resolve();
    globalTableDeleteDelays.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    delete tableDeleteDelays.sleep;
    delete globalTableDeleteDelays.sleep;
  });

  /** Refuse the first `DeleteTable` with the index-busy message, then succeed. */
  function stubOneRefusal(): { deletes: () => number } {
    let deletes = 0;
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        return deleted
          ? Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }))
          : Promise.resolve({
              Table: {
                TableName: 'shared-table',
                TableStatus: 'ACTIVE',
                GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
                Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
              },
            });
      }
      if (command instanceof DeleteTableCommand) {
        deletes += 1;
        if (deletes === 1) {
          return Promise.reject(
            new ResourceInUseException({ message: INDEX_BUSY_MESSAGE, $metadata: {} })
          );
        }
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    return { deletes: () => deletes };
  }

  it('AWS::DynamoDB::Table', async () => {
    const stub = stubOneRefusal();

    await new DynamoDBTableProvider().delete(
      'Orders',
      'shared-table',
      'AWS::DynamoDB::Table',
      {}
    );

    expect(stub.deletes()).toBe(2);
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy.mock.calls[0]?.[0]).toMatchObject({ typeLabel: 'table' });
  });

  it('AWS::DynamoDB::GlobalTable', async () => {
    const stub = stubOneRefusal();

    await new DynamoDBGlobalTableProvider().delete(
      'Warm',
      'shared-table',
      'AWS::DynamoDB::GlobalTable',
      {}
    );

    expect(stub.deletes()).toBe(2);
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(retrySpy.mock.calls[0]?.[0]).toMatchObject({ typeLabel: 'GlobalTable' });
  });

  it('the DELETE path re-arms with the shared bound and NOT the auto-scaling note', async () => {
    const stub = stubOneRefusal();

    await new DynamoDBGlobalTableProvider().delete(
      'Warm',
      'shared-table',
      'AWS::DynamoDB::GlobalTable',
      {}
    );

    expect(stub.deletes()).toBe(2);
    // Assert the re-arm HAPPENED before reading it. Without this the fence is
    // vacuous in one direction: `settleSpy` is reset per test, but `.at(-1)` on
    // an empty list is `undefined`, and `toMatchObject` against `undefined`
    // would throw rather than describe the regression -- while a LEAKED call
    // from a sibling test (identical opts) would satisfy every assertion below.
    // A removed `reArm` must fail here, not merely fail to be observed.
    expect(settleSpy).toHaveBeenCalledTimes(1);
    const reArmCall = settleSpy.mock.calls.at(-1)?.[0];
    expect(reArmCall).toMatchObject({ maxAttempts: DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS });
    expect(reArmCall?.proceedNote).toBe(DELETE_INDEX_WAIT_PROCEED_NOTE);
    // The specific regression: collapsing onto this provider's own defaults.
    expect(reArmCall?.maxAttempts).not.toBe(900);
    expect(reArmCall?.proceedNote).not.toMatch(/auto-scaling/i);
  });
});

/**
 * The GlobalTable provider kept its OWN defaults when the LOOP moved into the
 * shared module: a 900-poll cap and an auto-scaling proceed note, both of which
 * belong to the caller that has no backstop. The delete path deliberately passes
 * neither. Nothing stood over that split, so a later "simplification" onto the
 * shared defaults would silently hand the auto-scaling caller the delete-path
 * note (and the delete path a 15x larger budget than its arithmetic allows) with
 * every behavioural test still green. These two fence it from both sides.
 */
describe('the moved GlobalTable defaults stay distinct from the delete path (issue #1931)', () => {
  // Own hooks rather than relying on the previous describe's: isolation that
  // depends on declaration ORDER breaks silently when a test is inserted above.
  beforeEach(() => {
    mockSend.mockReset();
    settleSpy.mockReset();
  });

  it('the AUTO-SCALING caller keeps the 900-poll cap and its own note', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DescribeTableCommand) {
        return Promise.resolve({
          Table: { TableName: 'shared-table', GlobalSecondaryIndexes: [] },
          $metadata: {},
        } as DescribeTableCommandOutput);
      }
      return Promise.resolve({});
    });

    const provider = new DynamoDBGlobalTableProvider();
    // `waitForIndexesActive` is private; the auto-scaling caller reaches it with
    // NO opts, so calling it that way exercises the DEFAULT it would get.
    // Residual, stated rather than implied: this fences the default, NOT the
    // call site -- a regression that passed explicit delete-path opts AT the
    // auto-scaling call site would leave both fences green.
    await (
      provider as unknown as {
        waitForIndexesActive: (physicalId: string, logicalId: string) => Promise<void>;
      }
    ).waitForIndexesActive('shared-table', 'Warm');

    const defaultCall = settleSpy.mock.calls.at(-1)?.[0];
    expect(defaultCall?.maxAttempts).toBe(900);
    expect(defaultCall?.proceedNote).toMatch(/auto-scaling/i);
    expect(defaultCall?.proceedNote).not.toBe(DELETE_INDEX_WAIT_PROCEED_NOTE);
  });
});

/**
 * The ~18.4 min worst case is only true while the OUTER retry loop in
 * `destroy-runner.ts` invokes `delete()` exactly ONCE for this refusal. That
 * loop runs up to 4 attempts and keys on `isRetryableTransientError`, so adding
 * this message to `RETRYABLE_ERROR_MESSAGE_PATTERNS` would silently take the
 * worst case to ~74 min and blow the 30-min per-resource deadline the budget is
 * sized against. The module comment asserts that property; this pins it, so the
 * claim cannot rot into a comment that used to be true.
 */
describe('the index-busy refusal stays OUTSIDE the outer retry classifier (issue #1931)', () => {
  it('neither AWS\'s raw sentence nor the wrapped form is treated as retryable', () => {
    const raw =
      'Attempt to change a resource which is still in use: Cannot delete table ' +
      'while indexes are being created, updated, or deleted.';
    const wrapped = `Failed to delete DynamoDB table Orders: ${raw}`;

    for (const message of [raw, wrapped]) {
      expect(isRetryableTransientError(new Error(message), message)).toBe(false);
      // The classifier this module DOES want must still fire on the same text,
      // or the fence would pass simply because nothing matches anything.
      expect(isIndexBusyDeleteError(message)).toBe(true);
    }
  });
});
