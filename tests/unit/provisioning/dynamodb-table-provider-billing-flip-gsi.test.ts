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
 * Issue #1588: a `PAY_PER_REQUEST -> PROVISIONED` flip on a table that HAS a
 * GSI must carry per-index `ProvisionedThroughput` in the SAME `UpdateTable`.
 *
 * Measured against real AWS on 2026-08-11, both halves, because "AWS probably
 * rejects it" is not a basis for a fix:
 *
 *   A) BillingMode + table-level ProvisionedThroughput only (the pre-fix call)
 *      -> `ValidationException: One or more parameter values were invalid:
 *      ProvisionedThroughput must be specified for index: gsi1`. Nothing
 *      applied — so the flip was not degraded, it was IMPOSSIBLE for any table
 *      with an index.
 *   B) the same call plus `GlobalSecondaryIndexUpdates[].Update.
 *      ProvisionedThroughput` -> accepted; the readback showed the table at its
 *      declared capacity and `gsi1` at its own.
 *
 * The scope is exactly the flip: an already-PROVISIONED table taking a capacity
 * bump must NOT re-assert its indexes (AWS rejects a no-op index capacity), and
 * a flip in the other direction has no per-index capacity to send at all.
 */
function findCalls<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).map((c) => c[0] as T);
}

const LIVE_GSI = (name: string) => ({
  IndexName: name,
  IndexStatus: 'ACTIVE',
  // What DescribeTable reports for an index on a PAY_PER_REQUEST table — the
  // zeros are the AWS-side default for a mode the table is not in, never a
  // capacity to echo back (the #1571 lesson, one type over).
  ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
});

const cfnGsi = (name: string, read: unknown, write: unknown) => ({
  IndexName: name,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
  ProvisionedThroughput: { ReadCapacityUnits: read, WriteCapacityUnits: write },
});

let provider: DynamoDBTableProvider;

beforeEach(() => {
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

function primeWaitActive(): void {
  mockSend.mockResolvedValueOnce({
    Table: { TableName: TABLE_NAME, TableArn: TABLE_ARN, TableStatus: 'ACTIVE' },
  });
}

describe('flip to PROVISIONED carries per-GSI ProvisionedThroughput (issue #1588)', () => {
  it('sends GlobalSecondaryIndexUpdates in the SAME UpdateTable as the flip', async () => {
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({}); // UpdateTable
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      },
      { BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)] }
    );

    const calls = findCalls(UpdateTableCommand);
    // ONE call, not two: AWS requires them combined, and a second call would
    // race the first one's still-UPDATING index.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.BillingMode).toBe('PROVISIONED');
    expect(calls[0]!.input.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5,
    });
    expect(calls[0]!.input.GlobalSecondaryIndexUpdates).toEqual([
      {
        Update: {
          IndexName: 'gsi1',
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 3 },
        },
      },
    ]);
  });

  it('covers EVERY live index, not just the first', async () => {
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1'), LIVE_GSI('gsi2')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3), cfnGsi('gsi2', 7, 11)],
      },
      // Same index SET on both sides: this test is about the flip, and a
      // differing set would additionally engage the separate add/remove GSI
      // path (its own UpdateTable round-trips), which is covered elsewhere.
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3), cfnGsi('gsi2', 7, 11)],
      }
    );

    const updates = findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates ?? [];
    expect(updates.map((u) => u.Update?.IndexName).sort()).toEqual(['gsi1', 'gsi2']);
    expect(
      updates.find((u) => u.Update?.IndexName === 'gsi2')?.Update?.ProvisionedThroughput
    ).toEqual({ ReadCapacityUnits: 7, WriteCapacityUnits: 11 });
  });

  it('coerces string capacities, since CFn emits numerics as strings', async () => {
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', '3', '4')],
      },
      { BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [cfnGsi('gsi1', '3', '4')] }
    );

    expect(
      findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates?.[0]?.Update
        ?.ProvisionedThroughput
    ).toEqual({ ReadCapacityUnits: 3, WriteCapacityUnits: 4 });
  });

  it('takes the LIVE index list, so an index the template no longer declares is still named', async () => {
    // AWS's refusal names LIVE indexes. A template-only list would omit the
    // undeclared one — precisely the index AWS complains about — so the warning
    // has to be driven by what DescribeTable reports.
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1'), LIVE_GSI('ghost')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      },
      // `ghost` is in the PREVIOUS side too, so the index set is unchanged and
      // no add/remove path runs — the only thing that omits it is the DESIRED
      // template, which is exactly the case being pinned.
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      }
    );

    const updates = findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates ?? [];
    expect(updates.map((u) => u.Update?.IndexName)).toEqual(['gsi1']);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining('ghost'));
  });
});

describe('scope: only the flip, and only when indexes exist', () => {
  it('does NOT send index updates on a capacity bump of an already-PROVISIONED table', async () => {
    // AWS rejects an UpdateTable that re-asserts an index's current capacity,
    // so widening the gate to "any throughput change" would break the ordinary
    // capacity bump this provider already supported.
    primeDescribeTable('PROVISIONED', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 100, WriteCapacityUnits: 50 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      }
    );

    expect(
      findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates
    ).toBeUndefined();
  });

  it('does NOT send index updates on a flip TO PAY_PER_REQUEST', async () => {
    primeDescribeTable('PROVISIONED', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      { BillingMode: 'PAY_PER_REQUEST', GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)] },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [cfnGsi('gsi1', 3, 3)],
      }
    );

    const call = findCalls(UpdateTableCommand)[0]!;
    expect(call.input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(call.input.GlobalSecondaryIndexUpdates).toBeUndefined();
  });

  it('flips a table with NO indexes exactly as before (the #1553 shape is untouched)', async () => {
    primeDescribeTable('PAY_PER_REQUEST', []);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      },
      { BillingMode: 'PAY_PER_REQUEST' }
    );

    const call = findCalls(UpdateTableCommand)[0]!;
    expect(call.input.BillingMode).toBe('PROVISIONED');
    expect(call.input.GlobalSecondaryIndexUpdates).toBeUndefined();
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('warns and sends no index update when the template declares no per-index capacity', async () => {
    // Deliberately NOT a pre-flight refusal: AWS names the offending index a
    // moment later, which is the CFn-parity outcome and a better message than a
    // guessed capacity. The warning only makes the cause visible in cdkd output.
    primeDescribeTable('PAY_PER_REQUEST', [LIVE_GSI('gsi1')]);
    mockSend.mockResolvedValueOnce({});
    primeWaitActive();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi1', KeySchema: [], Projection: { ProjectionType: 'ALL' } },
        ],
      },
      {
        BillingMode: 'PAY_PER_REQUEST',
        GlobalSecondaryIndexes: [
          { IndexName: 'gsi1', KeySchema: [], Projection: { ProjectionType: 'ALL' } },
        ],
      }
    );

    expect(
      findCalls(UpdateTableCommand)[0]!.input.GlobalSecondaryIndexUpdates
    ).toBeUndefined();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ProvisionedThroughput for live index(es) gsi1')
    );
  });
});
