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
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  DELETE_INDEX_WAIT_PROCEED_NOTE,
  GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
  INDEX_SETTLE_POLL_INTERVAL_MS,
  TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
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
  TABLE_ACTIVE_WAIT_ATTEMPTS,
  deleteTableRetryDelays as tableDeleteDelays,
} from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import {
  DynamoDBGlobalTableProvider,
  TABLE_GONE_WAIT_ATTEMPTS,
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
  /** The line as the `Table` caller emits it on its first retry. */
  const firstRetryLine = (maxRetries = TABLE_DELETE_INDEX_BUSY_MAX_RETRIES): string =>
    indexBusyRetryWarning({
      typeLabel: 'table',
      logicalId: 'Orders',
      physicalId: 'orders-table',
      attemptNumber: 2,
      maxRetries,
    });

  it('derives the remaining attempts from the CALLER`s budget rather than spelling it', () => {
    // `withRetry` runs `1 + maxRetries` attempts and the line fires from inside
    // the attempt now starting, so one fewer than the budget is left. It
    // shipped saying the whole budget because the number was the raw constant.
    const first = firstRetryLine();
    expect(first).toContain(`up to ${TABLE_DELETE_INDEX_BUSY_MAX_RETRIES - 1} more attempts`);
    expect(first).toContain(`up to ${DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS} DescribeTable polls`);
    expect(first).toContain('DynamoDB table Orders');
    expect(first).toContain('orders-table');

    // ...and it is the CALLER's budget, not a module constant: the two
    // DynamoDB types no longer share one, so a line reading a module-level
    // constant would print the other type's promise.
    expect(firstRetryLine(GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES)).toContain(
      `up to ${GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES - 1} more attempts`
    );
  });

  it('attaches the settle budget to a count that INCLUDES the announced attempt', () => {
    // The line fires from inside the attempt now starting, and that attempt
    // re-arms too — so there is one MORE re-arm than there are "more attempts".
    // Written as "N more attempts, each preceded by 60 polls" the one sentence
    // quoted two different counts; the settle clause therefore ranges over
    // "this attempt plus the N more", which is what the code actually does.
    const first = firstRetryLine();
    expect(first).toContain(
      `this attempt plus up to ${TABLE_DELETE_INDEX_BUSY_MAX_RETRIES - 1} more attempts`
    );
    expect(first).toContain(
      `each one first waits up to ${DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS} DescribeTable polls`
    );
    // The old wording read as the budget applying only to the remaining N.
    expect(first).not.toContain('more attempts, each preceded by');
  });

  it('derives the poll INTERVAL too, so the sentence cannot disagree with itself', () => {
    // The minutes in this sentence are computed from
    // `INDEX_SETTLE_POLL_INTERVAL_MS` while the cadence next to them was the
    // literal `~1s apart`, so moving the constant left the line stating a
    // cadence and a total that could not both be true. Same defect in
    // `waitForIndexesSettled`'s exhausted-budget warning, fenced below.
    expect(firstRetryLine()).toContain(
      `polls ~${INDEX_SETTLE_POLL_INTERVAL_MS / 1000}s apart`
    );
  });

  it('clamps, so an attempt past the budget cannot print 0 or a negative count', () => {
    // Exported, so nothing stops a caller passing an attempt beyond the budget
    // — the unclamped form printed "up to 0 more attempts ... ~1 more minutes"
    // at `1 + budget` and went negative past it.
    const past = indexBusyRetryWarning({
      typeLabel: 'table',
      logicalId: 'Orders',
      physicalId: 'orders-table',
      attemptNumber: TABLE_DELETE_INDEX_BUSY_MAX_RETRIES + 5,
      maxRetries: TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
    });
    expect(past).toContain('up to 0 more attempts');
    expect(past).not.toMatch(/-\d/);
    // The announced attempt still re-arms, so the patience floor is never zero.
    expect(past).toContain('at least ~1 more minutes');
  });

  it('states how long cdkd will NOT GIVE UP for, as a floor derived from the constants', () => {
    // Issue #1950 took the `Table` budget to 14, so the loop can run for the
    // better part of twenty minutes and an attempt COUNT no longer tells a user
    // watching one table whether it is settling or stuck.
    //
    // The line fires from inside attempt 2, where the attempts still to run —
    // each of which re-arms — number exactly the budget.
    const firstRetryMinutes = Math.round(
      (TABLE_DELETE_INDEX_BUSY_MAX_RETRIES *
        DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS *
        INDEX_SETTLE_POLL_INTERVAL_MS) /
        60_000
    );
    const first = firstRetryLine();
    expect(first).toContain(`will not give up for at least ~${firstRetryMinutes} more minutes`);

    // The floor is on cdkd's PATIENCE, never on the wait itself: the re-arm
    // returns on the first `DescribeTable` reporting the indexes settled, so a
    // table clearing in 90 seconds prints this line and then finishes at once.
    // Phrased as a floor on the WAIT ("can keep retrying for at least ~14 more
    // minutes") it would push that user toward Ctrl-C — the opposite of what
    // the line exists for.
    expect(first).not.toContain('can keep retrying for at least');

    // ...and it SHRINKS with the attempt, so the figure is derived from where
    // the loop actually is rather than being one more constant in the string.
    // (Production only ever prints the line once, on the first retry; a fixed
    // string would pass the assertion above and this is what catches it.)
    expect(
      indexBusyRetryWarning({
        typeLabel: 'table',
        logicalId: 'Orders',
        physicalId: 'orders-table',
        attemptNumber: TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
        maxRetries: TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
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
      maxRetries: GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
    });
    expect(gt).toContain('DynamoDB GlobalTable Warm');
  });

  it('never quotes AWS`s own sentence', () => {
    // `tests/integration/dynamodb-globaltable/verify.sh` step 15b greps the
    // destroy log for `Cannot delete table while indexes are being` to prove
    // AWS really refused; a cdkd-authored copy would satisfy that grep with no
    // refusal having happened, and the arm would stop discriminating.
    expect(
      firstRetryLine()
    ).not.toContain('Cannot delete table while indexes are being');
  });
});

