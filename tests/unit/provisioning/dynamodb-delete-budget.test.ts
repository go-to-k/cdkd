import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeTableCommand,
  DeleteTableCommand,
  UpdateTableCommand,
  ResourceInUseException,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

/**
 * The ONE wall-clock allowance the DynamoDB DELETE path spends (issue #1955).
 *
 * Three terms are pinned here, and the file is organised by them because they
 * are three DIFFERENT defects that one mechanism closes:
 *
 *  1. **Stacked waits** — `waitForReplicaGone` + the #1521 gate + the retry
 *     loop + `waitForTableGone` each held an independent poll cap, so a
 *     replicated GlobalTable reached ~40 min inside a 30-min deadline.
 *  2. **A non-cancelling overshoot** — `withResourceDeadline` rejects without
 *     cancelling, so an overshoot replaced AWS's actionable index-busy sentence
 *     with a generic `ResourceTimeoutError` AND left the loop polling behind
 *     the failed run.
 *  3. **Throttle compounding** — a THROTTLED `DeleteTable` escapes the
 *     index-busy-only inner classifier to `destroy-runner.ts`'s outer loop,
 *     which re-enters `delete()` from the top inside the SAME deadline.
 *
 * Every provider-level test drives an INJECTED clock through
 * `dynamoDbDeleteBudgetOverride`. Real time cannot drain a 26-minute allowance,
 * and `vi.useFakeTimers()` would freeze the providers' own polling loops — so
 * the seam is what makes the DRAINING arms reachable at all.
 */

const { mockSend, mockAutoScalingSend, settleSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
  settleSpy: vi.fn(),
}));

/**
 * Spread the REAL module and wrap ONE export, mirroring
 * `dynamodb-index-busy-delete.test.ts`. The behaviour asserted below is the
 * real implementation's; the wrapper only lets the tests read the poll cap each
 * wait was ACTUALLY given, which is the thing the budget changes.
 */
