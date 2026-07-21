import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetQueueAttributesCommand,
  ListQueueTagsCommand,
  QueueDoesNotExist,
} from '@aws-sdk/client-sqs';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SQSQueueProvider } from '../../../src/provisioning/providers/sqs-queue-provider.js';

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue';

describe('SQSQueueProvider.readCurrentState', () => {
  let provider: SQSQueueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SQSQueueProvider();
  });

  it('returns CFn-shaped properties with type-coerced numerics, booleans, and parsed RedrivePolicy', async () => {
    const redrive = { deadLetterTargetArn: 'arn:aws:sqs:us-east-1:123:dlq', maxReceiveCount: 5 };
    mockSend.mockResolvedValueOnce({
      Attributes: {
        // Numeric attrs (AWS returns strings):
        VisibilityTimeout: '30',
        MaximumMessageSize: '262144',
        MessageRetentionPeriod: '345600',
        DelaySeconds: '0',
        ReceiveMessageWaitTimeSeconds: '20',
        KmsDataKeyReusePeriodSeconds: '300',
        // Booleans:
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        SqsManagedSseEnabled: 'true',
        // Strings:
        KmsMasterKeyId: 'alias/aws/sqs',
        DeduplicationScope: 'messageGroup',
        FifoThroughputLimit: 'perMessageGroupId',
        // RedrivePolicy as JSON string:
        RedrivePolicy: JSON.stringify(redrive),
        // AWS-managed fields the comparator should ignore:
        QueueArn: 'arn:aws:sqs:us-east-1:123:my-queue',
        ApproximateNumberOfMessages: '0',
      },
    });

    // ListQueueTags — no user tags
    mockSend.mockResolvedValueOnce({ Tags: {} });

    const result = await provider.readCurrentState(QUEUE_URL, 'Logical', 'AWS::SQS::Queue');

    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetQueueAttributesCommand);
    expect(mockSend.mock.calls[1]?.[0]).toBeInstanceOf(ListQueueTagsCommand);
    expect(result).toEqual({
      QueueName: 'my-queue',
      VisibilityTimeout: 30,
      MaximumMessageSize: 262144,
      MessageRetentionPeriod: 345600,
      DelaySeconds: 0,
      ReceiveMessageWaitTimeSeconds: 20,
      KmsDataKeyReusePeriodSeconds: 300,
      FifoQueue: true,
      ContentBasedDeduplication: false,
      SqsManagedSseEnabled: true,
      KmsMasterKeyId: 'alias/aws/sqs',
      DeduplicationScope: 'messageGroup',
      FifoThroughputLimit: 'perMessageGroupId',
      RedrivePolicy: redrive,
      Tags: [],
    });
  });

  it('returns undefined when queue does not exist', async () => {
    mockSend.mockRejectedValueOnce(
      new QueueDoesNotExist({ message: 'gone', $metadata: {} })
    );

    const result = await provider.readCurrentState(QUEUE_URL, 'Logical', 'AWS::SQS::Queue');
    expect(result).toBeUndefined();
  });

  it('surfaces Tags from ListQueueTags with aws:* filtered out', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { VisibilityTimeout: '30' } });
    mockSend.mockResolvedValueOnce({
      Tags: { Foo: 'Bar', 'aws:cdk:path': 'MyStack/MyQueue/Resource' },
    });

    const result = await provider.readCurrentState(QUEUE_URL, 'Logical', 'AWS::SQS::Queue');
    expect(result?.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('omits Tags when ListQueueTags returns no user tags', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { VisibilityTimeout: '30' } });
    mockSend.mockResolvedValueOnce({ Tags: { 'aws:cdk:path': 'MyStack/MyQueue/Resource' } });

    const result = await provider.readCurrentState(QUEUE_URL, 'Logical', 'AWS::SQS::Queue');
    expect(result?.Tags).toEqual([]);
  });

  it('omits FIFO-only attributes (DeduplicationScope / FifoThroughputLimit) on standard queues', async () => {
    // Standard queue (FifoQueue absent / 'false') — DeduplicationScope and
    // FifoThroughputLimit are FIFO-only; emitting `''` placeholders would
    // have `cdkd drift --revert` push them back to AWS, which
    // SetQueueAttributes rejects with "You can specify the
    // DeduplicationScope only when FifoQueue is set to true".
    mockSend.mockResolvedValueOnce({
      Attributes: { VisibilityTimeout: '30' /* FifoQueue absent */ },
    });
    mockSend.mockResolvedValueOnce({ Tags: {} });

    const result = await provider.readCurrentState(QUEUE_URL, 'Logical', 'AWS::SQS::Queue');

    expect(result).not.toHaveProperty('DeduplicationScope');
    expect(result).not.toHaveProperty('FifoThroughputLimit');
    // KmsMasterKeyId is valid for any queue type — placeholder still emitted.
    expect(result).toHaveProperty('KmsMasterKeyId', '');
  });

  it('emits a parsed RedriveAllowPolicy when AWS returns it', async () => {
    const redriveAllow = { redrivePermission: 'byQueue', sourceQueueArns: ['arn:aws:sqs:us-east-1:1:src'] };
    mockSend.mockResolvedValueOnce({
      Attributes: {
        VisibilityTimeout: '30',
        RedriveAllowPolicy: JSON.stringify(redriveAllow),
      },
    });
    mockSend.mockResolvedValueOnce({ Tags: {} });

    const result = await provider.readCurrentState(QUEUE_URL, 'Logical', 'AWS::SQS::Queue');
    expect(result?.['RedriveAllowPolicy']).toEqual(redriveAllow);
  });

  it('omits RedriveAllowPolicy when AWS does not return it (emit-when-present, no placeholder)', async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: { VisibilityTimeout: '30' /* no RedriveAllowPolicy */ },
    });
    mockSend.mockResolvedValueOnce({ Tags: {} });

    const result = await provider.readCurrentState(QUEUE_URL, 'Logical', 'AWS::SQS::Queue');
    expect(result).not.toHaveProperty('RedriveAllowPolicy');
  });

  it('emits FIFO-only attributes (DeduplicationScope / FifoThroughputLimit) on FIFO queues', async () => {
    mockSend.mockResolvedValueOnce({
      Attributes: { VisibilityTimeout: '30', FifoQueue: 'true' },
    });
    mockSend.mockResolvedValueOnce({ Tags: {} });

    const result = await provider.readCurrentState(QUEUE_URL, 'Logical', 'AWS::SQS::Queue');

    expect(result).toHaveProperty('DeduplicationScope', '');
    expect(result).toHaveProperty('FifoThroughputLimit', '');
    expect(result).toHaveProperty('FifoQueue', true);
  });
});

// Issue #1134: the `aws:cdk:path` tag walk is removed. AWS rejects
// `aws:`-prefixed tag writes, so that tag never exists on a real resource and
// the walk could not match. import() now resolves only from an explicit
// `--resource` (queue URL) / `Properties.QueueName`; anything else returns null
// without a lookup.
describe('SQSQueueProvider import', () => {
  const CDK_PATH = 'MyStack/MyQueue/Resource';

  beforeEach(() => {
    vi.clearAllMocks();
    // Drop once-queued responses leaked by earlier tests - clearAllMocks()
    // clears calls but NOT unconsumed mockResolvedValueOnce entries.
    mockSend.mockReset();
  });

  const importInput = () => ({
    logicalId: 'MyQueue',
    resourceType: 'AWS::SQS::Queue',
    cdkPath: CDK_PATH,
    stackName: 'MyStack',
    region: 'us-east-1',
    properties: {},
  });

  it('returns null without any AWS call when no explicit id is given', async () => {
    const provider = new SQSQueueProvider();
    const result = await provider.import(importInput());

    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
