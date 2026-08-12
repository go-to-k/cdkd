import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateTableCommand } from '@aws-sdk/client-dynamodb';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';

const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

/**
 * Issue #1630: the GSI **Create** and **Update** arms of `applyGsiUpdates` were
 * not idempotent, so a failure AFTER them wedged every later deploy.
 *
 * `applyGsiUpdates` issues one `UpdateTable` per GSI op and waits between each.
 * Everything after it in `update()` — PITR, TTL, ResourcePolicy, Kinesis
 * streaming, Contributor Insights — can still throw, and cdkd writes state only
 * once `update()` RETURNS. So a throw leaves the ops that already succeeded
 * unrecorded, and the next deploy re-emits them:
 *
 *  - a created GSI is not in the recorded previous side, so its `Create` is
 *    re-emitted and AWS rejects it (the index now exists);
 *  - a landed throughput `Update` is re-emitted with the same value, which AWS
 *    rejects with "The provisioned throughput for the index X will not change.
 *    The requested value equals the current value."
 *
 * Either way state never advances and every retry fails identically, until the
 * user runs `cdkd drift --accept`. #1617 fixed exactly this for the **Delete**
 * arm; these are its two siblings.
 *
 * The whole risk of the fix is the GATING, so that is what most of these rows
 * pin: `DescribeTable` reports `ProvisionedThroughput: {0, 0}` for EVERY index
 * of a PAY_PER_REQUEST table (the #1571 trap), so the live capacity is only
 * consulted when the table's LIVE billing mode is PROVISIONED.
 */
function findCalls<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).map((c) => c[0] as T);
}

function gsiUpdates(): unknown[] {
  return findCalls(UpdateTableCommand).flatMap((c) => c.input.GlobalSecondaryIndexUpdates ?? []);
}

const cfnGsi = (name: string, read: number, write: number) => ({
  IndexName: name,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
  ProvisionedThroughput: { ReadCapacityUnits: read, WriteCapacityUnits: write },
});

/** What `DescribeTable` reports: the two capacities PLUS AWS-side bookkeeping. */
const liveGsi = (name: string, read: number, write: number) => ({
  IndexName: name,
  IndexStatus: 'ACTIVE',
  ProvisionedThroughput: {
    ReadCapacityUnits: read,
    WriteCapacityUnits: write,
    // Present on every real readback and absent from the desired object — which
    // is precisely why the comparison has to be member-by-member rather than
    // structural. A `deepEqual` here would never match and the suppression
    // would be dead code.
    NumberOfDecreasesToday: 0,
    LastIncreaseDateTime: new Date(0),
  },
});

let provider: DynamoDBTableProvider;

beforeEach(() => {
  // `mockReset`, not just `clearAllMocks` (issue #1618): the latter clears call
  // RECORDS but leaves the `mockResolvedValueOnce` QUEUE, so a test priming more
  // responses than its update() consumes shifts every later test's queue and
  // they silently read the wrong DescribeTable.
  mockSend.mockReset();
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new DynamoDBTableProvider();
});

function primeDescribeTable(liveMode: string, indexes: unknown[]): void {
  mockSend.mockResolvedValueOnce({
    Table: {
      TableName: TABLE_NAME,
      TableArn: TABLE_ARN,
      TableStatus: 'ACTIVE',
      BillingModeSummary: { BillingMode: liveMode },
      ...(indexes.length > 0 && { GlobalSecondaryIndexes: indexes }),
    },
  });
}

describe('GSI Create arm is idempotent (#1630)', () => {
  it('skips the Create for an index AWS already has but state does not record', async () => {
    // The wedge: an earlier deploy created gsi2, then something after
    // applyGsiUpdates threw, so state still shows only gsi1.
    primeDescribeTable('PROVISIONED', [liveGsi('gsi1', 5, 5), liveGsi('gsi2', 3, 3)]);

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5), cfnGsi('gsi2', 3, 3)],
      },
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5)] }
    );

    expect(gsiUpdates()).toEqual([]);
  });

  it('WARNS when it skips, because state and AWS disagreeing is worth surfacing', async () => {
    primeDescribeTable('PROVISIONED', [liveGsi('gsi1', 5, 5), liveGsi('gsi2', 3, 3)]);

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5), cfnGsi('gsi2', 3, 3)],
      },
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5)] }
    );

    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('gsi2'));
  });

  it('STILL creates an index AWS genuinely does not have', async () => {
    // The fence that keeps the skip from swallowing every Create. Without a row
    // in this direction the suppression could be unconditional and every row
    // above would stay green.
    primeDescribeTable('PROVISIONED', [liveGsi('gsi1', 5, 5)]);
    mockSend.mockResolvedValueOnce({}); // UpdateTable
    mockSend.mockResolvedValueOnce({
      Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5), cfnGsi('gsi2', 3, 3)],
      },
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5)] }
    );

    expect(gsiUpdates()).toEqual([
      {
        Create: {
          IndexName: 'gsi2',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 3 },
        },
      },
    ]);
  });
});

