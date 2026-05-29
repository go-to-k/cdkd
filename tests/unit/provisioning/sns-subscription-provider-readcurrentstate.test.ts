import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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

  it('emits the backfilled attributes when AWS returns them (issue #609)', async () => {
    const redrive = { deadLetterTargetArn: 'arn:aws:sqs:us-east-1:1:dlq' };
    const delivery = { healthyRetryPolicy: { numRetries: 3 } };
    const replay = { pointType: 'TIMESTAMP' };
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: 'arn:aws:sns:us-east-1:1:my-topic',
        Protocol: 'sqs',
        Endpoint: 'arn:aws:sqs:us-east-1:1:queue',
        FilterPolicyScope: 'MessageBody',
        SubscriptionRoleArn: 'arn:aws:iam::1:role/r',
        RedrivePolicy: JSON.stringify(redrive),
        DeliveryPolicy: JSON.stringify(delivery),
        ReplayPolicy: JSON.stringify(replay),
        Owner: '1',
        SubscriptionArn: SUB_ARN,
      },
    });

    const result = await provider.readCurrentState(SUB_ARN, 'L', 'AWS::SNS::Subscription');
    expect(result).toEqual({
      TopicArn: 'arn:aws:sns:us-east-1:1:my-topic',
      Protocol: 'sqs',
      Endpoint: 'arn:aws:sqs:us-east-1:1:queue',
      FilterPolicyScope: 'MessageBody',
      SubscriptionRoleArn: 'arn:aws:iam::1:role/r',
      RedrivePolicy: redrive,
      DeliveryPolicy: delivery,
      ReplayPolicy: replay,
    });
  });

  it('omits the backfilled attributes when AWS does not return them (emit-when-present)', async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: 'arn:aws:sns:us-east-1:1:my-topic',
        Protocol: 'email',
        Endpoint: 'me@example.com',
        Owner: '1',
        SubscriptionArn: SUB_ARN,
      },
    });

    const result = await provider.readCurrentState(SUB_ARN, 'L', 'AWS::SNS::Subscription');
    expect(result).not.toHaveProperty('FilterPolicyScope');
    expect(result).not.toHaveProperty('SubscriptionRoleArn');
    expect(result).not.toHaveProperty('RedrivePolicy');
    expect(result).not.toHaveProperty('DeliveryPolicy');
    expect(result).not.toHaveProperty('ReplayPolicy');
  });

  it('returns undefined when subscription is gone', async () => {
    mockSend.mockRejectedValueOnce(
      new NotFoundException({ message: 'gone', $metadata: {} })
    );
    const result = await provider.readCurrentState(SUB_ARN, 'L', 'AWS::SNS::Subscription');
    expect(result).toBeUndefined();
  });
});
