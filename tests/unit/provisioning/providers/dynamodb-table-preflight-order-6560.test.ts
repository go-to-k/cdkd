import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';

// go-to-k/cdkd#6560: a refusal `update()` can decide from the template must
// fire before its FIRST mutating call. A TTL AttributeName rename used to be
// refused only after the stream / GSI / PITR changes of the same deploy went
// out, and the rollback that reverted the stream view type re-minted the
// stream, stranding its event source mapping on the deleted one.

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
  return {
    ...actual,
    DynamoDBClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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

import { DynamoDBTableProvider } from '../../../../src/provisioning/providers/dynamodb-table-provider.js';

const TYPE = 'AWS::DynamoDB::Table';
const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:123456789012:table/T';
const STREAM_ARN = `${TABLE_ARN}/stream/2026-11-18T15:12:19.119`;

const base = {
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'gsipk', AttributeType: 'S' },
  ],
  BillingMode: 'PAY_PER_REQUEST',
};
const gsi = (projection: string) => ({
  IndexName: 'byGsiPk',
  KeySchema: [{ AttributeName: 'gsipk', KeyType: 'HASH' }],
  Projection: { ProjectionType: projection },
});

/** Commands other than the DescribeTable read: every one of them changes the table. */
const mutatingCalls = (): string[] =>
  mockSend.mock.calls
    .map((call) => call[0] as object)
    .filter((cmd) => !(cmd instanceof DescribeTableCommand))
    .map((cmd) => cmd.constructor.name);

describe('DynamoDBTableProvider.update refuses before its first mutating call (#6560)', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof DescribeTableCommand
          ? {
              Table: {
                TableArn: TABLE_ARN,
                TableStatus: 'ACTIVE',
                BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
                StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
                LatestStreamArn: STREAM_ARN,
              },
            }
          : {}
      )
    );
    provider = new DynamoDBTableProvider();
  });

  const previous = {
    ...base,
    StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    Tags: [{ Key: 'k', Value: 'v1' }],
  };
  const desired = {
    ...base,
    StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    GlobalSecondaryIndexes: [gsi('ALL')],
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    Tags: [{ Key: 'k', Value: 'v2' }],
  };

  it('refuses a TTL AttributeName rename before the stream, GSI, PITR and tag changes go out', async () => {
    await expect(provider.update('T', 'T', TYPE, desired, previous)).rejects.toThrow(
      /cannot change the TimeToLive AttributeName from 'ttl' to 'expiresAt'/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses it before any call on the rollback replay too (AWS rejects the rename every time)', async () => {
    await expect(
      provider.update('T', 'T', TYPE, desired, previous, { replayingState: true })
    ).rejects.toThrow(/cannot change the TimeToLive AttributeName/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a same-name GSI Projection change before the stream change goes out', async () => {
    await expect(
      provider.update(
        'T',
        'T',
        TYPE,
        {
          ...base,
          StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
          GlobalSecondaryIndexes: [gsi('KEYS_ONLY')],
        },
        {
          ...base,
          StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
          GlobalSecondaryIndexes: [gsi('ALL')],
        }
      )
    ).rejects.toThrow(/changed its KeySchema or Projection/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses the OnDemandThroughput-under-PROVISIONED flip before the tag diff goes out', async () => {
    await expect(
      provider.update(
        'T',
        'T',
        TYPE,
        {
          ...base,
          BillingMode: 'PROVISIONED',
          ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
          OnDemandThroughput: { MaxReadRequestUnits: 5 },
          Tags: [{ Key: 'k', Value: 'v2' }],
        },
        { ...base, Tags: [{ Key: 'k', Value: 'v1' }] }
      )
    ).rejects.toThrow(/while still declaring OnDemandThroughput/);
    // The DescribeTable read is needed to see the live mode; nothing else.
    expect(mutatingCalls()).toEqual([]);
  });

  it('still applies a TTL change that is no rename, after the other settings', async () => {
    await provider.update(
      'T',
      'T',
      TYPE,
      { ...previous, TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: false } },
      previous
    );
    expect(mutatingCalls()).toContain('UpdateTimeToLiveCommand');
  });
});
