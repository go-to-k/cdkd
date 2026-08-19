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
  DYNAMODB_DELETE_BUDGET_MS,
  DYNAMODB_DELETE_DEADLINE_MARGIN_MS,
  DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS,
  DYNAMODB_DELETE_POLL_COST_MS,
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
import { ElapsedBudget } from '../../../src/utils/elapsed-budget.js';
import {
  DynamoDBGlobalTableProvider,
  TABLE_GONE_WAIT_ATTEMPTS,
  deleteTableRetryDelays as globalTableDeleteDelays,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import {
  DynamoDBTableProvider,
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
    expect(pollsWithinDeleteBudget(900, undefined)).toBe(900);
  });

  it('clamps to what the shared budget can still afford', () => {
    let t = 0;
    const budget = new ElapsedBudget(120 * DYNAMODB_DELETE_POLL_COST_MS, () => t);
    t += 100 * DYNAMODB_DELETE_POLL_COST_MS;

    expect(pollsWithinDeleteBudget(900, budget)).toBe(20);
    // ...and never ABOVE the caller's own cap.
    expect(pollsWithinDeleteBudget(5, budget)).toBe(5);
  });
});

describe('the budget seam resolves to production values when unset', () => {
  it('resolves the shipped total and the real clock', () => {
    // The seam is a test affordance; production must not depend on it. A stray
    // leftover from another suite would silently shorten every delete.
    expect(dynamoDbDeleteBudgetOverride.totalMs).toBeUndefined();
    expect(dynamoDbDeleteBudgetOverride.clock).toBeUndefined();
    expect(resolveDynamoDbDeleteBudgetMs()).toBe(DYNAMODB_DELETE_BUDGET_MS);
    expect(resolveDynamoDbDeleteBudgetClock()).toBe(Date.now);
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
    onDelete: () => Promise<unknown>;
  }): void {
    let deleted = false;
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
        return Promise.resolve({
          Table: {
            TableName: 'shared-table',
            TableStatus: 'ACTIVE',
            GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: status }],
            Replicas: (opts.replicas ?? ['us-east-1']).map((r) => ({
              RegionName: r,
              ReplicaStatus: 'ACTIVE',
            })),
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
    stubTable({ transitioningIndex: true, onDelete: () => Promise.resolve({}) });

    const provider = new DynamoDBGlobalTableProvider();
    await provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {});
    clock.advance(20 * 60_000);
    await provider.delete('Warm', 'shared-table', 'AWS::DynamoDB::GlobalTable', {});

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

  it('the gone-wait draws from it too, and its message names the CLAMPED count', async () => {
    // `waitForTableGone` runs LAST and only on a late loop SUCCESS, which is
    // exactly why it was the term that pushed the single-region shape to
    // ~40.4 min. Its exhaustion THROWS, so the message must describe the
    // budget it actually had rather than the 600-poll cap it did not.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    let describes = 0;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        describes += 1;
        // The table never disappears, so the gone-wait runs to its cap.
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
    ).rejects.toThrow(/did not disappear within 1s/);

    // The pre-delete describe plus the ONE poll the exhausted budget still
    // grants — not the 600 the raw cap would have spent.
    expect(describes).toBe(2);
  });

  it('a table already GONE releases the allowance rather than retaining it', async () => {
    // The idempotent skip arm is terminal too. Retaining there would starve a
    // later delete of the same id for no reason.
    dynamoDbDeleteBudgetOverride.totalMs = 26 * 60_000;
    mockSend.mockImplementation(() =>
      Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }))
    );

    const provider = new DynamoDBTableProvider();
    await provider.delete('Orders', 'shared-table', 'AWS::DynamoDB::Table', {});
    clock.advance(26 * 60_000);

    // If the entry had been retained, this second call would inherit an
    // exhausted budget. It must not throw for that reason.
    await expect(
      provider.delete('Orders', 'shared-table', 'AWS::DynamoDB::Table', {})
    ).resolves.toBeUndefined();
  });
});
