import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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
const TYPE = 'AWS::DynamoDB::Table';

const ATTRS_BASE = [{ AttributeName: 'pk', AttributeType: 'S' }];
const ATTRS_WITH_GSI = [
  { AttributeName: 'pk', AttributeType: 'S' },
  { AttributeName: 'gsipk', AttributeType: 'S' },
];
const GSI = {
  IndexName: 'gsi1',
  KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
};

function findCalls<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof ctor).map((c) => c[0] as T);
}

/**
 * Adding / removing a Global Secondary Index must be an in-place UpdateTable
 * (GlobalSecondaryIndexUpdates), NOT a table replacement. Regression coverage
 * for the bug where a GSI add failed deploy with "Table already exists".
 */
describe('DynamoDBTableProvider GSI in-place update', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  it('adds a GSI via UpdateTable Create with the new AttributeDefinitions', async () => {
    // 1) initial DescribeTable (for ARN), 2) UpdateTable (GSI create),
    // 3) DescribeTable wait (table + index ACTIVE)
    mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN, TableStatus: 'ACTIVE' } });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Table: {
        TableArn: TABLE_ARN,
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
      },
    });

    const result = await provider.update(
      'L',
      TABLE_NAME,
      TYPE,
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_WITH_GSI,
        GlobalSecondaryIndexes: [GSI],
      },
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_BASE,
        GlobalSecondaryIndexes: undefined,
      }
    );

    expect(result.wasReplaced).toBe(false);
    const updates = findCalls(UpdateTableCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.GlobalSecondaryIndexUpdates).toEqual([
      {
        Create: {
          IndexName: 'gsi1',
          KeySchema: GSI.KeySchema,
          Projection: GSI.Projection,
        },
      },
    ]);
    // Create must carry the AttributeDefinitions defining the new key attribute.
    expect(updates[0]!.input.AttributeDefinitions).toEqual(ATTRS_WITH_GSI);
  });

  it('removes a GSI via UpdateTable Delete', async () => {
    mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN, TableStatus: 'ACTIVE' } });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [] } });

    await provider.update(
      'L',
      TABLE_NAME,
      TYPE,
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_BASE,
        GlobalSecondaryIndexes: undefined,
      },
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_WITH_GSI,
        GlobalSecondaryIndexes: [GSI],
      }
    );

    const updates = findCalls(UpdateTableCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.GlobalSecondaryIndexUpdates).toEqual([
      { Delete: { IndexName: 'gsi1' } },
    ]);
    // Delete does not need AttributeDefinitions.
    expect(updates[0]!.input.AttributeDefinitions).toBeUndefined();
  });

  it('updates a GSI throughput via UpdateTable Update', async () => {
    const gsiProv = {
      ...GSI,
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    };
    const gsiProvBumped = {
      ...GSI,
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
    };
    mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN, TableStatus: 'ACTIVE' } });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Table: {
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
      },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      TYPE,
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_WITH_GSI,
        GlobalSecondaryIndexes: [gsiProvBumped],
      },
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_WITH_GSI,
        GlobalSecondaryIndexes: [gsiProv],
      }
    );

    const updates = findCalls(UpdateTableCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.GlobalSecondaryIndexUpdates).toEqual([
      {
        Update: {
          IndexName: 'gsi1',
          ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
        },
      },
    ]);
  });

  it('serializes a remove + add in one update as two UpdateTable ops (delete first)', async () => {
    const gsiB = {
      IndexName: 'gsi2',
      KeySchema: [{ AttributeName: 'gsi2pk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
    };
    // DescribeTable(ARN) -> UpdateTable(delete) -> wait -> UpdateTable(create) -> wait
    mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN, TableStatus: 'ACTIVE' } });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ Table: { TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [] } });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Table: {
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexName: 'gsi2', IndexStatus: 'ACTIVE' }],
      },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      TYPE,
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'gsi2pk', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [gsiB],
      },
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_WITH_GSI,
        GlobalSecondaryIndexes: [GSI],
      }
    );

    const updates = findCalls(UpdateTableCommand);
    expect(updates).toHaveLength(2);
    // Delete (gsi1) is issued BEFORE Create (gsi2) — one op per call.
    expect(updates[0]!.input.GlobalSecondaryIndexUpdates).toEqual([{ Delete: { IndexName: 'gsi1' } }]);
    expect(updates[1]!.input.GlobalSecondaryIndexUpdates).toEqual([
      { Create: { IndexName: 'gsi2', KeySchema: gsiB.KeySchema, Projection: gsiB.Projection } },
    ]);
  });

  it('throws on a same-name GSI KeySchema change (immutable in place, no silent drop)', async () => {
    mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN, TableStatus: 'ACTIVE' } });
    const reKeyed = {
      IndexName: 'gsi1',
      KeySchema: [{ AttributeName: 'otherpk', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
    };

    await expect(
      provider.update(
        'L',
        TABLE_NAME,
        TYPE,
        {
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: ATTRS_WITH_GSI,
          GlobalSecondaryIndexes: [reKeyed],
        },
        {
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: ATTRS_WITH_GSI,
          GlobalSecondaryIndexes: [GSI],
        }
      )
    ).rejects.toThrow(/KeySchema or Projection/);
    // No UpdateTable was issued (it threw before applying anything).
    expect(findCalls(UpdateTableCommand)).toHaveLength(0);
  });

  it('waits through a BACKFILLING index before completing the GSI create', async () => {
    // DescribeTable(ARN) -> UpdateTable(create) -> wait poll #1 (index still
    // BACKFILLING / table ACTIVE -> keep waiting) -> wait poll #2 (index ACTIVE)
    mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN, TableStatus: 'ACTIVE' } });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Table: {
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'CREATING' }],
      },
    });
    mockSend.mockResolvedValueOnce({
      Table: {
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
      },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      TYPE,
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_WITH_GSI,
        GlobalSecondaryIndexes: [GSI],
      },
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_BASE,
        GlobalSecondaryIndexes: undefined,
      }
    );

    // The wait loop re-polled DescribeTable until the index reached ACTIVE:
    // 1 initial (ARN) + 2 wait polls = 3 DescribeTable calls.
    expect(findCalls(DescribeTableCommand)).toHaveLength(3);
    expect(findCalls(UpdateTableCommand)).toHaveLength(1);
  });

  it('throws when a created GSI is missing KeySchema', async () => {
    mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN, TableStatus: 'ACTIVE' } });

    await expect(
      provider.update(
        'L',
        TABLE_NAME,
        TYPE,
        {
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: ATTRS_WITH_GSI,
          GlobalSecondaryIndexes: [{ IndexName: 'gsiNoKey', Projection: { ProjectionType: 'ALL' } }],
        },
        {
          KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
          AttributeDefinitions: ATTRS_BASE,
          GlobalSecondaryIndexes: undefined,
        }
      )
    ).rejects.toThrow(/missing KeySchema/);
    expect(findCalls(UpdateTableCommand)).toHaveLength(0);
  });

  it('forwards OnDemandThroughput on a GSI create when present', async () => {
    const gsiOnDemand = {
      ...GSI,
      OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 5 },
    };
    mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN, TableStatus: 'ACTIVE' } });
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      Table: {
        TableStatus: 'ACTIVE',
        GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }],
      },
    });

    await provider.update(
      'L',
      TABLE_NAME,
      TYPE,
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_WITH_GSI,
        GlobalSecondaryIndexes: [gsiOnDemand],
      },
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_BASE,
        GlobalSecondaryIndexes: undefined,
      }
    );

    const updates = findCalls(UpdateTableCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input.GlobalSecondaryIndexUpdates![0]!.Create!.OnDemandThroughput).toEqual({
      MaxReadRequestUnits: 10,
      MaxWriteRequestUnits: 5,
    });
  });

  it('does not issue any UpdateTable when GSIs are unchanged', async () => {
    mockSend.mockResolvedValueOnce({ Table: { TableArn: TABLE_ARN, TableStatus: 'ACTIVE' } });

    await provider.update(
      'L',
      TABLE_NAME,
      TYPE,
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_WITH_GSI,
        GlobalSecondaryIndexes: [GSI],
      },
      {
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
        AttributeDefinitions: ATTRS_WITH_GSI,
        GlobalSecondaryIndexes: [GSI],
      }
    );

    expect(findCalls(UpdateTableCommand)).toHaveLength(0);
    expect(findCalls(DescribeTableCommand)).toHaveLength(1);
  });
});
