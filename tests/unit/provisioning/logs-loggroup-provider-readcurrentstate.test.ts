import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeLogGroupsCommand,
  ListTagsForResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: vi.fn() },
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

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';

describe('LogsLogGroupProvider.readCurrentState', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LogsLogGroupProvider();
  });

  it('returns CFn-shaped properties from DescribeLogGroups (camelCase -> PascalCase)', async () => {
    mockSend.mockResolvedValueOnce({
      logGroups: [
        {
          logGroupName: '/aws/lambda/my-fn',
          kmsKeyId: 'arn:aws:kms:us-east-1:123:key/abc',
          retentionInDays: 30,
          logGroupClass: 'STANDARD',
          // AWS-managed fields ignored by the comparator:
          arn: 'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn:*',
          creationTime: 0,
          storedBytes: 0,
        },
      ],
    });
    // ListTagsForResource — no user tags
    mockSend.mockResolvedValueOnce({ tags: {} });

    const result = await provider.readCurrentState(
      '/aws/lambda/my-fn',
      'Logical',
      'AWS::Logs::LogGroup'
    );

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeLogGroupsCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result).toEqual({
      LogGroupName: '/aws/lambda/my-fn',
      KmsKeyId: 'arn:aws:kms:us-east-1:123:key/abc',
      RetentionInDays: 30,
      LogGroupClass: 'STANDARD',
      Tags: [],
    });
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      logGroups: [
        {
          logGroupName: '/aws/lambda/my-fn',
          arn: 'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn:*',
        },
      ],
    });
    mockSend.mockResolvedValueOnce({
      tags: { Foo: 'Bar', 'aws:cdk:path': 'MyStack/MyLogGroup/Resource' },
    });

    const result = await provider.readCurrentState(
      '/aws/lambda/my-fn',
      'Logical',
      'AWS::Logs::LogGroup'
    );
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      logGroups: [
        {
          logGroupName: '/aws/lambda/my-fn',
          arn: 'arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn:*',
        },
      ],
    });
    mockSend.mockResolvedValueOnce({
      tags: { 'aws:cdk:path': 'MyStack/MyLogGroup/Resource' },
    });

    const result = await provider.readCurrentState(
      '/aws/lambda/my-fn',
      'Logical',
      'AWS::Logs::LogGroup'
    );
    expect(result?.Tags).toEqual([]);
  });

  it('returns undefined when log group does not exist (no exact match)', async () => {
    // logGroupNamePrefix can return matching-prefix log groups; the impl
    // narrows to exact name. Simulate "no exact match" via empty list.
    mockSend.mockResolvedValueOnce({ logGroups: [] });

    const result = await provider.readCurrentState(
      '/aws/lambda/missing',
      'Logical',
      'AWS::Logs::LogGroup'
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when DescribeLogGroups throws ResourceNotFoundException', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(
      '/aws/lambda/missing',
      'Logical',
      'AWS::Logs::LogGroup'
    );
    expect(result).toBeUndefined();
  });
});