describe('the two per-type budget constants (issue #1950)', () => {
  /**
   * What ONE poll costs in wall clock.
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
   * is slower today than it was on 2026-08-18" arm. The deadline does not move
   * with it.
   */
  const PESSIMISTIC_POLL_RTT_MS = 500;
  /**
   * The polls `--remove-protection` spends waiting for the table to reach
   * ACTIVE BEFORE the loop starts, inside the same per-resource deadline.
   *
   * IMPORTED, not copied. It was a local `60`, and raising the provider's real
   * cap to 900 — ~18 min added to a 30-minute deadline — left all 51 tests
   * green: a copied cap stops tracking the moment the original moves, which is
   * exactly the failure the GlobalTable side avoids by OBSERVING its gate cap
   * below. The wait also reads `INDEX_SETTLE_POLL_INTERVAL_MS` for its sleep,
   * so neither the count nor the unit is restated here.
   */
  const TABLE_ACTIVE_WAIT_POLLS = TABLE_ACTIVE_WAIT_ATTEMPTS;
  /**
   * The FLOOR the `Table` budget has to clear by a real multiple: a FIVE-item
   * table's GSI create took ~8 min on the live #1950 run. Five items is about
   * as small as a backfill gets, so that is AWS's roughly fixed index-create
   * latency rather than a data-proportional cost.
   */
  const MEASURED_FLOOR_MS = 8 * 60_000;

  const silent: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  /**
   * Drive the REAL loop at a given budget against a refusal that never clears,
   * recording what it actually spends: how many times it re-armed, and every
   * millisecond it asked to sleep.
   *
   * MEASURED rather than restated, because that is what makes the fences below
   * move when a sibling constant does. `withRetry`'s schedule (1, 2, 4, 8, 8
   * ... capped at 8s) lives in `retry.ts`, and the fence this replaces hard-
   * coded its 47s total — a figure DERIVED from a budget of 8, so raising the
   * budget silently left the fence asserting the old loop's cost.
   */
  async function measureLoop(maxRetries: number): Promise<{
    attempts: number;
    reArms: number;
    backoffMs: number;
  }> {
    let attempts = 0;
    let reArms = 0;
    let backoffMs = 0;
    await expect(
      deleteTableWithIndexBusyRetry({
        logicalId: 'Orders',
        physicalId: 'orders-table',
        typeLabel: 'table',
        logger: silent,
        maxRetries,
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

  /** The loop's own wall clock at a given poll cost. */
  function loopMs(pollRttMs: number, measured: { reArms: number; backoffMs: number }): number {
    return (
      measured.reArms *
        DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS *
        (INDEX_SETTLE_POLL_INTERVAL_MS + pollRttMs) +
      measured.backoffMs
    );
  }

  /**
   * The #1521 pre-delete gate's poll cap, OBSERVED from the GlobalTable
   * provider rather than copied as a literal — the constant is a default
   * argument on a private method, and a fence that restated it would keep
   * asserting 900 after the provider moved to something else.
   */
  async function observeGlobalTablePreDeleteGatePolls(): Promise<number> {
    mockSend.mockReset();
    settleSpy.mockReset();
    mockSend.mockImplementation(() =>
      Promise.resolve({
        Table: { TableName: 'shared-table', GlobalSecondaryIndexes: [{ IndexStatus: 'ACTIVE' }] },
      })
    );
    await (
      new DynamoDBGlobalTableProvider() as unknown as {
        waitForIndexesActive: (physicalId: string, logicalId: string) => Promise<void>;
      }
    ).waitForIndexesActive('shared-table', 'Warm');
    const polls = settleSpy.mock.calls.at(-1)?.[0]?.maxAttempts as number | undefined;
    // Never let the fence below multiply an `undefined` into a passing 0.
    expect(polls).toBeGreaterThan(0);
    return polls as number;
  }

  it('spends exactly `1 + budget` attempts and one re-arm per retry', async () => {
    // The shape every fence below is computed from, pinned separately so a
    // failure there is readable: if this is wrong, the wall-clock numbers are
    // measuring something other than the loop.
    const table = await measureLoop(TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
    expect(table.attempts).toBe(1 + TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
    expect(table.reArms).toBe(TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);

    const globalTable = await measureLoop(GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
    expect(globalTable.attempts).toBe(1 + GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
    expect(globalTable.reArms).toBe(GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
  });

  it('Table: covers a backfill well past the FLOOR case the budget used to stop at', async () => {
    // Issue #1950: at the shipped budget of 8 the loop ran ~10.4 min against a
    // ~8 min floor — one retry of headroom on the cheapest backfill AWS can do,
    // so the feature delivered its promise only for the smallest possible
    // table. Requiring 2x the floor is what "not calibrated at the floor" means
    // as a number: AWS's fixed index-create latency PLUS a data-proportional
    // term of comparable size. It cannot mean "covers any backfill" — that term
    // is unbounded and no fixed budget reaches it.
    const measured = await measureLoop(TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
    expect(loopMs(MEASURED_POLL_RTT_MS, measured)).toBeGreaterThanOrEqual(2 * MEASURED_FLOOR_MS);
  });

  it('Table: the whole DELETE path stays under the per-resource deadline', async () => {
    // `destroy-runner.ts` caps the whole `delete()` CALL at
    // `DEFAULT_RESOURCE_TIMEOUT_MS` and neither provider declares a
    // `getMinResourceTimeoutMs` to lift it. Asserting against the IMPORTED
    // constant (not a copy of its value) is what makes lowering the real
    // deadline red this test.
    //
    // On THIS type the only thing sharing the deadline is the
    // `--remove-protection` ACTIVE wait, which is why it can afford 14.
    const measured = await measureLoop(TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
    const deletePathMs = (pollRttMs: number): number =>
      loopMs(pollRttMs, measured) +
      TABLE_ACTIVE_WAIT_POLLS * (INDEX_SETTLE_POLL_INTERVAL_MS + pollRttMs);

    // MARGIN: two thirds of the deadline, and note what this counts that the
    // half-the-deadline fence it replaces did not — the pre-delete ACTIVE wait,
    // and a poll priced at its MEASURED cost rather than at the bare sleep
    // interval. (The old fence would have admitted 14 as well, but only by
    // pricing the loop at ~14.7 min instead of the ~18.4 min it really takes;
    // it was permissive for the wrong reason, not strict for the right one.)
    expect(deletePathMs(MEASURED_POLL_RTT_MS)).toBeLessThan((DEFAULT_RESOURCE_TIMEOUT_MS * 2) / 3);

    // ...and it still fits, with five minutes to spare, if a poll turns out to
    // cost half again what the live run measured. `withResourceDeadline` does
    // NOT cancel the operation it wraps: on an overshoot it rejects while this
    // loop keeps issuing `DeleteTable` in the background, so the cost of being
    // wrong here is not merely a worse message.
    expect(deletePathMs(PESSIMISTIC_POLL_RTT_MS)).toBeLessThan(
      DEFAULT_RESOURCE_TIMEOUT_MS - 5 * 60_000
    );
  });

  it('GlobalTable: the budget still clears the FLOOR the retry exists for', async () => {
    // The ceiling below is only half a fence. Lowering this budget — "8 looks
    // risky next to that gate, let us take it to 2" — silently guts issue
    // #1830 for this type, and every other test in the tree keeps passing
    // because they all derive their counts FROM the constant. Probed: 8 -> 1
    // left all 40 tests green.
    //
    // The floor is the same measured one the sibling is held to, but the
    // MULTIPLE is not: loop(8) is ~10.4 min against a ~8 min floor, i.e. ~1.3x,
    // where `Table` gets 2x. That is the honest position — this type cannot
    // afford more, because the #1521 gate has already spent ~18 of the 30
    // minutes — and it is why the budget must not go DOWN either.
    const measured = await measureLoop(GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
    expect(loopMs(MEASURED_POLL_RTT_MS, measured)).toBeGreaterThan(MEASURED_FLOOR_MS);
  });

  it('GlobalTable: the #1521 gate PLUS the loop stays under the deadline', async () => {
    // Why this type keeps 8 while the sibling took 14. Its `delete()` reaches
    // the loop having already spent the #1521 pre-delete settle gate out of the
    // SAME deadline, so the single-region shape (no non-local replica, so no
    // `waitForReplicaGone`) is gate + loop and nothing else:
    //
    //   at 8    ~18 min + ~10.4 min = ~28.4 min   fits
    //   at 14   ~18 min + ~18.4 min = ~36.4 min   over
    //
    // The raise would CREATE that crossing rather than inherit it, on a common
    // shape. This fence is what stops a later "make the budgets agree again"
    // from doing it silently.
    //
    // WHAT THIS MODELS, precisely: the EXHAUSTED-budget path, which is the one
    // the budget bounds. `waitForTableGone`'s 600 polls run AFTER the loop and
    // only when it SUCCEEDS — an exhausted budget throws and skips them — so
    // they are excluded here on purpose rather than forgotten. The
    // late-SUCCESS path, where they do run, is asserted below as the tracked
    // overshoot it is.
    const gatePolls = await observeGlobalTablePreDeleteGatePolls();
    const measured = await measureLoop(GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
    const gateMs = gatePolls * (INDEX_SETTLE_POLL_INTERVAL_MS + MEASURED_POLL_RTT_MS);
    const exhaustedBudgetWorstCaseMs = gateMs + loopMs(MEASURED_POLL_RTT_MS, measured);

    // The margin is ONE MINUTE, not the sibling's ten, and the difference is
    // the finding rather than a weaker rule: the gate alone eats ~18 of the 30
    // minutes, so there is no version of this path with a comfortable margin —
    // that is issue #1955's problem. A minute is what the terms even THIS case
    // omits need (the `DeleteTable` calls themselves).
    expect(exhaustedBudgetWorstCaseMs).toBeLessThan(DEFAULT_RESOURCE_TIMEOUT_MS - 60_000);

    // The other path, asserted rather than left implied: when the loop succeeds
    // late, the gone-wait DOES run and the same single-region shape reaches
    // ~40.4 min — already over the deadline at the CURRENT budget, so it is not
    // a consequence of any calibration here and 8 cannot fix it. Asserted as
    // GREATER so it documents the live overshoot: if a later change brings this
    // path back under the deadline (issue #1955), this reds and the comments
    // claiming an overshoot have to be revisited — which is the point.
    const goneWaitMs =
      TABLE_GONE_WAIT_ATTEMPTS * (INDEX_SETTLE_POLL_INTERVAL_MS + MEASURED_POLL_RTT_MS);
    expect(exhaustedBudgetWorstCaseMs + goneWaitMs).toBeGreaterThan(DEFAULT_RESOURCE_TIMEOUT_MS);

    // ...and the sibling's budget would NOT fit here, which is the whole reason
    // the two constants exist. Asserted as a PREMISE, so the fence above cannot
    // pass merely because both budgets happen to be small.
    const atTableBudget = await measureLoop(TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
    expect(gateMs + loopMs(MEASURED_POLL_RTT_MS, atTableBudget)).toBeGreaterThan(
      DEFAULT_RESOURCE_TIMEOUT_MS
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
      //
      // Both the cadence and the total come from
      // `INDEX_SETTLE_POLL_INTERVAL_MS`. The cadence used to be the literal
      // `~1s apart` sitting next to a derived total, so raising the interval
      // left one sentence stating a cadence and a total that could not both be
      // true — and every string assertion here stayed green while it lied.
      const pollSeconds = INDEX_SETTLE_POLL_INTERVAL_MS / 1000;
      expect(warns[0]).toContain(`~${pollSeconds}s apart`);
      expect(warns[0]).toContain(`a little over ${3 * pollSeconds}s of wall clock`);
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
    // ...with THIS type's budget. The two are no longer the same number, and
    // nothing else in the suite would notice the providers being swapped: a
    // GlobalTable budget here would silently halve the `Table` retry, and the
    // reverse would push the sibling's single-region delete over the deadline.
    expect(retrySpy.mock.calls[0]?.[0]).toMatchObject({
      typeLabel: 'table',
      maxRetries: TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
    });
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
    expect(retrySpy.mock.calls[0]?.[0]).toMatchObject({
      typeLabel: 'GlobalTable',
      maxRetries: GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
    });
  });

  it('AWS::DynamoDB::Table re-arms with the shared bound, not a 900-poll one', async () => {
    // The TWIN of the GlobalTable fence below, and it was missing: every
    // wall-clock number in this file takes the poll COUNT from the constant,
    // while `measureLoop`'s `reArm` is a counter — so nothing read what this
    // provider actually passes. Mutating its `maxAttempts` to 900 left all 73
    // tests green while the real worst case became 14 x 900 polls, over three
    // hours inside a 30-minute deadline. The identical mutation on the sibling
    // reddened two tests, which is what a fence is supposed to do.
    const stub = stubOneRefusal();

    await new DynamoDBTableProvider().delete(
      'Orders',
      'shared-table',
      'AWS::DynamoDB::Table',
      {}
    );

    expect(stub.deletes()).toBe(2);
    // Assert the re-arm HAPPENED before reading it, for the same reason the
    // sibling fence does: `.at(-1)` on an empty list is `undefined`, and a
    // removed `reArm` must FAIL here rather than merely go unobserved.
    expect(settleSpy).toHaveBeenCalledTimes(1);
    const reArmCall = settleSpy.mock.calls.at(-1)?.[0];
    expect(reArmCall).toMatchObject({ maxAttempts: DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS });
    expect(reArmCall?.proceedNote).toBe(DELETE_INDEX_WAIT_PROCEED_NOTE);
    // The specific regression: reaching for the 15-minute cap that belongs to
    // the sibling's #1521 gate. At this type's budget that is ~3.5h of polling.
    expect(reArmCall?.maxAttempts).not.toBe(900);
  });

  it('the GlobalTable DELETE path re-arms with the shared bound and NOT the auto-scaling note', async () => {
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
 * The ~18.4 min `Table` worst case is only true while the OUTER retry loop in
 * `destroy-runner.ts` invokes `delete()` exactly ONCE for this refusal. That
 * loop runs up to 4 attempts and keys on `isRetryableTransientError`, so adding
 * this message to `RETRYABLE_ERROR_MESSAGE_PATTERNS` would silently take the
 * worst case to ~74 min and blow the 30-min per-resource deadline the budgets
 * are sized against. The module comment asserts that property; this pins it, so the
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
