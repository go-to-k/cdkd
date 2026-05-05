import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetSubscriptionAttributesCommand,
  NotFoundException,
} from '@aws-sdk/client-sns';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SNSSubscriptionProvider } from '../../../src/provisioning/providers/sns-subscription-provider.js';

const SUB_ARN =
  'arn:aws:sns:us-east-1:123456789012:my-topic:abcd-efgh';

describe('SNSSubscriptionProvider.readCurrentState', () => {
  let provider: SNSSubscriptionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSSubscriptionProvider();
  });

  it('returns CFn-shaped subscription properties + type-coerces values (happy path)', async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: 'arn:aws:sns:us-east-1:1:my-topic',
        Protocol: 'sqs',
        Endpoint: 'arn:aws:sqs:us-east-1:1:queue',
        RawMessageDelivery: 'true',
        FilterPolicy: '{"foo":["bar"]}',
        // AWS-managed fields the comparator should ignore (we never surface them):
        Owner: '1',
        SubscriptionArn: SUB_ARN,
      },
    });

    const result = await provider.readCurrentState(SUB_ARN, 'L', 'AWS::SNS::Subscription');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetSubscriptionAttributesCommand);
    expect(result).toEqual({
      TopicArn: 'arn:aws:sns:us-east-1:1:my-topic',
      Protocol: 'sqs',
      Endpoint: 'arn:aws:sqs:us-east-1:1:queue',
      RawMessageDelivery: true,
      FilterPolicy: { foo: ['bar'] },
    });
  });

  it('returns undefined when subscription is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new NotFoundException({ message: 'gone', $metadata: {} })
    );
    const result = await provider.readCurrentState(SUB_ARN, 'L', 'AWS::SNS::Subscription');
    expect(result).toBeUndefined();
  });
});
