import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeTableCommand,
  ListTagsOfResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';

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

describe('DynamoDBTableProvider.readCurrentState', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  it('returns CFn-shaped properties from DescribeTable (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: 'my-table',
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' },
        ProvisionedThroughput: {
          ReadCapacityUnits: 0,
          WriteCapacityUnits: 0,
          // AWS adds ephemeral fields the comparator should ignore.
          NumberOfDecreasesToday: 0,
          LastIncreaseDateTime: new Date(0),
        },
        StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
        SSEDescription: {
          Status: 'ENABLED',
          KMSMasterKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
          SSEType: 'KMS',
        },
        DeletionProtectionEnabled: true,
        TableClassSummary: { TableClass: 'STANDARD' },
        // AWS-managed fields cdkd never set:
        TableArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table',
        TableId: 'guid',
        CreationDateTime: new Date(0),
      },
    });
    // ListTagsOfResource — no user tags
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState('my-table', 'Logical', 'AWS::DynamoDB::Table');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeTableCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsOfResourceCommand);
    // Class 1/2 placeholder guards (PR — drift --revert round-trip safety):
    //  - GlobalSecondaryIndexes / LocalSecondaryIndexes are NOT emitted as
    //    empty-array placeholders — the previous `?? []` round-tripped as
    //    "remove all GSIs" / a guaranteed AWS rejection on LSI (immutable
    //    post-create).
    //  - SSESpecification is gated on Status === 'ENABLED' (it is here).
    expect(result).toEqual({
      TableName: 'my-table',
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
      ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
      StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
      SSESpecification: {
        SSEEnabled: true,
        KMSMasterKeyId: 'arn:aws:kms:us-east-1:123:key/abc',
        SSEType: 'KMS',
      },
      DeletionProtectionEnabled: true,
      TableClass: 'STANDARD',
      Tags: [],
    });
  });

  it('returns undefined when table is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState('my-table', 'Logical', 'AWS::DynamoDB::Table');
    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListTagsOfResource with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: 'my-table',
        TableArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table',
      },
    });
    mockSend.mockResolvedValueOnce({
      Tags: [
        { Key: 'Foo', Value: 'Bar' },
        { Key: 'aws:cdk:path', Value: 'MyStack/MyTable/Resource' },
      ],
    });

    const result = await provider.readCurrentState('my-table', 'Logical', 'AWS::DynamoDB::Table');

    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsOfResource returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: 'my-table',
        TableArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table',
      },
    });
    mockSend.mockResolvedValueOnce({
      Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyTable/Resource' }],
    });

    const result = await provider.readCurrentState('my-table', 'Logical', 'AWS::DynamoDB::Table');

    expect(result?.Tags).toEqual([]);
  });
});