describe('GSI throughput Update arm is idempotent (#1630)', () => {
  it('skips the Update when AWS already carries the requested capacity', async () => {
    // The recorded previous says 3/3 -> 9/9, so the diff emits an Update. AWS
    // already holds 9/9 because the earlier deploy landed it before throwing.
    primeDescribeTable('PROVISIONED', [liveGsi('gsi1', 9, 9)]);

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 9, 9)] },
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)] }
    );

    expect(gsiUpdates()).toEqual([]);
  });

  it('STILL issues the Update when the live capacity differs', async () => {
    primeDescribeTable('PROVISIONED', [liveGsi('gsi1', 3, 3)]);
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 9, 9)] },
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)] }
    );

    expect(gsiUpdates()).toEqual([
      { Update: { IndexName: 'gsi1', ProvisionedThroughput: { ReadCapacityUnits: 9, WriteCapacityUnits: 9 } } },
    ]);
  });

  it('issues the Update when only ONE of the two capacities already matches', async () => {
    // A partial match must NOT suppress — the read capacity landed and the
    // write did not, so the call is still needed. Pins that both members
    // participate rather than just the first.
    primeDescribeTable('PROVISIONED', [liveGsi('gsi1', 9, 3)]);
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 9, 9)] },
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)] }
    );

    expect(gsiUpdates()).toHaveLength(1);
  });

  it('issues the Update for an index the live snapshot has no entry for', async () => {
    // No live capacity to reason from, so the suppression must not fire —
    // failing OPEN is the safe direction (worst case is the pre-fix behavior,
    // whereas a false match silently drops a capacity change).
    primeDescribeTable('PROVISIONED', [liveGsi('other', 9, 9)]);
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 9, 9)] },
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)] }
    );

    expect(gsiUpdates()).toHaveLength(1);
  });
});

describe('the PAY_PER_REQUEST gate — the whole risk of the change (#1571 trap)', () => {
  it('does NOT consult live capacity on an on-demand table', async () => {
    // `DescribeTable` reports {0, 0} for every index of a PAY_PER_REQUEST
    // table. Those zeros are an AWS-side default for a mode the table is not
    // in, never a capacity to compare against — so the suppression must be
    // disabled entirely rather than "happen not to match".
    //
    // Asserted through a template that requests EXACTLY {0, 0}: under an
    // ungated comparison the zeros would match and the Update would vanish.
    // Any non-zero request would pass this row for the wrong reason.
    primeDescribeTable('PAY_PER_REQUEST', [liveGsi('gsi1', 0, 0)]);
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { GlobalSecondaryIndexes: [cfnGsi('gsi1', 0, 0)] },
      { GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)] }
    );

    expect(gsiUpdates()).toEqual([
      { Update: { IndexName: 'gsi1', ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 } } },
    ]);
  });

  it('the Create skip stays active on an on-demand table', async () => {
    // The two arms gate DIFFERENTLY and that is deliberate: index EXISTENCE is
    // billing-mode-independent, so the Create skip is safe on either mode,
    // while only the capacity VALUES are meaningless under PAY_PER_REQUEST.
    primeDescribeTable('PAY_PER_REQUEST', [liveGsi('gsi1', 0, 0), liveGsi('gsi2', 0, 0)]);

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi1', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } },
          { IndexName: 'gsi2', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } },
        ],
      },
      {
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi1', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' } },
        ],
      }
    );

    expect(gsiUpdates()).toEqual([]);
  });
});

