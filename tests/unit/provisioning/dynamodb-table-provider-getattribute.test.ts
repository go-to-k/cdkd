import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceNotFoundException } from '@aws-sdk/client-dynamodb';

// Mock AWS clients before importing the provider
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

describe('DynamoDBTableProvider.getAttribute', () => {
  let provider: DynamoDBTableProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DynamoDBTableProvider();
  });

  it('returns Arn from DescribeTable', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: 'my-table',
        TableArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table',
        LatestStreamArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table/stream/2026',
      },
    });

    const result = await provider.getAttribute('my-table', 'AWS::DynamoDB::Table', 'Arn');
    expect(result).toBe('arn:aws:dynamodb:us-east-1:123:table/my-table');
  });

  it('returns StreamArn from DescribeTable.LatestStreamArn', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: 'my-table',
        TableArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table',
        LatestStreamArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table/stream/2026',
      },
    });

    const result = await provider.getAttribute('my-table', 'AWS::DynamoDB::Table', 'StreamArn');
    expect(result).toBe('arn:aws:dynamodb:us-east-1:123:table/my-table/stream/2026');
  });

  it('returns LatestStreamLabel from DescribeTable.LatestStreamLabel', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        TableName: 'my-table',
        TableArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table',
        LatestStreamArn: 'arn:aws:dynamodb:us-east-1:123:table/my-table/stream/2026-05-02T00:00:00.000',
        LatestStreamLabel: '2026-05-02T00:00:00.000',
      },
    });

    const result = await provider.getAttribute(
      'my-table',
      'AWS::DynamoDB::Table',
      'LatestStreamLabel'
    );
    expect(result).toBe('2026-05-02T00:00:00.000');
  });

  it('returns undefined for unknown attribute', async () => {
    mockSend.mockResolvedValueOnce({
      Table: { TableName: 'my-table', TableArn: 'arn' },
    });

    const result = await provider.getAttribute('my-table', 'AWS::DynamoDB::Table', 'Unknown');
    expect(result).toBeUndefined();
  });

  it('returns undefined when table not found', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.getAttribute('missing-table', 'AWS::DynamoDB::Table', 'Arn');
    expect(result).toBeUndefined();
  });
});