vi.mock('../../../src/provisioning/dynamodb-index-busy-delete.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/dynamodb-index-busy-delete.js')>();
  return {
    ...actual,
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
  AUTO_SCALING_TEARDOWN_MAX_RETRIES,
  DYNAMODB_DELETE_BUDGET_MS,
  DYNAMODB_DELETE_DEADLINE_MARGIN_MS,
  DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS,
  DYNAMODB_DELETE_POLL_COST_MS,
  DELETE_SHORT_WAIT_POLLS,
  autoScalingRetriesWithinDeleteBudget,
  beginDeleteWait,
  deleteBudgetKey,
  dynamoDbDeleteBudgetOverride,
  pollsWithinDeleteBudget,
  resolveDynamoDbDeleteBudgetClock,
  resolveDynamoDbDeleteBudgetMs,
} from '../../../src/provisioning/providers/dynamodb-delete-budget.js';
import {
  DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS,
  GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
  INDEX_SETTLE_POLL_INTERVAL_MS,
  TABLE_DELETE_INDEX_BUSY_MAX_RETRIES,
} from '../../../src/provisioning/dynamodb-index-busy-delete.js';
// The REAL deadline the budget has to fit inside. IMPORTED, not restated, so
// lowering it reds this suite — a fence has to watch the field it claims.
import { DEFAULT_RESOURCE_TIMEOUT_MS } from '../../../src/deployment/deploy-engine.js';
import {
  ElapsedBudget,
  ElapsedBudgetRegistry,
  monotonicNowMs,
} from '../../../src/utils/elapsed-budget.js';
import type { Logger } from '../../../src/types/config.js';
import {
  DynamoDBGlobalTableProvider,
  GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS,
  TABLE_GONE_WAIT_ATTEMPTS,
  autoScalingRetryDelays,
  deleteTableRetryDelays as globalTableDeleteDelays,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import {
  DynamoDBTableProvider,
  TABLE_ACTIVE_WAIT_ATTEMPTS,
  deleteTableRetryDelays as tableDeleteDelays,
} from '../../../src/provisioning/providers/dynamodb-table-provider.js';

const INDEX_BUSY_MESSAGE =
  'Attempt to change a resource which is still in use: Cannot delete table while ' +
  'indexes are being created, updated, or deleted.';

/** AWS's throttle — the error the inner index-busy classifier deliberately does NOT retry. */
function throttleError(): Error {
  return Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
}

describe('the delete-budget constants (issue #1955)', () => {
  it('leaves the deadline a MARGIN the budget cannot spend', () => {
    // The whole mechanism rests on stopping ourselves BEFORE the deadline
    // fires, because `withResourceDeadline` does not cancel: an overshoot both
    // replaces AWS's own message and leaves the loop polling. So the budget
    // must be strictly smaller than what the providers self-report.
    expect(DYNAMODB_DELETE_BUDGET_MS).toBeLessThan(DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS);
    expect(DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS - DYNAMODB_DELETE_BUDGET_MS).toBe(
      DYNAMODB_DELETE_DEADLINE_MARGIN_MS
    );
    // ...and the margin has to be worth something: the outer retry loop's own
    // backoff alone is 35s, and it elapses between `delete()` calls.
    expect(DYNAMODB_DELETE_DEADLINE_MARGIN_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('does not RAISE the deadline at default settings', () => {
    // The self-report exists to stop a lowered `--resource-timeout` re-creating
    // the crossing, NOT to give DynamoDB a longer deadline than every other
    // type. Equalling the default is what makes `max(30m, 30m)` a no-op.
    expect(DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS).toBe(DEFAULT_RESOURCE_TIMEOUT_MS);
  });

  it('prices a poll ABOVE the bare sleep interval, and derives it from that constant', () => {
    // Pricing a poll at the sleep alone is what once let a ~10.4 min loop be
    // quoted as ~8.8 min: each poll also pays a `DescribeTable` round trip.
    // Reading the interval rather than restating 1000 is what stops the two
    // drifting while this arithmetic claims they agree.
    expect(DYNAMODB_DELETE_POLL_COST_MS).toBeGreaterThan(INDEX_SETTLE_POLL_INTERVAL_MS);
    expect(DYNAMODB_DELETE_POLL_COST_MS % INDEX_SETTLE_POLL_INTERVAL_MS).not.toBe(0.5);
    expect(DYNAMODB_DELETE_POLL_COST_MS).toBe(INDEX_SETTLE_POLL_INTERVAL_MS + 200);
  });

  it('is large enough that no shape completing TODAY starts failing', () => {
    // The sizing claim, as arithmetic rather than as prose. The `Table` single
    // pass (~19.6 min) and the GlobalTable single-region exhausted-budget case
    // (~28.4 min) are the two shapes that fit inside the deadline today; the
    // budget must cover the first outright, and may clamp the second only
    // because that path ends in AWS's own message either way.
    const tableSinglePass = 60 * DYNAMODB_DELETE_POLL_COST_MS + 1_103_000;
    expect(DYNAMODB_DELETE_BUDGET_MS).toBeGreaterThan(tableSinglePass);

    const globalTableSingleRegion = 900 * DYNAMODB_DELETE_POLL_COST_MS + 623_000;
    expect(globalTableSingleRegion).toBeGreaterThan(DYNAMODB_DELETE_BUDGET_MS);
    // ...and the clamp it takes is small — minutes, not most of the path.
    expect(globalTableSingleRegion - DYNAMODB_DELETE_BUDGET_MS).toBeLessThan(5 * 60_000);
  });

  it('the RAW caps still sum past the deadline — which is WHY the budget exists', () => {
    // Issue #1955's arithmetic, kept as a live assertion rather than as a
    // comment. Nothing here shrank: the #1521 gate is still 900 polls and the
    // gone-wait still 600. What changed is that the path no longer SPENDS them
    // independently. If someone "fixes" #1955 by shrinking the caps instead,
    // this reds and the whole design note has to be revisited.
    const gateMs = 900 * DYNAMODB_DELETE_POLL_COST_MS;
    const goneWaitMs = TABLE_GONE_WAIT_ATTEMPTS * DYNAMODB_DELETE_POLL_COST_MS;
    const lateSuccessMs = gateMs + 623_000 + goneWaitMs;
    expect(lateSuccessMs).toBeGreaterThan(DEFAULT_RESOURCE_TIMEOUT_MS);
    // ...and the budget bounds exactly that sum.
    expect(DYNAMODB_DELETE_BUDGET_MS).toBeLessThan(lateSuccessMs);
  });

  it('keeps the two per-type RETRY budgets meaningful rather than replacing them', () => {
    // The budget bounds HOW MUCH there is; the retry counts still shape how it
    // is spent. Asserted so a later "the budget makes these redundant" reads as
    // the behaviour change it would be.
    expect(TABLE_DELETE_INDEX_BUSY_MAX_RETRIES).toBeGreaterThan(
      GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES
    );
  });
});

describe('pollsWithinDeleteBudget', () => {
  it('leaves the cap untouched when there is NO budget (every CREATE / UPDATE caller)', () => {
    // The same waits run on the create / update paths, where the deadline
    // arithmetic this fixes does not apply. An absent budget must be a no-op,
    // or the fix silently shortens unrelated paths.
    expect(pollsWithinDeleteBudget(900, undefined)).toEqual({
      attempts: 900,
      cap: 900,
      clampedByBudget: false,
    });
  });

  it('clamps to what the shared budget can still afford, and SAYS it clamped', () => {
    let t = 0;
    // Deliberately NOT an exact multiple of the poll cost: the remainder is
    // what makes the floor/ceil distinction observable, and both clamp
    // assertions here used to divide evenly, so `Math.floor -> Math.ceil` left
    // the suite green. A budget that affords 20.5 polls affords 20.
    const budget = new ElapsedBudget(120 * DYNAMODB_DELETE_POLL_COST_MS, () => t);
    t += 100 * DYNAMODB_DELETE_POLL_COST_MS - DYNAMODB_DELETE_POLL_COST_MS / 2;

    expect(pollsWithinDeleteBudget(900, budget)).toEqual({
      attempts: 20,
      cap: 900,
      clampedByBudget: true,
    });
    // ...and never ABOVE the caller's own cap — which is NOT a clamp.
    expect(pollsWithinDeleteBudget(5, budget)).toEqual({
      attempts: 5,
      cap: 5,
      clampedByBudget: false,
    });
  });

  it('rounds DOWN, never up — a poll it cannot afford must not be granted', () => {
    let t = 0;
    const budget = new ElapsedBudget(10 * DYNAMODB_DELETE_POLL_COST_MS, () => t);
    // 3.5 polls' worth of allowance left.
    t += 6.5 * DYNAMODB_DELETE_POLL_COST_MS;

    expect(pollsWithinDeleteBudget(900, budget).attempts).toBe(3);
  });
});

describe('autoScalingRetriesWithinDeleteBudget (the unbounded teardown, issue #1955)', () => {
  it('leaves the default schedule alone with no budget, and while it is affordable', () => {
    expect(autoScalingRetriesWithinDeleteBudget(undefined, AUTO_SCALING_TEARDOWN_MAX_RETRIES)).toBe(
      AUTO_SCALING_TEARDOWN_MAX_RETRIES
    );
    const fresh = new ElapsedBudget(DYNAMODB_DELETE_BUDGET_MS, () => 0);
    expect(autoScalingRetriesWithinDeleteBudget(fresh, AUTO_SCALING_TEARDOWN_MAX_RETRIES)).toBe(
      AUTO_SCALING_TEARDOWN_MAX_RETRIES
    );
  });

  it('drops to ZERO retries once the allowance is gone — the call still runs once', () => {
    // The teardown precedes every budgeted poll and is not poll-bounded at all:
    // table-level plus one call per GSI, per non-local replica, each retrying
    // account-wide auto-scaling throttles on `withRetry`'s ~47s schedule. The
    // RETRY is what is bounded; the call itself must still be issued, because
    // skipping it leaks a scalable target a future table of the same name
    // inherits. Zero is therefore the floor here, unlike the polling waits.
    let t = 0;
    const budget = new ElapsedBudget(60_000, () => t);
    t += 120_000;

    expect(autoScalingRetriesWithinDeleteBudget(budget, AUTO_SCALING_TEARDOWN_MAX_RETRIES)).toBe(0);
  });
});

describe('deleteBudgetKey', () => {
  it('qualifies the table name by region', () => {
    // A DynamoDB table name is unique per REGION. A bare-name key lets a table
    // in one region inherit another region's spent allowance, silently.
    expect(deleteBudgetKey('orders', 'us-east-1')).not.toBe(deleteBudgetKey('orders', 'us-west-2'));
    expect(deleteBudgetKey('orders', 'us-east-1')).toBe(deleteBudgetKey('orders', 'us-east-1'));
  });

  it('separates two tables whose names concatenate to the same string', () => {
    // The separator has to be one neither component can contain, or
    // `('a','bc')` and `('ab','c')` collide.
    expect(deleteBudgetKey('b', 'a')).not.toBe(deleteBudgetKey('', 'ab'));
  });

  it('degrades to the bare name for pre-region state rather than failing', () => {
    expect(deleteBudgetKey('orders', undefined)).toContain('orders');
  });
});

describe('the budget seam resolves to production values when unset', () => {
  it('resolves the shipped total and the real clock', () => {
    // The seam is a test affordance; production must not depend on it. A stray
    // leftover from another suite would silently shorten every delete.
    expect(dynamoDbDeleteBudgetOverride.totalMs).toBeUndefined();
    expect(dynamoDbDeleteBudgetOverride.clock).toBeUndefined();
    expect(resolveDynamoDbDeleteBudgetMs()).toBe(DYNAMODB_DELETE_BUDGET_MS);
    // MONOTONIC, not `Date.now`: a forward NTP correction on a wall clock
    // instantly drains the allowance mid-delete, which cuts every remaining
    // wait to its one-poll floor and makes the path report an exhausted budget
    // for something that never happened.
    expect(resolveDynamoDbDeleteBudgetClock()).toBe(monotonicNowMs);
    expect(monotonicNowMs).not.toBe(Date.now);
  });
});

describe('both DynamoDB providers self-report the deadline the budget needs', () => {
  it('AWS::DynamoDB::GlobalTable', () => {
    expect(new DynamoDBGlobalTableProvider().getMinResourceTimeoutMs()).toBe(
      DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS
    );
  });

  it('AWS::DynamoDB::Table', () => {
    expect(new DynamoDBTableProvider().getMinResourceTimeoutMs()).toBe(
      DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS
    );
  });
});

/**
 * The provider-level behaviour. Each block drives a REAL `delete()` with a
 * controllable clock, which is the only way to reach the draining arms.
 */
describe('the DELETE path spends ONE shared allowance (issue #1955)', () => {
  let clock: { now: () => number; advance: (ms: number) => void };

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    settleSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    tableDeleteDelays.sleep = () => Promise.resolve();
    globalTableDeleteDelays.sleep = () => Promise.resolve();

    let t = 1_000_000;
    clock = {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
    };
    dynamoDbDeleteBudgetOverride.clock = clock.now;
  });

  afterEach(() => {
    delete tableDeleteDelays.sleep;
    delete globalTableDeleteDelays.sleep;
    delete dynamoDbDeleteBudgetOverride.clock;
    delete dynamoDbDeleteBudgetOverride.totalMs;
  });

  /**
   * A table whose index is mid-transition, so the #1521 pre-delete gate fires,
   * and whose `DeleteTable` behaves per `onDelete`.
   */
  function stubTable(opts: {
    transitioningIndex?: boolean;
    replicas?: string[];
    /** Polls after which a NON-LOCAL replica drops out of `Replicas[]`. */
    replicaGoneAfterPolls?: number;
    onDelete: () => Promise<unknown>;
  }): { setGone: (gone: boolean) => void } {
    let deleted = false;
    let replicaPolls = 0;
    // Re-armed before every `DeleteTable`, so EACH pass through `delete()` —
    // including a re-entry after a throttle — sees a transitioning index on its
    // PRE-DELETE describe and a settled one on the gate's own first poll.
    let nextDescribeTransitional = opts.transitioningIndex === true;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        // Once `DeleteTable` has succeeded the table is GONE, so
        // `waitForTableGone` returns on its first poll. Without this every test
        // in this block waits out that wait's real 600-poll loop — and a
        // TIMED-OUT test's `delete()` keeps running, feeding `mockSend` calls
        // into whichever test comes next.
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        // Only the PRE-DELETE describe reports a transitioning index, so the
        // #1521 gate is ENTERED and then returns on its very first poll. The
        // tests read the cap the gate was GIVEN (via `settleSpy`), which is
        // what the budget changes; making the index never settle would instead
        // make every test wait out the real poll loop.
        const status = nextDescribeTransitional ? 'UPDATING' : 'ACTIVE';
        nextDescribeTransitional = false;
        replicaPolls += 1;
        // A non-local replica drops out of `Replicas[]` after N polls, so
        // `waitForReplicaGone` RETURNS on a healthy allowance and runs out on a
        // drained one. Without a script it either never returns (the test waits
        // out 600 real polls) or returns immediately (the wait never runs).
        const replicaGone =
          opts.replicaGoneAfterPolls !== undefined && replicaPolls > opts.replicaGoneAfterPolls;
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: status }],
            Replicas: (opts.replicas ?? ['us-east-1'])
              .filter((r) => !(replicaGone && r !== 'us-east-1'))
              .map((r) => ({ RegionName: r, ReplicaStatus: 'ACTIVE' })),
          },
        });
      }
      if (command instanceof DeleteTableCommand) {
        nextDescribeTransitional = opts.transitioningIndex === true;
        return opts.onDelete().then(
          (value) => {
            deleted = true;
            return value;
          },
          (err) => Promise.reject(err)
        );
      }
      if (command instanceof UpdateTableCommand) return Promise.resolve({});
      return Promise.resolve({});
    });
    // Exposed so a test can bring the table BACK. The release-semantics tests
    // need a SECOND `delete()` that actually reaches a budgeted wait; with the
    // table left gone it takes the `ResourceNotFoundException` skip arm before
    // any wait runs, and the assertion then re-reads the FIRST delete's numbers
    // — which is how both of them used to pass with the `release()` calls
    // deleted from the providers.
    return {
      setGone: (gone: boolean) => {
        deleted = gone;
      },
    };
  }

  it('TERM 1: the #1521 gate takes the SHARED remaining budget, not its own 900 polls', async () => {
    // The stacked-waits term. Before the fix the gate always asked for 900
    // polls (~18 min) regardless of what the same deadline had already spent,
    // which is how the path came to be sized three times over.
    //
    // 12 min of a 26-min budget is already gone (one replica's worth of
    // `waitForReplicaGone`), so 14 min remain — 700 polls at ~1.2s, not 900.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    let sawGate = false;
    stubTable({
      transitioningIndex: true,
      onDelete: () => {
        sawGate = true;
        return Promise.resolve({});
      },
    });

    const provider = new DynamoDBGlobalTableProvider();
    // Spend part of the allowance BEFORE `delete()` reaches the gate, the way a
    // replica teardown does. Acquiring first is what the provider itself does;
    // advancing the clock afterwards drains that same entry.
    clock.advance(0);
    const pending = (async () => {
      const p = provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {});
      // The budget is acquired synchronously at the top of `delete()`, so this
      // advance lands inside it.
      clock.advance(12 * 60_000);
      return p;
    })();
    await pending;

    expect(sawGate).toBe(true);
    const gateCall = settleSpy.mock.calls.at(0)?.[0];
    expect(gateCall).toBeDefined();
    // The regression this replaces: a flat 900 regardless of what was spent.
    expect(gateCall?.maxAttempts).not.toBe(900);
    expect(gateCall?.maxAttempts).toBe(
      Math.floor((26 * 60_000 - 12 * 60_000) / DYNAMODB_DELETE_POLL_COST_MS)
    );
  });

  it('TERM 1: the gate keeps its FULL cap while the budget can afford it', async () => {
    // The other half of the same fence: the clamp must not fire on the common
    // shape. A budget-aware wait that always shortened would be a regression
    // dressed as a fix.
    stubTable({ transitioningIndex: true, onDelete: () => Promise.resolve({}) });

    await new DynamoDBGlobalTableProvider().delete(
      'Warm',
      'shared-table',
      'AWS::DynamoDB::GlobalTable',
      {}
    );

    expect(settleSpy.mock.calls.at(0)?.[0]?.maxAttempts).toBe(900);
  });

  it('TERM 2: an exhausted budget stops the retry loop with AWS`s OWN message', async () => {
    // The non-cancelling-overshoot term, and the reason the loop stops itself
    // rather than letting the deadline fire: `withResourceDeadline` rejects
    // with a generic `ResourceTimeoutError` that never mentions indexes, while
    // this loop keeps issuing `DeleteTable` behind the failed run.
    //
    // The budget is spent by the time the first refusal lands, so the loop must
    // treat the refusal as TERMINAL after ONE attempt — 1, not 1 + 8.
    dynamoDbDeleteBudgetOverride.totalMs = 60_000;
    let deletes = 0;
    stubTable({
      onDelete: () => {
        deletes += 1;
        clock.advance(120_000); // the allowance is gone
        return Promise.reject(new ResourceInUseException({ message: INDEX_BUSY_MESSAGE, $metadata: {} }));
      },
    });

    await expect(
      new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {}
      )
    ).rejects.toThrow(/Cannot delete table while indexes are being/);

    // ONE attempt, not `1 + GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES`.
    expect(deletes).toBe(1);
  });

  it('TERM 2: the SIBLING type stops the same way', async () => {
    // Pinned per type rather than assumed shared: the two providers wire the
    // predicate at their own call sites, so one can be wired and the other not.
    dynamoDbDeleteBudgetOverride.totalMs = 60_000;
    let deletes = 0;
    stubTable({
      onDelete: () => {
        deletes += 1;
        clock.advance(120_000);
        return Promise.reject(new ResourceInUseException({ message: INDEX_BUSY_MESSAGE, $metadata: {} }));
      },
    });

    await expect(
      new DynamoDBTableProvider().delete('Orders', 'shared-table', 'AWS::DynamoDB::Table', {})
    ).rejects.toThrow(/Cannot delete table while indexes are being/);

    expect(deletes).toBe(1);
  });

  it('TERM 2: a budget with time LEFT still spends the full retry count', async () => {
    // The discriminating half. Without it the test above would pass for a loop
    // that simply stopped retrying at all.
    let deletes = 0;
    stubTable({
      onDelete: () => {
        deletes += 1;
        return Promise.reject(new ResourceInUseException({ message: INDEX_BUSY_MESSAGE, $metadata: {} }));
      },
    });

    await expect(
      new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {}
      )
    ).rejects.toThrow(/Cannot delete table while indexes are being/);

    expect(deletes).toBe(1 + GLOBAL_TABLE_DELETE_INDEX_BUSY_MAX_RETRIES);
  });

  it('TERM 3: a re-entry after a THROTTLE continues the SAME allowance', async () => {
    // The compounding term. `destroy-runner.ts` classes a throttle as retryable
    // and re-enters `delete()` from the top INSIDE the same deadline, so a
    // per-call budget would hand the second pass a fresh 26 minutes and the
    // pair would reach ~39 min inside 30.
    //
    // First pass: burn 20 of 26 minutes, then throttle. Second pass: the gate
    // must see the REMAINING 6 minutes, not a fresh allowance.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    let deletes = 0;
    stubTable({
      transitioningIndex: true,
      onDelete: () => {
        deletes += 1;
        if (deletes === 1) {
          clock.advance(20 * 60_000);
          return Promise.reject(throttleError());
        }
        return Promise.resolve({});
      },
    });

    const provider = new DynamoDBGlobalTableProvider();
    // A throttle is NOT the index-busy refusal, so the inner loop rethrows it —
    // which is exactly how it escapes to the outer loop in production.
    await expect(
      provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {})
    ).rejects.toThrow(/Rate exceeded/);

    // The outer loop's own re-entry, on the SAME provider instance and the same
    // physical id.
    await provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {});

    const secondPassGate = settleSpy.mock.calls.at(-1)?.[0];
    expect(secondPassGate).toBeDefined();
    // Without the shared registry this is 900 (a fresh allowance).
    expect(secondPassGate?.maxAttempts).not.toBe(900);
    expect(secondPassGate?.maxAttempts).toBe(
      Math.floor((26 * 60_000 - 20 * 60_000) / DYNAMODB_DELETE_POLL_COST_MS)
    );
  });

  it('TERM 3: a SUCCESSFUL delete releases the allowance, so a later one starts fresh', async () => {
    // The other side of retaining on failure: an entry kept after a terminal
    // success would starve any later delete of the same physical id.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    const stub = stubTable({ transitioningIndex: true, onDelete: () => Promise.resolve({}) });

    const provider = new DynamoDBGlobalTableProvider();
    await provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {});
    const afterFirst = settleSpy.mock.calls.length;
    clock.advance(20 * 60_000);
    // The table EXISTS again (a re-created table, or a second destroy run
    // through the same provider instance). Without this the second `delete()`
    // takes the already-gone skip arm and never reaches the gate at all, and
    // the assertion below silently re-reads the first delete's 900 — which is
    // exactly what let this test pass with the `release()` calls removed.
    stub.setGone(false);
    await provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {});

    // The second delete REACHED the gate, so the number below is its own.
    expect(settleSpy.mock.calls.length).toBe(afterFirst + 1);
    // A retained entry would leave only 6 minutes and clamp this to 300.
    expect(settleSpy.mock.calls.at(-1)?.[0]?.maxAttempts).toBe(900);
  });

  it('the re-arm ALSO draws from the shared budget', async () => {
    // The re-arm runs PER RETRY, so it is the term whose product dominates the
    // loop. It keeps its own 60-poll bound while the budget can afford it, and
    // is clamped when it cannot — the same rule as the gate, asserted here
    // because the two are wired at different call sites.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    let deletes = 0;
    stubTable({
      onDelete: () => {
        deletes += 1;
        if (deletes === 1) {
          clock.advance(26 * 60_000 - 30_000); // 30s left -> 25 polls at ~1.2s
          return Promise.reject(new ResourceInUseException({ message: INDEX_BUSY_MESSAGE, $metadata: {} }));
        }
        return Promise.resolve({});
      },
    });

    await new DynamoDBGlobalTableProvider().delete(
      'Warm',
      'shared-table',
      'AWS::DynamoDB::GlobalTable',
      {}
    );

    const reArm = settleSpy.mock.calls.at(-1)?.[0];
    expect(reArm).toBeDefined();
    expect(reArm?.maxAttempts).not.toBe(DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS);
    expect(reArm?.maxAttempts).toBe(Math.floor(30_000 / DYNAMODB_DELETE_POLL_COST_MS));
  });

  it('the gone-wait draws from it too — one poll, not the 600 its own cap allows', async () => {
    // `waitForTableGone` runs LAST and only on a late loop SUCCESS, which is
    // exactly why it was the term that pushed the single-region shape to
    // ~40.4 min. This pins the CLAMP; what a clamped exhaustion then DOES
    // (warn, not throw — the delete was already accepted) is pinned separately.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    let describes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        describes += 1;
        // The table never disappears, so the gone-wait runs to whatever cap it
        // was actually given.
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) {
        clock.advance(26 * 60_000); // the allowance is gone by the time it returns
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await expect(
      new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {}
      )
    ).resolves.toBeUndefined();

    // The pre-delete describe plus the ONE poll the exhausted budget still
    // grants — not the 600 the raw cap would have spent.
    expect(describes).toBe(2);
  });

  it('a table already GONE releases the allowance rather than retaining it', async () => {
    // The idempotent skip arm is terminal too. Retaining there would starve a
    // later delete of the same id for no reason.
    //
    // Asserting only that the second call RESOLVES proves nothing: the skip arm
    // returns before any budgeted wait, so it resolves either way. The second
    // call has to reach a budgeted wait and report a FULL cap.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    const stub = stubTable({ transitioningIndex: true, onDelete: () => Promise.resolve({}) });
    stub.setGone(true);

    const provider = new DynamoDBGlobalTableProvider();
    await provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {});
    // Nothing was waited on — the skip arm fired.
    expect(settleSpy).not.toHaveBeenCalled();

    clock.advance(26 * 60_000);
    stub.setGone(false);
    await provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {});

    // A retained (and by now fully drained) entry clamps this to the one-poll
    // floor; a released one leaves the gate its own cap.
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(settleSpy.mock.calls.at(-1)?.[0]?.maxAttempts).toBe(900);
  });
});

