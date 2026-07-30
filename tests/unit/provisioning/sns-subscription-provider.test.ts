import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { InvalidParameterException, SubscribeCommand } from '@aws-sdk/client-sns';

// Mock AWS clients before importing the provider
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

describe('SNSSubscriptionProvider', () => {
  let provider: SNSSubscriptionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSSubscriptionProvider();
  });

  describe('create — backfilled subscription attributes (issue #609)', () => {
    const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const QUEUE_ARN = 'arn:aws:sqs:us-east-1:123456789012:my-queue';

    function subscribeInput() {
      const subscribeCall = mockSend.mock.calls.find((c) => c[0] instanceof SubscribeCommand);
      expect(subscribeCall).toBeDefined();
      return subscribeCall![0].input as { Attributes?: Record<string, string> };
    }

    it('coerces RawMessageDelivery boolean to the string "true" / "false"', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
        RawMessageDelivery: true,
      });

      expect(subscribeInput().Attributes?.['RawMessageDelivery']).toBe('true');
    });

    it('coerces RawMessageDelivery=false to the string "false" (not dropped by a truthy gate)', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
        RawMessageDelivery: false,
      });

      expect(subscribeInput().Attributes?.['RawMessageDelivery']).toBe('false');
    });

    it('JSON-stringifies object policies (RedrivePolicy / DeliveryPolicy / ReplayPolicy)', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      const redrive = { deadLetterTargetArn: 'arn:aws:sqs:us-east-1:0:dlq' };
      const delivery = { healthyRetryPolicy: { numRetries: 3 } };
      const replay = { pointType: 'TIMESTAMP' };

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
        RedrivePolicy: redrive,
        DeliveryPolicy: delivery,
        ReplayPolicy: replay,
      });

      const attrs = subscribeInput().Attributes ?? {};
      expect(attrs['RedrivePolicy']).toBe(JSON.stringify(redrive));
      expect(attrs['DeliveryPolicy']).toBe(JSON.stringify(delivery));
      expect(attrs['ReplayPolicy']).toBe(JSON.stringify(replay));
    });

    it('passes policy strings through unchanged', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      const raw = '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:0:dlq"}';

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
        RedrivePolicy: raw,
      });

      expect(subscribeInput().Attributes?.['RedrivePolicy']).toBe(raw);
    });

    it('passes FilterPolicyScope / SubscriptionRoleArn strings through', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'firehose',
        Endpoint: 'arn:aws:firehose:us-east-1:0:deliverystream/ds',
        FilterPolicyScope: 'MessageBody',
        SubscriptionRoleArn: 'arn:aws:iam::0:role/sns-firehose',
      });

      const attrs = subscribeInput().Attributes ?? {};
      expect(attrs['FilterPolicyScope']).toBe('MessageBody');
      expect(attrs['SubscriptionRoleArn']).toBe('arn:aws:iam::0:role/sns-firehose');
    });

    it('omits every backfilled attribute when absent from the template', async () => {
      mockSend.mockResolvedValueOnce({ SubscriptionArn: `${TOPIC_ARN}:sub` });

      await provider.create('L', 'AWS::SNS::Subscription', {
        TopicArn: TOPIC_ARN,
        Protocol: 'sqs',
        Endpoint: QUEUE_ARN,
      });

      const subscribeCall = mockSend.mock.calls.find((c) => c[0] instanceof SubscribeCommand);
      expect(subscribeCall).toBeDefined();
      // No Attributes map at all when nothing was templated (matches the
      // existing FilterPolicy-only gating).
      const input = subscribeCall![0].input as { Attributes?: Record<string, string> };
      expect(input.Attributes).toBeUndefined();
    });
  });

  describe('delete — pending-confirmation subscriptions are skipped (issue #1301)', () => {
    const SUB_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic:4fd6eaeb-8427-411d-bb4a-cde03cb147cc';

    it('treats the pending-confirmation Unsubscribe rejection as delete success (CFn parity)', async () => {
      mockSend.mockRejectedValueOnce(
        new InvalidParameterException({
          message:
            'Invalid parameter: SubscriptionArn Reason: Cannot unsubscribe a subscription that is pending confirmation',
          $metadata: {},
        })
      );

      await expect(
        provider.delete('Sub', SUB_ARN, 'AWS::SNS::Subscription')
      ).resolves.toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('skips the Unsubscribe call entirely for the literal PendingConfirmation placeholder id', async () => {
      await expect(
        provider.delete('Sub', 'PendingConfirmation', 'AWS::SNS::Subscription')
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('skips the Unsubscribe call for the lowercase "pending confirmation" placeholder id', async () => {
      await expect(
        provider.delete('Sub', 'pending confirmation', 'AWS::SNS::Subscription')
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('readCurrentState returns undefined for the placeholder id without calling AWS (drift must not abort)', async () => {
      await expect(
        provider.readCurrentState('PendingConfirmation', 'Sub', 'AWS::SNS::Subscription')
      ).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('still fails on unrelated InvalidParameterException errors', async () => {
      mockSend.mockRejectedValueOnce(
        new InvalidParameterException({
          message: 'Invalid parameter: SubscriptionArn Reason: An ARN must have at least 6 elements',
          $metadata: {},
        })
      );

      await expect(provider.delete('Sub', 'garbage', 'AWS::SNS::Subscription')).rejects.toThrow(
        'Failed to delete SNS subscription'
      );
    });
  });

  describe('import (explicit-override only)', () => {
    function makeInput(overrides: Partial<{ knownPhysicalId: string }> = {}) {
      return {
        logicalId: 'MySubscription',
        resourceType: 'AWS::SNS::Subscription',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {
          TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
          Protocol: 'sqs',
          Endpoint: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
        },
        ...overrides,
      };
    }

    it('returns physicalId when knownPhysicalId is supplied (no AWS calls)', async () => {
      const subArn =
        'arn:aws:sns:us-east-1:123456789012:my-topic:abcd1234-5678-90ab-cdef-1234567890ab';
      const result = await provider.import(makeInput({ knownPhysicalId: subArn }));

      expect(result).toEqual({ physicalId: subArn, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when knownPhysicalId is not supplied (no auto lookup)', async () => {
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
