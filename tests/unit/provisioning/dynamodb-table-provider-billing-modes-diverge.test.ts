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

/**
 * The three billing modes `update()` resolves — the LIVE one (`DescribeTable`),
 * the RECORDED previous one, and the DESIRED one — are distinct values of the
 * same type, and `update()` hands them POSITIONALLY to the billing slice
 * (`applyBillingModeUpdate`) and, as the EFFECTIVE mode, to the index slice
 * (`applyIndexUpdates`). Only a table whose modes DISAGREE tells one argument
 * from another, so these cases pin exactly that: a swap of two of them reds
 * here.
 */
const TABLE_NAME = 'my-table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123:table/my-table';
const RESOURCE_TYPE = 'AWS::DynamoDB::Table';

const gsi = (name: string, read: number, write: number) => ({
  IndexName: name,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  Projection: { ProjectionType: 'ALL' },
  ProvisionedThroughput: { ReadCapacityUnits: read, WriteCapacityUnits: write },
});

let provider: DynamoDBTableProvider;

beforeEach(() => {
  mockSend.mockReset();
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new DynamoDBTableProvider();
});

/** `DescribeTable` reports the table ON-DEMAND, with one live index; every later call answers `{}`. */
function primeLiveOnDemand(): void {
  mockSend.mockResolvedValueOnce({
    Table: {
      TableName: TABLE_NAME,
      TableArn: TABLE_ARN,
      TableStatus: 'ACTIVE',
      BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          IndexStatus: 'ACTIVE',
          ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
        },
      ],
    },
  });
  mockSend.mockResolvedValue({});
}

describe('live PAY_PER_REQUEST, recorded PROVISIONED, desired PROVISIONED', () => {
  it('flips against the LIVE mode: flip wait, per-index capacity, and no BillingMode mark', async () => {
    primeLiveOnDemand();
    const flipWait = vi
      .spyOn(provider, 'waitForTableAndIndexesActive')
      .mockResolvedValue(undefined as never);
    const plainWait = vi
      .spyOn(provider, 'waitForTableActiveAfterUpdate')
      .mockResolvedValue(undefined as never);
    const markUnsettled = vi.fn();

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
        GlobalSecondaryIndexes: [gsi('gsi1', 3, 3)],
      },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [gsi('gsi1', 3, 3)],
      },
      { markUnsettled }
    );

    // (a) AWS performs a real flip (live on-demand -> PROVISIONED), so the
    // long flip wait on table AND indexes, not the plain one.
    expect(flipWait).toHaveBeenCalledTimes(1);
    expect(plainWait).not.toHaveBeenCalled();
    // (b) the flip's per-index capacity rides the same UpdateTable: the gate
    // reads the LIVE mode, not the recorded one.
    const calls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateTableCommand => c instanceof UpdateTableCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.GlobalSecondaryIndexUpdates).toEqual([
      {
        Update: {
          IndexName: 'gsi1',
          ProvisionedThroughput: { ReadCapacityUnits: 3, WriteCapacityUnits: 3 },
        },
      },
    ]);
    // (c) the RECORDED mode equals the desired one, so BillingMode itself is
    // not marked unsettled; the throughput change is.
    expect(markUnsettled).not.toHaveBeenCalledWith('BillingMode');
    expect(markUnsettled).toHaveBeenCalledWith('ProvisionedThroughput');
  });

  it('hands the GSI ops the EFFECTIVE (live) mode when no billing change is sent', async () => {
    // Same throughput on both sides: nothing billing-related goes out, so the
    // table STAYS on-demand while the template says PROVISIONED. The GSI add
    // must be planned for the mode the table is actually in.
    primeLiveOnDemand();
    const applyGsiUpdates = vi
      .spyOn(provider, 'applyGsiUpdates')
      .mockResolvedValue(undefined as never);
    vi.spyOn(provider, 'waitForTableActiveAfterUpdate').mockResolvedValue(undefined as never);

    await provider.update(
      'L',
      TABLE_NAME,
      RESOURCE_TYPE,
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [gsi('gsi1', 3, 3), gsi('gsi2', 4, 4)],
      },
      {
        BillingMode: 'PROVISIONED',
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        GlobalSecondaryIndexes: [gsi('gsi1', 3, 3)],
      }
    );

    expect(applyGsiUpdates).toHaveBeenCalledTimes(1);
    // The `isPayPerRequest` argument: the effective mode is the LIVE
    // PAY_PER_REQUEST, not the desired PROVISIONED.
    expect(applyGsiUpdates.mock.calls[0]![10]).toBe(true);
  });
});