/**
 * The terms a first pass at issue #1955 left unbudgeted, plus the release and
 * keying semantics that had no discriminating coverage.
 *
 * Own hooks rather than the previous block's: isolation that depends on
 * declaration ORDER breaks silently the moment a test is inserted above.
 */
describe('every wait on the DELETE path draws from the allowance (issue #1955)', () => {
  let clock: { now: () => number; advance: (ms: number) => void };

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    settleSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    tableDeleteDelays.sleep = () => Promise.resolve();
    globalTableDeleteDelays.sleep = () => Promise.resolve();

    let t = 1_000_000;
    clock = {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
    };
    dynamoDbDeleteBudgetOverride.clock = clock.now;
  });

  afterEach(() => {
    delete tableDeleteDelays.sleep;
    delete globalTableDeleteDelays.sleep;
    delete dynamoDbDeleteBudgetOverride.clock;
    delete dynamoDbDeleteBudgetOverride.totalMs;
  });

  /**
   * A table whose `--remove-protection` ACTIVE wait needs `activeAtPoll`
   * describes before it reports settled, recording how many the wait actually
   * spent before `DeleteTable` was issued.
   *
   * The poll COUNT is the only observable here — the wait is private, its
   * exhaustion is swallowed by the caller's debug arm, and it goes through no
   * spy — so the stub scripts a table that becomes ready on a known poll and
   * the tests read how far the wait got.
   */
  function stubProtectionFlip(opts: { activeAtPoll: number; globalTable: boolean }): {
    pollsBeforeDelete: () => number;
  } {
    let describes = 0;
    let pollsBeforeDelete = -1;
    let deleted = false;
    let observedProtection = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        // Post-delete, the table is GONE so `waitForTableGone` returns at once.
        // A stub that keeps reporting it makes every test here wait out that
        // wait's real 600-poll cap and time out.
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        // The FIRST describe is the issue-#1978 pre-flip OBSERVATION, not a
        // poll of the ACTIVE wait this fixture measures. It is deliberately
        // uncounted: counting it would shift `activeAtPoll` off the wait it
        // names, and the clamped cases (which expect the ONE-poll floor) would
        // read 2 while measuring the same single poll.
        if (!observedProtection) {
          observedProtection = true;
          return Promise.resolve({
            Table: {
              TableName: 'shared-table',
              TableStatus: 'ACTIVE',
              DeletionProtectionEnabled: true,
              GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
              Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
            },
          });
        }
        describes += 1;
        const ready = describes >= opts.activeAtPoll;
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            // TABLE STATUS is the only thing gating the flip wait here. The
            // indexes are left ACTIVE so the #1521 gate does not fire and add
            // describes of its own — this fixture is about ONE wait.
            TableStatus: ready ? 'ACTIVE' : 'UPDATING',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) {
        if (pollsBeforeDelete < 0) {
          // The GlobalTable path takes ONE extra describe between the flip wait
          // and the delete (its pre-delete describe); the Table path takes none.
          pollsBeforeDelete = describes - (opts.globalTable ? 1 : 0);
        }
        deleted = true;
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    return { pollsBeforeDelete: () => pollsBeforeDelete };
  }

  const REMOVE_PROTECTION = { removeProtection: true } as const;

  /**
   * A table whose PRE-DELETE describe reports a transitioning index — so the
   * #1521 gate is entered and its cap is observable through `settleSpy` — and
   * whose gate poll then reports it settled, so the gate returns at once
   * instead of running out its real cap in real time.
   */
  function stubGatedTable(): void {
    // Gone-ness is tracked PER TABLE NAME. A single flag makes the second
    // `delete()` in a two-table test take the already-gone skip arm, which
    // never reaches the gate — and `.at(-1)` then silently re-reads the FIRST
    // table's cap, which is how a shared-key regression would pass.
    const deleted = new Set<string>();
    let nextDescribeTransitional = true;
    mockSend.mockImplementation((command: unknown) => {
      const name = (command as { input?: { TableName?: string } }).input?.TableName ?? '';
      if (command instanceof DeleteTableCommand) {
        deleted.add(name);
        nextDescribeTransitional = true;
        return Promise.resolve({});
      }
      if (command instanceof DescribeTableCommand) {
        if (deleted.has(name)) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        const status = nextDescribeTransitional ? 'UPDATING' : 'ACTIVE';
        nextDescribeTransitional = false;
        return Promise.resolve({
          Table: {
            TableName: 'any-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: status }],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      return Promise.resolve({});
    });
  }

  it('BLOCKER 1: the GlobalTable --remove-protection ACTIVE wait is CLAMPED when the allowance is short', async () => {
    // It runs FIRST, at t=0, and its predicate is ACTIVE *and* no transitional
    // index — the very condition the rest of the path is about — so unbudgeted
    // it spends its full ~12 min before the #1521 gate has looked once. On a
    // throttle re-entry it starts already drained and polls another 600 times,
    // reinstating the exact non-cancelling overshoot the fix removes.
    dynamoDbDeleteBudgetOverride.totalMs = 60_000;
    const stub = stubProtectionFlip({ activeAtPoll: 3, globalTable: true });
    clock.advance(0);

    const pending = (async () => {
      const p = new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {},
        REMOVE_PROTECTION
      );
      // The allowance is acquired synchronously at the top of `delete()`, so
      // this drains the entry the flip wait is about to read.
      clock.advance(120_000);
      return p;
    })();
    await pending;

    // ONE poll (the floor), not the three the table needed or the 600 it may.
    expect(stub.pollsBeforeDelete()).toBe(1);
  });

  it('BLOCKER 1: ...and keeps its FULL cap when the allowance can afford it', async () => {
    // The discriminating half: a clamp that always fired would be a regression
    // dressed as a fix, and would pass the assertion above.
    const stub = stubProtectionFlip({ activeAtPoll: 3, globalTable: true });

    await new DynamoDBGlobalTableProvider().delete(
      'Warm',
      'shared-table',
      'AWS::DynamoDB::GlobalTable',
      {},
      REMOVE_PROTECTION
    );

    expect(stub.pollsBeforeDelete()).toBe(3);
    expect(GLOBAL_TABLE_ACTIVE_WAIT_ATTEMPTS).toBeGreaterThan(3);
  });

  it('G3: the Table --remove-protection ACTIVE wait is clamped too', async () => {
    // The twin of BLOCKER 1. One side was budgeted in the first revision and
    // the other was not, so both are pinned rather than one standing for both.
    dynamoDbDeleteBudgetOverride.totalMs = 60_000;
    const stub = stubProtectionFlip({ activeAtPoll: 3, globalTable: false });

    const pending = (async () => {
      const p = new DynamoDBTableProvider().delete(
        'Orders',
        'shared-table',
        'AWS::DynamoDB::Table',
        {},
        REMOVE_PROTECTION
      );
      clock.advance(120_000);
      return p;
    })();
    await pending;

    expect(stub.pollsBeforeDelete()).toBe(1);
  });

  it('G3: ...and keeps its FULL cap when the allowance can afford it', async () => {
    const stub = stubProtectionFlip({ activeAtPoll: 3, globalTable: false });

    await new DynamoDBTableProvider().delete(
      'Orders',
      'shared-table',
      'AWS::DynamoDB::Table',
      {},
      REMOVE_PROTECTION
    );

    expect(stub.pollsBeforeDelete()).toBe(3);
    expect(TABLE_ACTIVE_WAIT_ATTEMPTS).toBeGreaterThan(3);
  });

  /**
   * A GlobalTable with a NON-LOCAL replica that drops out of `Replicas[]` after
   * `replicaGoneAtPoll` describes — so `waitForReplicaGone` genuinely runs, and
   * genuinely returns, rather than being skipped (a local-only replica list) or
   * never terminating (a replica that never leaves).
   */
  function stubReplicatedTable(opts: { replicaGoneAtPoll: number }): void {
    let describes = 0;
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteTableCommand) {
        deleted = true;
        return Promise.resolve({});
      }
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        describes += 1;
        const replicas = [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }];
        if (describes < opts.replicaGoneAtPoll) {
          replicas.push({ RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' });
        }
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
            Replicas: replicas,
          },
        });
      }
      return Promise.resolve({});
    });
  }

  it('G1: waitForReplicaGone draws from the allowance — the headline stacked-wait term', async () => {
    // 600 polls (~12 min) PER non-local replica is what makes the issue's ~40
    // min replicated shape, and it was the one term with no test at all: the
    // shared stub only ever carried a LOCAL replica, so the wait never ran.
    //
    // Drained: the wait gets its one-poll floor, the replica is still listed,
    // and it throws — naming the allowance rather than blaming AWS.
    dynamoDbDeleteBudgetOverride.totalMs = 60_000;
    stubReplicatedTable({ replicaGoneAtPoll: 4 });

    const pending = (async () => {
      const p = new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {}
      );
      clock.advance(120_000);
      return p;
    })();

    await expect(pending).rejects.toThrow(/Replica us-west-2 .* did not disappear within 1s/);
    // BLOCKER 3(a): the count is the CLAMPED one, so the message has to say
    // which clock ended the wait. "did not disappear within 1s" alone reads as
    // an AWS failure after cdkd waited the whole allowance.
    await expect(pending).rejects.toThrow(/delete allowance was already spent/);
    // ...and it quotes the ACTUAL allowance (60s here), not the shipped 26-min
    // constant, which the seam would otherwise make it misreport.
    await expect(pending).rejects.toThrow(/~1-minute delete allowance/);
  });

  it('G1: ...and keeps its FULL cap when the allowance can afford it', async () => {
    // Same fixture, healthy allowance: the wait runs past the floor, sees the
    // replica leave, and the delete completes.
    stubReplicatedTable({ replicaGoneAtPoll: 3 });

    await expect(
      new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {}
      )
    ).resolves.toBeUndefined();
  });

  it('SHOULD-FIX 4: a replica-wait failure is NOT reported as a describe failure', async () => {
    // The replica teardown runs inside the `try` whose `catch` wraps everything
    // in `Failed to describe ... before delete`, so an exhausted replica wait
    // surfaced as a describe failure that never happened — while the real
    // residue (a replica removal in flight, the local auto-scaling teardown
    // skipped, no DeleteTable issued) went unnamed.
    dynamoDbDeleteBudgetOverride.totalMs = 60_000;
    stubReplicatedTable({ replicaGoneAtPoll: 4 });

    const pending = (async () => {
      const p = new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {}
      );
      clock.advance(120_000);
      return p;
    })();

    await expect(pending).rejects.toThrow(/Replica us-west-2/);
    await expect(pending).rejects.not.toThrow(/Failed to describe/);
  });

  it('BLOCKER 3(b): a gone-wait cut short by the ALLOWANCE warns — it does not fail an accepted delete', async () => {
    // `DeleteTable` has already returned 200 by the time this wait runs, so the
    // deletion is no longer in cdkd's hands and WILL complete. Throwing because
    // cdkd's own allowance ran out turns an accepted delete into a reported
    // FAILURE with state preserved — the user re-runs a destroy for a table AWS
    // already deleted.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    const warns: string[] = [];
    const provider = new DynamoDBGlobalTableProvider();
    // A COMPLETE logger, not a spread of the real one: the provider's logger is
    // a class instance, so spreading it drops every prototype method and the
    // first `logger.debug` call throws.
    (provider as unknown as { logger: Logger }).logger = {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    };

    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        // The table never disappears within the wait it is given.
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) {
        clock.advance(26 * 60_000);
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    await expect(
      provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {})
    ).resolves.toBeUndefined();
    expect(warns.some((w) => w.includes('was ACCEPTED by AWS'))).toBe(true);
    expect(
      warns.some((w) => w.includes("shared ~26-minute delete allowance was already spent"))
    ).toBe(true);
  });

  it('BLOCKER 3(b): ...while a gone-wait that spent its REAL cap still fails hard', async () => {
    // The discriminating half, and the reason the downgrade is scoped rather
    // than blanket: twelve real minutes of polling with the table still present
    // is a different claim — something is actually wrong — and keeps the hard
    // error it had before this change.
    let describes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        describes += 1;
        return Promise.resolve({
          Table: { TableName: 'shared-table', TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [] },
        });
      }
      return Promise.resolve({});
    });

    const provider = new DynamoDBGlobalTableProvider();
    // Called directly with a small cap and NO budget: the raw-cap exhaustion is
    // the arm under test, and driving it through `delete()` would mean waiting
    // out the real 600-poll cap.
    await expect(
      (
        provider as unknown as {
          waitForTableGone: (t: string, l: string, m?: number) => Promise<void>;
        }
      ).waitForTableGone('shared-table', 'Warm', 3)
    ).rejects.toThrow(/did not disappear within 3s/);
    expect(describes).toBe(3);
  });

  it('G2: the Table path RETAINS the allowance on a throw — the compounding term is ITS term', async () => {
    // #1955's third term is specifically about `AWS::DynamoDB::Table`
    // (2 x ~19.6 min after #1950 raised its retry budget to 14), and that was
    // the one type with no retain-on-throw test: the GlobalTable arm stood in
    // for both, so a `release()` added before the Table throw went unnoticed.
    //
    // Pass 1 burns all but 30s and throttles. Pass 2's re-arm must see those
    // 30s (25 polls at ~1.2s), not a fresh 60-poll cap.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    let deletes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
          },
        });
      }
      if (command instanceof DeleteTableCommand) {
        deletes += 1;
        if (deletes === 1) {
          clock.advance(26 * 60_000 - 30_000);
          return Promise.reject(throttleError());
        }
        if (deletes === 2) {
          return Promise.reject(
            new ResourceInUseException({ message: INDEX_BUSY_MESSAGE, $metadata: {} })
          );
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });

    const provider = new DynamoDBTableProvider();
    // A throttle is not the index-busy refusal, so the inner loop rethrows it —
    // which is how it reaches `destroy-runner.ts`'s outer loop in production.
    await expect(
      provider.delete('Orders', 'shared-table', 'AWS::DynamoDB::Table', {})
    ).rejects.toThrow(/Rate exceeded/);

    // The outer loop's re-entry, same instance, same physical id.
    await provider.delete('Orders', 'shared-table', 'AWS::DynamoDB::Table', {});

    const reArm = settleSpy.mock.calls.at(-1)?.[0];
    expect(reArm).toBeDefined();
    // A released (i.e. fresh) allowance would give the re-arm its full cap.
    expect(reArm?.maxAttempts).not.toBe(DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS);
    expect(reArm?.maxAttempts).toBe(Math.floor(30_000 / DYNAMODB_DELETE_POLL_COST_MS));
    // BLOCKER 3(a): the re-arm hands the settle loop the WAIT, not just a
    // count, so the loop re-checks the allowance per poll and owns its own
    // give-up wording rather than reading as an AWS timeout.
    expect(reArm?.budgetWait).toBeDefined();
    expect(reArm?.budgetWait?.cap).toBe(DELETE_INDEX_BUSY_REARM_MAX_ATTEMPTS);
    expect(reArm?.budgetWait?.note()).toContain('delete allowance');
  });

  it('G4: two tables through ONE provider instance get SEPARATE allowances', async () => {
    // `destroy-runner.ts` deletes a level's resources concurrently through one
    // provider instance. A constant (or shared) registry key would make the
    // second table inherit the first's spent allowance, silently. The registry
    // suite fences the REGISTRY's keying; this fences the key the PROVIDER
    // actually passes.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    stubGatedTable();

    const provider = new DynamoDBGlobalTableProvider();
    const first = (async () => {
      const p = provider.delete('A', 'orders-table', 'AWS::DynamoDB::GlobalTable', {});
      clock.advance(20 * 60_000);
      return p;
    })();
    await first;
    // The gate on the FIRST table saw the allowance drain under it.
    const firstGate = settleSpy.mock.calls.at(-1)?.[0]?.maxAttempts as number;

    const afterFirst = settleSpy.mock.calls.length;
    await provider.delete('B', 'events-table', 'AWS::DynamoDB::GlobalTable', {});
    // The second delete REACHED its own gate, so the cap below is its own and
    // not a re-read of the first table's.
    expect(settleSpy.mock.calls.length).toBe(afterFirst + 1);
    const secondGate = settleSpy.mock.calls.at(-1)?.[0]?.maxAttempts as number;

    // A shared key would hand table B table A's remaining ~6 minutes.
    expect(secondGate).toBe(900);
    expect(firstGate).toBeLessThan(secondGate);
  });

  it('G4: ...and the key is REGION-qualified, since a table name is unique per region', async () => {
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    stubGatedTable();

    const provider = new DynamoDBGlobalTableProvider();
    const first = (async () => {
      const p = provider.delete('A', 'orders-table', 'AWS::DynamoDB::GlobalTable', {}, {
        expectedRegion: 'us-east-1',
      });
      clock.advance(20 * 60_000);
      return p;
    })();
    await first;

    const afterFirst = settleSpy.mock.calls.length;
    // SAME physical id, DIFFERENT region: a distinct table, and a distinct
    // allowance. Re-stubbed so the name is live again — the two regions hold
    // genuinely different tables, which is the whole premise.
    stubGatedTable();
    await provider.delete('A', 'orders-table', 'AWS::DynamoDB::GlobalTable', {}, {
      expectedRegion: 'us-west-2',
    });

    expect(settleSpy.mock.calls.length).toBe(afterFirst + 1);
    expect(settleSpy.mock.calls.at(-1)?.[0]?.maxAttempts).toBe(900);
  });

  it('BLOCKER 2: the auto-scaling teardown stops paying retries once the allowance is gone', async () => {
    // It runs BEFORE the first budgeted poll, is not poll-bounded at all, and
    // retries account-wide throttles on `withRetry`'s ~47s schedule per call —
    // table-level plus one per GSI, per non-local replica. A drained allowance
    // must buy the retries down to zero while STILL issuing every call, since
    // skipping leaks a scalable target a future table of the same name
    // inherits.
    dynamoDbDeleteBudgetOverride.totalMs = 60_000;
    let asCalls = 0;
    mockAutoScalingSend.mockImplementation(() => {
      asCalls += 1;
      return Promise.resolve({ ScalableTargets: [], ScalingPolicies: [] });
    });
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteTableCommand) {
        deleted = true;
        return Promise.resolve({});
      }
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      return Promise.resolve({});
    });

    const pending = (async () => {
      const p = new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {}
      );
      clock.advance(120_000);
      return p;
    })();
    await pending;

    // The calls were still ISSUED — the leak-prevention is intact.
    expect(asCalls).toBeGreaterThan(0);
    // ...and the retry budget they were given is zero.
    expect(autoScalingRetriesWithinDeleteBudget(new ElapsedBudget(1, () => 0), 8)).toBe(0);
  });
});

