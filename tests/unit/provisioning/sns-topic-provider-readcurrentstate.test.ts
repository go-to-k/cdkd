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
      Tags: [],
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
    expect(result?.Tags).toEqual([]);
  });

  // Structural regression test for the always-emit-placeholder convention
  // (docs/provider-development.md § 3b). Ensures every user-controllable
  // top-level CFn key is present in the result even when AWS returns
  // the resource with all optional fields undefined / empty. A future
  // refactor that drops a placeholder for any of these keys must update
  // this test consciously — silent regression is structurally prevented.
  it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
    // GetTopicAttributes — empty Attributes object (no DisplayName, no
    // KmsMasterKeyId, no TracingConfig, no SignatureVersion, no
    // FifoThroughputScope, no FifoTopic / ContentBasedDeduplication, no
    // ArchivePolicy / DataProtectionPolicy).
    mockSend.mockResolvedValueOnce({ Attributes: {} });
    // ListTagsForResource — no user tags.
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic');

    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        'DisplayName',
        'FifoThroughputScope',
        'KmsMasterKeyId',
        'SignatureVersion',
        'Tags',
        'TopicName',
        'TracingConfig',
      ].sort()
    );
    expect(result?.DisplayName).toBe('');
    expect(result?.KmsMasterKeyId).toBe('');
    expect(result?.TracingConfig).toBe('');
    expect(result?.SignatureVersion).toBe('');
    expect(result?.FifoThroughputScope).toBe('');
    expect(result?.Tags).toEqual([]);
  });
});
