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
      // DeliveryStatusLogging always-emit (PR for #181/#182 follow-up).
      // Empty array placeholder when no per-protocol feedback attributes
      // are set on the topic.
      DeliveryStatusLogging: [],
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

  it('declares only Subscription as drift-unknown (DeliveryStatusLogging is now reverse-mapped)', () => {
    // CDK manages topic subscriptions via separate AWS::SNS::Subscription
    // resources, so the inline Topic.Subscription property is intentionally
    // not surfaced. DeliveryStatusLogging is now reverse-mapped from per-
    // protocol flat attributes to the CFn array shape — see readCurrentState.
    expect(provider.getDriftUnknownPaths()).toEqual(['Subscription']);
  });

  it('reverse-maps DeliveryStatusLogging from per-protocol flat attributes to CFn array shape', async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: TOPIC_ARN,
        // Lambda: success only.
        LambdaSuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success',
        LambdaSuccessFeedbackSampleRate: '100',
        // SQS: success + failure with sample rate.
        SQSSuccessFeedbackRoleArn: 'arn:aws:iam::1:role/sqs-success',
        SQSSuccessFeedbackSampleRate: '50',
        SQSFailureFeedbackRoleArn: 'arn:aws:iam::1:role/sqs-failure',
        // HTTPS: failure only.
        HTTPSFailureFeedbackRoleArn: 'arn:aws:iam::1:role/https-failure',
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic');

    // Entries sorted alphabetically by Protocol for stable positional
    // compare (HTTPS before Lambda before SQS).
    expect(result?.['DeliveryStatusLogging']).toEqual([
      {
        Protocol: 'HTTPS',
        FailureFeedbackRoleArn: 'arn:aws:iam::1:role/https-failure',
      },
      {
        Protocol: 'Lambda',
        SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success',
        SuccessFeedbackSampleRate: '100',
      },
      {
        Protocol: 'SQS',
        SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/sqs-success',
        SuccessFeedbackSampleRate: '50',
        FailureFeedbackRoleArn: 'arn:aws:iam::1:role/sqs-failure',
      },
    ]);
  });

  it('preserves state-recorded lowercase Protocol case when reverse-mapping (CDK lowercase template)', async () => {
    // CDK templates emit `Protocol: 'lambda'` (lowercase). AWS's
    // attribute prefix is PascalCase. Without case preservation the
    // comparator fires false drift on every clean run because state
    // holds `'lambda'` and AWS-current would emit `'Lambda'`.
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: TOPIC_ARN,
        LambdaSuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success',
        SQSSuccessFeedbackRoleArn: 'arn:aws:iam::1:role/sqs-success',
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic', {
      DeliveryStatusLogging: [
        { Protocol: 'lambda', SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success' },
        { Protocol: 'sqs', SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/sqs-success' },
      ],
    });

    // Entries sorted by canonical PascalCase prefix (Lambda before SQS),
    // but each entry's `Protocol` field uses state's recorded case.
    expect(result?.['DeliveryStatusLogging']).toEqual([
      { Protocol: 'lambda', SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success' },
      { Protocol: 'sqs', SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/sqs-success' },
    ]);
  });

  it('preserves state-recorded PascalCase Protocol when state holds the canonical case', async () => {
    // The complement of the lowercase case: when state holds
    // `'Lambda'` the result must also emit `'Lambda'` — state's case
    // wins, regardless of which case canonicalizes to it.
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: TOPIC_ARN,
        LambdaSuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success',
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic', {
      DeliveryStatusLogging: [
        { Protocol: 'Lambda', SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success' },
      ],
    });

    expect(result?.['DeliveryStatusLogging']).toEqual([
      { Protocol: 'Lambda', SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success' },
    ]);
  });

  it('falls back to canonical PascalCase Protocol when state has no case hint', async () => {
    // Pre-existing behavior: when readCurrentState is called without
    // state's properties (e.g. early observed-property capture before
    // state has been written), the result emits the canonical
    // PascalCase prefix.
    mockSend.mockResolvedValueOnce({
      Attributes: {
        TopicArn: TOPIC_ARN,
        LambdaSuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success',
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic');

    expect(result?.['DeliveryStatusLogging']).toEqual([
      { Protocol: 'Lambda', SuccessFeedbackRoleArn: 'arn:aws:iam::1:role/lambda-success' },
    ]);
  });

  it('emits DeliveryStatusLogging=[] when no per-protocol feedback attributes are set', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { TopicArn: TOPIC_ARN } });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic');
    expect(result?.['DeliveryStatusLogging']).toEqual([]);
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
  it('emits placeholders for every user-controllable top-level key on AWS minimum response (standard topic)', async () => {
    // GetTopicAttributes — empty Attributes object (standard topic, not FIFO).
    mockSend.mockResolvedValueOnce({ Attributes: {} });
    // ListTagsForResource — no user tags.
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic');

    // FifoThroughputScope is intentionally absent for standard topics —
    // it's a FIFO-only attribute and emitting '' would have
    // `cdkd drift --revert` push the empty value back to AWS, which
    // SetTopicAttributes rejects.
    expect(Object.keys(result ?? {}).sort()).toEqual(
      [
        'DeliveryStatusLogging',
        'DisplayName',
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
    expect(result?.Tags).toEqual([]);
    expect(result?.DeliveryStatusLogging).toEqual([]);
  });

  it('emits FifoThroughputScope placeholder when topic is FIFO', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { FifoTopic: 'true' } });
    mockSend.mockResolvedValueOnce({ Tags: [] });

    const result = await provider.readCurrentState(TOPIC_ARN, 'Logical', 'AWS::SNS::Topic');

    expect(result).toHaveProperty('FifoThroughputScope', '');
    expect(result).toHaveProperty('FifoTopic', true);
  });
});