/**
 * The allowance as an actual BOUND rather than a prediction, and the two places
 * the previous round left it decided by arithmetic instead of by evidence.
 */
describe('the allowance is enforced per POLL, not only at wait entry (issue #1955)', () => {
  let clock: { now: () => number; advance: (ms: number) => void };

  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    settleSpy.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    tableDeleteDelays.sleep = () => Promise.resolve();
    globalTableDeleteDelays.sleep = () => Promise.resolve();
    autoScalingRetryDelays.sleep = () => Promise.resolve();

    let t = 1_000_000;
    clock = {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
    };
    dynamoDbDeleteBudgetOverride.clock = clock.now;
  });

  afterEach(() => {
    delete tableDeleteDelays.sleep;
    delete globalTableDeleteDelays.sleep;
    delete autoScalingRetryDelays.sleep;
    delete dynamoDbDeleteBudgetOverride.clock;
    delete dynamoDbDeleteBudgetOverride.totalMs;
  });

  it('breaks out mid-loop when a poll costs MORE than the grant predicted', async () => {
    // The defect this closes: `attemptsWithin` prices a poll at ~1.2s and the
    // grant was then treated as a bound. It is not one. Under sustained
    // `DescribeTable` throttling the SDK's own internal retries push a poll to
    // ~3s, so a wait entered with 12.1 min of allowance left is granted its
    // full 600 polls and runs for ~30 min — past the allowance AND past the
    // margin, with `withResourceDeadline` firing behind it. That is term T2
    // returning through the mechanism built to remove it.
    //
    // Here every poll costs 10x its prediction. The wait is granted many polls
    // and must still stop after a handful, once the allowance is actually gone.
    dynamoDbDeleteBudgetOverride.totalMs = 20 * DYNAMODB_DELETE_POLL_COST_MS;
    let describes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        describes += 1;
        // A poll that costs ten times what the grant assumed.
        clock.advance(10 * DYNAMODB_DELETE_POLL_COST_MS);
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
            Replicas: [
              { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
              { RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    await expect(
      new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {}
      )
    ).rejects.toThrow(/Replica us-west-2/);

    // Entry granted 20 polls; the real cost stopped it at ~3 (the pre-delete
    // describe, then two replica polls). WITHOUT the in-loop check this runs
    // all 20 and burns ten times the allowance.
    expect(describes).toBeLessThanOrEqual(5);
    expect(describes).toBeGreaterThanOrEqual(2);
  });

  it('...but the one-poll FLOOR survives an allowance that is already spent', async () => {
    // The in-loop check must not eat the floor: a loop that broke before its
    // first probe would report "did not settle" without ever having looked.
    dynamoDbDeleteBudgetOverride.totalMs = 60_000;
    let replicaPolls = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        replicaPolls += 1;
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
            Replicas: [
              { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
              { RegionName: 'us-west-2', ReplicaStatus: 'ACTIVE' },
            ],
          },
        });
      }
      return Promise.resolve({});
    });

    const pending = (async () => {
      const p = new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {}
      );
      clock.advance(120_000);
      return p;
    })();
    await expect(pending).rejects.toThrow(/did not disappear within 1s/);

    // The pre-delete describe plus exactly ONE replica probe — not zero.
    expect(replicaPolls).toBe(2);
  });

  it('the SETTLE loop re-checks it too, and reports the polls it RAN', async () => {
    // The #1521 gate and the index-busy re-arm both go through
    // `waitForIndexesSettled`, which lives in the shared module and takes the
    // wait structurally. Its give-up warning must count polls RUN, since the
    // loop can now stop before its grant.
    dynamoDbDeleteBudgetOverride.totalMs = 30 * DYNAMODB_DELETE_POLL_COST_MS;
    const warns: string[] = [];
    const provider = new DynamoDBGlobalTableProvider();
    (provider as unknown as { logger: Logger }).logger = {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    };
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        clock.advance(10 * DYNAMODB_DELETE_POLL_COST_MS);
        // The index NEVER settles, so only the allowance can end this wait.
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'UPDATING' }],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      return Promise.resolve({});
    });

    await provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {});

    const giveUp = warns.find((w) => w.includes('did not all reach ACTIVE'));
    expect(giveUp).toBeDefined();
    // It ran a couple of polls, not the 30 it was granted...
    expect(giveUp).not.toContain('within 30 DescribeTable polls');
    // ...and it says the allowance ended it, so this cannot read as AWS
    // failing to settle.
    expect(giveUp).toContain('delete allowance');
  });

  it('SHOULD-FIX: a LONG wait ended by the allowance still throws — the floor decides, not `attempts < cap`', async () => {
    // Before the floor existed the split was `attempts < cap`, so with ~14 min
    // of the allowance spent a 600-poll gone-wait was granted ~500 polls — ten
    // real minutes of `DescribeTable` — and that WARNED and dropped state,
    // while the code's own comment called twelve minutes "something is actually
    // wrong". Two minutes of wall clock is not a principled line.
    //
    // Here the wait is granted more than the floor and runs it out, so it
    // throws even though the allowance is what capped it.
    const provider = new DynamoDBGlobalTableProvider();
    const budget = new ElapsedBudget(
      (DELETE_SHORT_WAIT_POLLS + 10) * DYNAMODB_DELETE_POLL_COST_MS,
      () => 1_000_000
    );
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        return Promise.resolve({
          Table: { TableName: 'shared-table', TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [] },
        });
      }
      return Promise.resolve({});
    });

    // FAKE timers: the wait must run PAST the 60-poll floor for this arm to be
    // the arm under test, and 60+ real one-second sleeps would time the test
    // out. The budget's own clock is the injected closure above, so it is
    // unaffected by the fake timers and stays deliberately frozen — this arm is
    // about the ENTRY grant (70 polls) being above the floor, not about the
    // in-loop break.
    vi.useFakeTimers();
    try {
      const pending = (
        provider as unknown as {
          waitForTableGone: (
            t: string,
            l: string,
            m?: number,
            b?: ElapsedBudget
          ) => Promise<void>;
        }
      ).waitForTableGone('shared-table', 'Warm', 600, budget);
      const settled = expect(pending).rejects.toThrow(/did not disappear/);
      await vi.advanceTimersByTimeAsync((DELETE_SHORT_WAIT_POLLS + 20) * 1000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('SHOULD-FIX: ...while a wait cut BELOW the floor warns', async () => {
    // The other side of the same line, driven through the same method so the
    // pair differs only in how much wait the allowance actually bought.
    const warns: string[] = [];
    const provider = new DynamoDBGlobalTableProvider();
    (provider as unknown as { logger: Logger }).logger = {
      debug: () => {},
      info: () => {},
      warn: (m: string) => warns.push(m),
      error: () => {},
    };
    let t = 1_000_000;
    const budget = new ElapsedBudget(60_000, () => t);
    t += 120_000;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        return Promise.resolve({
          Table: { TableName: 'shared-table', TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [] },
        });
      }
      return Promise.resolve({});
    });

    await expect(
      (
        provider as unknown as {
          waitForTableGone: (
            t: string,
            l: string,
            m?: number,
            b?: ElapsedBudget
          ) => Promise<void>;
        }
      ).waitForTableGone('shared-table', 'Warm', 600, budget)
    ).resolves.toBeUndefined();
    expect(warns.some((w) => w.includes('was ACCEPTED by AWS'))).toBe(true);
  });

  it('NIT: no "allowance was already spent" note on a wait that was actually performed', async () => {
    // The strong note claims AWS was not given a real wait. On a 500-of-600
    // wait that is false, and the note's own advice ("re-run the destroy") is
    // wrong. Above the floor it degrades to a factual capped-at clause.
    const longWait = beginDeleteWait(
      600,
      new ElapsedBudget((DELETE_SHORT_WAIT_POLLS + 10) * DYNAMODB_DELETE_POLL_COST_MS, () => 0)
    );
    while (longWait.nextPoll()) {
      /* run it out */
    }
    expect(longWait.endedByBudget).toBe(true);
    expect(longWait.cutShort).toBe(false);
    expect(longWait.note()).not.toContain('was already spent');
    expect(longWait.note()).not.toContain('re-run the destroy');
    expect(longWait.note()).toContain('capped this wait');

    let t = 0;
    const drained = new ElapsedBudget(60_000, () => t);
    t += 120_000;
    const shortWait = beginDeleteWait(600, drained);
    while (shortWait.nextPoll()) {
      /* one poll, the floor */
    }
    expect(shortWait.cutShort).toBe(true);
    expect(shortWait.note()).toContain('was already spent');
    // ...and it quotes the REAL allowance, not the shipped constant.
    expect(shortWait.note()).toContain('~1-minute');
  });

  it('BLOCKER 2 redo: the auto-scaling TEARDOWN retries throttles, bounded by the allowance', async () => {
    // The delete path takes the teardown branch (`newSettings: undefined`), and
    // until this round that branch had no retry at all while its register twin
    // did — so a throttle left a scalable target silently REGISTERED, the
    // PR #403 leak. The clamp added in the previous round was wired only to the
    // register branch and was therefore inert on every delete.
    dynamoDbDeleteBudgetOverride.totalMs = DYNAMODB_DELETE_BUDGET_MS;
    let asAttempts = 0;
    mockAutoScalingSend.mockImplementation(() => {
      asAttempts += 1;
      return Promise.reject(
        Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
      );
    });
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteTableCommand) {
        deleted = true;
        return Promise.resolve({});
      }
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            // ONE index, so the teardown issues a bounded, countable number of
            // calls: table read + table write + index write + index read.
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      return Promise.resolve({});
    });

    await new DynamoDBGlobalTableProvider().delete(
      'Warm',
      'shared-table',
      'AWS::DynamoDB::GlobalTable',
      {}
    );

    // Each teardown call issues DeleteScalingPolicy + DeregisterScalableTarget,
    // and with a healthy allowance each of those RETRIES the throttle. Without
    // the wrap every send is a single attempt, so the count collapses to one
    // per send — which is what makes this fail on the inert-clamp defect.
    const sends = 4 /* dimensions */ * 2; /* policy + deregister */
    expect(asAttempts).toBeGreaterThan(sends);
    expect(asAttempts).toBeLessThanOrEqual(sends * (1 + AUTO_SCALING_TEARDOWN_MAX_RETRIES));
  });

  it('BLOCKER 2 redo: ...and a drained allowance issues each teardown call exactly ONCE', async () => {
    // The leak-prevention must never depend on the retry: `withRetry` with
    // `maxRetries: 0` still runs the operation once, so a spent allowance stops
    // paying for retries without skipping the call.
    dynamoDbDeleteBudgetOverride.totalMs = 60_000;
    let asAttempts = 0;
    mockAutoScalingSend.mockImplementation(() => {
      asAttempts += 1;
      return Promise.reject(
        Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
      );
    });
    let deleted = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteTableCommand) {
        deleted = true;
        return Promise.resolve({});
      }
      if (command instanceof DescribeTableCommand) {
        if (deleted) {
          return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
        }
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
            Replicas: [{ RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' }],
          },
        });
      }
      return Promise.resolve({});
    });

    const pending = (async () => {
      const p = new DynamoDBGlobalTableProvider().delete(
        'Warm',
        'shared-table',
        'AWS::DynamoDB::GlobalTable',
        {}
      );
      clock.advance(120_000);
      return p;
    })();
    await pending;

    expect(asAttempts).toBe(4 * 2);
  });

  it('BLOCKER 2 redo: the reserve keeps the teardown off the allowance the DELETE needs', async () => {
    // Funding retries from the whole remaining allowance would bound the
    // teardown (each call re-reads it) but would let a throttled burst spend
    // the entire thing before `DeleteTable` is issued — turning a silent target
    // leak into a destroy that fails on the first index-busy refusal because
    // the retry loop has no allowance left.
    const fresh = new ElapsedBudget(DYNAMODB_DELETE_BUDGET_MS, () => 0);
    expect(autoScalingRetriesWithinDeleteBudget(fresh, AUTO_SCALING_TEARDOWN_MAX_RETRIES)).toBe(
      AUTO_SCALING_TEARDOWN_MAX_RETRIES
    );

    // Past the reserve, retries stop even though minutes of allowance remain
    // for the waits that actually delete the table.
    let t = 0;
    const mostlySpent = new ElapsedBudget(DYNAMODB_DELETE_BUDGET_MS, () => t);
    t += DYNAMODB_DELETE_BUDGET_MS - 60_000; // a minute left: well under the reserve
    expect(mostlySpent.remainingMs()).toBeGreaterThan(0);
    expect(
      autoScalingRetriesWithinDeleteBudget(mostlySpent, AUTO_SCALING_TEARDOWN_MAX_RETRIES)
    ).toBe(0);
  });

  it('a RETAINED allowance goes stale once its deadline has certainly fired', async () => {
    // Entries are retained on a throw so the outer loop's re-entry keeps
    // spending the same clock. "Retained" must not mean "forever": the deploy
    // engine hands the same provider instance to `rollback-executor.ts`, so a
    // later operation with its OWN deadline could otherwise inherit a spent
    // allowance. Past the deadline the allowance is sized against, that
    // deadline has fired and the caller belongs to a new operation.
    const registry = new ElapsedBudgetRegistry();
    let t = 0;
    const clockFn = (): number => t;

    const first = registry.acquire('k', 26 * 60_000, clockFn, 30 * 60_000);
    t += 10 * 60_000;
    // Inside the window: the SAME allowance, still draining.
    expect(registry.acquire('k', 26 * 60_000, clockFn, 30 * 60_000)).toBe(first);

    t += 25 * 60_000; // 35 min in: past the 30-min deadline it was sized for
    const afterDeadline = registry.acquire('k', 26 * 60_000, clockFn, 30 * 60_000);
    expect(afterDeadline).not.toBe(first);
    expect(afterDeadline.remainingMs()).toBe(26 * 60_000);
  });
});