describe('a RECOVERED index that also CHANGED is repaired, not silently adopted (#1642 review)', () => {
  // Skipping the Create on the NAME alone was a silent state divergence: if the
  // retry ALSO edits the recovered index, no op is emitted, the engine records
  // the DESIRED bag on success, and no later diff converges — state claims one
  // capacity while AWS holds another, forever. Pre-fix this failed loudly at
  // AWS, so the skip must not trade a loud failure for a quiet lie.
  it('emits the throughput Update when the live capacity differs from desired', async () => {
    primeDescribeTable('PROVISIONED', [liveGsi('gsi1', 5, 5), liveGsi('gsi2', 3, 3)]);
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' } });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        // gsi2 is recovered from AWS (3/3) but the template now asks for 9/9.
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5), cfnGsi('gsi2', 9, 9)],
      },
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5)] }
    );

    expect(gsiUpdates()).toEqual([
      { Update: { IndexName: 'gsi2', ProvisionedThroughput: { ReadCapacityUnits: 9, WriteCapacityUnits: 9 } } },
    ]);
  });

  it('emits NOTHING when the recovered index already matches', async () => {
    // The ordinary recovery: same capacity on both sides, so the deploy simply
    // converges. Fences the row above against an unconditional Update.
    primeDescribeTable('PROVISIONED', [liveGsi('gsi1', 5, 5), liveGsi('gsi2', 3, 3)]);

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5), cfnGsi('gsi2', 3, 3)],
      },
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5)] }
    );

    expect(gsiUpdates()).toEqual([]);
  });

  it('a DELETING index does NOT count as live, so its Create still fires', async () => {
    // The index is on its way out; skipping the Create would leave it absent
    // from AWS while state records it. (The Delete arm's own filter DOES treat
    // DELETING as live, correctly — a Delete for it is what should be skipped.)
    primeDescribeTable('PROVISIONED', [
      liveGsi('gsi1', 5, 5),
      { ...liveGsi('gsi2', 3, 3), IndexStatus: 'DELETING' },
    ]);
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' } });

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5), cfnGsi('gsi2', 3, 3)],
      },
      { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5)] }
    );

    expect(gsiUpdates()).toEqual([
      {
        Create: {
          IndexName: 'gsi2',
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 3 },
        },
      },
    ]);
  });

  it('a template missing KeySchema still THROWS even when the index is recovered', async () => {
    // The required-field check must precede the skip: a broken template is
    // broken regardless of what AWS holds, and skipping past it would record
    // the broken bag into state.
    primeDescribeTable('PROVISIONED', [liveGsi('gsi1', 5, 5), liveGsi('gsi2', 3, 3)]);

    await expect(
      provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            cfnGsi('gsi1', 5, 5),
            { IndexName: 'gsi2', Projection: { ProjectionType: 'ALL' } },
          ],
        },
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 5, 5)] }
      )
    ).rejects.toThrow(/missing KeySchema/);
  });
});

describe('capacityNumber rejects the coercion traps (#1642 review)', () => {
  // `Number(null)` / `Number('')` / `Number([])` / `Number(false)` are all 0,
  // NOT NaN — so a naive `Number()` comparator would have matched a live 0
  // against a desired null/''/[]/false and SUPPRESSED the call. DynamoDB's own
  // capacities are always >= 1 so the blast radius is small, but this rule is
  // copied to other providers, so it is spelled correctly.
  it.each([[null], [''], [[]], [false], [{}], [undefined]])(
    'does not treat %p as a capacity that matches a live 0',
    async (bogus) => {
      primeDescribeTable('PROVISIONED', [liveGsi('gsi1', 0, 0)]);
      mockSend.mockResolvedValueOnce({});
      mockSend.mockResolvedValueOnce({ Table: { TableName: TABLE_NAME, TableStatus: 'ACTIVE' } });

      await provider.update(
        'L',
        TABLE_NAME,
        RESOURCE_TYPE,
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              ...cfnGsi('gsi1', 1, 1),
              ProvisionedThroughput: { ReadCapacityUnits: bogus, WriteCapacityUnits: bogus },
            },
          ],
        },
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)] }
      );

      // Fails OPEN: the call is still issued rather than silently suppressed.
      expect(gsiUpdates()).toHaveLength(1);
    }
  );
});
