import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DescribeEventBusCommand,
  ListTagsForResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-eventbridge';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { EventBridgeBusProvider } from '../../../src/provisioning/providers/eventbridge-bus-provider.js';

describe('EventBridgeBusProvider.readCurrentState', () => {
  let provider: EventBridgeBusProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EventBridgeBusProvider();
  });

  it('returns CFn-shaped fields from DescribeEventBus (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      Name: 'my-bus',
      Arn: 'arn:aws:events:us-east-1:123:event-bus/my-bus',
      Description: 'a custom bus',
      KmsKeyIdentifier: 'alias/aws/events',
      DeadLetterConfig: { Arn: 'arn:aws:sqs:us-east-1:123:dlq' },
      Policy: '{"Version":"2012-10-17","Statement":[]}',
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState('my-bus', 'BusLogical', 'AWS::Events::EventBus');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DescribeEventBusCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result).toEqual({
      Name: 'my-bus',
      Description: 'a custom bus',
      KmsKeyIdentifier: 'alias/aws/events',
      DeadLetterConfig: { Arn: 'arn:aws:sqs:us-east-1:123:dlq' },
      Policy: { Version: '2012-10-17', Statement: [] },
      Tags: [],
    });
  });

  it('returns undefined when bus is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new ResourceNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('gone', 'BusLogical', 'AWS::Events::EventBus');

    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({
      Name: 'my-bus',
      Arn: 'arn:aws:events:us-east-1:123:event-bus/my-bus',
    });
    mockSend.mockResolvedValueOnce({
      Tags: [
        { Key: 'Foo', Value: 'Bar' },
        { Key: 'aws:cdk:path', Value: 'MyStack/MyBus/Resource' },
      ],
    });

    const result = await provider.readCurrentState('my-bus', 'BusLogical', 'AWS::Events::EventBus');
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({
      Name: 'my-bus',
      Arn: 'arn:aws:events:us-east-1:123:event-bus/my-bus',
    });
    mockSend.mockResolvedValueOnce({
      Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyBus/Resource' }],
    });

    const result = await provider.readCurrentState('my-bus', 'BusLogical', 'AWS::Events::EventBus');
    expect(result?.Tags).toEqual([]);
  });
});
