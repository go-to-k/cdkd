import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetTopicAttributesCommand,
  ListTagsForResourceCommand,
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

import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';

const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';

describe('SNSTopicProvider.readCurrentState', () => {
  let provider: SNSTopicProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSTopicProvider();
  });

  it('returns CFn-shaped properties with parsed booleans and JSON policies', async () => {
    const archivePolicy = { MessageRetentionPeriod: '7' };
    mockSend.mockResolvedValueOnce({
      Attributes: {
        FifoTopic: 'true',
        ContentBasedDeduplication: 'false',
        DisplayName: 'My Topic',
        KmsMasterKeyId: 'alias/aws/sns',
        TracingConfig: 'Active',
        SignatureVersion: '2',
        FifoThroughputScope: 'Topic',
        ArchivePolicy: JSON.stringify(archivePolicy),
        // AWS-managed fields ignored by the comparator:
        TopicArn: TOPIC_ARN,
        Owner: '123456789012',
        SubscriptionsConfirmed: '0',
      },
    });

    // ListTagsForResource — no user tags
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetTopicAttributesCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListTagsForResourceCommand);
    expect(result).toEqual({
      TopicName: 'my-topic',
      FifoTopic: true,
      ContentBasedDeduplication: false,
      DisplayName: 'My Topic',
      KmsMasterKeyId: 'alias/aws/sns',
      TracingConfig: 'Active',
      SignatureVersion: '2',
      FifoThroughputScope: 'Topic',
      ArchivePolicy: archivePolicy,
    });
  });

  it('returns undefined when topic does not exist', async () => {
    mockSend.mockRejectedValueOnce(new NotFoundException({ message: 'gone', $metadata: {} }));

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic');
    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListTagsForResource with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { DisplayName: 'X' } });
    mockSend.mockResolvedValueOnce({
      Tags: [
        { Key: 'Foo', Value: 'Bar' },
        { Key: 'aws:cdk:path', Value: 'MyStack/MyTopic/Resource' },
      ],
    });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic');
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('declares DeliveryStatusLogging and Subscription as drift-unknown so the comparator skips them', () => {
    // DeliveryStatusLogging fans out to per-protocol attributes that
    // readCurrentState does not yet round-trip; Subscription is managed
    // via separate AWS::SNS::Subscription resources, not as a Topic
    // property — both would fire guaranteed false drift if surfaced.
    expect(provider.getDriftUnknownPaths()).toEqual(['DeliveryStatusLogging', 'Subscription']);
  });

  it('omits Tags when ListTagsForResource returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { DisplayName: 'X' } });
    mockSend.mockResolvedValueOnce({
      Tags: [{ Key: 'aws:cdk:path', Value: 'MyStack/MyTopic/Resource' }],
    });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic');
    expect(result).not.toHaveProperty('Tags');
  });
});
